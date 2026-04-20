"use server";

// ============================================================
// Enterprise Matchmaking Engine — Server Actions
// ============================================================
//
// Pipeline: Queue → On Deck → Active Court
// -----------------------------------------
// The engine is PURELY an on-deck filler. It never places
// players directly onto courts. Court assignment happens only
// via promoteOnDeckMatchInternal when a court frees up.
//
// Engine entry points (all check the toggle before running):
//   runEngineForSession(sessionId)   — called by: toggle-ON,
//     joinQueue, endMatch, clearOnDeck, callNextMatch
//
// Organizer surface:
//   callNextMatch(sessionId, courtId)  — promote oldest on-deck;
//     if none, run engine inline then retry once.
//
// Internal only:
//   runEngineInternal(supabase, sessionId)  — capacity-limited
//     on-deck filler. Cap = max(1, courtCount − 1).
//   createOneOnDeckMatch / runAlgorithm / promoteOnDeckMatchInternal
//   executeMatch / buildOverlapMap / snakeDraft / isGroupValid / etc.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  PLAYERS_PER_MATCH,
  FALLBACK_WAIT_MINUTES,
  ANTI_REPEAT_LOOKBACK,
  RED_ZONE_SCORE_FLOOR,
} from "@/lib/constants";
import {
  computePriorityScore,
  isGroupValid,
  snakeDraft,
  isDiversityViolation,
  scoreCandidates,
  buildCombinationGroup,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
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
// Organizer clicks "Call Next Match" on a court card.
// Step 1: promote the oldest on-deck match.
// Step 2: if none exists and toggle is ON, run engine inline
//   to form one from the queue, then retry promotion once.
// Always triggers engine after success so the slot is refilled.

export async function callNextMatch(
  sessionId: string,
  courtId: string
): Promise<MatchmakingResult> {
  const supabase = await createClient();

  // 1. Try to promote an existing on-deck match.
  let promoted = await promoteOnDeckMatchInternal(supabase, sessionId, courtId);
  if (promoted.success) {
    // Refill the on-deck slot we just consumed.
    await runEngineInternal(supabase, sessionId);
    return promoted;
  }

  // 2. No on-deck match — check toggle.
  const { data: session } = await supabase
    .from("sessions")
    .select("is_auto_matchmaking_on")
    .eq("id", sessionId)
    .single();

  if (!session?.is_auto_matchmaking_on) {
    return {
      success: false,
      message: "No on-deck matches. Auto-matchmaking is paused — create one manually.",
    };
  }

  // 3. Toggle ON: run engine now, then retry promotion.
  await runEngineInternal(supabase, sessionId);
  promoted = await promoteOnDeckMatchInternal(supabase, sessionId, courtId);
  if (promoted.success) return promoted;

  return {
    success: false,
    message: "Not enough players in the queue to form a match.",
  };
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: runEngineForSession
// ─────────────────────────────────────────────────────────────
// Called from: toggleAutoMatchmaking (ON), joinQueueAction,
// endMatchAction, clearOnDeckMatch.
// Checks the toggle itself — callers need not check it first.

export async function runEngineForSession(sessionId: string): Promise<void> {
  const supabase = await createClient();
  const { data: session } = await supabase
    .from("sessions")
    .select("is_auto_matchmaking_on")
    .eq("id", sessionId)
    .single();
  if (!session?.is_auto_matchmaking_on) return;
  await runEngineInternal(supabase, sessionId);
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: runEngineInternal
// ─────────────────────────────────────────────────────────────
// Capacity-limited on-deck filler.
// Cap = max(1, courtCount − 1): 4 courts → 3 on-deck max.
// Fills slots up to capacity, stopping when queue is exhausted.

async function runEngineInternal(
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

  // Cap on-deck at (courtCount − 1) to prevent locking the entire queue.
  const capacity = Math.max(1, courtCount - 1);

  const { count: existingOnDeck } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "pending");

  const slotsAvailable = capacity - (existingOnDeck ?? 0);
  if (slotsAvailable <= 0) return;

  // Pre-fetch recent rosters once for the entire fill loop.
  // recentRosters only contains COMPLETED matches, which don't change while
  // we're filling on-deck slots — safe to share across all iterations and
  // avoids (2 × slotsAvailable − 2) redundant DB queries per engine run.
  const recentRosters = await fetchRecentRosters(supabase, sessionId);

  for (let i = 0; i < slotsAvailable; i++) {
    const { created, message } = await createOneOnDeckMatch(supabase, sessionId, recentRosters);
    if (!created) {
      // Surface the reason so it's visible in Vercel logs.
      // "Not enough players" is expected and not an error; anything else is.
      const isExpected = message?.includes("Not enough");
      if (!isExpected) {
        console.error(`[matchmaking] runEngineInternal: slot ${i + 1}/${slotsAvailable} failed — ${message}`);
      } else if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(`[matchmaking] runEngineInternal: stopping at slot ${i + 1} — ${message}`);
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: createOneOnDeckMatch
// ─────────────────────────────────────────────────────────────

async function createOneOnDeckMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  recentRosters?: string[][]
): Promise<{ created: boolean; message: string }> {
  const result = await runAlgorithm(supabase, sessionId, null, true, recentRosters);
  return { created: result.success, message: result.message };
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
//
// Priority system (replaces raw games_played sort):
//   RED ZONE (wait ≥ 25 min): score = 1000 + wait → anchor first, no swap immunity
//   NORMAL   (wait < 25 min): score = wait − (games × 12)
// Pool is re-sorted by score DESC before anchor selection.
//
// Red Zone safeguards:
//   1. Skill window expands to ±3 then ±4 if ±2 can't fill the group.
//   2. The 3rd group member (swap target) is immune from diversity swap
//      if their priorityScore ≥ 1000.

async function runAlgorithm(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string | null,
  isOnDeck: boolean,
  cachedRecentRosters?: string[][]
): Promise<MatchmakingResult> {
  // ── 1. Fetch the waiting pool ─────────────────────────────
  const { data: rawPool, error: poolError } = await supabase
    .from("v_queue_with_wait_time")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .order("games_played", { ascending: true })
    .order("joined_at", { ascending: true });

  if (poolError) {
    return { success: false, message: `Failed to fetch queue: ${poolError.message}` };
  }

  // ── 1b. Filter soft-paused players ────────────────────────
  // v_queue_with_wait_time does not expose is_paused, so we do a
  // supplemental query directly on queue_entries and filter in memory.
  // Paused players are strictly invisible to the matchmaking engine.
  const { data: pausedRows } = await supabase
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .eq("is_paused", true);

  const pausedSet = new Set((pausedRows ?? []).map((r) => r.player_id));
  const activePool = (rawPool ?? []).filter((p) => !pausedSet.has(p.player_id));

  if (activePool.length < PLAYERS_PER_MATCH) {
    return {
      success: false,
      message: `Not enough active players in queue. Need ${PLAYERS_PER_MATCH}, have ${activePool.length}.`,
    };
  }

  // ── 2. Enrich pool with priorityScore, sort DESC ──────────
  // Re-sort by priority score so the most-urgent player anchors
  // the match, regardless of how many games they've played.
  const pool: ScoredPlayer[] = activePool
    .map((p) => ({ ...p, priorityScore: computePriorityScore(p) }))
    .sort((a, b) => b.priorityScore - a.priorityScore);

  // ── 3. Anchor = highest-priority player ──────────────────
  const anchor = pool[0];
  const anchorSkill = anchor.skill_level_int;
  const anchorWaitMinutes = anchor.wait_minutes ?? 0;
  const anchorIsRedZone = anchor.priorityScore >= RED_ZONE_SCORE_FLOOR;

  if (process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[matchmaking] anchor=${anchor.display_name} skill=${anchorSkill} ` +
      `wait=${anchorWaitMinutes.toFixed(1)}min priority=${anchor.priorityScore.toFixed(1)} ` +
      `redZone=${anchorIsRedZone} pool=${pool.length}`
    );
  }

  // ── 4. Build overlap map ──────────────────────────────────
  // buildOverlapMap is anchor-specific (counts pairings with THIS anchor)
  // so it cannot be hoisted above the loop — it must run once per tick as
  // the anchor changes each slot fill.
  const overlapMap = await buildOverlapMap(supabase, sessionId, anchor.player_id);

  // ── 5. Recent rosters for group-level diversity ───────────
  // Use the pre-fetched cache from runEngineInternal when available
  // (saves 2 DB queries per additional on-deck slot filled in one run).
  // Falls back to a fresh fetch when called from single-match paths
  // (callNextMatch inline engine, or direct court assignment).
  const recentRosters = cachedRecentRosters ?? await fetchRecentRosters(supabase, sessionId);

  // Candidates = everyone except the anchor (already priority-sorted).
  const candidates = pool.slice(1);

  // ── 6. Last-resort time fallback (> 15 min, non-Red Zone path) ──
  // Fires only when the anchor has waited > FALLBACK_WAIT_MINUTES
  // and we haven't entered Red Zone yet (15–25 min window) AND
  // the progressive skill expansion below also fails. Handled
  // at the end after all expansion windows are exhausted.

  // ── 7. Build skill window list ────────────────────────────
  // Red Zone anchor: try ±1, ±2, ±3, ±4 to guarantee a match.
  // Normal anchor:   try ±1, ±2 only (existing behaviour).
  const skillWindows = anchorIsRedZone
    ? [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX, 3, 4]
    : [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX];

  // ── 8. Progressive expansion ──────────────────────────────
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

    // Rank eligible candidates: highest priorityScore first, overlap as tiebreaker.
    const scored = scoreCandidates(eligible, overlapMap);

    // Combination group building with cross-validation.
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    if (group.length === 3) {
      const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

      // ── Group-level diversity check ───────────────────────
      if (isDiversityViolation(proposedIds, recentRosters)) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] Diversity violation for [${group.map((g) => g.display_name).join(", ")}] — attempting swap`
          );
        }

        // Red Zone immunity: if the 3rd companion (swap target) is also
        // in the Red Zone, never bench them for diversity — waiting time
        // takes absolute precedence.
        const swapTarget = group[2];
        if (swapTarget.priorityScore >= RED_ZONE_SCORE_FLOOR) {
          if (process.env.DEBUG_MATCHMAKING === "true") {
            console.warn(
              `[matchmaking] Swap target ${swapTarget.display_name} is Red Zone ` +
              `(score=${swapTarget.priorityScore.toFixed(1)}) — diversity swap skipped`
            );
          }
          // Fall through to executeMatch with the original group.
        } else {
          // Keep the top 2 companions; try replacing the 3rd.
          const fixedTwo = group.slice(0, 2);
          const alreadyInGroup = new Set(group.map((g) => g.player_id));
          const swapPool = scored.filter(
            ({ candidate }) => !alreadyInGroup.has(candidate.player_id)
          );

          let diverseSwapFound = false;
          for (const { candidate } of swapPool) {
            const swapGroup = [...fixedTwo, candidate];
            if (!isGroupValid([anchor, ...swapGroup], maxVariance)) continue;

            const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
            if (!isDiversityViolation(swappedIds, recentRosters)) {
              diverseSwapFound = true;
              if (process.env.DEBUG_MATCHMAKING === "true") {
                console.log(`[matchmaking] Swap succeeded — replaced with ${candidate.display_name}`);
              }
              const { teamA, teamB } = snakeDraft([anchor, ...swapGroup]);
              return executeMatch(supabase, sessionId, courtId, teamA, teamB, false, isOnDeck);
            }
          }

          if (!diverseSwapFound) {
            console.warn("[matchmaking] No diverse swap found — accepting repeat group (critical fallback)");
          }
        }
      }

      const isMixed = maxVariance > SKILL_VARIANCE_MAX;
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] ±${maxVariance} window: matched [${group.map((g) => g.display_name).join(", ")}]` +
          (isMixed ? " (mixed level)" : "")
        );
      }
      const allFour = [anchor, ...group];
      const { teamA, teamB } = snakeDraft(allFour);
      return executeMatch(supabase, sessionId, courtId, teamA, teamB, isMixed, isOnDeck);
    }

    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] ±${maxVariance} window: only built group of ${group.length} — expanding`
      );
    }
  }

  // ── 9. Last-resort fallback (15+ min anchor, any 3 players) ──
  // NOTE: This path intentionally skips skill validation. A player who has
  // waited > FALLBACK_WAIT_MINUTES without finding a compatible group will be
  // matched with the next-best available players regardless of skill spread.
  // The match is always flagged isMixedLevel=true so the UI can warn the
  // organizer. Tradeoff: prevents indefinite starvation at the cost of match
  // quality. This only fires when ALL skill-window expansion passes fail.
  if (anchorWaitMinutes > FALLBACK_WAIT_MINUTES) {
    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] LAST-RESORT FALLBACK — anchor waited ${anchorWaitMinutes.toFixed(1)}min > ${FALLBACK_WAIT_MINUTES}min`
      );
    }
    // Apply overlap penalties so we don't accidentally repeat exact matches
    const scoredFallback = scoreCandidates(candidates, overlapMap);
    const fallbackGroup = scoredFallback.slice(0, 3).map((s) => s.candidate);
    
    if (fallbackGroup.length >= 3) {
      const allFour = [anchor, ...fallbackGroup];
      const { teamA, teamB } = snakeDraft(allFour);
      return executeMatch(supabase, sessionId, courtId, teamA, teamB, true, isOnDeck);
    }
  }

  return {
    success: false,
    message:
      "No compatible match could be formed. Skill levels in the queue are too spread out. " +
      "Check the Wait Time Monitor for players needing manual intervention.",
  };
}


// ─────────────────────────────────────────────────────────────
// HELPER: fetchRecentRosters
// ─────────────────────────────────────────────────────────────
// Returns the last ANTI_REPEAT_LOOKBACK completed match rosters as
// arrays of player IDs. Used by the diversity-violation check.
//
// This data is stable within a single engine run (completed matches
// don't change while filling on-deck slots), so runEngineInternal
// pre-fetches it once and passes it to each runAlgorithm call rather
// than re-fetching per slot.

async function fetchRecentRosters(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string
): Promise<string[][]> {
  const { data: recentMatchRows } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(ANTI_REPEAT_LOOKBACK);

  const recentMatchIds = (recentMatchRows ?? []).map((m) => m.id);
  if (recentMatchIds.length === 0) return [];

  const { data: recentPlayers } = await supabase
    .from("match_players")
    .select("match_id, player_id")
    .in("match_id", recentMatchIds);

  if (!recentPlayers) return [];

  const rosterMap = new Map<string, string[]>();
  for (const row of recentPlayers) {
    const list = rosterMap.get(row.match_id) ?? [];
    list.push(row.player_id);
    rosterMap.set(row.match_id, list);
  }

  return recentMatchIds
    .map((id) => rosterMap.get(id) ?? [])
    .filter((r) => r.length > 0);
}

// ─────────────────────────────────────────────────────────────
// HELPER: buildOverlapMap
// ─────────────────────────────────────────────────────────────
// Returns a Map<player_id, count> of how many completed matches
// each player has shared with the anchor in this session.
// Used to apply anti-repeat overlap penalties in scoreCandidates.

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
// HELPER: executeMatch
// ─────────────────────────────────────────────────────────────
// Unified match creation — handles both on-deck (pending, null
// court_id) and direct (in_progress, real court_id).

async function executeMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string | null,
  teamA: ScoredPlayer[],
  teamB: ScoredPlayer[],
  isMixedLevel: boolean,
  isOnDeck: boolean
): Promise<MatchmakingResult> {
  // ── Atomic write: match + players + queue statuses + court ──
  // All steps run inside a single Postgres transaction via the
  // create_match_with_players RPC (migration 20260421000000).
  //
  // Previously: 3 sequential writes with only partial compensation
  //   — Write 3 (queue status update) had no error check, meaning
  //     a failure left matched players stuck as "waiting" and the
  //     engine could create a duplicate match for them on the next tick.
  //   — A server crash between Write 1 and Write 2 produced a ghost
  //     match row with 0 players visible across the TV board and
  //     leaderboard queries.
  //
  // Now: Postgres rolls back the entire transaction on any failure.
  const now = new Date().toISOString();

  const { data: matchId, error: rpcError } = await supabase.rpc(
    "create_match_with_players",
    {
      p_session_id:     sessionId,
      p_court_id:       isOnDeck ? null : courtId,
      p_status:         isOnDeck ? "pending" : "in_progress",
      p_is_mixed_level: isMixedLevel,
      p_started_at:     isOnDeck ? null : now,
      p_is_on_deck:     isOnDeck,
      p_team_a_ids:     teamA.map((p) => p.player_id),
      p_team_b_ids:     teamB.map((p) => p.player_id),
    }
  );

  if (rpcError || !matchId) {
    return {
      success: false,
      message: `Failed to create match: ${rpcError?.message ?? "Unknown error"}`,
    };
  }

  return {
    success: true,
    matchId,
    message: isOnDeck ? "On-deck match created!" : "Match created successfully!",
    teamA: teamA.map((p) => p.display_name),
    teamB: teamB.map((p) => p.display_name),
    isMixedLevel,
  };
}
