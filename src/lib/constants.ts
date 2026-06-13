// ============================================================
// App-wide Constants
// ============================================================

/** Minutes before a player is flagged as a "bottleneck" in the wait time monitor. */
export const BOTTLENECK_THRESHOLD_MINUTES = 20;

/** Target skill level difference for matchmaking (+/- 1 level). */
export const SKILL_VARIANCE_TARGET = 1;

/** Absolute maximum skill level difference allowed (+/- 2 levels). */
export const SKILL_VARIANCE_MAX = 2;

/** Number of players per court (strictly doubles). */
export const PLAYERS_PER_MATCH = 4;

/** Number of recent matches to check for anti-repeat logic (overlap map). */
export const ANTI_REPEAT_LOOKBACK = 5;

/**
 * How many recent match rosters to fetch for diversity-violation checks.
 * Larger than ANTI_REPEAT_LOOKBACK so getEffectiveLookback can scale up
 * for large sessions (16+ eligible players → lookback=7) without being
 * capped by the fetch window.
 */
export const ROSTER_LOOKBACK_COUNT = 10;

/** Minutes before the time-based fallback kicks in (bypasses skill windows entirely). */
export const FALLBACK_WAIT_MINUTES = 15;

/**
 * Red Zone threshold — wait time in minutes at which a player enters the
 * urgency tier. Red Zone score = 1000 + waitMinutes - (gamesPlayed × GAME_PENALTY_MINUTES),
 * guaranteeing it exceeds any Normal-queue score while still preferring
 * fewer-games players when waits are similar.
 *
 * Set to 20 min (was 25) so the Red Zone triggers sooner, reducing the
 * window in which a long-waiting player competes as "normal priority."
 * The Hard Wait Cap (25 min) fires 5 min after Red Zone entry and gives
 * the absolute-override floor that guarantees service.
 */
export const CRITICAL_WAIT_MINUTES = 20;

/**
 * Hard Wait Cap — after a player has been waiting this many minutes AND
 * has fewer than HARD_CAP_GAMES_CEILING games, their priority score jumps
 * to HARD_CAP_SCORE_FLOOR + (extraWait × 10), absolutely overriding both
 * Normal-queue and Red Zone players.
 *
 * Design intent: no eligible player should wait more than
 *   HARD_WAIT_CAP_MINUTES + max(courtDuration) ≈ 25 + 22 = 47 min.
 * In practice the engine delivers 36–43 min max across all tested scenarios.
 *
 * Progressive scoring (not flat) means the longest-waiting cap-eligible
 * player always leads — preventing flat-score ties that would otherwise
 * systematically deprioritise late-arriving players.
 */
export const HARD_WAIT_CAP_MINUTES = 25;

/**
 * Absolute-override score floor for Hard Wait Cap players.
 * Scores in the Hard Cap tier = HARD_CAP_SCORE_FLOOR + (wait − HARD_WAIT_CAP_MINUTES) × 10.
 * Must be > RED_ZONE_SCORE_FLOOR + max realistic Red Zone score to guarantee
 * hard-cap players always outrank Red Zone players.
 * (Max plausible Red Zone: 1000 + 60 − 0 = 1060; 2000 >> 1060 ✓)
 */
export const HARD_CAP_SCORE_FLOOR = 2000;

/**
 * Game count ceiling for Hard Wait Cap eligibility.
 * A player with games_played ≥ this value cannot use the hard cap override
 * — they compete via normal / Red Zone scoring only.
 *
 * Set to the typical session target (5 games for a 4-hour session with
 * standard court/player ratios). This prevents players who have already
 * reached their fair share from claiming the absolute-override and crowding
 * out players who haven't yet hit the target.
 *
 * Derivation: targetGames = round(courts × sessionMin / avgGameMin × 4 / players)
 *   31p / 3c / 240 min → round(4.65) = 5
 *   18p / 2c / 240 min → round(5.08) = 5
 *   50p / 5c / 240 min → round(4.80) = 5
 */
export const HARD_CAP_GAMES_CEILING = 5;

