// ============================================================
// repeat-pairing — pure derivers for the manual-match repeat warning
// ============================================================
// Deliberately its OWN module (not matchmaking-core): QueueControl is a
// "use client" component, and matchmaking-core is a ~1000-line engine module
// with ~20 engine-constant imports. This file imports only pairKey,
// isImmediateRematchPair, and the three repeat caps, so the client bundle
// stays clean and the engine stays server-side.
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
// Counts come from one session snapshot (derivePairCounts + deriveLastSides),
// spanning COMMITTED_MATCH_STATUSES (completed + in_progress + pending) — so a
// count is "times already paired this session, including a live match and an
// unpublished draft". PRIOR count: it never includes the match currently being
// built. Last-sides are session-wide so the either-rule can see bench players.
// ============================================================

import { isImmediateRematchPair, pairKey } from "@/lib/matchmaking-core";
import { MAX_OPPONENT_REPEATS, MAX_PARTNERSHIP_REPEATS, MAX_SHARED_GAMES } from "@/lib/constants";

/** Four positional slots: [A1, A2, B1, B2]. null = free. */
export type Slots = (string | null)[];

export const SLOT_COUNT = 4;
export const EMPTY_SLOTS: Slots = [null, null, null, null];

export type PairRelation = "teammate" | "opponent" | "last_game" | "shared";

export type RepeatThresholds = {
  /** Warn when a same-team pair has already played together >= this many times. */
  teammate: number;
  /** Warn when a cross-net pair has already met >= this many times. */
  opponent: number;
  /** Warn when a pair has already shared this many games, either side. */
  shared?: number;
};

/** Production thresholds — the engine's own caps, so UI and engine never drift. */
export const DEFAULT_REPEAT_THRESHOLDS: RepeatThresholds = {
  teammate: MAX_PARTNERSHIP_REPEATS,
  opponent: MAX_OPPONENT_REPEATS,
  shared: MAX_SHARED_GAMES,
};

export type PairCounts = {
  partnerships: Map<string, number>;
  opponents: Map<string, number>;
  /** Session-wide last-game opponents. Empty when the snapshot has none. */
  lastOpponents: Map<string, Set<string>>;
  /** Session-wide last-game partners. Empty when the snapshot has none. */
  lastPartners: Map<string, Set<string>>;
};

export const EMPTY_LAST_SIDES = {
  lastOpponents: new Map<string, Set<string>>(),
  lastPartners: new Map<string, Set<string>>(),
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
  /**
   * Worst count across ALL relations. A derived convenience for ranking —
   * NOT the chip's source. The chip reads `relations[0]` so its word and its
   * number come from the SAME relation; pairing this field with
   * `primaryRelation` (below) is what once rendered "TEAM 6TH" for a
   * 3rd-time teammate who had also faced someone five times.
   */
  worstCount: number;
  /**
   * `relations[0].relation` — last_game, then teammate, then shared, then opponent.
   * Same caveat as `worstCount`: read `relations[0]` when you need the word
   * and the number together.
   */
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
  if (relation === "shared") {
    return (
      (counts.partnerships.get(pairKey(a, b)) ?? 0) + (counts.opponents.get(pairKey(a, b)) ?? 0)
    );
  }
  if (relation === "last_game") return 1;
  const map = relation === "teammate" ? counts.partnerships : counts.opponents;
  return map.get(pairKey(a, b)) ?? 0;
}

/** last_game first (hard rematch), then teammate, then shared, then opponent. */
function relationRank(relation: PairRelation): number {
  switch (relation) {
    case "last_game":
      return 0;
    case "teammate":
      return 1;
    case "shared":
      return 2;
    case "opponent":
      return 3;
  }
}

function sortByRelationThenCount<T extends { relation: PairRelation; count: number }>(
  a: T,
  b: T
): number {
  const rank = relationRank(a.relation) - relationRank(b.relation);
  if (rank !== 0) return rank;
  return b.count - a.count;
}

function isLastGamePair(counts: PairCounts, a: string, b: string): boolean {
  return isImmediateRematchPair(a, b, counts.lastOpponents, counts.lastPartners);
}

