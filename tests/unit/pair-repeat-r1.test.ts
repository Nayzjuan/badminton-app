// ============================================================
// Pair-repeat R1 — no immediate rematch
// ============================================================

import { describe, expect, it } from "vitest";
import {
  hasImmediateRematch,
  isImmediateRematchPair,
  lastRosterOf,
  runAlgorithm,
  type LastOpponents,
  type LastPartners,
  type PairRuleFlags,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import {
  CRITICAL_WAIT_MINUTES,
  FALLBACK_WAIT_MINUTES,
  HARD_WAIT_CAP_MINUTES,
} from "@/lib/constants";
import type { SkillLevel } from "@/types/database";

const SKILL: SkillLevel[] = [
  "beginner",
  "lower_intermediate",
  "intermediate",
  "upper_intermediate",
  "lower_advanced",
  "advanced",
];

const R1: PairRuleFlags = { noImmediateRematch: true, sharedGamesPreference: false };

function player(
  id: string,
  opts: { skill?: number; games?: number; wait?: number; priority?: number } = {}
): ScoredPlayer {
  const skill = opts.skill ?? 3;
  const wait = opts.wait ?? 5;
  return {
    id: `qe-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: "2026-10-31T04:00:00Z",
    games_played: opts.games ?? 1,
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

describe("isImmediateRematchPair", () => {
  const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });

  it("is true in either direction, including a role flip", () => {
    expect(isImmediateRematchPair("a", "b", sides.lastOpponents, sides.lastPartners)).toBe(true);
    expect(isImmediateRematchPair("a", "c", sides.lastOpponents, sides.lastPartners)).toBe(true);
    expect(isImmediateRematchPair("e", "a", sides.lastOpponents, sides.lastPartners)).toBe(false);
  });

  it("sees an asymmetric last roster (A waited; B played again)", () => {
    const lastOpponents = new Map<string, Set<string>>([
      ["a", new Set(["c", "d"])],
      ["b", new Set(["x", "y"])],
    ]);
    const lastPartners = new Map<string, Set<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["z"])],
    ]);
    expect(isImmediateRematchPair("a", "b", lastOpponents, lastPartners)).toBe(true);
    expect(isImmediateRematchPair("b", "a", lastOpponents, lastPartners)).toBe(true);
    expect(isImmediateRematchPair("b", "c", lastOpponents, lastPartners)).toBe(false);
  });

  it("fails open on a missing or empty last roster", () => {
    expect(isImmediateRematchPair("a", "b")).toBe(false);
    const empty: LastOpponents = new Map([["a", new Set()]]);
    const emptyP: LastPartners = new Map([["a", new Set()]]);
    expect(isImmediateRematchPair("a", "b", empty, emptyP)).toBe(false);
    expect(lastRosterOf("a", empty, emptyP)).toBeNull();
  });
});

describe("runAlgorithm R1", () => {
  it("does not seat an immediate-rematch pair when a clean four exists", () => {
    const pool = [
      player("a", { wait: 16, priority: 16 }),
      player("b", { wait: 14, priority: 14 }),
      player("e", { wait: 12, priority: 12 }),
      player("f", { wait: 10, priority: 10 }),
      player("g", { wait: 8, priority: 8 }),
    ];
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const result = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners,
      R1
    );
    expect(result.proposal).not.toBeNull();
    const ids = idsOf(result.proposal!);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
    expect(hasImmediateRematch(ids, sides.lastOpponents, sides.lastPartners)).toBe(false);
  });

  it("returns immediate_rematch when a Red Zone anchor's only candidates are last-game co-players", () => {
    const pool = [
      player("a", { wait: CRITICAL_WAIT_MINUTES + 1, priority: 1001 }),
      player("b", { wait: 14, priority: 14 }),
      player("c", { wait: 12, priority: 12 }),
      player("d", { wait: 10, priority: 10 }),
    ];
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const result = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners,
      R1
    );
    expect(result.proposal).toBeNull();
    expect(result.rematchBlocked).toBe(true);
    expect(result.capSaturationReason).toBe("immediate_rematch");
  });

  it("same for a hard-cap-tier anchor", () => {
    const pool = [
      player("a", { wait: HARD_WAIT_CAP_MINUTES + 1, games: 1, priority: 2010 }),
      player("b", { wait: 14, priority: 14 }),
      player("c", { wait: 12, priority: 12 }),
      player("d", { wait: 10, priority: 10 }),
    ];
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const result = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners,
      R1
    );
    expect(result.proposal).toBeNull();
    expect(result.capSaturationReason).toBe("immediate_rematch");
  });

  it("does not blame R1 for pure skill exhaustion", () => {
    const pool = [
      player("a", { skill: 1, wait: 10, priority: 10 }),
      player("e", { skill: 6, wait: 8, priority: 8 }),
      player("f", { skill: 6, wait: 6, priority: 6 }),
      player("g", { skill: 6, wait: 4, priority: 4 }),
    ];
    const sides = lastGame({ a: ["x", "y"], b: ["z", "w"] });
    const result = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners,
      R1
    );
    expect(result.proposal).toBeNull();
    expect(result.rematchBlocked).toBeUndefined();
    expect(result.capSaturationReason).not.toBe("immediate_rematch");
  });

  it("reports immediate_rematch even when the partnership cap was also active", () => {
    const pool = [
      player("a", { wait: 16, priority: 16 }),
      player("b", { wait: 14, priority: 14 }),
      player("c", { wait: 12, priority: 12 }),
      player("d", { wait: 10, priority: 10 }),
      player("k", { wait: 8, priority: 8 }),
    ];
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const partnershipCounts = new Map<string, number>([["a:k", 2]]);
    const result = runAlgorithm(
      pool,
      partnershipCounts,
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners,
      R1
    );
    expect(result.proposal).toBeNull();
    expect(result.rematchBlocked).toBe(true);
    expect(result.capSaturationReason).toBe("immediate_rematch");
  });

  it("last-resort enumerates a clean 2-3-4 when 1 and 3 clash", () => {
    const pool = [
      player("a", { wait: FALLBACK_WAIT_MINUTES + 2, games: 0, priority: 17 }),
      player("b", { skill: 6, wait: 4, games: 0, priority: 4 }),
      player("e", { skill: 1, wait: 3, games: 0, priority: 3 }),
      player("c", { skill: 6, wait: 2, games: 0, priority: 2 }),
      player("f", { skill: 1, wait: 1, games: 0, priority: 1 }),
    ];
    const sides = lastGame({ a: ["x", "y"], b: ["b", "c"] });
    const result = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners,
      R1
    );
    expect(result.proposal).not.toBeNull();
    const ids = idsOf(result.proposal!);
    expect(ids).toEqual(["a", "e", "f"].concat(ids.includes("b") ? ["b"] : ["c"]).sort());
    expect(hasImmediateRematch(ids, sides.lastOpponents, sides.lastPartners)).toBe(false);
    expect(ids.includes("b") && ids.includes("c")).toBe(false);
  });

  it("flags off still serves a rematch four", () => {
    const pool = [
      player("a", { wait: 16, priority: 16 }),
      player("b", { wait: 14, priority: 14 }),
      player("c", { wait: 12, priority: 12 }),
      player("d", { wait: 10, priority: 10 }),
    ];
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const off = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(off.proposal).not.toBeNull();
    expect(hasImmediateRematch(idsOf(off.proposal!), sides.lastOpponents, sides.lastPartners)).toBe(
      true
    );
  });
});
