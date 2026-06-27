-- ============================================================
-- Migration 1 (additive): Match provenance & modification audit
-- ============================================================
-- See MATCH_PROVENANCE_AUDIT_PLAN.md. This migration is ADDITIVE: it leaves the
-- legacy `matches.origin` COLUMN in place (so old code reading it doesn't crash
-- during the deploy window) but the redefined RPCs no longer WRITE it — new rows
-- keep its DEFAULT 'auto' and swaps no longer flip it. The badge/UI move to
-- `final_classification`; migration 2 (separate file) drops the column + rebuilds
-- the view chain. Transitional cosmetic effect only: during the brief window
-- between this migration and the app deploy, the OLD app shows new matches as
-- 'auto' (it reads the now-stale origin) — harmless, resolved on deploy.
--
-- Adds:
--   • matches.created_method  (auto|manual|held, immutable)  — backfilled
--   • matches.modification_count (int)                        — backfilled (floor)
--   • matches.final_classification (generated, 6-value)
--   • matches.provenance_backfilled (marks pre-cutover rows: no event trail,
--     floored counts — COUNT-safe but SUM-unsafe across the cutover)
--   • match_events  (append-only audit log; match_id/session_id ON DELETE SET
--     NULL + snapshots so the trail survives match/session deletion)
--   • record_match_event() helper (seq under the caller's lock + counter delta)
--   • event capture inside every composition RPC (create/swap/fix-record),
--     keeping each RPC's existing behavior + legacy origin flip verbatim.
--
-- Idempotent: re-applying is safe (IF NOT EXISTS, backfill WHERE NULL).
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. Rollup columns on matches  (additive, idempotent)
-- ════════════════════════════════════════════════════════════

-- 1a. Nullable first so the add is metadata-only on the live table.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS created_method     text,
  ADD COLUMN IF NOT EXISTS modification_count integer,
  ADD COLUMN IF NOT EXISTS provenance_backfilled boolean NOT NULL DEFAULT false;

-- 1b. Backfill ONLY rows not yet populated (idempotent / re-runnable).
--   created_method recovery (exact for BIRTH thanks to the sticky rule):
--     is_held              → 'held'   (held drafts were stamped origin='auto')
--     origin = 'manual'    → 'manual' (manual never demoted)
--     origin auto/modified → 'auto'   ('modified' provably came from auto birth)
--   modification_count: legacy 'modified' rows get a FLOOR of 1 (≥1, exact
--   unknown — the granular trail never existed). NOTE (plan §14 H1): a
--   historically-modified MANUAL match stayed origin='manual' and therefore
--   backfills as manual_clean — manual_modified is unrecoverable, accurate only
--   going forward.
UPDATE public.matches
SET    created_method = CASE
         WHEN is_held              THEN 'held'
         WHEN origin = 'manual'    THEN 'manual'
         ELSE 'auto'
       END,
       modification_count = CASE WHEN origin = 'modified' THEN 1 ELSE 0 END,
       provenance_backfilled = true
WHERE  created_method IS NULL;

-- 1c. Lock in NOT NULL + defaults for rows inserted from here on.
ALTER TABLE public.matches
  ALTER COLUMN created_method     SET DEFAULT 'auto',
  ALTER COLUMN created_method     SET NOT NULL,
  ALTER COLUMN modification_count SET DEFAULT 0,
  ALTER COLUMN modification_count SET NOT NULL,
  ADD CONSTRAINT matches_created_method_chk
      CHECK (created_method IN ('auto','manual','held')) NOT VALID;

ALTER TABLE public.matches VALIDATE CONSTRAINT matches_created_method_chk;

-- 1d. Generated ultimate label (references only stored columns — legal).
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS final_classification text
  GENERATED ALWAYS AS (
    created_method ||
    CASE WHEN modification_count > 0 THEN '_modified' ELSE '_clean' END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_matches_final_classification
  ON public.matches (session_id, final_classification);

-- ════════════════════════════════════════════════════════════
-- 2. match_events — append-only audit log
-- ════════════════════════════════════════════════════════════
-- match_id / session_id are ON DELETE SET NULL (NOT cascade) so the trail
-- survives a draft being cancelled/purged. The *_snapshot columns preserve the
-- ids for forensics + per-match ordering after the live FK is nulled.

CREATE TABLE IF NOT EXISTS public.match_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           uuid REFERENCES public.matches(id)  ON DELETE SET NULL,
  session_id         uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
  match_id_snapshot  uuid NOT NULL,
  session_id_snapshot uuid NOT NULL,
  seq                integer NOT NULL,
  event_type         text NOT NULL CHECK (event_type IN
                       ('created','published','roster_swap','team_flip',
                        'ondeck_pull','player_left','cancelled','undo',
                        'score_edit','revert')),
  phase              text NOT NULL CHECK (phase IN ('draft','active','post_completion')),
  actor_type         text NOT NULL CHECK (actor_type IN ('engine','organizer','system')),
  actor_id           uuid,
  actor_name         text,
  correlation_id     uuid,
  reverses_event_id  uuid REFERENCES public.match_events(id) ON DELETE SET NULL,
  movements          jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload            jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_match_events_match
  ON public.match_events (match_id_snapshot, seq);
CREATE INDEX IF NOT EXISTS idx_match_events_session
  ON public.match_events (session_id_snapshot);
CREATE INDEX IF NOT EXISTS idx_match_events_session_type
  ON public.match_events (session_id_snapshot, event_type);
CREATE INDEX IF NOT EXISTS idx_match_events_correlation
  ON public.match_events (correlation_id) WHERE correlation_id IS NOT NULL;

-- RLS: organizers of the session may read; nobody may write via the API
-- (only SECURITY DEFINER RPCs / service_role insert). Append-only by design.
ALTER TABLE public.match_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS match_events_select_organizer ON public.match_events;
CREATE POLICY match_events_select_organizer ON public.match_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.session_organizers so
             WHERE so.session_id = match_events.session_id AND so.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.sessions s
                WHERE s.id = match_events.session_id AND s.created_by = auth.uid())
  );

