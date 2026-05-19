// ============================================================
// Matchmaking DB — Database-coupled data helpers
// ============================================================
//
// All functions accept a Supabase service-role client and perform
// the DB queries that feed the pure matchmaking algorithm in
// matchmaking-core.ts.
//
// Separated from matchmaking-core.ts so that:
//   1. The pure algorithm (runAlgorithm) is testable with zero DB mocking.
//   2. These DB helpers are independently mockable via vi.mock('@/lib/matchmaking-db').
//
// Exports:
//   fetchActivePool        — waiting players, paused-filtered, unscored
//   fetchRecentRosters     — recent match rosters for diversity checks
//   fetchPartnershipCounts — per-session same-team pair counts
//   buildOverlapMap        — per-anchor co-player familiarity weights
//   executeMatch           — write: commit a MatchProposal via RPC
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QueueWithWaitTime } from "@/types/database";
import { ANTI_REPEAT_LOOKBACK, COMMITTED_MATCH_STATUSES } from "@/lib/constants";
import { pairKey, type MatchProposal } from "@/lib/matchmaking-core";

// Convenience alias: all engine helpers run under the service-role client.
export type DbClient = SupabaseClient<Database>;

// Result shape returned by executeMatch to the orchestrator in matchmaking.ts.
// Kept intentionally narrow — callers build the public MatchmakingResult from this.
export type ExecuteMatchResult = {
  success: boolean;
  matchId?: string;
  message: string;
};

// ─────────────────────────────────────────────────────────────
// fetchActivePool
// ─────────────────────────────────────────────────────────────
// Returns the current "waiting" player pool for a session,
// excluding soft-paused players.
//
// Returns raw QueueWithWaitTime rows — NOT scored or sorted.
// Scoring and sorting is done by scoreAndSortPool() in
// matchmaking-core.ts so that step is independently testable.

export async function fetchActivePool(
  supabase: DbClient,
  sessionId: string
): Promise<QueueWithWaitTime[]> {
  const { data: rawPool, error: poolError } = await supabase
    .from("v_queue_with_wait_time")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .order("games_played", { ascending: true })
    .order("joined_at", { ascending: true });

  if (poolError) {
    console.warn("[matchmaking-db] fetchActivePool: query failed:", poolError.message);
    return [];
  }

  // v_queue_with_wait_time does not expose is_paused, so we do a
  // supplemental query on queue_entries and filter in memory.
  // Paused players are strictly invisible to the matchmaking engine.
  const { data: pausedRows } = await supabase
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .eq("is_paused", true);

  const pausedSet = new Set((pausedRows ?? []).map((r) => r.player_id));
  return (rawPool ?? []).filter((p) => !pausedSet.has(p.player_id));
}

// ─────────────────────────────────────────────────────────────
// fetchRecentRosters
// ─────────────────────────────────────────────────────────────
// Returns the last ANTI_REPEAT_LOOKBACK match rosters (completed,
// in_progress, and pending) as arrays of player IDs. Used by the
// diversity-violation check in runAlgorithm.
//
// Including in_progress and pending means the engine sees players
// who are CURRENTLY paired together, not only those who have
// already finished. This prevents the engine from forming the
// same pairing "again" just because the first game is still live.
//
// Pre-fetched once per runEngineInternal run (stable snapshot);
// passed to each runAlgorithm call rather than re-fetched per slot.

export async function fetchRecentRosters(
  supabase: DbClient,
  sessionId: string
): Promise<string[][]> {
  const { data: recentMatchRows } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", COMMITTED_MATCH_STATUSES)
    .order("created_at", { ascending: false })
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

  return recentMatchIds.map((id) => rosterMap.get(id) ?? []).filter((r) => r.length > 0);
}

// ─────────────────────────────────────────────────────────────
// fetchPartnershipCounts
// ─────────────────────────────────────────────────────────────
// Returns a Map<pairKey, count> of how many times each same-team
// pair has played together in this session. Covers all match statuses
// that represent a committed team assignment (completed, in_progress,
// pending — including unpublished drafts) so the cap applies the
// moment a draft match is created, not only after publish.
//
// Called once per runAlgorithm invocation (hoisted above the anchor
// selection loop) so it is NOT re-fetched per candidate scan.

