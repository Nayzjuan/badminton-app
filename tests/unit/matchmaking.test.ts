// ============================================================
// Unit Tests: Matchmaking Core (TDD Harness)
// ============================================================
//
// These tests are intentionally written BEFORE the algorithm
// fixes are applied (Phase 1 — Red/Green/Refactor).
//
// Test 1 — [EXPECTED: FAIL] Audit Rec #2 target
//   Red Zone candidate with overlap should outrank a fresh
//   low-priority candidate. The current scoreCandidates formula
//   uses overlap * 10_000 which overrides Red Zone urgency.
//
// Test 2 — [EXPECTED: FAIL] Audit Rec #1 target
//   Greedy group assembly traps itself by locking in an out-of-
//   range candidate (Skill 7) first, then failing to reach 3
//   members even though [B(3), C(4), D(5)] is a valid group.
//
// Test 3 — [EXPECTED: PASS] Happy-path sanity check
//   4 perfectly matched players, no overlaps. Verifies the test
//   harness itself is wired correctly.
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
// Test 1 — Rec #2: Red Zone urgency must not be drowned by overlap
// ─────────────────────────────────────────────────────────────
// Scenario:
//   Candidate A: has waited 30 minutes (Red Zone, score ≥ 1030),
//                but has played with the anchor once (overlap = 1).
//   Candidate B: has waited 2 minutes, 0 games (score ≈ 2),
//                zero overlap with the anchor.
//
// Expected (after fix): A ranked before B — Red Zone urgency
//   should override a single overlap event.
// Currently FAILS because: A's score = -1030 + 1×10_000 = 8,970
//   which sorts AFTER B's score of -2 (ascending = B first = bug).

describe("Rec #2 — Red Zone urgency vs overlap penalty", () => {
  it("ranks the Red Zone candidate above a fresh candidate with no overlap", () => {
    const anchorId = "anchor";

    // Candidate A: Red Zone (30 min wait), 1 prior overlap with anchor
    const candidateA = makePlayer("A", { skillInt: 4, waitMinutes: 30 });

    // Candidate B: Fresh (2 min wait, 0 games), zero overlap
    const candidateB = makePlayer("B", { skillInt: 4, waitMinutes: 2 });

    // Overlap map: A has been paired with the anchor once
    const overlapMap = new Map<string, number>([["A", 1]]);

    const scored = scoreCandidates([candidateA, candidateB], overlapMap);

    // After the fix, A (Red Zone) must be ranked first despite overlap.
    expect(scored[0].candidate.player_id).toBe("A");
  });
});

// ─────────────────────────────────────────────────────────────
// Test 2 — Rec #1: Greedy trapping with skill extremes
// ─────────────────────────────────────────────────────────────
// Scenario (all variance windows = ±2):
//   Anchor:      Skill 5
//   Candidate A: Skill 7 — eligible vs. Anchor (|7-5|=2 ≤ 2),
//                but incompatible with B (|7-3|=4 > 2).
//                Has highest priorityScore → greedy picks it first.
//   Candidate B: Skill 3 — valid vs Anchor (|5-3|=2) but blocked
//                by A already in group.
//   Candidate C: Skill 4 — valid vs Anchor, blocked by A.
//   Candidate D: Skill 5 — only one compatible with A after anchor.
//
// Currently FAILS because greedy locks in A, then can only add D,
//   reaching group size 2 (not 3).
// After fix (combination search), [B, C, D] is found as valid.

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

    // After fix: group should contain exactly B, C, D (3 players)
    // Currently FAILS: group only has [A, D] (size 2).
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
