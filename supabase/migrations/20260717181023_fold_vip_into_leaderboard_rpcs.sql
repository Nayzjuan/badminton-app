-- ============================================================================
-- M3: fold vip_tag / vip_theme into the two live leaderboard RPCs so the client
-- no longer fires a separate buildVipMap() profiles query per board fetch on the
-- 15 s-tick hot paths (session + monthly). The profiles join already exists in
-- both functions; we only add two projected columns (+ GROUP BY them).
--
-- RETURNS TABLE gains two columns → requires DROP + CREATE (CREATE OR REPLACE
-- cannot change a function's return type). Verified: no DB object depends on
-- either function, so a plain DROP (not CASCADE) is safe. Grants reproduced.
--
-- The all-time board keeps its live buildVipMap() (it reads the pre-aggregated
-- matview and is fetch-once per tab visit; folding VIP there would need a matview
-- rebuild AND make the badge snapshot-stale, so it's intentionally left live).
-- ============================================================================

-- ── Session board ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_session_leaderboard_public(uuid);
CREATE FUNCTION public.get_session_leaderboard_public(p_session_id uuid)
 RETURNS TABLE(player_id uuid, session_id uuid, club_id uuid, display_name text,
   games_played integer, wins integer, losses integer, points_for integer,
   points_against integer, point_diff integer, win_pct numeric,
   vip_tag text, vip_theme text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH match_results AS (
    SELECT
      mh.player_id,
      mh.session_id,
      mh.club_id,
      CASE
        WHEN (mh.team = 'a'::bpchar AND mh.team_a_score > mh.team_b_score)
          OR (mh.team = 'b'::bpchar AND mh.team_b_score > mh.team_a_score)
        THEN 1 ELSE 0
      END AS won,
      CASE WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_a_score, 0) ELSE COALESCE(mh.team_b_score, 0) END AS pts_for,
      CASE WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_b_score, 0) ELSE COALESCE(mh.team_a_score, 0) END AS pts_against
    FROM v_match_history mh
    WHERE mh.match_status = 'completed'::match_status
      AND mh.session_id = p_session_id
  )
  SELECT
    mr.player_id,
    mr.session_id,
    mr.club_id,
    p.display_name,
    (count(*))::integer AS games_played,
    (sum(mr.won))::integer AS wins,
    ((count(*) - sum(mr.won)))::integer AS losses,
    (sum(mr.pts_for))::integer AS points_for,
    (sum(mr.pts_against))::integer AS points_against,
    ((sum(mr.pts_for) - sum(mr.pts_against)))::integer AS point_diff,
    round(((sum(mr.won))::numeric / (nullif(count(*), 0))::numeric) * 100, 1) AS win_pct,
    p.vip_tag,
    p.vip_theme
  FROM match_results mr
  JOIN profiles p ON p.id = mr.player_id
  GROUP BY mr.player_id, mr.session_id, mr.club_id, p.display_name, p.vip_tag, p.vip_theme;
$function$;
GRANT EXECUTE ON FUNCTION public.get_session_leaderboard_public(uuid) TO anon, authenticated, service_role;

-- ── Monthly board ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_monthly_leaderboard(integer, integer, uuid);
CREATE FUNCTION public.get_monthly_leaderboard(p_year integer, p_month integer, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(player_id uuid, display_name text, games_played integer, wins integer,
   losses integer, points_for integer, points_against integer, point_diff integer,
   win_pct numeric, vip_tag text, vip_theme text)
 LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT make_timestamptz(p_year,p_month,1,0,0,0,'Asia/Manila') AS m_start,
           make_timestamptz(p_year,p_month,1,0,0,0,'Asia/Manila')+interval '1 month' AS m_end),
  match_results AS (
    SELECT mp.player_id,
      CASE WHEN (mp.team='a' AND m.team_a_score>m.team_b_score) OR (mp.team='b' AND m.team_b_score>m.team_a_score) THEN 1 ELSE 0 END AS won,
      CASE WHEN mp.team='a' THEN COALESCE(m.team_a_score,0) ELSE COALESCE(m.team_b_score,0) END AS pts_for,
      CASE WHEN mp.team='a' THEN COALESCE(m.team_b_score,0) ELSE COALESCE(m.team_a_score,0) END AS pts_against
    FROM matches m JOIN match_players mp ON mp.match_id=m.id JOIN sessions s ON s.id=m.session_id CROSS JOIN bounds b
    WHERE m.status='completed' AND m.completed_at>=b.m_start AND m.completed_at<b.m_end AND (p_club_id IS NULL OR s.club_id=p_club_id))
  SELECT mr.player_id, p.display_name, COUNT(*)::int, SUM(mr.won)::int, (COUNT(*)-SUM(mr.won))::int,
    SUM(mr.pts_for)::int, SUM(mr.pts_against)::int, (SUM(mr.pts_for)-SUM(mr.pts_against))::int,
    ROUND(SUM(mr.won)::numeric/NULLIF(COUNT(*),0)*100,1),
    p.vip_tag, p.vip_theme
  FROM match_results mr JOIN public.profiles p ON p.id=mr.player_id
  GROUP BY mr.player_id, p.display_name, p.vip_tag, p.vip_theme;
$function$;
GRANT EXECUTE ON FUNCTION public.get_monthly_leaderboard(integer, integer, uuid) TO PUBLIC;
