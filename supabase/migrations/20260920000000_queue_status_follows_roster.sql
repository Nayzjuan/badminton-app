-- ============================================================
-- Queue status follows physical roster truth
-- ============================================================
-- Prod 2026-09-19: Darwin was the pulled body of a held draft. The
-- organizer bench-swapped him for Jay while Darwin was still on court.
-- swap_player_in_match Step d wrote him to 'waiting' mid-game. 45s later
-- endMatchAction R3-1 re-reserved him as 'drafted' because pulled_player_ids
-- still named him (swap never ran recomputeHeldReadiness / N-2). He sat
-- Drafted with no match_players row until he left and rejoined.
--
-- Same class, other doors:
--   • swap_match_players never wrote queue_entries, so a drafted↔on_deck
--     cross-swap left statuses on the wrong people.
--   • swap_active_from_ondeck hardcoded the fill as 'on_deck', even when
--     the destination was an unpublished hold.
--   • swapping the body off its source court left them 'waiting' while
--     still named by the hold.
--
-- One rule, one function. After any roster mutation, a player's queue
-- status is:
--   1. in_progress membership  → playing   (never unseat a live body)
--   2. pending unpublished     → drafted
--   3. pending published       → on_deck
--   4. else                    → waiting
-- 'left' rows are never written.
--
-- p_drafted_ids on requeue_finished_players is kept for signature
-- stability and ignored — the RPC derives status from the roster so a
-- stale pulled_player_ids pointer cannot re-reserve a swapped-out body.
-- CREATE OR REPLACE preserves ACLs; GRANT/REVOKE are re-asserted anyway.
-- ============================================================

CREATE OR REPLACE FUNCTION public.queue_status_after_roster_change(
  p_session_id uuid,
  p_player_id uuid
) RETURNS queue_status
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = p_player_id
        AND m.session_id = p_session_id
        AND m.status = 'in_progress'
    ) THEN 'playing'::queue_status
    WHEN EXISTS (
      SELECT 1
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = p_player_id
        AND m.session_id = p_session_id
        AND m.status = 'pending'
        AND m.is_published = false
    ) THEN 'drafted'::queue_status
    WHEN EXISTS (
      SELECT 1
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = p_player_id
        AND m.session_id = p_session_id
        AND m.status = 'pending'
        AND m.is_published = true
    ) THEN 'on_deck'::queue_status
    ELSE 'waiting'::queue_status
  END;
$$;

