// ============================================================
// Unit Tests: Matchmaking Core — Regression Suite
// ============================================================
//
// These tests were written as a TDD harness for the algorithm
// fixes in commit 3d70a2e. All three tests now pass.
//
// Test 1 — Regression for Audit Rec #2 (scoreCandidates fix)
//   Red Zone candidate with overlap should outrank a fresh
//   low-priority candidate. Fixed by capping Red Zone overlap
//   penalty at 100× instead of 10_000×.
//
// Test 2 — Regression for Audit Rec #1 (combination search fix)
//   Greedy group assembly trapped itself by locking in an out-of-
//   range candidate first. Fixed by replacing greedy with a full
//   N-choose-3 combination search.
//
// Test 3 — Happy-path sanity check
//   4 perfectly matched players, no overlaps.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  computePriorityScore,
  scoreCandidates,
  buildCombinationGroup,
  isGroupValid,
} from "@/lib/matchmaking-core";
import type { ScoredPlayer } from "@/lib/matchmaking-core";
import type { QueueWithWaitTime } from "@/types/database";

// ── Mock factory ──────────────────────────────────────────────
// Builds a minimal ScoredPlayer for use in tests.
// All fields not relevant to a specific test are given safe defaults.

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
    // QueueEntry fields
    id: `entry-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: new Date(Date.now() - waitMinutes * 60_000).toISOString(),
    games_played: gamesPlayed,
    status: "waiting",
    position: null,
    is_paused: false,
    created_at: new Date().toISOString(),
    // QueueWithWaitTime enrichments
    display_name: `Player-${id}`,
    skill_level: "intermediate", // not relevant to these tests
    skill_level_int: opts.skillInt,
    wait_minutes: waitMinutes,
    is_bottleneck: false,
  };

  return {
    ...base,
    priorityScore: computePriorityScore(base),
  };
}

// ─────────────────────────────────────────────────────────────
// Test 1 — Regression for Rec #2: Red Zone urgency vs overlap
// ─────────────────────────────────────────────────────────────
// Scenario:
//   Candidate A: has waited 30 minutes (Red Zone, score ≥ 1030),
//                but has played with the anchor once (overlap = 1).
//   Candidate B: has waited 2 minutes, 0 games (score ≈ 2),
//                zero overlap with the anchor.
//
// Fix: Red Zone overlap penalty capped at 100× (not 10_000×), so
//   A's score = -1030 + 1×100 = -930 — sorts before B's -2. ✓

describe("Rec #2 — Red Zone urgency vs overlap penalty", () => {
  it("ranks the Red Zone candidate above a fresh candidate with no overlap", () => {
    // Candidate A: Red Zone (30 min wait), 1 prior overlap with anchor
    const candidateA = makePlayer("A", { skillInt: 4, waitMinutes: 30 });

    // Candidate B: Fresh (2 min wait, 0 games), zero overlap
    const candidateB = makePlayer("B", { skillInt: 4, waitMinutes: 2 });

    // Overlap map: A has been paired with the anchor once
    const overlapMap = new Map<string, number>([["A", 1]]);

    const scored = scoreCandidates([candidateA, candidateB], overlapMap);

    // A (Red Zone, 1 overlap) must rank before B (fresh, 0 overlap).
    expect(scored[0].candidate.player_id).toBe("A");
  });
});

// ─────────────────────────────────────────────────────────────
// Test 2 — Regression for Rec #1: Combination search replaces greedy
// ─────────────────────────────────────────────────────────────
// Scenario (all variance windows = ±2):
//   Anchor:      Skill 5
//   Candidate A: Skill 7 — eligible vs. Anchor (|7-5|=2 ≤ 2),
//                but incompatible with B/C/D (|7-3|=4, |7-4|=3, |7-5|=2).
//                Has highest priorityScore.
//   Candidate B: Skill 3 — valid vs Anchor, valid vs C/D but not A.
//   Candidate C: Skill 4 — valid vs Anchor and B/D.
//   Candidate D: Skill 5 — valid vs all.
//
// Fix: N-choose-3 combination search finds [B, C, D] as the first
//   valid triple instead of greedily locking A and failing.

describe("Rec #1 — Greedy trapping with extreme-skill candidate", () => {
  it("forms a valid group of 3 even when the highest-priority candidate would block others", () => {
    const anchor = makePlayer("anchor", {
      skillInt: 5,
      waitMinutes: 10,
      gamesPlayed: 1,
    });

    // A has the highest priority: most wait time, fewest games
    const candidateA = makePlayer("A", {
      skillInt: 7,
      waitMinutes: 15,
      gamesPlayed: 0,
    }); // priorityScore ≈ 15

    // B, C, D are lower priority but all compatible with each other AND anchor
    const candidateB = makePlayer("B", {
      skillInt: 3,
      waitMinutes: 8,
      gamesPlayed: 0,
    }); // priorityScore ≈ 8
    const candidateC = makePlayer("C", {
      skillInt: 4,
      waitMinutes: 7,
      gamesPlayed: 0,
    }); // priorityScore ≈ 7
    const candidateD = makePlayer("D", {
      skillInt: 5,
      waitMinutes: 6,
      gamesPlayed: 0,
    }); // priorityScore ≈ 6

    const maxVariance = 2;
    const noOverlap = new Map<string, number>();

    // Pre-score the candidates as runAlgorithm would
    const scored = scoreCandidates(
      [candidateA, candidateB, candidateC, candidateD],
      noOverlap
    );

    // Verify A is ranked first (confirming the scoring will pick it first)
    expect(scored[0].candidate.player_id).toBe("A");

    // Run combination group builder
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    // Combination search finds B, C, D — the first valid triple.
    expect(group).toHaveLength(3);

    // All members plus anchor must form a valid group
    const fullGroup = [anchor, ...group];
    expect(isGroupValid(fullGroup, maxVariance)).toBe(true);

    // A must NOT be in the group (it would break isGroupValid)
    const groupIds = group.map((p) => p.player_id);
    expect(groupIds).not.toContain("A");
  });
});

// ─────────────────────────────────────────────────────────────
// Test 3 — Happy path sanity check (EXPECTED: PASS)
// ─────────────────────────────────────────────────────────────
// 4 players, all skill 4, moderate wait, no overlaps.
// Verifies the test harness is wired up correctly.

describe("Sanity check — happy-path match formation", () => {
  it("groups 4 perfectly matched players into a valid match", () => {
    const anchor = makePlayer("P1", { skillInt: 4, waitMinutes: 10 });
    const p2 = makePlayer("P2", { skillInt: 4, waitMinutes: 9 });
    const p3 = makePlayer("P3", { skillInt: 4, waitMinutes: 8 });
    const p4 = makePlayer("P4", { skillInt: 4, waitMinutes: 7 });

    const noOverlap = new Map<string, number>();
    const maxVariance = 2;

    const scored = scoreCandidates([p2, p3, p4], noOverlap);
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], maxVariance)).toBe(true);
  });
});
