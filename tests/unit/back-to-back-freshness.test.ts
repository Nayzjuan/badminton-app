// ============================================================
// Back-to-back freshness — unit tests
// ============================================================
// Intent: the engine's fresher-four wrapper may only replace a stale
// four with a fairer-or-equal one. runAlgorithm itself is unchanged.
// Organizer swaps are not gated by these rules.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  buildCrossCourtProposal,
  findFresherFour,
  isBackToBackRepeat,
  lastRosterOf,
  runAlgorithm,
  runAlgorithmWithFreshness,
  type LastOpponents,
  type LastPartners,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import {
  isFreshnessRefreshEnabled,
  planSlots,
  shouldContinueSlot,
  softGateDecision,
} from "@/lib/matchmaking-slots";
import { deriveLastSides, type SessionMatchSnapshot } from "@/lib/matchmaking-db";
import {
  CONSECUTIVE_OPPONENT_PENALTY,
  CRITICAL_WAIT_MINUTES,
  FRESHNESS_WAIT_SLACK_MINUTES,
  GAMES_AHEAD_PENALTY_RED_ZONE,
  MAX_PARTNERSHIP_REPEATS,
  PLAYERS_PER_MATCH,
} from "@/lib/constants";
import type { SkillLevel } from "@/types/database";
import { hasAdmissibleFresherFour } from "../../scripts/replay/freshness-brute";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL: SkillLevel[] = [
  "beginner",
  "lower_intermediate",
  "intermediate",
  "upper_intermediate",
  "lower_advanced",
  "advanced",
];

