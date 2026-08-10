-- ============================================================================
-- ROLLBACK RUNBOOK — 20260810000001_extend_draft_firewall_to_match_players.sql
-- ============================================================================
-- ⚠ NOT A MIGRATION. This file lives outside supabase/migrations/ on purpose so
--   that `supabase db push` can never pick it up. It is a hand-run runbook, to
--   be executed deliberately and only if the draft firewall on match_players /
--   match_games has to be backed out of production.
--
-- Context: the forward migration was applied to prod (usxftpexoimletqmrggb) on
-- 2026-08-10, stamped 20260810151355. It redefines ONE function body and touches
-- no policies, so restoring that body is a complete revert.
--
--   pre-apply  md5(pg_get_functiondef) = 7bf351bbbb050f7571395ff9283b539a
--   post-apply md5(pg_get_functiondef) = 846db4a625746a778e9c4c38690bbc6e
--
-- Safe to run while the app is live. CREATE OR REPLACE preserves the existing
-- ACL (PUBLIC, postgres, anon, authenticated, service_role), so no GRANT here.
--
-- ⚠ Reverting re-opens audit finding #11: club members regain read access to the
--   full named roster of unpublished draft matches. Only do this if the firewall
--   is actively breaking something worse.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- THE SANCTIONED REVERT — copy this whole statement, do not retype the header.
-- ---------------------------------------------------------------------------
-- Every clause below is load-bearing. In particular:
--   * SECURITY DEFINER — if this lands as the default SECURITY INVOKER, the
--     helper's own `SELECT ... FROM matches` becomes subject to matches_select
--     AND the RESTRICTIVE matches_select_draft_firewall. For a member the row
--     disappears, the function returns NULL, and RLS denies => total roster
--     blackout, delivered as a 0-row success. That is a WORSE outage than the
--     DROP CASCADE this file warns about below.
--   * SET search_path — without it the function resolves `matches` and
--     `session_access_level` against the caller's search_path.
--   * STABLE — the planner may otherwise re-evaluate it per row.

CREATE OR REPLACE FUNCTION public.has_match_access(p_match_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.session_access_level(m.session_id) IS NOT NULL
  FROM matches m
  WHERE m.id = p_match_id;
$function$;

-- Verify the revert landed:
--   SELECT md5(pg_get_functiondef('public.has_match_access(uuid)'::regprocedure));
--   -- expect 7bf351bbbb050f7571395ff9283b539a


-- ============================================================================
-- ⛔ NEVER ROLL BACK WITH `DROP FUNCTION`.
-- ============================================================================
-- A plain DROP fails with 2BP01 (two policies depend on it). DROP ... CASCADE
-- SUCCEEDS and takes match_players_select + match_games_select with it, leaving
-- both tables RLS-enabled with NO SELECT policy at all. The remaining policies
-- are INSERT/UPDATE/DELETE only, so every browser roster read returns
-- zero rows -- as a SUCCESS, not an error. use-enriched-matches.ts:129-134 only
-- holds stale state on an error, so a 0-row success renders empty rosters with a
-- clean console: the same silent-blackout signature as the 07/25 de-authed-client
-- incident. The CREATE OR REPLACE above is the ONLY sanctioned rollback.
--
-- If someone has already run DROP ... CASCADE, recover by re-running the
-- CREATE OR REPLACE above and then re-creating BOTH policies. Do NOT copy them
-- from 20260722000002_declare_rls_baseline.sql -- that file does not define them
-- (it creates only the INSERT/UPDATE/DELETE ones; it names these two solely in
-- its closing assertion list). Their CREATE POLICY statements live at
-- 20260701000008_club_scoped_rls.sql:139 and :156, but those carry the
-- PRE-CONSOLIDATION qual and would silently restore the OLD access rule.
--
-- Use these instead -- transcribed from the live prod catalog on 2026-08-10,
-- pre-apply. Note the roles differ between the two; that asymmetry is real.

--   CREATE POLICY match_players_select ON public.match_players
--     AS PERMISSIVE FOR SELECT TO authenticated
--     USING (has_match_access(match_id));
--
--   CREATE POLICY match_games_select ON public.match_games
--     AS PERMISSIVE FOR SELECT TO public
--     USING (has_match_access(match_id));
--
-- AND re-grant. This step is ONLY needed on the DROP-CASCADE recovery path: the
-- normal revert above is a true CREATE OR REPLACE and preserves the existing ACL,
-- but after a DROP the function is gone, so that same statement runs as a plain
-- CREATE and lands with proacl = NULL. Nothing breaks immediately (NULL means
-- default PUBLIC EXECUTE), but the explicit grantees are then absent, and a later
-- `REVOKE EXECUTE ... FROM PUBLIC` would silently strip service_role along with
-- everyone else -- the failure mode already banked in this project as
-- "revoke strips service_role" (fails closed, and the symptom is misleading).
--
--   GRANT EXECUTE ON FUNCTION public.has_match_access(uuid)
--     TO anon, authenticated, service_role;

-- Confirm recovery -- expect exactly 2 rows, one permissive SELECT per table:
--   SELECT tablename, policyname, permissive, cmd,
--          array_to_string(roles, ',') AS roles, qual
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('match_players','match_games')
--      AND cmd = 'SELECT';
