// ============================================================
// Unit Tests: partitionCancelRestore — where a cancelled roster goes
// ============================================================
// Distinct id prefix CC-CAN-* (integration owns CC-CAN-HELD-*, in
// tests/integration/cross-court-realdb.test.ts).
//
// The two arms that matter here are the ones a real database cannot show you:
// the precedence between "still playing" and "reserved by a held draft", and
// the partition invariant. Everything else is pinned against real rows.
// ============================================================

import { describe, it, expect } from "vitest";
import { partitionCancelRestore } from "@/lib/cancel-restore";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

const NONE = new Set<string>();

describe("partitionCancelRestore", () => {
  it("CC-CAN-01: an empty roster yields three empty arrays", () => {
    expect(
      partitionCancelRestore({ rosterIds: [], playingElsewhere: NONE, reservedAsHeld: NONE })
    ).toEqual({ waitingIds: [], draftedIds: [], skippedIds: [] });
  });

  it("CC-CAN-02: no holds and nobody playing → everyone waiting (the pre-existing behaviour)", () => {
    // This is the ordinary cancel, and it is the majority case. For THIS input
    // shape — no roster member on a live court, none named by a held draft — the
    // partition must stay equivalent to the old single bulk update to 'waiting'.
    // If it ever stops being, the change has escaped the two cross-court
    // exceptions it was supposed to be confined to.
    const result = partitionCancelRestore({
      rosterIds: [A, B, C, D],
      playingElsewhere: NONE,
      reservedAsHeld: NONE,
    });
    expect(result.waitingIds).toEqual([A, B, C, D]);
    expect(result.draftedIds).toEqual([]);
    expect(result.skippedIds).toEqual([]);
  });

  it("CC-CAN-03: a member reserved by a pending held draft is re-reserved 'drafted', the rest waiting", () => {
    const result = partitionCancelRestore({
      rosterIds: [A, B, C, D],
      playingElsewhere: NONE,
      reservedAsHeld: new Set([B]),
    });
    expect(result.draftedIds).toEqual([B]);
    expect(result.waitingIds).toEqual([A, C, D]);
    expect(result.skippedIds).toEqual([]);
  });

  it("CC-CAN-04: a member physically on another court is skipped — no status is written for them", () => {
    const result = partitionCancelRestore({
      rosterIds: [A, B, C, D],
      playingElsewhere: new Set([D]),
      reservedAsHeld: NONE,
    });
    expect(result.skippedIds).toEqual([D]);
    expect(result.waitingIds).toEqual([A, B, C]);
    expect(result.draftedIds).toEqual([]);
  });

  // The arm no integration fixture can reach.
  it("CC-CAN-05: PRECEDENCE — a member who is BOTH playing and held-reserved is skipped, never drafted", () => {
    // Unreachable against real rows only as a CONJUNCTION of two guards living
    // in two different migrations:
    //
    //   - create_match_with_players Guard 2 (20260507000000) refuses to seat a
    //     player who already holds a pending/in_progress match — that covers the
    //     ordinary roster member.
    //   - create_held_cross_court_match Guard 1b (20260607000000) refuses to pull
    //     a body that is already the pulled body of another pending held draft.
    //     THIS is the one doing the work here: that same RPC's Guard 2 explicitly
    //     EXEMPTS the pulled body from the two-matches check ("it IS in its
    //     in_progress match"), so create_match_with_players alone does not
    //     prevent this overlap — 1b does.
    //
    // Both are guards in other files, not constraints. This test is what pins the
    // ordering if either one moves, and it is the arm a later "simplify the
    // branches" refactor would invert.
    //
    // Skipping is correct and drafting is not: rule 2 exists to reserve a body
    // that has just been FREED. Writing 'drafted' onto one who is still mid-game
    // is the same unseating defect as writing 'waiting' — their queue row would
    // contradict where they physically are, which is precisely the invariant
    // migration 20260812000000 restored for clear_on_deck_match_atomic.
    const result = partitionCancelRestore({
      rosterIds: [A, B],
      playingElsewhere: new Set([B]),
      reservedAsHeld: new Set([B]),
    });
    expect(result.skippedIds).toEqual([B]);
    expect(result.draftedIds).toEqual([]);
    expect(result.waitingIds).toEqual([A]);
  });

  it("CC-CAN-06: the three arrays partition the roster — total coverage, no overlap", () => {
    const rosterIds = [A, B, C, D];
    const { waitingIds, draftedIds, skippedIds } = partitionCancelRestore({
      rosterIds,
      playingElsewhere: new Set([D]),
      reservedAsHeld: new Set([B, D]),
    });

    const all = [...waitingIds, ...draftedIds, ...skippedIds];
    // Every roster member lands in exactly one array...
    expect(all).toHaveLength(rosterIds.length);
    expect(new Set(all)).toEqual(new Set(rosterIds));
    // ...which is what makes "not written" and "written waiting" distinguishable.
    // A member who fell out of all three would silently keep their pre-cancel
    // status ('playing' / 'on_deck') with nothing on screen to say so.
    expect(new Set(all).size).toBe(all.length);
  });

  it("CC-CAN-07: duplicate roster ids collapse to one entry", () => {
    // match_players has no unique (match_id, player_id) constraint, and a
    // duplicate would otherwise appear twice in the same .in() list — harmless
    // for the UPDATE, but it breaks the partition assertion above, which is the
    // property the rest of this suite leans on.
    const result = partitionCancelRestore({
      rosterIds: [A, A, B, B, B],
      playingElsewhere: NONE,
      reservedAsHeld: new Set([B]),
    });
    expect(result.waitingIds).toEqual([A]);
    expect(result.draftedIds).toEqual([B]);
    expect(result.skippedIds).toEqual([]);
  });
});
