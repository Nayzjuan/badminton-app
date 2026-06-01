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
//   fetchPartnershipCounts, buildOverlapMap, executeMatch) which use
//   it directly. Each test builds a queue-based mock client where each
//   from() call consumes the next pre-configured response.
//   queriedTables tracks the DB table-access order for assertions.
//
// Per-slot query order inside runEngineInternal:
//   Promise.all (after courts): v_queue_with_wait_time [0], matches draft count [1]
//   soft gate (if triggered):   matches in_progress count
//   fetchRecentRosters (once):  matches (+ match_players if non-empty)
//   fetchActivePool:            v_queue_with_wait_time, queue_entries
//   fetchPartnershipCounts:     matches (+ match_players if non-empty)
//   buildOverlapMap:            match_players, matches, match_players (if non-empty)
//   executeMatch:               rpc("create_match_with_players")
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoist mock before any imports ─────────────────────────────
vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import {
  promoteOnDeckMatchInternal,
  runEngineForSession,
  callNextMatch,
} from "@/app/actions/matchmaking";
import { getDynamicDraftCap } from "@/lib/matchmaking-core";

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
function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};

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
    "update",
    "upsert",
    "insert",
    "maybeSingle",
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
 * NOTE: buildOverlapMap uses a 3-step join — NOT the old v_recent_pairings view.
 * Step 1: from("match_players").eq("player_id", anchor)          — anchor's match IDs
 * Step 2: from("matches").in("id", ...).eq("session_id", ...)    — filter to session
 * Step 3: from("match_players").in("match_id", ...)              — co-players + teams
 * Steps 2 and 3 are only reached when the anchor has prior matches (Step 1 non-empty).
 * Tests with empty queues will never reach any of these — no mock responses needed.
 */
