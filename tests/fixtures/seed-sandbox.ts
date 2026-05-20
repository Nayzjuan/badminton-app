// ============================================================
// Sandbox Seeder — populates the E2E sandbox session with all
// 50 bot players from the PLAYER_DEFS roster.
//
// Run: npx tsx tests/fixtures/seed-sandbox.ts
//
// Safe to run repeatedly — idempotent:
//   • Auth users are created or looked up by email
//   • Profiles are upserted
//   • Queue entries are inserted only if not already present
//   • Courts are added only if < 6 already exist
//
// Identifies bots by email pattern: <name>@playwright.local
// Teardown: tests/helpers/teardown.ts resetSandboxSession()
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SESSION_ID = process.env.TEST_SESSION_ID!;

if (!SUPABASE_URL || !SERVICE_KEY || !SESSION_ID) {
  console.error("Missing env vars. Run from project root with .env.test loaded.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── All 50 E2E bot players ────────────────────────────────────
const PLAYER_DEFS = [
  // Base 5 — intermediate, PIN 1234
  { name: "E2E_Alice", skill: "intermediate", pin: "1234" },
  { name: "E2E_Bob", skill: "intermediate", pin: "1234" },
  { name: "E2E_Cara", skill: "intermediate", pin: "1234" },
  { name: "E2E_Dan", skill: "intermediate", pin: "1234" },
  { name: "E2E_Eve", skill: "intermediate", pin: "1234" },
  // Reconnect candidates — PIN 5678
  { name: "E2E_Frank", skill: "intermediate", pin: "5678" },
  { name: "E2E_Grace", skill: "upper_intermediate", pin: "5678" },
  { name: "E2E_Henry", skill: "lower_intermediate", pin: "5678" },
  { name: "E2E_Iris", skill: "intermediate", pin: "5678" },
  { name: "E2E_Jake", skill: "intermediate", pin: "5678" },
  // Mixed-skill block — PIN 1234
  { name: "E2E_Kate", skill: "beginner", pin: "1234" },
  { name: "E2E_Leo", skill: "beginner", pin: "1234" },
  { name: "E2E_Mia", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Noah", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Ola", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Pat", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Quinn", skill: "intermediate", pin: "1234" },
  { name: "E2E_Rosa", skill: "intermediate", pin: "1234" },
  { name: "E2E_Sam", skill: "intermediate", pin: "1234" },
  { name: "E2E_Tara", skill: "intermediate", pin: "1234" },
  { name: "E2E_Uma", skill: "intermediate", pin: "1234" },
  { name: "E2E_Vera", skill: "intermediate", pin: "1234" },
  { name: "E2E_Will", skill: "intermediate", pin: "1234" },
  { name: "E2E_Xena", skill: "intermediate", pin: "1234" },
  { name: "E2E_Yuki", skill: "upper_intermediate", pin: "1234" },
  { name: "E2E_Zach", skill: "upper_intermediate", pin: "1234" },
  { name: "E2E_Ana", skill: "upper_intermediate", pin: "1234" },
  { name: "E2E_Ben", skill: "lower_advanced", pin: "1234" },
  { name: "E2E_Celia", skill: "lower_advanced", pin: "1234" },
  { name: "E2E_Diego", skill: "advanced", pin: "1234" },
  // Extended pool (31-50)
  { name: "E2E_Eli", skill: "beginner", pin: "1234" },
  { name: "E2E_Faye", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Gus", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Hana", skill: "intermediate", pin: "1234" },
  { name: "E2E_Ivan", skill: "intermediate", pin: "1234" },
  { name: "E2E_Jade", skill: "intermediate", pin: "1234" },
  { name: "E2E_Kai", skill: "intermediate", pin: "1234" },
  { name: "E2E_Lena", skill: "intermediate", pin: "1234" },
  { name: "E2E_Marco", skill: "upper_intermediate", pin: "1234" },
  { name: "E2E_Nina", skill: "upper_intermediate", pin: "1234" },
  { name: "E2E_Omar", skill: "intermediate", pin: "1234" },
  { name: "E2E_Petra", skill: "intermediate", pin: "1234" },
  { name: "E2E_Rex", skill: "lower_advanced", pin: "1234" },
  { name: "E2E_Sara", skill: "lower_advanced", pin: "1234" },
  { name: "E2E_Theo", skill: "intermediate", pin: "1234" },
  { name: "E2E_Ula", skill: "intermediate", pin: "1234" },
  { name: "E2E_Vince", skill: "advanced", pin: "1234" },
  { name: "E2E_Wren", skill: "lower_intermediate", pin: "1234" },
  { name: "E2E_Xander", skill: "intermediate", pin: "1234" },
  { name: "E2E_Yara", skill: "beginner", pin: "1234" },
] as const;

// ── Helpers ───────────────────────────────────────────────────

async function getOrCreateUser(name: string): Promise<string> {
  const email = `${name.toLowerCase()}@playwright.local`;

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { display_name: name },
  });

  if (!createErr && created.user) {
    return created.user.id;
  }

  if (createErr?.message?.toLowerCase().includes("already been registered")) {
    const {
      data: { users },
    } = await db.auth.admin.listUsers({ perPage: 1000 });
    const existing = users?.find((u) => u.email === email);
    if (existing) return existing.id;
  }

  throw new Error(`[seed] Failed to create/find ${name}: ${createErr?.message}`);
}

