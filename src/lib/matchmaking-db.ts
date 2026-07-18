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
import { skillLevelToInt } from "@/types/database";
import {
  ANTI_REPEAT_LOOKBACK,
  COMMITTED_MATCH_STATUSES,
  MATCH_REST_GAP_MINUTES,
  MIN_REST_MINUTES,
  OVERLAP_WEIGHT_OPPONENT,
  OVERLAP_WEIGHT_TEAMMATE,
  PLAYERS_PER_MATCH,
  ROSTER_LOOKBACK_COUNT,
} from "@/lib/constants";
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

  // v_queue_with_wait_time DOES expose is_paused (verified in the view def and
  // the QueueWithWaitTime type), so filter in memory — the old supplemental
  // queue_entries query was dead weight (one extra round trip per pool fetch).
  // Paused players are strictly invisible to the matchmaking engine.
  const active = (rawPool ?? []).filter((p) => !p.is_paused);

  // Minimum rest filter: exclude players who just finished a game and haven't
  // rested long enough. wait_minutes reflects time since re-entering the queue.
  // First-time players (games_played=0) are always eligible — no rest needed.
  // Fallback: if the filter would leave fewer than PLAYERS_PER_MATCH players,
  // waive it so very small sessions can still form matches.
  const rested = active.filter(
    (p) => p.games_played === 0 || (p.wait_minutes ?? 0) >= MIN_REST_MINUTES
  );
  return rested.length >= PLAYERS_PER_MATCH ? rested : active;
}

// ─────────────────────────────────────────────────────────────
// fetchRecentRosters
// ─────────────────────────────────────────────────────────────
// Returns the last ROSTER_LOOKBACK_COUNT match rosters (completed,
// in_progress, and pending) as arrays of player IDs. Used by the
// diversity-violation check in runAlgorithm.
//
// Including in_progress and pending means the engine sees players
// who are CURRENTLY paired together, not only those who have
// already finished. This prevents the engine from forming the
// same pairing "again" just because the first game is still live.
//
// Fetched PER SLOT inside runEngineInternal's fill loop (not once per
// run) so the diversity-violation check also sees sibling drafts
// committed by earlier slots of the same burst.

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
    .limit(ROSTER_LOOKBACK_COUNT);

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
// Returns both same-team (partnership) AND cross-team (opponent)
// pair counts for this session in a single pass over the match_players
// data — no extra DB calls.
//
// partnershipCounts: Map<pairKey, count> of same-team co-appearances.
// opponentCounts:    Map<pairKey, count> of cross-net opponent appearances.
//
// Covers completed, in_progress, and pending matches so caps apply the
// moment a draft is created, not only after publish.
//
// Called once per slot (per runAlgorithm invocation) so fresh drafts
// from earlier slots are counted before the next slot's cap check.

export async function fetchPartnershipCounts(
  supabase: DbClient,
  sessionId: string
): Promise<{ partnershipCounts: Map<string, number>; opponentCounts: Map<string, number> }> {
  const partnershipCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();

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
    return { partnershipCounts, opponentCounts };
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
    return { partnershipCounts, opponentCounts };
  }

  // Step 3: group by (match_id, team). row.team is typed Team (non-nullable).
  const byMatchTeam = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.match_id}:${row.team}`;
    const group = byMatchTeam.get(key) ?? [];
    group.push(row.player_id);
    byMatchTeam.set(key, group);
  }

  // Step 4: group team buckets by match_id so we can compute both
  // same-team (partnership) pairs and cross-team (opponent) pairs.
  const byMatch = new Map<string, string[][]>();
  for (const [key, players] of byMatchTeam.entries()) {
    const matchId = key.split(":")[0]; // match UUID precedes the first ':'
    const teamList = byMatch.get(matchId) ?? [];
    teamList.push(players);
    byMatch.set(matchId, teamList);
  }

  for (const teamBuckets of byMatch.values()) {
    // Same-team (partnership) pairs — within each team bucket.
    for (const teammates of teamBuckets) {
      for (let i = 0; i < teammates.length; i++) {
        for (let j = i + 1; j < teammates.length; j++) {
          const k = pairKey(teammates[i], teammates[j]);
          partnershipCounts.set(k, (partnershipCounts.get(k) ?? 0) + 1);
        }
      }
    }

    // Cross-team (opponent) pairs — between team buckets for the same match.
    if (teamBuckets.length === 2) {
      const [teamA, teamB] = teamBuckets;
      for (const a of teamA) {
        for (const b of teamB) {
          const k = pairKey(a, b);
          opponentCounts.set(k, (opponentCounts.get(k) ?? 0) + 1);
        }
      }
    } else if (process.env.DEBUG_MATCHMAKING === "true") {
      console.warn(
        `[matchmaking-db] fetchPartnershipCounts: match has ${teamBuckets.length} team bucket(s) — opponent pairs skipped (expected 2)`
      );
    }
  }

  if (process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[matchmaking-db] fetchPartnershipCounts: ${partnershipCounts.size} partnership pair(s), ` +
        `${opponentCounts.size} opponent pair(s) across ` +
        `${sessionMatches.length} match(es) for session ${sessionId}`
    );
  }

  return { partnershipCounts, opponentCounts };
}

