"use client";

// ============================================================
// useEditMatch — state machine for the organizer score-edit dialog
// ============================================================

import { useState, useTransition } from "react";
import { updateMatchDetails } from "@/app/actions/match-lifecycle";
import { DIALOG_CLOSE_DELAY_MS } from "@/lib/constants";

export type UseEditMatchResult = {
  open: boolean;
  scoreA: string;
  scoreB: string;
  setScoreA: (v: string) => void;
  setScoreB: (v: string) => void;
  message: string | null;
  isError: boolean;
  isPending: boolean;
  handleOpenChange: (next: boolean) => void;
  handleSaveScore: () => void;
  handleRevert: () => void;
};

/**
 * Manages the two-action score-edit dialog for the organizer.
 *
 * Owns all transient UI state (open, scores, feedback message) so that
 * EditMatchDialog becomes a pure layout renderer with no server-action
 * imports. The server action call lives here, not in the component, so
 * that the architectural boundary (components → hooks → actions) is
 * maintained.
 *
 * Two paths:
 *   handleSaveScore — corrects the recorded scores without re-opening the match.
 *   handleRevert    — sets scores to 0/0 and returns the match to in_progress
 *                     status so players can re-submit (revertToActive=true).
 */
export function useEditMatch(
  matchId: string,
  initialScoreA: number,
  initialScoreB: number
): UseEditMatchResult {
  const [open, setOpen] = useState(false);
  const [scoreA, setScoreA] = useState(String(initialScoreA));
  const [scoreB, setScoreB] = useState(String(initialScoreB));
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the current persisted scores each time the dialog opens,
      // discarding any partially-typed values from a previous open/close cycle.
      setScoreA(String(initialScoreA));
      setScoreB(String(initialScoreB));
      setMessage(null);
    }
    setOpen(next);
  }

  function handleSaveScore() {
    const a = parseInt(scoreA, 10);
    const b = parseInt(scoreB, 10);
    if (isNaN(a) || isNaN(b) || a < 0 || b < 0) {
      setMessage("Enter valid non-negative scores.");
      setIsError(true);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await updateMatchDetails(matchId, a, b, false);
      setMessage(result.message);
      setIsError(!result.success);
      if (result.success) {
        // Realtime will update the history card score; close after a brief delay
        // so the organizer can confirm the success message was shown.
        setTimeout(() => setOpen(false), DIALOG_CLOSE_DELAY_MS);
      }
    });
  }

  function handleRevert() {
    startTransition(async () => {
      const result = await updateMatchDetails(matchId, 0, 0, true);
      setMessage(result.message);
      setIsError(!result.success);
      if (result.success) {
        // Match disappears from history via realtime once it transitions back
        // to in_progress. Close the dialog so the organizer can see the court.
        setTimeout(() => setOpen(false), DIALOG_CLOSE_DELAY_MS);
      }
    });
  }

  return {
    open,
    scoreA,
    scoreB,
    setScoreA,
    setScoreB,
    message,
    isError,
    isPending,
    handleOpenChange,
    handleSaveScore,
    handleRevert,
  };
}
