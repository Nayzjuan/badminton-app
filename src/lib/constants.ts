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

/** Minutes before the time-based fallback kicks in (bypasses skill windows). */
export const FALLBACK_WAIT_MINUTES = 15;
