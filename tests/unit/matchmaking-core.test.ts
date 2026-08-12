// ============================================================
// Unit Tests: Matchmaking Core — Pure Function Suite
// ============================================================
//
// Covers all 7 exported pure functions in matchmaking-core.ts.
// No Supabase mocks needed — these are database-free helpers.
//
// Functions under test:
//   computePriorityScore  — priority / Red Zone scoring
//   isGroupValid          — pairwise skill variance check
//   snakeDraft            — balanced team assignment
//   overlapWithRoster     — count shared players in a roster
//   isDiversityViolation  — detect repeat match groups
//   scoreCandidates       — rank candidates with overlap penalty
//   buildCombinationGroup — N-choose-3 combination search
// ============================================================

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  computePriorityScore,
  isGroupValid,
  snakeDraft,
  overlapWithRoster,
  isDiversityViolation,
  isRejectedRoster,
  scoreCandidates,
  buildCombinationGroup,
  getEffectiveLookback,
  rotatedDraft,
  pairKey,
  runAlgorithm,
  getDynamicDraftCap,
  shouldAutoPublishMatch,
  isPullEligible,
  isHeldMatchReady,
  heldDraftExpired,
  pickEarliestFinishing,
  countConsecutiveOpponentRepeats,
  isRedZonePlayer,
} from "@/lib/matchmaking-core";
import {
  CRITICAL_WAIT_MINUTES,
  GAME_PENALTY_MINUTES,
  HARD_CAP_GAMES_CEILING,
  HARD_CAP_SCORE_FLOOR,
  HARD_WAIT_CAP_MINUTES,
  RED_ZONE_SCORE_FLOOR,
  SKILL_VARIANCE_MAX,
  MAX_PARTNERSHIP_REPEATS,
  MAX_OPPONENT_REPEATS,
  FALLBACK_WAIT_MINUTES,
  MAX_CONSECUTIVE_GAMES_FOR_PULL,
  CROSS_COURT_REST_FALLBACK_MINUTES,
  CROSS_COURT_MAX_HOLD_MINUTES,
  CONSECUTIVE_OPPONENT_PENALTY,
  GAMES_AHEAD_PENALTY,
  MAX_CONSECUTIVE_OPPONENT_REPEATS,
} from "@/lib/constants";
import type { ScoredPlayer } from "@/lib/matchmaking-core";
import type { QueueWithWaitTime } from "@/types/database";

// ── Shared factory ────────────────────────────────────────────
// Creates a minimal ScoredPlayer. Fields irrelevant to a given
// test receive safe defaults (skill 3, 5 min wait, 0 games).

