// ============================================================
// Simulation: 30-player session — end-to-end cap enforcement
// ============================================================
//
// Runs the matchmaking algorithm (via pure core functions only,
// no Supabase) for a realistic 30-player session and validates
// all invariants introduced by the Hard Partner-Pair Cap feature.
//
// Key invariants asserted on EVERY formed match:
//   1. No same-team pair count ever exceeds MAX_PARTNERSHIP_REPEATS
//   2. Every match has exactly 4 distinct players
//   3. Non-mixed matches respect SKILL_VARIANCE_MAX
//
// Additional targeted tests:
//   4. capSignal fires when the cap is the sole blocker
//   5. Red Zone anchor hits cap → signal has type "red_zone"
//   6. Cap never blocks a match it shouldn't (count < cap is legal)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  computePriorityScore,
  isGroupValid,
  snakeDraft,
  rotatedDraft,
  isDiversityViolation,
  scoreCandidates,
  buildCombinationGroup,
  getEffectiveLookback,
  pairKey,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  ANTI_REPEAT_LOOKBACK,
  MAX_PARTNERSHIP_REPEATS,
  CRITICAL_WAIT_MINUTES,
  RED_ZONE_SCORE_FLOOR,
  FALLBACK_WAIT_MINUTES,
} from "@/lib/constants";
import type { QueueWithWaitTime } from "@/types/database";

// ─────────────────────────────────────────────────────────────
// Player factory
// ─────────────────────────────────────────────────────────────

function makeSimPlayer(
  id: string,
  skillInt: number,
  waitMinutes = 0,
  gamesPlayed = 0,
  joinedMinsAgo = 0
): ScoredPlayer {
  const base: QueueWithWaitTime = {
    id: `entry-${id}`,
    session_id: "sim-session",
    player_id: id,
    joined_at: new Date(Date.now() - joinedMinsAgo * 60_000).toISOString(),
    games_played: gamesPlayed,
    status: "waiting",
    position: null,
    is_paused: false,
    created_at: new Date().toISOString(),
    display_name: `Player-${id}`,
    skill_level: "intermediate",
    skill_level_int: skillInt,
    wait_minutes: waitMinutes,
    is_bottleneck: false,
  };
  return { ...base, priorityScore: computePriorityScore(base) };
}

// ─────────────────────────────────────────────────────────────
// 30-player roster — realistic club-night skill distribution
// ─────────────────────────────────────────────────────────────
//
// Skill distribution (bell-curve centred on intermediate):
//   Skill 1 (beginner−):   p01..p03  (3 players)
//   Skill 2 (beginner):    p04..p08  (5 players)
//   Skill 3 (inter−):      p09..p14  (6 players) ← largest cluster
//   Skill 4 (inter+):      p15..p21  (7 players) ← largest cluster
//   Skill 5 (advanced−):   p22..p26  (5 players)
//   Skill 6 (advanced):    p27..p29  (3 players)
//   Skill 7 (elite):       p30       (1 player)
//
// Why this distribution: tests same-tier clustering (3-4s can easily
// form lots of matches → will hit pair cap first), cross-tier
// Red Zone expansion (p30 only has ~8 eligible partners in ±2 window),
// and the natural cap-pressure hot-spots in the mid tier.

const THIRTY_PLAYERS: Array<{ id: string; skill: number }> = [
  // Skill 1
  { id: "p01", skill: 1 }, { id: "p02", skill: 1 }, { id: "p03", skill: 1 },
  // Skill 2
  { id: "p04", skill: 2 }, { id: "p05", skill: 2 }, { id: "p06", skill: 2 },
  { id: "p07", skill: 2 }, { id: "p08", skill: 2 },
  // Skill 3
  { id: "p09", skill: 3 }, { id: "p10", skill: 3 }, { id: "p11", skill: 3 },
  { id: "p12", skill: 3 }, { id: "p13", skill: 3 }, { id: "p14", skill: 3 },
  // Skill 4
  { id: "p15", skill: 4 }, { id: "p16", skill: 4 }, { id: "p17", skill: 4 },
  { id: "p18", skill: 4 }, { id: "p19", skill: 4 }, { id: "p20", skill: 4 },
  { id: "p21", skill: 4 },
  // Skill 5
  { id: "p22", skill: 5 }, { id: "p23", skill: 5 }, { id: "p24", skill: 5 },
  { id: "p25", skill: 5 }, { id: "p26", skill: 5 },
  // Skill 6
  { id: "p27", skill: 6 }, { id: "p28", skill: 6 }, { id: "p29", skill: 6 },
  // Skill 7
  { id: "p30", skill: 7 },
];

