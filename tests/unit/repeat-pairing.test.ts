// ============================================================
// Unit Tests: repeat-pairing derivers (manual-match repeat warning)
// ============================================================
// Covers the cases an independent plan review flagged as must-test:
//   RP-T*  team derivation from SELECTION ORDER (incl. deselect reshuffle)
//   RP-W*  warning derivation + thresholds + ordering
//   RP-M*  candidate-marker matrix per selection size
//   RP-X*  exclusion + disjointness (markers never overlap the panel)
//   RP-C*  thresholds stay pinned to the engine constants (anti-drift)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  deriveTeams,
  derivePairWarnings,
  deriveCandidateMarkers,
  hasCleanAlternative,
  filledCount,
  DEFAULT_REPEAT_THRESHOLDS,
  EMPTY_SLOTS,
  type PairCounts,
} from "@/lib/repeat-pairing";
import { pairKey } from "@/lib/matchmaking-core";
import { MAX_PARTNERSHIP_REPEATS, MAX_OPPONENT_REPEATS } from "@/lib/constants";

const P1 = "p1",
  P2 = "p2",
  P3 = "p3",
  P4 = "p4",
  P5 = "p5";

function counts(
  partnerships: Array<[string, string, number]> = [],
  opponents: Array<[string, string, number]> = []
): PairCounts {
  return {
    partnerships: new Map(partnerships.map(([a, b, n]) => [pairKey(a, b), n])),
    opponents: new Map(opponents.map(([a, b, n]) => [pairKey(a, b), n])),
  };
}

const T = { teammate: 2, opponent: 2 };

describe("repeat-pairing — thresholds", () => {
  it("RP-C1: production thresholds are pinned to the engine caps (no drift)", () => {
    expect(DEFAULT_REPEAT_THRESHOLDS.teammate).toBe(MAX_PARTNERSHIP_REPEATS);
    expect(DEFAULT_REPEAT_THRESHOLDS.opponent).toBe(MAX_OPPONENT_REPEATS);
  });
});

describe("repeat-pairing — deriveTeams", () => {
  it("RP-T1: A = picks 1-2, B = picks 3-4", () => {
    expect(deriveTeams([P1, P2, P3, P4])).toEqual({ teamA: [P1, P2], teamB: [P3, P4] });
  });

  it("RP-T2: partial selections yield partial teams", () => {
    expect(deriveTeams([P1])).toEqual({ teamA: [P1], teamB: [] });
    expect(deriveTeams([P1, P2, P3])).toEqual({ teamA: [P1, P2], teamB: [P3] });
  });

  it("RP-T3: deselect FREES ITS SLOT — the other three players do not move teams", () => {
    // select p1,p2,p3,p4 -> deselect p2 (A2) -> the vacated slot is A2, not a reshuffle
    const afterDeselect = [P1, null, P3, P4];
    expect(deriveTeams(afterDeselect)).toEqual({ teamA: [P1], teamB: [P3, P4] });
    // next tap refills A2 — p3/p4 are still Team B, exactly as the organizer left them
    const afterRepick = [P1, P5, P3, P4];
    expect(deriveTeams(afterRepick)).toEqual({ teamA: [P1, P5], teamB: [P3, P4] });
  });

  it("RP-T4: filledCount ignores gaps", () => {
    expect(filledCount([P1, null, P3, null])).toBe(2);
    expect(filledCount(EMPTY_SLOTS)).toBe(0);
  });
});

describe("repeat-pairing — derivePairWarnings", () => {
  it("RP-W1: no warnings below 2 selected", () => {
    expect(derivePairWarnings([], counts(), T)).toEqual([]);
    expect(derivePairWarnings([P1], counts([[P1, P2, 9]]), T)).toEqual([]);
  });

  it("RP-W2: 2 selected evaluates exactly the one teammate pair", () => {
    const w = derivePairWarnings([P1, P2], counts([[P1, P2, 2]]), T);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ relation: "teammate", count: 2, pairKey: pairKey(P1, P2) });
  });

  it("RP-W3: below threshold does not warn (>= is the trigger)", () => {
    expect(derivePairWarnings([P1, P2], counts([[P1, P2, 1]]), T)).toEqual([]);
  });

  it("RP-W4: 3 selected adds the two opponent pairs", () => {
    const w = derivePairWarnings(
      [P1, P2, P3],
      counts(
        [],
        [
          [P1, P3, 2],
          [P2, P3, 5],
        ]
      ),
      T
    );
    expect(w.map((x) => x.relation)).toEqual(["opponent", "opponent"]);
    // sorted by count desc within relation
    expect(w[0].count).toBe(5);
  });

  it("RP-W5: 4 selected evaluates all six pairs; teammates listed first", () => {
    const w = derivePairWarnings(
      [P1, P2, P3, P4],
      counts(
        [
          [P1, P2, 3],
          [P3, P4, 2],
        ],
        [
          [P1, P3, 4],
          [P1, P4, 2],
          [P2, P3, 2],
          [P2, P4, 2],
        ]
      ),
      T
    );
    expect(w).toHaveLength(6);
    expect(w.slice(0, 2).every((x) => x.relation === "teammate")).toBe(true);
    expect(w[0].count).toBe(3); // worst teammate headlines
  });

  it("RP-W6: a pair can trigger as BOTH teammate and opponent across different selections", () => {
    const c = counts([[P1, P2, 2]], [[P1, P2, 4]]);
    // same team -> teammate relation
    expect(derivePairWarnings([P1, P2], c, T)[0].relation).toBe("teammate");
    // opposite sides -> opponent relation
    const opp = derivePairWarnings([P1, P3, P2, P4], c, T).filter(
      (w) => w.pairKey === pairKey(P1, P2)
    );
    expect(opp).toHaveLength(1);
    expect(opp[0]).toMatchObject({ relation: "opponent", count: 4 });
  });
});

