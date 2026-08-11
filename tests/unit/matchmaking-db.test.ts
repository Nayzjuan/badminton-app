// ============================================================
// Unit Tests: matchmaking-db — fetchActivePool rest filter
//                            + fetchRecentClearedRosters parsing
// ============================================================
//
// fetchActivePool applies a MIN_REST_MINUTES filter after fetching
// the raw pool from Supabase. The filter and its fallback are pure
// in-memory logic — tested here by mocking the Supabase responses.
//
// Cases covered:
//   RF-1: first-time players (games_played=0) always pass regardless of wait
//   RF-2: rested players (games_played>0, wait≥MIN_REST_MINUTES) pass
//   RF-3: under-rested players are excluded when ≥4 rested remain
//   RF-4: fallback — when <4 rested players, return all active (waive filter)
//   RF-5: paused players are excluded from active before rest filter runs
//
// fetchRecentClearedRosters reads organizer clear events (rejection memory):
//   CR-1: parses both clear reasons into complete player-ID foursomes
//   CR-2: skips foreign reasons, partial rosters, and malformed payloads
//   CR-3: fail-OPEN — a query error returns [] and never throws
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { fetchActivePool, fetchRecentClearedRosters, type DbClient } from "@/lib/matchmaking-db";
import { MIN_REST_MINUTES, PLAYERS_PER_MATCH } from "@/lib/constants";

// ── Mock factory ─────────────────────────────────────────────
// Creates a minimal Supabase mock that returns `poolRows` for the
// v_queue_with_wait_time query. The chain is chainable (select / eq /
// order) and thenable (await-able at the end of the chain). Paused
// exclusion now reads is_paused off the pool rows themselves, so there
// is no longer a supplemental queue_entries query to mock.

type AnyRow = Record<string, unknown>;

