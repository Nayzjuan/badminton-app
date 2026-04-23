// ============================================================
// Unit Tests: Matchmaking Core — Pure Function Suite
// ============================================================
//
// Covers all 7 exported pure functions in matchmaking-core.ts.
// No Supabase mocks needed — these are database-free helpers.
//
// Functions under test:
//   computePriorityScore  — priority / Red Zone scoring
//   isGroupValid          — pairwise skill variance check
//   snakeDraft            — balanced team assignment
//   overlapWithRoster     — count shared players in a roster
//   isDiversityViolation  — detect repeat match groups
//   scoreCandidates       — rank candidates with overlap penalty
//   buildCombinationGroup — N-choose-3 combination search
// ============================================================

import { describe, it, expect } from "vitest";
import {
  computePriorityScore,
  isGroupValid,
  snakeDraft,
  overlapWithRoster,
  isDiversityViolation,
  scoreCandidates,
  buildCombinationGroup,
} from "@/lib/matchmaking-core";
import {
  CRITICAL_WAIT_MINUTES,
  GAME_PENALTY_MINUTES,
  RED_ZONE_SCORE_FLOOR,
  SKILL_VARIANCE_MAX,
} from "@/lib/constants";
import type { ScoredPlayer } from "@/lib/matchmaking-core";
import type { QueueWithWaitTime } from "@/types/database";

// ── Shared factory ────────────────────────────────────────────
// Creates a minimal ScoredPlayer. Fields irrelevant to a given
// test receive safe defaults (skill 3, 5 min wait, 0 games).

