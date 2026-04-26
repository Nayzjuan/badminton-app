-- Head-to-Head record function for exact 2v2 team pairings.
-- Returns win counts for the given team pairing: all-time and for a specific session.
--
-- Design notes:
-- • Uses a team_comps CTE to materialise both team arrays once per match,
--   avoiding the 6x aggregate recomputation of an inline HAVING approach.
-- • Winner is derived from team_a_score / team_b_score — no winner_team column.
-- • Handles both orientations (p_team_a stored as team_a or team_b).
-- • Degenerate input guard: overlapping team inputs return empty (RETURN early).
-- • Grant: authenticated only — anon has no need to query match history.
--
-- Parameters:
--   p_team_a     uuid[]  — sorted player IDs for the "A" team (caller sorts)
--   p_team_b     uuid[]  — sorted player IDs for the "B" team
--   p_session_id uuid    — current session (for the session-scoped counter)

CREATE OR REPLACE FUNCTION public.get_h2h_record(
  p_team_a     uuid[],
  p_team_b     uuid[],
  p_session_id uuid
)
RETURNS TABLE(alltime_a integer, alltime_b integer, session_a integer, session_b integer)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  -- Guard: reject overlapping inputs (a team cannot share players with the other)
  IF p_team_a && p_team_b THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH
  -- Materialise team arrays once per match (avoids 6x aggregate recomputation)
  team_comps AS (
    SELECT
      m.id            AS match_id,
      m.session_id,
      m.team_a_score,
      m.team_b_score,
      array_agg(mp.player_id ORDER BY mp.player_id)
        FILTER (WHERE mp.team = 'a') AS team_a_players,
      array_agg(mp.player_id ORDER BY mp.player_id)
        FILTER (WHERE mp.team = 'b') AS team_b_players
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.status = 'completed'
    GROUP BY m.id, m.session_id, m.team_a_score, m.team_b_score
    HAVING COUNT(*) = 4  -- exactly 2v2
  ),

  -- Keep only matches where one team = p_team_a and the other = p_team_b.
  -- "normal"  = p_team_a stored as team_a, p_team_b stored as team_b
  -- "flipped" = p_team_a stored as team_b, p_team_b stored as team_a
  matched AS (
    SELECT
      match_id,
      session_id,
      CASE
        WHEN team_a_players @> p_team_a AND team_a_players <@ p_team_a
         AND team_b_players @> p_team_b AND team_b_players <@ p_team_b
        THEN
          -- Normal orientation: team_a_score belongs to p_team_a
          CASE WHEN team_a_score > team_b_score THEN 'a'
               WHEN team_b_score > team_a_score THEN 'b'
               ELSE 'draw' END
        ELSE
          -- Flipped orientation: team_b_score belongs to p_team_a
          CASE WHEN team_b_score > team_a_score THEN 'a'
               WHEN team_a_score > team_b_score THEN 'b'
               ELSE 'draw' END
      END AS winner  -- 'a' = p_team_a won, 'b' = p_team_b won
    FROM team_comps
    WHERE
      (
        -- Normal: p_team_a was team_a
        team_a_players @> p_team_a AND team_a_players <@ p_team_a AND
        team_b_players @> p_team_b AND team_b_players <@ p_team_b
      ) OR (
        -- Flipped: p_team_a was team_b
        team_b_players @> p_team_a AND team_b_players <@ p_team_a AND
        team_a_players @> p_team_b AND team_a_players <@ p_team_b
      )
  )

  SELECT
    COUNT(*) FILTER (WHERE winner = 'a')::int                               AS alltime_a,
    COUNT(*) FILTER (WHERE winner = 'b')::int                               AS alltime_b,
    COUNT(*) FILTER (WHERE winner = 'a' AND session_id = p_session_id)::int AS session_a,
    COUNT(*) FILTER (WHERE winner = 'b' AND session_id = p_session_id)::int AS session_b
  FROM matched;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid) TO authenticated;
