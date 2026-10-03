-- ============================================================
-- Score + start actor logging
-- ============================================================
-- The 2026-10-03 phantom 14–31 match completed in 30s with no
-- scorer and no starter in match_events. Initial complete and
-- court promotion wrote the match row and nothing else.
--
-- This migration:
--   1. Widens match_events CHECKs (DROP + ADD) for event
--      'scored'/'started' and actor 'player'.
--   2. Adds complete_match_with_score — CAS complete + scored
--      event in one transaction. No score without an event.
--   3. Adds start_match_on_court — CAS promote + court in_use
--      + queue playing + started event in one transaction.
--   4. Refreshes started_at on revert_match_to_active so a
--      re-score's seconds_since_start is this playing stint.
--
-- Both new functions are service_role only (REVOKE PUBLIC).
-- Apply by hand. Confirm with list_migrations before merging
-- the TypeScript that calls them — there is no JS fallback.
-- ============================================================

-- ── 1. Widen CHECKs ──────────────────────────────────────────
ALTER TABLE public.match_events
  DROP CONSTRAINT match_events_event_type_check;
ALTER TABLE public.match_events
  ADD CONSTRAINT match_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'created'::text, 'published'::text, 'roster_swap'::text, 'team_flip'::text,
    'ondeck_pull'::text, 'player_left'::text, 'cancelled'::text, 'undo'::text,
    'score_edit'::text, 'revert'::text, 'scored'::text, 'started'::text
  ]));

ALTER TABLE public.match_events
  DROP CONSTRAINT match_events_actor_type_check;
ALTER TABLE public.match_events
  ADD CONSTRAINT match_events_actor_type_check
  CHECK (actor_type = ANY (ARRAY[
    'engine'::text, 'organizer'::text, 'system'::text, 'player'::text
  ]));

