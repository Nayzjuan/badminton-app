-- ============================================================
-- PR2, part 2 of 2 — REVOKES. Apply AFTER the code deploy.
-- ============================================================
-- TENANCY_AUDIT_2026-07-21.md finding #6, plus the materialized-view note in
-- its §3. A plain curl carrying the PUBLIC anon key — which ships inside the JS
-- bundle, so "possession of the key" is not a control — returns every member's
-- display_name, club_id and full stats.
--
-- ⚠ ORDERING. This file must be hand-applied only once the deployed commit
-- reads these objects through createServiceClient(). Applying it against a
-- deployment whose leaderboard.ts still uses the authenticated client
-- reproduces the 2026-07-02 outage verbatim — see
-- 20260702000007_regrant_leaderboard_history_views_stopgap.sql, which had to
-- re-open exactly these grants hours after they were first closed. The additive
-- half (20260722010000) can and should go out before the deploy; this half goes
-- after. Migrations here are applied BY HAND — there is no deploy automation.
--
-- ── WHAT IS ACTUALLY OPEN, VERIFIED ON PRODUCTION ─────────
-- Queried directly against project usxftpexoimletqmrggb on 2026-07-22:
--
--   v_alltime_leaderboard_mat   anon SELECT = TRUE   ← the live dump
--     relacl {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--             authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--   v_match_history             anon SELECT = FALSE  (already closed on prod)
--   v_session_leaderboard       anon SELECT = FALSE  (already closed on prod)
--
--   get_alltime_snapshot_before(timestamptz, uuid)  anon EXECUTE = TRUE
--   get_player_streaks(uuid, uuid)                  anon EXECUTE = TRUE
--   get_session_leaderboard_public(uuid)            anon EXECUTE = TRUE
--   _player_name(uuid)                              anon EXECUTE = TRUE
--   …all four proacl {=X/postgres, postgres=X/postgres, anon=X/postgres,
--                     authenticated=X/postgres, service_role=X/postgres}
--
-- The two VIEWS are open only on a FROM-SCRATCH REPLAY, not on production:
-- prod carries a hand-applied migration (stamp 20260702152731,
-- "revoke_leaderboard_history_view_grants_post_cutover") that has no
-- counterpart in this repo, so `supabase db reset` still ends with
-- 20260702000007's stopgap grants in force. Revoking them here is therefore two
-- things at once: a no-op on production, and the repo-side reversal that
-- 20260702000007's own header asked for ("Disposition on multi-tenant deploy:
-- REVERT", naming the history.ts / wrapped.ts service-client changes it was
-- waiting on — both landed long ago). src/app/actions/history.ts:69 and
-- src/app/actions/wrapped.ts:128 already assert in comments that no
-- anon/authenticated grant exists on v_match_history; until this migration that
-- assertion was false in CI and locally.
--
-- ── THE REVOKE TRAP (read this before adding another revoke) ─
-- On a function whose proacl is still NULL, Postgres materialises
-- acldefault('f', owner) = {owner=X/owner, =X/owner} BEFORE removing the named
-- grantees. "=X" is the grant to PUBLIC. Nothing in that sequence ever mentions
-- service_role, so on a database that never received Supabase's ALTER DEFAULT
-- PRIVILEGES — i.e. any from-scratch replay, i.e. CI — `revoke execute ... from
-- public` is the ONLY thing standing between service_role and the function, and
-- it takes EXECUTE away with it. On the local replay
-- get_alltime_snapshot_before and get_player_streaks both have proacl IS NULL
-- right now. Every revoke below is therefore PRECEDED by an explicit
-- `grant ... to service_role`, and re-asserted at the bottom. Full post-mortem:
-- 20260722000004_declare_function_execute_grants.sql.
--
-- The mirror-image trap applies to the other end: on production the named
-- anon/authenticated entries are NOT retracted by revoking PUBLIC, so every
-- revoke must spell out `from public, anon, authenticated`. See
-- 20260702000001_club_member_atomic_owner_guard_lockdown.sql:5-40.
--
-- ── RELATIONSHIP TO 20260722000003_declare_table_grants.sql ─
-- That migration DECLARES the intended end state for v_match_history and
-- v_session_leaderboard ("NO SELECT for anon/authenticated") but cannot reach
-- it: it only GRANTs, so it cannot subtract a privilege an earlier migration
-- handed out. It does still GRANT anon/authenticated on
-- v_alltime_leaderboard_mat — production's true state at that timestamp, so the
-- row is not wrong, merely superseded. This file sorts after it and is the last
-- writer, so a from-scratch replay and production converge on identical ACLs.
-- 20260722000003 is deliberately NOT edited: it is a "declare what production
-- has" migration, and rewriting one is the drift this series exists to stop.
-- The forward-looking guard is the new assertion in
-- tests/integration/schema-parity.test.ts, which re-derives the invariant from
-- the catalog on every `supabase db reset`.
--
-- ── NOT TOUCHED, ON PURPOSE ───────────────────────────────
--   get_monthly_leaderboard / get_leaderboard_months — invoker rights over the
--     base tables; RLS already scopes them correctly. See 20260722010000.
--   lookup_active_session(uuid) — keeps anon EXECUTE (audit hard constraint).
--   is_club_member / session_access_level / has_match_access /
--     is_session_organizer — grants untouched; get_session_player_streaks
--     CALLS session_access_level and depends on them staying put.
-- ============================================================


