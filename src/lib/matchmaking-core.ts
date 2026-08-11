// ============================================================
// Matchmaking Core — Pure, database-free helper functions
// ============================================================
//
// All functions in this file are pure: they take data and return
// data with no side effects. This makes them directly unit-testable
// without mocking Supabase or Next.js server infrastructure.
//
// DB-coupled helpers (fetchActivePool, fetchSessionMatchSnapshot, etc.)
// and the executeMatch write live in matchmaking-db.ts. The diversity
// projections that read that snapshot (deriveRecentRosters,
// derivePairCounts, deriveOverlapMap) are pure, but live beside it there
// because the snapshot shape is theirs.
//
// runAlgorithm() is the pure orchestration layer that composes the
// building blocks below. It accepts pre-fetched data and returns a
// MatchProposal (or null) with no side effects.
// ============================================================

import {
  CRITICAL_WAIT_MINUTES,
  DRAFT_CAP_LARGE_THRESHOLD,
  DRAFT_CAP_XLARGE_THRESHOLD,
  FALLBACK_WAIT_MINUTES,
  GAME_PENALTY_MINUTES,
  GAMES_AHEAD_PENALTY,
  GAMES_AHEAD_PENALTY_RED_ZONE,
  HARD_CAP_GAMES_CEILING,
  HARD_CAP_SCORE_FLOOR,
  HARD_WAIT_CAP_MINUTES,
  MAX_AUTO_DRAFTS,
  MAX_AUTO_DRAFTS_LARGE,
  MAX_AUTO_DRAFTS_XLARGE,
  MAX_CONSECUTIVE_GAMES_FOR_PULL,
  MAX_OPPONENT_REPEATS,
  MAX_PARTNERSHIP_REPEATS,
  RED_ZONE_SCORE_FLOOR,
  RED_ZONE_SKILL_VARIANCE_MAX,
  ROSTER_LOOKBACK_COUNT,
  SKILL_VARIANCE_MAX,
  SKILL_VARIANCE_TARGET,
} from "@/lib/constants";
import type { QueueWithWaitTime } from "@/types/database";

// ─────────────────────────────────────────────────────────────
// Draft cap helper
// ─────────────────────────────────────────────────────────────

/**
 * Returns the draft review queue cap based on the number of waiting players.
 *
 *  < 25 waiting → 3  (small session)
 *  25–29        → 5  (medium session)
 *  ≥ 30         → 6  (large session)
 *
 * Lives here (not in matchmaking.ts) because `"use server"` files require every
 * exported function to be async — a synchronous export causes a Turbopack build
 * error. As a pure, side-effect-free utility it belongs in matchmaking-core.ts.
 */
export function getDynamicDraftCap(waitingCount: number): number {
  if (waitingCount >= DRAFT_CAP_XLARGE_THRESHOLD) return MAX_AUTO_DRAFTS_XLARGE;
  if (waitingCount >= DRAFT_CAP_LARGE_THRESHOLD) return MAX_AUTO_DRAFTS_LARGE;
  return MAX_AUTO_DRAFTS;
}

/**
 * The `is_published` value an engine-generated match should be created with,
 * given the session's auto-publish mode.
 *
 *   auto_publish = false → false (DRAFT — organizer must review then publish)
 *   auto_publish = true  → true  (skip the gate — match goes straight to On Deck)
 *
 * Also dictates which pending matches the cap counts: in draft mode the cap
 * limits the unpublished REVIEW queue (is_published=false); in auto mode it
 * limits the published ON-DECK queue (is_published=true). Both are the same
 * boolean, so callers can use this single value for the count filter too.
 */
export function shouldAutoPublishMatch(autoPublish: boolean): boolean {
  return autoPublish === true;
}