function makePlayer(
  id: string,
  opts: {
    skillInt: number;
    waitMinutes?: number;
    gamesPlayed?: number;
  }
): ScoredPlayer {
  const waitMinutes = opts.waitMinutes ?? 5;
  const gamesPlayed = opts.gamesPlayed ?? 0;

  const base: QueueWithWaitTime = {
    id: `entry-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: new Date(Date.now() - waitMinutes * 60_000).toISOString(),
    games_played: gamesPlayed,
    status: "waiting",
    position: null,
    is_paused: false,
    created_at: new Date().toISOString(),
    display_name: `Player-${id}`,
    skill_level: "intermediate",
    skill_level_int: opts.skillInt,
    wait_minutes: waitMinutes,
    is_bottleneck: false,
  };

  return { ...base, priorityScore: computePriorityScore(base) };
}

// ─────────────────────────────────────────────────────────────
// computePriorityScore
// ─────────────────────────────────────────────────────────────
// Three-tier urgency formula (higher score = higher urgency):
//
//   Tier 3 — Hard Cap  (score ≥ 2000)
//     Condition: wait ≥ HARD_WAIT_CAP_MINUTES (25)
//            AND games < HARD_CAP_GAMES_CEILING (5)
//     Score: HARD_CAP_SCORE_FLOOR + (wait − 25) × 10  [progressive]
//     The games ceiling prevents session-target players from crowding
//     out under-served players via the override.
//
//   Tier 2 — Red Zone  (score 1000–1999)
//     Condition: wait ≥ CRITICAL_WAIT_MINUTES (20)
//     Score: 1000 + wait − (games × GAME_PENALTY_MINUTES)
//     Game penalty still applied within Red Zone.
//
//   Tier 1 — Normal  (score unbounded below 1000)
//     Score: wait − (games × GAME_PENALTY_MINUTES)
//     NO floor — negative scores let game count drive ordering.
//
// Invariants:
//   Hard Cap > Red Zone: 2000 ≫ max(Red Zone) ≈ 1000+60 = 1060
//   Red Zone > Normal:   min(Red Zone) ≈ 1000+20−13×8 = 916 ≫ max(Normal) = 19
//
// runAlgorithm uses joined_at ASC to break exact score ties.

describe("computePriorityScore", () => {
  // ── Tier 1: Normal zone ──────────────────────────────────────

  it("returns wait_minutes when games_played=0 (normal zone)", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 10, gamesPlayed: 0 });
    expect(computePriorityScore(p)).toBe(10);
  });

  it("subtracts GAME_PENALTY per game played — wait=CRITICAL_WAIT lands in Red Zone (score ≥ 1000)", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 20, gamesPlayed: 1 });
    // 20 - 1 × 8 = 12  (positive — no floor needed)
    // Note: wait=20 = CRITICAL_WAIT_MINUTES, but gamesPlayed=1 < HARD_CAP_GAMES_CEILING=5
    // and 20 < HARD_WAIT_CAP_MINUTES=25, so hard cap does not fire.
    // wait=20 ≥ CRITICAL_WAIT_MINUTES=20 → Red Zone: 1000 + 20 - 8 = 1012
    expect(computePriorityScore(p)).toBe(RED_ZONE_SCORE_FLOOR + 20 - GAME_PENALTY_MINUTES);
  });

  it("returns a negative score when game debt exceeds wait time (no floor)", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 0, gamesPlayed: 2 });
    // 0 - 2 × 8 = -16  (no Math.max(0,…) — score CAN be negative)
    // This ensures a 2-game player at 0 min wait loses to a 2-game player at 1 min wait.
    expect(computePriorityScore(p)).toBe(-2 * GAME_PENALTY_MINUTES);
  });

  it("returns 0 for a fresh player with 0 wait and 0 games", () => {
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 0, gamesPlayed: 0 });
    expect(computePriorityScore(p)).toBe(0);
  });

  it("returns normal score at wait=19 (one minute below Red Zone boundary)", () => {
    const p = makePlayer("a", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES - 1, // 19
      gamesPlayed: 0,
    });
    // 19 < CRITICAL_WAIT_MINUTES=20 → Normal zone; 19 < HARD_WAIT_CAP_MINUTES=25 → no cap
    expect(computePriorityScore(p)).toBe(CRITICAL_WAIT_MINUTES - 1);
  });

  // ── Tier 2: Red Zone ─────────────────────────────────────────

  it("enters Red Zone exactly at CRITICAL_WAIT_MINUTES (20 min)", () => {
    const p = makePlayer("a", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES, // 20
      gamesPlayed: 0,
    });
    // 20 < HARD_WAIT_CAP_MINUTES=25 → hard cap does not fire
    // 20 ≥ CRITICAL_WAIT_MINUTES=20 → Red Zone: 1000 + 20 = 1020
    expect(computePriorityScore(p)).toBe(RED_ZONE_SCORE_FLOOR + CRITICAL_WAIT_MINUTES);
  });

  it("Red Zone still applies game penalty — fewer-games player scores higher", () => {
    const withGames = makePlayer("a", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES, // 20 — in Red Zone, below hard cap (25)
      gamesPlayed: 5, // exactly at HARD_CAP_GAMES_CEILING — NOT cap-eligible
    });
    const fresh = makePlayer("b", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES, // 20 < HARD_WAIT_CAP_MINUTES=25 — hard cap doesn't fire
      gamesPlayed: 0,
    });
    // fresh:     1000 + 20 - 0×8 = 1020
    // withGames: games_played=5 is NOT < HARD_CAP_GAMES_CEILING=5 → no hard cap
    //            Red Zone: 1000 + 20 - 5×8 = 980
    expect(computePriorityScore(fresh)).toBeGreaterThan(computePriorityScore(withGames));
    expect(computePriorityScore(fresh)).toBe(RED_ZONE_SCORE_FLOOR + CRITICAL_WAIT_MINUTES);
    expect(computePriorityScore(withGames)).toBe(
      RED_ZONE_SCORE_FLOOR + CRITICAL_WAIT_MINUTES - 5 * GAME_PENALTY_MINUTES
    );
  });

  it("any Red Zone score outranks any Normal score (realistic game counts)", () => {
    // Highest possible Normal score: wait=19 (CRITICAL_WAIT-1), games=0 → 19
    const bestNormal = makePlayer("n", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES - 1, // 19
      gamesPlayed: 0,
    });
    // Lowest realistic Red Zone score: wait=20, games=13 (max in a 4h session)
    // games=13 >= HARD_CAP_GAMES_CEILING=5 → hard cap doesn't fire
    // Red Zone: 1000 + 20 - 13×8 = 916  ≫  19 → invariant holds
    const lowestRealisticRedZone = makePlayer("r", {
      skillInt: 3,
      waitMinutes: CRITICAL_WAIT_MINUTES, // 20
      gamesPlayed: 13,
    });
    expect(computePriorityScore(lowestRealisticRedZone)).toBeGreaterThan(
      computePriorityScore(bestNormal)
    );
    expect(computePriorityScore(lowestRealisticRedZone)).toBe(
      RED_ZONE_SCORE_FLOOR + CRITICAL_WAIT_MINUTES - 13 * GAME_PENALTY_MINUTES
    );
  });

  // ── Tier 3: Hard Wait Cap ────────────────────────────────────

  it("fires hard cap at exactly HARD_WAIT_CAP_MINUTES for a cap-eligible player", () => {
    const p = makePlayer("a", {
      skillInt: 3,
      waitMinutes: HARD_WAIT_CAP_MINUTES, // 25
      gamesPlayed: 0, // 0 < HARD_CAP_GAMES_CEILING=5 → eligible
    });
    // Hard cap fires: 2000 + (25 - 25) × 10 = 2000
    expect(computePriorityScore(p)).toBe(HARD_CAP_SCORE_FLOOR);
  });

  it("hard cap score is progressive — longer wait yields higher score", () => {
    const atCap = makePlayer("a", {
      skillInt: 3,
      waitMinutes: HARD_WAIT_CAP_MINUTES, // 25 → 2000
      gamesPlayed: 2,
    });
    const beyondCap = makePlayer("b", {
      skillInt: 3,
      waitMinutes: HARD_WAIT_CAP_MINUTES + 5, // 30 → 2000 + 5×10 = 2050
      gamesPlayed: 2,
    });
    expect(computePriorityScore(atCap)).toBe(HARD_CAP_SCORE_FLOOR);
    expect(computePriorityScore(beyondCap)).toBe(
      HARD_CAP_SCORE_FLOOR + Math.round((HARD_WAIT_CAP_MINUTES + 5 - HARD_WAIT_CAP_MINUTES) * 10)
    );
    expect(computePriorityScore(beyondCap)).toBeGreaterThan(computePriorityScore(atCap));
  });

  it("hard cap does NOT fire when games_played >= HARD_CAP_GAMES_CEILING", () => {
    // A player at the session target (5 games) is not cap-eligible — they use Red Zone instead.
    const atCeiling = makePlayer("a", {
      skillInt: 3,
      waitMinutes: HARD_WAIT_CAP_MINUTES + 10, // 35 — would trigger cap if eligible
      gamesPlayed: HARD_CAP_GAMES_CEILING, // 5 — NOT < 5 → ineligible
    });
    const score = computePriorityScore(atCeiling);
    // Should be Red Zone (wait=35 ≥ CRITICAL_WAIT_MINUTES=20), not Hard Cap.
    // NOTE: game penalty can push the actual score below RED_ZONE_SCORE_FLOOR (1000):
    //   1000 + 35 − 5×8 = 995  — still above any Normal score, but below the sentinel.
    //   RED_ZONE_SCORE_FLOOR is the addend, not a guaranteed floor for the result.
    expect(score).toBeLessThan(HARD_CAP_SCORE_FLOOR);
    expect(score).toBe(RED_ZONE_SCORE_FLOOR + 35 - HARD_CAP_GAMES_CEILING * GAME_PENALTY_MINUTES);
  });

  // ─────────────────────────────────────────────────────────────
  // isRedZonePlayer — the score threshold is NOT the Red Zone condition
  // ─────────────────────────────────────────────────────────────
  // Regression cover for a bug that lived at five call sites: they each asked
  // `priorityScore >= RED_ZONE_SCORE_FLOOR`, which is not the Red Zone
  // condition. Tier 2 returns `1000 + wait - games×8`, so the score drops below
  // the addend whenever game debt outruns the wait. Verified against production
  // (318 auto-created matches; 20 anchors at wait >= 20 reconstructed below
  // 1000). These tests are written against computePriorityScore's real output —
  // makePlayer derives priorityScore rather than accepting one — so they cannot
  // pass by asserting a hand-set score.
  describe("isRedZonePlayer", () => {
    it("[RZ-1] wait 22 / 3 games scores 998 yet IS in the Red Zone", () => {
      const p = makePlayer("rz", { skillInt: 3, waitMinutes: 22, gamesPlayed: 3 });

      // The headline case: below the addend, above the condition.
      expect(p.priorityScore).toBe(RED_ZONE_SCORE_FLOOR + 22 - 3 * GAME_PENALTY_MINUTES);
      expect(p.priorityScore).toBe(998);
      expect(p.priorityScore).toBeLessThan(RED_ZONE_SCORE_FLOOR);

      expect(p.wait_minutes).toBeGreaterThanOrEqual(CRITICAL_WAIT_MINUTES);
      expect(isRedZonePlayer(p)).toBe(true);
      // Pin the divergence itself, so a "simplification" back to the score test
      // fails here rather than silently in the engine.
      expect(p.priorityScore >= RED_ZONE_SCORE_FLOOR).toBe(false);
    });

    it("[RZ-2] the Hard-Cap games ceiling drops long waiters INTO the gap", () => {
      // HARD_CAP_GAMES_CEILING excludes games >= 5 from Tier 3, so a player at
      // wait 30 with 5 games falls through to Tier 2 and lands below the addend.
      // This is the most-served-but-longest-waiting player — the compounding
      // case, since they lose the widened skill window AND their swap
      // protection AND the capped overlap penalty simultaneously.
      const p = makePlayer("ceil", {
        skillInt: 3,
        waitMinutes: 30,
        gamesPlayed: HARD_CAP_GAMES_CEILING,
      });
      expect(p.priorityScore).toBe(990);
      expect(p.priorityScore).toBeLessThan(RED_ZONE_SCORE_FLOOR);
      expect(p.priorityScore).toBeLessThan(HARD_CAP_SCORE_FLOOR); // not Tier 3
      expect(isRedZonePlayer(p)).toBe(true);
    });

    it("[RZ-3] the boundary: wait 19 is out, wait 20 is in, at any game count", () => {
      for (const games of [0, 3, 5, 9]) {
        expect(
          isRedZonePlayer(
            makePlayer("b", {
              skillInt: 3,
              waitMinutes: CRITICAL_WAIT_MINUTES - 1,
              gamesPlayed: games,
            })
          )
        ).toBe(false);
        expect(
          isRedZonePlayer(
            makePlayer("b", { skillInt: 3, waitMinutes: CRITICAL_WAIT_MINUTES, gamesPlayed: games })
          )
        ).toBe(true);
      }
    });

    it("[RZ-4] the score arm still fires — kept as a constant-drift guard", () => {
      // The wait arm subsumes the score arm today (Tier 1 would need a
      // 1000-minute wait; Tier 3 already implies wait >= 25). The score arm
      // exists so that if the tiers are ever re-cut, a high-scoring player is
      // still caught. Assert it independently of the wait arm.
      expect(isRedZonePlayer({ wait_minutes: 0, priorityScore: RED_ZONE_SCORE_FLOOR })).toBe(true);
      expect(isRedZonePlayer({ wait_minutes: 0, priorityScore: RED_ZONE_SCORE_FLOOR - 1 })).toBe(
        false
      );
    });

    it("[RZ-5] a pulled body is never Red Zone", () => {
      // fetchPullablePlayers hardcodes wait_minutes 0 / priorityScore -1, so
      // this is a no-op today. It is asserted so that changing that hardcode
      // cannot silently make still-playing bodies un-benchable in the
      // balance-preserving swap.
      expect(isRedZonePlayer({ wait_minutes: 0, priorityScore: -1, isPulled: true })).toBe(false);
      expect(isRedZonePlayer({ wait_minutes: 99, priorityScore: 9999, isPulled: true })).toBe(
        false
      );
      // Same player, not pulled → Red Zone. Isolates isPulled as the cause.
      expect(isRedZonePlayer({ wait_minutes: 99, priorityScore: 9999 })).toBe(true);
    });

    it("[RZ-6] a null wait_minutes falls back to 0, not to Red Zone", () => {
      // QueueWithWaitTime types wait_minutes as `number`, but computePriorityScore
      // has always guarded it with `?? 0` and isRedZonePlayer matches that idiom.
      // The cast is the point of the test: it pins the defensive branch so the
      // `??` cannot be "cleaned up" on the strength of the type alone. If the
      // view really can never return null, delete the `??` and this test
      // together — not one without the other.
      const nullWait = { wait_minutes: null, priorityScore: 0 } as unknown as Pick<
        ScoredPlayer,
        "wait_minutes" | "priorityScore"
      >;
      expect(isRedZonePlayer(nullWait)).toBe(false);
    });
  });

  it("hard cap does NOT fire below HARD_WAIT_CAP_MINUTES even for eligible player", () => {
    // wait=24 — one minute below the cap; goes to Red Zone instead
    const p = makePlayer("a", {
      skillInt: 3,
      waitMinutes: HARD_WAIT_CAP_MINUTES - 1, // 24
      gamesPlayed: 0, // eligible by games count
    });
    const score = computePriorityScore(p);
    // Red Zone (24 ≥ 20) but not Hard Cap (24 < 25)
    expect(score).toBeLessThan(HARD_CAP_SCORE_FLOOR);
    expect(score).toBe(RED_ZONE_SCORE_FLOOR + (HARD_WAIT_CAP_MINUTES - 1));
  });

  it("hard cap always outranks Red Zone regardless of game penalty", () => {
    // Best Red Zone score: 0 games, very long wait (e.g. 60 min)
    const bestRedZone = makePlayer("r", {
      skillInt: 3,
      waitMinutes: 60,
      gamesPlayed: HARD_CAP_GAMES_CEILING, // ineligible for hard cap
    });
    // Minimum hard cap score: exactly at cap threshold, 0 extra wait
    const minHardCap = makePlayer("h", {
      skillInt: 3,
      waitMinutes: HARD_WAIT_CAP_MINUTES, // 25
      gamesPlayed: 0, // eligible
    });
    expect(computePriorityScore(minHardCap)).toBeGreaterThan(computePriorityScore(bestRedZone));
    expect(computePriorityScore(minHardCap)).toBe(HARD_CAP_SCORE_FLOOR);
  });

  // ── Null safety ───────────────────────────────────────────────

  it("treats null wait_minutes as 0 via nullish coalescing", () => {
    // The type says number, but the implementation guards with ?? 0.
    // This ensures runtime safety when the view returns null.
    const p = makePlayer("a", { skillInt: 3, waitMinutes: 0, gamesPlayed: 2 });
    const withNullWait = { ...p, wait_minutes: null as unknown as number };
    // null ?? 0 = 0 → 0 - 2×8 = -16  (no floor)
    expect(computePriorityScore(withNullWait)).toBe(-2 * GAME_PENALTY_MINUTES);
  });
});

// ─────────────────────────────────────────────────────────────
// isGroupValid
// ─────────────────────────────────────────────────────────────
// Returns true iff every pairwise skill diff ≤ maxVariance.

describe("isGroupValid", () => {
  it("returns true for 4 identical skill levels", () => {
    const group = [
      makePlayer("1", { skillInt: 4 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 4 }),
    ];
    expect(isGroupValid(group, SKILL_VARIANCE_MAX)).toBe(true);
  });

  it("returns true when max pairwise diff equals maxVariance (boundary)", () => {
    // Skills: 3, 3, 5, 5 — max diff = |3-5| = 2 = SKILL_VARIANCE_MAX
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 3 }),
      makePlayer("3", { skillInt: 5 }),
      makePlayer("4", { skillInt: 5 }),
    ];
    expect(isGroupValid(group, SKILL_VARIANCE_MAX)).toBe(true);
  });

  it("returns false when any pairwise diff exceeds maxVariance", () => {
    // Skills: 3, 4, 4, 6 — |3-6| = 3 > 2
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 6 }),
    ];
    expect(isGroupValid(group, SKILL_VARIANCE_MAX)).toBe(false);
  });

  it("returns false when max diff equals SKILL_VARIANCE_MAX+1 at tight window (±1)", () => {
    const group = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 5 }),
      makePlayer("4", { skillInt: 4 }),
    ];
    // |3-5| = 2 > SKILL_VARIANCE_TARGET(1)
    expect(isGroupValid(group, 1)).toBe(false);
  });

  it("returns true at ±4 window for skills spread across 4 levels", () => {
    // Red Zone expanded window: [2, 4, 4, 6] — max diff = |2-6| = 4
    const group = [
      makePlayer("1", { skillInt: 2 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 6 }),
    ];
    expect(isGroupValid(group, 4)).toBe(true);
  });

  it("returns true for a single player (vacuously — no pairs)", () => {
    const group = [makePlayer("1", { skillInt: 3 })];
    expect(isGroupValid(group, 0)).toBe(true);
  });

  it("returns true for exactly 2 players within variance", () => {
    const group = [makePlayer("1", { skillInt: 3 }), makePlayer("2", { skillInt: 4 })];
    expect(isGroupValid(group, 1)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// snakeDraft
// ─────────────────────────────────────────────────────────────
// Sorts 4 players DESC by skill, assigns:
//   teamA = [sorted[0] (best), sorted[3] (worst)]
//   teamB = [sorted[1] (2nd),  sorted[2] (3rd)]
// This minimises the inter-team skill gap.

describe("snakeDraft", () => {
  it("produces exactly 2 players per team", () => {
    const players = [
      makePlayer("1", { skillInt: 6 }),
      makePlayer("2", { skillInt: 5 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 3 }),
    ];
    // No cap args → always returns the balanced split (never null).
    const result = snakeDraft(players);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    expect(teamA).toHaveLength(2);
    expect(teamB).toHaveLength(2);
  });

  it("assigns highest + lowest skill to teamA, 2nd + 3rd to teamB", () => {
    const p6 = makePlayer("6", { skillInt: 6 });
    const p5 = makePlayer("5", { skillInt: 5 });
    const p4 = makePlayer("4", { skillInt: 4 });
    const p3 = makePlayer("3", { skillInt: 3 });

    // Pass in shuffled order — snakeDraft sorts internally
    const result = snakeDraft([p3, p6, p4, p5]);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;

    const teamASkills = teamA
      .map((p: ScoredPlayer) => p.skill_level_int)
      .sort((a: number, b: number) => a - b);
    const teamBSkills = teamB
      .map((p: ScoredPlayer) => p.skill_level_int)
      .sort((a: number, b: number) => a - b);

    // teamA gets [6, 3], teamB gets [5, 4]
    expect(teamASkills).toEqual([3, 6]);
    expect(teamBSkills).toEqual([4, 5]);
  });

  it("produces balanced team skill sums for evenly-spaced players", () => {
    // [3, 4, 5, 6] → teamA=[6,3]=9, teamB=[5,4]=9
    const players = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 5 }),
      makePlayer("4", { skillInt: 6 }),
    ];
    const result = snakeDraft(players);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    const sumA = teamA.reduce((s: number, p: ScoredPlayer) => s + p.skill_level_int, 0);
    const sumB = teamB.reduce((s: number, p: ScoredPlayer) => s + p.skill_level_int, 0);
    expect(sumA).toBe(sumB);
  });

  it("does not mutate the original array order", () => {
    const players = [
      makePlayer("1", { skillInt: 3 }),
      makePlayer("2", { skillInt: 6 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 5 }),
    ];
    const originalOrder = players.map((p) => p.player_id);
    snakeDraft(players);
    expect(players.map((p) => p.player_id)).toEqual(originalOrder);
  });

  it("handles all-same-skill players (stable assignment — 2 per team)", () => {
    const players = [
      makePlayer("1", { skillInt: 4 }),
      makePlayer("2", { skillInt: 4 }),
      makePlayer("3", { skillInt: 4 }),
      makePlayer("4", { skillInt: 4 }),
    ];
    const result = snakeDraft(players);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    expect(teamA).toHaveLength(2);
    expect(teamB).toHaveLength(2);
    // All IDs should be accounted for with no duplicates
    const allIds = [...teamA, ...teamB].map((p) => p.player_id);
    expect(new Set(allIds).size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────
// overlapWithRoster
// ─────────────────────────────────────────────────────────────
// Counts how many playerIds appear in a single match roster.

describe("overlapWithRoster", () => {
  it("returns 0 when no player is in the roster", () => {
    expect(overlapWithRoster(["p1", "p2"], ["p3", "p4"])).toBe(0);
  });

  it("returns 1 when exactly one player overlaps", () => {
    expect(overlapWithRoster(["p1", "p2", "p3", "p4"], ["p1", "p5", "p6", "p7"])).toBe(1);
  });

  it("returns 4 when all players overlap (exact repeat)", () => {
    const ids = ["p1", "p2", "p3", "p4"];
    expect(overlapWithRoster(ids, ids)).toBe(4);
  });

  it("returns 0 for an empty roster", () => {
    expect(overlapWithRoster(["p1", "p2"], [])).toBe(0);
  });

  it("returns 0 for empty playerIds", () => {
    expect(overlapWithRoster([], ["p1", "p2", "p3", "p4"])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// isDiversityViolation
// ─────────────────────────────────────────────────────────────
// Returns true iff ≥3 of the 4 proposed player IDs appeared
// together in any single recent match roster.

describe("isDiversityViolation", () => {
  const proposed = ["p1", "p2", "p3", "p4"];

  it("returns false when no roster overlaps", () => {
    const rosters = [["p5", "p6", "p7", "p8"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(false);
  });

  it("returns false for exactly 2-player overlap (below threshold)", () => {
    // Only p1, p2 from proposed are in this roster
    const rosters = [["p1", "p2", "p9", "p10"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(false);
  });

  it("returns true at exactly 3-player overlap (meets threshold)", () => {
    const rosters = [["p1", "p2", "p3", "p9"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(true);
  });

  it("returns true for full 4-player repeat (exact same match)", () => {
    const rosters = [["p1", "p2", "p3", "p4"]];
    expect(isDiversityViolation(proposed, rosters)).toBe(true);
  });

  it("returns true when only one roster in the list violates", () => {
    const rosters = [
      ["p5", "p6", "p7", "p8"], // no overlap
      ["p1", "p2", "p3", "p9"], // 3 overlap → violation
    ];
    expect(isDiversityViolation(proposed, rosters)).toBe(true);
  });

  it("returns false when multiple rosters all have ≤2 overlap", () => {
    const rosters = [
      ["p1", "p2", "p9", "p10"],
      ["p3", "p4", "p11", "p12"],
    ];
    expect(isDiversityViolation(proposed, rosters)).toBe(false);
  });

  it("returns false for an empty rosters list", () => {
    expect(isDiversityViolation(proposed, [])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// scoreCandidates
// ─────────────────────────────────────────────────────────────
// Scoring formula:
//   Normal   (priority < 1000): score = -priority + overlap × 10_000
//   Red Zone (priority ≥ 1000): score = -priority + overlap × 100
// Sorted ascending → lowest score = highest priority.

describe("scoreCandidates", () => {
  it("returns an empty array for empty input", () => {
    expect(scoreCandidates([], new Map())).toEqual([]);
  });

  it("score for a single candidate with no overlap equals -priorityScore", () => {
    const p = makePlayer("a", { skillInt: 4, waitMinutes: 10, gamesPlayed: 0 });
    // Normal zone: priorityScore = 10
    const [result] = scoreCandidates([p], new Map());
    expect(result.score).toBe(-10);
    expect(result.candidate.player_id).toBe("a");
  });

  it("higher-priority candidate ranks first when both have no overlap", () => {
    const high = makePlayer("h", { skillInt: 4, waitMinutes: 20, gamesPlayed: 0 });
    const low = makePlayer("l", { skillInt: 4, waitMinutes: 5, gamesPlayed: 0 });
    const scored = scoreCandidates([low, high], new Map());
    // high: wait=20 = CRITICAL_WAIT_MINUTES → Red Zone, score = -1020
    // low:  wait=5  → Normal, score = -5
    // -1020 < -5 → high sorts first
    expect(scored[0].candidate.player_id).toBe("h");
  });

  it("normal overlap penalty is 10_000 × count", () => {
    const p = makePlayer("a", { skillInt: 4, waitMinutes: 10, gamesPlayed: 0 });
    // Normal zone: 1 overlap → -10 + 10_000 = 9_990
    const [result] = scoreCandidates([p], new Map([["a", 1]]));
    expect(result.score).toBe(-10 + 10_000);
  });

  it("Red Zone overlap penalty is capped at 100 × count (not 10_000)", () => {
    const p = makePlayer("a", {
      skillInt: 4,
      // Use CRITICAL_WAIT_MINUTES + 2 (= 22): in Red Zone (≥ 20), below Hard Cap (< 25)
      waitMinutes: CRITICAL_WAIT_MINUTES + 2, // 22 min → score 1022
      gamesPlayed: 0,
    });
    // Red Zone: priorityScore = 1022, 1 overlap → -1022 + 100 = -922
    const [result] = scoreCandidates([p], new Map([["a", 1]]));
    expect(result.score).toBe(-(RED_ZONE_SCORE_FLOOR + CRITICAL_WAIT_MINUTES + 2) + 100);
  });

  it("Red Zone candidate with 1 overlap outranks normal candidate with 0 overlap", () => {
    const rz = makePlayer("rz", {
      skillInt: 4,
      // wait=30, games=0 → Hard Cap fires (30 ≥ 25, 0 < 5): score=2050
      // isRedZone check (priorityScore ≥ 1000) → true; 1 overlap → penalty=100
      // scoreCandidates score: -2050 + 100 = -1950
      waitMinutes: 30,
    });
    const normal = makePlayer("n", {
      skillInt: 4,
      waitMinutes: 2, // Normal: score=2, 0 overlap → -2
    });
    const overlapMap = new Map([["rz", 1]]);
    const scored = scoreCandidates([rz, normal], overlapMap);
    // -1950 < -2 → Hard Cap / Red Zone candidate ranks first
    expect(scored[0].candidate.player_id).toBe("rz");
  });

  it("Hard Cap candidate with 2 overlaps (200) still outranks Red Zone with 1 overlap (100)", () => {
    // rz: wait=30, games=0 → Hard Cap (30≥25, 0<5): score=2050. 2 overlaps → penalty=200 → -2050+200=-1850
    const rz = makePlayer("rz", { skillInt: 4, waitMinutes: 30 });
    // normal: wait=20 = CRITICAL_WAIT_MINUTES → Red Zone: score=1020. 1 overlap → penalty=100 → -1020+100=-920
    const normal = makePlayer("n", { skillInt: 4, waitMinutes: 20 });
    const overlapMap = new Map([
      ["rz", 2],
      ["n", 1],
    ]);
    const scored = scoreCandidates([rz, normal], overlapMap);
    // -1850 < -920 → Hard Cap candidate ranks first despite 2 overlaps
    expect(scored[0].candidate.player_id).toBe("rz");
  });

  // ── RZ-SC1 / RZ-SC2 — the BELOW-FLOOR Red Zone cohort, through scoreCandidates.
  //
  // These pin the largest behavioural change in the isRedZonePlayer fix. Every
  // test above reaches Red Zone through the SCORE arm (wait 20+ with 0 games, or
  // the Hard Cap tier), so all of them pass identically with the old score-only
  // test. Nothing exercised the cohort the fix actually adds: wait >= 20 with
  // games × 8 > wait, whose priorityScore lands BELOW RED_ZONE_SCORE_FLOOR.
  //
  // That cohort is, by definition, the high-games cohort — so it is exactly the
  // cohort that pays GAMES_AHEAD_PENALTY. Both terms flip at once.

  it("RZ-SC1: below-floor Red Zone candidate gets the CAPPED games-ahead penalty (100, not 10_000)", () => {
    // wait 22 / 3 games → 1000 + 22 − 24 = 998. In the Red Zone (22 >= 20) but
    // BELOW the floor, which is the whole point of the fixture.
    const dense = makePlayer("dense", { skillInt: 4, waitMinutes: 22, gamesPlayed: 3 });
    expect(dense.priorityScore).toBe(998);
    expect(dense.priorityScore >= RED_ZONE_SCORE_FLOOR).toBe(false);

    // A never-played waiter just under the threshold — Normal by any test.
    const fresh = makePlayer("fresh", { skillInt: 4, waitMinutes: 19, gamesPlayed: 0 });
    expect(fresh.priorityScore).toBe(19);

    const scored = scoreCandidates([dense, fresh], new Map(), 0);

    // Red Zone → gamesAhead 3 × GAMES_AHEAD_PENALTY_RED_ZONE (100) = 300.
    // Under the old score-only test this was 3 × 10_000 = 30_000 → +29_002,
    // which sorted the candidate DEAD LAST instead of first.
    expect(scored.find((s) => s.candidate.player_id === "dense")!.score).toBe(-998 + 300);
    expect(scored.find((s) => s.candidate.player_id === "fresh")!.score).toBe(-19);
    expect(scored[0].candidate.player_id).toBe("dense");
  });

  it("RZ-SC2: below-floor Red Zone candidate gets the CAPPED overlap penalty (100, not 10_000)", () => {
    const dense = makePlayer("dense", { skillInt: 4, waitMinutes: 22, gamesPlayed: 3 });
    expect(dense.priorityScore).toBe(998);
    expect(dense.priorityScore >= RED_ZONE_SCORE_FLOOR).toBe(false);

    // poolMinGames omitted so gamesAhead is 0 and this isolates the overlap term.
    const [result] = scoreCandidates([dense], new Map([["dense", 1]]));
    expect(result.score).toBe(-998 + 100); // was -998 + 10_000 = 9_002
  });

  it("RZ-SC3: the second cohort — wait >= 25 with games >= 5 falls through Tier 3 and is still Red Zone", () => {
    // HARD_CAP_GAMES_CEILING (5) excludes this player from Tier 3, so they land
    // in Tier 2 and score 1000 + 30 − 40 = 990 — below the floor despite having
    // the longest wait in the pool. Worst-affected group in the app.
    const stranded = makePlayer("stranded", { skillInt: 4, waitMinutes: 30, gamesPlayed: 5 });
    expect(stranded.priorityScore).toBe(990);
    expect(stranded.priorityScore >= RED_ZONE_SCORE_FLOOR).toBe(false);

    const [result] = scoreCandidates([stranded], new Map([["stranded", 1]]), 0);
    // Red Zone on both terms: overlap 1 × 100, gamesAhead 5 × 100.
    expect(result.score).toBe(-990 + 100 + 500); // was -990 + 10_000 + 50_000
  });

  it("results are sorted ascending by score (best first) with concrete expected values", () => {
    const players = [
      makePlayer("low", { skillInt: 4, waitMinutes: 2 }), // priorityScore=2  → score=-2
      makePlayer("high", { skillInt: 4, waitMinutes: 15 }), // priorityScore=15 → score=-15  (Normal: < 20)
      makePlayer("mid", { skillInt: 4, waitMinutes: 10 }), // priorityScore=10 → score=-10
    ];
    const scored = scoreCandidates(players, new Map());
    // Sorted ascending: -15 (high) → -10 (mid) → -2 (low)
    expect(scored.map((s) => s.score)).toEqual([-15, -10, -2]);
    expect(scored.map((s) => s.candidate.player_id)).toEqual(["high", "mid", "low"]);
  });
});

// ─────────────────────────────────────────────────────────────
// buildCombinationGroup
// ─────────────────────────────────────────────────────────────
// N-choose-3 combination search.
// Returns the first valid triple [anchor + triple = 4 valid players].
// "First valid" in priority order = optimal group.

describe("buildCombinationGroup", () => {
  it("returns [] when fewer than 3 candidates are available", () => {
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const only2 = scoreCandidates(
      [makePlayer("a", { skillInt: 4 }), makePlayer("b", { skillInt: 4 })],
      new Map()
    );
    expect(buildCombinationGroup(anchor, only2, SKILL_VARIANCE_MAX)).toEqual([]);
  });

  it("returns all 3 candidates when exactly 3 are available and all valid", () => {
    const anchor = makePlayer("anchor", { skillInt: 4, waitMinutes: 10 });
    const candidates = [
      makePlayer("a", { skillInt: 4, waitMinutes: 9 }),
      makePlayer("b", { skillInt: 4, waitMinutes: 8 }),
      makePlayer("c", { skillInt: 4, waitMinutes: 7 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
  });

  it("returns [] when exactly 3 candidates exist but skill spread violates maxVariance", () => {
    // Anchor skill=4, candidate skill=7 → |4-7|=3 > maxVariance(2)
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const candidates = [
      makePlayer("a", { skillInt: 7 }),
      makePlayer("b", { skillInt: 7 }),
      makePlayer("c", { skillInt: 7 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX)).toEqual([]);
  });

  it("skips candidates that violate cross-group variance even if valid against anchor", () => {
    // Anchor skill=5. All candidates within ±2 of anchor.
    // But a(skill=7) vs b(skill=3) → |7-3|=4 > maxVariance.
    // Only triple [b,c,d] is internally valid.
    const anchor = makePlayer("anchor", { skillInt: 5 });
    const a = makePlayer("a", { skillInt: 7 }); // valid vs anchor (|7-5|=2), invalid vs b
    const b = makePlayer("b", { skillInt: 3 }); // valid vs anchor (|5-3|=2)
    const c = makePlayer("c", { skillInt: 4 }); // valid vs all
    const d = makePlayer("d", { skillInt: 5 }); // valid vs all
    const scored = scoreCandidates([a, b, c, d], new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
    const ids = group.map((p) => p.player_id);
    expect(ids).not.toContain("a"); // a breaks group validity
  });

  it("greedy trap: finds valid triple even when top-priority candidate blocks the group", () => {
    // Regression for Audit Rec #1.
    // Anchor skill=5. Candidate A (highest priority) has skill=7 —
    // valid vs anchor (±2) but would break any triple with skill<5.
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10, gamesPlayed: 1 });
    const a = makePlayer("A", { skillInt: 7, waitMinutes: 15, gamesPlayed: 0 }); // highest priority
    const b = makePlayer("B", { skillInt: 3, waitMinutes: 8, gamesPlayed: 0 });
    const c = makePlayer("C", { skillInt: 4, waitMinutes: 7, gamesPlayed: 0 });
    const d = makePlayer("D", { skillInt: 5, waitMinutes: 6, gamesPlayed: 0 });

    const scored = scoreCandidates([a, b, c, d], new Map());
    // Verify A is ranked first (greedy would lock it in and fail)
    expect(scored[0].candidate.player_id).toBe("A");

    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
    expect(group.map((p) => p.player_id)).not.toContain("A");
    // The result [anchor + group] must be fully valid
    expect(isGroupValid([anchor, ...group], SKILL_VARIANCE_MAX)).toBe(true);
  });

  it("respects tight maxVariance=1 (SKILL_VARIANCE_TARGET)", () => {
    // All three valid candidates must be mutually within ±1 of each other.
    // {4,5,3} fails because |5-3|=2 > 1. Use {4,4,5} instead — every pair ≤1.
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const within1 = [
      makePlayer("a", { skillInt: 4 }), // |4-4|=0 vs anchor and b
      makePlayer("b", { skillInt: 4 }), // |4-4|=0 vs anchor and a
      makePlayer("c", { skillInt: 5 }), // |5-4|=1 vs anchor, a, b — all ≤ 1
    ];
    const out = makePlayer("d", { skillInt: 6 }); // |6-4|=2 > 1 → excluded
    const scored = scoreCandidates([...within1, out], new Map());
    const group = buildCombinationGroup(anchor, scored, 1);
    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], 1)).toBe(true);
    // d (skill=6) must not appear in the result
    expect(group.map((p) => p.player_id)).not.toContain("d");
  });

  it("succeeds at maxVariance=3 for Red Zone expanded window", () => {
    // Skills spread: anchor=3, candidates at 6. |3-6|=3 — invalid at ±2, valid at ±3.
    const anchor = makePlayer("anchor", { skillInt: 3 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }),
      makePlayer("b", { skillInt: 6 }),
      makePlayer("c", { skillInt: 6 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, 2)).toEqual([]); // ±2: fails
    expect(buildCombinationGroup(anchor, scored, 3)).toHaveLength(3); // ±3: succeeds
  });

  it("returns [] when ALL possible combinations fail validation", () => {
    // Anchor skill=4. All candidates either ±0 from anchor but
    // mutually incompatible → this should never happen in practice
    // since isGroupValid only checks anchor–candidates, but let's
    // use a range that genuinely produces no valid triple.
    const anchor = makePlayer("anchor", { skillInt: 4 });
    // Use maxVariance=0: only same-skill players are eligible.
    // Candidates at skill 5 all fail against anchor at variance 0.
    const candidates = [
      makePlayer("a", { skillInt: 5 }),
      makePlayer("b", { skillInt: 5 }),
      makePlayer("c", { skillInt: 5 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, 0)).toEqual([]);
  });

  it("handles large candidate pool (C(10,3)=120 iterations) without error", () => {
    const anchor = makePlayer("anchor", { skillInt: 4 });
    // 10 candidates, all at skill 4 — first triple found immediately
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makePlayer(`p${i}`, { skillInt: 4, waitMinutes: 10 - i })
    );
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], SKILL_VARIANCE_MAX)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// isMixed boundary (via SKILL_VARIANCE_MAX constant)
// ─────────────────────────────────────────────────────────────
// In runAlgorithm: isMixed = maxVariance > SKILL_VARIANCE_MAX (2).
// A group formed at ±2 is a NORMAL match. A group formed at ±3 or
// ±4 (Red Zone expansion) is flagged isMixed=true.
// These tests verify the skill window boundary using buildCombinationGroup:
//   - ±2 accepts skill spread of 2 → NOT isMixed
//   - ±3 accepts spread of 3 but REJECTS spread of 2+ε at ±2 → IS isMixed
//   - ±4 accepts spread of 4 but REJECTS spread of 3+ε at ±3 → IS isMixed

describe("isMixed level boundary (maxVariance > SKILL_VARIANCE_MAX)", () => {
  it("maxVariance=SKILL_VARIANCE_MAX(2) forms a valid group — this is the normal-match boundary", () => {
    // A player at skill=6 is exactly |6-4|=2 from anchor(4) = SKILL_VARIANCE_MAX.
    // At maxVariance=2, this is accepted. isMixed = 2 > SKILL_VARIANCE_MAX(2) = false.
    const anchor = makePlayer("anchor", { skillInt: 4 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }), // |6-4|=2 — right at the boundary
      makePlayer("b", { skillInt: 4 }),
      makePlayer("c", { skillInt: 4 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    // Group forms at ±SKILL_VARIANCE_MAX → a normal (non-mixed) match
    expect(group).toHaveLength(3);
    expect(isGroupValid([anchor, ...group], SKILL_VARIANCE_MAX)).toBe(true);
    // The boundary value itself: 2 is NOT greater than SKILL_VARIANCE_MAX(2)
    expect(2 > SKILL_VARIANCE_MAX).toBe(false);
  });

  it("maxVariance=3 (Red Zone ±3 window) accepts spread rejected at ±2 — IS isMixed", () => {
    // skill spread of 3: anchor=3, candidates at 6. |6-3|=3 > SKILL_VARIANCE_MAX(2).
    // Fails at ±2, succeeds at ±3. Any group formed here → isMixed = 3 > 2 = true.
    const anchor = makePlayer("anchor", { skillInt: 3 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }), // |6-3|=3: rejected at ±2
      makePlayer("b", { skillInt: 6 }),
      makePlayer("c", { skillInt: 6 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX)).toEqual([]); // ±2 fails
    expect(buildCombinationGroup(anchor, scored, 3)).toHaveLength(3); // ±3 succeeds
    expect(3 > SKILL_VARIANCE_MAX).toBe(true); // isMixed flag would be set
  });

  it("maxVariance=4 (widest Red Zone window) accepts spread of 4 — IS isMixed", () => {
    // skill spread of 4: anchor=2, candidates at 6. |6-2|=4.
    // Fails at ±2 and ±3, succeeds only at ±4. isMixed = 4 > 2 = true.
    const anchor = makePlayer("anchor", { skillInt: 2 });
    const candidates = [
      makePlayer("a", { skillInt: 6 }), // |6-2|=4: only valid at maxVariance=4
      makePlayer("b", { skillInt: 6 }),
      makePlayer("c", { skillInt: 6 }),
    ];
    const scored = scoreCandidates(candidates, new Map());
    expect(buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX)).toEqual([]); // ±2 fails
    expect(buildCombinationGroup(anchor, scored, 3)).toEqual([]); // ±3 fails
    expect(buildCombinationGroup(anchor, scored, 4)).toHaveLength(3); // ±4 succeeds
    expect(4 > SKILL_VARIANCE_MAX).toBe(true); // isMixed flag would be set
  });
});

// ─────────────────────────────────────────────────────────────
// getEffectiveLookback
// ─────────────────────────────────────────────────────────────
// Scales the anti-repeat lookback window to the eligible pool size.
// Thresholds (eligiblePoolSize = eligible candidates + anchor):
//   ≤ 5  → 2  (nearly isolated tier — only avoid the last match)
//   6–9  → 3  (small pool — Thursday-night 6-player scenario)
//   10–15 → 4  (medium session)
//   16+  → 5  (full memory — unchanged from original behaviour)
//
// Why this matters: a fixed lookback of 5 collapses a 4-player
// pool after 1–2 matches because every new combination was already
// seen. Shorter memory for smaller pools prevents that failure mode.

describe("getEffectiveLookback", () => {
  it("returns 2 for pool size of 1 (minimum meaningful input)", () => {
    expect(getEffectiveLookback(1)).toBe(2);
  });

  it("returns 2 for pool size of 4 (typical gate-hold scenario)", () => {
    expect(getEffectiveLookback(4)).toBe(2);
  });

  it("returns 2 at the upper boundary of the ≤5 bracket (poolSize=5)", () => {
    expect(getEffectiveLookback(5)).toBe(2);
  });

  it("returns 3 at the first entry of the 6–9 bracket (poolSize=6)", () => {
    expect(getEffectiveLookback(6)).toBe(3);
  });

  it("returns 3 at the upper boundary of the 6–9 bracket (poolSize=9)", () => {
    expect(getEffectiveLookback(9)).toBe(3);
  });

  it("returns 4 at the first entry of the 10–15 bracket (poolSize=10)", () => {
    expect(getEffectiveLookback(10)).toBe(4);
  });

  it("returns 4 at the upper boundary of the 10–15 bracket (poolSize=15)", () => {
    expect(getEffectiveLookback(15)).toBe(4);
  });

  it("returns 7 at the first entry of the 16+ bracket (poolSize=16)", () => {
    expect(getEffectiveLookback(16)).toBe(7);
  });

  it("returns 7 for large full-session pools (poolSize=30)", () => {
    // Increased from 5 — ROSTER_LOOKBACK_COUNT=10 is now fetched so lookback
    // can safely exceed the old ANTI_REPEAT_LOOKBACK=5 limit.
    expect(getEffectiveLookback(30)).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────
// rotatedDraft
// ─────────────────────────────────────────────────────────────
// Used when the same 4 players must play again (forced repeat).
// Cycles through 3 team splits so the pairing changes each time:
//
//   splitIndex = repeatCount % 3
//   (repeatCount = number of recent rosters containing ALL 4 players)
//
//   Split 0 (0 repeats): teamA=[sorted[0], sorted[3]], teamB=[sorted[1], sorted[2]]
//                        ↑ identical to snakeDraft (highest + lowest vs 2nd + 3rd)
//   Split 1 (1 repeat):  teamA=[sorted[0], sorted[1]], teamB=[sorted[2], sorted[3]]
//                        ↑ top pair vs bottom pair
//   Split 2 (2 repeats): teamA=[sorted[0], sorted[2]], teamB=[sorted[1], sorted[3]]
//                        ↑ alternating cross-split
//   3 repeats → splitIndex = 3 % 3 = 0 → cycles back to snake
//
// Input players are sorted DESC by skill internally; input order does not matter.

describe("rotatedDraft", () => {
  // 4 players with distinct skill levels — sorted DESC → [p6, p5, p4, p3]
  function makeFour() {
    const p6 = makePlayer("p6", { skillInt: 6 });
    const p5 = makePlayer("p5", { skillInt: 5 });
    const p4 = makePlayer("p4", { skillInt: 4 });
    const p3 = makePlayer("p3", { skillInt: 3 });
    return { p6, p5, p4, p3 };
  }

  it("splitIndex=0 (no repeats): teamA=[highest+lowest], teamB=[2nd+3rd] — same as snakeDraft", () => {
    const { p6, p5, p4, p3 } = makeFour();
    // No cap args → always returns the natural split (never null).
    const result = rotatedDraft([p6, p5, p4, p3], []);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    // Sorted DESC: [p6(0), p5(1), p4(2), p3(3)]
    // teamA = [p6, p3], teamB = [p5, p4]
    expect(teamA.map((p) => p.player_id).sort()).toEqual(["p3", "p6"]);
    expect(teamB.map((p) => p.player_id).sort()).toEqual(["p4", "p5"]);
  });

  it("splitIndex=1 (1 full-repeat roster): teamA=[top pair], teamB=[bottom pair]", () => {
    const { p6, p5, p4, p3 } = makeFour();
    const allFourIds = [p6, p5, p4, p3].map((p) => p.player_id);
    // Exactly 1 roster containing all 4 → repeatCount=1 → splitIndex=1
    const result = rotatedDraft([p6, p5, p4, p3], [allFourIds]);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    // teamA = [p6, p5], teamB = [p4, p3]
    expect(teamA.map((p) => p.player_id).sort()).toEqual(["p5", "p6"]);
    expect(teamB.map((p) => p.player_id).sort()).toEqual(["p3", "p4"]);
  });

  it("splitIndex=2 (2 full-repeat rosters): teamA=[1st+3rd], teamB=[2nd+4th] — cross-split", () => {
    const { p6, p5, p4, p3 } = makeFour();
    const allFourIds = [p6, p5, p4, p3].map((p) => p.player_id);
    // 2 rosters both containing all 4 → repeatCount=2 → splitIndex=2
    const result = rotatedDraft([p6, p5, p4, p3], [allFourIds, allFourIds]);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    // teamA = [p6, p4], teamB = [p5, p3]
    expect(teamA.map((p) => p.player_id).sort()).toEqual(["p4", "p6"]);
    expect(teamB.map((p) => p.player_id).sort()).toEqual(["p3", "p5"]);
  });

  it("cycles back to splitIndex=0 at 3 full-repeat rosters (3 % 3 = 0)", () => {
    const { p6, p5, p4, p3 } = makeFour();
    const allFourIds = [p6, p5, p4, p3].map((p) => p.player_id);
    // 3 full-repeat rosters → repeatCount=3 → splitIndex=0 (snakeDraft)
    const result = rotatedDraft([p6, p5, p4, p3], [allFourIds, allFourIds, allFourIds]);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    expect(teamA.map((p) => p.player_id).sort()).toEqual(["p3", "p6"]);
    expect(teamB.map((p) => p.player_id).sort()).toEqual(["p4", "p5"]);
  });

  it("partial-overlap rosters do not count towards repeatCount (only ALL 4 present increments it)", () => {
    const { p6, p5, p4, p3 } = makeFour();
    // 3 rosters each missing one of the 4 players → repeatCount=0 → splitIndex=0
    const partialRosters = [
      ["p6", "p5", "p4", "outsider1"], // missing p3
      ["p6", "p5", "p3", "outsider2"], // missing p4
      ["p6", "p4", "p3", "outsider3"], // missing p5
    ];
    const result = rotatedDraft([p6, p5, p4, p3], partialRosters);
    expect(result).not.toBeNull();
    const { teamA, teamB } = result!;
    // repeatCount=0 → splitIndex=0 → snakeDraft output
    expect(teamA.map((p) => p.player_id).sort()).toEqual(["p3", "p6"]);
    expect(teamB.map((p) => p.player_id).sort()).toEqual(["p4", "p5"]);
  });

  it("produces exactly 2 players per team for all 3 splits", () => {
    const { p6, p5, p4, p3 } = makeFour();
    const allFourIds = [p6, p5, p4, p3].map((p) => p.player_id);

    for (const rosterCount of [0, 1, 2]) {
      const recentRosters = Array.from({ length: rosterCount }, () => allFourIds);
      const result = rotatedDraft([p6, p5, p4, p3], recentRosters);
      expect(result).not.toBeNull();
      const { teamA, teamB } = result!;
      expect(teamA).toHaveLength(2);
      expect(teamB).toHaveLength(2);
      // No duplicates across teams
      const allAssigned = [...teamA, ...teamB].map((p) => p.player_id);
      expect(new Set(allAssigned).size).toBe(4);
    }
  });

  it("does not mutate the input array order", () => {
    const { p6, p5, p4, p3 } = makeFour();
    const input = [p3, p6, p4, p5]; // shuffled order
    const originalOrder = input.map((p) => p.player_id);
    rotatedDraft(input, []);
    expect(input.map((p) => p.player_id)).toEqual(originalOrder);
  });

  it("sorts input by skill DESC before splitting — input order does not affect result", () => {
    const { p6, p5, p4, p3 } = makeFour();
    // Pass in shuffled order; result should be same as sorted order
    const shuffled = rotatedDraft([p3, p6, p4, p5], []);
    const sorted = rotatedDraft([p6, p5, p4, p3], []);
    expect(shuffled).not.toBeNull();
    expect(sorted).not.toBeNull();
    expect(shuffled!.teamA.map((p) => p.player_id).sort()).toEqual(
      sorted!.teamA.map((p) => p.player_id).sort()
    );
    expect(shuffled!.teamB.map((p) => p.player_id).sort()).toEqual(
      sorted!.teamB.map((p) => p.player_id).sort()
    );
  });
});

// ─────────────────────────────────────────────────────────────
// rotatedDraft — opponent-cap preference (4-pass crossNetOk)
// ─────────────────────────────────────────────────────────────
// Mirrors the snakeDraft 4-pass structure. Sorted DESC by skill:
//   [p6(0), p5(1), p4(2), p3(3)]
// Split 0: teamA=[p6,p3] vs teamB=[p5,p4] — cross-net: p5:p6, p4:p6, p3:p5, p3:p4
// Split 1: teamA=[p6,p5] vs teamB=[p4,p3] — cross-net: p4:p6, p3:p6, p4:p5, p3:p5
// Split 2: teamA=[p6,p4] vs teamB=[p5,p3] — cross-net: p5:p6, p3:p6, p4:p5, p3:p4
//
// Partnership pairs per split:
//   Split 0: "p3:p6" (teamA), "p4:p5" (teamB)
//   Split 1: "p5:p6" (teamA), "p3:p4" (teamB)
//   Split 2: "p4:p6" (teamA), "p3:p5" (teamB)
//
// "p5:p6" is cross-net in Splits 0 and 2, same-team in Split 1.

describe("rotatedDraft — opponent-cap preference", () => {
  const OPP_CAP = MAX_OPPONENT_REPEATS;

  function makeFourAlpha() {
    const p6 = makePlayer("p6", { skillInt: 6 });
    const p5 = makePlayer("p5", { skillInt: 5 });
    const p4 = makePlayer("p4", { skillInt: 4 });
    const p3 = makePlayer("p3", { skillInt: 3 });
    return { p6, p5, p4, p3 };
  }

  it("Pass 1a: skips splits with capped cross-net pair — returns the uncapped split from natural rotation", () => {
    // 0 full-repeat rosters → splitIndex=0. "p5:p6" capped in Splits 0 and 2.
    // Pass 1a cycles Splits 0→1→2; Split 1 has p5+p6 same-team (not cross-net) → crossNetOk → return it.
    const { p6, p5, p4, p3 } = makeFourAlpha();
    const opponentCounts = new Map([["p5:p6", OPP_CAP]]);
    const result = rotatedDraft(
      [p6, p5, p4, p3],
      [], // 0 repeats → splitIndex=0
      new Map(), // all partnerships fresh
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Split 1: teamA=[p6,p5], teamB=[p4,p3]
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["p5", "p6"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["p3", "p4"]);
  });

  it("Pass 1b: when ALL splits have a capped cross-net pair, relaxes opponent cap and returns first fresh-partnership split", () => {
    // p6 faces every opponent at cap → no split passes crossNetOk.
    // Pass 1b ignores crossNetOk → all partnerships fresh → Split 0 (first from splitIndex=0).
    const { p6, p5, p4, p3 } = makeFourAlpha();
    const opponentCounts = new Map([
      ["p5:p6", OPP_CAP], // Splits 0 and 2 cross-net
      ["p4:p6", OPP_CAP], // Splits 0 and 1 cross-net
      ["p3:p6", OPP_CAP], // Splits 1 and 2 cross-net
    ]);
    const result = rotatedDraft(
      [p6, p5, p4, p3],
      [],
      new Map(),
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Pass 1b: all splits fail crossNetOk → relax → return Split 0 (splitIndex=0, fresh partnerships)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["p3", "p6"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["p4", "p5"]);
  });

  it("Pass 2a: when all partnerships are stale, still prefers the split with no capped cross-net pair", () => {
    // All 6 partnership pairs stale (count=1, below cap=2). "p5:p6" capped.
    // Passes 1a+1b: no fresh partnerships → skip. Pass 2a: Splits 0+2 fail crossNetOk,
    // Split 1 has p5+p6 same-team so crossNetOk=true → return Split 1.
    const { p6, p5, p4, p3 } = makeFourAlpha();
    const partnershipCounts = new Map([
      ["p3:p6", 1], // Split 0 teamA
      ["p4:p5", 1], // Split 0 teamB
      ["p5:p6", 1], // Split 1 teamA
      ["p3:p4", 1], // Split 1 teamB
      ["p4:p6", 1], // Split 2 teamA
      ["p3:p5", 1], // Split 2 teamB
    ]);
    const opponentCounts = new Map([["p5:p6", OPP_CAP]]);
    const result = rotatedDraft(
      [p6, p5, p4, p3],
      [],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Pass 2a: Split 1 passes crossNetOk (p5:p6 same-team, not cross-net)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["p5", "p6"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["p3", "p4"]);
  });

  it("Pass 2b: last resort — returns first below-partnership-cap split when all cross-net pairs are capped", () => {
    // All 6 partnership pairs stale (count=1, below cap=2).
    // All 6 cross-net pairs at OPP_CAP → every split fails crossNetOk.
    // Pass 2b ignores crossNetOk → returns Split 0 (first from splitIndex=0, below partnership cap).
    const { p6, p5, p4, p3 } = makeFourAlpha();
    const partnershipCounts = new Map([
      ["p3:p6", 1],
      ["p4:p5", 1],
      ["p5:p6", 1],
      ["p3:p4", 1],
      ["p4:p6", 1],
      ["p3:p5", 1],
    ]);
    const opponentCounts = new Map([
      ["p5:p6", OPP_CAP], // cross-net in Splits 0 and 2
      ["p4:p6", OPP_CAP], // cross-net in Splits 0 and 1
      ["p3:p5", OPP_CAP], // cross-net in Splits 0 and 1
      ["p3:p4", OPP_CAP], // cross-net in Splits 0 and 2
      ["p3:p6", OPP_CAP], // cross-net in Splits 1 and 2
      ["p4:p5", OPP_CAP], // cross-net in Splits 1 and 2
    ]);
    const result = rotatedDraft(
      [p6, p5, p4, p3],
      [],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Pass 2b: ignore crossNetOk → Split 0 (first from splitIndex=0, count < cap)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["p3", "p6"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["p4", "p5"]);
  });
});

// ─────────────────────────────────────────────────────────────
// pairKey
// ─────────────────────────────────────────────────────────────
// Returns a canonical symmetric key for a same-team pair so that
// pairKey(a, b) === pairKey(b, a). The lexicographically smaller
// ID always sorts to the left of the colon.

describe("pairKey", () => {
  it("is symmetric: pairKey(a, b) === pairKey(b, a)", () => {
    expect(pairKey("alice", "bob")).toBe(pairKey("bob", "alice"));
  });

  it("places the lexicographically smaller ID first", () => {
    // "alice" < "bob" alphabetically → "alice:bob"
    expect(pairKey("alice", "bob")).toBe("alice:bob");
  });

  it("places the lexicographically larger ID second", () => {
    // "zzz" > "aaa" → result is "aaa:zzz"
    expect(pairKey("zzz", "aaa")).toBe("aaa:zzz");
  });

  it("handles UUID-shaped strings consistently", () => {
    const u1 = "00000000-0000-0000-0000-000000000001";
    const u2 = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    // u1 < u2 lexicographically
    expect(pairKey(u1, u2)).toBe(`${u1}:${u2}`);
    expect(pairKey(u2, u1)).toBe(`${u1}:${u2}`);
  });

  it("is idempotent: same ID on both sides returns 'id:id'", () => {
    expect(pairKey("p1", "p1")).toBe("p1:p1");
  });

  it("produces distinct keys for different pairs", () => {
    // Ensure there is no accidental collision between (a,b) and (a,c)
    expect(pairKey("a", "b")).not.toBe(pairKey("a", "c"));
  });
});

// ─────────────────────────────────────────────────────────────
// snakeDraft — cap enforcement
// ─────────────────────────────────────────────────────────────
// With cap args, snakeDraft tries 3 splits in descending
// skill-balance order (0→2→1) and returns the first that has
// both team pairs below the cap. Returns null if all are capped.
//
// Reference splits for players sorted DESC [a(6), b(5), c(4), d(3)]:
//   Split 0 (most balanced): teamA=[a,d], teamB=[b,c]
//     pairKey("a","d") = "a:d",  pairKey("b","c") = "b:c"
//   Split 2 (cross):          teamA=[a,c], teamB=[b,d]
//     pairKey("a","c") = "a:c",  pairKey("b","d") = "b:d"
//   Split 1 (least balanced): teamA=[a,b], teamB=[c,d]
//     pairKey("a","b") = "a:b",  pairKey("c","d") = "c:d"

describe("snakeDraft — cap enforcement", () => {
  // Shared 4-player fixture with distinct skills a>b>c>d.
  // IDs a<b<c<d alphabetically so pairKey results are predictable.
  function makeFourAlpha() {
    const a = makePlayer("a", { skillInt: 6 });
    const b = makePlayer("b", { skillInt: 5 });
    const c = makePlayer("c", { skillInt: 4 });
    const d = makePlayer("d", { skillInt: 3 });
    return { a, b, c, d };
  }

  it("backward compat: no cap args → always returns Split 0, never null", () => {
    const { a, b, c, d } = makeFourAlpha();
    const result = snakeDraft([a, b, c, d]);
    expect(result).not.toBeNull();
    // Split 0: teamA=[a,d], teamB=[b,c]
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("returns Split 0 when no pairs are at the cap", () => {
    const { a, b, c, d } = makeFourAlpha();
    // All pairs at count 1 — below cap of 2
    const counts = new Map([
      ["a:d", 1],
      ["b:c", 1],
      ["a:c", 1],
      ["b:d", 1],
      ["a:b", 1],
      ["c:d", 1],
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Most balanced split wins
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("skips Split 0 when its teamA pair is at cap, returns Split 2 instead", () => {
    const { a, b, c, d } = makeFourAlpha();
    // pairKey("a","d") = "a:d" — capped at MAX_PARTNERSHIP_REPEATS
    const counts = new Map([["a:d", MAX_PARTNERSHIP_REPEATS]]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Tries Split 2 next (more balanced than Split 1)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "c"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "d"]);
  });

  it("skips Split 0 when its teamB pair is at cap, returns Split 2 instead", () => {
    const { a, b, c, d } = makeFourAlpha();
    // pairKey("b","c") = "b:c" — capped
    const counts = new Map([["b:c", MAX_PARTNERSHIP_REPEATS]]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Split 0's teamB is capped → skipped → try Split 2
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "c"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "d"]);
  });

  it("skips Splits 0 and 2, returns Split 1 when both prior teamA pairs are capped", () => {
    const { a, b, c, d } = makeFourAlpha();
    const counts = new Map([
      ["a:d", MAX_PARTNERSHIP_REPEATS], // Split 0 teamA capped
      ["a:c", MAX_PARTNERSHIP_REPEATS], // Split 2 teamA capped
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Only Split 1 remains: teamA=[a,b], teamB=[c,d]
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "b"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["c", "d"]);
  });

  it("returns null when all 3 splits have at least one capped pair", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Cap the teamA pair of every split — each split immediately fails
    const counts = new Map([
      ["a:d", MAX_PARTNERSHIP_REPEATS], // Split 0 teamA capped
      ["a:c", MAX_PARTNERSHIP_REPEATS], // Split 2 teamA capped
      ["a:b", MAX_PARTNERSHIP_REPEATS], // Split 1 teamA capped
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).toBeNull();
  });

  it("count < cap is allowed but fresh Split 2 is preferred when Split 0 pairs are stale", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Split 0 pairs (a:d, b:c) are stale (count = cap - 1 = 1).
    // Split 2 pairs (a:c, b:d) are absent → count = 0 → both fresh.
    // Pass 1 skips Split 0 (not both 0), finds Split 2 (both 0) → returns Split 2.
    const counts = new Map([
      ["a:d", MAX_PARTNERSHIP_REPEATS - 1],
      ["b:c", MAX_PARTNERSHIP_REPEATS - 1],
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull(); // count < cap is still allowed
    // Fresh-pair preference: Split 2 wins over stale-but-below-cap Split 0
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "c"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "d"]);
  });

  it("treats count === cap as capped (count < cap is false at equality)", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Every pair except Split 1's pairs is at cap — Split 1 is the only valid option
    const counts = new Map([
      ["a:d", MAX_PARTNERSHIP_REPEATS], // Split 0 teamA capped
      ["b:c", MAX_PARTNERSHIP_REPEATS], // Split 0 teamB also capped (belt & suspenders)
      ["a:c", MAX_PARTNERSHIP_REPEATS], // Split 2 teamA capped
      ["b:d", MAX_PARTNERSHIP_REPEATS], // Split 2 teamB also capped
      // Split 1 pairs ("a:b" and "c:d") are absent → count=0 < cap=2 ✓
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "b"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["c", "d"]);
  });
});

// ─────────────────────────────────────────────────────────────
// snakeDraft — fresh-pair preference (two-pass)
// ─────────────────────────────────────────────────────────────
// Pass 1: try splits (most→least balanced) where BOTH team pairs
//   have count = 0 (never been partners). Avoids consecutive same-
//   partner games even when the pair is still below the hard cap.
// Pass 2: fall back to any split where both pairs are < cap.
//
// Reference splits for [a(6), b(5), c(4), d(3)]:
//   Split 0 (most balanced): teamA=[a,d], teamB=[b,c]
//   Split 2 (cross):          teamA=[a,c], teamB=[b,d]
//   Split 1 (least balanced): teamA=[a,b], teamB=[c,d]

describe("snakeDraft — fresh-pair preference", () => {
  function makeFourAlpha() {
    const a = makePlayer("a", { skillInt: 6 });
    const b = makePlayer("b", { skillInt: 5 });
    const c = makePlayer("c", { skillInt: 4 });
    const d = makePlayer("d", { skillInt: 3 });
    return { a, b, c, d };
  }

  it("prefers Split 2 over Split 0 when both Split 0 pairs were recent partners", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Simulate: a+d and b+c were partners last game (count=1, below cap=2)
    // Split 2 pairs (a:c, b:d) are fresh (count=0)
    const counts = new Map([
      ["a:d", 1], // Split 0 teamA — stale
      ["b:c", 1], // Split 0 teamB — stale
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Pass 1 skips Split 0 (a:d=1, not both 0) then finds fresh Split 2
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "c"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "d"]);
  });

  it("prefers Split 2 when only Split 0's teamA pair is stale", () => {
    const { a, b, c, d } = makeFourAlpha();
    // a:d stale (count=1), b:c fresh (count=0)
    // Split 2 pairs (a:c=0, b:d=0) are both fresh
    const counts = new Map([["a:d", 1]]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Split 0 fails Pass 1 (a:d=1, not both 0) → Split 2 is fully fresh → returned
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "c"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "d"]);
  });

  it("falls back to most-balanced (Split 0) when no fully-fresh split exists", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Every split has at least one stale teamA pair — no fully-fresh split
    const counts = new Map([
      ["a:d", 1], // Split 0 teamA stale
      ["a:c", 1], // Split 2 teamA stale
      ["a:b", 1], // Split 1 teamA stale
    ]);
    const result = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Pass 1 finds nothing → Pass 2 returns Split 0 (most balanced, below cap)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("still returns null when all splits are at the hard cap (no bypass)", () => {
    const { a, b, c, d } = makeFourAlpha();
    const counts = new Map([
      ["a:d", MAX_PARTNERSHIP_REPEATS],
      ["a:c", MAX_PARTNERSHIP_REPEATS],
      ["a:b", MAX_PARTNERSHIP_REPEATS],
    ]);
    expect(snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// snakeDraft — opponent-cap preference (4-pass crossNetOk)
// ─────────────────────────────────────────────────────────────
// Pass 1a: both team pairs fresh AND no cross-net pair at opponentCap
// Pass 1b: both team pairs fresh — relax opponent cap
// Pass 2a: both below partnership cap AND cross-net ok
// Pass 2b: both below cap — last resort, ignore opponent cap
//
// Cross-net pairs for [a(6), b(5), c(4), d(3)] sorted DESC:
//   Split 0 (teamA=[a,d], teamB=[b,c]): cross-net = a-b, a-c, d-b, d-c
//   Split 2 (teamA=[a,c], teamB=[b,d]): cross-net = a-b, a-d, c-b, c-d
//   Split 1 (teamA=[a,b], teamB=[c,d]): cross-net = a-c, a-d, b-c, b-d
//   (note: "a:b" is a SAME-TEAM pair in Split 1, not cross-net)

describe("snakeDraft — opponent-cap preference", () => {
  const OPP_CAP = MAX_OPPONENT_REPEATS;
  function makeFourAlpha() {
    const a = makePlayer("a", { skillInt: 6 });
    const b = makePlayer("b", { skillInt: 5 });
    const c = makePlayer("c", { skillInt: 4 });
    const d = makePlayer("d", { skillInt: 3 });
    return { a, b, c, d };
  }

  it("Pass 1a→1b: balance gate keeps Split 1 out — capped cross-net pair on Splits 0+2 no longer forces lopsided teams", () => {
    // "a:b" is at the opponent cap. Splits 0 and 2 have a-vs-b cross-net;
    // Split 1 pairs a+b on the SAME team so "a:b" is not a cross-net pair there.
    // OLD behavior: Pass 1a skipped Splits 0+2 and returned least-balanced Split 1
    // (skill gap 4) just to dodge the opponent repeat — the balance inversion.
    // NEW behavior: Split 1 is outside the balance gate (gap 4 > minGap 0 +
    // SKILL_VARIANCE_MAX 2), so Pass 1a finds nothing in the balanced pool and
    // Pass 1b relaxes the opponent cap → most-balanced fresh Split 0 wins.
    const { a, b, c, d } = makeFourAlpha();
    const partnershipCounts = new Map<string, number>(); // all fresh
    const opponentCounts = new Map([["a:b", OPP_CAP]]);
    const result = snakeDraft(
      [a, b, c, d],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Split 0: teamA=[a,d], teamB=[b,c] — balanced beats opponent-freshness
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
    expect(result!.usedLopsidedFallback).toBeUndefined();
  });

  it("Pass 1b: returns most-balanced Split 0 when all splits have capped cross-net pairs but partnerships are fresh", () => {
    // "a:b", "a:c", "a:d" all at cap → every split has ≥1 capped cross-net pair.
    // Pass 1a finds nothing. Pass 1b relaxes crossNetOk → returns Split 0 (most balanced).
    const { a, b, c, d } = makeFourAlpha();
    const partnershipCounts = new Map<string, number>(); // all fresh
    const opponentCounts = new Map([
      ["a:b", OPP_CAP],
      ["a:c", OPP_CAP],
      ["a:d", OPP_CAP],
    ]);
    const result = snakeDraft(
      [a, b, c, d],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Pass 1b returns Split 0 (most balanced, fresh partnerships)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("Pass 2a→2b: balance gate keeps Split 1 out even when it is the only split with no capped cross-net pair", () => {
    // All partnerships below cap but stale (count=1). "a:b" at opponent cap.
    // Splits 0+2 have a-vs-b cross-net → fail crossNetOk. Split 1 would pass,
    // but it is outside the balance gate (gap 4 > minGap 0 + SKILL_VARIANCE_MAX 2).
    // OLD behavior returned lopsided Split 1; NEW behavior falls to Pass 2b within
    // the balanced pool → most-balanced below-cap Split 0, opponent cap relaxed.
    const { a, b, c, d } = makeFourAlpha();
    const partnershipCounts = new Map([
      ["a:d", 1], // Split 0 teamA stale
      ["a:c", 1], // Split 2 teamA stale
      ["a:b", 1], // Split 1 teamA stale
    ]);
    const opponentCounts = new Map([["a:b", OPP_CAP]]);
    const result = snakeDraft(
      [a, b, c, d],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Split 0: teamA=[a,d], teamB=[b,c] — balance beats opponent-freshness
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
    expect(result!.usedLopsidedFallback).toBeUndefined();
  });

  // ── Balance gate regression (INT+INT vs BEG+BEG incident) ──────────
  // Live failure mode: 2 highs + 2 lows, every cross-tier partnership
  // already used once. The old freshness-first search returned the fresh
  // but maximally lopsided high+high vs low+low split. The balance gate
  // must repeat a within-cap balanced pairing instead.
  describe("snakeDraft — balance gate (lopsided-split regression)", () => {
    function makeTwoTiers() {
      const h1 = makePlayer("h1", { skillInt: 4 });
      const h2 = makePlayer("h2", { skillInt: 4 });
      const l1 = makePlayer("l1", { skillInt: 1 });
      const l2 = makePlayer("l2", { skillInt: 1 });
      return { h1, h2, l1, l2 };
    }
    const teamGap = (r: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }) =>
      Math.abs(
        r.teamA[0].skill_level_int +
          r.teamA[1].skill_level_int -
          r.teamB[0].skill_level_int -
          r.teamB[1].skill_level_int
      );

    it("incident case: all cross-tier pairs used once → repeats a balanced pairing, never high+high vs low+low", () => {
      const { h1, h2, l1, l2 } = makeTwoTiers();
      const counts = new Map([
        ["h1:l1", 1],
        ["h1:l2", 1],
        ["h2:l1", 1],
        ["h2:l2", 1],
      ]);
      const result = snakeDraft([h1, h2, l1, l2], counts, MAX_PARTNERSHIP_REPEATS);
      expect(result).not.toBeNull();
      expect(teamGap(result!)).toBe(0); // each team = 1 high + 1 low
      expect(result!.usedLopsidedFallback).toBeUndefined();
    });

    it("lopsided fallback fires (flagged) only when every balanced split is at the hard cap", () => {
      const { h1, h2, l1, l2 } = makeTwoTiers();
      const counts = new Map([
        ["h1:l1", MAX_PARTNERSHIP_REPEATS],
        ["h1:l2", MAX_PARTNERSHIP_REPEATS],
        ["h2:l1", MAX_PARTNERSHIP_REPEATS],
        ["h2:l2", MAX_PARTNERSHIP_REPEATS],
      ]);
      const result = snakeDraft([h1, h2, l1, l2], counts, MAX_PARTNERSHIP_REPEATS);
      expect(result).not.toBeNull();
      expect(result!.usedLopsidedFallback).toBe(true); // caller may swap a body
    });

    it("returns null when lopsided splits are also capped (no silent stall-break)", () => {
      const { h1, h2, l1, l2 } = makeTwoTiers();
      const counts = new Map([
        ["h1:l1", MAX_PARTNERSHIP_REPEATS],
        ["h1:l2", MAX_PARTNERSHIP_REPEATS],
        ["h2:l1", MAX_PARTNERSHIP_REPEATS],
        ["h2:l2", MAX_PARTNERSHIP_REPEATS],
        ["h1:h2", MAX_PARTNERSHIP_REPEATS],
        ["l1:l2", MAX_PARTNERSHIP_REPEATS],
      ]);
      expect(snakeDraft([h1, h2, l1, l2], counts, MAX_PARTNERSHIP_REPEATS)).toBeNull();
    });
  });

  it("Pass 2b: last resort — returns most-balanced split when all capped on both partnership+opponent", () => {
    // All partnerships stale (count=1). a faces everyone at opponent cap.
    // All splits fail crossNetOk. Pass 2b ignores opponent cap → returns Split 0.
    const { a, b, c, d } = makeFourAlpha();
    const partnershipCounts = new Map([
      ["a:d", 1], // Split 0 teamA stale
      ["a:c", 1], // Split 2 teamA stale
      ["a:b", 1], // Split 1 teamA stale
    ]);
    const opponentCounts = new Map([
      ["a:b", OPP_CAP],
      ["a:c", OPP_CAP],
      ["a:d", OPP_CAP],
    ]);
    const result = snakeDraft(
      [a, b, c, d],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      opponentCounts,
      OPP_CAP
    );
    expect(result).not.toBeNull();
    // Pass 2b: all crossNetOk checks fail → returns Split 0 (most balanced, below partnership cap)
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("omitting opponentCounts has identical behavior to the base 2-pass logic", () => {
    // When opponentCounts is absent crossNetOk always returns true → pass 1a = old pass 1.
    const { a, b, c, d } = makeFourAlpha();
    const counts = new Map([
      ["a:d", 1],
      ["b:c", 1],
    ]); // Split 0 stale
    const withoutOpp = snakeDraft([a, b, c, d], counts, MAX_PARTNERSHIP_REPEATS);
    const withEmptyOpp = snakeDraft(
      [a, b, c, d],
      counts,
      MAX_PARTNERSHIP_REPEATS,
      new Map(),
      OPP_CAP
    );
    expect(withEmptyOpp).toEqual(withoutOpp); // identical behavior
  });
});

// ─────────────────────────────────────────────────────────────
// rotatedDraft — cap enforcement
// ─────────────────────────────────────────────────────────────
// With cap args, rotatedDraft starts from the natural splitIndex
// (determined by repeatCount % 3) and cycles through all 3 splits,
// returning the first that satisfies the cap for both teams.
// Returns null if every split is capped.
//
// Same player fixture and split-to-pair mapping as above.

describe("rotatedDraft — cap enforcement", () => {
  function makeFourAlpha() {
    const a = makePlayer("a", { skillInt: 6 });
    const b = makePlayer("b", { skillInt: 5 });
    const c = makePlayer("c", { skillInt: 4 });
    const d = makePlayer("d", { skillInt: 3 });
    return { a, b, c, d };
  }

  it("backward compat: no cap args → returns natural rotation split, never null", () => {
    const { a, b, c, d } = makeFourAlpha();
    // 0 repeats → splitIndex=0 → snakeDraft equivalent
    const result = rotatedDraft([a, b, c, d], []);
    expect(result).not.toBeNull();
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("returns the natural rotation split when no pairs are capped", () => {
    const { a, b, c, d } = makeFourAlpha();
    // 1 repeat → splitIndex=1 → top vs bottom
    const allFourIds = [a, b, c, d].map((p) => p.player_id);
    const counts = new Map<string, number>(); // all pairs at count 0 < cap
    const result = rotatedDraft([a, b, c, d], [allFourIds], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // splitIndex=1: teamA=[a,b], teamB=[c,d]
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "b"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["c", "d"]);
  });

  it("falls back to the next split when the natural rotation split is capped (splitIndex=0→next=split 1)", () => {
    const { a, b, c, d } = makeFourAlpha();
    // 0 repeats → natural splitIndex=0 (teamA=[a,d], teamB=[b,c])
    // Cap split 0's teamA pair → must advance to split 1 (index (0+1)%3=1)
    const counts = new Map([["a:d", MAX_PARTNERSHIP_REPEATS]]);
    const result = rotatedDraft([a, b, c, d], [], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Split 1: teamA=[a,b], teamB=[c,d]
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "b"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["c", "d"]);
  });

  it("falls back across two splits (splitIndex=1, splits 1 and 2 capped → returns split 0)", () => {
    const { a, b, c, d } = makeFourAlpha();
    // 1 repeat → splitIndex=1 (teamA=[a,b]). Cap splits 1 and 2:
    //   split 1 teamA pair "a:b" capped → skip
    //   split 2 = (1+1)%3=2 teamA pair "a:c" capped → skip
    //   split 0 = (1+2)%3=0 teamA pair "a:d" not capped → return split 0
    const allFourIds = [a, b, c, d].map((p) => p.player_id);
    const counts = new Map([
      ["a:b", MAX_PARTNERSHIP_REPEATS], // split 1 teamA capped
      ["a:c", MAX_PARTNERSHIP_REPEATS], // split 2 teamA capped
    ]);
    const result = rotatedDraft([a, b, c, d], [allFourIds], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Split 0: teamA=[a,d], teamB=[b,c]
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });

  it("returns null when all 3 splits are capped regardless of starting splitIndex", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Cap the teamA pair of every split → all 3 fail the cap check
    const counts = new Map([
      ["a:d", MAX_PARTNERSHIP_REPEATS], // split 0 teamA
      ["a:b", MAX_PARTNERSHIP_REPEATS], // split 1 teamA
      ["a:c", MAX_PARTNERSHIP_REPEATS], // split 2 teamA
    ]);
    // Test with multiple starting splitIndices to ensure cycling always exhausts
    for (const repeatCount of [0, 1, 2]) {
      const rosters = Array.from({ length: repeatCount }, () =>
        [a, b, c, d].map((p) => p.player_id)
      );
      expect(rotatedDraft([a, b, c, d], rosters, counts, MAX_PARTNERSHIP_REPEATS)).toBeNull();
    }
  });

  it("preserves natural split when only the teamB pair of an alternate split is capped", () => {
    const { a, b, c, d } = makeFourAlpha();
    // Natural splitIndex=0: teamA=[a,d] not capped, teamB=[b,c] not capped → return immediately
    // Cap split 2's teamB pair to ensure it doesn't bleed into split 0's evaluation
    const counts = new Map([["b:d", MAX_PARTNERSHIP_REPEATS]]);
    const result = rotatedDraft([a, b, c, d], [], counts, MAX_PARTNERSHIP_REPEATS);
    expect(result).not.toBeNull();
    // Should still be split 0 — split 0 pairs are uncapped
    expect(result!.teamA.map((p) => p.player_id).sort()).toEqual(["a", "d"]);
    expect(result!.teamB.map((p) => p.player_id).sort()).toEqual(["b", "c"]);
  });
});

// ─────────────────────────────────────────────────────────────
// runAlgorithm — happy paths (successful match proposals)
// ─────────────────────────────────────────────────────────────
// These tests cover the main success return at lines 660–663:
//
//   RA-1  Straightforward match: 4 compatible players, no
//         diversity violation, direct snakeDraft success
//   RA-2  Red Zone anchor uses ±3 expanded window → isMixed
//   RA-3  Diversity violation + Red Zone swap target →
//         swap skipped; falls through to snakeDraft
//   RA-4  All 4 players + extra in pool — correct 4 selected

describe("runAlgorithm — happy paths (successful match proposals)", () => {
  // ── RA-1 ──────────────────────────────────────────────────
  it("RA-1: forms a valid match with 4 compatible players — direct snakeDraft, no violations", () => {
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10 });
    const p1 = makePlayer("p1", { skillInt: 5, waitMinutes: 9 });
    const p2 = makePlayer("p2", { skillInt: 4, waitMinutes: 8 });
    const p3 = makePlayer("p3", { skillInt: 5, waitMinutes: 7 });

    const pool = [anchor, p1, p2, p3];
    const result = runAlgorithm(pool, new Map(), new Map(), []);

    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.teamA).toHaveLength(2);
    expect(result.proposal!.teamB).toHaveLength(2);
    // All players within ±1 → normal (non-mixed) match
    expect(result.proposal!.isMixedLevel).toBe(false);
    expect(result.capSaturation).toBe(false);
    // All 4 players distributed across teams with no duplicates
    const allAssigned = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ];
    expect(new Set(allAssigned).size).toBe(4);
  });

  // ── RA-2 ──────────────────────────────────────────────────
  it("RA-2: Red Zone anchor uses ±3 expanded skill window, returns isMixedLevel=true", () => {
    // anchor waited 30 min → Red Zone (score=1030 ≥ RED_ZONE_SCORE_FLOOR=1000)
    // skillWindows expands to [±1, ±2, ±3, ±4]
    // Candidates at skill 6: |6-3|=3 fails ±2 but passes ±3 → isMixed=true
    const anchor = makePlayer("anchor", { skillInt: 3, waitMinutes: 30 });
    const p1 = makePlayer("p1", { skillInt: 6, waitMinutes: 5 });
    const p2 = makePlayer("p2", { skillInt: 6, waitMinutes: 4 });
    const p3 = makePlayer("p3", { skillInt: 6, waitMinutes: 3 });

    const pool = [anchor, p1, p2, p3];
    const result = runAlgorithm(pool, new Map(), new Map(), []);

    expect(result.proposal).not.toBeNull();
    // maxVariance=3 > SKILL_VARIANCE_MAX(2) → mixed level
    expect(result.proposal!.isMixedLevel).toBe(true);
    expect(result.capSaturation).toBe(false);
    const allAssigned = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ];
    expect(new Set(allAssigned).size).toBe(4);
  });

  // ── RA-3 ──────────────────────────────────────────────────
  it("RA-3: diversity violation with Red Zone swap target — swap guard fires, falls through to snakeDraft (lines 521–531)", () => {
    // All 4 players recently played together → diversity violation triggers.
    // For group[2] (swapTarget) to be Red Zone, all 4 players must be Red Zone
    // so they sort ahead of any normal player.
    //   pool sorted DESC: anchorRZ(1030), g0(1029), g1(1028), g2(1026)
    //   anchor = anchorRZ; candidates = [g0, g1, g2]
    //   group[2] = g2 (lowest priority among the 3 — still Red Zone at 1026 ≥ 1000)
    //
    // Guard: swapTarget.priorityScore >= RED_ZONE_SCORE_FLOOR → skip swap → snakeDraft
    const anchorRZ = makePlayer("anchorRZ", { skillInt: 5, waitMinutes: 30 }); // 1030
    const g0 = makePlayer("g0", { skillInt: 5, waitMinutes: 29 }); // 1029
    const g1 = makePlayer("g1", { skillInt: 5, waitMinutes: 28 }); // 1028
    const g2 = makePlayer("g2", { skillInt: 5, waitMinutes: 26 }); // 1026

    // All 4 recently played together → diversity violation
    const recentRosters = [[anchorRZ.player_id, g0.player_id, g1.player_id, g2.player_id]];

    const pool = [anchorRZ, g0, g1, g2];
    const result = runAlgorithm(pool, new Map(), new Map(), recentRosters);

    // Swap guard fired → fell through to snakeDraft → proposal returned
    expect(result.proposal).not.toBeNull();
    // All within ±1 → non-mixed
    expect(result.proposal!.isMixedLevel).toBe(false);
    expect(result.capSaturation).toBe(false);
  });

  // ── RA-2b / RA-3b — the same two guards, reached through the WAIT arm ──
  //
  // RA-2 and RA-3 both build their Red Zone players with 0 games, so both reach
  // the tier through the SCORE arm and pass identically under the old score-only
  // test. These clones use the below-floor cohort (wait >= 20, games × 8 > wait)
  // so they fail without isRedZonePlayer. Fixtures use wait 26–30 with 5 games:
  // HARD_CAP_GAMES_CEILING (5) drops them out of Tier 3 into Tier 2, where they
  // score 1000 + wait − 40 — under the floor, with the longest waits in the pool.

  it("RA-2b: below-floor Red Zone anchor still gets the expanded ±3 window — and does NOT arm forcedRepeat", () => {
    const anchor = makePlayer("anchor", { skillInt: 3, waitMinutes: 30, gamesPlayed: 5 });
    // Premise guard: Red Zone by wait, but the score test would say no.
    expect(anchor.priorityScore).toBe(990);
    expect(anchor.priorityScore >= RED_ZONE_SCORE_FLOOR).toBe(false);
    expect(anchor.wait_minutes).toBeGreaterThanOrEqual(CRITICAL_WAIT_MINUTES);

    // Skill 6 vs anchor 3 → spread 3: fails ±2, passes ±3.
    const p1 = makePlayer("p1", { skillInt: 6, waitMinutes: 5 });
    const p2 = makePlayer("p2", { skillInt: 6, waitMinutes: 4 });
    const p3 = makePlayer("p3", { skillInt: 6, waitMinutes: 3 });

    const result = runAlgorithm([anchor, p1, p2, p3], new Map(), new Map(), []);

    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.isMixedLevel).toBe(true);

    // ⚠️ THE decisive assertion, and it is NOT "a match was formed".
    // FALLBACK_WAIT_MINUTES (15) is BELOW CRITICAL_WAIT_MINUTES (20), so every
    // Red Zone anchor is already past the last-resort fallback threshold — the
    // fallback seats this four either way and "proposal !== null" proves nothing.
    // What differs is HOW: the fallback returns forcedRepeat: true, which is the
    // engine telling the caller it served a compromised roster and is what arms
    // the cross-court reach. Reaching ±3 legitimately leaves it unset.
    expect(result.forcedRepeat).toBeFalsy();

    const allAssigned = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ];
    expect(new Set(allAssigned).size).toBe(4);
  });

  it("RA-3b: below-floor Red Zone swap target is still protected from the diversity swap", () => {
    // Every Red Zone player carries 5 games and so does `alt`, which pins
    // poolMinGames at 5 and zeroes every gamesAhead term. That matters: it keeps
    // the candidate ORDER identical with and without the fix, so this test
    // isolates the swap guard instead of accidentally re-testing RZ-SC1.
    const anchorRZ = makePlayer("anchorRZ", { skillInt: 5, waitMinutes: 30, gamesPlayed: 5 }); // 990
    const g0 = makePlayer("g0", { skillInt: 5, waitMinutes: 29, gamesPlayed: 5 }); // 989
    const g1 = makePlayer("g1", { skillInt: 5, waitMinutes: 28, gamesPlayed: 5 }); // 988
    const g2 = makePlayer("g2", { skillInt: 5, waitMinutes: 26, gamesPlayed: 5 }); // 986
    // The swap candidate the guard must refuse to use. Without a 5th player the
    // swap has nowhere to go and fires-vs-doesn't-fire are indistinguishable.
    const alt = makePlayer("alt", { skillInt: 5, waitMinutes: 5, gamesPlayed: 5 }); // −35

    for (const p of [anchorRZ, g0, g1, g2]) {
      expect(p.wait_minutes).toBeGreaterThanOrEqual(CRITICAL_WAIT_MINUTES);
      expect(p.priorityScore >= RED_ZONE_SCORE_FLOOR).toBe(false);
    }
    expect(g2.priorityScore).toBe(986);

    // ⚠️ REJECTION memory, not diversity — and the difference is what makes this
    // test decisive. The Tier-1 swap only ever replaces group[2], so it can only
    // clear a diversity violation whose overlapping trio INCLUDES group[2].
    // The natural fixture here — put the original four in activeRosters — is
    // exactly the case it cannot clear: the overlapping trio
    // anchor + group[0] + group[1] survives the substitution untouched, so the
    // swapped four is still at overlap 3 and still a violation. The guard firing
    // and the guard not firing then produce the same roster and nothing is
    // proven. (FR-1's own comment records the sibling version of this trap.)
    //
    // A violation on a roster like {anchor, group[0], group[2]} WOULD be
    // clearable — but building one is fiddly and the rejection path is simpler:
    // isRejectedRoster is an EXACT set match, so any one substitution clears it
    // and the swap genuinely goes through when the guard is absent.
    const rejected = [[anchorRZ.player_id, g0.player_id, g1.player_id, g2.player_id]];
    const result = runAlgorithm(
      [anchorRZ, g0, g1, g2, alt],
      new Map(),
      new Map(),
      [], // no diversity history — the rejection memory is what fires
      new Map(),
      rejected
    );

    expect(result.proposal).not.toBeNull();
    expect(result.capSaturation).toBe(false);
    const allAssigned = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ];
    // Guard fired → the Red-Zone player keeps their seat and the repeat is
    // served. Without it, `alt` is here instead of g2.
    expect(new Set(allAssigned)).toEqual(new Set(["anchorRZ", "g0", "g1", "g2"]));
    // …and the engine says so, rather than serving the repeat silently.
    expect(result.forcedRepeat).toBe(true);
  });

  // ── RA-4 ──────────────────────────────────────────────────
  it("RA-4: larger pool — correct 4 players selected, rest unused", () => {
    // 8 players at the same skill, no diversity violations.
    // runAlgorithm picks the highest-priority 4 (the ones who waited longest)
    // and returns a non-null proposal.
    const players = Array.from({ length: 8 }, (_, i) =>
      makePlayer(`p${i}`, { skillInt: 5, waitMinutes: 10 - i })
    );
    // scoreAndSortPool sorts DESC by priority; pool[0] = p0 (waited 10 min)

    const result = runAlgorithm(players, new Map(), new Map(), []);

    expect(result.proposal).not.toBeNull();
    expect(result.capSaturation).toBe(false);
    const allAssigned = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ];
    // Exactly 4 distinct players in the match
    expect(new Set(allAssigned).size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────
// Rejection memory — isRejectedRoster + runAlgorithm integration
// ─────────────────────────────────────────────────────────────
// An organizer clearing a draft means "deal a different hand". Verified live
// (08/06): the deterministic engine re-dealt an identical cleared roster 3×
// inside one minute. These tests pin the fix: an exact rejected four routes
// into the swap ladder (→ 3-of-4 recombination), while remaining fail-open
// when no alternative body exists.
//
//   RJ-1  isRejectedRoster: exact-set semantics, order-insensitive, no ≥3 match
//   RJ-2  runAlgorithm swaps in the bench body instead of re-dealing
//   RJ-3  fail-open: pool of exactly 4, all rejected → still proposes (rotated)

describe("rejection memory (isRejectedRoster + runAlgorithm)", () => {
  it("RJ-1: isRejectedRoster matches the exact set only — order-insensitive, 3-of-4 is NOT a match", () => {
    const rejected = [["a", "b", "c", "d"]];

    // Exact four, any order → match.
    expect(isRejectedRoster(["a", "b", "c", "d"], rejected)).toBe(true);
    expect(isRejectedRoster(["d", "c", "b", "a"], rejected)).toBe(true);

    // 3-of-4 recombination is the DESIRED outcome — must NOT match.
    expect(isRejectedRoster(["a", "b", "c", "e"], rejected)).toBe(false);

    // Distinct four / empty memory → no match.
    expect(isRejectedRoster(["e", "f", "g", "h"], rejected)).toBe(false);
    expect(isRejectedRoster(["a", "b", "c", "d"], [])).toBe(false);
  });

  it("RJ-2: runAlgorithm swaps in the bench body instead of re-dealing the cleared four", () => {
    // 5 same-skill players. Without rejection memory the engine picks the top
    // four by wait (anchor, p1, p2, p3) — deterministically, every run.
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10 });
    const p1 = makePlayer("p1", { skillInt: 5, waitMinutes: 9 });
    const p2 = makePlayer("p2", { skillInt: 5, waitMinutes: 8 });
    const p3 = makePlayer("p3", { skillInt: 5, waitMinutes: 7 });
    const p4 = makePlayer("p4", { skillInt: 5, waitMinutes: 6 });
    const pool = [anchor, p1, p2, p3, p4];

    // Control: no rejection memory → the exact four the organizer just cleared.
    const control = runAlgorithm(pool, new Map(), new Map(), []);
    const controlIds = [
      ...control.proposal!.teamA.map((p) => p.player_id),
      ...control.proposal!.teamB.map((p) => p.player_id),
    ].sort();
    expect(controlIds).toEqual(["anchor", "p1", "p2", "p3"]);

    // With the cleared roster in memory: swap ladder benches the weakest
    // group member and pulls in p4 — a 3-of-4 recombination, not a re-deal.
    const result = runAlgorithm(pool, new Map(), new Map(), [], new Map(), [
      ["anchor", "p1", "p2", "p3"],
    ]);
    expect(result.proposal).not.toBeNull();
    const ids = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ].sort();
    expect(ids).not.toEqual(["anchor", "p1", "p2", "p3"]);
    expect(ids).toContain("p4");
    expect(result.forcedRepeat).toBeUndefined();
  });

  it("RJ-3: fail-open — pool of exactly 4, all rejected → still proposes rather than stalling", () => {
    // No bench body exists, so honoring the rejection would leave the court
    // empty. The ladder exhausts Tiers 1–2 and accepts the same four via
    // Tier-3 rotation (flagged forcedRepeat) — a different team split is the
    // best "different hand" available.
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10 });
    const p1 = makePlayer("p1", { skillInt: 5, waitMinutes: 9 });
    const p2 = makePlayer("p2", { skillInt: 5, waitMinutes: 8 });
    const p3 = makePlayer("p3", { skillInt: 5, waitMinutes: 7 });
    const pool = [anchor, p1, p2, p3];

    const result = runAlgorithm(pool, new Map(), new Map(), [], new Map(), [
      ["anchor", "p1", "p2", "p3"],
    ]);

    expect(result.proposal).not.toBeNull();
    const ids = [
      ...result.proposal!.teamA.map((p) => p.player_id),
      ...result.proposal!.teamB.map((p) => p.player_id),
    ].sort();
    expect(ids).toEqual(["anchor", "p1", "p2", "p3"]);
    expect(result.forcedRepeat).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// runAlgorithm — last-resort fallback and no-match paths
// ─────────────────────────────────────────────────────────────
// Covers the two paths that were previously untested:
//
//   MC-new-1  Fallback fires when anchor waited > FALLBACK_WAIT_MINUTES
//             and all skill-window passes fail — returns isMixedLevel=true
//   MC-new-2  Fallback fires but snakeDraft returns null (all team splits
//             cap-blocked by non-anchor pairs) → proposal: null
//   MC-new-3  Anchor wait exactly equals FALLBACK_WAIT_MINUTES (not
//             exceeding it) → fallback does NOT fire → proposal: null
//   MC-new-4  All candidates cap-blocked with the anchor → candidates=[]
//             → capSaturation: true (cap was the blocking reason)

describe("runAlgorithm — last-resort fallback and no-match paths", () => {
  // ── MC-new-1 ─────────────────────────────────────────────────
  it("MC-new-1: fallback fires when anchor waited > FALLBACK_WAIT_MINUTES and all skill windows fail — returns isMixedLevel=true", () => {
    // Anchor: skill 5, wait just above threshold (not Red Zone)
    const anchor = makePlayer("anchor", {
      skillInt: 5,
      waitMinutes: FALLBACK_WAIT_MINUTES + 1, // 16 min > 15 → fallback fires; < 25 → not Red Zone
    });
    // Three candidates at extreme skill 10 — |10-5|=5 > SKILL_VARIANCE_MAX(2)
    // so they fail ALL skill-window passes (anchor not Red Zone → only ±1, ±2 tried)
    const c1 = makePlayer("c1", { skillInt: 10, waitMinutes: 5 });
    const c2 = makePlayer("c2", { skillInt: 10, waitMinutes: 4 });
    const c3 = makePlayer("c3", { skillInt: 10, waitMinutes: 3 });

    const pool = [anchor, c1, c2, c3];
    const result = runAlgorithm(pool, new Map(), new Map(), []);

    // Fallback path: no skill filtering → snakeDraft succeeds → isMixedLevel=true
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.isMixedLevel).toBe(true);
    expect(result.capSaturation).toBe(false);
    // Both teams must have exactly 2 players
    expect(result.proposal!.teamA).toHaveLength(2);
    expect(result.proposal!.teamB).toHaveLength(2);
  });

  // ── MC-new-2 ─────────────────────────────────────────────────
  it("MC-new-2: fallback fires but snakeDraft returns null because all non-anchor candidate pairs are capped — proposal: null", () => {
    const anchor = makePlayer("anchor", {
      skillInt: 5,
      waitMinutes: FALLBACK_WAIT_MINUTES + 1, // 16 min → fallback fires
    });
    // candidates skills 4,3,2: ±1 has only c1 (1 < 3), ±2 has c1+c2 (2 < 3) → all windows fail
    const c1 = makePlayer("c1", { skillInt: 4, waitMinutes: 5 });
    const c2 = makePlayer("c2", { skillInt: 3, waitMinutes: 4 });
    const c3 = makePlayer("c3", { skillInt: 2, waitMinutes: 3 });

    // Cap all non-anchor same-side pairs. Sorted DESC → [anchor(5),c1(4),c2(3),c3(2)]
    // Split 0: teamA=[anchor,c3], teamB=[c1,c2] → c1-c2 capped → skip
    // Split 1: teamA=[anchor,c2], teamB=[c1,c3] → c1-c3 capped → skip
    // Split 2: teamA=[anchor,c1], teamB=[c2,c3] → c2-c3 capped → skip
    const partnershipCounts = new Map([
      [pairKey("c1", "c2"), MAX_PARTNERSHIP_REPEATS],
      [pairKey("c1", "c3"), MAX_PARTNERSHIP_REPEATS],
      [pairKey("c2", "c3"), MAX_PARTNERSHIP_REPEATS],
    ]);

    const pool = [anchor, c1, c2, c3];
    const result = runAlgorithm(pool, partnershipCounts, new Map(), []);

    // Fallback fires but snakeDraft exhausts all splits → no proposal
    expect(result.proposal).toBeNull();
    // capWasActive: anchor-candidate pairs are NOT capped → cap did not filter any
    // candidate → capWasActive = false → capSaturation: false
    expect(result.capSaturation).toBe(false);
  });

  // ── MC-new-3 ─────────────────────────────────────────────────
  it("MC-new-3: anchor wait === FALLBACK_WAIT_MINUTES (not exceeding) → fallback does NOT fire → proposal: null", () => {
    const anchor = makePlayer("anchor", {
      skillInt: 5,
      waitMinutes: FALLBACK_WAIT_MINUTES, // exactly 15 — condition is > 15, so this does NOT trigger
    });
    const c1 = makePlayer("c1", { skillInt: 10, waitMinutes: 5 });
    const c2 = makePlayer("c2", { skillInt: 10, waitMinutes: 4 });
    const c3 = makePlayer("c3", { skillInt: 10, waitMinutes: 3 });

    const pool = [anchor, c1, c2, c3];
    const result = runAlgorithm(pool, new Map(), new Map(), []);

    // No skill-window match (|10-5|=5 > 2), fallback condition: 15 > 15 = false
    expect(result.proposal).toBeNull();
    expect(result.capSaturation).toBe(false); // no cap filtering happened
  });

  // ── MC-new-4 ─────────────────────────────────────────────────
  it("MC-new-4: all anchor–candidate pairs cap-blocked → capSaturation: true", () => {
    // Anchor far below fallback threshold so the fallback can't rescue
    const anchor = makePlayer("anchor", {
      skillInt: 5,
      waitMinutes: 5, // well below FALLBACK_WAIT_MINUTES (15)
    });
    const c1 = makePlayer("c1", { skillInt: 5, waitMinutes: 4 });
    const c2 = makePlayer("c2", { skillInt: 5, waitMinutes: 3 });
    const c3 = makePlayer("c3", { skillInt: 5, waitMinutes: 2 });

    // Every anchor–candidate pair is at or above MAX_PARTNERSHIP_REPEATS → all filtered out
    const partnershipCounts = new Map([
      [pairKey("anchor", "c1"), MAX_PARTNERSHIP_REPEATS],
      [pairKey("anchor", "c2"), MAX_PARTNERSHIP_REPEATS],
      [pairKey("anchor", "c3"), MAX_PARTNERSHIP_REPEATS],
    ]);

    const pool = [anchor, c1, c2, c3];
    const result = runAlgorithm(pool, partnershipCounts, new Map(), []);

    // candidates = [] (all filtered); capWasActive = pool.length-1 (3) > 0 = true
    expect(result.proposal).toBeNull();
    expect(result.capSaturation).toBe(true);
  });
});

// ============================================================
// getDynamicDraftCap — Draft cap scaling (added for cap-override feature)
// ============================================================
//
// DC-1  Small session (< 25 waiting) → cap = 3
// DC-2  Large session (25–29 waiting) → cap = 5
// DC-3  XLarge session (≥ 30 waiting) → cap = 6
// DC-4  Boundary: exactly 24 → cap = 3
// DC-5  Boundary: exactly 25 → cap = 5
// DC-6  Boundary: exactly 29 → cap = 5
// DC-7  Boundary: exactly 30 → cap = 6
// DC-8  Override null → dynamic cap passes through unchanged
// DC-9  Override < dynamicCap → override wins (ceiling applied)
// DC-10 Override > dynamicCap → dynamic cap wins (override ignored)
// DC-11 Override = dynamicCap → value unchanged
// DC-12 Override = 1 (minimum) → 1 regardless of dynamic cap
// DC-13 Override = 5 (maximum) → still bounded by dynamic cap when dynamic < 5

import {
  MAX_AUTO_DRAFTS,
  MAX_AUTO_DRAFTS_LARGE,
  MAX_AUTO_DRAFTS_XLARGE,
  DRAFT_CAP_LARGE_THRESHOLD,
  DRAFT_CAP_XLARGE_THRESHOLD,
} from "@/lib/constants";

/** The effective cap logic that runEngineInternal will apply. Pure function. */
function getEffectiveCap(waitingCount: number, override: number | null): number {
  const dynamic = getDynamicDraftCap(waitingCount);
  return override != null ? Math.min(override, dynamic) : dynamic;
}

describe("getDynamicDraftCap — tiered auto-scaling", () => {
  it("DC-1: small session (0 waiting) → cap 3", () => {
    expect(getDynamicDraftCap(0)).toBe(MAX_AUTO_DRAFTS);
  });

  it("DC-2: large session (27 waiting) → cap 5", () => {
    expect(getDynamicDraftCap(27)).toBe(MAX_AUTO_DRAFTS_LARGE);
  });

  it("DC-3: xlarge session (35 waiting) → cap 6", () => {
    expect(getDynamicDraftCap(35)).toBe(MAX_AUTO_DRAFTS_XLARGE);
  });

  it("DC-4: boundary — 24 waiting → cap 3 (just below large threshold)", () => {
    expect(getDynamicDraftCap(DRAFT_CAP_LARGE_THRESHOLD - 1)).toBe(MAX_AUTO_DRAFTS);
  });

  it("DC-5: boundary — 25 waiting → cap 5 (exactly at large threshold)", () => {
    expect(getDynamicDraftCap(DRAFT_CAP_LARGE_THRESHOLD)).toBe(MAX_AUTO_DRAFTS_LARGE);
  });

  it("DC-6: boundary — 29 waiting → cap 5 (just below xlarge threshold)", () => {
    expect(getDynamicDraftCap(DRAFT_CAP_XLARGE_THRESHOLD - 1)).toBe(MAX_AUTO_DRAFTS_LARGE);
  });

  it("DC-7: boundary — 30 waiting → cap 6 (exactly at xlarge threshold)", () => {
    expect(getDynamicDraftCap(DRAFT_CAP_XLARGE_THRESHOLD)).toBe(MAX_AUTO_DRAFTS_XLARGE);
  });
});

describe("getEffectiveCap — override ceiling logic", () => {
  it("DC-8: null override → dynamic cap used unchanged", () => {
    expect(getEffectiveCap(10, null)).toBe(MAX_AUTO_DRAFTS); // dynamic=3
    expect(getEffectiveCap(27, null)).toBe(MAX_AUTO_DRAFTS_LARGE); // dynamic=5
  });

  it("DC-9: override 2 with dynamic 5 → effective cap is 2 (organizer restricts)", () => {
    expect(getEffectiveCap(27, 2)).toBe(2);
  });

  it("DC-10: override 5 with dynamic 3 → effective cap is 3 (dynamic wins, prevents pool starvation)", () => {
    // Small session: organizer wants 5 but pool only supports 3
    expect(getEffectiveCap(10, 5)).toBe(3);
  });

  it("DC-11: override equals dynamic cap → value unchanged", () => {
    expect(getEffectiveCap(10, 3)).toBe(3); // dynamic=3, override=3
  });

  it("DC-12: override 1 → maximum restriction regardless of pool size", () => {
    expect(getEffectiveCap(0, 1)).toBe(1);
    expect(getEffectiveCap(30, 1)).toBe(1); // dynamic=6 but capped to 1
  });

  it("DC-13: override 5 in xlarge session (dynamic=6) → capped at 5", () => {
    expect(getEffectiveCap(35, 5)).toBe(5); // 5 < 6, override wins
  });
});

// ═════════════════════════════════════════════════════════════
// CROSS-COURT DIVERSITY DRAFTING — pure helpers (Phase 3)
// ═════════════════════════════════════════════════════════════
// Determinism (senior-QA QA-PURE-02): the whole section runs under a frozen
// clock so makePlayer's Date.now()-seeded joined_at and makePulled's timestamps
// are reproducible run-to-run.

const FIXED_NOW = new Date("2026-06-07T12:00:00.000Z");

// A still-playing body, exactly as fetchPullablePlayers emits it: priorityScore
// forced to -1 (C-3, never recomputed), isPulled true, with the current match's
// started_at for the pickEarliestFinishing tiebreak.
function makePulled(
  id: string,
  opts: { skillInt: number; currentMatchStartedAt?: string; joinedMinutesAgo?: number }
): ScoredPlayer {
  const joinedMinutesAgo = opts.joinedMinutesAgo ?? 0;
  const base: QueueWithWaitTime = {
    id: `entry-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: new Date(FIXED_NOW.getTime() - joinedMinutesAgo * 60_000).toISOString(),
    games_played: 0,
    status: "playing",
    position: null,
    is_paused: false,
    created_at: FIXED_NOW.toISOString(),
    display_name: `Pulled-${id}`,
    skill_level: "intermediate",
    skill_level_int: opts.skillInt,
    wait_minutes: 0,
    is_bottleneck: false,
  };
  return {
    ...base,
    priorityScore: -1,
    isPulled: true,
    currentMatchStartedAt: opts.currentMatchStartedAt ?? FIXED_NOW.toISOString(),
  };
}

