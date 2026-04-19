// ============================================================
// Matchmaking Core — Pure, database-free helper functions
// ============================================================
//
// All functions in this file are pure: they take data and return
// data with no side effects. This makes them directly unit-testable
// without mocking Supabase or Next.js server infrastructure.
//
// runAlgorithm() (in matchmaking.ts) composes these building blocks.
// ============================================================

import {
  CRITICAL_WAIT_MINUTES,
  GAME_PENALTY_MINUTES,
  RED_ZONE_SCORE_FLOOR,
} from "@/lib/constants";
import type { QueueWithWaitTime } from "@/types/database";

// ── Enriched player type ──────────────────────────────────────
// QueueWithWaitTime enriched with the computed priority score.
export type ScoredPlayer = QueueWithWaitTime & { priorityScore: number };

// ── ScoredCandidate ────────────────────────────────────────────
// A candidate paired with the composite sort score used to rank
// it during group assembly (lower = higher priority).
export type ScoredCandidate = {
  candidate: ScoredPlayer;
  score: number;
};

// ─────────────────────────────────────────────────────────────
// EXPORT: computePriorityScore
// ─────────────────────────────────────────────────────────────
// RED ZONE (wait ≥ 25 min): 1000 + waitMinutes → absolute urgency.
// NORMAL   (wait < 25 min): waitMinutes − (gamesPlayed × 12).
// Higher score = higher urgency.

export function computePriorityScore(player: QueueWithWaitTime): number {
  const wait = player.wait_minutes ?? 0;
  if (wait >= CRITICAL_WAIT_MINUTES) {
    return 1000 + wait; // Red Zone — ignore game debt entirely
  }
  return wait - player.games_played * GAME_PENALTY_MINUTES;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: isGroupValid
// ─────────────────────────────────────────────────────────────
// Returns true iff every pairwise skill difference in the group
// is within maxVariance. O(n²) — fine for n=4.

export function isGroupValid(
  players: ScoredPlayer[],
  maxVariance: number
): boolean {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (
        Math.abs(players[i].skill_level_int - players[j].skill_level_int) >
        maxVariance
      ) {
        return false;
      }
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: snakeDraft
// ─────────────────────────────────────────────────────────────
// Sort all 4 players DESC by skill, then:
//   Team A = [highest (pos 0) + lowest (pos 3)]
//   Team B = [2nd highest (pos 1) + 3rd highest (pos 2)]
// Snake distribution minimises aggregate skill gap between teams.

export function snakeDraft(allFour: ScoredPlayer[]): {
  teamA: ScoredPlayer[];
  teamB: ScoredPlayer[];
} {
  const sorted = [...allFour].sort(
    (a, b) => b.skill_level_int - a.skill_level_int
  );
  return {
    teamA: [sorted[0], sorted[3]],
    teamB: [sorted[1], sorted[2]],
  };
}

// ─────────────────────────────────────────────────────────────
// EXPORT: overlapWithRoster
// ─────────────────────────────────────────────────────────────
// Counts how many of playerIds appear in a single match roster.

export function overlapWithRoster(
  playerIds: string[],
  roster: string[]
): number {
  const rosterSet = new Set(roster);
  return playerIds.filter((id) => rosterSet.has(id)).length;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: isDiversityViolation
// ─────────────────────────────────────────────────────────────
// Returns true if ≥3 of the proposed 4 player IDs appeared
// together in any single recent match roster.

export function isDiversityViolation(
  playerIds: string[],
  recentRosters: string[][]
): boolean {
  // Build the Set once here so each roster check is O(n) rather than O(n²)
  // from constructing a new rosterSet inside overlapWithRoster per iteration.
  const playerSet = new Set(playerIds);
  for (const roster of recentRosters) {
    const overlap = roster.filter((id) => playerSet.has(id)).length;
    if (overlap >= 3) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: scoreCandidates   [FIX — Audit Rec #2]
// ─────────────────────────────────────────────────────────────
// Produces a sorted (ascending score = highest priority first)
// list of ScoredCandidates from the eligible pool.
//
// Formula:
//   Normal candidate:   score = -priorityScore + overlapCount × 10_000
//   Red Zone candidate: score = -priorityScore + overlapCount × 100
//
// Red Zone candidates (priorityScore ≥ 1000) have their overlap
// penalty capped at 100× instead of 10_000×. This guarantees that
// a Red Zone candidate with 1 overlap still sorts before a fresh
// Normal candidate:
//   Red Zone, 1 overlap:  -1030 + 100   = -930  → sorts first ✓
//   Normal,   0 overlap:  -2   + 0      = -2    → sorts after ✓
//
// The 10_000× multiplier is preserved for Normal candidates so
// anti-repeat logic still works as designed for non-urgent matches.

export function scoreCandidates(
  candidates: ScoredPlayer[],
  overlapMap: Map<string, number>
): ScoredCandidate[] {
  return candidates
    .map((c) => {
      const overlap = overlapMap.get(c.player_id) ?? 0;
      // Red Zone: cap overlap penalty so urgency always wins.
      const isRedZone = c.priorityScore >= RED_ZONE_SCORE_FLOOR;
      const overlapPenalty = isRedZone ? overlap * 100 : overlap * 10_000;
      return {
        candidate: c,
        score: -c.priorityScore + overlapPenalty,
      };
    })
    .sort((a, b) => a.score - b.score);
}

// ─────────────────────────────────────────────────────────────
// EXPORT: buildCombinationGroup   [FIX — Audit Rec #1]
// ─────────────────────────────────────────────────────────────
// Replaces the previous greedy approach with a full N-choose-3
// combination search. Because `scoredCandidates` is already sorted
// best-priority-first, the very first valid combination found
// IS the optimal group — so we break immediately on success.
//
// Why this fixes greedy trapping:
//   Greedy locks in the top-scored candidate immediately, then
//   fails to fill the group when that candidate is skill-
//   incompatible with the remaining pool.
//   Combination search considers ALL triples, so even if the
//   highest-priority candidate can't participate in a valid
//   group, we still find [candidates[1], [2], [3]] etc.
//
// Scale invariant: n is the size of the skill-filtered eligible
//   pool, bounded by the queue size (≤ ~30 players per session).
//   Worst case: C(30,3) = 4,060 iterations — still negligible at
//   runtime. If sessions grow beyond ~50 players, consider adding
//   a candidate pre-filter before this search.

export function buildCombinationGroup(
  anchor: ScoredPlayer,
  scoredCandidates: ScoredCandidate[],
  maxVariance: number
): ScoredPlayer[] {
  const n = scoredCandidates.length;
  if (n < 3) return [];

  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const combo: ScoredPlayer[] = [
          scoredCandidates[i].candidate,
          scoredCandidates[j].candidate,
          scoredCandidates[k].candidate,
        ];
        if (isGroupValid([anchor, ...combo], maxVariance)) {
          // Early exit — first valid triple in priority order IS optimal.
          return combo;
        }
      }
    }
  }

  return []; // No valid combination found within this skill window.
}

