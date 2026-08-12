// ============================================================
// App-wide Constants
// ============================================================

/**
 * The club's canonical timezone. The app is single-locale; all "calendar"
 * boundaries that must be identical for every viewer (e.g. the Monthly
 * leaderboard's month membership) are anchored here, NOT in the browser's
 * local timezone. Asia/Manila is a stable UTC+8 with no DST.
 * If the club ever spans timezones, this should become a session/club setting.
 */
export const CLUB_TIMEZONE = "Asia/Manila";

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

/**
 * Rejection memory: an organizer clearing a draft means "deal a different
 * hand", not "deal the same one again". Cleared rosters younger than this
 * are treated like a diversity violation on the EXACT same four, steering
 * the swap ladder toward a 3-of-4 recombination. Verified live (08/06
 * session): without this, the deterministic engine re-dealt an identical
 * cleared roster three times inside one minute until the organizer gave up
 * and switched auto-matchmaking off. Kept short so an early-session
 * rejection doesn't ban a legitimate foursome for the whole night.
 */
export const REJECTED_ROSTER_TTL_MINUTES = 30;

/**
 * Upper bound on cleared-draft events fetched per engine run. Clears arrive
 * in bursts of ~3 (Clear All on a full review queue); a few burst rounds fit
 * comfortably inside this cap, and anything older is TTL-expired anyway.
 */
export const REJECTED_ROSTER_FETCH_LIMIT = 12;

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
 * Sentinel score ADDEND for Red Zone players — read the next paragraph before
 * using it as a threshold.
 *
 * Score formula: 1000 + waitMinutes - (gamesPlayed × GAME_PENALTY_MINUTES).
 * Being in the Red Zone means `wait >= CRITICAL_WAIT_MINUTES`; urgency then
 * overrides normal-queue ordering, but game debt still applies within the Red
 * Zone so fewer-games players are preferred. The +1000 keeps Red Zone scores
 * above Normal-queue ones (Tier 1 requires wait < 20, so it tops out at 19).
 *
 * ⚠️ `priorityScore >= RED_ZONE_SCORE_FLOOR` is NOT the Red Zone condition and
 * must not be used as one. The 1000 is an addend, not a floor on the result:
 * subtract the game penalty and the score drops below 1000 whenever
 * `games × GAME_PENALTY_MINUTES > wait` (wait 22 / 3 games → 998). Use
 * `isRedZonePlayer` from matchmaking-core, which tests the wait directly; this
 * doc comment previously asserted the equivalence and five call sites believed
 * it, under-reporting the Red Zone on 20 of 318 sampled production matches.
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
 *
 * Lowered 3 → 2 (2026-07 diversity pass): the engine now prefers splits where
 * no cross-net pair has already met twice, so a given pair only faces off a
 * third time when the pool genuinely leaves no alternative. Affects round 3+
 * team-splitting (in round 2 no pair has met more than once, so the cap does
 * not bite — round-2 opponent freshness is driven by OVERLAP_WEIGHT_OPPONENT
 * in deriveOverlapMap instead). Still soft, so small sessions never stall.
 */
export const MAX_OPPONENT_REPEATS = 2;

/**
 * Familiarity weights applied by deriveOverlapMap per prior in-session
 * encounter with the anchor, consumed by scoreCandidates (weight × the overlap
 * multiplier) to push already-encountered players down the candidate order.
 *
 * TEAMMATE (same side) and OPPONENT (cross-net) are now weighted EQUALLY (both
 * 2) — raised from the old 2/1 split as part of the 2026-07 diversity pass so
 * that re-FACING someone from round 1 is avoided as strongly as re-PARTNERING
 * them. This is the primary lever for round-2 opponent diversity: it fires on
 * a single prior meeting (unlike MAX_OPPONENT_REPEATS, which only bites on a
 * 2nd meeting). Soft signal only — reorders candidates, never hard-blocks;
 * skill windows and the partnership cap are enforced separately.
 */
export const OVERLAP_WEIGHT_TEAMMATE = 2;
export const OVERLAP_WEIGHT_OPPONENT = 2;

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

