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
  CONSECUTIVE_OPPONENT_PENALTY,
  MAX_CONSECUTIVE_OPPONENT_REPEATS,
  CRITICAL_WAIT_MINUTES,
  CROSS_COURT_REST_FALLBACK_MINUTES,
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
  SPLIT_PREVIEW_BUDGET,
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
// │  ⚠ When game debt > wait, the actual score falls below 1000          │
// │  (e.g. wait=20, games=5 → 1000+20−40=980). Downstream consumers      │
// │  USED TO re-detect Red Zone as priorityScore ≥ RED_ZONE_SCORE_FLOOR, │
// │  which silently gave those players Normal treatment. They now call   │
// │  isRedZonePlayer, which tests the wait directly. See that function.  │
// │                                                                      │
// │  This comment previously called that "intentional: their wait is     │
// │  self-caused by dense play rather than queue starvation". That       │
// │  rationale is preserved here because it is real, but it does not     │
// │  cover the sites it was cited at. It reaches only the two SCORING    │
// │  sites (scoreCandidates and the widened skill window); it cannot     │
// │  argue that such a player may be benched by a diversity or balance   │
// │  swap ("never bench a Red-Zone player" is a fairness floor, not a    │
// │  boost), nor that a cap-saturation broadcast should say "general"    │
// │  when CapSaturationPayload defines "red_zone" as wait ≥ 20 and the   │
// │  UI renders "waiting over 20 min".                                   │
// │                                                                      │
// │  ⚠ Where it DOES have real force, be honest about the size of it:    │
// │  scoreCandidates' isRedZone flag gates TWO terms, and the second is  │
// │  the fresh-first GAMES_AHEAD_PENALTY (10_000 → 100). So the fix      │
// │  hands this exact cohort a 100× discount on the anti-starvation      │
// │  lever — a wait-22 / 3-games candidate goes from 29_002 (sorted      │
// │  last) to −698 (sorted ahead of a 0-game / 19-min waiter). That is   │
// │  accepted, and it is the designed behaviour rather than a side       │
// │  effect: Tier 2 deliberately has NO games ceiling (unlike Tier 3's   │
// │  HARD_CAP_GAMES_CEILING), and GAMES_AHEAD_PENALTY_RED_ZONE exists    │
// │  precisely so urgency outranks freshness once someone crosses 20     │
// │  minutes. The bug was that the promise silently excluded the         │
// │  high-games players it was written for.                              │
// │                                                                      │
// │  It also double-counts: the game penalty is ALREADY subtracted       │
// │  inside Tier 2, so a dense-play player already sorts below a         │
// │  starved one within the Red Zone. Dropping them out of the tier      │
// │  entirely charges them twice.                                        │
// │  If the urgency argument is ever revived, revive it as an explicit   │
// │  games test at the two scoring sites — not as a score threshold      │
// │  that silently also removes their fairness protections.              │
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
// EXPORT: isRedZonePlayer
// ─────────────────────────────────────────────────────────────
// The ONLY sound test for "this player is in the Red Zone". Use it; never
// re-derive the condition from the score.
//
// `priorityScore >= RED_ZONE_SCORE_FLOOR` reads like the same question and is
// not. RED_ZONE_SCORE_FLOOR is an ADDEND in Tier 2, not a floor on the result:
// the tier returns `1000 + wait - games × GAME_PENALTY_MINUTES`, which dips
// below 1000 whenever the game penalty outruns the wait. A player at wait 22
// with 3 games scores `1000 + 22 - 24 = 998` — unambiguously in the Red Zone by
// the only definition that exists (`wait >= CRITICAL_WAIT_MINUTES`), and
// invisible to the score test.
//
// Two cohorts are missed, and they are the wrong two to miss:
//   • wait ∈ [20, 25) with `games × 8 > wait` (games >= 3 at wait 20–23,
//     games >= 4 at wait 24) — Tier 2, below the addend.
//   • wait >= 25 with games >= HARD_CAP_GAMES_CEILING (5) and `wait < games × 8`
//     — the Hard Cap ceiling excludes them from Tier 3, so they fall THROUGH to
//     Tier 2 and score below 1000 (wait 30 / 5 games → `1000 + 30 - 40 = 990`).
//     This is the most-served-but-longest-waiting player, and every consequence
//     compounds on them at once.
// Measured on production (project usxftpexoimletqmrggb, read-only
// reconstruction of 318 auto-created matches): of the matches whose anchor had a
// reconstructed wait >= CRITICAL_WAIT_MINUTES, 20 had a reconstructed
// priorityScore below RED_ZONE_SCORE_FLOOR — i.e. the score test silently
// disagreed with the definition on 20 real matches.
//
// The wait arm essentially SUBSUMES the score arm (reaching 1000 through Tier 1
// would take a 1000-minute wait; Tier 3 already implies wait >= 25). The score
// arm is kept anyway as a constant-drift guard, matching `anchorBlocksReach`,
// which is where this two-armed shape was first used.
//
// `isPulled` is excluded deliberately. A still-playing body is not waiting, so
// it cannot be in the Red Zone by definition. Today this is a strict no-op, but
// note that the two hardcodes it relies on live in DIFFERENT files:
// `fetchPullablePlayers` sets `wait_minutes: 0` (matchmaking-db.ts) while
// `priorityScore: -1` is applied by the CALLER when it augments the pool
// (matchmaking.ts — `PullableBody` has no priorityScore field at all). Both arms
// are false today only because those two agree. That split is exactly why the
// guard is worth writing down: either hardcode can move without the other, and
// a pulled body that acquired a real wait would silently become un-benchable in
// the balance-preserving swap below — not a decision anyone would have made on
// purpose. RZ-5 pins it.
export function isRedZonePlayer(
  player: Pick<ScoredPlayer, "wait_minutes" | "priorityScore" | "isPulled">
): boolean {
  if (player.isPulled) return false;
  return (
    (player.wait_minutes ?? 0) >= CRITICAL_WAIT_MINUTES ||
    player.priorityScore >= RED_ZONE_SCORE_FLOOR
  );
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

/** A candidate team assignment for one foursome. */
export type TeamSplit = { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] };