function makeMockClient(fromResponses: MockResponse[], rpcResponses: MockResponse[] = []) {
  let fromIdx = 0;
  let rpcIdx = 0;
  const queriedTables: string[] = [];

  const from = vi.fn((table: string) => {
    queriedTables.push(table);
    const result = fromResponses[fromIdx++] ?? { data: null, error: null };
    return makeBuilder(result);
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

  return { from, rpc, queriedTables, auth };
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
      { data: null, error: null }, // matches update → 0 rows (CAS guard fails)
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already promoted/i);
    // Stopped after the failed CAS update — only matches queried twice (fetch + update attempt)
    expect(mock.queriedTables).toEqual(["matches", "matches"]);
  });

  it("returns success:false with error detail on a DB error during the CAS update", async () => {
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // fetch
      { data: null, error: { message: "FK violation" } }, // update → DB error
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain("FK violation");
  });

  it("succeeds with empty match player list (no queue_entries update performed)", async () => {
    // Sequence (5 from() calls — no queue_entries since matchPlayers=[]):
    // matches(fetch), matches(update CAS), courts(update), match_players(select=[]), profiles(select=[])
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null }, // matches fetch
      { data: { id: "match-1" }, error: null }, // matches update (CAS passes)
      { data: null, error: null }, // courts update
      { data: [], error: null }, // match_players → empty
      { data: [], error: null }, // profiles → empty
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
    expect(result.teamA).toEqual([]);
    expect(result.teamB).toEqual([]);
    // Full query sequence: fetch pending → CAS update → courts update → match_players → profiles
    expect(mock.queriedTables).toEqual([
      "matches", // fetch pending on-deck match
      "matches", // CAS status update
      "courts", // mark court occupied
      "match_players", // load match player list (empty)
      "profiles", // resolve display names (empty)
    ]);
  });

  it("succeeds and resolves player names into teamA and teamB", async () => {
    // Sequence (6 from() calls — queue_entries update included):
    // matches(fetch), matches(update), courts(update), match_players, queue_entries(update), profiles
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },
      { data: { id: "match-1" }, error: null },
      { data: null, error: null },
      { data: MOCK_MATCH_PLAYERS, error: null },
      { data: null, error: null }, // queue_entries update
      { data: MOCK_PROFILES, error: null },
    ]);

    const result = await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.teamA).toEqual(["Alice", "Bob"]);
    expect(result.teamB).toEqual(["Charlie", "Diana"]);
    // Full query sequence includes queue_entries update (players moved from waiting → playing)
    expect(mock.queriedTables).toEqual([
      "matches", // fetch pending on-deck match
      "matches", // CAS status update
      "courts", // mark court occupied
      "match_players", // load match player list (non-empty → triggers queue_entries update)
      "queue_entries", // mark matched players status = in_match
      "profiles", // resolve display names
    ]);
  });

  it("passes through is_mixed_level=true from the match row", async () => {
    const mixedMatch = { id: "match-1", is_mixed_level: true };
    const mock = makeMockClient([
      { data: [mixedMatch], error: null },
      { data: { id: "match-1" }, error: null },
      { data: null, error: null },
      { data: [], error: null }, // match_players empty
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
      { data: [MOCK_MATCH], error: null },
      { data: { id: "match-1" }, error: null },
      { data: null, error: null },
      { data: MOCK_MATCH_PLAYERS, error: null },
      { data: null, error: null },
      { data: partialProfiles, error: null },
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
    // Promise.all([v_queue_with_wait_time, matches]) runs after courts.
    // waitingCount=0 → dynamicCap=3. draftCount=3 → slotsAvailable=0 → skipping.
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [{ id: "c1" }, { id: "c2" }], error: null }, // courts (2)
      { data: [], error: null }, // v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 3, data: null, error: null }, // matches draft count=3 → slotsAvailable=0 (Promise.all[1])
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Engine exits after parallel waiting+draft fetch: no queue/algorithm queries fired
    expect(mock.queriedTables).toEqual(["sessions", "courts", "v_queue_with_wait_time", "matches"]);
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
    //   [4] matches: fetchRecentRosters → [] (empty; no match_players query follows)
    //   slot 0 (i=0 exempt from pool-diversity cap):
    //   [5] v_queue_with_wait_time: fetchActivePool → 4 players
    //   [6] queue_entries: fetchActivePool paused filter → []
    //       (pool=4 ≥ 4 → continues)
    //   [7] matches: fetchPartnershipCounts step 1 → [] (no prior matches → empty map; no step 2)
    //   [8] match_players: buildOverlapMap step 1 → beyond array → default {data:null,error:null}
    //        → anchorRows=null → early return; empty overlapMap
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
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts (2)
        { data: fourPlayers, error: null }, // [2] v_queue_with_wait_time: maxWait=10 → gateTimedOut → releases (estimatedWaiting=4) (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=3 (Promise.all[1])
        { data: [], error: null }, // [4] fetchRecentRosters: recent matches → []
        // (match_players not queried since recentMatchIds is empty)
        { data: fourPlayers, error: null }, // [5] runAlgorithm: v_queue_with_wait_time → 4 players
        { data: [], error: null }, // [6] queue_entries paused → []
        { data: [], error: null }, // [7] fetchPartnershipCounts: matches (no prior session matches → empty map)
        // [8] buildOverlapMap step 1: match_players → beyond array → undefined fallback
        //     → anchorRows=null → early return; empty overlapMap
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

  it("ME-new-1: engine completes without error when runAlgorithm returns capSaturation=true (broadcast fires silently — env vars absent in tests)", async () => {
    // Force capSaturation=true by supplying partnership counts that cap every
    // anchor-candidate pair. The pool has anchor (p0) + 2 candidates (p1, p2),
    // all at the same skill so every skill window would pass — but the cap filter
    // removes p1 and p2 before the window loop runs, leaving candidates=[].
    //
    // capWasActive = pool.length-1(2) > candidates.length(0) = true
    // → runAlgorithm returns { proposal: null, capSaturation: true }
    // → broadcastCapSaturation() is called but env vars are absent in tests
    //   so postBroadcast() logs a console.warn and returns immediately.
    // → The .catch() handler in matchmaking.ts is NOT invoked (no rejection).
    // → console.error is NOT called.

    // Use wait_minutes=10 so maxWait(10) >= GATE_HOLD_MINUTES(8) → gateTimedOut=true
    // → gate releases without an extra active-court query, matching the existing
    // test pattern (4-player RPC failure test at ~line 428+).
    const threePlayers = [
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
    ];

    // fetchPartnershipCounts: p0 played with p1 AND p2 twice each
    // Matches: m1 (p0+p1 same team), m2 (p0+p2 same team) — each repeated twice
    const matchRows = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }];
    const mpRows = [
      // m1: p0-p1 same team → count +1
      { match_id: "m1", player_id: "p0", team: "a" },
      { match_id: "m1", player_id: "p1", team: "a" },
      { match_id: "m1", player_id: "p2", team: "b" },
      { match_id: "m1", player_id: "px", team: "b" },
      // m2: p0-p2 same team → count +1
      { match_id: "m2", player_id: "p0", team: "a" },
      { match_id: "m2", player_id: "p2", team: "a" },
      { match_id: "m2", player_id: "p1", team: "b" },
      { match_id: "m2", player_id: "py", team: "b" },
      // m3: p0-p1 same team again → p0-p1 count = 2 = MAX_PARTNERSHIP_REPEATS
      { match_id: "m3", player_id: "p0", team: "a" },
      { match_id: "m3", player_id: "p1", team: "a" },
      { match_id: "m3", player_id: "p2", team: "b" },
      { match_id: "m3", player_id: "px", team: "b" },
      // m4: p0-p2 same team again → p0-p2 count = 2 = MAX_PARTNERSHIP_REPEATS
      { match_id: "m4", player_id: "p0", team: "a" },
      { match_id: "m4", player_id: "p2", team: "a" },
      { match_id: "m4", player_id: "p1", team: "b" },
      { match_id: "m4", player_id: "py", team: "b" },
    ];

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions
      { data: [{ id: "c1" }], error: null }, // [1] courts (1)
      { data: threePlayers, error: null }, // [2] v_queue_with_wait_time: maxWait=10≥8 → gateTimedOut=true → releases (estimatedWaiting=3) (Promise.all[0])
      { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=2 (Promise.all[1])
      { data: [], error: null }, // [4] fetchRecentRosters: matches → [] (no recent matches → no step 2)
      { data: threePlayers, error: null }, // [5] fetchActivePool: v_queue_with_wait_time
      { data: [], error: null }, // [6] fetchActivePool: paused filter
      { data: matchRows, error: null }, // [7] fetchPartnershipCounts step 1: match IDs
      { data: mpRows, error: null }, // [8] fetchPartnershipCounts step 2: match_players rows
      // buildOverlapMap step 1: beyond array → default {data:null} → early return → empty overlapMap
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // capSaturation=true path: broadcastCapSaturation fires (silently, env vars absent)
    // but console.error is NOT called
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("no compatible match"));

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
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [{ id: "c1" }], error: null }, // courts (1)
      { data: eightExtremes, error: null }, // v_queue_with_wait_time: 8 players (8 > GATE_POOL_THRESHOLD=4 → gate not triggered; estimatedWaiting=8) (Promise.all[0])
      { count: 0, data: null, error: null }, // matches draft count=0 → slotsAvailable=2 (Promise.all[1])
      { data: [], error: null }, // fetchRecentRosters
      { data: eightExtremes, error: null }, // fetchActivePool: pool=8
      { data: [], error: null }, // paused filter
      { data: [], error: null }, // fetchPartnershipCounts step 1 → no matches → empty counts
      // buildOverlapMap → beyond array → empty map
      // runAlgorithm: anchor skill=1, candidates skill=9 → |9-1|=8 > max Red Zone window(4, only if Red Zone)
      // anchor wait_minutes=8 < CRITICAL_WAIT_MINUTES=25 → not Red Zone → windows=[1,2]
      // ±1: no candidates (|9-1|=8 > 1), ±2: no candidates → no match
      // fallback: 8 > 15? No → no fallback
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
        { data: { is_auto_matchmaking_on: true }, error: null }, // [0] sessions
        { data: [{ id: "c1" }, { id: "c2" }], error: null }, // [1] courts (2)
        { data: eightPlayers, error: null }, // [2] v_queue_with_wait_time (estimatedWaiting=8; soft gate: 8>4 not triggered) (Promise.all[0])
        { count: 0, data: null, error: null }, // [3] matches draft count=0 → slotsAvailable=3 (Promise.all[1])
        { data: [], error: null }, // [4] fetchRecentRosters: recent matches → []
        { data: eightPlayers, error: null }, // [5] fetchActivePool: v_queue_with_wait_time → 8 players
        { data: [], error: null }, // [6] fetchActivePool: queue_entries paused → []
        { data: [], error: null }, // [7] fetchPartnershipCounts: matches → [] (no prior matches → empty map)
        // [8] buildOverlapMap step 1: match_players → beyond array → default fallback → empty overlapMap
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
      { data: { created_by: "test-user" }, error: null }, // [0] sessions auth gate
      { data: [MOCK_MATCH], error: null }, // [1] matches fetch → pending non-empty
      { data: { id: "match-1" }, error: null }, // [2] matches update (CAS)
      { data: null, error: null }, // [3] courts update
      { data: [], error: null }, // [4] match_players → empty
      { data: [], error: null }, // [5] profiles → empty (no player ids)
      { data: [{ id: "c1" }], error: null }, // [6] runEngineInternal: courts
      { data: [], error: null }, // [7] runEngineInternal: v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 3, data: null, error: null }, // [8] runEngineInternal: matches draft count=3 → slotsAvailable=0 (Promise.all[1])
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
      { data: { created_by: "test-user" }, error: null }, // [0] sessions auth gate
      { data: [MOCK_MATCH], error: null }, // [1] matches fetch → pending non-empty
      { data: { id: "match-1" }, error: null }, // [2] matches update (CAS)
      { data: null, error: null }, // [3] courts update
      { data: [], error: null }, // [4] match_players → empty
      { data: [], error: null }, // [5] profiles → empty
      { data: { is_auto_matchmaking_on: true }, error: null }, // [6] sessions → toggle ON
      { data: [{ id: "c1" }], error: null }, // [7] courts → engine proceeds
      { data: [], error: null }, // [8] v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 3, data: null, error: null }, // [9] matches draft count=3 → slotsAvailable=0 (Promise.all[1])
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    await callNextMatch(SESSION_ID, COURT_ID);

    // [6] must be "sessions" — confirms runEngineForSession (not runEngineInternal) was called.
    expect(serviceMock.queriedTables[6]).toBe("sessions");
    // Post-promotion sequence: sessions (toggle) → courts → v_queue → matches.
    const postPromotionTables = serviceMock.queriedTables.slice(6);
    expect(postPromotionTables).toEqual([
      "sessions",
      "courts",
      "v_queue_with_wait_time",
      "matches",
    ]);
  });

  it("returns 'paused' message when no on-deck match exists and toggle is OFF", async () => {
    // promoteOnDeckMatchInternal: matches → empty → draft-blocking check → 0 drafts.
    // Then service client toggle check: sessions → OFF → return paused message.
    // Note: is_auto_matchmaking_on is now read via service client (not RLS client)
    // so co-organizers (blocked by sessions RLS SELECT) also get the correct value.
    const mock = makeMockClient([]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // [0] sessions auth gate
      { data: [], error: null }, // [1] matches fetch → empty
      { count: 0, data: null, error: null }, // [2] draft-blocking check → 0 drafts
      { data: { is_auto_matchmaking_on: false }, error: null }, // [3] toggle check → OFF
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
      { data: { created_by: "test-user" }, error: null }, // [0] sessions auth gate
      { data: [], error: null }, // [1] promote 1: no published pending
      { count: 2, data: null, error: null }, // [2] promote 1: 2 drafts → hasDraftsBlocking
      { data: { is_auto_matchmaking_on: true }, error: null }, // [3] toggle check → ON
      { data: [{ id: "c1" }], error: null }, // [4] runEngine: courts
      { data: [], error: null }, // [5] runEngine: v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 2, data: null, error: null }, // [6] runEngine: matches draft count=2 → slotsAvailable=1 (Promise.all[1])
      { data: [], error: null }, // [7] runEngine: fetchRecentRosters → []
      { data: [], error: null }, // [8] fetchActivePool: v_queue_with_wait_time → [] (pool < 4 → break)
      { data: [], error: null }, // [9] fetchActivePool: queue_entries paused → []
      { data: [], error: null }, // [10] promote 2: no published pending
      { count: 2, data: null, error: null }, // [11] promote 2: 2 drafts → hasDraftsBlocking
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
      { data: { created_by: "test-user" }, error: null }, // [0] sessions auth gate
      { data: [], error: null }, // [1] promote 1: no pending
      { count: 0, data: null, error: null }, // [2] promote 1: 0 drafts
      { data: { is_auto_matchmaking_on: true }, error: null }, // [3] toggle check → ON
      { data: [{ id: "c1" }], error: null }, // [4] runEngine: courts
      { data: [], error: null }, // [5] runEngine: v_queue_with_wait_time → waitingCount=0 (Promise.all[0])
      { count: 0, data: null, error: null }, // [6] runEngine: matches draft count=0 → slotsAvailable=3 (Promise.all[1])
      { data: [], error: null }, // [7] runEngine: fetchRecentRosters → []
      { data: [], error: null }, // [8] fetchActivePool: v_queue_with_wait_time → [] (pool < 4 → break)
      { data: [], error: null }, // [9] fetchActivePool: queue_entries paused → []
      { data: [], error: null }, // [10] promote 2: still no pending
      { count: 0, data: null, error: null }, // [11] promote 2: 0 drafts
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not enough players/i);
  });
});
