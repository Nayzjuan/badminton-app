// ============================================================
// truncate.ts — Targeted Cleanup Helper (Layer B Isolation)
// ============================================================
// Provides a fast afterEach cleanup for integration tests that
// call Server Actions (which use the Supabase JS client and
// therefore can't be wrapped in a pg savepoint).
//
// HOW IT WORKS:
//   TRUNCATE ... RESTART IDENTITY CASCADE wipes domain tables in
//   dependency order (FK-safe). auth.users rows are removed via
//   the Supabase admin API (never truncate auth.users directly —
//   it breaks Supabase Auth's internal schema).
//
// USAGE:
//   import { truncateAll, serviceClient } from "../helpers/truncate";
//
//   afterEach(async () => {
//     await truncateAll();
//   });
//
//   // For creating seed data that bypasses RLS, use serviceClient():
//   const { data } = await serviceClient().from("profiles").select("*");
//
// CAUTION:
//   truncateAll() is destructive and permanent within the current
//   DB state. It is safe to use against LOCAL Supabase only.
//   It will throw if NEXT_PUBLIC_SUPABASE_URL is a production URL.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { flushAfterCallbacks } from "./after-queue";

/** Allowed local Supabase URL prefixes. */
const LOCAL_URL_PREFIXES = ["http://127.0.0.1", "http://localhost", "http://0.0.0.0"];

function assertLocalOnly(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isLocal = LOCAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
  if (!isLocal) {
    throw new Error(
      `[truncate] SAFETY GUARD: truncateAll() may only run against LOCAL Supabase.\n` +
        `  Current URL: ${url}\n` +
        `  This guard prevents accidental production data loss.\n` +
        `  Check that tests/integration/.env points to http://127.0.0.1:54321`
    );
  }
}

/**
 * Returns a Supabase service-role client backed by the local Supabase.
 * Use this for seed setup and assertions that need to bypass RLS.
 */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "[serviceClient] NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
        "Ensure tests/integration/.env is loaded."
    );
  }

  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Truncates all domain tables in FK-safe dependency order.
 * auth.users rows are removed via the Supabase admin API.
 *
 * Call this in afterEach() for tests that write via Server Actions.
 *
 * @param authUserIds - Optional list of auth.users UUIDs to delete.
 *                      If omitted, all auth.users created by tests
 *                      must be tracked and passed here, OR use the
 *                      makeProfile() factory which tracks them automatically.
 */
export async function truncateAll(authUserIds: string[] = []): Promise<void> {
  assertLocalOnly();

  const client = serviceClient();

  // ── Step 1: Delete auth.users rows via admin API ──────────
  // Must happen BEFORE truncating profiles (FK constraint).
  // NEVER directly TRUNCATE auth.users — it breaks Supabase Auth.
  for (const userId of authUserIds) {
    await client.auth.admin.deleteUser(userId);
  }

  // ── Step 2: Delete all rows from domain tables in FK-safe order ──
  // Children before parents. Each delete is a full-table wipe via a
  // condition that matches every row. We avoid TRUNCATE because it
  // requires a Postgres superuser role; service_role can only DELETE.
  //
  // The impossible-UUID filter `neq('id', ZERO_UUID)` matches every row
  // because no real row ever has a zero UUID as its primary key.
  //
  // Update this list when new tables are added to the schema.
  await truncateViaDeletes(client);
}

/** The nil UUID used as a "match everything" filter in DELETE queries. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** The founding club seeded for tests — the one club that must survive. */
const DEFAULT_CLUB_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Deletes all rows from every domain table in FK-safe order.
 * Called by truncateAll() — not for direct use.
 *
 * EVERY delete is error-checked and THROWS. This used to swallow errors, and
 * one FK-blocked delete (a test-created club whose created_by pointed at a
 * regular profile) silently aborted the profiles wipe — profiles then
 * accumulated across every later file until engine-trigger-realdb died on
 * handle_new_user unique-display_name collisions, four files away from the
 * cause. A cleanup that fails must fail THE TEST THAT LEAKED, loudly.
 */