/**
 * Who each player faced ACROSS THE NET in their immediately-previous game.
 * Produced by deriveLastOpponents (matchmaking-db.ts). An empty map is always
 * safe and reproduces the pre-freshness behaviour exactly, which is what makes
 * every consumer below opt-in.
 */
export type LastOpponents = ReadonlyMap<string, ReadonlySet<string>>;

// Skill gap between the two teams of a split — 0 means perfectly balanced.
function splitSkillGap(split: TeamSplit): number {
  return Math.abs(
    split.teamA[0].skill_level_int +
      split.teamA[1].skill_level_int -
      (split.teamB[0].skill_level_int + split.teamB[1].skill_level_int)
  );
}

// ─────────────────────────────────────────────────────────────
// EXPORT: countConsecutiveOpponentRepeats
// ─────────────────────────────────────────────────────────────
// How many of the four players would face, ACROSS THE NET, someone they faced
// in their own immediately-previous game. Range 0–4 — each seat is visited once
// and increments at most once, which is what bounds CONSECUTIVE_OPPONENT_PENALTY
// at a provably sub-quantum 12 (see the constant's proof).
//
// Split-aware by design, and that is the whole idea: co-presence is not a
// repeat, a shared NET is. A pair who just faced each other and land on the
// SAME team here score zero — putting them together is the fix, not the
// offence. Per-player and binary because that is how the pain is felt (and how
// metrics.ts measures it): facing two of your last opponents at once is one bad
// game, not two.
//
// An absent / empty map returns 0 for every split, so every caller is
// behaviour-identical when the engine runs without it.

export function countConsecutiveOpponentRepeats(
  split: TeamSplit,
  lastOpponents?: LastOpponents
): number {
  if (!lastOpponents || lastOpponents.size === 0) return 0;
  let repeats = 0;
  for (const [own, other] of [
    [split.teamA, split.teamB],
    [split.teamB, split.teamA],
  ] as const) {
    for (const player of own) {
      const faced = lastOpponents.get(player.player_id);
      if (!faced || faced.size === 0) continue;
      if (other.some((o) => faced.has(o.player_id))) repeats++;
    }
  }
  return repeats;
}

// ─────────────────────────────────────────────────────────────
// EXPORT: wantsFresherFour / pullImprovesFreshness
// ─────────────────────────────────────────────────────────────
// The cross-court reach policy, in two predicates. They live here, beside the
// metric they are built on, because the engine's copy of them sits inside a
// server action where they cannot be tested without a full Supabase fixture —
// and an untestable trigger is exactly how the original one shipped dead
// (0 held drafts across 945 production matches).
//
// Both take `forcedRepeat` first because it is the older, stricter path and it
// short-circuits: when the waiting pool can produce nothing but a repeat, any
// non-repeat four is an improvement by definition.

/**
 * Should the engine spend the extra queries to look for a fresher four?
 *
 * `forcedRepeat` alone — the original sole trigger — is self-defeating: it arms
 * only when the engine has already failed (22/550 replayed matches, 4%), and
 * every improvement to waiting-pool selection makes it arm less often. The
 * second arm is the condition players actually complain about: at least one of
 * the four would face someone from their immediately-previous game.
 */
export function wantsFresherFour(
  forcedRepeat: boolean | undefined,
  baseStaleness: number
): boolean {
  return forcedRepeat === true || baseStaleness > 0;
}

/**
 * Did the reach actually buy anything? Pulling a body off a live court is a real
 * cost, so on the freshness path the augmented four must strictly REDUCE
 * consecutive-opponent staleness. `!forcedRepeat` — the acceptance test the
 * forced-repeat path uses — is far too weak here: most stale fours are not
 * forced repeats, so it would happily accept an augmented four no fresher than
 * the one already in hand.
 */
export function pullImprovesFreshness(
  forcedRepeat: boolean | undefined,
  baseStaleness: number,
  augStaleness: number
): boolean {
  return forcedRepeat === true || augStaleness < baseStaleness;
}