// ── Early-session diversity (fresh-first rule) ────────────────────────────────
// Motivated by the 2026-07 early-round-diversity investigation: real sessions
// showed early second-round matches recycling just-played "alumni" while
// fewer-games players were present, because candidate scoring had no notion of
// games-played disparity.

/**
 * scoreCandidates penalty per game a candidate is AHEAD of the pool minimum
 * (fresh-first rule). Same magnitude as one overlap unit (10_000) so a
 * candidate one game ahead of the freshest waiting players ranks behind them
 * — effectively "draw from the freshest cohort first" whenever the skill
 * window allows, without ever hard-blocking (skill compatibility and Red Zone
 * urgency still win). Zero effect when every candidate has equal games.
 */
export const GAMES_AHEAD_PENALTY = 10_000;

/**
 * Red Zone variant of GAMES_AHEAD_PENALTY — capped small (like the 100×
 * overlap cap) so an urgent long-waiting player is never displaced by a
 * fresher-but-not-urgent candidate.
 */
export const GAMES_AHEAD_PENALTY_RED_ZONE = 100;

// ── Split-aware consecutive-opponent freshness ────────────────────────────────
// The complaint the engine actually loses on is "I faced them AGAIN, right
// after" — not "twice all night". Two players in a proposed foursome are only
// opponents if the team split puts them on opposite sides, and that split is
// decided AFTER the group is fixed (snakeDraft / rotatedDraft). So the group
// search previews the split it would produce and scores the CROSS-NET pairs it
// would actually create: a pair who just faced each other and would face each
// other again is charged; the same pair drafted as TEAMMATES is not — putting
// them together is the fix, not the repeat.
//
// Measured over the five-session replay harness (scripts/replay-sessions.ts):
// back-to-back opponent repeats 244/550 (44.4%) → 186/550 (33.8%), which is
// better than the 35.5% the organizer achieved intervening by hand. Near-
// identical foursomes 32 → 28, opponent pairs over cap 52 → 36, and partner
// variety IMPROVED (94.9% → 96.9%) rather than being traded away.

/**
 * Penalty charged per PLAYER in a proposed foursome who would face, across the
 * net, someone they faced in their immediately-previous game. Counted per
 * player (max 4 per match), exactly mirroring how the complaint is measured.
 *
 * ── Sub-quantum proof (fairness stays strictly dominant) ──
 * The magnitude is bounded BY CONSTRUCTION, not by convention:
 * countConsecutiveOpponentRepeats visits each of the PLAYERS_PER_MATCH seats
 * exactly once and increments at most once per seat, so its range is [0, 4] and
 * the term's ceiling is 4 × 3 = 12. That is:
 *   • < GAMES_AHEAD_PENALTY (10_000) by 833× → cannot reorder a candidate who
 *     is a game closer to the pool minimum behind one who is a game further
 *     away. Games-ahead tiers are never reordered, so no one can be starved.
 *   • < one overlap unit (10_000; a single prior encounter with the anchor is
 *     already 2 units = 20_000) → cannot reorder across anchor-familiarity.
 *   • < GAMES_AHEAD_PENALTY_RED_ZONE (100) and < one Red Zone overlap unit
 *     (100) by 8.3×; and because RED_ZONE_SCORE_FLOOR is 1000, substituting a
 *     Red Zone candidate for a Normal one moves the group's cost by ≳1000,
 *     which 12 can never buy back. A Red Zone or Hard Cap player therefore
 *     cannot be benched by this term.
 * The anchor is not a search variable at all (anchor = pool[0]), so the
 * longest-waiting player cannot be displaced by this term under any input.
 *
 * ⚠️ One caller exceeds that ceiling deliberately: buildCombinationGroup scores
 * an UNSPLITTABLE four as MAX_CONSECUTIVE_OPPONENT_REPEATS + 1 = 5 rather than
 * as a real repeat count, so the term reaches 5 × 3 = 15 inside that argmin and
 * the max swing between two triples is 15, not 12. Every bound above still
 * holds at 15 (the tightest, the Red Zone pair, goes from 8.3× to 6.7×) — but
 * quote 15, not 12, when reasoning about that argmin specifically.
 *
 * ── What it CAN reorder ──
 * Only triples with the same games-above-minimum and the same anchor overlap —
 * inside one fairness tier, where the remaining separator is wait time. There
 * its reach is up to 12 summed priority-minutes across the three non-anchor
 * slots, i.e. roughly 4 minutes per displaced seat. That is well inside the
 * guardrail but it is NOT merely "players who re-queued in the same instant":
 * at MIN_REST_MINUTES = 18 with staggered court finishes, a 4-minute gap is
 * routine, so this term does bench a slightly-longer-waiting player to avoid an
 * immediate rematch. That trade is the intended behaviour; it is recorded here
 * so the next person to tune it knows the true reach.
 *
 * ── Why 3 and not 60 ──
 * Swept {1,2,3,4,5,6,8,10,12,15,30,60,120,240,600} over the replay harness.
 * EVERY value beats the baseline's 244 repeats, so the win does not depend on
 * this number; the range is 186–201 (33.8%–36.5% vs 44.4%). The best plateau is
 * {2,3,4,5} → 186, degrading above it (6 → 200, 15–240 → 199, 600 → 201).
 * Bigger is worse because a larger term stops being a tie-break and starts
 * pulling a materially lower-priority player in ahead of a higher-priority one
 * to dodge a repeat NOW; that player re-queues off-beat, desynchronising the
 * rotation and producing worse pools later. The signature is visible in the
 * 07/25 replay, where near-identical foursomes jump 4 → 24 once the penalty
 * crosses 5. 3 is the middle of the winning plateau.
 *
 * Treat the exact value as noise-level tuning over five fixed trajectories, and
 * "any positive sub-quantum value helps" as the robust finding.
 */
