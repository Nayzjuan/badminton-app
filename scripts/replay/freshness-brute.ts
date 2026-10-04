// ============================================================
// Independent brute force for "was a fresher four admissible?"
// ============================================================
//
// Does NOT call findFresherFour. Same accept filters as the plan §1
// (skill ±2, Red Zone containment, games-ahead, anchor overlap, wait
// slack, diversity, back-to-back, rejection, seatability, staleness).
// The gate uses this so a bug in the engine search cannot hide.

import {
  countConsecutiveOpponentRepeats,
  getEffectiveLookback,
  isBackToBackRepeat,
  isDiversityViolation,
  isGroupValid,
  isRedZonePlayer,
  isRejectedRoster,
  pairKey,
  snakeDraft,
  type LastOpponents,
  type LastPartners,
  type MatchProposal,
  type ScoredPlayer,
} from "../../src/lib/matchmaking-core";
import {
  FRESHNESS_WAIT_SLACK_MINUTES,
  MAX_OPPONENT_REPEATS,
  MAX_PARTNERSHIP_REPEATS,
  SKILL_VARIANCE_MAX,
} from "../../src/lib/constants";

export type BruteArgs = {
  partnershipCounts: Map<string, number>;
  overlapMap: Map<string, number>;
  recentRosters: string[][];
  opponentCounts: Map<string, number>;
  rejectedRosters: string[][];
  lastOpponents: LastOpponents;
  lastPartners: LastPartners;
  waitSlackMinutes?: number;
};

function gamesAheadOf(player: ScoredPlayer, poolMinGames: number): number {
  if (player.isPulled) return 0;
  return Math.max(0, player.games_played - poolMinGames);
}

/** True when at least one ±2 four passes every freshness guard against `served`. */
export function hasAdmissibleFresherFour(
  pool: ScoredPlayer[],
  served: MatchProposal,
  args: BruteArgs
): boolean {
  if (pool.length < 4) return false;
  const anchor = pool[0];
  const servedFour = [...served.teamA, ...served.teamB];
  const servedIdSet = new Set(servedFour.map((p) => p.player_id));
  const poolMinGames = pool.reduce(
    (min, p) => (p.isPulled ? min : Math.min(min, p.games_played)),
    Infinity
  );
  const baselineGames = Number.isFinite(poolMinGames) ? poolMinGames : 0;
  const candidates = pool
    .slice(1)
    .filter(
      (c) =>
        (args.partnershipCounts.get(pairKey(anchor.player_id, c.player_id)) ?? 0) <
        MAX_PARTNERSHIP_REPEATS
    )
    .filter((c) => Math.abs(c.skill_level_int - anchor.skill_level_int) <= SKILL_VARIANCE_MAX);
  if (candidates.length < 3) return false;

  const activeRosters = args.recentRosters.slice(0, getEffectiveLookback(candidates.length + 1));
  const servedCompanions = servedFour.filter((p) => p.player_id !== anchor.player_id);
  const servedRedZone = servedFour.filter((p) => isRedZonePlayer(p));
  const servedGamesAhead = servedCompanions.reduce((s, p) => s + gamesAheadOf(p, baselineGames), 0);
  const servedOverlap = servedCompanions.reduce(
    (s, p) => s + (args.overlapMap.get(p.player_id) ?? 0),
    0
  );
  const servedWait = servedCompanions.reduce((s, p) => s + (p.wait_minutes ?? 0), 0);
  const servedStaleness = countConsecutiveOpponentRepeats(served, args.lastOpponents);
  const slack = args.waitSlackMinutes ?? FRESHNESS_WAIT_SLACK_MINUTES;

  const n = candidates.length;
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const triple = [candidates[i], candidates[j], candidates[k]];
        const four = [anchor, ...triple];
        if (triple.filter((c) => c.isPulled).length > 1) continue;
        if (!isGroupValid(four, SKILL_VARIANCE_MAX)) continue;
        const fourIds = four.map((p) => p.player_id);
        const fourIdSet = new Set(fourIds);
        if (fourIds.every((id) => servedIdSet.has(id))) continue;
        if (!servedRedZone.every((p) => fourIdSet.has(p.player_id))) continue;
        if (triple.reduce((s, p) => s + gamesAheadOf(p, baselineGames), 0) > servedGamesAhead) {
          continue;
        }
        if (
          triple.reduce((s, p) => s + (args.overlapMap.get(p.player_id) ?? 0), 0) > servedOverlap
        ) {
          continue;
        }
        if (triple.reduce((s, p) => s + (p.wait_minutes ?? 0), 0) < servedWait - slack) {
          continue;
        }
        if (isDiversityViolation(fourIds, activeRosters)) continue;
        if (isBackToBackRepeat(fourIds, args.lastOpponents, args.lastPartners)) continue;
        if (isRejectedRoster(fourIds, args.rejectedRosters)) continue;
        const draft = snakeDraft(
          four,
          args.partnershipCounts,
          MAX_PARTNERSHIP_REPEATS,
          args.opponentCounts,
          MAX_OPPONENT_REPEATS,
          args.lastOpponents,
          args.lastPartners
        );
        if (!draft || draft.usedCapOverride) continue;
        if (countConsecutiveOpponentRepeats(draft, args.lastOpponents) > servedStaleness) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}