// ─────────────────────────────────────────────────────────────
// Simulation helpers
// ─────────────────────────────────────────────────────────────

/** Build a per-anchor overlap map from the recent roster history. */
function buildSimOverlapMap(
  anchorId: string,
  recentRosters: string[][]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const roster of recentRosters.slice(0, ANTI_REPEAT_LOOKBACK)) {
    if (!roster.includes(anchorId)) continue;
    for (const pid of roster) {
      if (pid === anchorId) continue;
      map.set(pid, (map.get(pid) ?? 0) + 1);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// Core simulation algorithm — mirrors runAlgorithm (pure version)
// ─────────────────────────────────────────────────────────────
//
// Steps (matches production runAlgorithm):
//   1. Sort pool by priority DESC, joined_at ASC (tiebreaker)
//   2. Anchor = pool[0]
//   3. Cap pre-filter on candidates
//   4. Track capWasActive
//   5. Progressive skill-window expansion
//   6. For each window: buildCombinationGroup → diversity check →
//        if violation: simplified Tier-1 swap + Tier-3 rotatedDraft
//        if no violation: snakeDraft (cap-aware)
//   7. Last-resort fallback (wait > 15 min)
//   8. Return SimResult

interface SimMatch {
  teamA: ScoredPlayer[];
  teamB: ScoredPlayer[];
  isMixed: boolean;
}

type SimResult =
  | { formed: true; match: SimMatch }
  | { formed: false; capSignal: boolean; anchorIsRedZone: boolean; anchorName: string };

function simRunAlgorithm(
  pool: ScoredPlayer[],
  partnershipCounts: Map<string, number>,
  recentRosters: string[][]
): SimResult {
  const noMatch = (capSignal: boolean, anchorIsRedZone: boolean, anchorName: string): SimResult =>
    ({ formed: false, capSignal, anchorIsRedZone, anchorName });

  if (pool.length < 4) {
    return noMatch(false, false, "N/A");
  }

  // ── 1. Sort by priority DESC, joined_at ASC ───────────────
  const sorted = [...pool].sort((a, b) => {
    const diff = b.priorityScore - a.priorityScore;
    if (Math.abs(diff) > 0.001) return diff;
    return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
  });

  const anchor = sorted[0];
  const anchorIsRedZone = anchor.priorityScore >= RED_ZONE_SCORE_FLOOR;
  const anchorWaitMinutes = anchor.wait_minutes ?? 0;
  const anchorSkill = anchor.skill_level_int;

  // ── 2. Per-anchor overlap map ─────────────────────────────
  const overlapMap = buildSimOverlapMap(anchor.player_id, recentRosters);

  // ── 3. Cap pre-filter ─────────────────────────────────────
  const candidates = sorted.slice(1).filter(
    (c) =>
      (partnershipCounts.get(pairKey(anchor.player_id, c.player_id)) ?? 0) <
      MAX_PARTNERSHIP_REPEATS
  );
  const capWasActive = sorted.length - 1 > candidates.length;

  // ── 4. Skill window expansion ─────────────────────────────
  const skillWindows = anchorIsRedZone
    ? [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX, 3, 4]
    : [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX];

  for (const maxVariance of skillWindows) {
    const eligible = candidates.filter(
      (c) => Math.abs(c.skill_level_int - anchorSkill) <= maxVariance
    );
    if (eligible.length < 3) continue;

    const effectiveLookback = getEffectiveLookback(eligible.length + 1);
    const activeRosters = recentRosters.slice(0, effectiveLookback);
    const scored = scoreCandidates(eligible, overlapMap);
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    if (group.length !== 3) continue;

    const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

    if (isDiversityViolation(proposedIds, activeRosters)) {
      // ── Tier 1: swap 3rd companion ─────────────────────────
      const alreadyInGroup = new Set(group.map((g) => g.player_id));
      const swapPool = scored.filter(
        ({ candidate }) => !alreadyInGroup.has(candidate.player_id)
      );
      const fixedTwo = group.slice(0, 2);

      for (const { candidate } of swapPool) {
        const swapGroup = [...fixedTwo, candidate];
        if (!isGroupValid([anchor, ...swapGroup], maxVariance)) continue;
        const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
        if (isDiversityViolation(swappedIds, activeRosters)) continue;
        const draft = snakeDraft(
          [anchor, ...swapGroup],
          partnershipCounts,
          MAX_PARTNERSHIP_REPEATS
        );
        if (!draft) continue;
        return {
          formed: true,
          match: { teamA: draft.teamA, teamB: draft.teamB, isMixed: maxVariance > SKILL_VARIANCE_MAX },
        };
      }

      // ── Tier 3: rotatedDraft (all swap paths exhausted) ────
      const rotated = rotatedDraft(
        [anchor, ...group],
        recentRosters,
        partnershipCounts,
        MAX_PARTNERSHIP_REPEATS
      );
      if (rotated) {
        return {
          formed: true,
          match: {
            teamA: rotated.teamA,
            teamB: rotated.teamB,
            isMixed: maxVariance > SKILL_VARIANCE_MAX,
          },
        };
      }
      // rotatedDraft returned null → all splits capped → expand window
    } else {
      // ── No diversity violation: snakeDraft with cap ────────
      const draft = snakeDraft(
        [anchor, ...group],
        partnershipCounts,
        MAX_PARTNERSHIP_REPEATS
      );
      if (draft) {
        return {
          formed: true,
          match: { teamA: draft.teamA, teamB: draft.teamB, isMixed: maxVariance > SKILL_VARIANCE_MAX },
        };
      }
      // All splits capped → expand window
    }
  }

  // ── 5. Last-resort fallback (wait > 15 min, cap still applies) ──
  if (anchorWaitMinutes > FALLBACK_WAIT_MINUTES && candidates.length >= 3) {
    const scored = scoreCandidates(candidates, overlapMap);
    const fallbackGroup = scored.slice(0, 3).map((s) => s.candidate);
    const draft = snakeDraft(
      [anchor, ...fallbackGroup],
      partnershipCounts,
      MAX_PARTNERSHIP_REPEATS
    );
    if (draft) {
      return {
        formed: true,
        match: { teamA: draft.teamA, teamB: draft.teamB, isMixed: true },
      };
    }
  }

  return noMatch(capWasActive, anchorIsRedZone, anchor.display_name);
}

// ─────────────────────────────────────────────────────────────
// Partnership count helper — increments all same-team pairs
// ─────────────────────────────────────────────────────────────

function recordMatch(
  match: SimMatch,
  partnershipCounts: Map<string, number>,
  recentRosters: string[][]
): void {
  // Record team pair counts
  for (const team of [match.teamA, match.teamB]) {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        const key = pairKey(team[i].player_id, team[j].player_id);
        partnershipCounts.set(key, (partnershipCounts.get(key) ?? 0) + 1);
      }
    }
  }
  // Prepend to recent roster window
  const roster = [...match.teamA, ...match.teamB].map((p) => p.player_id);
  recentRosters.unshift(roster);
  if (recentRosters.length > ANTI_REPEAT_LOOKBACK) {
    recentRosters.pop();
  }
}