-- ════════════════════════════════════════════════════════════
-- 3. record_match_event() — the single event writer
-- ════════════════════════════════════════════════════════════
-- Computes the per-match seq under the caller's existing FOR UPDATE lock on the
-- matches row (callers MUST hold it — every composition RPC below does), inserts
-- the event, and applies the modification_count delta atomically. Returns the
-- new event id (for reverses_event_id linking).
--
-- delta mirrors src/lib/match-provenance.ts modificationDelta():
--   roster_swap/team_flip/ondeck_pull/player_left → +1 ; undo → −1 ; else 0.

CREATE OR REPLACE FUNCTION public.record_match_event(
  p_match_id          uuid,
  p_session_id        uuid,
  p_event_type        text,
  p_phase             text,
  p_actor_type        text,
  p_actor_id          uuid,
  p_actor_name        text,
  p_movements         jsonb DEFAULT '[]'::jsonb,
  p_payload           jsonb DEFAULT NULL,
  p_correlation_id    uuid  DEFAULT NULL,
  p_reverses_event_id uuid  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_seq      integer;
  v_delta    integer;
  v_event_id uuid;
BEGIN
  v_seq := COALESCE(
    (SELECT MAX(seq) FROM public.match_events WHERE match_id = p_match_id), 0
  ) + 1;

  v_delta := CASE
    WHEN p_event_type IN ('roster_swap','team_flip','ondeck_pull','player_left') THEN 1
    WHEN p_event_type = 'undo' THEN -1
    ELSE 0
  END;

  INSERT INTO public.match_events (
    match_id, session_id, match_id_snapshot, session_id_snapshot,
    seq, event_type, phase, actor_type, actor_id, actor_name,
    correlation_id, reverses_event_id, movements, payload
  )
  VALUES (
    p_match_id, p_session_id, p_match_id, p_session_id,
    v_seq, p_event_type, p_phase, p_actor_type, p_actor_id, p_actor_name,
    p_correlation_id, p_reverses_event_id, COALESCE(p_movements, '[]'::jsonb), p_payload
  )
  RETURNING id INTO v_event_id;

  IF v_delta <> 0 THEN
    UPDATE public.matches
    SET    modification_count = GREATEST(0, modification_count + v_delta)
    WHERE  id = p_match_id;
  END IF;

  RETURN v_event_id;
END;
$$;

-- Intentionally service_role-only. The create RPCs are GRANTed to `authenticated`
-- too, and reach this via SECURITY DEFINER composition (caller runs as definer →
-- can invoke a service_role-only function). Keeping it service_role-only is
-- least-privilege; do not GRANT to authenticated.
GRANT EXECUTE ON FUNCTION public.record_match_event(
  uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, uuid, uuid
) TO service_role;

-- Small helper: snapshot a player's current display_name (for movement JSONB).
CREATE OR REPLACE FUNCTION public._player_name(p_player_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT display_name FROM public.profiles WHERE id = p_player_id;
$$;
GRANT EXECUTE ON FUNCTION public._player_name(uuid) TO service_role;

-- ════════════════════════════════════════════════════════════
-- 4. create_match_with_players — set created_method + 'created' event
-- ════════════════════════════════════════════════════════════
-- New params p_actor_id/p_actor_name appended (DEFAULT NULL) so existing 10-arg
-- callers keep working. created_method derives from p_origin ('auto'|'manual').
DROP FUNCTION IF EXISTS public.create_match_with_players(
  uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], public.match_origin, boolean
);

CREATE FUNCTION public.create_match_with_players(
  p_session_id      uuid,
  p_court_id        uuid,
  p_status          text,
  p_is_mixed_level  boolean,
  p_started_at      timestamptz,
  p_is_on_deck      boolean,
  p_team_a_ids      uuid[],
  p_team_b_ids      uuid[],
  p_origin          public.match_origin DEFAULT 'auto',
  p_is_published    boolean DEFAULT false,
  p_actor_id        uuid DEFAULT NULL,
  p_actor_name      text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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

  -- Step a: Create the match row. created_method derives from p_origin
  -- ('auto'|'manual'); the legacy origin column is no longer written (dropped
  -- in migration 2 — it keeps its DEFAULT 'auto' transitionally).
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
  END IF;

  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts SET status = 'in_use'::court_status WHERE id = p_court_id;
  END IF;

  -- 'created' event (manual → organizer actor; engine → engine actor).
  -- Wrapped so an audit-logging defect can NEVER roll back match generation
  -- (this is pure logging — delta 0 — on the hot matchmaking path).
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
$$;

GRANT EXECUTE ON FUNCTION public.create_match_with_players(
  uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[],
  public.match_origin, boolean, uuid, text
) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════
-- 5. create_held_cross_court_match — created_method='held' + 'created' event
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.create_held_cross_court_match(
  uuid, boolean, uuid[], uuid[], uuid, uuid, public.match_origin
);

CREATE FUNCTION public.create_held_cross_court_match(
  p_session_id           uuid,
  p_is_mixed_level       boolean,
  p_team_a_ids           uuid[],
  p_team_b_ids           uuid[],
  p_pulled_player_id     uuid,
  p_pulled_from_match_id uuid,
  p_origin               public.match_origin DEFAULT 'auto',
  p_actor_id             uuid DEFAULT NULL,
  p_actor_name           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_id      UUID;
  v_all_ids       UUID[];
  v_waiting_ids   UUID[];
  v_waiting_count INT;
  v_pulled_ok     INT;
  v_held_conflict INT;
  v_conflict      INT;
BEGIN
  v_all_ids := p_team_a_ids || p_team_b_ids;
  SELECT ARRAY(SELECT unnest(v_all_ids) EXCEPT SELECT p_pulled_player_id)
  INTO   v_waiting_ids;

  IF p_pulled_player_id = ANY(v_waiting_ids)
     OR array_length(v_waiting_ids, 1) IS DISTINCT FROM 3 THEN
    RETURN NULL;
  END IF;

  SET LOCAL lock_timeout = '3s';

  SELECT COUNT(*)::INT INTO v_waiting_count
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_waiting_ids)
    AND  status     = 'waiting';
  IF v_waiting_count != array_length(v_waiting_ids, 1) THEN RETURN NULL; END IF;

  SELECT COUNT(*)::INT INTO v_pulled_ok
  FROM   match_players mp
  JOIN   matches       m ON m.id = mp.match_id
  JOIN   queue_entries q ON q.player_id = mp.player_id AND q.session_id = m.session_id
  WHERE  mp.player_id = p_pulled_player_id
    AND  mp.match_id  = p_pulled_from_match_id
    AND  m.session_id = p_session_id
    AND  m.status     = 'in_progress'
    AND  q.status     = 'playing';
  IF v_pulled_ok = 0 THEN RETURN NULL; END IF;

  SELECT COUNT(*)::INT INTO v_held_conflict
  FROM   matches
  WHERE  session_id = p_session_id
    AND  status     = 'pending'
    AND  p_pulled_player_id = ANY(pulled_player_ids);
  IF v_held_conflict > 0 THEN RETURN NULL; END IF;

  PERFORM 1
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_waiting_ids)
  ORDER BY player_id
  FOR UPDATE;

  SELECT COUNT(*)::INT INTO v_conflict
  FROM   match_players mp
  JOIN   matches       m ON m.id = mp.match_id
  WHERE  mp.player_id = ANY(v_waiting_ids)
    AND  m.session_id = p_session_id
    AND  m.status     IN ('pending', 'in_progress');
  IF v_conflict > 0 THEN RETURN NULL; END IF;

  INSERT INTO matches (
    session_id, court_id, status, is_mixed_level, started_at,
    is_published, pulled_player_ids, pulled_from_match_id, held_ready_at,
    created_method
  )
  VALUES (
    p_session_id, NULL, 'pending'::match_status, p_is_mixed_level, NULL,
    false, ARRAY[p_pulled_player_id], p_pulled_from_match_id, NULL,
    'held'
  )
  RETURNING id INTO v_match_id;

  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  UPDATE queue_entries
  SET    status = 'drafted'::queue_status
  WHERE  session_id = p_session_id AND player_id = ANY(v_waiting_ids);

  -- Non-fatal: an audit defect must not roll back held-draft generation.
  BEGIN
    PERFORM record_match_event(
      v_match_id, p_session_id, 'created', 'draft', 'engine',
      p_actor_id, p_actor_name,
      '[]'::jsonb,
      jsonb_build_object(
        'method', 'held',
        'pulled_player_id', p_pulled_player_id,
        'pulled_from_match_id', p_pulled_from_match_id,
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
$$;

GRANT EXECUTE ON FUNCTION public.create_held_cross_court_match(
  uuid, boolean, uuid[], uuid[], uuid, uuid, public.match_origin, uuid, text
) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════
-- 6. swap_player_in_active_match — roster_swap/undo event (phase active)
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.swap_player_in_active_match(UUID, UUID, UUID, UUID, TEXT);

CREATE FUNCTION public.swap_player_in_active_match(
    p_match_id      UUID,
    p_out_player_id UUID,
    p_in_player_id  UUID,
    p_session_id    UUID,
    p_team          TEXT,
    p_actor_id      UUID DEFAULT NULL,
    p_actor_name    TEXT DEFAULT NULL,
    p_is_undo       BOOLEAN DEFAULT false,
    p_reverses_event_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
    v_match_status match_status;
    v_in_status    queue_status;
BEGIN
    SELECT status INTO v_match_status FROM matches WHERE id = p_match_id FOR UPDATE;
    IF NOT FOUND OR v_match_status != 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id
    ) THEN
        RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
    END IF;

    SELECT status INTO v_in_status FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_in_player_id FOR UPDATE;
    IF NOT FOUND OR v_in_status != 'waiting' THEN
        RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
    END IF;

    DELETE FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_match_id, p_in_player_id, p_team);
    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_in_player_id;

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
$$;

GRANT EXECUTE ON FUNCTION public.swap_player_in_active_match(UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, BOOLEAN, UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- 7. swap_teams_in_active_match — team_flip/undo event (phase active)
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.swap_teams_in_active_match(UUID, UUID, UUID);

CREATE FUNCTION public.swap_teams_in_active_match(
    p_match_id    UUID,
    p_player_a_id UUID,
    p_player_b_id UUID,
    p_actor_id    UUID DEFAULT NULL,
    p_actor_name  TEXT DEFAULT NULL,
    p_is_undo     BOOLEAN DEFAULT false,
    p_reverses_event_id UUID DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
    v_team_a       TEXT;
    v_team_b       TEXT;
    v_match_status match_status;
    v_session_id   uuid;
BEGIN
    SELECT status, session_id INTO v_match_status, v_session_id
    FROM matches WHERE id = p_match_id FOR UPDATE;
    IF NOT FOUND OR v_match_status != 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    SELECT team INTO v_team_a FROM match_players
    WHERE match_id = p_match_id AND player_id = p_player_a_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO v_team_b FROM match_players
    WHERE match_id = p_match_id AND player_id = p_player_b_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    UPDATE match_players SET team = v_team_b WHERE match_id = p_match_id AND player_id = p_player_a_id;
    UPDATE match_players SET team = v_team_a WHERE match_id = p_match_id AND player_id = p_player_b_id;

    UPDATE matches
    SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1
          FROM match_players mp JOIN profiles pr ON pr.id = mp.player_id
          WHERE mp.match_id = p_match_id)
    WHERE id = p_match_id;

    PERFORM record_match_event(
      p_match_id, v_session_id,
      CASE WHEN p_is_undo THEN 'undo' ELSE 'team_flip' END,
      'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(
        jsonb_build_object('player_id', p_player_a_id, 'player_name', _player_name(p_player_a_id),
                           'from_team', v_team_a, 'to_team', v_team_b),
        jsonb_build_object('player_id', p_player_b_id, 'player_name', _player_name(p_player_b_id),
                           'from_team', v_team_b, 'to_team', v_team_a)),
      NULL, NULL, p_reverses_event_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_teams_in_active_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN, UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- 8. swap_active_from_ondeck — TWO correlated ondeck_pull events
-- ════════════════════════════════════════════════════════════
-- Appends p_actor_id/p_actor_name as IN params BEFORE the unchanged OUT params
-- (the PostgREST OUT contract o_out_team/o_ondeck_team is preserved — M8).
-- DROP+CREATE (not REPLACE) so we don't leave a second overload behind.
DROP FUNCTION IF EXISTS public.swap_active_from_ondeck(UUID, UUID, UUID, UUID, UUID, UUID);

CREATE FUNCTION public.swap_active_from_ondeck(
    p_active_match_id  UUID,
    p_out_player_id    UUID,
    p_ondeck_player_id UUID,
    p_ondeck_match_id  UUID,
    p_fill_player_id   UUID,
    p_session_id       UUID,
    p_actor_id         UUID DEFAULT NULL,
    p_actor_name       TEXT DEFAULT NULL,
    OUT o_out_team          TEXT,
    OUT o_ondeck_team       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
    v_active_status  match_status;
    v_ondeck_status  match_status;
    v_fill_status    queue_status;
    v_corr           uuid := gen_random_uuid();
BEGIN
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
    END IF;

    IF NOT FOUND OR v_active_status != 'in_progress' THEN RAISE EXCEPTION 'MATCH_NOT_ACTIVE'; END IF;
    IF v_ondeck_status != 'pending' THEN RAISE EXCEPTION 'ONDECK_MATCH_STARTED'; END IF;

    SELECT team INTO o_out_team FROM match_players
    WHERE match_id = p_active_match_id AND player_id = p_out_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO o_ondeck_team FROM match_players
    WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT status INTO v_fill_status FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_fill_player_id FOR UPDATE;
    IF NOT FOUND OR v_fill_status != 'waiting' THEN RAISE EXCEPTION 'FILL_PLAYER_UNAVAILABLE'; END IF;

    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_active_match_id, p_ondeck_player_id, o_out_team);

    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_ondeck_match_id, p_fill_player_id, o_ondeck_team);

    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_ondeck_player_id;
    UPDATE queue_entries SET status = 'on_deck' WHERE session_id = p_session_id AND player_id = p_fill_player_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_active_match_id)
    WHERE id = p_active_match_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_ondeck_match_id)
    WHERE id = p_ondeck_match_id;

    -- Active-match leg: out_player → ondeck_player
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
    -- On-deck-match leg: ondeck_player → fill_player
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
$$;

