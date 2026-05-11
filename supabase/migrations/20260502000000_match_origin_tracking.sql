-- ============================================================
-- Migration: match_origin_tracking
-- Adds a match_origin ENUM column to matches so every match can
-- be identified as auto-generated, manually composed, or
-- auto-generated then edited (modified).
--
-- Origin semantics (sticky in the conservative direction):
--   auto     → auto       (untouched engine match)
--   auto     → modified   (engine match that had a swap)
--   manual   → manual     (organizer-composed, always stays manual)
--   modified → modified   (further swaps don't change anything)
--
-- Sticky rule implementation: swap RPCs use
--   WHERE origin = 'auto'
-- so manual is never demoted and modified never re-fires.
--
-- Objects modified:
--   1. ENUM type           public.match_origin
--   2. Column              matches.origin (NOT NULL DEFAULT 'auto')
--   3. RPC update          create_match_with_players (+ p_origin param)
--   4. RPC update          swap_player_in_match       (+ Step f)
--   5. RPC update          swap_match_players         (+ origin bumps)
--   6. View rebuild        v_match_history            (+ match_origin col)
--   7. View rebuild        v_session_leaderboard      (dropped by CASCADE)
--   8. Mat-view rebuild    v_alltime_leaderboard_mat  (dropped by CASCADE)
-- ============================================================

-- ── 1. ENUM type ─────────────────────────────────────────────
-- IF NOT EXISTS guard: when the initial_schema migration has already
-- created the base tables (local dev), this is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'match_origin'
  ) THEN
    CREATE TYPE public.match_origin AS ENUM ('auto', 'manual', 'modified');
  END IF;
END $$;

-- ── 2. Column on matches ─────────────────────────────────────
-- IF NOT EXISTS guard: idempotent when base schema already has the column.
-- NOT NULL DEFAULT 'auto' atomically labels all historical rows.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS origin public.match_origin NOT NULL DEFAULT 'auto';

