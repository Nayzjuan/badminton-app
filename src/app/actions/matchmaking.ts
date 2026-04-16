"use server";

// ============================================================
// Enterprise Matchmaking Engine — Server Actions
// ============================================================
//
// Algorithm overview
// ------------------
//   1. Fetch pool sorted by (games_played ASC, joined_at ASC).
//   2. Anchor = pool[0] — the player who's waited longest at
//      the fewest games.
//   3. Build an overlap map: for each candidate, count how many
//      past matches they've shared with the anchor today.
//   4. Score candidates: lowest overlap → fewest games → longest
//      wait (encoded as pool index).
//   5. Progressive skill expansion:
//        a. ±1 window first
//        b. ±2 window if ±1 fails
//   6. Time-based fallback: if anchor has waited > 15 min,
//      bypass skill windows entirely, grab next 3, set
//      is_mixed_level = true.
//   7. Snake-draft team balancing: sort all 4 DESC by skill,
//      Team A = [highest + lowest], Team B = [2nd + 3rd].
//
// Public surface:
//   callNextMatch(sessionId, courtId)
//   generateOnDeckMatchesAction(sessionId)
//
// Internal:
//   runAlgorithm(supabase, sessionId, courtId | null, isOnDeck)
//   buildOverlapMap(supabase, sessionId, anchorPlayerId)
//   createOneOnDeckMatch(supabase, sessionId)
//   generateOnDeckMatchesInternal(supabase, sessionId)
//   promoteOnDeckMatchInternal(supabase, sessionId, courtId)
//   executeMatch(supabase, sessionId, courtId | null, teamA, teamB, isMixedLevel)
// ============================================================

import { createClient } from "@/utils/supabase/server";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  PLAYERS_PER_MATCH,
  FALLBACK_WAIT_MINUTES,
  ANTI_REPEAT_LOOKBACK,
} from "@/lib/constants";
import { skillLevelToInt } from "@/types/database";
import type { QueueWithWaitTime } from "@/types/database";

export interface MatchmakingResult {
  success: boolean;
  matchId?: string;
  message: string;
  /** Names of matched players for the toast notification. */
  teamA?: string[];
  teamB?: string[];
  /** True when the time-based fallback was triggered. */
  isMixedLevel?: boolean;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: callNextMatch
// ─────────────────────────────────────────────────────────────

export async function callNextMatch(
  sessionId: string,
  courtId: string
): Promise<MatchmakingResult> {
  const supabase = await createClient();

  // Try to promote a manually-created on-deck match first.
  // Auto-generation of on-deck matches is disabled — organizers
  // control the on-deck queue manually via "Create Match" in the
  // Queue & Match Control tab.
  const promoted = await promoteOnDeckMatchInternal(supabase, sessionId, courtId);
  if (promoted.success) {
    return promoted;
  }

  // No on-deck match available — run the algorithm and place
  // players directly onto the court (in_progress).
  return runAlgorithm(supabase, sessionId, courtId, false);
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: generateOnDeckMatchesAction (DEPRECATED — no-op)
// ─────────────────────────────────────────────────────────────
// PUBLIC: generateOnDeckMatchesAction
// ─────────────────────────────────────────────────────────────
// Manual trigger — organizer clicks "Generate" in OnDeckPanel.
// Auto-triggering (after endMatch / callNextMatch) is disabled;
// this only runs when the organizer explicitly requests it.

export async function generateOnDeckMatchesAction(sessionId: string): Promise<void> {
  const supabase = await createClient();
  await generateOnDeckMatchesInternal(supabase, sessionId);
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: generateOnDeckMatchesInternal
// ─────────────────────────────────────────────────────────────

async function generateOnDeckMatchesInternal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string
): Promise<void> {
  const { data: courts } = await supabase
    .from("courts")
    .select("id")
    .eq("session_id", sessionId)
    .neq("status", "closed");

  const courtCount = courts?.length ?? 0;
  if (courtCount === 0) return;

  const { count: existingCount } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "pending");

  const needed = Math.max(0, courtCount - (existingCount ?? 0));

  for (let i = 0; i < needed; i++) {
    const created = await createOneOnDeckMatch(supabase, sessionId);
    if (!created) break;
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: createOneOnDeckMatch
// ─────────────────────────────────────────────────────────────

async function createOneOnDeckMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string
): Promise<boolean> {
  const result = await runAlgorithm(supabase, sessionId, null, true);
  return result.success;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: promoteOnDeckMatchInternal
// ─────────────────────────────────────────────────────────────

export async function promoteOnDeckMatchInternal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string
): Promise<MatchmakingResult> {
  const { data: pending, error } = await supabase
    .from("matches")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error || !pending || pending.length === 0) {
    return { success: false, message: "No on-deck match available." };
  }

  const match = pending[0];
  const now = new Date().toISOString();

  // P0-2: Atomic compare-and-swap — add .eq("status", "pending") so that
  // if two courts free simultaneously and both call this function with the
  // same on-deck match, only the FIRST UPDATE wins. The second will affect
  // 0 rows (promotedMatch = null) and returns early, preventing the same
  // match from being assigned to two courts at once.
  const { data: promotedMatch, error: updateError } = await supabase
    .from("matches")
    .update({
      court_id: courtId,
      status: "in_progress" as const,
      started_at: now,
    })
    .eq("id", match.id)
    .eq("status", "pending")   // ← Atomic guard
    .select("id")
    .single();

  if (updateError || !promotedMatch) {
    if (!promotedMatch && !updateError) {
      // Another concurrent request already promoted this match — bail gracefully.
      console.warn("[matchmaking] promoteOnDeckMatch: match already promoted by concurrent request, skipping.");
      return { success: false, message: "On-deck match was already promoted by another request." };
    }
    return {
      success: false,
      message: `Failed to promote on-deck match: ${updateError?.message}`,
    };
  }

  await supabase
    .from("courts")
    .update({ status: "in_use" as const })
    .eq("id", courtId);

  const { data: matchPlayers } = await supabase
    .from("match_players")
    .select("player_id, team")
    .eq("match_id", match.id);

  if (matchPlayers && matchPlayers.length > 0) {
    const playerIds = matchPlayers.map((mp) => mp.player_id);
    await supabase
      .from("queue_entries")
      .update({ status: "playing" as const })
      .eq("session_id", sessionId)
      .in("player_id", playerIds);
  }

  const playerIds = (matchPlayers ?? []).map((mp) => mp.player_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", playerIds);

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));
  const teamANames = (matchPlayers ?? [])
    .filter((mp) => mp.team === "a")
    .map((mp) => profileMap.get(mp.player_id) ?? "Unknown");
  const teamBNames = (matchPlayers ?? [])
    .filter((mp) => mp.team === "b")
    .map((mp) => profileMap.get(mp.player_id) ?? "Unknown");