// ── Enriched player type ──────────────────────────────────────
// QueueWithWaitTime enriched with the computed priority score.
export type ScoredPlayer = QueueWithWaitTime & {
  priorityScore: number;
  /**
   * True = a currently-PLAYING body eligible to be pulled into a held draft
   * (Cross-Court Diversity Drafting). fetchPullablePlayers sets priorityScore
   * to -1 on these so a pulled body never out-anchors a waiting player (C-3).
   */
  isPulled?: boolean;
  /**
   * started_at of the pulled body's current in_progress match — used by
   * pickEarliestFinishing as the court-preference tiebreak (N-3).
   */
  currentMatchStartedAt?: string;
};

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
// Used by derivePairCounts (matchmaking-db.ts) and the pair-aware draft
// functions to look up session-scoped partnership counts.

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: computePriorityScore
// ─────────────────────────────────────────────────────────────
// Three-tier urgency formula (higher score = higher urgency):
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │  TIER 3 — HARD CAP  (score ≥ 2000)                                  │
// │  Condition: wait ≥ HARD_WAIT_CAP_MINUTES (25)                       │
// │          AND games_played < HARD_CAP_GAMES_CEILING (5)              │
// │  Score: HARD_CAP_SCORE_FLOOR + (wait − 25) × 10                     │
// │  Progressive: longest-waiting cap-eligible player always leads.      │
// │  The games ceiling prevents session-target players from using the    │
// │  override to accumulate extra games at the expense of under-served   │
// │  players.                                                            │
// ├─────────────────────────────────────────────────────────────────────┤
// │  TIER 2 — RED ZONE  (score nominally 1000–1999)                     │
// │  Condition: wait ≥ CRITICAL_WAIT_MINUTES (20)                       │
// │  Score: RED_ZONE_SCORE_FLOOR (1000) + wait − (games × PENALTY)      │
// │  Game penalty still differentiates within Red Zone — fewer-games    │
// │  players preferred even when both are urgent.                        │
// │  ⚠ When game debt > wait, the actual score can fall below 1000       │
// │  (e.g. wait=20, games=5 → 1000+20−40=980). Downstream consumers     │
// │  (scoreCandidates, runAlgorithm) re-detect Red Zone by testing       │
// │  priorityScore ≥ RED_ZONE_SCORE_FLOOR, so those players receive      │
// │  Normal treatment (10_000× overlap penalty, tight skill window).     │
// │  This is intentional: players well above the fair-share games target │
// │  benefit less from Red Zone urgency because their wait is self-      │
// │  caused by dense play rather than queue starvation.                  │
// ├─────────────────────────────────────────────────────────────────────┤
// │  TIER 1 — NORMAL  (score unbounded below 1000)                      │
// │  Score: wait − (games × GAME_PENALTY_MINUTES)                       │
// │  NO floor at 0 — negative scores let game count drive ordering      │
// │  even when everyone has been waiting a similar time.                │
// └─────────────────────────────────────────────────────────────────────┘
//
// Invariants:
//   Hard Cap > Red Zone > Normal for any realistic game counts / waits.
//   Hard Cap progressive: max(RedZone) ≈ 1000+60−0 = 1060 ≪ 2000 (floor).
//   Red Zone beats Normal: 1000+20−(5×8)=980 > 19−0=19 (best Normal).
//   Worst-case Red Zone score: 1000+20−(13×8)=916 ≫ 19 → invariant holds.

