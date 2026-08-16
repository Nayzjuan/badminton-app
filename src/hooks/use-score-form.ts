"use client";

// ============================================================
// useScoreForm — shared score input state machine
// ============================================================
// Drives both the player ScoreInputCard and the organizer ScoreModal.
// Validates 0–MAX_BADMINTON_SCORE range at submit time and rejects draws.
//
// Three submit outcomes, not two. `{}` is a win, `{ error }` is a failure the
// user can act on (bad input, network) — and `{ settled }` is the concurrency
// case: the match was scored by someone else between this form opening and
// this submit. Nothing about it is the submitter's fault and there is nothing
// left for them to do here, so it drives the same terminal state as a success
// rather than a red error the form can never clear.
// ============================================================

import { useRef, useState, useTransition } from "react";
import { MAX_BADMINTON_SCORE } from "@/lib/constants";

/** What a `useScoreForm` submit handler may report back. */
export type ScoreSubmitOutcome = {
  /** An actionable failure — rendered inline, form stays armed. */
  error?: string;
  /** The match is already scored/cancelled by someone else. Terminal. */
  settled?: boolean;
  /** Copy for the terminal state when `settled`. */
  settledMessage?: string;
};

/**
 * Shared score input state machine for ScoreInputCard (player) and ScoreModal (organizer).
 *
 * Validates that both scores are integers in [0, MAX_BADMINTON_SCORE] at submit time.
 * Uses `useTransition` so the submit spinner does not block input re-renders during
 * the server round-trip. Also exposes `clearError` for a host that wants to drop the
 * validation message on input change — no caller wires it today, so on both surfaces
 * the message stays up until the next submit replaces it. (useEditMatch does wire
 * that behaviour, through its own `clearFeedback`.)
 */
export function useScoreForm(
  onSubmit: (teamA: number, teamB: number) => Promise<ScoreSubmitOutcome>
) {
  const [teamAScore, setTeamAScore] = useState("");
  const [teamBScore, setTeamBScore] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Synchronous double-submit latch.
  //
  // `isPending` is state: it only disables the button after React re-renders,
  // and a second tap that lands inside that window sees a still-enabled button
  // and fires a second `onSubmit` — two `submitMatchScore` calls for one match
  // on the player card, two `endMatchAction` calls on the organizer's modal.
  // The server's CAS rejects the second, but the user is then shown the loser's
  // "already scored by someone else" message for a race they had with
  // themselves. A ref flips in the same tick as the first call, so the second
  // returns before it can start.
  const inFlightRef = useRef(false);

  function handleSubmit() {
    if (inFlightRef.current) return;
    const a = parseInt(teamAScore, 10);
    const b = parseInt(teamBScore, 10);
    if (
      isNaN(a) ||
      isNaN(b) ||
      a < 0 ||
      b < 0 ||
      a > MAX_BADMINTON_SCORE ||
      b > MAX_BADMINTON_SCORE
    ) {
      setError(`Enter valid scores (0–${MAX_BADMINTON_SCORE}) for both teams.`);
      return;
    }
    if (a === b) {
      setError("Scores cannot be equal — there must be a winning team.");
      return;
    }
    setError(null);
    inFlightRef.current = true;
    startTransition(async () => {
      try {
        const result = await onSubmit(a, b);
        if (result.settled) {
          // Terminal, like a success: the match IS scored. Checked before
          // `error` so a handler that fills in both still lands here.
          setSettled(result.settledMessage ?? "This match was already scored.");
          setSubmitted(true);
        } else if (result.error) {
          setError(result.error);
        } else {
          setSubmitted(true);
        }
      } finally {
        // Released on every path, including a rejected `onSubmit`. Leaving it
        // latched after a failure would disarm the form permanently, and the
        // failure branch above exists precisely so the user can retry.
        inFlightRef.current = false;
      }
    });
  }

  function clearError() {
    setError(null);
  }

  /**
   * Full reset back to a fresh, armed form — for a host that REUSES one mounted
   * form across several matches (the organizer's ScoreModal does; the player's
   * ScoreInputCard unmounts instead and needs none of this).
   *
   * `clearError` deliberately does not do this, and the two must not be merged:
   * it is the per-keystroke shape (that is what a host would wire it to), and
   * `submitted`/`settled` are terminal states that typing must not undo. But
   * they are equally terminal for the LIFETIME of the mount, so a reused form
   * has to be able to clear them at the boundary between two matches — otherwise
   * one settled submit latches the terminal state onto every match opened after
   * it. Scores are left to the caller, which already seeds them on open.
   */
  function reset() {
    setError(null);
    setSettled(null);
    setSubmitted(false);
    // The latch is per-submit, but a reused form crossing a match boundary
    // while a stale submit is still in flight would otherwise stay disarmed.
    inFlightRef.current = false;
  }

  return {
    teamAScore,
    setTeamAScore,
    teamBScore,
    setTeamBScore,
    error,
    submitted,
    /** Non-null when the match was settled by someone else; holds the copy. */
    settled,
    isPending,
    handleSubmit,
    clearError,
    reset,
  };
}
