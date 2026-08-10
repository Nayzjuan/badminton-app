// ============================================================
// Unit Tests: fetchSessionMatchSnapshot + the three pure derivations
// ============================================================
//
// The engine used to issue SEVEN queries per slot across three helpers
// (fetchRecentRosters 2 / fetchPartnershipCounts 2 / buildOverlapMap 3), all
// reading overlapping slices of the same two tables. They are now ONE snapshot
// read plus three in-memory projections. (The slot's read phase was 8 deep
// counting fetchActivePool's separate v_queue_with_wait_time read, which is
// unchanged — that is where the "8 → 3" figure in matchmaking-db.ts comes from.)
//
// A temporary differential harness proved the merge equivalent to the three
// deleted helpers before they were removed; it was deleted with them, since an
// oracle that compares against code which no longer exists cannot be run again.
// This file is its permanent replacement. It pins the properties that the
// differential run was actually protecting, which are NOT "the numbers come out
// the same" but:
//
//   SNAP-1/2/3  the ordering invariant — ordering stays in SQL, the returned
//               prefix is deterministic under created_at ties, and nothing in
//               the derivations re-sorts or string-compares timestamps
//   SNAP-4      the row ceiling fails CLOSED and costs no second query
//   SNAP-5/6    a query error fails CLOSED, never a partial snapshot
//   SNAP-7      { data: null } is treated as "no matches", not as an error
//   SNAP-8..12  the derivations themselves (lookback windows, team bucketing,
//               overlap weights, the anchor-scoping that removed the old
//               global .limit(200) truncation bug)
//   SNAP-13     fetchPartnershipCounts stays fail-SOFT for its non-engine caller
//
// Mock strategy: a small PostgREST-shaped fake that RECORDS the chain calls
// (select/eq/in/order) so the SQL-side ordering can be asserted directly. It
// deliberately does not sort anything itself — if the production code ever
// starts re-sorting in JS, the row order it receives is the order it must
// return, and SNAP-2/3 will catch the difference.
// ============================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchSessionMatchSnapshot,
  deriveRecentRosters,
  derivePairCounts,
  deriveOverlapMap,
  fetchPartnershipCounts,
  type DbClient,
  type SessionMatchSnapshot,
} from "@/lib/matchmaking-db";
import { pairKey } from "@/lib/matchmaking-core";
import {
  SESSION_MATCH_SNAPSHOT_CEILING,
  ROSTER_LOOKBACK_COUNT,
  ANTI_REPEAT_LOOKBACK,
  OVERLAP_WEIGHT_TEAMMATE,
  OVERLAP_WEIGHT_OPPONENT,
  COMMITTED_MATCH_STATUSES,
} from "@/lib/constants";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

type Resp = { data: unknown; error: { message: string } | null };
type Call = { table: string; method: string; args: unknown[] };

/**
 * PostgREST-shaped fake. `responses` is consumed FIFO by from(); every chain
 * method is recorded so tests can assert the query shape (which is where the
 * ordering guarantee now lives).
 */