  return {
    success: true,
    matchId: match.id,
    message: "On-deck match promoted to court!",
    teamA: teamANames,
    teamB: teamBNames,
    isMixedLevel: match.is_mixed_level ?? false,
  };
}

// ─────────────────────────────────────────────────────────────
// CORE: runAlgorithm
// ─────────────────────────────────────────────────────────────
// Unified algorithm used by both on-deck generation and direct
// court assignment. The `isOnDeck` flag controls whether the
// created match is pending (no court) or in_progress.

async function runAlgorithm(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string | null,
  isOnDeck: boolean
): Promise<MatchmakingResult> {
  // ── 1. Fetch the waiting pool ─────────────────────────────
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

  // ── 2. Anchor = pool[0] ───────────────────────────────────
  const anchor = pool[0];
  const anchorSkill = anchor.skill_level_int;
  const anchorWaitMinutes =
    (Date.now() - new Date(anchor.joined_at).getTime()) / 60_000;

  console.log(
    `[matchmaking] anchor=${anchor.display_name} skill=${anchorSkill} ` +
    `wait=${anchorWaitMinutes.toFixed(1)}min pool=${pool.length}`
  );

  // ── 3. Build overlap map ──────────────────────────────────
  const overlapMap = await buildOverlapMap(supabase, sessionId, anchor.player_id);

  // ── 3b. Fetch recent match rosters for group-level diversity ─
  // Grab the last ANTI_REPEAT_LOOKBACK completed matches and
  // reconstruct the full 4-player roster for each, so we can
  // detect when ≥3 of a proposed group played together recently.
  const { data: recentMatchRows } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(ANTI_REPEAT_LOOKBACK);

  let recentRosters: string[][] = [];
  const recentMatchIds = (recentMatchRows ?? []).map((m) => m.id);
  if (recentMatchIds.length > 0) {
    const { data: recentPlayers } = await supabase
      .from("match_players")
      .select("match_id, player_id")
      .in("match_id", recentMatchIds);

    if (recentPlayers) {
      const rosterMap = new Map<string, string[]>();
      for (const row of recentPlayers) {
        const list = rosterMap.get(row.match_id) ?? [];
        list.push(row.player_id);
        rosterMap.set(row.match_id, list);
      }
      recentRosters = recentMatchIds
        .map((id) => rosterMap.get(id) ?? [])
        .filter((r) => r.length > 0);
    }
  }

  // Candidates = everyone except the anchor.
  const candidates = pool.slice(1);

  // ── 4. Time-based fallback ────────────────────────────────
  if (anchorWaitMinutes > FALLBACK_WAIT_MINUTES) {
    console.log(
      `[matchmaking] FALLBACK triggered — anchor waited ${anchorWaitMinutes.toFixed(1)}min > ${FALLBACK_WAIT_MINUTES}min`
    );

    // Grab the next 3 players regardless of skill.
    const fallbackGroup = candidates.slice(0, 3);
    if (fallbackGroup.length < 3) {
      return {
        success: false,
        message: "Not enough players for fallback match.",
      };
    }

    const allFour = [anchor, ...fallbackGroup];
    const { teamA, teamB } = snakeDraft(allFour);

    return executeMatch(supabase, sessionId, courtId, teamA, teamB, true, isOnDeck);
  }

  // ── 5. Progressive expansion ──────────────────────────────
  for (const maxVariance of [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX]) {
    const eligible = candidates.filter(
      (c) => Math.abs(c.skill_level_int - anchorSkill) <= maxVariance
    );

    if (eligible.length < 3) {
      console.log(
        `[matchmaking] ±${maxVariance} window: only ${eligible.length} eligible, need 3 — expanding`
      );
      continue;
    }

    // Score: overlap (primary) * 1_000_000 + poolIndex (tiebreaker).
    // poolIndex encodes games_played + joined_at since pool is pre-sorted.
    const scored = eligible.map((c) => {
      const poolIndex = pool.indexOf(c);
      const overlap = overlapMap.get(c.player_id) ?? 0;
      return {
        candidate: c,
        score: overlap * 1_000_000 + poolIndex,
      };
    });

    scored.sort((a, b) => a.score - b.score);

    // Greedy group building with cross-validation.
    const group: QueueWithWaitTime[] = [];
    for (const { candidate } of scored) {
      if (group.length >= 3) break;

      // Check that adding this candidate keeps ALL pairwise diffs ≤ maxVariance.
      const testGroup = [anchor, ...group, candidate];
      if (isGroupValid(testGroup, maxVariance)) {
        group.push(candidate);
      }
    }

    if (group.length === 3) {
      const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

      // ── Group-level diversity check ───────────────────────
      // If ≥3 of the 4 played together in any recent match,
      // try swapping the last (lowest-priority) group member
      // with the next eligible scored candidate.
      if (isDiversityViolation(proposedIds, recentRosters)) {
        console.log(
          `[matchmaking] Diversity violation detected for [${group.map((g) => g.display_name).join(", ")}] — attempting swap`
        );

        // Keep the top 2 companions; try replacing the 3rd.
        const fixedTwo = group.slice(0, 2);
        const alreadyInGroup = new Set(group.map((g) => g.player_id));
        const swapPool = scored.filter(
          ({ candidate }) => !alreadyInGroup.has(candidate.player_id)
        );

        let swapped = false;
        for (const { candidate } of swapPool) {
          const swapGroup = [...fixedTwo, candidate];
          if (!isGroupValid([anchor, ...swapGroup], maxVariance)) continue;

          const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
          if (!isDiversityViolation(swappedIds, recentRosters)) {
            console.log(`[matchmaking] Swap succeeded — replaced with ${candidate.display_name}`);
            const { teamA, teamB } = snakeDraft([anchor, ...swapGroup]);
            return executeMatch(supabase, sessionId, courtId, teamA, teamB, false, isOnDeck);
          }
        }

        // Critical fallback: pool too small / all alternatives also repeat.
        // Accept the repeat group — NEVER leave a court idle.
        if (!swapped) {
          console.warn("[matchmaking] No diverse swap found — accepting repeat group (critical fallback)");
        }
      }

      console.log(
        `[matchmaking] ±${maxVariance} window: matched [${group.map((g) => g.display_name).join(", ")}]`
      );
      const allFour = [anchor, ...group];
      const { teamA, teamB } = snakeDraft(allFour);
      return executeMatch(supabase, sessionId, courtId, teamA, teamB, false, isOnDeck);
    }

    console.log(
      `[matchmaking] ±${maxVariance} window: only built group of ${group.length} — expanding`
    );
  }

  return {
    success: false,
    message:
      "No compatible match could be formed. Skill levels in the queue are too spread out. " +
      "Check the Wait Time Monitor for players needing manual intervention.",
  };
}

