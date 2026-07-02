-- ============================================================
-- 2026-07-02 EMERGENCY STOPGAP — persisted for tracking (already applied to
-- prod via SQL during a live session).
-- ------------------------------------------------------------
-- 20260702000003_harden_security_definer_views revoked SELECT on these two
-- SECURITY DEFINER views (security_invoker = false) from anon/authenticated.
-- That is correct for the multi-tenant code, which reads them via the SERVICE
-- client. BUT production still serves `main`, whose getSessionLeaderboard /
-- getLeaderboard (leaderboard.ts) and getMatchHistory / getAllSessionsHistory
-- (history.ts) read them via the AUTHENTICATED client — so the revoke made the
-- per-session leaderboard and the match-history list 42501 (empty/error).
--
-- This re-grants SELECT so the deployed `main` code works again.
--
-- ⚠️ SECURITY NOTE: these are SECURITY DEFINER views — the grant BYPASSES
-- base-table RLS, so any client can read all leaderboard/match rows unfiltered.
-- Acceptable ONLY in the current single-club reality (gameplay stats/scores; no
-- PINs or passcodes are exposed by these views).
--
-- Disposition on multi-tenant deploy: REVERT. (a) run the REVOKE block below,
-- and (b) switch leaderboard.ts + history.ts to service-client reads (the
-- Wrapped page src/app/wrapped/[sessionId]/[playerId]/page.tsx already reads
-- v_match_history via createServiceClient() — mirror that). See memory
-- prod-db-code-drift-stopgaps.
-- ============================================================

GRANT SELECT ON public.v_session_leaderboard TO authenticated, anon;
GRANT SELECT ON public.v_match_history       TO authenticated, anon;

-- ── REVERSAL (run when feat/multi-tenant deploys, together with the
--    service-client code change in leaderboard.ts / history.ts) ──
-- REVOKE SELECT ON public.v_session_leaderboard FROM authenticated, anon;
-- REVOKE SELECT ON public.v_match_history       FROM authenticated, anon;
