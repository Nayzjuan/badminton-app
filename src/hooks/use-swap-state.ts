"use client";

// ============================================================
// useSwapState — Tap-to-Swap state machine
// ============================================================
// Extracted from OrganizerDashboard to keep the swap logic
// in one focused, testable unit.
//
// Drives two swap paths:
//   1. Direct match↔match swap  — two-tap picking flow
//   2. Bench swap               — SwapSheet drawer path
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { SwapContext } from "@/components/organizer/on-deck-panel";
import type { UndoableSwap } from "@/components/organizer/swap-sheet";
import type { EnrichedMatch } from "@/hooks/use-enriched-matches";
import type { SwapErrorCode, SwapMatchPlayersErrorCode } from "@/app/actions/swap-player";

type MatchSwapArgs = [first: Omit<SwapContext, "mode">, second: Omit<SwapContext, "mode">];

/**
 * Two-path swap state machine for the organizer dashboard.
 *
 * Path 1 (direct): two-tap player selection → `handlePlayerTap` → `executeMatchSwap`
 *   → `swapMatchPlayers` server action → undoable toast.
 * Path 2 (bench): single tap → `handleOpenBenchSwap` opens SwapSheet → `swapPlayer`
 *   server action → `handleSwapComplete` → undoable toast.
 *
 * `handlePlayerTap` is a stable `useCallback` (reads swapContext via ref) so
 * OnDeckPanel's `memo` boundary is not broken by re-renders that update swapContext.
 *
 * Layer 2 guard: proactively clears picking mode when any on-deck match disappears —
 * prevents a confusing server error if the organizer is mid-pick when a match starts.
 */
