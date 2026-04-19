// ============================================================
// SAFETY-CRITICAL: Sandbox Session Teardown
// ============================================================
// Wipes all child rows for TEST_SESSION_ID in strict dependency
// order so the next test starts from a clean slate.
//
// HARD GUARDRAILS (both must pass before a single DELETE fires):
//   1. TEST_SESSION_ID env var must be defined.
//   2. The sessions.name must start with "🤖 E2E SANDBOX" —
//      this physically prevents wiping a real production session
//      even if TEST_SESSION_ID is accidentally set to one.
//
// What is wiped (scoped to TEST_SESSION_ID only):
//   match_players → matches → queue_entries → courts → bot auth users
//
// What is NOT wiped:
//   The sessions row itself — its UUID is our stable anchor.
//   The organizer bot account — reused across all tests.
//   Any row from any other session_id — impossible by construction.
// ============================================================

import { createClient } from "@supabase/supabase-js";

// ── Service-role client (bypasses RLS) ───────────────────────
function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "[teardown] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Guard: validate TEST_SESSION_ID ──────────────────────────
function getSessionId(): string {
  const id = process.env.TEST_SESSION_ID;
  if (!id || id.trim() === "") {
    throw new Error(
      "[teardown] FATAL: TEST_SESSION_ID is not set.\n" +
        "Add it to .env.test — never run teardown without a sandbox session ID."
    );
  }
  return id.trim();
}

// ── Main export ───────────────────────────────────────────────

export interface TeardownResult {
  matchesDeleted: number;
  matchPlayersDeleted: number;
  queueEntriesDeleted: number;
  courtsDeleted: number;
  botUsersDeleted: number;
}

export async function resetSandboxSession(): Promise<TeardownResult> {
  const db = getAdminClient();
  const sessionId = getSessionId();

  // ── Guard: confirm this really is the sandbox session ──────
  const { data: session, error: sessionErr } = await db
    .from("sessions")
    .select("id, name")
    .eq("id", sessionId)
    .single();

  if (sessionErr || !session) {
    throw new Error(
      `[teardown] FATAL: Could not fetch session ${sessionId}: ${sessionErr?.message ?? "not found"}.\n` +
        "Check TEST_SESSION_ID in .env.test."
    );
  }

  if (!session.name.startsWith("🤖 E2E SANDBOX")) {
    throw new Error(
      `[teardown] FATAL: Session "${session.name}" (${sessionId}) is not a sandbox session.\n` +
        'The session name must start with "🤖 E2E SANDBOX". Refusing to wipe.'
    );
  }

  // ── Step 1: Fetch all match IDs for this session ────────────
  const { data: matches } = await db
    .from("matches")
    .select("id")
    .eq("session_id", sessionId);

  const matchIds = (matches ?? []).map((m) => m.id);

  // ── Step 2: Delete match_players (leaf table, no FKs out) ───
  let matchPlayersDeleted = 0;
  if (matchIds.length > 0) {
    const { count, error } = await db
      .from("match_players")
      .delete({ count: "exact" })
      .in("match_id", matchIds);

    if (error) {
      throw new Error(`[teardown] Failed to delete match_players: ${error.message}`);
    }
    matchPlayersDeleted = count ?? 0;
  }

  // ── Step 3: Delete matches ────────────────────────────────
  const { count: matchCount, error: matchErr } = await db
    .from("matches")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (matchErr) {
    throw new Error(`[teardown] Failed to delete matches: ${matchErr.message}`);
  }

  // ── Step 4: Delete queue_entries ─────────────────────────
  const { count: queueCount, error: queueErr } = await db
    .from("queue_entries")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (queueErr) {
    throw new Error(`[teardown] Failed to delete queue_entries: ${queueErr.message}`);
  }

  // ── Step 5: Delete courts ─────────────────────────────────
  const { count: courtCount, error: courtErr } = await db
    .from("courts")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (courtErr) {
    throw new Error(`[teardown] Failed to delete courts: ${courtErr.message}`);
  }

  // ── Step 6: Delete bot auth users (cascades to profiles) ──
  // Bot accounts are identified by display_name prefix "E2E_".
  const { data: botProfiles } = await db
    .from("profiles")
    .select("id")
    .like("display_name", "E2E_%");

  let botUsersDeleted = 0;
  for (const p of botProfiles ?? []) {
    const { error: delErr } = await db.auth.admin.deleteUser(p.id);
    if (delErr) {
      // Non-fatal: user may have already been deleted; log and continue.
      console.warn(`[teardown] Could not delete bot user ${p.id}: ${delErr.message}`);
    } else {
      botUsersDeleted++;
    }
  }

  // ── Step 7: Reset the session row to a known-good state ────
  await db
    .from("sessions")
    .update({
      is_active: true,
      is_auto_matchmaking_on: false,
      ended_at: null,
    })
    .eq("id", sessionId);

  const result: TeardownResult = {
    matchesDeleted: matchCount ?? 0,
    matchPlayersDeleted,
    queueEntriesDeleted: queueCount ?? 0,
    courtsDeleted: courtCount ?? 0,
    botUsersDeleted,
  };

  console.log(
    `[teardown] ✓ Reset session ${sessionId}: ` +
      `${result.matchesDeleted} matches, ${result.queueEntriesDeleted} queue entries, ` +
      `${result.courtsDeleted} courts, ${result.botUsersDeleted} bot users`
  );

  return result;
}

