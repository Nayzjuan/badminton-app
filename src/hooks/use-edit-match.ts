"use client";

// ============================================================
// useEditMatch — state machine for the organizer score-edit dialog
// ============================================================

import { useState, useRef, useEffect, useTransition } from "react";
import { updateMatchDetails } from "@/app/actions/match-lifecycle";
import { resolveScoreCorrection } from "@/app/actions/notifications";
import { DIALOG_CLOSE_DELAY_MS, MAX_BADMINTON_SCORE } from "@/lib/constants";

export type UseEditMatchOptions = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  notificationId?: string | null;
  onSaved?: () => void;
};

export type UseEditMatchResult = {
  open: boolean;
  scoreA: string;
  scoreB: string;
  /** Setters that also clear the feedback message — see `clearFeedback`. */
  setScoreA: (v: string) => void;
  setScoreB: (v: string) => void;
  message: string | null;
  isError: boolean;
  /** True once a score edit in THIS dialog session has been saved. */
  savedOnce: boolean;
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
 *
 * ⚠️ A score edit deliberately does NOT close the dialog. Correcting a score is
 * a repeatable operation — the organizer routinely needs a second pass (swap the
 * teams, then fix a digit) — and this dialog previously ended every successful
 * save with a detached `setTimeout(() => setOpen(false), DIALOG_CLOSE_DELAY_MS)`.
 * Two independent reasons that is wrong:
 *
 *   1. It made every repeat edit a close/reopen cycle, for an operation whose
 *      whole point is that it repeats. Staying open costs one ✕ click and makes
 *      the second edit a non-event.
 *   2. The timer was untracked, so it outlived the dialog: it could fire against
 *      a reopened dialog (slamming it shut mid-typing) and set state after
 *      unmount.
 *
 * ⛔ It is NOT because a timer-driven close strands `body { pointer-events:none }`.
 * That was an earlier hypothesis for the "then nothing responded" report and it
 * is FALSE — checked against the installed source: @radix-ui/react-dismissable-layer
 * restores the body from an effect *cleanup* on unmount, which runs no matter what
 * flipped `open`, so a timer close is not special. A safety-net hook built on that
 * hypothesis was written and then reverted. Don't re-add one without a reproduction.
 *
 * The revert path still auto-closes: it moves the match back onto a court, so
 * the history card it lives in disappears from under the dialog either way. Its
 * timer is tracked in a ref and cancelled on unmount and on every new action.
 */
export function useEditMatch(
  matchId: string,
  initialScoreA: number,
  initialScoreB: number,
  options: UseEditMatchOptions = {}
): UseEditMatchResult {
  const isControlled = options.open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? Boolean(options.open) : uncontrolledOpen;
  function setOpen(next: boolean) {
    if (!isControlled) setUncontrolledOpen(next);
    options.onOpenChange?.(next);
  }
  const [scoreA, setScoreARaw] = useState(String(initialScoreA));
  const [scoreB, setScoreBRaw] = useState(String(initialScoreB));
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Pending auto-close timer (revert path only). Held in a ref so it can be
  // cancelled — an uncancelled timer fires against whatever the dialog has
  // become by the time it lands.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelPendingClose() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }
  useEffect(() => cancelPendingClose, []);

  // Typing invalidates the last verdict. Without this the green "Scores
  // updated." outlives the values it was about: the dialog no longer closes
  // itself after a save, so the organizer can retype 21→23 and be left looking
  // at a success message next to a number that was never sent.
  function clearFeedback() {
    setMessage(null);
    setIsError(false);
  }
  function setScoreA(v: string) {
    clearFeedback();
    setScoreARaw(v);
  }
  function setScoreB(v: string) {
    clearFeedback();
    setScoreBRaw(v);
  }

  function handleOpenChange(next: boolean) {
    cancelPendingClose();
    if (next) {
      // Reset to the current persisted scores each time the dialog opens,
      // discarding any partially-typed values from a previous open/close cycle.
      // isError is reset alongside message — it used to survive the close and
      // could paint the next open's first message red.
      setScoreARaw(String(initialScoreA));
      setScoreBRaw(String(initialScoreB));
      setMessage(null);
      setIsError(false);
      setSavedOnce(false);
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
    // Upper bound mirrors scoreSchema (@/lib/schemas/match), which the server
    // applies to this exact call. Without it the only feedback on a typo like
    // 211 is a round-trip; useScoreForm already bounds the submit path the same
    // way, so the two score-entry surfaces now agree on what is enterable.
    if (a > MAX_BADMINTON_SCORE || b > MAX_BADMINTON_SCORE) {
      setMessage(`Enter valid scores (0–${MAX_BADMINTON_SCORE}) for both teams.`);
      setIsError(true);
      return;
    }
    if (a === b) {
      setMessage("Scores cannot be equal — there must be a winning team.");
      setIsError(true);
      return;
    }
    cancelPendingClose();
    setMessage(null);
    startTransition(async () => {
      if (options.notificationId) {
        const result = await resolveScoreCorrection(options.notificationId, a, b);
        if (result.alreadyResolved) {
          setMessage(
            result.actorName
              ? `Already handled by ${result.actorName}.`
              : (result.error ?? "Already handled.")
          );
          setIsError(true);
          if (result.currentScoreA != null) setScoreARaw(String(result.currentScoreA));
          if (result.currentScoreB != null) setScoreBRaw(String(result.currentScoreB));
          options.onSaved?.();
          return;
        }
        setMessage(result.message ?? result.error ?? null);
        setIsError(!result.success);
        if (result.success) {
          setScoreARaw(String(a));
          setScoreBRaw(String(b));
          setSavedOnce(true);
          options.onSaved?.();
          closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            handleOpenChange(false);
          }, DIALOG_CLOSE_DELAY_MS);
        }
        return;
      }

      const result = await updateMatchDetails(matchId, a, b, false);
      setMessage(result.message);
      setIsError(!result.success);
      if (result.success) {
        // Stay open, re-seeded with what was just persisted, so the next
        // correction is one edit away. Realtime updates the history card behind
        // the dialog independently.
        //
        // Raw setters: the public setScoreA/setScoreB clear the feedback
        // message (they exist to invalidate it on a keystroke), and these two
        // lines run immediately after setMessage(result.message) — going
        // through the wrappers would erase the "Scores updated." we just set.
        setScoreARaw(String(a));
        setScoreBRaw(String(b));
        setSavedOnce(true);
        options.onSaved?.();
      }
    });
  }

  function handleRevert() {
    cancelPendingClose();
    startTransition(async () => {
      const result = await updateMatchDetails(matchId, 0, 0, true);
      setMessage(result.message);
      setIsError(!result.success);
      if (result.success) {
        // Match disappears from history via realtime once it transitions back
        // to in_progress. Close the dialog so the organizer can see the court.
        options.onSaved?.();
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          handleOpenChange(false);
        }, DIALOG_CLOSE_DELAY_MS);
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
    savedOnce,
    isPending,
    handleOpenChange,
    handleSaveScore,
    handleRevert,
  };
}
