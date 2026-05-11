-- ============================================================
-- Migration: Session Wrapped — threshold & overlap tweaks
-- ============================================================
-- Fixes 3 minor issues identified in code review of the
-- 20260508 award expansion:
--
--   1. the_closer: games_played >= 2 → >= 3
--      Prevents a player who played only 2 games from earning
--      "The Closer" — the award should reward ending a real
--      session on a high note, not just winning 1 of 2 games.
--
--   2. friendly_fire: overlap >= 1 → >= 2
--      In small sessions (6–8 players), almost every player ends
--      up on both sides of every other player. The >= 1 threshold
--      made the award fire for ~80% of participants and stripped
--      it of meaning. Requiring >= 2 distinct crossover partners
--      makes it genuinely notable.
--
--   3. the_warmup_act: tier-replaces participation_trophy
--      A player who qualifies for warmup_act (0 wins, 3+ games,
--      avg loss margin >= 6) already gets participation_trophy
--      because wins = 0. Now warmup_act removes participation_trophy
--      before adding itself, so the player receives the more
--      specific and punchy award rather than both.
--
-- Full function replacement — no schema changes.
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

  -- Session-wide context
  v_max_wins             integer := 0;
  v_max_games            integer := 0;
  v_max_points           integer := 0;
  v_best_win_pct         numeric := 0;
  v_worst_plus_minus     integer := 0;
  v_session_player_count integer := 0;

  -- New session-wide context for expanded awards
  v_min_pa_per_game      numeric := NULL;   -- defensive_wall comparator (lowest avg PA among ≥4 games)
  v_max_unique_partners  integer := 0;      -- social_butterfly comparator
  v_first_match_id       uuid    := NULL;   -- early_bird identifier
  v_last_match_id        uuid    := NULL;   -- night_cap identifier

