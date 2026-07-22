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