describe("repeat-pairing — deriveCandidateMarkers", () => {
  const c = counts(
    [
      [P1, P5, 3],
      [P3, P5, 2],
    ],
    [
      [P1, P5, 4],
      [P2, P5, 2],
    ]
  );

  it("RP-M1: no markers with 0 selected or when selection is full", () => {
    expect(deriveCandidateMarkers([], [P5], c, T)).toEqual([]);
    expect(deriveCandidateMarkers([P1, P2, P3, P4], [P5], c, T)).toEqual([]);
  });

  it("RP-M2: 1 selected — candidate would be a TEAMMATE of pick 1", () => {
    const m = deriveCandidateMarkers([P1], [P5], c, T);
    expect(m).toHaveLength(1);
    expect(m[0].relations).toEqual([{ relation: "teammate", withPlayerId: P1, count: 3 }]);
    expect(m[0].primaryRelation).toBe("teammate");
  });

  it("RP-M3: 2 selected — candidate would OPPOSE both A players", () => {
    const m = deriveCandidateMarkers([P1, P2], [P5], c, T);
    expect(m[0].relations.map((r) => r.relation)).toEqual(["opponent", "opponent"]);
    expect(m[0].relations.map((r) => r.withPlayerId).sort()).toEqual([P1, P2]);
    expect(m[0].worstCount).toBe(4);
  });

  it("RP-M4: 3 selected — returns ALL THREE relations, not just one", () => {
    const m = deriveCandidateMarkers([P1, P2, P3], [P5], c, T);
    expect(m[0].relations).toHaveLength(3); // teammate of p3 + opponent of p1, p2
    expect(m[0].relations[0].relation).toBe("teammate"); // teammate outranks
    expect(m[0].primaryRelation).toBe("teammate");
    expect(m[0].worstCount).toBe(4);
  });

  it("RP-M5: candidates below threshold get no marker", () => {
    const m = deriveCandidateMarkers([P1], [P4], counts([[P1, P4, 1]]), T);
    expect(m).toEqual([]);
  });
});

describe("repeat-pairing — slot gaps (post-deselect)", () => {
  it("RP-M6: freeing A2 makes the next tap a TEAMMATE of A1, not an opponent", () => {
    // [A1=p1, A2 free, B1=p3, B2=p4] — three selected, but the free slot is on Team A.
    const slots = [P1, null, P3, P4];
    const c = counts([[P1, P5, 2]], [[P3, P5, 9]]);
    const m = deriveCandidateMarkers(slots, [P5], c, T);
    expect(m).toHaveLength(1);
    // teammate of A1 (the freed slot's partner) AND opponent of both B players
    expect(m[0].relations).toContainEqual({ relation: "teammate", withPlayerId: P1, count: 2 });
    expect(m[0].relations).toContainEqual({ relation: "opponent", withPlayerId: P3, count: 9 });
    expect(m[0].primaryRelation).toBe("teammate");
  });

  it("RP-M7: warnings ignore an empty slot's team rather than inventing a pair", () => {
    // Only A1 and B1 occupied -> exactly one opponent pair, no teammate pairs.
    const w = derivePairWarnings([P1, null, P3, null], counts([[P1, P3, 9]], [[P1, P3, 3]]), T);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ relation: "opponent", count: 3 });
  });
});

describe("repeat-pairing — avoidability gate", () => {
  it("RP-A1: true when at least one candidate triggers nothing", () => {
    const c = counts([[P1, P4, 5]]);
    expect(hasCleanAlternative([P1, null, null, null], [P4, P5], c, T)).toBe(true);
  });

  it("RP-A2: false when EVERY alternative is also over the cap (repeat is forced)", () => {
    const c = counts([
      [P1, P4, 3],
      [P1, P5, 2],
    ]);
    expect(hasCleanAlternative([P1, null, null, null], [P4, P5], c, T)).toBe(false);
  });

  it("RP-A3: false when there are no candidates at all", () => {
    expect(hasCleanAlternative([P1, null, null, null], [], counts(), T)).toBe(false);
  });
});

describe("repeat-pairing — exclusion + disjointness", () => {
  it("RP-X1: never marks an already-selected player, even if the caller passes one", () => {
    const c2 = counts([[P1, P2, 5]], [[P1, P2, 5]]);
    const m = deriveCandidateMarkers([P1, P2], [P1, P2], c2, T);
    expect(m).toEqual([]);
  });

  it("RP-X2: marker pairs and panel pairs are disjoint at every selection size", () => {
    const all = [P1, P2, P3, P4, P5];
    const c3 = counts(
      [
        [P1, P2, 5],
        [P3, P5, 5],
        [P1, P5, 5],
        [P3, P4, 5],
      ],
      [
        [P1, P3, 5],
        [P2, P3, 5],
        [P1, P5, 5],
        [P2, P5, 5],
        [P1, P4, 5],
        [P2, P4, 5],
      ]
    );
    for (let n = 0; n <= 4; n++) {
      const ordered = all.slice(0, n);
      const candidates = all.filter((id) => !ordered.includes(id));
      const panelKeys = new Set(derivePairWarnings(ordered, c3, T).map((w) => w.pairKey));
      const markerKeys = new Set(
        deriveCandidateMarkers(ordered, candidates, c3, T).flatMap((m) =>
          m.relations.map((r) => pairKey(m.playerId, r.withPlayerId))
        )
      );
      for (const k of markerKeys) expect(panelKeys.has(k)).toBe(false);
    }
  });
});
