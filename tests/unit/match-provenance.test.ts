// ============================================================
// Unit Tests: Match provenance & modification audit (pure logic)
// ============================================================
// Covers the DERIVATION rules only (classification, backfill mapper,
// modification delta spec, movement shapes). The AUTHORITATIVE counter
// lives in PL/pgSQL — these assert the contract the RPCs must mirror;
// the integration checklist verifies parity (plan §14 H7).
//
// Id prefixes: MP-CLS (classify), MP-BF (backfill), MP-CNT (count spec),
// MP-MOV (movements / fix-record discriminator).
// ============================================================

import { describe, it, expect } from "vitest";
import {
  deriveFinalClassification,
  isModified,
  backfillProvenance,
  modificationDelta,
  applyModification,
  countsAsModification,
  fixRecordEventType,
  rosterSwapMovement,
  teamFlipMovements,
  isRosterSwapMovement,
  type MatchCreatedMethod,
  type MatchEventType,
} from "@/lib/match-provenance";

describe("MP-CLS · deriveFinalClassification", () => {
  it("MP-CLS-01 maps all six (method × modified?) combinations", () => {
    expect(deriveFinalClassification("auto", 0)).toBe("auto_clean");
    expect(deriveFinalClassification("auto", 1)).toBe("auto_modified");
    expect(deriveFinalClassification("manual", 0)).toBe("manual_clean");
    expect(deriveFinalClassification("manual", 1)).toBe("manual_modified");
    expect(deriveFinalClassification("held", 0)).toBe("held_clean");
    expect(deriveFinalClassification("held", 1)).toBe("held_modified");
  });

  it("MP-CLS-02 treats any count > 0 as modified (not just 1)", () => {
    expect(deriveFinalClassification("auto", 3)).toBe("auto_modified");
    expect(deriveFinalClassification("manual", 7)).toBe("manual_modified");
  });

  it("MP-CLS-03 isModified mirrors the suffix decision", () => {
    expect(isModified(0)).toBe(false);
    expect(isModified(1)).toBe(true);
    expect(isModified(5)).toBe(true);
  });
});

describe("MP-BF · backfillProvenance (legacy origin/is_held → created_method/count)", () => {
  it("MP-BF-01 origin=auto, not held → auto_clean", () => {
    expect(backfillProvenance("auto", false)).toEqual({
      createdMethod: "auto",
      modificationCount: 0,
    });
  });

  it("MP-BF-02 origin=manual → manual_clean (manual_modified is unrecoverable)", () => {
    expect(backfillProvenance("manual", false)).toEqual({
      createdMethod: "manual",
      modificationCount: 0,
    });
  });

  it("MP-BF-03 origin=modified ⇒ born auto (sticky rule), count floored to 1", () => {
    expect(backfillProvenance("modified", false)).toEqual({
      createdMethod: "auto",
      modificationCount: 1,
    });
  });

  it("MP-BF-04 is_held wins over origin → held, regardless of auto/modified", () => {
    expect(backfillProvenance("auto", true)).toEqual({
      createdMethod: "held",
      modificationCount: 0,
    });
    expect(backfillProvenance("modified", true)).toEqual({
      createdMethod: "held",
      modificationCount: 1,
    });
  });

  it("MP-BF-05 round-trips through deriveFinalClassification correctly", () => {
    const cases: Array<["auto" | "manual" | "modified", boolean, string]> = [
      ["auto", false, "auto_clean"],
      ["manual", false, "manual_clean"],
      ["modified", false, "auto_modified"],
      ["auto", true, "held_clean"],
      ["modified", true, "held_modified"],
    ];
    for (const [origin, isHeld, expected] of cases) {
      const { createdMethod, modificationCount } = backfillProvenance(origin, isHeld);
      expect(deriveFinalClassification(createdMethod, modificationCount)).toBe(expected);
    }
  });
});

