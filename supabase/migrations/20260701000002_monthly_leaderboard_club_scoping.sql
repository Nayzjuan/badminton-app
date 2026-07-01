-- ============================================================
-- Multi-Tenant Phase 3 (File B) — club-scope the monthly leaderboard RPCs
-- ============================================================
-- get_monthly_leaderboard + get_leaderboard_months read matches/match_players
-- DIRECTLY (not the view chain) and are SECURITY INVOKER. They gain an ADDITIVE
-- p_club_id DEFAULT NULL (NULL = today's all-clubs behavior) and a sessions JOIN
-- to filter by s.club_id (matches has no club_id). Signature change (extra
-- param) => DROP + CREATE; default PUBLIC EXECUTE is restored on CREATE, which
-- matches the pre-change grant set (PUBLIC/anon/authenticated/service_role).
--
-- get_leaderboard_months still UNIONs the CURRENT month unconditionally so the
-- picker always offers "this month" regardless of club activity.
--
-- Only touches functions — no views, no base tables. Additive + reversible.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_monthly_leaderboard(integer, integer);
CREATE FUNCTION public.get_monthly_leaderboard(p_year integer, p_month integer, p_club_id uuid DEFAULT NULL)
 RETURNS TABLE(player_id uuid, display_name text, games_played integer, wins integer, losses integer, points_for integer, points_against integer, point_diff integer, win_pct numeric)
 LANGUAGE sql
 STABLE
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
    JOIN sessions s ON s.id = m.session_id
    CROSS JOIN bounds b
    WHERE m.status = 'completed'
      AND m.completed_at >= b.m_start
      AND m.completed_at <  b.m_end
      AND (p_club_id IS NULL OR s.club_id = p_club_id)
  )
  SELECT
    mr.player_id,
    p.display_name,
    COUNT(*)::int,
    SUM(mr.won)::int,
    (COUNT(*) - SUM(mr.won))::int,
    SUM(mr.pts_for)::int,
    SUM(mr.pts_against)::int,
    (SUM(mr.pts_for) - SUM(mr.pts_against))::int,
    ROUND(SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1)
  FROM match_results mr
  JOIN public.profiles p ON p.id = mr.player_id
  GROUP BY mr.player_id, p.display_name;
$function$;

DROP FUNCTION IF EXISTS public.get_leaderboard_months();
CREATE FUNCTION public.get_leaderboard_months(p_club_id uuid DEFAULT NULL)
 RETURNS TABLE(year integer, month integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT
    EXTRACT(YEAR  FROM (m.completed_at AT TIME ZONE 'Asia/Manila'))::int,
    EXTRACT(MONTH FROM (m.completed_at AT TIME ZONE 'Asia/Manila'))::int
  FROM matches m
  JOIN sessions s ON s.id = m.session_id
  WHERE m.status = 'completed' AND m.completed_at IS NOT NULL
    AND (p_club_id IS NULL OR s.club_id = p_club_id)
  UNION
  SELECT
    EXTRACT(YEAR  FROM (now() AT TIME ZONE 'Asia/Manila'))::int,
    EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Manila'))::int
  ORDER BY 1 DESC, 2 DESC;
$function$;
