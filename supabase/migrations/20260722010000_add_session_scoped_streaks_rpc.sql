-- ============================================================
-- PR2, part 1 of 2 — ADDITIVE. Safe to apply at any time.
-- ============================================================
-- Adds get_session_player_streaks(uuid): the browser-callable, session-scoped
-- half of get_player_streaks. Nothing here revokes anything, so this file can
-- (and should) be hand-applied to production BEFORE the code deploy. Its
-- companion, 20260722010001_lock_leaderboard_reads_to_service_role.sql, does
-- the revoking and must be applied AFTER the code deploy.
--
-- WHY THE SPLIT. The two halves fail in opposite directions:
--   • revokes applied before the code deploy  -> the deployed code still reads
--     those objects with the authenticated client -> 42501 on the leaderboard
--     and match-history lists. That is the 2026-07-02 outage verbatim; see
--     20260702000007_regrant_leaderboard_history_views_stopgap.sql.
--   • the new function created after the code deploy -> the browser calls an
--     RPC that does not exist yet -> PGRST202 -> every win-streak flame on the
--     player and organizer court boards silently reads 0 for the whole window.
-- Splitting the migration is what makes an ordering exist that avoids both:
--   1. apply THIS file  2. deploy the code  3. apply ...010001.
--
-- ── WHY A NEW FUNCTION AT ALL ──────────────────────────────
-- src/hooks/use-enriched-matches.ts calls get_player_streaks FROM THE BROWSER,
-- with the anon/authenticated key, on every court-board refresh; the result
-- drives the win-streak flame on every on-deck and in-progress card (consumers:
-- useSessionData -> player-dashboard.tsx, useOrganizerMatches -> useOrganizerData
-- -> organizer-dashboard.tsx). get_player_streaks is SECURITY DEFINER with BOTH
-- parameters defaulted, so `{}` returns (player_id, win_streak) for every player
-- in every club — that is the shape ...010001 has to revoke. This function is
-- the replacement for the one call site that legitimately needs browser access.
--
-- Same shape 20260702000003 used for v_session_leaderboard, and the same answer:
-- SECURITY DEFINER + a MANDATORY scoping parameter that cannot be omitted or
-- wildcarded. Two differences from get_player_streaks:
--   (a) p_session_id has no DEFAULT, so `{}` is not a legal call and the global
--       cross-club form has no browser-reachable spelling at all.
--   (b) it authorizes itself: session_access_level(p_session_id) IS NULL for
--       anyone who is neither an organizer of the session nor an active member
--       of its club, and the predicate then matches no rows. Safe even if some
--       future migration mistakenly grants it to anon.
--
-- A DISTINCT NAME, not an overload of get_player_streaks: PostgREST resolves RPC
-- overloads by the supplied argument-name set, and with both
-- get_player_streaks(uuid, uuid) (all params defaulted) and get_player_streaks(uuid)
-- present, {"p_session_id": ...} matches both candidates and PostgREST answers
-- PGRST203 "Could not choose the best candidate function".
--
-- The window body is copied verbatim from get_player_streaks so the two cannot
-- drift in how a streak is defined. In particular the bare `player_id` in the
-- first_loss CTE is intentional and is the same text that runs in production
-- today; it resolves to the CTE column, not to the RETURNS TABLE output
-- parameter of the same name.
-- ============================================================


