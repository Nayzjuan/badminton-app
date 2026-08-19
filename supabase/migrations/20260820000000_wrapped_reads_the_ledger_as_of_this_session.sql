-- ============================================================
-- compute_session_wrapped: read the ledgers AS OF this session, not as of now
-- ============================================================
-- WHAT IS WRONG
--
-- player_rivalries and player_partnerships are running totals with no time
-- dimension. compute_session_wrapped recovered a "before tonight" figure by
-- subtracting tonight out of them:
--
--     pre_wins_vs = pr.wins_vs - tonight_wins
--
-- That is only correct while the ledger contains nothing AFTER the session
-- being wrapped -- true for the ordinary close, which is why this has never
-- produced a wrong badge on production (28 wrapped sessions, 0 computed out of
-- chronological order, 0 overlapping sessions in the same club; measured
-- 2026-08-20). Re-derive the numbers with:
--
--     with w as (select s.club_id, s.id, s.created_at, min(sws.computed_at) ca
--                from session_wrapped_stats sws join sessions s on s.id=sws.session_id
--                group by 1,2,3)
--     select count(*) filter (where
--              row_number() over (partition by club_id order by created_at, id)
--           <> row_number() over (partition by club_id order by ca, id)) from w;
--
-- It stops being true the moment anything recomputes an OLD session's wrap.
-- src/app/actions/fix-player-record.ts does exactly that: after an organizer
-- corrects a roster it fires compute_session_wrapped on any closed session,
-- however long ago. The ledger by then holds every session since, so
-- "before tonight" silently includes matches from the player's future, and
-- cross_session_redemption / score_settled / dynasty_victim / max_serial_rival
-- all gate on it. The same recompute on the same row can produce a different
-- badge set every time it runs, which is the opposite of the idempotence the
-- caller documents.
--
-- THE SAME DEFECT IN THE MOMENTUM FAMILY
--
-- "Previous session" was defined twice -- prior_sessions_ranked (feeding
-- consistent_dominator and bounced_back) and prior_carry (feeding the carried
-- win streak) -- and both defined it as ANY OTHER session of the club, ranked
-- by session_wrapped_stats.computed_at DESC. That is when the wrap was
-- CALCULATED, not when the session was PLAYED, and it fails the same way:
-- recompute an old session and its "previous" session is a LATER one. It also
-- fails on its own -- re-running Fix Record rewrites computed_at, so the
-- ranking moves without a single match changing. Both are now bounded to
-- sessions that started before this one and ranked by the session clock, with
-- session_id as a deterministic tiebreak.
--
-- This one was caught by the replay harness rather than by reading: with the
-- ledger fix alone, redemption_arc and settled_the_score stopped drifting on a
-- recomputed old session and bounced_back still did.
--
-- WHAT THIS CHANGES
--
-- The subtraction window widens from "this session" to "this session and
-- everything after it", and the tonight-only figures are added back where a
-- number is meant to include tonight. One rule now holds for every
-- cross-session column in a wrap: it is as of the END of the session being
-- wrapped.
--
--     pre_wins_vs = ledger - since        (strictly before this session)
--     wins_vs     = ledger - since + tonight   (through the end of it)
--
-- WHY SUBTRACT RATHER THAN RE-DERIVE FROM matches
--
-- 20260812100000 rejected subtraction when it rebuilt the ledger, and the
-- reason it gave was specific: an ADDITIVE ledger cannot be trusted to contain
-- a session exactly once. That objection died with the additive ledger. Since
-- that migration the ledger is an absolute rebuild from complete match history,
-- so pr.wins_vs is exact by construction and subtracting from it is sound.
--
-- The alternative -- recomputing rivalry and partnership truth from `matches`
-- inside the wrap -- would put a SECOND definition of one quantity in a second
-- file with nothing keeping the two in step. That is this repository's most
-- repeated defect shape, and it would put it on the path of every wrap rather
-- than on the rare one. Subtraction keeps exactly one definition of the totals.
--
-- The since-window carries the ledger's own predicates (is_hidden=false,
-- status='completed', both scores NOT NULL) for the same reason: the quantity
-- being subtracted has to be measured the way the quantity it is subtracted
-- from was measured. That also retires the hazard 20260812100000 flagged in its
-- HIDDEN SESSIONS note -- closing a hidden session with completed matches used
-- to drive pre_wins_vs negative, because the ledger had excluded tonight and
-- the subtraction removed it anyway. The window now excludes it too.
--
-- NO-OP ON THE ORDINARY PATH, BY CONSTRUCTION
--
-- When the session being wrapped is the club's latest, the since-window is
-- exactly tonight, so ledger - since + tonight = ledger and every column holds
-- the value it holds today. tests/integration/cross-session-ledger.test.ts
-- pins both halves: the equivalence, and the out-of-order case that fails
-- without this migration.
--
-- NOT IN SCOPE
--
--   * refresh_cross_session_stats is untouched.
--   * The wrapped rows of hidden sessions still count as prior sessions.
--     refresh_cross_session_stats excludes is_hidden from the LEDGER, but
--     prior_sessions_ranked has always ranked every wrap that exists. That is a
--     question about which sessions count, not about which came first, and
--     changing it would move numbers this migration asserts are unchanged.
--   * No historical wrap is recomputed. The 638 stored rows keep the awards
--     their players have already seen.
--
-- HOW THIS FILE WAS BUILT
--
-- Generated by scripts/gen-wrapped-as-of-migration.py from the body declared in
-- 20260811000000_one_time_milestone_awards.sql, which was verified equal to
-- production's pg_proc.prosrc (md5 e3689008fe20a015421a0c69afc49375 over
-- '\n' || body || '\n') on 2026-08-20. Every substitution is anchored and the
-- generator aborts unless each anchor matches exactly once. Regenerate rather
-- than hand-editing.
--
-- APPLY BY HAND. Merging ships TypeScript only; verify with list_migrations.
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_session_wrapped(p_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_winning_score integer:=21; v_player RECORD; v_awards text[]; v_award_data jsonb;
  v_max_wins integer:=0; v_max_games integer:=0; v_max_points integer:=0;
  v_best_win_pct numeric:=0; v_worst_plus_minus integer:=0; v_session_player_count integer:=0;
  v_min_pa_per_game numeric:=NULL; v_max_unique_partners integer:=0;
  v_first_match_id uuid:=NULL; v_last_match_id uuid:=NULL; v_club_id uuid:=NULL; v_milestone_holder uuid:=NULL; v_session_start timestamptz:=NULL;
BEGIN
  SELECT club_id,created_at INTO v_club_id,v_session_start FROM sessions WHERE id=p_session_id;
  IF v_club_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('wrapped_awards:'||v_club_id::text, 0)); END IF; PERFORM refresh_alltime_leaderboard();
  SELECT COALESCE((SELECT s.score FROM (SELECT team_a_score AS score FROM matches WHERE session_id=p_session_id AND status='completed' AND team_a_score IS NOT NULL AND team_b_score IS NOT NULL AND team_a_score>team_b_score UNION ALL SELECT team_b_score FROM matches WHERE session_id=p_session_id AND status='completed' AND team_a_score IS NOT NULL AND team_b_score IS NOT NULL AND team_b_score>team_a_score) s GROUP BY s.score ORDER BY COUNT(*) DESC,s.score DESC LIMIT 1),21) INTO v_winning_score;
  SELECT id INTO v_first_match_id FROM matches WHERE session_id=p_session_id AND status='completed' AND started_at IS NOT NULL ORDER BY started_at ASC LIMIT 1;
  SELECT id INTO v_last_match_id FROM matches WHERE session_id=p_session_id AND status='completed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1;
  CREATE TEMP TABLE _wrapped_stats ON COMMIT DROP AS
  WITH completed_matches AS (SELECT m.id AS match_id,m.team_a_score AS score_a,m.team_b_score AS score_b,m.is_mixed_level,m.completed_at,m.started_at,mp.player_id,mp.team FROM matches m JOIN match_players mp ON mp.match_id=m.id WHERE m.session_id=p_session_id AND m.status='completed' AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL),
  player_match_results AS (SELECT player_id,match_id,team,is_mixed_level,CASE WHEN team='a' THEN score_a ELSE score_b END AS points_for,CASE WHEN team='a' THEN score_b ELSE score_a END AS points_against,CASE WHEN team='a' AND score_a>score_b THEN true WHEN team='b' AND score_b>score_a THEN true ELSE false END AS won,completed_at,started_at FROM completed_matches),
  streak_calc AS (SELECT player_id,won,completed_at,ROW_NUMBER() OVER(PARTITION BY player_id ORDER BY completed_at)-ROW_NUMBER() OVER(PARTITION BY player_id,won ORDER BY completed_at) AS grp FROM player_match_results),
  win_streak_groups AS (SELECT player_id,grp,COUNT(*) AS cnt FROM streak_calc WHERE won=true GROUP BY player_id,grp),
  win_streaks AS (SELECT player_id,MAX(cnt) AS max_win_streak,COUNT(*) FILTER(WHERE cnt>=2) AS distinct_win_streaks_2plus,COUNT(*) FILTER(WHERE cnt>=3) AS distinct_win_streaks_3plus FROM win_streak_groups GROUP BY player_id),
  h2h_losses AS (SELECT p1.player_id,p2.player_id AS opponent_id,COUNT(*) AS loss_count,ROW_NUMBER() OVER(PARTITION BY p1.player_id ORDER BY COUNT(*) DESC,p2.player_id) AS rk FROM player_match_results p1 JOIN match_players mp2 ON mp2.match_id=p1.match_id AND mp2.team!=p1.team JOIN player_match_results p2 ON p2.match_id=p1.match_id AND p2.player_id=mp2.player_id WHERE p1.won=false GROUP BY p1.player_id,p2.player_id),
  h2h_wins AS (SELECT p1.player_id,p2.player_id AS victim_id,COUNT(*) AS win_count,ROW_NUMBER() OVER(PARTITION BY p1.player_id ORDER BY COUNT(*) DESC,p2.player_id) AS rk FROM player_match_results p1 JOIN match_players mp2 ON mp2.match_id=p1.match_id AND mp2.team!=p1.team JOIN player_match_results p2 ON p2.match_id=p1.match_id AND p2.player_id=mp2.player_id WHERE p1.won=true GROUP BY p1.player_id,p2.player_id),
  match_opponent_pairs AS (SELECT p.player_id,p.match_id,p.won,p.completed_at,LEAST(o1.player_id,o2.player_id)::text||'_'||GREATEST(o1.player_id,o2.player_id)::text AS opp_pair_key,LEAST(o1.player_id,o2.player_id) AS opp_a,GREATEST(o1.player_id,o2.player_id) AS opp_b FROM player_match_results p JOIN match_players o1 ON o1.match_id=p.match_id AND o1.team!=p.team JOIN match_players o2 ON o2.match_id=p.match_id AND o2.team!=p.team AND o2.player_id<o1.player_id),
  opp_pair_summary AS (SELECT player_id,opp_pair_key,COUNT(*) AS encounters,MIN(completed_at) FILTER(WHERE NOT won) AS first_loss_at,MAX(completed_at) FILTER(WHERE won) AS last_win_at,BOOL_OR(NOT won) AS has_loss,BOOL_OR(won) AS has_win FROM match_opponent_pairs GROUP BY player_id,opp_pair_key),
  rematch_counts AS (SELECT DISTINCT ON(player_id) player_id,encounters::int AS max_rematch_count,opp_pair_key AS top_pair_key FROM opp_pair_summary ORDER BY player_id,encounters DESC,opp_pair_key),
  redemption_pairs AS (SELECT player_id,COUNT(*)::int AS redemption_count,MAX(opp_pair_key) AS sample_pair_key FROM opp_pair_summary WHERE has_loss AND has_win AND first_loss_at IS NOT NULL AND last_win_at IS NOT NULL AND last_win_at>first_loss_at GROUP BY player_id),
  partner_counts AS (SELECT mp1.player_id,mp2.player_id AS partner_id,COUNT(*)::int AS pair_count FROM match_players mp1 JOIN match_players mp2 ON mp2.match_id=mp1.match_id AND mp2.team=mp1.team AND mp2.player_id!=mp1.player_id JOIN matches m ON m.id=mp1.match_id WHERE m.session_id=p_session_id AND m.status='completed' GROUP BY mp1.player_id,mp2.player_id),
  partner_aggregates AS (SELECT player_id,COUNT(*)::int AS unique_partners,MAX(pair_count)::int AS max_same_partner_count FROM partner_counts GROUP BY player_id),
  top_partner_per_player AS (SELECT DISTINCT ON(player_id) player_id,partner_id AS top_partner_id,pair_count AS top_partner_count FROM partner_counts ORDER BY player_id,pair_count DESC,partner_id),
  partner_summary AS (SELECT pa.player_id,pa.unique_partners,pa.max_same_partner_count,tp.top_partner_id FROM partner_aggregates pa LEFT JOIN top_partner_per_player tp ON tp.player_id=pa.player_id),
  partners AS (SELECT DISTINCT mp1.player_id,mp2.player_id AS other_id FROM match_players mp1 JOIN match_players mp2 ON mp2.match_id=mp1.match_id AND mp2.team=mp1.team AND mp2.player_id!=mp1.player_id JOIN matches m ON m.id=mp1.match_id WHERE m.session_id=p_session_id AND m.status='completed'),
  opponents AS (SELECT DISTINCT mp1.player_id,mp2.player_id AS other_id FROM match_players mp1 JOIN match_players mp2 ON mp2.match_id=mp1.match_id AND mp2.team!=mp1.team JOIN matches m ON m.id=mp1.match_id WHERE m.session_id=p_session_id AND m.status='completed'),
  friendly_fire_counts AS (SELECT player_id,COUNT(*)::int AS overlap_count FROM(SELECT player_id,other_id FROM partners INTERSECT SELECT player_id,other_id FROM opponents) overlap GROUP BY player_id),
  own_worst_enemy_pairs AS (SELECT hl.player_id,hl.opponent_id,hl.loss_count,hw.win_count FROM h2h_losses hl JOIN h2h_wins hw ON hw.player_id=hl.player_id AND hw.victim_id=hl.opponent_id),
  own_worst_enemy_summary AS (SELECT DISTINCT ON(player_id) player_id,opponent_id AS worst_id FROM own_worst_enemy_pairs ORDER BY player_id,(loss_count+win_count) DESC,opponent_id),
  player_skills AS (SELECT pr.id AS player_id,skill_level_to_int(pr.skill_level)::int AS skill_int FROM profiles pr),
  match_opponent_skill AS (SELECT pmr.player_id,pmr.match_id,pmr.won,AVG(skill_level_to_int(opp_p.skill_level)::numeric) AS opp_avg_skill FROM player_match_results pmr JOIN match_players opp_mp ON opp_mp.match_id=pmr.match_id AND opp_mp.team!=pmr.team JOIN profiles opp_p ON opp_p.id=opp_mp.player_id GROUP BY pmr.player_id,pmr.match_id,pmr.won),
  skill_slayer_counts AS (SELECT mos.player_id,COUNT(*) FILTER(WHERE mos.won AND mos.opp_avg_skill>=ps.skill_int+2)::int AS upset_wins,MAX(mos.opp_avg_skill) FILTER(WHERE mos.won AND mos.opp_avg_skill>=ps.skill_int+2)::numeric AS top_upset_skill FROM match_opponent_skill mos JOIN player_skills ps ON ps.player_id=mos.player_id GROUP BY mos.player_id),
  alltime_top3 AS (SELECT player_id FROM v_alltime_leaderboard_mat WHERE club_id=v_club_id ORDER BY games_played DESC NULLS LAST,win_pct DESC NULLS LAST LIMIT 3),
  player_match_results_numbered AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY player_id ORDER BY completed_at) AS rn,COUNT(*) OVER(PARTITION BY player_id) AS total_games FROM player_match_results),
  player_stats AS (SELECT pmr.player_id,COUNT(*) AS games_played,SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END) AS wins,SUM(CASE WHEN NOT pmr.won THEN 1 ELSE 0 END) AS losses,SUM(pmr.points_for) AS points_for,SUM(pmr.points_against) AS points_against,ROUND(SUM(CASE WHEN pmr.won THEN 1 ELSE 0 END)::numeric/NULLIF(COUNT(*),0)*100,2) AS win_pct,COALESCE(ws.max_win_streak,0) AS win_streak,COALESCE(ws.distinct_win_streaks_2plus,0) AS distinct_win_streaks_2plus,SUM(CASE WHEN pmr.won AND pmr.rn>pmr.total_games-3 THEN 1 ELSE 0 END) AS last3_wins,SUM(CASE WHEN pmr.rn>pmr.total_games-3 THEN 1 ELSE 0 END) AS last3_total,BOOL_OR(CASE WHEN pmr.rn=1 THEN pmr.won ELSE false END) AS won_first,BOOL_OR(CASE WHEN pmr.rn=pmr.total_games THEN pmr.won ELSE false END) AS won_last,(SUM(CASE WHEN pmr.rn IN(1,2) AND NOT pmr.won THEN 1 ELSE 0 END)=2 AND MAX(pmr.total_games)>=2) AS lost_first_two,SUM(CASE WHEN pmr.won AND pmr.rn>2 THEN 1 ELSE 0 END) AS wins_after_first_two,AVG(CASE WHEN pmr.won THEN(pmr.points_for-pmr.points_against)::numeric ELSE NULL END) AS avg_winning_margin,AVG(CASE WHEN NOT pmr.won THEN(pmr.points_against-pmr.points_for)::numeric ELSE NULL END) AS avg_loss_margin,SUM(CASE WHEN pmr.won AND pmr.points_for-pmr.points_against>=8 THEN 1 ELSE 0 END) AS wins_by_8_or_more,SUM(CASE WHEN pmr.won AND pmr.points_for-pmr.points_against BETWEEN 5 AND 7 THEN 1 ELSE 0 END) AS wins_by_5_to_7,ROUND(SUM(pmr.points_against)::numeric/NULLIF(COUNT(*),0),2) AS avg_pa_per_game,SUM(CASE WHEN pmr.won AND pmr.is_mixed_level THEN 1 ELSE 0 END) AS mixed_wins,BOOL_OR(pmr.match_id=v_first_match_id) AS played_first_match,BOOL_OR(pmr.match_id=v_last_match_id) AS played_last_match,(SELECT hl.opponent_id FROM h2h_losses hl WHERE hl.player_id=pmr.player_id AND hl.rk=1 AND hl.loss_count>=2 LIMIT 1) AS nemesis_id,(SELECT hl.loss_count FROM h2h_losses hl WHERE hl.player_id=pmr.player_id AND hl.rk=1 LIMIT 1) AS nemesis_loss_count,(SELECT hw.victim_id FROM h2h_wins hw WHERE hw.player_id=pmr.player_id AND hw.rk=1 AND hw.win_count>=2 LIMIT 1) AS kryptonite_victim_id,(SELECT hw.win_count FROM h2h_wins hw WHERE hw.player_id=pmr.player_id AND hw.rk=1 LIMIT 1) AS kryptonite_win_count,EXISTS(SELECT 1 FROM partner_counts pc JOIN win_streaks ws2 ON ws2.player_id=pc.partner_id WHERE pc.player_id=pmr.player_id AND ws2.max_win_streak>=3) AS has_streak_partner FROM player_match_results_numbered pmr LEFT JOIN win_streaks ws ON ws.player_id=pmr.player_id GROUP BY pmr.player_id,ws.max_win_streak,ws.distinct_win_streaks_2plus)
  SELECT ps.*,(ps.points_for-ps.points_against) AS point_diff,RANK() OVER(ORDER BY ps.wins DESC,ps.win_pct DESC) AS session_rank,pn.display_name AS nemesis_name,pk.display_name AS kryptonite_name,COALESCE(rc.max_rematch_count,0) AS max_rematch_count,rc.top_pair_key AS top_rematch_pair_key,COALESCE(rp.redemption_count,0) AS redemption_count,COALESCE(ps_partner.unique_partners,0) AS unique_partners,COALESCE(ps_partner.max_same_partner_count,0) AS max_same_partner_count,ps_partner.top_partner_id,pp_name.display_name AS top_partner_name,COALESCE(ff.overlap_count,0) AS friendly_fire_overlap,owe.worst_id AS own_worst_enemy_id,owe_name.display_name AS own_worst_enemy_name,COALESCE(ssc.upset_wins,0) AS skill_slayer_wins,ssc.top_upset_skill AS skill_slayer_top_skill,COALESCE(amat.games_played,0) AS alltime_games,(a3.player_id IS NOT NULL) AS is_alltime_top3
  FROM player_stats ps LEFT JOIN profiles pn ON pn.id=ps.nemesis_id LEFT JOIN profiles pk ON pk.id=ps.kryptonite_victim_id LEFT JOIN rematch_counts rc ON rc.player_id=ps.player_id LEFT JOIN redemption_pairs rp ON rp.player_id=ps.player_id LEFT JOIN partner_summary ps_partner ON ps_partner.player_id=ps.player_id LEFT JOIN profiles pp_name ON pp_name.id=ps_partner.top_partner_id LEFT JOIN friendly_fire_counts ff ON ff.player_id=ps.player_id LEFT JOIN own_worst_enemy_summary owe ON owe.player_id=ps.player_id LEFT JOIN profiles owe_name ON owe_name.id=owe.worst_id LEFT JOIN skill_slayer_counts ssc ON ssc.player_id=ps.player_id LEFT JOIN v_alltime_leaderboard_mat amat ON amat.player_id=ps.player_id AND amat.club_id=v_club_id LEFT JOIN alltime_top3 a3 ON a3.player_id=ps.player_id WHERE ps.games_played>0;
  SELECT MAX(wins)::integer,MAX(games_played)::integer,MAX(points_for)::integer,MAX(win_pct),MIN(point_diff)::integer,COUNT(*)::integer,MIN(avg_pa_per_game) FILTER(WHERE games_played>=4),MAX(unique_partners) FILTER(WHERE games_played>=4) INTO v_max_wins,v_max_games,v_max_points,v_best_win_pct,v_worst_plus_minus,v_session_player_count,v_min_pa_per_game,v_max_unique_partners FROM _wrapped_stats;
  -- ── One-time milestone ledger ──────────────────────────────
  -- Six of the awards below are MILESTONES, not per-night achievements: they
  -- describe the player's ALL-TIME record rather than tonight, so the condition
  -- is still true the next time they turn up and, without this table, the award
  -- re-fires every session. That is how century_club ("Welcome to the 100 club")
  -- came to be handed to 5 players 18 times, and serial_rivals to 34 players 132
  -- times. Each of the six is now earned in the FIRST session where it holds and
  -- never again.
  --
  -- Two properties of this lookup are load-bearing:
  --   • It matches ANY OTHER session of the club -- not just earlier ones -- and
  --     it excludes p_session_id. Both halves matter, for opposite reasons.
  --     Excluding p_session_id is what makes the RPC RECOMPUTE-SAFE: re-running
  --     it on an already-computed session (fixPlayerRecord does exactly that,
  --     unconditionally, on any closed session) cannot see that session's own
  --     grant, so it re-grants the award instead of revoking it.
  --     Matching in BOTH directions is what makes it IDEMPOTENT. Every gated
  --     condition is evaluated against PRESENT-DAY all-time data -- the loop
  --     reads v_alltime_leaderboard_mat, refreshed at the top of this function,
  --     with no session cutoff -- so "alltime_games>=100" is just as true of a
  --     session the player played BEFORE they crossed 100. A backward-only
  --     lookup would therefore re-grant the award on every earlier session that
  --     ever got recomputed, recreating the exact duplicate this table exists
  --     to prevent. Measured on production: a backward-only bound would
  --     re-duplicate 217 serial_rivals, 111 the_dynasty, 81 century_club, 63
  --     winning_formula, 20 the_veteran and 15 first_to_100 grants -- the last
  --     of which the OLD code was not even vulnerable to, so a backward-only
  --     rule would have been a fresh regression. Ordering is NOT part of this
  --     predicate -- "first earning" is decided by which wrap holds the grant,
  --     not by recomputing a chronology on every call.
  --   • It excludes hidden sessions, matching v_alltime_leaderboard_mat, which
  --     is the source of alltime_games. Same universe in, same universe out --
  --     and an E2E sandbox wrap can never burn a real player's one-time award.
  --
  -- Net effect, stated precisely: the award lives on AT MOST one wrap per
  -- (club, player), and no session can ever add a second. Recomputing the
  -- holding session re-evaluates the live condition -- which is why the award
  -- can still DISAPPEAR there, for the three non-monotone ones: the_veteran
  -- (top-3 is relative, others overtake you), the_dynasty (a 70% win rate
  -- against a rival can fall back under) and winning_formula (your top partner
  -- can change). That is unchanged from the old function and is not what this
  -- migration is about; the guarantee added here is strictly "never twice".
  --
  -- Also deliberate: the gate is per PLAYER, not per (player, rival/partner).
  -- soulmates / winning_formula / the_dynasty / serial_rivals therefore cannot
  -- be re-earned with a DIFFERENT partner or rival. That was the product call
  -- (all six were chosen to be one-time); it is not an oversight.
  CREATE TEMP TABLE _prior_awards ON COMMIT DROP AS
  SELECT DISTINCT sws.player_id,a.slug FROM session_wrapped_stats sws JOIN sessions s2 ON s2.id=sws.session_id CROSS JOIN LATERAL unnest(sws.earned_awards) AS a(slug) WHERE s2.club_id=v_club_id AND s2.is_hidden=false AND sws.session_id<>p_session_id AND sws.player_id IN(SELECT player_id FROM _wrapped_stats) AND a.slug IN('century_club','first_to_100','the_veteran','serial_rivals','the_dynasty','soulmates','winning_formula');
  CREATE TEMP TABLE _cross_session_stats ON COMMIT DROP AS
  WITH tonight_matches AS (SELECT m.id AS match_id,mp.player_id,mp.team,CASE WHEN mp.team='a' AND m.team_a_score>m.team_b_score THEN true WHEN mp.team='b' AND m.team_b_score>m.team_a_score THEN true ELSE false END AS won FROM matches m JOIN match_players mp ON mp.match_id=m.id WHERE m.session_id=p_session_id AND m.status='completed' AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL),
  tonight_vs_rival AS (SELECT p.player_id,opp.player_id AS rival_id,SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS tonight_wins,SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int AS tonight_losses FROM tonight_matches p JOIN match_players opp ON opp.match_id=p.match_id AND opp.team!=p.team GROUP BY p.player_id,opp.player_id),
  since_matches AS (SELECT m.id AS match_id,m.session_id,mp.player_id,mp.team,CASE WHEN mp.team='a' AND m.team_a_score>m.team_b_score THEN true WHEN mp.team='b' AND m.team_b_score>m.team_a_score THEN true ELSE false END AS won FROM matches m JOIN sessions s ON s.id=m.session_id JOIN match_players mp ON mp.match_id=m.id WHERE s.club_id=v_club_id AND s.is_hidden=false AND m.status='completed' AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL AND (m.session_id=p_session_id OR m.completed_at>=v_session_start)),
  since_vs_rival AS (SELECT p.player_id,opp.player_id AS rival_id,SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS since_wins,SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int AS since_losses,COUNT(DISTINCT p.session_id)::int AS since_sessions FROM since_matches p JOIN match_players opp ON opp.match_id=p.match_id AND opp.team!=p.team GROUP BY p.player_id,opp.player_id),
  since_with_partner AS (SELECT p.player_id,tm.player_id AS partner_id,COUNT(*)::int AS since_games,SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS since_wins,COUNT(DISTINCT p.session_id)::int AS since_sessions FROM since_matches p JOIN match_players tm ON tm.match_id=p.match_id AND tm.team=p.team AND tm.player_id<>p.player_id GROUP BY p.player_id,tm.player_id),
  tonight_with_partner AS (SELECT p.player_id,tm.player_id AS partner_id,COUNT(*)::int AS tonight_games,SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS tonight_wins FROM tonight_matches p JOIN match_players tm ON tm.match_id=p.match_id AND tm.team=p.team AND tm.player_id<>p.player_id GROUP BY p.player_id,tm.player_id),
  rivalry_with_tonight AS (SELECT pr.player_id,pr.rival_id,(pr.wins_vs-COALESCE(svr.since_wins,0)+COALESCE(tvr.tonight_wins,0)) AS wins_vs,(pr.losses_vs-COALESCE(svr.since_losses,0)+COALESCE(tvr.tonight_losses,0)) AS losses_vs,(pr.sessions_faced-COALESCE(svr.since_sessions,0)+CASE WHEN tvr.player_id IS NULL THEN 0 ELSE 1 END) AS sessions_faced,(pr.wins_vs-COALESCE(svr.since_wins,0)) AS pre_wins_vs,(pr.losses_vs-COALESCE(svr.since_losses,0)) AS pre_losses_vs,COALESCE(tvr.tonight_wins,0) AS tonight_wins,COALESCE(tvr.tonight_losses,0) AS tonight_losses FROM player_rivalries pr LEFT JOIN since_vs_rival svr ON svr.player_id=pr.player_id AND svr.rival_id=pr.rival_id LEFT JOIN tonight_vs_rival tvr ON tvr.player_id=pr.player_id AND tvr.rival_id=pr.rival_id WHERE pr.club_id=v_club_id AND pr.player_id IN(SELECT player_id FROM _wrapped_stats)),
  alltime_nemesis AS (SELECT DISTINCT ON(player_id) player_id,rival_id AS cs_nemesis_alltime_id,wins_vs AS cs_my_wins_vs_alltime_nemesis,losses_vs AS cs_alltime_nemesis_wins_vs_me,sessions_faced AS cs_alltime_nemesis_sessions,(losses_vs-wins_vs) AS cs_nemesis_net_deficit FROM rivalry_with_tonight WHERE losses_vs>wins_vs ORDER BY player_id,(losses_vs-wins_vs) DESC,losses_vs DESC,rival_id),
  beat_nemesis_tonight AS (SELECT an.player_id,COALESCE((tvr.tonight_wins>0),false) AS cs_beat_nemesis_tonight FROM alltime_nemesis an LEFT JOIN tonight_vs_rival tvr ON tvr.player_id=an.player_id AND tvr.rival_id=an.cs_nemesis_alltime_id),
  score_settled AS (SELECT DISTINCT ON(player_id) player_id,rival_id AS cs_settled_rival_id,(pre_losses_vs-pre_wins_vs) AS cs_score_old_deficit FROM rivalry_with_tonight WHERE pre_losses_vs>pre_wins_vs AND wins_vs>=losses_vs AND tonight_wins>0 ORDER BY player_id,(pre_losses_vs-pre_wins_vs) DESC,rival_id),
  dynasty_victim AS (SELECT DISTINCT ON(player_id) player_id,rival_id AS cs_dynasty_victim_id,wins_vs AS cs_dynasty_wins,losses_vs AS cs_dynasty_losses,sessions_faced AS cs_dynasty_sessions FROM rivalry_with_tonight WHERE wins_vs>=5 AND wins_vs::numeric/NULLIF(wins_vs+losses_vs,0)>=0.70 ORDER BY player_id,wins_vs DESC,(wins_vs+losses_vs) DESC,rival_id),
  max_serial_rival AS (SELECT player_id,MAX(sessions_faced)::int AS cs_max_sessions_faced FROM rivalry_with_tonight GROUP BY player_id),
  session_nemesis_alltime AS (SELECT ws.player_id,COALESCE(rwt.wins_vs,0) AS cs_sn_my_alltime_wins,COALESCE(rwt.losses_vs,0) AS cs_sn_alltime_losses,COALESCE(rwt.sessions_faced,0) AS cs_sn_alltime_sessions FROM _wrapped_stats ws LEFT JOIN rivalry_with_tonight rwt ON rwt.player_id=ws.player_id AND rwt.rival_id=ws.nemesis_id),
  session_kryptonite_alltime AS (SELECT ws.player_id,COALESCE(rwt.wins_vs,0) AS cs_sk_my_alltime_wins,COALESCE(rwt.losses_vs,0) AS cs_sk_alltime_losses,COALESCE(rwt.sessions_faced,0) AS cs_sk_alltime_sessions FROM _wrapped_stats ws LEFT JOIN rivalry_with_tonight rwt ON rwt.player_id=ws.player_id AND rwt.rival_id=ws.kryptonite_victim_id),
  cross_session_redemption AS (SELECT DISTINCT ON(player_id) player_id,rival_id AS cs_redeemed_rival_id FROM rivalry_with_tonight WHERE pre_losses_vs>0 AND pre_wins_vs=0 AND tonight_wins>0 ORDER BY player_id,pre_losses_vs DESC,rival_id),
  partnership_alltime AS (SELECT DISTINCT ON(pp.player_id) pp.player_id,pp.partner_id AS cs_top_alltime_partner_id,(pp.games_together-COALESCE(swp.since_games,0)+COALESCE(twp.tonight_games,0)) AS cs_alltime_games_together,(pp.wins_together-COALESCE(swp.since_wins,0)+COALESCE(twp.tonight_wins,0)) AS cs_alltime_wins_together,(pp.sessions_together-COALESCE(swp.since_sessions,0)+CASE WHEN twp.player_id IS NULL THEN 0 ELSE 1 END) AS cs_alltime_sessions_together,ROUND((pp.wins_together-COALESCE(swp.since_wins,0)+COALESCE(twp.tonight_wins,0))::numeric/NULLIF((pp.games_together-COALESCE(swp.since_games,0)+COALESCE(twp.tonight_games,0)),0)*100,1) AS cs_alltime_partner_win_rate FROM player_partnerships pp LEFT JOIN since_with_partner swp ON swp.player_id=pp.player_id AND swp.partner_id=pp.partner_id LEFT JOIN tonight_with_partner twp ON twp.player_id=pp.player_id AND twp.partner_id=pp.partner_id WHERE pp.club_id=v_club_id AND pp.player_id IN(SELECT player_id FROM _wrapped_stats) ORDER BY pp.player_id,(pp.games_together-COALESCE(swp.since_games,0)+COALESCE(twp.tonight_games,0)) DESC,pp.partner_id),
  prior_sessions_ranked AS (SELECT sws.player_id,sws.win_pct,ROW_NUMBER() OVER(PARTITION BY sws.player_id ORDER BY ps.created_at DESC,sws.session_id DESC) AS rn FROM session_wrapped_stats sws JOIN sessions ps ON ps.id=sws.session_id WHERE sws.session_id!=p_session_id AND ps.club_id=v_club_id AND ps.created_at<v_session_start AND sws.player_id IN(SELECT player_id FROM _wrapped_stats)),
  prior_sessions AS (SELECT player_id,COUNT(*) FILTER(WHERE win_pct>=70)::int AS cs_prior_dominant_sessions,(array_agg(win_pct ORDER BY rn))[1] AS cs_prior_last_win_pct FROM prior_sessions_ranked WHERE rn<=2 GROUP BY player_id),
  prior_carry AS (SELECT DISTINCT ON(sws.player_id) sws.player_id,(sws.carry_forward->>'ended_on_win_streak')::int AS cs_prior_win_streak,(sws.carry_forward->>'session_win_pct')::numeric AS cs_prior_session_win_pct FROM session_wrapped_stats sws JOIN sessions cs ON cs.id=sws.session_id WHERE sws.session_id!=p_session_id AND cs.club_id=v_club_id AND cs.created_at<v_session_start AND sws.player_id IN(SELECT player_id FROM _wrapped_stats) AND sws.carry_forward!='{}'::jsonb ORDER BY sws.player_id,cs.created_at DESC,sws.session_id DESC)
  SELECT ws.player_id AS cs_player_id,an.cs_nemesis_alltime_id,an.cs_my_wins_vs_alltime_nemesis,an.cs_alltime_nemesis_wins_vs_me,an.cs_alltime_nemesis_sessions,an.cs_nemesis_net_deficit,COALESCE(bnt.cs_beat_nemesis_tonight,false) AS cs_beat_nemesis_tonight,ss.cs_settled_rival_id,ss.cs_score_old_deficit,dv.cs_dynasty_victim_id,dv.cs_dynasty_wins,dv.cs_dynasty_losses,dv.cs_dynasty_sessions,COALESCE(msr.cs_max_sessions_faced,0) AS cs_max_sessions_faced,COALESCE(sna.cs_sn_my_alltime_wins,0) AS cs_sn_my_alltime_wins,COALESCE(sna.cs_sn_alltime_losses,0) AS cs_sn_alltime_losses,COALESCE(sna.cs_sn_alltime_sessions,0) AS cs_sn_alltime_sessions,COALESCE(ska.cs_sk_my_alltime_wins,0) AS cs_sk_my_alltime_wins,COALESCE(ska.cs_sk_alltime_losses,0) AS cs_sk_alltime_losses,COALESCE(ska.cs_sk_alltime_sessions,0) AS cs_sk_alltime_sessions,csr.cs_redeemed_rival_id,pa.cs_top_alltime_partner_id,COALESCE(pa.cs_alltime_games_together,0) AS cs_alltime_games_together,COALESCE(pa.cs_alltime_wins_together,0) AS cs_alltime_wins_together,COALESCE(pa.cs_alltime_sessions_together,0) AS cs_alltime_sessions_together,pa.cs_alltime_partner_win_rate,COALESCE(ps.cs_prior_dominant_sessions,0) AS cs_prior_dominant_sessions,ps.cs_prior_last_win_pct,COALESCE(pc.cs_prior_win_streak,0) AS cs_prior_win_streak,pc.cs_prior_session_win_pct
  FROM _wrapped_stats ws LEFT JOIN alltime_nemesis an ON an.player_id=ws.player_id LEFT JOIN beat_nemesis_tonight bnt ON bnt.player_id=ws.player_id LEFT JOIN score_settled ss ON ss.player_id=ws.player_id LEFT JOIN dynasty_victim dv ON dv.player_id=ws.player_id LEFT JOIN max_serial_rival msr ON msr.player_id=ws.player_id LEFT JOIN session_nemesis_alltime sna ON sna.player_id=ws.player_id LEFT JOIN session_kryptonite_alltime ska ON ska.player_id=ws.player_id LEFT JOIN cross_session_redemption csr ON csr.player_id=ws.player_id LEFT JOIN partnership_alltime pa ON pa.player_id=ws.player_id LEFT JOIN prior_sessions ps ON ps.player_id=ws.player_id LEFT JOIN prior_carry pc ON pc.player_id=ws.player_id;
  -- _ended_streaks: actual end-of-session win streak (consecutive wins counting backward from last match)
  CREATE TEMP TABLE _ended_streaks ON COMMIT DROP AS
  WITH sc AS (SELECT mp.player_id,m.completed_at,CASE WHEN mp.team='a' AND m.team_a_score>m.team_b_score THEN true WHEN mp.team='b' AND m.team_b_score>m.team_a_score THEN true ELSE false END AS won,ROW_NUMBER() OVER(PARTITION BY mp.player_id ORDER BY m.completed_at)-ROW_NUMBER() OVER(PARTITION BY mp.player_id,CASE WHEN mp.team='a' AND m.team_a_score>m.team_b_score THEN true WHEN mp.team='b' AND m.team_b_score>m.team_a_score THEN true ELSE false END ORDER BY m.completed_at) AS grp FROM matches m JOIN match_players mp ON mp.match_id=m.id WHERE m.session_id=p_session_id AND m.status='completed' AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL AND mp.player_id IN(SELECT player_id FROM _wrapped_stats)),
  wg AS (SELECT player_id,grp,COUNT(*)::int AS cnt FROM sc WHERE won GROUP BY player_id,grp),
  last_grp AS (SELECT DISTINCT ON(player_id) player_id,grp,won FROM sc ORDER BY player_id,completed_at DESC)
  SELECT lg.player_id,CASE WHEN lg.won THEN COALESCE(wg.cnt,0) ELSE 0 END AS ended_on_win_streak FROM last_grp lg LEFT JOIN wg ON wg.player_id=lg.player_id AND wg.grp=lg.grp;
  FOR v_player IN SELECT ws.*,csc.cs_player_id,csc.cs_nemesis_alltime_id,csc.cs_my_wins_vs_alltime_nemesis,csc.cs_alltime_nemesis_wins_vs_me,csc.cs_alltime_nemesis_sessions,csc.cs_nemesis_net_deficit,csc.cs_beat_nemesis_tonight,csc.cs_settled_rival_id,csc.cs_score_old_deficit,csc.cs_dynasty_victim_id,csc.cs_dynasty_wins,csc.cs_dynasty_losses,csc.cs_dynasty_sessions,csc.cs_max_sessions_faced,csc.cs_sn_my_alltime_wins,csc.cs_sn_alltime_losses,csc.cs_sn_alltime_sessions,csc.cs_sk_my_alltime_wins,csc.cs_sk_alltime_losses,csc.cs_sk_alltime_sessions,csc.cs_redeemed_rival_id,csc.cs_top_alltime_partner_id,csc.cs_alltime_games_together,csc.cs_alltime_wins_together,csc.cs_alltime_sessions_together,csc.cs_alltime_partner_win_rate,csc.cs_prior_dominant_sessions,csc.cs_prior_last_win_pct,csc.cs_prior_win_streak,csc.cs_prior_session_win_pct FROM _wrapped_stats ws LEFT JOIN _cross_session_stats csc ON csc.cs_player_id=ws.player_id LOOP
    v_awards:=ARRAY[]::text[]; v_award_data:='{}'::jsonb; v_milestone_holder:=NULL;
    IF v_player.wins=v_player.games_played AND v_player.games_played>=3 THEN v_awards:=array_append(v_awards,'undefeated_champion'::text); v_award_data:=v_award_data||jsonb_build_object('undefeated_champion',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.win_pct>=80 AND v_player.games_played>=5 AND v_player.wins<v_player.games_played THEN v_awards:=array_append(v_awards,'dominant_night'::text); v_award_data:=v_award_data||jsonb_build_object('dominant_night',jsonb_build_object('win_pct',v_player.win_pct,'wins',v_player.wins)); END IF;
    IF v_player.win_pct>=60 AND v_player.win_pct<80 AND v_player.games_played>=3 THEN v_awards:=array_append(v_awards,'solid_outing'::text); v_award_data:=v_award_data||jsonb_build_object('solid_outing',jsonb_build_object('win_pct',v_player.win_pct)); END IF;
    IF v_player.wins=v_player.losses AND v_player.games_played>=4 THEN v_awards:=array_append(v_awards,'glass_half_full'::text); v_award_data:=v_award_data||jsonb_build_object('glass_half_full',jsonb_build_object('wins',v_player.wins,'losses',v_player.losses)); END IF;
    IF v_player.session_rank=1 AND v_player.games_played>=3 AND v_session_player_count>=3 THEN v_awards:=array_append(v_awards,'session_mvp'::text); v_award_data:=v_award_data||jsonb_build_object('session_mvp',jsonb_build_object('wins',v_player.wins,'win_pct',v_player.win_pct)); END IF;
    IF v_player.lost_first_two AND v_player.wins_after_first_two>=2 THEN v_awards:=array_append(v_awards,'comeback_kid'::text); v_award_data:=v_award_data||jsonb_build_object('comeback_kid',jsonb_build_object('comeback_wins',v_player.wins_after_first_two,'total_games',v_player.games_played)); END IF;
    IF v_player.won_last AND v_player.games_played>=3 THEN v_awards:=array_append(v_awards,'the_closer'::text); v_award_data:=v_award_data||jsonb_build_object('the_closer',jsonb_build_object('games',v_player.games_played)); END IF;
    IF NOT v_player.won_first AND NOT v_player.won_last AND v_player.games_played>=3 THEN v_awards:=array_append(v_awards,'ice_cold'::text); v_award_data:=v_award_data||jsonb_build_object('ice_cold',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.distinct_win_streaks_2plus>=2 THEN v_awards:=array_append(v_awards,'back_to_back'::text); v_award_data:=v_award_data||jsonb_build_object('back_to_back',jsonb_build_object('streaks',v_player.distinct_win_streaks_2plus)); END IF;
    IF v_player.cs_prior_win_streak>=3 AND v_player.won_first AND v_player.games_played>=2 THEN v_awards:=array_append(v_awards,'momentum'::text); v_award_data:=v_award_data||jsonb_build_object('momentum',jsonb_build_object('prior_streak',v_player.cs_prior_win_streak,'games',v_player.games_played)); END IF;
    IF v_player.win_pct>=70 AND v_player.cs_prior_dominant_sessions>=1 AND v_player.games_played>=3 THEN v_awards:=array_append(v_awards,'consistent_dominator'::text); v_award_data:=v_award_data||jsonb_build_object('consistent_dominator',jsonb_build_object('win_pct',v_player.win_pct,'dominant_sessions',v_player.cs_prior_dominant_sessions+1)); END IF;
    IF v_player.cs_prior_last_win_pct IS NOT NULL AND v_player.cs_prior_last_win_pct<50 AND v_player.win_pct>=50 AND v_player.games_played>=3 THEN v_awards:=array_append(v_awards,'bounced_back'::text); v_award_data:=v_award_data||jsonb_build_object('bounced_back',jsonb_build_object('last_win_pct',v_player.cs_prior_last_win_pct,'this_win_pct',v_player.win_pct)); END IF;
    IF v_player.points_for>=100 THEN v_awards:=array_append(v_awards,'point_machine'::text); v_award_data:=v_award_data||jsonb_build_object('point_machine',jsonb_build_object('total_points',v_player.points_for)); END IF;
    IF EXISTS(SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND((mp.team='a' AND m.team_a_score>=v_winning_score AND m.team_b_score<=1)OR(mp.team='b' AND m.team_b_score>=v_winning_score AND m.team_a_score<=1))) THEN v_awards:=array_append(v_awards,'shutout_artist'::text); v_award_data:=v_award_data||jsonb_build_object('shutout_artist',jsonb_build_object('winning_score',v_winning_score)); END IF;
    IF v_player.points_for=v_max_points AND v_player.games_played>=3 AND v_session_player_count>=4 THEN v_awards:=array_append(v_awards,'top_scorer'::text); v_award_data:=v_award_data||jsonb_build_object('top_scorer',jsonb_build_object('points',v_player.points_for)); END IF;
    IF v_player.point_diff=(SELECT MAX(point_diff) FROM _wrapped_stats) AND v_player.games_played>=3 AND v_player.point_diff>0 AND v_session_player_count>=4 THEN v_awards:=array_append(v_awards,'point_diff_king'::text); v_award_data:=v_award_data||jsonb_build_object('point_diff_king',jsonb_build_object('point_diff',v_player.point_diff)); END IF;
    IF v_player.avg_winning_margin IS NOT NULL AND v_player.avg_winning_margin>=10 AND v_player.wins>=3 THEN v_awards:=array_append(v_awards,'blowout_king'::text); v_award_data:=v_award_data||jsonb_build_object('blowout_king',jsonb_build_object('avg_margin',ROUND(v_player.avg_winning_margin,1),'wins',v_player.wins)); END IF;
    IF v_player.wins_by_8_or_more>=3 THEN v_awards:=array_append(v_awards,'heartless'::text); v_award_data:=v_award_data||jsonb_build_object('heartless',jsonb_build_object('big_wins',v_player.wins_by_8_or_more)); END IF;
    IF v_player.wins_by_5_to_7>=3 THEN v_awards:=array_append(v_awards,'sniper'::text); v_award_data:=v_award_data||jsonb_build_object('sniper',jsonb_build_object('clean_wins',v_player.wins_by_5_to_7)); END IF;
    IF v_min_pa_per_game IS NOT NULL AND v_player.games_played>=4 AND v_player.avg_pa_per_game=v_min_pa_per_game AND v_session_player_count>=4 THEN v_awards:=array_append(v_awards,'defensive_wall'::text); v_award_data:=v_award_data||jsonb_build_object('defensive_wall',jsonb_build_object('avg_pa',ROUND(v_player.avg_pa_per_game,1))); END IF;
    IF v_player.win_streak>=3 AND v_player.win_streak<5 THEN v_awards:=array_append(v_awards,'hot_streak'::text); v_award_data:=v_award_data||jsonb_build_object('hot_streak',jsonb_build_object('streak',v_player.win_streak)); END IF;
    IF v_player.win_streak>=5 AND v_player.win_streak<7 THEN v_awards:=array_remove(v_awards,'hot_streak'); v_awards:=array_append(v_awards,'on_fire'::text); v_award_data:=v_award_data-'hot_streak'||jsonb_build_object('on_fire',jsonb_build_object('streak',v_player.win_streak)); END IF;
    IF v_player.win_streak>=7 THEN v_awards:=array_remove(v_awards,'hot_streak'); v_awards:=array_remove(v_awards,'on_fire'); v_awards:=array_append(v_awards,'unstoppable'::text); v_award_data:=v_award_data-'hot_streak'-'on_fire'||jsonb_build_object('unstoppable',jsonb_build_object('streak',v_player.win_streak)); END IF;
    IF v_player.games_played>=6 AND v_player.games_played<8 THEN v_awards:=array_append(v_awards,'battle_tested'::text); v_award_data:=v_award_data||jsonb_build_object('battle_tested',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.games_played>=8 AND v_player.games_played<10 THEN v_awards:=array_remove(v_awards,'battle_tested'); v_awards:=array_append(v_awards,'marathon_night'::text); v_award_data:=v_award_data-'battle_tested'||jsonb_build_object('marathon_night',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.games_played>=10 THEN v_awards:=array_remove(v_awards,'battle_tested'); v_awards:=array_remove(v_awards,'marathon_night'); v_awards:=array_append(v_awards,'court_hermit'::text); v_award_data:=v_award_data-'battle_tested'-'marathon_night'||jsonb_build_object('court_hermit',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.games_played=v_max_games AND v_player.games_played>=5 AND v_session_player_count>=4 THEN v_awards:=array_append(v_awards,'most_active'::text); v_award_data:=v_award_data||jsonb_build_object('most_active',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.losses>=3 AND v_player.games_played>=5 AND v_player.win_pct<50 THEN v_awards:=array_append(v_awards,'grinds'::text); v_award_data:=v_award_data||jsonb_build_object('grinds',jsonb_build_object('losses',v_player.losses,'games',v_player.games_played)); END IF;
    IF v_player.losses>=5 THEN v_awards:=array_remove(v_awards,'grinds'); v_awards:=array_append(v_awards,'never_say_die'::text); v_award_data:=v_award_data-'grinds'||jsonb_build_object('never_say_die',jsonb_build_object('losses',v_player.losses)); END IF;
    IF v_player.last3_wins>=2 AND v_player.games_played>=4 THEN v_awards:=array_append(v_awards,'sunset_surge'::text); v_award_data:=v_award_data||jsonb_build_object('sunset_surge',jsonb_build_object('final_wins',v_player.last3_wins)); END IF;
    IF v_player.last3_total=3 AND v_player.last3_wins=3 AND v_player.games_played>=3 THEN v_awards:=array_remove(v_awards,'sunset_surge'); v_awards:=array_append(v_awards,'clean_sweep'::text); v_award_data:=v_award_data-'sunset_surge'||jsonb_build_object('clean_sweep',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.won_first AND v_player.games_played>=2 THEN v_awards:=array_append(v_awards,'fast_starter'::text); v_award_data:=v_award_data||jsonb_build_object('fast_starter',jsonb_build_object('first_match','win')); END IF;
    IF v_player.nemesis_id IS NOT NULL THEN v_awards:=array_append(v_awards,'my_nemesis'::text); v_award_data:=v_award_data||jsonb_build_object('my_nemesis',jsonb_build_object('nemesis_id',v_player.nemesis_id,'nemesis_name',v_player.nemesis_name,'loss_count',v_player.nemesis_loss_count,'alltime_losses_vs',v_player.cs_sn_alltime_losses,'alltime_my_wins',v_player.cs_sn_my_alltime_wins,'alltime_sessions',v_player.cs_sn_alltime_sessions)); END IF;
    IF v_player.kryptonite_victim_id IS NOT NULL THEN v_awards:=array_append(v_awards,'kryptonite'::text); v_award_data:=v_award_data||jsonb_build_object('kryptonite',jsonb_build_object('victim_id',v_player.kryptonite_victim_id,'victim_name',v_player.kryptonite_name,'win_count',v_player.kryptonite_win_count,'alltime_my_wins',v_player.cs_sk_my_alltime_wins,'alltime_losses_vs',v_player.cs_sk_alltime_losses,'alltime_sessions',v_player.cs_sk_alltime_sessions)); END IF;
    IF v_player.max_rematch_count>=3 THEN v_awards:=array_append(v_awards,'the_rematch'::text); v_award_data:=v_award_data||jsonb_build_object('the_rematch',jsonb_build_object('encounters',v_player.max_rematch_count)); END IF;
    IF v_player.redemption_count>=1 OR v_player.cs_redeemed_rival_id IS NOT NULL THEN v_awards:=array_append(v_awards,'redemption_arc'::text); v_award_data:=v_award_data||jsonb_build_object('redemption_arc',jsonb_build_object('arcs',v_player.redemption_count,'cross_session',(v_player.cs_redeemed_rival_id IS NOT NULL))); END IF;
    IF v_player.friendly_fire_overlap>=2 THEN v_awards:=array_append(v_awards,'friendly_fire'::text); v_award_data:=v_award_data||jsonb_build_object('friendly_fire',jsonb_build_object('overlap',v_player.friendly_fire_overlap)); END IF;
    IF v_player.cs_nemesis_alltime_id IS NOT NULL AND v_player.cs_beat_nemesis_tonight THEN v_awards:=array_append(v_awards,'nemesis_slayer'::text); v_award_data:=v_award_data||jsonb_build_object('nemesis_slayer',jsonb_build_object('nemesis_id',v_player.cs_nemesis_alltime_id,'alltime_deficit',v_player.cs_nemesis_net_deficit)); END IF;
    IF v_player.cs_settled_rival_id IS NOT NULL THEN v_awards:=array_append(v_awards,'settled_the_score'::text); v_award_data:=v_award_data||jsonb_build_object('settled_the_score',jsonb_build_object('rival_id',v_player.cs_settled_rival_id,'old_deficit',v_player.cs_score_old_deficit)); END IF;
    IF v_player.cs_dynasty_victim_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='the_dynasty') THEN v_awards:=array_append(v_awards,'the_dynasty'::text); v_award_data:=v_award_data||jsonb_build_object('the_dynasty',jsonb_build_object('victim_id',v_player.cs_dynasty_victim_id,'wins',v_player.cs_dynasty_wins,'sessions',v_player.cs_dynasty_sessions)); END IF;
    IF v_player.cs_max_sessions_faced>=3 AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='serial_rivals') THEN v_awards:=array_append(v_awards,'serial_rivals'::text); v_award_data:=v_award_data||jsonb_build_object('serial_rivals',jsonb_build_object('sessions_faced',v_player.cs_max_sessions_faced)); END IF;
    IF v_player.unique_partners>0 AND v_player.unique_partners=v_max_unique_partners AND v_player.games_played>=4 AND v_session_player_count>=4 THEN v_awards:=array_append(v_awards,'social_butterfly'::text); v_award_data:=v_award_data||jsonb_build_object('social_butterfly',jsonb_build_object('partners',v_player.unique_partners)); END IF;
    IF v_player.max_same_partner_count>=3 THEN v_awards:=array_append(v_awards,'loyal_partner'::text); v_award_data:=v_award_data||jsonb_build_object('loyal_partner',jsonb_build_object('partner_id',v_player.top_partner_id,'partner_name',v_player.top_partner_name,'shared_games',v_player.max_same_partner_count,'alltime_games',v_player.cs_alltime_games_together,'alltime_sessions',v_player.cs_alltime_sessions_together)); END IF;
    IF v_player.mixed_wins>=2 THEN v_awards:=array_append(v_awards,'mixed_master'::text); v_award_data:=v_award_data||jsonb_build_object('mixed_master',jsonb_build_object('mixed_wins',v_player.mixed_wins)); END IF;
    IF v_player.cs_alltime_games_together>=20 AND v_player.cs_alltime_sessions_together>=2 AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='soulmates') THEN v_awards:=array_append(v_awards,'soulmates'::text); v_award_data:=v_award_data||jsonb_build_object('soulmates',jsonb_build_object('partner_id',v_player.cs_top_alltime_partner_id,'games',v_player.cs_alltime_games_together,'sessions',v_player.cs_alltime_sessions_together)); END IF;
    IF v_player.cs_alltime_games_together>=6 AND v_player.cs_alltime_partner_win_rate>=60 AND v_player.cs_alltime_sessions_together>=2 AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='winning_formula') THEN v_awards:=array_append(v_awards,'winning_formula'::text); v_award_data:=v_award_data||jsonb_build_object('winning_formula',jsonb_build_object('partner_id',v_player.cs_top_alltime_partner_id,'win_rate',v_player.cs_alltime_partner_win_rate,'games',v_player.cs_alltime_games_together)); END IF;
    IF(SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND((mp.team='a' AND m.team_a_score>m.team_b_score AND m.team_a_score-m.team_b_score<=2)OR(mp.team='b' AND m.team_b_score>m.team_a_score AND m.team_b_score-m.team_a_score<=2)))>=3 THEN v_awards:=array_append(v_awards,'close_call_survivor'::text); v_award_data:=v_award_data||jsonb_build_object('close_call_survivor',jsonb_build_object('narrow_wins',(SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND((mp.team='a' AND m.team_a_score>m.team_b_score AND m.team_a_score-m.team_b_score<=2)OR(mp.team='b' AND m.team_b_score>m.team_a_score AND m.team_b_score-m.team_a_score<=2))))); END IF;
    IF(SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND((mp.team='a' AND m.team_a_score<m.team_b_score AND m.team_b_score-m.team_a_score<=2)OR(mp.team='b' AND m.team_b_score<m.team_a_score AND m.team_a_score-m.team_b_score<=2)))>=3 THEN v_awards:=array_append(v_awards,'heartbreaker'::text); v_award_data:=v_award_data||jsonb_build_object('heartbreaker',jsonb_build_object('narrow_losses',(SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND((mp.team='a' AND m.team_a_score<m.team_b_score AND m.team_b_score-m.team_a_score<=2)OR(mp.team='b' AND m.team_b_score<m.team_a_score AND m.team_a_score-m.team_b_score<=2))))); END IF;
    IF(SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND m.team_a_score>=30 AND m.team_b_score>=30)>=3 THEN v_awards:=array_append(v_awards,'deuce_magnet'::text); v_award_data:=v_award_data||jsonb_build_object('deuce_magnet',jsonb_build_object('deuce_games',(SELECT COUNT(*) FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND m.team_a_score>=30 AND m.team_b_score>=30))); END IF;
    IF v_player.wins=0 THEN v_awards:=array_append(v_awards,'participation_trophy'::text); v_award_data:=v_award_data||jsonb_build_object('participation_trophy',jsonb_build_object('games',v_player.games_played,'message','You showed up. That''s what matters.')); END IF;
    IF v_player.losses>=4 AND v_player.losses=(SELECT MAX(losses) FROM _wrapped_stats) AND v_session_player_count>=4 THEN v_awards:=array_append(v_awards,'the_punching_bag'::text); v_award_data:=v_award_data||jsonb_build_object('the_punching_bag',jsonb_build_object('losses',v_player.losses)); END IF;
    IF EXISTS(SELECT 1 FROM matches m JOIN match_players mp ON mp.match_id=m.id AND mp.player_id=v_player.player_id WHERE m.session_id=p_session_id AND m.status='completed' AND((mp.team='a' AND m.team_a_score=0)OR(mp.team='b' AND m.team_b_score=0))) THEN v_awards:=array_append(v_awards,'scoreboard_decorator'::text); v_award_data:=v_award_data||jsonb_build_object('scoreboard_decorator',jsonb_build_object('message','You let them have their perfect game.')); END IF;
    IF v_player.games_played=1 THEN v_awards:=array_append(v_awards,'benchwarmer'::text); v_award_data:=v_award_data||jsonb_build_object('benchwarmer',jsonb_build_object('games',v_player.games_played)); END IF;
    IF v_player.wins=0 AND v_player.games_played>=3 AND v_player.avg_loss_margin IS NOT NULL AND v_player.avg_loss_margin>=6 THEN v_awards:=array_remove(v_awards,'participation_trophy'::text); v_award_data:=v_award_data-'participation_trophy'; v_awards:=array_append(v_awards,'the_warmup_act'::text); v_award_data:=v_award_data||jsonb_build_object('the_warmup_act',jsonb_build_object('avg_margin',ROUND(v_player.avg_loss_margin,1),'games',v_player.games_played)); END IF;
    IF v_player.own_worst_enemy_id IS NOT NULL THEN v_awards:=array_append(v_awards,'own_worst_enemy'::text); v_award_data:=v_award_data||jsonb_build_object('own_worst_enemy',jsonb_build_object('opponent_id',v_player.own_worst_enemy_id,'opponent_name',v_player.own_worst_enemy_name)); END IF;
    IF v_player.is_alltime_top3 AND v_player.alltime_games>=20 AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='the_veteran') THEN v_awards:=array_append(v_awards,'the_veteran'::text); v_award_data:=v_award_data||jsonb_build_object('the_veteran',jsonb_build_object('alltime_games',v_player.alltime_games)); END IF;
    IF v_player.alltime_games>=100 THEN SELECT player_id INTO v_milestone_holder FROM club_milestones WHERE club_id=v_club_id AND milestone='first_to_100_games'; IF v_milestone_holder IS NULL AND (v_player.alltime_games-v_player.games_played)<100 THEN SELECT cr.player_id INTO v_milestone_holder FROM (SELECT cu.player_id, cu.completed_at, cu.match_id FROM (SELECT mp.player_id, m.completed_at, m.id AS match_id, ROW_NUMBER() OVER (PARTITION BY mp.player_id ORDER BY m.completed_at, m.id) AS gn FROM matches m JOIN sessions s ON s.id=m.session_id JOIN match_players mp ON mp.match_id=m.id WHERE m.status='completed' AND m.completed_at IS NOT NULL AND s.club_id=v_club_id) cu WHERE cu.gn=100) cr ORDER BY cr.completed_at ASC, cr.match_id ASC LIMIT 1; IF v_milestone_holder IS NOT NULL THEN INSERT INTO club_milestones(club_id,milestone,player_id,session_id) VALUES (v_club_id,'first_to_100_games',v_milestone_holder,CASE WHEN v_milestone_holder=v_player.player_id THEN p_session_id ELSE NULL END) ON CONFLICT (club_id,milestone) DO NOTHING; SELECT player_id INTO v_milestone_holder FROM club_milestones WHERE club_id=v_club_id AND milestone='first_to_100_games'; END IF; END IF; IF v_milestone_holder=v_player.player_id AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='first_to_100') THEN v_awards:=array_append(v_awards,'first_to_100'::text); v_award_data:=v_award_data||jsonb_build_object('first_to_100',jsonb_build_object('alltime_games',v_player.alltime_games)); END IF; END IF; IF v_player.alltime_games>=100 AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id AND pa.slug='century_club') THEN v_awards:=array_append(v_awards,'century_club'::text); v_award_data:=v_award_data||jsonb_build_object('century_club',jsonb_build_object('alltime_games',v_player.alltime_games)); END IF;
    IF v_player.played_last_match AND v_last_match_id IS NOT NULL THEN v_awards:=array_append(v_awards,'night_cap'::text); v_award_data:=v_award_data||jsonb_build_object('night_cap',jsonb_build_object('match_id',v_last_match_id)); END IF;
    IF v_player.played_first_match AND v_first_match_id IS NOT NULL THEN v_awards:=array_append(v_awards,'early_bird'::text); v_award_data:=v_award_data||jsonb_build_object('early_bird',jsonb_build_object('match_id',v_first_match_id)); END IF;
    IF v_player.skill_slayer_wins>=1 THEN v_awards:=array_append(v_awards,'skill_slayer'::text); v_award_data:=v_award_data||jsonb_build_object('skill_slayer',jsonb_build_object('upset_wins',v_player.skill_slayer_wins)); END IF;
    IF v_player.win_streak>=3 AND v_player.has_streak_partner THEN v_awards:=array_append(v_awards,'double_trouble'::text); v_award_data:=v_award_data||jsonb_build_object('double_trouble',jsonb_build_object('streak',v_player.win_streak)); END IF;
    IF array_length(v_awards,1) IS NULL OR array_length(v_awards,1)=0 THEN v_awards:=ARRAY['just_getting_started']; v_award_data:=jsonb_build_object('just_getting_started',jsonb_build_object('games',v_player.games_played,'message','Come back next session — your story is just beginning.')); END IF;
    INSERT INTO session_wrapped_stats(session_id,player_id,computed_at,games_played,wins,losses,points_for,points_against,win_pct,win_streak,session_rank,earned_awards,award_data,carry_forward)
    VALUES(p_session_id,v_player.player_id,now(),v_player.games_played::integer,v_player.wins::integer,v_player.losses::integer,v_player.points_for::integer,v_player.points_against::integer,v_player.win_pct,v_player.win_streak::integer,v_player.session_rank::integer,v_awards,v_award_data,
      jsonb_build_object('ended_on_win_streak',COALESCE((SELECT es.ended_on_win_streak FROM _ended_streaks es WHERE es.player_id=v_player.player_id),0),'session_win_pct',v_player.win_pct,'session_id',p_session_id))
    ON CONFLICT(session_id,player_id) DO UPDATE SET computed_at=EXCLUDED.computed_at,games_played=EXCLUDED.games_played,wins=EXCLUDED.wins,losses=EXCLUDED.losses,points_for=EXCLUDED.points_for,points_against=EXCLUDED.points_against,win_pct=EXCLUDED.win_pct,win_streak=EXCLUDED.win_streak,session_rank=EXCLUDED.session_rank,earned_awards=EXCLUDED.earned_awards,award_data=EXCLUDED.award_data,carry_forward=EXCLUDED.carry_forward;
  END LOOP;
END;
$function$;

-- Privileges are preserved across CREATE OR REPLACE; restated so a from-scratch
-- replay lands on the same grants production has. Restate the GRANTs BEFORE the
-- REVOKE: `revoke ... from public` also strips EXECUTE from service_role on a
-- database built from scratch (see docs -- revoke-strips-service-role).
grant execute on function public.compute_session_wrapped(uuid) to postgres with grant option;
grant execute on function public.compute_session_wrapped(uuid) to service_role;
revoke execute on function public.compute_session_wrapped(uuid) from public, anon, authenticated;

comment on function public.compute_session_wrapped(uuid) is
  'Computes and stores Session Wrapped stats + awards for one session. Every cross-session figure is as of the END of that session: the running ledgers are read, then everything from this session onward is subtracted back out, so a recompute of an old session (fixPlayerRecord) cannot count the player''s later matches as history. Bounded by 20260820000000.';