-- ============================================================
-- 1. Functions: grant service_role FIRST, then revoke.
-- ============================================================
-- Order is deliberate. After the grant, proacl names service_role explicitly;
-- the revoke then removes only PUBLIC/anon/authenticated. Doing it the other
-- way round also works inside a transaction, but grant-first is the ordering
-- that survives a partial hand-application.

grant execute on function
  public.get_alltime_snapshot_before(timestamptz, uuid) to service_role;
revoke execute on function
  public.get_alltime_snapshot_before(timestamptz, uuid) from public, anon, authenticated;

grant execute on function
  public.get_player_streaks(uuid, uuid) to service_role;
revoke execute on function
  public.get_player_streaks(uuid, uuid) from public, anon, authenticated;

grant execute on function
  public.get_session_leaderboard_public(uuid) to service_role;
revoke execute on function
  public.get_session_leaderboard_public(uuid) from public, anon, authenticated;

-- _player_name(uuid) is SECURITY DEFINER and maps ANY player UUID to a
-- display_name with no membership check — an unauthenticated UUID-to-real-name
-- oracle, and session/player UUIDs are printed into /tv links and QR codes.
-- Its only callers are nine SECURITY DEFINER functions owned by postgres
-- (create_match_with_players, create_held_cross_court_match, the swap family,
-- fix_record_swap_player, undo_swap_active_from_ondeck) — verified against
-- pg_proc.prosrc on production. They execute as the owner, so revoking the
-- browser roles cannot affect them. No src/ code calls it.
grant execute on function public._player_name(uuid) to service_role;
revoke execute on function public._player_name(uuid) from public, anon, authenticated;


-- ============================================================
-- 2. Relations: grant service_role first, then revoke.
-- ============================================================
-- Relations have no PUBLIC trap — acldefault('r', owner) grants PUBLIC nothing,
-- so materialising the default cannot hand anyone SELECT. `from public` is
-- included as a defensive no-op, and service_role is granted first anyway, both
-- to match section 1's ordering and because the project constraint is that
-- every revoke names service_role explicitly.

-- MATERIALIZED VIEW — `revoke all`, not `revoke select`. RLS is impossible on a
-- matview by definition, so the GRANT *is* the entire access control. In
-- PostgreSQL 17 the MAINTAIN privilege on a matview confers REFRESH
-- MATERIALIZED VIEW and TRUNCATE is a real destructive operation; anon and
-- authenticated hold both today (relacl "arwdDxtm"). Neither is reachable over
-- PostgREST, so this is defence in depth rather than a live hole — but there is
-- no reason for the browser roles to retain any privilege here at all.
grant  select on public.v_alltime_leaderboard_mat to service_role;
revoke all    on public.v_alltime_leaderboard_mat from public, anon, authenticated;

-- VIEWS — SELECT only. Both are non-auto-updatable (information_schema.views
-- reports is_updatable / is_insertable_into / is_trigger_updatable = NO), so
-- their INSERT/UPDATE/DELETE entries are genuinely inert, and removing exactly
-- the privilege that leaks lands the replay on production's byte-identical ACL
-- ("anon=awdDxtm/postgres" — the 'r' gone, everything else left in place).
grant  select on public.v_match_history       to service_role;
revoke select on public.v_match_history       from public, anon, authenticated;