async function ensureCourts(count: number) {
  const { data: existing } = await db
    .from("courts")
    .select("id, name")
    .eq("session_id", SESSION_ID);

  const existingCount = existing?.length ?? 0;
  if (existingCount >= count) {
    console.log(`  ✓ Courts: ${existingCount} already present`);
    return;
  }

  const toAdd = count - existingCount;
  const existingNames = new Set((existing ?? []).map((c) => c.name));
  const inserts = [];

  for (let i = 1; inserts.length < toAdd; i++) {
    const name = `Court ${i}`;
    if (!existingNames.has(name)) {
      inserts.push({ session_id: SESSION_ID, name, status: "available" as const });
    }
  }

  await db.from("courts").insert(inserts);
  console.log(`  ✓ Added ${inserts.length} courts (total now ${count})`);
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`\nSeeding sandbox session: ${SESSION_ID}`);
  console.log(`Project: ${SUPABASE_URL}\n`);

  // Guard: confirm this is actually the E2E sandbox
  const { data: session, error: sessionErr } = await db
    .from("sessions")
    .select("id, name")
    .eq("id", SESSION_ID)
    .single();

  if (sessionErr || !session) {
    console.error("Session not found:", sessionErr?.message);
    process.exit(1);
  }

  if (!session.name.startsWith("🤖 E2E SANDBOX")) {
    console.error(`ABORT: Session "${session.name}" is not an E2E sandbox.`);
    process.exit(1);
  }

  console.log(`Session: "${session.name}"\n`);

  // Ensure 6 courts
  await ensureCourts(6);

  // Get players already in queue to avoid duplicate inserts
  const { data: existingEntries } = await db
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", SESSION_ID)
    .neq("status", "left");

  const alreadyInQueue = new Set((existingEntries ?? []).map((e) => e.player_id));
  console.log(`\nPlayers already in queue: ${alreadyInQueue.size}`);
  console.log(`Players to seed: ${PLAYER_DEFS.length}\n`);

  let created = 0;
  let skipped = 0;
  let position = alreadyInQueue.size + 1;

  for (const def of PLAYER_DEFS) {
    process.stdout.write(`  ${def.name}... `);

    // 1. Get or create auth user
    const userId = await getOrCreateUser(def.name);

    // 2. Upsert profile
    await db
      .from("profiles")
      .upsert(
        { id: userId, display_name: def.name, skill_level: def.skill, pin: def.pin },
        { onConflict: "id" }
      );

    // 3. Add to queue if not already there
    if (alreadyInQueue.has(userId)) {
      console.log("already in queue, skipping");
      skipped++;
      continue;
    }

    const { error: queueErr } = await db.from("queue_entries").insert({
      session_id: SESSION_ID,
      player_id: userId,
      status: "waiting",
      games_played: 0,
      position: position++,
      joined_at: new Date(Date.now() - (PLAYER_DEFS.length - position) * 2_000).toISOString(),
    });

    if (queueErr) {
      // Could be a unique-constraint race — check and continue
      if (queueErr.message.includes("duplicate") || queueErr.message.includes("unique")) {
        console.log("already in queue (race), skipping");
        skipped++;
      } else {
        console.log(`ERROR: ${queueErr.message}`);
      }
    } else {
      console.log("added ✓");
      created++;
    }
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`Done.`);
  console.log(`  Added:   ${created} players`);
  console.log(`  Skipped: ${skipped} (already in queue)`);

  // Final summary
  const { data: finalEntries } = await db
    .from("queue_entries")
    .select("status")
    .eq("session_id", SESSION_ID);

  const counts = (finalEntries ?? []).reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  console.log(`\nQueue summary: ${JSON.stringify(counts)}`);

  const { data: finalCourts } = await db
    .from("courts")
    .select("name, status")
    .eq("session_id", SESSION_ID)
    .order("name");
  console.log(`Courts: ${(finalCourts ?? []).map((c) => `${c.name}(${c.status})`).join(", ")}\n`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
