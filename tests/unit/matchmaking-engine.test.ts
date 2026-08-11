// ============================================================
// Integration Tests: Matchmaking Engine — Supabase-Mocked Suite
// ============================================================
//
// Tests the three exported engine functions with mocked Supabase:
//
//   promoteOnDeckMatchInternal — takes client directly as a param.
//     Tests all branches: no pending match, CAS race, DB errors,
//     happy path (with and without matched players).
//
//   runEngineForSession — checks the toggle gate before running.
//     Tests: toggle OFF, toggle ON + 0 courts, toggle ON + at capacity,
//     session DB error.
//
//   callNextMatch — promotes oldest on-deck; if none + toggle ON,
//     runs engine inline then retries once.
//     Tests: on-deck exists (toggle bypass), no on-deck + toggle OFF,
//     no on-deck + toggle ON + empty queue.
//
// Mock strategy:
//   @/utils/supabase/service is replaced by vi.mock() and the returned
//   client is passed down to matchmaking-db helpers (fetchActivePool,
//   fetchSessionMatchSnapshot, executeMatch) which use it directly.
//   Each test builds a queue-based mock client where each from() call
//   consumes the next pre-configured response.
//   queriedTables tracks the DB table-access order for assertions.
//
// Per-slot query order inside runEngineInternal:
//   Promise.all (after courts): v_queue_with_wait_time [0], matches draft count [1],
//                               sessions [2]; auto mode adds a published on-deck count
//   soft gate (if triggered):   matches in_progress count
//   PER SLOT, at the top of each loop iteration — two independent reads issued
//   concurrently via Promise.all, so from() sees them in this fixed order:
//     fetchSessionMatchSnapshot: matches   (+ match_players, only if matches is non-empty)
//     fetchActivePool:           v_queue_with_wait_time
//   The recent rosters, partnership/opponent caps and the overlap map are then
//   DERIVED IN MEMORY from that one snapshot — they cost no further round trips.
//   executeMatch:               rpc("create_match_with_players")
//
// CAUTION when adding fixtures: because the snapshot short-circuits when the
// `matches` response is empty, a test whose history fixture is `{ data: [] }`
// never issues the match_players read, and every response after it shifts by
// one. Give a test a NON-empty matches fixture only if you have also supplied
// the match_players response that follows it (see ENG-SNAP-1).
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoist mock before any imports ─────────────────────────────
vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));
// after() (used for fire-and-forget push) runs synchronously in tests.
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => cb(),
}));
// Push delivery is out of scope here — stub it so the after() callback no-ops.
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
// Broadcast is stubbed so that "did the engine hit cap saturation?" is a POSITIVE
// assertion (ME-new-1) rather than a negative one that passes when nothing ran.
//
// It is NOT stubbed for credential safety, though that is the obvious guess:
// postBroadcast() reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
// process.env, and .env.test does hold the real values — but vitest.config.ts
// declares no `env` key and loads no dotenv, and Vite only surfaces VITE_-prefixed
// vars, so those names are UNSET under `vitest run` (probed on 4.1.5, 2026-08-04).
// Unmocked, postBroadcast would hit its missing-env guard and warn, not fetch.
// Keep that true: if anyone ever wires dotenv into the unit config, this mock
// becomes the only thing standing between a unit run and a live prod broadcast.
// callNextMatch now runs isSessionActive() between the organizer gate and the
// service client (the post-close write guard). Left real it would read
// sessions.is_active off the SAME ordered service-client mock every case below
// consumes by index, shifting all of them by one. Only that export is replaced —
// isSessionOrganizer stays real and is still driven by responses [0] and [1].
vi.mock("@/app/actions/_shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/actions/_shared")>()),
  isSessionActive: vi.fn(async () => true),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcastSessionClosed: vi.fn().mockResolvedValue(undefined),
  broadcastAutoMatchmakingToggled: vi.fn().mockResolvedValue(undefined),
  broadcastAutoPublishToggled: vi.fn().mockResolvedValue(undefined),
  broadcastCapSaturation: vi.fn().mockResolvedValue(undefined),
  broadcastDraftCapPhase: vi.fn().mockResolvedValue(undefined),
  broadcastOrganizerIntervention: vi.fn().mockResolvedValue(undefined),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isSessionActive } from "@/app/actions/_shared";
import {
  promoteOnDeckMatchInternal,
  runEngineForSession,
  callNextMatch,
  recomputeHeldReadiness,
} from "@/app/actions/matchmaking";
import { getDynamicDraftCap } from "@/lib/matchmaking-core";
import { fetchPullablePlayers, executeHeldMatch } from "@/lib/matchmaking-db";
import { broadcastCapSaturation } from "@/lib/broadcast";

// ─────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────

type MockResponse = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};

/**
 * Returns a chainable Supabase-like query builder that resolves to
 * the given response when awaited directly OR when .single() is called.
 *
 * All chain methods (select, eq, neq, in, or, order, limit, update, insert)
 * return the same builder so the full chain resolves to one response.
 */
function makeBuilder(response: MockResponse, recorder?: { update: unknown[]; insert: unknown[] }) {
  const b: Record<string, unknown> = {};

  // Capture mutation payloads so tests can assert WHAT was written, not just that
  // a call happened (QA-PROM-02 / QA-TRG-03). update()/insert() still return `b`.
  b["update"] = (arg: unknown) => {
    recorder?.update.push(arg);
    return b;
  };
  b["insert"] = (arg: unknown) => {
    recorder?.insert.push(arg);
    return b;
  };

  // Make the builder itself awaitable (for patterns that don't call .single())
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);

  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);

  // .single() returns a new Promise — same resolved value
  b["single"] = () => Promise.resolve(response);

  // All query chain methods return `b` unchanged.
  // NOTE: maybeSingle() must be here — callNextMatch uses it on the
  // session_organizers co-organizer lookup. Omitting it causes
  // TypeError if a test ever reaches that branch.
  for (const method of [
    "select",
    "eq",
    "neq",
    "in",
    "or",
    "order",
    "limit",
    "upsert",
    "maybeSingle",
    // Cross-court readiness/promotion operators (QA-PROM-01): recomputeHeldReadiness
    // and the held-draft scans use is()/gt()/contains(); add the common operators so
    // those chains don't TypeError.
    "is",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "containedBy",
    "overlaps",
    "filter",
  ]) {
    b[method] = (..._args: unknown[]) => b;
  }

  return b;
}

/**
 * Creates a mock Supabase client where each from() call pops the next
 * response from `fromResponses`, and each rpc() call pops the next
 * response from `rpcResponses`.
 *
 * `queriedTables` records the table name for each from() call so tests
 * can assert the order-of-queries (e.g. verify toggle bypass by checking
 * "sessions" does not appear after a successful promotion).
 *
 * NOTE: the engine no longer runs a per-helper join for match history. One
 * fetchSessionMatchSnapshot per slot reads the session's committed matches and
 * their rosters:
 *   Step 1: from("matches").eq("session_id", ...).in("status", COMMITTED)   — match IDs
 *   Step 2: from("match_players").in("match_id", ids)                       — rosters
 * Step 2 is skipped entirely when Step 1 comes back empty, so tests with empty
 * queues need exactly one `{ data: [], error: null }` here — not three.
 */
function makeMockClient(fromResponses: MockResponse[], rpcResponses: MockResponse[] = []) {
  let fromIdx = 0;
  let rpcIdx = 0;
  const queriedTables: string[] = [];
  const recorder: { update: unknown[]; insert: unknown[] } = { update: [], insert: [] };

  const from = vi.fn((table: string) => {
    queriedTables.push(table);
    const result = fromResponses[fromIdx++] ?? { data: null, error: null };
    return makeBuilder(result, recorder);
  });

  const rpc = vi.fn(() => {
    const result = rpcResponses[rpcIdx++] ?? { data: "new-match-id", error: null };
    return Promise.resolve(result);
  });

  // auth mock: needed by callNextMatch which calls userClient.auth.getUser()
  // before operating on the session. Returns a valid "test-user" by default.
  const auth = {
    getUser: vi.fn().mockResolvedValue({
      data: { user: { id: "test-user", email: "test@example.com" } },
      error: null,
    }),
  };

  return { from, rpc, queriedTables, auth, recorder };
}

// ── Test fixture UUIDs ─────────────────────────────────────────
// Valid v4 UUID format required so they pass the isValidUUID guard
// added in Wave 1 to callNextMatch and runEngineForSession.
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const COURT_ID = "00000000-0000-4000-8000-000000000002";

