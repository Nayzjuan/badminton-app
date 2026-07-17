-- ============================================================================
-- C1 correctness fix: restore the 'drafted' queue-status branch + widen the
-- publish predicates so engine drafts and their queue rows behave correctly.
--
-- Root cause: the 20260617 match-provenance rewrite of create_match_with_players
-- kept only the `NOT p_is_on_deck -> playing` and `p_is_published -> on_deck`
-- branches and dropped the `ELSE -> drafted` branch (present since 20260511).
-- In draft mode (the default; only 1/22 sessions ever enabled auto-publish),
-- engine-created draft rosters left their players at status='waiting':
--   - the engine's next slot re-picked those top-priority players, hit the
--     conflict guard (they are already in a pending match) -> RETURN NULL ->
--     slot skipped, so draft mode chronically under-generated; AND
--   - publish_match / publish_all_drafts only flip `status = 'drafted'`, so
--     publishing an engine draft never set on_deck on the queue rows, and the
--     player-side "Match Forming" holding card never fired for engine drafts.
--
-- Fix: (1) restore the ELSE 'drafted' branch; (2) widen the two publish RPCs'
-- queue predicates to `IN ('drafted','waiting')` which heals any rows left
-- 'waiting' during the bug window (players in a roster being published belong
-- on deck; the conflict checks already ran). auto_publish_match already handles
-- both statuses; create_held_cross_court_match already sets 'drafted'.
--
-- All three are CREATE OR REPLACE (no signature change) so GRANTs are preserved.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_match_with_players(p_session_id uuid, p_court_id uuid, p_status text, p_is_mixed_level boolean, p_started_at timestamp with time zone, p_is_on_deck boolean, p_team_a_ids uuid[], p_team_b_ids uuid[], p_origin match_origin DEFAULT 'auto'::match_origin, p_is_published boolean DEFAULT false, p_actor_id uuid DEFAULT NULL::uuid, p_actor_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_match_id      UUID;
  v_all_ids       UUID[];
  v_waiting_count INT;
  v_conflict      INT;
BEGIN
  v_all_ids := p_team_a_ids || p_team_b_ids;
  SET LOCAL lock_timeout = '3s';

  SELECT COUNT(*)::INT INTO v_waiting_count
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_all_ids)
    AND  status     = 'waiting';

  IF v_waiting_count != array_length(v_all_ids, 1) THEN
    RETURN NULL;
  END IF;

  PERFORM 1
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_all_ids)
  ORDER BY player_id
  FOR UPDATE;

  SELECT COUNT(*)::INT INTO v_conflict
  FROM   match_players mp
  JOIN   matches       m  ON m.id = mp.match_id
  WHERE  mp.player_id  = ANY(v_all_ids)
    AND  m.session_id  = p_session_id
    AND  m.status      IN ('pending', 'in_progress');

  IF v_conflict > 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO matches (
    session_id, court_id, status, is_mixed_level,
    started_at, is_published, created_method
  )
  VALUES (
    p_session_id, p_court_id, p_status::match_status, p_is_mixed_level,
    p_started_at, p_is_published, p_origin::text
  )
  RETURNING id INTO v_match_id;

  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  IF NOT p_is_on_deck THEN
    UPDATE queue_entries SET status = 'playing'::queue_status
    WHERE  session_id = p_session_id AND player_id = ANY(v_all_ids);
  ELSIF p_is_published THEN
    UPDATE queue_entries SET status = 'on_deck'::queue_status
    WHERE  session_id = p_session_id AND player_id = ANY(v_all_ids);
  ELSE
    -- Draft mode (on_deck + unpublished): mark players 'drafted' so they leave
    -- the waiting pool and the engine's next slot doesn't re-pick them.
    -- (Restored — dropped by the 20260617 provenance rewrite.)
    UPDATE queue_entries SET status = 'drafted'::queue_status
    WHERE  session_id = p_session_id AND player_id = ANY(v_all_ids);
  END IF;

  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts SET status = 'in_use'::court_status WHERE id = p_court_id;
  END IF;

  BEGIN
    PERFORM record_match_event(
      v_match_id, p_session_id, 'created', 'draft',
      CASE WHEN p_origin = 'manual' THEN 'organizer' ELSE 'engine' END,
      p_actor_id, p_actor_name,
      '[]'::jsonb,
      jsonb_build_object(
        'method', p_origin::text,
        'roster', (
          SELECT jsonb_agg(jsonb_build_object(
                   'player_id', mp.player_id,
                   'player_name', _player_name(mp.player_id),
                   'team', mp.team) ORDER BY mp.team, mp.player_id)
          FROM match_players mp WHERE mp.match_id = v_match_id)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_match_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.publish_match(p_match_id uuid, p_session_id uuid, p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_is_published bool;
  v_left_count int;
  v_conflict_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN 'NOT_ORGANIZER';
  END IF;

  SELECT status, is_published INTO v_status, v_is_published
  FROM matches
  WHERE id = p_match_id
    AND session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;

  IF v_status != 'pending' THEN
    RETURN 'NOT_PENDING';
  END IF;

  IF v_is_published THEN
    RETURN 'ALREADY_PUBLISHED';
  END IF;

  SELECT COUNT(*) INTO v_left_count
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
  WHERE mp.match_id = p_match_id
    AND qe.status = 'left';

  IF v_left_count > 0 THEN
    RETURN 'HAS_LEFT_PLAYERS';
  END IF;

  SELECT COUNT(*) INTO v_conflict_count
  FROM match_players mp
  JOIN matches m ON m.id = mp.match_id
  WHERE mp.player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND m.session_id = p_session_id
    AND m.id != p_match_id
    AND m.status IN ('pending', 'in_progress');

  IF v_conflict_count > 0 THEN
    RETURN 'CONFLICT';
  END IF;

  UPDATE matches
  SET is_published = true
  WHERE id = p_match_id;

  UPDATE queue_entries
  SET status = 'on_deck'
  WHERE session_id = p_session_id
    AND player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND status IN ('drafted', 'waiting');

  RETURN 'SUCCESS';
END;
$function$;

CREATE OR REPLACE FUNCTION public.publish_all_drafts(p_session_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_match_id uuid;
  v_match_status text;
  v_match_is_published bool;
  v_left_count int;
  v_conflict_count int;
  v_published_ids uuid[] := '{}';
  v_skipped_ids uuid[] := '{}';
  v_all_draft_ids uuid[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_ORGANIZER');
  END IF;

  SELECT ARRAY_AGG(id ORDER BY id) INTO v_all_draft_ids
  FROM matches
  WHERE session_id = p_session_id
    AND status = 'pending'
    AND is_published = false;

  IF v_all_draft_ids IS NULL THEN
    RETURN jsonb_build_object('success', true, 'published_count', 0, 'skipped_count', 0);
  END IF;

  FOREACH v_match_id IN ARRAY v_all_draft_ids
  LOOP
    SELECT status, is_published
    INTO v_match_status, v_match_is_published
    FROM matches
    WHERE id = v_match_id
    FOR UPDATE;

    IF v_match_status != 'pending' OR v_match_is_published THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

    SELECT COUNT(*) INTO v_left_count
    FROM match_players mp
    JOIN queue_entries qe ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
    WHERE mp.match_id = v_match_id AND qe.status = 'left';

    IF v_left_count > 0 THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

    SELECT COUNT(*) INTO v_conflict_count
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    WHERE mp.player_id IN (SELECT player_id FROM match_players WHERE match_id = v_match_id)
      AND m.session_id = p_session_id
      AND m.id != v_match_id
      AND m.status IN ('pending', 'in_progress');

    IF v_conflict_count > 0 THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

    UPDATE matches SET is_published = true WHERE id = v_match_id;
    v_published_ids := array_append(v_published_ids, v_match_id);
  END LOOP;

  IF v_published_ids != '{}' THEN
    UPDATE queue_entries
    SET status = 'on_deck'
    WHERE session_id = p_session_id
      AND player_id IN (
        SELECT player_id FROM match_players WHERE match_id = ANY(v_published_ids)
      )
      AND status IN ('drafted', 'waiting');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'published_count', COALESCE(array_length(v_published_ids, 1), 0),
    'skipped_count', COALESCE(array_length(v_skipped_ids, 1), 0)
  );
END;
$function$;
