"use client";

// ============================================================
// useScoreInput — score submission hook for the player's score card
// ============================================================

import { useScoreForm } from "@/hooks/use-score-form";
import { submitMatchScore } from "@/app/actions/match-lifecycle";

/**
 * Thin wrapper around useScoreForm that wires up the submitMatchScore
 * server action for the player-facing ScoreInputCard.
 *
 * Extracted from ScoreInputCard so that:
 *   1. ScoreInputCard has zero server-action imports (component → hook boundary).
 *   2. The same submission logic can be reused if a second player-facing
 *      score entry surface is ever added.
 *
 * The error mapping normalises the action's `message` field into the
 * string shape that useScoreForm expects from its onSubmit callback.
 */
export function useScoreInput(matchId: string) {
  return useScoreForm(async (a, b) => {
    const result = await submitMatchScore(matchId, a, b);
    return {
      error: result.success ? undefined : (result.message ?? "Failed to submit score."),
    };
  });
}
