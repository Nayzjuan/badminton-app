// ============================================================
// Pair-repeat R2 — shared-games preference
// ============================================================

import { describe, expect, it, vi } from "vitest";
import {
  composeEngineProposal,
  countOverCapPairs,
  findLessRepeatedFour,
  hasImmediateRematch,
  PAIR_RULE_FLAGS_OFF,
  pullImprovesFreshness,
  wantsFresherFour,
  type LastOpponents,
  type LastPartners,
  type PairRuleFlags,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import { MAX_SHARED_GAMES } from "@/lib/constants";
import type { SkillLevel } from "@/types/database";

const SKILL: SkillLevel[] = [
  "beginner",
  "lower_intermediate",
  "intermediate",
  "upper_intermediate",
  "lower_advanced",
  "advanced",
];

const R2: PairRuleFlags = { noImmediateRematch: false, sharedGamesPreference: true };
const BOTH: PairRuleFlags = { noImmediateRematch: true, sharedGamesPreference: true };

function player(
  id: string,
  opts: { skill?: number; games?: number; wait?: number; priority?: number } = {}
): ScoredPlayer {
  const skill = opts.skill ?? 3;
  const wait = opts.wait ?? 8;
  return {
    id: `qe-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: "2026-10-31T04:00:00Z",
    games_played: opts.games ?? 2,
    status: "waiting",
    position: null,
    is_paused: false,
    paused_at: null,
    created_at: "2026-10-31T04:00:00Z",
    display_name: id,
    skill_level: SKILL[skill - 1] ?? "intermediate",
    skill_level_int: skill,
    wait_minutes: wait,
    is_bottleneck: false,
    priorityScore: opts.priority ?? wait,
  };
}

function lastGame(split: { a: [string, string]; b: [string, string] }): {
  lastOpponents: LastOpponents;
  lastPartners: LastPartners;
} {
  const lastOpponents = new Map<string, Set<string>>();
  const lastPartners = new Map<string, Set<string>>();
  for (const [own, other] of [
    [split.a, split.b],
    [split.b, split.a],
  ] as const) {
    for (const id of own) {
      lastOpponents.set(id, new Set(other));
      lastPartners.set(id, new Set(own.filter((p) => p !== id)));
    }
  }
  return { lastOpponents, lastPartners };
}

function idsOf(proposal: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }): string[] {
  return [...proposal.teamA, ...proposal.teamB].map((p) => p.player_id).sort();
}

describe("countOverCapPairs", () => {
  it("counts partner + opponent meetings against MAX_SHARED_GAMES", () => {
    const partnership = new Map<string, number>([["a:b", 1]]);
    const opponent = new Map<string, number>([["a:b", 1]]);
    expect(MAX_SHARED_GAMES).toBe(2);
    expect(countOverCapPairs(["a", "b", "c", "d"], partnership, opponent)).toBe(1);
    expect(countOverCapPairs(["a", "c", "d", "e"], partnership, opponent)).toBe(0);
  });
});

describe("cross-court over-cap args", () => {
  it("wantsFresherFour arms on over-cap; pullImprovesFreshness accepts a drop", () => {
    expect(wantsFresherFour(undefined, 0, 0)).toBe(false);
    expect(wantsFresherFour(undefined, 0, 1)).toBe(true);
    expect(pullImprovesFreshness(undefined, 0, 0, 2, 1)).toBe(true);
    expect(pullImprovesFreshness(undefined, 0, 0, 1, 1)).toBe(false);
    expect(pullImprovesFreshness(undefined, 0, 0, 1, 2)).toBe(false);
  });
});

describe("findLessRepeatedFour / composeEngineProposal", () => {
  const pool = [
    player("a", { wait: 16, priority: 16, games: 2 }),
    player("b", { wait: 14, priority: 14, games: 2 }),
    player("c", { wait: 12, priority: 12, games: 2 }),
    player("d", { wait: 10, priority: 10, games: 2 }),
    player("e", { wait: 9, priority: 9, games: 2 }),
    player("f", { wait: 8, priority: 8, games: 2 }),
  ];
  const partnershipCounts = new Map<string, number>([["a:b", 1]]);
  const opponentCounts = new Map<string, number>([["a:b", 1]]);
  const inputs = {
    partnershipCounts,
    overlapMap: new Map<string, number>(),
    recentRosters: [] as string[][],
    opponentCounts,
    rejectedRosters: [] as string[][],
    lastOpponents: new Map() as LastOpponents,
    lastPartners: new Map() as LastPartners,
  };

  it("replaces an over-cap four when a cleaner alternative exists", () => {
    const served = {
      teamA: [pool[0], pool[1]],
      teamB: [pool[2], pool[3]],
      isMixedLevel: false,
    };
    const alt = findLessRepeatedFour(pool, served, { ...inputs, flags: R2 });
    expect(alt).not.toBeNull();
    expect(idsOf(alt!)).not.toEqual(["a", "b", "c", "d"]);
    expect(countOverCapPairs(idsOf(alt!), partnershipCounts, opponentCounts)).toBe(0);
  });

  it("composeEngineProposal serves the replacement and flags lessRepeatedRefresh", () => {
    const result = composeEngineProposal(pool, inputs, R2, { freshness: false });
    expect(result.proposal).not.toBeNull();
    expect(result.lessRepeatedRefresh).toBe(true);
    expect(result.sharedOverCapPairs).toBe(0);
    expect(idsOf(result.proposal!)).not.toContain("b");
  });

  it("keeps the original when no alternative exists, and logs", () => {
    const tiny = [pool[0], pool[1], pool[2], pool[3]];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = composeEngineProposal(tiny, inputs, R2, { freshness: false });
    expect(result.proposal).not.toBeNull();
    expect(result.lessRepeatedRefresh).toBeUndefined();
    expect(result.sharedOverCapPairs).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no alternative/));
    warn.mockRestore();
  });

  it("does not replace when R2 is off", () => {
    const result = composeEngineProposal(pool, inputs, PAIR_RULE_FLAGS_OFF, { freshness: false });
    expect(result.sharedOverCapPairs).toBe(0);
    expect(result.lessRepeatedRefresh).toBeUndefined();
  });

  it("does not accept an alternative that is an immediate rematch when R1 is on", () => {
    const sides = lastGame({ a: ["a", "e"], b: ["c", "f"] });
    const withSides = {
      ...inputs,
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    };
    const served = {
      teamA: [pool[0], pool[1]],
      teamB: [pool[2], pool[3]],
      isMixedLevel: false,
    };
    const alt = findLessRepeatedFour(pool, served, { ...withSides, flags: BOTH });
    if (alt) {
      expect(hasImmediateRematch(idsOf(alt), sides.lastOpponents, sides.lastPartners)).toBe(false);
    }
  });
});