BEGIN

  -- ── 0a. Refresh all-time leaderboard ────────────────────────────────────
  -- Ensures `century_club` and `the_veteran` use up-to-date totals that
  -- include this session's games. Idempotent — safe to call repeatedly.
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
     GROUP BY s.score
     ORDER BY COUNT(*) DESC, s.score DESC
     LIMIT 1),
    21
  ) INTO v_winning_score;

  -- ── 0c. Identify session's first and last completed matches ─────────────
  -- Used by `early_bird` and `night_cap`. Falls back to NULL if there
  -- are no completed matches (in which case those awards never fire).
  SELECT id INTO v_first_match_id
  FROM matches
  WHERE session_id = p_session_id AND status = 'completed'
    AND started_at IS NOT NULL
  ORDER BY started_at ASC
  LIMIT 1;

  SELECT id INTO v_last_match_id
  FROM matches
  WHERE session_id = p_session_id AND status = 'completed'
    AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1;

  -- ── 1. Build per-player stats (temp table for this run) ────────────────
  CREATE TEMP TABLE _wrapped_stats ON COMMIT DROP AS
  WITH completed_matches AS (
    SELECT
      m.id              AS match_id,
      m.team_a_score    AS score_a,
      m.team_b_score    AS score_b,
      m.is_mixed_level  AS is_mixed_level,
      m.completed_at,
      m.started_at,
      mp.player_id,
      mp.team
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id
      AND m.status     = 'completed'
      AND m.team_a_score IS NOT NULL
      AND m.team_b_score IS NOT NULL
  ),
  player_match_results AS (
    SELECT
      player_id,
      match_id,
      team,
      is_mixed_level,
      CASE WHEN team = 'a' THEN score_a ELSE score_b END AS points_for,
      CASE WHEN team = 'a' THEN score_b ELSE score_a END AS points_against,
      CASE
        WHEN team = 'a' AND score_a > score_b THEN true
        WHEN team = 'b' AND score_b > score_a THEN true
        ELSE false
      END AS won,
      completed_at,
      started_at
    FROM completed_matches
  ),
  -- Streaks via gaps-and-islands
  streak_calc AS (
    SELECT
      player_id, won, completed_at,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY completed_at)
        - ROW_NUMBER() OVER (PARTITION BY player_id, won ORDER BY completed_at) AS grp
    FROM player_match_results
  ),
  win_streak_groups AS (
    SELECT player_id, grp, COUNT(*) AS cnt
    FROM streak_calc
    WHERE won = true
    GROUP BY player_id, grp
  ),
  win_streaks AS (
    SELECT
      player_id,
      MAX(cnt)                                                    AS max_win_streak,
      COUNT(*) FILTER (WHERE cnt >= 2)                            AS distinct_win_streaks_2plus,
      COUNT(*) FILTER (WHERE cnt >= 3)                            AS distinct_win_streaks_3plus
    FROM win_streak_groups
    GROUP BY player_id
  ),
  -- H2H losses per opponent
  h2h_losses AS (
    SELECT
      p1.player_id AS player_id,
      p2.player_id AS opponent_id,
      COUNT(*)     AS loss_count,
      ROW_NUMBER() OVER (
        PARTITION BY p1.player_id
        ORDER BY COUNT(*) DESC, p2.player_id
      ) AS rk
    FROM player_match_results p1
    JOIN match_players mp2 ON mp2.match_id = p1.match_id AND mp2.team != p1.team
    JOIN player_match_results p2 ON p2.match_id = p1.match_id AND p2.player_id = mp2.player_id
    WHERE p1.won = false
    GROUP BY p1.player_id, p2.player_id
  ),
  h2h_wins AS (
    SELECT
      p1.player_id AS player_id,
      p2.player_id AS victim_id,
      COUNT(*)     AS win_count,
      ROW_NUMBER() OVER (
        PARTITION BY p1.player_id
        ORDER BY COUNT(*) DESC, p2.player_id
      ) AS rk
    FROM player_match_results p1
    JOIN match_players mp2 ON mp2.match_id = p1.match_id AND mp2.team != p1.team
    JOIN player_match_results p2 ON p2.match_id = p1.match_id AND p2.player_id = mp2.player_id
    WHERE p1.won = true
    GROUP BY p1.player_id, p2.player_id
  ),

  -- ── NEW: opponent-pair history per player ─────────────────────────────
  -- For each player and each match, identify the canonical opponent-pair
  -- key (lesser_uuid || '_' || greater_uuid). Used by `the_rematch` and
  -- `redemption_arc`.
  match_opponent_pairs AS (
    SELECT
      p.player_id,
      p.match_id,
      p.won,
      p.completed_at,
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
    -- opp_a / opp_b dropped here: Postgres has no MAX(uuid) aggregate, and
    -- the pair UUIDs are not used downstream. opp_pair_key (text) is enough
    -- to identify the pair for `the_rematch` and `redemption_arc`.
    SELECT
      player_id,
      opp_pair_key,
      COUNT(*) AS encounters,
      MIN(completed_at) FILTER (WHERE NOT won) AS first_loss_at,
      MAX(completed_at) FILTER (WHERE     won) AS last_win_at,
      BOOL_OR(NOT won)                          AS has_loss,
      BOOL_OR(    won)                          AS has_win
    FROM match_opponent_pairs
    GROUP BY player_id, opp_pair_key
  ),
  -- the_rematch: max number of times any single opponent pair was faced.
  -- Uses DISTINCT ON to pick the top pair without relying on correlated
  -- subqueries against grouped columns (which are fragile in Postgres).
  rematch_counts AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      encounters::int  AS max_rematch_count,
      opp_pair_key     AS top_pair_key
    FROM opp_pair_summary
    ORDER BY player_id, encounters DESC, opp_pair_key
  ),
  -- redemption_arc: did the player lose to a pair earlier and beat the same pair later?
  redemption_pairs AS (
    SELECT
      player_id,
      COUNT(*)::int AS redemption_count,
      MAX(opp_pair_key) AS sample_pair_key
    FROM opp_pair_summary
    WHERE has_loss AND has_win
      AND first_loss_at IS NOT NULL
      AND last_win_at  IS NOT NULL
      AND last_win_at > first_loss_at
    GROUP BY player_id
  ),

  -- ── NEW: partner counts per player ────────────────────────────────────
  -- Per (player, partner) pair count for `loyal_partner` / `social_butterfly`.
  partner_counts AS (
    SELECT
      mp1.player_id,
      mp2.player_id AS partner_id,
      COUNT(*)::int AS pair_count
    FROM match_players mp1
    JOIN match_players mp2 ON mp2.match_id = mp1.match_id
                          AND mp2.team     = mp1.team
                          AND mp2.player_id != mp1.player_id
    JOIN matches m ON m.id = mp1.match_id
    WHERE m.session_id = p_session_id
      AND m.status     = 'completed'
    GROUP BY mp1.player_id, mp2.player_id
  ),
  partner_aggregates AS (
    SELECT
      player_id,
      COUNT(*)::int        AS unique_partners,
      MAX(pair_count)::int AS max_same_partner_count
    FROM partner_counts
    GROUP BY player_id
  ),
  top_partner_per_player AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      partner_id AS top_partner_id,
      pair_count AS top_partner_count
    FROM partner_counts
    ORDER BY player_id, pair_count DESC, partner_id
  ),
  partner_summary AS (
    SELECT
      pa.player_id,
      pa.unique_partners,
      pa.max_same_partner_count,
      tp.top_partner_id
    FROM partner_aggregates pa
    LEFT JOIN top_partner_per_player tp ON tp.player_id = pa.player_id
  ),

  -- ── NEW: friendly_fire / own_worst_enemy overlap ──────────────────────
  -- Players who appear as both partner (same team) and opponent
  -- (different team) of the subject player in this session.
  partners AS (
    SELECT DISTINCT mp1.player_id, mp2.player_id AS other_id
    FROM match_players mp1
    JOIN match_players mp2 ON mp2.match_id = mp1.match_id
                          AND mp2.team     = mp1.team
                          AND mp2.player_id != mp1.player_id
    JOIN matches m ON m.id = mp1.match_id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
  ),
  opponents AS (
    SELECT DISTINCT mp1.player_id, mp2.player_id AS other_id
    FROM match_players mp1
    JOIN match_players mp2 ON mp2.match_id = mp1.match_id
                          AND mp2.team    != mp1.team
    JOIN matches m ON m.id = mp1.match_id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
  ),
  friendly_fire_counts AS (
    SELECT player_id, COUNT(*)::int AS overlap_count
    FROM (
      SELECT player_id, other_id FROM partners
      INTERSECT
      SELECT player_id, other_id FROM opponents
    ) overlap
    GROUP BY player_id
  ),

  -- ── NEW: own_worst_enemy ──────────────────────────────────────────────
  -- For each player, find an opponent who both beat them AND was beaten
  -- by them (mixed H2H result with the same opponent).
  own_worst_enemy_pairs AS (
    SELECT
      hl.player_id,
      hl.opponent_id,
      hl.loss_count,
      hw.win_count
    FROM h2h_losses hl
    JOIN h2h_wins   hw ON hw.player_id = hl.player_id
                      AND hw.victim_id  = hl.opponent_id
  ),
  own_worst_enemy_summary AS (
    SELECT DISTINCT ON (player_id)
      player_id,
      opponent_id AS worst_id
    FROM own_worst_enemy_pairs
    ORDER BY player_id, (loss_count + win_count) DESC, opponent_id
  ),

  -- ── NEW: skill_slayer ─────────────────────────────────────────────────
  -- Count of wins where opponent team's avg skill is ≥ player's skill + 2.
  -- Uses skill_level_to_int() to coerce the enum to numeric.
  player_skills AS (
    SELECT pr.id AS player_id, skill_level_to_int(pr.skill_level)::int AS skill_int
    FROM profiles pr
  ),
  match_opponent_skill AS (
    SELECT
      pmr.player_id,
      pmr.match_id,
      pmr.won,
      AVG(skill_level_to_int(opp_p.skill_level)::numeric) AS opp_avg_skill
    FROM player_match_results pmr
    JOIN match_players opp_mp ON opp_mp.match_id = pmr.match_id AND opp_mp.team != pmr.team
    JOIN profiles      opp_p  ON opp_p.id        = opp_mp.player_id
    GROUP BY pmr.player_id, pmr.match_id, pmr.won
  ),
  skill_slayer_counts AS (
    SELECT
      mos.player_id,
      COUNT(*) FILTER (
        WHERE mos.won
          AND mos.opp_avg_skill >= ps.skill_int + 2
      )::int AS upset_wins,
      MAX(mos.opp_avg_skill) FILTER (
        WHERE mos.won
          AND mos.opp_avg_skill >= ps.skill_int + 2
      )::numeric AS top_upset_skill
    FROM match_opponent_skill mos
    JOIN player_skills ps ON ps.player_id = mos.player_id
    GROUP BY mos.player_id
  ),

  -- ── NEW: alltime context ──────────────────────────────────────────────
  alltime_top3 AS (
    SELECT player_id
    FROM v_alltime_leaderboard_mat
    ORDER BY games_played DESC NULLS LAST, win_pct DESC NULLS LAST
    LIMIT 3
  ),

  -- Numbered window cols (rn, total_games) — same pattern as before
  player_match_results_numbered AS (
    SELECT
      *,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY completed_at) AS rn,
      COUNT(*)    OVER (PARTITION BY player_id)                        AS total_games
    FROM player_match_results
  ),
  player_stats AS (
    SELECT
      pmr.player_id,
      COUNT(*)                                          AS games_played,
      SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)          AS wins,
      SUM(CASE WHEN NOT pmr.won THEN 1 ELSE 0 END)      AS losses,
      SUM(pmr.points_for)                               AS points_for,
      SUM(pmr.points_against)                           AS points_against,
      ROUND(
        SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0) * 100, 2
      )                                                 AS win_pct,
      COALESCE(ws.max_win_streak, 0)                    AS win_streak,
      COALESCE(ws.distinct_win_streaks_2plus, 0)        AS distinct_win_streaks_2plus,

      -- Last-3 metrics
      SUM(CASE WHEN pmr.won AND pmr.rn > pmr.total_games - 3
               THEN 1 ELSE 0 END)                       AS last3_wins,
      SUM(CASE WHEN pmr.rn > pmr.total_games - 3
               THEN 1 ELSE 0 END)                       AS last3_total,

      -- Existing flags
      BOOL_OR(CASE WHEN pmr.rn = 1 THEN pmr.won ELSE false END)  AS won_first,

      -- NEW: won_last (won the LAST game played)
      BOOL_OR(CASE WHEN pmr.rn = pmr.total_games THEN pmr.won ELSE false END)
                                                        AS won_last,

      -- NEW: lost_first_two (lost both rn=1 and rn=2)
      (SUM(CASE WHEN pmr.rn IN (1, 2) AND NOT pmr.won THEN 1 ELSE 0 END) = 2
        AND MAX(pmr.total_games) >= 2)                  AS lost_first_two,

      -- NEW: wins after first two games (for comeback_kid subtitle)
      SUM(CASE WHEN pmr.won AND pmr.rn > 2 THEN 1 ELSE 0 END)
                                                        AS wins_after_first_two,

      -- NEW: margin metrics
      AVG(CASE WHEN pmr.won
               THEN (pmr.points_for - pmr.points_against)::numeric
               ELSE NULL END)                           AS avg_winning_margin,
      AVG(CASE WHEN NOT pmr.won
               THEN (pmr.points_against - pmr.points_for)::numeric
               ELSE NULL END)                           AS avg_loss_margin,
      SUM(CASE WHEN pmr.won
                AND pmr.points_for - pmr.points_against >= 8
               THEN 1 ELSE 0 END)                       AS wins_by_8_or_more,
      SUM(CASE WHEN pmr.won
                AND pmr.points_for - pmr.points_against BETWEEN 5 AND 7
               THEN 1 ELSE 0 END)                       AS wins_by_5_to_7,

      -- NEW: defensive_wall comparator
      ROUND(SUM(pmr.points_against)::numeric
            / NULLIF(COUNT(*), 0), 2)                   AS avg_pa_per_game,

      -- NEW: mixed_master
      SUM(CASE WHEN pmr.won AND pmr.is_mixed_level THEN 1 ELSE 0 END)
                                                        AS mixed_wins,

      -- NEW: early_bird / night_cap
      BOOL_OR(pmr.match_id = v_first_match_id)          AS played_first_match,
      BOOL_OR(pmr.match_id = v_last_match_id)           AS played_last_match,

      -- Nemesis (existing)
      (SELECT hl.opponent_id FROM h2h_losses hl
       WHERE hl.player_id = pmr.player_id AND hl.rk = 1 AND hl.loss_count >= 2
       LIMIT 1)                                         AS nemesis_id,
      (SELECT hl.loss_count FROM h2h_losses hl
       WHERE hl.player_id = pmr.player_id AND hl.rk = 1
       LIMIT 1)                                         AS nemesis_loss_count,
      -- Kryptonite (existing)
      (SELECT hw.victim_id FROM h2h_wins hw
       WHERE hw.player_id = pmr.player_id AND hw.rk = 1 AND hw.win_count >= 2
       LIMIT 1)                                         AS kryptonite_victim_id,
      (SELECT hw.win_count FROM h2h_wins hw
       WHERE hw.player_id = pmr.player_id AND hw.rk = 1
       LIMIT 1)                                         AS kryptonite_win_count,
      -- NEW: pre-computed for double_trouble — partner_counts CTE goes out
      -- of scope after _wrapped_stats is materialized, so we collapse the
      -- "any partner with ≥3 streak" check into a column here.
      EXISTS (
        SELECT 1 FROM partner_counts pc
        JOIN win_streaks ws2 ON ws2.player_id = pc.partner_id
        WHERE pc.player_id = pmr.player_id AND ws2.max_win_streak >= 3
      )                                                 AS has_streak_partner
    FROM player_match_results_numbered pmr
    LEFT JOIN win_streaks ws ON ws.player_id = pmr.player_id
    GROUP BY pmr.player_id, ws.max_win_streak, ws.distinct_win_streaks_2plus
  )
  SELECT
    ps.*,
    -- point_diff (target table is GENERATED, but we still need it locally)
    (ps.points_for - ps.points_against)                 AS point_diff,
    RANK() OVER (ORDER BY ps.wins DESC, ps.win_pct DESC) AS session_rank,
    -- Display names for nemesis / kryptonite
    pn.display_name                                     AS nemesis_name,
    pk.display_name                                     AS kryptonite_name,

    -- New fields from supporting CTEs
    COALESCE(rc.max_rematch_count, 0)                   AS max_rematch_count,
    rc.top_pair_key                                     AS top_rematch_pair_key,
    COALESCE(rp.redemption_count, 0)                    AS redemption_count,
    COALESCE(ps_partner.unique_partners, 0)             AS unique_partners,
    COALESCE(ps_partner.max_same_partner_count, 0)      AS max_same_partner_count,
    ps_partner.top_partner_id                           AS top_partner_id,
    pp_name.display_name                                AS top_partner_name,
    COALESCE(ff.overlap_count, 0)                       AS friendly_fire_overlap,
    owe.worst_id                                        AS own_worst_enemy_id,
    owe_name.display_name                               AS own_worst_enemy_name,
    COALESCE(ssc.upset_wins, 0)                         AS skill_slayer_wins,
    ssc.top_upset_skill                                 AS skill_slayer_top_skill,
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
    MAX(wins)::integer,
    MAX(games_played)::integer,
    MAX(points_for)::integer,
    MAX(win_pct),
    MIN(point_diff)::integer,
    COUNT(*)::integer,
    -- New aggregates
    MIN(avg_pa_per_game) FILTER (WHERE games_played >= 4),
    MAX(unique_partners) FILTER (WHERE games_played >= 4)
  INTO
    v_max_wins,
    v_max_games,
    v_max_points,
    v_best_win_pct,
    v_worst_plus_minus,
    v_session_player_count,
    v_min_pa_per_game,
    v_max_unique_partners
  FROM _wrapped_stats;

  -- ── 3. Award computation loop ─────────────────────────────────────────
  FOR v_player IN SELECT * FROM _wrapped_stats LOOP

    v_awards    := ARRAY[]::text[];
    v_award_data := '{}'::jsonb;

    -- ─────────────────────────────────────────────────────────────────────
    -- PERFORMANCE awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.wins = v_player.games_played AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'undefeated_champion'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'undefeated_champion', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    IF v_player.win_pct >= 80 AND v_player.games_played >= 5
       AND v_player.wins < v_player.games_played THEN
      v_awards     := array_append(v_awards, 'dominant_night'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'dominant_night', jsonb_build_object('win_pct', v_player.win_pct, 'wins', v_player.wins)
      );
    END IF;

    IF v_player.win_pct >= 60 AND v_player.win_pct < 80 AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'solid_outing'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'solid_outing', jsonb_build_object('win_pct', v_player.win_pct)
      );
    END IF;

    IF v_player.wins = v_player.losses AND v_player.games_played >= 4 THEN
      v_awards     := array_append(v_awards, 'glass_half_full'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'glass_half_full', jsonb_build_object('wins', v_player.wins, 'losses', v_player.losses)
      );
    END IF;

    IF v_player.session_rank = 1 AND v_player.games_played >= 3 AND v_session_player_count >= 3 THEN
      v_awards     := array_append(v_awards, 'session_mvp'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'session_mvp', jsonb_build_object('wins', v_player.wins, 'win_pct', v_player.win_pct)
      );
    END IF;

    -- NEW: Comeback Kid — lost first 2, then won ≥2
    IF v_player.lost_first_two AND v_player.wins_after_first_two >= 2 THEN
      v_awards     := array_append(v_awards, 'comeback_kid'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'comeback_kid', jsonb_build_object(
          'comeback_wins', v_player.wins_after_first_two,
          'total_games',   v_player.games_played
        )
      );
    END IF;

    -- FIX 1: The Closer — games_played >= 3 (was >= 2).
    -- Prevents a 2-game player from earning this award — the closer
    -- narrative only makes sense after a real stretch of play.
    IF v_player.won_last AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'the_closer'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'the_closer', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    -- NEW: Ice Cold — lost first AND last game
    IF NOT v_player.won_first AND NOT v_player.won_last AND v_player.games_played >= 3 THEN
      v_awards     := array_append(v_awards, 'ice_cold'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'ice_cold', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    -- NEW: Back-to-Back — multiple separate ≥2 win streaks
    IF v_player.distinct_win_streaks_2plus >= 2 THEN
      v_awards     := array_append(v_awards, 'back_to_back'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'back_to_back', jsonb_build_object('streaks', v_player.distinct_win_streaks_2plus)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SCORING awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.points_for >= 100 THEN
      v_awards     := array_append(v_awards, 'point_machine'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'point_machine', jsonb_build_object('total_points', v_player.points_for)
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
        AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id
        AND m.status = 'completed'
        AND (
          (mp.team = 'a' AND m.team_a_score >= v_winning_score AND m.team_b_score <= 1)
          OR
          (mp.team = 'b' AND m.team_b_score >= v_winning_score AND m.team_a_score <= 1)
        )
    ) THEN
      v_awards     := array_append(v_awards, 'shutout_artist'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'shutout_artist', jsonb_build_object('winning_score', v_winning_score)
      );
    END IF;

    IF v_player.points_for = v_max_points AND v_player.games_played >= 3
       AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'top_scorer'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'top_scorer', jsonb_build_object('points', v_player.points_for)
      );
    END IF;

    IF v_player.point_diff = (SELECT MAX(point_diff) FROM _wrapped_stats)
       AND v_player.games_played >= 3 AND v_player.point_diff > 0
       AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'point_diff_king'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'point_diff_king', jsonb_build_object('point_diff', v_player.point_diff)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- MARGIN / DOMINANCE awards (NEW)
    -- ─────────────────────────────────────────────────────────────────────
    -- Blowout King — average winning margin ≥ 10, ≥3 wins
    IF v_player.avg_winning_margin IS NOT NULL
       AND v_player.avg_winning_margin >= 10
       AND v_player.wins >= 3 THEN
      v_awards     := array_append(v_awards, 'blowout_king'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'blowout_king', jsonb_build_object(
          'avg_margin', ROUND(v_player.avg_winning_margin, 1),
          'wins',       v_player.wins
        )
      );
    END IF;

    -- Heartless — 3+ wins by ≥8 pts (refined, mutually exclusive with sniper)
    IF v_player.wins_by_8_or_more >= 3 THEN
      v_awards     := array_append(v_awards, 'heartless'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'heartless', jsonb_build_object('big_wins', v_player.wins_by_8_or_more)
      );
    END IF;

    -- Sniper — 3+ wins by 5–7 pts (refined: clinical band, not blowout)
    IF v_player.wins_by_5_to_7 >= 3 THEN
      v_awards     := array_append(v_awards, 'sniper'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'sniper', jsonb_build_object('clean_wins', v_player.wins_by_5_to_7)
      );
    END IF;

    -- Defensive Wall — lowest avg points conceded, ≥4 games, ≥4 players
    IF v_min_pa_per_game IS NOT NULL
       AND v_player.games_played >= 4
       AND v_player.avg_pa_per_game = v_min_pa_per_game
       AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'defensive_wall'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'defensive_wall', jsonb_build_object(
          'avg_pa', ROUND(v_player.avg_pa_per_game, 1)
        )
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- STREAK awards (tiered)
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.win_streak >= 3 AND v_player.win_streak < 5 THEN
      v_awards     := array_append(v_awards, 'hot_streak'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'hot_streak', jsonb_build_object('streak', v_player.win_streak)
      );
    END IF;

    IF v_player.win_streak >= 5 AND v_player.win_streak < 7 THEN
      v_awards := array_remove(v_awards, 'hot_streak');
      v_awards     := array_append(v_awards, 'on_fire'::text);
      v_award_data := v_award_data - 'hot_streak'
                   || jsonb_build_object('on_fire', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    IF v_player.win_streak >= 7 THEN
      v_awards := array_remove(v_awards, 'hot_streak');
      v_awards := array_remove(v_awards, 'on_fire');
      v_awards     := array_append(v_awards, 'unstoppable'::text);
      v_award_data := v_award_data - 'hot_streak' - 'on_fire'
                   || jsonb_build_object('unstoppable', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- VOLUME awards (tiered)
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.games_played >= 6 AND v_player.games_played < 8 THEN
      v_awards     := array_append(v_awards, 'battle_tested'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'battle_tested', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    IF v_player.games_played >= 8 AND v_player.games_played < 10 THEN
      v_awards := array_remove(v_awards, 'battle_tested');
      v_awards     := array_append(v_awards, 'marathon_night'::text);
      v_award_data := v_award_data - 'battle_tested'
                   || jsonb_build_object('marathon_night', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.games_played >= 10 THEN
      v_awards := array_remove(v_awards, 'battle_tested');
      v_awards := array_remove(v_awards, 'marathon_night');
      v_awards     := array_append(v_awards, 'court_hermit'::text);
      v_award_data := v_award_data - 'battle_tested' - 'marathon_night'
                   || jsonb_build_object('court_hermit', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.games_played = v_max_games AND v_player.games_played >= 5
       AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'most_active'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'most_active', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- RESILIENCE awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.losses >= 3 AND v_player.games_played >= 5 AND v_player.win_pct < 50 THEN
      v_awards     := array_append(v_awards, 'grinds'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'grinds', jsonb_build_object('losses', v_player.losses, 'games', v_player.games_played)
      );
    END IF;

    IF v_player.losses >= 5 THEN
      v_awards := array_remove(v_awards, 'grinds');
      v_awards     := array_append(v_awards, 'never_say_die'::text);
      v_award_data := v_award_data - 'grinds'
                   || jsonb_build_object('never_say_die', jsonb_build_object('losses', v_player.losses));
    END IF;

    -- Sunset Surge: won 2+ of last 3 games, ≥4 games total
    IF v_player.last3_wins >= 2 AND v_player.games_played >= 4 THEN
      v_awards     := array_append(v_awards, 'sunset_surge'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'sunset_surge', jsonb_build_object('final_wins', v_player.last3_wins)
      );
    END IF;

    -- NEW (tier-replaces sunset_surge): Clean Sweep — won ALL of last 3
    IF v_player.last3_total = 3 AND v_player.last3_wins = 3 AND v_player.games_played >= 3 THEN
      v_awards := array_remove(v_awards, 'sunset_surge');
      v_awards     := array_append(v_awards, 'clean_sweep'::text);
      v_award_data := v_award_data - 'sunset_surge'
                   || jsonb_build_object('clean_sweep', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.won_first AND v_player.games_played >= 2 THEN
      v_awards     := array_append(v_awards, 'fast_starter'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'fast_starter', jsonb_build_object('first_match', 'win')
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- NEMESIS / H2H awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.nemesis_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'my_nemesis'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'my_nemesis', jsonb_build_object(
          'nemesis_id',   v_player.nemesis_id,
          'nemesis_name', v_player.nemesis_name,
          'loss_count',   v_player.nemesis_loss_count
        )
      );
    END IF;

    IF v_player.kryptonite_victim_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'kryptonite'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'kryptonite', jsonb_build_object(
          'victim_id',   v_player.kryptonite_victim_id,
          'victim_name', v_player.kryptonite_name,
          'win_count',   v_player.kryptonite_win_count
        )
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- RIVALRY / DRAMA awards (NEW)
    -- ─────────────────────────────────────────────────────────────────────
    -- The Rematch — faced exact same 2v2 pair ≥3 times
    IF v_player.max_rematch_count >= 3 THEN
      v_awards     := array_append(v_awards, 'the_rematch'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'the_rematch', jsonb_build_object('encounters', v_player.max_rematch_count)
      );
    END IF;

    -- Redemption Arc — lost to a pair earlier, beat same pair later
    IF v_player.redemption_count >= 1 THEN
      v_awards     := array_append(v_awards, 'redemption_arc'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'redemption_arc', jsonb_build_object('arcs', v_player.redemption_count)
      );
    END IF;

    -- FIX 2: Friendly Fire — overlap >= 2 (was >= 1).
    -- In small sessions almost every player ends up on both sides
    -- of every other player at least once; >= 1 made this fire for
    -- ~80% of participants. Requiring >= 2 makes it genuinely notable.
    IF v_player.friendly_fire_overlap >= 2 THEN
      v_awards     := array_append(v_awards, 'friendly_fire'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'friendly_fire', jsonb_build_object('overlap', v_player.friendly_fire_overlap)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SOCIAL / PARTNER awards (NEW)
    -- ─────────────────────────────────────────────────────────────────────
    -- Social Butterfly — most unique partners, ≥4 games, ≥4 players
    IF v_player.unique_partners > 0
       AND v_player.unique_partners = v_max_unique_partners
       AND v_player.games_played >= 4
       AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'social_butterfly'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'social_butterfly', jsonb_build_object('partners', v_player.unique_partners)
      );
    END IF;

    -- Loyal Partner — played ≥3 games with same partner
    IF v_player.max_same_partner_count >= 3 THEN
      v_awards     := array_append(v_awards, 'loyal_partner'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'loyal_partner', jsonb_build_object(
          'partner_id',    v_player.top_partner_id,
          'partner_name',  v_player.top_partner_name,
          'shared_games',  v_player.max_same_partner_count
        )
      );
    END IF;

    -- Mixed Master — won ≥2 mixed-level matches
    IF v_player.mixed_wins >= 2 THEN
      v_awards     := array_append(v_awards, 'mixed_master'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'mixed_master', jsonb_build_object('mixed_wins', v_player.mixed_wins)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SCORE-BASED FLAVOR awards
    -- ─────────────────────────────────────────────────────────────────────
    IF (
      SELECT COUNT(*)
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND ((mp.team = 'a' AND m.team_a_score > m.team_b_score
              AND m.team_a_score - m.team_b_score <= 2)
          OR (mp.team = 'b' AND m.team_b_score > m.team_a_score
              AND m.team_b_score - m.team_a_score <= 2))
    ) >= 3 THEN
      v_awards     := array_append(v_awards, 'close_call_survivor'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'close_call_survivor', jsonb_build_object('narrow_wins', (
          SELECT COUNT(*)
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
          WHERE m.session_id = p_session_id AND m.status = 'completed'
            AND ((mp.team = 'a' AND m.team_a_score > m.team_b_score
                  AND m.team_a_score - m.team_b_score <= 2)
              OR (mp.team = 'b' AND m.team_b_score > m.team_a_score
                  AND m.team_b_score - m.team_a_score <= 2))
        ))
      );
    END IF;

    IF (
      SELECT COUNT(*)
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND ((mp.team = 'a' AND m.team_a_score < m.team_b_score
              AND m.team_b_score - m.team_a_score <= 2)
          OR (mp.team = 'b' AND m.team_b_score < m.team_a_score
              AND m.team_a_score - m.team_b_score <= 2))
    ) >= 3 THEN
      v_awards     := array_append(v_awards, 'heartbreaker'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'heartbreaker', jsonb_build_object('narrow_losses', (
          SELECT COUNT(*)
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
          WHERE m.session_id = p_session_id AND m.status = 'completed'
            AND ((mp.team = 'a' AND m.team_a_score < m.team_b_score
                  AND m.team_b_score - m.team_a_score <= 2)
              OR (mp.team = 'b' AND m.team_b_score < m.team_a_score
                  AND m.team_a_score - m.team_b_score <= 2))
        ))
      );
    END IF;

    IF (
      SELECT COUNT(*)
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND m.team_a_score >= 20 AND m.team_b_score >= 20
    ) >= 3 THEN
      v_awards     := array_append(v_awards, 'deuce_magnet'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'deuce_magnet', jsonb_build_object('deuce_games', (
          SELECT COUNT(*)
          FROM matches m
          JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
          WHERE m.session_id = p_session_id AND m.status = 'completed'
            AND m.team_a_score >= 20 AND m.team_b_score >= 20
        ))
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- COMEDIC / PERSONALITY awards
    -- ─────────────────────────────────────────────────────────────────────
    IF v_player.wins = 0 THEN
      v_awards     := array_append(v_awards, 'participation_trophy'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'participation_trophy', jsonb_build_object(
          'games',   v_player.games_played,
          'message', 'You showed up. That''s what matters.'
        )
      );
    END IF;

    IF v_player.losses >= 4
       AND v_player.losses = (SELECT MAX(losses) FROM _wrapped_stats)
       AND v_session_player_count >= 4 THEN
      v_awards     := array_append(v_awards, 'the_punching_bag'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'the_punching_bag', jsonb_build_object('losses', v_player.losses)
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND ((mp.team = 'a' AND m.team_a_score = 0)
          OR (mp.team = 'b' AND m.team_b_score = 0))
    ) THEN
      v_awards     := array_append(v_awards, 'scoreboard_decorator'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'scoreboard_decorator', jsonb_build_object(
          'message', 'You let them have their perfect game.'
        )
      );
    END IF;

    -- NEW: Benchwarmer — played only 1 game all session
    IF v_player.games_played = 1 THEN
      v_awards     := array_append(v_awards, 'benchwarmer'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'benchwarmer', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    -- FIX 3: The Warm-Up Act now tier-replaces participation_trophy.
    -- A player who qualifies (0 wins, 3+ games, avg loss margin >= 6)
    -- already received participation_trophy above because wins = 0.
    -- Strip the generic consolation award and give the more specific one.
    IF v_player.wins = 0
       AND v_player.games_played >= 3
       AND v_player.avg_loss_margin IS NOT NULL
       AND v_player.avg_loss_margin >= 6 THEN
      v_awards     := array_remove(v_awards, 'participation_trophy'::text);
      v_award_data := v_award_data - 'participation_trophy';
      v_awards     := array_append(v_awards, 'the_warmup_act'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'the_warmup_act', jsonb_build_object(
          'avg_margin', ROUND(v_player.avg_loss_margin, 1),
          'games',      v_player.games_played
        )
      );
    END IF;

    -- NEW: Own Worst Enemy — lost to AND beat the same opponent
    IF v_player.own_worst_enemy_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'own_worst_enemy'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'own_worst_enemy', jsonb_build_object(
          'opponent_id',   v_player.own_worst_enemy_id,
          'opponent_name', v_player.own_worst_enemy_name
        )
      );
    END IF;

    -- NEW: The Veteran — all-time top-3 in games played AND active tonight
    IF v_player.is_alltime_top3 AND v_player.alltime_games >= 20 THEN
      v_awards     := array_append(v_awards, 'the_veteran'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'the_veteran', jsonb_build_object('alltime_games', v_player.alltime_games)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- SPECIAL / MILESTONE awards (NEW)
    -- ─────────────────────────────────────────────────────────────────────
    -- Century Club — 100+ all-time games
    IF v_player.alltime_games >= 100 THEN
      v_awards     := array_append(v_awards, 'century_club'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'century_club', jsonb_build_object('alltime_games', v_player.alltime_games)
      );
    END IF;

    -- Night Cap — played in the very last match of session
    IF v_player.played_last_match AND v_last_match_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'night_cap'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'night_cap', jsonb_build_object('match_id', v_last_match_id)
      );
    END IF;

    -- Early Bird — played in the very first match of session
    IF v_player.played_first_match AND v_first_match_id IS NOT NULL THEN
      v_awards     := array_append(v_awards, 'early_bird'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'early_bird', jsonb_build_object('match_id', v_first_match_id)
      );
    END IF;

    -- Skill Slayer — beat a team with avg skill ≥ player's skill + 2
    IF v_player.skill_slayer_wins >= 1 THEN
      v_awards     := array_append(v_awards, 'skill_slayer'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'skill_slayer', jsonb_build_object(
          'upset_wins', v_player.skill_slayer_wins
        )
      );
    END IF;

    -- Double Trouble — partner who also had ≥3 win streak the same night.
    -- Uses pre-computed `has_streak_partner` column (built inside _wrapped_stats
    -- where partner_counts is still in scope).
    IF v_player.win_streak >= 3 AND v_player.has_streak_partner THEN
      v_awards     := array_append(v_awards, 'double_trouble'::text);
      v_award_data := v_award_data || jsonb_build_object(
        'double_trouble', jsonb_build_object('streak', v_player.win_streak)
      );
    END IF;

    -- ─────────────────────────────────────────────────────────────────────
    -- FALLBACK
    -- ─────────────────────────────────────────────────────────────────────
    IF array_length(v_awards, 1) IS NULL OR array_length(v_awards, 1) = 0 THEN
      v_awards     := ARRAY['just_getting_started'];
      v_award_data := jsonb_build_object(
        'just_getting_started', jsonb_build_object(
          'games',   v_player.games_played,
          'message', 'Come back next session — your story is just beginning.'
        )
      );
    END IF;

    -- ── 4. Upsert into session_wrapped_stats ──────────────────────────────
    INSERT INTO session_wrapped_stats (
      session_id,
      player_id,
      computed_at,
      games_played,
      wins,
      losses,
      points_for,
      points_against,
      win_pct,
      win_streak,
      session_rank,
      earned_awards,
      award_data
    )
    VALUES (
      p_session_id,
      v_player.player_id,
      now(),
      v_player.games_played::integer,
      v_player.wins::integer,
      v_player.losses::integer,
      v_player.points_for::integer,
      v_player.points_against::integer,
      v_player.win_pct,
      v_player.win_streak::integer,
      v_player.session_rank::integer,
      v_awards,
      v_award_data
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
      award_data     = EXCLUDED.award_data;

  END LOOP;

END;
$$;

-- Grant unchanged — only invoked from server-side closeSession()
GRANT EXECUTE ON FUNCTION compute_session_wrapped(UUID) TO service_role;
