-- ============================================================
-- Close unauthenticated match forgery: revoke EXECUTE on every
-- mutating SECURITY DEFINER RPC from the browser roles.
-- ============================================================
-- TENANCY_AUDIT_2026-07-21.md #10, and the RPC half of the item the audit
-- filed for PR5. This is not defence in depth. It is a LIVE, UNAUTHENTICATED
-- WRITE HOLE on production, verified by request on 2026-07-23.
--
-- ── THE PROOF ─────────────────────────────────────────────
-- A plain curl carrying only NEXT_PUBLIC_SUPABASE_ANON_KEY — which ships inside
-- the JS bundle, so possession of it is not a control — against project
-- usxftpexoimletqmrggb:
--
--   POST /rest/v1/rpc/swap_player_in_active_match
--     {"p_match_id":"000…0", …}
--   → 400 {"code":"P0001","message":"MATCH_NOT_ACTIVE"}
--
-- P0001/MATCH_NOT_ACTIVE is the function's OWN exception, raised from inside the
-- body. Reaching it means the EXECUTE check already passed. The control, using
-- the identical request shape against a function that carries a real revoke:
--
--   POST /rest/v1/rpc/reorder_on_deck_matches
--   → 401 {"code":"42501","message":"permission denied for function …"}
--
-- All-zero UUIDs were used deliberately so the probe could not mutate a row.
--
-- ── WHY THESE WERE OPEN ───────────────────────────────────
-- Every one of them was created by a migration that granted service_role and
-- stopped there:
--
--     grant execute on function public.swap_player_in_active_match(...) to service_role;
--
-- with no matching revoke. That reads as a lockdown and is the opposite of one.
-- Supabase's ALTER DEFAULT PRIVILEGES are in effect at CREATE FUNCTION time, so
-- each function is born carrying explicit anon=X and authenticated=X entries.
-- Granting service_role adds a fourth entry; it removes nothing. The function is
-- SECURITY DEFINER, owned by postgres, so anon calling it runs the body with
-- superuser rights and RLS is not in the picture at all.
--
-- This is the mirror image of the trap documented in
-- 20260722000004_declare_function_execute_grants.sql. That one bites a
-- from-scratch replay (revoking PUBLIC strips service_role, because no default
-- privilege ever named it). This one bites PRODUCTION (revoking PUBLIC leaves
-- anon and authenticated, because the default privilege named them directly).
-- Both are handled the same way and it is not optional: grant service_role
-- explicitly, and spell out `from public, anon, authenticated` on every revoke.
--
-- ── WHAT AN ATTACKER COULD DO BEFORE THIS MIGRATION ───────
-- With no account, from any network:
--   * rewrite the roster of any in-progress match       (swap_player_in_active_match,
--                                                        swap_teams_in_active_match,
--                                                        swap_active_from_ondeck,
--                                                        swap_match_players,
--                                                        swap_player_in_match)
--   * create matches in any club's session              (create_match_with_players,
--                                                        create_held_cross_court_match)
--   * destroy an organizer's unpublished drafts         (clear_all_unpublished_drafts,
--                                                        clear_on_deck_match_atomic)
--   * reopen a completed match                          (revert_match_to_active)
--   * forge or flood the provenance audit trail         (record_match_event)
--   * rewrite a player's match history                  (fix_record_swap_player)
--   * recompute or poison published stats               (compute_session_wrapped,
--                                                        refresh_cross_session_stats,
--                                                        refresh_alltime_leaderboard)
--
-- ── WHY REVOKING IS SAFE: EVERY CALLER IS service_role ────
-- All 27 call sites of these 16 functions were resolved to the client that
-- issues them, by brace-scoped analysis of src/ plus direct reading of the five
-- the analyser could not prove:
--
--   * closeSession declares `let supabase: ReturnType<typeof createServiceClient>`
--     and assigns on a later line, so the const-matcher missed it
--     (src/app/actions/sessions.ts:749-765).
--   * executeMatch / executeHeldMatch take an injected `DbClient`, but their only
--     callers are src/app/actions/matchmaking.ts:558 and :578, both inside
--     runEngineInternal(supabase: ReturnType<typeof createServiceClient>, …).
--
-- Not one runs on the request-scoped (authenticated) client. The independent
-- confirmation is reorder_on_deck_matches: it has carried this exact revoke
-- since 20260717172535, and draft reordering works in production today — so its
-- call site in match-drafts.ts is necessarily service_role, and the sites around
-- it are built the same way.
--
-- ── ORDERING ──────────────────────────────────────────────
-- APPLY THIS FIRST, THEN 20260723000001, THEN MERGE/DEPLOY. All three steps, in
-- that order, before the browser sees the new code.
--
-- Taken in isolation this file is deploy-order-free — service_role access is
-- unchanged and no browser code calls any of the 16 — but do not act on that in
-- isolation, because it is transitively false: 20260723000001 MUST precede the
-- deploy (the new client sends p_session_id, which the pre-migration 7-arg
-- function answers with PGRST202, breaking every team flip), and this file must
-- precede 20260723000001. So this file must precede the deploy too.
--
-- Why before 20260723000001: that file DROPs and re-CREATEs
-- swap_teams_in_active_match with an extra parameter, and this file must be able
-- to name that function. It is addressed by oid below rather than by an argument
-- list, as defence in depth — but the backwards order does not actually get that
-- far, because 20260723000001's own assertion 5a sweeps every volatile SECDEF
-- function for anon EXECUTE and aborts if this file has not run. Backwards means
-- "20260723000001 rolls back", not "silent damage". Go in order anyway.
--
-- Unlike 20260722010001 this file has no "apply after the deploy" half — the
-- moment it lands the hole is shut. Apply it NOW.
--
-- ── SCOPE ─────────────────────────────────────────────────
-- Exactly the 16 volatile (provolatile='v') SECURITY DEFINER functions in public
-- that anon could execute, minus trigger functions. Deliberately untouched:
--
--   * handle_new_user / handle_new_session — SECURITY DEFINER and anon-granted,
--     but `RETURNS trigger`. Postgres refuses to invoke a trigger function
--     directly ("trigger functions can only be called as triggers"), so the
--     grant is inert and unreachable over PostgREST. Firing a trigger does not
--     re-check EXECUTE, so revoking would be harmless — but handle_new_user sits
--     on auth.users and a mistake there breaks every signup, and the grant leaks
--     nothing today. Not worth the blast radius in the same change as a live fix.
--   * The STABLE helpers — is_club_member, session_access_level,
--     has_match_access, is_session_organizer, is_match_club_member,
--     is_session_club_member. RLS policies invoke these AS THE CALLING ROLE;
--     revoking would make every policy that calls one deny, taking the whole app
--     down. Hard constraint, re-asserted at the bottom.
--   * lookup_active_session(uuid) — keeps anon EXECUTE. Audit hard constraint:
--     the logged-out join flow needs it.
--
-- No pg_cron extension is installed, no RLS policy references any of these, and
-- no trigger is bound to one — all three checked against production, so nothing
-- inside the database calls them as a browser role either. Calls made from
-- WITHIN another SECURITY DEFINER function (record_match_event and _player_name
-- are PERFORMed by the swap family) execute as that function's owner, not the
-- original caller, so those are unaffected.
-- ============================================================


