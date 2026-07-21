// @vitest-environment happy-dom

// ============================================================
// useRepeatPairing — the episodic half of the repeat warning
// ============================================================
// The pure derivation is covered by repeat-pairing.test.ts. What is tested
// here is everything that only exists because a real organizer is mid-tap:
//   * the counts SNAPSHOT that stops engine draft churn from re-ranking the
//     warning under their fingers,
//   * the STABLE headline that stops the top line rewriting twice during
//     one 4-tap build,
//   * the AVOIDABILITY gate + cap-saturation suppression that stop the
//     warning firing hardest when there is no alternative,
//   * the USER-GATED, debounced live region.
//
// IDs: RPH-S snapshot · RPH-H headline · RPH-G gate · RPH-C context
//      RPH-A announcement
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ANNOUNCE_DEBOUNCE_MS, useRepeatPairing } from "@/hooks/use-repeat-pairing";
import { EMPTY_SLOTS, type PairCounts, type Slots } from "@/lib/repeat-pairing";
import { pairKey } from "@/lib/matchmaking-core";

const NAMES: Record<string, string> = {
  p1: "Alice",
  p2: "Bob",
  p3: "Carol",
  p4: "Dave",
  p5: "Eve",
};
const nameOf = (id: string) => NAMES[id] ?? "Unknown";

function counts(
  partnerships: Array<[string, string, number]> = [],
  opponents: Array<[string, string, number]> = []
): PairCounts {
  return {
    partnerships: new Map(partnerships.map(([a, b, n]) => [pairKey(a, b), n])),
    opponents: new Map(opponents.map(([a, b, n]) => [pairKey(a, b), n])),
  };
}

type Props = Parameters<typeof useRepeatPairing>[0];

const BASE: Props = {
  slots: EMPTY_SLOTS,
  candidateIds: [],
  liveCounts: null,
  selectionEpoch: 0,
  suppressed: false,
  nameOf,
};

function setup(overrides: Partial<Props> = {}) {
  return renderHook((props: Props) => useRepeatPairing(props), {
    initialProps: { ...BASE, ...overrides },
  });
}

describe("useRepeatPairing — episode snapshot", () => {
  it("RPH-S1: counts are frozen for the duration of a build episode", () => {
    const before = counts([["p1", "p2", 2]]);
    const after = counts([["p1", "p2", 0]]);

    const { result, rerender } = setup({
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: before,
    });
    expect(result.current.markers.has("p2")).toBe(true);

    // The engine drafts a match mid-build and the counts refetch. The marker
    // must NOT vanish under the organizer's finger.
    rerender({
      ...BASE,
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: after,
    });
    expect(result.current.markers.has("p2")).toBe(true);
  });

  it("RPH-S2: clearing the selection ends the episode and adopts fresh counts", () => {
    const before = counts([["p1", "p2", 2]]);
    const after = counts([["p1", "p2", 0]]);

    const { result, rerender } = setup({
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: before,
    });
    expect(result.current.markers.has("p2")).toBe(true);

    rerender({ ...BASE, slots: EMPTY_SLOTS, candidateIds: ["p2", "p3", "p4"], liveCounts: after });
    rerender({
      ...BASE,
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: after,
    });
    expect(result.current.markers.has("p2")).toBe(false);
  });

  it("RPH-S3: an episode that starts before the first counts load adopts them once", () => {
    const { result, rerender } = setup({
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: null,
    });
    expect(result.current.markers.size).toBe(0);

    rerender({
      ...BASE,
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: counts([["p1", "p2", 2]]),
    });
    expect(result.current.markers.has("p2")).toBe(true);
  });
});

