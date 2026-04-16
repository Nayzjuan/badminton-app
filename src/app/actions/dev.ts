"use server";

// ============================================================
// Dev Tools — Server Actions for Test Data
// ============================================================
// Temporary helpers to seed realistic test data and clear
// session state for rapid development iteration.
//
// REQUIRES: SUPABASE_SERVICE_ROLE_KEY in .env.local
// The service role bypasses RLS so fake UUIDs can be inserted
// without a matching auth.users entry.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { SKILL_LEVELS, type SkillLevel } from "@/types/database";

// ----------------------------------------------------------
// Random name generator — produces realistic-ish badminton names
// ----------------------------------------------------------
const FIRST_NAMES = [
  "Alex", "Jordan", "Sam", "Casey", "Riley", "Morgan", "Taylor",
  "Avery", "Quinn", "Blake", "Drew", "Kai", "Reese", "Dakota",
  "Skyler", "Jamie", "Peyton", "Cameron", "Hayden", "Rowan",
  "Emery", "Finley", "Sage", "Ari", "Noel", "Remy", "Tatum",
  "Harley", "Lennox", "Phoenix", "River", "Wren", "Eden", "Kit",
  "Lee", "Jude", "Ellis", "Micah", "Shay", "Jules",
];

const LAST_INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function randomName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const lastInitial = LAST_INITIALS[Math.floor(index / FIRST_NAMES.length) % 26];
  const suffix = index >= FIRST_NAMES.length * 26 ? `${index}` : "";
  return `${first} ${lastInitial}.${suffix}`;
}

function randomSkillLevel(): SkillLevel {
  const idx = Math.floor(Math.random() * SKILL_LEVELS.length);
  return SKILL_LEVELS[idx].value;
}

function randomGamesPlayed(): number {
  // 0–3 games, weighted toward lower numbers.
  const weights = [0, 0, 0, 1, 1, 2, 3];
  return weights[Math.floor(Math.random() * weights.length)];
}

function randomJoinedAt(guaranteeBottleneck: boolean): string {
  const now = Date.now();
  if (guaranteeBottleneck) {
    // 21–45 minutes ago — guaranteed bottleneck (> 20 min).
    const minutesAgo = 21 + Math.floor(Math.random() * 24);
    return new Date(now - minutesAgo * 60_000).toISOString();
  }
  // 0–18 minutes ago — normal wait time.
  const minutesAgo = Math.floor(Math.random() * 18);
  return new Date(now - minutesAgo * 60_000).toISOString();
}

// ----------------------------------------------------------
// Seed Test Data
// ----------------------------------------------------------
export interface SeedResult {
  success: boolean;
  message: string;
  playerCount?: number;
}

// ── Dev-tool auth guard ───────────────────────────────────────
// P1-5: Dev tools use the service-role client which bypasses ALL
// RLS. Without an auth check, any authenticated player who knows
// the session ID could call these actions and wipe session data.
//
// Guard: caller must be authenticated. In production, these
// actions should be disabled entirely (gated by NODE_ENV or a
// feature flag). For now we at minimum require a valid session.
async function requireAuth(): Promise<{ error: string } | null> {
  // Inline import to avoid circular dep with server client.
  const { createClient } = await import("@/utils/supabase/server");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };
  return null;
}