function minFor(
  relation: Exclude<PairRelation, "last_game">,
  thresholds: RepeatThresholds
): number {
  if (relation === "teammate") return thresholds.teammate;
  if (relation === "shared") return thresholds.shared ?? MAX_SHARED_GAMES;
  return thresholds.opponent;
}

/**
 * Keep only last-game findings. Used when the rematch-saturation notice is
 * up: every other relation stays suppressed, last-game stays visible.
 */
export function lastGameWarningsOnly(warnings: PairWarning[]): PairWarning[] {
  return warnings.filter((w) => w.relation === "last_game");
}

/** Same filter for bench markers — drop a marker that has no last-game left. */
export function lastGameMarkersOnly(markers: CandidateMarker[]): CandidateMarker[] {
  const out: CandidateMarker[] = [];
  for (const m of markers) {
    const relations = m.relations.filter((r) => r.relation === "last_game");
    if (relations.length === 0) continue;
    out.push({
      playerId: m.playerId,
      relations,
      worstCount: Math.max(...relations.map((r) => r.count)),
      primaryRelation: relations[0].relation,
    });
  }
  return out;
}

/**
 * Every repeat pairing implied by the CURRENT slots.
 *
 * last_game first, then teammate, then shared, then opponent; within a
 * relation, descending count. The caller headlines `[0]` as the worst finding.
 */
export function derivePairWarnings(
  slots: Slots,
  counts: PairCounts,
  thresholds: RepeatThresholds = DEFAULT_REPEAT_THRESHOLDS
): PairWarning[] {
  const { teamA, teamB } = deriveTeams(slots);
  const out: PairWarning[] = [];

  const consider = (a: string, b: string, relation: PairRelation) => {
    if (relation === "last_game") {
      if (isLastGamePair(counts, a, b)) {
        out.push({ pairKey: pairKey(a, b), playerIds: [a, b], relation, count: 1 });
      }
      return;
    }
    const count = countFor(counts, relation, a, b);
    if (count >= minFor(relation, thresholds)) {
      out.push({ pairKey: pairKey(a, b), playerIds: [a, b], relation, count });
    }
  };

  if (teamA.length === 2) consider(teamA[0], teamA[1], "teammate");
  if (teamB.length === 2) consider(teamB[0], teamB[1], "teammate");
  for (const a of teamA) for (const b of teamB) consider(a, b, "opponent");

  const selected = [...teamA, ...teamB];
  const roleKeys = new Set(out.map((w) => w.pairKey));
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      consider(selected[i], selected[j], "last_game");
      // Shared is the 1+1 case the role caps miss. Skip when teammate or
      // opponent already named this pair — two rows for one fact is noise.
      if (!roleKeys.has(pairKey(selected[i], selected[j]))) {
        consider(selected[i], selected[j], "shared");
      }
    }
  }

  return out.sort(sortByRelationThenCount);
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
      if (relation === "last_game") {
        if (isLastGamePair(counts, candidate, withPlayerId)) {
          relations.push({ relation, withPlayerId, count: 1 });
        }
        return;
      }
      const count = countFor(counts, relation, candidate, withPlayerId);
      if (count >= minFor(relation, thresholds)) {
        relations.push({ relation, withPlayerId, count });
      }
    };

    if (partner) add("teammate", partner);
    for (const o of opponents) add("opponent", o);

    const touched = [...(partner ? [partner] : []), ...opponents];
    const roleWith = new Set(relations.map((r) => r.withPlayerId));
    for (const other of touched) {
      add("last_game", other);
      if (!roleWith.has(other)) add("shared", other);
    }

    if (relations.length === 0) continue;

    relations.sort(sortByRelationThenCount);
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
 * The POSITIVE inverse of deriveCandidateMarkers: who has NO shared history at
 * all with anyone the next pick touches.
 *
 * This is not "the players without an amber marker". A marker only fires at
 * `count >= cap` (2), so the unmarked bench silently mixes never-played-with
 * (0) and played-with-once (1). The organizer hand-building a match after a
 * clear cannot tell those apart, which is exactly the gap that sends them
 * scrolling through Wrapped mid-session to check.
 *
 * ZERO, not "under the cap", on purpose — it is the only threshold that needs
 * no explaining on a chip two words long, and it gives the chip a property
 * worth relying on: a player who has never faced someone cannot have faced
 * them LAST GAME either, so a FRESH pick is also free of the consecutive-
 * opponent penalty the engine now applies (APP_MANIFEST §3.32). A "1 prior"
 * tier would carry neither guarantee.
 *
 * BOTH MAPS, not just the role this pick would create. A candidate who has
 * partnered the would-be opponent four times is not "fresh" against them in
 * any sense the organizer means, and the chip's own copy — "no games with
 * Alice, Bob and Carol yet tonight" — would be a plain lie. This is the one
 * place the feature deliberately diverges from the engine's role-specific
 * caps: the amber marker mirrors the engine because it predicts what the
 * engine will refuse, while the green chip answers a human question about who
 * has shared a court. Strictness is the safe direction — it can only ever
 * withhold a chip, never over-promise on one.
 *
 * Same targeting and same exclusion contract as deriveCandidateMarkers: the
 * next tap fills the FIRST FREE SLOT, and `candidateIds` must already exclude
 * selected / locked / paused rows. Returns [] when the selection is full (no
 * next pick) or empty (no referent — "fresh against nobody" is meaningless).
 *
 * The selected-id filter below re-applies that contract defensively. Callers
 * measuring the pool for `freshMarkersAreInformative` must use
 * `eligibleCandidates` so the numerator and denominator share one basis.
 */
