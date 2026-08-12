"use client";

// ============================================================
// useRepeatPairing — the repeat-warning state machine for one build
// ============================================================
// Turns (slots + bench + session counts) into the three surfaces the
// organizer sees: the sticky headline, the per-pair detail rows, and the
// per-row candidate markers. Pure derivation lives in
// `src/lib/repeat-pairing.ts`; everything episodic/temporal lives here.
//
// Three behaviours that only make sense as STATE, not derivation:
//
// 1. EPISODE SNAPSHOT. The counts are frozen the moment the selection goes
//    0 → 1 and held until it clears. The engine keeps drafting while the
//    organizer builds a match by hand; without the freeze a background
//    draft would re-rank the warnings — and resize the sticky region —
//    under their fingers mid-tap.
//
// 2. STABLE HEADLINE. The first pair that trips in an episode stays the
//    headline for that episode. Re-ranking on every tap rewrites the top
//    line two or three times during a single 4-tap build, which reads as
//    flicker rather than information.
//
// 3. USER-GATED ANNOUNCEMENT. The sr-only live region is written on a
//    500 ms trailing debounce and ONLY in response to a selection change
//    (tracked via `selectionEpoch`). A counts refetch must never speak.
//
// AVOIDABILITY GATE. Everything is suppressed unless `hasCleanAlternative`
// says the organizer could plausibly have done better — and entirely while
// the engine's own cap-saturation notice is up, since that notice tells
// them to override manually. An ungated warning fires hardest exactly when
// there is no choice (and, on an 8-player night, on nearly every match).
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_REPEAT_THRESHOLDS,
  deriveCandidateMarkers,
  deriveFreshCandidates,
  derivePairWarnings,
  eligibleCandidates,
  filledCount,
  freshMarkersAreInformative,
  hasCleanAlternative,
  opposingSlotIndices,
  partnerSlotIndex,
  SLOT_COUNT,
  type CandidateMarker,
  type PairCounts,
  type PairWarning,
  type Slots,
} from "@/lib/repeat-pairing";
import { announcementFor, type LegendFamilies, type NameLookup } from "@/lib/repeat-pairing-copy";

/** Trailing debounce before the live region is written. */
export const ANNOUNCE_DEBOUNCE_MS = 500;

/** Which slot the next tap fills — resolves the referent for the markers. */
export type MarkerContext = {
  team: "A" | "B";
  /** Already-selected same-team player for that slot, if any. */
  partnerId: string | null;
  /** Already-selected players across the net from that slot. */
  opponentIds: string[];
};

export type RepeatPairingState = {
  /** Repeat pairings implied by the current slots. Already gated. */
  warnings: PairWarning[];
  /** playerId → marker for the still-selectable bench. Already gated. */
  markers: Map<string, CandidateMarker>;
  /**
   * Bench players with ZERO shared history against the next pick's referents.
   * Already gated — and by a DIFFERENT gate than `markers`, so the two are
   * independently empty. Never overlaps `markers`: a marker needs count >= 2.
   */
  fresh: ReadonlySet<string>;
  /** Stable headline for this build episode (never re-ranked mid-build). */
  headline: PairWarning | null;
  /** Debounced screen-reader string. "" means "say nothing". */
  announcement: string;
  /** Referent for the chips; null when NEITHER family has anything to show. */
  markerContext: MarkerContext | null;
  /** Which chip families are live — the legend has to describe both. */
  legendFamilies: LegendFamilies;
  /**
   * Pairs that started repeating on the MOST RECENT user tap — the ones worth
   * a one-shot flash. Scoped to a single build episode and never re-issued for
   * a pair already shown in it.
   */
  pulsedPairKeys: ReadonlySet<string>;
};

const NO_MARKERS: Map<string, CandidateMarker> = new Map();
const NO_WARNINGS: PairWarning[] = [];
const NO_PULSE: ReadonlySet<string> = new Set();
const NO_FRESH: ReadonlySet<string> = new Set();

type Episode = { active: boolean; counts: PairCounts | null };

/** `key` identifies the trigger that produced `fresh`; `shown` is episode memory. */
type PulseState = {
  key: string;
  shown: ReadonlySet<string>;
  fresh: ReadonlySet<string>;
};

