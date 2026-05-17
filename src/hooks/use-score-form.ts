"use client";

// ============================================================
// useScoreForm — shared score input state machine
// ============================================================
// Drives both the player ScoreInputCard and the organizer ScoreModal.
// Validates 0–30 range at submit time, clears errors on input change.
// ============================================================

import { useState, useTransition } from "react";

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
    if (isNaN(a) || isNaN(b) || a < 0 || b < 0 || a > 30 || b > 30) {
      setError("Enter valid scores (0–30) for both teams.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await onSubmit(a, b);
      if (result.error) setError(result.error);
      else setSubmitted(true);
    });
  }

  return { teamAScore, setTeamAScore, teamBScore, setTeamBScore, error, submitted, isPending, handleSubmit };
}
