#!/usr/bin/env tsx
// ============================================================
// Emergency Sandbox Cleanup — Full Audit Report
// ============================================================
// Wipes the E2E sandbox session and prints an exact log of
// every row deleted, so you can confirm nothing real was touched.
//
// Usage:
//   npx tsx tests/helpers/emergency-cleanup.ts
//
// Guards (same as teardown.ts):
//   - TEST_SESSION_ID must be set
//   - Session name must start with "🤖 E2E SANDBOX"
//   Will refuse to run against any other session.
// ============================================================

import "dotenv/config";
import * as dotenv from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";

dotenv.config({ path: resolve(process.cwd(), ".env.test") });
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: false });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const sessionId = process.env.TEST_SESSION_ID ?? "";

if (!url || !key || !sessionId) {
  console.error(
    "❌  Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or TEST_SESSION_ID in .env.test"
  );
  process.exit(1);
}

const db = createClient<Database>(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── ANSI helpers ──────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function run() {
  console.log(bold("\n🧹  Emergency Sandbox Cleanup\n"));
  const start = Date.now();

  // ── Safety guard ─────────────────────────────────────────────
  const { data: session } = await db
    .from("sessions")
    .select("id, name, is_active, is_auto_matchmaking_on")
    .eq("id", sessionId)
    .single();

  if (!session) {
    console.error(red(`❌  Session ${sessionId} not found.`));
    process.exit(1);
  }

  if (!session.name.startsWith("🤖 E2E SANDBOX")) {
    console.error(red(`❌  SAFETY GUARD: "${session.name}" is not a sandbox session. Refusing.`));
    process.exit(1);
  }

  console.log(`${bold("Session")}  ${dim(session.id)}`);
  console.log(`${bold("Name")}     ${session.name}`);
  console.log(
    `${bold("Active")}   ${session.is_active ? "yes" : "no"}   Auto: ${session.is_auto_matchmaking_on ? "ON" : "OFF"}`
  );
  console.log();

  // ── Pre-delete audit: gather everything to be deleted ────────

  // Courts
  const { data: courts } = await db
    .from("courts")
    .select("id, name, status")
    .eq("session_id", sessionId);

  // Matches with their players
  const { data: matches } = await db
    .from("matches")
    .select("id, status, origin, is_published, team_a_score, team_b_score")
    .eq("session_id", sessionId);

  const matchIds = (matches ?? []).map((m) => m.id);

  // match_players with profile names
  const { data: matchPlayers } =
    matchIds.length > 0
      ? await db
          .from("match_players")
          .select("match_id, team, player_id, profiles(display_name)")
          .in("match_id", matchIds)
      : { data: [] };

  // Queue entries with player names
  const { data: queueEntries } = await db
    .from("queue_entries")
    .select("id, player_id, status, games_played, profiles(display_name)")
    .eq("session_id", sessionId);

  // Wrapped stats
  const { count: wrappedCount } = await db
    .from("session_wrapped_stats")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);

  // ── Print what will be deleted ────────────────────────────────

  // Courts
  if ((courts ?? []).length === 0) {
    console.log(dim("Courts:         none"));
  } else {
    console.log(bold(`Courts (${courts!.length}):`));
    for (const c of courts!) {
      console.log(`  ${amber("▸")} ${c.name}  ${dim(`[${c.status}]  ${c.id}`)}`);
    }
  }
  console.log();

  // Matches
  if ((matches ?? []).length === 0) {
    console.log(dim("Matches:        none"));
  } else {
    console.log(bold(`Matches (${matches!.length}):`));
    const playersByMatch = new Map<string, { team: string; name: string }[]>();
    for (const mp of matchPlayers ?? []) {
      const name =
        (mp.profiles as unknown as { display_name: string } | null)?.display_name ?? mp.player_id;
      const arr = playersByMatch.get(mp.match_id) ?? [];
      arr.push({ team: mp.team, name });
      playersByMatch.set(mp.match_id, arr);
    }
    for (const m of matches!) {
      const statusLabel = m.status === "in_progress" ? red(m.status) : dim(m.status);
      const publishLabel = m.is_published ? "" : dim(" [draft]");
      const scoreLabel = m.team_a_score != null ? dim(` ${m.team_a_score}–${m.team_b_score}`) : "";
      console.log(`  ${amber("▸")} ${statusLabel}${publishLabel}${scoreLabel}  ${dim(m.id)}`);
      const players = playersByMatch.get(m.id) ?? [];
      const teamA = players
        .filter((p) => p.team === "a")
        .map((p) => p.name)
        .join(", ");
      const teamB = players
        .filter((p) => p.team === "b")
        .map((p) => p.name)
        .join(", ");
      if (teamA || teamB) {
        console.log(`     Team A: ${teamA || dim("—")}   Team B: ${teamB || dim("—")}`);
      }
    }
  }
  console.log();

  // Queue entries
  if ((queueEntries ?? []).length === 0) {
    console.log(dim("Queue entries:  none"));
  } else {
    console.log(bold(`Queue entries (${queueEntries!.length}):`));
    const byStatus = new Map<string, string[]>();
    for (const q of queueEntries!) {
      const name =
        (q.profiles as unknown as { display_name: string } | null)?.display_name ?? q.player_id;
      const label = `${name} (${q.games_played}gp)`;
      const arr = byStatus.get(q.status) ?? [];
      arr.push(label);
      byStatus.set(q.status, arr);
    }
    for (const [status, names] of byStatus) {
      console.log(`  ${amber("▸")} ${status}: ${names.join(", ")}`);
    }
  }
  console.log();

  if ((wrappedCount ?? 0) > 0) {
    console.log(bold(`Wrapped stats:  ${wrappedCount}`));
    console.log();
  }

  // ── Confirmation (unless --yes flag) ─────────────────────────
  const autoConfirm = process.argv.includes("--yes");
  if (!autoConfirm) {
    const totalRows =
      (courts?.length ?? 0) +
      (matches?.length ?? 0) +
      (matchPlayers?.length ?? 0) +
      (queueEntries?.length ?? 0) +
      (wrappedCount ?? 0);

    if (totalRows === 0) {
      console.log(green("✓  Session already clean — nothing to delete.\n"));
      return;
    }

    // setRawMode throws on a non-TTY stdin (CI, pipes). Require --yes there.
    if (!process.stdin.isTTY) {
      console.log(
        amber(`\nNon-interactive stdin — re-run with --yes to confirm deleting ${totalRows} rows.`)
      );
      return;
    }

    process.stdout.write(amber(`Delete ${totalRows} rows from "${session.name}"? [y/N] `));
    const answer = await new Promise<string>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", (buf) => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(buf.toString().toLowerCase().trim());
      });
    });
    console.log(answer);
    if (answer !== "y") {
      console.log(dim("Aborted.\n"));
      return;
    }
  }

  // ── Execute deletion ──────────────────────────────────────────
  console.log("\nDeleting…");

  // wrapped stats
  await db.from("session_wrapped_stats").delete().eq("session_id", sessionId);

  // match_players → matches
  if (matchIds.length > 0) {
    await db.from("match_players").delete().in("match_id", matchIds);
    await db.from("matches").delete().eq("session_id", sessionId);
  }

  // queue_entries
  await db.from("queue_entries").delete().eq("session_id", sessionId);

  // courts
  await db.from("courts").delete().eq("session_id", sessionId);

  // bot users (E2E_ prefix)
  const { data: botProfiles } = await db
    .from("profiles")
    .select("id, display_name")
    .like("display_name", "E2E_%");

  let botUsersDeleted = 0;
  for (const p of botProfiles ?? []) {
    const { error } = await db.auth.admin.deleteUser(p.id);
    if (error) {
      console.warn(dim(`  ⚠  Could not delete bot user ${p.display_name}: ${error.message}`));
    } else {
      botUsersDeleted++;
    }
  }

  // reset session row
  await db
    .from("sessions")
    .update({ is_active: true, is_auto_matchmaking_on: false, ended_at: null })
    .eq("id", sessionId);

  // ── Final report ─────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log();
  console.log(green(bold(`✅  Cleanup complete in ${elapsed}s`)));
  console.log();
  console.log(`  ${bold("Courts deleted:")}         ${courts?.length ?? 0}`);
  console.log(`  ${bold("Matches deleted:")}         ${matches?.length ?? 0}`);
  console.log(`  ${bold("Match players deleted:")}   ${matchPlayers?.length ?? 0}`);
  console.log(`  ${bold("Queue entries deleted:")}   ${queueEntries?.length ?? 0}`);
  console.log(`  ${bold("Bot users deleted:")}       ${botUsersDeleted}`);
  console.log(`  ${bold("Wrapped stats deleted:")}   ${wrappedCount ?? 0}`);
  console.log();
  console.log(dim(`  Session row preserved: ${sessionId}`));
  console.log(dim("  is_active=true  is_auto_matchmaking_on=false  ended_at=null"));
  console.log();
}

void run().catch((err) => {
  console.error(red("❌  Cleanup failed:"), err);
  process.exit(1);
});