GRANT EXECUTE ON FUNCTION public.swap_active_from_ondeck(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;

-- ════════════════════════════════════════════════════════════
-- 9. undo_swap_active_from_ondeck — TWO correlated undo events
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.undo_swap_active_from_ondeck(UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT);

CREATE FUNCTION public.undo_swap_active_from_ondeck(
    p_active_match_id  UUID,
    p_out_player_id    UUID,
    p_ondeck_player_id UUID,
    p_ondeck_match_id  UUID,
    p_fill_player_id   UUID,
    p_session_id       UUID,
    p_out_team         TEXT,
    p_ondeck_team      TEXT,
    p_actor_id         UUID DEFAULT NULL,
    p_actor_name       TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
    v_active_status match_status;
    v_ondeck_status match_status;
    v_corr          uuid := gen_random_uuid();
BEGIN
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
    END IF;

    -- If either match moved on, undo is unsafe — silently abort (no event, no decrement).
    IF v_active_status != 'in_progress' OR v_ondeck_status != 'pending' THEN
        RETURN;
    END IF;

    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_active_match_id, p_out_player_id, p_out_team);

    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_fill_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_ondeck_match_id, p_ondeck_player_id, p_ondeck_team);

    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'on_deck' WHERE session_id = p_session_id AND player_id = p_ondeck_player_id;
    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_fill_player_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_active_match_id)
    WHERE id = p_active_match_id;
    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_ondeck_match_id)
    WHERE id = p_ondeck_match_id;

    -- Reverse both legs (decrement both matches).
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
$$;