export async function fetchPartnershipCounts(
  supabase: DbClient,
  sessionId: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  // Step 1: all match IDs for this session with committed statuses.
  const { data: sessionMatches, error: matchErr } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", COMMITTED_MATCH_STATUSES);

  if (matchErr || !sessionMatches || sessionMatches.length === 0) {
    if (matchErr) {
      console.warn(
        "[matchmaking-db] fetchPartnershipCounts: match query failed:",
        matchErr.message
      );
    }
    return counts;
  }

  const matchIds = sessionMatches.map((m) => m.id);

  // Step 2: all match_players rows for those matches.
  const { data: rows, error: rowsErr } = await supabase
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", matchIds);

  if (rowsErr || !rows || rows.length === 0) {
    if (rowsErr) {
      console.warn(
        "[matchmaking-db] fetchPartnershipCounts: players query failed:",
        rowsErr.message
      );
    }
    return counts;
  }

  // Step 3: group by (match_id, team), count all same-team pairs.
  // row.team is typed Team (non-nullable) — the DB column is NOT NULL.
  const byMatchTeam = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.match_id}:${row.team}`;
    const group = byMatchTeam.get(key) ?? [];
    group.push(row.player_id);
    byMatchTeam.set(key, group);
  }

  for (const teammates of byMatchTeam.values()) {
    for (let i = 0; i < teammates.length; i++) {
      for (let j = i + 1; j < teammates.length; j++) {
        const key = pairKey(teammates[i], teammates[j]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  if (process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[matchmaking-db] fetchPartnershipCounts: ${counts.size} tracked pair(s) across ` +
        `${sessionMatches.length} match(es) for session ${sessionId}`
    );
  }

  return counts;
}

// ─────────────────────────────────────────────────────────────
// buildOverlapMap
// ─────────────────────────────────────────────────────────────
// Returns a Map<player_id, weight> representing how "familiar"
// each co-player is to the anchor across recent matches in this
// session. Used by scoreCandidates to apply anti-repeat penalties.
//
// Team-aware weighting:
//   Teammate appearance  → weight += 2  (same side; stronger familiarity)
//   Opponent appearance  → weight += 1  (opposing; weaker familiarity)
//
// Implementation: 3-step join to avoid relying on v_recent_pairings
// (which lacks team data and only tracks completed matches).
//   Step 1 — find the anchor's match IDs (global, via match_players)
//   Step 2 — filter to session + recent statuses
//   Step 3 — fetch all co-players + teams, compute weighted map