// Returned as DbClient via a double cast, once, here. The double cast is the
// honest signature for a deliberately partial stand-in: this object implements
// only `from`, which is all fetchActivePool touches, and pretending otherwise
// by widening the parameter would weaken the real call sites.
function makeSupabaseMock(poolRows: AnyRow[]): DbClient {
  function makeChain(result: { data: AnyRow[]; error: null }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain["select"] = vi.fn(self);
    chain["eq"] = vi.fn(self);
    chain["order"] = vi.fn(self);
    // Makes the chain awaitable: `await chain` calls `then`.
    chain["then"] = (
      resolve: (v: { data: AnyRow[]; error: null }) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    chain["catch"] = (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject);
    chain["finally"] = (fn: () => void) => Promise.resolve(result).finally(fn);
    return chain;
  }

  return {
    from: vi.fn(() => makeChain({ data: poolRows, error: null })),
  } as unknown as DbClient;
}

// ── Player factory ────────────────────────────────────────────

function makeRow(id: string, gamesPlayed: number, waitMinutes: number): AnyRow {
  return {
    player_id: id,
    games_played: gamesPlayed,
    wait_minutes: waitMinutes,
    display_name: id,
    skill_level: "intermediate",
    skill_level_int: 3,
    is_bottleneck: false,
    is_paused: false,
    status: "waiting",
    session_id: "sess-1",
    joined_at: new Date().toISOString(),
  };
}

const SESSION_ID = "sess-1";

// ── Tests ─────────────────────────────────────────────────────

describe("fetchActivePool — rest filter", () => {
  it("RF-1: first-time players (games_played=0) always pass regardless of wait", async () => {
    // Two brand-new players with 0 wait and 0 games — should not be filtered out.
    const firstTimers = [
      makeRow("a", 0, 0),
      makeRow("b", 0, 0),
      makeRow("c", 0, 0),
      makeRow("d", 0, 0),
    ];
    const supabase = makeSupabaseMock(firstTimers);
    const pool = await fetchActivePool(supabase, SESSION_ID);
    expect(pool.map((p) => p.player_id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("RF-2: rested players (games_played>0, wait≥MIN_REST_MINUTES) pass the filter", async () => {
    const rows = [
      makeRow("a", 1, MIN_REST_MINUTES), // exactly at boundary — passes
      makeRow("b", 2, MIN_REST_MINUTES + 5), // above boundary — passes
      makeRow("c", 0, 0), // first-timer — always passes
      makeRow("d", 3, MIN_REST_MINUTES + 1), // above boundary — passes
    ];
    const supabase = makeSupabaseMock(rows);
    const pool = await fetchActivePool(supabase, SESSION_ID);
    expect(pool.map((p) => p.player_id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("RF-3: under-rested players are excluded when ≥PLAYERS_PER_MATCH rested remain", async () => {
    // "fresh" has games>0 but wait < MIN_REST_MINUTES → should be excluded.
    // The other 4 are rested → filter returns only those 4.
    const rows = [
      makeRow("rested1", 1, MIN_REST_MINUTES),
      makeRow("rested2", 2, MIN_REST_MINUTES + 3),
      makeRow("rested3", 0, 0), // first-timer, always eligible
      makeRow("rested4", 3, MIN_REST_MINUTES + 1),
      makeRow("fresh", 1, MIN_REST_MINUTES - 1), // under-rested: excluded
    ];
    const supabase = makeSupabaseMock(rows);
    const pool = await fetchActivePool(supabase, SESSION_ID);
    expect(pool.map((p) => p.player_id)).not.toContain("fresh");
    expect(pool).toHaveLength(4);
  });

  it(`RF-4: fallback — when <${PLAYERS_PER_MATCH} rested players survive the filter, return all active`, async () => {
    // Only 3 rested players — below PLAYERS_PER_MATCH. Waive filter and return all 4.
    const rows = [
      makeRow("rested1", 1, MIN_REST_MINUTES),
      makeRow("rested2", 0, 0), // first-timer
      makeRow("rested3", 2, MIN_REST_MINUTES + 2),
      makeRow("fresh", 1, MIN_REST_MINUTES - 1), // would be excluded, but fallback kicks in
    ];
    const supabase = makeSupabaseMock(rows);
    const pool = await fetchActivePool(supabase, SESSION_ID);
    // Fallback: all 4 returned (filter waived)
    expect(pool).toHaveLength(4);
    expect(pool.map((p) => p.player_id).sort()).toEqual(["fresh", "rested1", "rested2", "rested3"]);
  });

  it("RF-5: paused players are excluded before the rest filter is applied", async () => {
    // "paused" is rested (wait≥MIN_REST) but flagged is_paused → excluded entirely.
    const rows = [
      makeRow("a", 0, 0),
      makeRow("b", 1, MIN_REST_MINUTES),
      makeRow("c", 0, 0),
      makeRow("d", 0, 0),
      { ...makeRow("paused", 2, MIN_REST_MINUTES + 5), is_paused: true },
    ];
    const supabase = makeSupabaseMock(rows);
    const pool = await fetchActivePool(supabase, SESSION_ID);
    expect(pool.map((p) => p.player_id)).not.toContain("paused");
    expect(pool).toHaveLength(4);
  });
});

// ── fetchRecentClearedRosters ─────────────────────────────────
// Mock covering the longer filter chain (eq×3 / gte / order / limit) plus an
// error variant — the helper must fail OPEN (empty array), the opposite
// posture from the fail-closed match snapshot.

function makeEventsMock(result: { data: AnyRow[] | null; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["select", "eq", "gte", "order", "limit"]) chain[m] = vi.fn(self);
  chain["then"] = (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { from: vi.fn(() => chain) } as unknown as DbClient;
}

const roster = (...ids: string[]) => ids.map((id) => ({ team: "a", player_id: id }));

describe("fetchRecentClearedRosters — rejection memory parsing", () => {
  it("CR-1: parses both organizer clear reasons into complete foursomes", async () => {
    const supabase = makeEventsMock({
      data: [
        { payload: { reason: "on_deck_cleared", roster: roster("a", "b", "c", "d") } },
        { payload: { reason: "batch_clear_unpublished", roster: roster("e", "f", "g", "h") } },
      ],
      error: null,
    });
    const rosters = await fetchRecentClearedRosters(supabase, SESSION_ID);
    expect(rosters).toEqual([
      ["a", "b", "c", "d"],
      ["e", "f", "g", "h"],
    ]);
  });

  it("CR-2: skips foreign reasons, partial rosters, and malformed payloads", async () => {
    const supabase = makeEventsMock({
      data: [
        // Foreign reason (not an organizer rejection) — skipped.
        { payload: { reason: "player_left", roster: roster("a", "b", "c", "d") } },
        // Partial roster (3 ids) can never equal a proposed four — skipped.
        { payload: { reason: "on_deck_cleared", roster: roster("a", "b", "c") } },
        // Malformed payloads — skipped, never thrown.
        { payload: null },
        { payload: { reason: "on_deck_cleared" } }, // roster missing
        { payload: { reason: "on_deck_cleared", roster: [{ team: "a" }] } }, // ids missing
        { payload: { reason: "on_deck_cleared", roster: "corrupt" } }, // non-array roster
        // Duplicate ids: 4 rows but 3 distinct players — deduped, then dropped
        // as incomplete (would otherwise degrade exact-set matching to ≥3-overlap).
        { payload: { reason: "on_deck_cleared", roster: roster("a", "a", "b", "c") } },
        // One valid event survives.
        { payload: { reason: "on_deck_cleared", roster: roster("w", "x", "y", "z") } },
      ],
      error: null,
    });
    const rosters = await fetchRecentClearedRosters(supabase, SESSION_ID);
    expect(rosters).toEqual([["w", "x", "y", "z"]]);
  });

  it("CR-3: fail-OPEN — a query error returns [] (missing rejection memory only re-deals a hand)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supabase = makeEventsMock({ data: null, error: { message: "statement timeout" } });
    await expect(fetchRecentClearedRosters(supabase, SESSION_ID)).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("fetchRecentClearedRosters"),
      expect.stringContaining("statement timeout")
    );
    warnSpy.mockRestore();
  });
});