// ─────────────────────────────────────────────────────────────
// HELPER: buildOverlapMap
// ─────────────────────────────────────────────────────────────
// Returns a Map<player_id, count> of how many completed matches
// each player has shared with the anchor in this session.

async function buildOverlapMap(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  anchorPlayerId: string
): Promise<Map<string, number>> {
  const overlapMap = new Map<string, number>();

  const { data: pairings, error } = await supabase
    .from("v_recent_pairings")
    .select("player_a, player_b")
    .eq("session_id", sessionId)
    .or(`player_a.eq.${anchorPlayerId},player_b.eq.${anchorPlayerId}`);

  if (error || !pairings) {
    console.warn("[matchmaking] buildOverlapMap failed:", error?.message);
    return overlapMap;
  }

  for (const row of pairings) {
    const otherPlayer =
      row.player_a === anchorPlayerId ? row.player_b : row.player_a;
    overlapMap.set(otherPlayer, (overlapMap.get(otherPlayer) ?? 0) + 1);
  }

  return overlapMap;
}

// ─────────────────────────────────────────────────────────────
// HELPER: overlapWithRoster
// ─────────────────────────────────────────────────────────────
// Counts how many of the given playerIds appear in a roster.

function overlapWithRoster(playerIds: string[], roster: string[]): number {
  const rosterSet = new Set(roster);
  return playerIds.filter((id) => rosterSet.has(id)).length;
}

