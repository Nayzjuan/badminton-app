#!/usr/bin/env tsx
// ============================================================
// Sandbox Cleanup Validator
// ============================================================
// Confirms the E2E sandbox session is fully clean after a test
// run or after emergency-cleanup.ts is executed.
//
// Usage:
//   npx tsx tests/helpers/validate-cleanup.mts
//
// Exits 0 (✅ clean) or 1 (❌ dirty — data still present).
// ============================================================

import "dotenv/config";
import * as dotenv from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";

dotenv.config({ path: resolve(process.cwd(), ".env.test") });
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: false });

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const sessionId = process.env.TEST_SESSION_ID ?? "";

if (!url || !key || !sessionId) {
  console.error("❌  Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or TEST_SESSION_ID");
  process.exit(1);
}

const db = createClient<Database>(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── ANSI helpers ──────────────────────────────────────────────
const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red   = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim   = (s: string) => `\x1b[2m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function run() {
  console.log(bold("\n🔍  Sandbox Cleanup Validation\n"));

  // ── Fetch session ─────────────────────────────────────────────
  const { data: session } = await db
    .from("sessions")
    .select("id, name, is_active, is_auto_matchmaking_on, ended_at")
    .eq("id", sessionId)
    .single();

  if (!session) {
    console.error(red(`❌  Session ${sessionId} not found — cannot validate.`));
    process.exit(1);
  }

  console.log(`${bold("Session")}  ${dim(session.id)}`);
  console.log(`${bold("Name")}     ${session.name}\n`);

  // ── Check all tables ──────────────────────────────────────────
  const checks = await Promise.all([
    db.from("matches").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
    db.from("queue_entries").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
    db.from("courts").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
    db.from("session_wrapped_stats").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
    // match_events must be counted by session_id, NOT via the matches above.
    // match_events.match_id is ON DELETE SET NULL, so deleting a match leaves the
    // audit row behind with a null match_id — invisible to a matches-based check.
    // That is exactly how 171 sandbox rows accumulated unnoticed between
    // 2026-07-02 and 2026-08-03 while this validator kept reporting "fully clean".
    db.from("match_events").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
    // Exclude E2E_OrganizerBot — it's the persistent bot account reused across all
    // test runs and is intentionally NOT deleted between sessions.
    db.from("profiles")
      .select("id", { count: "exact", head: true })
      .like("display_name", "E2E_%")
      .neq("display_name", "E2E_OrganizerBot"),
  ]);

  const [matches, queue, courts, wrapped, matchEvents, e2eBots] = checks.map(r => r.count ?? 0);

  // ── Session state checks ──────────────────────────────────────
  const sessionStateOk =
    session.is_active === true &&
    session.is_auto_matchmaking_on === false &&
    session.ended_at === null;

  // ── Print results ─────────────────────────────────────────────
  const row = (label: string, count: number, expected = 0) => {
    const ok = count === expected;
    const icon = ok ? green("✓") : red("✗");
    const val  = ok ? green(`${count}`) : red(`${count} — expected ${expected}`);
    return `  ${icon}  ${bold(label.padEnd(22))}${val}`;
  };

  console.log(row("Matches",         matches));
  console.log(row("Queue entries",   queue));
  console.log(row("Courts",          courts));
  console.log(row("Wrapped stats",   wrapped));
  console.log(row("Match events",    matchEvents));
  console.log(row("E2E bot profiles",e2eBots));
  console.log();

  // Session state
  const stateIcon = sessionStateOk ? green("✓") : red("✗");
  const stateVal  = sessionStateOk
    ? green("is_active=true  auto=false  ended_at=null")
    : red(`is_active=${session.is_active}  auto=${session.is_auto_matchmaking_on}  ended_at=${session.ended_at}`);
  console.log(`  ${stateIcon}  ${bold("Session state".padEnd(22))}${stateVal}`);
  console.log();

  // ── Final verdict ─────────────────────────────────────────────
  const allClear =
    matches === 0 &&
    queue   === 0 &&
    courts  === 0 &&
    wrapped === 0 &&
    matchEvents === 0 &&
    e2eBots === 0 &&
    sessionStateOk;

  if (allClear) {
    console.log(green(bold("✅  Sandbox is fully clean. Safe to start a real session.\n")));
    process.exit(0);
  } else {
    console.log(red(bold("❌  Sandbox still has data. Run the cleanup script:\n")));
    console.log(amber("       npx tsx tests/helpers/emergency-cleanup.ts --yes\n"));
    process.exit(1);
  }
}

void run().catch((err) => {
  console.error(red("❌  Validation failed:"), err);
  process.exit(1);
});
