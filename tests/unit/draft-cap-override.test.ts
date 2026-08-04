// ============================================================
// Unit Tests: Draft Cap Override — Pure Logic Suite
// ============================================================
//
// Tests the cap override feature's pure logic without hitting
// the database or server actions. Covers:
//
// Cap validation (CV-*)
//   CV-1  null is valid (means "use dynamic")
//   CV-2  1 is valid (minimum override)
//   CV-3  5 is valid (maximum override)
//   CV-4  0 is invalid (below minimum)
//   CV-5  6 is invalid (above maximum — dynamic handles xlarge)
//   CV-6  Non-integer is invalid
//   CV-7  Negative is invalid
//
// Cap chip label derivation (CL-*)
//   CL-1  null → label "Dynamic"
//   CL-2  1-5 → label is the number itself
//
// Phase state machine (PS-*)
//   PS-1  null → not locked, no chip loading state
//   PS-2  'clearing' → isDashboardLocked=true, chip shows "Clearing…"
//   PS-3  'generating' → isDashboardLocked=true, chip shows "Generating…"
//   PS-4  Transitions: null → clearing → generating → null
//
// Effective cap (covered in matchmaking-core.test.ts DC-8 to DC-13)
// ============================================================

import { describe, it, expect } from "vitest";

// ── Cap validation ─────────────────────────────────────────────
// A local restatement of the rule `applyDraftCapOverride` enforces
// (null, or an integer 1–5). It is a MIRROR, not the real code path —
// the action's own guard is asserted against the real implementation in
// tests/unit/draft-cap-action.test.ts (DCA-2).

function isValidCapOverride(value: unknown): value is number | null {
  if (value === null) return true;
  if (typeof value !== "number") return false;
  if (!Number.isInteger(value)) return false;
  return value >= 1 && value <= 5;
}

describe("Cap override validation", () => {
  it("CV-1: null is valid — means use dynamic cap", () => {
    expect(isValidCapOverride(null)).toBe(true);
  });

  it("CV-2: 1 is valid — minimum organizer override", () => {
    expect(isValidCapOverride(1)).toBe(true);
  });

  it("CV-3: 5 is valid — maximum organizer override", () => {
    expect(isValidCapOverride(5)).toBe(true);
  });

  it("CV-4: 0 is invalid — would generate zero drafts, use Auto OFF instead", () => {
    expect(isValidCapOverride(0)).toBe(false);
  });

  it("CV-5: 6 is invalid — dynamic cap handles xlarge sessions natively", () => {
    expect(isValidCapOverride(6)).toBe(false);
  });

  it("CV-6: non-integer (2.5) is invalid", () => {
    expect(isValidCapOverride(2.5)).toBe(false);
  });

  it("CV-7: negative value is invalid", () => {
    expect(isValidCapOverride(-1)).toBe(false);
  });
});

// ── Cap chip label ─────────────────────────────────────────────

function getCapChipLabel(override: number | null): string {
  return override === null ? "Dynamic" : String(override);
}

describe("Cap chip label", () => {
  it("CL-1: null override → label is 'Dynamic'", () => {
    expect(getCapChipLabel(null)).toBe("Dynamic");
  });

  it("CL-2: override 1 → label is '1'", () => {
    expect(getCapChipLabel(1)).toBe("1");
  });

  it("CL-2: override 5 → label is '5'", () => {
    expect(getCapChipLabel(5)).toBe("5");
  });

  it("CL-2: override 3 → label is '3'", () => {
    expect(getCapChipLabel(3)).toBe("3");
  });
});

// ── Phase state machine ────────────────────────────────────────

type CapPhase = null | "clearing" | "generating";

function isDashboardLocked(phase: CapPhase): boolean {
  return phase !== null;
}

function getChipLoadingLabel(phase: CapPhase): string | null {
  if (phase === "clearing") return "Clearing…";
  if (phase === "generating") return "Generating…";
  return null;
}

describe("Phase state machine", () => {
  it("PS-1: null phase → dashboard not locked, no loading label", () => {
    expect(isDashboardLocked(null)).toBe(false);
    expect(getChipLoadingLabel(null)).toBeNull();
  });

  it("PS-2: 'clearing' phase → dashboard locked, chip shows 'Clearing…'", () => {
    expect(isDashboardLocked("clearing")).toBe(true);
    expect(getChipLoadingLabel("clearing")).toBe("Clearing…");
  });

  it("PS-3: 'generating' phase → dashboard locked, chip shows 'Generating…'", () => {
    expect(isDashboardLocked("generating")).toBe(true);
    expect(getChipLoadingLabel("generating")).toBe("Generating…");
  });

  it("PS-4: transitions null→clearing→generating→null all produce correct labels", () => {
    const phases: CapPhase[] = [null, "clearing", "generating", null];
    const labels = phases.map(getChipLoadingLabel);
    expect(labels).toEqual([null, "Clearing…", "Generating…", null]);
  });

  it("PS-4: dashboard is locked during clearing and generating, but not at null", () => {
    const phases: CapPhase[] = [null, "clearing", "generating", null];
    const locked = phases.map(isDashboardLocked);
    expect(locked).toEqual([false, true, true, false]);
  });
});