GRANT EXECUTE ON FUNCTION public.undo_swap_active_from_ondeck(UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT) TO service_role;

-- ════════════════════════════════════════════════════════════
-- 10. swap_player_in_match (draft swap) — roster_swap/undo (phase draft)
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN);

CREATE FUNCTION public.swap_player_in_match(
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

  IF p_is_published THEN
    UPDATE queue_entries SET status = 'on_deck' WHERE session_id = p_session_id AND player_id = p_in_player_id;
  ELSE
    UPDATE queue_entries SET status = 'drafted' WHERE session_id = p_session_id AND player_id = p_in_player_id;
  END IF;

  UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_out_player_id;

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

-- ════════════════════════════════════════════════════════════
-- 11. swap_match_players (draft) — same-match=team_flip, cross-match=2× roster_swap
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.swap_match_players(UUID, UUID, UUID, UUID);

CREATE FUNCTION public.swap_match_players(
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

  SELECT COUNT(DISTINCT p.skill_level) INTO v_a_distinct
  FROM match_players mp JOIN profiles p ON p.id = mp.player_id WHERE mp.match_id = p_a_match_id;
  UPDATE matches SET is_mixed_level = (v_a_distinct > 1) WHERE id = p_a_match_id;

  IF p_a_match_id != p_b_match_id THEN
    SELECT COUNT(DISTINCT p.skill_level) INTO v_b_distinct
    FROM match_players mp JOIN profiles p ON p.id = mp.player_id WHERE mp.match_id = p_b_match_id;
    UPDATE matches SET is_mixed_level = (v_b_distinct > 1) WHERE id = p_b_match_id;
  END IF;

  IF p_a_match_id = p_b_match_id THEN
    -- Same match: the two players exchanged teams → ONE team_flip event.
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
    -- Cross-match: each draft's roster changed → TWO correlated roster_swap events.
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

-- ════════════════════════════════════════════════════════════
-- 12. fix_record_swap_player — post_completion team_flip/roster_swap event
-- ════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.fix_record_swap_player(UUID, UUID, UUID, UUID);

CREATE FUNCTION public.fix_record_swap_player(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID,
  p_actor_id      UUID DEFAULT NULL,
  p_actor_name    TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_status  TEXT;
  v_match_score_a INT;
  v_match_score_b INT;
  v_out_team      TEXT;
  v_in_team       TEXT;
  v_is_team_flip  BOOLEAN;
  v_winning_team  TEXT;
  v_out_won       BOOLEAN;
  v_in_won        BOOLEAN;
  v_out_teammate  UUID;
  v_in_teammate   UUID;
  v_distinct_lvl  INT;
BEGIN
  IF p_out_player_id = p_in_player_id THEN RAISE EXCEPTION 'Cannot swap a player with themselves'; END IF;

  SELECT status, team_a_score, team_b_score
  INTO   v_match_status, v_match_score_a, v_match_score_b
  FROM   matches WHERE id = p_match_id FOR UPDATE;
  IF v_match_status IS NULL THEN RAISE EXCEPTION 'MATCH_NOT_FOUND'; END IF;
  IF v_match_status != 'completed' THEN RAISE EXCEPTION 'MATCH_NOT_COMPLETED'; END IF;

  SELECT team INTO v_out_team FROM match_players
  WHERE match_id = p_match_id AND player_id = p_out_player_id FOR UPDATE;
  IF v_out_team IS NULL THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

  SELECT team INTO v_in_team FROM match_players
  WHERE match_id = p_match_id AND player_id = p_in_player_id FOR UPDATE;
  v_is_team_flip := (v_in_team IS NOT NULL);

  v_winning_team := CASE
    WHEN v_match_score_a IS NOT NULL AND v_match_score_b IS NOT NULL AND v_match_score_a > v_match_score_b THEN 'a'
    WHEN v_match_score_a IS NOT NULL AND v_match_score_b IS NOT NULL AND v_match_score_b > v_match_score_a THEN 'b'
    ELSE NULL END;

  SELECT player_id INTO v_out_teammate FROM match_players
  WHERE match_id = p_match_id AND team = v_out_team AND player_id != p_out_player_id;
  v_out_won := (v_winning_team IS NOT NULL AND v_winning_team = v_out_team);

  IF v_is_team_flip THEN
    SELECT player_id INTO v_in_teammate FROM match_players
    WHERE match_id = p_match_id AND team = v_in_team AND player_id != p_in_player_id;
    v_in_won := (v_winning_team IS NOT NULL AND v_winning_team = v_in_team);

    UPDATE match_players SET team = v_out_team WHERE match_id = p_match_id AND player_id = p_in_player_id;
    UPDATE match_players SET team = v_in_team  WHERE match_id = p_match_id AND player_id = p_out_player_id;

    IF v_out_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_out_player_id, v_out_teammate, -1, v_out_won, p_session_id); END IF;
    IF v_in_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_in_player_id,  v_in_teammate,  -1, v_in_won,  p_session_id); END IF;
    IF v_in_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_out_player_id, v_in_teammate,  1, v_in_won,  p_session_id); END IF;
    IF v_out_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_in_player_id,  v_out_teammate, 1, v_out_won, p_session_id); END IF;
  ELSE
    DELETE FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_match_id, p_in_player_id, v_out_team);

    UPDATE queue_entries SET games_played = GREATEST(0, games_played - 1)
    WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET games_played = games_played + 1
    WHERE session_id = p_session_id AND player_id = p_in_player_id;

    IF v_out_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_out_player_id, v_out_teammate, -1, v_out_won, p_session_id);
      PERFORM _fix_record_partnership_delta(p_in_player_id,  v_out_teammate,  1, v_out_won, p_session_id);
    END IF;
  END IF;

  SELECT COUNT(DISTINCT pr.skill_level) INTO v_distinct_lvl
  FROM match_players mp JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_match_id;
  UPDATE matches SET is_mixed_level = (v_distinct_lvl > 1) WHERE id = p_match_id;

  -- Post-completion composition event.
  IF v_is_team_flip THEN
    PERFORM record_match_event(
      p_match_id, p_session_id, 'team_flip', 'post_completion',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(
        jsonb_build_object('player_id', p_out_player_id, 'player_name', _player_name(p_out_player_id),
                           'from_team', v_out_team, 'to_team', v_in_team),
        jsonb_build_object('player_id', p_in_player_id, 'player_name', _player_name(p_in_player_id),
                           'from_team', v_in_team, 'to_team', v_out_team))
    );
  ELSE
    PERFORM record_match_event(
      p_match_id, p_session_id, 'roster_swap', 'post_completion',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_out_player_id, 'out_player_name', _player_name(p_out_player_id),
        'in_player_id', p_in_player_id, 'in_player_name', _player_name(p_in_player_id),
        'team', v_out_team))
    );
  END IF;

  PERFORM refresh_alltime_leaderboard();
END;
$$;

GRANT EXECUTE ON FUNCTION public.fix_record_swap_player(UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;
