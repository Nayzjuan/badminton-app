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
  deriveFreshCandidates,
  eligibleCandidates,
  freshMarkersAreInformative,
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

// ============================================================
// RP-F*  FRESH chips — deriveFreshCandidates + the discrimination gate
// ============================================================
// The chip exists because the amber marker CANNOT answer this question: it
// only fires at count >= cap, so the unmarked bench silently mixes "never
// played with them" (0) and "played with them once" (1). Every test below
// that uses P4 as the once-played body is guarding exactly that gap.

const P6 = "p6";

describe("repeat-pairing — deriveFreshCandidates", () => {
  it("RP-F1: zero history with the would-be PARTNER is required (1 prior is not fresh)", () => {
    // One selected -> the next tap fills A2, so P1 is the referent as a teammate.
    const c = counts([[P1, P4, 1]]);
    // P4 has ONE prior partnership: under the cap, so no amber marker...
    expect(deriveCandidateMarkers([P1], [P4], c, T)).toEqual([]);
    // ...and that is precisely why it must not be green either.
    expect(deriveFreshCandidates([P1], [P4, P5], c)).toEqual([P5]);
  });

  it("RP-F2: zero history with EVERY would-be opponent is required", () => {
    // Two selected -> next tap fills B1, opposing both A players.
    const c = counts([], [[P2, P4, 1]]);
    expect(deriveFreshCandidates([P1, P2], [P4, P5], c)).toEqual([P5]);
  });

  it("RP-F3: BOTH MAPS count, not just the role this pick would create", () => {
    // Three selected -> next tap fills B2: teammate of P3, opponent of P1/P2.
    // P4 has never PARTNERED anyone, but has faced P1 once.
    const c = counts([], [[P1, P4, 1]]);
    expect(deriveFreshCandidates([P1, P2, P3], [P4, P5], c)).toEqual([P5]);
    // The mirror: a partnership-only history against the B2 teammate.
    expect(deriveFreshCandidates([P1, P2, P3], [P4, P5], counts([[P3, P4, 1]]))).toEqual([P5]);
    // And the case that pins the cross-role rule: P4 has PARTNERED P1 once,
    // while this pick would make them OPPONENTS. Role-specific logic would
    // call that fresh; the chip's copy ("no games with P1") would then be a
    // lie, so it must not.
    expect(deriveFreshCandidates([P1, P2, P3], [P4, P5], counts([[P1, P4, 1]]))).toEqual([P5]);
    // Mirror again: faced the would-be TEAMMATE.
    expect(deriveFreshCandidates([P1, P2, P3], [P4, P5], counts([], [[P3, P4, 1]]))).toEqual([P5]);
  });

  it("RP-F4: history with a player the next pick does NOT touch is irrelevant", () => {
    // Next tap fills A2: referent is P1 alone. Slots 2/3 are empty, so P3 is
    // not in the picture at all — a fat history with P3 must not disqualify.
    const c = counts([[P3, P4, 9]], [[P3, P4, 9]]);
    expect(deriveFreshCandidates([P1], [P4], c)).toEqual([P4]);
  });

  it("RP-F5: same guards as the markers — full selection and empty selection", () => {
    const c = counts();
    expect(deriveFreshCandidates([], [P5], c)).toEqual([]);
    expect(deriveFreshCandidates([P1, P2, P3, P4], [P5], c)).toEqual([]);
  });

  it("RP-F6: never returns an already-selected player, even if the caller passes one", () => {
    const c = counts();
    expect(deriveFreshCandidates([P1, P2], [P1, P2, P5], c)).toEqual([P5]);
  });

  it("RP-F7: post-deselect — freeing A2 re-targets freshness at the TEAMMATE", () => {
    // Slots [P1, null, P3, P4]: three selected, and the next tap is a
    // TEAMMATE of P1 rather than of P3 — but A2 also opposes the whole B side,
    // so P3 and P4 are touched too. P5 is clean against P1 and dirty against
    // P3, and the both-maps rule means dirty against ANY touched player loses
    // the chip.
    expect(deriveFreshCandidates([P1, null, P3, P4], [P5], counts([[P3, P5, 4]]))).toEqual([]);
    // Whereas history with a body in NO slot cannot disqualify: with only A1
    // filled, P3 and P4 are not in the picture at all.
    expect(deriveFreshCandidates([P1], [P5], counts([[P3, P5, 4]]))).toEqual([P5]);
    // Remove the history and the deselect case is fresh again:
    expect(deriveFreshCandidates([P1, null, P3, P4], [P5], counts())).toEqual([P5]);
  });

  it("RP-F8: fresh and marked are mutually exclusive at every selection size", () => {
    const all = [P1, P2, P3, P4, P5, P6];
    const c = counts(
      [
        [P1, P5, 3],
        [P2, P6, 1],
      ],
      [
        [P1, P6, 2],
        [P3, P5, 1],
      ]
    );
    for (let n = 1; n <= 3; n++) {
      const ordered = all.slice(0, n);
      const candidates = all.filter((id) => !ordered.includes(id));
      const marked = new Set(
        deriveCandidateMarkers(ordered, candidates, c, T).map((m) => m.playerId)
      );
      const fresh = deriveFreshCandidates(ordered, candidates, c);
      // Both sides must be non-empty at every n, or the disjointness below is
      // satisfied by a deriver that simply returned nothing.
      expect(marked.size).toBeGreaterThan(0);
      expect(fresh.length).toBeGreaterThan(0);
      for (const id of fresh) expect(marked.has(id)).toBe(false);
    }
  });

  it("RP-F9: FRESH implies no consecutive rematch — the property the chip leans on", () => {
    // The engine's consecutive-opponent term (APP_MANIFEST §3.32) can only
    // charge a pair that has met at all. Zero total meetings therefore also
    // means zero LAST-GAME meetings, whatever the match history looked like.
    // Encoded as: any candidate with a non-zero opponent count is excluded,
    // so the fresh set can never contain a just-faced pair.
    const c = counts([], [[P1, P4, 1]]);
    const fresh = deriveFreshCandidates([P1, P2], [P4, P5], c);
    // Exact, not `not.toContain`: an always-empty deriver would satisfy both
    // the exclusion and the property loop below.
    expect(fresh).toEqual([P5]);
    for (const id of fresh) {
      expect(c.opponents.get(pairKey(P1, id)) ?? 0).toBe(0);
      expect(c.opponents.get(pairKey(P2, id)) ?? 0).toBe(0);
    }
  });
});

