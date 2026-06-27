// ============================================================
// Test Factories — Integration Tests
// ============================================================
// Composable helpers that create valid DB state for tests.
//
// All factories:
//   • Use the service-role Supabase client (bypasses RLS for setup)
//   • Track created auth.users via trackAuthUser() so truncateTracked()
//     cleans them up in afterEach without extra bookkeeping
//   • Use @faker-js/faker seeded with a fixed value at the top of
//     each test suite for reproducible UUIDs and display names
//
// USAGE:
//   import { Faker, en } from "@faker-js/faker";
//   import { makeProfile, makeSession } from "../factories";
//
//   const faker = new Faker({ locale: [en] });
//
//   beforeAll(() => {
//     faker.seed(12345); // deterministic per suite
//   });
//
//   it("does something", async () => {
//     const organizer = await makeProfile({ faker, skill: "intermediate" });
//     const session   = await makeSession({ faker, organizer: organizer.id });
//     // ...
//   });
// ============================================================

import { serviceClient, trackAuthUser } from "../helpers/truncate";
import type { SkillLevel, ScoringFormat } from "@/types/database";

/** Minimal Faker interface — avoids importing the full type in tests. */
export interface FakerLike {
  person: { firstName: () => string; lastName: () => string };
  string: { numeric: (len: number) => string };
}

// ── makeProfile ───────────────────────────────────────────────

export interface MakeProfileOptions {
  /** Faker instance for deterministic display names. */
  faker: FakerLike;
  /** Skill level for the profile. Defaults to "intermediate". */
  skill?: SkillLevel;
  /** Optional display name override. */
  displayName?: string;
  /** Optional PIN override. Defaults to a random 4-digit string. */
  pin?: string;
}

export interface ProfileResult {
  /** Supabase auth.users UUID (same as profiles.id). */
  id: string;
  /** The display name inserted into the profiles row. */
  displayName: string;
}

/**
 * Creates a Supabase auth user + corresponding profiles row.
 *
 * The auth user is created via auth.admin.createUser() so it
 * participates in RLS checks correctly. The profile row is upserted
 * immediately after.
 *
 * The auth user ID is tracked via trackAuthUser() and will be
 * deleted when truncateTracked() is called in afterEach.
 *
 * @returns The new profile's UUID and display name.
 */
