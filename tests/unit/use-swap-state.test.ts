// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useSwapState Hook
// ============================================================
// Pins the swap state machine including the subtle pieces that
// break silently during refactors:
//
//   SS-1  First tap enters picking mode
//   SS-2  Same player tapped again → cancel (toggle off)
//   SS-3  Different player triggers executeMatchSwap
//   SS-4  Layer 2 race guard: match disappears → auto-cancel
//   SS-5  handleCancelSwap clears context
//   SS-6  handleOpenBenchSwap promotes picking → sheet mode
//   SS-7  Undo argument reversal — matchIds are REVERSED on undo
//   SS-8  showFloatingBar true only when mode === "picking"
//   SS-9  Pre-check cancels swap when either match gone
//   SS-10 swapPlayer bench undo calls with reversed in/out
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSwapState } from "@/hooks/use-swap-state";

// ── Mock sonner so toast calls don't error in jsdom ───────────
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from "sonner";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-1";
const MATCH_A = "match-a";
const MATCH_B = "match-b";
const PLAYER_ALICE = "player-alice";
const PLAYER_BOB = "player-bob";

function makeCtx(
  overrides: Partial<{
    matchId: string;
    outPlayerId: string;
    outPlayerName: string;
    sessionId: string;
  }> = {}
) {
  return {
    matchId: MATCH_A,
    sessionId: SESSION_ID,
    outPlayerId: PLAYER_ALICE,
    outTeam: "a" as const,
    outPlayerName: "Alice",
    outPlayerSkill: "intermediate" as const,
    currentPlayers: [
      { player_id: PLAYER_ALICE, skill_level: "intermediate" as const, display_name: "Alice" },
      { player_id: PLAYER_BOB, skill_level: "intermediate" as const, display_name: "Bob" },
    ],
    ...overrides,
  };
}

function makeMatch(id: string) {
  return { id } as Parameters<typeof useSwapState>[1][0];
}

// ── Default mock actions ───────────────────────────────────────

function makeSwapMatchPlayers(success = true, errorCode?: string) {
  return vi.fn().mockResolvedValue({ success, errorCode });
}

function makeSwapPlayer(success = true, errorCode?: string) {
  return vi.fn().mockResolvedValue({ success, errorCode });
}

function setup(
  onDeckMatches = [makeMatch(MATCH_A), makeMatch(MATCH_B)],
  swapMatchPlayers = makeSwapMatchPlayers(),
  swapPlayer = makeSwapPlayer()
) {
  const { result, rerender } = renderHook(
    ({ matches }) => useSwapState(SESSION_ID, matches, swapMatchPlayers, swapPlayer),
    { initialProps: { matches: onDeckMatches } }
  );
  return { result, rerender, swapMatchPlayers, swapPlayer };
}

// ── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSwapState", () => {
  describe("SS-1: First tap enters picking mode", () => {
    it("sets swapContext with mode=picking on first tap", () => {
      const { result } = setup();
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext).toMatchObject({
        mode: "picking",
        matchId: MATCH_A,
        outPlayerId: PLAYER_ALICE,
      });
    });
  });

  describe("SS-2: Same player tapped again → cancel", () => {
    it("clears context when same player is tapped twice", () => {
      const { result } = setup();
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext).not.toBeNull();

      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext).toBeNull();
    });
  });

  describe("SS-3: Different player triggers swap", () => {
    it("calls swapMatchPlayers with correct player and match IDs", async () => {
      const { result, swapMatchPlayers } = setup();

      // First tap: Alice in match A
      act(() => result.current.handlePlayerTap(makeCtx()));
      // Second tap: Bob in match B
      await act(async () =>
        result.current.handlePlayerTap(
          makeCtx({ matchId: MATCH_B, outPlayerId: PLAYER_BOB, outPlayerName: "Bob" })
        )
      );

      await waitFor(() => expect(swapMatchPlayers).toHaveBeenCalled());
      expect(swapMatchPlayers).toHaveBeenCalledWith(
        MATCH_A,
        PLAYER_ALICE,
        MATCH_B,
        PLAYER_BOB,
        SESSION_ID
      );
    });

    it("clears context immediately (optimistic) before server responds", async () => {
      const slow = vi.fn(
        () => new Promise<{ success: boolean }>((r) => setTimeout(() => r({ success: true }), 100))
      );
      const { result } = setup([makeMatch(MATCH_A), makeMatch(MATCH_B)], slow);

      act(() => result.current.handlePlayerTap(makeCtx()));
      act(() =>
        result.current.handlePlayerTap(makeCtx({ matchId: MATCH_B, outPlayerId: PLAYER_BOB }))
      );

      // Context should be null immediately (before server resolves)
      expect(result.current.swapContext).toBeNull();
    });
  });

  describe("SS-4: Layer 2 race guard — match disappears", () => {
    it("clears picking mode and shows warning when selected match is promoted", async () => {
      const { result, rerender } = setup();

      // Enter picking mode for match A
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext).not.toBeNull();

      // Simulate match A being promoted (removed from onDeckMatches)
      rerender({ matches: [makeMatch(MATCH_B)] });

      await waitFor(() => expect(result.current.swapContext).toBeNull());
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/match has started/i));
    });

    it("clears context when a different match is promoted (extended Layer 2 guard)", async () => {
      // Extended guard (commit 53b8e46): when onDeckMatches.length decreases while
      // in picking mode, the bar closes even if Alice's match is still on-deck.
      // Rationale: the target player pool changed — starting fresh is safer UX.
      const { result, rerender } = setup([makeMatch(MATCH_A), makeMatch(MATCH_B)]);

      // Enter picking mode for match A
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext).not.toBeNull();

      // Match B promoted (count drops from 2 → 1); match A still pending
      rerender({ matches: [makeMatch(MATCH_A)] });

      await waitFor(() => expect(result.current.swapContext).toBeNull());
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/moved to a court/i));
    });
  });

  describe("SS-5: handleCancelSwap clears context", () => {
    it("sets swapContext to null", () => {
      const { result } = setup();
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext).not.toBeNull();

      act(() => result.current.handleCancelSwap());
      expect(result.current.swapContext).toBeNull();
    });

    it("is a no-op when context is already null", () => {
      const { result } = setup();
      expect(() => act(() => result.current.handleCancelSwap())).not.toThrow();
      expect(result.current.swapContext).toBeNull();
    });
  });

  describe("SS-6: handleOpenBenchSwap promotes to sheet mode", () => {
    it("changes mode from picking → sheet when in picking mode", () => {
      const { result } = setup();
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.swapContext?.mode).toBe("picking");

      act(() => result.current.handleOpenBenchSwap());
      expect(result.current.swapContext?.mode).toBe("sheet");
    });

    it("is a no-op when not in picking mode", () => {
      const { result } = setup();
      // No context at all
      act(() => result.current.handleOpenBenchSwap());
      expect(result.current.swapContext).toBeNull();
    });
  });

  describe("SS-7: Undo argument reversal (critical correctness test)", () => {
    it("reverses matchId arguments on undo — sends each player back to their original match", async () => {
      const { result, swapMatchPlayers } = setup();

      // Alice (match A) ↔ Bob (match B) initial swap
      act(() => result.current.handlePlayerTap(makeCtx()));
      await act(async () =>
        result.current.handlePlayerTap(
          makeCtx({ matchId: MATCH_B, outPlayerId: PLAYER_BOB, outPlayerName: "Bob" })
        )
      );

      await waitFor(() => expect(swapMatchPlayers).toHaveBeenCalledTimes(1));

      // After swap: Alice is in match B, Bob is in match A.
      // Undo must send: Alice (now in B) → A, Bob (now in A) → B.
      // That means the matchId args must be REVERSED: (matchB, alice, matchA, bob).
      const toastSuccessCall = vi.mocked(toast.success).mock.calls[0];
      // Extract the undo onClick from the toast action
      const toastOptions = toastSuccessCall?.[1] as { action?: { onClick: () => void } };

      await act(async () => toastOptions?.action?.onClick());

      await waitFor(() => expect(swapMatchPlayers).toHaveBeenCalledTimes(2));

      const undoCall = vi.mocked(swapMatchPlayers).mock.calls[1];
      // Undo call: (matchB, aliceId, matchA, bobId, sessionId)
      expect(undoCall[0]).toBe(MATCH_B); // Alice is NOW in match B — source for undo
      expect(undoCall[1]).toBe(PLAYER_ALICE);
      expect(undoCall[2]).toBe(MATCH_A); // Bob is NOW in match A — source for undo
      expect(undoCall[3]).toBe(PLAYER_BOB);
    });
  });

  describe("SS-8: showFloatingBar", () => {
    it("is true when mode is picking", () => {
      const { result } = setup();
      act(() => result.current.handlePlayerTap(makeCtx()));
      expect(result.current.showFloatingBar).toBe(true);
    });

    it("is false when mode is sheet", () => {
      const { result } = setup();
      act(() => result.current.handlePlayerTap(makeCtx()));
      act(() => result.current.handleOpenBenchSwap());
      expect(result.current.showFloatingBar).toBe(false);
    });

    it("is false when no context", () => {
      const { result } = setup();
      expect(result.current.showFloatingBar).toBe(false);
    });
  });

  describe("SS-9: Pre-check cancels swap when either match gone", () => {
    it("cancels when first match is no longer on-deck at swap time", async () => {
      // Only match B is on-deck — match A was promoted between taps.
      const { result, swapMatchPlayers } = setup([makeMatch(MATCH_B)]);

      // Manually enter picking mode for match A (which is no longer on-deck).
      act(() => result.current.setSwapContext({ ...makeCtx(), mode: "picking" as const }));

      // Second tap: Bob in match B. executeMatchSwap fires (unawaited internally),
      // detects match A is gone, sets context null and warns — flush microtasks.
      await act(async () => {
        result.current.handlePlayerTap(makeCtx({ matchId: MATCH_B, outPlayerId: PLAYER_BOB }));
        // Flush the microtask that runs the pre-check inside executeMatchSwap.
        await Promise.resolve();
      });

      // swapMatchPlayers must never have been called (pre-check should block it).
      expect(swapMatchPlayers).not.toHaveBeenCalled();
      // Warning toast confirms the pre-check branch fired.
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/match has started/i));
    });
  });

  describe("SS-10: swapPlayer bench undo reverses in/out", () => {
    it("calls swapPlayer with inPlayerId as out and outPlayerId as in on undo", async () => {
      const { result, swapPlayer } = setup();

      const benchSwap = {
        matchId: MATCH_A,
        outPlayerId: PLAYER_ALICE,
        outName: "Alice",
        inPlayerId: PLAYER_BOB,
        inName: "Bob",
      };

      // Trigger handleSwapComplete (fires the undo toast)
      act(() => result.current.handleSwapComplete(benchSwap));

      const toastSuccessCall = vi.mocked(toast.success).mock.calls[0];
      const toastOptions = toastSuccessCall?.[1] as { action?: { onClick: () => void } };

      await act(async () => toastOptions?.action?.onClick());

      await waitFor(() => expect(swapPlayer).toHaveBeenCalledTimes(1));

      // Undo: swap Bob (who came in) back out, Alice (who went out) back in
      expect(swapPlayer).toHaveBeenCalledWith(
        MATCH_A,
        PLAYER_BOB, // inPlayerId → becomes the "out" player on undo
        PLAYER_ALICE // outPlayerId → comes back in
      );
    });
  });

  // ── SS-new-5 / SS-new-6 / SS-new-7: executeMatchSwap initial failure branches
  // Lines 175–180 in use-swap-state.ts: when the INITIAL swapMatchPlayers call
  // (not the undo) returns an error, each error code maps to a specific toast.

  describe("SS-new-5/6/7: executeMatchSwap initial swap failure toasts", () => {
    async function triggerInitialSwapFailure(swapResult: {
      success: boolean;
      errorCode?: string;
      message?: string;
    }) {
      const swapMatchPlayersMock = vi.fn().mockResolvedValue(swapResult);
      const { result } = setup([makeMatch(MATCH_A), makeMatch(MATCH_B)], swapMatchPlayersMock);

      // First tap selects Alice from match A
      act(() => result.current.handlePlayerTap(makeCtx()));
      // Second tap on Bob in match B → triggers executeMatchSwap which fails
      await act(async () =>
        result.current.handlePlayerTap(
          makeCtx({ matchId: MATCH_B, outPlayerId: PLAYER_BOB, outPlayerName: "Bob" })
        )
      );
      await waitFor(() => expect(swapMatchPlayersMock).toHaveBeenCalledTimes(1));
    }

    it("SS-new-5: initial swap with MATCH_STARTED error fires 'already started' toast", async () => {
      await triggerInitialSwapFailure({ success: false, errorCode: "MATCH_STARTED" });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already started/i));
    });

    it("SS-new-6: initial swap with PLAYER_NOT_IN_MATCH error fires 'already moved' toast", async () => {
      await triggerInitialSwapFailure({ success: false, errorCode: "PLAYER_NOT_IN_MATCH" });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already moved/i));
    });

    it("SS-new-7: initial swap with generic error fires 'Swap failed' toast with message", async () => {
      await triggerInitialSwapFailure({ success: false, message: "DB constraint violated" });
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/swap failed.*DB constraint violated/i)
      );
    });
  });

  // ── SS-new-1 / SS-new-2: handleUndoMatchSwap error branches ──────────────
  // Lines 213–216 in use-swap-state.ts: the undo-match-swap error paths
  // (MATCH_STARTED error code and generic fallback error).

  describe("SS-new-1/2: handleUndoMatchSwap error toasts", () => {
    async function triggerUndoMatchSwap(swapResult: { success: boolean; errorCode?: string }) {
      // Set up swapMatchPlayers to succeed for the initial swap
      const swapMatchPlayersMock = makeSwapMatchPlayers(true);
      const { result } = setup([makeMatch(MATCH_A), makeMatch(MATCH_B)], swapMatchPlayersMock);

      // Perform initial swap: Alice (matchA) ↔ Bob (matchB)
      act(() => result.current.handlePlayerTap(makeCtx()));
      await act(async () =>
        result.current.handlePlayerTap(
          makeCtx({ matchId: MATCH_B, outPlayerId: PLAYER_BOB, outPlayerName: "Bob" })
        )
      );
      await waitFor(() => expect(swapMatchPlayersMock).toHaveBeenCalledTimes(1));

      // Now override swapMatchPlayers for the undo call
      swapMatchPlayersMock.mockResolvedValue(swapResult);

      // Extract and fire the undo from the success toast action
      const toastCall = vi.mocked(toast.success).mock.calls[0];
      const toastOptions = toastCall?.[1] as { action?: { onClick: () => void } };
      await act(async () => toastOptions?.action?.onClick());
      await waitFor(() => expect(swapMatchPlayersMock).toHaveBeenCalledTimes(2));
    }

    it("SS-new-1: undo fires 'match has already started' toast when errorCode=MATCH_STARTED", async () => {
      await triggerUndoMatchSwap({ success: false, errorCode: "MATCH_STARTED" });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/match has already started/i));
    });

    it("SS-new-2: undo fires 'match may have changed' toast for generic failure (no errorCode)", async () => {
      await triggerUndoMatchSwap({ success: false });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/match may have changed/i));
    });
  });

  // ── SS-new-3 / SS-new-4: handleUndoSwap error branches ───────────────────
  // Lines 256–259 in use-swap-state.ts: the bench-swap undo error paths.

  describe("SS-new-3/4: handleUndoSwap (bench swap) error toasts", () => {
    async function triggerUndoSwap(swapResult: { success: boolean; errorCode?: string }) {
      const swapPlayerMock = makeSwapPlayer(true);
      const { result } = setup([makeMatch(MATCH_A)], makeSwapMatchPlayers(), swapPlayerMock);

      const benchSwap = {
        matchId: MATCH_A,
        outPlayerId: PLAYER_ALICE,
        outName: "Alice",
        inPlayerId: PLAYER_BOB,
        inName: "Bob",
      };

      // handleSwapComplete wires the undo toast for the bench swap path
      act(() => result.current.handleSwapComplete(benchSwap));

      // Override swapPlayer for the undo call
      swapPlayerMock.mockResolvedValue(swapResult);

      const toastCall = vi.mocked(toast.success).mock.calls[0];
      const toastOptions = toastCall?.[1] as { action?: { onClick: () => void } };
      await act(async () => toastOptions?.action?.onClick());
      await waitFor(() => expect(swapPlayerMock).toHaveBeenCalledTimes(1));
    }

    it("SS-new-3: bench undo fires 'match has already started' toast when errorCode=MATCH_STARTED", async () => {
      await triggerUndoSwap({ success: false, errorCode: "MATCH_STARTED" });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/match has already started/i));
    });

    it("SS-new-4: bench undo fires 'match may have changed' toast for generic failure (no errorCode)", async () => {
      await triggerUndoSwap({ success: false });
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/match may have changed/i));
    });
  });
});