export async function seedTestData(
  sessionId: string,
  count: number = 35
): Promise<SeedResult> {
  // P1-5: Require authentication before any service-role writes.
  const authErr = await requireAuth();
  if (authErr) return { success: false, message: authErr.error };

  // The service role client is required for two reasons:
  //   1. supabase.auth.admin.createUser() is an admin-only API —
  //      the anon key does not have access to it.
  //   2. It bypasses RLS on profiles / queue_entries so we can
  //      write on behalf of the newly-created users.
  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[seedTestData] Failed to create service client:", msg);
    return { success: false, message: msg };
  }

  // Verify the session exists and is active.
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("is_active", true)
    .single();

  if (sessionError) {
    console.error("[seedTestData] Session lookup error:", sessionError);
    return { success: false, message: `Session lookup failed: ${sessionError.message}` };
  }
  if (!session) {
    console.error("[seedTestData] Session not found or inactive:", sessionId);
    return { success: false, message: "Session not found or inactive." };
  }

  // Decide which players will be bottlenecks (3–5 of them).
  const bottleneckCount = 3 + Math.floor(Math.random() * 3);
  const bottleneckIndices = new Set<number>();
  while (bottleneckIndices.size < bottleneckCount) {
    bottleneckIndices.add(Math.floor(Math.random() * count));
  }

  let inserted = 0;
  let authErrors = 0;
  let profileErrors = 0;
  let queueErrors = 0;

  // Use a shared seed prefix so emails are unique even if this runs
  // multiple times against the same session.
  const runId = crypto.randomUUID().slice(0, 8);

  for (let i = 0; i < count; i++) {
    const displayName = randomName(i);
    const skillLevel = randomSkillLevel();
    const gamesPlayed = randomGamesPlayed();
    const isBottleneck = bottleneckIndices.has(i);
    const joinedAt = randomJoinedAt(isBottleneck);

    // ── Step 1: create a real auth.users row ──────────────────────────
    // profiles.id has a FK → auth.users(id), so we MUST create the auth
    // user first. There is no fallback — fake UUIDs will always violate
    // the FK constraint.
    const email = `dev_${runId}_${i}@seed.local`;

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        display_name: displayName,
        skill_level: skillLevel,
      },
    });

    if (authError || !authData?.user) {
      authErrors++;
      console.error(
        `[seedTestData] auth.admin.createUser failed for player ${i} ("${displayName}"):`,
        authError
      );
      continue;
    }

    const userId = authData.user.id;

    // ── Step 2: upsert profile ─────────────────────────────────────────
    // The DB trigger (handle_new_user) may have already created the row.
    // Upserting is safe and ensures display_name + skill_level are set.
    const { error: profileError } = await supabase
      .from("profiles")
      .upsert(
        { id: userId, display_name: displayName, skill_level: skillLevel },
        { onConflict: "id" }
      );

    if (profileError) {
      profileErrors++;
      console.error(
        `[seedTestData] Profile upsert failed for player ${i} ("${displayName}", id=${userId}):`,
        profileError
      );
      // Roll back the auth user so we don't leave orphans.
      await supabase.auth.admin.deleteUser(userId);
      continue;
    }

    // ── Step 3: insert queue entry ────────────────────────────────────
    const { error: queueError } = await supabase
      .from("queue_entries")
      .upsert(
        {
          session_id: sessionId,
          player_id: userId,
          status: "waiting" as const,
          joined_at: joinedAt,
          games_played: gamesPlayed,
        },
        { onConflict: "session_id,player_id" }
      );

    if (queueError) {
      queueErrors++;
      console.error(
        `[seedTestData] Queue entry failed for player ${i} ("${displayName}", id=${userId}):`,
        queueError
      );
      continue;
    }

    inserted++;
  }

  console.log(
    `[seedTestData] Done. ${inserted}/${count} players inserted. ` +
      `auth errors=${authErrors}, profile errors=${profileErrors}, ` +
      `queue errors=${queueErrors}, bottlenecks=${bottleneckCount}`
  );

  if (inserted === 0) {
    return {
      success: false,
      message:
        "Seeded 0 players — check your Next.js terminal for [seedTestData] errors. " +
        `auth errors: ${authErrors}, profile errors: ${profileErrors}, queue errors: ${queueErrors}.`,
    };
  }

  return {
    success: true,
    message: `Seeded ${inserted} test players (${bottleneckCount} bottlenecks).`,
    playerCount: inserted,
  };
}

// ----------------------------------------------------------
// Seed Named Players (specific roster)
// ----------------------------------------------------------
// Creates exactly the 16 players specified by the organizer.
// All are treated as "new joiners": games_played = 0, joined_at = now.

const NAMED_PLAYERS: { name: string; skill: SkillLevel }[] = [
  { name: "Carl", skill: "lower_advanced" },
  { name: "Stelle", skill: "upper_intermediate" },
  { name: "Mariah", skill: "upper_beginner" },
  { name: "Jerg", skill: "intermediate" },
  { name: "Veejay", skill: "intermediate" },
  { name: "Keeeb", skill: "intermediate" },
  { name: "Rufel", skill: "upper_intermediate" },
  { name: "Bea", skill: "intermediate" },
  { name: "Mark", skill: "upper_intermediate" },
  { name: "Alvin", skill: "upper_intermediate" },
  { name: "Miggy", skill: "lower_advanced" },
  { name: "Ogie", skill: "upper_intermediate" },
  { name: "Jackie", skill: "intermediate" },
  { name: "JV", skill: "advanced" },
  { name: "Bianca", skill: "upper_beginner" },
  { name: "Chu", skill: "advanced" },
];