describe("Cross-Court Diversity Drafting (pure)", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  describe("isPullEligible", () => {
    const body = () => makePulled("p", { skillInt: 5 });

    it("CC-PURE-CC01: streak 0, not already held → eligible", () => {
      expect(isPullEligible(body(), { streak: 0, alreadyHeld: false })).toBe(true);
    });

    it("CC-PURE-CC02: streak === cap → excluded (relational cooldown, R3-C)", () => {
      expect(
        isPullEligible(body(), { streak: MAX_CONSECUTIVE_GAMES_FOR_PULL, alreadyHeld: false })
      ).toBe(false);
    });

    it("CC-PURE-CC03: streak one below cap → still eligible", () => {
      expect(
        isPullEligible(body(), { streak: MAX_CONSECUTIVE_GAMES_FOR_PULL - 1, alreadyHeld: false })
      ).toBe(true);
    });

    it("CC-PURE-CC04: streak above cap → excluded", () => {
      expect(
        isPullEligible(body(), { streak: MAX_CONSECUTIVE_GAMES_FOR_PULL + 1, alreadyHeld: false })
      ).toBe(false);
    });

    it("CC-PURE-CC05: already in another held draft → excluded even at streak 0", () => {
      expect(isPullEligible(body(), { streak: 0, alreadyHeld: true })).toBe(false);
    });

    it("CC-PURE-CC06 [N-4]: skill is irrelevant — extreme low/high both eligible (no skill-window)", () => {
      expect(
        isPullEligible(makePulled("lo", { skillInt: 1 }), { streak: 0, alreadyHeld: false })
      ).toBe(true);
      expect(
        isPullEligible(makePulled("hi", { skillInt: 9 }), { streak: 0, alreadyHeld: false })
      ).toBe(true);
    });
  });

  describe("isHeldMatchReady", () => {
    const FALLBACK_MS = CROSS_COURT_REST_FALLBACK_MINUTES * 60_000;
    const now = FIXED_NOW.getTime();
    const freedMsAgo = (ms: number) => new Date(now - ms).toISOString();

    it("CC-PURE-CC07: still playing (pulledFreedAt null) → false regardless of promotions/timer", () => {
      expect(
        isHeldMatchReady({
          pulledFreedAt: null,
          promotionsSinceFreed: 9,
          now,
          restFallbackMs: FALLBACK_MS,
        })
      ).toBe(false);
    });

    it("CC-PURE-CC08: freed + ≥1 promotion → ready (fallback not needed)", () => {
      expect(
        isHeldMatchReady({
          pulledFreedAt: freedMsAgo(0),
          promotionsSinceFreed: 1,
          now,
          restFallbackMs: FALLBACK_MS,
        })
      ).toBe(true);
    });

    it("CC-PURE-CC09: freed + 0 promotions + elapsed < fallback → not ready", () => {
      expect(
        isHeldMatchReady({
          pulledFreedAt: freedMsAgo(FALLBACK_MS - 1),
          promotionsSinceFreed: 0,
          now,
          restFallbackMs: FALLBACK_MS,
        })
      ).toBe(false);
    });

    it("CC-PURE-CC10: freed + 0 promotions + elapsed === fallback → ready (boundary is >=)", () => {
      expect(
        isHeldMatchReady({
          pulledFreedAt: freedMsAgo(FALLBACK_MS),
          promotionsSinceFreed: 0,
          now,
          restFallbackMs: FALLBACK_MS,
        })
      ).toBe(true);
    });

    it("CC-PURE-CC11: freed + 0 promotions + elapsed > fallback → ready", () => {
      expect(
        isHeldMatchReady({
          pulledFreedAt: freedMsAgo(FALLBACK_MS + 60_000),
          promotionsSinceFreed: 0,
          now,
          restFallbackMs: FALLBACK_MS,
        })
      ).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // heldDraftExpired — the hold-age cancel
  // ─────────────────────────────────────────────────────────────
  // This is the guard for the two SEATED waiters. `anchorBlocksReach` bounds
  // only pool[0], and only at creation time — the review that produced this
  // helper showed the sort order carries no wait bound down the pool
  // (priorityScore nets off games played, so a wait-19 / 3-games seat sits
  // BELOW a wait-16 / 0-games anchor). Extending the anchor's 17-minute margin
  // to the seats would have forced all three waiters to be zero-games players
  // once the rest filter is active, i.e. re-killed the feature; capping the
  // hold bounds the harm for all three without narrowing the reach.
  describe("heldDraftExpired (hold-age cancel)", () => {
    const MAX_MS = CROSS_COURT_MAX_HOLD_MINUTES * 60_000;
    const now = FIXED_NOW.getTime();
    const createdMsAgo = (ms: number) => new Date(now - ms).toISOString();

    it("CC-HOLD-1: body still playing past the cap → expired", () => {
      expect(
        heldDraftExpired({
          createdAt: createdMsAgo(MAX_MS + 1),
          pulledFreedAt: null,
          now,
          maxHoldMs: MAX_MS,
        })
      ).toBe(true);
    });

    it("CC-HOLD-2: exactly at the cap → expired (boundary is >=, matching isHeldMatchReady)", () => {
      expect(
        heldDraftExpired({
          createdAt: createdMsAgo(MAX_MS),
          pulledFreedAt: null,
          now,
          maxHoldMs: MAX_MS,
        })
      ).toBe(true);
    });

    it("CC-HOLD-3: under the cap → not expired", () => {
      expect(
        heldDraftExpired({
          createdAt: createdMsAgo(MAX_MS - 1),
          pulledFreedAt: null,
          now,
          maxHoldMs: MAX_MS,
        })
      ).toBe(false);
    });

    it("CC-HOLD-4: ⚠️ ONCE FREED it never expires, however old — isHeldMatchReady resolves it within the rest fallback, and cancelling then would throw away the pull for nothing", () => {
      expect(
        heldDraftExpired({
          createdAt: createdMsAgo(MAX_MS * 10),
          pulledFreedAt: createdMsAgo(0),
          now,
          maxHoldMs: MAX_MS,
        })
      ).toBe(false);
    });

    it("CC-HOLD-5: a malformed created_at never cancels a healthy draft", () => {
      // NaN comparisons are already false, but this decides whether three real
      // players lose their seat — pin it rather than rely on the coercion.
      expect(
        heldDraftExpired({ createdAt: "not-a-date", pulledFreedAt: null, now, maxHoldMs: MAX_MS })
      ).toBe(false);
    });

    it("CC-HOLD-6: the cap sits above the p90 court-free time, so the median hold is untouched", () => {
      // Calibration guard, not a tautology: production p50 4.7 min / p90 12.7.
      // If someone tightens the constant below p90 the reach rate collapses.
      const P90_COURT_FREE_MS = 12.7 * 60_000;
      expect(MAX_MS).toBeGreaterThan(P90_COURT_FREE_MS);
      expect(
        heldDraftExpired({
          createdAt: createdMsAgo(P90_COURT_FREE_MS),
          pulledFreedAt: null,
          now,
          maxHoldMs: MAX_MS,
        })
      ).toBe(false);
    });
  });

  describe("pickEarliestFinishing (N-3 tiebreak)", () => {
    it("CC-PURE-CC12: returns the candidate whose current game started earliest", () => {
      const early = makePulled("early", {
        skillInt: 5,
        currentMatchStartedAt: "2026-06-07T11:30:00.000Z",
      });
      const late = makePulled("late", {
        skillInt: 5,
        currentMatchStartedAt: "2026-06-07T11:55:00.000Z",
      });
      expect(pickEarliestFinishing([late, early])?.player_id).toBe("early");
    });

    it("CC-PURE-CC13: empty list → null", () => {
      expect(pickEarliestFinishing([])).toBeNull();
    });

    it("CC-PURE-CC14: equal start times → deterministic by player_id", () => {
      const a = makePulled("a", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:40:00.000Z" });
      const b = makePulled("b", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:40:00.000Z" });
      expect(pickEarliestFinishing([b, a])?.player_id).toBe("a");
    });
  });

  describe("forcedRepeat flag (cross-court trigger signal)", () => {
    it("CC-PURE-CC15: clean diverse match → forcedRepeat falsy", () => {
      const pool = [
        makePlayer("a", { skillInt: 3, waitMinutes: 10 }),
        makePlayer("b", { skillInt: 3, waitMinutes: 9 }),
        makePlayer("c", { skillInt: 3, waitMinutes: 8 }),
        makePlayer("d", { skillInt: 3, waitMinutes: 7 }),
      ];
      const res = runAlgorithm(pool, new Map(), new Map(), []);
      expect(res.proposal).not.toBeNull();
      expect(res.forcedRepeat).toBeFalsy();
    });

    it("CC-PURE-CC16: unavoidable repeat (same 4 in every recent roster) → forcedRepeat true", () => {
      const pool = [
        makePlayer("a", { skillInt: 3, waitMinutes: 10 }),
        makePlayer("b", { skillInt: 3, waitMinutes: 9 }),
        makePlayer("c", { skillInt: 3, waitMinutes: 8 }),
        makePlayer("d", { skillInt: 3, waitMinutes: 7 }),
      ];
      const ids = ["a", "b", "c", "d"];
      const res = runAlgorithm(pool, new Map(), new Map(), [ids, ids, ids, ids, ids]);
      expect(res.proposal).not.toBeNull();
      expect(res.forcedRepeat).toBe(true);
    });

    it("CC-PURE-CC17: too few players → proposal null, forcedRepeat falsy", () => {
      const res = runAlgorithm(
        [makePlayer("a", { skillInt: 3 }), makePlayer("b", { skillInt: 3 })],
        new Map(),
        new Map(),
        []
      );
      expect(res.proposal).toBeNull();
      expect(res.forcedRepeat).toBeFalsy();
    });
  });

  describe("≤1 pulled body per match (N-1)", () => {
    const countPulled = (res: ReturnType<typeof runAlgorithm>) =>
      res.proposal
        ? [...res.proposal.teamA, ...res.proposal.teamB].filter((p) => p.isPulled).length
        : 0;

    it("CC-PURE-CC18: 3 waiting + 2 pulled → composes exactly ONE pulled; waiting anchors (C-3)", () => {
      // Pre-scored pool (as fetchPullablePlayers emits): waiting >= 0, pulled at -1.
      const pool = [
        makePlayer("w0", { skillInt: 3, waitMinutes: 12 }),
        makePlayer("w1", { skillInt: 3, waitMinutes: 8 }),
        makePlayer("w2", { skillInt: 3, waitMinutes: 6 }),
        makePulled("pullA", { skillInt: 3, currentMatchStartedAt: "2026-06-07T11:40:00.000Z" }),
        makePulled("pullB", { skillInt: 3, currentMatchStartedAt: "2026-06-07T11:55:00.000Z" }),
      ];
      const res = runAlgorithm(pool, new Map(), new Map(), []);
      expect(res.proposal).not.toBeNull();
      // Exactly one pulled — NOT 0 (gave up) and NOT 2 (constraint violated).
      expect(countPulled(res)).toBe(1);
      // C-3: a waiting player anchors (pool[0] is never a pulled body).
      expect(pool[0].isPulled).toBeFalsy();
      expect(pool[0].player_id).toBe("w0");
    });

    it("CC-PURE-CC19: 2 waiting + 2 pulled (no ≤1-pulled four possible) → no match, NOT a 2-pulled match", () => {
      const pool = [
        makePlayer("w0", { skillInt: 3, waitMinutes: 5 }), // low wait → no last-resort fallback
        makePlayer("w1", { skillInt: 3, waitMinutes: 4 }),
        makePulled("pullA", { skillInt: 3 }),
        makePulled("pullB", { skillInt: 3 }),
      ];
      const res = runAlgorithm(pool, new Map(), new Map(), []);
      expect(res.proposal).toBeNull();
    });
  });
});

// ============================================================
// shouldAutoPublishMatch — auto-publish mode decision (pure)
// ============================================================
//
// AP-1  auto_publish=true  → true  (engine writes is_published=true)
// AP-2  auto_publish=false → false (engine writes is_published=false / draft)

describe("shouldAutoPublishMatch — auto-publish decision", () => {
  it("AP-1: true → true (skip the draft gate)", () => {
    expect(shouldAutoPublishMatch(true)).toBe(true);
  });

  it("AP-2: false → false (draft mode, organizer reviews)", () => {
    expect(shouldAutoPublishMatch(false)).toBe(false);
  });
});

// ============================================================
// countConsecutiveOpponentRepeats — split-aware freshness (pure)
// ============================================================
//
// The engine's answer to "I faced them AGAIN, right after". Two facts make
// this the right shape and both are asserted below:
//
//   CCO-1/2  a repeat is only a repeat ACROSS THE NET — the same pair drafted
//            as TEAMMATES is the fix, not the offence, and scores 0
//   CCO-3    per-player and binary — facing two of your last opponents at once
//            is ONE bad game, not two (this is what bounds the term at 4, which
//            is what makes CONSECUTIVE_OPPONENT_PENALTY provably sub-quantum)
//   CCO-4/5  absent or empty map ⇒ 0 for every split, which is what makes every
//            caller behaviour-identical to the pre-freshness engine

describe("countConsecutiveOpponentRepeats — cross-net only, per player", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => makePlayer(id, { skillInt: 3 }));

  it("CCO-1: charges each player who would face a previous-game opponent across the net", () => {
    // a and c faced each other last game; this split puts them on opposite
    // sides again → both are charged.
    const lastOpponents = new Map([
      ["a", new Set(["c"])],
      ["c", new Set(["a"])],
    ]);
    const split = { teamA: [a, b], teamB: [c, d] };
    expect(countConsecutiveOpponentRepeats(split, lastOpponents)).toBe(2);
  });

  it("CCO-2: the SAME pair drafted as teammates scores 0 — pairing them up is the fix", () => {
    const lastOpponents = new Map([
      ["a", new Set(["c"])],
      ["c", new Set(["a"])],
    ]);
    const split = { teamA: [a, c], teamB: [b, d] };
    expect(countConsecutiveOpponentRepeats(split, lastOpponents)).toBe(0);
  });

  it("CCO-3: binary per player — facing TWO previous opponents still counts once for that player", () => {
    // a faced both c and d last game. a is charged once; c and d are each
    // charged for facing a. Total 3, not 4.
    const lastOpponents = new Map([
      ["a", new Set(["c", "d"])],
      ["c", new Set(["a"])],
      ["d", new Set(["a"])],
    ]);
    const split = { teamA: [a, b], teamB: [c, d] };
    expect(countConsecutiveOpponentRepeats(split, lastOpponents)).toBe(3);
  });

  it("CCO-3b: the maximum is 4 — one per seat, which is the sub-quantum bound", () => {
    const lastOpponents = new Map([
      ["a", new Set(["c", "d"])],
      ["b", new Set(["c", "d"])],
      ["c", new Set(["a", "b"])],
      ["d", new Set(["a", "b"])],
    ]);
    const split = { teamA: [a, b], teamB: [c, d] };
    const repeats = countConsecutiveOpponentRepeats(split, lastOpponents);
    expect(repeats).toBe(4);
    // The constant must track the measured maximum, not drift from it — every
    // bound below is stated in terms of the constant.
    expect(MAX_CONSECUTIVE_OPPONENT_REPEATS).toBe(repeats);

    // The guardrail this exists to protect: even at maximum, the term cannot
    // reach one games-ahead quantum, so fairness tiers are never reordered.
    expect(repeats * CONSECUTIVE_OPPONENT_PENALTY).toBeLessThan(GAMES_AHEAD_PENALTY);

    // The REAL ceiling is one higher: buildCombinationGroup scores an unseatable
    // four at MAX + 1 so it sorts strictly below every real split. Asserting only
    // the 4× bound above leaves a window (penalty in [2000, 2500)) where the
    // sentinel breaches the quantum while the whole suite stays green. This is
    // the assertion that actually pins CONSECUTIVE_OPPONENT_PENALTY < 2000.
    expect((MAX_CONSECUTIVE_OPPONENT_REPEATS + 1) * CONSECUTIVE_OPPONENT_PENALTY).toBeLessThan(
      GAMES_AHEAD_PENALTY
    );
  });

  it("CCO-4: an absent map scores 0 (the pre-freshness engine's behaviour)", () => {
    expect(countConsecutiveOpponentRepeats({ teamA: [a, b], teamB: [c, d] })).toBe(0);
  });

  it("CCO-5: an empty map scores 0 — t=0, before any match has been played", () => {
    expect(countConsecutiveOpponentRepeats({ teamA: [a, b], teamB: [c, d] }, new Map())).toBe(0);
  });
});

// ============================================================
// The split preview — snakeDraft / buildCombinationGroup wiring
// ============================================================
//
// CCO-6/7  snakeDraft prefers the fresher split WITHIN a rung, and never
//          promotes across one (the regression that sank the rival variant:
//          buying opponent freshness by re-teaming a used partnership)
// CCO-8/9  buildCombinationGroup only changes its selection when the map is
//          non-empty — this gate is what makes REPLAY_NO_LAST_OPPONENTS an
//          exact baseline control rather than an approximation

describe("snakeDraft — consecutive-opponent tie-break inside a rung", () => {
  it("CCO-6: with several fresh splits available, picks the one with no rematch", () => {
    // Equal skills → all three splits are balanced and every pair is fresh, so
    // all of them qualify in pass 1a and the repeat count is the only separator.
    const players = ["a", "b", "c", "d"].map((id) => makePlayer(id, { skillInt: 3 }));
    // a just faced b. The default [0,3] vs [1,2] split (a+d vs b+c) would
    // re-serve it; a+b vs c+d does not.
    const lastOpponents = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);

    const draft = snakeDraft(
      players,
      new Map(),
      MAX_PARTNERSHIP_REPEATS,
      new Map(),
      MAX_OPPONENT_REPEATS,
      lastOpponents
    );

    expect(draft).not.toBeNull();
    expect(countConsecutiveOpponentRepeats(draft!, lastOpponents)).toBe(0);
    // Specifically: a and b end up as TEAMMATES.
    const teamOfA = draft!.teamA.some((p) => p.player_id === "a") ? draft!.teamA : draft!.teamB;
    expect(teamOfA.map((p) => p.player_id).sort()).toEqual(["a", "b"]);
  });

  it("CCO-7: never promotes a used partnership up the ladder to dodge a rematch", () => {
    // a+b have already partnered. The ONLY rematch-free split is a+b vs c+d —
    // but that split is not fresh, so pass 1a/1b must still win. Freshness of
    // PARTNERSHIPS outranks freshness of opponents; the preference is a
    // within-rung tie-break, never a rung promotion.
    const players = ["a", "b", "c", "d"].map((id) => makePlayer(id, { skillInt: 3 }));
    const partnershipCounts = new Map([[pairKey("a", "b"), 1]]);
    const lastOpponents = new Map([
      ["a", new Set(["c", "d"])],
      ["c", new Set(["a"])],
      ["d", new Set(["a"])],
    ]);

    const draft = snakeDraft(
      players,
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS,
      new Map(),
      MAX_OPPONENT_REPEATS,
      lastOpponents
    );

    expect(draft).not.toBeNull();
    const teamOfA = draft!.teamA.some((p) => p.player_id === "a") ? draft!.teamA : draft!.teamB;
    // a is NOT paired with b — the used partnership was not resurrected.
    expect(teamOfA.map((p) => p.player_id)).not.toEqual(["a", "b"]);
    expect(partnershipCounts.get(pairKey(teamOfA[0].player_id, teamOfA[1].player_id)) ?? 0).toBe(0);
  });
});

describe("buildCombinationGroup — the split-preview gate", () => {
  // Six equal-skill candidates, all valid together, with distinct wait times so
  // the score order is unambiguous.
  const anchor = makePlayer("anchor", { skillInt: 3, waitMinutes: 30 });
  const candidates = ["c1", "c2", "c3", "c4", "c5"].map((id, i) =>
    makePlayer(id, { skillInt: 3, waitMinutes: 20 - i })
  );

  it("CCO-8: an EMPTY lastOpponents map leaves the first-valid selection untouched", () => {
    const scored = scoreCandidates(candidates, new Map());
    const baseline = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    const withEmptyPreview = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX, {
      partnershipCounts: new Map(),
      cap: MAX_PARTNERSHIP_REPEATS,
      opponentCounts: new Map(),
      opponentCap: MAX_OPPONENT_REPEATS,
      lastOpponents: new Map(),
    });

    expect(withEmptyPreview.map((p) => p.player_id)).toEqual(baseline.map((p) => p.player_id));
  });

  it("CCO-9: a non-empty map moves the selection off the top-3 to avoid an immediate rematch", () => {
    // The top-3 by score are c1/c2/c3. Make every one of those foursomes a
    // rematch for the anchor, and leave c4 clean.
    const lastOpponents = new Map([
      ["anchor", new Set(["c1", "c2", "c3"])],
      ["c1", new Set(["anchor"])],
      ["c2", new Set(["anchor"])],
      ["c3", new Set(["anchor"])],
    ]);
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX, {
      partnershipCounts: new Map(),
      cap: MAX_PARTNERSHIP_REPEATS,
      opponentCounts: new Map(),
      opponentCap: MAX_OPPONENT_REPEATS,
      lastOpponents,
    });

    expect(group).toHaveLength(3);
    // The selection actually MOVED — this is the claim the title makes, and
    // asserting only `repeats === 0` below would pass even if it had not.
    const baseline = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX);
    expect(group.map((p) => p.player_id)).not.toEqual(baseline.map((p) => p.player_id));

    const draft = snakeDraft(
      [anchor, ...group],
      new Map(),
      MAX_PARTNERSHIP_REPEATS,
      new Map(),
      MAX_OPPONENT_REPEATS,
      lastOpponents
    );
    // Whatever it picked, the anchor is not re-served the same opponents.
    expect(countConsecutiveOpponentRepeats(draft!, lastOpponents)).toBe(0);
  });

  it("CCO-10: fairness still dominates — a games-ahead candidate is never pulled in to dodge a rematch", () => {
    // c5 has played 3 more games than the pool minimum, so it carries
    // 3 × GAMES_AHEAD_PENALTY. Make EVERY foursome without c5 a rematch: the
    // engine must still refuse to draft c5, because 12 can never buy 10_000.
    const aheadPool = [
      ...candidates.slice(0, 4),
      makePlayer("c5", { skillInt: 3, waitMinutes: 16, gamesPlayed: 3 }),
    ];
    const lastOpponents = new Map([
      ["anchor", new Set(["c1", "c2", "c3", "c4"])],
      ["c1", new Set(["anchor"])],
      ["c2", new Set(["anchor"])],
      ["c3", new Set(["anchor"])],
      ["c4", new Set(["anchor"])],
    ]);
    const scored = scoreCandidates(aheadPool, new Map(), 0);
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX, {
      partnershipCounts: new Map(),
      cap: MAX_PARTNERSHIP_REPEATS,
      opponentCounts: new Map(),
      opponentCap: MAX_OPPONENT_REPEATS,
      lastOpponents,
    });

    expect(group.map((p) => p.player_id)).not.toContain("c5");
  });
});