function makeDb(responses: Resp[]) {
  const calls: Call[] = [];
  const tables: string[] = [];
  let idx = 0;

  const from = vi.fn((table: string) => {
    tables.push(table);
    const response = responses[idx++] ?? { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit"]) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b["then"] = (ok: (v: Resp) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve(response).then(ok, err);
    return b;
  });

  return { from, calls, tables } as unknown as DbClient & { calls: Call[]; tables: string[] };
}

/** Convenience: build a snapshot directly, bypassing the DB layer. */
function snapshotOf(matches: { id: string; roster: [string, string][] }[]): SessionMatchSnapshot {
  return {
    matchIds: matches.map((m) => m.id),
    rowsByMatch: new Map(
      matches.map((m) => [m.id, m.roster.map(([player_id, team]) => ({ player_id, team }))])
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════
// The ordering invariant
// ═════════════════════════════════════════════════════════════

describe("fetchSessionMatchSnapshot — ordering invariant", () => {
  it("SNAP-1: orders in SQL by created_at DESC then id DESC, scoped to committed statuses", async () => {
    const db = makeDb([
      { data: [{ id: "m2" }, { id: "m1" }], error: null },
      { data: [], error: null },
    ]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(true);

    const orders = db.calls.filter((c) => c.table === "matches" && c.method === "order");
    // Both keys, in this sequence — created_at alone is not deterministic here
    // because a burst writes one created_at for every row it commits.
    expect(orders).toEqual([
      { table: "matches", method: "order", args: ["created_at", { ascending: false }] },
      { table: "matches", method: "order", args: ["id", { ascending: false }] },
    ]);

    const statusFilter = db.calls.find((c) => c.table === "matches" && c.method === "in");
    expect(statusFilter?.args).toEqual(["status", COMMITTED_MATCH_STATUSES]);
    const sessionFilter = db.calls.find((c) => c.table === "matches" && c.method === "eq");
    expect(sessionFilter?.args).toEqual(["session_id", SESSION_ID]);
  });

  it("SNAP-2: created_at ties do not disturb the prefix — DB row order is returned verbatim", async () => {
    // Six matches the DB emitted as one tie-group (identical created_at, so the
    // id DESC tiebreak decided the order). If anything re-sorted in JS, a stable
    // sort on an all-equal key could still permute this — the assertion is that
    // the array comes back byte-for-byte as delivered.
    const tied = ["m6", "m5", "m4", "m3", "m2", "m1"];
    const db = makeDb([
      { data: tied.map((id) => ({ id })), error: null },
      { data: [], error: null },
    ]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok && result.snapshot.matchIds).toEqual(tied);
  });

  it("SNAP-3: the matches select projects id only — no timestamp ever reaches JS", async () => {
    // Fractional-second formatting is a real hazard the moment a timestamp
    // crosses into JS: "…T10:00:00+00" and "…T10:00:00.000000+00" are the same
    // instant with different string lengths, and localeCompare is locale- and
    // ICU-dependent. Not selecting created_at at all is what makes that
    // unreachable, so the projection is the assertion.
    const db = makeDb([
      { data: [{ id: "m1" }], error: null },
      { data: [], error: null },
    ]);
    await fetchSessionMatchSnapshot(db, SESSION_ID);

    const select = db.calls.find((c) => c.table === "matches" && c.method === "select");
    expect(select?.args).toEqual(["id"]);
  });
});

// ═════════════════════════════════════════════════════════════
// Fail-closed behaviour
// ═════════════════════════════════════════════════════════════

describe("fetchSessionMatchSnapshot — fails closed", () => {
  it("SNAP-4: above the row ceiling → ok:false, and the roster query is never issued", async () => {
    const tooMany = Array.from({ length: SESSION_MATCH_SNAPSHOT_CEILING + 1 }, (_, i) => ({
      id: `m${i}`,
    }));
    const db = makeDb([{ data: tooMany, error: null }]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(String(SESSION_MATCH_SNAPSHOT_CEILING));
      expect(result.reason).toContain(String(SESSION_MATCH_SNAPSHOT_CEILING + 1));
    }
    // Bailing before the second read is the whole point of an early ceiling.
    expect(db.tables).toEqual(["matches"]);
  });

  it("SNAP-4b: exactly at the ceiling is allowed (boundary is >, not >=)", async () => {
    const atLimit = Array.from({ length: SESSION_MATCH_SNAPSHOT_CEILING }, (_, i) => ({
      id: `m${i}`,
    }));
    const db = makeDb([
      { data: atLimit, error: null },
      { data: [], error: null },
    ]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(true);
    expect(db.tables).toEqual(["matches", "match_players"]);
  });

  it("SNAP-5: matches query error → ok:false with the driver message surfaced", async () => {
    const db = makeDb([{ data: null, error: { message: "connection reset" } }]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("connection reset");
    expect(db.tables).toEqual(["matches"]);
  });

  it("SNAP-6: match_players query error → ok:false, never a partial snapshot", async () => {
    const db = makeDb([
      { data: [{ id: "m1" }, { id: "m2" }], error: null },
      { data: null, error: { message: "statement timeout" } },
    ]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("statement timeout");
    // The match IDs succeeded, but half a snapshot is worse than none: it would
    // read every genuine repeat as a fresh pairing.
    expect(result).not.toHaveProperty("snapshot");
  });

  it("SNAP-7: { data: null, error: null } is treated as 'no matches', not as an error", async () => {
    const db = makeDb([{ data: null, error: null }]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.matchIds).toEqual([]);
      expect(result.snapshot.rowsByMatch.size).toBe(0);
    }
    expect(db.tables).toEqual(["matches"]);
  });

  it("SNAP-7b: an empty session short-circuits — one query, empty snapshot", async () => {
    const db = makeDb([{ data: [], error: null }]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok && result.snapshot.matchIds).toEqual([]);
    expect(db.tables).toEqual(["matches"]);
  });

  it("SNAP-7c: rosters are grouped by match_id, and matches with no rows are absent", async () => {
    const db = makeDb([
      { data: [{ id: "m1" }, { id: "m2" }], error: null },
      {
        data: [
          { match_id: "m1", player_id: "p1", team: "a" },
          { match_id: "m1", player_id: "p2", team: "b" },
        ],
        error: null,
      },
    ]);

    const result = await fetchSessionMatchSnapshot(db, SESSION_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.matchIds).toEqual(["m1", "m2"]);
    expect(result.snapshot.rowsByMatch.get("m1")).toEqual([
      { player_id: "p1", team: "a" },
      { player_id: "p2", team: "b" },
    ]);
    // m2 has no roster rows — it stays in matchIds but out of rowsByMatch, and
    // the derivations skip it rather than emitting an empty roster.
    expect(result.snapshot.rowsByMatch.has("m2")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// deriveRecentRosters
// ═════════════════════════════════════════════════════════════

describe("deriveRecentRosters", () => {
  it("SNAP-8: returns at most ROSTER_LOOKBACK_COUNT rosters, newest-first, unsorted", () => {
    const matches = Array.from({ length: ROSTER_LOOKBACK_COUNT + 5 }, (_, i) => ({
      id: `m${i}`,
      roster: [
        [`a${i}`, "a"],
        [`b${i}`, "b"],
      ] as [string, string][],
    }));

    const rosters = deriveRecentRosters(snapshotOf(matches));
    expect(rosters).toHaveLength(ROSTER_LOOKBACK_COUNT);
    // Prefix of matchIds, in order — m0 is newest because the SQL sorted DESC.
    expect(rosters[0]).toEqual(["a0", "b0"]);
    expect(rosters[ROSTER_LOOKBACK_COUNT - 1]).toEqual([
      `a${ROSTER_LOOKBACK_COUNT - 1}`,
      `b${ROSTER_LOOKBACK_COUNT - 1}`,
    ]);
  });

  it("SNAP-8b: a match with no roster rows is skipped, not emitted as []", () => {
    const snapshot: SessionMatchSnapshot = {
      matchIds: ["m1", "m2", "m3"],
      rowsByMatch: new Map([
        ["m1", [{ player_id: "p1", team: "a" }]],
        ["m3", [{ player_id: "p3", team: "a" }]],
      ]),
    };

    expect(deriveRecentRosters(snapshot)).toEqual([["p1"], ["p3"]]);
  });
});

// ═════════════════════════════════════════════════════════════
// derivePairCounts
// ═════════════════════════════════════════════════════════════

describe("derivePairCounts", () => {
  it("SNAP-9: counts same-team pairs as partnerships and cross-team pairs as opponents", () => {
    const snapshot = snapshotOf([
      {
        id: "m1",
        roster: [
          ["p1", "a"],
          ["p2", "a"],
          ["p3", "b"],
          ["p4", "b"],
        ],
      },
    ]);

    const { partnershipCounts, opponentCounts } = derivePairCounts(snapshot);

    expect(partnershipCounts.get(pairKey("p1", "p2"))).toBe(1);
    expect(partnershipCounts.get(pairKey("p3", "p4"))).toBe(1);
    expect(partnershipCounts.size).toBe(2);

    // 2×2 = four cross-net pairs.
    expect(opponentCounts.size).toBe(4);
    for (const a of ["p1", "p2"]) {
      for (const b of ["p3", "p4"]) {
        expect(opponentCounts.get(pairKey(a, b))).toBe(1);
      }
    }
  });

  it("SNAP-9b: repeats accumulate across matches, and key order does not matter", () => {
    const roster: [string, string][] = [
      ["p1", "a"],
      ["p2", "a"],
      ["p3", "b"],
      ["p4", "b"],
    ];
    const snapshot = snapshotOf([
      { id: "m1", roster },
      // Same partnership, teams swapped — still one more p1/p2 partnership and
      // one more p1/p3 opponent meeting.
      {
        id: "m2",
        roster: [
          ["p2", "b"],
          ["p1", "b"],
          ["p4", "a"],
          ["p3", "a"],
        ],
      },
    ]);

    const { partnershipCounts, opponentCounts } = derivePairCounts(snapshot);
    expect(partnershipCounts.get(pairKey("p1", "p2"))).toBe(2);
    expect(partnershipCounts.get(pairKey("p2", "p1"))).toBe(2);
    expect(opponentCounts.get(pairKey("p1", "p3"))).toBe(2);
  });

  it("SNAP-9c: a malformed one-sided match yields partnerships but no opponent pairs", () => {
    const snapshot = snapshotOf([
      {
        id: "m1",
        roster: [
          ["p1", "a"],
          ["p2", "a"],
          ["p3", "a"],
        ],
      },
    ]);

    const { partnershipCounts, opponentCounts } = derivePairCounts(snapshot);
    expect(partnershipCounts.size).toBe(3); // p1p2, p1p3, p2p3
    // Guessing an opponent relationship out of a single bucket would invent
    // history the match never had.
    expect(opponentCounts.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
// deriveOverlapMap
// ═════════════════════════════════════════════════════════════

describe("deriveOverlapMap", () => {
  it("SNAP-10: weights teammates and opponents per the configured constants", () => {
    const snapshot = snapshotOf([
      {
        id: "m1",
        roster: [
          ["anchor", "a"],
          ["mate", "a"],
          ["foe1", "b"],
          ["foe2", "b"],
        ],
      },
    ]);

    const overlap = deriveOverlapMap(snapshot, "anchor");
    expect(overlap.get("mate")).toBe(OVERLAP_WEIGHT_TEAMMATE);
    expect(overlap.get("foe1")).toBe(OVERLAP_WEIGHT_OPPONENT);
    expect(overlap.get("foe2")).toBe(OVERLAP_WEIGHT_OPPONENT);
    // The anchor never weighs against itself.
    expect(overlap.has("anchor")).toBe(false);
  });

  it("SNAP-11: only the anchor's ANTI_REPEAT_LOOKBACK most recent matches count", () => {
    // One extra match beyond the window, containing a player who appears nowhere
    // else. Matches the anchor is NOT in must not consume window budget.
    const withAnchor = Array.from({ length: ANTI_REPEAT_LOOKBACK }, (_, i) => ({
      id: `m${i}`,
      roster: [
        ["anchor", "a"],
        [`mate${i}`, "a"],
      ] as [string, string][],
    }));
    const snapshot = snapshotOf([
      ...withAnchor,
      {
        id: "too-old",
        roster: [
          ["anchor", "a"],
          ["forgotten", "a"],
        ] as [string, string][],
      },
    ]);

    const overlap = deriveOverlapMap(snapshot, "anchor");
    expect(overlap.size).toBe(ANTI_REPEAT_LOOKBACK);
    expect(overlap.has("forgotten")).toBe(false);
  });

  it("SNAP-11b: matches without the anchor are skipped without consuming the window", () => {
    // ANTI_REPEAT_LOOKBACK decoys the anchor sat out, newest-first, THEN the
    // anchor's own match. The decoy count is deliberately == the window size:
    // with fewer, an implementation that increments `seen` before the
    // anchor-membership check would still reach m1 and the test would pass on a
    // broken derivation. At exactly ANTI_REPEAT_LOOKBACK, that mutant exhausts
    // the window on decoys alone and never sees "mate".
    const decoys = Array.from({ length: ANTI_REPEAT_LOOKBACK }, (_, i) => ({
      id: `x${i + 1}`,
      roster: [
        ["other1", "a"],
        ["other2", "b"],
      ] as [string, string][],
    }));
    const snapshot = snapshotOf([
      ...decoys,
      {
        id: "m1",
        roster: [
          ["anchor", "a"],
          ["mate", "a"],
        ] as [string, string][],
      },
    ]);

    const overlap = deriveOverlapMap(snapshot, "anchor");
    // The old global-limit implementation could lose m1 behind unrelated rows;
    // scoping to the session snapshot means the anchor's own match always lands.
    expect(overlap.get("mate")).toBe(OVERLAP_WEIGHT_TEAMMATE);
    expect(overlap.has("other1")).toBe(false);
  });

  it("SNAP-12: repeated co-appearances accumulate weight", () => {
    const roster: [string, string][] = [
      ["anchor", "a"],
      ["mate", "a"],
    ];
    const snapshot = snapshotOf([
      { id: "m1", roster },
      { id: "m2", roster },
    ]);

    expect(deriveOverlapMap(snapshot, "anchor").get("mate")).toBe(OVERLAP_WEIGHT_TEAMMATE * 2);
  });

  it("SNAP-12b: an anchor with no history yields an empty map", () => {
    const snapshot = snapshotOf([
      {
        id: "m1",
        roster: [
          ["p1", "a"],
          ["p2", "b"],
        ] as [string, string][],
      },
    ]);

    expect(deriveOverlapMap(snapshot, "stranger").size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
// fetchPartnershipCounts — the non-engine wrapper
// ═════════════════════════════════════════════════════════════

describe("fetchPartnershipCounts", () => {
  it("SNAP-13: fails SOFT — a snapshot error yields empty maps and a warning, not a throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeDb([{ data: null, error: { message: "boom" } }]);

    const { partnershipCounts, opponentCounts } = await fetchPartnershipCounts(db, SESSION_ID);

    // Its only caller is the organizer's repeat-pairing badge, which drops a
    // non-success silently. Failing closed there would blank the badge with no
    // explanation; failing soft shows the previous counts.
    expect(partnershipCounts.size).toBe(0);
    expect(opponentCounts.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "[matchmaking-db] fetchPartnershipCounts:",
      expect.stringContaining("boom")
    );
  });

  it("SNAP-13b: on success it returns the same counts as derivePairCounts", async () => {
    const db = makeDb([
      { data: [{ id: "m1" }], error: null },
      {
        data: [
          { match_id: "m1", player_id: "p1", team: "a" },
          { match_id: "m1", player_id: "p2", team: "a" },
          { match_id: "m1", player_id: "p3", team: "b" },
          { match_id: "m1", player_id: "p4", team: "b" },
        ],
        error: null,
      },
    ]);

    const { partnershipCounts, opponentCounts } = await fetchPartnershipCounts(db, SESSION_ID);
    expect(partnershipCounts.get(pairKey("p1", "p2"))).toBe(1);
    expect(opponentCounts.get(pairKey("p1", "p3"))).toBe(1);
  });
});
