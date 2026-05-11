-- ============================================================
-- Migration: Add 'drafted' queue_status + update create_match_with_players
-- ============================================================
-- Why:
--   Previously, players in an unpublished draft match kept status='waiting'
--   because there was no 'drafted' state. This forced the TypeScript engine
--   to maintain a separate `committedSet` workaround (two extra queries per
--   engine run) to exclude already-drafted players from the waiting pool.
--
--   The correct fix is a first-class 'drafted' status:
--     waiting → drafted  (engine creates an unpublished draft)
--     drafted → on_deck  (organizer publishes the draft)
--     drafted → waiting  (organizer cancels the draft; players freed)
--
--   With this status, the existing view v_queue_with_wait_time (which filters
--   status = 'waiting') naturally excludes drafted players from the pool.
--   The TypeScript committedSet workaround can then be removed entirely.
--
-- Note on ALTER TYPE:
--   ALTER TYPE ... ADD VALUE executes outside a transaction in Postgres < 12.
--   On Postgres 12+ (Supabase default) it is safe inside a transaction.
--   The IF NOT EXISTS guard makes this migration idempotent.
-- ============================================================

-- ── 1. Extend the enum ────────────────────────────────────────────────────────
ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'drafted' AFTER 'waiting';

-- ── 2. Replace create_match_with_players ─────────────────────────────────────
-- Identical to the 20260507 version in all parameters, return type, and GRANT.
-- The only change is Step d: unpublished drafts now set status = 'drafted'
-- instead of leaving status unchanged (= 'waiting').
--
-- Guard 0 still checks status = 'waiting': the TypeScript engine reads only
-- 'waiting' players from v_queue_with_wait_time, so at the moment the RPC is
-- called all proposed players are still 'waiting'. 'drafted' is set here, as
-- the last step, within the same transaction that locks the rows.
CREATE OR REPLACE FUNCTION public.create_match_with_players(
  p_session_id      uuid,
  p_court_id        uuid,
  p_status          text,
  p_is_mixed_level  boolean,
  p_started_at      timestamptz,
  p_is_on_deck      boolean,
  p_team_a_ids      uuid[],
  p_team_b_ids      uuid[],
  p_origin          public.match_origin DEFAULT 'auto',
  p_is_published    boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_id      UUID;
  v_all_ids       UUID[];
  v_waiting_count INT;
  v_conflict      INT;
BEGIN
  v_all_ids := p_team_a_ids || p_team_b_ids;

  -- ── Bound lock-acquisition wait time ──────────────────────────────────────
  SET LOCAL lock_timeout = '3s';

  -- ── Guard 0: Pre-flight status check ─────────────────────────────────────
  -- All proposed players must be 'waiting'. 'drafted' players are in a
  -- different draft and cannot be re-drafted (they won't appear in the engine
  -- pool, so this is a belt-and-suspenders check).
  SELECT COUNT(*)::INT INTO v_waiting_count
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_all_ids)
    AND  status     = 'waiting';

  IF v_waiting_count != array_length(v_all_ids, 1) THEN
    RETURN NULL;
  END IF;

  -- ── Guard 1: Row-level lock ────────────────────────────────────────────
  PERFORM 1
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_all_ids)
  ORDER BY player_id
  FOR UPDATE;

  -- ── Guard 2: Conflict check ────────────────────────────────────────────
  SELECT COUNT(*)::INT INTO v_conflict
  FROM   match_players mp
  JOIN   matches       m  ON m.id = mp.match_id
  WHERE  mp.player_id  = ANY(v_all_ids)
    AND  m.session_id  = p_session_id
    AND  m.status      IN ('pending', 'in_progress');

  IF v_conflict > 0 THEN
    RETURN NULL;
  END IF;

  -- ── Step a: Create the match row ───────────────────────────────────────
  INSERT INTO matches (
    session_id, court_id, status, is_mixed_level,
    started_at, origin, is_published
  )
  VALUES (
    p_session_id, p_court_id, p_status::match_status, p_is_mixed_level,
    p_started_at, p_origin, p_is_published
  )
  RETURNING id INTO v_match_id;

  -- ── Step b: Insert team A players ─────────────────────────────────────
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';

  -- ── Step c: Insert team B players ─────────────────────────────────────
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  -- ── Step d: Update queue statuses ─────────────────────────────────────
  --   Direct court match  → 'playing'
  --   Published on-deck   → 'on_deck'  (alert fires — organizer approved)
  --   Draft (unpublished) → 'drafted'  (players reserved; alert suppressed)
  --
  -- Previously unpublished drafts left players as 'waiting', requiring a
  -- TypeScript-side committedSet workaround to exclude them from future
  -- engine runs. 'drafted' makes this exclusion first-class in the DB.
  IF NOT p_is_on_deck THEN
    UPDATE queue_entries
    SET    status = 'playing'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_all_ids);
  ELSIF p_is_published THEN
    UPDATE queue_entries
    SET    status = 'on_deck'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_all_ids);
  ELSE
    -- Draft (unpublished): reserve players without alerting them yet.
    UPDATE queue_entries
    SET    status = 'drafted'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_all_ids);
  END IF;

  -- ── Step e: Mark court as in_use ──────────────────────────────────────
  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts
    SET    status = 'in_use'::court_status
    WHERE  id = p_court_id;
  END IF;

  RETURN v_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_match_with_players(
  uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], public.match_origin, boolean
) TO authenticated, service_role;