export const CONSECUTIVE_OPPONENT_PENALTY = 3;

/**
 * Structural maximum of `countConsecutiveOpponentRepeats` for one foursome: the
 * term is charged once per SEAT, and there are four seats, so no split can score
 * above 4. Two things lean on that ceiling:
 *
 *   1. The sub-quantum proof. 4 × CONSECUTIVE_OPPONENT_PENALTY = 12, which is
 *      833× below GAMES_AHEAD_PENALTY — so the term can only ever reorder
 *      candidates already tied on fairness, never promote one across a tier.
 *   2. buildCombinationGroup's null-split score. A four the seater cannot seat
 *      at all is scored at this maximum PLUS ONE rather than at 0, so the argmin
 *      does not treat "unsplittable" as "perfectly fresh". Scoring it 0 was a
 *      real bug: the search preferred unseatable fours, and the caller's
 *      `if (!draft) continue` then discarded the whole skill window. The +1 is
 *      what keeps it strictly worse than a real split scoring the full 4 —
 *      at exactly 4 the two tie and the argmin's strict `<` keeps the earlier,
 *      unsplittable one. 5 × 3 = 15 is still far below the quantum.
 *
 * If the term ever becomes per-PAIR rather than per-seat this must move to 8,
 * and the sub-quantum proof needs re-checking (8 × 3 = 24, still sub-quantum).
 */
export const MAX_CONSECUTIVE_OPPONENT_REPEATS = PLAYERS_PER_MATCH;

/**
 * Ceiling on how many team-splits buildCombinationGroup may preview while
 * searching for the group with the fewest consecutive-opponent repeats. Purely
 * a runtime guard: exhausting it is CORRECT but degraded — the search returns
 * the best group found so far, which is never worse than the first-valid group
 * the pre-freshness engine returned.
 *
 * Sized from the real worst case rather than a round number. The search is
 * C(n,3) over the skill-filtered candidate window, so:
 *   n = 16 →   560 previews   n = 20 → 1_140
 *   n = 24 → 2_024            n = 30 → 4_060  (the ~30-player session ceiling
 *                                              already documented on
 *                                              buildCombinationGroup)
 * A preview is one snakeDraft (sort 4, build 3 splits, walk the ladder),
 * measured at ~1.4 µs, so 4_060 previews ≈ 5.7 ms — well inside a single
 * on-deck fill and paid at most once per slot. 4_096 therefore covers the
 * largest session the engine claims to support, with headroom.
 *
 * The previous value of 600 was a silent cliff: a 17-candidate window is
 * C(17,3) = 680 and blew it on the FIRST anchor, reverting that slot to
 * baseline behaviour with no signal. Branch-and-bound prunes most of this in
 * practice — the budget only binds under near-total score ties — but when it
 * does bind, DEBUG_MATCHMAKING now says so instead of failing quiet.
 */