export function computePriorityScore(player: QueueWithWaitTime): number {
  const wait = player.wait_minutes ?? 0;

  // ── Tier 3: Hard Wait Cap ────────────────────────────────────
  // Fires when a player has been waiting long enough that fairness demands
  // service regardless of other players' game counts. Progressive scoring
  // prevents flat-score ties, so the longest-waiting eligible player always
  // leads without needing a separate tiebreaker.
  if (player.games_played < HARD_CAP_GAMES_CEILING && wait >= HARD_WAIT_CAP_MINUTES) {
    return HARD_CAP_SCORE_FLOOR + Math.round((wait - HARD_WAIT_CAP_MINUTES) * 10);
  }

  const gamePenalty = player.games_played * GAME_PENALTY_MINUTES;

  // ── Tier 2: Red Zone ─────────────────────────────────────────
  // Urgency boost ensures Red Zone players always anchor over Normal-queue
  // players. Game penalty still applied so fewer-games players are preferred.
  if (wait >= CRITICAL_WAIT_MINUTES) {
    return RED_ZONE_SCORE_FLOOR + wait - gamePenalty;
  }

  // ── Tier 1: Normal ───────────────────────────────────────────
  // Unbounded below — game count can push score negative, letting players
  // with fewer games naturally rise above burst players at the same wait.
  return wait - gamePenalty;
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
//
// opponentCounts / opponentCap: when supplied, the engine PREFERS splits
// where no cross-net pair is at the opponent cap (soft preference — never
// a hard block so the engine cannot stall on small sessions).
//
// BALANCE GATE (anti-repeat vs balance priority inversion fix):
// The 4-pass freshness search runs over the MOST skill-balanced splits
// first, and only falls through to less-balanced splits when every
// balanced split is at the partnership cap. Previously freshness was the
// outer gate, so once all cross-tier pairings had been used once, the
// engine would "prefer" a fresh high+high vs low+low split (INT+INT vs
// BEG+BEG) over repeating a within-cap balanced pairing. A within-cap
// repeat on balanced teams always beats a fresh-but-lopsided match.
// `usedLopsidedFallback: true` on the result signals that only a
// less-balanced split was available — the caller (runAlgorithm) uses it
// to try a different 4th body before accepting the lopsided teams.

export type SnakeDraftResult = {
  teamA: ScoredPlayer[];
  teamB: ScoredPlayer[];
  /** True when every most-balanced split was partnership-capped and a
   *  less-balanced split was returned to prevent a stall. */
  usedLopsidedFallback?: boolean;
};

// Skill gap between the two teams of a split — 0 means perfectly balanced.
function splitSkillGap(split: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }): number {
  return Math.abs(
    split.teamA[0].skill_level_int +
      split.teamA[1].skill_level_int -
      (split.teamB[0].skill_level_int + split.teamB[1].skill_level_int)
  );
}