create or replace function public.get_session_player_streaks(p_session_id uuid)
returns table (player_id uuid, win_streak integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  WITH ordered_results AS (
    SELECT
      mh.player_id,
      mh.completed_at,
      CASE
        WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
          OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
        THEN 1 ELSE 0
      END AS won,
      ROW_NUMBER() OVER (
        PARTITION BY mh.player_id
        ORDER BY mh.completed_at DESC
      ) AS rn
    FROM public.v_match_history mh
    WHERE mh.match_status = 'completed'
      AND mh.session_id = p_session_id
      -- The self-authorizing gate. STABLE and independent of the scan, so it is
      -- evaluated once. NULL = not an organizer and not an active member of the
      -- session's club (and also NULL for a session id that does not exist),
      -- which makes the predicate false and returns zero rows rather than
      -- another club's streaks.
      AND public.session_access_level(p_session_id) IS NOT NULL
  ),
  first_loss AS (
    SELECT player_id, MIN(rn) AS first_loss_rn
    FROM ordered_results
    WHERE won = 0
    GROUP BY player_id
  )
  SELECT
    o.player_id,
    COUNT(*)::int AS win_streak
  FROM ordered_results o
  LEFT JOIN first_loss fl ON fl.player_id = o.player_id
  WHERE o.won = 1
    AND o.rn < COALESCE(fl.first_loss_rn, 2147483647)
  GROUP BY o.player_id;
$$;

-- ── Grants ────────────────────────────────────────────────
-- `from public, anon, authenticated`, never `from public` alone. On a
-- from-scratch replay proacl IS NULL and PUBLIC is the only holder, so
-- `from public` would be enough there. On PRODUCTION it is not: this project's
-- Supabase bootstrap runs ALTER DEFAULT PRIVILEGES, which stamps DIRECT
-- anon/authenticated EXECUTE entries at CREATE FUNCTION time, and those named
-- grants are NOT retracted by revoking PUBLIC. Verified on prod
-- (usxftpexoimletqmrggb): every function in public carries an explicit
-- `anon=X/postgres,authenticated=X/postgres` pair. Same lesson as
-- 20260702000001_club_member_atomic_owner_guard_lockdown.sql:5-40.
--
-- anon is deliberately absent from the grant: no logged-out surface needs this.
-- The public share page /leaderboard/[sessionId] gets its streaks from the
-- getSessionLeaderboard server action, on the service client.
revoke all on function public.get_session_player_streaks(uuid)
  from public, anon, authenticated;
grant execute on function public.get_session_player_streaks(uuid)
  to authenticated, service_role;

comment on function public.get_session_player_streaks(uuid) is
  'Session-scoped win streaks for the court board. Browser-callable half of '
  'get_player_streaks, which is service-role only as of 20260722010001. '
  'Mandatory p_session_id; gates itself on session_access_level() so a caller '
  'without access to the session receives zero rows.';


-- ── Trap-proofing for the two invoker-rights monthly functions ──
-- NOT revoked, on purpose, and this migration must not be read as a step
-- towards revoking them. get_monthly_leaderboard / get_leaderboard_months are
-- prosecdef = false (invoker rights) AND read the BASE TABLES matches /
-- match_players / sessions / profiles directly — verified with
-- pg_get_functiondef, not assumed. They never touch v_match_history,
-- v_session_leaderboard or v_alltime_leaderboard_mat, so invoker rights
-- genuinely scopes them: for anon, matches_select evaluates
-- session_access_level() to NULL, match_players_select and sessions_select are
-- TO authenticated, and profiles_select is TO authenticated — every join in the
-- monthly aggregation is empty. Revoking them would DELETE that working RLS
-- scoping and replace it with hand-written TypeScript checks.
--
-- They get an explicit service_role grant only because both currently reach
-- service_role through PUBLIC, which is one careless `revoke ... from public`
-- away from a silent fail-closed outage on the server.
grant execute on function public.get_monthly_leaderboard(int, int, uuid) to service_role;
grant execute on function public.get_leaderboard_months(uuid)            to service_role;


-- ── Assertions ────────────────────────────────────────────
-- A DO block runs exactly once, when THIS migration applies; it cannot catch
-- the next bad revoke. tests/integration/schema-parity.test.ts is the
-- forward-looking gate that re-derives these invariants on every db reset.
--
-- has_function_privilege is passed an OID via ::regprocedure, never a bare
-- name: the name form resolves through search_path and the planner may evaluate
-- it before the predicate that was meant to constrain the rows.
DO $$
DECLARE
  v_fn text;
BEGIN
  IF NOT has_function_privilege('authenticated',
        'public.get_session_player_streaks(uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'authenticated cannot EXECUTE get_session_player_streaks — every win-streak flame on the court board would silently read 0';
  END IF;
  IF NOT has_function_privilege('service_role',
        'public.get_session_player_streaks(uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot EXECUTE get_session_player_streaks';
  END IF;
  IF has_function_privilege('anon',
        'public.get_session_player_streaks(uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon holds EXECUTE on get_session_player_streaks — it was never meant to';
  END IF;

  -- Hard constraints from TENANCY_AUDIT_2026-07-21.md that every migration in
  -- this series must preserve. get_session_player_streaks CALLS
  -- session_access_level, so its grant is load-bearing here specifically.
  IF NOT has_function_privilege('anon',
        'public.lookup_active_session(uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on lookup_active_session — the logged-out join flow is broken';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_club_member(uuid)',
    'public.session_access_level(uuid)',
    'public.has_match_access(uuid)',
    'public.is_session_organizer(uuid)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated lost EXECUTE on % — every RLS policy that calls it now denies', v_fn;
    END IF;
  END LOOP;
END $$;


-- PostgREST caches the schema; without this the new RPC answers PGRST202 until
-- the DDL watcher happens to fire.
NOTIFY pgrst, 'reload schema';