/**
 * Is the anchor too close to needing service to be held?
 *
 * A held draft marks its three waiting members `drafted`, which removes them
 * from `fetchActivePool` — so once held, the Red-Zone and Hard-Wait escalations
 * in `computePriorityScore` can no longer reach them.
 *
 * ⚠️ This guards the ANCHOR ONLY. An earlier version of this doc claimed
 * "checking `pool[0]` covers all three seated waiters, since `scoreAndSortPool`
 * sorts descending" — **false**, and false in the exact way §3.34 exists to
 * eradicate. The sort key is `priorityScore`, which subtracts
 * `games_played × GAME_PENALTY_MINUTES`; it is not wait. A wait-19 / 3-games
 * seat candidate scores −5 and sorts BELOW a wait-16 / 0-games anchor scoring
 * 16, so the anchor clears this guard (16 < 17) while the seat is held straight
 * past the Red-Zone line — precisely the harm the guard is written to prevent.
 *
 * The seats are covered instead by the **hold-age cancel**: `heldDraftExpired`
 * +`CROSS_COURT_MAX_HOLD_MINUTES`, enforced in `recomputeHeldReadiness`. That
 * bounds how long all three parked players can be held rather than restricting
 * which reaches are allowed. Two alternatives were considered and rejected:
 *   - Extending this 17-minute margin to the seats. Strictly more correct, but
 *     on `fetchActivePool`'s rested branch every player with >= 1 game is at
 *     `wait >= 18 >= 17`, so it would force all three waiters to be zero-games
 *     players — plausibly returning a feature with a measured history of "0 held
 *     drafts in 945 production matches" to never firing.
 *   - A seat-level `isRedZonePlayer` block in `buildCrossCourtProposal`'s search
 *     loop. **Unreachable dead code**: a Tier-2 player always outranks any
 *     Tier-1 player (Tier 2 floors at `1000 + 20 − 8g`; falling below a Tier-1
 *     max of 19 needs g > 125), so a Red-Zone seat implies `pool[0]` is Red Zone
 *     too and the wait arm here has already refused. It also would not have
 *     caught the motivating case, since a wait-19 seat is *below* the Red-Zone
 *     line. Do not re-add it.
 *
 * The WAIT arm is the operative one. It refuses at
 * `CRITICAL_WAIT_MINUTES - CROSS_COURT_REST_FALLBACK_MINUTES` (17) rather than
 * at 20, so a player is not seated at 19 minutes and held straight past the
 * Red-Zone line. Note what this does and does NOT bound: it bounds the anchor's
 * wait at the moment the hold is CREATED. It does not bound the hold's
 * duration — `isHeldMatchReady` returns false until `pulledFreedAt` is set, so
 * the hold runs for the rest of the source game plus up to the fallback. See
 * the residual note at the call site.
 *
 * The SCORE arm is presently redundant: `computePriorityScore` only reaches
 * `RED_ZONE_SCORE_FLOOR` via the `wait >= CRITICAL_WAIT_MINUTES` (20) and
 * `wait >= HARD_WAIT_CAP_MINUTES` (25) tiers, both above 17, so the wait arm
 * subsumes it (measured on production: 66 refusals by score, 136 by wait,
 * union 136). It is kept as a constant-drift guard — if the margin constant
 * ever grows past `CRITICAL_WAIT_MINUTES` the arms stop being nested.
 *
 * ⚠️ Interaction with `MIN_REST_MINUTES = 18`: when at least
 * `PLAYERS_PER_MATCH` players clear the rest filter, `fetchActivePool` returns
 * only players at `wait >= 18` OR `games_played === 0`. On that branch every
 * anchor who has already played is >= 18 >= 17 and the reach is refused *by
 * construction*. The only escape is an anchor with zero games — and even that is
 * necessary, not sufficient, since it must still clear the wait and score arms.
 * Zero-games anchors are 3.8% of production auto-matches overall; that is a
 * base rate, NOT the escape rate conditional on this branch (zero-games players
 * are over-represented here, being the only cohort exempt from the wait >= 18
 * cut), so do not subtract it from 100 and quote the remainder. This is the
 * first thing to check if held drafts go quiet again.
 */
export function anchorBlocksReach(priorityScore: number, waitMinutes: number): boolean {
  return (
    priorityScore >= RED_ZONE_SCORE_FLOOR ||
    waitMinutes >= CRITICAL_WAIT_MINUTES - CROSS_COURT_REST_FALLBACK_MINUTES
  );
}

// ─────────────────────────────────────────────────────────────
// selectSplit — the shared freshness ladder
// ─────────────────────────────────────────────────────────────
// Extracted verbatim from what snakeDraft's `findSplit` closure and
// rotatedDraft's four hand-inlined loops each implemented separately. Same four
// passes, same order, same predicates:
//
//   1a: both team pairs fresh (count=0) AND no cross-net pair at cap.
//   1b: both team pairs fresh — relax opponent cap.
//   2a: below partnership cap AND no cross-net pair at cap.
//   2b: below partnership cap only — last resort to prevent stalls.
//
// The ONE addition: within a pass, when several splits qualify, prefer the one
// creating the fewest consecutive-opponent repeats, ties broken by pool order
// (which carries the callers' own balance / rotation preference).
//
// That this is a tie-break INSIDE a rung — never a promotion BETWEEN rungs — is
// load-bearing, and it is the difference between this design and the
// rung-promoting variant it was measured against. Promoting a split up the
// ladder to buy opponent freshness re-teams already-used partnerships: measured
// at a partner-variety regression in 5 of 5 replayed sessions, landing below
// both the current engine and the organizer's own hand-run nights. Keeping the
// preference inside a rung improves partner variety instead (94.9% → 96.9%).
// Do not "simplify" this by hoisting the repeat count above the partnership
// predicates.
type SplitConstraints = {
  partnershipCounts: Map<string, number>;
  cap: number;
  opponentCounts?: Map<string, number>;
  opponentCap?: number;
  lastOpponents?: LastOpponents;
};

function selectSplit(pool: TeamSplit[], c: SplitConstraints): TeamSplit | null {
  const pairCount = (a: ScoredPlayer, b: ScoredPlayer): number =>
    c.partnershipCounts.get(pairKey(a.player_id, b.player_id)) ?? 0;

  // True when no cross-net pair is at or above the opponent cap.
  // Always true when opponentCounts / opponentCap are absent.
  const crossNetOk = (split: TeamSplit): boolean => {
    if (!c.opponentCounts || c.opponentCap === undefined) return true;
    const counts = c.opponentCounts;
    const cap = c.opponentCap;
    return !split.teamA.some((a) =>
      split.teamB.some((b) => (counts.get(pairKey(a.player_id, b.player_id)) ?? 0) >= cap)
    );
  };

  const bothPairsFresh = (split: TeamSplit): boolean =>
    pairCount(split.teamA[0], split.teamA[1]) === 0 &&
    pairCount(split.teamB[0], split.teamB[1]) === 0;

  const bothPairsUnderCap = (split: TeamSplit): boolean =>
    pairCount(split.teamA[0], split.teamA[1]) < c.cap &&
    pairCount(split.teamB[0], split.teamB[1]) < c.cap;

  const passes: Array<(s: TeamSplit) => boolean> = [
    (s) => bothPairsFresh(s) && crossNetOk(s),
    bothPairsFresh,
    (s) => bothPairsUnderCap(s) && crossNetOk(s),
    bothPairsUnderCap,
  ];

  for (const qualifies of passes) {
    let best: TeamSplit | null = null;
    let bestRepeats = Infinity;
    for (const split of pool) {
      if (!qualifies(split)) continue;
      const repeats = countConsecutiveOpponentRepeats(split, c.lastOpponents);
      // Strict `<` keeps the earliest (most balanced / natural rotation) split
      // on a tie — i.e. the exact split the pre-freshness code returned.
      if (repeats < bestRepeats) {
        best = split;
        bestRepeats = repeats;
        if (repeats === 0) break; // cannot do better within this pass
      }
    }
    if (best) return best;
  }

  return null;
}