/**
 * Game penalty applied in normal-queue priority scoring (no floor — scores can go negative).
 * Each game played subtracts this many "virtual minutes" from the player's
 * effective wait time, so frequent players yield the queue to fresher ones.
 *
 * Formula: priorityScore = waitMinutes - (gamesPlayed × GAME_PENALTY_MINUTES)
 *          Red Zone:       1000 + waitMinutes - (gamesPlayed × GAME_PENALTY_MINUTES)
 *
 * Calibration: set ≈ half the average game cycle (~20 min / 2 = 10 min).
 * At 8 min, a player with 1 extra game has a ~8-min disadvantage vs a lower-games
 * player at equal wait — they catch up after ~8 more minutes of waiting.
 * This keeps max wait under ~40 min while still differentiating game counts.
 * (Higher values improve equity but increase wait time for early-burst players.)
 */
export const GAME_PENALTY_MINUTES = 8;

/**
 * Sentinel score floor for Red Zone players.
 * Any player with priorityScore >= RED_ZONE_SCORE_FLOOR is in the Red Zone,
 * meaning their urgency overrides normal-queue ordering — but game debt still
 * applies within the Red Zone so fewer-games players are preferred.
 * Score formula: 1000 + waitMinutes - (gamesPlayed × GAME_PENALTY_MINUTES).
 * The +1000 ensures all Red Zone scores outrank any Normal-queue score.
 */
export const RED_ZONE_SCORE_FLOOR = 1000;

/**
 * Soft gate — maximum waiting-pool size that triggers cross-court mixing
 * deferral in runEngineInternal. When the pool of waiting players is at or
 * below this count AND at least one match is currently in progress, the
 * engine holds on-deck generation so that returning players from the active
 * court can be included in a larger, more diverse scheduling pool.
 *
 * Why 4: a pool of exactly 4 means there is only ONE possible combination —
 * the same players who just finished together. The gate prevents this repeat
 * by waiting for the active court to also finish, doubling the pool to 8.
 */
export const GATE_POOL_THRESHOLD = 4;

/**
 * Soft gate — minutes a player must wait before the gate releases
 * automatically. Once any waiting player has been in the queue for this
 * long, the gate stops holding and schedules from whatever pool is available
 * (partner rotation then handles variety within the forced group).
 *
 * Set below FALLBACK_WAIT_MINUTES (15) so the gate never delays longer than
 * the time-based fallback that already overrides skill matching.
 */
export const GATE_HOLD_MINUTES = 8;

/**
 * Dynamic draft cap tiers — scales the review queue depth with the number of
 * waiting players so larger sessions always have enough pending matches ready.
 *
 * The cap counts ONLY is_published=false matches (status='pending'). Published
 * on-deck matches that have already been reviewed do NOT count — they are "done"
 * from the review perspective and should not block new draft generation.
 *
 * Formula: slotsAvailable = max(0, getDynamicDraftCap(waitingCount) − draftCount)
 *
 * Tier table:
 *   waiting < 25   → cap 3  (small session — few matches needed)
 *   waiting 25–29  → cap 5  (medium session)
 *   waiting ≥ 30   → cap 6  (large session — keep review queue full)
 */
export const MAX_AUTO_DRAFTS = 3; // < 25 waiting players
export const MAX_AUTO_DRAFTS_LARGE = 5; // 25–29 waiting players
export const MAX_AUTO_DRAFTS_XLARGE = 6; // ≥ 30 waiting players
export const DRAFT_CAP_LARGE_THRESHOLD = 25; // player count that bumps cap to 5
export const DRAFT_CAP_XLARGE_THRESHOLD = 30; // player count that bumps cap to 6

