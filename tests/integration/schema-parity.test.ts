// ============================================================
// Suite G — Schema Parity (Phase 3)
// ============================================================
// Verifies that every RPC function referenced in database.ts
// actually exists in the local Supabase schema. Catches the
// "deployed migration vs. TypeScript types" drift before it
// becomes a runtime failure.
//
// How it works:
//   Queries `information_schema.routines` via the `pg` client
//   (direct Postgres connection — bypasses RLS and Supabase API
//   to access system catalogs that PostgREST doesn't expose).
//
// What "parity" means here:
//   • The function EXISTS in the public schema
//   • It is callable (ROUTINE_TYPE = 'FUNCTION' or 'PROCEDURE')
//   We do NOT verify parameter types — that's overkill and brittle
//   against minor signature evolutions.
//
// Isolation: None needed — read-only catalog queries.
// ============================================================

import { describe, it, expect } from "vitest";
import { withTx } from "./helpers/withTx";

describe("Schema Parity — Suite G", () => {
  // ── Helper ────────────────────────────────────────────────

  async function functionExists(name: string): Promise<boolean> {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.routines
          WHERE routine_schema = 'public'
            AND routine_name   = $1
        ) AS exists`,
        [name]
      );
      found = rows[0]?.exists ?? false;
    });
    return found;
  }

  // ── Core RPCs ─────────────────────────────────────────────

  it("compute_session_wrapped exists in public schema", async () => {
    expect(await functionExists("compute_session_wrapped")).toBe(true);
  });

  it("refresh_cross_session_stats exists in public schema", async () => {
    expect(await functionExists("refresh_cross_session_stats")).toBe(true);
  });

  it("refresh_alltime_leaderboard exists in public schema", async () => {
    expect(await functionExists("refresh_alltime_leaderboard")).toBe(true);
  });

  it("create_match_with_players exists in public schema", async () => {
    expect(await functionExists("create_match_with_players")).toBe(true);
  });

  it("swap_player_in_match exists in public schema", async () => {
    expect(await functionExists("swap_player_in_match")).toBe(true);
  });

  it("fix_record_swap_player exists in public schema", async () => {
    expect(await functionExists("fix_record_swap_player")).toBe(true);
  });

  // ── Live match player swap RPCs (migration 20260601000000) ──

  it("swap_player_in_active_match exists in public schema", async () => {
    expect(await functionExists("swap_player_in_active_match")).toBe(true);
  });

  it("swap_teams_in_active_match exists in public schema", async () => {
    expect(await functionExists("swap_teams_in_active_match")).toBe(true);
  });

  it("swap_active_from_ondeck exists in public schema", async () => {
    expect(await functionExists("swap_active_from_ondeck")).toBe(true);
  });

  it("undo_swap_active_from_ondeck exists in public schema", async () => {
    expect(await functionExists("undo_swap_active_from_ondeck")).toBe(true);
  });

  // ── Draft cap override RPC (migration 20260602000000) ──────

  it("clear_all_unpublished_drafts exists in public schema", async () => {
    expect(await functionExists("clear_all_unpublished_drafts")).toBe(true);
  });

  it("migrate_player_identity exists in public schema", async () => {
    expect(await functionExists("migrate_player_identity")).toBe(true);
  });

  it("elevate_to_organizer exists in public schema", async () => {
    expect(await functionExists("elevate_to_organizer")).toBe(true);
  });

  it("rejoin_queue exists in public schema", async () => {
    expect(await functionExists("rejoin_queue")).toBe(true);
  });

  // ── Key tables ────────────────────────────────────────────

  it("player_rivalries table exists", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name   = 'player_rivalries'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  it("player_partnerships table exists", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name   = 'player_partnerships'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  it("session_wrapped_stats has carry_forward column", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'session_wrapped_stats'
            AND column_name  = 'carry_forward'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  it("sessions table has max_auto_drafts_override column", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'sessions'
            AND column_name  = 'max_auto_drafts_override'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  it("sessions table has auto_publish column (NOT NULL, default false)", async () => {
    let col: { is_nullable: string; column_default: string | null } | undefined;
    await withTx(async (db) => {
      const { rows } = await db.query<{ is_nullable: string; column_default: string | null }>(
        `SELECT is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'sessions'
            AND column_name  = 'auto_publish'`
      );
      col = rows[0];
    });
    expect(col).toBeDefined();
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/false/);
  });

  it("auto_publish_match RPC exists in public schema", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'auto_publish_match'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  it("sessions.max_auto_drafts_override has CHECK constraint (1–5)", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_schema  = 'public'
            AND tc.table_name    = 'sessions'
            AND tc.constraint_type = 'CHECK'
            AND ccu.column_name  = 'max_auto_drafts_override'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  it("matches table has is_published column (draft mode)", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'matches'
            AND column_name  = 'is_published'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });

  // ── Privilege parity ──────────────────────────────────────
  // `revoke execute on function f from public, anon, authenticated` does NOT
  // leave service_role alone. On a function whose proacl is still NULL, Postgres
  // materialises the default ACL first — {owner=X/owner, =X/owner}, where "=X"
  // is the grant to PUBLIC — and only then removes the named grantees. Nothing
  // in that sequence mentions service_role, so revoking PUBLIC is the only thing
  // standing between service_role and the function, and it takes EXECUTE with
  // it. Production hides this: its functions were created under Supabase's
  // ALTER DEFAULT PRIVILEGES and already carry an explicit service_role=X.
  //
  // 20260722000004 declares the grants that were missing, but a DO block in a
  // migration only runs once, when that migration applies — it cannot catch the
  // NEXT bad revoke. This test can: it re-derives the invariant from the catalog
  // on every `supabase db reset`, so a migration added tomorrow fails here
  // rather than in a live session. The callers are fail-closed, which is the
  // worst way for it to surface — a permission error is indistinguishable from
  // a genuine lockout ("Too many attempts" against an empty attempt log).

  it("service_role can EXECUTE every callable function in public", async () => {
    let offenders: string[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ sig: string }>(
        // has_function_privilege is passed p.oid, never a name: the name form
        // resolves through search_path and the planner may evaluate it before
        // the predicate meant to constrain the rows.
        //
        // Trigger functions are excluded deliberately. They can only be invoked
        // by the trigger machinery, which runs as the table owner, so EXECUTE
        // for service_role is meaningless there — and revoking it from a
        // SECURITY DEFINER trigger function is legitimate hardening that this
        // test must not forbid. prokind is left unconstrained so a procedure or
        // aggregate added later is covered rather than silently skipped.
        `SELECT p.oid::regprocedure::text AS sig
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.prorettype <> 'trigger'::regtype
            AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
          ORDER BY 1`
      );
      offenders = rows.map((r) => r.sig);
    });
    expect(offenders).toEqual([]);
  });

  it("the privilege-granting primitives stay closed to anon and authenticated", async () => {
    // The other half of the invariant above: the grants that keep service_role
    // working must never widen the browser-reachable surface. Each of these is
    // callable over PostgREST the moment anon or authenticated regains EXECUTE.
    const locked = [
      "public.cojoin_record_and_check(uuid, text, int, int, int)",
      "public.elevate_to_organizer(uuid, text)",
      "public.migrate_player_identity(uuid, uuid)",
      "public.join_queue(uuid, uuid)",
      "public.remove_player_from_queue_organizer(uuid, uuid)",
      "public.publish_match(uuid, uuid, uuid)",
      "public.publish_all_drafts(uuid, uuid)",
      "public.rejoin_queue(uuid)",
    ];
    let leaks: string[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ sig: string; grantee: string }>(
        `SELECT sig, grantee
           FROM unnest($1::text[]) AS sig
           CROSS JOIN unnest(ARRAY['anon','authenticated']) AS grantee
          WHERE has_function_privilege(grantee, sig::regprocedure::oid, 'EXECUTE')`,
        [locked]
      );
      leaks = rows.map((r) => `${r.grantee} -> ${r.sig}`);
    });
    expect(leaks).toEqual([]);
  });

  // ── Mutating RPC surface (20260723000000 / 20260723000001) ──
  // TENANCY_AUDIT_2026-07-21.md #10. Sixteen SECURITY DEFINER functions that
  // create matches, rewrite live rosters, destroy drafts, reopen completed
  // matches and write the audit trail were EXECUTE-able by `anon` — reachable
  // over PostgREST with nothing but the public anon key, no login at all.
  // Confirmed live against production before the fix: a POST to
  // /rest/v1/rpc/swap_player_in_active_match came back 400 P0001
  // "MATCH_NOT_ACTIVE" — the function's OWN exception, i.e. the privilege check
  // had already passed — while the control (reorder_on_deck_matches, revoked
  // back in 20260717172535) answered 401 42501 "permission denied".
  //
  // They were open because Supabase's ALTER DEFAULT PRIVILEGES stamps anon and
  // authenticated EXECUTE onto every new function, and nothing had ever taken
  // it back. Every one of the 27 call sites runs on the service client, so the
  // revoke costs the app nothing.

  it("no mutating SECURITY DEFINER function is reachable from the browser", async () => {
    // A sweep, not a list: the failure mode here is a NEW function inheriting
    // the default grants, which a hardcoded list cannot see. Volatile +
    // SECURITY DEFINER + not a trigger = "writes, with the owner's rights,
    // callable over PostgREST" — that combination must never be browser-facing.
    //
    // If this fails on a function you just added, the fix is almost never to
    // add an exception. Either it is a read (mark it STABLE and it leaves this
    // set), or it is a write, in which case it belongs behind a server action
    // on the service client like the other 27 call sites. Trigger functions are
    // excluded because PostgREST refuses to call them ("trigger functions can
    // only be called as triggers") and firing a trigger does not re-check
    // EXECUTE, so their grants are inert either way.
    let offenders: string[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ sig: string; grantee: string }>(
        `SELECT p.oid::regprocedure::text AS sig, g AS grantee
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN unnest(ARRAY['anon','authenticated']) AS g
          WHERE n.nspname = 'public'
            AND p.prosecdef
            AND p.provolatile = 'v'
            AND p.prorettype <> 'trigger'::regtype
            AND has_function_privilege(g, p.oid, 'EXECUTE')
          ORDER BY 1, 2`
      );
      offenders = rows.map((r) => `${r.grantee} -> ${r.sig}`);
    });
    expect(offenders).toEqual([]);
  });

  it("the live-swap RPCs still carry their post-fix signatures", async () => {
    // 20260723000001 binds each of these to p_session_id. The sweep above would
    // stay green if one were dropped, and tests/integration/live-match-swap.ts
    // asserts behaviour rather than shape — so pin the shapes here. In
    // particular swap_teams_in_active_match GAINED a trailing p_session_id, and
    // must exist exactly ONCE: a leftover overload makes PostgREST answer
    // PGRST203 ("could not choose the best candidate function") and every team
    // flip in the app fails.
    const expected = [
      "swap_active_from_ondeck(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)",
      "swap_player_in_active_match(uuid,uuid,uuid,uuid,text,uuid,text,boolean,uuid)",
      "swap_teams_in_active_match(uuid,uuid,uuid,uuid,text,boolean,uuid,uuid)",
      "undo_swap_active_from_ondeck(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,text)",
    ];
    let actual: string[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ sig: string }>(
        `SELECT p.oid::regprocedure::text AS sig
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('swap_player_in_active_match','swap_teams_in_active_match',
                              'swap_active_from_ondeck','undo_swap_active_from_ondeck')
          ORDER BY 1`
      );
      actual = rows.map((r) => r.sig);
    });
    expect(actual).toEqual(expected);
  });

  // ── Leaderboard read surface (20260722010000 / 20260722010001) ──
  // TENANCY_AUDIT_2026-07-21.md #6: these four functions are SECURITY DEFINER
  // with every scoping parameter DEFAULTED, so `{}` over PostgREST returned
  // every player in every club to a caller holding nothing but the anon key —
  // no login, no membership, no session id. v_alltime_leaderboard_mat was the
  // same dump one layer down: a materialized view CANNOT have RLS, so its GRANT
  // *is* its access control, and anon held SELECT.
  //
  // The fix routes all four reads through the service role in
  // src/app/actions/leaderboard.ts, where getAllTimeLeaderboard/getPlayerStats
  // do the club-scoping in TypeScript that the database can no longer do for
  // them. That trade is only sound while the browser-reachable grants stay
  // revoked — hence this test rather than trust in the migration's DO block.

  it("the leaderboard read functions stay closed to anon and authenticated", async () => {
    const locked = [
      "public.get_alltime_snapshot_before(timestamptz, uuid)",
      "public.get_player_streaks(uuid, uuid)",
      "public.get_session_leaderboard_public(uuid)",
      // Not a leaderboard reader itself — the name-resolution helper the other
      // three call. Leaving it browser-callable would have kept a
      // uuid -> display-name oracle open across every club.
      "public._player_name(uuid)",
    ];
    let leaks: string[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ sig: string; grantee: string }>(
        `SELECT sig, grantee
           FROM unnest($1::text[]) AS sig
           CROSS JOIN unnest(ARRAY['anon','authenticated']) AS grantee
          WHERE has_function_privilege(grantee, sig::regprocedure::oid, 'EXECUTE')`,
        [locked]
      );
      leaks = rows.map((r) => `${r.grantee} -> ${r.sig}`);
    });
    expect(leaks).toEqual([]);
  });

  it("the leaderboard read relations stay closed to anon and authenticated", async () => {
    // v_match_history and v_session_leaderboard are owner-rights views
    // (reloptions IS NULL, i.e. no security_invoker), so they read their base
    // tables as the owner and bypass RLS entirely; v_alltime_leaderboard_mat is
    // a matview, which cannot carry RLS at all. For all three the GRANT is the
    // only thing between a caller and the whole table.
    //
    // 20260702000007 re-granted the two views as an emergency stopgap after the
    // 2026-07-02 cutover locked out live code. Production reversed that by hand
    // (20260702152731) but the repo never did, so a from-scratch replay still
    // ended with the stopgap grants in place. 20260722010001 is that reversal
    // in tracked form; this test is what keeps it reversed.
    const locked = [
      "public.v_alltime_leaderboard_mat",
      "public.v_match_history",
      "public.v_session_leaderboard",
    ];
    let leaks: string[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ rel: string; grantee: string }>(
        `SELECT rel, grantee
           FROM unnest($1::text[]) AS rel
           CROSS JOIN unnest(ARRAY['anon','authenticated']) AS grantee
          WHERE has_table_privilege(grantee, rel::regclass::oid, 'SELECT')`,
        [locked]
      );
      leaks = rows.map((r) => `${r.grantee} -> ${r.rel}`);
    });
    expect(leaks).toEqual([]);
  });

  it("get_session_player_streaks is callable by authenticated but not anon", async () => {
    // The replacement for the one call site that legitimately needs browser
    // access: src/hooks/use-enriched-matches.ts fetches win streaks on every
    // court-board refresh. Losing `authenticated` here is silent — every
    // win-streak flame reads 0 and nothing errors — so the positive half of
    // this assertion matters as much as the negative half.
    let grants: Record<string, boolean> = {};
    await withTx(async (db) => {
      const { rows } = await db.query<{ grantee: string; can: boolean }>(
        `SELECT grantee,
                has_function_privilege(
                  grantee,
                  'public.get_session_player_streaks(uuid)'::regprocedure::oid,
                  'EXECUTE') AS can
           FROM unnest(ARRAY['anon','authenticated','service_role']) AS grantee`
      );
      grants = Object.fromEntries(rows.map((r) => [r.grantee, r.can]));
    });
    expect(grants).toEqual({ anon: false, authenticated: true, service_role: true });
  });

  it("get_session_player_streaks requires p_session_id — no wildcard overload", async () => {
    // Two guarantees in one query. (a) p_session_id has no DEFAULT, so `{}` is
    // not a legal call and the cross-club form has no browser-reachable
    // spelling. (b) exactly one candidate answers to that argument name in
    // public — a second overload would make PostgREST reply PGRST203
    // "Could not choose the best candidate function" and zero every streak.
    let matches: { sig: string; defaults: number }[] = [];
    await withTx(async (db) => {
      const { rows } = await db.query<{ sig: string; defaults: number }>(
        `SELECT p.oid::regprocedure::text AS sig, p.pronargdefaults AS defaults
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'get_session_player_streaks'
          ORDER BY 1`
      );
      matches = rows;
    });
    expect(matches).toEqual([{ sig: "get_session_player_streaks(uuid)", defaults: 0 }]);
  });

  // ── Materialized view ────────────────────────────────────

  it("v_alltime_leaderboard_mat materialized view exists", async () => {
    let found = false;
    await withTx(async (db) => {
      const { rows } = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_matviews
          WHERE schemaname = 'public'
            AND matviewname = 'v_alltime_leaderboard_mat'
        ) AS exists`
      );
      found = rows[0]?.exists ?? false;
    });
    expect(found).toBe(true);
  });
});
