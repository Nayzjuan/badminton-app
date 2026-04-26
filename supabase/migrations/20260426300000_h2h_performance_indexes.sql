-- Performance indexes for get_h2h_record hot query path.
-- Without these, the function does a full table scan on both matches and
-- match_players as session history accumulates.

-- Partial index — only completed matches participate in H2H queries
CREATE INDEX IF NOT EXISTS idx_matches_status_completed
  ON public.matches(id)
  WHERE status = 'completed';

-- Covering index — satisfies the match_id JOIN and team/player_id aggregation
CREATE INDEX IF NOT EXISTS idx_match_players_match_team
  ON public.match_players(match_id, team, player_id);
