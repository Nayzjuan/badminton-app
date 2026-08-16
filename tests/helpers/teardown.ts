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
//   match_players → match_events → matches → queue_entries → courts
//   → bot auth users
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
    throw new Error("[teardown] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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

// ── Sandbox club resolution (cached — the sandbox session's club never
// changes within a test run, so this resolves once per worker process) ──
let cachedSandboxClub: { id: string; slug: string } | null = null;

async function resolveSandboxClub(
  db: ReturnType<typeof getAdminClient>,
  sessionId: string
): Promise<{ id: string; slug: string }> {
  if (cachedSandboxClub) return cachedSandboxClub;

  const { data: session, error: sessionErr } = await db
    .from("sessions")
    .select("club_id")
    .eq("id", sessionId)
    .single();

  if (sessionErr || !session?.club_id) {
    throw new Error(
      `[teardown] Could not resolve club_id for session ${sessionId}: ${sessionErr?.message ?? "missing club_id"}`
    );
  }

  const { data: club, error: clubErr } = await db
    .from("clubs")
    .select("id, slug")
    .eq("id", session.club_id)
    .single();

  if (clubErr || !club) {
    throw new Error(
      `[teardown] Could not resolve club for club_id ${session.club_id}: ${clubErr?.message ?? "not found"}`
    );
  }

  cachedSandboxClub = { id: club.id, slug: club.slug };
  return cachedSandboxClub;
}

// Exported for e2e specs that navigate club-scoped routes but don't call
// seedSession() (module-level SESSION_ID specs) — resolves the sandbox
// session's club slug once so tests can build club-scoped URLs.
export async function getSandboxClubSlug(): Promise<string> {
  const db = getAdminClient();
  const sessionId = getSessionId();
  const club = await resolveSandboxClub(db, sessionId);
  return club.slug;
}

// ── Main export ───────────────────────────────────────────────

export interface TeardownResult {
  matchesDeleted: number;
  matchPlayersDeleted: number;
  matchEventsDeleted: number;
  queueEntriesDeleted: number;
  courtsDeleted: number;
  botUsersDeleted: number;
  wrappedStatsDeleted: number;
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

  // ── Step 1: Delete session_wrapped_stats ────────────────────
  // Independent of matches — no FK dependencies.
  const { count: wrappedStatsCount, error: wrappedStatsErr } = await db
    .from("session_wrapped_stats")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (wrappedStatsErr) {
    throw new Error(
      `[teardown] Failed to delete session_wrapped_stats: ${wrappedStatsErr.message}`
    );
  }

  // ── Step 2: Fetch all match IDs for this session ────────────
  const { data: matches } = await db.from("matches").select("id").eq("session_id", sessionId);

  const matchIds = (matches ?? []).map((m) => m.id);

  // ── Step 3: Delete match_players (leaf table, no FKs out) ───
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

  // ── Step 4: Delete match_events ───────────────────────────
  // Must happen explicitly: match_events.match_id is ON DELETE SET NULL, so
  // the matches delete below only nulls the pointer and leaves the audit row
  // in place permanently. That is the right behaviour for real sessions — an
  // organizer cancelling a match should not erase the record — but it meant
  // every E2E run deposited rows in a production table that nothing ever
  // reclaimed. 171 sandbox rows had built up between 2026-07-02 and
  // 2026-08-03, roughly 36 per full-suite run. Scoped by session_id, which
  // the sandbox-name guard at the top of this function has already validated.
  //
  // session_id is a safe handle here only because teardown never deletes the
  // sandbox SESSION row (it resets it in place). Were that to change, these
  // rows would be orphaned a second way — session_id nulled — and would need
  // session_id_snapshot (NOT NULL) to stay reachable. Keep the session row.
  const { count: matchEventCount, error: matchEventErr } = await db
    .from("match_events")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (matchEventErr) {
    throw new Error(`[teardown] Failed to delete match_events: ${matchEventErr.message}`);
  }

  // ── Step 5: Delete matches ────────────────────────────────
  const { count: matchCount, error: matchErr } = await db
    .from("matches")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (matchErr) {
    throw new Error(`[teardown] Failed to delete matches: ${matchErr.message}`);
  }

  // ── Step 6: Delete queue_entries ─────────────────────────
  const { count: queueCount, error: queueErr } = await db
    .from("queue_entries")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (queueErr) {
    throw new Error(`[teardown] Failed to delete queue_entries: ${queueErr.message}`);
  }

  // ── Step 7: Delete courts ─────────────────────────────────
  const { count: courtCount, error: courtErr } = await db
    .from("courts")
    .delete({ count: "exact" })
    .eq("session_id", sessionId);

  if (courtErr) {
    throw new Error(`[teardown] Failed to delete courts: ${courtErr.message}`);
  }

  // ── Step 8: Delete bot auth users (cascades to profiles) ──
  // Bot accounts are identified by display_name prefix "E2E_", excluding
  // the organizer bot ("E2E_OrganizerBot" would otherwise also match this
  // prefix) — the organizer account is permanent and reused across every
  // test file, never recreated per-test like player bots.
  const { data: botProfiles } = await db
    .from("profiles")
    .select("id")
    .like("display_name", "E2E_%")
    .neq("display_name", "E2E_OrganizerBot");

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

  // ── Step 9: Reset the session row to a known-good state ────
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
    matchEventsDeleted: matchEventCount ?? 0,
    queueEntriesDeleted: queueCount ?? 0,
    courtsDeleted: courtCount ?? 0,
    botUsersDeleted,
    wrappedStatsDeleted: wrappedStatsCount ?? 0,
  };

  console.log(
    `[teardown] ✓ Reset session ${sessionId}: ` +
      `${result.matchesDeleted} matches, ${result.queueEntriesDeleted} queue entries, ` +
      `${result.courtsDeleted} courts, ${result.botUsersDeleted} bot users, ` +
      `${result.wrappedStatsDeleted} wrapped stats, ` +
      `${result.matchEventsDeleted} match events`
  );

  return result;
}

