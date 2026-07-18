-- ============================================================================
-- Low-tier: drop the baked ORDER BY from v_match_history.
--
-- Every consumer either GROUP BYs the view (get_session_leaderboard_public,
-- get_alltime_snapshot_before → ordering irrelevant) or adds its OWN
-- .order("completed_at", desc) (history.ts ×2, wrapped.ts). The view-level
-- ORDER BY therefore only forces a redundant sort inside every aggregate
-- consumer. Reproduce the view verbatim minus the trailing ORDER BY.
--
-- CREATE OR REPLACE VIEW preserves grants + owner; column set is unchanged.
-- ============================================================================

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
  WHERE m.status = 'completed'::match_status;