export function snakeDraft(
  allFour: ScoredPlayer[],
  partnershipCounts?: Map<string, number>,
  cap?: number,
  opponentCounts?: Map<string, number>,
  opponentCap?: number
): SnakeDraftResult | null {
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

  // Partition by balance: the freshness passes must never trade team
  // balance away just to avoid a within-cap partnership repeat. Splits
  // within SKILL_VARIANCE_MAX of the best gap still count as balanced —
  // that keeps the fresh-pair preference alive between near-equal splits
  // (e.g. skills 6/5/4/3: Split 2's gap of 2 is acceptable) while
  // demoting genuinely lopsided ones (e.g. 4/4/1/1: high+high vs
  // low+low has gap 6 and only ever fires as a stall-prevention
  // fallback).
  const minGap = Math.min(...splits.map(splitSkillGap));
  const balancedSplits = splits.filter((s) => splitSkillGap(s) <= minGap + SKILL_VARIANCE_MAX);
  const lopsidedSplits = splits.filter((s) => splitSkillGap(s) > minGap + SKILL_VARIANCE_MAX);

  // Helper: true when no cross-net pair is at or above the opponent cap.
  // Always returns true when opponentCounts / opponentCap are absent.
  const crossNetOk = (split: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }): boolean => {
    if (!opponentCounts || opponentCap === undefined) return true;
    return !split.teamA.some((a) =>
      split.teamB.some(
        (b) => (opponentCounts.get(pairKey(a.player_id, b.player_id)) ?? 0) >= opponentCap
      )
    );
  };

  const pairCount = (a: ScoredPlayer, b: ScoredPlayer): number =>
    partnershipCounts.get(pairKey(a.player_id, b.player_id)) ?? 0;

  // 4-pass freshness search over one pool of splits (ordered most→least balanced):
  //   1a: both team pairs fresh (count=0) AND no cross-net pair at cap.
  //   1b: both team pairs fresh — relax opponent cap.
  //   2a: below partnership cap AND no cross-net pair at cap.
  //   2b: below partnership cap only — last resort to prevent stalls.
  const findSplit = (
    pool: Array<{ teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }>
  ): { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] } | null => {
    for (const split of pool) {
      if (
        pairCount(split.teamA[0], split.teamA[1]) === 0 &&
        pairCount(split.teamB[0], split.teamB[1]) === 0 &&
        crossNetOk(split)
      )
        return split;
    }
    for (const split of pool) {
      if (
        pairCount(split.teamA[0], split.teamA[1]) === 0 &&
        pairCount(split.teamB[0], split.teamB[1]) === 0
      )
        return split;
    }
    for (const split of pool) {
      if (
        pairCount(split.teamA[0], split.teamA[1]) < cap &&
        pairCount(split.teamB[0], split.teamB[1]) < cap &&
        crossNetOk(split)
      )
        return split;
    }
    for (const split of pool) {
      if (
        pairCount(split.teamA[0], split.teamA[1]) < cap &&
        pairCount(split.teamB[0], split.teamB[1]) < cap
      )
        return split;
    }
    return null;
  };

  const balanced = findSplit(balancedSplits);
  if (balanced) return balanced;

  // Every balanced split is partnership-capped — fall through to a less
  // balanced split rather than stalling, but flag it so the caller can
  // try a different 4th body first.
  const lopsided = findSplit(lopsidedSplits);
  if (lopsided) return { ...lopsided, usedLopsidedFallback: true };

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
//   16+  → 7  (large session — ROSTER_LOOKBACK_COUNT=10 is now fetched so
//              lookback can safely exceed the old ANTI_REPEAT_LOOKBACK=5)

