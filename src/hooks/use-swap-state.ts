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

export function useSwapState(
  sessionId: string,
  onDeckMatches: EnrichedMatch[],
  swapMatchPlayers: (
    matchAId: string,
    playerAId: string,
    matchBId: string,
    playerBId: string,
    sessionId: string
  ) => Promise<{ success: boolean; errorCode?: string; message?: string }>,
  swapPlayer: (
    matchId: string,
    outPlayerId: string,
    inPlayerId: string
  ) => Promise<{ success: boolean; errorCode?: string; error?: string }>
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
  // eslint-disable-next-line react-hooks/refs
  swapContextRef.current = swapContext;

  // Ref mirrors executeMatchSwap so the stable handlePlayerTap useCallback
  // always calls the latest version — avoids a stale closure over swapMatchPlayers
  // or onDeckMatches if they ever change identity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeMatchSwapRef = useRef<(...args: any[]) => void>(() => {});

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
  // Checks swapContext.matchId (the first selected player's match).
  // If the TARGET match (second player) starts while picking, executeMatchSwap
  // catches it via its own pre-check before calling the server.
  //
  // Zero new subscriptions needed — onDeckMatches is already driven
  // by the existing subscribeToMatches → fetchActiveMatches pipeline.
  useEffect(() => {
    if (!swapContext) return;
    const matchStillPending = onDeckMatches.some((m) => m.id === swapContext.matchId);
    if (!matchStillPending) {
      setSwapContext(null);
      toast.warning("Match has started — the swap was cancelled automatically.");
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
  // eslint-disable-next-line react-hooks/refs
  executeMatchSwapRef.current = executeMatchSwap;

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
    setSwapContext,
    handlePlayerTap,
    handleOpenBenchSwap,
    handleCancelSwap,
    handleSwapComplete,
    lastSwapRef,
    showFloatingBar: swapContext?.mode === "picking",
  };
}
