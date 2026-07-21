// ============================================================
// repeat-pairing — pure derivers for the manual-match repeat warning
// ============================================================
// Deliberately its OWN module (not matchmaking-core): QueueControl is a
// "use client" component, and matchmaking-core is a ~1000-line engine module
// with ~20 engine-constant imports. This file imports only pairKey + the two
// repeat caps, so the client bundle stays clean and the engine stays server-side.
//
// SLOT MODEL — the selection is FOUR POSITIONAL SLOTS, not an insertion-ordered
// list: [A1, A2, B1, B2]. Deselecting frees that slot and leaves the other three
// in place; the next tap fills the first free slot. This is what makes the team
// preview trustworthy — with an insertion-ordered Set, deselecting pick #2 used
// to silently promote a Team-B player into Team A and rewrite the warnings.
//
// Thresholds are INJECTED (testability) but production call sites pass
// DEFAULT_REPEAT_THRESHOLDS, wired to the engine's own caps
// (MAX_PARTNERSHIP_REPEATS / MAX_OPPONENT_REPEATS). One source of truth matters:
// the engine soft-refuses a pairing at >= cap, so a warning threshold ABOVE the
// cap would stay silent on exactly the pairings the engine already rejects.
//
// Counts come from fetchPartnershipCounts, spanning COMMITTED_MATCH_STATUSES
// (completed + in_progress + pending) — so a count is "times already paired this
// session, including a live match and an unpublished draft". PRIOR count: it
// never includes the match currently being built.
// ============================================================

import { pairKey } from "@/lib/matchmaking-core";
import { MAX_PARTNERSHIP_REPEATS, MAX_OPPONENT_REPEATS } from "@/lib/constants";

/** Four positional slots: [A1, A2, B1, B2]. null = free. */
export type Slots = (string | null)[];

export const SLOT_COUNT = 4;
export const EMPTY_SLOTS: Slots = [null, null, null, null];

export type PairRelation = "teammate" | "opponent";

export type RepeatThresholds = {
  /** Warn when a same-team pair has already played together >= this many times. */
  teammate: number;
  /** Warn when a cross-net pair has already met >= this many times. */
  opponent: number;
};

/** Production thresholds — the engine's own caps, so UI and engine never drift. */
export const DEFAULT_REPEAT_THRESHOLDS: RepeatThresholds = {
  teammate: MAX_PARTNERSHIP_REPEATS,
  opponent: MAX_OPPONENT_REPEATS,
};

export type PairCounts = {
  partnerships: Map<string, number>;
  opponents: Map<string, number>;
};

export type PairWarning = {
  pairKey: string;
  playerIds: [string, string];
  relation: PairRelation;
  /** Times already paired this session (PRIOR — excludes the match being built). */
  count: number;
};

export type MarkerRelation = {
  relation: PairRelation;
  /** The already-selected player this candidate would repeat with. */
  withPlayerId: string;
  count: number;
};

export type CandidateMarker = {
  playerId: string;
  /** EVERY triggered relationship — filling a B slot can hit three at once. */
  relations: MarkerRelation[];
  /** Worst count across relations — drives single-glyph severity. */
  worstCount: number;
  /** teammate outranks opponent when choosing one glyph. */
  primaryRelation: PairRelation;
};

/** Slot index of a slot's same-team partner: 0<->1, 2<->3. */
export function partnerSlotIndex(i: number): number {
  return i < 2 ? 1 - i : 5 - i;
}

/** Slot indices on the opposite side of the net. */
export function opposingSlotIndices(i: number): number[] {
  return i < 2 ? [2, 3] : [0, 1];
}

/**
 * Pad/truncate to exactly SLOT_COUNT so callers may pass a short dense array
 * (e.g. `[p1, p2]`) or a sparse 4-slot array interchangeably. Without this,
 * `findIndex` on a length-2 array never visits slots 2-3 and reports "full".
 */
function normalize(slots: Slots): Slots {
  const out: Slots = [null, null, null, null];
  for (let i = 0; i < SLOT_COUNT; i++) out[i] = slots[i] ?? null;
  return out;
}

export function deriveTeams(slots: Slots): { teamA: string[]; teamB: string[] } {
  const s = normalize(slots);
  const keep = (xs: (string | null)[]) => xs.filter((x): x is string => !!x);
  return { teamA: keep([s[0], s[1]]), teamB: keep([s[2], s[3]]) };
}

export function filledCount(slots: Slots): number {
  return normalize(slots).filter(Boolean).length;
}

function countFor(counts: PairCounts, relation: PairRelation, a: string, b: string): number {
  const map = relation === "teammate" ? counts.partnerships : counts.opponents;
  return map.get(pairKey(a, b)) ?? 0;
}