export async function makeProfile({
  faker,
  skill = "intermediate",
  displayName,
  pin,
}: MakeProfileOptions): Promise<ProfileResult> {
  const client = serviceClient();
  const name = displayName ?? `${faker.person.firstName()} ${faker.person.lastName()}`;
  const profilePin = pin ?? faker.string.numeric(4);

  // Create auth user (email-less anonymous-style user via admin API)
  const { data: authData, error: authError } = await client.auth.admin.createUser({
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@integration.local`,
    password: "integration-test-password",
    email_confirm: true,
    user_metadata: { display_name: name },
  });

  if (authError || !authData.user) {
    throw new Error(
      `[makeProfile] Failed to create auth user: ${authError?.message ?? "no user returned"}`
    );
  }

  const userId = authData.user.id;

  // Track for cleanup in afterEach via truncateTracked()
  trackAuthUser(userId);

  // Upsert profile row (only fields defined in ProfileInsert)
  const { error: profileError } = await client.from("profiles").upsert(
    {
      id: userId,
      display_name: name,
      skill_level: skill,
      pin: profilePin,
    },
    { onConflict: "id" }
  );

  if (profileError) {
    throw new Error(
      `[makeProfile] Failed to upsert profile for ${userId}: ${profileError.message}`
    );
  }

  return { id: userId, displayName: name };
}

// ── makeSession ───────────────────────────────────────────────

export interface MakeSessionOptions {
  /** Faker instance for deterministic session names. */
  faker: FakerLike;
  /** UUID of the profile that owns the session. Must exist. */
  organizer: string;
  /** Session name override. Defaults to a generated name. */
  name?: string;
  /** Scoring format. Defaults to "single". */
  scoring?: ScoringFormat;
}

export interface SessionResult {
  /** The new session's UUID. */
  id: string;
  /** The session name. */
  name: string;
}

/**
 * Creates a session row and inserts the organizer into session_organizers.
 *
 * @returns The new session's UUID and name.
 */
export async function makeSession({
  faker,
  organizer,
  name,
  scoring = "single",
}: MakeSessionOptions): Promise<SessionResult> {
  const client = serviceClient();
  const sessionName = name ?? `Integration Test Session ${faker.string.numeric(4)}`;

  // Explicitly set is_auto_matchmaking_on=false so the engine does NOT
  // run automatically after cancelMatchAction / endMatchAction in tests
  // that don't need it. Tests that need the engine call enableAutoMatchmaking().
  // (Production default is true, but for isolated integration tests false is safer.)
  const { data: session, error: sessionError } = await client
    .from("sessions")
    .insert({
      name: sessionName,
      created_by: organizer,
      scoring,
      is_auto_matchmaking_on: false,
    })
    .select("id, name")
    .single();

  if (sessionError || !session) {
    throw new Error(
      `[makeSession] Failed to insert session: ${sessionError?.message ?? "no data returned"}`
    );
  }

  // Ensure the organizer is in session_organizers.
  // On local Supabase the on_session_created trigger already inserts this row,
  // so use upsert (ignoreDuplicates) to handle both cases: trigger fired or not.
  const { error: orgError } = await client
    .from("session_organizers")
    .upsert(
      { session_id: session.id, user_id: organizer },
      { onConflict: "session_id,user_id", ignoreDuplicates: true }
    );

  if (orgError) {
    throw new Error(
      `[makeSession] Failed to insert session_organizer for session ${session.id}: ${orgError.message}`
    );
  }

  return { id: session.id, name: sessionName };
}

// ── makeQueueEntry ────────────────────────────────────────────

export interface MakeQueueEntryOptions {
  /** Session UUID. */
  sessionId: string;
  /** Player UUID (must exist in profiles). */
  playerId: string;
  /**
   * Entry status. Defaults to "waiting".
   * Valid values match the QueueStatus enum.
   */
  status?: "waiting" | "drafted" | "on_deck" | "playing" | "left";
}

/**
 * Inserts a queue_entries row for the given player in the given session.
 */
export async function makeQueueEntry({
  sessionId,
  playerId,
  status = "waiting",
}: MakeQueueEntryOptions): Promise<{ id: string }> {
  const client = serviceClient();

  const { data: entry, error } = await client
    .from("queue_entries")
    .insert({
      session_id: sessionId,
      player_id: playerId,
      status,
    })
    .select("id")
    .single();

  if (error || !entry) {
    throw new Error(
      `[makeQueueEntry] Failed to insert queue entry: ${error?.message ?? "no data"}`
    );
  }

  return { id: entry.id };
}

// ── makeCourt ─────────────────────────────────────────────────

export interface MakeCourtOptions {
  /** Session UUID. */
  sessionId: string;
  /** Court name, e.g. "Court 1". */
  name: string;
  /** Court status. Defaults to "available". The engine ignores "closed" courts. */
  status?: "available" | "in_use" | "closed";
}

/**
 * Inserts a courts row for the given session.
 * The matchmaking engine requires at least one non-closed court to run.
 */
export async function makeCourt({
  sessionId,
  name,
  status = "available",
}: MakeCourtOptions): Promise<{ id: string }> {
  const client = serviceClient();

  const { data: court, error } = await client
    .from("courts")
    .insert({ session_id: sessionId, name, status })
    .select("id")
    .single();

  if (error || !court) {
    throw new Error(`[makeCourt] Failed to insert court: ${error?.message ?? "no data"}`);
  }

  return { id: court.id };
}

// ── makeMatch ─────────────────────────────────────────────────

export interface MakeMatchOptions {
  /** Session UUID. */
  sessionId: string;
  /** Team A player UUIDs — exactly 2. */
  teamA: [string, string];
  /** Team B player UUIDs — exactly 2. */
  teamB: [string, string];
  /** Optional court UUID. Defaults to null (on-deck / pending). */
  courtId?: string | null;
  /** Match status. Defaults to "pending". */
  status?: "pending" | "in_progress" | "completed" | "cancelled";
  /** Whether the match is published (visible to players). Defaults to false (draft). */
  isPublished?: boolean;
  /** Whether the match is mixed level. Defaults to false. */
  isMixedLevel?: boolean;
}

export interface MatchResult {
  /** The new match's UUID. */
  id: string;
}

/**
 * Inserts a match + 4 match_players rows.
 * Used to seed in-progress / completed / pending matches for testing
 * matchmaking partnership counts, TOCTOU guards, and close-session logic.
 */
export async function makeMatch({
  sessionId,
  teamA,
  teamB,
  courtId = null,
  status = "pending",
  isPublished = false,
  isMixedLevel = false,
}: MakeMatchOptions): Promise<MatchResult> {
  const client = serviceClient();

  const { data: match, error: matchError } = await client
    .from("matches")
    .insert({
      session_id: sessionId,
      court_id: courtId,
      status,
      is_published: isPublished,
      is_mixed_level: isMixedLevel,
      created_method: "manual",
    })
    .select("id")
    .single();

  if (matchError || !match) {
    throw new Error(`[makeMatch] Failed to insert match: ${matchError?.message ?? "no data"}`);
  }

  // Insert 4 match_players rows
  const players = [
    { match_id: match.id, player_id: teamA[0], team: "a" as const },
    { match_id: match.id, player_id: teamA[1], team: "a" as const },
    { match_id: match.id, player_id: teamB[0], team: "b" as const },
    { match_id: match.id, player_id: teamB[1], team: "b" as const },
  ];

  const { error: playersError } = await client.from("match_players").insert(players);

  if (playersError) {
    throw new Error(
      `[makeMatch] Failed to insert match_players for match ${match.id}: ${playersError.message}`
    );
  }

  return { id: match.id };
}

// ── makeCompletedMatch ────────────────────────────────────────

export interface MakeCompletedMatchOptions {
  /** Session UUID. */
  sessionId: string;
  /** Team A player UUIDs — exactly 2. */
  teamA: [string, string];
  /** Team B player UUIDs — exactly 2. */
  teamB: [string, string];
  /** Team A score. Defaults to 21. */
  scoreA?: number;
  /** Team B score. Defaults to 15. */
  scoreB?: number;
  /** Optional court UUID. */
  courtId?: string | null;
}

/**
 * Inserts a completed match with scores and match_players.
 * Used to seed session history for testing:
 *   • Partnership cap (fetchPartnershipCounts reads completed matches)
 *   • closeSession → refresh_cross_session_stats / compute_session_wrapped
 *   • Cross-session arithmetic tests
 */
export async function makeCompletedMatch({
  sessionId,
  teamA,
  teamB,
  scoreA = 21,
  scoreB = 15,
  courtId = null,
}: MakeCompletedMatchOptions): Promise<MatchResult> {
  const client = serviceClient();

  // Insert with only MatchInsert-compatible fields first
  const { data: match, error: matchError } = await client
    .from("matches")
    .insert({
      session_id: sessionId,
      court_id: courtId,
      status: "completed",
      is_published: true,
      is_mixed_level: false,
      created_method: "auto",
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();

  if (matchError || !match) {
    throw new Error(
      `[makeCompletedMatch] Failed to insert match: ${matchError?.message ?? "no data"}`
    );
  }

  // Update with score fields (MatchUpdate includes team_a_score, team_b_score, completed_at)
  const { error: updateError } = await client
    .from("matches")
    .update({
      team_a_score: scoreA,
      team_b_score: scoreB,
      completed_at: new Date().toISOString(),
    })
    .eq("id", match.id);

  if (updateError) {
    throw new Error(
      `[makeCompletedMatch] Failed to update scores for match ${match.id}: ${updateError.message}`
    );
  }

  const players = [
    { match_id: match.id, player_id: teamA[0], team: "a" as const },
    { match_id: match.id, player_id: teamA[1], team: "a" as const },
    { match_id: match.id, player_id: teamB[0], team: "b" as const },
    { match_id: match.id, player_id: teamB[1], team: "b" as const },
  ];

  const { error: playersError } = await client.from("match_players").insert(players);

  if (playersError) {
    throw new Error(
      `[makeCompletedMatch] Failed to insert match_players for match ${match.id}: ${playersError.message}`
    );
  }

  return { id: match.id };
}

// ── makeMatchViaRpc ───────────────────────────────────────────

export interface MakeMatchViaRpcOptions {
  /** Session UUID. */
  sessionId: string;
  /** Team A player UUIDs — exactly 2. Players must have status="waiting". */
  teamA: [string, string];
  /** Team B player UUIDs — exactly 2. Players must have status="waiting". */
  teamB: [string, string];
  /**
   * Whether to publish the match immediately.
   * false (default) = draft; RPC sets all 4 players to 'drafted'.
   * true = published on-deck; RPC sets all 4 players to 'on_deck'.
   */
  isPublished?: boolean;
}

/**
 * Creates a match by calling the `create_match_with_players` RPC directly.
 * Unlike makeMatch (which bypasses the RPC), this correctly updates
 * queue_entries.status: "drafted" for unpublished drafts, "on_deck" for published.
 *
 * Use this factory when testing the drafted-status lifecycle.
 * Use makeMatch when you need a match without touching queue statuses.
 */
export async function makeMatchViaRpc({
  sessionId,
  teamA,
  teamB,
  isPublished = false,
}: MakeMatchViaRpcOptions): Promise<MatchResult> {
  const client = serviceClient();

  const { data: matchId, error } = await client.rpc("create_match_with_players", {
    p_session_id: sessionId,
    p_court_id: null,
    p_status: "pending",
    p_is_mixed_level: false,
    p_started_at: null,
    p_is_on_deck: true,
    p_team_a_ids: teamA,
    p_team_b_ids: teamB,
    p_origin: "manual",
    p_is_published: isPublished,
  });

  if (error || !matchId) {
    throw new Error(
      `[makeMatchViaRpc] RPC failed: ${error?.message ?? "null match ID returned (TOCTOU guard fired?)"}`
    );
  }

  return { id: matchId as string };
}

// ── enableAutoMatchmaking ─────────────────────────────────────

/**
 * Enables auto-matchmaking for a session via direct DB update.
 * `SessionInsert` doesn't include `is_auto_matchmaking_on`, so
 * this helper updates it separately after session creation.
 */
export async function enableAutoMatchmaking(sessionId: string): Promise<void> {
  const { error } = await serviceClient()
    .from("sessions")
    .update({ is_auto_matchmaking_on: true })
    .eq("id", sessionId);
  if (error) {
    throw new Error(`[enableAutoMatchmaking] ${error.message}`);
  }
}

/**
 * Sets joined_at for a queue entry to a specific number of minutes ago.
 * Used to simulate Red Zone (> CRITICAL_WAIT_MINUTES = 25) or
 * last-resort fallback (> FALLBACK_WAIT_MINUTES = 15) scenarios.
 */
export async function ageQueueEntry(entryId: string, minutesAgo: number): Promise<void> {
  const joinedAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const { error } = await serviceClient()
    .from("queue_entries")
    .update({ joined_at: joinedAt })
    .eq("id", entryId);
  if (error) {
    throw new Error(`[ageQueueEntry] ${error.message}`);
  }
}
