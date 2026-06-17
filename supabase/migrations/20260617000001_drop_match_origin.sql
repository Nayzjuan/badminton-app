-- ============================================================
-- Migration 2: Retire matches.origin (B-clean)
-- ============================================================
-- Apply ONLY AFTER migration 20260617000000 is live AND the new app
-- (reading final_classification, not origin) has deployed.
--
-- Rebuilds the view dependency chain without `match_origin`, then drops the
-- legacy column. The migration-1 RPCs are already origin-free, so nothing else
-- references the column at this point.
--
-- The `match_origin` ENUM TYPE is intentionally LEFT in place: the create RPCs
-- still accept a `p_origin match_origin` input (mapped to created_method). It is
-- harmless vestigial residue and can be retired in a later cleanup once those
-- params are migrated to text. Dropping it here would require redefining the two
-- create RPCs again — deferred to keep this migration focused.
--
-- Dependency chain (verified against the live schema):
--   v_alltime_leaderboard_mat (matview) ─┐
--   v_session_leaderboard (view) ────────┴─► v_match_history (view) ─► matches.origin
--   get_player_streaks / get_alltime_snapshot_before reference v_match_history
--   but NOT match_origin, so the rebuilt view (same non-origin columns) keeps
--   them working with no redefinition.
-- ============================================================

-- ── 1. Tear down the chain (deepest dependent first) ─────────
DROP VIEW IF EXISTS public.v_session_leaderboard;
DROP MATERIALIZED VIEW IF EXISTS public.v_alltime_leaderboard_mat;
DROP VIEW IF EXISTS public.v_match_history;

-- ── 2. Rebuild v_match_history WITHOUT origin, WITH the provenance columns ──
CREATE VIEW public.v_match_history AS
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

-- ── 3. Recreate v_session_leaderboard (verbatim from 20260502000000) ──
CREATE VIEW public.v_session_leaderboard AS
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

-- ── 4. Recreate v_alltime_leaderboard_mat + its unique index ──
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_alltime_leaderboard_player_id
  ON public.v_alltime_leaderboard_mat (player_id);

-- ── 5. Drop the legacy column (nothing references it anymore) ──
ALTER TABLE public.matches DROP COLUMN IF EXISTS origin;