// ─────────────────────────────────────────────────────────────
// HELPER: isDiversityViolation
// ─────────────────────────────────────────────────────────────
// Returns true if ≥3 of the proposed 4 player IDs appeared
// together in any single recent match roster.

function isDiversityViolation(
  playerIds: string[],
  recentRosters: string[][]
): boolean {
  for (const roster of recentRosters) {
    if (overlapWithRoster(playerIds, roster) >= 3) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// HELPER: isGroupValid
// ─────────────────────────────────────────────────────────────
// All pairwise skill diffs must be ≤ maxVariance.

function isGroupValid(
  players: QueueWithWaitTime[],
  maxVariance: number
): boolean {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (
        Math.abs(players[i].skill_level_int - players[j].skill_level_int) >
        maxVariance
      ) {
        return false;
      }
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// HELPER: snakeDraft
// ─────────────────────────────────────────────────────────────
// Sort all 4 DESC by skill, then:
//   Team A = [highest (pos 0) + lowest (pos 3)]
//   Team B = [2nd highest (pos 1) + 3rd highest (pos 2)]

function snakeDraft(allFour: QueueWithWaitTime[]): {
  teamA: QueueWithWaitTime[];
  teamB: QueueWithWaitTime[];
} {
  const sorted = [...allFour].sort(
    (a, b) => b.skill_level_int - a.skill_level_int
  );
  return {
    teamA: [sorted[0], sorted[3]],
    teamB: [sorted[1], sorted[2]],
  };
}

// ─────────────────────────────────────────────────────────────
// HELPER: executeMatch
// ─────────────────────────────────────────────────────────────
// Unified match creation — handles both on-deck (pending, null
// court_id) and direct (in_progress, real court_id).

async function executeMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string | null,
  teamA: QueueWithWaitTime[],
  teamB: QueueWithWaitTime[],
  isMixedLevel: boolean,
  isOnDeck: boolean
): Promise<MatchmakingResult> {
  const status = isOnDeck ? ("pending" as const) : ("in_progress" as const);
  const now = new Date().toISOString();

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .insert({
      session_id: sessionId,
      court_id: isOnDeck ? null : courtId,
      status,
      is_mixed_level: isMixedLevel,
      started_at: isOnDeck ? null : now,
    })
    .select()
    .single();

  if (matchError || !match) {
    return {
      success: false,
      message: `Failed to create match: ${matchError?.message ?? "Unknown error"}`,
    };
  }

  const playerRows = [
    ...teamA.map((p) => ({ match_id: match.id, player_id: p.player_id, team: "a" as const })),
    ...teamB.map((p) => ({ match_id: match.id, player_id: p.player_id, team: "b" as const })),
  ];

  const { error: playersError } = await supabase.from("match_players").insert(playerRows);

  if (playersError) {
    await supabase.from("matches").delete().eq("id", match.id);
    return {
      success: false,
      message: `Failed to assign players: ${playersError.message}`,
    };
  }

  // Update queue statuses + court status.
  const allPlayerIds = [...teamA, ...teamB].map((p) => p.player_id);
  const queueStatus = isOnDeck ? ("on_deck" as const) : ("playing" as const);

  await supabase
    .from("queue_entries")
    .update({ status: queueStatus })
    .eq("session_id", sessionId)
    .in("player_id", allPlayerIds);

  if (!isOnDeck && courtId) {
    await supabase
      .from("courts")
      .update({ status: "in_use" as const })
      .eq("id", courtId);
  }

  return {
    success: true,
    matchId: match.id,
    message: isOnDeck ? "On-deck match created!" : "Match created successfully!",
    teamA: teamA.map((p) => p.display_name),
    teamB: teamB.map((p) => p.display_name),
    isMixedLevel,
  };
}