// ── repairSandboxState ────────────────────────────────────────
// Heals corrupt state left by a test run that crashed mid-execution
// before teardown could fire. Safe to call at any time — it only
// updates statuses and never deletes rows, so permanent sandbox
// players survive unaffected.
//
// Repairs:
//   in_progress / pending matches           → cancelled
//   playing / drafted / on_deck players     → waiting
//   in_use courts                           → available
//
// Called automatically at the start of softResetSandboxSession so
// every test run self-heals regardless of how the previous one ended.

export async function repairSandboxState(): Promise<void> {
  const db = getAdminClient();
  const sessionId = getSessionId();

  const { data: session } = await db
    .from("sessions")
    .select("id, name")
    .eq("id", sessionId)
    .single();

  if (!session?.name.startsWith("🤖 E2E SANDBOX")) {
    throw new Error(`[repair] Session "${session?.name}" is not a sandbox. Refusing.`);
  }

  // Cancel any match that didn't reach a terminal state.
  await db
    .from("matches")
    .update({ status: "cancelled" as const })
    .eq("session_id", sessionId)
    .in("status", ["in_progress", "pending"]);

  // Return any player stuck in a non-waiting non-terminal status.
  await db
    .from("queue_entries")
    .update({ status: "waiting" as const })
    .eq("session_id", sessionId)
    .in("status", ["playing", "drafted", "on_deck"]);

  // Free any court that never got released.
  await db
    .from("courts")
    .update({ status: "available" as const })
    .eq("session_id", sessionId)
    .eq("status", "in_use");
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
  /** Extra bot players created for extended presets (e.g. soft_gate, two_matches_on_deck). */
  extraPlayers: Record<string, BotPlayer>;
  matchId?: string; // Primary / first match ID
  matchId2?: string; // Second match ID (two_matches_on_deck preset only)
  /** Slug of the sandbox session's club — for building club-scoped test URLs. */
  clubSlug: string;
}

export type QueuePreset =
  | "all_waiting" // all 5 players waiting, no matches
  | "first_match_on_deck" // alice/bob/cara/dan in a pending match; eve waiting
  | "first_match_in_progress" // alice/bob/cara/dan in active match; eve waiting
  | "soft_gate" // alice/bob/cara/dan in active match; eve/frank/grace/henry waiting (4 = GATE_POOL_THRESHOLD)
  | "two_matches_on_deck" // match1: alice/bob vs cara/dan (pending); match2: eve/frank vs grace/henry (pending)
  | "diversity_pool_8" // 8 intermediates waiting + 1 COMPLETED match (alice/bob vs cara/dan); used by scenario-h [H-1]
  | "diversity_pool_4"; // ONLY alice/bob/cara/dan waiting (mixed skills) + 1 COMPLETED match; used by scenario-h [H-2]