CREATE OR REPLACE FUNCTION public.apply_queue_status_after_roster_change(
  p_session_id uuid,
  p_player_ids uuid[]
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE queue_entries qe
  SET status = public.queue_status_after_roster_change(p_session_id, qe.player_id)
  WHERE qe.session_id = p_session_id
    AND qe.player_id = ANY(p_player_ids)
    AND qe.status IS DISTINCT FROM 'left';
$$;

GRANT EXECUTE ON FUNCTION public.queue_status_after_roster_change(uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.queue_status_after_roster_change(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apply_queue_status_after_roster_change(uuid, uuid[]) TO service_role;
REVOKE EXECUTE ON FUNCTION public.apply_queue_status_after_roster_change(uuid, uuid[]) FROM PUBLIC, anon, authenticated;


-- ── requeue_finished_players: derive status, ignore p_drafted_ids ──

CREATE OR REPLACE FUNCTION public.requeue_finished_players(
  p_session_id uuid,
  p_player_ids uuid[],
  p_drafted_ids uuid[]
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE queue_entries
  SET games_played = games_played + 1,
      joined_at    = now(),
      status       = public.queue_status_after_roster_change(p_session_id, player_id)
  WHERE session_id = p_session_id
    AND player_id  = ANY(p_player_ids)
    AND status    <> 'left';
$$;

-- p_drafted_ids is unused on purpose (signature stability). Reference it so
-- plpgsql-style "unused parameter" linters and `sql` volatility analysis
-- still see every argument name; the value is not read.
COMMENT ON FUNCTION public.requeue_finished_players(uuid, uuid[], uuid[]) IS
  'Increments games_played and sets status from queue_status_after_roster_change. p_drafted_ids is ignored.';

GRANT EXECUTE ON FUNCTION public.requeue_finished_players(uuid, uuid[], uuid[]) TO service_role;
REVOKE EXECUTE ON FUNCTION public.requeue_finished_players(uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;


-- ── swap_player_in_match ──

CREATE OR REPLACE FUNCTION public.swap_player_in_match(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID,
  p_team          TEXT,
  p_is_published  BOOLEAN DEFAULT true,
  p_actor_id      UUID DEFAULT NULL,
  p_actor_name    TEXT DEFAULT NULL,
  p_is_undo       BOOLEAN DEFAULT false,
  p_reverses_event_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_in_status       TEXT;
  v_match_status    TEXT;
  v_distinct_levels INT;
BEGIN
  SELECT status INTO v_in_status FROM queue_entries
  WHERE session_id = p_session_id AND player_id = p_in_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_UNAVAILABLE'; END IF;
  IF v_in_status IS DISTINCT FROM 'waiting' THEN RAISE EXCEPTION 'PLAYER_UNAVAILABLE'; END IF;

  IF EXISTS (
    SELECT 1 FROM match_players mp JOIN matches m ON m.id = mp.match_id
    WHERE mp.player_id = p_in_player_id AND m.session_id = p_session_id
      AND m.id != p_match_id AND m.status IN ('pending', 'in_progress')
  ) THEN RAISE EXCEPTION 'PLAYER_UNAVAILABLE'; END IF;

  SELECT status INTO v_match_status FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MATCH_STARTED'; END IF;
  IF v_match_status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'MATCH_STARTED'; END IF;

  DELETE FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id;
  INSERT INTO match_players (match_id, player_id, team) VALUES (p_match_id, p_in_player_id, p_team);

  -- p_is_published is kept for signature stability; status is derived from
  -- the live roster (unpublished → drafted, published → on_deck, still on
  -- an in_progress court → playing).
  PERFORM public.apply_queue_status_after_roster_change(
    p_session_id, ARRAY[p_out_player_id, p_in_player_id]
  );

  SELECT COUNT(DISTINCT p.skill_level) INTO v_distinct_levels
  FROM match_players mp JOIN profiles p ON p.id = mp.player_id WHERE mp.match_id = p_match_id;
  UPDATE matches SET is_mixed_level = (v_distinct_levels > 1) WHERE id = p_match_id;

  PERFORM record_match_event(
    p_match_id, p_session_id,
    CASE WHEN p_is_undo THEN 'undo' ELSE 'roster_swap' END, 'draft',
    CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
    p_actor_id, p_actor_name,
    jsonb_build_array(jsonb_build_object(
      'out_player_id', p_out_player_id, 'out_player_name', _player_name(p_out_player_id),
      'in_player_id', p_in_player_id, 'in_player_name', _player_name(p_in_player_id),
      'team', p_team)),
    NULL, NULL, p_reverses_event_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN, UUID, TEXT, BOOLEAN, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN, UUID, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;


-- ── swap_match_players ──

CREATE OR REPLACE FUNCTION public.swap_match_players(
  p_a_match_id   uuid,
  p_a_player_id  uuid,
  p_b_match_id   uuid,
  p_b_player_id  uuid,
  p_actor_id     uuid DEFAULT NULL,
  p_actor_name   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_a_match_status TEXT;
  v_b_match_status TEXT;
  v_a_team         TEXT;
  v_b_team         TEXT;
  v_a_distinct     INT;
  v_b_distinct     INT;
  v_session_a      uuid;
  v_session_b      uuid;
  v_corr           uuid := gen_random_uuid();
BEGIN
  IF p_a_player_id = p_b_player_id THEN RAISE EXCEPTION 'Cannot swap a player with themselves'; END IF;

  SELECT status, session_id INTO v_a_match_status, v_session_a FROM matches WHERE id = p_a_match_id FOR UPDATE;
  IF p_a_match_id != p_b_match_id THEN
    SELECT status, session_id INTO v_b_match_status, v_session_b FROM matches WHERE id = p_b_match_id FOR UPDATE;
  ELSE
    v_b_match_status := v_a_match_status;
    v_session_b := v_session_a;
  END IF;

  IF v_a_match_status IS NULL OR v_a_match_status != 'pending' OR
     v_b_match_status IS NULL OR v_b_match_status != 'pending' THEN
    RAISE EXCEPTION 'MATCH_STARTED';
  END IF;

  -- A still-playing pulled body cannot be parked on a second pending roster.
  IF EXISTS (
    SELECT 1 FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    WHERE mp.player_id IN (p_a_player_id, p_b_player_id)
      AND m.session_id IN (v_session_a, v_session_b)
      AND m.status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
  END IF;

  SELECT team INTO v_a_team FROM match_players
  WHERE match_id = p_a_match_id AND player_id = p_a_player_id FOR UPDATE;
  SELECT team INTO v_b_team FROM match_players
  WHERE match_id = p_b_match_id AND player_id = p_b_player_id FOR UPDATE;
  IF v_a_team IS NULL OR v_b_team IS NULL THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

  DELETE FROM match_players
  WHERE (match_id = p_a_match_id AND player_id = p_a_player_id)
     OR (match_id = p_b_match_id AND player_id = p_b_player_id);

  INSERT INTO match_players (match_id, player_id, team)
  VALUES (p_b_match_id, p_a_player_id, v_b_team), (p_a_match_id, p_b_player_id, v_a_team);

  PERFORM public.apply_queue_status_after_roster_change(
    v_session_a, ARRAY[p_a_player_id, p_b_player_id]
  );

  SELECT COUNT(DISTINCT p.skill_level) INTO v_a_distinct
  FROM match_players mp JOIN profiles p ON p.id = mp.player_id WHERE mp.match_id = p_a_match_id;
  UPDATE matches SET is_mixed_level = (v_a_distinct > 1) WHERE id = p_a_match_id;

  IF p_a_match_id != p_b_match_id THEN
    SELECT COUNT(DISTINCT p.skill_level) INTO v_b_distinct
    FROM match_players mp JOIN profiles p ON p.id = mp.player_id WHERE mp.match_id = p_b_match_id;
    UPDATE matches SET is_mixed_level = (v_b_distinct > 1) WHERE id = p_b_match_id;
  END IF;

  IF p_a_match_id = p_b_match_id THEN
    PERFORM record_match_event(
      p_a_match_id, v_session_a, 'team_flip', 'draft',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(
        jsonb_build_object('player_id', p_a_player_id, 'player_name', _player_name(p_a_player_id),
                           'from_team', v_a_team, 'to_team', v_b_team),
        jsonb_build_object('player_id', p_b_player_id, 'player_name', _player_name(p_b_player_id),
                           'from_team', v_b_team, 'to_team', v_a_team))
    );
  ELSE
    PERFORM record_match_event(
      p_a_match_id, v_session_a, 'roster_swap', 'draft',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_a_player_id, 'out_player_name', _player_name(p_a_player_id),
        'in_player_id', p_b_player_id, 'in_player_name', _player_name(p_b_player_id),
        'team', v_a_team)),
      jsonb_build_object('secondary_match_id', p_b_match_id), v_corr, NULL
    );
    PERFORM record_match_event(
      p_b_match_id, v_session_b, 'roster_swap', 'draft',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_b_player_id, 'out_player_name', _player_name(p_b_player_id),
        'in_player_id', p_a_player_id, 'in_player_name', _player_name(p_a_player_id),
        'team', v_b_team)),
      jsonb_build_object('secondary_match_id', p_a_match_id), v_corr, NULL
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_match_players(UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.swap_match_players(UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;


-- ── swap_player_in_active_match ──

CREATE OR REPLACE FUNCTION public.swap_player_in_active_match(
    p_match_id uuid,
    p_out_player_id uuid,
    p_in_player_id uuid,
    p_session_id uuid,
    p_team text,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text,
    p_is_undo boolean DEFAULT false,
    p_reverses_event_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_match_status match_status;
    v_in_status    queue_status;
BEGIN
    SELECT status INTO v_match_status
    FROM matches
    WHERE id = p_match_id AND session_id = p_session_id
    FOR UPDATE;
    IF v_match_status IS DISTINCT FROM 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id
    ) THEN
        RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
    END IF;

    SELECT status INTO v_in_status FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_in_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_UNAVAILABLE'; END IF;
    -- Incoming must be waiting, including on undo. Accepting drafted/on_deck
    -- would INSERT them onto the live court without removing a pending
    -- match_players row and double-book them. A pulled-body live-swap is
    -- not undoable at the action layer (outgoing is not waiting).
    IF v_in_status IS DISTINCT FROM 'waiting' THEN
      RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
    END IF;

    DELETE FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_match_id, p_in_player_id, p_team);

    PERFORM public.apply_queue_status_after_roster_change(
      p_session_id, ARRAY[p_out_player_id, p_in_player_id]
    );

    UPDATE matches
    SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1
          FROM match_players mp JOIN profiles pr ON pr.id = mp.player_id
          WHERE mp.match_id = p_match_id)
    WHERE id = p_match_id;

    PERFORM record_match_event(
      p_match_id, p_session_id,
      CASE WHEN p_is_undo THEN 'undo' ELSE 'roster_swap' END,
      'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_out_player_id, 'out_player_name', _player_name(p_out_player_id),
        'in_player_id', p_in_player_id,   'in_player_name', _player_name(p_in_player_id),
        'team', p_team)),
      NULL, NULL, p_reverses_event_id
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) FROM PUBLIC, anon, authenticated;


-- ── swap_active_from_ondeck ──

CREATE OR REPLACE FUNCTION public.swap_active_from_ondeck(
    p_active_match_id uuid,
    p_out_player_id uuid,
    p_ondeck_player_id uuid,
    p_ondeck_match_id uuid,
    p_fill_player_id uuid,
    p_session_id uuid,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text,
    OUT o_out_team text,
    OUT o_ondeck_team text)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_active_status  match_status;
    v_ondeck_status  match_status;
    v_fill_status    queue_status;
    v_corr           uuid := gen_random_uuid();
BEGIN
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
    END IF;

    IF v_active_status IS DISTINCT FROM 'in_progress' THEN RAISE EXCEPTION 'MATCH_NOT_ACTIVE'; END IF;
    IF v_ondeck_status IS DISTINCT FROM 'pending'     THEN RAISE EXCEPTION 'ONDECK_MATCH_STARTED'; END IF;

    SELECT team INTO o_out_team FROM match_players
    WHERE match_id = p_active_match_id AND player_id = p_out_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO o_ondeck_team FROM match_players
    WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    -- Defense in depth: the UI already hides live-court players from the
    -- on-deck candidate list. A still-playing pulled body must not be pulled
    -- onto a second in_progress roster.
    IF EXISTS (
      SELECT 1 FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = p_ondeck_player_id
        AND m.session_id = p_session_id
        AND m.status = 'in_progress'
    ) THEN RAISE EXCEPTION 'PLAYER_UNAVAILABLE'; END IF;

    SELECT status INTO v_fill_status FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_fill_player_id FOR UPDATE;
    IF NOT FOUND OR v_fill_status != 'waiting' THEN RAISE EXCEPTION 'FILL_PLAYER_UNAVAILABLE'; END IF;

    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_active_match_id, p_ondeck_player_id, o_out_team);

    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_ondeck_match_id, p_fill_player_id, o_ondeck_team);

    PERFORM public.apply_queue_status_after_roster_change(
      p_session_id, ARRAY[p_out_player_id, p_ondeck_player_id, p_fill_player_id]
    );

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_active_match_id)
    WHERE id = p_active_match_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_ondeck_match_id)
    WHERE id = p_ondeck_match_id;

    PERFORM record_match_event(
      p_active_match_id, p_session_id, 'ondeck_pull', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_out_player_id, 'out_player_name', _player_name(p_out_player_id),
        'in_player_id', p_ondeck_player_id, 'in_player_name', _player_name(p_ondeck_player_id),
        'team', o_out_team)),
      jsonb_build_object('secondary_match_id', p_ondeck_match_id, 'leg', 'active'),
      v_corr, NULL
    );
    PERFORM record_match_event(
      p_ondeck_match_id, p_session_id, 'ondeck_pull', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_ondeck_player_id, 'out_player_name', _player_name(p_ondeck_player_id),
        'in_player_id', p_fill_player_id, 'in_player_name', _player_name(p_fill_player_id),
        'team', o_ondeck_team)),
      jsonb_build_object('secondary_match_id', p_active_match_id, 'leg', 'ondeck'),
      v_corr, NULL
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;


