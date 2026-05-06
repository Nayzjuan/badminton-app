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
//   @/utils/supabase/server is replaced by vi.mock().
//   Each test builds a queue-based mock client where each from()
//   call consumes the next pre-configured response. queriedTables
//   tracks which DB tables were accessed for order verification.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoist mock before any imports ─────────────────────────────
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import {
  promoteOnDeckMatchInternal,
  runEngineForSession,
  callNextMatch,
} from "@/app/actions/matchmaking";

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
  b["then"] = (
    onFulfilled: (v: MockResponse) => unknown,
    onRejected: (e: unknown) => unknown
  ) => Promise.resolve(response).then(onFulfilled, onRejected);

  b["catch"] = (onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).catch(onRejected);

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
function makeMockClient(
  fromResponses: MockResponse[],
  rpcResponses: MockResponse[] = []
) {
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
const COURT_ID   = "00000000-0000-4000-8000-000000000002";

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
// no createClient mock needed for these tests.

describe("promoteOnDeckMatchInternal", () => {
  it("returns success:false when there is no pending match (empty array)", async () => {
    const mock = makeMockClient([
      { data: [], error: null },              // matches fetch → empty
      { count: 0, data: null, error: null }, // draft-blocking secondary check → 0 unpublished drafts
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

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
      { data: [], error: null },              // matches fetch → 0 published pending
      { count: 2, data: null, error: null }, // draft check → 2 unpublished drafts blocking
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

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

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

    expect(result.success).toBe(false);
    // Error path returns the real DB message — NOT the "no on-deck" fallback
    expect(result.message).toMatch(/failed to fetch/i);
  });

  it("returns success:false with 'already promoted' message on CAS race condition", async () => {
    // CAS race: another request already promoted the match.
    // The UPDATE affects 0 rows → .single() resolves with data:null, error:null.
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },  // matches fetch → 1 pending
      { data: null, error: null },          // matches update → 0 rows (CAS guard fails)
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already promoted/i);
    // Stopped after the failed CAS update — only matches queried twice (fetch + update attempt)
    expect(mock.queriedTables).toEqual(["matches", "matches"]);
  });

  it("returns success:false with error detail on a DB error during the CAS update", async () => {
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },                         // fetch
      { data: null, error: { message: "FK violation" } },         // update → DB error
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("FK violation");
  });

  it("succeeds with empty match player list (no queue_entries update performed)", async () => {
    // Sequence (5 from() calls — no queue_entries since matchPlayers=[]):
    // matches(fetch), matches(update CAS), courts(update), match_players(select=[]), profiles(select=[])
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },   // matches fetch
      { data: { id: "match-1" }, error: null }, // matches update (CAS passes)
      { data: null, error: null },           // courts update
      { data: [], error: null },             // match_players → empty
      { data: [], error: null },             // profiles → empty
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
    expect(result.teamA).toEqual([]);
    expect(result.teamB).toEqual([]);
    // Full query sequence: fetch pending → CAS update → courts update → match_players → profiles
    expect(mock.queriedTables).toEqual([
      "matches",       // fetch pending on-deck match
      "matches",       // CAS status update
      "courts",        // mark court occupied
      "match_players", // load match player list (empty)
      "profiles",      // resolve display names (empty)
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
      { data: null, error: null },  // queue_entries update
      { data: MOCK_PROFILES, error: null },
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

    expect(result.success).toBe(true);
    expect(result.teamA).toEqual(["Alice", "Bob"]);
    expect(result.teamB).toEqual(["Charlie", "Diana"]);
    // Full query sequence includes queue_entries update (players moved from waiting → playing)
    expect(mock.queriedTables).toEqual([
      "matches",        // fetch pending on-deck match
      "matches",        // CAS status update
      "courts",         // mark court occupied
      "match_players",  // load match player list (non-empty → triggers queue_entries update)
      "queue_entries",  // mark matched players status = in_match
      "profiles",       // resolve display names
    ]);
  });

  it("passes through is_mixed_level=true from the match row", async () => {
    const mixedMatch = { id: "match-1", is_mixed_level: true };
    const mock = makeMockClient([
      { data: [mixedMatch], error: null },
      { data: { id: "match-1" }, error: null },
      { data: null, error: null },
      { data: [], error: null },    // match_players empty
      { data: [], error: null },    // profiles empty
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

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

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      SESSION_ID,
      COURT_ID
    );

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
    // runEngineForSession uses createServiceClient (service-role) internally — not createClient.
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Only the sessions toggle check was made
    expect(mock.queriedTables).toEqual(["sessions"]);
  });

  it("queries courts when toggle is ON (proceeds into runEngineInternal)", async () => {
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [], error: null },                               // courts → 0 courts
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
      { data: [], error: null },                               // courts → 0
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Only sessions + courts queried: engine exits before the pending count check
    expect(mock.queriedTables).toEqual(["sessions", "courts"]);
  });

  it("stops filling when on-deck is already at capacity", async () => {
    // 2 courts → capacity = courtCount + ON_DECK_LOOKAHEAD = 3
    // 3 pending matches already → slotsAvailable = 0 → no match creation
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null },  // sessions
      { data: [{ id: "c1" }, { id: "c2" }], error: null },      // courts (2)
      { count: 3, data: null, error: null },                    // pending count = 3 → at capacity
    ]);
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Engine exits after the pending count: no queue/algorithm queries fired
    expect(mock.queriedTables).toEqual(["sessions", "courts", "matches"]);
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
    //   [1] courts(2 → capacity=2)
    //   [2] matches(pending count=0 → slotsAvailable=2)
    //   [3] v_queue_with_wait_time: soft gate — 4 players, maxWait=10 ≥ GATE_HOLD_MINUTES=8
    //        → gateTimedOut=true → gate releases; no active-courts query; estimatedWaiting=4
    //   [4] matches: fetchRecentRosters → [] (empty; no match_players query follows)
    //   slot 0 (i=0 exempt from pool-diversity cap):
    //   [5] v_queue_with_wait_time: runAlgorithm raw pool → 4 players
    //   [6] queue_entries: paused filter → []
    //       (activePool=4 ≥ 4 → continues past the "not enough" guard)
    //   [7] matches: fetchPartnershipCounts → [] (no prior session matches → empty map)
    //   [8] match_players: buildOverlapMap step 1 (anchor prior matches) → null/undefined
    //        → anchorRows=null → early return; empty overlapMap
    //   → group built → snakeDraft → executeMatch → rpc FAILS
    //   → loop breaks (slot 1 never reached)
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
        { data: { is_auto_matchmaking_on: true }, error: null },  // sessions
        { data: [{ id: "c1" }, { id: "c2" }], error: null },      // courts (2 → capacity=2)
        { count: 0, data: null, error: null },                    // pending count → 0 (slotsAvailable=2)
        { data: fourPlayers, error: null },                       // [soft gate] v_queue_with_wait_time: maxWait=10 → gateTimedOut → releases (estimatedWaiting=4)
        { data: [], error: null },                                 // fetchRecentRosters: recent matches (completed/in_progress/pending) → []
        // (match_players not queried since recentMatchIds is empty)
        { data: fourPlayers, error: null },                       // [5] runAlgorithm: v_queue_with_wait_time → 4 players
        { data: [], error: null },                                 // [6] queue_entries paused → []
        { data: [], error: null },                                 // [7] fetchPartnershipCounts: matches (no prior session matches → empty map)
        // [8] buildOverlapMap step 1: match_players → beyond array → undefined fallback
        //     → anchorRows=null → early return; empty overlapMap
        // rpc fails → loop breaks (slot 1 never reached)
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

  it("pool diversity cap limits second on-deck slot when remaining pool falls below threshold", async () => {
    // Fix 1: pool diversity cap prevents over-committing the free pool.
    // slotsAvailable = 2 (2 courts, 0 pending → room for 2 on-deck matches).
    // waitingCount = 8: soft gate not triggered (8 > GATE_POOL_THRESHOLD=4).
    //
    // Slot 0 (i=0): exempt from cap → fires → RPC succeeds → estimatedWaiting = 4.
    // Slot 1 (i=1): cap check: i>0 && estimatedWaiting(4) < PLAYERS_PER_MATCH(4)+MIN_FREE_POOL(4)=8
    //               → cap fires → break.
    //
    // Result: only 1 match created even though 2 slots were available.
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
        { data: { is_auto_matchmaking_on: true }, error: null },  // sessions
        { data: [{ id: "c1" }, { id: "c2" }], error: null },      // courts (2 → capacity=2)
        { count: 0, data: null, error: null },                    // pending count → 0 (slotsAvailable=2)
        { data: eightPlayers, error: null },                      // v_queue_with_wait_time (estimatedWaiting=8; soft gate: 8>4, not triggered)
        { data: [], error: null },                                 // fetchRecentRosters: recent matches → []
        { data: eightPlayers, error: null },                      // [5] runAlgorithm slot 0: v_queue_with_wait_time → 8 players
        { data: [], error: null },                                 // [6] queue_entries paused → []
        { data: [], error: null },                                 // [7] fetchPartnershipCounts: matches (no prior matches → empty map)
        // [8] buildOverlapMap step 1: match_players → beyond array → undefined fallback → empty overlapMap
        // rpc succeeds → estimatedWaiting=8-4=4; slot 1: 4 < MIN_POOL(8) → cap fires → break
      ],
      [{ data: "new-match-id", error: null }]  // rpc → success for slot 0
    );
    vi.mocked(createServiceClient).mockReturnValue(mock as never);

    await runEngineForSession(SESSION_ID);

    // Slot 0 created a match, slot 1 was blocked by the pool diversity cap.
    expect(mock.rpc).toHaveBeenCalledTimes(1);
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
  it("returns success when an on-deck match is promoted successfully", async () => {
    // promoteOnDeckMatchInternal (5 calls) + runEngineInternal (courts[1] + pending at cap[2])
    // 1 court → capacity = courtCount + ON_DECK_LOOKAHEAD = 2; count=2 → slotsAvailable=0 → no fill
    // pending[0] = MOCK_MATCH (non-empty) → no draft-blocking secondary check fires.
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },        // matches fetch (non-empty → no draft check)
      { data: { id: "match-1" }, error: null },   // matches update (CAS)
      { data: null, error: null },                // courts update
      { data: [], error: null },                  // match_players → empty
      { data: [], error: null },                  // profiles → empty
      { data: [{ id: "c1" }], error: null },      // runEngineInternal: courts query
      { count: 2, data: null, error: null },      // runEngineInternal: pending count = 2 → at capacity
    ]);
    // Service-role client handles the organizer auth-gate check inside callNextMatch.
    // created_by matches "test-user" from auth.getUser → session_organizers check skipped.
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // sessions → organizer ownership check
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
  });

  it("toggle bypass: after successful promotion, engine runs WITHOUT checking the toggle", async () => {
    // If callNextMatch went through runEngineForSession, it would query "sessions" first.
    // If it calls runEngineInternal directly, the next table after promotion is "courts".
    // 1 court → capacity = 2; count=2 → slotsAvailable=0 → engine exits after pending check (no gate query).
    // pending[0] = MOCK_MATCH (non-empty) → no draft-blocking secondary check fires.
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },        // matches fetch (non-empty → no draft check)
      { data: { id: "match-1" }, error: null },   // matches update (CAS)
      { data: null, error: null },                // courts update
      { data: [], error: null },                  // match_players → empty
      { data: [], error: null },                  // profiles → empty
      { data: [{ id: "c1" }], error: null },      // ← first query AFTER promotion = courts (not sessions)
      { count: 2, data: null, error: null },      // pending count = 2 → at capacity (1 court + lookahead)
    ]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // sessions → organizer ownership check
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    await callNextMatch(SESSION_ID, COURT_ID);

    // The 6th query (index 5) must be "courts", NOT "sessions".
    // "sessions" would appear here if runEngineForSession (toggle check) was called.
    expect(mock.queriedTables[5]).toBe("courts");
    // "sessions" should NOT appear after the 5 promotion calls
    const postPromotionTables = mock.queriedTables.slice(5);
    expect(postPromotionTables).not.toContain("sessions");
  });

  it("returns 'paused' message when no on-deck match exists and toggle is OFF", async () => {
    // When pending is empty, promoteOnDeckMatchInternal fires a secondary "matches" query
    // to check whether unpublished drafts are blocking the queue (Draft Mode feature).
    const mock = makeMockClient([
      { data: [], error: null },                                   // (0) matches fetch → empty
      { count: 0, data: null, error: null },                      // (1) draft-blocking check → 0 drafts
      { data: { is_auto_matchmaking_on: false }, error: null },   // (2) sessions → toggle OFF
    ]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // sessions → organizer ownership check
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/paused|auto-matchmaking/i);
  });

  it("returns 'not enough players' when toggle is ON but queue is empty", async () => {
    // Sequence:
    //   Attempt 1 (promote): matches → [] (no on-deck) + draft check → 0 drafts
    //   Toggle check: sessions → ON
    //   runEngineInternal (bypassGate=true): courts → [c1], pending → 0 slots
    //   fetchRecentRosters: matches → [] (empty → no match_players query)
    //   runAlgorithm: v_queue_with_wait_time → [] (empty queue), queue_entries paused → []
    //   → activePool.length 0 < 4 → "Not enough active players" → engine stops
    //   Attempt 2 (promote retry): matches → [] still + draft check → 0 drafts
    const mock = makeMockClient([
      { data: [], error: null },                                 // (0) promote attempt 1: no pending
      { count: 0, data: null, error: null },                    // (1) draft-blocking check → 0 drafts
      { data: { is_auto_matchmaking_on: true }, error: null },  // (2) sessions → toggle ON
      { data: [{ id: "c1" }], error: null },                    // (3) courts (1 court → capacity=2)
      { count: 0, data: null, error: null },                    // (4) pending count → 0 (slotsAvailable=2)
      { data: [], error: null },                                 // (5) fetchRecentRosters: recent matches → []
      // (match_players not queried since recentMatchIds is empty)
      { data: [], error: null },                                 // (6) v_queue_with_wait_time → [] (empty queue)
      { data: [], error: null },                                 // (7) queue_entries paused → []
      // activePool.length=0 < 4 → returns before fetchPartnershipCounts/buildOverlapMap
      { data: [], error: null },                                 // (8) promote attempt 2: still no pending
      { count: 0, data: null, error: null },                    // (9) draft-blocking check → 0 drafts
    ]);
    const serviceMock = makeMockClient([
      { data: { created_by: "test-user" }, error: null }, // sessions → organizer ownership check
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);
    vi.mocked(createServiceClient).mockReturnValue(serviceMock as never);

    const result = await callNextMatch(SESSION_ID, COURT_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not enough players/i);
  });

});
