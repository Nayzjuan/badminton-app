-- ============================================================================
-- Low-tier: get_h2h_record scans the club's ENTIRE completed history per call
-- (invoked per on-deck card on the court board). The head-to-head only concerns
-- matches containing all 4 of the two proposed teams' players, so pre-filter to
-- those via an indexed match_players.player_id probe before building team arrays.
--
-- Equivalence verified against ALL 716 real completed 2v2 matches (0 mismatches)
-- before promotion. Semantics unchanged: the exact set-equality + winner logic
-- in `matched` is identical; only the candidate set feeding it is narrowed.
-- CREATE OR REPLACE preserves grants; STABLE / not-SECURITY-DEFINER unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_h2h_record(p_team_a uuid[], p_team_b uuid[], p_session_id uuid, p_club_id uuid)
 RETURNS TABLE(alltime_a integer, alltime_b integer, session_a integer, session_b integer)
 LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_team_a && p_team_b THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH
  -- Only matches that contain ALL 4 target players can be an H2H between these
  -- exact teams. This probes match_players by player_id (selective) instead of
  -- scanning every completed match in the club.
  candidate_matches AS (
    SELECT mp.match_id
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    JOIN sessions s ON s.id = m.session_id
    WHERE m.status = 'completed' AND s.club_id = p_club_id
      AND mp.player_id = ANY (p_team_a || p_team_b)
    GROUP BY mp.match_id
    HAVING COUNT(*) = 4
  ),
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
    WHERE m.id IN (SELECT match_id FROM candidate_matches)
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
      (
        team_a_players @> p_team_a AND team_a_players <@ p_team_a AND
        team_b_players @> p_team_b AND team_b_players <@ p_team_b
      ) OR (
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

DROP FUNCTION IF EXISTS public.get_h2h_record_v2(uuid[], uuid[], uuid, uuid);