export const SPLIT_PREVIEW_BUDGET = 4_096;

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
 * Hold-age cancel: a held draft whose pulled body is STILL PLAYING after this
 * many minutes is cancelled, returning all three parked waiters to the queue.
 *
 * Why this exists. A held draft seats nobody when it is created — it parks
 * three waiting players until the body's court frees. `anchorBlocksReach`
 * bounds only the ANCHOR's wait, and only at the moment the hold is CREATED;
 * it bounds neither the hold's duration nor the two other seats. Those seats
 * are genuinely unguarded: `scoreAndSortPool` sorts by `priorityScore`, not
 * wait, so a wait-19 / 3-games seat (score −5) sits below a wait-16 / 0-games
 * anchor (score 16) and is held straight past `CRITICAL_WAIT_MINUTES`.
 *
 * Extending the anchor's 17-minute margin to the seats would close that, but
 * once `fetchActivePool`'s rest filter is active every player with ≥1 game has
 * `wait >= MIN_REST_MINUTES` (18) ≥ 17, so all three waiters would have to be
 * zero-games players — which would return the feature to almost never firing.
 * Capping the hold instead bounds the damage for ALL THREE parked players
 * without narrowing which reaches are allowed.
 *
 * Calibration. Measured on production, the soonest court to free at draft time
 * is p50 4.7 min / p90 12.7 / p99 18.1. At 15 the median hold is untouched and
 * only the long tail is cancelled, so the reach rate is essentially preserved.
 *
 * ⚠️ Two things this does NOT promise. Do not describe it as a Red-Zone
 * guarantee on either count.
 *
 * 1. It bounds the HOLD, not the total wait. A seat that entered the hold at
 *    12 minutes can still finish at 27. The strictly correct version cancels on
 *    the parked players' actual `wait_minutes` rather than on hold age; that
 *    costs a query per held draft and is the follow-up if this reads too loose.
 * 2. It is BEST-EFFORT, evaluated on an event, not on a timer. The cancel lives
 *    in `recomputeHeldReadiness`, which is never invoked from the engine loop —
 *    its only callers are in match-lifecycle.ts, when a match ends or is
 *    cancelled. Both of those sit inside `if (match.court_id)`, so a match with
 *    no court does not even count as attention. Until one of those two events
 *    fires on a court, a hold outlives this cap indefinitely. That coupling is
 *    benign in practice (a court freeing is the same event that makes a hold
 *    resolvable at all), but the cap is an upper bound on ATTENTION, not on
 *    elapsed time.
 */
export const CROSS_COURT_MAX_HOLD_MINUTES = 15;

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

/**
 * Hard ceiling on how many committed matches fetchSessionMatchSnapshot will
 * load for one session. Above this it returns { ok: false } and the engine
 * fails CLOSED (stops drafting) rather than matchmaking off a truncated view
 * of who has already played whom.
 *
 * Sized against reality, not guessed: the busiest session in production
 * history holds 56 committed matches, so 200 is ~3.5x headroom. The snapshot
 * is per-session and sessions are single-evening, so this is not a growth
 * curve that creeps up — a session that trips this is anomalous (a stuck
 * engine loop, or a session record being reused as a permanent bucket), and
 * in that case refusing to draft is the correct answer.
 */
export const SESSION_MATCH_SNAPSHOT_CEILING = 200;

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

// ── Realtime refetch debounce ─────────────────────────────────────────────────

/**
 * Trailing-edge debounce (ms) for realtime-subscription refetches. A single
 * engine action (e.g. a draft) writes ~9 rows that fan into multiple
 * postgres_changes events; without a debounce each event fires a full refetch
 * pipeline. Collapsing a burst into one trailing refetch cuts refetch storms
 * ~5× per device. Small enough to stay visually instant. The per-fetch-target
 * fetchSeq guards still discard any stale response that lands out of order.
 */
export const REALTIME_REFETCH_DEBOUNCE_MS = 200;

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