async function truncateViaDeletes(client: ReturnType<typeof serviceClient>): Promise<void> {
  const wipe = async (
    q: PromiseLike<{ error: { message: string } | null }>,
    table: string
  ): Promise<void> => {
    const { error } = await q;
    if (error) throw new Error(`[truncate] ${table} wipe failed: ${error.message}`);
  };

  // Tables in FK dependency order: children before parents.
  // session_wrapped_stats, player_rivalries, player_partnerships
  // reference profiles → delete them first.
  await wipe(
    client.from("session_wrapped_stats").delete().neq("id", ZERO_UUID),
    "session_wrapped_stats"
  );
  await wipe(
    client.from("player_rivalries").delete().neq("player_id", ZERO_UUID),
    "player_rivalries"
  );
  await wipe(
    client.from("player_partnerships").delete().neq("player_id", ZERO_UUID),
    "player_partnerships"
  );
  await wipe(client.from("match_players").delete().neq("id", ZERO_UUID), "match_players");
  await wipe(client.from("match_games").delete().neq("id", ZERO_UUID), "match_games");
  await wipe(client.from("matches").delete().neq("id", ZERO_UUID), "matches");
  await wipe(client.from("queue_entries").delete().neq("id", ZERO_UUID), "queue_entries");
  await wipe(client.from("courts").delete().neq("id", ZERO_UUID), "courts");
  await wipe(client.from("session_organizers").delete().neq("id", ZERO_UUID), "session_organizers");
  await wipe(client.from("sessions").delete().neq("id", ZERO_UUID), "sessions");
  // Credential-guessing log for the reconnect / co-organizer rate limiters.
  // NOT cleaning it let failed attempts accumulate across every test in the
  // run, so tests that deliberately submit a wrong passcode eventually tripped
  // the 10-per-window lockout and got "Too many attempts" instead of the
  // "invalid passcode" they asserted on — a false failure whose cause is
  // several tests upstream. Wiped before profiles: user_id references them.
  await wipe(
    client.from("co_organizer_join_attempts").delete().neq("id", ZERO_UUID),
    "co_organizer_join_attempts"
  );
  // Club tables — AFTER sessions (sessions.club_id → clubs RESTRICT), BEFORE
  // profiles (clubs.created_by / club_members.player_id reference them).
  // The founding club survives (neq DEFAULT_CLUB_ID); its created_by is the
  // ZERO_UUID bootstrap profile, which the profiles wipe below also skips —
  // that pairing is what keeps the FK chain satisfiable between tests.
  await wipe(client.from("club_invites").delete().neq("id", ZERO_UUID), "club_invites");
  await wipe(client.from("club_members").delete().neq("club_id", ZERO_UUID), "club_members");
  await wipe(client.from("clubs").delete().neq("id", DEFAULT_CLUB_ID), "clubs");
  await wipe(client.from("profiles").delete().neq("id", ZERO_UUID), "profiles");
}

/**
 * Tracked auth user IDs created by the current test.
 * makeProfile() appends here; truncateTracked() cleans them all.
 *
 * This module-level accumulator is reset by resetTracking().
 */
const _trackedAuthUserIds: string[] = [];

/** Records an auth user ID for cleanup by truncateTracked(). */
export function trackAuthUser(userId: string): void {
  _trackedAuthUserIds.push(userId);
}

/**
 * Truncates all domain tables AND deletes all auth users that were
 * tracked via trackAuthUser() / makeProfile() since the last reset.
 *
 * Typical usage:
 *   afterEach(async () => {
 *     await truncateTracked();
 *   });
 */
export async function truncateTracked(): Promise<void> {
  // Drain fire-and-forget after() work first. The stub in setup.ts runs those
  // callbacks for real (several wrap runEngineForSession), and real after() work
  // outlives the action that scheduled it — so without this the engine can still
  // be inserting matches while we delete the rows they reference.
  await flushAfterCallbacks();
  const ids = [..._trackedAuthUserIds];
  _trackedAuthUserIds.length = 0; // reset before await in case of throw
  await truncateAll(ids);
}

/** Clears the tracked user list without deleting anything. */
export function resetTracking(): void {
  _trackedAuthUserIds.length = 0;
}