grant  select on public.v_session_leaderboard to service_role;
revoke select on public.v_session_leaderboard from public, anon, authenticated;


-- ============================================================
-- 3. Assertions — both halves, at this timestamp.
-- ============================================================
-- A DO block runs exactly once, when THIS migration applies; it cannot catch
-- the next bad revoke. tests/integration/schema-parity.test.ts is the
-- forward-looking gate. This block proves the database is sound the moment the
-- change lands, on production and on a from-scratch replay alike.
--
-- has_function_privilege / has_table_privilege are passed an OID via
-- ::regprocedure / ::regclass, never a bare name: the name form resolves
-- through search_path and the planner may evaluate it before the predicate that
-- was meant to constrain the rows.

DO $$
DECLARE
  v_fn   text;
  v_rel  text;
  v_role text;
BEGIN
  -- 3a. Locked functions: service_role in, browser roles out.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.get_alltime_snapshot_before(timestamptz, uuid)',
    'public.get_player_streaks(uuid, uuid)',
    'public.get_session_leaderboard_public(uuid)',
    'public._player_name(uuid)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_fn::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'THE REVOKE TRAP FIRED: service_role lost EXECUTE on %. The paired grant is missing.', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn::regprocedure::oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% still holds EXECUTE on % — the anon stats dump is still open', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  -- 3b. Locked relations: service_role in, browser roles out.
  FOREACH v_rel IN ARRAY ARRAY[
    'public.v_alltime_leaderboard_mat',
    'public.v_match_history',
    'public.v_session_leaderboard'
  ] LOOP
    IF NOT has_table_privilege('service_role', v_rel::regclass::oid, 'SELECT') THEN
      RAISE EXCEPTION 'service_role lost SELECT on % — every leaderboard/history server action would 42501', v_rel;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_rel::regclass::oid, 'SELECT') THEN
        RAISE EXCEPTION '% still holds SELECT on % — owner-rights relation, so this is a full unfiltered dump', v_role, v_rel;
      END IF;
    END LOOP;
  END LOOP;

  -- 3c. The browser's replacement must have survived (20260722010000).
  IF NOT has_function_privilege('authenticated',
        'public.get_session_player_streaks(uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'authenticated cannot EXECUTE get_session_player_streaks — apply 20260722010000 first, or every win-streak flame reads 0';
  END IF;

  -- 3d. Hard constraints from the audit that must survive this migration.
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


NOTIFY pgrst, 'reload schema';


-- ============================================================
-- ROLLBACK (paste-ready — restores PRODUCTION's pre-PR2 access)
-- ============================================================
-- Only needed if the deployed commit turns out to still read these with the
-- authenticated client, which is what forced the 2026-07-02 stopgap. It
-- restores app-REACHABLE access, not a byte-identical ACL: the prior entries
-- were "anon=arwdDxtm/postgres" on the matview and a PUBLIC "=X/postgres" on
-- the functions, and this grants SELECT / EXECUTE back to the roles that
-- actually use them.
--
-- ⚠ v_match_history and v_session_leaderboard are DELIBERATELY ABSENT. anon
-- SELECT on those two is already FALSE on production (verified above); pasting
-- a "restore" for them would OPEN a hole production does not have — and they
-- are the widest objects in this file, carrying per-match teammate AND opponent
-- display-name arrays for every club. If a from-scratch replay ever needs them
-- back, add them by hand and remove them again the same day.
--
-- grant execute on function public.get_alltime_snapshot_before(timestamptz, uuid)
--   to public, anon, authenticated;
-- grant execute on function public.get_player_streaks(uuid, uuid)
--   to public, anon, authenticated;
-- grant execute on function public.get_session_leaderboard_public(uuid)
--   to public, anon, authenticated;
-- grant execute on function public._player_name(uuid)
--   to public, anon, authenticated;
-- grant select on public.v_alltime_leaderboard_mat to anon, authenticated;
-- NOTIFY pgrst, 'reload schema';
--
-- (get_session_player_streaks from 20260722010000 can stay — it is additive and
-- harms nothing.)