describe("MP-CNT · modification delta spec (mirrored by the RPCs)", () => {
  it("MP-CNT-01 composition events count +1", () => {
    const composition: MatchEventType[] = [
      "roster_swap",
      "team_flip",
      "ondeck_pull",
      "player_left",
    ];
    for (const t of composition) expect(modificationDelta(t)).toBe(1);
  });

  it("MP-CNT-02 undo is −1", () => {
    expect(modificationDelta("undo")).toBe(-1);
  });

  it("MP-CNT-03 lifecycle / result events never count", () => {
    const noncount: MatchEventType[] = [
      "created",
      "published",
      "cancelled",
      "score_edit",
      "revert",
    ];
    for (const t of noncount) expect(modificationDelta(t)).toBe(0);
  });

  it("MP-CNT-04 countsAsModification agrees with the +1 set", () => {
    expect(countsAsModification("roster_swap")).toBe(true);
    expect(countsAsModification("undo")).toBe(false); // it reverses, doesn't add
    expect(countsAsModification("score_edit")).toBe(false);
  });

  it("MP-CNT-05 applyModification floors at 0 (undo never goes negative)", () => {
    expect(applyModification(0, "undo")).toBe(0);
    expect(applyModification(0, "roster_swap")).toBe(1);
  });

  it("MP-CNT-06 the user's partial-undo scenario: swap, swap, undo → 1 (still modified)", () => {
    // born auto (count 0) → swap A (+1) → swap B (+1) → undo B (−1) = 1
    let count = 0;
    count = applyModification(count, "roster_swap"); // swap A
    count = applyModification(count, "roster_swap"); // swap B
    count = applyModification(count, "undo"); // undo B only (single-level)
    expect(count).toBe(1);
    expect(deriveFinalClassification("auto", count)).toBe("auto_modified");
  });

  it("MP-CNT-07 single swap fully undone → 0 (clean again)", () => {
    let count = 0;
    count = applyModification(count, "roster_swap");
    count = applyModification(count, "undo");
    expect(count).toBe(0);
    expect(deriveFinalClassification("auto", count)).toBe("auto_clean");
  });

  it("MP-CNT-08 cross-match pull is two +1 legs (each on its own match)", () => {
    // active match leg and on-deck match leg are independent rows, each +1.
    expect(applyModification(0, "ondeck_pull")).toBe(1); // active match
    expect(applyModification(0, "ondeck_pull")).toBe(1); // on-deck match (separate row/match)
  });
});

describe("MP-MOV · movement builders + fix-record discriminator", () => {
  it("MP-MOV-01 rosterSwapMovement builds the canonical single-move shape", () => {
    expect(
      rosterSwapMovement({
        outPlayerId: "p1",
        outPlayerName: "Carlo",
        inPlayerId: "p2",
        inPlayerName: "Stelle",
        team: "a",
      })
    ).toEqual([
      {
        out_player_id: "p1",
        out_player_name: "Carlo",
        in_player_id: "p2",
        in_player_name: "Stelle",
        team: "a",
      },
    ]);
  });

  it("MP-MOV-02 teamFlipMovements records both players crossing sides", () => {
    const out = teamFlipMovements(
      { playerId: "g", playerName: "Glenn", team: "b" },
      { playerId: "j", playerName: "JV", team: "a" }
    );
    expect(out).toEqual([
      { player_id: "g", player_name: "Glenn", from_team: "b", to_team: "a" },
      { player_id: "j", player_name: "JV", from_team: "a", to_team: "b" },
    ]);
  });

  it("MP-MOV-03 fixRecordEventType: non-null in-team → team_flip, null → roster_swap", () => {
    expect(fixRecordEventType("a")).toBe("team_flip");
    expect(fixRecordEventType("b")).toBe("team_flip");
    expect(fixRecordEventType(null)).toBe("roster_swap");
  });

  it("MP-MOV-04 isRosterSwapMovement type guard distinguishes the two shapes", () => {
    const swap = rosterSwapMovement({
      outPlayerId: "p1",
      outPlayerName: "A",
      inPlayerId: "p2",
      inPlayerName: "B",
      team: "a",
    })[0];
    const flip = teamFlipMovements(
      { playerId: "x", playerName: "X", team: "a" },
      { playerId: "y", playerName: "Y", team: "b" }
    )[0];
    expect(isRosterSwapMovement(swap)).toBe(true);
    expect(isRosterSwapMovement(flip)).toBe(false);
  });
});

describe("MP-CLS · exhaustive method coverage guard", () => {
  it("MP-CLS-04 every created_method yields a clean + modified label", () => {
    const methods: MatchCreatedMethod[] = ["auto", "manual", "held"];
    for (const m of methods) {
      expect(deriveFinalClassification(m, 0)).toBe(`${m}_clean`);
      expect(deriveFinalClassification(m, 2)).toBe(`${m}_modified`);
    }
  });
});