/**
 * Minimum number of waiting players that must remain in the free pool
 * after each on-deck match is generated (applies from the 2nd slot onwards).
 *
 * Before filling on-deck slot N (N ≥ 1), the engine checks:
 *   estimatedWaiting >= PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK
 *
 * Set to PLAYERS_PER_MATCH (4) so that after one on-deck generation,
 * at least 4 players remain free. When those players return from a court,
 * the pool grows back to 8 — enough for diverse scheduling without
 * forcing the same group to re-play.
 *
 * Why first slot (i=0) is exempt: the engine must always be able to queue
 * at least one match, otherwise the session stalls when the pool is small
 * (e.g., 4 players waiting and no active courts). The soft gate already
 * handles the "wait for returning players" case; this cap handles the
 * "don't pre-commit more matches than the pool can support" case.
 *
 * Organizer bypass (callNextMatch with bypassGate=true) skips this cap.
 */
export const MIN_FREE_POOL_FOR_ON_DECK = 4;

/**
 * Hard cap on the number of times two players may appear on the same
 * team within a single session. Once a pair reaches this count they are
 * excluded from every team-assignment path (snakeDraft / rotatedDraft).
 *
 * No waivers — Red Zone urgency, last-resort fallback, and tier isolation
 * do NOT bypass this cap. If no valid team split exists, the slot returns
 * no-match and a saturation signal fires so the organizer can intervene.
 * Manual organizer assignment is the only bypass.
 */
export const MAX_PARTNERSHIP_REPEATS = 2;

/**
 * Soft cap on the number of times two players may face each other as
 * opponents (cross-net) within a single session.
 *
 * Enforced in snakeDraft / rotatedDraft as a PREFERENCE (soft), not a hard
 * block: the engine first tries team splits where no cross-net pair is at
 * this cap. If all splits have at least one capped opponent pair, the cap
 * is relaxed and the best available split is used — preventing stalls.
 *
 * This is a soft cap to avoid conflicts with the hard partnership cap:
 * in small sessions the same players necessarily face each other often.
 */
export const MAX_OPPONENT_REPEATS = 3;

/**
 * Minimum minutes a returning player must wait before they can be
 * drafted again. Guards against 0-minute back-to-back play.
 *
 * Applies to players with games_played > 0. First-time players
 * (games_played = 0) are always eligible regardless of wait time.
 *
 * Fallback: if applying this filter would leave fewer than PLAYERS_PER_MATCH
 * waiting players, the filter is waived so the session can still form a
 * match (handles very small sessions or returning bursts).
 */
export const MIN_REST_MINUTES = 18;

// ── Cross-Court Diversity Drafting (held drafts) ──────────────────────────────
// See CROSS_COURT_DRAFTING_PLAN.md. The engine may pre-build an on-deck "held"
// draft of 3 waiting players + 1 player still PLAYING on another court, to force
// match diversity; the held draft only promotes once the pulled body finishes
// and rests one match.

/**
 * A held draft becomes promotable this many minutes after its pulled player
 * frees — the rest-timer fallback used when no other match promotes in the
 * meantime. (The primary readiness signal is ≥1 intervening promotion.)
 */
export const CROSS_COURT_REST_FALLBACK_MINUTES = 3;

/**
 * Max consecutive back-to-back games before a playing body is excluded from
 * being pulled. Pulled games count toward this streak, so this doubles as the
 * relational pull-cooldown — robust to game-length variance (unlike a clock
 * window). Guard 1b (DB) remains the hard "no body in two held drafts" rule.
 */
export const MAX_CONSECUTIVE_GAMES_FOR_PULL = 2;

/**
 * Max gap (in minutes) between a player's consecutive games for them to still
 * count as "back-to-back" when computing the consecutive-games streak in
 * fetchPullablePlayers.
 */
export const MATCH_REST_GAP_MINUTES = 5;

// ── Skill level display metadata ─────────────────────────────────────────────
// Single source of truth for skill level labels, abbreviations, and dot colors.
// Used by match-roster.tsx (on-deck / active courts) and tv-board.tsx (TV view).
//
// lower_advanced uses fuchsia (not amber) to avoid colliding with
// the app's amber semantic for "pending / on-deck / warning".

import type { MatchStatus, SkillLevel } from "@/types/database";

