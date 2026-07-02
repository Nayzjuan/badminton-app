-- ============================================================
-- Multi-Tenant Phase 3 — club-scope get_h2h_record
-- ============================================================
-- get_h2h_record computes head-to-head win counts for a specific 2v2
-- team pairing (used by the in-session H2H strip). Its `team_comps` CTE
-- read ALL completed matches/match_players with NO club filter — since
-- matches/match_players carry no club_id of their own (only sessions
-- does), a 2+-club deployment would blend a team pairing's all-time H2H
-- record across every club where those 4 player_ids had ever played
-- together, not just the calling club.
--
-- Fix: add a p_club_id parameter and join sessions to scope team_comps
-- to matches whose session belongs to that club. This changes the
-- function's signature (3 params -> 4), so DROP + CREATE is required
-- (CREATE OR REPLACE cannot change a function's parameter list).
--
-- Rehearsed in a rolled-back transaction with a real test call against
-- known match data (session bcf19499-d5b8-4fba-9dcf-dd9e411621aa) before
-- being applied for real; result matched the known real match outcome
-- (team_a 1-0 alltime, 1-0 session — team_a won 31-18).
--
-- App code updated to match: src/types/database.ts (get_h2h_record Args
-- gains p_club_id), src/app/actions/h2h.ts (resolves sessions.club_id
-- and passes it through). src/hooks/use-h2h.ts needs no change — it
-- calls the server action, not the RPC directly.
--
-- Body below is the exact live prod definition post-fix (pulled via
-- pg_get_functiondef after applying), unchanged apart from the new
-- p_club_id param + club-scoping join/predicate.
-- ============================================================

DROP FUNCTION public.get_h2h_record(uuid[], uuid[], uuid);

CREATE OR REPLACE FUNCTION public.get_h2h_record(p_team_a uuid[], p_team_b uuid[], p_session_id uuid, p_club_id uuid)
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
    JOIN sessions s ON s.id = m.session_id
    WHERE m.status = 'completed' AND s.club_id = p_club_id
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

-- DROP FUNCTION drops the old grants along with the old signature, and a
-- bare CREATE FUNCTION grants EXECUTE to PUBLIC by default. Re-apply the
-- same lockdown that 20260426200000_h2h_security_and_degenerate_guard.sql
-- originally put on the 3-arg overload, on the new 4-arg signature —
-- otherwise this RPC is callable by anon, bypassing the session-membership
-- auth gate that src/app/actions/h2h.ts enforces.
REVOKE EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_h2h_record(uuid[], uuid[], uuid, uuid) TO authenticated;
