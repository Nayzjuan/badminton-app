// ============================================================
// Matchmaking Core — Pure, database-free helper functions
// ============================================================
//
// All functions in this file are pure: they take data and return
// data with no side effects. This makes them directly unit-testable
// without mocking Supabase or Next.js server infrastructure.
//
// DB-coupled helpers (fetchActivePool, buildOverlapMap, etc.) and
// the executeMatch write live in matchmaking-db.ts.
//
// runAlgorithm() is the pure orchestration layer that composes the
// building blocks below. It accepts pre-fetched data and returns a
// MatchProposal (or null) with no side effects.
// ============================================================

import {
  CRITICAL_WAIT_MINUTES,
  FALLBACK_WAIT_MINUTES,
  GAME_PENALTY_MINUTES,
  MAX_PARTNERSHIP_REPEATS,
  RED_ZONE_SCORE_FLOOR,
  SKILL_VARIANCE_MAX,
  SKILL_VARIANCE_TARGET,
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
// EXPORT: pairKey
// ─────────────────────────────────────────────────────────────
// Canonical symmetric key for a same-team pair of player UUIDs.
// Sorts alphabetically so pairKey(a, b) === pairKey(b, a).
// Used by fetchPartnershipCounts (matchmaking.ts) and the pair-aware
// draft functions to look up session-scoped partnership counts.

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: computePriorityScore
// ─────────────────────────────────────────────────────────────
// RED ZONE (wait ≥ 25 min): 1000 + waitMinutes → absolute urgency.
// NORMAL   (wait < 25 min): max(0, waitMinutes − (gamesPlayed × 12)).
//   Floored at 0 so a player with game debt never scores below a
//   fresh joiner. Players in the same score bucket (both 0) are
//   further sorted by joined_at in runAlgorithm — earlier joiner wins.
// Higher score = higher urgency.

export function computePriorityScore(player: QueueWithWaitTime): number {
  const wait = player.wait_minutes ?? 0;
  if (wait >= CRITICAL_WAIT_MINUTES) {
    return 1000 + wait; // Red Zone — ignore game debt entirely
  }
  // Floor at 0: game debt holds you back but never drops you below
  // a brand-new joiner who has 0 wait time. The joined_at tiebreaker
  // in runAlgorithm resolves ties within the 0-score bucket.
  return Math.max(0, wait - player.games_played * GAME_PENALTY_MINUTES);
}

// ─────────────────────────────────────────────────────────────
// EXPORT: isGroupValid
// ─────────────────────────────────────────────────────────────
// Returns true iff every pairwise skill difference in the group
// is within maxVariance. O(n²) — fine for n=4.

export function isGroupValid(players: ScoredPlayer[], maxVariance: number): boolean {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (Math.abs(players[i].skill_level_int - players[j].skill_level_int) > maxVariance) {
        return false;
      }
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: snakeDraft
// ─────────────────────────────────────────────────────────────
// Sort all 4 players DESC by skill, then find the most skill-balanced
// team split that does not violate the partner-pair cap.
//
// The 3 splits tried in descending skill-balance order:
//   Split 0 — [0,3] vs [1,2]: highest+lowest vs 2nd+3rd (snake default, most balanced)
//   Split 2 — [0,2] vs [1,3]: alternating cross-split
//   Split 1 — [0,1] vs [2,3]: top pair vs bottom pair (least balanced)
//
// Returns null if every split puts at least one team pair at or above
// the cap — the caller must treat this as a slot failure and either
// try another candidate group or return no-match.
//
// When partnershipCounts / cap are omitted, the function behaves
// exactly as before (always returns the balanced Split 0).

export function snakeDraft(
  allFour: ScoredPlayer[],
  partnershipCounts?: Map<string, number>,
  cap?: number
): { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] } | null {
  const sorted = [...allFour].sort((a, b) => b.skill_level_int - a.skill_level_int);

  // Without cap enforcement, always return the balanced default.
  if (!partnershipCounts || cap === undefined) {
    return {
      teamA: [sorted[0], sorted[3]],
      teamB: [sorted[1], sorted[2]],
    };
  }

  // Try splits from most to least skill-balanced.
  const splits: Array<{ teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }> = [
    { teamA: [sorted[0], sorted[3]], teamB: [sorted[1], sorted[2]] },
    { teamA: [sorted[0], sorted[2]], teamB: [sorted[1], sorted[3]] },
    { teamA: [sorted[0], sorted[1]], teamB: [sorted[2], sorted[3]] },
  ];

  for (const split of splits) {
    const countA =
      partnershipCounts.get(pairKey(split.teamA[0].player_id, split.teamA[1].player_id)) ?? 0;
    const countB =
      partnershipCounts.get(pairKey(split.teamB[0].player_id, split.teamB[1].player_id)) ?? 0;
    if (countA < cap && countB < cap) return split;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: overlapWithRoster
// ─────────────────────────────────────────────────────────────
// Counts how many of playerIds appear in a single match roster.

export function overlapWithRoster(playerIds: string[], roster: string[]): number {
  const rosterSet = new Set(roster);
  return playerIds.filter((id) => rosterSet.has(id)).length;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: getEffectiveLookback
// ─────────────────────────────────────────────────────────────
// Scales the diversity lookback window to the size of the
// eligible pool available to the anchor player.
//
// Why: with a fixed lookback of 5, a small skill-tier group
// (e.g. only 4 advanced players in queue) exhausts its
// "fresh" combinations after 1–2 matches. Every subsequent
// attempt triggers a swap failure and accepts a repeat anyway.
// Shorter memory for smaller pools avoids that collapse while
// preserving strict diversity enforcement for large sessions.
//
// Thresholds (eligiblePoolSize = eligible candidates + anchor):
//   ≤ 5  → 2  (nearly isolated tier — only avoid the last match)
//   6–9  → 3  (small pool — today's Thursday-night scenario)
//   10–15 → 4  (medium pool)
//   16+  → 5  (full memory — current behaviour, unchanged)

export function getEffectiveLookback(eligiblePoolSize: number): number {
  if (eligiblePoolSize <= 5) return 2;
  if (eligiblePoolSize <= 9) return 3;
  if (eligiblePoolSize <= 15) return 4;
  return 5;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: isDiversityViolation
// ─────────────────────────────────────────────────────────────
// Returns true if ≥3 of the proposed 4 player IDs appeared
// together in any single recent match roster.

export function isDiversityViolation(playerIds: string[], recentRosters: string[][]): boolean {
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

// ─────────────────────────────────────────────────────────────
// EXPORT: rotatedDraft
// ─────────────────────────────────────────────────────────────
// Used when all swap paths are exhausted and the same 4 players
// must play again (forced repeat). Rather than always producing
// the identical snakeDraft split, this cycles through 3 possible
// team configurations based on how many times these 4 players
// have appeared together in recent match history.
//
// The 3 splits (sorted DESC by skill: positions [0,1,2,3]):
//   Split 0 — [0,3] vs [1,2]: highest+lowest vs 2nd+3rd  (snakeDraft default)
//   Split 1 — [0,1] vs [2,3]: top pair vs bottom pair
//   Split 2 — [0,2] vs [1,3]: alternating cross-split
//
// splitIndex = repeatCount % 3. When cap enforcement is active,
// the function tries splits starting from splitIndex, cycling
// through all 3, returning the first that satisfies the cap.
// Returns null if every split puts at least one team pair at or
// above the cap — the caller must treat this as a slot failure.
//
// When partnershipCounts / cap are omitted, behaviour is identical
// to before: always returns the split at splitIndex (never null).
//
// Limitation: recentRosters is bounded by ANTI_REPEAT_LOOKBACK (5),
// so repeatCount saturates at 5. After 5+ repeats the cycle may
// stall on split 2. The soft gate limits how often forced repeats
// occur, so this edge case is rare in practice.

export function rotatedDraft(
  allFour: ScoredPlayer[],
  recentRosters: string[][],
  partnershipCounts?: Map<string, number>,
  cap?: number
): { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] } | null {
  const sorted = [...allFour].sort((a, b) => b.skill_level_int - a.skill_level_int);

  // Count recent rosters that contained ALL 4 of these players.
  const playerIds = allFour.map((p) => p.player_id);
  const repeatCount = recentRosters.filter((roster) => {
    const rosterSet = new Set(roster);
    return playerIds.every((id) => rosterSet.has(id));
  }).length;

  const splitIndex = repeatCount % 3;

  // All 3 splits indexed to match the original switch semantics.
  const splits: Array<{ teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }> = [
    { teamA: [sorted[0], sorted[3]], teamB: [sorted[1], sorted[2]] }, // 0: snake default
    { teamA: [sorted[0], sorted[1]], teamB: [sorted[2], sorted[3]] }, // 1: top vs bottom
    { teamA: [sorted[0], sorted[2]], teamB: [sorted[1], sorted[3]] }, // 2: cross-split
  ];

  // Without cap enforcement, return the natural rotation split unconditionally.
  if (!partnershipCounts || cap === undefined) {
    return splits[splitIndex];
  }

  // With cap enforcement, try splits starting from the natural rotation index
  // and cycling through all 3. This preserves rotation semantics (the natural
  // split is always tried first) while falling back when it is capped.
  for (let i = 0; i < 3; i++) {
    const split = splits[(splitIndex + i) % 3];
    const countA =
      partnershipCounts.get(pairKey(split.teamA[0].player_id, split.teamA[1].player_id)) ?? 0;
    const countB =
      partnershipCounts.get(pairKey(split.teamB[0].player_id, split.teamB[1].player_id)) ?? 0;
    if (countA < cap && countB < cap) return split;
  }

  return null;
}

// ═════════════════════════════════════════════════════════════
// PURE ALGORITHM LAYER
// ═════════════════════════════════════════════════════════════
// scoreAndSortPool, runAlgorithm, MatchProposal, AlgorithmResult
//
// These are all pure functions — zero DB calls, zero side effects.
// matchmaking-db.ts fetches the inputs; matchmaking.ts orchestrates
// and commits the output via executeMatch.
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// EXPORT: MatchProposal
// ─────────────────────────────────────────────────────────────
// The decision output of runAlgorithm: which players, which teams,
// mixed-level flag. Does NOT include execution context (courtId,
// isOnDeck) — those are supplied to executeMatch by the orchestrator.

export type MatchProposal = {
  teamA: ScoredPlayer[];
  teamB: ScoredPlayer[];
  isMixedLevel: boolean;
};

// ─────────────────────────────────────────────────────────────
// EXPORT: AlgorithmResult
// ─────────────────────────────────────────────────────────────
// Returned by runAlgorithm. When proposal is null, capSaturation
// indicates whether the partnership cap (not a lack of players)
// was the reason no match could be formed. Callers use this to
// decide whether to broadcast a cap-saturation warning.

export type AlgorithmResult = {
  proposal: MatchProposal | null;
  /** True when the partnership cap shrank the candidate pool and no match was formed. */
  capSaturation: boolean;
};

// ─────────────────────────────────────────────────────────────
// EXPORT: scoreAndSortPool
// ─────────────────────────────────────────────────────────────
// Enriches each raw QueueWithWaitTime player with a priorityScore,
// then sorts descending so pool[0] is always the highest-urgency
// anchor for runAlgorithm.
//
// Kept separate from fetchActivePool (matchmaking-db.ts) so the
// DB helper stays a pure data-fetch and this step is independently
// testable with no Supabase mock.
// (QueueWithWaitTime is already imported at the top of this module.)

export function scoreAndSortPool(rawPool: QueueWithWaitTime[]): ScoredPlayer[] {
  return rawPool
    .map((p) => ({ ...p, priorityScore: computePriorityScore(p) }))
    .sort((a, b) => {
      const diff = b.priorityScore - a.priorityScore;
      if (Math.abs(diff) > 0.001) return diff;
      // Same score bucket → earlier joiner wins (joined_at ASC tiebreaker).
      return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
    });
}

// ─────────────────────────────────────────────────────────────
// EXPORT: runAlgorithm
// ─────────────────────────────────────────────────────────────
// Pure match-selection algorithm. Accepts pre-fetched, pre-scored,
// pre-sorted pool data and returns a MatchProposal (or null).
//
// pool[0] is the anchor (highest priority player).
// partnershipCounts, overlapMap, recentRosters are fetched by the
// orchestrator in matchmaking.ts and passed in.
//
// Pipeline:
//   1. Filter candidates: remove anchor + cap-blocked players
//   2. Progressive skill expansion: ±VARIANCE_TARGET → ±VARIANCE_MAX
//      (→ ±3, ±4 when anchor is Red Zone)
//   3. Per window: scoreCandidates → buildCombinationGroup
//      → diversity check → Tier-1 swap → Tier-2 expanded swap
//      → Tier-3 rotated draft → snakeDraft
//   4. Last-resort fallback (anchor wait > FALLBACK_WAIT_MINUTES)
//   5. No-match: return { proposal: null, capSaturation }

export function runAlgorithm(
  pool: ScoredPlayer[],
  partnershipCounts: Map<string, number>,
  overlapMap: Map<string, number>,
  recentRosters: string[][]
): AlgorithmResult {
  // pool must be pre-scored and pre-sorted (pool[0] = anchor).
  const anchor = pool[0];
  const anchorSkill = anchor.skill_level_int;
  const anchorWaitMinutes = anchor.wait_minutes ?? 0;
  const anchorIsRedZone = anchor.priorityScore >= RED_ZONE_SCORE_FLOOR;

  if (process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[matchmaking] anchor=${anchor.display_name} skill=${anchorSkill} ` +
        `wait=${anchorWaitMinutes.toFixed(1)}min priority=${anchor.priorityScore.toFixed(1)} ` +
        `redZone=${anchorIsRedZone} pool=${pool.length}`
    );
  }

  // ── 1. Build candidate list ───────────────────────────────
  // Pre-filter: remove anchor + any player who has already hit the
  // partnership cap with the anchor. This is the universal enforcement
  // point — it propagates through every downstream path.
  const candidates = pool
    .slice(1)
    .filter(
      (c) =>
        (partnershipCounts.get(pairKey(anchor.player_id, c.player_id)) ?? 0) <
        MAX_PARTNERSHIP_REPEATS
    );

  // Track whether the cap reduced the candidate pool.
  const capWasActive = pool.length - 1 > candidates.length;

  if (process.env.DEBUG_MATCHMAKING === "true") {
    const filtered = pool.length - 1 - candidates.length;
    if (filtered > 0) {
      console.log(
        `[matchmaking] Partner-cap pre-filter: removed ${filtered} candidate(s) at cap with anchor ${anchor.display_name}`
      );
    }
  }

  // ── 2. Build skill window list ────────────────────────────
  // Red Zone anchor: try ±1, ±2, ±3, ±4 to guarantee a match.
  // Normal anchor:   try ±1, ±2 only.
  const skillWindows = anchorIsRedZone
    ? [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX, 3, 4]
    : [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX];

  // ── 3. Progressive expansion ──────────────────────────────
  for (const maxVariance of skillWindows) {
    const eligible = candidates.filter(
      (c) => Math.abs(c.skill_level_int - anchorSkill) <= maxVariance
    );

    if (eligible.length < 3) {
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] ±${maxVariance} window: only ${eligible.length} eligible, need 3 — expanding`
        );
      }
      continue;
    }

    const effectiveLookback = getEffectiveLookback(eligible.length + 1);
    const activeRosters = recentRosters.slice(0, effectiveLookback);

    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] ±${maxVariance} window: pool=${eligible.length + 1} → lookback=${effectiveLookback}`
      );
    }

    const scored = scoreCandidates(eligible, overlapMap);
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    if (group.length === 3) {
      const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

      if (isDiversityViolation(proposedIds, activeRosters)) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] Diversity violation for [${group.map((g) => g.display_name).join(", ")}] — attempting swap`
          );
        }

        const swapTarget = group[2];
        if (swapTarget.priorityScore >= RED_ZONE_SCORE_FLOOR) {
          if (process.env.DEBUG_MATCHMAKING === "true") {
            console.warn(
              `[matchmaking] Swap target ${swapTarget.display_name} is Red Zone ` +
                `(score=${swapTarget.priorityScore.toFixed(1)}) — diversity swap skipped`
            );
          }
          // Fall through to snakeDraft with the original group.
        } else {
          // ── Tier 1: primary swap within current skill window ──────
          const fixedTwo = group.slice(0, 2);
          const alreadyInGroup = new Set(group.map((g) => g.player_id));
          const swapPool = scored.filter(
            ({ candidate }) => !alreadyInGroup.has(candidate.player_id)
          );

          for (const { candidate } of swapPool) {
            const swapGroup = [...fixedTwo, candidate];
            if (!isGroupValid([anchor, ...swapGroup], maxVariance)) continue;

            const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
            if (!isDiversityViolation(swappedIds, activeRosters)) {
              const draft = snakeDraft(
                [anchor, ...swapGroup],
                partnershipCounts,
                MAX_PARTNERSHIP_REPEATS
              );
              if (!draft) {
                if (process.env.DEBUG_MATCHMAKING === "true") {
                  console.log(
                    `[matchmaking] Tier-1 swap: all team splits capped for ${candidate.display_name} — skipping`
                  );
                }
                continue;
              }
              if (process.env.DEBUG_MATCHMAKING === "true") {
                console.log(
                  `[matchmaking] Tier-1 swap succeeded — replaced with ${candidate.display_name}`
                );
              }
              const isMixedSwap = maxVariance > SKILL_VARIANCE_MAX;
              return {
                proposal: { teamA: draft.teamA, teamB: draft.teamB, isMixedLevel: isMixedSwap },
                capSaturation: false,
              };
            }
          }

          // ── Tier 2: expanded swap at ±SKILL_VARIANCE_MAX ──────────
          if (swapPool.length === 0 && maxVariance < SKILL_VARIANCE_MAX) {
            const widerEligible = candidates.filter(
              (c) =>
                Math.abs(c.skill_level_int - anchorSkill) <= SKILL_VARIANCE_MAX &&
                !alreadyInGroup.has(c.player_id)
            );

            if (widerEligible.length > 0) {
              const widerScored = scoreCandidates(widerEligible, overlapMap);
              for (const { candidate } of widerScored) {
                const swapGroup = [...fixedTwo, candidate];
                if (!isGroupValid([anchor, ...swapGroup], SKILL_VARIANCE_MAX)) continue;

                const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
                if (!isDiversityViolation(swappedIds, activeRosters)) {
                  const draft = snakeDraft(
                    [anchor, ...swapGroup],
                    partnershipCounts,
                    MAX_PARTNERSHIP_REPEATS
                  );
                  if (!draft) {
                    if (process.env.DEBUG_MATCHMAKING === "true") {
                      console.log(
                        `[matchmaking] Tier-2 expanded swap: all team splits capped for ${candidate.display_name} — skipping`
                      );
                    }
                    continue;
                  }
                  if (process.env.DEBUG_MATCHMAKING === "true") {
                    console.log(
                      `[matchmaking] Tier-2 expanded swap (±${SKILL_VARIANCE_MAX}) — replaced with ${candidate.display_name}`
                    );
                  }
                  return {
                    proposal: { teamA: draft.teamA, teamB: draft.teamB, isMixedLevel: false },
                    capSaturation: false,
                  };
                }
              }
            }
          }

          // ── Tier 3: partner rotation ───────────────────────────────
          const isMixedRotation = maxVariance > SKILL_VARIANCE_MAX;
          const rotatedResult = rotatedDraft(
            [anchor, ...group],
            recentRosters,
            partnershipCounts,
            MAX_PARTNERSHIP_REPEATS
          );
          if (!rotatedResult) {
            if (process.env.DEBUG_MATCHMAKING === "true") {
              console.warn(
                "[matchmaking] Tier-3 rotation: all team splits capped — expanding skill window"
              );
            }
            continue;
          }
          console.warn(
            "[matchmaking] No diverse swap found — applying partner rotation (forced repeat)"
          );
          return {
            proposal: {
              teamA: rotatedResult.teamA,
              teamB: rotatedResult.teamB,
              isMixedLevel: isMixedRotation,
            },
            capSaturation: false,
          };
        }
      }

      const isMixed = maxVariance > SKILL_VARIANCE_MAX;
      const allFour = [anchor, ...group];
      const draft = snakeDraft(allFour, partnershipCounts, MAX_PARTNERSHIP_REPEATS);
      if (!draft) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] ±${maxVariance} window: group valid but all team splits capped — expanding`
          );
        }
        continue;
      }
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] ±${maxVariance} window: matched [${group.map((g) => g.display_name).join(", ")}]` +
            (isMixed ? " (mixed level)" : "")
        );
      }
      return {
        proposal: { teamA: draft.teamA, teamB: draft.teamB, isMixedLevel: isMixed },
        capSaturation: false,
      };
    }

    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] ±${maxVariance} window: only built group of ${group.length} — expanding`
      );
    }
  }

  // ── 4. Last-resort fallback (anchor wait > FALLBACK_WAIT_MINUTES) ──
  // Skips skill validation entirely. Always flagged isMixedLevel=true.
  // Only fires when ALL skill-window expansion passes fail.
  if (anchorWaitMinutes > FALLBACK_WAIT_MINUTES) {
    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] LAST-RESORT FALLBACK — anchor waited ${anchorWaitMinutes.toFixed(1)}min > ${FALLBACK_WAIT_MINUTES}min`
      );
    }
    const scoredFallback = scoreCandidates(candidates, overlapMap);
    const fallbackGroup = scoredFallback.slice(0, 3).map((s) => s.candidate);

    if (fallbackGroup.length >= 3) {
      const allFour = [anchor, ...fallbackGroup];
      const draft = snakeDraft(allFour, partnershipCounts, MAX_PARTNERSHIP_REPEATS);
      if (draft) {
        return {
          proposal: { teamA: draft.teamA, teamB: draft.teamB, isMixedLevel: true },
          capSaturation: false,
        };
      }
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log("[matchmaking] LAST-RESORT FALLBACK: all team splits capped — no match formed");
      }
    }
  }

  // ── 5. No match ───────────────────────────────────────────────────
  // capSaturation: true tells the orchestrator to broadcast a warning
  // to the organizer. Broadcast itself is a side effect handled there.
  return { proposal: null, capSaturation: capWasActive };
}