export function getEffectiveLookback(eligiblePoolSize: number): number {
  if (eligiblePoolSize <= 5) return 2;
  if (eligiblePoolSize <= 9) return 3;
  if (eligiblePoolSize <= 15) return 4;
  // Math.min guards against ROSTER_LOOKBACK_COUNT shrinking below 7 in the future.
  return Math.min(7, ROSTER_LOOKBACK_COUNT);
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
// EXPORT: isRejectedRoster
// ─────────────────────────────────────────────────────────────
// Rejection memory. Returns true only when the proposed four is the EXACT
// set an organizer recently cleared (order/team-split insensitive).
//
// Deliberately stricter than isDiversityViolation's ≥3 overlap: a 3-of-4
// recombination is precisely the "different hand" the swap ladder should
// produce after a rejection (observed live: the organizer's own manual fix
// after a clear kept 3 of the 4 bodies and recombined them). Matching on
// ≥3 would ban that outcome and stall small pools.

export function isRejectedRoster(playerIds: string[], rejectedRosters: string[][]): boolean {
  if (rejectedRosters.length === 0) return false;
  const playerSet = new Set(playerIds);
  return rejectedRosters.some(
    (roster) => roster.length === playerSet.size && roster.every((id) => playerSet.has(id))
  );
}

// ─────────────────────────────────────────────────────────────
// EXPORT: scoreCandidates   [FIX — Audit Rec #2]
// ─────────────────────────────────────────────────────────────
// Produces a sorted (ascending score = highest priority first)
// list of ScoredCandidates from the eligible pool.
//
// Formula:
//   Normal candidate:   score = -priorityScore + overlapCount × 10_000
//                               + gamesAhead × GAMES_AHEAD_PENALTY
//   Red Zone candidate: score = -priorityScore + overlapCount × 100
//                               + gamesAhead × GAMES_AHEAD_PENALTY_RED_ZONE
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
//
// Fresh-first rule (early-session diversity): when `poolMinGames` is
// supplied, each candidate is additionally penalised per game they are
// AHEAD of the pool minimum. Post-round-1 this pushes never-played (or
// least-played) waiting players to the front of the candidate order, so
// buildCombinationGroup — which takes the first skill-valid triple —
// naturally drafts the freshest cohort instead of recycling just-played
// alumni. Red Zone candidates use the small capped variant so urgency
// still outranks freshness. Omitting poolMinGames (or a pool where all
// games are equal, e.g. t=0) leaves behaviour exactly as before.

export function scoreCandidates(
  candidates: ScoredPlayer[],
  overlapMap: Map<string, number>,
  poolMinGames?: number
): ScoredCandidate[] {
  return candidates
    .map((c) => {
      const overlap = overlapMap.get(c.player_id) ?? 0;
      // Red Zone: cap overlap penalty so urgency always wins.
      const isRedZone = c.priorityScore >= RED_ZONE_SCORE_FLOOR;
      const overlapPenalty = isRedZone ? overlap * 100 : overlap * 10_000;
      // Fresh-first: penalise games above the pool minimum (never negative —
      // a candidate below the supplied minimum simply gets no penalty).
      // Pulled bodies are exempt: their ordering is governed entirely by
      // priorityScore -1 (C-3 — last-resort filler, always sorts behind
      // waiting players), and their mid-game games_played reads one low,
      // which would otherwise let them jump ahead of equally-fresh waiters.
      const gamesAhead =
        poolMinGames === undefined || c.isPulled ? 0 : Math.max(0, c.games_played - poolMinGames);
      const gamesAheadPenalty = isRedZone
        ? gamesAhead * GAMES_AHEAD_PENALTY_RED_ZONE
        : gamesAhead * GAMES_AHEAD_PENALTY;
      return {
        candidate: c,
        score: -c.priorityScore + overlapPenalty + gamesAheadPenalty,
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
        // Cross-court (N-1): at most ONE pulled (still-playing) body per match.
        // The anchor is never pulled (C-3), so capping the triple caps the four.
        if (combo.filter((c) => c.isPulled).length > 1) continue;
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
// opponentCounts / opponentCap: same soft-preference semantics as in
// snakeDraft — used to avoid repeated cross-net matchups within rotations.
//
// Limitation: recentRosters is bounded by ROSTER_LOOKBACK_COUNT (10),
// so repeatCount saturates at 10. The soft gate limits how often forced
// repeats occur, so hitting the saturation ceiling is rare in practice.

export function rotatedDraft(
  allFour: ScoredPlayer[],
  recentRosters: string[][],
  partnershipCounts?: Map<string, number>,
  cap?: number,
  opponentCounts?: Map<string, number>,
  opponentCap?: number
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

  // Helper: true when no cross-net pair is at or above opponentCap.
  const crossNetOk = (split: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }): boolean => {
    if (!opponentCounts || opponentCap === undefined) return true;
    return !split.teamA.some((a) =>
      split.teamB.some(
        (b) => (opponentCounts.get(pairKey(a.player_id, b.player_id)) ?? 0) >= opponentCap
      )
    );
  };

  // Pass 1a: both team pairs fresh AND no cross-net pair at cap, from natural rotation.
  for (let i = 0; i < 3; i++) {
    const split = splits[(splitIndex + i) % 3];
    const countA =
      partnershipCounts.get(pairKey(split.teamA[0].player_id, split.teamA[1].player_id)) ?? 0;
    const countB =
      partnershipCounts.get(pairKey(split.teamB[0].player_id, split.teamB[1].player_id)) ?? 0;
    if (countA === 0 && countB === 0 && crossNetOk(split)) return split;
  }

  // Pass 1b: both team pairs fresh — relax opponent cap.
  for (let i = 0; i < 3; i++) {
    const split = splits[(splitIndex + i) % 3];
    const countA =
      partnershipCounts.get(pairKey(split.teamA[0].player_id, split.teamA[1].player_id)) ?? 0;
    const countB =
      partnershipCounts.get(pairKey(split.teamB[0].player_id, split.teamB[1].player_id)) ?? 0;
    if (countA === 0 && countB === 0) return split;
  }

  // Pass 2a: below partnership cap AND no cross-net pair at cap.
  for (let i = 0; i < 3; i++) {
    const split = splits[(splitIndex + i) % 3];
    const countA =
      partnershipCounts.get(pairKey(split.teamA[0].player_id, split.teamA[1].player_id)) ?? 0;
    const countB =
      partnershipCounts.get(pairKey(split.teamB[0].player_id, split.teamB[1].player_id)) ?? 0;
    if (countA < cap && countB < cap && crossNetOk(split)) return split;
  }

  // Pass 2b: below partnership cap only — last resort to prevent stalls.
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
// CROSS-COURT DIVERSITY DRAFTING — pure helpers
// ═════════════════════════════════════════════════════════════
// See CROSS_COURT_DRAFTING_PLAN.md. These are DB-free and unit-tested in
// matchmaking-core.test.ts. The DB-coupled side (fetchPullablePlayers,
// recomputeHeldReadiness) lives in matchmaking-db.ts / matchmaking.ts.

/** Context for pull eligibility, computed by fetchPullablePlayers (DB layer). */
export type PullEligibilityOpts = {
  /** Consecutive back-to-back games the body is currently on (pulled games count). */
  streak: number;
  /** True if the body is already reserved in another pending held draft. */
  alreadyHeld: boolean;
};

/**
 * Whether a currently-playing body may be pulled into a held draft. Relational
 * cooldown only (R3-C): a body on a streak >= MAX_CONSECUTIVE_GAMES_FOR_PULL is
 * excluded, as is one already reserved in another held draft.
 *
 * N-4: deliberately NO skill-window check here — fetchPullablePlayers runs before
 * the anchor is known, so skill compatibility is left entirely to runAlgorithm.
 */
export function isPullEligible(_player: QueueWithWaitTime, opts: PullEligibilityOpts): boolean {
  if (opts.alreadyHeld) return false;
  return opts.streak < MAX_CONSECUTIVE_GAMES_FOR_PULL;
}

/** Inputs for the held-draft readiness predicate (all injected for determinism). */
export type HeldReadinessInput = {
  /** completed_at of the pulled body's source match; null = still playing. */
  pulledFreedAt: string | null;
  /** Matches promoted (got a started_at) since the body freed. */
  promotionsSinceFreed: number;
  /** Current time, ms epoch. */
  now: number;
  /** Rest-timer fallback, ms (CROSS_COURT_REST_FALLBACK_MINUTES * 60_000). */
  restFallbackMs: number;
};

/**
 * A held draft is promotable iff its pulled body is free AND either at least one
 * other match has promoted since it freed, OR the rest-timer fallback has elapsed
 * (decision 6). A still-playing body (pulledFreedAt === null) is never ready.
 */
export function isHeldMatchReady(input: HeldReadinessInput): boolean {
  if (input.pulledFreedAt === null) return false;
  if (input.promotionsSinceFreed >= 1) return true;
  const elapsedMs = input.now - new Date(input.pulledFreedAt).getTime();
  return elapsedMs >= input.restFallbackMs;
}

/**
 * Court-preference tiebreak (N-3): among equally-good pulled candidates, prefer
 * the one whose current game STARTED EARLIEST (closest to finishing). This is a
 * tiebreak used when composing the single pulled slot — NOT a global pre-sort
 * (that would override best-fit). Deterministic final tiebreak on player_id.
 */
export function pickEarliestFinishing(candidates: ScoredPlayer[]): ScoredPlayer | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const ta = a.currentMatchStartedAt ? new Date(a.currentMatchStartedAt).getTime() : Infinity;
    const tb = b.currentMatchStartedAt ? new Date(b.currentMatchStartedAt).getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0;
  })[0];
}

// Internal: keep at most one pulled body in a candidate list (order-preserving).
// Belt-and-suspenders for the last-resort fallback path (buildCombinationGroup
// already caps the primary path at one pulled).
function limitPulledToOne(candidates: ScoredPlayer[]): ScoredPlayer[] {
  let taken = false;
  return candidates.filter((c) => {
    if (!c.isPulled) return true;
    if (taken) return false;
    taken = true;
    return true;
  });
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
  /**
   * True ONLY when the proposal is a forced repeat — the Tier-3 partner rotation
   * or the last-resort fallback (a recent group re-emitted). The cross-court
   * engine path triggers off this. Absent (falsy) on Tier-1/Tier-2/normal matches
   * and on no-match.
   */
  forcedRepeat?: boolean;
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
      // wait_minutes is a float (EXTRACT(EPOCH)/60), so priorityScore can carry
      // sub-millisecond FP noise. Treat differences < 0.001 min (~0.06 s) as
      // equal and fall through to the joined_at tiebreaker.
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
  recentRosters: string[][],
  opponentCounts: Map<string, number> = new Map(),
  // Rejection memory: rosters the organizer recently CLEARED. An exact re-deal
  // of a cleared four is treated like a diversity violation so the swap ladder
  // steers to a 3-of-4 recombination. Fail-open by design — every escape hatch
  // (Red-Zone swap target, Tier-3 rotation, last-resort fallback) still serves
  // the same four rather than stalling the queue.
  rejectedRosters: string[][] = []
): AlgorithmResult {
  // pool must be pre-scored and pre-sorted (pool[0] = anchor).
  const anchor = pool[0];
  const anchorSkill = anchor.skill_level_int;
  const anchorWaitMinutes = anchor.wait_minutes ?? 0;
  const anchorIsRedZone = anchor.priorityScore >= RED_ZONE_SCORE_FLOOR;

  // Fresh-first baseline: the fewest games played by any WAITING player in
  // the pool. scoreCandidates penalises candidates per game ABOVE this
  // minimum so the freshest waiting cohort is drafted first (see
  // GAMES_AHEAD_PENALTY). Pulled (still-playing) bodies are excluded from
  // the baseline: their games_played reads one low mid-game (it increments
  // only at completion), which would drop the baseline and penalise every
  // genuinely-fresh waiting candidate in the cross-court augmented run.
  const poolMinGames = pool.reduce(
    (min, p) => (p.isPulled ? min : Math.min(min, p.games_played)),
    Infinity
  );

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
    ? [
        SKILL_VARIANCE_TARGET,
        SKILL_VARIANCE_MAX,
        SKILL_VARIANCE_MAX + 1,
        RED_ZONE_SKILL_VARIANCE_MAX,
      ]
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

    const scored = scoreCandidates(eligible, overlapMap, poolMinGames);
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    if (group.length === 3) {
      const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

      if (
        isDiversityViolation(proposedIds, activeRosters) ||
        isRejectedRoster(proposedIds, rejectedRosters)
      ) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] Diversity/rejection violation for [${group.map((g) => g.display_name).join(", ")}] — attempting swap`
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
            if (
              !isDiversityViolation(swappedIds, activeRosters) &&
              !isRejectedRoster(swappedIds, rejectedRosters)
            ) {
              const draft = snakeDraft(
                [anchor, ...swapGroup],
                partnershipCounts,
                MAX_PARTNERSHIP_REPEATS,
                opponentCounts,
                MAX_OPPONENT_REPEATS
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
              const widerScored = scoreCandidates(widerEligible, overlapMap, poolMinGames);
              for (const { candidate } of widerScored) {
                const swapGroup = [...fixedTwo, candidate];
                if (!isGroupValid([anchor, ...swapGroup], SKILL_VARIANCE_MAX)) continue;

                const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
                if (
                  !isDiversityViolation(swappedIds, activeRosters) &&
                  !isRejectedRoster(swappedIds, rejectedRosters)
                ) {
                  const draft = snakeDraft(
                    [anchor, ...swapGroup],
                    partnershipCounts,
                    MAX_PARTNERSHIP_REPEATS,
                    opponentCounts,
                    MAX_OPPONENT_REPEATS
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
            MAX_PARTNERSHIP_REPEATS,
            opponentCounts,
            MAX_OPPONENT_REPEATS
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
            forcedRepeat: true, // Tier-3 partner rotation = a forced repeat (cross-court trigger)
          };
        }
      }

      const isMixed = maxVariance > SKILL_VARIANCE_MAX;
      const allFour = [anchor, ...group];
      let draft = snakeDraft(
        allFour,
        partnershipCounts,
        MAX_PARTNERSHIP_REPEATS,
        opponentCounts,
        MAX_OPPONENT_REPEATS
      );
      if (!draft) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] ±${maxVariance} window: group valid but all team splits capped — expanding`
          );
        }
        continue;
      }

      // ── Balance-preserving swap (Fix B) ─────────────────────────
      // snakeDraft only returns a lopsided split when every balanced
      // split of THIS group is partnership-capped. Before accepting
      // high+high vs low+low teams, try replacing each member of the
      // trio with another eligible candidate — a different 4th body
      // usually restores a fresh balanced pairing. Constraints mirror
      // the main path: skill window, ≤1 pulled body, diversity.
      if (draft.usedLopsidedFallback) {
        const inGroup = new Set(allFour.map((p) => p.player_id));
        balanceSwap: for (const { candidate } of scored) {
          if (inGroup.has(candidate.player_id)) continue;
          // Evict lowest-priority members first, and never bench a Red-Zone
          // player (mirrors the diversity-swap fairness guard).
          for (let i = group.length - 1; i >= 0; i--) {
            if (group[i].priorityScore >= RED_ZONE_SCORE_FLOOR) continue;
            const swapGroup = group.map((g, idx) => (idx === i ? candidate : g));
            if (swapGroup.filter((c) => c.isPulled).length > 1) continue;
            if (!isGroupValid([anchor, ...swapGroup], maxVariance)) continue;
            const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
            if (isDiversityViolation(swappedIds, activeRosters)) continue;
            if (isRejectedRoster(swappedIds, rejectedRosters)) continue;
            const altDraft = snakeDraft(
              [anchor, ...swapGroup],
              partnershipCounts,
              MAX_PARTNERSHIP_REPEATS,
              opponentCounts,
              MAX_OPPONENT_REPEATS
            );
            if (altDraft && !altDraft.usedLopsidedFallback) {
              if (process.env.DEBUG_MATCHMAKING === "true") {
                console.log(
                  `[matchmaking] Balance swap: replaced ${group[i].display_name} with ` +
                    `${candidate.display_name} to avoid lopsided teams`
                );
              }
              draft = altDraft;
              break balanceSwap;
            }
          }
        }
        // No balanced alternative anywhere in the pool — accept the
        // lopsided split rather than stalling the queue.
        if (draft.usedLopsidedFallback && process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] ±${maxVariance} window: no balanced alternative — accepting lopsided split`
          );
        }
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
    const scoredFallback = scoreCandidates(candidates, overlapMap, poolMinGames);
    // Cross-court (N-1): keep at most one pulled body even in the last-resort path.
    const fallbackGroup = limitPulledToOne(scoredFallback.map((s) => s.candidate)).slice(0, 3);

    if (fallbackGroup.length >= 3) {
      const allFour = [anchor, ...fallbackGroup];
      const draft = snakeDraft(
        allFour,
        partnershipCounts,
        MAX_PARTNERSHIP_REPEATS,
        opponentCounts,
        MAX_OPPONENT_REPEATS
      );
      if (draft) {
        return {
          proposal: { teamA: draft.teamA, teamB: draft.teamB, isMixedLevel: true },
          capSaturation: false,
          forcedRepeat: true, // last-resort fallback = a forced repeat (cross-court trigger)
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