describe("useRepeatPairing — stable headline", () => {
  it("RPH-H1: the FIRST pair to trip stays the headline even when out-ranked", () => {
    const c = counts([
      ["p1", "p2", 2],
      ["p3", "p4", 5],
    ]);
    const { result, rerender } = setup({
      slots: ["p1", "p2", null, null],
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
    });
    const first = result.current.headline;
    expect(first?.pairKey).toBe(pairKey("p1", "p2"));

    // p3 & p4 have a HIGHER count, so derivePairWarnings sorts them first…
    rerender({
      ...BASE,
      slots: ["p1", "p2", "p3", "p4"],
      candidateIds: ["p5"],
      liveCounts: c,
    });
    expect(result.current.warnings[0].pairKey).toBe(pairKey("p3", "p4"));
    // …but the top line does not rewrite mid-build.
    expect(result.current.headline?.pairKey).toBe(pairKey("p1", "p2"));
  });

  it("RPH-H2: the headline moves on when its own pair leaves the selection", () => {
    const c = counts([
      ["p1", "p2", 2],
      ["p3", "p4", 5],
    ]);
    // Build up so p1 & p2 is the pair that trips FIRST in this episode.
    const { result, rerender } = setup({
      slots: ["p1", "p2", null, null],
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
    });
    rerender({
      ...BASE,
      slots: ["p1", "p2", "p3", "p4"],
      candidateIds: ["p5"],
      liveCounts: c,
    });
    expect(result.current.headline?.pairKey).toBe(pairKey("p1", "p2"));

    // Bob is swapped out; his pair no longer exists.
    rerender({
      ...BASE,
      slots: ["p1", "p5", "p3", "p4"],
      candidateIds: ["p2"],
      liveCounts: c,
    });
    expect(result.current.headline?.pairKey).toBe(pairKey("p3", "p4"));
  });

  it("RPH-H3: no selection means no headline", () => {
    const { result } = setup({ liveCounts: counts([["p1", "p2", 9]]) });
    expect(result.current.headline).toBeNull();
    expect(result.current.warnings).toEqual([]);
  });
});

describe("useRepeatPairing — avoidability gate + suppression", () => {
  it("RPH-G1: everything is suppressed when every alternative is also capped", () => {
    // Alice is picked; EVERY remaining bench player is already at the cap
    // with her, so the repeat is forced, not a choice.
    const c = counts([
      ["p1", "p2", 2],
      ["p1", "p3", 2],
      ["p1", "p4", 2],
    ]);
    const { result } = setup({
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: c,
    });
    expect(result.current.markers.size).toBe(0);
    expect(result.current.warnings).toEqual([]);
  });

  it("RPH-G2: one clean alternative opens the gate", () => {
    const c = counts([
      ["p1", "p2", 2],
      ["p1", "p3", 2],
    ]);
    const { result } = setup({
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3", "p4"],
      liveCounts: c,
    });
    expect(result.current.markers.size).toBe(2);
  });

  it("RPH-G3: cap saturation suppresses the warning entirely", () => {
    const c = counts([["p1", "p2", 2]]);
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
    };
    const { result, rerender } = setup(props);
    expect(result.current.warnings).toHaveLength(1);

    rerender({ ...props, suppressed: true });
    expect(result.current.warnings).toEqual([]);
    expect(result.current.markers.size).toBe(0);
    expect(result.current.headline).toBeNull();
  });

  it("RPH-G5: at 4/4 with an empty bench the warning SURVIVES if a slot was avoidable", () => {
    // The night has exactly four selectable players, so candidateIds is empty
    // at full selection. The pre-fix gate short-circuited on that and made the
    // headline vanish at the exact moment the CTA went live.
    const c = counts([["p1", "p2", 2]]);
    const { result } = setup({
      slots: ["p1", "p2", "p3", "p4"],
      candidateIds: [],
      liveCounts: c,
    });
    expect(result.current.warnings).toHaveLength(1);
    expect(result.current.headline?.pairKey).toBe(pairKey("p1", "p2"));
  });

  it("RPH-G6: at 4/4 a roster that was forced in EVERY slot still stays quiet", () => {
    // Whichever slot you free, the only person who could fill it is the one
    // already there — and they trip a repeat. Nothing was avoidable.
    const c = counts([
      ["p1", "p2", 2],
      ["p3", "p4", 2],
      ["p1", "p3", 2],
      ["p1", "p4", 2],
      ["p2", "p3", 2],
      ["p2", "p4", 2],
    ]);
    const { result } = setup({
      slots: ["p1", "p2", "p3", "p4"],
      candidateIds: [],
      liveCounts: c,
    });
    expect(result.current.warnings).toEqual([]);
  });

  it("RPH-G4: an empty bench suppresses the warning (nothing was avoidable)", () => {
    const { result } = setup({
      slots: ["p1", "p2", null, null],
      candidateIds: [],
      liveCounts: counts([["p1", "p2", 2]]),
    });
    expect(result.current.warnings).toEqual([]);
  });
});