// ============================================================
// The unsplittable-four trap  [regression — review gate, blocking]
// ============================================================
//
// snakeDraft returns null when EVERY team assignment for a four is partnership-
// capped. The preview first scored that as `repeats = 0` — the best possible
// value — so the argmin did not merely tolerate an unseatable four, it PREFERRED
// one over a seatable four whenever fairness was within 4 × 3 = 12 points.
//
// Nothing downstream recovers it: runAlgorithm's `if (!draft) continue` abandons
// the whole skill window, so the observable failure is a court that seats nobody
// while a perfectly good four was available — and with capSaturation false, so
// it does not even read as saturation to the caller.
//
// The setup below is the real precondition, not a contrivance: three players
// mutually at the partnership cap while none of them is capped WITH the anchor.
// That combination is what slips past the anchor-pair pre-filter and is ordinary
// late-session state. Every wait time is identical so fairness is a constant and
// the selection is decided purely by the repeats term.

describe("buildCombinationGroup — an unsplittable four is scored worst, not best", () => {
  const anchor = makePlayer("anchor", { skillInt: 3, waitMinutes: 20 });
  const candidates = ["c1", "c2", "c3", "c4"].map((id) =>
    makePlayer(id, { skillInt: 3, waitMinutes: 20 })
  );
  // c1/c2/c3 are mutually capped, so {anchor,c1,c2,c3} has no legal split: every
  // arrangement leaves two of them partnered. The anchor is capped with nobody.
  const cappedTrio = () =>
    new Map([
      [pairKey("c1", "c2"), MAX_PARTNERSHIP_REPEATS],
      [pairKey("c1", "c3"), MAX_PARTNERSHIP_REPEATS],
      [pairKey("c2", "c3"), MAX_PARTNERSHIP_REPEATS],
    ]);
  // Anything containing c4 is seatable but IS a rematch (anchor just faced c4),
  // so the buggy scoring ranked the unseatable trio strictly ahead of it.
  const lastOpponents = () =>
    new Map([
      ["anchor", new Set(["c4"])],
      ["c4", new Set(["anchor"])],
    ]);

  const preview = () => ({
    partnershipCounts: cappedTrio(),
    cap: MAX_PARTNERSHIP_REPEATS,
    opponentCounts: new Map<string, number>(),
    opponentCap: MAX_OPPONENT_REPEATS,
    lastOpponents: lastOpponents(),
  });

  it("CCO-11: the group it returns can actually be seated", () => {
    const scored = scoreCandidates(candidates, new Map());
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX, preview());

    expect(group).toHaveLength(3);
    // The bug returned exactly [c1,c2,c3] — the first triple in score order.
    expect(group.map((p) => p.player_id).sort()).not.toEqual(["c1", "c2", "c3"]);

    const draft = snakeDraft(
      [anchor, ...group],
      cappedTrio(),
      MAX_PARTNERSHIP_REPEATS,
      new Map(),
      MAX_OPPONENT_REPEATS,
      lastOpponents()
    );
    expect(draft).not.toBeNull();
  });

  it("CCO-12: runAlgorithm still seats a court instead of returning no match", () => {
    // Equal wait times, so pool order is the array order and anchor is pool[0].
    const pool = [anchor, ...candidates];
    const result = runAlgorithm(pool, cappedTrio(), new Map(), [], new Map(), [], lastOpponents());

    // Pre-fix this was `{ proposal: null, capSaturation: false }` — a silently
    // empty court, indistinguishable from "nobody is available".
    expect(result.proposal).not.toBeNull();
    const served = [...result.proposal!.teamA, ...result.proposal!.teamB].map((p) => p.player_id);
    expect(served).toHaveLength(4);
    expect(served).toContain("c4");
  });

  it("CCO-13: the preference is a tie-break, not a second partnership gate", () => {
    // Same capped trio, but now c4 is 3 games ahead of the pool: 3 ×
    // GAMES_AHEAD_PENALTY dwarfs the 12-point ceiling, so fairness must win and
    // the engine must go back to preferring the trio — and then legitimately
    // fail to split it. Scoring an unsplittable four at MAX must not turn this
    // term into a hard constraint that outranks games-owed.
    const aheadCandidates = [
      ...candidates.slice(0, 3),
      makePlayer("c4", { skillInt: 3, waitMinutes: 20, gamesPlayed: 3 }),
    ];
    const scored = scoreCandidates(aheadCandidates, new Map(), 0);
    const group = buildCombinationGroup(anchor, scored, SKILL_VARIANCE_MAX, preview());

    expect(group.map((p) => p.player_id).sort()).toEqual(["c1", "c2", "c3"]);
  });
});

