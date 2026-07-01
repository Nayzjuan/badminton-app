-- ============================================================
-- Multi-Tenant Phase 3 (File A) — club-scope the leaderboard view chain
-- ============================================================
-- Today the leaderboard view chain merges ALL clubs (a cross-tenant leak once a
-- 2nd club exists; today there is 1 club so no observable leak). This threads
-- club_id (resolved matches.session_id -> sessions.club_id; matches has no
-- club_id) ROOT-first through v_match_history -> v_session_leaderboard +
-- v_alltime_leaderboard_mat, rekeys the matview's unique index to
-- (club_id, player_id) so REFRESH ... CONCURRENTLY still works, and adds an
-- ADDITIVE p_club_id DEFAULT NULL to the two view-chain functions
-- (get_player_streaks, get_alltime_snapshot_before) — NULL = today's all-clubs
-- behavior, so still-old TS keeps working after this lands (no coordinated
-- cutover). Only rebuilds DERIVED objects — base tables are untouched.
--
-- Verified against prod: v_match_history's ONLY dependents are
-- v_session_leaderboard + v_alltime_leaderboard_mat. matches.session_id is
-- NOT NULL and sessions.club_id is NOT NULL, so the INNER JOIN drops no rows.
--
-- ROLLBACK (down): DROP the new objects, re-CREATE the pre-change shapes from
-- git history of this file's prior commit (v_match_history w/o club_id, the two
-- views/mat w/o club_id, UNIQUE INDEX idx_alltime_leaderboard_player_id ON
-- (player_id), and the 1-arg get_player_streaks(uuid) / 1-arg
-- get_alltime_snapshot_before(timestamptz)).
-- ============================================================

-- ── 1) Drop the two dependents so the root view can be reshaped ──────────────
DROP MATERIALIZED VIEW IF EXISTS public.v_alltime_leaderboard_mat;
DROP VIEW IF EXISTS public.v_session_leaderboard;

-- ── 2) Root view gains club_id (append-only -> CREATE OR REPLACE keeps grants
--       + keeps the get_player_streaks / get_alltime_snapshot_before consumers) ─
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
    m.created_method,
    m.modification_count,
    m.final_classification,
    ( SELECT jsonb_agg(jsonb_build_object('game_number', mg.game_number, 'team_a_score', mg.team_a_score, 'team_b_score', mg.team_b_score) ORDER BY mg.game_number) AS jsonb_agg
           FROM match_games mg
          WHERE mg.match_id = m.id) AS game_scores,
    ( SELECT array_agg(p2.display_name) AS array_agg
           FROM match_players mp2
             JOIN profiles p2 ON p2.id = mp2.player_id
          WHERE mp2.match_id = m.id AND mp2.team = mp.team AND mp2.player_id <> mp.player_id) AS teammates,
    ( SELECT array_agg(p3.display_name) AS array_agg
           FROM match_players mp3
             JOIN profiles p3 ON p3.id = mp3.player_id
          WHERE mp3.match_id = m.id AND mp3.team <> mp.team) AS opponents,
    s.club_id
   FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     JOIN sessions s ON s.id = m.session_id
     LEFT JOIN courts c ON c.id = m.court_id
  WHERE m.status = 'completed'::match_status
  ORDER BY m.completed_at DESC;

-- ── 3) Recreate v_session_leaderboard threading club_id through ──────────────
CREATE VIEW public.v_session_leaderboard AS
 WITH match_results AS (
         SELECT mh.player_id,
            mh.session_id,
            mh.club_id,
                CASE
                    WHEN mh.team = 'a'::bpchar AND mh.team_a_score > mh.team_b_score OR mh.team = 'b'::bpchar AND mh.team_b_score > mh.team_a_score THEN 1
                    ELSE 0
                END AS won,
                CASE
                    WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_a_score, 0)
                    ELSE COALESCE(mh.team_b_score, 0)
                END AS pts_for,
                CASE
                    WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_b_score, 0)
                    ELSE COALESCE(mh.team_a_score, 0)
                END AS pts_against
           FROM v_match_history mh
          WHERE mh.match_status = 'completed'::match_status
        )
 SELECT mr.player_id,
    mr.session_id,
    mr.club_id,
    p.display_name,
    count(*)::integer AS games_played,
    sum(mr.won)::integer AS wins,
    (count(*) - sum(mr.won))::integer AS losses,
    sum(mr.pts_for)::integer AS points_for,
    sum(mr.pts_against)::integer AS points_against,
    (sum(mr.pts_for) - sum(mr.pts_against))::integer AS point_diff,
    round(sum(mr.won)::numeric / NULLIF(count(*), 0)::numeric * 100::numeric, 1) AS win_pct
   FROM match_results mr
     JOIN profiles p ON p.id = mr.player_id
  GROUP BY mr.player_id, mr.session_id, mr.club_id, p.display_name;