export async function seedNamedPlayers(sessionId: string): Promise<SeedResult> {
  // P1-5: Require authentication.
  const authErr = await requireAuth();
  if (authErr) return { success: false, message: authErr.error };

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[seedNamedPlayers] Failed to create service client:", msg);
    return { success: false, message: msg };
  }

  // Verify session exists and is active.
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("is_active", true)
    .single();

  if (sessionError || !session) {
    return { success: false, message: `Session lookup failed: ${sessionError?.message ?? "not found"}` };
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < NAMED_PLAYERS.length; i++) {
    const { name, skill } = NAMED_PLAYERS[i];
    const email = `player_${runId}_${name.toLowerCase().replace(/\s/g, "")}@seed.local`;

    // Step 1: Create auth user.
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { display_name: name, skill_level: skill },
    });

    if (authError || !authData?.user) {
      errors++;
      console.error(`[seedNamedPlayers] auth.admin.createUser failed for "${name}":`, authError);
      continue;
    }

    const userId = authData.user.id;

    // Step 2: Upsert profile.
    const { error: profileError } = await supabase
      .from("profiles")
      .upsert(
        { id: userId, display_name: name, skill_level: skill },
        { onConflict: "id" }
      );

    if (profileError) {
      errors++;
      console.error(`[seedNamedPlayers] Profile upsert failed for "${name}":`, profileError);
      await supabase.auth.admin.deleteUser(userId);
      continue;
    }

    // Step 3: Insert queue entry — new joiner (games_played: 0, joined_at: now).
    const { error: queueError } = await supabase
      .from("queue_entries")
      .upsert(
        {
          session_id: sessionId,
          player_id: userId,
          status: "waiting" as const,
          joined_at: now,
          games_played: 0,
        },
        { onConflict: "session_id,player_id" }
      );

    if (queueError) {
      errors++;
      console.error(`[seedNamedPlayers] Queue entry failed for "${name}":`, queueError);
      continue;
    }

    inserted++;
  }

  console.log(`[seedNamedPlayers] Done. ${inserted}/${NAMED_PLAYERS.length} players inserted. errors=${errors}`);

  if (inserted === 0) {
    return {
      success: false,
      message: `Seeded 0 players — check server logs. errors: ${errors}`,
    };
  }

  return {
    success: true,
    message: `Seeded ${inserted} named players (${NAMED_PLAYERS.length - inserted} failed).`,
    playerCount: inserted,
  };
}

// ----------------------------------------------------------
// Clear Session Data
// ----------------------------------------------------------
export interface ClearResult {
  success: boolean;
  message: string;
}

export async function clearSessionData(sessionId: string): Promise<ClearResult> {
  // P1-5: Require authentication.
  const authErr = await requireAuth();
  if (authErr) return { success: false, message: authErr.error };

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[clearSessionData] Failed to create service client:", msg);
    return { success: false, message: msg };
  }

  // Delete in dependency order: match_games → match_players → matches → queue_entries.
  // We keep profiles and the session itself intact.

  // 1. Get all match IDs for this session.
  const { data: matches, error: matchFetchError } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId);

  if (matchFetchError) {
    console.error("[clearSessionData] Failed to fetch matches:", matchFetchError);
  }

  const matchIds = (matches ?? []).map((m) => m.id);

  // 2. Delete match_games.
  if (matchIds.length > 0) {
    const { error } = await supabase
      .from("match_games")
      .delete()
      .in("match_id", matchIds);
    if (error) console.error("[clearSessionData] match_games delete error:", error);
  }

  // 3. Delete match_players.
  if (matchIds.length > 0) {
    const { error } = await supabase
      .from("match_players")
      .delete()
      .in("match_id", matchIds);
    if (error) console.error("[clearSessionData] match_players delete error:", error);
  }

  // 4. Delete matches.
  const { error: matchError } = await supabase
    .from("matches")
    .delete()
    .eq("session_id", sessionId);
  if (matchError) console.error("[clearSessionData] matches delete error:", matchError);

  // 5. Delete queue entries.
  const { error: queueError } = await supabase
    .from("queue_entries")
    .delete()
    .eq("session_id", sessionId);
  if (queueError) console.error("[clearSessionData] queue_entries delete error:", queueError);

  // 6. Reset all courts to available.
  const { error: courtError } = await supabase
    .from("courts")
    .update({ status: "available" as const })
    .eq("session_id", sessionId);
  if (courtError) console.error("[clearSessionData] courts reset error:", courtError);

  if (matchError || queueError) {
    return {
      success: false,
      message: `Partial clear: ${matchError?.message ?? ""} ${queueError?.message ?? ""}`.trim(),
    };
  }

  return {
    success: true,
    message: `Session data cleared. ${matchIds.length} matches and all queue entries removed. Courts reset.`,
  };
}