// ============================================================
// forcedRepeat — the Red-Zone escape hatch used to stay silent
// ============================================================
//
// When the diversity/rejection check fails, the engine tries to swap out
// group[2]. If that player is in the Red Zone it refuses to bench them and
// falls through, serving the violating four anyway. That is a forced repeat by
// every definition the flag uses — but the fall-through returned with the flag
// absent, so cross-court augmentation never fired for the one case where the
// engine KNEW it was repeating. The flag is now decided from the roster
// actually served, not from which branch produced it.

describe("forcedRepeat — Red-Zone fall-through (silent-repeat fix)", () => {
  // Installed in beforeAll, NOT in the describe body: a describe body runs at
  // COLLECTION time, so a spy created there silences console.warn for every
  // test in the file, not just this block.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => warn.mockRestore());

  // Everyone Red Zone (wait ≥ CRITICAL_WAIT_MINUTES) so group[2] is Red Zone
  // and the diversity swap is refused. Only four players exist, so there is no
  // alternative body to swap in either way.
  const redZonePool = () => [
    makePlayer("a", { skillInt: 3, waitMinutes: CRITICAL_WAIT_MINUTES + 4 }),
    makePlayer("b", { skillInt: 3, waitMinutes: CRITICAL_WAIT_MINUTES + 3 }),
    makePlayer("c", { skillInt: 3, waitMinutes: CRITICAL_WAIT_MINUTES + 2 }),
    makePlayer("d", { skillInt: 3, waitMinutes: CRITICAL_WAIT_MINUTES + 1 }),
  ];
  const ids = ["a", "b", "c", "d"];

  it("FR-1: a diversity-violating four served past a Red-Zone swap target is flagged", () => {
    const pool = redZonePool();
    expect(pool.every((p) => p.priorityScore >= RED_ZONE_SCORE_FLOOR)).toBe(true);

    const res = runAlgorithm(pool, new Map(), new Map(), [ids, ids, ids, ids, ids]);
    expect(res.proposal).not.toBeNull();
    expect(res.forcedRepeat).toBe(true);
  });

  it("FR-2: a REJECTED roster served past a Red-Zone swap target is flagged too", () => {
    const pool = redZonePool();
    const res = runAlgorithm(
      pool,
      new Map(),
      new Map(),
      [], // no diversity history — the rejection memory is what fires
      new Map(),
      [ids]
    );
    expect(res.proposal).not.toBeNull();
    expect(res.forcedRepeat).toBe(true);
  });

  it("FR-3: a clean four is still NOT flagged — the flag tracks the served roster", () => {
    const pool = redZonePool();
    const res = runAlgorithm(pool, new Map(), new Map(), [], new Map(), [
      ["w", "x", "y", "z"], // a rejection for some other four
    ]);
    expect(res.proposal).not.toBeNull();
    expect(res.forcedRepeat).toBeFalsy();
  });
});