-- ── 4) Recreate the materialized all-time board keyed by (club_id, player_id) ─
CREATE MATERIALIZED VIEW public.v_alltime_leaderboard_mat AS
 WITH match_results AS (
         SELECT mh.player_id,
            mh.club_id,
                CASE
                    WHEN mh.team = 'a'::bpchar AND mh.team_a_score > mh.team_b_score OR mh.team = 'b'::bpchar AND mh.team_b_score > mh.team_a_score THEN 1
                    ELSE 0
                END AS won,
                CASE
                    WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_a_score, 0)
                    ELSE COALESCE(mh.team_b_score, 0)
                END AS pts_for,
                CASE
                    WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_b_score, 0)
                    ELSE COALESCE(mh.team_a_score, 0)
                END AS pts_against
           FROM v_match_history mh
          WHERE mh.match_status = 'completed'::match_status
        )
 SELECT mr.player_id,
    mr.club_id,
    p.display_name,
    count(*)::integer AS games_played,
    sum(mr.won)::integer AS wins,
    (count(*) - sum(mr.won))::integer AS losses,
    sum(mr.pts_for)::integer AS points_for,
    sum(mr.pts_against)::integer AS points_against,
    (sum(mr.pts_for) - sum(mr.pts_against))::integer AS point_diff,
    round(sum(mr.won)::numeric / NULLIF(count(*), 0)::numeric * 100::numeric, 1) AS win_pct
   FROM match_results mr
     JOIN profiles p ON p.id = mr.player_id
  GROUP BY mr.club_id, mr.player_id, p.display_name;

-- Composite UNIQUE index — REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY
-- (a player now appears once per club, so player_id alone is no longer unique).
CREATE UNIQUE INDEX idx_alltime_leaderboard_club_player
  ON public.v_alltime_leaderboard_mat (club_id, player_id);

-- ── 5) Restore SELECT grants dropped by DROP/CREATE ─────────────────────────
GRANT SELECT ON public.v_session_leaderboard TO anon, authenticated, service_role;
GRANT SELECT ON public.v_alltime_leaderboard_mat TO anon, authenticated, service_role;

-- ── 6) View-chain functions: ADDITIVE p_club_id (DEFAULT NULL = all clubs) ────
-- Signature change (extra param) => DROP + CREATE; default PUBLIC EXECUTE is
-- restored by CREATE (matches the pre-change grant set).
DROP FUNCTION IF EXISTS public.get_player_streaks(uuid);
CREATE FUNCTION public.get_player_streaks(p_session_id uuid DEFAULT NULL, p_club_id uuid DEFAULT NULL)
 RETURNS TABLE(player_id uuid, win_streak integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
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
      AND (p_club_id IS NULL OR mh.club_id = p_club_id)
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
$function$;

DROP FUNCTION IF EXISTS public.get_alltime_snapshot_before(timestamptz);
CREATE FUNCTION public.get_alltime_snapshot_before(p_cutoff timestamptz, p_club_id uuid DEFAULT NULL)
 RETURNS TABLE(player_id uuid, display_name text, games_played integer, wins integer, losses integer, points_for integer, points_against integer, point_diff integer, win_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
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
      AND mh.completed_at < p_cutoff
      AND (p_club_id IS NULL OR mh.club_id = p_club_id)
  )
  SELECT
    mr.player_id,
    p.display_name,
    COUNT(*)::int                                                  AS games_played,
    SUM(mr.won)::int                                              AS wins,
    (COUNT(*) - SUM(mr.won))::int                                 AS losses,
    SUM(mr.pts_for)::int                                          AS points_for,
    SUM(mr.pts_against)::int                                      AS points_against,
    (SUM(mr.pts_for) - SUM(mr.pts_against))::int                  AS point_diff,
    ROUND(
      SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
    )                                                              AS win_pct
  FROM match_results mr
  JOIN public.profiles p ON p.id = mr.player_id
  GROUP BY mr.player_id, p.display_name;
$function$;
