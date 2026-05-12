-- ============================================================
-- Migration: leaderboard_views
-- Creates the session leaderboard view, all-time materialized
-- view, win streak function, and alltime refresh function.
-- ============================================================

-- ── 1. Session Leaderboard View ─────────────────────────────
-- Regular VIEW: recomputed on every query. Always fresh.
-- GP threshold (>= 3) is applied at query time, not here,
-- so organizers can optionally see all players if needed.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_session_leaderboard AS
WITH match_results AS (
  SELECT
    mh.player_id,
    mh.session_id,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END                                                           AS won,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_a_score, 0)
      ELSE COALESCE(mh.team_b_score, 0)
    END                                                           AS pts_for,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_b_score, 0)
      ELSE COALESCE(mh.team_a_score, 0)
    END                                                           AS pts_against
  FROM public.v_match_history mh
  WHERE mh.match_status = 'completed'
)
SELECT
  mr.player_id,
  mr.session_id,
  p.display_name,
  COUNT(*)::int                                                   AS games_played,
  SUM(mr.won)::int                                               AS wins,
  (COUNT(*) - SUM(mr.won))::int                                  AS losses,
  SUM(mr.pts_for)::int                                           AS points_for,
  SUM(mr.pts_against)::int                                       AS points_against,
  (SUM(mr.pts_for) - SUM(mr.pts_against))::int                   AS point_diff,
  ROUND(
    SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
  )                                                               AS win_pct
FROM match_results mr
JOIN public.profiles p ON p.id = mr.player_id
GROUP BY mr.player_id, mr.session_id, p.display_name;

-- ── 2. All-Time Materialized View ───────────────────────────
-- Stored on disk; never blocks reads during refresh.
-- Refreshed by calling refresh_alltime_leaderboard() from
-- the endMatchAction server action after each score is saved.
-- ────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.v_alltime_leaderboard_mat AS
WITH match_results AS (
  SELECT
    mh.player_id,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END                                                           AS won,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_a_score, 0)
      ELSE COALESCE(mh.team_b_score, 0)
    END                                                           AS pts_for,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_b_score, 0)
      ELSE COALESCE(mh.team_a_score, 0)
    END                                                           AS pts_against
  FROM public.v_match_history mh
  WHERE mh.match_status = 'completed'
)
SELECT
  mr.player_id,
  p.display_name,
  COUNT(*)::int                                                   AS games_played,
  SUM(mr.won)::int                                               AS wins,
  (COUNT(*) - SUM(mr.won))::int                                  AS losses,
  SUM(mr.pts_for)::int                                           AS points_for,
  SUM(mr.pts_against)::int                                       AS points_against,
  (SUM(mr.pts_for) - SUM(mr.pts_against))::int                   AS point_diff,
  ROUND(
    SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
  )                                                               AS win_pct
FROM match_results mr
JOIN public.profiles p ON p.id = mr.player_id
GROUP BY mr.player_id, p.display_name
WITH DATA;

-- Required for CONCURRENTLY refresh (prevents read-blocking)
CREATE UNIQUE INDEX IF NOT EXISTS idx_alltime_leaderboard_player_id
  ON public.v_alltime_leaderboard_mat (player_id);

-- ── 3. Win Streak Function ───────────────────────────────────
-- Returns consecutive wins ending at the player's most recent
-- match, counting backwards until the first loss.
--
-- p_session_id = uuid  → session-scoped streak (tonight only)
-- p_session_id = NULL  → cross-session streak (all-time)
--
-- Algorithm: ROW_NUMBER() orders matches newest-first per
-- player. Find the min rn where won=0 (first loss looking
-- back). Streak = count of wins with rn < that loss.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_player_streaks(
  p_session_id uuid DEFAULT NULL
)
RETURNS TABLE (player_id uuid, win_streak int)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH ordered_results AS (
    SELECT
      mh.player_id,
      mh.completed_at,
      CASE
        WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
          OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
        THEN 1 ELSE 0
      END AS won,
      ROW_NUMBER() OVER (
        PARTITION BY mh.player_id
        ORDER BY mh.completed_at DESC
      ) AS rn
    FROM public.v_match_history mh
    WHERE mh.match_status = 'completed'
      AND (p_session_id IS NULL OR mh.session_id = p_session_id)
  ),
  first_loss AS (
    SELECT player_id, MIN(rn) AS first_loss_rn
    FROM ordered_results
    WHERE won = 0
    GROUP BY player_id
  )
  SELECT
    o.player_id,
    COUNT(*)::int AS win_streak
  FROM ordered_results o
  LEFT JOIN first_loss fl ON fl.player_id = o.player_id
  WHERE o.won = 1
    AND o.rn < COALESCE(fl.first_loss_rn, 2147483647)
  GROUP BY o.player_id;
$$;

-- ── 4. All-Time Refresh Function ─────────────────────────────
-- Called from endMatchAction server action via supabase.rpc().
-- PL/pgSQL required — REFRESH MATERIALIZED VIEW is a utility
-- command that cannot appear in a plain SQL function body.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_alltime_leaderboard()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_alltime_leaderboard_mat;
END;
$$;