/**
 * The three match statuses that represent a committed team assignment.
 * Used by matchmaking-db.ts to count partnership repeats and recent rosters.
 *
 * "pending" is included so unpublished drafts count toward the partnership
 * cap immediately — preventing the engine from pairing the same players
 * in a second draft before the first one is reviewed or cancelled.
 */
export const COMMITTED_MATCH_STATUSES: MatchStatus[] = ["completed", "in_progress", "pending"];

// ── UI timing constants ───────────────────────────────────────────────────────

/** ms delay between showing a success message and closing a dialog. */
export const DIALOG_CLOSE_DELAY_MS = 800;

/** ms delay before auto-focusing the first score input after a dialog opens.
 *  Allows Radix to complete its focus-trap setup before we programmatically move focus. */
export const DIALOG_FOCUS_DELAY_MS = 80;

/** ms before a success/info toast auto-dismisses. */
export const TOAST_DISMISS_MS = 5_000;

/** ms before an error message auto-dismisses.
 *  Longer than TOAST_DISMISS_MS — errors need more read time. */
export const ERROR_AUTO_DISMISS_MS = 8_000;

// ── Court timer constants ─────────────────────────────────────────────────────

/** Minutes past the time limit that triggers the "critical" alert tier (red glow). */
export const COURT_ALERT_CRITICAL_OFFSET_MINUTES = 10;

/** ms interval for recomputing the court alert tier. Minute-level granularity is sufficient. */
export const COURT_ALERT_RECOMPUTE_INTERVAL_MS = 30_000;

// ── Score validation ──────────────────────────────────────────────────────────

/** Maximum valid score in a single badminton game (standard 21-point, but we allow up to 31 for deuce scenarios). */
export const MAX_BADMINTON_SCORE = 31;

/**
 * Maximum skill variance window for Red Zone anchor candidates.
 * Expands progressively — ±1, ±2, ±3, ±4 — until at least 3 eligible players
 * are found. ±4 covers the full 6-level spectrum and is the last resort before
 * the slot returns no-match.
 */
export const RED_ZONE_SKILL_VARIANCE_MAX = 4;

// ── Drag-and-drop activation ──────────────────────────────────────────────────

/** Minimum px the pointer must move before a drag starts (prevents accidental drags on tap). */
export const DND_ACTIVATION_DISTANCE_PX = 3;

/** ms a touch must be held before a drag starts. */
export const DND_TOUCH_DELAY_MS = 150;

/** px of movement tolerance during the DnD touch delay window. */
export const DND_TOUCH_TOLERANCE_PX = 5;

// ── Player queue display thresholds ──────────────────────────────────────────

/** Queue position at or below which the player card shows an amber "approaching" indicator. */
export const APPROACHING_QUEUE_THRESHOLD = 2;

/** Queue position at or below which the OnDeckAlert banner is shown. */
export const ON_DECK_ALERT_THRESHOLD = 4;

// ── Organizer dashboard layout ────────────────────────────────────────────────

/** px size of the background grid overlay on the organizer dashboard. */
export const DASHBOARD_GRID_SIZE_PX = 48;

export const SKILL_META: Record<SkillLevel, { label: string; abbr: string; dot: string }> = {
  beginner: { label: "Beginner", abbr: "Beg", dot: "bg-emerald-500 dark:bg-emerald-400" },
  lower_intermediate: {
    label: "Lower Intermediate",
    abbr: "L.Int",
    dot: "bg-teal-500    dark:bg-teal-400",
  },
  intermediate: { label: "Intermediate", abbr: "Int", dot: "bg-sky-500     dark:bg-sky-400" },
  upper_intermediate: {
    label: "Upper Intermediate",
    abbr: "U.Int",
    dot: "bg-indigo-500  dark:bg-indigo-400",
  },
  lower_advanced: {
    label: "Lower Advanced",
    abbr: "L.Adv",
    dot: "bg-fuchsia-500 dark:bg-fuchsia-400",
  },
  advanced: { label: "Advanced", abbr: "Adv", dot: "bg-purple-500  dark:bg-purple-400" },
};
