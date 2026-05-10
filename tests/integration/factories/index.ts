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
  const name =
    displayName ?? `${faker.person.firstName()} ${faker.person.lastName()}`;
  const profilePin = pin ?? faker.string.numeric(4);

  // Create auth user (email-less anonymous-style user via admin API)
  const { data: authData, error: authError } =
    await client.auth.admin.createUser({
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
  const sessionName =
    name ?? `Integration Test Session ${faker.string.numeric(4)}`;

  // Only pass fields defined in SessionInsert
  // (is_active, is_auto_matchmaking_on, etc. use DB defaults)
  const { data: session, error: sessionError } = await client
    .from("sessions")
    .insert({
      name: sessionName,
      created_by: organizer,
      scoring,
    })
    .select("id, name")
    .single();

  if (sessionError || !session) {
    throw new Error(
      `[makeSession] Failed to insert session: ${sessionError?.message ?? "no data returned"}`
    );
  }

  // Insert the organizer into session_organizers
  const { error: orgError } = await client.from("session_organizers").insert({
    session_id: session.id,
    user_id: organizer,
  });

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
   * Valid values match the QueueStatus enum: "waiting" | "on_deck" | "playing" | "left"
   */
  status?: "waiting" | "on_deck" | "playing" | "left";
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