-- ============================================================
-- 1. grant service_role FIRST, then revoke.
-- ============================================================
-- Grant-first is the ordering that survives a partial hand-application, and it
-- is what stops the from-scratch-replay trap: after the grant, proacl names
-- service_role explicitly, so the revoke removes only PUBLIC/anon/authenticated.

grant  execute on function public.clear_all_unpublished_drafts(uuid) to service_role;
revoke execute on function public.clear_all_unpublished_drafts(uuid) from public, anon, authenticated;

grant  execute on function public.clear_on_deck_match_atomic(uuid, uuid) to service_role;
revoke execute on function public.clear_on_deck_match_atomic(uuid, uuid) from public, anon, authenticated;

grant  execute on function public.compute_session_wrapped(uuid) to service_role;
revoke execute on function public.compute_session_wrapped(uuid) from public, anon, authenticated;

grant  execute on function public.create_held_cross_court_match(uuid, boolean, uuid[], uuid[], uuid, uuid, match_origin, uuid, text) to service_role;
revoke execute on function public.create_held_cross_court_match(uuid, boolean, uuid[], uuid[], uuid, uuid, match_origin, uuid, text) from public, anon, authenticated;

grant  execute on function public.create_match_with_players(uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], match_origin, boolean, uuid, text) to service_role;
revoke execute on function public.create_match_with_players(uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], match_origin, boolean, uuid, text) from public, anon, authenticated;