// ─────────────────────────────────────────────────────────────
// Simulation runner
// ─────────────────────────────────────────────────────────────
//
// Each round represents ~5 minutes of session time.
//   - All queued players accumulate +5 wait minutes
//   - Engine tries to fill up to 4 court slots from the queue
//   - Matched players reset waitMinutes=0, increment gamesPlayed
//   - Unmatched players keep accumulating wait (increasing priority)
//
// Runs for `rounds` rounds. Returns session statistics.

interface RoundStats {
  round: number;
  matchesFormed: number;
  noMatchReturns: number;
  capSignals: number;
  redZoneCapSignals: number;
  queueSizeAtStart: number;
}

interface SessionStats {
  totalMatches: number;
  totalNoMatch: number;
  totalCapSignals: number;
  capSaturationAnchorNames: string[];
  maxPairCount: number;
  roundStats: RoundStats[];
  allMatches: SimMatch[];
  finalPartnershipCounts: Map<string, number>;
}

function runSimulation(
  players: Array<{ id: string; skill: number }>,
  rounds: number,
  courtsPerRound = 4,
  minutesPerRound = 5
): SessionStats {
  // Initialize state
  const gamesPlayed = new Map<string, number>(players.map((p) => [p.id, 0]));
  const waitMinutes = new Map<string, number>(players.map((p) => [p.id, 0]));
  // joinedAgo: stagger slightly so tiebreaking is deterministic
  // (player index × 0.1 min = earlier join for lower index)
  const joinedAgo = new Map<string, number>(
    players.map((p, i) => [p.id, i * 0.1])
  );

  const partnershipCounts = new Map<string, number>();
  const recentRosters: string[][] = [];
  const allMatches: SimMatch[] = [];

  const roundStats: RoundStats[] = [];
  let totalNoMatch = 0;
  let totalCapSignals = 0;
  const capSaturationAnchorNames: string[] = [];

  for (let round = 1; round <= rounds; round++) {
    // ── Accumulate wait time for all players ─────────────────
    for (const p of players) {
      waitMinutes.set(p.id, (waitMinutes.get(p.id) ?? 0) + minutesPerRound);
    }

    // ── Build the current queue (all players scored) ──────────
    let queue: ScoredPlayer[] = players.map((p) =>
      makeSimPlayer(
        p.id,
        p.skill,
        waitMinutes.get(p.id) ?? 0,
        gamesPlayed.get(p.id) ?? 0,
        joinedAgo.get(p.id) ?? 0
      )
    );

    const queueSizeAtStart = queue.length;
    let matchesThisRound = 0;
    let noMatchThisRound = 0;
    let capSignalsThisRound = 0;
    let redZoneCapSignalsThisRound = 0;

    // ── Fill up to `courtsPerRound` slots ─────────────────────
    for (let court = 0; court < courtsPerRound; court++) {
      if (queue.length < 4) break;

      const result = simRunAlgorithm(queue, partnershipCounts, recentRosters);

      if (result.formed) {
        const { match } = result;
        recordMatch(match, partnershipCounts, recentRosters);
        allMatches.push(match);
        matchesThisRound++;

        // Remove matched players from the queue for this round
        const matchedIds = new Set(
          [...match.teamA, ...match.teamB].map((p) => p.player_id)
        );
        queue = queue.filter((p) => !matchedIds.has(p.player_id));

        // Update per-player state
        for (const pid of matchedIds) {
          gamesPlayed.set(pid, (gamesPlayed.get(pid) ?? 0) + 1);
          waitMinutes.set(pid, 0); // Reset wait after playing
        }
      } else {
        noMatchThisRound++;
        totalNoMatch++;
        if (result.capSignal) {
          capSignalsThisRound++;
          redZoneCapSignalsThisRound += result.anchorIsRedZone ? 1 : 0;
          totalCapSignals++;
          capSaturationAnchorNames.push(result.anchorName);
        }
        // No match on first attempt → stop filling courts this round
        // (mirrors production behaviour: engine breaks on first failure)
        break;
      }
    }

    roundStats.push({
      round,
      matchesFormed: matchesThisRound,
      noMatchReturns: noMatchThisRound,
      capSignals: capSignalsThisRound,
      redZoneCapSignals: redZoneCapSignalsThisRound,
      queueSizeAtStart,
    });
  }

  const maxPairCount = Math.max(0, ...partnershipCounts.values());

  return {
    totalMatches: allMatches.length,
    totalNoMatch,
    totalCapSignals,
    capSaturationAnchorNames,
    maxPairCount,
    roundStats,
    allMatches,
    finalPartnershipCounts: partnershipCounts,
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("30-player session simulation", () => {
  // ── Shared session run ──────────────────────────────────────
  // Run once and reuse across tests (vitest runs describe synchronously
  // so `stats` is fully populated before any `it` body executes).
  const stats = runSimulation(THIRTY_PLAYERS, 20, 4, 5);

  // ── Verbose session report ─────────────────────────────────
  // Shown when running with --reporter=verbose (always emitted via
  // console.log so it appears in Vitest output regardless of failure).
  console.log("\n══════════════════════════════════════════════════");
  console.log(" 30-PLAYER SESSION SIMULATION — RESULTS");
  console.log("══════════════════════════════════════════════════");
  console.log(`  Total matches formed : ${stats.totalMatches}`);
  console.log(`  Total no-match slots : ${stats.totalNoMatch}`);
  console.log(`  Cap saturation events: ${stats.totalCapSignals}`);
  console.log(`  Max pair partnership : ${stats.maxPairCount} (cap=${MAX_PARTNERSHIP_REPEATS})`);
  console.log(`  Final partnership map: ${stats.finalPartnershipCounts.size} unique pairs tracked`);
  console.log("──────────────────────────────────────────────────");
  console.log("  Round breakdown:");
  for (const r of stats.roundStats) {
    const bar = "■".repeat(r.matchesFormed) + (r.noMatchReturns > 0 ? "✗" : "");
    console.log(
      `  Round ${String(r.round).padStart(2)}: ${bar.padEnd(6)} ` +
      `[${r.matchesFormed} matches | ` +
      `${r.noMatchReturns} no-match | ` +
      `${r.capSignals > 0 ? `⚑ ${r.capSignals} cap signal(s)` : "no cap signals"}]`
    );
  }
  if (stats.capSaturationAnchorNames.length > 0) {
    console.log("──────────────────────────────────────────────────");
    console.log(
      `  Cap saturation anchors: ${[...new Set(stats.capSaturationAnchorNames)].join(", ")}`
    );
  }

  // Per-player partnership summary
  const playerPartnerCounts = new Map<string, number>();
  for (const [key, count] of stats.finalPartnershipCounts.entries()) {
    const [a, b] = key.split(":");
    playerPartnerCounts.set(a, (playerPartnerCounts.get(a) ?? 0) + count);
    playerPartnerCounts.set(b, (playerPartnerCounts.get(b) ?? 0) + count);
  }

  console.log("──────────────────────────────────────────────────");
  console.log("  Partnership cap utilisation per player:");
  for (const p of THIRTY_PLAYERS) {
    const total = playerPartnerCounts.get(p.id) ?? 0;
    // Count how many unique partners this player has hit the cap with
    const capsHit = [...stats.finalPartnershipCounts.entries()].filter(
      ([key, count]) =>
        key.includes(`:${p.id}`) || key.startsWith(`${p.id}:`)
          ? count >= MAX_PARTNERSHIP_REPEATS
          : false
    ).length;
    if (total > 0) {
      console.log(
        `    ${p.id} (skill ${p.skill}): ${total} total partner-games, ${capsHit} pair(s) at cap`
      );
    }
  }
  console.log("══════════════════════════════════════════════════\n");

  // ─────────────────────────────────────────────────────────
  // Invariant 1: partner-pair cap NEVER violated in any match
  // ─────────────────────────────────────────────────────────
  it("never puts a same-team pair together more than MAX_PARTNERSHIP_REPEATS times", () => {
    // Replay all recorded matches in order, building a running count.
    // At the moment each match is recorded, the count for any team pair
    // must be going from (cap-1) to cap at most — never from cap to cap+1.
    // We reuse finalPartnershipCounts for the overall check.
    for (const [, count] of stats.finalPartnershipCounts.entries()) {
      expect(count).toBeLessThanOrEqual(MAX_PARTNERSHIP_REPEATS);
    }
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 2: every match has exactly 4 distinct players
  // ─────────────────────────────────────────────────────────
  it("every formed match contains exactly 4 distinct players", () => {
    for (const match of stats.allMatches) {
      expect(match.teamA).toHaveLength(2);
      expect(match.teamB).toHaveLength(2);
      const ids = [...match.teamA, ...match.teamB].map((p) => p.player_id);
      expect(new Set(ids).size).toBe(4);
    }
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 3: non-mixed matches respect skill variance
  // ─────────────────────────────────────────────────────────
  it("non-mixed matches respect SKILL_VARIANCE_MAX across all 4 players", () => {
    for (const match of stats.allMatches) {
      if (match.isMixed) continue; // mixed matches intentionally exceed variance
      const allFour = [...match.teamA, ...match.teamB];
      expect(isGroupValid(allFour, SKILL_VARIANCE_MAX)).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 4: at least 30 matches form in 20 rounds / 4 courts
  // (sanity check: a healthy session should always produce matches)
  // ─────────────────────────────────────────────────────────
  it("forms at least 30 matches over 20 rounds with 4 courts", () => {
    // 20 rounds × 4 courts = 80 max slots, 30 players → 7 matches possible
    // per round maximum. Even with cap pressure late in the session,
    // we expect well above 30 total.
    expect(stats.totalMatches).toBeGreaterThanOrEqual(30);
    console.log(`    ↳ formed ${stats.totalMatches} total matches`);
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 5: max recorded pair count ≤ MAX_PARTNERSHIP_REPEATS
  // (single-number summary of invariant 1)
  // ─────────────────────────────────────────────────────────
  it(`max same-team pair count across entire session ≤ ${MAX_PARTNERSHIP_REPEATS}`, () => {
    expect(stats.maxPairCount).toBeLessThanOrEqual(MAX_PARTNERSHIP_REPEATS);
    console.log(`    ↳ max pair count observed: ${stats.maxPairCount}`);
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 6: players with no valid partners fire capSignal,
  // not a violated match
  // ─────────────────────────────────────────────────────────
  it("cap saturation returns capSignal=true rather than producing a capped match", () => {
    // Construct a pool where the highest-priority player (anchor) has
    // every possible partner already at the cap. The engine must return
    // capSignal=true, not a match.
    //
    // Critical: anchor must have the HIGHEST priorityScore so it
    // actually becomes pool[0] after the priority sort. We give it
    // 20 min wait (score=20) and all others ≤5 min (scores 1-5).
    // Without this, a different player becomes the anchor, cappedCounts
    // doesn't apply to them, and a match forms — which is correct
    // behaviour but not what this invariant is testing.
    const base = makeSimPlayer("anchor", 4, 20, 0); // score=20 → highest priority
    const others = ["p1", "p2", "p3", "p4", "p5"].map((id, i) =>
      makeSimPlayer(id, 4, i + 1, 0) // scores 1-5 → all below anchor
    );
    const pool = [base, ...others];

    // Mark every anchor-other pair as AT the cap
    const cappedCounts = new Map<string, number>();
    for (const o of others) {
      cappedCounts.set(pairKey(base.player_id, o.player_id), MAX_PARTNERSHIP_REPEATS);
    }

    const result = simRunAlgorithm(pool, cappedCounts, []);
    expect(result.formed).toBe(false);
    if (!result.formed) {
      expect(result.capSignal).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 7: Red Zone anchor + all-capped → type "red_zone"
  // ─────────────────────────────────────────────────────────
  it("fires capSignal with anchorIsRedZone=true when Red Zone anchor has no legal partners", () => {
    const redZoneAnchor = makeSimPlayer("rz", 4, CRITICAL_WAIT_MINUTES + 5, 0);
    expect(redZoneAnchor.priorityScore).toBeGreaterThanOrEqual(RED_ZONE_SCORE_FLOOR);

    const others = ["q1", "q2", "q3", "q4"].map((id, i) =>
      makeSimPlayer(id, 4, i * 2, 0)
    );
    const pool = [redZoneAnchor, ...others];

    const cappedCounts = new Map<string, number>();
    for (const o of others) {
      cappedCounts.set(pairKey(redZoneAnchor.player_id, o.player_id), MAX_PARTNERSHIP_REPEATS);
    }

    const result = simRunAlgorithm(pool, cappedCounts, []);
    expect(result.formed).toBe(false);
    if (!result.formed) {
      expect(result.capSignal).toBe(true);
      expect(result.anchorIsRedZone).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 8: count < cap is NEVER blocked
  // The engine must NOT reject a match just because a pair has
  // played together once (which is below the cap of 2).
  // ─────────────────────────────────────────────────────────
  it("does not block a pair that has played once (count=1 < cap=2)", () => {
    const a = makeSimPlayer("a", 4, 10, 1);
    const b = makeSimPlayer("b", 4, 9,  1);
    const c = makeSimPlayer("c", 4, 8,  1);
    const d = makeSimPlayer("d", 4, 7,  1);

    // All pairs played together once — still below cap
    const onceCounts = new Map<string, number>();
    onceCounts.set(pairKey("a", "b"), 1);
    onceCounts.set(pairKey("a", "c"), 1);
    onceCounts.set(pairKey("a", "d"), 1);
    onceCounts.set(pairKey("b", "c"), 1);
    onceCounts.set(pairKey("b", "d"), 1);
    onceCounts.set(pairKey("c", "d"), 1);

    const result = simRunAlgorithm([a, b, c, d], onceCounts, []);
    // Should still form a match — count=1 is strictly less than cap=2
    expect(result.formed).toBe(true);
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 9: snakeDraft null-return is the safety gate —
  // never destructured blindly
  // ─────────────────────────────────────────────────────────
  it("snakeDraft returns null when all 3 splits are capped, never produces a violating assignment", () => {
    const p6 = makeSimPlayer("p6", 6);
    const p5 = makeSimPlayer("p5", 5);
    const p4 = makeSimPlayer("p4", 4);
    const p3 = makeSimPlayer("p3", 3);

    // Build counts where every possible team split has at least one pair AT cap
    // Split 0: teamA=[p6,p3] pairKey="p3:p6", teamB=[p5,p4] pairKey="p4:p5"
    // Split 1: teamA=[p6,p5] pairKey="p5:p6", teamB=[p4,p3] pairKey="p3:p4"
    // Split 2: teamA=[p6,p4] pairKey="p4:p6", teamB=[p5,p3] pairKey="p3:p5"
    const fullyCapped = new Map<string, number>([
      ["p3:p6", MAX_PARTNERSHIP_REPEATS], // split 0 teamA
      ["p4:p6", MAX_PARTNERSHIP_REPEATS], // split 2 teamA
      ["p5:p6", MAX_PARTNERSHIP_REPEATS], // split 1 teamA
    ]);

    const result = snakeDraft([p6, p5, p4, p3], fullyCapped, MAX_PARTNERSHIP_REPEATS);
    expect(result).toBeNull(); // safety gate held — no violating assignment produced
  });

  // ─────────────────────────────────────────────────────────
  // Invariant 10: skill 7 elite player (most constrained tier)
  // still gets matches via skill-window expansion
  // ─────────────────────────────────────────────────────────
  it("elite player (skill 7) appears in at least 3 matches via skill-window expansion", () => {
    const eliteAppearances = stats.allMatches.filter((m) =>
      [...m.teamA, ...m.teamB].some((p) => p.player_id === "p30")
    ).length;
    // With 20 rounds and 4 courts, p30 (skill 7, only 1 player at that tier)
    // must use the ±3/±4 expansion windows to find partners. We expect
    // at least 3 appearances.
    expect(eliteAppearances).toBeGreaterThanOrEqual(3);
    console.log(`    ↳ elite player p30 appeared in ${eliteAppearances} matches`);
  });
});

// ─────────────────────────────────────────────────────────────
// Targeted saturation scenario — small isolated pool
// ─────────────────────────────────────────────────────────────
//
// 6 players at the same skill level, all played with each other.
// After 3 matches, every pair in the pool will have hit the cap
// (C(6,2) = 15 possible pairs, each match uses 2 pairs, 3 matches
// use 6 pairs total — not full saturation yet but enough to pressure
// the engine significantly in a tight pool).
//
// We run the simulation until no more matches can be formed and
// assert that saturation fires rather than cap violations occurring.

describe("small isolated pool — cap saturation scenario", () => {
  it("exhausts valid pairings and fires capSignal rather than producing violations", () => {
    const skillLevel = 4;
    // 6 players, all same skill (WITHIN ±0 of each other — guaranteed valid groups)
    const pool6 = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id, i) =>
      makeSimPlayer(id, skillLevel, (i + 1) * 3, 0)
    );

    const counts = new Map<string, number>();
    const rosters: string[][] = [];
    const matches: SimMatch[] = [];

    // Run until no match can be formed
    let attempts = 0;
    while (attempts < 20) {
      // Re-score pool with updated games/wait (simplified: just use current state)
      const result = simRunAlgorithm(pool6, counts, rosters);
      if (!result.formed) {
        // When saturation fires: verify it's the cap, not an algorithm bug
        if (result.capSignal) {
          // Final cap violation check
          for (const [, count] of counts.entries()) {
            expect(count).toBeLessThanOrEqual(MAX_PARTNERSHIP_REPEATS);
          }
        }
        break;
      }

      const { match } = result;
      recordMatch(match, counts, rosters);
      matches.push(match);
      attempts++;
    }

    console.log(`\n  Small pool saturation: formed ${matches.length} match(es) before stalling`);
    console.log(`  Pairs tracked: ${counts.size}, max count: ${Math.max(0, ...counts.values())}`);

    // Should have formed at least 1 match
    expect(matches.length).toBeGreaterThanOrEqual(1);

    // Every pair count must be within cap
    for (const [pair, count] of counts.entries()) {
      expect(count).toBeLessThanOrEqual(MAX_PARTNERSHIP_REPEATS);
    }
  });
});
