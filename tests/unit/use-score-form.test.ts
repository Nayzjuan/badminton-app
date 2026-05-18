// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useScoreForm Hook
// ============================================================
// Pins the score validation boundaries and state machine that
// existed as a bug (the organiser had no 0–30 upper limit).
//
//   SF-1  NaN input rejected
//   SF-2  Negative scores rejected
//   SF-3  Score > 30 rejected (the previously missing check)
//   SF-4  Boundary values accepted: 0 and 30 both valid
//   SF-5  Server error propagates to error state
//   SF-6  Server success sets submitted = true
//   SF-7  clearError() resets error to null
//   SF-8  isPending is true during async submit (skipped — useTransition is
//          not observable in happy-dom; React batches transitions differently
//          in test vs. production rendering)
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScoreForm } from "@/hooks/use-score-form";

// ── Helpers ───────────────────────────────────────────────────

function makeSubmitter(result: { error?: string } = {}) {
  return vi.fn().mockResolvedValue(result);
}

function setup(submitter = makeSubmitter()) {
  const { result } = renderHook(() => useScoreForm(submitter));
  return { result, submitter };
}

function fillScores(result: ReturnType<typeof setup>["result"], a: string, b: string) {
  act(() => {
    result.current.setTeamAScore(a);
    result.current.setTeamBScore(b);
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("useScoreForm", () => {
  describe("SF-1: NaN input rejected", () => {
    it("sets error when teamA is non-numeric", async () => {
      const { result, submitter } = setup();
      fillScores(result, "abc", "21");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("sets error when teamB is non-numeric", async () => {
      const { result, submitter } = setup();
      fillScores(result, "21", "xyz");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("sets error when both scores are empty", async () => {
      const { result, submitter } = setup();
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });
  });

  describe("SF-2: Negative scores rejected", () => {
    it("rejects negative teamA score", async () => {
      const { result, submitter } = setup();
      fillScores(result, "-1", "15");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("rejects negative teamB score", async () => {
      const { result, submitter } = setup();
      fillScores(result, "15", "-5");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });
  });

  describe("SF-3: Score > 30 rejected (regression pin)", () => {
    it("rejects teamA score of 31", async () => {
      const { result, submitter } = setup();
      fillScores(result, "31", "15");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("rejects teamB score of 99", async () => {
      const { result, submitter } = setup();
      fillScores(result, "21", "99");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("rejects 100 vs 100", async () => {
      const { result, submitter } = setup();
      fillScores(result, "100", "100");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });
  });

  describe("SF-4: Boundary values accepted", () => {
    it("accepts 0 – 0", async () => {
      const submitter = makeSubmitter();
      const { result } = setup(submitter);
      fillScores(result, "0", "0");
      await act(async () => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledWith(0, 0);
      expect(result.current.error).toBeNull();
    });

    it("accepts 30 – 28", async () => {
      const submitter = makeSubmitter();
      const { result } = setup(submitter);
      fillScores(result, "30", "28");
      await act(async () => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledWith(30, 28);
      expect(result.current.error).toBeNull();
    });

    it("accepts 0 – 30", async () => {
      const submitter = makeSubmitter();
      const { result } = setup(submitter);
      fillScores(result, "0", "30");
      await act(async () => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledWith(0, 30);
    });
  });

  describe("SF-5: Server error propagates", () => {
    it("sets error state from server response", async () => {
      const submitter = makeSubmitter({ error: "Session already closed." });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");
      await act(async () => result.current.handleSubmit());
      expect(result.current.error).toBe("Session already closed.");
      expect(result.current.submitted).toBe(false);
    });
  });

  describe("SF-6: Server success sets submitted", () => {
    it("sets submitted = true on clean server response", async () => {
      const submitter = makeSubmitter();
      const { result } = setup(submitter);
      fillScores(result, "21", "15");
      await act(async () => result.current.handleSubmit());
      expect(result.current.submitted).toBe(true);
      expect(result.current.error).toBeNull();
    });
  });

  describe("SF-7: clearError()", () => {
    it("clears a validation error", async () => {
      const { result } = setup();
      // Trigger a validation error
      fillScores(result, "abc", "21");
      act(() => result.current.handleSubmit());
      expect(result.current.error).not.toBeNull();

      // Clear it
      act(() => result.current.clearError());
      expect(result.current.error).toBeNull();
    });

    it("clears a server error", async () => {
      const submitter = makeSubmitter({ error: "Server down." });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");
      await act(async () => result.current.handleSubmit());
      expect(result.current.error).toBe("Server down.");

      act(() => result.current.clearError());
      expect(result.current.error).toBeNull();
    });

    it("is a no-op when there is no error", () => {
      const { result } = setup();
      act(() => result.current.clearError());
      expect(result.current.error).toBeNull();
    });
  });

  // SF-8 — isPending during async submit
  // Skipped: useTransition's isPending flag is not reliably observable in
  // happy-dom because React batches transitions differently in test vs.
  // production rendering. The flag is structural (from useTransition) rather
  // than custom logic, so there is no application-level regression risk.
  it.skip("SF-8: isPending is true during async submit", () => {
    // Would need React's act() to flush concurrent-mode transitions correctly.
    // Use a real browser or React 18 test utilities with concurrentMode enabled.
  });
});
