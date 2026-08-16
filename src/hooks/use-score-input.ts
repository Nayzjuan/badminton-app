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
 *
 * The one failure that is NOT mapped to an error is the race the organizer and
 * the players run every time a game ends and more than one of them reaches for
 * the score: whoever loses gets `already_scored` (or `match_cancelled`) back.
 * Painting that red leaves the loser staring at a form for a match that no
 * longer exists, with a retry button that can only ever fail again — which is
 * exactly the state that pushes people into recording the game a second way.
 * It is reported as `settled` instead, so the card shows the resolution and the
 * player's dashboard moves them back to the queue on the next realtime tick.
 */
export function useScoreInput(matchId: string) {
  return useScoreForm(async (a, b) => {
    const result = await submitMatchScore(matchId, a, b);
    if (result.success) return {};
    if (result.code === "already_scored" || result.code === "match_cancelled") {
      return {
        settled: true,
        settledMessage:
          result.code === "already_scored"
            ? "Someone else already submitted this score. You're all set — heading back to the queue…"
            : "This match was cancelled by the organizer. Heading back to the queue…",
      };
    }
    return { error: result.message ?? "Failed to submit score." };
  });
}