// ── Seed helpers ──────────────────────────────────────────────
// Creates courts + bot players + queue entries in a single call.
// Returns a typed handle so specs can reference IDs without magic strings.

export interface BotPlayer {
  userId: string;
  profileId: string;
  displayName: string;
  skill: string;
}

export interface SeedResult {
  sessionId: string;
  courtIds: string[];
  players: {
    alice: BotPlayer;
    bob: BotPlayer;
    cara: BotPlayer;
    dan: BotPlayer;
    eve: BotPlayer;
  };
  matchId?: string; // Set when queue === "first_match_on_deck"
}

export type QueuePreset =
  | "all_waiting"          // all 5 players waiting, no matches
  | "first_match_on_deck"  // alice/bob/cara/dan in a pending match; eve waiting
  | "first_match_in_progress"; // alice/bob/cara/dan in active match; eve waiting

export async function seedSession(
  preset: QueuePreset = "first_match_on_deck"
): Promise<SeedResult> {
  const db = getAdminClient();
  const sessionId = getSessionId();

  // ── Create bot auth users ──────────────────────────────────
  const playerDefs = [
    { key: "alice", name: "E2E_Alice", skill: "intermediate" },
    { key: "bob",   name: "E2E_Bob",   skill: "intermediate" },
    { key: "cara",  name: "E2E_Cara",  skill: "intermediate" },
    { key: "dan",   name: "E2E_Dan",   skill: "intermediate" },
    { key: "eve",   name: "E2E_Eve",   skill: "intermediate" },
  ] as const;

  const bots: Record<string, BotPlayer> = {};

  for (const def of playerDefs) {
    // Create anonymous user via admin API
    const { data: userData, error: userErr } = await db.auth.admin.createUser({
      email: `${def.name.toLowerCase()}@playwright.local`,
      email_confirm: true,
      user_metadata: { display_name: def.name },
    });

    if (userErr || !userData.user) {
      throw new Error(`[seed] Failed to create user ${def.name}: ${userErr?.message}`);
    }

    const userId = userData.user.id;

    // Upsert profile row (the DB trigger may have already created it)
    const { error: profileErr } = await db.from("profiles").upsert(
      {
        id: userId,
        display_name: def.name,
        skill_level: def.skill,
        pin: "1234",
      },
      { onConflict: "id" }
    );

    if (profileErr) {
      throw new Error(`[seed] Failed to upsert profile ${def.name}: ${profileErr.message}`);
    }

    bots[def.key] = {
      userId,
      profileId: userId,
      displayName: def.name,
      skill: def.skill,
    };
  }

  // ── Create courts ─────────────────────────────────────────
  const courtInserts = [
    { session_id: sessionId, name: "Court 1", status: "available" as const },
    { session_id: sessionId, name: "Court 2", status: "available" as const },
  ];

  const { data: courts, error: courtErr } = await db
    .from("courts")
    .insert(courtInserts)
    .select("id");

  if (courtErr || !courts) {
    throw new Error(`[seed] Failed to create courts: ${courtErr?.message}`);
  }

  // ── Create queue entries ──────────────────────────────────
  const queueInserts = playerDefs.map((def, i) => ({
    session_id: sessionId,
    player_id: bots[def.key].userId,
    status: "waiting" as const,
    games_played: 0,
    position: i + 1,
  }));

  const { error: queueErr } = await db.from("queue_entries").insert(queueInserts);

  if (queueErr) {
    throw new Error(`[seed] Failed to create queue entries: ${queueErr.message}`);
  }

  let matchId: string | undefined;

  if (preset === "first_match_on_deck" || preset === "first_match_in_progress") {
    // ── Create a match with alice/bob vs cara/dan ─────────────
    const status = preset === "first_match_on_deck" ? "pending" : "in_progress";
    const courtId = preset === "first_match_in_progress" ? courts[0].id : null;

    const { data: matchData, error: matchErr } = await db
      .from("matches")
      .insert({
        session_id: sessionId,
        court_id: courtId,
        status,
        is_mixed_level: false,
        sort_order: 1,
      })
      .select("id")
      .single();

    if (matchErr || !matchData) {
      throw new Error(`[seed] Failed to create match: ${matchErr?.message}`);
    }

    matchId = matchData.id;

    // Assign players to the match
    const matchPlayers = [
      { match_id: matchId, player_id: bots.alice.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.bob.userId,   team: "a" as const },
      { match_id: matchId, player_id: bots.cara.userId,  team: "b" as const },
      { match_id: matchId, player_id: bots.dan.userId,   team: "b" as const },
    ];

    const { error: mpErr } = await db.from("match_players").insert(matchPlayers);
    if (mpErr) {
      throw new Error(`[seed] Failed to create match_players: ${mpErr.message}`);
    }

    // Update queue statuses for matched players
    const matchedPlayerIds = [
      bots.alice.userId, bots.bob.userId, bots.cara.userId, bots.dan.userId,
    ];
    const matchedQueueStatus = status === "pending" ? "on_deck" : "playing";

    await db
      .from("queue_entries")
      .update({ status: matchedQueueStatus })
      .eq("session_id", sessionId)
      .in("player_id", matchedPlayerIds);

    // If in_progress, mark the court as in_use
    if (preset === "first_match_in_progress") {
      await db
        .from("courts")
        .update({ status: "in_use" })
        .eq("id", courts[0].id);
    }
  }

  return {
    sessionId,
    courtIds: courts.map((c) => c.id),
    players: bots as SeedResult["players"],
    matchId,
  };
}