// ─────────────────────────────────────────────────────────────
// buildOverlapMap
// ─────────────────────────────────────────────────────────────
// Returns a Map<player_id, weight> representing how "familiar"
// each co-player is to the anchor across recent matches in this
// session. Used by scoreCandidates to apply anti-repeat penalties.
//
// Team-aware weighting (OVERLAP_WEIGHT_TEAMMATE / OVERLAP_WEIGHT_OPPONENT):
//   Teammate appearance  → weight += 2  (same side)
//   Opponent appearance  → weight += 2  (cross-net; equal to teammate as of the
//                          2026-07 diversity pass — re-facing avoided as hard
//                          as re-partnering, the primary round-2 opponent lever)
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
    const weight = row.team === anchorTeam ? OVERLAP_WEIGHT_TEAMMATE : OVERLAP_WEIGHT_OPPONENT;
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
  isOnDeck: boolean,
  autoPublish = false
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
    // Draft mode (autoPublish=false, default): is_published=false → the match
    // lands as a DRAFT for organizer review. "Publish All" or per-match Publish
    // promotes it to On Deck. Manually-created matches also start unpublished.
    //
    // Auto-publish mode (autoPublish=true): is_published=true → the RPC promotes
    // the roster straight to 'on_deck' and the match skips the review gate. The
    // engine fires ON_DECK_WARNING itself (the push lives in the publish action,
    // which this path bypasses).
    p_is_published: autoPublish,
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

// ═════════════════════════════════════════════════════════════
// CROSS-COURT DIVERSITY DRAFTING — DB helpers (Phase 4)
// ═════════════════════════════════════════════════════════════

// A currently-PLAYING body that may be pulled into a held draft, enriched with
// everything the engine needs: a QueueWithWaitTime-shaped row + the eligibility
// context (consecutive-games streak, already-in-a-held-draft) + the started_at of
// its current in_progress match (for the pickEarliestFinishing tiebreak).
export type PullableBody = QueueWithWaitTime & {
  streak: number;
  alreadyHeld: boolean;
  /** id of the body's current in_progress match — passed as p_pulled_from_match_id. */
  currentMatchId: string;
  currentMatchStartedAt: string;
};