export function useSwapState(
  sessionId: string,
  onDeckMatches: EnrichedMatch[],
  swapMatchPlayers: (
    matchAId: string,
    playerAId: string,
    matchBId: string,
    playerBId: string,
    sessionId: string
  ) => Promise<{ success: boolean; errorCode?: SwapMatchPlayersErrorCode; message?: string }>,
  swapPlayer: (
    matchId: string,
    outPlayerId: string,
    inPlayerId: string
  ) => Promise<{ success: boolean; errorCode?: SwapErrorCode; error?: string }>
) {
  // ── Tap-to-Swap state ───────────────────────────────────────
  // swapContext drives both picking-mode (direct match↔match swap)
  // and sheet-mode (legacy bench replacement).
  //
  // mode: "picking" — first tap done; floating bar shown; pills have
  //                   ring/valid-target visual treatment.
  // mode: "sheet"   — SwapSheet open for picking a bench replacement.
  const [swapContext, setSwapContext] = useState<SwapContext | null>(null);

  // Ref mirrors swapContext so the stable useCallback can read current
  // value without being included in deps (avoids breaking OnDeckPanel memo).
  const swapContextRef = useRef<SwapContext | null>(null);
  useEffect(() => {
    swapContextRef.current = swapContext;
  }, [swapContext]);

  // Ref mirrors executeMatchSwap so the stable handlePlayerTap useCallback
  // always calls the latest version — avoids a stale closure over swapMatchPlayers
  // or onDeckMatches if they ever change identity.
  const executeMatchSwapRef = useRef<(...args: MatchSwapArgs) => void>(() => {});

  // Ref holds the last successful bench swap for the 5-second undo toast.
  // Using a ref (not state) so setting it doesn't cause a re-render.
  const lastSwapRef = useRef<UndoableSwap | null>(null);

  // ── Layer 2 — Frontend Race Condition Guard ─────────────────
  // When a match transitions from pending → in_progress (promoted
  // by promoteOnDeckMatchInternal), it disappears from onDeckMatches.
  // This effect proactively closes the SwapSheet / clears picking mode
  // ~100ms after promotion so the organizer sees a clear warning rather
  // than a server error.
  //
  // Two triggers:
  //   a) The SELECTED player's match left on-deck (original guard).
  //   b) Any match left on-deck while in picking mode (extended guard).
  //      Covers the scenario where the TARGET player's match starts
  //      between the first and second tap — the player pill disappears
  //      from the on-deck panel, so the pre-flight check in executeMatchSwap
  //      never runs. Cancelling proactively gives the organizer a clean
  //      starting point.
  //
  // Zero new subscriptions needed — onDeckMatches is already driven
  // by the existing subscribeToMatches → fetchActiveMatches pipeline.
  const prevOnDeckLengthRef = useRef(onDeckMatches.length);
  useEffect(() => {
    const prevLen = prevOnDeckLengthRef.current;
    prevOnDeckLengthRef.current = onDeckMatches.length;

    if (!swapContext) return;

    // (a) Selected player's own match left on-deck
    const matchStillPending = onDeckMatches.some((m) => m.id === swapContext.matchId);
    if (!matchStillPending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSwapContext(null);
      toast.warning("Match has started — the swap was cancelled automatically.");
      return;
    }

    // (b) Any other match left on-deck — target player pool changed
    if (onDeckMatches.length < prevLen) {
      setSwapContext(null);
      toast.warning("A match moved to a court — tap a player to try again.");
    }
  }, [onDeckMatches, swapContext]);

  // ── handlePlayerTap ─────────────────────────────────────────
  // Stable callback (reads swapContext via ref) so OnDeckPanel memo is not
  // broken — this function reference never changes between renders.
  //
  // First tap  → enter "picking" mode, show floating bar.
  // Same player again → cancel (toggle off).
  // Different player → execute direct match↔match swap.
  const handlePlayerTap = useCallback((ctx: Omit<SwapContext, "mode">) => {
    const current = swapContextRef.current;

    if (!current || current.mode !== "picking") {
      // No active picking context → start a new one
      setSwapContext({ ...ctx, mode: "picking" });
      return;
    }

    // Already in picking mode
    if (current.outPlayerId === ctx.outPlayerId && current.matchId === ctx.matchId) {
      // Same player tapped again → cancel
      setSwapContext(null);
      return;
    }

    // Different player tapped → execute the direct swap.
    // Use the ref so we always call the latest version of executeMatchSwap
    // (which closes over current onDeckMatches for the Bug 3 pre-check).
    executeMatchSwapRef.current(current, ctx);
  }, []); // stable — reads from swapContextRef + executeMatchSwapRef

  // ── handleUndoMatchSwap ─────────────────────────────────────
  // Reverses a direct match↔match swap.
  //
  // After the initial swap:
  //   first.outPlayerId  is now in  second.matchId
  //   second.outPlayerId is now in  first.matchId
  //
  // So the undo must REVERSE the matchId arguments — pass each
  // player's NEW match as the source, restoring original placement.
  // For a same-match team swap (first.matchId == second.matchId)
  // the argument order doesn't matter and this still works correctly.
  //
  // Declared before executeMatchSwap so the reference at the toast
  // action site is not a forward reference (React Compiler analysis).
  async function handleUndoMatchSwap(
    first: Omit<SwapContext, "mode">,
    second: Omit<SwapContext, "mode">
  ) {
    const result = await swapMatchPlayers(
      second.matchId, // first.outPlayerId is NOW here
      first.outPlayerId,
      first.matchId, // second.outPlayerId is NOW here
      second.outPlayerId,
      first.sessionId
    );
    if (result.success) {
      toast.success("Swap undone.");
    } else if (result.errorCode === "MATCH_STARTED") {
      toast.error("Couldn't undo — match has already started.");
    } else {
      toast.error("Couldn't undo — match may have changed.");
    }
  }

  // ── executeMatchSwap ────────────────────────────────────────
  // Calls the server action and shows undo-able toast on success.
  // Clears picking mode immediately (optimistic).
  //
  // Bug 3 fix: pre-checks BOTH match IDs against onDeckMatches before
  // calling the server. If either match started between the first tap
  // and the second tap, this catches it client-side so we never hit
  // a confusing server error in this edge case.
  async function executeMatchSwap(
    first: Omit<SwapContext, "mode">,
    second: Omit<SwapContext, "mode">
  ) {
    // Pre-check: both matches must still be on-deck (pending).
    const firstStillPending = onDeckMatches.some((m) => m.id === first.matchId);
    const secondStillPending = onDeckMatches.some((m) => m.id === second.matchId);
    if (!firstStillPending || !secondStillPending) {
      setSwapContext(null);
      toast.warning("A match has started — the swap was cancelled automatically.");
      return;
    }

    // Clear picking mode immediately — UI snaps to idle while server responds
    setSwapContext(null);

    const result = await swapMatchPlayers(
      first.matchId,
      first.outPlayerId,
      second.matchId,
      second.outPlayerId,
      first.sessionId
    );

    if (result.success) {
      const sameMatch = first.matchId === second.matchId;
      const toastTitle = sameMatch
        ? `Swapped teams: ${first.outPlayerName} ↔ ${second.outPlayerName}`
        : `Swapped matches: ${first.outPlayerName} ↔ ${second.outPlayerName}`;

      toast.success(toastTitle, {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => handleUndoMatchSwap(first, second),
        },
      });
    } else if (result.errorCode === "MATCH_STARTED") {
      toast.error("Match has already started — swap cancelled.");
    } else if (result.errorCode === "PLAYER_NOT_IN_MATCH") {
      toast.error("A player was already moved — swap cancelled.");
    } else {
      toast.error(`Swap failed: ${result.message}`);
    }
  }

  // Keep the ref current so handlePlayerTap always calls the latest closure
  // (which captures the up-to-date onDeckMatches for the pre-check above).
  // No deps array — executeMatchSwap is redeclared every render and must
  // always reflect the latest onDeckMatches snapshot for the pre-flight check.
  useEffect(() => {
    executeMatchSwapRef.current = executeMatchSwap;
  });

  // ── handleOpenBenchSwap ─────────────────────────────────────
  // Promotes picking mode → sheet mode (opens the bench-replacement drawer).
  function handleOpenBenchSwap() {
    if (swapContextRef.current?.mode === "picking") {
      setSwapContext((prev) => (prev ? { ...prev, mode: "sheet" } : null));
    }
  }

  // ── handleCancelSwap ────────────────────────────────────────
  function handleCancelSwap() {
    setSwapContext(null);
  }

  // ── Bench swap complete: close sheet + fire undo toast ──────
  function handleSwapComplete(swap: UndoableSwap) {
    lastSwapRef.current = swap;
    toast.success(`Swapped ${swap.outName} → ${swap.inName}`, {
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => handleUndoSwap(swap),
      },
    });
    // Sheet is closed by SwapSheet itself after calling onSwapComplete
  }

  // ── Undo bench swap ─────────────────────────────────────────
  async function handleUndoSwap(swap: UndoableSwap) {
    lastSwapRef.current = null;
    const result = await swapPlayer(
      swap.matchId,
      swap.inPlayerId, // inPlayer becomes the new "out"
      swap.outPlayerId // outPlayer comes back in
    );
    if (result.success) {
      toast.success("Swap undone.");
    } else if (result.errorCode === "MATCH_STARTED") {
      toast.error("Couldn't undo — match has already started.");
    } else {
      toast.error("Couldn't undo — match may have changed.");
    }
  }

  return {
    swapContext,
    // setSwapContext intentionally NOT exported — use handler functions for all
    // state transitions so the Layer-2 guard and pre-flight checks are never bypassed.
    handlePlayerTap,
    handleOpenBenchSwap,
    handleCancelSwap,
    handleSwapComplete,
    // lastSwapRef intentionally NOT exported — only needed internally for the undo toast.
    showFloatingBar: swapContext?.mode === "picking",
  };
}