// Convenience for the most common match object returned by the pending query
const MOCK_MATCH = { id: "match-1", is_mixed_level: false };
const MOCK_MATCH_PLAYERS = [
  { player_id: "p1", team: "a" },
  { player_id: "p2", team: "a" },
  { player_id: "p3", team: "b" },
  { player_id: "p4", team: "b" },
];
const MOCK_PROFILES = [
  { id: "p1", display_name: "Alice" },
  { id: "p2", display_name: "Bob" },
  { id: "p3", display_name: "Charlie" },
  { id: "p4", display_name: "Diana" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// promoteOnDeckMatchInternal
// ─────────────────────────────────────────────────────────────
// Takes the Supabase client directly as a parameter —
// no createServerSupabaseClient mock needed for these tests.

describe("promoteOnDeckMatchInternal", () => {
  it("returns success:false when there is no pending match (empty array)", async () => {
    const mock = makeMockClient([
      { data: [], error: null }, // matches fetch → empty
      { count: 0, data: null, error: null }, // draft-blocking secondary check → 0 unpublished drafts
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no on-deck/i);
    // Initial pending fetch + secondary draft-blocking check both query "matches"
    expect(mock.queriedTables).toEqual(["matches", "matches"]);
  });

  it("returns hasDraftsBlocking:true when unpublished drafts are blocking the queue", async () => {
    // Draft Mode: when no published pending matches exist but there ARE unpublished drafts,
    // the organizer needs a contextual "review your drafts" signal rather than a generic
    // "no on-deck" message. Production sets hasDraftsBlocking=true so the UI can render
    // an amber warning toast instead of the default empty-state message.
    const mock = makeMockClient([
      { data: [], error: null }, // matches fetch → 0 published pending
      { count: 2, data: null, error: null }, // draft check → 2 unpublished drafts blocking
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.hasDraftsBlocking).toBe(true);
    // Message includes the draft count so the organizer knows how many to review
    expect(result.message).toMatch(/draft/i);
    expect(result.message).toContain("2");
    expect(mock.queriedTables).toEqual(["matches", "matches"]);
  });

  it("returns success:false with the DB error message surfaced (not masked as no-on-deck)", async () => {
    // A real DB error on the initial fetch is returned verbatim so the organizer
    // can distinguish a connectivity issue from an empty queue.
    // Production path: if (error) return { ..., message: `Failed to fetch on-deck matches: ${error.message}` }
    const mock = makeMockClient([
      { data: null, error: { message: "connection timeout" } }, // matches fetch → DB error
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    // Error path returns the real DB message — NOT the "no on-deck" fallback
    expect(result.message).toMatch(/failed to fetch/i);
  });

  it("returns success:false with 'already promoted' message on CAS race condition", async () => {
    // CAS race: another request already promoted the match.
    // The UPDATE affects 0 rows → .single() resolves with data:null, error:null.
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // matches fetch → 1 pending
      { data: MOCK_MATCH_PLAYERS, error: null }, // match_players (left-guard roster)
      { count: 0, data: null, error: null }, // queue_entries left-count → none left
      { data: null, error: null }, // matches update → 0 rows (CAS guard fails)
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already promoted/i);
    // Left-guard roster + left-count run before the (failed) CAS update.
    expect(mock.queriedTables).toEqual(["matches", "match_players", "queue_entries", "matches"]);
  });

  it("returns success:false with error detail on a DB error during the CAS update", async () => {
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // fetch
      { data: MOCK_MATCH_PLAYERS, error: null }, // match_players (left-guard roster)
      { count: 0, data: null, error: null }, // queue_entries left-count → none left
      { data: null, error: { message: "FK violation" } }, // update → DB error
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain("FK violation");
  });

  it("succeeds with empty match player list (no queue_entries update performed)", async () => {
    // Sequence: the left-guard fetches the roster (empty) + left-count first, then
    // CAS update, courts update, profiles. No playing-update since matchPlayers=[].
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // matches fetch
      { data: [], error: null }, // match_players (left-guard roster) → empty
      { count: 0, data: null, error: null }, // queue_entries left-count → none left
      { data: { id: "match-1" }, error: null }, // matches update (CAS passes)
      { data: null, error: null }, // courts update
      { data: [], error: null }, // profiles → empty
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
    expect(result.teamA).toEqual([]);
    expect(result.teamB).toEqual([]);
    expect(mock.queriedTables).toEqual([
      "matches", // fetch pending on-deck match
      "match_players", // left-guard roster (empty)
      "queue_entries", // left-count check
      "matches", // CAS status update
      "courts", // mark court occupied
      "profiles", // resolve display names (empty)
    ]);
  });

  it("succeeds and resolves player names into teamA and teamB", async () => {
    // Sequence: left-guard roster + left-count, then CAS update, courts update,
    // queue_entries playing-update (roster non-empty), profiles.
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // matches fetch
      { data: MOCK_MATCH_PLAYERS, error: null }, // match_players (left-guard roster)
      { count: 0, data: null, error: null }, // queue_entries left-count → none left
      { data: { id: "match-1" }, error: null }, // matches update (CAS passes)
      { data: null, error: null }, // courts update
      { data: null, error: null }, // queue_entries playing-update
      { data: MOCK_PROFILES, error: null }, // profiles
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.teamA).toEqual(["Alice", "Bob"]);
    expect(result.teamB).toEqual(["Charlie", "Diana"]);
    expect(mock.queriedTables).toEqual([
      "matches", // fetch pending on-deck match
      "match_players", // left-guard roster
      "queue_entries", // left-count check
      "matches", // CAS status update
      "courts", // mark court occupied
      "queue_entries", // players waiting → playing
      "profiles", // resolve display names
    ]);
  });

  it("passes through is_mixed_level=true from the match row", async () => {
    const mixedMatch = { id: "match-1", is_mixed_level: true };
    const mock = makeMockClient([
      { data: [mixedMatch], error: null }, // matches fetch
      { data: [], error: null }, // match_players (left-guard roster) → empty
      { count: 0, data: null, error: null }, // queue_entries left-count
      { data: { id: "match-1" }, error: null }, // matches update
      { data: null, error: null }, // courts update
      { data: [], error: null }, // profiles empty
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.isMixedLevel).toBe(true);
  });

  it("falls back to 'Unknown' for players whose profile is not found", async () => {
    // p3 and p4 are in match_players but NOT in profiles response
    const partialProfiles = [
      { id: "p1", display_name: "Alice" },
      { id: "p2", display_name: "Bob" },
      // p3, p4 missing from profiles
    ];
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // matches fetch
      { data: MOCK_MATCH_PLAYERS, error: null }, // match_players (left-guard roster)
      { count: 0, data: null, error: null }, // queue_entries left-count
      { data: { id: "match-1" }, error: null }, // matches update
      { data: null, error: null }, // courts update
      { data: null, error: null }, // queue_entries playing-update
      { data: partialProfiles, error: null }, // profiles
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.teamA).toEqual(["Alice", "Bob"]);
    // p3, p4 not in profiles → "Unknown"
    expect(result.teamB).toEqual(["Unknown", "Unknown"]);
  });
});

// ─────────────────────────────────────────────────────────────
// runEngineForSession
// ─────────────────────────────────────────────────────────────
// Called by toggle-ON events and after match completions.
// Gate: checks is_auto_matchmaking_on before doing any work.

describe("runEngineForSession", () => {
  it("returns early without querying courts when toggle is OFF", async () => {
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: false }, error: null }, // sessions
    ]);
    // runEngineForSession uses createServiceClient (service-role) internally — not createServerSupabaseClient.
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Only the sessions toggle check was made
    expect(mock.queriedTables).toEqual(["sessions"]);
  });

  it("queries courts when toggle is ON (proceeds into runEngineInternal)", async () => {
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [], error: null }, // courts → 0 courts
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // At least sessions + courts queried
    expect(mock.queriedTables).toContain("sessions");
    expect(mock.queriedTables).toContain("courts");
  });

  it("stops after courts query when courtCount is 0 (nothing to fill)", async () => {
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [], error: null }, // courts → 0
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Only sessions + courts queried: engine exits before the pending count check
    expect(mock.queriedTables).toEqual(["sessions", "courts"]);
  });

  it("stops filling when on-deck is already at capacity", async () => {
    // Promise.all([v_queue_with_wait_time, matches, sessions]) runs after courts.
    // waitingCount=0 → dynamicCap=3. draftCount=3 → slotsAvailable=0 → skipping.
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions (toggle)
      { data: [{ id: "c1" }, { id: "c2" }], error: null }, // courts (2)
      { data: [], error: null }, // v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 3, data: null, error: null }, // matches draft count=3 → slotsAvailable=0 (Promise.all[1])
      { data: { max_auto_drafts_override: null }, error: null }, // sessions override (Promise.all[2])
      { data: [], error: null }, // match_events — rejection memory, empty (Promise.all[3])
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Engine exits after parallel waiting+draft+session fetch: no queue/algorithm queries fired
    expect(mock.queriedTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
      "sessions",
      "match_events",
    ]);
  });

  it("returns gracefully when the session DB read fails", async () => {
    const mock = makeMockClient([
      { data: null, error: { message: "Table not found" } }, // sessions error
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    // Should not throw; only the sessions read was attempted before the error exit
    await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();
    expect(mock.queriedTables).toEqual(["sessions"]);
  });

  it("handles RPC failure in executeMatch without throwing — engine logs and exits cleanly", async () => {
    // Exercises the G-1 path: rpc("create_match_with_players") returns an error.
    // executeMatch → returns { success: false }. createOneOnDeckMatch → { created: false }.
    // runEngineInternal logs the error and breaks the fill loop.
    // runEngineForSession returns void — no crash, no rethrow.
    //
    // Query sequence (bypassGate=false):
    //   [0] sessions(ON)
    //   [1] courts(2)
    //   Promise.all:
    //   [2] v_queue_with_wait_time: 4 players, maxWait=10 ≥ GATE_HOLD_MINUTES=8
    //        → gateTimedOut=true → gate releases; estimatedWaiting=4 (Promise.all[0])
    //   [3] matches: draft count=0 → slotsAvailable=3 (Promise.all[1])
    //   [4] sessions: max_auto_drafts_override (Promise.all[2])
    //   slot 0 (i=0 exempt from pool-diversity cap):
    //   [5] matches: fetchSessionMatchSnapshot → [] (empty; no match_players hop follows)
    //   [6] v_queue_with_wait_time: fetchActivePool → 4 players (pool=4 ≥ 4 → continues)
    //       recentRosters / partnership counts / overlapMap all derive from the
    //       empty snapshot — zero further queries.
    //   → runAlgorithm(pool, counts, overlap, rosters) → proposal → executeMatch → rpc FAILS
    //   → loop breaks (slot 1: estimatedWaiting=4 < MIN_POOL=8 → cap fires anyway)
    const fourPlayers = Array.from({ length: 4 }, (_, i) => ({
      id: `entry-p${i}`,
      session_id: SESSION_ID,
      player_id: `p${i}`,
      joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      games_played: 0,
      status: "waiting" as const,
      position: null,
      is_paused: false,
      created_at: new Date().toISOString(),
      display_name: `Player ${i}`,
      skill_level: "intermediate" as const,
      skill_level_int: 4,
      wait_minutes: 10,
      is_bottleneck: false,
    }));

    const mock = makeMockClient(
      [
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions (toggle)
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts (2)
        { data: fourPlayers, error: null }, // [2] v_queue_with_wait_time: maxWait=10 → gateTimedOut (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=3 (Promise.all[1])
        { data: { max_auto_drafts_override: null }, error: null }, // [4] sessions override (Promise.all[2])
        { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
        { data: [], error: null }, // [6] fetchSessionMatchSnapshot: matches → []
        // (match_players not queried since the snapshot short-circuits on empty)
        { data: fourPlayers, error: null }, // [7] fetchActivePool: v_queue_with_wait_time → 4 players
        // rpc fails → loop breaks (slot 1 never reached — estimatedWaiting=4 < MIN_POOL=8)
      ],
      [{ data: null, error: { message: "unique constraint violation" } }] // rpc → error
    );
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    // Engine should not throw even when rpc fails
    await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();
    // rpc was called — engine reached executeMatch before failing
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledWith("create_match_with_players", expect.any(Object));
    // Origin tracking: engine always passes p_origin: "auto"
    expect(mock.rpc).toHaveBeenCalledWith(
      "create_match_with_players",
      expect.objectContaining({ p_origin: "auto" })
    );
  });

  it("ME-new-1: engine broadcasts cap saturation (not an error) when the partnership cap empties the candidate list", async () => {
    // Force capSaturation=true by supplying partnership counts that cap every
    // anchor-candidate pair. The pool has anchor (p0) + 3 candidates (p1, p2, p3),
    // all at the same skill so every skill window would pass — but the cap filter
    // removes p1, p2 and p3 before the window loop runs, leaving candidates=[].
    //
    // ⚠️ The pool MUST hold ≥ PLAYERS_PER_MATCH (4). runEngineInternal breaks out
    // of the slot at `pool.length < PLAYERS_PER_MATCH` (matchmaking.ts:503) BEFORE
    // derivePairCounts / deriveOverlapMap / runAlgorithm ever run — so a 3-player
    // pool makes capSaturation structurally unreachable and every assertion below
    // is then satisfied by the player-shortage abort instead. This test carried a
    // 3-player fixture for exactly that reason and passed for the wrong one.
    //
    // capWasActive = pool.length-1(3) > candidates.length(0) = true
    // → runAlgorithm returns { proposal: null, capSaturation: true }
    // → broadcastCapSaturation() is called (mocked at the top of this file)
    // → the else-branch console.error("no compatible match") is NOT reached.

    // Use wait_minutes=10 so maxWait(10) >= GATE_HOLD_MINUTES(8) → gateTimedOut=true
    // → gate releases without an extra active-court query, matching the existing
    // test pattern (4-player RPC failure test at ~line 428+).
    const cappedPool = [
      {
        id: "e-p0",
        session_id: SESSION_ID,
        player_id: "p0",
        joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        games_played: 0,
        status: "waiting" as const,
        position: null,
        is_paused: false,
        created_at: new Date().toISOString(),
        display_name: "Player 0",
        skill_level: "intermediate" as const,
        skill_level_int: 4,
        wait_minutes: 10,
        is_bottleneck: false,
      },
      {
        id: "e-p1",
        session_id: SESSION_ID,
        player_id: "p1",
        joined_at: new Date(Date.now() - 9 * 60_000).toISOString(),
        games_played: 0,
        status: "waiting" as const,
        position: null,
        is_paused: false,
        created_at: new Date().toISOString(),
        display_name: "Player 1",
        skill_level: "intermediate" as const,
        skill_level_int: 4,
        wait_minutes: 9,
        is_bottleneck: false,
      },
      {
        id: "e-p2",
        session_id: SESSION_ID,
        player_id: "p2",
        joined_at: new Date(Date.now() - 8 * 60_000).toISOString(),
        games_played: 0,
        status: "waiting" as const,
        position: null,
        is_paused: false,
        created_at: new Date().toISOString(),
        display_name: "Player 2",
        skill_level: "intermediate" as const,
        skill_level_int: 4,
        wait_minutes: 8,
        is_bottleneck: false,
      },
      {
        id: "e-p3",
        session_id: SESSION_ID,
        player_id: "p3",
        joined_at: new Date(Date.now() - 7 * 60_000).toISOString(),
        games_played: 0,
        status: "waiting" as const,
        position: null,
        is_paused: false,
        created_at: new Date().toISOString(),
        display_name: "Player 3",
        skill_level: "intermediate" as const,
        skill_level_int: 4,
        wait_minutes: 7,
        is_bottleneck: false,
      },
    ];

    // Session match history, read ONCE per slot by fetchSessionMatchSnapshot and
    // then projected in memory into recentRosters + partnership/opponent counts +
    // the overlap map. Here it puts p0 on the SAME TEAM as p1, p2 and p3 exactly
    // twice each, so every one of the anchor's three candidate pairs sits at
    // MAX_PARTNERSHIP_REPEATS (2) and the pre-filter at matchmaking-core.ts:849
    // empties the candidate list.
    //
    // derivePairCounts walks the WHOLE snapshot (no lookback window), so all six
    // matches count — unlike deriveOverlapMap, which stops at
    // ANTI_REPEAT_LOOKBACK.
    const matchRows = [
      { id: "m1" },
      { id: "m2" },
      { id: "m3" },
      { id: "m4" },
      { id: "m5" },
      { id: "m6" },
    ];
    const mpRows = [
      // m1 + m2: p0-p1 same team twice → p0-p1 count = 2 = MAX_PARTNERSHIP_REPEATS
      { match_id: "m1", player_id: "p0", team: "a" },
      { match_id: "m1", player_id: "p1", team: "a" },
      { match_id: "m1", player_id: "p2", team: "b" },
      { match_id: "m1", player_id: "p3", team: "b" },
      { match_id: "m2", player_id: "p0", team: "a" },
      { match_id: "m2", player_id: "p1", team: "a" },
      { match_id: "m2", player_id: "px", team: "b" },
      { match_id: "m2", player_id: "py", team: "b" },
      // m3 + m4: p0-p2 same team twice → p0-p2 count = 2
      { match_id: "m3", player_id: "p0", team: "a" },
      { match_id: "m3", player_id: "p2", team: "a" },
      { match_id: "m3", player_id: "p1", team: "b" },
      { match_id: "m3", player_id: "p3", team: "b" },
      { match_id: "m4", player_id: "p0", team: "a" },
      { match_id: "m4", player_id: "p2", team: "a" },
      { match_id: "m4", player_id: "px", team: "b" },
      { match_id: "m4", player_id: "py", team: "b" },
      // m5 + m6: p0-p3 same team twice → p0-p3 count = 2
      { match_id: "m5", player_id: "p0", team: "a" },
      { match_id: "m5", player_id: "p3", team: "a" },
      { match_id: "m5", player_id: "p1", team: "b" },
      { match_id: "m5", player_id: "p2", team: "b" },
      { match_id: "m6", player_id: "p0", team: "a" },
      { match_id: "m6", player_id: "p3", team: "a" },
      { match_id: "m6", player_id: "px", team: "b" },
      { match_id: "m6", player_id: "py", team: "b" },
    ];

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions (toggle)
      { data: [{ id: "c1" }], error: null }, // [1] courts (1)
      { data: cappedPool, error: null }, // [2] v_queue_with_wait_time: maxWait=10≥8 → gateTimedOut=true (Promise.all[0])
      { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=3 (Promise.all[1])
      { data: { max_auto_drafts_override: null }, error: null }, // [4] sessions override (Promise.all[2])
      { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
      // Slot 1 read phase — snapshot and pool are issued concurrently, so from()
      // sees matches → v_queue_with_wait_time → match_players (the roster read is
      // the snapshot's second hop and lands after the pool's synchronous from()).
      { data: matchRows, error: null }, // [6] fetchSessionMatchSnapshot: committed match IDs
      { data: cappedPool, error: null }, // [7] fetchActivePool: v_queue_with_wait_time
      { data: mpRows, error: null }, // [8] fetchSessionMatchSnapshot: roster rows
      // recentRosters, partnership/opponent counts and the overlap map are all
      // derived from [5]+[7] — no further queries.
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // POSITIVE proof the cap-saturation branch was the one taken. Without this,
    // every other assertion in this test is satisfied just as well by the engine
    // bailing out early — which is exactly what the 3-player fixture used to do.
    expect(broadcastCapSaturation).toHaveBeenCalledTimes(1);
    expect(broadcastCapSaturation).toHaveBeenCalledWith(SESSION_ID, {
      type: "general", // anchor waits 10min → priorityScore < RED_ZONE_SCORE_FLOOR
      anchorPlayerId: "p0",
      anchorPlayerName: "Player 0",
    });

    // The sibling else-branch must NOT have fired: cap saturation and
    // "skill spread or diversity exhausted" are mutually exclusive (see ME-new-2).
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("no compatible match"));

    // Pin the read that makes the caps real: the roster hop must have run (proving
    // the snapshot was non-empty), and no match may be created out of a saturated
    // pool. The burst stops after slot 1 because !proposal breaks the loop, so the
    // sequence is 9 entries even though slotsAvailable is 3.
    expect(mock.queriedTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
      "sessions",
      "match_events",
      "matches",
      "v_queue_with_wait_time",
      "match_players",
    ]);
    expect(mock.rpc).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("ME-new-2: console.error logged when runAlgorithm returns no match with capSaturation=false (skill/diversity exhaustion)", async () => {
    // 8 players where anchor (skill=1) and all others (skill=9) are so far apart
    // that no skill window covers them. Wait times < FALLBACK_WAIT_MINUTES (15 min)
    // so the fallback also doesn't fire. No partnership caps active.
    // → runAlgorithm returns { proposal: null, capSaturation: false }
    // → the else-branch fires: console.error("...no compatible match...")

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // 8 players: pool=8 > GATE_POOL_THRESHOLD(4) so the soft gate doesn't hold.
    const eightExtremes = Array.from({ length: 8 }, (_, i) => ({
      id: `e-x${i}`,
      session_id: SESSION_ID,
      player_id: i === 0 ? "pa" : `px${i}`,
      joined_at: new Date(Date.now() - (8 - i) * 60_000).toISOString(),
      games_played: 0,
      status: "waiting" as const,
      position: null,
      is_paused: false,
      created_at: new Date().toISOString(),
      display_name: i === 0 ? "Anchor" : `Player ${i}`,
      skill_level: i === 0 ? ("beginner" as const) : ("advanced" as const),
      skill_level_int: i === 0 ? 1 : 9, // extreme spread: |9-1|=8 > max window of 4
      wait_minutes: 8 - i,
      is_bottleneck: false,
    }));

    const mock2 = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions (toggle)
      { data: [{ id: "c1" }], error: null }, // [1] courts (1)
      { data: eightExtremes, error: null }, // [2] v_queue_with_wait_time: 8 players (Promise.all[0])
      { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=2 (Promise.all[1])
      { data: { max_auto_drafts_override: null }, error: null }, // [4] sessions override (Promise.all[2])
      { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
      { data: [], error: null }, // [6] fetchSessionMatchSnapshot: matches → [] (short-circuits)
      { data: eightExtremes, error: null }, // [7] fetchActivePool: pool=8
      // runAlgorithm: anchor skill=1, candidates skill=9 → |9-1|=8 > max Red Zone window(4)
      // → { proposal: null, capSaturation: false } → console.error logged
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock2 as never);

    await runEngineForSession(SESSION_ID);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("no compatible match"));

    consoleSpy.mockRestore();
  });

  it("pool diversity cap limits second on-deck slot when remaining pool falls below threshold", async () => {
    // Fix 1: pool diversity cap prevents over-committing the free pool.
    // slotsAvailable = 3 (0 total pending → MAX_AUTO_DRAFTS=3 − 0 = 3, single atomic query).
    // waitingCount = 8: soft gate not triggered (8 > GATE_POOL_THRESHOLD=4).
    //
    // Slot 0 (i=0): exempt from pool-diversity cap → fetchActivePool(8) → runAlgorithm → RPC succeeds → estimatedWaiting=4.
    // Slot 1 (i=1): cap check: i>0 && estimatedWaiting(4) < PLAYERS_PER_MATCH(4)+MIN_FREE_POOL(4)=8
    //               → cap fires → break (slotsAvailable=3 not reached).
    //
    // Result: only 1 match created even though 3 slots were available.
    const eightPlayers = Array.from({ length: 8 }, (_, i) => ({
      id: `entry-p${i}`,
      session_id: SESSION_ID,
      player_id: `p${i}`,
      joined_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      games_played: 0,
      status: "waiting" as const,
      position: null,
      is_paused: false,
      created_at: new Date().toISOString(),
      display_name: `Player ${i}`,
      skill_level: "intermediate" as const,
      skill_level_int: 4,
      wait_minutes: 5,
      is_bottleneck: false,
    }));

    const mock = makeMockClient(
      [
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions (toggle)
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts (2)
        { data: eightPlayers, error: null }, // [2] v_queue_with_wait_time (estimatedWaiting=8) (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=3 (Promise.all[1])
        { data: { max_auto_drafts_override: null }, error: null }, // [4] sessions override (Promise.all[2])
        { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
        { data: [], error: null }, // [6] fetchSessionMatchSnapshot: matches → [] (short-circuits)
        { data: eightPlayers, error: null }, // [7] fetchActivePool: v_queue_with_wait_time → 8 players
        // runAlgorithm → proposal → rpc succeeds → estimatedWaiting=8-4=4
        // slot 1: estimatedWaiting(4) < MIN_POOL(8) → cap fires → break
      ],
      [{ data: "new-match-id", error: null }] // rpc → success for slot 0
    );
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Slot 0 created a match, slot 1 was blocked by the pool diversity cap.
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// getDynamicDraftCap — direct unit tests
// ─────────────────────────────────────────────────────────────
// Pure function — no DB calls, no mock setup needed.
// Pins exact tier thresholds so a constant change is caught
// immediately, with clear failure messages (not "engine behavior").

describe("getDynamicDraftCap", () => {
  it.each([
    [0, 3],
    [1, 3],
    [24, 3], // just below DRAFT_CAP_LARGE_THRESHOLD (25)
    [25, 5], // at DRAFT_CAP_LARGE_THRESHOLD
    [29, 5], // just below DRAFT_CAP_XLARGE_THRESHOLD (30)
    [30, 6], // at DRAFT_CAP_XLARGE_THRESHOLD
    [100, 6], // well above xlarge threshold
  ])("waitingCount=%i → cap=%i", (waitingCount, expected) => {
    expect(getDynamicDraftCap(waitingCount)).toBe(expected);
  });
});

// ── Override cap applied as ceiling ──────────────────────────
// EO-1  max_auto_drafts_override=2 with dynamic=3 → slotsAvailable=max(0,2-draftCount)
// EO-2  max_auto_drafts_override=5 with dynamic=3 → dynamic wins → effectiveCap=3

describe("runEngineForSession — max_auto_drafts_override ceiling", () => {
  it("EO-1: override=2 with dynamic=3 → effectiveCap=2, engine stops at 2 drafts", async () => {
    // waitingCount=0 → dynamicCap=3. Override=2 → effectiveCap=min(2,3)=2.
    // draftCount=2 → slotsAvailable=max(0,2-2)=0 → engine exits immediately.
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions (toggle)
      { data: [{ id: "c1" }], error: null }, // [1] courts (1)
      { data: [], error: null }, // [2] v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 2, data: null, error: null }, // [3] matches draft count=2 (Promise.all[1])
      { data: { max_auto_drafts_override: 2 }, error: null }, // [4] sessions override=2 (Promise.all[2])
      // effectiveCap=min(2,3)=2; slotsAvailable=max(0,2-2)=0 → skip
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Engine must have stopped without attempting any match creation
    expect(mock.rpc).not.toHaveBeenCalled();
    // Only 6 tables queried: sessions, courts, v_queue, matches, sessions, match_events
    expect(mock.queriedTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
      "sessions",
      "match_events",
    ]);
  });

  it("EO-2: override=5 with dynamic=3 (small pool) → effectiveCap=3, dynamic wins", async () => {
    // waitingCount=0 → dynamicCap=3. Override=5 → effectiveCap=min(5,3)=3.
    // draftCount=3 → slotsAvailable=max(0,3-3)=0 → engine exits immediately.
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null },
      { data: [{ id: "c1" }], error: null },
      { data: [], error: null },
      { count: 3, data: null, error: null },
      { data: { max_auto_drafts_override: 5 }, error: null }, // override=5 but dynamic=3 wins
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    expect(mock.rpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// callNextMatch
// ─────────────────────────────────────────────────────────────
// Organizer action: promotes oldest on-deck, or runs engine
// inline (toggle-gated) if the on-deck queue is empty.
//
// Critical behaviour: when promotion SUCCEEDS, runEngineInternal
// is called DIRECTLY — bypassing the toggle check entirely.
// This guarantees one slot is always refilled after promotion,
// even if auto-matchmaking was subsequently toggled OFF.

describe("callNextMatch", () => {
  // callNextMatch now passes the service client to both promoteOnDeckMatchInternal
  // and runEngineInternal. The user client (createServerSupabaseClient) is used only for:
  //   1. auth.getUser() (always, no from() call)
  //   2. sessions toggle check (only when promotion fails)
  //
  // serviceMock response layout for success cases:
  //   [0]   sessions → organizer auth gate
  //   [1]   matches fetch (promoteOnDeckMatchInternal)
  //   [2]   matches update / CAS (promoteOnDeckMatchInternal)
  //   [3]   courts update (promoteOnDeckMatchInternal)
  //   [4]   match_players fetch (promoteOnDeckMatchInternal)
  //   [5]   profiles fetch (promoteOnDeckMatchInternal)
  //   [6+]  runEngineInternal calls

  it("returns success when an on-deck match is promoted successfully", async () => {
    // After promotion, runEngineInternal runs: courts → Promise.all([v_queue, matches]).
    // waitingCount=0 → dynamicCap=3. draftCount=3 → slotsAvailable=0 → engine exits.
    // match_players=[] → no queue_entries update → profiles called with empty ids → [].
    const mock = makeMockClient([
      // user client only used for toggle-check sessions; promotion succeeds → never reached
    ]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions (created_by → true)
      { data: null, error: null }, // [1] isSessionOrganizer: session_organizers (parallel co-org probe)
      { data: [MOCK_MATCH], error: null }, // [2] matches fetch → pending non-empty
      { data: [], error: null }, // [3] match_players (left-guard roster) → empty
      { count: 0, data: null, error: null }, // [4] queue_entries left-count → none left
      { data: { id: "match-1" }, error: null }, // [5] matches update (CAS)
      { data: null, error: null }, // [6] courts update
      { data: [], error: null }, // [7] profiles → empty (no player ids)
      { data: { is_auto_matchmaking_on: true }, error: null }, // [8] runEngineForSession toggle → ON
      { data: [{ id: "c1" }], error: null }, // [9] runEngineInternal: courts
      { data: [], error: null }, // [10] runEngineInternal: v_queue (Promise.all[0])
      { count: 3, data: null, error: null }, // [11] runEngineInternal: matches draft count=3 (Promise.all[1])
      { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [12] sessions (Promise.all[2])
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
  });

  it("toggle respected: after successful promotion, engine refills via runEngineForSession (checks toggle)", async () => {
    // Fix ded7697: callNextMatch previously called runEngineInternal directly after promotion,
    // bypassing the is_auto_matchmaking_on toggle. It now calls runEngineForSession, which
    // checks the toggle first. The first post-promotion service query is therefore "sessions"
    // (toggle read), NOT "courts" as it was before the fix.
    //
    // Query order after promotion ([0]-[5]):
    //   [6] sessions → runEngineForSession toggle check → ON
    //   [7] courts   → runEngineInternal proceeds
    //   [8] v_queue  → waitingCount (Promise.all[0])
    //   [9] matches  → draftCount=3 → slotsAvailable=0 (Promise.all[1])
    const mock = makeMockClient([
      // user client → no from() calls when promotion succeeds
    ]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions (created_by → true)
      { data: null, error: null }, // [1] isSessionOrganizer: session_organizers (parallel co-org probe)
      { data: [MOCK_MATCH], error: null }, // [2] matches fetch → pending non-empty
      { data: [], error: null }, // [3] match_players (left-guard roster) → empty
      { count: 0, data: null, error: null }, // [4] queue_entries left-count → none left
      { data: { id: "match-1" }, error: null }, // [5] matches update (CAS)
      { data: null, error: null }, // [6] courts update
      { data: [], error: null }, // [7] profiles → empty
      { data: { is_auto_matchmaking_on: true }, error: null }, // [8] sessions → toggle ON
      { data: [{ id: "c1" }], error: null }, // [9] courts → engine proceeds
      { data: [], error: null }, // [10] v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 3, data: null, error: null }, // [11] matches draft count=3 → slotsAvailable=0 (Promise.all[1])
      { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [12] sessions (Promise.all[2])
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    await callNextMatch(SESSION_ID, COURT_ID);

    // [8] must be "sessions" — confirms runEngineForSession (not runEngineInternal) was called.
    // (isSessionOrganizer adds sessions + session_organizers, and the left-player guard adds
    //  match_players + queue_entries inside promote, so the toggle check now lands at index 8.)
    expect(serviceMock.queriedTables[8]).toBe("sessions");
    // Post-promotion sequence: sessions (toggle) → courts → v_queue → matches →
    // sessions (override) → match_events (rejection memory).
    const postPromotionTables = serviceMock.queriedTables.slice(8);
    expect(postPromotionTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
      "sessions",
      "match_events",
    ]);
  });

  it("returns 'paused' message when no on-deck match exists and toggle is OFF", async () => {
    // promoteOnDeckMatchInternal: matches → empty → draft-blocking check → 0 drafts.
    // Then service client toggle check: sessions → OFF → return paused message.
    // Note: is_auto_matchmaking_on is now read via service client (not RLS client)
    // so co-organizers (blocked by sessions RLS SELECT) also get the correct value.
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions (created_by → true)
      { data: null, error: null }, // [1] isSessionOrganizer: session_organizers (parallel co-org probe)
      { data: [], error: null }, // [2] matches fetch → empty
      { count: 0, data: null, error: null }, // [3] draft-blocking check → 0 drafts
      { data: { is_auto_matchmaking_on: false }, error: null }, // [4] toggle check → OFF
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/paused|auto-matchmaking/i);
  });

  it("propagates hasDraftsBlocking when drafts are blocking after engine inline run", async () => {
    // Attempt 1: no published pending + 2 drafts → hasDraftsBlocking=true
    // Toggle check (service client): sessions → ON
    // runEngineInternal: courts [c1], pending=2 → slotsAvailable=1 → tries to fill
    // runAlgorithm: empty queue → stops
    // Attempt 2: no published pending + 2 drafts → hasDraftsBlocking=true
    // callNextMatch propagates hasDraftsBlocking:true
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions (created_by → true)
      { data: null, error: null }, // [1] isSessionOrganizer: session_organizers (parallel co-org probe)
      { data: [], error: null }, // [2] promote 1: no published pending
      { count: 2, data: null, error: null }, // [3] promote 1: 2 drafts → hasDraftsBlocking
      { data: { is_auto_matchmaking_on: true }, error: null }, // [4] toggle check → ON
      { data: [{ id: "c1" }], error: null }, // [5] runEngine: courts
      { data: [], error: null }, // [6] runEngine: v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 2, data: null, error: null }, // [7] runEngine: matches draft count=2 → slotsAvailable=1 (Promise.all[1])
      { data: { max_auto_drafts_override: null }, error: null }, // [8] runEngine: sessions override (Promise.all[2])
      { data: [], error: null }, // [9] match_events — rejection memory, empty (Promise.all[3])
      { data: [], error: null }, // [10] runEngine: fetchSessionMatchSnapshot matches → []
      { data: [], error: null }, // [11] fetchActivePool: v_queue_with_wait_time → [] (pool < 4 → break)
      { data: [], error: null }, // [12] promote 2: no published pending
      { count: 2, data: null, error: null }, // [13] promote 2: 2 drafts → hasDraftsBlocking
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.hasDraftsBlocking).toBe(true);
    expect(result.message).not.toMatch(/not enough players/i);
    expect(result.message).toMatch(/draft/i);
  });

  it("returns 'not enough players' when toggle is ON but queue is empty", async () => {
    // Attempt 1: empty pending + 0 drafts
    // Toggle check (service client): sessions → ON
    // runEngineInternal: courts [c1], pending=0 → slotsAvailable=3 → tries to fill
    // runAlgorithm: empty queue → "Not enough active players"
    // Attempt 2: still empty pending + 0 drafts
    // hasDraftsBlocking=false → "not enough players"
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions (created_by → true)
      { data: null, error: null }, // [1] isSessionOrganizer: session_organizers (parallel co-org probe)
      { data: [], error: null }, // [2] promote 1: no pending
      { count: 0, data: null, error: null }, // [3] promote 1: 0 drafts
      { data: { is_auto_matchmaking_on: true }, error: null }, // [4] toggle check → ON
      { data: [{ id: "c1" }], error: null }, // [5] runEngine: courts
      { data: [], error: null }, // [6] runEngine: v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 0, data: null, error: null }, // [7] runEngine: matches draft count=0 → slotsAvailable=3 (Promise.all[1])
      { data: { max_auto_drafts_override: null }, error: null }, // [8] runEngine: sessions override (Promise.all[2])
      { data: [], error: null }, // [9] runEngine: fetchSessionMatchSnapshot matches → []
      { data: [], error: null }, // [10] fetchActivePool: v_queue_with_wait_time → [] (pool < 4 → break)
      { data: [], error: null }, // [11] promote 2: still no pending
      { count: 0, data: null, error: null }, // [12] promote 2: 0 drafts
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not enough players/i);
  });

  it("refuses to promote once the session is closed (post-close write guard)", async () => {
    // A co-organizer's stale board firing Call Next after someone else closed
    // the session: it must stop at the gate, before any court re-opens or any
    // queue entry moves back to "playing".
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions
      { data: null, error: null }, // [1] isSessionOrganizer: session_organizers
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);
    vi.mocked(isSessionActive).mockResolvedValueOnce(false);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/session has ended/i);
    // Only the organizer gate touched the DB — no promote, no engine refill.
    expect(serviceMock.queriedTables).toEqual(["sessions", "session_organizers"]);
  });
});

// ═════════════════════════════════════════════════════════════
// AUTO-PUBLISH MODE — engine writes is_published per session.auto_publish
// ═════════════════════════════════════════════════════════════
//
// ENG-AP-1  auto_publish=true  → executeMatch RPC called with p_is_published=true
//           (and the cap counts the PUBLISHED on-deck set — an extra count query)
// ENG-AP-2  auto_publish=false → RPC called with p_is_published=false (draft, regression)

describe("runEngineForSession — auto-publish mode (ENG-AP)", () => {
  // Four waiting players, maxWait=10 ≥ GATE_HOLD_MINUTES so the soft gate releases
  // and the engine proceeds to generate a match (cloned from the G-1 RPC-failure setup).
  const fourWaiting = () =>
    Array.from({ length: 4 }, (_, i) => ({
      id: `entry-p${i}`,
      session_id: SESSION_ID,
      player_id: `p${i}`,
      joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      games_played: 0,
      status: "waiting" as const,
      position: null,
      is_paused: false,
      created_at: new Date().toISOString(),
      display_name: `Player ${i}`,
      skill_level: "intermediate" as const,
      skill_level_int: 4,
      wait_minutes: 10,
      is_bottleneck: false,
    }));

  it("ENG-AP-1: auto_publish=true → RPC gets p_is_published=true; cap re-count runs (published + held)", async () => {
    const four = fourWaiting();
    const mock = makeMockClient(
      [
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] toggle ON
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts
        { data: four, error: null }, // [2] v_queue (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] unpublished draft count (Promise.all[1])
        { data: { max_auto_drafts_override: null, auto_publish: true }, error: null }, // [4] session (Promise.all[2])
        { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
        { count: 0, data: null, error: null }, // [6] PUBLISHED on-deck count (auto-mode extra)
        { data: [], error: null }, // [7] fetchSessionMatchSnapshot matches (empty ⇒ short-circuits)
        { data: four, error: null }, // [8] fetchActivePool v_queue
        // No history ⇒ no match_players read, and the rosters / pair counts /
        // overlap map all derive from the empty snapshot with zero further queries.
      ],
      [{ data: null, error: { message: "stop after one slot" } }] // rpc → error to break the loop
    );
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();
    expect(mock.rpc).toHaveBeenCalledWith(
      "create_match_with_players",
      expect.objectContaining({ p_is_published: true, p_origin: "auto" })
    );
    // Auto mode counts the published on-deck set: a 2nd matches count query runs in
    // the cap phase (unpublished [3] + published [6]) before the slot loop starts.
    // The whole array is pinned, not a slice, so the merged per-slot read phase
    // ([7] snapshot + [8] pool, concurrent) can't silently regain a 3rd round trip.
    expect(mock.queriedTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
      "sessions",
      "match_events", // rejection memory (Promise.all[3])
      "matches",
      "matches", // slot 1 — fetchSessionMatchSnapshot (empty ⇒ no match_players)
      "v_queue_with_wait_time", // slot 1 — fetchActivePool
    ]);
  });

  it("ENG-AP-2: auto_publish=false → RPC gets p_is_published=false (draft mode regression)", async () => {
    const four = fourWaiting();
    const mock = makeMockClient(
      [
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] toggle ON
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts
        { data: four, error: null }, // [2] v_queue (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] unpublished draft count (Promise.all[1])
        { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [4] session (Promise.all[2])
        { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
        // no published-count query in draft mode
        { data: [], error: null }, // [6] fetchSessionMatchSnapshot matches (empty ⇒ short-circuits)
        { data: four, error: null }, // [7] fetchActivePool v_queue
      ],
      [{ data: null, error: { message: "stop after one slot" } }]
    );
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();
    expect(mock.rpc).toHaveBeenCalledWith(
      "create_match_with_players",
      expect.objectContaining({ p_is_published: false, p_origin: "auto" })
    );
  });
});

// ═════════════════════════════════════════════════════════════
// CALL NEXT — bypassGate publish override (ENG-BP)
// ═════════════════════════════════════════════════════════════
//
// The draft-mode dead end (verified live on 08/06): callNextMatch runs the
// engine with bypassGate=true, but the match inherited the session's
// auto_publish=false, was born unpublished, and the promotion retry — which
// only considers is_published=true — found nothing. The primary live-gym
// button composed a match it could never seat.
//
// ENG-BP-1  bypassGate + draft mode → slot 0 RPC gets p_is_published=true
//           AND the promotion retry seats it (end-to-end acceptance)
// ENG-BP-2  bypassGate + draft mode → slots 1+ STAY drafts (review flow
//           governs everything beyond the one match being seated)

describe("callNextMatch — bypassGate publish override (ENG-BP)", () => {
  const fourWaiting = (offset = 0) =>
    Array.from({ length: 4 }, (_, i) => ({
      id: `entry-p${offset + i}`,
      session_id: SESSION_ID,
      player_id: `p${offset + i}`,
      joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      games_played: 0,
      status: "waiting" as const,
      position: null,
      is_paused: false,
      created_at: new Date().toISOString(),
      display_name: `Player ${offset + i}`,
      skill_level: "intermediate" as const,
      skill_level_int: 4,
      wait_minutes: 10,
      is_bottleneck: false,
    }));

  it("ENG-BP-1: draft mode + Call Next → slot-0 match born published and seated by the promotion retry", async () => {
    const four = fourWaiting();
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient(
      [
        { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions
        { data: null, error: null }, // [1] isSessionOrganizer: session_organizers (co-org probe)
        { data: [], error: null }, // [2] promote 1: no published pending
        { count: 0, data: null, error: null }, // [3] promote 1: draft-blocking check → none
        { data: { is_auto_matchmaking_on: true }, error: null }, // [4] toggle → ON
        { data: [{ id: "c1" }], error: null }, // [5] runEngine: courts
        { data: four, error: null }, // [6] v_queue → waitingCount=4 (Promise.all[0])
        { count: 0, data: null, error: null }, // [7] unpublished draft count=0 (Promise.all[1])
        { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [8] session — DRAFT MODE (Promise.all[2])
        { data: [], error: null }, // [9] match_events — rejection memory, empty (Promise.all[3])
        // bypassGate → soft gate + pool caps skipped; draft mode → no published-count query
        { data: [], error: null }, // [10] slot 0: fetchSessionMatchSnapshot (empty ⇒ no match_players)
        { data: four, error: null }, // [11] slot 0: fetchActivePool
        // rpc[0] succeeds → slot 0 committed PUBLISHED (the fix under test)
        { data: [], error: null }, // [12] slot 1: fetchSessionMatchSnapshot (empty)
        { data: [], error: null }, // [13] slot 1: fetchActivePool → pool < 4 → loop breaks
        { data: [{ ...MOCK_MATCH, id: "new-match-id" }], error: null }, // [14] promote 2: published pending → THE slot-0 match
        { data: [], error: null }, // [15] promote 2: match_players (left-guard roster)
        { count: 0, data: null, error: null }, // [16] promote 2: queue_entries left-count
        { data: { id: "new-match-id" }, error: null }, // [17] promote 2: matches update (CAS)
        { data: null, error: null }, // [18] promote 2: courts update
        { data: [], error: null }, // [19] promote 2: profiles
      ],
      [{ data: "new-match-id", error: null }] // rpc[0]: create_match_with_players succeeds
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    // The fix: despite auto_publish=false, the bypassGate slot-0 match is born
    // published — promotable by the retry that follows immediately.
    expect(serviceMock.rpc).toHaveBeenCalledWith(
      "create_match_with_players",
      expect.objectContaining({ p_is_published: true, p_origin: "auto" })
    );
    expect(result.success).toBe(true);
    expect(result.matchId).toBe("new-match-id");
  });

  it("ENG-BP-2: bypassGate slots 1+ stay drafts — only the match being seated skips review", async () => {
    const four = fourWaiting();
    const fourMore = fourWaiting(4);
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient(
      [
        { data: { created_by: "test-user" }, error: null }, // [0] isSessionOrganizer: sessions
        { data: null, error: null }, // [1] isSessionOrganizer: session_organizers
        { data: [], error: null }, // [2] promote 1: no published pending
        { count: 0, data: null, error: null }, // [3] promote 1: draft-blocking check → none
        { data: { is_auto_matchmaking_on: true }, error: null }, // [4] toggle → ON
        { data: [{ id: "c1" }], error: null }, // [5] runEngine: courts
        { data: four, error: null }, // [6] v_queue (Promise.all[0])
        { count: 0, data: null, error: null }, // [7] unpublished draft count=0 (Promise.all[1])
        { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [8] session — DRAFT MODE (Promise.all[2])
        { data: [], error: null }, // [9] match_events — rejection memory, empty (Promise.all[3])
        { data: [], error: null }, // [10] slot 0: snapshot (empty)
        { data: four, error: null }, // [11] slot 0: pool
        // rpc[0] succeeds (published — slot 0)
        { data: [], error: null }, // [12] slot 1: snapshot (empty)
        { data: fourMore, error: null }, // [13] slot 1: pool → fresh four → second proposal
        // rpc[1] errors → loop breaks after asserting the DRAFT write
        { data: [], error: null }, // [14] promote 2: no published pending
        { count: 1, data: null, error: null }, // [15] promote 2: draft-blocking check
      ],
      [
        { data: "match-slot0", error: null }, // rpc[0]: slot 0 commit
        { data: null, error: { message: "stop after slot 1" } }, // rpc[1]: slot 1 commit
      ]
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    await callNextMatch(SESSION_ID, COURT_ID);

    // Slot 0: published (being seated). Slot 1: back under the review flow.
    expect(serviceMock.rpc).toHaveBeenCalledTimes(2);
    expect(serviceMock.rpc).toHaveBeenNthCalledWith(
      1,
      "create_match_with_players",
      expect.objectContaining({ p_is_published: true })
    );
    expect(serviceMock.rpc).toHaveBeenNthCalledWith(
      2,
      "create_match_with_players",
      expect.objectContaining({ p_is_published: false })
    );
  });
});

// ═════════════════════════════════════════════════════════════
// SESSION MATCH SNAPSHOT — fail-closed + per-slot cadence (ENG-SNAP)
// ═════════════════════════════════════════════════════════════
//
// The snapshot feeds EVERY diversity input the engine has: recent rosters, the
// partnership/opponent caps, and the overlap map. These two tests pin the parts
// of that contract the pure unit tests in matchmaking-snapshot.test.ts cannot
// see, because they are properties of the engine loop rather than the helper.
//
// ENG-SNAP-1  an unavailable snapshot STOPS the burst — it must never fall
//             through to drafting against empty history
// ENG-SNAP-2  the snapshot is re-read PER SLOT, so sibling drafts committed
//             earlier in the same burst are visible to later slots

describe("runEngineForSession — match-snapshot contract (ENG-SNAP)", () => {
  const waiting = (n: number, waitMinutes = 10) =>
    Array.from({ length: n }, (_, i) => ({
      id: `entry-s${i}`,
      session_id: SESSION_ID,
      player_id: `s${i}`,
      joined_at: new Date(Date.now() - waitMinutes * 60_000).toISOString(),
      games_played: 0,
      status: "waiting" as const,
      position: null,
      is_paused: false,
      created_at: new Date().toISOString(),
      display_name: `Player ${i}`,
      skill_level: "intermediate" as const,
      skill_level_int: 4,
      wait_minutes: waitMinutes,
      is_bottleneck: false,
    }));

  it("ENG-SNAP-1: snapshot query error ⇒ engine stops the burst and creates NO match", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const four = waiting(4);

    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // [0] toggle ON
      { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts
      { data: four, error: null }, // [2] v_queue (Promise.all[0])
      { count: 0, data: null, error: null }, // [3] draft count=0 → slots=3 (Promise.all[1])
      { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [4] session
      { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
      { data: null, error: { message: "statement timeout" } }, // [6] snapshot matches → FAILS
      { data: four, error: null }, // [7] fetchActivePool (already in flight — concurrent)
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();

    // Fail CLOSED. Continuing would run the algorithm with empty history, which
    // does not degrade gracefully: every repeat reads as a fresh pairing, so the
    // burst would emit exactly the duplicate rosters the caps exist to prevent.
    // Fewer drafts is recoverable; a batch of confidently-wrong ones is not.
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("match snapshot unavailable"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("statement timeout"));

    // Stopped inside slot 1 — no slot-2 read phase.
    expect(mock.queriedTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
      "sessions",
      "match_events",
      "matches",
      "v_queue_with_wait_time",
    ]);

    consoleSpy.mockRestore();
  });

  it("ENG-SNAP-2: the snapshot is re-read every slot (sibling drafts stay visible)", async () => {
    // 12 waiting ⇒ after slot 1 commits, estimatedWaiting is still 8, so the
    // pool-diversity cap does not fire and slot 2 runs a full read phase of its
    // own. Hoisting the snapshot out of the loop would show up here as a single
    // pair of reads instead of two.
    const twelve = waiting(12);

    const mock = makeMockClient(
      [
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] toggle ON
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts
        { data: twelve, error: null }, // [2] v_queue (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] draft count=0 (Promise.all[1])
        { data: { max_auto_drafts_override: null, auto_publish: false }, error: null }, // [4] session
        { data: [], error: null }, // [5] match_events — rejection memory, empty (Promise.all[3])
        { data: [], error: null }, // [6] slot 1 snapshot: matches → []
        { data: twelve, error: null }, // [7] slot 1 pool
        { data: [], error: null }, // [8] slot 2 snapshot: matches → []
        { data: twelve, error: null }, // [9] slot 2 pool
      ],
      [
        { data: "match-1", error: null },
        { data: "match-2", error: null },
      ]
    );
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();

    expect(mock.rpc).toHaveBeenCalledTimes(2);
    expect(mock.queriedTables.slice(6)).toEqual([
      "matches", // slot 1 snapshot
      "v_queue_with_wait_time", // slot 1 pool
      "matches", // slot 2 snapshot — re-read, NOT hoisted
      "v_queue_with_wait_time", // slot 2 pool
    ]);
  });
});

// ═════════════════════════════════════════════════════════════
// CROSS-COURT — promotion TS-filter + recomputeHeldReadiness (Phase 5)
// ═════════════════════════════════════════════════════════════

describe("promoteOnDeckMatchInternal — held-draft TS-filter (C-4 / R3-A)", () => {
  // Past timestamp ⇒ a held match whose held_ready_at is due (no fake clock needed).
  const READY_AT = "2020-01-01T00:00:00.000Z";

  it("CC-PROM-CC01: skips a not-ready held match and promotes a READY match queued behind it", async () => {
    const heldNotReady = {
      id: "held-1",
      is_held: true,
      held_ready_at: null,
      is_mixed_level: false,
    };
    const normalReady = {
      id: "match-2",
      is_held: false,
      held_ready_at: null,
      is_mixed_level: false,
    };
    const mock = makeMockClient([
      { data: [heldNotReady, normalReady], error: null }, // published pending (front = not-ready held)
      { data: MOCK_MATCH_PLAYERS, error: null }, // left-guard roster (for the ready candidate)
      { count: 0, data: null, error: null }, // queue_entries left-count → none left
      { data: { id: "match-2" }, error: null }, // CAS update on the chosen ready match
      { data: null, error: null }, // courts update
      { data: null, error: null }, // queue_entries playing-update
      { data: MOCK_PROFILES, error: null }, // profiles
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-2"); // the ready one BEHIND the held one
  });

  it("CC-PROM-CC02: promotes a held match once its held_ready_at is due", async () => {
    const readyHeld = {
      id: "held-1",
      is_held: true,
      held_ready_at: READY_AT,
      is_mixed_level: false,
    };
    const mock = makeMockClient([
      { data: [readyHeld], error: null }, // published pending (ready held)
      { data: MOCK_MATCH_PLAYERS, error: null }, // left-guard roster
      { count: 0, data: null, error: null }, // queue_entries left-count → none left
      { data: { id: "held-1" }, error: null }, // CAS update
      { data: null, error: null }, // courts update
      { data: null, error: null }, // queue_entries playing-update
      { data: MOCK_PROFILES, error: null }, // profiles
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("held-1");
  });

  it("CC-PROM-CC03: only a not-ready held match ⇒ nothing promoted (court frees, engine refills)", async () => {
    const mock = makeMockClient([
      {
        data: [{ id: "held-1", is_held: true, held_ready_at: null, is_mixed_level: false }],
        error: null,
      },
      { count: 0, data: null, error: null }, // draft-blocking check → 0 unpublished drafts
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no on-deck/i);
    expect(mock.queriedTables).toEqual(["matches", "matches"]);
  });
});

describe("recomputeHeldReadiness — held-draft health check", () => {
  const held = (over: Record<string, unknown> = {}) => ({
    id: "held-1",
    pulled_player_ids: ["pp"],
    pulled_from_match_id: "src-1",
    held_ready_at: null,
    ...over,
  });

  it("CC-RDY-CC01: source completed + ≥1 promotion ⇒ stamps held_ready_at (idempotent)", async () => {
    const mock = makeMockClient([
      { data: [held()], error: null }, // held not-ready pending matches
      { data: { auto_publish: false }, error: null }, // session auto_publish mode → draft
      {
        data: [{ player_id: "pp" }, { player_id: "w1" }, { player_id: "w2" }, { player_id: "w3" }],
        error: null,
      }, // roster (pulled body present)
      { data: { status: "completed", completed_at: "2026-06-07T11:50:00.000Z" }, error: null }, // source match
      { count: 1, data: null, error: null }, // promotionsSinceFreed
      { data: null, error: null }, // stamp update
    ]);

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    expect(mock.recorder.update).toHaveLength(1);
    expect(mock.recorder.update[0]).toMatchObject({ held_ready_at: expect.any(String) });
  });

  it("CC-RDY-CC02: source still in_progress ⇒ NOT ready, no stamp", async () => {
    const mock = makeMockClient([
      { data: [held()], error: null },
      { data: { auto_publish: false }, error: null }, // session auto_publish mode → draft
      { data: [{ player_id: "pp" }, { player_id: "w1" }], error: null }, // roster ok
      { data: { status: "in_progress", completed_at: null }, error: null }, // source still live
    ]);

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    expect(mock.recorder.update).toHaveLength(0);
    expect(mock.queriedTables).toEqual(["matches", "sessions", "match_players", "matches"]);
  });

  it("CC-RDY-CC03 [N-2]: pulled body swapped out of roster ⇒ downgrade to a normal draft", async () => {
    const mock = makeMockClient([
      { data: [held()], error: null },
      { data: { auto_publish: false }, error: null }, // session auto_publish mode → draft
      { data: [{ player_id: "x1" }, { player_id: "x2" }, { player_id: "x3" }], error: null }, // roster WITHOUT "pp"
      { data: null, error: null }, // downgrade update
    ]);

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    expect(mock.recorder.update).toContainEqual({
      pulled_player_ids: [],
      pulled_from_match_id: null,
      held_ready_at: null,
    });
    expect(mock.rpc).not.toHaveBeenCalled(); // downgrade, not cancel
  });

  it("CC-RDY-CC04 [R3-B]: null source match ⇒ cancel via clear_on_deck_match_atomic", async () => {
    const mock = makeMockClient([
      { data: [held({ pulled_from_match_id: null })], error: null },
      { data: { auto_publish: false }, error: null }, // session auto_publish mode → draft
      { data: [{ player_id: "pp" }, { player_id: "w1" }], error: null }, // roster ok
    ]);

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    expect(mock.rpc).toHaveBeenCalledWith("clear_on_deck_match_atomic", {
      p_match_id: "held-1",
      p_session_id: SESSION_ID,
    });
    expect(mock.recorder.update).toHaveLength(0); // cancel, not stamp/downgrade
  });

  const readyRoster = () => [
    { data: [held()], error: null }, // held fetch
    { data: { auto_publish: true }, error: null }, // auto mode
    {
      data: [{ player_id: "pp" }, { player_id: "w1" }, { player_id: "w2" }, { player_id: "w3" }],
      error: null,
    }, // roster (pp present)
    { data: { status: "completed", completed_at: "2026-06-07T11:50:00.000Z" }, error: null }, // source completed
    { count: 1, data: null, error: null }, // promotionsSinceFreed ≥1 → ready
    { data: null, error: null }, // held_ready_at stamp update
  ];

  it("CC-RDY-AP1: auto mode, ready + auto_publish SUCCESS ⇒ publishes, no clear", async () => {
    const mock = makeMockClient(
      [
        ...readyRoster(),
        { data: [{ player_id: "pp" }, { player_id: "w1" }], error: null }, // roster fetch for ON_DECK_WARNING
      ],
      [{ data: "SUCCESS", error: null }] // auto_publish_match → SUCCESS
    );

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    expect(mock.rpc).toHaveBeenCalledWith("auto_publish_match", {
      p_match_id: "held-1",
      p_session_id: SESSION_ID,
    });
    // SUCCESS path must NOT clear the match.
    expect(mock.rpc).not.toHaveBeenCalledWith("clear_on_deck_match_atomic", expect.anything());
  });

  it("CC-RDY-AP2 [Fix #1]: auto mode, ready but auto_publish HAS_LEFT_PLAYERS ⇒ clears the orphan", async () => {
    const mock = makeMockClient(readyRoster(), [
      { data: "HAS_LEFT_PLAYERS", error: null }, // auto_publish_match → tainted roster
      { data: null, error: null }, // clear_on_deck_match_atomic
    ]);

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    // The stamped-but-unpublishable draft is cleared so players re-enter the pool
    // instead of being orphaned (held_ready_at set, is_published=false, invisible).
    expect(mock.rpc).toHaveBeenCalledWith("clear_on_deck_match_atomic", {
      p_match_id: "held-1",
      p_session_id: SESSION_ID,
    });
  });

  it("CC-RDY-AP3 [Fix #1]: auto mode, ready but auto_publish CONFLICT ⇒ clears the orphan", async () => {
    const mock = makeMockClient(readyRoster(), [
      { data: "CONFLICT", error: null },
      { data: null, error: null }, // clear_on_deck_match_atomic
    ]);

    await recomputeHeldReadiness(mock as never, SESSION_ID);

    expect(mock.rpc).toHaveBeenCalledWith("clear_on_deck_match_atomic", {
      p_match_id: "held-1",
      p_session_id: SESSION_ID,
    });
  });
});

// ═════════════════════════════════════════════════════════════
// CROSS-COURT — producer helpers (Phase 4)
// ═════════════════════════════════════════════════════════════

describe("fetchPullablePlayers + executeHeldMatch (cross-court producer)", () => {
  const heldProposal = {
    teamA: [{ player_id: "a" }, { player_id: "b" }],
    teamB: [{ player_id: "c" }, { player_id: "pp" }],
    isMixedLevel: false,
  };

  it("CC-ENG-CC01: returns eligible playing bodies with streak + currentMatchId", async () => {
    const mock = makeMockClient([
      { data: [{ id: "m1", started_at: "2026-06-07T11:50:00.000Z" }], error: null }, // active in_progress
      { data: [{ match_id: "m1", player_id: "pp" }], error: null }, // active match_players
      {
        data: [
          {
            id: "qe1",
            player_id: "pp",
            games_played: 2,
            joined_at: "2026-06-07T11:00:00.000Z",
            created_at: "2026-06-07T11:00:00.000Z",
            is_paused: false,
          },
        ],
        error: null,
      }, // queue_entries
      { data: [{ id: "pp", display_name: "PP", skill_level: "intermediate" }], error: null }, // profiles
      { data: [], error: null }, // held drafts (none)
      {
        data: [{ id: "m1", started_at: "2026-06-07T11:50:00.000Z", completed_at: null }],
        error: null,
      }, // recent matches
      { data: [{ match_id: "m1", player_id: "pp" }], error: null }, // recent roster
    ]);

    const bodies = await fetchPullablePlayers(mock as never, SESSION_ID);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      player_id: "pp",
      currentMatchId: "m1",
      currentMatchStartedAt: "2026-06-07T11:50:00.000Z",
      alreadyHeld: false,
      streak: 1,
      skill_level_int: 3,
      status: "playing",
    });
  });

  it("CC-ENG-CC02: a body already reserved in a pending held draft is flagged alreadyHeld (Guard 1b mirror)", async () => {
    const mock = makeMockClient([
      { data: [{ id: "m1", started_at: "2026-06-07T11:50:00.000Z" }], error: null },
      { data: [{ match_id: "m1", player_id: "pp" }], error: null },
      {
        data: [
          {
            id: "qe1",
            player_id: "pp",
            games_played: 0,
            joined_at: "2026-06-07T11:00:00.000Z",
            created_at: "2026-06-07T11:00:00.000Z",
            is_paused: false,
          },
        ],
        error: null,
      },
      { data: [{ id: "pp", display_name: "PP", skill_level: "intermediate" }], error: null },
      { data: [{ pulled_player_ids: ["pp"] }], error: null }, // pp already in a held draft
      {
        data: [{ id: "m1", started_at: "2026-06-07T11:50:00.000Z", completed_at: null }],
        error: null,
      },
      { data: [{ match_id: "m1", player_id: "pp" }], error: null },
    ]);

    const bodies = await fetchPullablePlayers(mock as never, SESSION_ID);
    expect(bodies[0].alreadyHeld).toBe(true);
  });

  it("CC-ENG-CC03: no in_progress matches ⇒ nothing pullable", async () => {
    const mock = makeMockClient([{ data: [], error: null }]);
    expect(await fetchPullablePlayers(mock as never, SESSION_ID)).toEqual([]);
  });

  it("CC-ENG-CC04: executeHeldMatch calls create_held_cross_court_match and returns the new id", async () => {
    const mock = makeMockClient([], [{ data: "held-id", error: null }]);

    const r = await executeHeldMatch(
      mock as never,
      SESSION_ID,
      heldProposal as never,
      "pp",
      "src-1"
    );

    expect(r.success).toBe(true);
    expect(r.matchId).toBe("held-id");
    expect(mock.rpc).toHaveBeenCalledWith("create_held_cross_court_match", {
      p_session_id: SESSION_ID,
      p_is_mixed_level: false,
      p_team_a_ids: ["a", "b"],
      p_team_b_ids: ["c", "pp"],
      p_pulled_player_id: "pp",
      p_pulled_from_match_id: "src-1",
      p_origin: "auto",
    });
  });

  it("CC-ENG-CC05: executeHeldMatch NULL return ⇒ graceful slot-skip (no throw)", async () => {
    const mock = makeMockClient([], [{ data: null, error: null }]); // a guard fired
    const r = await executeHeldMatch(
      mock as never,
      SESSION_ID,
      heldProposal as never,
      "pp",
      "src-1"
    );
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/skipped/i);
  });
});
