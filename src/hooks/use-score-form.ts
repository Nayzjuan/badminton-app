"use client";

// ============================================================
// useScoreForm — shared score input state machine
// ============================================================
// Drives both the player ScoreInputCard and the organizer ScoreModal.
// Validates 0–MAX_BADMINTON_SCORE range at submit time, rejects draws,
// and clears errors on input change.
// ============================================================

import { useState, useTransition } from "react";
import { MAX_BADMINTON_SCORE } from "@/lib/constants";

/**
 * Shared score input state machine for ScoreInputCard (player) and ScoreModal (organizer).
 *
 * Validates that both scores are integers in [0, MAX_BADMINTON_SCORE] at submit time.
 * Uses `useTransition` so the submit spinner does not block input re-renders during
 * the server round-trip. Provides `clearError` so callers can reset the validation
 * message on input change, independent of the submit cycle.
 */
export function useScoreForm(
  onSubmit: (teamA: number, teamB: number) => Promise<{ error?: string }>
) {
  const [teamAScore, setTeamAScore] = useState("");
  const [teamBScore, setTeamBScore] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
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
    startTransition(async () => {
      const result = await onSubmit(a, b);
      if (result.error) setError(result.error);
      else setSubmitted(true);
    });
  }

  function clearError() {
    setError(null);
  }

  return {
    teamAScore,
    setTeamAScore,
    teamBScore,
    setTeamBScore,
    error,
    submitted,
    isPending,
    handleSubmit,
    clearError,
  };
}
