-- ============================================================
-- Migration: compute_session_wrapped() RPC
-- ============================================================
-- Called by closeSession() (server action) immediately before
-- the session_closed broadcast. Computes per-player stats and
-- awards for every player who completed ≥1 match this session,
-- then upserts into session_wrapped_stats.
--
-- SECURITY DEFINER: runs as the function owner (bypasses RLS)
-- so the server action only needs the service-role key —
-- no RLS gymnastics needed.
--
-- Idempotent: ON CONFLICT DO UPDATE means re-running is safe.
-- ============================================================

CREATE OR REPLACE FUNCTION compute_session_wrapped(p_session_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_winning_score       integer := 21;  -- adaptive: detected from MODE of scores
  v_player              RECORD;
  v_awards              text[];
  v_award_data          jsonb;

  -- Session-wide context (computed once, used across players)
  v_max_wins            integer := 0;
  v_max_games           integer := 0;
  v_max_points          integer := 0;
  v_best_win_pct        numeric := 0;
  v_worst_plus_minus    integer := 0;    -- most negative point diff
  v_session_player_count integer := 0;

BEGIN

  -- ── 0. Adaptive winning score detection ─────────────────────────────────
  -- Find the most common winning score across all completed matches this
  -- session. Falls back to 21 if not enough data.
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

  -- ── 1. Build per-player stats (temp table for this run) ──────────────────
  -- temp table lets us compute session-wide aggregates (rank, "most games",
  -- "top scorer") before deciding awards per player.
  --
  -- Fix: `total_games` is pre-computed as a window column in the inner
  -- subquery so it can be used in a plain aggregate (SUM) for last3_wins,
  -- avoiding the PostgreSQL restriction on window functions inside aggregates.

  CREATE TEMP TABLE _wrapped_stats ON COMMIT DROP AS
  WITH completed_matches AS (
    SELECT
      m.id            AS match_id,
      m.team_a_score  AS score_a,
      m.team_b_score  AS score_b,
      m.completed_at,
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
      CASE WHEN team = 'a' THEN score_a ELSE score_b END AS points_for,
      CASE WHEN team = 'a' THEN score_b ELSE score_a END AS points_against,
      CASE
        WHEN team = 'a' AND score_a > score_b THEN true
        WHEN team = 'b' AND score_b > score_a THEN true
        ELSE false
      END AS won,
      completed_at
    FROM completed_matches
  ),
  -- Compute longest win streak per player (gaps-and-islands trick)
  streak_calc AS (
    SELECT
      player_id, won, completed_at,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY completed_at)
        - ROW_NUMBER() OVER (PARTITION BY player_id, won ORDER BY completed_at) AS grp
    FROM player_match_results
  ),
  win_streaks AS (
    SELECT player_id, MAX(cnt) AS max_win_streak
    FROM (
      SELECT player_id, grp, COUNT(*) AS cnt
      FROM streak_calc
      WHERE won = true
      GROUP BY player_id, grp
    ) s
    GROUP BY player_id
  ),
  -- H2H: which opponent did each player lose to the most?
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
  -- H2H: which opponent did each player beat the most?
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
  -- Inner subquery: row-number + total_games as window columns.
  -- total_games is computed here so last3_wins can use it inside a plain SUM().
  player_match_results_numbered AS (
    SELECT
      *,
      ROW_NUMBER()  OVER (PARTITION BY player_id ORDER BY completed_at) AS rn,
      COUNT(*)      OVER (PARTITION BY player_id)                        AS total_games
    FROM player_match_results
  ),
  player_stats AS (
    SELECT
      pmr.player_id,
      COUNT(*)                                     AS games_played,
      SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)     AS wins,
      SUM(CASE WHEN NOT pmr.won THEN 1 ELSE 0 END) AS losses,
      SUM(pmr.points_for)                          AS points_for,
      SUM(pmr.points_against)                      AS points_against,
      ROUND(
        SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0) * 100, 2
      )                                            AS win_pct,
      COALESCE(ws.max_win_streak, 0)               AS win_streak,
      -- Last-3-games wins (for "Sunset Surge").
      -- Uses pre-computed total_games from the numbered CTE — avoids
      -- illegal window function inside aggregate.
      SUM(CASE WHEN pmr.won AND pmr.rn > pmr.total_games - 3
               THEN 1 ELSE 0 END)                  AS last3_wins,
      -- Won first game of the night (for "Fast Starter")
      BOOL_OR(CASE WHEN pmr.rn = 1 THEN pmr.won ELSE false END) AS won_first,
      -- Nemesis: opponent who beat this player the most (≥2 losses to them)
      (SELECT hl.opponent_id FROM h2h_losses hl
       WHERE hl.player_id = pmr.player_id AND hl.rk = 1 AND hl.loss_count >= 2
       LIMIT 1)                                    AS nemesis_id,
      (SELECT hl.loss_count FROM h2h_losses hl
       WHERE hl.player_id = pmr.player_id AND hl.rk = 1
       LIMIT 1)                                    AS nemesis_loss_count,
      -- Kryptonite: opponent this player beat the most (≥2 wins against them)
      (SELECT hw.victim_id FROM h2h_wins hw
       WHERE hw.player_id = pmr.player_id AND hw.rk = 1 AND hw.win_count >= 2
       LIMIT 1)                                    AS kryptonite_victim_id,
      (SELECT hw.win_count FROM h2h_wins hw
       WHERE hw.player_id = pmr.player_id AND hw.rk = 1
       LIMIT 1)                                    AS kryptonite_win_count
    FROM player_match_results_numbered pmr
    LEFT JOIN win_streaks ws ON ws.player_id = pmr.player_id
    GROUP BY pmr.player_id, ws.max_win_streak
  )
  SELECT
    ps.*,
    -- point_diff added here: GENERATED in the target table, must exist in temp table
    (ps.points_for - ps.points_against)           AS point_diff,
    -- Session rank by wins desc, then win_pct desc
    RANK() OVER (ORDER BY ps.wins DESC, ps.win_pct DESC) AS session_rank,
    -- Display names for nemesis / kryptonite
    pn.display_name  AS nemesis_name,
    pk.display_name  AS kryptonite_name
  FROM player_stats ps
  LEFT JOIN profiles pn ON pn.id = ps.nemesis_id
  LEFT JOIN profiles pk ON pk.id = ps.kryptonite_victim_id
  WHERE ps.games_played > 0;

  -- ── 2. Session-wide aggregates ───────────────────────────────────────────
  SELECT
    MAX(wins)::integer,
    MAX(games_played)::integer,
    MAX(points_for)::integer,
    MAX(win_pct),
    MIN(point_diff)::integer,
    COUNT(*)::integer
  INTO
    v_max_wins,
    v_max_games,
    v_max_points,
    v_best_win_pct,
    v_worst_plus_minus,
    v_session_player_count
  FROM _wrapped_stats;

  -- ── 3. Award computation loop ────────────────────────────────────────────
  FOR v_player IN SELECT * FROM _wrapped_stats LOOP

    v_awards    := ARRAY[]::text[];
    v_award_data := '{}'::jsonb;

    -- ── PERFORMANCE awards ───────────────────────────────────
    -- Undefeated: 100% win rate, ≥3 games
    IF v_player.wins = v_player.games_played AND v_player.games_played >= 3 THEN
      v_awards     := v_awards || 'undefeated_champion';
      v_award_data := v_award_data || jsonb_build_object(
        'undefeated_champion', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    -- Dominant Night: ≥80% win rate, ≥5 games (not undefeated)
    IF v_player.win_pct >= 80 AND v_player.games_played >= 5
       AND v_player.wins < v_player.games_played THEN
      v_awards     := v_awards || 'dominant_night';
      v_award_data := v_award_data || jsonb_build_object(
        'dominant_night', jsonb_build_object('win_pct', v_player.win_pct, 'wins', v_player.wins)
      );
    END IF;

    -- Solid Outing: 60–79% win rate, ≥3 games
    IF v_player.win_pct >= 60 AND v_player.win_pct < 80 AND v_player.games_played >= 3 THEN
      v_awards     := v_awards || 'solid_outing';
      v_award_data := v_award_data || jsonb_build_object(
        'solid_outing', jsonb_build_object('win_pct', v_player.win_pct)
      );
    END IF;

    -- Glass Half Full: equal wins and losses with ≥4 games
    IF v_player.wins = v_player.losses AND v_player.games_played >= 4 THEN
      v_awards     := v_awards || 'glass_half_full';
      v_award_data := v_award_data || jsonb_build_object(
        'glass_half_full', jsonb_build_object('wins', v_player.wins, 'losses', v_player.losses)
      );
    END IF;

    -- Session MVP: rank #1 with ≥3 games and ≥3 players in session
    IF v_player.session_rank = 1 AND v_player.games_played >= 3 AND v_session_player_count >= 3 THEN
      v_awards     := v_awards || 'session_mvp';
      v_award_data := v_award_data || jsonb_build_object(
        'session_mvp', jsonb_build_object('wins', v_player.wins, 'win_pct', v_player.win_pct)
      );
    END IF;

    -- ── SCORING awards ───────────────────────────────────────
    -- Point Machine: scored 100+ total points
    IF v_player.points_for >= 100 THEN
      v_awards     := v_awards || 'point_machine';
      v_award_data := v_award_data || jsonb_build_object(
        'point_machine', jsonb_build_object('total_points', v_player.points_for)
      );
    END IF;

    -- Shutout Artist: won a game where opponent scored 0 or 1
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
      v_awards     := v_awards || 'shutout_artist';
      v_award_data := v_award_data || jsonb_build_object(
        'shutout_artist', jsonb_build_object('winning_score', v_winning_score)
      );
    END IF;

    -- Top Scorer: most total points in the session (≥3 games, ≥4 players)
    IF v_player.points_for = v_max_points AND v_player.games_played >= 3
       AND v_session_player_count >= 4 THEN
      v_awards     := v_awards || 'top_scorer';
      v_award_data := v_award_data || jsonb_build_object(
        'top_scorer', jsonb_build_object('points', v_player.points_for)
      );
    END IF;

    -- Point Differential King: best +/- in session (≥3 games, positive)
    IF v_player.point_diff = (SELECT MAX(point_diff) FROM _wrapped_stats)
       AND v_player.games_played >= 3 AND v_player.point_diff > 0
       AND v_session_player_count >= 4 THEN
      v_awards     := v_awards || 'point_diff_king';
      v_award_data := v_award_data || jsonb_build_object(
        'point_diff_king', jsonb_build_object('point_diff', v_player.point_diff)
      );
    END IF;

    -- ── STREAK awards (tiered — lower tier removed when higher awarded) ────
    -- Hot Streak: 3–4 wins in a row at some point
    IF v_player.win_streak >= 3 AND v_player.win_streak < 5 THEN
      v_awards     := v_awards || 'hot_streak';
      v_award_data := v_award_data || jsonb_build_object(
        'hot_streak', jsonb_build_object('streak', v_player.win_streak)
      );
    END IF;

    -- On Fire: 5–6 wins in a row (replaces hot_streak)
    IF v_player.win_streak >= 5 AND v_player.win_streak < 7 THEN
      v_awards := array_remove(v_awards, 'hot_streak');
      v_awards     := v_awards || 'on_fire';
      v_award_data := v_award_data - 'hot_streak'
                   || jsonb_build_object('on_fire', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    -- Unstoppable: 7+ wins in a row (replaces all lower streak awards)
    IF v_player.win_streak >= 7 THEN
      v_awards := array_remove(v_awards, 'hot_streak');
      v_awards := array_remove(v_awards, 'on_fire');
      v_awards     := v_awards || 'unstoppable';
      v_award_data := v_award_data - 'hot_streak' - 'on_fire'
                   || jsonb_build_object('unstoppable', jsonb_build_object('streak', v_player.win_streak));
    END IF;

    -- ── VOLUME awards (tiered) ───────────────────────────────
    IF v_player.games_played >= 6 AND v_player.games_played < 8 THEN
      v_awards     := v_awards || 'battle_tested';
      v_award_data := v_award_data || jsonb_build_object(
        'battle_tested', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    IF v_player.games_played >= 8 AND v_player.games_played < 10 THEN
      v_awards := array_remove(v_awards, 'battle_tested');
      v_awards     := v_awards || 'marathon_night';
      v_award_data := v_award_data - 'battle_tested'
                   || jsonb_build_object('marathon_night', jsonb_build_object('games', v_player.games_played));
    END IF;

    IF v_player.games_played >= 10 THEN
      v_awards := array_remove(v_awards, 'battle_tested');
      v_awards := array_remove(v_awards, 'marathon_night');
      v_awards     := v_awards || 'court_hermit';
      v_award_data := v_award_data - 'battle_tested' - 'marathon_night'
                   || jsonb_build_object('court_hermit', jsonb_build_object('games', v_player.games_played));
    END IF;

    -- Most Active: highest games_played in session (≥5 games, ≥4 players)
    IF v_player.games_played = v_max_games AND v_player.games_played >= 5
       AND v_session_player_count >= 4 THEN
      v_awards     := v_awards || 'most_active';
      v_award_data := v_award_data || jsonb_build_object(
        'most_active', jsonb_build_object('games', v_player.games_played)
      );
    END IF;

    -- ── RESILIENCE awards ────────────────────────────────────
    -- Grinds: 3+ losses, ≥5 games, <50% win rate
    IF v_player.losses >= 3 AND v_player.games_played >= 5 AND v_player.win_pct < 50 THEN
      v_awards     := v_awards || 'grinds';
      v_award_data := v_award_data || jsonb_build_object(
        'grinds', jsonb_build_object('losses', v_player.losses, 'games', v_player.games_played)
      );
    END IF;

    -- Never Say Die: 5+ losses (upgrades over Grinds)
    IF v_player.losses >= 5 THEN
      v_awards := array_remove(v_awards, 'grinds');
      v_awards     := v_awards || 'never_say_die';
      v_award_data := v_award_data - 'grinds'
                   || jsonb_build_object('never_say_die', jsonb_build_object('losses', v_player.losses));
    END IF;

    -- Sunset Surge: won 2+ of last 3 games (≥4 games total)
    IF v_player.last3_wins >= 2 AND v_player.games_played >= 4 THEN
      v_awards     := v_awards || 'sunset_surge';
      v_award_data := v_award_data || jsonb_build_object(
        'sunset_surge', jsonb_build_object('final_wins', v_player.last3_wins)
      );
    END IF;

    -- Fast Starter: won first match (≥2 games total)
    IF v_player.won_first AND v_player.games_played >= 2 THEN
      v_awards     := v_awards || 'fast_starter';
      v_award_data := v_award_data || jsonb_build_object(
        'fast_starter', jsonb_build_object('first_match', 'win')
      );
    END IF;

    -- ── NEMESIS / H2H awards ─────────────────────────────────
    IF v_player.nemesis_id IS NOT NULL THEN
      v_awards     := v_awards || 'my_nemesis';
      v_award_data := v_award_data || jsonb_build_object(
        'my_nemesis', jsonb_build_object(
          'nemesis_id',   v_player.nemesis_id,
          'nemesis_name', v_player.nemesis_name,
          'loss_count',   v_player.nemesis_loss_count
        )
      );
    END IF;

    IF v_player.kryptonite_victim_id IS NOT NULL THEN
      v_awards     := v_awards || 'kryptonite';
      v_award_data := v_award_data || jsonb_build_object(
        'kryptonite', jsonb_build_object(
          'victim_id',    v_player.kryptonite_victim_id,
          'victim_name',  v_player.kryptonite_name,
          'win_count',    v_player.kryptonite_win_count
        )
      );
    END IF;

    -- ── SCORE-BASED FLAVOR awards ────────────────────────────
    -- Close Call Survivor: won 3+ games by ≤2 points
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
      v_awards     := v_awards || 'close_call_survivor';
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

    -- Heartbreaker: lost 3+ games by ≤2 points
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
      v_awards     := v_awards || 'heartbreaker';
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

    -- Deuce Magnet: 3+ games went to 20-20 or beyond
    IF (
      SELECT COUNT(*)
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND m.team_a_score >= 20 AND m.team_b_score >= 20
    ) >= 3 THEN
      v_awards     := v_awards || 'deuce_magnet';
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

    -- ── COMEDIC awards (safety net) ──────────────────────────
    -- Participation Trophy: 0 wins
    IF v_player.wins = 0 THEN
      v_awards     := v_awards || 'participation_trophy';
      v_award_data := v_award_data || jsonb_build_object(
        'participation_trophy', jsonb_build_object(
          'games',   v_player.games_played,
          'message', 'You showed up. That''s what matters.'
        )
      );
    END IF;

    -- The Punching Bag: most losses in session, ≥4 losses, ≥4 players
    IF v_player.losses >= 4
       AND v_player.losses = (SELECT MAX(losses) FROM _wrapped_stats)
       AND v_session_player_count >= 4 THEN
      v_awards     := v_awards || 'the_punching_bag';
      v_award_data := v_award_data || jsonb_build_object(
        'the_punching_bag', jsonb_build_object('losses', v_player.losses)
      );
    END IF;

    -- Scoreboard Decorator: lost a game 0-N (opponent scored the max)
    IF EXISTS (
      SELECT 1
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = v_player.player_id
      WHERE m.session_id = p_session_id AND m.status = 'completed'
        AND ((mp.team = 'a' AND m.team_a_score = 0)
          OR (mp.team = 'b' AND m.team_b_score = 0))
    ) THEN
      v_awards     := v_awards || 'scoreboard_decorator';
      v_award_data := v_award_data || jsonb_build_object(
        'scoreboard_decorator', jsonb_build_object(
          'message', 'You let them have their perfect game.'
        )
      );
    END IF;

    -- ── FALLBACK ─────────────────────────────────────────────
    -- Guarantee at least one award. Triggered when a player played
    -- only 1–2 unremarkable games (e.g. 1 win, 1 loss = no thresholds met).
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
    -- Note: point_diff is GENERATED ALWAYS AS and must NOT be in the column list.
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

-- Grant to service_role only — only called from server-side closeSession()
GRANT EXECUTE ON FUNCTION compute_session_wrapped(UUID) TO service_role;
