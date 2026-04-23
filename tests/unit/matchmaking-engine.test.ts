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

import { createClient } from "@/utils/supabase/server";
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

  // All query chain methods return `b` unchanged
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
 * NOTE: `v_recent_pairings` (used by buildOverlapMap) is only queried when
 * the pool has ≥4 active players. Tests with empty queues will never reach
 * that query — no need to add a response for it in those cases.
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

  return { from, rpc, queriedTables };
}

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
      { data: [], error: null }, // matches fetch → empty
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      "session-1",
      "court-1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no on-deck/i);
    // Only the initial fetch was attempted
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it("returns success:false with the same message on a DB error during fetch", async () => {
    const mock = makeMockClient([
      { data: null, error: { message: "connection timeout" } }, // matches fetch error
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      "session-1",
      "court-1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no on-deck/i);
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
      "session-1",
      "court-1"
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already promoted/i);
    // Stopped after the failed CAS update
    expect(mock.from).toHaveBeenCalledTimes(2);
  });

  it("returns success:false with error detail on a DB error during the CAS update", async () => {
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },                         // fetch
      { data: null, error: { message: "FK violation" } },         // update → DB error
    ]);

    const result = await promoteOnDeckMatchInternal(
      mock as never,
      "session-1",
      "court-1"
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
      "session-1",
      "court-1"
    );

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
    expect(result.teamA).toEqual([]);
    expect(result.teamB).toEqual([]);
    // 5 queries: fetch, update, courts, match_players, profiles
    expect(mock.from).toHaveBeenCalledTimes(5);
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
      "session-1",
      "court-1"
    );

    expect(result.success).toBe(true);
    expect(result.teamA).toEqual(["Alice", "Bob"]);
    expect(result.teamB).toEqual(["Charlie", "Diana"]);
    expect(mock.from).toHaveBeenCalledTimes(6);
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
      "session-1",
      "court-1"
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
      "session-1",
      "court-1"
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
    vi.mocked(createClient).mockResolvedValue(mock as never);

    await runEngineForSession("session-1");

    // Only the sessions toggle check was made
    expect(mock.from).toHaveBeenCalledTimes(1);
    expect(mock.queriedTables).toEqual(["sessions"]);
  });

  it("queries courts when toggle is ON (proceeds into runEngineInternal)", async () => {
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [], error: null },                               // courts → 0 courts
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    await runEngineForSession("session-1");

    // At least sessions + courts queried
    expect(mock.queriedTables).toContain("sessions");
    expect(mock.queriedTables).toContain("courts");
  });

  it("stops after courts query when courtCount is 0 (nothing to fill)", async () => {
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null }, // sessions
      { data: [], error: null },                               // courts → 0
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    await runEngineForSession("session-1");

    // Only sessions + courts: no pending-match count queried
    expect(mock.from).toHaveBeenCalledTimes(2);
    expect(mock.queriedTables).not.toContain("matches");
  });

  it("stops filling when on-deck is already at capacity", async () => {
    // 2 courts → capacity = courtCount = 2
    // 2 pending matches already → slotsAvailable = 0 → no match creation
    const mock = makeMockClient([
      { data: { is_auto_matchmaking_on: true }, error: null },  // sessions
      { data: [{ id: "c1" }, { id: "c2" }], error: null },      // courts (2)
      { count: 2, data: null, error: null },                    // pending count = 2 → at capacity
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    await runEngineForSession("session-1");

    // sessions + courts + pending count = 3 from() calls; no queue fetch
    expect(mock.from).toHaveBeenCalledTimes(3);
    expect(mock.queriedTables).not.toContain("v_queue_with_wait_time");
  });

  it("returns gracefully when the session DB read fails", async () => {
    const mock = makeMockClient([
      { data: null, error: { message: "Table not found" } }, // sessions error
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    // Should not throw
    await expect(runEngineForSession("session-1")).resolves.toBeUndefined();
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it("handles RPC failure in executeMatch without throwing — engine logs and exits cleanly", async () => {
    // Exercises the G-1 path: rpc("create_match_with_players") returns an error.
    // executeMatch → returns { success: false }. createOneOnDeckMatch → { created: false }.
    // runEngineInternal logs the error and breaks the fill loop.
    // runEngineForSession returns void — no crash, no rethrow.
    //
    // Queue sequence:
    //   sessions(ON) → courts(2) → pending(0, need 1 slot) → fetchRecentRosters(empty)
    //   → v_queue_with_wait_time(4 players) → queue_entries paused(0)
    //   → v_recent_pairings(0 pairings for buildOverlapMap)
    //   → rpc fails → engine exits cleanly
    const fourPlayers = Array.from({ length: 4 }, (_, i) => ({
      id: `entry-p${i}`,
      session_id: "session-1",
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
        { data: [{ id: "c1" }, { id: "c2" }], error: null },      // courts (2 → capacity=1)
        { count: 0, data: null, error: null },                    // pending count → 0 (fill 1 slot)
        { data: [], error: null },                                 // fetchRecentRosters: recent completed → []
        // (match_players not queried — recentMatchIds is empty)
        { data: fourPlayers, error: null },                       // v_queue_with_wait_time → 4 players
        { data: [], error: null },                                 // queue_entries paused → []
        { data: [], error: null },                                 // v_recent_pairings (buildOverlapMap) → []
      ],
      [{ data: null, error: { message: "unique constraint violation" } }] // rpc → error
    );
    vi.mocked(createClient).mockResolvedValue(mock as never);

    // Engine should not throw even when rpc fails
    await expect(runEngineForSession("session-1")).resolves.toBeUndefined();
    // rpc was called — engine reached executeMatch before failing
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledWith("create_match_with_players", expect.any(Object));
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
    // promoteOnDeckMatchInternal (5 calls) + runEngineInternal (courts[1] + pending at cap[1])
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },        // matches fetch
      { data: { id: "match-1" }, error: null },   // matches update (CAS)
      { data: null, error: null },                // courts update
      { data: [], error: null },                  // match_players → empty
      { data: [], error: null },                  // profiles → empty
      { data: [{ id: "c1" }], error: null },      // runEngineInternal: courts query
      { count: 1, data: null, error: null },      // runEngineInternal: pending count → at capacity
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    const result = await callNextMatch("session-1", "court-1");

    expect(result.success).toBe(true);
    expect(result.matchId).toBe("match-1");
  });

  it("toggle bypass: after successful promotion, engine runs WITHOUT checking the toggle", async () => {
    // If callNextMatch went through runEngineForSession, it would query "sessions" first.
    // If it calls runEngineInternal directly, the next table after promotion is "courts".
    const mock = makeMockClient([
      { data: [MOCK_MATCH], error: null },        // matches fetch (promotion)
      { data: { id: "match-1" }, error: null },   // matches update (CAS)
      { data: null, error: null },                // courts update
      { data: [], error: null },                  // match_players → empty
      { data: [], error: null },                  // profiles → empty
      { data: [{ id: "c1" }], error: null },      // ← first query AFTER promotion = courts (not sessions)
      { count: 1, data: null, error: null },      // pending count
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    await callNextMatch("session-1", "court-1");

    // The 6th query (index 5) must be "courts", NOT "sessions".
    // "sessions" would appear here if runEngineForSession (toggle check) was called.
    expect(mock.queriedTables[5]).toBe("courts");
    // "sessions" should NOT appear after the 5 promotion calls
    const postPromotionTables = mock.queriedTables.slice(5);
    expect(postPromotionTables).not.toContain("sessions");
  });

  it("returns 'paused' message when no on-deck match exists and toggle is OFF", async () => {
    const mock = makeMockClient([
      { data: [], error: null },                                   // matches fetch → empty
      { data: { is_auto_matchmaking_on: false }, error: null },   // sessions → toggle OFF
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    const result = await callNextMatch("session-1", "court-1");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/paused|auto-matchmaking/i);
  });

  it("returns 'not enough players' when toggle is ON but queue is empty", async () => {
    // Sequence:
    //   Attempt 1 (promote): matches → [] (no on-deck)
    //   Toggle check: sessions → ON
    //   runEngineInternal: courts → [c1], pending → 0 slots, recent rosters → []
    //   runAlgorithm: v_queue_with_wait_time → [] (empty queue), queue_entries paused → []
    //   → "Not enough players" → engine stops, no match created
    //   Attempt 2 (promote retry): matches → [] still (nothing was created)
    const mock = makeMockClient([
      { data: [], error: null },                                 // promote attempt 1: no pending
      { data: { is_auto_matchmaking_on: true }, error: null },  // sessions → toggle ON
      { data: [{ id: "c1" }], error: null },                    // courts (1 court)
      { count: 0, data: null, error: null },                    // pending count → 0 slots available
      { data: [], error: null },                                 // recent completed matches
      // (match_players not queried since recentMatchIds is empty)
      { data: [], error: null },                                 // v_queue_with_wait_time → []
      { data: [], error: null },                                 // queue_entries paused → []
      { data: [], error: null },                                 // promote attempt 2: still no pending
    ]);
    vi.mocked(createClient).mockResolvedValue(mock as never);

    const result = await callNextMatch("session-1", "court-1");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not enough players/i);
  });

});