grant  execute on function public.fix_record_swap_player(uuid, uuid, uuid, uuid, uuid, text) to service_role;
revoke execute on function public.fix_record_swap_player(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

grant  execute on function public.record_match_event(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, uuid, uuid) to service_role;
revoke execute on function public.record_match_event(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, uuid, uuid) from public, anon, authenticated;

grant  execute on function public.refresh_alltime_leaderboard() to service_role;
revoke execute on function public.refresh_alltime_leaderboard() from public, anon, authenticated;

grant  execute on function public.refresh_cross_session_stats(uuid) to service_role;
revoke execute on function public.refresh_cross_session_stats(uuid) from public, anon, authenticated;

grant  execute on function public.revert_match_to_active(uuid, uuid) to service_role;
revoke execute on function public.revert_match_to_active(uuid, uuid) from public, anon, authenticated;

-- OUT parameters are not part of a function's identity, so the two OUT columns
-- of swap_active_from_ondeck do not appear here.
grant  execute on function public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) to service_role;
revoke execute on function public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

grant  execute on function public.swap_match_players(uuid, uuid, uuid, uuid, uuid, text) to service_role;
revoke execute on function public.swap_match_players(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

grant  execute on function public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) to service_role;
revoke execute on function public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) from public, anon, authenticated;

grant  execute on function public.swap_player_in_match(uuid, uuid, uuid, uuid, text, boolean, uuid, text, boolean, uuid) to service_role;
revoke execute on function public.swap_player_in_match(uuid, uuid, uuid, uuid, text, boolean, uuid, text, boolean, uuid) from public, anon, authenticated;

-- swap_teams_in_active_match is the ONE function in this list whose signature
-- changes in the next migration: 20260723000001 DROPs the 7-arg version and
-- CREATEs an 8-arg one (it gains p_session_id). Naming an explicit argument list
-- here would make THIS file raise 42883 if an operator applied the two out of
-- order — and because the file is one transaction, that failure rolls back all
-- 16 revokes and silently leaves the unauthenticated write hole open. Address
-- every overload by oid instead, so the order genuinely does not matter.
DO $$
DECLARE
  r       record;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'swap_teams_in_active_match'
  LOOP
    EXECUTE format('grant  execute on function %s to service_role', r.sig);
    EXECUTE format('revoke execute on function %s from public, anon, authenticated', r.sig);
    v_count := v_count + 1;
  END LOOP;

  -- A zero-iteration loop would be a silent no-op, which is the one failure mode
  -- this construct could introduce that the explicit form could not.
  IF v_count = 0 THEN
    RAISE EXCEPTION 'no public.swap_teams_in_active_match found to revoke';
  END IF;
END $$;

grant  execute on function public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) to service_role;
revoke execute on function public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) from public, anon, authenticated;


-- ============================================================
-- 2. Assertions.
-- ============================================================
-- Derived from the catalog rather than from the list above, so a mutator added
-- tomorrow without a revoke fails HERE rather than in a live session. The set
-- this sweep covers was checked against production before the invariant was
-- written: the 16 functions granted above are exactly the volatile SECURITY
-- DEFINER non-trigger functions in public that anon OR authenticated could
-- execute, and anon and authenticated agreed on every one — so "zero" is
-- reachable, not aspirational.
--
-- A DO block runs once, when THIS migration applies. The forward-looking gate is
-- tests/integration/schema-parity.test.ts, which re-derives the same sweep on
-- every `supabase db reset`.
--
-- has_function_privilege is passed p.oid / ::regprocedure::oid, never a bare
-- name: the name form resolves through search_path and the planner may evaluate
-- it before the predicate meant to constrain the rows.
DO $$
DECLARE
  v_problem text;
  v_fn      text;
  v_role    text;
