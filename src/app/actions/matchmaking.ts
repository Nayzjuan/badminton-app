"use server";

// ============================================================
// Matchmaking Algorithm — Server Action
// ============================================================
// Triggered when the Organizer clicks "Call Next Match" for an
// available court. Implements the full matchmaking flow:
//
//   1. Fetch the waiting pool
//   2. Sort by games_played ASC, then wait time DESC
//   3. Iterate seed candidates from top of queue
//   4. For each seed, find 3 compatible players (skill ±1, expand ±2)
//   5. Apply anti-repeat deprioritization
//   6. Balance teams (highest+lowest vs middle two)
//   7. Skip seed if incompatible (bottleneck rule)
//   8. Execute all DB updates atomically
//
// Returns { success, matchId?, message } for UI feedback.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  PLAYERS_PER_MATCH,
  ANTI_REPEAT_LOOKBACK,
} from "@/lib/constants";
import { skillLevelToInt } from "@/types/database";
import type { QueueWithWaitTime, RecentPairing } from "@/types/database";

export interface MatchmakingResult {
  success: boolean;
  matchId?: string;
  message: string;
  /** Names of matched players for the toast notification. */
  teamA?: string[];
  teamB?: string[];
}

export async function callNextMatch(
  sessionId: string,
  courtId: string
): Promise<MatchmakingResult> {
  const supabase = await createClient();

  // ----------------------------------------------------------
  // 1. FETCH THE POOL — all "waiting" players for this session
  // ----------------------------------------------------------
  const { data: pool, error: poolError } = await supabase
    .from("v_queue_with_wait_time")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .order("games_played", { ascending: true })
    .order("joined_at", { ascending: true });

  if (poolError) {
    return { success: false, message: `Failed to fetch queue: ${poolError.message}` };
  }

  if (!pool || pool.length < PLAYERS_PER_MATCH) {
    return {
      success: false,
      message: `Not enough players in queue. Need ${PLAYERS_PER_MATCH}, have ${pool?.length ?? 0}.`,
    };
  }

  // ----------------------------------------------------------
  // 2. FETCH RECENT PAIRINGS for anti-repeat logic
  // ----------------------------------------------------------
  const { data: recentPairings } = await supabase
    .from("v_recent_pairings")
    .select("*")
    .eq("session_id", sessionId)
    .order("completed_at", { ascending: false });

  const pairings = recentPairings ?? [];

  // ----------------------------------------------------------
  // 3. ITERATE SEED CANDIDATES
  // ----------------------------------------------------------
  // Pool is already sorted by priority (fewest games, then longest wait).
  // Try each as a potential seed; skip if no valid group can be formed.

  for (let seedIdx = 0; seedIdx < pool.length; seedIdx++) {
    const seed = pool[seedIdx];
    const seedSkill = seed.skill_level_int;

    // Build the candidate list (everyone except the seed).
    const candidates = pool.filter((_, i) => i !== seedIdx);

    // ----------------------------------------------------------
    // 4. FIND 3 COMPATIBLE PLAYERS
    // ----------------------------------------------------------
    const group = findCompatibleGroup(seed, candidates, seedSkill, pairings);

    if (!group) {
      // Bottleneck skip: this seed can't be matched. Try next.
      continue;
    }

    // ----------------------------------------------------------
    // 5. TEAM BALANCING
    // ----------------------------------------------------------
    // Sort all 4 by skill level. Pair highest+lowest (Team A),
    // middle two (Team B) for balanced games.
    const allFour = [seed, ...group];
    allFour.sort((a, b) => a.skill_level_int - b.skill_level_int);

    const teamA = [allFour[0], allFour[3]]; // lowest + highest
    const teamB = [allFour[1], allFour[2]]; // middle two

    // ----------------------------------------------------------
    // 6. EXECUTE DATABASE UPDATES
    // ----------------------------------------------------------
    const result = await executeMatch(
      supabase,
      sessionId,
      courtId,
      teamA,
      teamB
    );

    return result;
  }

  // ----------------------------------------------------------
  // 7. NO VALID MATCH FOUND (all seeds exhausted)
  // ----------------------------------------------------------
  return {
    success: false,
    message:
      "No compatible match could be formed. Skill levels in the queue are too spread out. " +
      "Check the Wait Time Monitor for players needing manual intervention.",
  };
}

// ============================================================
// HELPER: Find 3 compatible players for a seed
// ============================================================
// Two-pass approach:
//   Pass 1: Try ±1 skill variance (target)
//   Pass 2: Expand to ±2 skill variance (maximum)
// Within each pass, candidates are scored to deprioritize
// recent pairings with the seed.

