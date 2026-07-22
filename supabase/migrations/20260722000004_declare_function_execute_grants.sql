-- ============================================================
-- Declare the service_role EXECUTE grants the migrations assumed
-- ============================================================
-- Fifth and last layer of the same defect as 20260722000000-3: the migrations
-- did not describe the database. Here the missing statement is a function
-- grant, and the symptom was five integration failures that all reported
-- "Too many attempts. Please wait a few minutes and try again." — a rate-limit
-- message, from a database with an empty attempt log.
--
-- WHAT ACTUALLY HAPPENED.
-- Several migrations lock a SECURITY DEFINER function down like this:
--
--     revoke execute on function public.cojoin_record_and_check(...)
--       from public, anon, authenticated;
--
-- On a function whose ACL is still NULL, Postgres materialises the default
-- ACL first — {owner=X/owner, =X/owner}, where "=X" is the grant to PUBLIC —
-- and then removes the named grantees. Nothing in that sequence ever mentions
-- service_role. On production the revoke still left service_role able to
-- execute, because production's functions were created while Supabase's
-- ALTER DEFAULT PRIVILEGES were in effect, so each one already carried an
-- explicit service_role=X entry that the revoke did not touch. A database
-- built from these migrations alone has no such default privilege, so the
-- revoke of PUBLIC is the ONLY thing standing between service_role and the
-- function — and it takes EXECUTE away with it.
--
-- Verified, prod vs. a from-scratch replay, by comparing the effective
-- executor set of every function in public. Exactly four differ, all the same
-- way — service_role can execute on prod and cannot locally:
--
--     cojoin_record_and_check     rejoin_queue
--     elevate_to_organizer        get_h2h_record
--
-- Only the first is load-bearing today, and it fails in the worst direction:
-- joinAsCoOrganizer is deliberately FAIL-CLOSED, so a permission-denied on the
-- limiter RPC is indistinguishable from a genuine lockout and every legitimate
-- co-organizer join is refused with a message about too many attempts. The
-- other three are declared here because the drift is identical and silent, not
-- because they break today: get_h2h_record is called with the request-scoped
-- (authenticated) client, and rejoin_queue has no caller left in src/.
--
-- These grants are a NO-OP against production, which already has all four.
--
-- This does NOT re-open what those revokes closed. The point of each revoke is
-- to take a browser-reachable function away from anon and authenticated;
-- service_role is server-only and never leaves the server. The assertions at
-- the bottom check both halves: service_role can execute, anon/authenticated
-- still cannot.
-- ============================================================

grant execute on function
  public.cojoin_record_and_check(uuid, text, int, int, int)
  to service_role;

grant execute on function
  public.elevate_to_organizer(uuid, text)
  to service_role;

grant execute on function
  public.rejoin_queue(uuid)
  to service_role;

grant execute on function
  public.get_h2h_record(uuid[], uuid[], uuid, uuid)
  to service_role;

-- ── Assertion 1: the invariant, not just the four ───────────
-- Every function in public is executable by service_role. Confirmed true on
-- production (0 of 56 functions deny it), which makes it a real invariant
-- rather than a convenience.
--
-- Scope note: a DO block runs exactly once, when THIS migration applies. Later
-- migrations always sort after it, so nothing here re-evaluates when the next
-- one revokes EXECUTE from public without re-granting service_role. The
-- forward-looking gate is `tests/integration/schema-parity.test.ts`, which
-- re-checks this invariant against every `supabase db reset`; this block only
-- proves the database is sound at the moment the declaration lands.
--
-- has_function_privilege is passed p.oid, never a name. The name form resolves
-- through search_path and the planner may evaluate it before any predicate
-- that was supposed to constrain the row set — the same trap that made an
-- earlier version of 20260722000003 fail on "relation public.instances does
-- not exist".
DO $$
DECLARE
  v_problem text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_problem
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'service_role cannot EXECUTE these public functions: %', v_problem;
  END IF;
END $$;

-- ── Assertion 2: the lockdowns are still locked down ────────
-- The grants above must not have widened anything. Each of these is reachable
-- over PostgREST the moment anon or authenticated regains EXECUTE:
-- elevate_to_organizer hands out session-organizer rights for a passcode,
-- cojoin_record_and_check is the rate limiter guarding that same passcode
-- space, migrate_player_identity reassigns a player's whole history (called
-- "the highest-value function in the schema" by 20260721180000), and
-- join_queue / remove_player_from_queue_organizer / publish_match /
-- publish_all_drafts are the queue- and draft-forgery surface closed by
-- 20260721180000.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.cojoin_record_and_check(uuid, text, int, int, int)',
    'public.elevate_to_organizer(uuid, text)',
    'public.migrate_player_identity(uuid, uuid)',
    'public.join_queue(uuid, uuid)',
    'public.remove_player_from_queue_organizer(uuid, uuid)',
    'public.publish_match(uuid, uuid, uuid)',
    'public.publish_all_drafts(uuid, uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon regained EXECUTE on %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated regained EXECUTE on %', v_fn;
    END IF;
  END LOOP;
END $$;
