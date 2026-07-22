-- ============================================================
-- The limiter functions' missing service_role EXECUTE grants
-- ============================================================
-- The three migrations above lock the new limiter functions down like this:
--
--     revoke execute on function public.reconnect_record_and_check(...)
--       from public, anon, authenticated;
--
-- That is not the closed door it reads as. On a function whose ACL is still
-- NULL, Postgres materialises the default ACL first — {owner=X/owner, =X/owner},
-- where "=X" is the grant to PUBLIC — and only then removes the named grantees.
-- Nothing in that sequence ever mentions service_role. On production these
-- functions were created while Supabase's ALTER DEFAULT PRIVILEGES were in
-- effect, so each already carried an explicit service_role=X entry that the
-- revoke left alone; a database built from these migrations alone has no such
-- default, so revoking PUBLIC is the ONLY thing standing between service_role
-- and the function, and it takes EXECUTE away with it.
--
-- The functions are called exclusively from server code holding the service
-- key, so on a from-scratch database every call fails with permission denied.
-- Both callers are FAIL-CLOSED, which is the worst possible way for this to
-- surface: a permission error is indistinguishable from a genuine lockout, so
-- legitimate users are refused with a message about too many attempts against
-- an empty attempt log. That exact failure cost a full debugging session on
-- cojoin_record_and_check (see 20260722000004 on the CI-replay branch, which
-- declares the same grants for the four functions that predate these).
--
-- These grants are a NO-OP against production, which already has all three.
--
-- This does NOT re-open what the revokes closed. Their purpose is to take a
-- browser-reachable function away from anon and authenticated; service_role is
-- server-only and never leaves the server. The assertion at the bottom checks
-- both halves.
-- ============================================================

grant execute on function
  public.reconnect_record_and_check(text, text, int, int, int, int)
  to service_role;

grant execute on function
  public.auth_attempt_mark_succeeded(uuid)
  to service_role;

grant execute on function
  public.cojoin_record_and_check(uuid, text, int, int, int)
  to service_role;

-- ── Assertion: service_role in, anon/authenticated still out ──
-- has_function_privilege is passed an OID, never a bare name: the name form
-- resolves through search_path and the planner may evaluate it before the
-- predicate that was meant to constrain the rows.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.reconnect_record_and_check(text, text, int, int, int, int)',
    'public.auth_attempt_mark_succeeded(uuid)',
    'public.cojoin_record_and_check(uuid, text, int, int, int)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot EXECUTE %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon regained EXECUTE on %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated regained EXECUTE on %', v_fn;
    END IF;
  END LOOP;
END $$;