// ── softResetSandboxSession ───────────────────────────────────
// Clears all match/queue/court data for the sandbox session but
// does NOT delete bot user accounts.  Use this in beforeEach when
// you have already created users in beforeAll and want to avoid
// the 4-5 second sequential auth-API overhead of recreating them
// on every test.
//
// Full cleanup (including users) is still done by resetSandboxSession()
// which should be called in afterAll.
export async function softResetSandboxSession(): Promise<void> {
  const db = getAdminClient();
  const sessionId = getSessionId();

  // Guard: must be a sandbox session
  const { data: session, error: sessionErr } = await db
    .from("sessions")
    .select("id, name")
    .eq("id", sessionId)
    .single();

  if (sessionErr || !session) {
    throw new Error(
      `[soft-teardown] Could not fetch session ${sessionId}: ${sessionErr?.message ?? "not found"}`
    );
  }

  if (!session.name.startsWith("🤖 E2E SANDBOX")) {
    throw new Error(`[soft-teardown] Session "${session.name}" is not a sandbox. Refusing.`);
  }

  // Step 0: Repair any stuck state from a previously crashed test run.
  // Cancels orphaned matches and returns stuck players/courts to their
  // idle states before the delete sweep below. This is a no-op when the
  // session is already clean.
  await repairSandboxState();

  // Step 1: Collect match IDs
  const { data: matches } = await db.from("matches").select("id").eq("session_id", sessionId);
  const matchIds = (matches ?? []).map((m) => m.id);

  // Step 2: Delete match_players
  if (matchIds.length > 0) {
    await db.from("match_players").delete().in("match_id", matchIds);
  }

  // Step 3: Delete match_events.
  // Not covered by the matches delete below: match_events.match_id is
  // ON DELETE SET NULL, so dropping a match nulls the pointer and leaves the
  // audit row behind for good. That is correct for real sessions — an
  // organizer cancelling a match should not erase the record of it — but it
  // means every E2E run permanently deposits rows in a production table.
  // 171 sandbox rows had accumulated this way between 2026-07-02 and
  // 2026-08-03, roughly 36 per full-suite run. Deleted by session_id, which
  // the sandbox-name guard above has already validated.
  await db.from("match_events").delete().eq("session_id", sessionId);

  // Step 4: Delete matches
  await db.from("matches").delete().eq("session_id", sessionId);

  // Step 5: Delete queue_entries
  await db.from("queue_entries").delete().eq("session_id", sessionId);

  // Step 6: Delete courts
  await db.from("courts").delete().eq("session_id", sessionId);

  // Step 7: Delete session_wrapped_stats
  await db.from("session_wrapped_stats").delete().eq("session_id", sessionId);

  // Step 8: Reset session row to clean state
  await db
    .from("sessions")
    .update({
      is_active: true,
      is_auto_matchmaking_on: false,
      ended_at: null,
    })
    .eq("id", sessionId);
}

