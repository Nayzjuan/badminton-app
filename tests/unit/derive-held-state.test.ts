// ============================================================
// Unit Tests: deriveHeldState — cross-court held-draft view state
// ============================================================
// Distinct id prefix CC-DHS-* (NOT CC-PURE-*, which the pure-core suite owns —
// senior-QA QA-IDS-01 collision fix).
// ============================================================

import { describe, it, expect } from "vitest";
import { deriveHeldState, HELD_STATE_META } from "@/lib/cross-court/derive-held-state";

describe("deriveHeldState", () => {
  it("CC-DHS-01: not held → 'none' regardless of other fields", () => {
    expect(
      deriveHeldState({
        isHeld: false,
        heldReadyAt: "2026-06-07T12:00:00Z",
        sourceStillPlaying: true,
      })
    ).toBe("none");
  });

  it("CC-DHS-02: held + source still playing + not stamped → 'holding'", () => {
    expect(deriveHeldState({ isHeld: true, heldReadyAt: null, sourceStillPlaying: true })).toBe(
      "holding"
    );
  });

  it("CC-DHS-03: held + source finished + not yet stamped → 'resting'", () => {
    expect(deriveHeldState({ isHeld: true, heldReadyAt: null, sourceStillPlaying: false })).toBe(
      "resting"
    );
  });

  it("CC-DHS-04: held + held_ready_at stamped → 'ready' (overrides source state)", () => {
    expect(
      deriveHeldState({
        isHeld: true,
        heldReadyAt: "2026-06-07T12:00:00Z",
        sourceStillPlaying: false,
      })
    ).toBe("ready");
    // Even if the source somehow still reads in_progress, a stamp wins.
    expect(
      deriveHeldState({
        isHeld: true,
        heldReadyAt: "2026-06-07T12:00:00Z",
        sourceStillPlaying: true,
      })
    ).toBe("ready");
  });

  it("CC-DHS-05: every non-none state has accessible label + tone meta (icon+text, never color-only)", () => {
    for (const state of ["holding", "resting", "ready"] as const) {
      expect(HELD_STATE_META[state].label).toMatch(/^[A-Z]+$/);
      expect(["violet", "emerald"]).toContain(HELD_STATE_META[state].tone);
    }
    // READY is the single emerald (go) state; HOLDING/RESTING share the violet identity.
    expect(HELD_STATE_META.ready.tone).toBe("emerald");
    expect(HELD_STATE_META.holding.tone).toBe("violet");
    expect(HELD_STATE_META.resting.tone).toBe("violet");
  });
});
