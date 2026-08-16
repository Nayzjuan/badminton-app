// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useScoreForm Hook
// ============================================================
// Pins the score validation boundaries and state machine.
//
//   SF-1  NaN input rejected
//   SF-2  Negative scores rejected
//   SF-3  Score > 31 rejected (MAX_BADMINTON_SCORE = 31 cap)
//   SF-4  Boundary values accepted: 0–30 valid non-equal pairs
//   SF-5  Server error propagates to error state
//   SF-6  Server success sets submitted = true
//   SF-7  clearError() resets error to null
//   SF-8  Draw rejected (equal scores must not be submitted)
//   SF-9  isPending is true during async submit (skipped — useTransition is
//          not observable in happy-dom; React batches transitions differently
//          in test vs. production rendering)
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScoreForm, type ScoreSubmitOutcome } from "@/hooks/use-score-form";

// ── Helpers ───────────────────────────────────────────────────

// Typed as the hook's full outcome, not `{ error?: string }`: the narrower type
// is still ASSIGNABLE to the wider one (every field is optional), so a helper
// stuck at the old shape compiles fine at the call site while making `settled`
// unspecifiable — the SF-11 cases could never have been written against it.
function makeSubmitter(result: ScoreSubmitOutcome = {}) {
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

  describe("SF-3: Score > 31 rejected (MAX_BADMINTON_SCORE cap)", () => {
    it("rejects teamA score of 32", () => {
      const { result, submitter } = setup();
      fillScores(result, "32", "15");
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
      expect(result.current.error).toBeNull();
    });

    it("accepts 1 – 0 (minimum winning margin)", async () => {
      const submitter = makeSubmitter();
      const { result } = setup(submitter);
      fillScores(result, "1", "0");
      await act(async () => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledWith(1, 0);
      expect(result.current.error).toBeNull();
    });

    it("rejects 32 – 28 (exceeds MAX_BADMINTON_SCORE of 31)", () => {
      const { result, submitter } = setup();
      fillScores(result, "32", "28");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/valid scores/i);
      expect(submitter).not.toHaveBeenCalled();
    });
  });

  describe("SF-8: Draw rejected", () => {
    it("rejects 0 – 0", async () => {
      const { result, submitter } = setup();
      fillScores(result, "0", "0");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/equal|winning team/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("rejects 21 – 21", async () => {
      const { result, submitter } = setup();
      fillScores(result, "21", "21");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/equal|winning team/i);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("rejects 15 – 15", async () => {
      const { result, submitter } = setup();
      fillScores(result, "15", "15");
      act(() => result.current.handleSubmit());
      expect(result.current.error).toMatch(/equal|winning team/i);
      expect(submitter).not.toHaveBeenCalled();
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

  // SF-9 — isPending during async submit
  // Skipped: useTransition's isPending flag is not reliably observable in
  // happy-dom because React batches transitions differently in test vs.
  // production rendering. The flag is structural (from useTransition) rather
  // than custom logic, so there is no application-level regression risk.
  it.skip("SF-9: isPending is true during async submit", () => {
    // Would need React's act() to flush concurrent-mode transitions correctly.
    // Use a real browser or React 18 test utilities with concurrentMode enabled.
  });

  // ── SF-10: the synchronous double-submit latch ──────────────
  //
  // SF-9 is skipped because `isPending` is not observable here, and that is
  // exactly the hole the latch exists for: `isPending` is state, so a second
  // tap landing before React re-renders still sees an enabled button. Without
  // the ref that becomes two calls for one match — submitMatchScore twice from
  // the player card, endMatchAction twice from the organizer's modal — and the
  // second loses the server's CAS, so the user is shown "already scored by
  // someone else" for a race they had with themselves.
  describe("SF-10: double-submit latch", () => {
    /** A submitter that stays pending until the returned `resolve` is called. */
    function deferredSubmitter() {
      let resolve!: (v: { error?: string }) => void;
      const pending = new Promise<{ error?: string }>((r) => {
        resolve = r;
      });
      const fn = vi.fn().mockReturnValue(pending);
      return { fn, resolve };
    }

    it("ignores a second submit while the first is still in flight", async () => {
      const { fn, resolve } = deferredSubmitter();
      const { result } = setup(fn);
      fillScores(result, "21", "15");

      act(() => result.current.handleSubmit());
      act(() => result.current.handleSubmit());
      expect(fn).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolve({});
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("re-arms after a failure so the user can retry", async () => {
      const submitter = makeSubmitter({ error: "Network error" });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");

      await act(async () => result.current.handleSubmit());
      expect(result.current.error).toBe("Network error");

      await act(async () => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledTimes(2);
    });

    it("re-arms after the submitter REJECTS — a throw must not disarm the form", async () => {
      const submitter = vi.fn().mockRejectedValue(new Error("boom"));
      const { result } = setup(submitter);
      fillScores(result, "21", "15");

      // The rejection propagates out of the transition, so each flush is caught
      // here; what matters is that the hook's `finally` released the latch.
      const submitAndSwallow = async () => {
        try {
          await act(async () => {
            result.current.handleSubmit();
          });
        } catch {
          /* the submitter's own rejection */
        }
      };

      await submitAndSwallow();
      await submitAndSwallow();

      expect(submitter).toHaveBeenCalledTimes(2);
    });

    it("does not latch on a validation failure — nothing was ever in flight", async () => {
      const submitter = makeSubmitter();
      const { result } = setup(submitter);
      fillScores(result, "21", "21"); // draw
      act(() => result.current.handleSubmit());
      expect(submitter).not.toHaveBeenCalled();

      fillScores(result, "21", "15");
      await act(async () => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledTimes(1);
    });
  });

  // ── SF-11: the settled outcome ──────────────────────────────
  describe("SF-11: settled is terminal, not an error", () => {
    it("sets settled + submitted and leaves error null", async () => {
      const submitter = makeSubmitter({
        settled: true,
        settledMessage: "This match was already scored by someone else.",
      });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");

      await act(async () => result.current.handleSubmit());

      expect(result.current.settled).toBe("This match was already scored by someone else.");
      expect(result.current.submitted).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it("wins over a co-reported error — settled is checked first", async () => {
      const submitter = makeSubmitter({ settled: true, error: "Match is not in progress." });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");

      await act(async () => result.current.handleSubmit());

      expect(result.current.settled).not.toBeNull();
      expect(result.current.error).toBeNull();
    });

    it("falls back to default copy when no settledMessage is supplied", async () => {
      const submitter = makeSubmitter({ settled: true });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");

      await act(async () => result.current.handleSubmit());

      expect(result.current.settled).toBe("This match was already scored.");
    });
  });

  // ── SF-12: reset() ──────────────────────────────────────────
  // The organizer's ScoreModal reuses ONE mounted form across every match it
  // opens. Without this, one settled submit would latch the terminal state onto
  // every match opened after it for the life of the mount.
  describe("SF-12: reset()", () => {
    it("clears the terminal state so the next match starts armed", async () => {
      const submitter = makeSubmitter({ settled: true, settledMessage: "Already scored." });
      const { result } = setup(submitter);
      fillScores(result, "21", "15");
      await act(async () => result.current.handleSubmit());
      expect(result.current.submitted).toBe(true);

      act(() => result.current.reset());

      expect(result.current.settled).toBeNull();
      expect(result.current.submitted).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it("re-arms the latch, so a stale in-flight submit cannot disarm the next match", async () => {
      let resolve!: (v: { error?: string }) => void;
      const pending = new Promise<{ error?: string }>((r) => {
        resolve = r;
      });
      const submitter = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({});
      const { result } = setup(submitter);
      fillScores(result, "21", "15");

      act(() => result.current.handleSubmit()); // still in flight
      act(() => result.current.reset()); // organizer opens the next match

      fillScores(result, "21", "19");
      act(() => result.current.handleSubmit());
      expect(submitter).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolve({});
      });
    });
  });
});