function makePlayer(
  id: string,
  opts: {
    skillInt: number;
    waitMinutes?: number;
    gamesPlayed?: number;
  }
): ScoredPlayer {
  const waitMinutes = opts.waitMinutes ?? 5;
  const gamesPlayed = opts.gamesPlayed ?? 0;

  const base: QueueWithWaitTime = {
    id: `entry-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: new Date(Date.now() - waitMinutes * 60_000).toISOString(),
    games_played: gamesPlayed,
    status: "waiting",
    position: null,
    is_paused: false,
    created_at: new Date().toISOString(),
    display_name: `Player-${id}`,
    skill_level: "intermediate",
    skill_level_int: opts.skillInt,
    wait_minutes: waitMinutes,
    is_bottleneck: false,
  };

  return { ...base, priorityScore: computePriorityScore(base) };
}

// ─────────────────────────────────────────────────────────────
// computePriorityScore
// ─────────────────────────────────────────────────────────────
// Formula:
//   Normal   (wait < 25): score = max(0, wait - (games × GAME_PENALTY_MINUTES))
//   Red Zone (wait ≥ 25): score = 1000 + wait  (game debt ignored)
//
// The floor at 0 ensures a player with game debt never scores below a fresh
// joiner. Within the 0-bucket, runAlgorithm uses joined_at ASC as a
// tiebreaker so the longest-waiting player still anchors first.

describe("computePriorityScore", () => {
  it("returns wait_minutes when games_played=0 (normal zone)", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 10, gamesPlayed: 0 });
    expect(computePriorityScore(p)).toBe(10);
  });

  it("subtracts GAME_PENALTY per game played when wait exceeds the penalty (normal zone)", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 15, gamesPlayed: 1 });
    // 15 - 1 × 12 = 3  (positive — no floor needed)
    expect(computePriorityScore(p)).toBe(15 - GAME_PENALTY_MINUTES);
  });

  it("floors at 0 when game debt exceeds wait time — never negative", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 0, gamesPlayed: 2 });
    // max(0, 0 - 2 × 12) = max(0, -24) = 0
    // Within the 0-bucket, joined_at (not score) decides rank order.
    expect(computePriorityScore(p)).toBe(0);
  });

  it("returns 0 for a fresh player with 0 wait and 0 games", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 0, gamesPlayed: 0 });
    expect(computePriorityScore(p)).toBe(0);
  });

  it("returns normal score at wait=24 (one minute below Red Zone boundary)", () => {
    const p = makePlayer("a", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES - 1,
      gamesPlayed: 0,
    });
    expect(computePriorityScore(p)).toBe(CRITICAL_WAIT_MINUTES - 1);
  });

  it("enters Red Zone exactly at CRITICAL_WAIT_MINUTES (25 min)", () => {
    const p = makePlayer("a", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES,
      gamesPlayed: 0,
    });
    // 1000 + 25 = 1025
    expect(computePriorityScore(p)).toBe(RED_ZONE_SCORE_FLOOR + CRITICAL_WAIT_MINUTES);
  });

  it("Red Zone score ignores game debt entirely", () => {
    const withGames = makePlayer("a", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES,
      gamesPlayed: 100,
    });
    const fresh = makePlayer("b", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES,
      gamesPlayed: 0,
    });
    // Both waited 25 min in Red Zone — same score regardless of games played
    expect(computePriorityScore(withGames)).toBe(computePriorityScore(fresh));
  });

  it("Red Zone score grows with wait time beyond the threshold", () => {
    const p30 = makePlayer("a", { skillInt: 3, waitMinutes: 30, gamesPlayed: 0 });
    const p40 = makePlayer("b", { skillInt: 3, waitMinutes: 40, gamesPlayed: 0 });
    // 1000+30 < 1000+40
    expect(computePriorityScore(p30)).toBeLessThan(computePriorityScore(p40));
  });

  it("any Red Zone score outranks any Normal score", () => {
    // Highest possible Normal score: wait=24, games=0 → 24
    const bestNormal = makePlayer("n", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES - 1,
      gamesPlayed: 0,
    });
    // Lowest Red Zone score: wait=25, games=any → 1025
    const lowestRedZone = makePlayer("r", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES,
      gamesPlayed: 999,
    });
    expect(computePriorityScore(lowestRedZone)).toBeGreaterThan(
      computePriorityScore(bestNormal)
    );
  });

  it("treats null wait_minutes as 0 via nullish coalescing", () => {
    // The type says number, but the implementation guards with ?? 0.
    // This ensures runtime safety when the view returns null.
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 0, gamesPlayed: 2 });
    const withNullWait = { ...p, wait_minutes: null as unknown as number };
    // null ?? 0 = 0 → max(0, 0 - 2×12) = 0
    expect(computePriorityScore(withNullWait)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// isGroupValid
// ─────────────────────────────────────────────────────────────
// Returns true iff every pairwise skill diff ≤ maxVariance.

describe("isGroupValid", () => {
  it("returns true for 4 identical skill levels", () => {
    const group = [
      makePlayer("1", { skillInt: 4 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 4 }),
    ];
    expect(isGroupValid(group, SKILL_VARIANCE_MAX)).toBe(true);
  });

  it("returns true when max pairwise diff equals maxVariance (boundary)", () => {
    // Skills: 3, 3, 5, 5 — max diff = |3-5| = 2 = SKILL_VARIANCE_MAX
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 3 }),
      makePlayer("3", { skillInt: 5 }),
      makePlayer("4", { skillInt: 5 }),
    ];
    expect(isGroupValid(group, SKILL_VARIANCE_MAX)).toBe(true);
  });

  it("returns false when any pairwise diff exceeds maxVariance", () => {
    // Skills: 3, 4, 4, 6 — |3-6| = 3 > 2
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 6 }),
    ];
    expect(isGroupValid(group, SKILL_VARIANCE_MAX)).toBe(false);
  });

  it("returns false when max diff equals SKILL_VARIANCE_MAX+1 at tight window (±1)", () => {
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 5 }),
      makePlayer("4", { skillInt: 4 }),
    ];
    // |3-5| = 2 > SKILL_VARIANCE_TARGET(1)
    expect(isGroupValid(group, 1)).toBe(false);
  });

  it("returns true at ±4 window for skills spread across 4 levels", () => {
    // Red Zone expanded window: [2, 4, 4, 6] — max diff = |2-6| = 4
    const group = [
      makePlayer("1", { skillInt: 2 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 6 }),
    ];
    expect(isGroupValid(group, 4)).toBe(true);
  });

  it("returns true for a single player (vacuously — no pairs)", () => {
    const group = [makePlayer("1", { skillInt: 3 })];
    expect(isGroupValid(group, 0)).toBe(true);
  });

  it("returns true for exactly 2 players within variance", () => {
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
    ];
    expect(isGroupValid(group, 1)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// snakeDraft
// ─────────────────────────────────────────────────────────────
// Sorts 4 players DESC by skill, assigns:
//   teamA = [sorted[0] (best), sorted[3] (worst)]
//   teamB = [sorted[1] (2nd),  sorted[2] (3rd)]
// This minimises the inter-team skill gap.

describe("snakeDraft", () => {
  it("produces exactly 2 players per team", () => {
    const players = [
      makePlayer("1", { skillInt: 6 }),
      makePlayer("2", { skillInt: 5 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 3 }),
    ];
    const { teamA, teamB } = snakeDraft(players);
    expect(teamA).toHaveLength(2);
    expect(teamB).toHaveLength(2);
  });

  it("assigns highest + lowest skill to teamA, 2nd + 3rd to teamB", () => {
    const p6 = makePlayer("6", { skillInt: 6 });
    const p5 = makePlayer("5", { skillInt: 5 });
    const p4 = makePlayer("4", { skillInt: 4 });
    const p3 = makePlayer("3", { skillInt: 3 });

    // Pass in shuffled order — snakeDraft sorts internally
    const { teamA, teamB } = snakeDraft([p3, p6, p4, p5]);

    const teamASkills = teamA.map((p) => p.skill_level_int).sort((a, b) => a - b);
    const teamBSkills = teamB.map((p) => p.skill_level_int).sort((a, b) => a - b);

    // teamA gets [6, 3], teamB gets [5, 4]
    expect(teamASkills).toEqual([3, 6]);
    expect(teamBSkills).toEqual([4, 5]);
  });

  it("produces balanced team skill sums for evenly-spaced players", () => {
    // [3, 4, 5, 6] → teamA=[6,3]=9, teamB=[5,4]=9
    const players = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 5 }),
      makePlayer("4", { skillInt: 6 }),
    ];
    const { teamA, teamB } = snakeDraft(players);
    const sumA = teamA.reduce((s, p) => s + p.skill_level_int, 0);
    const sumB = teamB.reduce((s, p) => s + p.skill_level_int, 0);
    expect(sumA).toBe(sumB);
  });

  it("does not mutate the original array order", () => {
    const players = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 6 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 5 }),
    ];
    const originalOrder = players.map((p) => p.player_id);
    snakeDraft(players);
    expect(players.map((p) => p.player_id)).toEqual(originalOrder);
  });

  it("handles all-same-skill players (stable assignment — 2 per team)", () => {
    const players = [
      makePlayer("1", { skillInt: 4 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 4 }),
    ];
    const { teamA, teamB } = snakeDraft(players);
    expect(teamA).toHaveLength(2);
    expect(teamB).toHaveLength(2);
    // All IDs should be accounted for with no duplicates
    const allIds = [...teamA, ...teamB].map((p) => p.player_id);
    expect(new Set(allIds).size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────
// overlapWithRoster
// ─────────────────────────────────────────────────────────────
// Counts how many playerIds appear in a single match roster.

describe("overlapWithRoster", () => {
  it("returns 0 when no player is in the roster", () => {
    expect(overlapWithRoster(["p1", "p2"], ["p3", "p4"])).toBe(0);
  });

  it("returns 1 when exactly one player overlaps", () => {
    expect(overlapWithRoster(["p1", "p2", "p3", "p4"], ["p1", "p5", "p6", "p7"])).toBe(1);
  });

  it("returns 4 when all players overlap (exact repeat)", () => {
    const ids = ["p1", "p2", "p3", "p4"];
    expect(overlapWithRoster(ids, ids)).toBe(4);
  });

  it("returns 0 for an empty roster", () => {
    expect(overlapWithRoster(["p1", "p2"], [])).toBe(0);
  });

  it("returns 0 for empty playerIds", () => {
    expect(overlapWithRoster([], ["p1", "p2", "p3", "p4"])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// isDiversityViolation
// ─────────────────────────────────────────────────────────────
// Returns true iff ≥3 of the 4 proposed player IDs appeared
// together in any single recent match roster.

describe("isDiversityViolation", () => {
  const proposed = ["p1", "p2", "p3", "p4"];

  it("returns false when no roster overlaps", () => {
    const rosters = [["p5", "p6", "p7", "p8"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(false);
  });

  it("returns false for exactly 2-player overlap (below threshold)", () => {
    // Only p1, p2 from proposed are in this roster
    const rosters = [["p1", "p2", "p9", "p10"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(false);
  });

  it("returns true at exactly 3-player overlap (meets threshold)", () => {
    const rosters = [["p1", "p2", "p3", "p9"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(true);
  });

  it("returns true for full 4-player repeat (exact same match)", () => {
    const rosters = [["p1", "p2", "p3", "p4"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(true);
  });

  it("returns true when only one roster in the list violates", () => {
    const rosters = [
      ["p5", "p6", "p7", "p8"],  // no overlap
      ["p1", "p2", "p3", "p9"],  // 3 overlap → violation
    ];
    expect(isDiversityViolation(proposed, rosters)).toBe(true);
  });

  it("returns false when multiple rosters all have ≤2 overlap", () => {
    const rosters = [
      ["p1", "p2", "p9", "p10"],
      ["p3", "p4", "p11", "p12"],
    ];
    expect(isDiversityViolation(proposed, rosters)).toBe(false);
  });

  it("returns false for an empty rosters list", () => {
    expect(isDiversityViolation(proposed, [])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// scoreCandidates
// ─────────────────────────────────────────────────────────────
// Scoring formula:
//   Normal   (priority < 1000): score = -priority + overlap × 10_000
//   Red Zone (priority ≥ 1000): score = -priority + overlap × 100
// Sorted ascending → lowest score = highest priority.

describe("scoreCandidates", () => {
  it("returns an empty array for empty input", () => {
    expect(scoreCandidates([], new Map())).toEqual([]);
  });

  it("score for a single candidate with no overlap equals -priorityScore", () => {
    const p = makePlayer("a", { skillInt: 4, waitMinutes: 10, gamesPlayed: 0 });
    // Normal zone: priorityScore = 10
    const [result] = scoreCandidates([p], new Map());
    expect(result.score).toBe(-10);
    expect(result.candidate.player_id).toBe("a");
  });

  it("higher-priority candidate ranks first when both have no overlap", () => {
    const high = makePlayer("h", { skillInt: 4, waitMinutes: 20, gamesPlayed: 0 });
    const low  = makePlayer("l", { skillInt: 4, waitMinutes: 5,  gamesPlayed: 0 });
    const scored = scoreCandidates([low, high], new Map());
    // high: score = -20, low: score = -5 → high sorts first
    expect(scored[0].candidate.player_id).toBe("h");
  });

  it("normal overlap penalty is 10_000 × count", () => {
    const p = makePlayer("a", { skillInt: 4, waitMinutes: 10, gamesPlayed: 0 });
    // Normal zone: 1 overlap → -10 + 10_000 = 9_990
    const [result] = scoreCandidates([p], new Map([["a", 1]]));
    expect(result.score).toBe(-10 + 10_000);
  });

  it("Red Zone overlap penalty is capped at 100 × count (not 10_000)", () => {
    const p = makePlayer("a", {
      skillInt: 4,
      waitMinutes: CRITICAL_WAIT_MINUTES + 5, // 30 min → score 1030
      gamesPlayed: 0,
    });
    // Red Zone: priorityScore = 1030, 1 overlap → -1030 + 100 = -930
    const [result] = scoreCandidates([p], new Map([["a", 1]]));
    expect(result.score).toBe(-(1000 + 30) + 100);
  });

  it("Red Zone candidate with 1 overlap outranks normal candidate with 0 overlap", () => {
    const rz = makePlayer("rz", {
      skillInt: 4,
      waitMinutes: 30, // score = 1030, 1 overlap → -930
    });
    const normal = makePlayer("n", {
      skillInt: 4,
      waitMinutes: 2, // score = 2, 0 overlap → -2
    });
    const overlapMap = new Map([["rz", 1]]);
    const scored = scoreCandidates([rz, normal], overlapMap);
    // -930 < -2 → Red Zone ranks first
    expect(scored[0].candidate.player_id).toBe("rz");
  });

  it("normal candidate with heavy overlap (10_000) loses to Red Zone with 2 overlaps (200)", () => {
    const rz = makePlayer("rz", { skillInt: 4, waitMinutes: 30 }); // score 1030, 2 overlap → -1030+200=-830
    const normal = makePlayer("n", { skillInt: 4, waitMinutes: 20 }); // score 20, 1 overlap → -20+10000=9980
    const overlapMap = new Map([["rz", 2], ["n", 1]]);
    const scored = scoreCandidates([rz, normal], overlapMap);
    expect(scored[0].candidate.player_id).toBe("rz");
  });

  it("results are sorted ascending by score (best first) with concrete expected values", () => {
    const players = [
      makePlayer("low",  { skillInt: 4, waitMinutes: 2  }),  // priorityScore=2  → score=-2
      makePlayer("high", { skillInt: 4, waitMinutes: 20 }),  // priorityScore=20 → score=-20
      makePlayer("mid",  { skillInt: 4, waitMinutes: 10 }),  // priorityScore=10 → score=-10
    ];
    const scored = scoreCandidates(players, new Map());
    // Sorted ascending: -20 (high) → -10 (mid) → -2 (low)
    expect(scored.map((s) => s.score)).toEqual([-20, -10, -2]);
    expect(scored.map((s) => s.candidate.player_id)).toEqual(["high", "mid", "low"]);
  });
});

// ─────────────────────────────────────────────────────────────
// buildCombinationGroup
// ─────────────────────────────────────────────────────────────
// N-choose-3 combination search.
// Returns the first valid triple [anchor + triple = 4 valid players].
// "First valid" in priority order = optimal group.

describe("buildCombinationGroup", () => {
  it("returns [] when fewer than 3 candidates are available", () => {
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const only2 = scoreCandidates(
      [makePlayer("a", { skillInt: 4 }), makePlayer("b", { skillInt: 4 })],
      new Map()
    );
    expect(buildCombinationGroup(anchor, only2, SKILL_VARIANCE_MAX)).toEqual([]);
  });

  it("returns all 3 candidates when exactly 3 are available and all valid", () => {
    const anchor = makePlayer("anchor", { skillInt: 4, waitMinutes: 10 });
    const candidates = [
      makePlayer("a", { skillInt: 4, waitMinutes: 9 }),
      makePlayer("b", { skillInt: 4, waitMinutes: 8 }),
      makePlayer("c", { skillInt: 4, waitMinutes: 7 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
  });

  it("returns [] when exactly 3 candidates exist but skill spread violates maxVariance", () => {
    // Anchor skill=4, candidate skill=7 → |4-7|=3 > maxVariance(2)
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const candidates = [
      makePlayer("a", { skillInt: 7 }),
      makePlayer("b", { skillInt: 7 }),
      makePlayer("c", { skillInt: 7 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX)).toEqual([]);
  });

  it("skips candidates that violate cross-group variance even if valid against anchor", () => {
    // Anchor skill=5. All candidates within ±2 of anchor.
    // But a(skill=7) vs b(skill=3) → |7-3|=4 > maxVariance.
    // Only triple [b,c,d] is internally valid.
    const anchor = makePlayer("anchor", { skillInt: 5 });
    const a = makePlayer("a", { skillInt: 7 }); // valid vs anchor (|7-5|=2), invalid vs b
    const b = makePlayer("b", { skillInt: 3 }); // valid vs anchor (|5-3|=2)
    const c = makePlayer("c", { skillInt: 4 }); // valid vs all
    const d = makePlayer("d", { skillInt: 5 }); // valid vs all
    const scored = scoreCandidates([a, b, c, d], new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
    const ids = group.map((p) => p.player_id);
    expect(ids).not.toContain("a"); // a breaks group validity
  });

  it("greedy trap: finds valid triple even when top-priority candidate blocks the group", () => {
    // Regression for Audit Rec #1.
    // Anchor skill=5. Candidate A (highest priority) has skill=7 —
    // valid vs anchor (±2) but would break any triple with skill<5.
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10, gamesPlayed: 1 });
    const a = makePlayer("A", { skillInt: 7, waitMinutes: 15, gamesPlayed: 0 }); // highest priority
    const b = makePlayer("B", { skillInt: 3, waitMinutes: 8,  gamesPlayed: 0 });
    const c = makePlayer("C", { skillInt: 4, waitMinutes: 7,  gamesPlayed: 0 });
    const d = makePlayer("D", { skillInt: 5, waitMinutes: 6,  gamesPlayed: 0 });

    const scored = scoreCandidates([a, b, c, d], new Map());
    // Verify A is ranked first (greedy would lock it in and fail)
    expect(scored[0].candidate.player_id).toBe("A");

    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
    expect(group.map((p) => p.player_id)).not.toContain("A");
    // The result [anchor + group] must be fully valid
    expect(isGroupValid([anchor, ...group], SKILL_VARIANCE_MAX)).toBe(true);
  });

  it("respects tight maxVariance=1 (SKILL_VARIANCE_TARGET)", () => {
    // All three valid candidates must be mutually within ±1 of each other.
    // {4,5,3} fails because |5-3|=2 > 1. Use {4,4,5} instead — every pair ≤1.
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const within1 = [
      makePlayer("a", { skillInt: 4 }),  // |4-4|=0 vs anchor and b
      makePlayer("b", { skillInt: 4 }),  // |4-4|=0 vs anchor and a
      makePlayer("c", { skillInt: 5 }),  // |5-4|=1 vs anchor, a, b — all ≤ 1
    ];
    const out = makePlayer("d", { skillInt: 6 }); // |6-4|=2 > 1 → excluded
    const scored = scoreCandidates([...within1, out], new Map());
    const group = buildCombinationGroup(anchor, scored, 1);
    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], 1)).toBe(true);
    // d (skill=6) must not appear in the result
    expect(group.map((p) => p.player_id)).not.toContain("d");
  });

  it("succeeds at maxVariance=3 for Red Zone expanded window", () => {
    // Skills spread: anchor=3, candidates at 6. |3-6|=3 — invalid at ±2, valid at ±3.
    const anchor = makePlayer("anchor", { skillInt: 3 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }),
      makePlayer("b", { skillInt: 6 }),
      makePlayer("c", { skillInt: 6 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, 2)).toEqual([]); // ±2: fails
    expect(buildCombinationGroup(anchor, scored, 3)).toHaveLength(3); // ±3: succeeds
  });

  it("returns [] when ALL possible combinations fail validation", () => {
    // Anchor skill=4. All candidates either ±0 from anchor but
    // mutually incompatible → this should never happen in practice
    // since isGroupValid only checks anchor–candidates, but let's
    // use a range that genuinely produces no valid triple.
    const anchor = makePlayer("anchor", { skillInt: 4 });
    // Use maxVariance=0: only same-skill players are eligible.
    // Candidates at skill 5 all fail against anchor at variance 0.
    const candidates = [
      makePlayer("a", { skillInt: 5 }),
      makePlayer("b", { skillInt: 5 }),
      makePlayer("c", { skillInt: 5 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, 0)).toEqual([]);
  });

  it("handles large candidate pool (C(10,3)=120 iterations) without error", () => {
    const anchor = makePlayer("anchor", { skillInt: 4 });
    // 10 candidates, all at skill 4 — first triple found immediately
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makePlayer(`p${i}`, { skillInt: 4, waitMinutes: 10 - i })
    );
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], SKILL_VARIANCE_MAX)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// isMixed boundary (via SKILL_VARIANCE_MAX constant)
// ─────────────────────────────────────────────────────────────
// In runAlgorithm: isMixed = maxVariance > SKILL_VARIANCE_MAX (2).
// A group formed at ±2 is a NORMAL match. A group formed at ±3 or
// ±4 (Red Zone expansion) is flagged isMixed=true.
// These tests verify the skill window boundary using buildCombinationGroup:
//   - ±2 accepts skill spread of 2 → NOT isMixed
//   - ±3 accepts spread of 3 but REJECTS spread of 2+ε at ±2 → IS isMixed
//   - ±4 accepts spread of 4 but REJECTS spread of 3+ε at ±3 → IS isMixed

describe("isMixed level boundary (maxVariance > SKILL_VARIANCE_MAX)", () => {
  it("maxVariance=SKILL_VARIANCE_MAX(2) forms a valid group — this is the normal-match boundary", () => {
    // A player at skill=6 is exactly |6-4|=2 from anchor(4) = SKILL_VARIANCE_MAX.
    // At maxVariance=2, this is accepted. isMixed = 2 > SKILL_VARIANCE_MAX(2) = false.
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }),  // |6-4|=2 — right at the boundary
      makePlayer("b", { skillInt: 4 }),
      makePlayer("c", { skillInt: 4 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    // Group forms at ±SKILL_VARIANCE_MAX → a normal (non-mixed) match
    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], SKILL_VARIANCE_MAX)).toBe(true);
    // The boundary value itself: 2 is NOT greater than SKILL_VARIANCE_MAX(2)
    expect(2 > SKILL_VARIANCE_MAX).toBe(false);
  });

  it("maxVariance=3 (Red Zone ±3 window) accepts spread rejected at ±2 — IS isMixed", () => {
    // skill spread of 3: anchor=3, candidates at 6. |6-3|=3 > SKILL_VARIANCE_MAX(2).
    // Fails at ±2, succeeds at ±3. Any group formed here → isMixed = 3 > 2 = true.
    const anchor = makePlayer("anchor", { skillInt: 3 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }),  // |6-3|=3: rejected at ±2
      makePlayer("b", { skillInt: 6 }),
      makePlayer("c", { skillInt: 6 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX)).toEqual([]);  // ±2 fails
    expect(buildCombinationGroup(anchor, scored, 3)).toHaveLength(3);               // ±3 succeeds
    expect(3 > SKILL_VARIANCE_MAX).toBe(true); // isMixed flag would be set
  });

  it("maxVariance=4 (widest Red Zone window) accepts spread of 4 — IS isMixed", () => {
    // skill spread of 4: anchor=2, candidates at 6. |6-2|=4.
    // Fails at ±2 and ±3, succeeds only at ±4. isMixed = 4 > 2 = true.
    const anchor = makePlayer("anchor", { skillInt: 2 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }),  // |6-2|=4: only valid at maxVariance=4
      makePlayer("b", { skillInt: 6 }),
      makePlayer("c", { skillInt: 6 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX)).toEqual([]);  // ±2 fails
    expect(buildCombinationGroup(anchor, scored, 3)).toEqual([]);                   // ±3 fails
    expect(buildCombinationGroup(anchor, scored, 4)).toHaveLength(3);               // ±4 succeeds
    expect(4 > SKILL_VARIANCE_MAX).toBe(true); // isMixed flag would be set
  });
});
