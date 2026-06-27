-- ============================================================
-- Monthly Leaderboard — live RPC + month picker source + index
-- ============================================================
-- Adds a per-month leaderboard that aggregates one Manila-month slice of
-- completed matches, live (no materialized view). See MONTHLY_LEADERBOARD_PLAN.md.
--
-- Month membership is anchored in Asia/Manila (UTC+8, no DST), identical for
-- every viewer. The month's [start, end) UTC instants are computed ONCE per
-- call so the row filter is a sargable range scan on completed_at (uses the
-- partial index below), not a per-row `AT TIME ZONE` expression.
--
-- Reads the base tables (match_players ⋈ matches), NOT v_match_history — the
-- view computes per-row teammates/opponents arrays the leaderboard discards.
-- Verified: base-table aggregation yields identical games/wins/points to the
-- existing views.
--
-- SECURITY INVOKER (default): respects the matches_select RLS policy, which
-- already permits anon/authenticated to read completed matches. No DEFINER
-- needed (unlike get_player_streaks / get_alltime_snapshot_before).
-- ============================================================

-- ── Range-scan index for monthly (and any completed_at range) ──
CREATE INDEX IF NOT EXISTS idx_matches_completed_at
  ON public.matches (completed_at) WHERE status = 'completed';

-- ── get_monthly_leaderboard(year, month) ─────────────────────
CREATE OR REPLACE FUNCTION public.get_monthly_leaderboard(p_year int, p_month int)
RETURNS TABLE (
  player_id      uuid,
  display_name   text,
  games_played   int,
  wins           int,
  losses         int,
  points_for     int,
  points_against int,
  point_diff     int,
  win_pct        numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT
      make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'Asia/Manila')                      AS m_start,
      make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'Asia/Manila') + interval '1 month' AS m_end
  ),
  match_results AS (
    SELECT
      mp.player_id,
      CASE
        WHEN (mp.team = 'a' AND m.team_a_score > m.team_b_score)
          OR (mp.team = 'b' AND m.team_b_score > m.team_a_score)
        THEN 1 ELSE 0
      END AS won,
      CASE WHEN mp.team = 'a'
        THEN COALESCE(m.team_a_score, 0)
        ELSE COALESCE(m.team_b_score, 0)
      END AS pts_for,
      CASE WHEN mp.team = 'a'
        THEN COALESCE(m.team_b_score, 0)
        ELSE COALESCE(m.team_a_score, 0)
      END AS pts_against
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    CROSS JOIN bounds b
    WHERE m.status = 'completed'
      AND m.completed_at >= b.m_start
      AND m.completed_at <  b.m_end
  )
  SELECT
    mr.player_id,
    p.display_name,
    COUNT(*)::int                                          AS games_played,
    SUM(mr.won)::int                                       AS wins,
    (COUNT(*) - SUM(mr.won))::int                          AS losses,
    SUM(mr.pts_for)::int                                   AS points_for,
    SUM(mr.pts_against)::int                               AS points_against,
    (SUM(mr.pts_for) - SUM(mr.pts_against))::int           AS point_diff,
    ROUND(SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS win_pct
  FROM match_results mr
  JOIN public.profiles p ON p.id = mr.player_id
  GROUP BY mr.player_id, p.display_name;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_leaderboard(int, int) TO anon, authenticated;

-- ── get_leaderboard_months() — month picker source ───────────
-- Distinct Manila-months that have completed matches, UNIONed with the current
-- Manila month (so the current month is always selectable even when empty),
-- newest first.
CREATE OR REPLACE FUNCTION public.get_leaderboard_months()
RETURNS TABLE (year int, month int)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT
    EXTRACT(YEAR  FROM (m.completed_at AT TIME ZONE 'Asia/Manila'))::int  AS year,
    EXTRACT(MONTH FROM (m.completed_at AT TIME ZONE 'Asia/Manila'))::int  AS month
  FROM matches m
  WHERE m.status = 'completed' AND m.completed_at IS NOT NULL
  UNION
  SELECT
    EXTRACT(YEAR  FROM (now() AT TIME ZONE 'Asia/Manila'))::int,
    EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Manila'))::int
  ORDER BY 1 DESC, 2 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_leaderboard_months() TO anon, authenticated;
