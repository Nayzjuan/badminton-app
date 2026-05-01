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
 * Extra on-deck slots generated beyond the number of open courts.
 * capacity = courtCount + ON_DECK_LOOKAHEAD, capped at MAX_ON_DECK_MATCHES.
 *
 * With the default of 1 and a cap of 2:
 *   1 court  → 2 on-deck  (1 + 1 = 2, at cap)
 *   2 courts → 2 on-deck  (2 + 1 = 3, capped to 2)
 *   3 courts → 2 on-deck  (3 + 1 = 4, capped to 2)
 *
 * The lookahead match absorbs the gap between a court finishing and the
 * engine refilling: even if two courts end almost simultaneously, there is
 * always a queued match for the second one rather than a brief idle period.
 * The engine's fill loop already stops gracefully when the pool is exhausted,
 * so this never creates phantom matches.
 */
export const ON_DECK_LOOKAHEAD = 1;

/**
 * Hard ceiling on the number of on-deck (pending) matches the engine will
 * auto-generate. The uncapped formula (courtCount + ON_DECK_LOOKAHEAD) can
 * produce 3-5 on-deck matches for 2-4 courts, which makes the queue list
 * confusingly short and commits too many players to specific partners before
 * new players arrive.
 *
 * Set to 2 so the organizer always sees at least 2 matches queued but the
 * engine never speculates further than one match beyond what is immediately
 * needed. Existing on-deck matches at session runtime are not affected — the
 * cap only gates new generation.
 */
export const MAX_ON_DECK_MATCHES = 2;
