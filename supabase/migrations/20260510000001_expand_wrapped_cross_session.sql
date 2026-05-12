-- ============================================================
-- Migration: compute_session_wrapped — cross-session awards
-- ============================================================
-- Extends compute_session_wrapped with:
--   • Section 2b: _cross_session_stats temp table (pre-loop
--     bulk join of player_rivalries, player_partnerships, and
--     prior session_wrapped_stats — avoids N+1 queries).
--   • FOR loop now joins _cross_session_stats via explicit
--     column list (cs_ prefix avoids name collision with
--     _wrapped_stats columns).
--   • 4 enhanced award blocks (same slug, richer award_data):
--       my_nemesis, kryptonite, loyal_partner, redemption_arc
--   • 9 new award slugs:
--       momentum, consistent_dominator, bounced_back,
--       nemesis_slayer, settled_the_score, the_dynasty,
--       serial_rivals, soulmates, winning_formula
--   • carry_forward written into the session_wrapped_stats
--     upsert for use by the next session's RPC.
-- ============================================================

CREATE OR REPLACE FUNCTION compute_session_wrapped(p_session_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_winning_score        integer := 21;
  v_player               RECORD;
  v_awards               text[];
  v_award_data           jsonb;

  v_max_wins             integer := 0;
  v_max_games            integer := 0;
  v_max_points           integer := 0;
  v_best_win_pct         numeric := 0;
  v_worst_plus_minus     integer := 0;
  v_session_player_count integer := 0;

  v_min_pa_per_game      numeric := NULL;
  v_max_unique_partners  integer := 0;
  v_first_match_id       uuid    := NULL;
  v_last_match_id        uuid    := NULL;

BEGIN

  -- ── 0a. Refresh all-time leaderboard ────────────────────────────────────
  PERFORM refresh_alltime_leaderboard();

  -- ── 0b. Adaptive winning score detection ────────────────────────────────
  SELECT COALESCE(
    (SELECT s.score
     FROM (
       SELECT team_a_score AS score FROM matches
         WHERE session_id = p_session_id AND status = 'completed'
           AND team_a_score IS NOT NULL AND team_b_score IS NOT NULL
           AND team_a_score > team_b_score
       UNION ALL
       SELECT team_b_score FROM matches
         WHERE session_id = p_session_id AND status = 'completed'
           AND team_a_score IS NOT NULL AND team_b_score IS NOT NULL
           AND team_b_score > team_a_score
     ) s
     GROUP BY s.score ORDER BY COUNT(*) DESC, s.score DESC LIMIT 1),
    21
  ) INTO v_winning_score;

  -- ── 0c. First and last completed matches ─────────────────────────────────
  SELECT id INTO v_first_match_id FROM matches
  WHERE session_id = p_session_id AND status = 'completed' AND started_at IS NOT NULL
  ORDER BY started_at ASC LIMIT 1;

  SELECT id INTO v_last_match_id FROM matches
  WHERE session_id = p_session_id AND status = 'completed' AND completed_at IS NOT NULL
  ORDER BY completed_at DESC LIMIT 1;

  -- ── 1. _wrapped_stats per-player temp table ──────────────────────────────
  CREATE TEMP TABLE _wrapped_stats ON COMMIT DROP AS
  WITH completed_matches AS (
    SELECT m.id AS match_id, m.team_a_score AS score_a, m.team_b_score AS score_b,
      m.is_mixed_level, m.completed_at, m.started_at, mp.player_id, mp.team
    FROM matches m JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
      AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL
  ),
  player_match_results AS (
    SELECT player_id, match_id, team, is_mixed_level,
      CASE WHEN team = 'a' THEN score_a ELSE score_b END AS points_for,
      CASE WHEN team = 'a' THEN score_b ELSE score_a END AS points_against,
      CASE WHEN team = 'a' AND score_a > score_b THEN true
           WHEN team = 'b' AND score_b > score_a THEN true ELSE false END AS won,
      completed_at, started_at
    FROM completed_matches
  ),
  streak_calc AS (
    SELECT player_id, won, completed_at,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY completed_at)
        - ROW_NUMBER() OVER (PARTITION BY player_id, won ORDER BY completed_at) AS grp
    FROM player_match_results
  ),
  win_streak_groups AS (
    SELECT player_id, grp, COUNT(*) AS cnt FROM streak_calc WHERE won = true GROUP BY player_id, grp
  ),
  win_streaks AS (
    SELECT player_id,
      MAX(cnt) AS max_win_streak,
      COUNT(*) FILTER (WHERE cnt >= 2) AS distinct_win_streaks_2plus,
      COUNT(*) FILTER (WHERE cnt >= 3) AS distinct_win_streaks_3plus
    FROM win_streak_groups GROUP BY player_id
  ),
  h2h_losses AS (
    SELECT p1.player_id, p2.player_id AS opponent_id, COUNT(*) AS loss_count,
      ROW_NUMBER() OVER (PARTITION BY p1.player_id ORDER BY COUNT(*) DESC, p2.player_id) AS rk
    FROM player_match_results p1
    JOIN match_players mp2 ON mp2.match_id = p1.match_id AND mp2.team != p1.team
    JOIN player_match_results p2 ON p2.match_id = p1.match_id AND p2.player_id = mp2.player_id
    WHERE p1.won = false GROUP BY p1.player_id, p2.player_id
  ),
  h2h_wins AS (
    SELECT p1.player_id, p2.player_id AS victim_id, COUNT(*) AS win_count,
      ROW_NUMBER() OVER (PARTITION BY p1.player_id ORDER BY COUNT(*) DESC, p2.player_id) AS rk
    FROM player_match_results p1
    JOIN match_players mp2 ON mp2.match_id = p1.match_id AND mp2.team != p1.team
    JOIN player_match_results p2 ON p2.match_id = p1.match_id AND p2.player_id = mp2.player_id
    WHERE p1.won = true GROUP BY p1.player_id, p2.player_id
  ),
  match_opponent_pairs AS (
    SELECT p.player_id, p.match_id, p.won, p.completed_at,
      LEAST(o1.player_id, o2.player_id)::text || '_' ||
        GREATEST(o1.player_id, o2.player_id)::text AS opp_pair_key,
      LEAST(o1.player_id, o2.player_id) AS opp_a,
      GREATEST(o1.player_id, o2.player_id) AS opp_b
    FROM player_match_results p
    JOIN match_players o1 ON o1.match_id = p.match_id AND o1.team != p.team
    JOIN match_players o2 ON o2.match_id = p.match_id AND o2.team != p.team
                         AND o2.player_id < o1.player_id
  ),
  opp_pair_summary AS (
    SELECT player_id, opp_pair_key, COUNT(*) AS encounters,
      MIN(completed_at) FILTER (WHERE NOT won) AS first_loss_at,
      MAX(completed_at) FILTER (WHERE     won) AS last_win_at,
      BOOL_OR(NOT won) AS has_loss, BOOL_OR(won) AS has_win
    FROM match_opponent_pairs GROUP BY player_id, opp_pair_key
  ),
  rematch_counts AS (
    SELECT DISTINCT ON (player_id) player_id, encounters::int AS max_rematch_count, opp_pair_key AS top_pair_key
    FROM opp_pair_summary ORDER BY player_id, encounters DESC, opp_pair_key
  ),
  redemption_pairs AS (
    SELECT player_id, COUNT(*)::int AS redemption_count, MAX(opp_pair_key) AS sample_pair_key
    FROM opp_pair_summary
    WHERE has_loss AND has_win AND first_loss_at IS NOT NULL AND last_win_at IS NOT NULL
      AND last_win_at > first_loss_at
    GROUP BY player_id
  ),
  partner_counts AS (
    SELECT mp1.player_id, mp2.player_id AS partner_id, COUNT(*)::int AS pair_count
    FROM match_players mp1
    JOIN match_players mp2 ON mp2.match_id = mp1.match_id AND mp2.team = mp1.team
                          AND mp2.player_id != mp1.player_id
    JOIN matches m ON m.id = mp1.match_id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
    GROUP BY mp1.player_id, mp2.player_id
  ),
  partner_aggregates AS (
    SELECT player_id, COUNT(*)::int AS unique_partners, MAX(pair_count)::int AS max_same_partner_count
    FROM partner_counts GROUP BY player_id
  ),
  top_partner_per_player AS (
    SELECT DISTINCT ON (player_id) player_id, partner_id AS top_partner_id, pair_count AS top_partner_count
    FROM partner_counts ORDER BY player_id, pair_count DESC, partner_id
  ),
  partner_summary AS (
    SELECT pa.player_id, pa.unique_partners, pa.max_same_partner_count, tp.top_partner_id
    FROM partner_aggregates pa LEFT JOIN top_partner_per_player tp ON tp.player_id = pa.player_id
  ),
  partners AS (
    SELECT DISTINCT mp1.player_id, mp2.player_id AS other_id
    FROM match_players mp1 JOIN match_players mp2 ON mp2.match_id = mp1.match_id
                          AND mp2.team = mp1.team AND mp2.player_id != mp1.player_id
    JOIN matches m ON m.id = mp1.match_id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
  ),
  opponents AS (
    SELECT DISTINCT mp1.player_id, mp2.player_id AS other_id
    FROM match_players mp1 JOIN match_players mp2 ON mp2.match_id = mp1.match_id
                          AND mp2.team != mp1.team
    JOIN matches m ON m.id = mp1.match_id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
  ),
  friendly_fire_counts AS (
    SELECT player_id, COUNT(*)::int AS overlap_count
    FROM (SELECT player_id, other_id FROM partners INTERSECT SELECT player_id, other_id FROM opponents) overlap
    GROUP BY player_id
  ),
  own_worst_enemy_pairs AS (
    SELECT hl.player_id, hl.opponent_id, hl.loss_count, hw.win_count
    FROM h2h_losses hl JOIN h2h_wins hw ON hw.player_id = hl.player_id AND hw.victim_id = hl.opponent_id
  ),
  own_worst_enemy_summary AS (
    SELECT DISTINCT ON (player_id) player_id, opponent_id AS worst_id
    FROM own_worst_enemy_pairs ORDER BY player_id, (loss_count + win_count) DESC, opponent_id
  ),
  player_skills AS (
    SELECT pr.id AS player_id, skill_level_to_int(pr.skill_level)::int AS skill_int FROM profiles pr
  ),
  match_opponent_skill AS (
    SELECT pmr.player_id, pmr.match_id, pmr.won,
      AVG(skill_level_to_int(opp_p.skill_level)::numeric) AS opp_avg_skill
    FROM player_match_results pmr
    JOIN match_players opp_mp ON opp_mp.match_id = pmr.match_id AND opp_mp.team != pmr.team
    JOIN profiles opp_p ON opp_p.id = opp_mp.player_id
    GROUP BY pmr.player_id, pmr.match_id, pmr.won
  ),
  skill_slayer_counts AS (
    SELECT mos.player_id,
      COUNT(*) FILTER (WHERE mos.won AND mos.opp_avg_skill >= ps.skill_int + 2)::int AS upset_wins,
      MAX(mos.opp_avg_skill) FILTER (WHERE mos.won AND mos.opp_avg_skill >= ps.skill_int + 2)::numeric AS top_upset_skill
    FROM match_opponent_skill mos JOIN player_skills ps ON ps.player_id = mos.player_id
    GROUP BY mos.player_id
  ),
  alltime_top3 AS (
    SELECT player_id FROM v_alltime_leaderboard_mat
    ORDER BY games_played DESC NULLS LAST, win_pct DESC NULLS LAST LIMIT 3
  ),
  player_match_results_numbered AS (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY completed_at) AS rn,
      COUNT(*)    OVER (PARTITION BY player_id)                        AS total_games
    FROM player_match_results
  ),
  player_stats AS (
    SELECT pmr.player_id,
      COUNT(*)                                                          AS games_played,
      SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)                         AS wins,
      SUM(CASE WHEN NOT pmr.won THEN 1 ELSE 0 END)                     AS losses,
      SUM(pmr.points_for)                                               AS points_for,
      SUM(pmr.points_against)                                           AS points_against,
      ROUND(SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0) * 100, 2) AS win_pct,
      COALESCE(ws.max_win_streak, 0)                                    AS win_streak,
      COALESCE(ws.distinct_win_streaks_2plus, 0)                        AS distinct_win_streaks_2plus,
      SUM(CASE WHEN pmr.won AND pmr.rn > pmr.total_games - 3 THEN 1 ELSE 0 END) AS last3_wins,
      SUM(CASE WHEN pmr.rn > pmr.total_games - 3 THEN 1 ELSE 0 END)    AS last3_total,
      BOOL_OR(CASE WHEN pmr.rn = 1 THEN pmr.won ELSE false END)         AS won_first,
      BOOL_OR(CASE WHEN pmr.rn = pmr.total_games THEN pmr.won ELSE false END) AS won_last,
      (SUM(CASE WHEN pmr.rn IN (1,2) AND NOT pmr.won THEN 1 ELSE 0 END) = 2
        AND MAX(pmr.total_games) >= 2)                                  AS lost_first_two,
      SUM(CASE WHEN pmr.won AND pmr.rn > 2 THEN 1 ELSE 0 END)          AS wins_after_first_two,
      AVG(CASE WHEN pmr.won  THEN (pmr.points_for - pmr.points_against)::numeric ELSE NULL END) AS avg_winning_margin,
      AVG(CASE WHEN NOT pmr.won THEN (pmr.points_against - pmr.points_for)::numeric ELSE NULL END) AS avg_loss_margin,
      SUM(CASE WHEN pmr.won AND pmr.points_for - pmr.points_against >= 8 THEN 1 ELSE 0 END) AS wins_by_8_or_more,
      SUM(CASE WHEN pmr.won AND pmr.points_for - pmr.points_against BETWEEN 5 AND 7 THEN 1 ELSE 0 END) AS wins_by_5_to_7,
      ROUND(SUM(pmr.points_against)::numeric / NULLIF(COUNT(*),0), 2)  AS avg_pa_per_game,
      SUM(CASE WHEN pmr.won AND pmr.is_mixed_level THEN 1 ELSE 0 END)  AS mixed_wins,
      BOOL_OR(pmr.match_id = v_first_match_id)                         AS played_first_match,
      BOOL_OR(pmr.match_id = v_last_match_id)                          AS played_last_match,
      (SELECT hl.opponent_id FROM h2h_losses hl WHERE hl.player_id = pmr.player_id AND hl.rk = 1 AND hl.loss_count >= 2 LIMIT 1) AS nemesis_id,
      (SELECT hl.loss_count  FROM h2h_losses hl WHERE hl.player_id = pmr.player_id AND hl.rk = 1 LIMIT 1) AS nemesis_loss_count,
      (SELECT hw.victim_id   FROM h2h_wins   hw WHERE hw.player_id = pmr.player_id AND hw.rk = 1 AND hw.win_count >= 2 LIMIT 1) AS kryptonite_victim_id,
      (SELECT hw.win_count   FROM h2h_wins   hw WHERE hw.player_id = pmr.player_id AND hw.rk = 1 LIMIT 1) AS kryptonite_win_count,
      EXISTS (
        SELECT 1 FROM partner_counts pc JOIN win_streaks ws2 ON ws2.player_id = pc.partner_id
        WHERE pc.player_id = pmr.player_id AND ws2.max_win_streak >= 3
      ) AS has_streak_partner
    FROM player_match_results_numbered pmr
    LEFT JOIN win_streaks ws ON ws.player_id = pmr.player_id
    GROUP BY pmr.player_id, ws.max_win_streak, ws.distinct_win_streaks_2plus
  )
  SELECT ps.*,
    (ps.points_for - ps.points_against)                 AS point_diff,
    RANK() OVER (ORDER BY ps.wins DESC, ps.win_pct DESC) AS session_rank,
    pn.display_name                                      AS nemesis_name,
    pk.display_name                                      AS kryptonite_name,
    COALESCE(rc.max_rematch_count, 0)                   AS max_rematch_count,
    rc.top_pair_key                                      AS top_rematch_pair_key,
    COALESCE(rp.redemption_count, 0)                    AS redemption_count,
    COALESCE(ps_partner.unique_partners, 0)             AS unique_partners,
    COALESCE(ps_partner.max_same_partner_count, 0)      AS max_same_partner_count,
    ps_partner.top_partner_id,
    pp_name.display_name                                 AS top_partner_name,
    COALESCE(ff.overlap_count, 0)                       AS friendly_fire_overlap,
    owe.worst_id                                         AS own_worst_enemy_id,
    owe_name.display_name                                AS own_worst_enemy_name,
    COALESCE(ssc.upset_wins, 0)                         AS skill_slayer_wins,
    ssc.top_upset_skill                                  AS skill_slayer_top_skill,
    COALESCE(amat.games_played, 0)                      AS alltime_games,
    (a3.player_id IS NOT NULL)                          AS is_alltime_top3
  FROM player_stats ps
  LEFT JOIN profiles               pn         ON pn.id = ps.nemesis_id
  LEFT JOIN profiles               pk         ON pk.id = ps.kryptonite_victim_id
  LEFT JOIN rematch_counts         rc         ON rc.player_id = ps.player_id
  LEFT JOIN redemption_pairs       rp         ON rp.player_id = ps.player_id
  LEFT JOIN partner_summary        ps_partner ON ps_partner.player_id = ps.player_id
  LEFT JOIN profiles               pp_name    ON pp_name.id = ps_partner.top_partner_id
  LEFT JOIN friendly_fire_counts   ff         ON ff.player_id = ps.player_id
  LEFT JOIN own_worst_enemy_summary owe       ON owe.player_id = ps.player_id
  LEFT JOIN profiles               owe_name   ON owe_name.id = owe.worst_id
  LEFT JOIN skill_slayer_counts    ssc        ON ssc.player_id = ps.player_id
  LEFT JOIN v_alltime_leaderboard_mat amat    ON amat.player_id = ps.player_id
  LEFT JOIN alltime_top3           a3         ON a3.player_id = ps.player_id
  WHERE ps.games_played > 0;

  -- ── 2. Session-wide aggregates ─────────────────────────────────────────
  SELECT
    MAX(wins)::integer, MAX(games_played)::integer, MAX(points_for)::integer,
    MAX(win_pct), MIN(point_diff)::integer, COUNT(*)::integer,
    MIN(avg_pa_per_game) FILTER (WHERE games_played >= 4),
    MAX(unique_partners) FILTER (WHERE games_played >= 4)
  INTO v_max_wins, v_max_games, v_max_points, v_best_win_pct,
       v_worst_plus_minus, v_session_player_count, v_min_pa_per_game, v_max_unique_partners
  FROM _wrapped_stats;

  -- ── 2b. Cross-session context (bulk pre-loop join) ─────────────────────
  -- All data from player_rivalries, player_partnerships, and prior
  -- session_wrapped_stats is resolved here, once, for all players.
  -- Columns use cs_ prefix to avoid name collision with _wrapped_stats.
  CREATE TEMP TABLE _cross_session_stats ON COMMIT DROP AS
  WITH
  -- Tonight's completed matches (re-queried from DB; _wrapped_stats CTEs are gone)
  tonight_matches AS (
    SELECT m.id AS match_id, mp.player_id, mp.team,
      CASE WHEN mp.team='a' AND m.team_a_score > m.team_b_score THEN true
           WHEN mp.team='b' AND m.team_b_score > m.team_a_score THEN true
           ELSE false END AS won
    FROM matches m JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
      AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL
  ),
  -- Tonight's wins/losses per player vs each individual rival
  tonight_vs_rival AS (
    SELECT p.player_id, opp.player_id AS rival_id,
      SUM(CASE WHEN p.won     THEN 1 ELSE 0 END)::int AS tonight_wins,
      SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int AS tonight_losses
    FROM tonight_matches p
    JOIN match_players opp ON opp.match_id = p.match_id AND opp.team != p.team
    GROUP BY p.player_id, opp.player_id
  ),
  -- All-time rivalry records for active players, with pre-session state computed
  -- (player_rivalries already includes tonight via refresh_cross_session_stats)
  rivalry_with_tonight AS (
    SELECT pr.player_id, pr.rival_id, pr.wins_vs, pr.losses_vs, pr.sessions_faced,
      (pr.wins_vs   - COALESCE(tvr.tonight_wins,   0)) AS pre_wins_vs,
      (pr.losses_vs - COALESCE(tvr.tonight_losses, 0)) AS pre_losses_vs,
      COALESCE(tvr.tonight_wins,   0)                   AS tonight_wins,
      COALESCE(tvr.tonight_losses, 0)                   AS tonight_losses
    FROM player_rivalries pr
    LEFT JOIN tonight_vs_rival tvr ON tvr.player_id = pr.player_id AND tvr.rival_id = pr.rival_id
    WHERE pr.player_id IN (SELECT player_id FROM _wrapped_stats)
  ),
  -- All-time nemesis: rival where losses_vs > wins_vs (they have net advantage over me)
  alltime_nemesis AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      rival_id           AS cs_nemesis_alltime_id,
      wins_vs            AS cs_my_wins_vs_alltime_nemesis,
      losses_vs          AS cs_alltime_nemesis_wins_vs_me,
      sessions_faced     AS cs_alltime_nemesis_sessions,
      (losses_vs - wins_vs) AS cs_nemesis_net_deficit
    FROM rivalry_with_tonight
    WHERE losses_vs > wins_vs
    ORDER BY player_id, (losses_vs - wins_vs) DESC, losses_vs DESC, rival_id
  ),
  -- Did player beat their all-time nemesis in tonight's matches?
  beat_nemesis_tonight AS (
    SELECT an.player_id,
      COALESCE((tvr.tonight_wins > 0), false) AS cs_beat_nemesis_tonight
    FROM alltime_nemesis an
    LEFT JOIN tonight_vs_rival tvr ON tvr.player_id = an.player_id
                                  AND tvr.rival_id = an.cs_nemesis_alltime_id
  ),
  -- Score-settling: rival where pre-session record was negative → now level or positive
  score_settled AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      rival_id                        AS cs_settled_rival_id,
      (pre_losses_vs - pre_wins_vs)   AS cs_score_old_deficit
    FROM rivalry_with_tonight
    WHERE pre_losses_vs > pre_wins_vs   -- was losing all-time before tonight
      AND wins_vs >= losses_vs           -- now level or ahead
      AND tonight_wins > 0              -- actually beat them tonight
    ORDER BY player_id, (pre_losses_vs - pre_wins_vs) DESC, rival_id
  ),
  -- Dynasty victim: rival I dominate (≥5 wins, ≥70% win rate all-time)
  dynasty_victim AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      rival_id       AS cs_dynasty_victim_id,
      wins_vs        AS cs_dynasty_wins,
      losses_vs      AS cs_dynasty_losses,
      sessions_faced AS cs_dynasty_sessions
    FROM rivalry_with_tonight
    WHERE wins_vs >= 5
      AND wins_vs::numeric / NULLIF(wins_vs + losses_vs, 0) >= 0.70
    ORDER BY player_id, wins_vs DESC, (wins_vs + losses_vs) DESC, rival_id
  ),
  -- Max sessions_faced with any single rival (serial_rivals award)
  max_serial_rival AS (
    SELECT player_id, MAX(sessions_faced)::int AS cs_max_sessions_faced
    FROM rivalry_with_tonight GROUP BY player_id
  ),
  -- All-time record against the SESSION nemesis (session nemesis may differ from alltime nemesis)
  session_nemesis_alltime AS (
    SELECT ws.player_id,
      COALESCE(pr.wins_vs,       0) AS cs_sn_my_alltime_wins,
      COALESCE(pr.losses_vs,     0) AS cs_sn_alltime_losses,
      COALESCE(pr.sessions_faced, 0) AS cs_sn_alltime_sessions
    FROM _wrapped_stats ws
    LEFT JOIN player_rivalries pr ON pr.player_id = ws.player_id AND pr.rival_id = ws.nemesis_id
  ),
  -- All-time record against the SESSION kryptonite victim
  session_kryptonite_alltime AS (
    SELECT ws.player_id,
      COALESCE(pr.wins_vs,       0) AS cs_sk_my_alltime_wins,
      COALESCE(pr.losses_vs,     0) AS cs_sk_alltime_losses,
      COALESCE(pr.sessions_faced, 0) AS cs_sk_alltime_sessions
    FROM _wrapped_stats ws
    LEFT JOIN player_rivalries pr ON pr.player_id = ws.player_id AND pr.rival_id = ws.kryptonite_victim_id
  ),
  -- Cross-session redemption: first-ever win against a rival you only lost to in prior sessions
  cross_session_redemption AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      rival_id AS cs_redeemed_rival_id
    FROM rivalry_with_tonight
    WHERE pre_losses_vs > 0    -- lost to them before tonight
      AND pre_wins_vs   = 0    -- never won against them before
      AND tonight_wins  > 0    -- got first win tonight
    ORDER BY player_id, pre_losses_vs DESC, rival_id
  ),
  -- Best all-time partner per player (most games together)
  partnership_alltime AS (
    SELECT DISTINCT ON (pp.player_id)
      pp.player_id,
      pp.partner_id       AS cs_top_alltime_partner_id,
      pp.games_together   AS cs_alltime_games_together,
      pp.wins_together    AS cs_alltime_wins_together,
      pp.sessions_together AS cs_alltime_sessions_together,
      ROUND(pp.wins_together::numeric / NULLIF(pp.games_together, 0) * 100, 1) AS cs_alltime_partner_win_rate
    FROM player_partnerships pp
    WHERE pp.player_id IN (SELECT player_id FROM _wrapped_stats)
    ORDER BY pp.player_id, pp.games_together DESC, pp.partner_id
  ),
  -- Last 2 prior sessions per player (for rolling last-3 including tonight)
  prior_sessions_ranked AS (
    SELECT player_id, win_pct, computed_at,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY computed_at DESC) AS rn
    FROM session_wrapped_stats
    WHERE session_id != p_session_id
      AND player_id IN (SELECT player_id FROM _wrapped_stats)
  ),
  prior_sessions AS (
    SELECT player_id,
      COUNT(*) FILTER (WHERE win_pct >= 70)::int            AS cs_prior_dominant_sessions,
      (array_agg(win_pct ORDER BY computed_at DESC))[1]     AS cs_prior_last_win_pct
    FROM prior_sessions_ranked WHERE rn <= 2 GROUP BY player_id
  ),
  -- Most recent carry_forward per player (for momentum / streak continuity)
  prior_carry AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      (carry_forward->>'ended_on_win_streak')::int     AS cs_prior_win_streak,
      (carry_forward->>'session_win_pct')::numeric     AS cs_prior_session_win_pct
    FROM session_wrapped_stats
    WHERE session_id != p_session_id
      AND player_id IN (SELECT player_id FROM _wrapped_stats)
      AND carry_forward != '{}'::jsonb
    ORDER BY player_id, computed_at DESC
  )
  SELECT
    ws.player_id                                                AS cs_player_id,
    -- All-time nemesis
    an.cs_nemesis_alltime_id,
    an.cs_my_wins_vs_alltime_nemesis,
    an.cs_alltime_nemesis_wins_vs_me,
    an.cs_alltime_nemesis_sessions,
    an.cs_nemesis_net_deficit,
    COALESCE(bnt.cs_beat_nemesis_tonight, false)               AS cs_beat_nemesis_tonight,
    -- Settled the score
    ss.cs_settled_rival_id,
    ss.cs_score_old_deficit,
    -- Dynasty
    dv.cs_dynasty_victim_id,
    dv.cs_dynasty_wins,
    dv.cs_dynasty_losses,
    dv.cs_dynasty_sessions,
    -- Serial rivals
    COALESCE(msr.cs_max_sessions_faced, 0)                     AS cs_max_sessions_faced,
    -- Session nemesis alltime record
    COALESCE(sna.cs_sn_my_alltime_wins, 0)                     AS cs_sn_my_alltime_wins,
    COALESCE(sna.cs_sn_alltime_losses, 0)                      AS cs_sn_alltime_losses,
    COALESCE(sna.cs_sn_alltime_sessions, 0)                    AS cs_sn_alltime_sessions,
    -- Session kryptonite alltime record
    COALESCE(ska.cs_sk_my_alltime_wins, 0)                     AS cs_sk_my_alltime_wins,
    COALESCE(ska.cs_sk_alltime_losses, 0)                      AS cs_sk_alltime_losses,
    COALESCE(ska.cs_sk_alltime_sessions, 0)                    AS cs_sk_alltime_sessions,
    -- Cross-session redemption
    csr.cs_redeemed_rival_id,
    -- Partnerships
    pa.cs_top_alltime_partner_id,
    COALESCE(pa.cs_alltime_games_together, 0)                  AS cs_alltime_games_together,
    COALESCE(pa.cs_alltime_wins_together, 0)                   AS cs_alltime_wins_together,
    COALESCE(pa.cs_alltime_sessions_together, 0)               AS cs_alltime_sessions_together,
    pa.cs_alltime_partner_win_rate,
    -- Prior sessions (rolling-3)
    COALESCE(ps.cs_prior_dominant_sessions, 0)                 AS cs_prior_dominant_sessions,
    ps.cs_prior_last_win_pct,
    -- Carry-forward from prior session
    COALESCE(pc.cs_prior_win_streak, 0)                        AS cs_prior_win_streak,
    pc.cs_prior_session_win_pct
  FROM _wrapped_stats ws
  LEFT JOIN alltime_nemesis         an  ON an.player_id   = ws.player_id
  LEFT JOIN beat_nemesis_tonight    bnt ON bnt.player_id  = ws.player_id
  LEFT JOIN score_settled           ss  ON ss.player_id   = ws.player_id
  LEFT JOIN dynasty_victim          dv  ON dv.player_id   = ws.player_id
  LEFT JOIN max_serial_rival        msr ON msr.player_id  = ws.player_id
  LEFT JOIN session_nemesis_alltime sna ON sna.player_id  = ws.player_id
  LEFT JOIN session_kryptonite_alltime ska ON ska.player_id = ws.player_id
  LEFT JOIN cross_session_redemption csr ON csr.player_id = ws.player_id
  LEFT JOIN partnership_alltime     pa  ON pa.player_id   = ws.player_id
  LEFT JOIN prior_sessions          ps  ON ps.player_id   = ws.player_id
  LEFT JOIN prior_carry             pc  ON pc.player_id   = ws.player_id;

  -- ── 3. Award computation loop ─────────────────────────────────────────
  -- v_player now includes both _wrapped_stats columns and all cs_ cross-session columns.
  FOR v_player IN
    SELECT ws.*,
      csc.cs_player_id,
      csc.cs_nemesis_alltime_id,
      csc.cs_my_wins_vs_alltime_nemesis,
      csc.cs_alltime_nemesis_wins_vs_me,
      csc.cs_alltime_nemesis_sessions,
      csc.cs_nemesis_net_deficit,
      csc.cs_beat_nemesis_tonight,
      csc.cs_settled_rival_id,
      csc.cs_score_old_deficit,
      csc.cs_dynasty_victim_id,
      csc.cs_dynasty_wins,
      csc.cs_dynasty_losses,
      csc.cs_dynasty_sessions,
      csc.cs_max_sessions_faced,
      csc.cs_sn_my_alltime_wins,
      csc.cs_sn_alltime_losses,
      csc.cs_sn_alltime_sessions,
      csc.cs_sk_my_alltime_wins,
      csc.cs_sk_alltime_losses,
      csc.cs_sk_alltime_sessions,
      csc.cs_redeemed_rival_id,
      csc.cs_top_alltime_partner_id,
      csc.cs_alltime_games_together,
      csc.cs_alltime_wins_together,
      csc.cs_alltime_sessions_together,
      csc.cs_alltime_partner_win_rate,
      csc.cs_prior_dominant_sessions,
      csc.cs_prior_last_win_pct,
      csc.cs_prior_win_streak,
      csc.cs_prior_session_win_pct
    FROM _wrapped_stats ws
    LEFT JOIN _cross_session_stats csc ON csc.cs_player_id = ws.player_id
  LOOP

    v_awards    := ARRAY[]::text[];
    v_award_data := '{}'::jsonb;

    -- ─────────────────────────────────────────────────────────────────────
    -- PERFORMANCE awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.wins = v_player.games_played AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'undefeated_champion'::text);
      v_award_data := v_award_data || jsonb_build_object('undefeated_champion', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.win_pct >= 80 AND v_player.games_played >= 5 AND v_player.wins < v_player.games_played THEN
      v_awards     := array_append(v_awards, 'dominant_night'::text);
      v_award_data := v_award_data || jsonb_build_object('dominant_night', jsonb_build_object('win_pct', v_player.win_pct, 'wins', v_player.wins));
    END IF;

    IF v_player.win_pct >= 60 AND v_player.win_pct < 80 AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'solid_outing'::text);
      v_award_data := v_award_data || jsonb_build_object('solid_outing', jsonb_build_object('win_pct', v_player.win_pct));
    END IF;

    IF v_player.wins = v_player.losses AND v_player.games_played >= 4 THEN
      v_awards     := array_append(v_awards, 'glass_half_full'::text);
      v_award_data := v_award_data || jsonb_build_object('glass_half_full', jsonb_build_object('wins', v_player.wins, 'losses', v_player.losses));
    END IF;

    IF v_player.session_rank = 1 AND v_player.games_played >= 3 AND v_session_player_count >= 3 THEN
      v_awards     := array_append(v_awards, 'session_mvp'::text);
      v_award_data := v_award_data || jsonb_build_object('session_mvp', jsonb_build_object('wins', v_player.wins, 'win_pct', v_player.win_pct));
    END IF;

    IF v_player.lost_first_two AND v_player.wins_after_first_two >= 2 THEN
      v_awards     := array_append(v_awards, 'comeback_kid'::text);
      v_award_data := v_award_data || jsonb_build_object('comeback_kid', jsonb_build_object('comeback_wins', v_player.wins_after_first_two, 'total_games', v_player.games_played));
    END IF;

    IF v_player.won_last AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'the_closer'::text);
      v_award_data := v_award_data || jsonb_build_object('the_closer', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF NOT v_player.won_first AND NOT v_player.won_last AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'ice_cold'::text);
      v_award_data := v_award_data || jsonb_build_object('ice_cold', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.distinct_win_streaks_2plus >= 2 THEN
      v_awards     := array_append(v_awards, 'back_to_back'::text);
      v_award_data := v_award_data || jsonb_build_object('back_to_back', jsonb_build_object('streaks', v_player.distinct_win_streaks_2plus));
    END IF;

    -- NEW: Momentum — ended last session on streak ≥3, won first game tonight
    IF v_player.cs_prior_win_streak >= 3 AND v_player.won_first AND v_player.games_played >= 2 THEN
      v_awards     := array_append(v_awards, 'momentum'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'momentum', jsonb_build_object(
          'prior_streak', v_player.cs_prior_win_streak,
          'games',        v_player.games_played
        )
      );
    END IF;

    -- NEW: Consistent Dominator — ≥70% win rate in 2 of last 3 sessions (rolling)
    IF v_player.win_pct >= 70
       AND v_player.cs_prior_dominant_sessions >= 1
       AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'consistent_dominator'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'consistent_dominator', jsonb_build_object(
          'win_pct',          v_player.win_pct,
          'dominant_sessions', v_player.cs_prior_dominant_sessions + 1
        )
      );
    END IF;

    -- NEW: Bounced Back — last session win_pct < 50%, this session ≥50%
    IF v_player.cs_prior_last_win_pct IS NOT NULL
       AND v_player.cs_prior_last_win_pct < 50
       AND v_player.win_pct >= 50
       AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'bounced_back'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'bounced_back', jsonb_build_object(
          'last_win_pct', v_player.cs_prior_last_win_pct,
          'this_win_pct', v_player.win_pct
        )
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SCORING awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.points_for >= 100 THEN
      v_awards     := array_append(v_awards, 'point_machine'::text);
      v_award_data := v_award_data || jsonb_build_object('point_machine', jsonb_build_object('total_points', v_player.points_for));
    END IF;

    IF EXISTS (
      SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND ((mp.team = 'a' AND m.team_a_score >= v_winning_score AND m.team_b_score <= 1)
          OR (mp.team = 'b' AND m.team_b_score >= v_winning_score AND m.team_a_score <= 1))
    ) THEN
      v_awards     := array_append(v_awards, 'shutout_artist'::text);
      v_award_data := v_award_data || jsonb_build_object('shutout_artist', jsonb_build_object('winning_score', v_winning_score));
    END IF;

    IF v_player.points_for = v_max_points AND v_player.games_played >= 3 AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'top_scorer'::text);
      v_award_data := v_award_data || jsonb_build_object('top_scorer', jsonb_build_object('points', v_player.points_for));
    END IF;

    IF v_player.point_diff = (SELECT MAX(point_diff) FROM _wrapped_stats)
       AND v_player.games_played >= 3 AND v_player.point_diff > 0 AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'point_diff_king'::text);
      v_award_data := v_award_data || jsonb_build_object('point_diff_king', jsonb_build_object('point_diff', v_player.point_diff));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- MARGIN / DOMINANCE awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.avg_winning_margin IS NOT NULL AND v_player.avg_winning_margin >= 10 AND v_player.wins >= 3 THEN
      v_awards     := array_append(v_awards, 'blowout_king'::text);
      v_award_data := v_award_data || jsonb_build_object('blowout_king', jsonb_build_object('avg_margin', ROUND(v_player.avg_winning_margin,1), 'wins', v_player.wins));
    END IF;

    IF v_player.wins_by_8_or_more >= 3 THEN
      v_awards     := array_append(v_awards, 'heartless'::text);
      v_award_data := v_award_data || jsonb_build_object('heartless', jsonb_build_object('big_wins', v_player.wins_by_8_or_more));
    END IF;

    IF v_player.wins_by_5_to_7 >= 3 THEN
      v_awards     := array_append(v_awards, 'sniper'::text);
      v_award_data := v_award_data || jsonb_build_object('sniper', jsonb_build_object('clean_wins', v_player.wins_by_5_to_7));
    END IF;

    IF v_min_pa_per_game IS NOT NULL AND v_player.games_played >= 4
       AND v_player.avg_pa_per_game = v_min_pa_per_game AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'defensive_wall'::text);
      v_award_data := v_award_data || jsonb_build_object('defensive_wall', jsonb_build_object('avg_pa', ROUND(v_player.avg_pa_per_game,1)));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- STREAK awards (tiered)
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.win_streak >= 3 AND v_player.win_streak < 5 THEN
      v_awards     := array_append(v_awards, 'hot_streak'::text);
      v_award_data := v_award_data || jsonb_build_object('hot_streak', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    IF v_player.win_streak >= 5 AND v_player.win_streak < 7 THEN
      v_awards := array_remove(v_awards, 'hot_streak');
      v_awards     := array_append(v_awards, 'on_fire'::text);
      v_award_data := v_award_data - 'hot_streak' || jsonb_build_object('on_fire', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    IF v_player.win_streak >= 7 THEN
      v_awards := array_remove(v_awards, 'hot_streak');
      v_awards := array_remove(v_awards, 'on_fire');
      v_awards     := array_append(v_awards, 'unstoppable'::text);
      v_award_data := v_award_data - 'hot_streak' - 'on_fire' || jsonb_build_object('unstoppable', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- VOLUME awards (tiered)
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.games_played >= 6 AND v_player.games_played < 8 THEN
      v_awards     := array_append(v_awards, 'battle_tested'::text);
      v_award_data := v_award_data || jsonb_build_object('battle_tested', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.games_played >= 8 AND v_player.games_played < 10 THEN
      v_awards := array_remove(v_awards, 'battle_tested');
      v_awards     := array_append(v_awards, 'marathon_night'::text);
      v_award_data := v_award_data - 'battle_tested' || jsonb_build_object('marathon_night', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.games_played >= 10 THEN
      v_awards := array_remove(v_awards, 'battle_tested');
      v_awards := array_remove(v_awards, 'marathon_night');
      v_awards     := array_append(v_awards, 'court_hermit'::text);
      v_award_data := v_award_data - 'battle_tested' - 'marathon_night' || jsonb_build_object('court_hermit', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.games_played = v_max_games AND v_player.games_played >= 5 AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'most_active'::text);
      v_award_data := v_award_data || jsonb_build_object('most_active', jsonb_build_object('games', v_player.games_played));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- RESILIENCE awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.losses >= 3 AND v_player.games_played >= 5 AND v_player.win_pct < 50 THEN
      v_awards     := array_append(v_awards, 'grinds'::text);
      v_award_data := v_award_data || jsonb_build_object('grinds', jsonb_build_object('losses', v_player.losses, 'games', v_player.games_played));
    END IF;

    IF v_player.losses >= 5 THEN
      v_awards := array_remove(v_awards, 'grinds');
      v_awards     := array_append(v_awards, 'never_say_die'::text);
      v_award_data := v_award_data - 'grinds' || jsonb_build_object('never_say_die', jsonb_build_object('losses', v_player.losses));
    END IF;

    IF v_player.last3_wins >= 2 AND v_player.games_played >= 4 THEN
      v_awards     := array_append(v_awards, 'sunset_surge'::text);
      v_award_data := v_award_data || jsonb_build_object('sunset_surge', jsonb_build_object('final_wins', v_player.last3_wins));
    END IF;

    IF v_player.last3_total = 3 AND v_player.last3_wins = 3 AND v_player.games_played >= 3 THEN
      v_awards := array_remove(v_awards, 'sunset_surge');
      v_awards     := array_append(v_awards, 'clean_sweep'::text);
      v_award_data := v_award_data - 'sunset_surge' || jsonb_build_object('clean_sweep', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.won_first AND v_player.games_played >= 2 THEN
      v_awards     := array_append(v_awards, 'fast_starter'::text);
      v_award_data := v_award_data || jsonb_build_object('fast_starter', jsonb_build_object('first_match', 'win'));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- NEMESIS / H2H awards — ENHANCED with cross-session context
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.nemesis_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'my_nemesis'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'my_nemesis', jsonb_build_object(
          'nemesis_id',        v_player.nemesis_id,
          'nemesis_name',      v_player.nemesis_name,
          'loss_count',        v_player.nemesis_loss_count,
          -- Cross-session enrichment (zeroes if first time facing them)
          'alltime_losses_vs', v_player.cs_sn_alltime_losses,
          'alltime_my_wins',   v_player.cs_sn_my_alltime_wins,
          'alltime_sessions',  v_player.cs_sn_alltime_sessions
        )
      );
    END IF;

    IF v_player.kryptonite_victim_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'kryptonite'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'kryptonite', jsonb_build_object(
          'victim_id',         v_player.kryptonite_victim_id,
          'victim_name',       v_player.kryptonite_name,
          'win_count',         v_player.kryptonite_win_count,
          -- Cross-session enrichment
          'alltime_my_wins',   v_player.cs_sk_my_alltime_wins,
          'alltime_losses_vs', v_player.cs_sk_alltime_losses,
          'alltime_sessions',  v_player.cs_sk_alltime_sessions
        )
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- RIVALRY / DRAMA awards — cross-session NEW slugs added here
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.max_rematch_count >= 3 THEN
      v_awards     := array_append(v_awards, 'the_rematch'::text);
      v_award_data := v_award_data || jsonb_build_object('the_rematch', jsonb_build_object('encounters', v_player.max_rematch_count));
    END IF;

    -- Redemption Arc — same-session OR cross-session (first win against prior-session rival)
    IF v_player.redemption_count >= 1 OR v_player.cs_redeemed_rival_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'redemption_arc'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'redemption_arc', jsonb_build_object(
          'arcs',         v_player.redemption_count,
          'cross_session', (v_player.cs_redeemed_rival_id IS NOT NULL)
        )
      );
    END IF;

    IF v_player.friendly_fire_overlap >= 2 THEN
      v_awards     := array_append(v_awards, 'friendly_fire'::text);
      v_award_data := v_award_data || jsonb_build_object('friendly_fire', jsonb_build_object('overlap', v_player.friendly_fire_overlap));
    END IF;

    -- NEW: Nemesis Slayer — beat all-time nemesis tonight
    IF v_player.cs_nemesis_alltime_id IS NOT NULL AND v_player.cs_beat_nemesis_tonight THEN
      v_awards     := array_append(v_awards, 'nemesis_slayer'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'nemesis_slayer', jsonb_build_object(
          'nemesis_id',   v_player.cs_nemesis_alltime_id,
          'alltime_deficit', v_player.cs_nemesis_net_deficit
        )
      );
    END IF;

    -- NEW: Settled the Score — had losing all-time H2H, levelled or flipped it tonight
    IF v_player.cs_settled_rival_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'settled_the_score'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'settled_the_score', jsonb_build_object(
          'rival_id',    v_player.cs_settled_rival_id,
          'old_deficit', v_player.cs_score_old_deficit
        )
      );
    END IF;

    -- NEW: The Dynasty — 5+ all-time wins vs same rival, ≥70% win rate
    IF v_player.cs_dynasty_victim_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'the_dynasty'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'the_dynasty', jsonb_build_object(
          'victim_id', v_player.cs_dynasty_victim_id,
          'wins',      v_player.cs_dynasty_wins,
          'sessions',  v_player.cs_dynasty_sessions
        )
      );
    END IF;

    -- NEW: Serial Rivals — faced same rival in ≥3 distinct sessions
    IF v_player.cs_max_sessions_faced >= 3 THEN
      v_awards     := array_append(v_awards, 'serial_rivals'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'serial_rivals', jsonb_build_object('sessions_faced', v_player.cs_max_sessions_faced)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SOCIAL / PARTNER awards — cross-session NEW slugs added here
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.unique_partners > 0
       AND v_player.unique_partners = v_max_unique_partners
       AND v_player.games_played >= 4 AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'social_butterfly'::text);
      v_award_data := v_award_data || jsonb_build_object('social_butterfly', jsonb_build_object('partners', v_player.unique_partners));
    END IF;

    -- Loyal Partner — ≥3 games tonight with same partner (ENHANCED: shows alltime context)
    IF v_player.max_same_partner_count >= 3 THEN
      v_awards     := array_append(v_awards, 'loyal_partner'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'loyal_partner', jsonb_build_object(
          'partner_id',          v_player.top_partner_id,
          'partner_name',        v_player.top_partner_name,
          'shared_games',        v_player.max_same_partner_count,
          -- Cross-session enrichment
          'alltime_games',       v_player.cs_alltime_games_together,
          'alltime_sessions',    v_player.cs_alltime_sessions_together
        )
      );
    END IF;

    IF v_player.mixed_wins >= 2 THEN
      v_awards     := array_append(v_awards, 'mixed_master'::text);
      v_award_data := v_award_data || jsonb_build_object('mixed_master', jsonb_build_object('mixed_wins', v_player.mixed_wins));
    END IF;

    -- NEW: Soulmates — 20+ games together all-time, across multiple sessions
    IF v_player.cs_alltime_games_together >= 20
       AND v_player.cs_alltime_sessions_together >= 2 THEN
      v_awards     := array_append(v_awards, 'soulmates'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'soulmates', jsonb_build_object(
          'partner_id',   v_player.cs_top_alltime_partner_id,
          'games',        v_player.cs_alltime_games_together,
          'sessions',     v_player.cs_alltime_sessions_together
        )
      );
    END IF;

    -- NEW: Winning Formula — ≥6 games together all-time, ≥60% win rate, ≥2 sessions
    IF v_player.cs_alltime_games_together >= 6
       AND v_player.cs_alltime_partner_win_rate >= 60
       AND v_player.cs_alltime_sessions_together >= 2 THEN
      v_awards     := array_append(v_awards, 'winning_formula'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'winning_formula', jsonb_build_object(
          'partner_id', v_player.cs_top_alltime_partner_id,
          'win_rate',   v_player.cs_alltime_partner_win_rate,
          'games',      v_player.cs_alltime_games_together
        )
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SCORE-BASED FLAVOR awards
    -- ─────────────────────────────────────────────────────────────────────
    IF (SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
        WHERE m.session_id = p_session_id AND m.status = 'completed'
          AND ((mp.team='a' AND m.team_a_score > m.team_b_score AND m.team_a_score - m.team_b_score <= 2)
            OR (mp.team='b' AND m.team_b_score > m.team_a_score AND m.team_b_score - m.team_a_score <= 2))
    ) >= 3 THEN
      v_awards     := array_append(v_awards, 'close_call_survivor'::text);
      v_award_data := v_award_data || jsonb_build_object('close_call_survivor', jsonb_build_object('narrow_wins', (
        SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
        WHERE m.session_id = p_session_id AND m.status = 'completed'
          AND ((mp.team='a' AND m.team_a_score > m.team_b_score AND m.team_a_score - m.team_b_score <= 2)
            OR (mp.team='b' AND m.team_b_score > m.team_a_score AND m.team_b_score - m.team_a_score <= 2))
      )));
    END IF;

    IF (SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
        WHERE m.session_id = p_session_id AND m.status = 'completed'
          AND ((mp.team='a' AND m.team_a_score < m.team_b_score AND m.team_b_score - m.team_a_score <= 2)
            OR (mp.team='b' AND m.team_b_score < m.team_a_score AND m.team_a_score - m.team_b_score <= 2))
    ) >= 3 THEN
      v_awards     := array_append(v_awards, 'heartbreaker'::text);
      v_award_data := v_award_data || jsonb_build_object('heartbreaker', jsonb_build_object('narrow_losses', (
        SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
        WHERE m.session_id = p_session_id AND m.status = 'completed'
          AND ((mp.team='a' AND m.team_a_score < m.team_b_score AND m.team_b_score - m.team_a_score <= 2)
            OR (mp.team='b' AND m.team_b_score < m.team_a_score AND m.team_a_score - m.team_b_score <= 2))
      )));
    END IF;

    IF (SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
        WHERE m.session_id = p_session_id AND m.status = 'completed'
          AND m.team_a_score >= 20 AND m.team_b_score >= 20
    ) >= 3 THEN
      v_awards     := array_append(v_awards, 'deuce_magnet'::text);
      v_award_data := v_award_data || jsonb_build_object('deuce_magnet', jsonb_build_object('deuce_games', (
        SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
        WHERE m.session_id = p_session_id AND m.status = 'completed' AND m.team_a_score >= 20 AND m.team_b_score >= 20
      )));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- COMEDIC / PERSONALITY awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.wins = 0 THEN
      v_awards     := array_append(v_awards, 'participation_trophy'::text);
      v_award_data := v_award_data || jsonb_build_object('participation_trophy', jsonb_build_object('games', v_player.games_played, 'message', 'You showed up. That''s what matters.'));
    END IF;

    IF v_player.losses >= 4 AND v_player.losses = (SELECT MAX(losses) FROM _wrapped_stats) AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'the_punching_bag'::text);
      v_award_data := v_award_data || jsonb_build_object('the_punching_bag', jsonb_build_object('losses', v_player.losses));
    END IF;

    IF EXISTS (
      SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND ((mp.team='a' AND m.team_a_score = 0) OR (mp.team='b' AND m.team_b_score = 0))
    ) THEN
      v_awards     := array_append(v_awards, 'scoreboard_decorator'::text);
      v_award_data := v_award_data || jsonb_build_object('scoreboard_decorator', jsonb_build_object('message', 'You let them have their perfect game.'));
    END IF;

    IF v_player.games_played = 1 THEN
      v_awards     := array_append(v_awards, 'benchwarmer'::text);
      v_award_data := v_award_data || jsonb_build_object('benchwarmer', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.wins = 0 AND v_player.games_played >= 3
       AND v_player.avg_loss_margin IS NOT NULL AND v_player.avg_loss_margin >= 6 THEN
      v_awards     := array_remove(v_awards, 'participation_trophy'::text);
      v_award_data := v_award_data - 'participation_trophy';
      v_awards     := array_append(v_awards, 'the_warmup_act'::text);
      v_award_data := v_award_data || jsonb_build_object('the_warmup_act', jsonb_build_object('avg_margin', ROUND(v_player.avg_loss_margin,1), 'games', v_player.games_played));
    END IF;

    IF v_player.own_worst_enemy_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'own_worst_enemy'::text);
      v_award_data := v_award_data || jsonb_build_object('own_worst_enemy', jsonb_build_object('opponent_id', v_player.own_worst_enemy_id, 'opponent_name', v_player.own_worst_enemy_name));
    END IF;

    IF v_player.is_alltime_top3 AND v_player.alltime_games >= 20 THEN
      v_awards     := array_append(v_awards, 'the_veteran'::text);
      v_award_data := v_award_data || jsonb_build_object('the_veteran', jsonb_build_object('alltime_games', v_player.alltime_games));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SPECIAL / MILESTONE awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.alltime_games >= 100 THEN
      v_awards     := array_append(v_awards, 'century_club'::text);
      v_award_data := v_award_data || jsonb_build_object('century_club', jsonb_build_object('alltime_games', v_player.alltime_games));
    END IF;

    IF v_player.played_last_match AND v_last_match_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'night_cap'::text);
      v_award_data := v_award_data || jsonb_build_object('night_cap', jsonb_build_object('match_id', v_last_match_id));
    END IF;

    IF v_player.played_first_match AND v_first_match_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'early_bird'::text);
      v_award_data := v_award_data || jsonb_build_object('early_bird', jsonb_build_object('match_id', v_first_match_id));
    END IF;

    IF v_player.skill_slayer_wins >= 1 THEN
      v_awards     := array_append(v_awards, 'skill_slayer'::text);
      v_award_data := v_award_data || jsonb_build_object('skill_slayer', jsonb_build_object('upset_wins', v_player.skill_slayer_wins));
    END IF;

    IF v_player.win_streak >= 3 AND v_player.has_streak_partner THEN
      v_awards     := array_append(v_awards, 'double_trouble'::text);
      v_award_data := v_award_data || jsonb_build_object('double_trouble', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- FALLBACK
    -- ─────────────────────────────────────────────────────────────────────
    IF array_length(v_awards, 1) IS NULL OR array_length(v_awards, 1) = 0 THEN
      v_awards     := ARRAY['just_getting_started'];
      v_award_data := jsonb_build_object('just_getting_started', jsonb_build_object('games', v_player.games_played, 'message', 'Come back next session — your story is just beginning.'));
    END IF;

    -- ── 4. Upsert into session_wrapped_stats ─────────────────────────────
    INSERT INTO session_wrapped_stats (
      session_id, player_id, computed_at,
      games_played, wins, losses, points_for, points_against,
      win_pct, win_streak, session_rank,
      earned_awards, award_data,
      carry_forward
    )
    VALUES (
      p_session_id, v_player.player_id, now(),
      v_player.games_played::integer, v_player.wins::integer,
      v_player.losses::integer, v_player.points_for::integer,
      v_player.points_against::integer, v_player.win_pct,
      v_player.win_streak::integer, v_player.session_rank::integer,
      v_awards, v_award_data,
      -- carry_forward payload for next session's RPC
      jsonb_build_object(
        'ended_on_win_streak', v_player.win_streak,
        'session_win_pct',     v_player.win_pct,
        'session_id',          p_session_id
      )
    )
    ON CONFLICT (session_id, player_id)
    DO UPDATE SET
      computed_at    = EXCLUDED.computed_at,
      games_played   = EXCLUDED.games_played,
      wins           = EXCLUDED.wins,
      losses         = EXCLUDED.losses,
      points_for     = EXCLUDED.points_for,
      points_against = EXCLUDED.points_against,
      win_pct        = EXCLUDED.win_pct,
      win_streak     = EXCLUDED.win_streak,
      session_rank   = EXCLUDED.session_rank,
      earned_awards  = EXCLUDED.earned_awards,
      award_data     = EXCLUDED.award_data,
      carry_forward  = EXCLUDED.carry_forward;

  END LOOP;

END;
$$;

GRANT EXECUTE ON FUNCTION compute_session_wrapped(UUID) TO service_role;