export async function buildOverlapMap(
  supabase: DbClient,
  sessionId: string,
  anchorPlayerId: string
): Promise<Map<string, number>> {
  const overlapMap = new Map<string, number>();

  // Step 1: Find all match IDs the anchor has participated in.
  // Safety cap: limit to 200 rows so the allAnchorMatchIds array
  // stays bounded for the .in() clause in Step 2.
  const { data: anchorRows, error: anchorErr } = await supabase
    .from("match_players")
    .select("match_id")
    .eq("player_id", anchorPlayerId)
    .limit(200);

  if (anchorErr || !anchorRows || anchorRows.length === 0) {
    if (anchorErr) {
      console.warn("[matchmaking-db] buildOverlapMap: anchor query failed:", anchorErr.message);
    }
    return overlapMap; // First-time player or error — no overlap data
  }

  const allAnchorMatchIds = anchorRows.map((r) => r.match_id);

  // Step 2: Filter to this session's recent matches (completed +
  // in_progress + pending) that actually include the anchor.
  const { data: sessionMatches, error: sessionErr } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", COMMITTED_MATCH_STATUSES)
    .in("id", allAnchorMatchIds)
    .order("created_at", { ascending: false })
    .limit(ANTI_REPEAT_LOOKBACK);

  if (sessionErr || !sessionMatches || sessionMatches.length === 0) {
    if (sessionErr) {
      console.warn("[matchmaking-db] buildOverlapMap: session filter failed:", sessionErr.message);
    }
    return overlapMap;
  }

  const recentMatchIds = sessionMatches.map((m) => m.id);

  // Step 3: Fetch all players + teams for those matches.
  const { data: allPlayers, error: playersErr } = await supabase
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", recentMatchIds);

  if (playersErr || !allPlayers) {
    if (playersErr) {
      console.warn(
        "[matchmaking-db] buildOverlapMap: co-players query failed:",
        playersErr.message
      );
    }
    return overlapMap;
  }

  // Build a map of match_id → anchor's team assignment.
  const anchorTeamByMatch = new Map<string, string>();
  // row.team is typed Team (non-nullable) — the DB column is NOT NULL.
  for (const row of allPlayers) {
    if (row.player_id === anchorPlayerId) {
      anchorTeamByMatch.set(row.match_id, row.team);
    }
  }

  // Apply team-weighted overlap for every co-player.
  for (const row of allPlayers) {
    if (row.player_id === anchorPlayerId) continue;
    const anchorTeam = anchorTeamByMatch.get(row.match_id);
    if (anchorTeam === undefined) continue;
    // row.team is typed Team (non-nullable) — the DB column is NOT NULL.
    // Teammate (same team) is weighted 2×; opponent 1×.
    const weight = row.team === anchorTeam ? 2 : 1;
    overlapMap.set(row.player_id, (overlapMap.get(row.player_id) ?? 0) + weight);
  }

  return overlapMap;
}

// ─────────────────────────────────────────────────────────────
// executeMatch
// ─────────────────────────────────────────────────────────────
// Commits a MatchProposal to the database via the atomic
// create_match_with_players RPC.
//
// Accepts a proposal from the pure runAlgorithm (players + teams +
// mixed-level flag) plus execution context (courtId, isOnDeck) that
// is irrelevant to the algorithm itself.
//
// NULL return convention:
//   { data: null, error: null }       → TOCTOU guard fired → graceful skip
//   { data: null, error: PostgrestError } → hard DB error → surface to caller

export async function executeMatch(
  supabase: DbClient,
  sessionId: string,
  courtId: string | null,
  proposal: MatchProposal,
  isOnDeck: boolean
): Promise<ExecuteMatchResult> {
  const now = new Date().toISOString();
  const { teamA, teamB, isMixedLevel } = proposal;

  const { data: matchId, error: rpcError } = await supabase.rpc("create_match_with_players", {
    p_session_id: sessionId,
    p_court_id: isOnDeck ? null : courtId,
    p_status: isOnDeck ? "pending" : "in_progress",
    p_is_mixed_level: isMixedLevel,
    p_started_at: isOnDeck ? null : now,
    p_is_on_deck: isOnDeck,
    p_team_a_ids: teamA.map((p) => p.player_id),
    p_team_b_ids: teamB.map((p) => p.player_id),
    p_origin: "auto" as const,
    // Auto-created on-deck matches are published immediately — they come
    // from the engine's algorithm, not the organizer's draft review flow.
    // Manually-created draft matches (organizer UI) use p_is_published: false.
    p_is_published: isOnDeck,
  });

  if (rpcError) {
    return {
      success: false,
      message: `Failed to create match: ${rpcError.message}`,
    };
  }

  if (!matchId) {
    // RPC returned NULL: the DB-level TOCTOU guard detected a conflict.
    // This is a graceful slot-skip, not a hard error.
    console.warn(
      "[matchmaking-db] executeMatch: RPC returned NULL — concurrent matchmaking " +
        "run already committed one or more of these players. Skipping slot gracefully.",
      {
        sessionId,
        teamA: teamA.map((p) => p.display_name),
        teamB: teamB.map((p) => p.display_name),
      }
    );
    return {
      success: false,
      message: "Slot skipped: player already committed by a concurrent matchmaking run.",
    };
  }

  return {
    success: true,
    matchId,
    message: isOnDeck ? "On-deck match created!" : "Match created successfully!",
  };
}