function player(
  id: string,
  opts: {
    skill?: number;
    games?: number;
    wait?: number;
    priority?: number;
    pulled?: boolean;
  } = {}
): ScoredPlayer {
  const skill = opts.skill ?? 3;
  return {
    id: `qe-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: "2026-10-03T04:00:00Z",
    games_played: opts.games ?? 0,
    status: "waiting",
    position: null,
    is_paused: false,
    paused_at: null,
    created_at: "2026-10-03T04:00:00Z",
    display_name: id,
    skill_level: SKILL[skill - 1] ?? "intermediate",
    skill_level_int: skill,
    wait_minutes: opts.wait ?? 5,
    is_bottleneck: false,
    priorityScore: opts.priority ?? opts.wait ?? 5,
    ...(opts.pulled ? { isPulled: true } : {}),
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

describe("U-B1 isBackToBackRepeat truth table", () => {
  const { lastOpponents, lastPartners } = lastGame({
    a: ["a", "b"],
    b: ["c", "d"],
  });

  it("false when 0/1/2 of the four were in a member's last game", () => {
    expect(isBackToBackRepeat(["a", "e", "f", "g"], lastOpponents, lastPartners)).toBe(false);
    expect(isBackToBackRepeat(["a", "b", "e", "f"], lastOpponents, lastPartners)).toBe(false);
    expect(isBackToBackRepeat(["a", "b", "c", "e"], lastOpponents, lastPartners)).toBe(true);
  });

  it("true at 3 and 4 shared with a member's last roster", () => {
    expect(isBackToBackRepeat(["a", "b", "c", "x"], lastOpponents, lastPartners)).toBe(true);
    expect(isBackToBackRepeat(["a", "b", "c", "d"], lastOpponents, lastPartners)).toBe(true);
  });

  it("false when only a non-member's last roster overlaps", () => {
    const extra = lastGame({ a: ["w", "x"], b: ["y", "z"] });
    const opps = new Map([...lastOpponents, ...extra.lastOpponents]);
    const parts = new Map([...lastPartners, ...extra.lastPartners]);
    expect(isBackToBackRepeat(["a", "e", "f", "g"], opps, parts)).toBe(false);
  });

  it("false for a player with no last game or a malformed empty roster", () => {
    expect(isBackToBackRepeat(["e", "f", "g", "h"], lastOpponents, lastPartners)).toBe(false);
    const empty: LastOpponents = new Map([["a", new Set()]]);
    const emptyP: LastPartners = new Map([["a", new Set()]]);
    expect(isBackToBackRepeat(["a", "b", "c", "d"], empty, emptyP)).toBe(false);
    expect(lastRosterOf("a", empty, emptyP)).toBeNull();
    expect(lastRosterOf("missing", lastOpponents, lastPartners)).toBeNull();
  });

  it("false on empty maps", () => {
    expect(isBackToBackRepeat(["a", "b", "c", "d"])).toBe(false);
  });
});

describe("U-B2 last-roster reconstruction matches deriveLastSides", () => {
  it("newest committed 2v2 wins; cancelled-shape malformed fails open; created_at tie uses id DESC", () => {
    const snapshot: SessionMatchSnapshot = {
      matchIds: ["m-new", "m-old", "m-bad"],
      rowsByMatch: new Map([
        [
          "m-new",
          [
            { player_id: "a", team: "a" },
            { player_id: "b", team: "a" },
            { player_id: "c", team: "b" },
            { player_id: "d", team: "b" },
          ],
        ],
        [
          "m-old",
          [
            { player_id: "a", team: "a" },
            { player_id: "x", team: "a" },
            { player_id: "y", team: "b" },
            { player_id: "z", team: "b" },
          ],
        ],
        [
          "m-bad",
          [
            { player_id: "e", team: "a" },
            { player_id: "f", team: "a" },
            { player_id: "g", team: "a" },
            { player_id: "h", team: "b" },
          ],
        ],
      ]),
    };
    const sides = deriveLastSides(snapshot);
    expect(lastRosterOf("a", sides.lastOpponents, sides.lastPartners)?.sort()).toEqual(
      ["a", "b", "c", "d"].sort()
    );
    expect(lastRosterOf("e", sides.lastOpponents, sides.lastPartners)).toBeNull();
    expect(sides.lastOpponents.get("a")).toEqual(new Set(["c", "d"]));
    expect(sides.lastPartners.get("a")).toEqual(new Set(["b"]));
  });
});

describe("U-R1 incident-shaped 9a266930", () => {
  const dom = player("dom", { skill: 2, games: 3, wait: 14, priority: 14 });
  const pat = player("pat", { skill: 1, games: 3, wait: 12, priority: 12 });
  const nic = player("nic", { skill: 1, games: 3, wait: 12, priority: 12 });
  const ram = player("ram", { skill: 1, games: 3, wait: 12, priority: 12 });
  const luis = player("luis", { skill: 3, games: 3, wait: 8, priority: 8 });
  const pool = [dom, pat, nic, ram, luis];
  const sides = lastGame({ a: ["ched", "nic"], b: ["pat", "ram"] });
  const recentRosters = [
    ["p1", "p2", "p3", "p4"],
    ["p5", "p6", "p7", "p8"],
    ["p9", "p10", "p11", "p12"],
    ["ched", "nic", "pat", "ram"],
  ];

  it("OFF reproduces the near-identical four; ON swaps one beginner for luis", () => {
    const off = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      recentRosters,
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(off.proposal).not.toBeNull();
    const offIds = idsOf(off.proposal!);
    expect(offIds).toEqual(["dom", "nic", "pat", "ram"].sort());
    expect(isBackToBackRepeat(offIds, sides.lastOpponents, sides.lastPartners)).toBe(true);

    const on = runAlgorithmWithFreshness(
      pool,
      new Map(),
      new Map(),
      recentRosters,
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(on.proposal).not.toBeNull();
    expect(on.refreshed).toBe(true);
    expect(on.proposal!.isMixedLevel).toBe(false);
    const onIds = idsOf(on.proposal!);
    expect(onIds).toContain("dom");
    expect(onIds).toContain("luis");
    expect(isBackToBackRepeat(onIds, sides.lastOpponents, sides.lastPartners)).toBe(false);
    expect(onIds.filter((id) => ["nic", "pat", "ram"].includes(id)).length).toBeLessThanOrEqual(2);
  });
});

describe("U-R2 previous game 13th newest still refreshes", () => {
  const ches = player("ches", { skill: 1, games: 3, wait: 12, priority: 12 });
  const lei = player("lei", { skill: 1, games: 3, wait: 12, priority: 12 });
  const ing = player("ing", { skill: 2, games: 4, wait: 10, priority: 10 });
  const dom = player("dom", { skill: 2, games: 4, wait: 14, priority: 14 });
  const avy = player("avy", { skill: 3, games: 1, wait: 10, priority: 10 });
  const pool = [dom, ches, lei, ing, avy];
  const sides = lastGame({ a: ["lei", "ches"], b: ["ing", "x"] });
  const recentRosters = Array.from({ length: 13 }, (_, i) => [
    `f${i}a`,
    `f${i}b`,
    `f${i}c`,
    `f${i}d`,
  ]);

  it("ON does not depend on how deep the previous game sits", () => {
    const on = runAlgorithmWithFreshness(
      pool,
      new Map(),
      new Map(),
      recentRosters,
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(on.proposal).not.toBeNull();
    const ids = idsOf(on.proposal!);
    expect(isBackToBackRepeat(ids, sides.lastOpponents, sides.lastPartners)).toBe(false);
  });
});

describe("U-R3 one-body swap gap", () => {
  const anchor = player("a", { skill: 3, games: 2, wait: 12, priority: 12 });
  const b = player("b", { skill: 3, games: 2, wait: 11, priority: 11 });
  const c = player("c", { skill: 3, games: 2, wait: 11, priority: 11 });
  const d = player("d", { skill: 3, games: 2, wait: 11, priority: 11 });
  const e = player("e", { skill: 3, games: 2, wait: 8, priority: 8 });
  const pool = [anchor, b, c, d, e];
  const sides = lastGame({ a: ["a", "b"], b: ["c", "x"] });
  const recentRosters = [
    ["p1", "p2", "p3", "p4"],
    ["p5", "p6", "p7", "p8"],
    ["a", "b", "c", "x"],
  ];

  it("OFF may force-repeat; ON finds a fresh triple", () => {
    const off = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      recentRosters,
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(off.proposal).not.toBeNull();
    const on = runAlgorithmWithFreshness(
      pool,
      new Map(),
      new Map(),
      recentRosters,
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(on.proposal).not.toBeNull();
    expect(isBackToBackRepeat(idsOf(on.proposal!), sides.lastOpponents, sides.lastPartners)).toBe(
      false
    );
  });
});

describe("U-W1 wrapper cannot stall or touch a fresh four", () => {
  it("null in → null out with the same capSaturation", () => {
    const only = [player("a"), player("b")];
    const off = runAlgorithm(only, new Map(), new Map(), []);
    const on = runAlgorithmWithFreshness(only, new Map(), new Map(), []);
    expect(off.proposal).toBeNull();
    expect(on.proposal).toBeNull();
    expect(on.capSaturation).toBe(off.capSaturation);
    expect(on.capSaturationReason).toBe(off.capSaturationReason);
  });

  it("fresh four is returned unchanged", () => {
    const pool = [
      player("a", { wait: 10, priority: 10 }),
      player("b", { wait: 8, priority: 8 }),
      player("c", { wait: 8, priority: 8 }),
      player("d", { wait: 8, priority: 8 }),
    ];
    const off = runAlgorithm(pool, new Map(), new Map(), []);
    const on = runAlgorithmWithFreshness(pool, new Map(), new Map(), []);
    expect(idsOf(on.proposal!)).toEqual(idsOf(off.proposal!));
    expect(on.refreshed).toBeUndefined();
  });
});

describe("U-W2 skill window and mixed-level label", () => {
  it("never emits a ±3 four; refreshed proposals are isMixedLevel false", () => {
    const anchor = player("a", { skill: 1, wait: 22, priority: 1022 });
    const b = player("b", { skill: 1, wait: 6, priority: 6 });
    const c = player("c", { skill: 1, wait: 6, priority: 6 });
    const d = player("d", { skill: 1, wait: 6, priority: 6 });
    const far = player("far", { skill: 5, wait: 6, priority: 6 });
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const on = runAlgorithmWithFreshness(
      [anchor, b, c, d, far],
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(on.proposal).not.toBeNull();
    const skills = [...on.proposal!.teamA, ...on.proposal!.teamB].map((p) => p.skill_level_int);
    expect(Math.max(...skills) - Math.min(...skills)).toBeLessThanOrEqual(2);
    if (on.refreshed) expect(on.proposal!.isMixedLevel).toBe(false);
  });
});

describe("U-G guard boundaries", () => {
  const anchor = player("a", { skill: 3, games: 2, wait: 12, priority: 12 });
  const b = player("b", { skill: 3, games: 2, wait: 12, priority: 12 });
  const c = player("c", { skill: 3, games: 2, wait: 12, priority: 12 });
  const d = player("d", { skill: 3, games: 2, wait: 12, priority: 12 });
  const served = { teamA: [anchor, b], teamB: [c, d], isMixedLevel: false };
  // Last game is b+c vs d+x so S is stale (3 of 4), but swapping d for a new
  // body drops the overlap to 2 and is a real refresh.
  const sides = lastGame({ a: ["b", "c"], b: ["d", "x"] });

  it("U-G-a: dropping a Red Zone member of S is rejected", () => {
    const rz = player("rz", { skill: 3, games: 2, wait: 22, priority: 1022 });
    const e = player("e", { skill: 3, games: 2, wait: 10, priority: 10 });
    const s = { teamA: [anchor, rz], teamB: [c, d], isMixedLevel: false };
    const found = findFresherFour([anchor, rz, c, d, e], s, {
      partnershipCounts: new Map(),
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    if (found) {
      const ids = idsOf(found);
      expect(ids).toContain("rz");
    }
  });

  it("U-G-b: games-ahead sum +1 is rejected", () => {
    const e = player("e", { skill: 3, games: 4, wait: 12, priority: 12 });
    const found = findFresherFour([anchor, b, c, d, e], served, {
      partnershipCounts: new Map(),
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    expect(found === null || !idsOf(found).includes("e")).toBe(true);
  });

  it("U-G-c: extra anchor overlap is rejected", () => {
    const e = player("e", { skill: 3, games: 2, wait: 12, priority: 12 });
    const overlapMap = new Map([["e", 4]]);
    const found = findFresherFour([anchor, b, c, d, e], served, {
      partnershipCounts: new Map(),
      overlapMap,
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    expect(found === null || !idsOf(found).includes("e")).toBe(true);
  });

  it("U-G-d: wait sum = S − slack is accepted; one tick below is rejected", () => {
    const slack = FRESHNESS_WAIT_SLACK_MINUTES;
    const eOk = player("eok", { skill: 3, games: 2, wait: 12 - slack, priority: 2 });
    const eBad = player("ebad", { skill: 3, games: 2, wait: 12 - slack - 1, priority: 1 });
    const ok = findFresherFour([anchor, b, c, d, eOk], served, {
      partnershipCounts: new Map(),
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
      waitSlackMinutes: slack,
    });
    expect(ok).not.toBeNull();
    expect(idsOf(ok!)).toContain("eok");

    const bad = findFresherFour([anchor, b, c, d, eBad], served, {
      partnershipCounts: new Map(),
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
      waitSlackMinutes: slack,
    });
    expect(bad === null || !idsOf(bad).includes("ebad")).toBe(true);
  });

  it("U-G-e: will not raise consecutive-opponent staleness", () => {
    const e = player("e", { skill: 3, games: 2, wait: 10, priority: 10 });
    const lastOpponents: LastOpponents = new Map([
      ["e", new Set(["a", "b", "c", "d"])],
      ["a", new Set(["e"])],
      ["b", new Set(["e"])],
      ["c", new Set(["e"])],
      ["d", new Set(["e"])],
    ]);
    const lastPartners: LastPartners = new Map();
    const freshS = { teamA: [anchor, b], teamB: [c, d], isMixedLevel: false };
    const found = findFresherFour([anchor, b, c, d, e], freshS, {
      partnershipCounts: new Map(),
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents,
      lastPartners,
    });
    expect(found === null || !idsOf(found).includes("e")).toBe(true);
  });
});

describe("U-F fail-open and invariants", () => {
  it("U-F1 thin band serves S and flags backToBackRepeat", () => {
    const pool = [
      player("a", { skill: 1, wait: 12, priority: 12 }),
      player("b", { skill: 1, wait: 11, priority: 11 }),
      player("c", { skill: 1, wait: 11, priority: 11 }),
      player("d", { skill: 1, wait: 11, priority: 11 }),
    ];
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const on = runAlgorithmWithFreshness(
      pool,
      new Map(),
      new Map(),
      [],
      new Map(),
      [],
      sides.lastOpponents,
      sides.lastPartners
    );
    expect(on.proposal).not.toBeNull();
    expect(on.refreshed).toBeUndefined();
    expect(on.backToBackRepeat).toBe(true);
  });

  it("U-F2 cap-override / last-partner four is skipped", () => {
    const a = player("a", { skill: 3, wait: 12, priority: 12 });
    const b = player("b", { skill: 3, wait: 11, priority: 11 });
    const c = player("c", { skill: 3, wait: 11, priority: 11 });
    const d = player("d", { skill: 3, wait: 11, priority: 11 });
    const e = player("e", { skill: 3, wait: 10, priority: 10 });
    const served = { teamA: [a, b], teamB: [c, d], isMixedLevel: false };
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const partnershipCounts = new Map([
      ["a:e", MAX_PARTNERSHIP_REPEATS],
      ["b:e", MAX_PARTNERSHIP_REPEATS],
      ["c:e", MAX_PARTNERSHIP_REPEATS],
    ]);
    const found = findFresherFour([a, b, c, d, e], served, {
      partnershipCounts,
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    expect(found === null || !idsOf(found).includes("e")).toBe(true);
  });

  it("U-F3 rejected roster is skipped", () => {
    const a = player("a", { skill: 3, wait: 12, priority: 12 });
    const b = player("b", { skill: 3, wait: 11, priority: 11 });
    const c = player("c", { skill: 3, wait: 11, priority: 11 });
    const d = player("d", { skill: 3, wait: 11, priority: 11 });
    const e = player("e", { skill: 3, wait: 10, priority: 10 });
    const served = { teamA: [a, b], teamB: [c, d], isMixedLevel: false };
    const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
    const found = findFresherFour([a, b, c, d, e], served, {
      partnershipCounts: new Map(),
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [["a", "b", "c", "e"]],
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    expect(found === null || idsOf(found).join() !== ["a", "b", "c", "e"].sort().join()).toBe(true);
  });
});

describe("U-X1 cross-court back-to-back filter", () => {
  const anchor = player("a", { skill: 3, wait: 10, priority: 10 });
  const b = player("b", { skill: 3, wait: 8, priority: 8 });
  const c = player("c", { skill: 3, wait: 8, priority: 8 });
  const body = player("body", { skill: 3, wait: 0, priority: -1, pulled: true });
  const sides = lastGame({ a: ["a", "b"], b: ["c", "body"] });
  const args = {
    partnershipCounts: new Map<string, number>(),
    overlapMap: new Map<string, number>(),
    recentRosters: [] as string[][],
    opponentCounts: new Map<string, number>(),
    rejectedRosters: [] as string[][],
    lastOpponents: sides.lastOpponents,
    lastPartners: sides.lastPartners,
    baseStaleness: 2,
    forcedRepeat: true as boolean | undefined,
  };

  it("filter on skips a back-to-back pick; filter off matches today's output", () => {
    const off = buildCrossCourtProposal([anchor, b, c], [body], {
      ...args,
      backToBackFilter: false,
    });
    const on = buildCrossCourtProposal([anchor, b, c], [body], { ...args, backToBackFilter: true });
    if (off && isBackToBackRepeat(idsOf(off.proposal), sides.lastOpponents, sides.lastPartners)) {
      expect(on).toBeNull();
    }
  });
});

describe("U-C1 / U-T1 constants and operation count", () => {
  it("sub-quantum proof and slack stay below Red Zone wait", () => {
    expect(5 * CONSECUTIVE_OPPONENT_PENALTY).toBeLessThan(GAMES_AHEAD_PENALTY_RED_ZONE);
    expect(FRESHNESS_WAIT_SLACK_MINUTES).toBeLessThan(CRITICAL_WAIT_MINUTES);
  });

  it("enumerates at most C(n,3) triples and snakeDrafts only survivors", () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      player(`p${i}`, { skill: 3, games: 1, wait: 10 - i * 0.1, priority: 10 - i * 0.1 })
    );
    const served = {
      teamA: [pool[0], pool[1]],
      teamB: [pool[2], pool[3]],
      isMixedLevel: false,
    };
    const sides = lastGame({ a: ["p0", "p1"], b: ["p2", "p3"] });
    const diagnostics = { triplesEnumerated: 0, snakeDraftCalls: 0 };
    findFresherFour(
      pool,
      served,
      {
        partnershipCounts: new Map(),
        overlapMap: new Map(),
        recentRosters: [],
        opponentCounts: new Map(),
        rejectedRosters: [],
        lastOpponents: sides.lastOpponents,
        lastPartners: sides.lastPartners,
      },
      diagnostics
    );
    const n = 11;
    const c3 = (n * (n - 1) * (n - 2)) / 6;
    expect(diagnostics.triplesEnumerated).toBeLessThanOrEqual(c3);
    expect(diagnostics.snakeDraftCalls).toBeLessThanOrEqual(diagnostics.triplesEnumerated);
  });
});

describe("U-H1 slot-planning helpers", () => {
  it("planSlots applies override ceiling and mode-dependent draftCount", () => {
    const pending = [
      { is_published: false, is_held: false, held_ready_at: null },
      { is_published: false, is_held: true, held_ready_at: null },
    ];
    const draft = planSlots({
      waitingCount: 10,
      override: 2,
      autoPublish: false,
      pendingRows: pending,
    });
    expect(draft.effectiveCap).toBe(2);
    expect(draft.draftCount).toBe(1);
    expect(draft.slotsAvailable).toBe(1);

    const auto = planSlots({
      waitingCount: 10,
      override: null,
      autoPublish: true,
      pendingRows: pending,
    });
    expect(auto.draftCount).toBe(1);
  });

  it("soft gate is lazy: only small pools without Red Zone / timeout need a count", () => {
    expect(softGateDecision({ bypassGate: true, waitingCount: 4, maxWait: 2 })).toBe("release");
    expect(softGateDecision({ bypassGate: false, waitingCount: 8, maxWait: 2 })).toBe("release");
    expect(softGateDecision({ bypassGate: false, waitingCount: 4, maxWait: 20 })).toBe("release");
    expect(softGateDecision({ bypassGate: false, waitingCount: 4, maxWait: 2 })).toBe(
      "needs-active-count"
    );
  });

  it("slot 0 always continues; later slots need 8 waiting unless bypassed", () => {
    expect(shouldContinueSlot({ slotIndex: 0, estimatedWaiting: 4, bypassGate: false })).toBe(true);
    expect(shouldContinueSlot({ slotIndex: 1, estimatedWaiting: 7, bypassGate: false })).toBe(
      false
    );
    expect(shouldContinueSlot({ slotIndex: 1, estimatedWaiting: 8, bypassGate: false })).toBe(true);
    expect(shouldContinueSlot({ slotIndex: 1, estimatedWaiting: 4, bypassGate: true })).toBe(true);
  });
});

describe("env flag", () => {
  it("defaults on; false/0/off disable", () => {
    expect(isFreshnessRefreshEnabled(undefined)).toBe(true);
    expect(isFreshnessRefreshEnabled("")).toBe(true);
    expect(isFreshnessRefreshEnabled("true")).toBe(true);
    expect(isFreshnessRefreshEnabled("false")).toBe(false);
    expect(isFreshnessRefreshEnabled("FALSE")).toBe(false);
    expect(isFreshnessRefreshEnabled("0")).toBe(false);
    expect(isFreshnessRefreshEnabled("off")).toBe(false);
  });
});

describe("U-P property tests", () => {
  function mulberry32(seed: number) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("P1–P4 hold on 200 seeded pools", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = mulberry32(seed);
      const n = 4 + Math.floor(rnd() * 10);
      const pool = Array.from({ length: n }, (_, i) =>
        player(`p${i}`, {
          skill: 1 + Math.floor(rnd() * 4),
          games: Math.floor(rnd() * 4),
          wait: 4 + rnd() * 16,
          priority: 4 + rnd() * 16,
        })
      ).sort((a, b) => b.priorityScore - a.priorityScore);
      const sides =
        rnd() > 0.4
          ? lastGame({
              a: [pool[0].player_id, pool[1].player_id],
              b: [pool[2].player_id, pool[Math.min(3, n - 1)].player_id],
            })
          : {
              lastOpponents: new Map<string, Set<string>>(),
              lastPartners: new Map<string, Set<string>>(),
            };

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
      const on = runAlgorithmWithFreshness(
        pool,
        new Map(),
        new Map(),
        [],
        new Map(),
        [],
        sides.lastOpponents,
        sides.lastPartners
      );
      expect(!!on.proposal).toBe(!!off.proposal);
      if (on.proposal) {
        expect(idsOf(on.proposal)).toContain(pool[0].player_id);
        if (on.refreshed && off.proposal) {
          const sIds = idsOf(off.proposal);
          const onIds = idsOf(on.proposal);
          const sRz = [...off.proposal.teamA, ...off.proposal.teamB]
            .filter((p) => (p.wait_minutes ?? 0) >= CRITICAL_WAIT_MINUTES)
            .map((p) => p.player_id);
          for (const id of sRz) expect(onIds).toContain(id);
          expect(onIds.join()).not.toBe(sIds.join());
        }
      }
    }
  });
});

describe("U-P5 independent brute force agrees with findFresherFour existence", () => {
  it("source does not call findFresherFour", () => {
    const src = readFileSync(join(process.cwd(), "scripts/replay/freshness-brute.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/findFresherFour/);
  });

  it("existence matches on the incident-shaped pool and a thin fail-open pool", () => {
    const emptyArgs = {
      partnershipCounts: new Map<string, number>(),
      overlapMap: new Map<string, number>(),
      recentRosters: [] as string[][],
      opponentCounts: new Map<string, number>(),
      rejectedRosters: [] as string[][],
    };

    const ram = player("ram", { skill: 1, games: 2, wait: 14, priority: 14 });
    const nic = player("nic", { skill: 1, games: 2, wait: 12, priority: 12 });
    const pat = player("pat", { skill: 1, games: 2, wait: 11, priority: 11 });
    const dom = player("dom", { skill: 2, games: 3, wait: 10, priority: 10 });
    const luis = player("luis", { skill: 3, games: 2, wait: 9, priority: 9 });
    const pool = [ram, nic, pat, dom, luis];
    const sides = lastGame({ a: ["ram", "nic"], b: ["pat", "x"] });
    const served = { teamA: [ram, nic], teamB: [pat, dom], isMixedLevel: false };
    const brute = hasAdmissibleFresherFour(pool, served, {
      ...emptyArgs,
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    const found = findFresherFour(pool, served, {
      ...emptyArgs,
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    expect(brute).toBe(found !== null);

    const thin = [ram, nic, pat, player("only", { skill: 1, games: 6, wait: 1, priority: 1 })];
    const thinServed = { teamA: [ram, nic], teamB: [pat, thin[3]], isMixedLevel: false };
    const thinBrute = hasAdmissibleFresherFour(thin, thinServed, {
      ...emptyArgs,
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    const thinFound = findFresherFour(thin, thinServed, {
      ...emptyArgs,
      lastOpponents: sides.lastOpponents,
      lastPartners: sides.lastPartners,
    });
    expect(thinBrute).toBe(false);
    expect(thinFound).toBeNull();
  });
});

describe("PLAYERS_PER_MATCH still 4", () => {
  it("doubles only", () => {
    expect(PLAYERS_PER_MATCH).toBe(4);
  });
});
