import { settledMatchToast, type SettledMatchToast } from "@/lib/settled-match-toast";

export type IdleScoreModalDecision = "ignore" | "in_flight" | "settle";

/**
 * Whether the organizer's score modal should react to a match leaving the
 * live set. Submit owns scored-vs-cancelled copy while `endMatch` is in
 * flight — the refetch that action always does would otherwise steal that
 * distinction and replace it with a vague "no longer live" toast.
 */
export function idleScoreModalDecision(args: {
  scoringMatchId: string | null;
  liveMatchIds: readonly string[];
  endingMatchId: string | null;
}): IdleScoreModalDecision {
  const { scoringMatchId, liveMatchIds, endingMatchId } = args;
  if (!scoringMatchId) return "ignore";
  if (liveMatchIds.includes(scoringMatchId)) return "ignore";
  if (endingMatchId === scoringMatchId) return "in_flight";
  return "settle";
}

/**
 * Idle-close copy once we know (or fail to know) the row's terminal status.
 * `completed` / `cancelled` reuse `settledMatchToast` so the two outcomes
 * cannot collapse into one sentence. Unknown stays neutral.
 */
export function toastForTerminalMatchStatus(status: string | null | undefined): SettledMatchToast {
  if (status === "completed") return settledMatchToast("already_scored")!;
  if (status === "cancelled") return settledMatchToast("match_cancelled")!;
  return {
    title: "Match ended",
    body: "This match is no longer live.",
  };
}