export async function seedSession(
  preset: QueuePreset = "first_match_on_deck"
): Promise<SeedResult> {
  const db = getAdminClient();
  const sessionId = getSessionId();

  // ── Create bot auth users ──────────────────────────────────
  const playerDefs = [
    { key: "alice", name: "E2E_Alice", skill: "intermediate" },
    { key: "bob", name: "E2E_Bob", skill: "intermediate" },
    { key: "cara", name: "E2E_Cara", skill: "intermediate" },
    { key: "dan", name: "E2E_Dan", skill: "intermediate" },
    { key: "eve", name: "E2E_Eve", skill: "intermediate" },
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

  // ── Verify all profiles exist before inserting queue entries ─
  // When deleteUser fails in a previous teardown, the old email stays taken.
  // createUser then returns a NEW UUID, but the profile upsert may silently
  // no-op if a constraint collision exists, leaving the new UUID without a
  // profile row — causing a FK violation on queue_entries.player_id.
  // We verify each profile exists and retry the upsert once if needed.
  const allUserIds = playerDefs.map((d) => bots[d.key].userId);
  const { data: existingProfiles } = await db.from("profiles").select("id").in("id", allUserIds);
  const existingIds = new Set((existingProfiles ?? []).map((p) => p.id));
  for (const def of playerDefs) {
    const uid = bots[def.key].userId;
    if (!existingIds.has(uid)) {
      // Profile missing — upsert it. Using onConflict:"id" handles the race
      // where the auth trigger fires between our SELECT and this write, creating
      // the profile in the interim. Insert would PK-collide; upsert handles it.
      const { error: upsertErr } = await db
        .from("profiles")
        .upsert(
          { id: uid, display_name: def.name, skill_level: def.skill, pin: "1234" },
          { onConflict: "id" }
        );
      if (upsertErr) {
        throw new Error(`[seed] Force-upsert profile failed for ${def.name}: ${upsertErr.message}`);
      }
    }
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
  const extraPlayers: Record<string, BotPlayer> = {};

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
        // Pending matches must be published so they appear as "On Deck"
        // rather than "Draft" in the organizer panel (is_published defaults
        // to false in the DB since the draft-mode migration).
        is_published: status === "pending",
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
      { match_id: matchId, player_id: bots.bob.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.cara.userId, team: "b" as const },
      { match_id: matchId, player_id: bots.dan.userId, team: "b" as const },
    ];

    const { error: mpErr } = await db.from("match_players").insert(matchPlayers);
    if (mpErr) {
      throw new Error(`[seed] Failed to create match_players: ${mpErr.message}`);
    }

    // Update queue statuses for matched players
    const matchedPlayerIds = [
      bots.alice.userId,
      bots.bob.userId,
      bots.cara.userId,
      bots.dan.userId,
    ];
    const matchedQueueStatus = status === "pending" ? "on_deck" : "playing";

    await db
      .from("queue_entries")
      .update({ status: matchedQueueStatus })
      .eq("session_id", sessionId)
      .in("player_id", matchedPlayerIds);

    // If in_progress, mark the court as in_use
    if (preset === "first_match_in_progress") {
      await db.from("courts").update({ status: "in_use" }).eq("id", courts[0].id);
    }
  }

  if (preset === "soft_gate") {
    // ── Soft Gate Preset ─────────────────────────────────────────
    // Purpose: test that the engine defers scheduling when the waiting
    // pool is exactly at GATE_POOL_THRESHOLD (4) and an active match
    // is in progress.
    //
    // Layout:
    //   Court 1: in_use — alice/bob/cara/dan playing (in_progress match)
    //   Court 2: available
    //   Waiting queue: eve + frank/grace/henry (4 players = GATE_POOL_THRESHOLD)
    //
    // With all 4 waiting players fresh (joined_at ≈ now, wait < GATE_HOLD_MINUTES=8),
    // the gate condition fires:
    //   poolSize(4) ≤ GATE_POOL_THRESHOLD(4) AND hasActiveMatches=true AND maxWait<8
    //   → engine defers, no on-deck match is created.

    // ── Create 3 extra bot players (frank, grace, henry) ─────────
    const extraDefs = [
      { key: "frank", name: "E2E_Frank", skill: "intermediate" as const },
      { key: "grace", name: "E2E_Grace", skill: "intermediate" as const },
      { key: "henry", name: "E2E_Henry", skill: "intermediate" as const },
    ];

    for (const def of extraDefs) {
      const { data: userData, error: userErr } = await db.auth.admin.createUser({
        email: `${def.name.toLowerCase()}@playwright.local`,
        email_confirm: true,
        user_metadata: { display_name: def.name },
      });

      if (userErr || !userData.user) {
        throw new Error(`[seed:soft_gate] Failed to create user ${def.name}: ${userErr?.message}`);
      }

      const userId = userData.user.id;

      const { error: profileErr } = await db
        .from("profiles")
        .upsert(
          { id: userId, display_name: def.name, skill_level: def.skill, pin: "1234" },
          { onConflict: "id" }
        );
      if (profileErr) {
        throw new Error(
          `[seed:soft_gate] Failed to upsert profile ${def.name}: ${profileErr.message}`
        );
      }

      extraPlayers[def.key] = {
        userId,
        profileId: userId,
        displayName: def.name,
        skill: def.skill,
      };
    }

    // ── Create in_progress match for alice/bob/cara/dan on court 1 ──
    const { data: matchData, error: matchErr } = await db
      .from("matches")
      .insert({
        session_id: sessionId,
        court_id: courts[0].id,
        status: "in_progress",
        is_mixed_level: false,
        sort_order: 1,
      })
      .select("id")
      .single();

    if (matchErr || !matchData) {
      throw new Error(`[seed:soft_gate] Failed to create match: ${matchErr?.message}`);
    }

    matchId = matchData.id;

    const matchPlayers = [
      { match_id: matchId, player_id: bots.alice.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.bob.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.cara.userId, team: "b" as const },
      { match_id: matchId, player_id: bots.dan.userId, team: "b" as const },
    ];

    const { error: mpErr } = await db.from("match_players").insert(matchPlayers);
    if (mpErr) {
      throw new Error(`[seed:soft_gate] Failed to create match_players: ${mpErr.message}`);
    }

    // Mark alice/bob/cara/dan as "playing"
    await db
      .from("queue_entries")
      .update({ status: "playing" })
      .eq("session_id", sessionId)
      .in("player_id", [bots.alice.userId, bots.bob.userId, bots.cara.userId, bots.dan.userId]);

    // Mark court 1 as in_use
    await db.from("courts").update({ status: "in_use" }).eq("id", courts[0].id);

    // ── Add frank/grace/henry to queue (eve is already in queue at pos 5) ──
    // Combined waiting pool: eve (pos 5) + frank/grace/henry (pos 6-8) = 4 waiting
    // 4 == GATE_POOL_THRESHOLD — the gate holds when these are the only players available
    const extraQueueInserts = [
      {
        session_id: sessionId,
        player_id: extraPlayers.frank.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 6,
      },
      {
        session_id: sessionId,
        player_id: extraPlayers.grace.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 7,
      },
      {
        session_id: sessionId,
        player_id: extraPlayers.henry.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 8,
      },
    ];

    const { error: extraQueueErr } = await db.from("queue_entries").insert(extraQueueInserts);

    if (extraQueueErr) {
      throw new Error(
        `[seed:soft_gate] Failed to create extra queue entries: ${extraQueueErr.message}`
      );
    }
  }

  let matchId2: string | undefined;

  if (preset === "two_matches_on_deck") {
    // ── Two Matches On-Deck Preset ────────────────────────────────
    // Purpose: test Tap-to-Swap v2 cross-match and same-match swaps.
    //
    // Layout:
    //   Match 1 (pending, sort_order=1): alice/bob (Team A) vs cara/dan (Team B)
    //   Match 2 (pending, sort_order=2): eve/frank (Team A) vs grace/henry (Team B)
    //   All 8 players: status=on_deck
    //   2 courts: both available (no active match)

    // ── Create extra bot players (frank, grace, henry) ───────────
    const extraDefs = [
      { key: "frank", name: "E2E_Frank", skill: "intermediate" as const },
      { key: "grace", name: "E2E_Grace", skill: "intermediate" as const },
      { key: "henry", name: "E2E_Henry", skill: "intermediate" as const },
    ];

    for (const def of extraDefs) {
      const { data: userData, error: userErr } = await db.auth.admin.createUser({
        email: `${def.name.toLowerCase()}@playwright.local`,
        email_confirm: true,
        user_metadata: { display_name: def.name },
      });

      if (userErr || !userData.user) {
        throw new Error(
          `[seed:two_matches_on_deck] Failed to create user ${def.name}: ${userErr?.message}`
        );
      }

      const userId = userData.user.id;

      const { error: profileErr } = await db
        .from("profiles")
        .upsert(
          { id: userId, display_name: def.name, skill_level: def.skill, pin: "1234" },
          { onConflict: "id" }
        );
      if (profileErr) {
        throw new Error(
          `[seed:two_matches_on_deck] Failed to upsert profile ${def.name}: ${profileErr.message}`
        );
      }

      extraPlayers[def.key] = {
        userId,
        profileId: userId,
        displayName: def.name,
        skill: def.skill,
      };
    }

    // Queue entries for frank, grace, henry (alice–eve already inserted above)
    const extraQueueInserts = [
      {
        session_id: sessionId,
        player_id: extraPlayers.frank.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 6,
      },
      {
        session_id: sessionId,
        player_id: extraPlayers.grace.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 7,
      },
      {
        session_id: sessionId,
        player_id: extraPlayers.henry.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 8,
      },
    ];

    const { error: extraQueueErr } = await db.from("queue_entries").insert(extraQueueInserts);
    if (extraQueueErr) {
      throw new Error(
        `[seed:two_matches_on_deck] Failed to create extra queue entries: ${extraQueueErr.message}`
      );
    }

    // ── Match 1: alice/bob (Team A) vs cara/dan (Team B) ─────────
    const { data: m1, error: m1Err } = await db
      .from("matches")
      .insert({
        session_id: sessionId,
        court_id: null,
        status: "pending",
        is_mixed_level: false,
        sort_order: 1,
        is_published: true,
      })
      .select("id")
      .single();
    if (m1Err || !m1)
      throw new Error(`[seed:two_matches_on_deck] Failed to create match 1: ${m1Err?.message}`);
    matchId = m1.id;

    await db.from("match_players").insert([
      { match_id: matchId, player_id: bots.alice.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.bob.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.cara.userId, team: "b" as const },
      { match_id: matchId, player_id: bots.dan.userId, team: "b" as const },
    ]);

    await db
      .from("queue_entries")
      .update({ status: "on_deck" })
      .eq("session_id", sessionId)
      .in("player_id", [bots.alice.userId, bots.bob.userId, bots.cara.userId, bots.dan.userId]);

    // ── Match 2: eve/frank (Team A) vs grace/henry (Team B) ──────
    const { data: m2, error: m2Err } = await db
      .from("matches")
      .insert({
        session_id: sessionId,
        court_id: null,
        status: "pending",
        is_mixed_level: false,
        sort_order: 2,
        is_published: true,
      })
      .select("id")
      .single();
    if (m2Err || !m2)
      throw new Error(`[seed:two_matches_on_deck] Failed to create match 2: ${m2Err?.message}`);
    matchId2 = m2.id;

    await db.from("match_players").insert([
      { match_id: matchId2, player_id: bots.eve.userId, team: "a" as const },
      { match_id: matchId2, player_id: extraPlayers.frank.userId, team: "a" as const },
      { match_id: matchId2, player_id: extraPlayers.grace.userId, team: "b" as const },
      { match_id: matchId2, player_id: extraPlayers.henry.userId, team: "b" as const },
    ]);

    await db
      .from("queue_entries")
      .update({ status: "on_deck" })
      .eq("session_id", sessionId)
      .in("player_id", [
        bots.eve.userId,
        extraPlayers.frank.userId,
        extraPlayers.grace.userId,
        extraPlayers.henry.userId,
      ]);
  }

  if (preset === "diversity_pool_8") {
    // ── Diversity Pool 8 Preset ──────────────────────────────────
    // Purpose: scenario-h [H-1] — verify the engine avoids the recently
    // played 4-player roster when the waiting pool has fresh alternatives.
    //
    // Layout:
    //   8 intermediate players (alice–henry), all waiting (positions 1–8)
    //   2 courts available, no in-progress match
    //   1 COMPLETED match: Team A=alice/bob, Team B=cara/dan
    //   alice/bob/cara/dan have games_played=1 (they played the completed match)
    //   eve/frank/grace/henry have games_played=0 (fresh)
    //
    // With this setup, the engine picks any of the 8 as anchor; companions
    // are scored by overlap-with-anchor. Since alice/bob/cara/dan have
    // overlap=1 with each other, the engine prefers fresh players, and the
    // first proposed group should have ≤ 2 players from the completed roster.

    // ── Create 3 extra bot players (frank, grace, henry) ─────────
    const extraDefs = [
      { key: "frank", name: "E2E_Frank", skill: "intermediate" as const },
      { key: "grace", name: "E2E_Grace", skill: "intermediate" as const },
      { key: "henry", name: "E2E_Henry", skill: "intermediate" as const },
    ];

    for (const def of extraDefs) {
      const { data: userData, error: userErr } = await db.auth.admin.createUser({
        email: `${def.name.toLowerCase()}@playwright.local`,
        email_confirm: true,
        user_metadata: { display_name: def.name },
      });

      if (userErr || !userData.user) {
        throw new Error(
          `[seed:diversity_pool_8] Failed to create user ${def.name}: ${userErr?.message}`
        );
      }

      const userId = userData.user.id;

      const { error: profileErr } = await db
        .from("profiles")
        .upsert(
          { id: userId, display_name: def.name, skill_level: def.skill, pin: "1234" },
          { onConflict: "id" }
        );
      if (profileErr) {
        throw new Error(
          `[seed:diversity_pool_8] Failed to upsert profile ${def.name}: ${profileErr.message}`
        );
      }

      extraPlayers[def.key] = {
        userId,
        profileId: userId,
        displayName: def.name,
        skill: def.skill,
      };
    }

    // ── Add frank/grace/henry to queue at positions 6-8 ──────────
    // Note: alice–eve were inserted in a separate batch earlier and share
    // a single statement-timestamp `joined_at`. frank/grace/henry are
    // inserted now in their own batch and get a slightly later joined_at.
    // Combined with the priorityScore=0 floor for everyone (alice/bob/cara/dan
    // floored from -12 by GAME_PENALTY, eve/frank/grace/henry naturally 0),
    // the engine's joined_at-ASC tiebreak picks one of {alice…eve} as anchor.
    // Either anchor still produces a diverse first match because:
    //   • If anchor is alice/bob/cara/dan: the 3 lowest-overlap companions
    //     (overlap=1 → score 10_000) are dominated by 4 fresh choices
    //     (overlap=0 → score 0), so the group ends up with 1 from the
    //     completed roster and 3 fresh.
    //   • If anchor is eve: all 7 candidates have overlap=0; the engine's
    //     stable sort then picks the first 3 by query order — still a
    //     mix that keeps overlap with the completed roster ≤ 2.
    const extraQueueInserts = [
      {
        session_id: sessionId,
        player_id: extraPlayers.frank.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 6,
      },
      {
        session_id: sessionId,
        player_id: extraPlayers.grace.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 7,
      },
      {
        session_id: sessionId,
        player_id: extraPlayers.henry.userId,
        status: "waiting" as const,
        games_played: 0,
        position: 8,
      },
    ];

    const { error: extraQueueErr } = await db.from("queue_entries").insert(extraQueueInserts);
    if (extraQueueErr) {
      throw new Error(
        `[seed:diversity_pool_8] Failed to create extra queue entries: ${extraQueueErr.message}`
      );
    }

    // ── Create the COMPLETED match: alice/bob vs cara/dan ────────
    // started 11 min ago, completed 1 min ago — well within the
    // ANTI_REPEAT_LOOKBACK window the engine reads.
    const { data: completedMatch, error: completedErr } = await db
      .from("matches")
      .insert({
        session_id: sessionId,
        court_id: null,
        status: "completed",
        is_mixed_level: false,
        sort_order: 0,
        team_a_score: 21,
        team_b_score: 19,
        started_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        completed_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .select("id")
      .single();

    if (completedErr || !completedMatch) {
      throw new Error(
        `[seed:diversity_pool_8] Failed to create completed match: ${completedErr?.message}`
      );
    }

    matchId = completedMatch.id;

    const { error: completedMpErr } = await db.from("match_players").insert([
      { match_id: matchId, player_id: bots.alice.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.bob.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.cara.userId, team: "b" as const },
      { match_id: matchId, player_id: bots.dan.userId, team: "b" as const },
    ]);
    if (completedMpErr) {
      throw new Error(
        `[seed:diversity_pool_8] Failed to create completed match players: ${completedMpErr.message}`
      );
    }

    // ── Bump games_played for the 4 who played the completed match ──
    // Their priority drops to floor(0 - 1×12, 0) = 0 (same as fresh players),
    // but the overlap penalty in scoreCandidates makes the engine prefer
    // pairing fresh anchors with fresh companions.
    const { error: gpErr } = await db
      .from("queue_entries")
      .update({ games_played: 1 })
      .eq("session_id", sessionId)
      .in("player_id", [bots.alice.userId, bots.bob.userId, bots.cara.userId, bots.dan.userId]);
    if (gpErr) {
      throw new Error(`[seed:diversity_pool_8] Failed to bump games_played: ${gpErr.message}`);
    }
  }

  if (preset === "diversity_pool_4") {
    // ── Diversity Pool 4 Preset ──────────────────────────────────
    // Purpose: scenario-h [H-2] — verify rotatedDraft fires when the
    // engine is forced to repeat the same 4 players (no fresh alternatives).
    //
    // Layout:
    //   ONLY alice/bob/cara/dan waiting (eve removed from queue)
    //   Skills span ±2 so the engine's normal window admits the group:
    //     alice = lower_intermediate (skill_int=2)
    //     bob   = intermediate       (skill_int=3)
    //     cara  = intermediate       (skill_int=3)
    //     dan   = upper_intermediate (skill_int=4)
    //   Variance: max(4) - min(2) = 2 ≤ SKILL_VARIANCE_MAX
    //   2 courts available, no in-progress match (so soft gate cannot fire)
    //   1 COMPLETED match: Team A=alice/dan (skill 2+4=6), Team B=bob/cara (3+3=6)
    //
    // Engine flow:
    //   - Pool size = 4 → effectiveLookback=2, but only 1 completed match exists
    //   - Anchor = whoever's first by joined_at tiebreak (priority 0 across the board)
    //   - Group = the other 3 (only choice)
    //   - isDiversityViolation([all 4]) = true (4-of-4 overlap with completed)
    //   - Tier 1 swap: swapPool empty (no other players) → fail
    //   - Tier 2 expand: widerEligible empty (all 4 already in group) → fail
    //   - Tier 3 rotatedDraft: repeatCount=1 → splitIndex=1. For this
    //     4/3/3/2 four, Split 1 (gap 2) is still balanced. A 6/5/4/3
    //     four would skip top-vs-bottom as lopsided.
    //
    // The rotated split with sorted-DESC-by-skill input (dan, bob/cara, alice)
    // produces partnership pairs that DIFFER from {alice+dan, bob+cara}.
    // Both possible tie-breaks (bob first or cara first) yield a different
    // partnership set than the completed match — see scenario-h [H-2] assertion.

    // ── Override skills for alice and dan ────────────────────────
    const { error: aliceSkillErr } = await db
      .from("profiles")
      .update({ skill_level: "lower_intermediate" })
      .eq("id", bots.alice.userId);
    if (aliceSkillErr) {
      throw new Error(
        `[seed:diversity_pool_4] Failed to update alice skill: ${aliceSkillErr.message}`
      );
    }

    const { error: danSkillErr } = await db
      .from("profiles")
      .update({ skill_level: "upper_intermediate" })
      .eq("id", bots.dan.userId);
    if (danSkillErr) {
      throw new Error(`[seed:diversity_pool_4] Failed to update dan skill: ${danSkillErr.message}`);
    }

    bots.alice.skill = "lower_intermediate";
    bots.dan.skill = "upper_intermediate";

    // ── Remove eve from the queue (her profile/auth user remain) ──
    const { error: eveDelErr } = await db
      .from("queue_entries")
      .delete()
      .eq("session_id", sessionId)
      .eq("player_id", bots.eve.userId);
    if (eveDelErr) {
      throw new Error(
        `[seed:diversity_pool_4] Failed to remove eve from queue: ${eveDelErr.message}`
      );
    }

    // ── Create the COMPLETED match: alice+dan vs bob+cara ────────
    // Skill sums: A=2+4=6, B=3+3=6 → balanced.
    // Partnership pairs: {alice+dan, bob+cara}.
    // After rotatedDraft (splitIndex=1), the new partnership pair will be
    // {dan+top-int, alice+bottom-int} which differs from above regardless
    // of whether bob or cara wins the stable-sort tie.
    const { data: completedMatch, error: completedErr } = await db
      .from("matches")
      .insert({
        session_id: sessionId,
        court_id: null,
        status: "completed",
        is_mixed_level: false,
        sort_order: 0,
        team_a_score: 21,
        team_b_score: 18,
        started_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        completed_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .select("id")
      .single();

    if (completedErr || !completedMatch) {
      throw new Error(
        `[seed:diversity_pool_4] Failed to create completed match: ${completedErr?.message}`
      );
    }

    matchId = completedMatch.id;

    const { error: completedMpErr } = await db.from("match_players").insert([
      { match_id: matchId, player_id: bots.alice.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.dan.userId, team: "a" as const },
      { match_id: matchId, player_id: bots.bob.userId, team: "b" as const },
      { match_id: matchId, player_id: bots.cara.userId, team: "b" as const },
    ]);
    if (completedMpErr) {
      throw new Error(
        `[seed:diversity_pool_4] Failed to create completed match players: ${completedMpErr.message}`
      );
    }

    // ── Bump games_played for all 4 (they played the completed match) ──
    const { error: gpErr } = await db
      .from("queue_entries")
      .update({ games_played: 1 })
      .eq("session_id", sessionId)
      .in("player_id", [bots.alice.userId, bots.bob.userId, bots.cara.userId, bots.dan.userId]);
    if (gpErr) {
      throw new Error(`[seed:diversity_pool_4] Failed to bump games_played: ${gpErr.message}`);
    }
  }

  // ── Enroll every bot player in the sandbox session's club ───────────
  // Route-level requireClubMembership gates club-scoped pages — without
  // this, tests that navigate directly to /c/[slug]/... (bypassing the
  // legacy root shims that used to auto-enroll via ensureClubMembership)
  // would get redirected away as non-members.
  const club = await resolveSandboxClub(db, sessionId);
  const allBotIds = [
    ...Object.values(bots).map((b) => b.userId),
    ...Object.values(extraPlayers).map((b) => b.userId),
  ];
  const { error: memberErr } = await db.from("club_members").upsert(
    allBotIds.map((playerId) => ({
      club_id: club.id,
      player_id: playerId,
      role: "member" as const,
    })),
    { onConflict: "club_id,player_id" }
  );
  if (memberErr) {
    throw new Error(`[seed] Failed to upsert club_members: ${memberErr.message}`);
  }

  return {
    sessionId,
    courtIds: courts.map((c) => c.id),
    players: bots as SeedResult["players"],
    extraPlayers,
    matchId,
    matchId2,
    clubSlug: club.slug,
  };
}
