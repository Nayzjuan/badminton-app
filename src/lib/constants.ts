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

/** Number of recent matches to check for anti-repeat logic. */
export const ANTI_REPEAT_LOOKBACK = 5;

/** Minutes before the time-based fallback kicks in (bypasses skill windows entirely). */
export const FALLBACK_WAIT_MINUTES = 15;

/**
 * Red Zone threshold — wait time in minutes at which a player's priority
 * overrides their game debt entirely. Score = 1000 + waitMinutes so they
 * always anchor the next match regardless of how many games they've played.
 */
export const CRITICAL_WAIT_MINUTES = 25;

/**
 * Game penalty applied in normal-queue priority scoring.
 * Each game played subtracts this many "virtual minutes" from the player's
 * effective wait time, so frequent players yield the queue to fresher ones.
 * priorityScore = waitMinutes - (gamesPlayed * GAME_PENALTY_MINUTES)
 */
export const GAME_PENALTY_MINUTES = 12;

/**
 * Sentinel score floor for Red Zone players.
 * Any player with priorityScore >= RED_ZONE_SCORE_FLOOR is in the Red Zone,
 * meaning their urgency overrides game debt entirely.
 * Score formula: 1000 + waitMinutes (always > any Normal-queue score).
 */
export const RED_ZONE_SCORE_FLOOR = 1000;