export function useRepeatPairing(params: {
  slots: Slots;
  /** Selectable bench: NOT selected, NOT paused, NOT on_deck/drafted. */
  candidateIds: string[];
  /** Live counts from usePairCounts; null until first load. */
  liveCounts: PairCounts | null;
  /** Bumped by the caller on every USER-INITIATED selection change. */
  selectionEpoch: number;
  /** True while the engine's cap-saturation notice is up. */
  suppressed: boolean;
  nameOf: NameLookup;
}): RepeatPairingState {
  const { slots, candidateIds, liveCounts, selectionEpoch, suppressed, nameOf } = params;

  const filled = filledCount(slots);
  const buildActive = filled > 0;

  // ── 1. Episode snapshot ──────────────────────────────────────
  // Adjust-state-during-render (same idiom as MatchAlertPresence): it
  // converges in one extra pass, reads only state, and is StrictMode-safe.
  const [episode, setEpisode] = useState<Episode>({ active: false, counts: null });
  let currentEpisode = episode;
  if (buildActive !== episode.active) {
    currentEpisode = buildActive
      ? { active: true, counts: liveCounts }
      : { active: false, counts: null };
    setEpisode(currentEpisode);
  } else if (buildActive && episode.counts === null && liveCounts !== null) {
    // The build started before the first counts load landed — adopt it once.
    currentEpisode = { active: true, counts: liveCounts };
    setEpisode(currentEpisode);
  }
  const counts = currentEpisode.counts;
  /** Flips false→true the once, when this episode adopts loaded counts. */
  const countsAdopted = counts !== null;

  // ── 2. Derivation + avoidability gate ────────────────────────
  const gateOpen = useMemo(() => {
    if (!counts || suppressed) return false;
    if (filled < SLOT_COUNT) {
      return hasCleanAlternative(slots, candidateIds, counts, DEFAULT_REPEAT_THRESHOLDS);
    }
    // FULL SELECTION. There is no "next pick", so deriveCandidateMarkers
    // returns [] and hasCleanAlternative would degenerate to "is the bench
    // non-empty" — which SUPPRESSES the warning at the exact moment the CTA
    // goes live, on any night where the selectable pool is exactly 4. A
    // headline that appears at 2 picks and vanishes at 4 is worse than either
    // extreme.
    //
    // Ask the meaningful question instead, for EVERY slot: freeing slot i
    // makes it the first free slot (all lower slots are occupied), so this
    // reconstitutes exactly the 3-pick question for that position. Each
    // occupant is returned to the pool, so a roster that was forced in every
    // position still stays quiet. Probing only the LAST slot would be
    // asymmetric — the slot model supports deselect-then-refill and
    // moveAcrossNet, so the 4th tap does not always land in slot 3, and a
    // warning about slots 0&1 would have been gated on slot 3's alternatives.
    return Array.from({ length: SLOT_COUNT }).some((_, i) => {
      const probe: Slots = [...slots];
      const occupant = probe[i];
      probe[i] = null;
      const pool = occupant ? [...candidateIds, occupant] : candidateIds;
      return hasCleanAlternative(probe, pool, counts, DEFAULT_REPEAT_THRESHOLDS);
    });
  }, [counts, suppressed, slots, candidateIds, filled]);

  const warnings = useMemo(() => {
    if (!gateOpen || !counts) return NO_WARNINGS;
    return derivePairWarnings(slots, counts, DEFAULT_REPEAT_THRESHOLDS);
  }, [gateOpen, counts, slots]);

  const markers = useMemo(() => {
    if (!gateOpen || !counts) return NO_MARKERS;
    const list = deriveCandidateMarkers(slots, candidateIds, counts, DEFAULT_REPEAT_THRESHOLDS);
    if (list.length === 0) return NO_MARKERS;
    return new Map(list.map((m) => [m.playerId, m]));
  }, [gateOpen, counts, slots, candidateIds]);

  // FRESH chips ride the episode snapshot (same freeze, same reason: a
  // background draft must not re-paint the bench mid-tap) but NOT `gateOpen`.
  // Both of that gate's inputs are wrong for this family:
  //
  //   * `hasCleanAlternative` asks "could the organizer have avoided a
  //     repeat" — the question a warning has to justify itself against. A
  //     FRESH chip is the answer, not the accusation.
  //   * `suppressed` is the engine's cap-saturation notice, which literally
  //     tells the organizer to override by hand. Hiding the only positive
  //     signal at that exact moment inverts the feature's purpose.
  //
  // What replaces it is the discrimination gate, which self-suppresses in
  // both directions anyway: nobody fresh (late, saturated) and everybody
  // fresh (early, empty history) both render nothing.
  const fresh = useMemo(() => {
    if (!counts) return NO_FRESH;
    // One basis for both halves of the ratio. `candidateIds` already excludes
    // selected rows in production, but measuring the fresh count after that
    // exclusion and the pool before it would turn a silent all-fresh bench
    // into a wall of green the moment a caller passed a looser pool.
    const pool = eligibleCandidates(slots, candidateIds);
    const list = deriveFreshCandidates(slots, pool, counts);
    if (!freshMarkersAreInformative(list.length, pool.length)) return NO_FRESH;
    return new Set(list);
  }, [counts, slots, candidateIds]);

  // ── 3. Stable headline ───────────────────────────────────────
  const [headlineKey, setHeadlineKey] = useState<string | null>(null);
  const stillPresent = headlineKey !== null && warnings.some((w) => w.pairKey === headlineKey);
  const nextHeadlineKey =
    warnings.length === 0 ? null : stillPresent ? headlineKey : warnings[0].pairKey;
  if (nextHeadlineKey !== headlineKey) setHeadlineKey(nextHeadlineKey);
  const headline = warnings.find((w) => w.pairKey === nextHeadlineKey) ?? null;

  // ── 4. Marker referent ───────────────────────────────────────
  // Gated on EITHER family. Keying it on `markers` alone was correct while
  // amber was the only chip; it would now strand a bench full of green with
  // nothing saying who they are fresh against — the exact "a repeat with
  // *whom*?" defect this legend exists to prevent, in the other colour.
  const markerContext = useMemo<MarkerContext | null>(() => {
    if (markers.size === 0 && fresh.size === 0) return null;
    // Both derivers target the FIRST free slot; mirror that here.
    let target = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if ((slots[i] ?? null) === null) {
        target = i;
        break;
      }
    }
    if (target === -1) return null;
    return {
      team: target < 2 ? "A" : "B",
      partnerId: slots[partnerSlotIndex(target)] ?? null,
      opponentIds: opposingSlotIndices(target)
        .map((i) => slots[i] ?? null)
        .filter((x): x is string => !!x),
    };
  }, [markers, fresh, slots]);

  const legendFamilies = useMemo(
    () => ({ repeats: markers.size > 0, fresh: fresh.size > 0 }),
    [markers, fresh]
  );

  // ── 5. Live region (trailing debounce, user-gated) ───────────
  const message = useMemo(() => announcementFor(warnings, nameOf), [warnings, nameOf]);
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    // Epoch 0 = the initial mount, not a user action. Stay silent.
    if (selectionEpoch === 0) return;
    // The second dep is the counts ADOPTION transition, not the derived
    // message. It exists so a build that outran the first counts fetch is
    // still announced: the organizer taps four players on gym wi-fi, the
    // counts land a second later, warnings appear — with the epoch alone the
    // live region would stay frozen at "" and the feature would be inaudible.
    //
    // Depending on `message` itself would be too wide. The episode snapshot
    // freezes `counts` — but NOT the other two gate inputs: `suppressed` is
    // driven by an inbound cap-saturation broadcast, and `candidateIds` is
    // recomputed from the realtime queue. A co-organizer's draft flipping
    // either one blanks and restores `message` with no user action, and the
    // same warning would be spoken a second time.
    const timer = setTimeout(() => {
      // Read through the ref so the trailing edge speaks the FINAL state of
      // a tap burst, not whatever was true when the first tap fired.
      setAnnouncement((prev) => (prev === messageRef.current ? prev : messageRef.current));
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [selectionEpoch, countsAdopted]);

  // ── 6. One-shot pulse for newly-triggered pairs ──────────────
  // Scoped to ONE build episode: `shown` is the set of pairs already flashed
  // during this build, so a pair that trips, is deselected, and trips again
  // does not strobe. It resets when the selection clears.
  //
  // Fires on the same two triggers as the live region — a user tap, or the one
  // counts-adoption transition — and on nothing else. Engine draft churn and
  // queue refetches must not flash: a flash on a background event trains the
  // organizer to ignore flashes.
  //
  // Derived during render rather than in an effect (the repo bans setState in
  // effects) and threaded through state rather than a ref, so a StrictMode
  // double-invoke recomputes the SAME answer from the same previous state
  // instead of consuming `shown` on the first pass.
  const pulseKey = buildActive ? `${selectionEpoch}:${countsAdopted}` : "idle";
  const [pulse, setPulse] = useState<PulseState>({
    key: "",
    shown: NO_PULSE,
    fresh: NO_PULSE,
  });
  let currentPulse = pulse;
  if (pulse.key !== pulseKey) {
    if (!buildActive || selectionEpoch === 0) {
      currentPulse = { key: pulseKey, shown: NO_PULSE, fresh: NO_PULSE };
    } else {
      const freshKeys = warnings.filter((w) => !pulse.shown.has(w.pairKey)).map((w) => w.pairKey);
      const shown = new Set(pulse.shown);
      for (const w of warnings) shown.add(w.pairKey);
      currentPulse = {
        key: pulseKey,
        shown,
        fresh: freshKeys.length > 0 ? new Set(freshKeys) : NO_PULSE,
      };
    }
    setPulse(currentPulse);
  }
  const pulsedPairKeys = currentPulse.fresh;

  return {
    warnings,
    markers,
    fresh,
    headline,
    announcement,
    markerContext,
    legendFamilies,
    pulsedPairKeys,
  };
}
