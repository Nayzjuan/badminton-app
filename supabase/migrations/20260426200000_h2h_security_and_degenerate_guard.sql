-- Code-review fixes for get_h2h_record:
--   1. Degenerate input guard: overlapping team arrays return empty immediately
--   2. Grant tightened to authenticated only — anon grant removed
--
-- The function body is identical to 20260426100000 plus the IF guard.
-- Applied as a separate migration so git history shows intent clearly.

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
  IF p_team_a && p_team_b THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH
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
    HAVING COUNT(*) = 4
  ),
  matched AS (
    SELECT
      match_id,
      session_id,
      CASE
        WHEN team_a_players @> p_team_a AND team_a_players <@ p_team_a
         AND team_b_players @> p_team_b AND team_b_players <@ p_team_b
        THEN
          CASE WHEN team_a_score > team_b_score THEN 'a'
               WHEN team_b_score > team_a_score THEN 'b'
               ELSE 'draw' END
        ELSE
          CASE WHEN team_b_score > team_a_score THEN 'a'
               WHEN team_a_score > team_b_score THEN 'b'
               ELSE 'draw' END
      END AS winner
    FROM team_comps
    WHERE
      (team_a_players @> p_team_a AND team_a_players <@ p_team_a AND
       team_b_players @> p_team_b AND team_b_players <@ p_team_b)
      OR
      (team_b_players @> p_team_a AND team_b_players <@ p_team_a AND
       team_a_players @> p_team_b AND team_a_players <@ p_team_b)
  )
  SELECT
    COUNT(*) FILTER (WHERE winner = 'a')::int                               AS alltime_a,
    COUNT(*) FILTER (WHERE winner = 'b')::int                               AS alltime_b,
    COUNT(*) FILTER (WHERE winner = 'a' AND session_id = p_session_id)::int AS session_a,
    COUNT(*) FILTER (WHERE winner = 'b' AND session_id = p_session_id)::int AS session_b
  FROM matched;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid) TO authenticated;
