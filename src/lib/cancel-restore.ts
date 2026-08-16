// ============================================================
// cancel-restore.ts — where a cancelled match's roster goes
// ============================================================
// `cancelMatchAction` used to flip every non-left roster member to 'waiting'
// in one bulk UPDATE. That is right for three of the four cases and wrong for
// the two the cross-court reach introduced, so the destination is now a
// partition rather than a constant. This module is the rule; the action is the
// IO around it.
//
// Extracted pure so the PRECEDENCE can be tested with no database. That matters
// because the arm where a player is BOTH still playing and named by a held
// draft is unreachable against real rows — see the note on that rule below — so
// a unit test is the only place it can be pinned, and it is exactly the arm a
// later refactor would quietly invert.
// ============================================================

export type CancelRestoreInput = {
  /** Every player_id on the cancelled match's roster (duplicates tolerated). */
  rosterIds: string[];
  /**
   * Roster members who physically hold an `in_progress` match in this session.
   * Evaluated AFTER the cancel CAS, so the cancelled match itself can never
   * contribute here — anyone in this set is mid-game on a DIFFERENT court.
   */
  playingElsewhere: ReadonlySet<string>;
  /**
   * Roster members named in the `pulled_player_ids` of a still-`pending` held
   * draft. Same post-CAS reasoning: a held draft can never reserve its own body,
   * because the match being cancelled is no longer `pending`.
   */
  reservedAsHeld: ReadonlySet<string>;
};

export type CancelRestorePartition = {
  /** → queue_entries.status = 'waiting'. The ordinary case. */
  waitingIds: string[];
  /** → queue_entries.status = 'drafted'. Mirrors endMatchInternal's R3-1. */
  draftedIds: string[];
  /** Not written at all — their queue row already tells the truth ('playing'). */
  skippedIds: string[];
};

/**
 * Ordered rule, first match wins:
 *
 *   1. playingElsewhere → write NOTHING. Writing any status onto a player who is
 *      physically mid-game is the unseating defect migration 20260812000000
 *      removed from `clear_on_deck_match_atomic`; this action never went through
 *      that RPC, so it needs the rule spelled here.
 *   2. reservedAsHeld   → 'drafted'. The held draft survives its source being
 *      cancelled (`recomputeHeldReadiness` counts 'cancelled' as freed), so the
 *      seat it is holding has to survive too.
 *   3. otherwise        → 'waiting'. Identical to the previous behaviour for any
 *      roster with no member on a live court — i.e. every non-cross-court cancel.
 *
 * Rule 1 STRICTLY outranks rule 2: a player who is somehow both is skipped, never
 * drafted. Rule 2 exists to reserve a body that has just been FREED — applying it
 * to one who is still on court would be the same unseating defect wearing the
 * reservation's clothes.
 *
 * That overlap should not occur against real rows, but the guarantee is a
 * CONJUNCTION of two separate guards, in two separate migrations, neither of
 * which mentions the other:
 *
 *   - `create_match_with_players` Guard 2 (20260507000000) — a player cannot be
 *     on two pending/in_progress matches, which keeps an ORDINARY roster member
 *     off a second live court.
 *   - `create_held_cross_court_match` Guard 1b (20260607000000) — the pulled body
 *     is not already the pulled body of another pending held draft. This is the
 *     load-bearing one here: that RPC's own Guard 2 deliberately EXEMPTS the
 *     pulled body from the two-matches check ("it IS in its in_progress match"),
 *     so Guard 2 alone permits exactly the overlap this precedence resolves.
 *
 * Lose either guard and the arm goes live. Do not "simplify" the precedence away
 * on the strength of one of them.
 */
export function partitionCancelRestore(input: CancelRestoreInput): CancelRestorePartition {
  const waitingIds: string[] = [];
  const draftedIds: string[] = [];
  const skippedIds: string[] = [];

  // De-duplicate defensively: match_players has no unique constraint on
  // (match_id, player_id), and a duplicated id would otherwise appear in the
  // same output array twice and break the partition invariant the tests assert.
  for (const id of new Set(input.rosterIds)) {
    if (input.playingElsewhere.has(id)) skippedIds.push(id);
    else if (input.reservedAsHeld.has(id)) draftedIds.push(id);
    else waitingIds.push(id);
  }

  return { waitingIds, draftedIds, skippedIds };
}