function findCompatibleGroup(
  seed: QueueWithWaitTime,
  candidates: QueueWithWaitTime[],
  seedSkill: number,
  pairings: RecentPairing[]
): QueueWithWaitTime[] | null {
  const needed = PLAYERS_PER_MATCH - 1; // 3

  // Try target variance first, then expand.
  for (const maxVariance of [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX]) {
    // Filter by skill constraint.
    const eligible = candidates.filter((c) => {
      const diff = Math.abs(c.skill_level_int - seedSkill);
      return diff <= maxVariance;
    });

    if (eligible.length < needed) continue;

    // Score each candidate: lower = better.
    // Base score preserves original queue order (priority).
    // Penalty for recent pairings with the seed.
    const scored = eligible.map((candidate, queueIndex) => {
      let penaltyScore = 0;

      // Check how recently this candidate played with/against the seed.
      const relevantPairings = pairings.filter(
        (p) =>
          (p.player_a === seed.player_id && p.player_b === candidate.player_id) ||
          (p.player_b === seed.player_id && p.player_a === candidate.player_id)
      );

      // Penalize based on recency — the most recent pairings get
      // the highest penalty. We look at the last N matches.
      const recentN = relevantPairings.slice(0, ANTI_REPEAT_LOOKBACK);
      for (let i = 0; i < recentN.length; i++) {
        // Most recent pairing = highest penalty.
        // Penalty decreases with age: 1000 for most recent, 500 for next, etc.
        penaltyScore += 1000 / (i + 1);
      }

      return {
        candidate,
        score: queueIndex + penaltyScore,
      };
    });

    // Sort by score (lowest = best fit).
    scored.sort((a, b) => a.score - b.score);

    // Take the top 3.
    const selected = scored.slice(0, needed).map((s) => s.candidate);

    // Verify: all 4 players (seed + 3) must be within the max variance
    // of EACH OTHER, not just the seed. This ensures fair matches.
    if (isGroupValid(seed, selected, maxVariance)) {
      return selected;
    }
  }

  return null; // No valid group found for this seed.
}

// ============================================================
// HELPER: Validate that all 4 players are within skill variance
// ============================================================
function isGroupValid(
  seed: QueueWithWaitTime,
  group: QueueWithWaitTime[],
  maxVariance: number
): boolean {
  const all = [seed, ...group];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const diff = Math.abs(all[i].skill_level_int - all[j].skill_level_int);
      if (diff > maxVariance) return false;
    }
  }
  return true;
}

// ============================================================
// HELPER: Execute all DB updates for a formed match
// ============================================================
async function executeMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string,
  teamA: QueueWithWaitTime[],
  teamB: QueueWithWaitTime[]
): Promise<MatchmakingResult> {
  // 1. Create the match.
  const { data: match, error: matchError } = await supabase
    .from("matches")
    .insert({
      session_id: sessionId,
      court_id: courtId,
      status: "in_progress" as const,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (matchError || !match) {
    return {
      success: false,
      message: `Failed to create match: ${matchError?.message ?? "Unknown error"}`,
    };
  }

  // 2. Insert match_players.
  const playerRows = [
    ...teamA.map((p) => ({
      match_id: match.id,
      player_id: p.player_id,
      team: "a" as const,
    })),
    ...teamB.map((p) => ({
      match_id: match.id,
      player_id: p.player_id,
      team: "b" as const,
    })),
  ];

  const { error: playersError } = await supabase
    .from("match_players")
    .insert(playerRows);

  if (playersError) {
    // Rollback the match if player insert fails.
    await supabase.from("matches").delete().eq("id", match.id);
    return {
      success: false,
      message: `Failed to assign players: ${playersError.message}`,
    };
  }

  // 3. Update court status to in_use.
  const { error: courtError } = await supabase
    .from("courts")
    .update({ status: "in_use" as const })
    .eq("id", courtId);

  if (courtError) {
    return {
      success: false,
      message: `Match created but failed to update court: ${courtError.message}`,
    };
  }

  // 4. Update queue entries for all 4 players to "playing".
  const allPlayerIds = [...teamA, ...teamB].map((p) => p.player_id);
  await supabase
    .from("queue_entries")
    .update({ status: "playing" as const })
    .eq("session_id", sessionId)
    .in("player_id", allPlayerIds);

  // 5. Return success with player names for the UI toast.
  return {
    success: true,
    matchId: match.id,
    message: "Match created successfully!",
    teamA: teamA.map((p) => p.display_name),
    teamB: teamB.map((p) => p.display_name),
  };
}
