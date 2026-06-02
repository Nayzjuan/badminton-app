"use client";

// ============================================================
// useLiveMatchSwap — State machine for the live swap sheet
// ============================================================
// Manages the three-phase flow for fixing player assignments
// on an active (in_progress) court:
//
//   Phase 1 — Sheet open: organizer picks a replacement
//             from three sections: same match (team swap),
//             on-deck, or waiting queue.
//   Phase 2 — Fill required (on-deck only): organizer must
//             nominate a queue player to fill the vacated
//             on-deck slot before Confirm unlocks.
//   Phase 3 — Submitting: server action in-flight.
//
// Undo: after success, stores an undo context. The parent
// renders a 3-second Sonner toast with an undo action that
// calls undoLiveSwap().
// ============================================================

import { useState, useTransition } from "react";
import {
  swapPlayerInActiveMatch,
  swapTeamsInActiveMatch,
  swapActiveFromOnDeck,
  undoLiveSwap,
} from "@/app/actions/live-match-swap";
import type { LiveSwapErrorCode, LiveSwapUndoContext } from "@/app/actions/live-match-swap";
import type { RosterPlayer } from "@/components/organizer/match-roster";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

// ── Types ──────────────────────────────────────────────────────

export type ReplacementSource = "same_match" | "queue" | "ondeck";

export type ReplacementCandidate = {
  player_id: string;
  display_name: string;
  skill_level: string;
  source: ReplacementSource;
  /** Only set when source === "ondeck". */
  onDeckMatchId?: string;
  /** Court name / label to show for on-deck grouping. */
  onDeckLabel?: string;
};

export type FillCandidate = {
  player_id: string;
  display_name: string;
  skill_level: string;
};

export type LiveSwapState = {
  isOpen: boolean;
  outgoingPlayer: RosterPlayer | null;
  outgoingTeam: "a" | "b" | null;
  match: EnrichedMatch | null;
  selectedReplacement: ReplacementCandidate | null;
  /** Only required when selectedReplacement.source === "ondeck". */
  selectedFill: FillCandidate | null;
  isSubmitting: boolean;
  error: string | null;
  errorCode: LiveSwapErrorCode | null;
};

const INITIAL: LiveSwapState = {
  isOpen: false,
  outgoingPlayer: null,
  outgoingTeam: null,
  match: null,
  selectedReplacement: null,
  selectedFill: null,
  isSubmitting: false,
  error: null,
  errorCode: null,
};

// ── Hook ───────────────────────────────────────────────────────

/**
 * State machine for the live match player swap flow.
 *
 * Usage:
 *   const swap = useLiveMatchSwap({ sessionId, onSuccess });
 *   // Long-press fires:
 *   swap.open(player, team, match);
 *   // Sheet picks fire:
 *   swap.selectReplacement(candidate);
 *   swap.selectFill(fillCandidate);
 *   // Confirm button:
 *   swap.confirm();
 */
export function useLiveMatchSwap({
  sessionId,
  onSuccess,
}: {
  sessionId: string;
  onSuccess: (undoCtx: LiveSwapUndoContext) => void;
}) {
  const [state, setState] = useState<LiveSwapState>(INITIAL);
  const [isPending, startTransition] = useTransition();

  // ── Sheet open/close ──────────────────────────────────────────

  function open(player: RosterPlayer, team: "a" | "b", match: EnrichedMatch) {
    setState({
      ...INITIAL,
      isOpen: true,
      outgoingPlayer: player,
      outgoingTeam: team,
      match,
    });
  }

  function close() {
    setState(INITIAL);
  }

  // ── Replacement selection ─────────────────────────────────────

  function selectReplacement(candidate: ReplacementCandidate | null) {
    setState((prev) => ({
      ...prev,
      selectedReplacement: candidate,
      // Clear fill if the new replacement doesn't need it.
      selectedFill: candidate?.source === "ondeck" ? prev.selectedFill : null,
      error: null,
      errorCode: null,
    }));
  }

  function selectFill(fill: FillCandidate | null) {
    setState((prev) => ({ ...prev, selectedFill: fill, error: null, errorCode: null }));
  }

  // ── Confirmation readiness ────────────────────────────────────

  function canConfirm(s: LiveSwapState): boolean {
    if (!s.selectedReplacement || !s.match || !s.outgoingPlayer) return false;
    if (s.selectedReplacement.source === "ondeck" && !s.selectedFill) return false;
    return true;
  }

  // ── Confirm ───────────────────────────────────────────────────

  function confirm() {
    if (!canConfirm(state) || isPending) return;

    const { match, outgoingPlayer, outgoingTeam, selectedReplacement, selectedFill } = state;
    if (!match || !outgoingPlayer || !outgoingTeam || !selectedReplacement) return;

    startTransition(async () => {
      setState((prev) => ({ ...prev, isSubmitting: true, error: null, errorCode: null }));

      let result;

      if (selectedReplacement.source === "same_match") {
        result = await swapTeamsInActiveMatch(
          match.id,
          sessionId,
          outgoingPlayer.player_id,
          selectedReplacement.player_id,
          outgoingPlayer.display_name,
          selectedReplacement.display_name
        );
      } else if (selectedReplacement.source === "queue") {
        result = await swapPlayerInActiveMatch(
          match.id,
          outgoingPlayer.player_id,
          selectedReplacement.player_id,
          sessionId,
          outgoingPlayer.display_name,
          selectedReplacement.display_name
        );
      } else {
        // ondeck — 3-way swap
        if (!selectedFill || !selectedReplacement.onDeckMatchId) {
          setState((prev) => ({
            ...prev,
            isSubmitting: false,
            error: "Please select a player to fill the on-deck slot.",
          }));
          return;
        }
        result = await swapActiveFromOnDeck(
          match.id,
          outgoingPlayer.player_id,
          selectedReplacement.player_id,
          selectedReplacement.onDeckMatchId,
          selectedFill.player_id,
          sessionId,
          outgoingPlayer.display_name,
          selectedReplacement.display_name,
          selectedFill.display_name
        );
      }

      if (result.success && result.undoContext) {
        // Close the sheet first, then fire the undo callback.
        setState(INITIAL);
        onSuccess(result.undoContext);
      } else {
        const shouldClose =
          result.errorCode === "MATCH_NOT_ACTIVE" ||
          result.errorCode === "PLAYER_NOT_IN_MATCH" ||
          result.errorCode === "ONDECK_MATCH_STARTED";

        if (shouldClose) {
          setState(INITIAL);
        } else {
          setState((prev) => ({
            ...prev,
            isSubmitting: false,
            error: result.message,
            errorCode: result.errorCode ?? null,
          }));
        }
      }
    });
  }

  // ── Undo ──────────────────────────────────────────────────────

  async function undo(ctx: LiveSwapUndoContext): Promise<boolean> {
    const result = await undoLiveSwap(ctx);
    return result.success;
  }

  return {
    state,
    isOpen: state.isOpen,
    isSubmitting: isPending || state.isSubmitting,
    canConfirm: canConfirm(state),
    open,
    close,
    selectReplacement,
    selectFill,
    confirm,
    undo,
  };
}