BEGIN
  -- 2a. No mutating SECURITY DEFINER function is browser-callable.
  SELECT string_agg(sig, ', ' ORDER BY sig) INTO v_problem
    FROM (
      SELECT p.oid::regprocedure::text AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.prorettype <> 'trigger'::regtype
         AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) s;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION
      'Browser roles can still EXECUTE these mutating SECURITY DEFINER functions: %', v_problem;
  END IF;

  -- 2b. The revoke trap did not fire: service_role kept EXECUTE everywhere.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_problem
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prorettype <> 'trigger'::regtype
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION
      'THE REVOKE TRAP FIRED: service_role lost EXECUTE on %. A paired grant is missing.', v_problem;
  END IF;

  -- 2c. Hard constraints from the audit that must survive this migration.
  IF NOT has_function_privilege('anon',
        'public.lookup_active_session(uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon lost EXECUTE on lookup_active_session — the logged-out join flow is broken';
  END IF;

  -- All six STABLE helpers named at the top, and BOTH browser roles. Checking
  -- only `authenticated` would let an accidental `revoke ... from anon` through
  -- silently, and these run in policies evaluated for logged-out visitors too
  -- (the /tv and public-session paths). The forward-looking schema-parity sweep
  -- cannot catch it either — it filters provolatile = 'v', and these are STABLE.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_club_member(uuid)',
    'public.session_access_level(uuid)',
    'public.has_match_access(uuid)',
    'public.is_session_organizer(uuid)',
    'public.is_match_club_member(uuid)',
    'public.is_session_club_member(uuid)'
  ] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT has_function_privilege(v_role, v_fn::regprocedure::oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% lost EXECUTE on % — every RLS policy that calls it now denies',
          v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
END $$;


NOTIFY pgrst, 'reload schema';


-- ============================================================
-- ROLLBACK (paste-ready)
-- ============================================================
-- ⚠ Pasting this re-opens unauthenticated match forgery on every object listed.
-- There is no scenario where the app needs it: every caller is server-side and
-- holds service_role, which this file never touches. It exists only so an
-- operator debugging an unrelated 42501 can rule this migration in or out in one
-- step, and it should be reverted the same minute.
--
-- grant execute on function public.clear_all_unpublished_drafts(uuid) to anon, authenticated;
-- grant execute on function public.clear_on_deck_match_atomic(uuid, uuid) to anon, authenticated;
-- grant execute on function public.compute_session_wrapped(uuid) to anon, authenticated;
-- grant execute on function public.create_held_cross_court_match(uuid, boolean, uuid[], uuid[], uuid, uuid, match_origin, uuid, text) to anon, authenticated;
-- grant execute on function public.create_match_with_players(uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], match_origin, boolean, uuid, text) to anon, authenticated;
-- grant execute on function public.fix_record_swap_player(uuid, uuid, uuid, uuid, uuid, text) to anon, authenticated;
-- grant execute on function public.record_match_event(uuid, uuid, text, text, text, uuid, text, jsonb, jsonb, uuid, uuid) to anon, authenticated;
-- grant execute on function public.refresh_alltime_leaderboard() to anon, authenticated;
-- grant execute on function public.refresh_cross_session_stats(uuid) to anon, authenticated;
-- grant execute on function public.revert_match_to_active(uuid, uuid) to anon, authenticated;
-- grant execute on function public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) to anon, authenticated;
-- grant execute on function public.swap_match_players(uuid, uuid, uuid, uuid, uuid, text) to anon, authenticated;
-- grant execute on function public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) to anon, authenticated;
-- grant execute on function public.swap_player_in_match(uuid, uuid, uuid, uuid, text, boolean, uuid, text, boolean, uuid) to anon, authenticated;
-- -- swap_teams_in_active_match: 7 args before 20260723000001, 8 after. Check
-- -- \df public.swap_teams_in_active_match before pasting; the wrong list is 42883.
-- grant execute on function public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid) to anon, authenticated;
-- grant execute on function public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) to anon, authenticated;
-- NOTIFY pgrst, 'reload schema';