describe("useRepeatPairing — marker referent", () => {
  it("RPH-C1: resolves the slot the next tap fills, after a deselect", () => {
    // A2 is free, so the next tap is a TEAMMATE of Alice even though three
    // players are already picked.
    const { result } = setup({
      slots: ["p1", null, "p3", "p4"],
      candidateIds: ["p2", "p5"],
      liveCounts: counts([["p1", "p2", 2]]),
    });
    expect(result.current.markerContext).toEqual({
      team: "A",
      partnerId: "p1",
      opponentIds: ["p3", "p4"],
    });
  });

  it("RPH-C2: null when nothing is marked", () => {
    const { result } = setup({
      slots: ["p1", null, null, null],
      candidateIds: ["p2", "p3"],
      liveCounts: counts(),
    });
    expect(result.current.markerContext).toBeNull();
  });
});

describe("useRepeatPairing — live region", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("RPH-A1: silent at epoch 0 — mounting is not a user action", () => {
    const { result } = setup({
      slots: ["p1", "p2", null, null],
      candidateIds: ["p3", "p4"],
      liveCounts: counts([["p1", "p2", 2]]),
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS * 4);
    });
    expect(result.current.announcement).toBe("");
  });

  it("RPH-A2: a user-initiated change speaks on the trailing edge only", () => {
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4"],
      liveCounts: counts([["p1", "p2", 2]]),
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);

    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS - 50);
    });
    expect(result.current.announcement).toBe("");

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(result.current.announcement).toContain("Alice and Bob have partnered 2 times tonight.");

    // A burst of taps resets the timer and only the FINAL state is spoken.
    rerender({ ...props, selectionEpoch: 2, slots: ["p1", null, null, null] });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS - 50);
    });
    rerender({ ...props, selectionEpoch: 3, slots: ["p1", null, null, null] });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS - 50);
    });
    expect(result.current.announcement).toContain("partnered");
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(result.current.announcement).toBe("");
  });

  it("RPH-A3: a counts refetch after the first announcement never re-speaks", () => {
    // Deliberately at epoch >= 1: at epoch 0 the `selectionEpoch === 0` guard
    // satisfies this on its own and the test would pass with ANY dep array.
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4"],
      liveCounts: counts([["p1", "p2", 2]]),
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
    });
    const spoken = result.current.announcement;
    expect(spoken).toContain("partnered");

    // A refetch lands with different numbers, same epoch. The episode
    // snapshot means it cannot even reach the derived text — and the live
    // region must not be rewritten (a rewrite re-announces).
    rerender({ ...props, liveCounts: counts([["p1", "p2", 7]]) });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS * 4);
    });
    expect(result.current.announcement).toBe(spoken);
  });

  it("RPH-A4: a build that outran the counts fetch is still announced", () => {
    // The organizer taps on gym wi-fi before getSessionPairCounts resolves.
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4"],
      liveCounts: null,
      selectionEpoch: 2,
    };
    const { result, rerender } = setup(props);
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
    });
    // Nothing known yet, so nothing to say.
    expect(result.current.announcement).toBe("");

    // Counts land a second later. Without the adoption dep the live region
    // would stay frozen at "" and the whole feature would be inaudible.
    rerender({ ...props, liveCounts: counts([["p1", "p2", 2]]) });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
    });
    expect(result.current.announcement).toContain("Alice and Bob have partnered 2 times tonight.");
  });

  it("RPH-A5: a gate flip with no user action never re-speaks", () => {
    // `suppressed` and `candidateIds` are NOT frozen by the episode snapshot:
    // a co-organizer's cap-saturation broadcast or a queue change flips them.
    // Blanking and restoring the warning must not announce it twice.
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4"],
      liveCounts: counts([["p1", "p2", 2]]),
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
    });
    const spoken = result.current.announcement;
    expect(spoken).toContain("partnered");

    rerender({ ...props, suppressed: true });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
    });
    rerender({ ...props, suppressed: false });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
    });
    // Same string, never rewritten — so a screen reader says it once.
    expect(result.current.announcement).toBe(spoken);
  });
});