// ─────────────────────────────────────────────────────────────
// fetchPullablePlayers
// ─────────────────────────────────────────────────────────────
// Returns the playing bodies eligible to be CONSIDERED for a held draft. The
// engine still filters these through isPullEligible (streak/cooldown/already-held)
// and the algorithm's skill window — this helper just gathers the candidate set.
// Called lazily (only when the waiting pool produced a forced repeat), so its
// handful of queries don't run on every engine tick.
export async function fetchPullablePlayers(
  supabase: DbClient,
  sessionId: string
): Promise<PullableBody[]> {
  // 1. In-progress matches → player → currentMatchStartedAt. Manual join: this
  //    codebase declares Relationships:[] (CLAUDE.md), so PostgREST embeds aren't typed.
  const { data: activeMatchRows } = await supabase
    .from("matches")
    .select("id, started_at")
    .eq("session_id", sessionId)
    .eq("status", "in_progress");
  const activeMatchIds = (activeMatchRows ?? []).map((m) => m.id);
  if (activeMatchIds.length === 0) return [];
  const activeStartedAt = new Map((activeMatchRows ?? []).map((m) => [m.id, m.started_at]));

  const { data: activePlayers } = await supabase
    .from("match_players")
    .select("match_id, player_id")
    .in("match_id", activeMatchIds);

  const playingMap = new Map<string, { matchId: string; startedAt: string }>();
  for (const mp of activePlayers ?? []) {
    const startedAt = activeStartedAt.get(mp.match_id);
    if (startedAt) playingMap.set(mp.player_id, { matchId: mp.match_id, startedAt });
  }
  if (playingMap.size === 0) return [];

  const playingIds = [...playingMap.keys()];

  // 2-4. Queue rows + profiles + already-held set + recent match timing (parallel).
  const [
    { data: queueRows },
    { data: profileRows },
    { data: heldDrafts },
    { data: recentMatchRows },
  ] = await Promise.all([
    supabase
      .from("queue_entries")
      .select("id, player_id, games_played, joined_at, created_at, is_paused")
      .eq("session_id", sessionId)
      .in("player_id", playingIds),
    supabase.from("profiles").select("id, display_name, skill_level").in("id", playingIds),
    supabase
      .from("matches")
      .select("pulled_player_ids")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .eq("is_held", true),
    supabase
      .from("matches")
      .select("id, started_at, completed_at")
      .eq("session_id", sessionId)
      .in("status", ["in_progress", "completed"])
      .order("started_at", { ascending: false })
      .limit(16),
  ]);

  const profileMap = new Map((profileRows ?? []).map((p) => [p.id, p]));
  const queueMap = new Map((queueRows ?? []).map((q) => [q.player_id, q]));
  const alreadyHeld = new Set(
    (heldDrafts ?? []).flatMap(
      (m) => (m as { pulled_player_ids: string[] }).pulled_player_ids ?? []
    )
  );

  // Recent rosters (manual join) → match_id → Set(player_id), for the streak.
  const recentMatchIds = (recentMatchRows ?? []).map((m) => m.id);
  const { data: recentRoster } =
    recentMatchIds.length > 0
      ? await supabase
          .from("match_players")
          .select("match_id, player_id")
          .in("match_id", recentMatchIds)
      : { data: [] as { match_id: string; player_id: string }[] };
  const rosterByMatch = new Map<string, Set<string>>();
  for (const mp of recentRoster ?? []) {
    const set = rosterByMatch.get(mp.match_id) ?? new Set<string>();
    set.add(mp.player_id);
    rosterByMatch.set(mp.match_id, set);
  }

  // Per-player consecutive-games streak (R3-C): walk their recent matches
  // newest-first; count the unbroken run where each game starts within
  // MATCH_REST_GAP_MINUTES of the previous one finishing (no real rest between).
  const gapMs = MATCH_REST_GAP_MINUTES * 60_000;
  const streakFor = (playerId: string): number => {
    const theirs = (recentMatchRows ?? []).filter((m) => rosterByMatch.get(m.id)?.has(playerId));
    if (theirs.length === 0) return 0;
    let streak = 1;
    for (let i = 1; i < theirs.length; i++) {
      const newer = theirs[i - 1];
      const older = theirs[i];
      if (!newer.started_at || !older.completed_at) break;
      const gap = new Date(newer.started_at).getTime() - new Date(older.completed_at).getTime();
      if (gap <= gapMs) streak++;
      else break;
    }
    return streak;
  };

  // 5. Assemble. priorityScore:-1 (C-3) so a pulled body never out-anchors a
  //    waiting player; isPulled flags it for the ≤1-pulled composition guard.
  const result: PullableBody[] = [];
  for (const playerId of playingIds) {
    const prof = profileMap.get(playerId);
    const q = queueMap.get(playerId);
    if (!prof || !q || q.is_paused) continue;
    result.push({
      id: q.id,
      session_id: sessionId,
      player_id: playerId,
      joined_at: q.joined_at,
      games_played: q.games_played,
      status: "playing",
      position: null,
      is_paused: false,
      created_at: q.created_at,
      display_name: prof.display_name,
      skill_level: prof.skill_level,
      skill_level_int: skillLevelToInt(prof.skill_level),
      wait_minutes: 0,
      is_bottleneck: false,
      streak: streakFor(playerId),
      alreadyHeld: alreadyHeld.has(playerId),
      currentMatchId: playingMap.get(playerId)!.matchId,
      currentMatchStartedAt: playingMap.get(playerId)!.startedAt,
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// executeHeldMatch
// ─────────────────────────────────────────────────────────────
// Commits a held cross-court draft via the create_held_cross_court_match RPC.
// Same NULL-return convention as executeMatch: NULL = a TOCTOU/reservation guard
// fired → graceful slot-skip (not a hard error).
export async function executeHeldMatch(
  supabase: DbClient,
  sessionId: string,
  proposal: MatchProposal,
  pulledPlayerId: string,
  pulledFromMatchId: string
): Promise<ExecuteMatchResult> {
  const { teamA, teamB, isMixedLevel } = proposal;

  const { data: matchId, error: rpcError } = await supabase.rpc("create_held_cross_court_match", {
    p_session_id: sessionId,
    p_is_mixed_level: isMixedLevel,
    p_team_a_ids: teamA.map((p) => p.player_id),
    p_team_b_ids: teamB.map((p) => p.player_id),
    p_pulled_player_id: pulledPlayerId,
    p_pulled_from_match_id: pulledFromMatchId,
    p_origin: "auto" as const,
  });

  if (rpcError) {
    return { success: false, message: `Failed to create held match: ${rpcError.message}` };
  }

  if (!matchId) {
    console.warn(
      "[matchmaking-db] executeHeldMatch: RPC returned NULL — a TOCTOU/reservation guard " +
        "fired (waiting member taken, pulled body no longer playing, or already in a held draft). " +
        "Skipping slot gracefully.",
      { sessionId, pulledPlayerId }
    );
    return { success: false, message: "Slot skipped: held-draft guard fired." };
  }

  return { success: true, matchId, message: "Held cross-court draft created!" };
}