describe("repeat-pairing — eligibleCandidates (one basis for the ratio)", () => {
  it("RP-F14: drops ids that already hold a slot, and keeps caller order", () => {
    expect(eligibleCandidates([P1, P3], [P1, P2, P3, P4])).toEqual([P2, P4]);
    expect(eligibleCandidates([], [P2, P1])).toEqual([P2, P1]);
  });

  it("RP-F15: it is the deriver's own denominator — a loose pool cannot fake a signal", () => {
    // Everyone is fresh, so the gate must stay SILENT. Measured against the
    // raw pool (which still holds the two selected players) 3 < 5 would read
    // as "discriminating" and paint the whole bench green.
    const c = counts();
    const raw = [P1, P2, P3, P4, P5];
    const pool = eligibleCandidates([P1, P2], raw);
    const fresh = deriveFreshCandidates([P1, P2], pool, c);
    expect(fresh).toEqual([P3, P4, P5]);
    expect(freshMarkersAreInformative(fresh.length, pool.length)).toBe(false);
    expect(freshMarkersAreInformative(fresh.length, raw.length)).toBe(true); // the bug it prevents
  });
});

describe("repeat-pairing — freshMarkersAreInformative (discrimination gate)", () => {
  it("RP-F10: silent when EVERY candidate is fresh — a chip on every row says nothing", () => {
    expect(freshMarkersAreInformative(5, 5)).toBe(false);
  });

  it("RP-F11: silent when NO candidate is fresh — the absence is the message", () => {
    expect(freshMarkersAreInformative(0, 5)).toBe(false);
    expect(freshMarkersAreInformative(0, 0)).toBe(false);
  });

  it("RP-F12: speaks only when the chips actually discriminate", () => {
    expect(freshMarkersAreInformative(1, 5)).toBe(true);
    expect(freshMarkersAreInformative(4, 5)).toBe(true);
  });

  it("RP-F13: the two gates are independent, not merely co-firing", () => {
    const c = counts([[P1, P5, 5]], [[P1, P5, 5]]);
    const candidates = [P5, P6];
    // Warnings would be suppressed only if NOTHING is clean; here P6 is clean,
    // so this asserts the two gates are independent, not merely co-firing.
    expect(hasCleanAlternative([P1], candidates, c, T)).toBe(true);
    const fresh = deriveFreshCandidates([P1], candidates, c);
    expect(fresh).toEqual([P6]);
    expect(freshMarkersAreInformative(fresh.length, candidates.length)).toBe(true);
  });
});