-- ── 2. complete_match_with_score ─────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_match_with_score(
  p_match_id   uuid,
  p_session_id uuid,
  p_score_a    integer,
  p_score_b    integer,
  p_actor_type text,
  p_actor_id   uuid,
  p_actor_name text,
  p_via        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_match      public.matches%ROWTYPE;
  v_updated    int;
  v_event_id   uuid;
  v_roster     jsonb;
  v_court_name text;
  v_actor_team text;
  v_seconds    int;
BEGIN
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('organizer', 'player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid actor type.');
  END IF;
  IF p_actor_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Actor id is required.');
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('organizer_end', 'player_submit') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid via.');
  END IF;
  IF p_score_a IS NULL OR p_score_b IS NULL OR p_score_a = p_score_b THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scores must be unequal.');
  END IF;

  SELECT * INTO v_match
  FROM public.matches
  WHERE id = p_match_id
    AND session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Match not found.');
  END IF;

  IF v_match.status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', v_match.status,
      'error', 'already_settled'
    );
  END IF;

  UPDATE public.matches
  SET team_a_score = p_score_a,
      team_b_score = p_score_b,
      status       = 'completed',
      completed_at = now()
  WHERE id = p_match_id
    AND session_id = p_session_id
    AND status = 'in_progress';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    SELECT status INTO v_match.status FROM public.matches WHERE id = p_match_id;
    RETURN jsonb_build_object(
      'success', false,
      'status', v_match.status,
      'error', 'already_settled'
    );
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'team', mp.team,
        'player_id', mp.player_id,
        'player_name', public._player_name(mp.player_id)
      )
      ORDER BY mp.team, mp.player_id
    ),
    '[]'::jsonb
  )
  INTO v_roster
  FROM public.match_players mp
  WHERE mp.match_id = p_match_id;

  SELECT c.name INTO v_court_name
  FROM public.courts c
  WHERE c.id = v_match.court_id;

  SELECT mp.team INTO v_actor_team
  FROM public.match_players mp
  WHERE mp.match_id = p_match_id
    AND mp.player_id = p_actor_id;

  v_seconds := CASE
    WHEN v_match.started_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - v_match.started_at))::int
  END;

  BEGIN
    v_event_id := public.record_match_event(
      p_match_id,
      p_session_id,
      'scored',
      'active',
      p_actor_type,
      p_actor_id,
      p_actor_name,
      '[]'::jsonb,
      jsonb_build_object(
        'a', p_score_a,
        'b', p_score_b,
        'via', p_via,
        'actor_team', v_actor_team,
        'court_id', v_match.court_id,
        'court_name', v_court_name,
        'started_at', v_match.started_at,
        'seconds_since_start', v_seconds,
        'roster', v_roster
      )
    );
  EXCEPTION WHEN unique_violation THEN
    v_event_id := public.record_match_event(
      p_match_id,
      p_session_id,
      'scored',
      'active',
      p_actor_type,
      p_actor_id,
      p_actor_name,
      '[]'::jsonb,
      jsonb_build_object(
        'a', p_score_a,
        'b', p_score_b,
        'via', p_via,
        'actor_team', v_actor_team,
        'court_id', v_match.court_id,
        'court_name', v_court_name,
        'started_at', v_match.started_at,
        'seconds_since_start', v_seconds,
        'roster', v_roster
      )
    );
  END;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'completed',
    'event_id', v_event_id,
    'seconds_since_start', v_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_match_with_score(uuid, uuid, integer, integer, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_match_with_score(uuid, uuid, integer, integer, text, uuid, text, text)
  TO service_role;

-- ── 3. start_match_on_court ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.start_match_on_court(
  p_match_id          uuid,
  p_session_id        uuid,
  p_court_id          uuid,
  p_trigger           text,
  p_actor_type        text,
  p_actor_id          uuid,
  p_actor_name        text,
  p_trigger_match_id  uuid,
  p_trigger_actor_id  uuid,
  p_trigger_actor_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_match      public.matches%ROWTYPE;
  v_court_ok   boolean;
  v_updated    int;
  v_court_flip int;
  v_event_id   uuid;
  v_roster     jsonb;
  v_court_name text;
BEGIN
  IF p_trigger IS NULL OR p_trigger NOT IN ('call_next', 'after_score', 'after_cancel') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid trigger.');
  END IF;

  IF p_trigger = 'call_next' THEN
    IF p_actor_type IS DISTINCT FROM 'organizer' OR p_actor_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Call next requires an organizer actor.');
    END IF;
  ELSE
    IF p_actor_type IS DISTINCT FROM 'system' OR p_actor_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Automatic start must be system with a null actor id.');
    END IF;
    IF p_trigger_match_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Automatic start requires the triggering match.');
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.courts
    WHERE id = p_court_id AND session_id = p_session_id
  ) INTO v_court_ok;
  IF NOT v_court_ok THEN
    RETURN jsonb_build_object('success', false, 'code', 'court_mismatch', 'error', 'Court does not belong to this session.');
  END IF;

  SELECT * INTO v_match
  FROM public.matches
  WHERE id = p_match_id
    AND session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Match not found.');
  END IF;

  IF v_match.status IS DISTINCT FROM 'pending' OR v_match.is_published IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'code', 'already_promoted', 'error', 'Match is not a published pending match.');
  END IF;

  UPDATE public.matches
  SET court_id   = p_court_id,
      status     = 'in_progress',
      started_at = now()
  WHERE id = p_match_id
    AND session_id = p_session_id
    AND status = 'pending'
    AND is_published = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'already_promoted', 'error', 'Match was already promoted.');
  END IF;

  UPDATE public.courts
  SET status = 'in_use'
  WHERE id = p_court_id
    AND session_id = p_session_id;
  GET DIAGNOSTICS v_court_flip = ROW_COUNT;
  IF v_court_flip = 0 THEN
    RAISE EXCEPTION 'COURT_MISMATCH';
  END IF;

  UPDATE public.queue_entries qe
  SET status = 'playing'
  FROM public.match_players mp
  WHERE mp.match_id = p_match_id
    AND qe.session_id = p_session_id
    AND qe.player_id = mp.player_id
    AND qe.status <> 'left';

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'team', mp.team,
        'player_id', mp.player_id,
        'player_name', public._player_name(mp.player_id)
      )
      ORDER BY mp.team, mp.player_id
    ),
    '[]'::jsonb
  )
  INTO v_roster
  FROM public.match_players mp
  WHERE mp.match_id = p_match_id;

  SELECT c.name INTO v_court_name
  FROM public.courts c
  WHERE c.id = p_court_id;

  BEGIN
    v_event_id := public.record_match_event(
      p_match_id,
      p_session_id,
      'started',
      'draft',
      p_actor_type,
      p_actor_id,
      p_actor_name,
      '[]'::jsonb,
      jsonb_build_object(
        'trigger', p_trigger,
        'court_id', p_court_id,
        'court_name', v_court_name,
        'roster', v_roster,
        'trigger_match_id', p_trigger_match_id,
        'trigger_actor_id', p_trigger_actor_id,
        'trigger_actor_name', p_trigger_actor_name
      )
    );
  EXCEPTION WHEN unique_violation THEN
    v_event_id := public.record_match_event(
      p_match_id,
      p_session_id,
      'started',
      'draft',
      p_actor_type,
      p_actor_id,
      p_actor_name,
      '[]'::jsonb,
      jsonb_build_object(
        'trigger', p_trigger,
        'court_id', p_court_id,
        'court_name', v_court_name,
        'roster', v_roster,
        'trigger_match_id', p_trigger_match_id,
        'trigger_actor_id', p_trigger_actor_id,
        'trigger_actor_name', p_trigger_actor_name
      )
    );
  END;

  RETURN jsonb_build_object(
    'success', true,
    'match_id', p_match_id,
    'event_id', v_event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_match_on_court(uuid, uuid, uuid, text, text, uuid, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_match_on_court(uuid, uuid, uuid, text, text, uuid, text, uuid, uuid, text)
  TO service_role;

-- ── 4. Revert refreshes started_at ───────────────────────────
CREATE OR REPLACE FUNCTION public.revert_match_to_active(
  p_match_id uuid,
  p_session_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM id
  FROM    matches
  WHERE   id         = p_match_id
    AND   session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;

  UPDATE matches
  SET    status       = 'in_progress',
         team_a_score = NULL,
         team_b_score = NULL,
         completed_at = NULL,
         started_at   = now()
  WHERE  id = p_match_id;

  UPDATE queue_entries qe
  SET    status       = 'playing',
         games_played = GREATEST(0, qe.games_played - 1)
  FROM   match_players mp
  WHERE  mp.match_id   = p_match_id
    AND  qe.session_id = p_session_id
    AND  qe.player_id  = mp.player_id
    AND  qe.status     = 'waiting';

  RETURN 'ok';
END;
$$;