export function snakeDraft(
  allFour: ScoredPlayer[],
  partnershipCounts?: Map<string, number>,
  cap?: number,
  opponentCounts?: Map<string, number>,
  opponentCap?: number,
  lastOpponents?: LastOpponents
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
  const splits: TeamSplit[] = [
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

  // The 4-pass freshness ladder now lives in selectSplit (above), shared with
  // rotatedDraft. Within a pass it additionally prefers the split creating the
  // fewest consecutive-opponent repeats; with lastOpponents absent that count
  // is always 0, so the first qualifying split wins exactly as before.
  const constraints: SplitConstraints = {
    partnershipCounts,
    cap,
    opponentCounts,
    opponentCap,
    lastOpponents,
  };

  const balanced = selectSplit(balancedSplits, constraints);
  if (balanced) return balanced;

  // Every balanced split is partnership-capped — fall through to a less
  // balanced split rather than stalling, but flag it so the caller can
  // try a different 4th body first.
  const lopsided = selectSplit(lopsidedSplits, constraints);
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
// Red Zone candidates — `isRedZonePlayer(c)`: wait ≥ CRITICAL_WAIT_MINUTES,
// OR score ≥ RED_ZONE_SCORE_FLOOR, and never a pulled body. NOT the score
// test alone; see isRedZonePlayer for why that under-reported the cohort.
// They have their overlap penalty capped at 100× instead of 10_000×. This
// guarantees that a Red Zone candidate with 1 overlap still sorts before a
// fresh Normal candidate:
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
// buildCombinationGroup — which prefers the lowest-scoring skill-valid
// triple — naturally drafts the freshest cohort instead of recycling just-played
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
      // Red Zone: cap BOTH the overlap penalty and the fresh-first
      // games-ahead penalty (100 vs 10_000) so urgency always wins.
      const isRedZone = isRedZonePlayer(c);
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
// That early break still holds on the baseline path (no lastOpponents).
// With a split preview active it does NOT: cost is fairness plus a
// sub-quantum rematch term, so the search runs a branch-and-bound argmin
// instead. See the `previewing` gate below — it is what keeps the two
// paths from diverging when the preview is unavailable.
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
//
// ── Split-aware freshness (optional; `splitPreview`) ──────────────
// Whether two players are OPPONENTS is decided by snakeDraft AFTER
// this function has fixed the foursome — so "don't re-serve the
// matchup they just played" cannot be enforced downstream: by then
// the four bodies are already chosen and every split may contain a
// repeat. When splitPreview carries a NON-EMPTY lastOpponents map,
// each candidate triple therefore previews the split snakeDraft
// would actually produce for it and scores the cross-net pairs that
// split would create.
//
// SEMANTICS CHANGE, deliberate and scoped: with the preview active
// this returns the ARGMIN over
//     s[i].score + s[j].score + s[k].score
//       + CONSECUTIVE_OPPONENT_PENALTY × repeats(previewed split)
// instead of the first valid triple in priority order. Those differ
// even at zero penalty — lexicographic-first is not score-sum-
// minimal (e.g. (0,1,5) precedes (0,2,3) but may cost more) — so
// the preview is gated on a non-empty map rather than on
// splitPreview being supplied. That gate is what makes the change
// provably inert at t=0 (no matches yet ⇒ empty map ⇒ byte-identical
// first-valid behaviour) and what lets the replay harness reproduce
// the pre-freshness baseline exactly via REPLAY_NO_LAST_OPPONENTS.
//
// Fairness is untouched: the penalty is bounded at 4 × 3 = 12 for a
// real split and 5 × 3 = 15 with the unsplittable sentinel below,
// three orders of magnitude below GAMES_AHEAD_PENALTY (10_000), so
// the argmin can only reorder triples that already tie on
// games-above-minimum AND anchor overlap. See the proof on
// CONSECUTIVE_OPPONENT_PENALTY. The anchor is not a search variable
// here at all.
//
// The search is branch-and-bound on the fairness lower bound (the
// score sums are ascending, and the penalty is non-negative, so a
// prefix already at or above the incumbent cost can be cut whole),
// plus a hard SPLIT_PREVIEW_BUDGET on previews. Budget exhaustion
// returns the best group found so far — degraded, never wrong.

/** Everything needed to preview the split snakeDraft would produce for a triple. */
export type SplitPreviewContext = {
  partnershipCounts: Map<string, number>;
  cap: number;
  opponentCounts?: Map<string, number>;
  opponentCap?: number;
  lastOpponents?: LastOpponents;
};

export function buildCombinationGroup(
  anchor: ScoredPlayer,
  scoredCandidates: ScoredCandidate[],
  maxVariance: number,
  splitPreview?: SplitPreviewContext
): ScoredPlayer[] {
  const n = scoredCandidates.length;
  if (n < 3) return [];

  const lastOpponents = splitPreview?.lastOpponents;
  const previewing = !!splitPreview && !!lastOpponents && lastOpponents.size > 0;

  // Cheapest fairness cost any triple could possibly reach. Once the incumbent
  // matches it, nothing left to find.
  const globalFloor =
    scoredCandidates[0].score + scoredCandidates[1].score + scoredCandidates[2].score;

  let best: ScoredPlayer[] | null = null;
  let bestCost = Infinity;
  let firstValid: ScoredPlayer[] | null = null;
  let previewsLeft = SPLIT_PREVIEW_BUDGET;
  let budgetExhausted = false;

  for (let i = 0; i < n - 2; i++) {
    // Prefix bound: the cheapest triple starting at i.
    if (
      previewing &&
      best &&
      scoredCandidates[i].score + scoredCandidates[i + 1].score + scoredCandidates[i + 2].score >=
        bestCost
    )
      break;

    for (let j = i + 1; j < n - 1; j++) {
      if (
        previewing &&
        best &&
        scoredCandidates[i].score + scoredCandidates[j].score + scoredCandidates[j + 1].score >=
          bestCost
      )
        break;

      for (let k = j + 1; k < n; k++) {
        const fairness =
          scoredCandidates[i].score + scoredCandidates[j].score + scoredCandidates[k].score;
        if (previewing && best && fairness >= bestCost) break;

        const combo: ScoredPlayer[] = [
          scoredCandidates[i].candidate,
          scoredCandidates[j].candidate,
          scoredCandidates[k].candidate,
        ];
        // Cross-court (N-1): at most ONE pulled (still-playing) body per match.
        // The anchor is never pulled (C-3), so capping the triple caps the four.
        if (combo.filter((c) => c.isPulled).length > 1) continue;
        if (!isGroupValid([anchor, ...combo], maxVariance)) continue;

        if (!previewing) {
          // Early exit — first valid triple in priority order IS optimal.
          return combo;
        }

        if (!firstValid) firstValid = combo;

        if (previewsLeft <= 0) {
          budgetExhausted = true;
          break;
        }
        previewsLeft--;

        // What would the seater do with these four? Only cross-net pairs count,
        // so a just-faced pair drafted as TEAMMATES here is free — that IS the fix.
        const split = snakeDraft(
          [anchor, ...combo],
          splitPreview.partnershipCounts,
          splitPreview.cap,
          splitPreview.opponentCounts,
          splitPreview.opponentCap,
          lastOpponents
        );
        // A null split means every team assignment for this four is
        // partnership-capped — the seater CANNOT seat it. Score it as the worst
        // case, never as neutral: scoring it 0 made "unsplittable" the best
        // possible preview, so the argmin actively PREFERRED an unseatable four
        // over a seatable one whenever fairness was within 4 × 3 = 12 points.
        // Nothing downstream repairs that — runAlgorithm's `if (!draft)` below
        // does `continue`, which abandons the whole skill window, so the group
        // this function "won" with is a group the caller then throws away. The
        // measured failure is a court that seats nobody with capSaturation
        // false, i.e. it does not even read as saturation to the caller.
        //
        // MAX + 1, not MAX: at exactly MAX an unsplittable four TIES a seatable
        // four that carries 4 repeats at the same fairness, and the strict `<`
        // below then keeps the earlier one — which is the unsplittable one. The
        // sentinel makes unseatable strictly worse than every real split, so the
        // tie cannot resolve the wrong way. Still sub-quantum at 5 × 3 = 15.
        //
        // This stays a tie-break against unsplittable fours, not a second
        // partnership gate: a group that is 16+ fairness points better still
        // wins and still gets its `continue`, exactly as before this feature.
        const repeats = split
          ? countConsecutiveOpponentRepeats(split, lastOpponents)
          : MAX_CONSECUTIVE_OPPONENT_REPEATS + 1;
        const cost = fairness + CONSECUTIVE_OPPONENT_PENALTY * repeats;

        // Strict `<` — ties keep the earlier (higher-priority) triple, which is
        // the one the pre-freshness search would have returned.
        if (cost < bestCost) {
          best = combo;
          bestCost = cost;
          if (bestCost <= globalFloor) break; // provably optimal
        }
      }
      if (budgetExhausted || (best && bestCost <= globalFloor)) break;
    }
    if (budgetExhausted || (best && bestCost <= globalFloor)) break;
  }

  if (budgetExhausted && process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[MATCHMAKING] split-preview budget exhausted (${SPLIT_PREVIEW_BUDGET}) for anchor ${anchor.player_id} over ${n} candidates — returning best-so-far`
    );
  }

  // No valid combination found within this skill window → [].
  return best ?? firstValid ?? [];
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
  opponentCap?: number,
  lastOpponents?: LastOpponents
): TeamSplit | null {
  const sorted = [...allFour].sort((a, b) => b.skill_level_int - a.skill_level_int);

  // Count recent rosters that contained ALL 4 of these players.
  const playerIds = allFour.map((p) => p.player_id);
  const repeatCount = recentRosters.filter((roster) => {
    const rosterSet = new Set(roster);
    return playerIds.every((id) => rosterSet.has(id));
  }).length;

  const splitIndex = repeatCount % 3;

  // All 3 splits indexed to match the original switch semantics.
  const splits: TeamSplit[] = [
    { teamA: [sorted[0], sorted[3]], teamB: [sorted[1], sorted[2]] }, // 0: snake default
    { teamA: [sorted[0], sorted[1]], teamB: [sorted[2], sorted[3]] }, // 1: top vs bottom
    { teamA: [sorted[0], sorted[2]], teamB: [sorted[1], sorted[3]] }, // 2: cross-split
  ];

  // Without cap enforcement, return the natural rotation split unconditionally.
  if (!partnershipCounts || cap === undefined) {
    return splits[splitIndex];
  }

  // Rotate the pool so the natural split for this repeatCount is first, then run
  // the same 4-pass ladder snakeDraft uses. Pool order carries the rotation
  // preference, and selectSplit's strict `<` tie-break preserves it whenever the
  // consecutive-opponent counts are equal (always, without lastOpponents).
  const rotationOrdered = [0, 1, 2].map((i) => splits[(splitIndex + i) % 3]);

  return selectSplit(rotationOrdered, {
    partnershipCounts,
    cap,
    opponentCounts,
    opponentCap,
    lastOpponents,
  });
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
 * Hold-age cancel: has a held draft been parked so long that its three waiting
 * players should be released back into the queue?
 *
 * Only ever true while the body is STILL PLAYING (`pulledFreedAt === null`).
 * Once the body frees, `isHeldMatchReady` resolves within
 * `CROSS_COURT_REST_FALLBACK_MINUTES` on its own, and cancelling a draft that is
 * about to become promotable would throw away the pull for nothing.
 *
 * This is the guard for the two seated waiters that `anchorBlocksReach` provably
 * does NOT cover — see `CROSS_COURT_MAX_HOLD_MINUTES` for why the alternative
 * (extending the anchor's 17-minute margin to the seats) is not viable, and for
 * the honest limit of what an age cap can promise.
 */
export function heldDraftExpired(input: {
  createdAt: string;
  pulledFreedAt: string | null;
  now: number;
  maxHoldMs: number;
}): boolean {
  if (input.pulledFreedAt !== null) return false;
  const createdMs = new Date(input.createdAt).getTime();
  // A malformed timestamp must not cancel a healthy draft (NaN comparisons are
  // false, but be explicit — this decides whether real players lose their seat).
  if (Number.isNaN(createdMs)) return false;
  return input.now - createdMs >= input.maxHoldMs;
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
// EXPORT: buildCrossCourtProposal
// ─────────────────────────────────────────────────────────────
// The third reason cross-court drafting produced ZERO held matches in 945
// production games — and the one that survived fixing the other two.
//
// The old producer appended the pulled bodies to the waiting pool at
// `priorityScore: -1` and asked runAlgorithm to choose:
//
//     runAlgorithm([...pool, ...bodies.map(b => ({...b, priorityScore: -1}))])
//
// scoreCandidates scores every candidate as
//
//     -priorityScore + overlap×10_000 + gamesAhead×10_000
//
// and `isPulled` exempts ONLY the gamesAhead term (scoreCandidates' `gamesAhead`
// ternary — no line number, it has already drifted once). So the body scores
// `1 + overlap_b×10_000` and a waiting candidate scores
// `-P_w + overlap_w×10_000 + gamesAhead_w×10_000`. Note which way those two
// exempted/unexempted terms actually push: BOTH favour the body. Its gamesAhead
// is forced to 0 while a waiter one game above the pool minimum pays 10_000, and
// its overlap is usually 0 while a waiter who has recently shared a court with
// the anchor pays 20_000 (OVERLAP_WEIGHT_* = 2 each). Neither term is a moat
// around the waiting pool — they are the two ways the body can win.
//
// But the comparison that actually decides is NOT per-candidate. On the
// previewing path buildCombinationGroup is an argmin over TRIPLES of
// `fairness + CONSECUTIVE_OPPONENT_PENALTY × repeats`, where `fairness` is the
// sum of three scores and `repeats` depends on the whole four through
// snakeDraft. So "does the body beat this waiter" is not a well-formed question:
// the body displaces the third-cheapest waiter `w3` iff
//
//     s_body - s_w3  <  CONSECUTIVE_OPPONENT_PENALTY × (r_waiting - r_body)
//
// i.e. — substituting `s_body = 1 + overlap_b × 10_000` and TAKING overlap_b = 0,
// the usual case for a body drawn off another court — iff
// `s_w3 > 1 - 3·Δrepeats`. (With overlap_b > 0 the threshold moves by a full
// 10_000 per unit and the repeats term stops mattering; do not drop that term
// silently, which is how this paragraph went wrong before.) Repeats run 0–4 plus the unsplittable
// sentinel 5, so Δrepeats spans [-5, 5] and that threshold slides ±15 around
// `+1`. Three waiters cheaper than the body is therefore neither necessary nor
// sufficient for the body to lose — the repeats term routinely decides it.
//
// What IS true, and is the whole reason for the rewrite: when the repeats term
// is a wash between the two triples the body loses whenever three waiters are
// simultaneously at the pool's game minimum, overlap-free with the anchor, and
// above `priorityScore -1` — the ordinary mid-session pool, and precisely the
// pool cross-court exists to improve. When it is not a wash the outcome turns on
// a property of the whole four that the body's score cannot express at all.
// Either way, `priorityScore: -1` is not a control surface.
//
// CCT-BUILD-1 is a worked instance of the wash: waits 14/12/10/8, one game each,
// no anchor overlap; the waiting-only four costs -6 + 3×1 = -3 and the best four
// containing the body costs -3 + 3×0 = -3 — a dead tie, resolved for the
// incumbent by the strict `<`, pull silently dropped. Note WHY it ties: the
// fairness gap (3) happens to equal the repeat saving (3×1). That cancellation
// is the tie; the three pool conditions alone do not produce it. Give the
// waiting four one more repeat and the body wins on a pool that still satisfies
// all three. Where the body reliably won was a waiting four that was ILLEGAL, and
// such a four comes back flagged forcedRepeat, which the caller's acceptance
// test then rejected. That is the deadlock.
//
// ⚠️ This paragraph has been wrong THREE times, each time by reaching for a
// tidy universal, so re-derive it from the source lines — never paraphrase the
// sentence above it. The three dead versions, so they stay dead: (1) "the body
// trails by 11–15 unbridgeable points" — fiction; (2) "pinned at +1, and the
// overlap term can only widen the gap" — overlap is charged to BOTH sides and
// Tier 1 is unbounded below, so `1 + priorityScore` bounds nothing (a waiter at
// wait 10 / 2 games scores +6 and the body's +1 beats them outright); (3) "the
// body loses exactly when three waiters beat +1" — an iff that ignores the
// repeats term in the argmin, and so is neither necessary nor sufficient.
// Likewise do not restate any of this as "the augmented run got the waiting-only
// four back every time."
//
// Scope, honestly: blockers 1 and 2 (the `i > 0` slot gate and the 4%
// forcedRepeat-only trigger) are what produced 0 held drafts in 945 matches.
// This third blocker is what would have kept the feature near-useless after
// fixing them — it is not independently evidenced by that zero.
//
// So the pull is FORCED here instead of competed for: every candidate four is
// built as three waiting players plus one body (C-1's "a held draft consumes 3
// waiting players"), and runAlgorithm is invoked on that exact four so the
// partnership caps, the skill window, the diversity check and the freshness
// ladder all still apply unchanged.
//
// Fairness is preserved partly by construction and partly by the ranking below.
// Be precise about which is which — an earlier version of this comment claimed
// all of it was structural and was wrong twice over:
//   * pool[0] is in EVERY candidate four, so the reach can never skip the
//     queue's front. This is the app's #1 invariant. ⚠️ pool[0] is the
//     HIGHEST-PRIORITY player, **not** necessarily the longest waiter —
//     `scoreAndSortPool` sorts by `priorityScore`, and that score subtracts
//     `games_played × GAME_PENALTY_MINUTES`. A wait-19 / 3-games player
//     (score −5) sorts BELOW a wait-16 / 0-games player (score 16). Do not
//     re-derive a wait guarantee from the sort order; that is the exact
//     score-encodes-a-tier fallacy §3.34 exists to eradicate.
//   * BECAUSE of that, `anchorBlocksReach(pool[0])` does NOT cover the two
//     seated waiters, which is what the old comment assumed. There is NO
//     seat-level guard in the loop below — a Red-Zone one would be unreachable
//     (see `anchorBlocksReach`'s JSDoc: a Tier-2 player always outranks any
//     Tier-1 player, so a Red-Zone seat implies a Red-Zone `pool[0]`). The
//     seats are covered instead by the hold-age cancel — `heldDraftExpired` +
//     `CROSS_COURT_MAX_HOLD_MINUTES`, enforced in `recomputeHeldReadiness` —
//     which bounds how long they can be parked rather than who may be seated.
//   * the two seat slots are NOT structurally fair — with exactly 4 players,
//     the inner `buildCombinationGroup` has no choice to make, so no fairness
//     term participates in it at all. Fairness among seat pairs is imposed
//     HERE, by the lexicographic ranking below, and nowhere else.
//   * a four that runAlgorithm flags forcedRepeat is discarded, never served.
//   * the result is returned only if it STRICTLY beats `baseStaleness`, so a
//     player is pulled off a live court only to buy a measurably fresher game.

/** Waiting candidates (beyond the anchor) considered for the two open seats. */
const CROSS_COURT_SEAT_CANDIDATES = 7;

export type CrossCourtPick = {
  proposal: MatchProposal;
  /** The single pulled body seated in `proposal`. */
  pulledPlayerId: string;
  /**
   * Consecutive-opponent repeats in `proposal`. Strictly below `baseStaleness`
   * on the freshness path; UNCONSTRAINED when `forcedRepeat` — that path has no
   * staleness floor to beat, so the pick can tie or exceed it (see CCT-BUILD-5).
   */
  staleness: number;
  /**
   * Combined `games_played` of the two seated waiters above the seat pool's
   * minimum. The PRIMARY ranking key — lexicographically ahead of `staleness`,
   * mirroring how GAMES_AHEAD_PENALTY dominates CONSECUTIVE_OPPONENT_PENALTY in
   * `scoreCandidates`. Always 0 when both seats are at the pool minimum.
   */
  gamesAhead: number;
};

export function buildCrossCourtProposal(
  pool: ScoredPlayer[],
  bodies: ScoredPlayer[],
  args: {
    partnershipCounts: Map<string, number>;
    overlapMap: Map<string, number>;
    recentRosters: string[][];
    opponentCounts: Map<string, number>;
    rejectedRosters: string[][];
    lastOpponents: LastOpponents;
    /** Staleness of the waiting-only four this reach has to beat. */
    baseStaleness: number;
    /**
     * Whether the waiting-only four was a forced repeat. Kept separate from
     * baseStaleness because the two paths accept differently, and
     * pullImprovesFreshness owns that distinction: a forced repeat has no
     * staleness floor to beat (it can be 0 and still be unservable), so any
     * legal four clears it, while the freshness path demands a strict drop.
     */
    forcedRepeat: boolean | undefined;
  }
): CrossCourtPick | null {
  if (pool.length < 3 || bodies.length === 0) return null;

  const anchor = pool[0];
  const seatPool = pool.slice(1, 1 + CROSS_COURT_SEAT_CANDIDATES);
  if (seatPool.length < 2) return null;

  let best: CrossCourtPick | null = null;

  // The inner runAlgorithm calls below each get a pool of exactly 4, and
  // getEffectiveLookback(4) is 2 — far shorter than the 4–7 the real waiting
  // pool earns. Left alone, the reach would enforce a WEAKER anti-repeat rule
  // than the plain draft it is replacing, which is backwards for a feature
  // whose entire justification is freshness: a four sharing ≥3 players with the
  // 3rd-most-recent roster would sail through. So the diversity verdict is
  // re-taken out here, against the pool the engine actually drew from.
  //
  // `pool.length` is the right key, and it is never LOOSER than the outer
  // engine's. runAlgorithm keys on `eligible.length + 1`, where `eligible` is
  // the pool minus the anchor, minus everyone outside the skill window, minus
  // everyone partner-capped — so `eligible.length + 1 <= pool.length` always,
  // and getEffectiveLookback is monotonically non-decreasing. Using the whole
  // pool therefore yields an equal-or-LONGER lookback, i.e. an equal-or-stricter
  // anti-repeat rule. Erring strict is the safe direction here: the reach may
  // refuse a four the plain draft would have taken, but it can never wave
  // through one the plain draft would have rejected.
  const activeRosters = args.recentRosters.slice(0, getEffectiveLookback(pool.length));

  // Fresh-first baseline for the two seats. The engine's own weighting makes
  // games-ahead dominate staleness by 833× (GAMES_AHEAD_PENALTY 10_000 vs
  // CONSECUTIVE_OPPONENT_PENALTY 3 × 4 seats = 12 — gotcha 28), so the discrete
  // analogue here is LEXICOGRAPHIC, not a weighted sum: a seat pair that is a
  // game closer to the pool minimum wins outright, and staleness only separates
  // pairs inside the same games-ahead tier. Ranking on staleness alone — which
  // this did before — inverted that invariant, letting a pair several games
  // ahead take the seats to buy a single unit of freshness.
  const seatMinGames = Math.min(...seatPool.map((p) => p.games_played));

  // `bodies` arrives sorted earliest-finishing-first (N-3) and `seatPool` by
  // priority, so iteration order is already the fairest tie-break: the strict
  // comparison below keeps the first-found winner on an exact tie.
  for (const body of bodies) {
    for (let i = 0; i < seatPool.length; i++) {
      for (let j = i + 1; j < seatPool.length; j++) {
        const four = [anchor, seatPool[i], seatPool[j], body];
        const result = runAlgorithm(
          four,
          args.partnershipCounts,
          args.overlapMap,
          args.recentRosters,
          args.opponentCounts,
          args.rejectedRosters,
          args.lastOpponents
        );
        // forcedRepeat here means runAlgorithm had to re-serve a group that
        // failed the diversity / rejection check. Never worth a pull.
        if (!result.proposal || result.forcedRepeat) continue;

        // The real diversity gate — see activeRosters above.
        const fourIds = [...result.proposal.teamA, ...result.proposal.teamB].map(
          (p) => p.player_id
        );
        // The caller writes pulled_player_ids / pulled_from_match_id from the
        // loop's `body`, NOT from the returned proposal — so a proposal that
        // dropped the body would stamp a held draft with a puller who is not in
        // it. runAlgorithm cannot currently do that on a 4-player pool (every
        // rung that could substitute a player either has an empty candidate set
        // or returns forcedRepeat, which is discarded above), but that is an
        // emergent property of a function this one does not own. Enforce it.
        if (!fourIds.includes(body.player_id)) continue;

        if (isDiversityViolation(fourIds, activeRosters)) continue;
        if (isRejectedRoster(fourIds, args.rejectedRosters)) continue;

        const staleness = countConsecutiveOpponentRepeats(result.proposal, args.lastOpponents);
        if (!pullImprovesFreshness(args.forcedRepeat, args.baseStaleness, staleness)) continue;

        const gamesAhead =
          seatPool[i].games_played - seatMinGames + (seatPool[j].games_played - seatMinGames);
        if (
          best &&
          (gamesAhead > best.gamesAhead ||
            (gamesAhead === best.gamesAhead && staleness >= best.staleness))
        ) {
          continue;
        }

        best = {
          proposal: result.proposal,
          pulledPlayerId: body.player_id,
          staleness,
          gamesAhead,
        };
        // A perfectly fresh four on the fairest possible seats cannot be
        // improved on — stop the search. Staleness 0 ALONE is not enough any
        // more: a later pair may tie it at a lower games-ahead tier.
        if (staleness === 0 && gamesAhead === 0) return best;
      }
    }
  }

  return best;
}

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
  rejectedRosters: string[][] = [],
  // Who each player faced across the net in their LAST game (deriveLastOpponents).
  // Appended as param 7 rather than inserted: rejectedRosters shipped at 6 and a
  // silent positional shift would drop rejection memory while still compiling.
  // Defaulting to an empty map keeps every existing caller — and every test —
  // byte-identical to the pre-freshness engine.
  lastOpponents: LastOpponents = new Map()
): AlgorithmResult {
  // pool must be pre-scored and pre-sorted (pool[0] = anchor).
  const anchor = pool[0];
  const anchorSkill = anchor.skill_level_int;
  const anchorWaitMinutes = anchor.wait_minutes ?? 0;
  const anchorIsRedZone = isRedZonePlayer(anchor);

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

  // Constant across every skill window: lets buildCombinationGroup preview the
  // split the seater below would produce, so it can prefer a foursome that does
  // not re-serve a matchup someone just played. Inert while lastOpponents is
  // empty (t=0, or the replay harness's REPLAY_NO_LAST_OPPONENTS baseline).
  const splitPreview: SplitPreviewContext = {
    partnershipCounts,
    cap: MAX_PARTNERSHIP_REPEATS,
    opponentCounts,
    opponentCap: MAX_OPPONENT_REPEATS,
    lastOpponents,
  };

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
    const group = buildCombinationGroup(anchor, scored, maxVariance, splitPreview);

    if (group.length === 3) {
      const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

      // ── Scope note: the repair ladder discards the split preview ──────
      // buildCombinationGroup chose `group` as the argmin against a PREVIEWED
      // split. From here down, Tier-1 / Tier-2 / balance-swap and Tier-3 may
      // substitute a body and re-draft — and none of them re-consults that
      // charge, so the preview no longer describes the match they emit.
      //
      // Not a correctness defect: every re-draft below still receives
      // `lastOpponents`, so the SPLIT it picks remains freshness-aware and the
      // fewest-repeats tie-break inside selectSplit still applies. What is lost
      // is only freshness-awareness in the choice of WHICH bodies to swap in —
      // and these paths exist to escape a diversity violation or a
      // partnership-cap stall, where not stalling outranks not repeating.
      // Making the ladder preview-aware is a measurable follow-up, not an
      // assumption a reader should make about the code as it stands.
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
        if (isRedZonePlayer(swapTarget)) {
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
                MAX_OPPONENT_REPEATS,
                lastOpponents
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
                    MAX_OPPONENT_REPEATS,
                    lastOpponents
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
            MAX_OPPONENT_REPEATS,
            lastOpponents
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
        MAX_OPPONENT_REPEATS,
        lastOpponents
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
            if (isRedZonePlayer(group[i])) continue;
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
              MAX_OPPONENT_REPEATS,
              lastOpponents
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
      // forcedRepeat, decided from the roster ACTUALLY being served rather than
      // from which branch produced it. The Red-Zone escape hatch above ("swap
      // target is Red Zone — fall through to snakeDraft with the original
      // group") re-emits a four that just failed the diversity / rejection
      // check, exactly like Tier-3 and the last-resort fallback do — but it
      // used to return with the flag absent. Cross-court augmentation and the
      // organizer's rejection memory both read that flag, so the one path where
      // the engine KNOWS it is repeating was the one path that stayed silent.
      //
      // Recomputed here instead of tracked through the branches because the
      // balance swap below may already have replaced a body with a clean one,
      // in which case the served four is not a repeat at all.
      const servedIds = [...draft.teamA, ...draft.teamB].map((p) => p.player_id);
      const servedIsRepeat =
        isDiversityViolation(servedIds, activeRosters) ||
        isRejectedRoster(servedIds, rejectedRosters);
      if (servedIsRepeat) {
        console.warn(
          "[matchmaking] Serving a group that failed the diversity/rejection check " +
            "(Red-Zone swap target) — flagged as a forced repeat"
        );
      }
      return {
        proposal: { teamA: draft.teamA, teamB: draft.teamB, isMixedLevel: isMixed },
        capSaturation: false,
        ...(servedIsRepeat ? { forcedRepeat: true } : {}),
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
        MAX_OPPONENT_REPEATS,
        lastOpponents
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