/**
 * Every repeat pairing implied by the CURRENT slots.
 *
 * Teammates are listed first, then by descending count, so the caller can
 * headline `[0]` as the worst finding.
 */
export function derivePairWarnings(
  slots: Slots,
  counts: PairCounts,
  thresholds: RepeatThresholds = DEFAULT_REPEAT_THRESHOLDS
): PairWarning[] {
  const { teamA, teamB } = deriveTeams(slots);
  const out: PairWarning[] = [];

  const consider = (a: string, b: string, relation: PairRelation) => {
    const count = countFor(counts, relation, a, b);
    const min = relation === "teammate" ? thresholds.teammate : thresholds.opponent;
    if (count >= min) out.push({ pairKey: pairKey(a, b), playerIds: [a, b], relation, count });
  };

  if (teamA.length === 2) consider(teamA[0], teamA[1], "teammate");
  if (teamB.length === 2) consider(teamB[0], teamB[1], "teammate");
  for (const a of teamA) for (const b of teamB) consider(a, b, "opponent");

  return out.sort((x, y) => {
    if (x.relation !== y.relation) return x.relation === "teammate" ? -1 : 1;
    return y.count - x.count;
  });
}

/**
 * Which still-selectable players would create a repeat IF TAPPED NEXT.
 *
 * The next tap fills the FIRST FREE SLOT, so that slot determines the roles:
 * its same-team partner (if occupied) is a teammate relation, and every
 * occupied slot across the net is an opponent relation. Slot-awareness matters
 * after a deselect — freeing A2 means the next tap is a TEAMMATE of A1, even
 * though three players are already selected.
 *
 * `candidateIds` MUST already exclude selected / locked (on_deck, drafted) /
 * paused rows. With that exclusion the two surfaces are disjoint: the panel
 * covers selected x selected, markers cover selected x unselected.
 */
export function deriveCandidateMarkers(
  slots: Slots,
  candidateIds: string[],
  counts: PairCounts,
  thresholds: RepeatThresholds = DEFAULT_REPEAT_THRESHOLDS
): CandidateMarker[] {
  const s = normalize(slots);
  const target = s.findIndex((x) => x === null);
  // No free slot (selection full) or nothing selected yet (no context) -> no markers.
  if (target === -1 || filledCount(s) === 0) return [];

  const partner = s[partnerSlotIndex(target)] ?? null;
  const opponents = opposingSlotIndices(target)
    .map((i) => s[i])
    .filter((x): x is string => !!x);

  const selectedSet = new Set(s.filter((x): x is string => !!x));
  const out: CandidateMarker[] = [];

  for (const candidate of candidateIds) {
    // Defensive: never mark an already-selected player even if a caller slips.
    if (selectedSet.has(candidate)) continue;

    const relations: MarkerRelation[] = [];
    const add = (relation: PairRelation, withPlayerId: string) => {
      const count = countFor(counts, relation, candidate, withPlayerId);
      const min = relation === "teammate" ? thresholds.teammate : thresholds.opponent;
      if (count >= min) relations.push({ relation, withPlayerId, count });
    };

    if (partner) add("teammate", partner);
    for (const o of opponents) add("opponent", o);

    if (relations.length === 0) continue;

    relations.sort((x, y) => {
      if (x.relation !== y.relation) return x.relation === "teammate" ? -1 : 1;
      return y.count - x.count;
    });
    out.push({
      playerId: candidate,
      relations,
      worstCount: Math.max(...relations.map((r) => r.count)),
      primaryRelation: relations[0].relation,
    });
  }

  return out;
}

/**
 * Avoidability gate. A warning is only worth showing if the organizer could
 * plausibly have done better: if EVERY selectable alternative for that slot is
 * also over the cap, the repeat is forced and the warning is noise.
 *
 * This matters because the app itself directs organizers here — the cap-
 * saturation banner says "all partner combinations have reached the cap.
 * Consider a manual override" — so an ungated warning fires hardest exactly
 * when the organizer has no choice (and on small rosters, on nearly every match).
 *
 * Returns true when at least one candidate would NOT trigger any repeat.
 */
export function hasCleanAlternative(
  slots: Slots,
  candidateIds: string[],
  counts: PairCounts,
  thresholds: RepeatThresholds = DEFAULT_REPEAT_THRESHOLDS
): boolean {
  if (candidateIds.length === 0) return false;
  const flagged = new Set(
    deriveCandidateMarkers(slots, candidateIds, counts, thresholds).map((m) => m.playerId)
  );
  return candidateIds.some((id) => !flagged.has(id));
}