-- ── 3. Update create_match_with_players ──────────────────────
-- New parameter p_origin (DEFAULT 'auto') is appended so all
-- existing callers continue to work without changes.
-- The matchmaking engine passes 'auto'; the manual-match action
-- will pass 'manual'.
CREATE OR REPLACE FUNCTION public.create_match_with_players(
  p_session_id      uuid,
  p_court_id        uuid,
  p_status          text,
  p_is_mixed_level  boolean,
  p_started_at      timestamptz,
  p_is_on_deck      boolean,
  p_team_a_ids      uuid[],
  p_team_b_ids      uuid[],
  p_origin          public.match_origin DEFAULT 'auto'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_id     UUID;
  v_queue_status TEXT;
BEGIN
  -- Step a: Create the match row — cast TEXT → match_status enum
  INSERT INTO matches (session_id, court_id, status, is_mixed_level, started_at, origin)
  VALUES (p_session_id, p_court_id, p_status::match_status, p_is_mixed_level, p_started_at, p_origin)
  RETURNING id INTO v_match_id;

  -- Step b: Insert team A players
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';

  -- Step c: Insert team B players
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  -- Step d: Update queue statuses for all 4 players
  v_queue_status := CASE WHEN p_is_on_deck THEN 'on_deck' ELSE 'playing' END;

  UPDATE queue_entries
  SET    status = v_queue_status::queue_status
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(p_team_a_ids || p_team_b_ids);

  -- Step e: Mark court as in_use (only for live, court-assigned matches)
  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts
    SET    status = 'in_use'::court_status
    WHERE  id = p_court_id;
  END IF;

  RETURN v_match_id;
END;
$$;

-- ── 4. Update swap_player_in_match ───────────────────────────
-- Adds Step f: promote origin auto → modified.
-- WHERE origin = 'auto' is the sticky-rule guard — manual stays
-- manual, modified stays modified.
CREATE OR REPLACE FUNCTION public.swap_player_in_match(
  p_match_id       uuid,
  p_out_player_id  uuid,
  p_in_player_id   uuid,
  p_session_id     uuid,
  p_team           text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_distinct_levels INT;
BEGIN
  -- Step a: Remove outgoing player from this match
  DELETE FROM match_players
  WHERE match_id = p_match_id
    AND player_id = p_out_player_id;

  -- Step b: Insert incoming player on the same team
  INSERT INTO match_players (match_id, player_id, team)
  VALUES (p_match_id, p_in_player_id, p_team);

  -- Step c: Mark incoming player as on_deck in the queue
  UPDATE queue_entries
  SET status = 'on_deck'
  WHERE session_id = p_session_id
    AND player_id  = p_in_player_id;

  -- Step d: Return outgoing player to the waiting queue
  UPDATE queue_entries
  SET status = 'waiting'
  WHERE session_id = p_session_id
    AND player_id  = p_out_player_id;

  -- Step e: Recompute is_mixed_level from the current post-swap roster
  SELECT COUNT(DISTINCT p.skill_level) INTO v_distinct_levels
  FROM  match_players mp
  JOIN  profiles p ON p.id = mp.player_id
  WHERE mp.match_id = p_match_id;

  UPDATE matches
  SET is_mixed_level = (v_distinct_levels > 1)
  WHERE id = p_match_id;

  -- Step f: Promote origin auto → modified (sticky rule)
  -- Only fires when origin IS 'auto'; manual and modified are untouched.
  UPDATE matches
  SET    origin = 'modified'::public.match_origin
  WHERE  id     = p_match_id
    AND  origin = 'auto'::public.match_origin;
END;
$$;

-- ── 5. Update swap_match_players ─────────────────────────────
-- Adds origin promotion for both matches (sticky rule each).
CREATE OR REPLACE FUNCTION public.swap_match_players(
  p_a_match_id   uuid,
  p_a_player_id  uuid,
  p_b_match_id   uuid,
  p_b_player_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_a_match_status TEXT;
  v_b_match_status TEXT;
  v_a_team         TEXT;
  v_b_team         TEXT;
  v_a_distinct     INT;
  v_b_distinct     INT;
BEGIN
  IF p_a_player_id = p_b_player_id THEN
    RAISE EXCEPTION 'Cannot swap a player with themselves';
  END IF;

  SELECT status INTO v_a_match_status
  FROM matches
  WHERE id = p_a_match_id
  FOR UPDATE;

  IF p_a_match_id != p_b_match_id THEN
    SELECT status INTO v_b_match_status
    FROM matches
    WHERE id = p_b_match_id
    FOR UPDATE;
  ELSE
    v_b_match_status := v_a_match_status;
  END IF;

  IF v_a_match_status IS NULL OR v_a_match_status != 'pending' OR
     v_b_match_status IS NULL OR v_b_match_status != 'pending' THEN
    RAISE EXCEPTION 'MATCH_STARTED';
  END IF;

  SELECT team INTO v_a_team
  FROM match_players
  WHERE match_id = p_a_match_id AND player_id = p_a_player_id
  FOR UPDATE;

  SELECT team INTO v_b_team
  FROM match_players
  WHERE match_id = p_b_match_id AND player_id = p_b_player_id
  FOR UPDATE;

  IF v_a_team IS NULL OR v_b_team IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
  END IF;

  DELETE FROM match_players
  WHERE (match_id = p_a_match_id AND player_id = p_a_player_id)
     OR (match_id = p_b_match_id AND player_id = p_b_player_id);

  INSERT INTO match_players (match_id, player_id, team)
  VALUES
    (p_b_match_id, p_a_player_id, v_b_team),
    (p_a_match_id, p_b_player_id, v_a_team);

  SELECT COUNT(DISTINCT p.skill_level) INTO v_a_distinct
  FROM  match_players mp
  JOIN  profiles p ON p.id = mp.player_id
  WHERE mp.match_id = p_a_match_id;

  UPDATE matches
  SET    is_mixed_level = (v_a_distinct > 1)
  WHERE  id = p_a_match_id;

  IF p_a_match_id != p_b_match_id THEN
    SELECT COUNT(DISTINCT p.skill_level) INTO v_b_distinct
    FROM  match_players mp
    JOIN  profiles p ON p.id = mp.player_id
    WHERE mp.match_id = p_b_match_id;

    UPDATE matches
    SET    is_mixed_level = (v_b_distinct > 1)
    WHERE  id = p_b_match_id;
  END IF;

  -- Promote origin auto → modified for match A (sticky rule)
  UPDATE matches
  SET    origin = 'modified'::public.match_origin
  WHERE  id     = p_a_match_id
    AND  origin = 'auto'::public.match_origin;

  -- Promote origin auto → modified for match B (only when different match)
  IF p_a_match_id != p_b_match_id THEN
    UPDATE matches
    SET    origin = 'modified'::public.match_origin
    WHERE  id     = p_b_match_id
      AND  origin = 'auto'::public.match_origin;
  END IF;
END;
$$;

-- ── 6. Rebuild v_match_history to expose origin ──────────────
-- Drop dependents explicitly before dropping the view to
-- avoid implicit CASCADE surprises in future migrations.
DROP VIEW IF EXISTS public.v_session_leaderboard;
DROP MATERIALIZED VIEW IF EXISTS public.v_alltime_leaderboard_mat;
DROP VIEW IF EXISTS public.v_match_history;

CREATE OR REPLACE VIEW public.v_match_history AS
  SELECT mp.player_id,
      m.session_id,
      m.id AS match_id,
      m.court_id,
      c.name AS court_name,
      mp.team,
      m.team_a_score,
      m.team_b_score,
      m.status AS match_status,
      m.completed_at,
      m.origin AS match_origin,
      ( SELECT jsonb_agg(jsonb_build_object(
                 'game_number',   mg.game_number,
                 'team_a_score',  mg.team_a_score,
                 'team_b_score',  mg.team_b_score
               ) ORDER BY mg.game_number)
          FROM match_games mg
         WHERE mg.match_id = m.id) AS game_scores,
      ( SELECT array_agg(p2.display_name)
          FROM match_players mp2
          JOIN profiles p2 ON p2.id = mp2.player_id
         WHERE mp2.match_id = m.id
           AND mp2.team = mp.team
           AND mp2.player_id <> mp.player_id) AS teammates,
      ( SELECT array_agg(p3.display_name)
          FROM match_players mp3
          JOIN profiles p3 ON p3.id = mp3.player_id
         WHERE mp3.match_id = m.id
           AND mp3.team <> mp.team) AS opponents
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    LEFT JOIN courts c ON c.id = m.court_id
   WHERE m.status = 'completed'::match_status
   ORDER BY m.completed_at DESC;

-- ── 7. Recreate v_session_leaderboard ────────────────────────
CREATE OR REPLACE VIEW public.v_session_leaderboard AS
WITH match_results AS (
  SELECT
    mh.player_id,
    mh.session_id,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END                                                         AS won,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_a_score, 0)
      ELSE COALESCE(mh.team_b_score, 0)
    END                                                         AS pts_for,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_b_score, 0)
      ELSE COALESCE(mh.team_a_score, 0)
    END                                                         AS pts_against
  FROM public.v_match_history mh
  WHERE mh.match_status = 'completed'
)
SELECT
  mr.player_id,
  mr.session_id,
  p.display_name,
  COUNT(*)::int                                                 AS games_played,
  SUM(mr.won)::int                                             AS wins,
  (COUNT(*) - SUM(mr.won))::int                                AS losses,
  SUM(mr.pts_for)::int                                         AS points_for,
  SUM(mr.pts_against)::int                                     AS points_against,
  (SUM(mr.pts_for) - SUM(mr.pts_against))::int                 AS point_diff,
  ROUND(
    SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
  )                                                             AS win_pct
FROM match_results mr
JOIN public.profiles p ON p.id = mr.player_id
GROUP BY mr.player_id, mr.session_id, p.display_name;

-- ── 8. Recreate v_alltime_leaderboard_mat ────────────────────
CREATE MATERIALIZED VIEW public.v_alltime_leaderboard_mat AS
WITH match_results AS (
  SELECT
    mh.player_id,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END                                                         AS won,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_a_score, 0)
      ELSE COALESCE(mh.team_b_score, 0)
    END                                                         AS pts_for,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_b_score, 0)
      ELSE COALESCE(mh.team_a_score, 0)
    END                                                         AS pts_against
  FROM public.v_match_history mh
  WHERE mh.match_status = 'completed'
)
SELECT
  mr.player_id,
  p.display_name,
  COUNT(*)::int                                                 AS games_played,
  SUM(mr.won)::int                                             AS wins,
  (COUNT(*) - SUM(mr.won))::int                                AS losses,
  SUM(mr.pts_for)::int                                         AS points_for,
  SUM(mr.pts_against)::int                                     AS points_against,
  (SUM(mr.pts_for) - SUM(mr.pts_against))::int                 AS point_diff,
  ROUND(
    SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
  )                                                             AS win_pct
FROM match_results mr
JOIN public.profiles p ON p.id = mr.player_id
GROUP BY mr.player_id, p.display_name
WITH DATA;

-- Required for CONCURRENTLY refresh (prevents read-blocking)
CREATE UNIQUE INDEX IF NOT EXISTS idx_alltime_leaderboard_player_id
  ON public.v_alltime_leaderboard_mat (player_id);