-- ── undo_swap_active_from_ondeck ──

CREATE OR REPLACE FUNCTION public.undo_swap_active_from_ondeck(
    p_active_match_id uuid,
    p_out_player_id uuid,
    p_ondeck_player_id uuid,
    p_ondeck_match_id uuid,
    p_fill_player_id uuid,
    p_session_id uuid,
    p_out_team text,
    p_ondeck_team text,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_active_status match_status;
    v_ondeck_status match_status;
    v_corr          uuid := gen_random_uuid();
BEGIN
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
    END IF;

    IF v_active_status IS DISTINCT FROM 'in_progress'
       OR v_ondeck_status IS DISTINCT FROM 'pending' THEN
        RETURN;
    END IF;

    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_active_match_id, p_out_player_id, p_out_team);

    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_fill_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_ondeck_match_id, p_ondeck_player_id, p_ondeck_team);

    PERFORM public.apply_queue_status_after_roster_change(
      p_session_id, ARRAY[p_out_player_id, p_ondeck_player_id, p_fill_player_id]
    );

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_active_match_id)
    WHERE id = p_active_match_id;
    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_ondeck_match_id)
    WHERE id = p_ondeck_match_id;

    PERFORM record_match_event(
      p_active_match_id, p_session_id, 'undo', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_ondeck_player_id, 'out_player_name', _player_name(p_ondeck_player_id),
        'in_player_id', p_out_player_id, 'in_player_name', _player_name(p_out_player_id),
        'team', p_out_team)),
      jsonb_build_object('secondary_match_id', p_ondeck_match_id, 'leg', 'active', 'undo_of', 'ondeck_pull'),
      v_corr, NULL
    );
    PERFORM record_match_event(
      p_ondeck_match_id, p_session_id, 'undo', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_fill_player_id, 'out_player_name', _player_name(p_fill_player_id),
        'in_player_id', p_ondeck_player_id, 'in_player_name', _player_name(p_ondeck_player_id),
        'team', p_ondeck_team)),
      jsonb_build_object('secondary_match_id', p_active_match_id, 'leg', 'ondeck', 'undo_of', 'ondeck_pull'),
      v_corr, NULL
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