export function deriveFreshCandidates(
  slots: Slots,
  candidateIds: string[],
  counts: PairCounts
): string[] {
  const s = normalize(slots);
  const target = s.findIndex((x) => x === null);
  if (target === -1 || filledCount(s) === 0) return [];

  // Everyone the next pick would share a court with — the partner slot and
  // both opposing slots. Roles are not tracked past this point, by design.
  const partner = s[partnerSlotIndex(target)] ?? null;
  const touched = [
    ...(partner ? [partner] : []),
    ...opposingSlotIndices(target)
      .map((i) => s[i])
      .filter((x): x is string => !!x),
  ];

  const selectedSet = new Set(s.filter((x): x is string => !!x));

  return candidateIds.filter(
    (candidate) =>
      !selectedSet.has(candidate) &&
      touched.every(
        (other) =>
          countFor(counts, "teammate", candidate, other) === 0 &&
          countFor(counts, "opponent", candidate, other) === 0
      )
  );
}

/**
 * The rows a FRESH chip could legitimately land on — `candidateIds` minus
 * anyone already holding a slot. It exists so the fresh count and the pool it
 * is compared against are computed from ONE basis: measuring the numerator
 * post-exclusion and the denominator pre-exclusion would make an all-fresh
 * bench (correctly silent) look like a discriminating one, which is a wall of
 * green produced by the very gate meant to prevent it.
 */
export function eligibleCandidates(slots: Slots, candidateIds: string[]): string[] {
  const selectedSet = new Set(normalize(slots).filter((x): x is string => !!x));
  return candidateIds.filter((id) => !selectedSet.has(id));
}

/**
 * Whether the FRESH chips are worth rendering at all.
 *
 * Render only when the chips DISCRIMINATE — some eligible candidate is fresh
 * and some is not. The two silent ends are the ones that carry no information
 * at all: a chip on EVERY row says nothing (the first half of a session, when
 * nobody has played anybody), and zero fresh players has nothing to point at.
 *
 * Deliberately an all-or-nothing test, NOT a ratio floor. 12 of 15 rows green
 * is lopsided but still says something true about the other 3, and any floor
 * would be a number invented here with no evidence behind it — while the two
 * degenerate ends are provably information-free. The lopsided case also
 * self-corrects: the touched set grows from 1 referent to 3 by the fourth
 * pick, and each one can only remove players from the fresh set.
 *
 * Note this is deliberately NOT the avoidability gate that governs the amber
 * warnings. That gate suppresses a warning the organizer could not have
 * avoided; a FRESH chip is most useful precisely when options are scarce,
 * including while the engine's own cap-saturation notice is up telling them to
 * override by hand.
 */
export function freshMarkersAreInformative(freshCount: number, candidateCount: number): boolean {
  return freshCount > 0 && freshCount < candidateCount;
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