describe("useRepeatPairing — one-shot pulse", () => {
  const c = counts([
    ["p1", "p2", 2],
    ["p3", "p4", 5],
  ]);

  it("RPH-P1: a pair that starts repeating on this tap pulses once", () => {
    const { result } = setup({
      slots: ["p1", "p2", null, null],
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
      selectionEpoch: 1,
    });
    expect([...result.current.pulsedPairKeys]).toEqual([pairKey("p1", "p2")]);
  });

  it("RPH-P2: an already-shown pair does not pulse again in the same episode", () => {
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    expect(result.current.pulsedPairKeys.size).toBe(1);

    // Next tap adds Carol & Dave — only THAT pair flashes; Alice & Bob, which
    // the organizer has already seen, must not strobe again.
    rerender({
      ...props,
      slots: ["p1", "p2", "p3", "p4"],
      candidateIds: ["p5"],
      selectionEpoch: 2,
    });
    expect([...result.current.pulsedPairKeys]).toEqual([pairKey("p3", "p4")]);
  });

  it("RPH-P3: a tap that adds no new repeat pulses nothing", () => {
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    rerender({
      ...props,
      slots: ["p1", "p2", "p5", null],
      candidateIds: ["p3", "p4"],
      selectionEpoch: 2,
    });
    expect(result.current.pulsedPairKeys.size).toBe(0);
  });

  it("RPH-P4: the episode memory clears with the selection", () => {
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    expect(result.current.pulsedPairKeys.size).toBe(1);

    rerender({ ...props, slots: EMPTY_SLOTS, selectionEpoch: 2 });
    expect(result.current.pulsedPairKeys.size).toBe(0);

    // A fresh build re-flashes the same pair — it is new information again.
    rerender({ ...props, selectionEpoch: 3 });
    expect([...result.current.pulsedPairKeys]).toEqual([pairKey("p1", "p2")]);
  });

  it("RPH-P5: a background counts refetch never pulses", () => {
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: c,
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    expect(result.current.pulsedPairKeys.size).toBe(1);

    // Same epoch, new counts object: engine draft churn must not flash — a
    // flash on a background event trains the organizer to ignore flashes.
    rerender({ ...props, liveCounts: counts([["p1", "p2", 9]]) });
    expect([...result.current.pulsedPairKeys]).toEqual([pairKey("p1", "p2")]);
  });

  it("RPH-P6: a build that outran the counts fetch still pulses on adoption", () => {
    const props = {
      ...BASE,
      slots: ["p1", "p2", null, null] as Slots,
      candidateIds: ["p3", "p4", "p5"],
      liveCounts: null,
      selectionEpoch: 1,
    };
    const { result, rerender } = setup(props);
    expect(result.current.pulsedPairKeys.size).toBe(0);

    rerender({ ...props, liveCounts: c });
    expect([...result.current.pulsedPairKeys]).toEqual([pairKey("p1", "p2")]);
  });
});
