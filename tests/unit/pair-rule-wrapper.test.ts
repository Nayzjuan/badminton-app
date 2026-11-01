// ============================================================
// Pair-repeat PR 1 — flags-off wrapper + harness plumbing
// ============================================================
// Intent: composeEngineProposal with both rules off is byte-identical to
// today's runAlgorithm / runAlgorithmWithFreshness. The harness sanitizes
// overnight matches and scores shared-court repeats. No engine behaviour
// change in this PR.

import { describe, expect, it } from "vitest";
import {
  buildCrossCourtProposal,
  composeEngineProposal,
  PAIR_RULE_FLAGS_OFF,
  pullImprovesFreshness,
  runAlgorithm,
  runAlgorithmWithFreshness,
  wantsFresherFour,
  type LastOpponents,
  type LastPartners,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import {
  isFreshnessRefreshEnabled,
  isNoImmediateRematchEnabled,
  isSharedGamesPreferenceEnabled,
} from "@/lib/matchmaking-slots";
import { MAX_SHARED_GAMES } from "@/lib/constants";
import type { SkillLevel } from "@/types/database";
import { sanitizeFixture, MAX_REPLAY_MATCH_MINUTES } from "../../scripts/replay/fetch";
import { computeMetrics } from "../../scripts/replay/metrics";
import type { SessionFixture } from "../../scripts/replay/types";

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
  opts: { skill?: number; games?: number; wait?: number; priority?: number; pulled?: boolean } = {}
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

describe("pair-rule env flags", () => {
  it("unset or empty means on; false/0/off means off", () => {
    expect(isFreshnessRefreshEnabled(undefined)).toBe(true);
    expect(isFreshnessRefreshEnabled("")).toBe(true);
    expect(isNoImmediateRematchEnabled("false")).toBe(false);
    expect(isNoImmediateRematchEnabled("0")).toBe(false);
    expect(isSharedGamesPreferenceEnabled("off")).toBe(false);
    expect(isSharedGamesPreferenceEnabled("ON")).toBe(true);
  });
});

describe("composeEngineProposal flags off", () => {
  const pool = [
    player("a", { skill: 3, wait: 16, priority: 16 }),
    player("b", { skill: 3, wait: 14, priority: 14 }),
    player("c", { skill: 3, wait: 12, priority: 12 }),
    player("d", { skill: 3, wait: 10, priority: 10 }),
    player("e", { skill: 4, wait: 8, priority: 8 }),
  ];
  const sides = lastGame({ a: ["a", "b"], b: ["c", "d"] });
  const inputs = {
    partnershipCounts: new Map<string, number>(),
    overlapMap: new Map<string, number>(),
    recentRosters: [] as string[][],
    opponentCounts: new Map<string, number>(),
    rejectedRosters: [] as string[][],
    lastOpponents: sides.lastOpponents,
    lastPartners: sides.lastPartners,
  };

  it("matches runAlgorithm when freshness is off", () => {
    const direct = runAlgorithm(
      pool,
      inputs.partnershipCounts,
      inputs.overlapMap,
      inputs.recentRosters,
      inputs.opponentCounts,
      inputs.rejectedRosters,
      inputs.lastOpponents,
      inputs.lastPartners
    );
    const wrapped = composeEngineProposal(pool, inputs, PAIR_RULE_FLAGS_OFF, { freshness: false });
    expect(wrapped.proposal && idsOf(wrapped.proposal)).toEqual(
      direct.proposal && idsOf(direct.proposal)
    );
    expect(wrapped.capSaturation).toBe(direct.capSaturation);
    expect(wrapped.capSaturationReason).toBe(direct.capSaturationReason);
    expect(wrapped.forcedRepeat).toBe(direct.forcedRepeat);
    expect(wrapped.sharedOverCapPairs).toBe(0);
    expect(wrapped.rematchBlocked).toBeUndefined();
  });

  it("matches runAlgorithmWithFreshness when freshness is on", () => {
    const direct = runAlgorithmWithFreshness(
      pool,
      inputs.partnershipCounts,
      inputs.overlapMap,
      inputs.recentRosters,
      inputs.opponentCounts,
      inputs.rejectedRosters,
      inputs.lastOpponents,
      inputs.lastPartners
    );
    const wrapped = composeEngineProposal(pool, inputs, PAIR_RULE_FLAGS_OFF, { freshness: true });
    expect(wrapped.proposal && idsOf(wrapped.proposal)).toEqual(
      direct.proposal && idsOf(direct.proposal)
    );
    expect(wrapped.refreshed).toBe(direct.refreshed);
    expect(wrapped.backToBackRepeat).toBe(direct.backToBackRepeat);
    expect(wrapped.sharedOverCapPairs).toBe(0);
  });
});

describe("cross-court flags off is today's output", () => {
  it("wantsFresherFour and pullImprovesFreshness keep two-arg behaviour", () => {
    expect(wantsFresherFour(undefined, 0)).toBe(false);
    expect(wantsFresherFour(true, 0)).toBe(true);
    expect(wantsFresherFour(undefined, 1)).toBe(true);
    expect(pullImprovesFreshness(undefined, 2, 1)).toBe(true);
    expect(pullImprovesFreshness(undefined, 1, 1)).toBe(false);
    expect(pullImprovesFreshness(true, 0, 2)).toBe(true);
  });

  it("an over-cap pull candidate is not skipped when R2 is off", () => {
    const pool = [
      player("a", { skill: 3, wait: 16, priority: 16 }),
      player("b", { skill: 3, wait: 14, priority: 14 }),
      player("c", { skill: 3, wait: 12, priority: 12 }),
      player("d", { skill: 3, wait: 10, priority: 10 }),
    ];
    const body = player("x", { skill: 3, wait: 0, priority: -1, pulled: true });
    const partnershipCounts = new Map<string, number>([["a:x", 3]]);
    const pick = buildCrossCourtProposal(pool, [body], {
      partnershipCounts,
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: new Map(),
      lastPartners: new Map(),
      baseStaleness: 2,
      forcedRepeat: true,
      flags: PAIR_RULE_FLAGS_OFF,
    });
    const today = buildCrossCourtProposal(pool, [body], {
      partnershipCounts,
      overlapMap: new Map(),
      recentRosters: [],
      opponentCounts: new Map(),
      rejectedRosters: [],
      lastOpponents: new Map(),
      lastPartners: new Map(),
      baseStaleness: 2,
      forcedRepeat: true,
    });
    expect(pick?.pulledPlayerId).toBe(today?.pulledPlayerId);
    expect(pick?.proposal && idsOf(pick.proposal)).toEqual(
      today?.proposal && idsOf(today.proposal)
    );
  });
});

describe("sanitizeFixture", () => {
  const fixture: SessionFixture = {
    sessionId: "s1",
    name: "overnight",
    day: "2026-10-31",
    t0: "2026-10-31T00:00:00.000Z",
    players: [
      {
        player_id: "p1",
        display_name: "P1",
        skill_level_int: 3,
        skill_level: "intermediate",
        joinMin: 0,
      },
    ],
    courts: [
      { id: "c0", name: "C0", durationsMin: [20, 1175] },
      { id: "c1", name: "C1", durationsMin: [1175] },
    ],
    horizonMin: 1400,
    realMatches: [
      {
        seq: 1,
        courtId: "c0",
        startMin: 10,
        endMin: 30,
        teamA: ["a", "b"],
        teamB: ["c", "d"],
      },
      {
        seq: 55,
        matchId: "left-open",
        courtId: "c1",
        startMin: 40,
        endMin: 40 + 1175,
        teamA: ["e", "f"],
        teamB: ["g", "h"],
      },
    ],
  };

  it("drops matches longer than MAX_REPLAY_MATCH_MINUTES and empty courts", () => {
    const cleaned = sanitizeFixture(fixture);
    expect(MAX_REPLAY_MATCH_MINUTES).toBe(90);
    expect(cleaned.realMatches.map((m) => m.seq)).toEqual([1]);
    expect(cleaned.courts.map((c) => c.id)).toEqual(["c0"]);
    expect(cleaned.courts[0].durationsMin).toEqual([20]);
    expect(cleaned.horizonMin).toBe(30);
  });

  it("throws when no court remains", () => {
    expect(() =>
      sanitizeFixture({
        ...fixture,
        courts: [{ id: "c1", name: "C1", durationsMin: [1175] }],
        realMatches: [fixture.realMatches[1]],
      })
    ).toThrow(/no court left/);
  });
});

describe("shared-court metrics", () => {
  it("counts a pair's partner+opponent meetings against MAX_SHARED_GAMES", () => {
    const matches = [
      { seq: 1, courtId: "c", startMin: 0, endMin: 20, teamA: ["a", "b"], teamB: ["c", "d"] },
      { seq: 2, courtId: "c", startMin: 20, endMin: 40, teamA: ["a", "c"], teamB: ["b", "e"] },
      { seq: 3, courtId: "c", startMin: 40, endMin: 60, teamA: ["a", "f"], teamB: ["b", "g"] },
    ];
    const m = computeMetrics(matches, 7);
    expect(MAX_SHARED_GAMES).toBe(2);
    expect(m.consecutiveCoPlayerRepeats).toBeGreaterThan(0);
    expect(m.pairsOverSharedCap).toBe(1);
    expect(m.maxSharedGames).toBe(3);
  });
});
