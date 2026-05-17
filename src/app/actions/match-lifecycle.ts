"use server";

// ============================================================
// match-lifecycle.ts — Score submission + match lifecycle
// ============================================================
// submitMatchScore  — player-initiated score submission
// endMatchAction    — organizer ends a match with scores
// cancelMatchAction — cancel a pending/in-progress match
// updateMatchDetails — edit historical match scores / revert
// createManualMatchAction — organizer creates a manual match
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { promoteOnDeckMatchInternal, runEngineForSession } from "@/app/actions/matchmaking";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { isValidUUID } from "@/lib/validate";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";

export interface MatchActionResult {
  success: boolean;
  message: string;
}

// ============================================================
// submitMatchScore — player-initiated score submission
// ============================================================
// Called from the player's dashboard. Validates that the
// calling user is actually in the match before delegating
// to the shared endMatchAction logic.
// ============================================================
export async function submitMatchScore(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  // Identify the calling player.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const supabase = await createServerSupabaseClient();

  // Verify this player is in the match (prevents spoofed submissions).
  // Use .maybeSingle() — .single() throws if 0 rows, which would surface
  // as a confusing error instead of the "not a player" message.
  const { data: mySlot } = await supabase
    .from("match_players")
    .select("id")
    .eq("match_id", matchId)
    .eq("player_id", user.id)
    .maybeSingle();

  if (!mySlot) {
    return { success: false, message: "You are not a player in this match." };
  }

  // Delegate to the shared action which handles scoring, court release,
  // re-queueing, auto-fill, and on-deck refill.
  return endMatchAction(matchId, teamAScore, teamBScore);
}

// ============================================================
// endMatchAction
// ============================================================
// Auth model:
//   Accepts two kinds of callers:
//     A. A session organizer (primary creator OR co-organizer)
//     B. A player who is in this specific match (via submitMatchScore)
//
//   The RLS client (supabase) is used for read-only auth lookups so
//   we don't leak rows outside the user's visibility. All writes use
//   the service client (db) — bypassing RLS entirely — because JS-
//   level auth is performed first and the old RLS path was silently
//   blocking the primary organizer (sessions.created_by) who never
//   has a session_organizers row.
// ============================================================
export async function endMatchAction(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };
  const db = createServiceClient();

  // P0-3: Require authentication.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // 1. Fetch the match (via service client — guarantees read succeeds
  //    regardless of any read-side RLS policy).
  const { data: match, error: matchFetchError } = await db
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  if (matchFetchError || !match) {
    return { success: false, message: `Match not found: ${matchFetchError?.message ?? "unknown"}` };
  }

  if (match.status === "completed" || match.status === "cancelled") {
    return { success: false, message: `Match is already ${match.status}.` };
  }

  // 1b. JS-level authorization: organizer OR player in this match.
  //    Run both checks in parallel to avoid serial round-trips.
  //    isSessionOrganizer checks sessions.created_by FIRST (fast path),
  //    then falls back to session_organizers membership.
  const [isOrg, playerSlot] = await Promise.all([
    isSessionOrganizer(user.id, match.session_id),
    db
      .from("match_players")
      .select("id")
      .eq("match_id", matchId)
      .eq("player_id", user.id)
      .maybeSingle(),
  ]);

  if (!isOrg && !playerSlot.data) {
    return {
      success: false,
      message: "Not authorized. You must be a session organizer or a player in this match.",
    };
  }

  // 2. P0-1: Atomic UPDATE — only succeeds if status is still "in_progress".
  //    Adding .eq("status", "in_progress") makes this a compare-and-swap:
  //    if a concurrent caller already changed the status, 0 rows are affected
  //    and `updatedRows` will be empty — we bail out instead of double-completing.
  //
  //    Uses the service client so the primary organizer (sessions.created_by)
  //    is never blocked. JS auth above is the gate; RLS is intentionally bypassed.
  //
  //    NOTE: Do NOT use .single() here. When the CAS guard causes 0 rows to be
  //    updated (concurrent request already completed the match), PostgREST returns
  //    an empty array — .single() throws "Cannot coerce the result to a single JSON
  //    object" instead of returning null, surfacing a confusing error to the player.
  const { data: updatedRows, error: matchUpdateError } = await db
    .from("matches")
    .update({
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      status: "completed" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .eq("status", "in_progress") // ← Atomic guard (CAS)
    .select("id");

  if (matchUpdateError) {
    return { success: false, message: `Failed to save scores: ${matchUpdateError.message}` };
  }
  if (!updatedRows || updatedRows.length === 0) {
    // 0 rows affected — another concurrent caller already completed/cancelled.
    return { success: false, message: "Match was already completed by another request." };
  }

  // 3. Fetch all players in this match.
  const { data: matchPlayers, error: playersError } = await db
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  if (playersError || !matchPlayers) {
    console.error("[endMatchAction] Failed to fetch match players:", playersError?.message);
    // Non-fatal — match is saved, continue with court auto-fill.
  }

  // 4. Re-queue all players: read real games_played from queue_entries
  //    (NOT from v_queue_with_wait_time — that view excludes "playing" status),
  //    increment by 1, reset to "waiting" with a fresh timestamp.
  //
  //    Status guard: only update rows where status is NOT "left".
  //    Without this guard, players who explicitly checked out while
  //    their match was in_progress would be silently re-added to the
  //    queue every time the match ended — creating ghost "waiting"
  //    entries for people who physically left the gym.
  const now = new Date().toISOString();
  if (matchPlayers && matchPlayers.length > 0) {
    await Promise.all(
      matchPlayers.map(async (mp) => {
        const { data: entry } = await db
          .from("queue_entries")
          .select("games_played")
          .eq("session_id", match.session_id)
          .eq("player_id", mp.player_id)
          .neq("status", "left") // skip players who already left
          .maybeSingle();

        // entry is null when the player's status is "left" — skip them.
        if (!entry) return;

        const updatedGames = (entry.games_played ?? 0) + 1;

        return db
          .from("queue_entries")
          .update({
            status: "waiting" as const,
            games_played: updatedGames,
            joined_at: now,
          })
          .eq("session_id", match.session_id)
          .eq("player_id", mp.player_id)
          .neq("status", "left"); // double-guard against race condition
      })
    );
  }

  // 5. PIPELINE: promote oldest on-deck match to the freed court.
  //    Then run the engine so it refills the on-deck slot (if toggle ON).
  //    If no on-deck match exists, free the court — the engine will form
  //    one for next time.
  //    Pass the service client so promotion writes are never RLS-blocked.
  if (match.court_id) {
    const promoted = await promoteOnDeckMatchInternal(db, match.session_id, match.court_id);

    if (!promoted.success) {
      // No on-deck match — free the court immediately.
      await db
        .from("courts")
        .update({ status: "available" as const })
        .eq("id", match.court_id);
    }
    // Either way, run the engine to refill on-deck from the queue.
    await runEngineForSession(match.session_id);
  }

  // 6. Refresh the all-time leaderboard materialized view.
  //    Fire without awaiting so a slow refresh never delays the player's UI.
  //    CONCURRENTLY means reads are never blocked during refresh.
  void db.rpc("refresh_alltime_leaderboard").then(({ error }) => {
    if (error) console.warn("[endMatchAction] leaderboard refresh failed:", error.message);
  });

  return { success: true, message: "Match completed. Players returned to queue." };
}

// ============================================================
// updateMatchDetails — Organizer score edit / revert to active
// ============================================================
// Two modes:
//   revertToActive=false → only corrects the scores on a
//     completed match. Status stays "completed".
//   revertToActive=true  → sets the match back to "in_progress",
//     clears scores/completed_at, reclaims the court if free,
//     and reverts each player's queue_entries row to "playing"
//     with games_played decremented by 1. Use this when a player
//     accidentally submitted the score before the game finished.
// ============================================================
export async function updateMatchDetails(
  matchId: string,
  teamAScore: number,
  teamBScore: number,
  revertToActive = false
): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };
  // All writes use the service client so the primary organizer
  // (sessions.created_by) is never silently blocked by write-side RLS.
  // Auth is verified at the JS layer (getUser + isSessionOrganizer) before any write.
  const db = createServiceClient();

  // P0-3: Organizer-only action.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const { data: match, error: fetchErr } = await db
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  if (fetchErr || !match) {
    return { success: false, message: "Match not found." };
  }

  // Verify caller is an organizer for this session.
  const organizer = await isSessionOrganizer(user.id, match.session_id);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (!revertToActive) {
    // ── Score-only edit ──────────────────────────────────────
    const { error } = await db
      .from("matches")
      .update({ team_a_score: teamAScore, team_b_score: teamBScore })
      .eq("id", matchId);

    if (error) return { success: false, message: "Failed to update scores." };
    return { success: true, message: "Scores updated." };
  }

  // ── Revert to in_progress ────────────────────────────────
  // Try the atomic RPC first (migration 20260512200003).
  // The RPC reverts the match status + bulk-updates all roster players
  // from 'waiting' → 'playing' (games_played - 1) in one transaction,
  // eliminating the N+1 round-trip loop and its silent failure modes.
  const { error: rpcRevertErr } = await db.rpc("revert_match_to_active", {
    p_match_id: matchId,
    p_session_id: match.session_id,
  });

  if (rpcRevertErr && rpcRevertErr.code !== "PGRST202") {
    // RPC exists but returned a domain error.
    const msg = rpcRevertErr.message ?? "";
    if (msg.includes("MATCH_NOT_FOUND")) {
      return { success: false, message: "Match not found." };
    }
    return { success: false, message: "Failed to revert match." };
  }

  if (rpcRevertErr?.code === "PGRST202") {
    // RPC not yet deployed — fall back to the original non-atomic sequence.
    const { error: revertErr } = await db
      .from("matches")
      .update({
        status: "in_progress" as const,
        team_a_score: null,
        team_b_score: null,
        completed_at: null,
      })
      .eq("id", matchId);

    if (revertErr) return { success: false, message: "Failed to revert match." };

    const { data: matchPlayers } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", matchId);

    if (matchPlayers && matchPlayers.length > 0) {
      await Promise.all(
        matchPlayers.map(async (mp) => {
          const { data: entry } = await db
            .from("queue_entries")
            .select("games_played, status")
            .eq("session_id", match.session_id)
            .eq("player_id", mp.player_id)
            .maybeSingle();

          if (entry?.status === "waiting") {
            return db
              .from("queue_entries")
              .update({
                status: "playing" as const,
                games_played: Math.max(0, (entry.games_played ?? 1) - 1),
              })
              .eq("session_id", match.session_id)
              .eq("player_id", mp.player_id);
          }
        })
      );
    }
  }

  // Court handling: reclaim if free, detach if occupied or closed.
  // Kept in JS (not in RPC) — conditional court logic, not part of
  // the player-state race condition that the RPC targets.
  if (match.court_id) {
    const { data: court } = await db
      .from("courts")
      .select("status")
      .eq("id", match.court_id)
      .single();

    if (court?.status === "available") {
      await db
        .from("courts")
        .update({ status: "in_use" as const })
        .eq("id", match.court_id);
    } else {
      // Another match occupies or the court is closed — detach.
      await db.from("matches").update({ court_id: null }).eq("id", matchId);
    }
  }

  return { success: true, message: "Match reverted. Players can re-submit the correct score." };
}

// ============================================================
// cancelMatchAction
// ============================================================
export async function cancelMatchAction(matchId: string): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };
  const db = createServiceClient();

  // All DB writes use db (service client) so the primary organizer
  // (sessions.created_by) is never silently blocked by write-side RLS.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // 1. Fetch the match (service client — guarantees read succeeds regardless
  //    of read-side RLS policies).
  const { data: match, error: matchFetchError } = await db
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  if (matchFetchError || !match) {
    return { success: false, message: `Match not found: ${matchFetchError?.message ?? "unknown"}` };
  }

  // Verify caller is an organizer for this session.
  const organizer = await isSessionOrganizer(user.id, match.session_id);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (match.status === "completed" || match.status === "cancelled") {
    return { success: false, message: `Match is already ${match.status}.` };
  }

  // 2. P0-1: Atomic UPDATE — guard against double-cancellation.
  //    Only succeeds if the match is still in a cancellable state.
  //
  //    NOTE: Do NOT use .single() here. When .in("status", [...]) matches
  //    0 rows (already cancelled/completed), PostgREST returns an empty array
  //    and .single() throws "Cannot coerce the result to a single JSON object"
  //    instead of returning null.
  const { data: cancelledRows, error: matchUpdateError } = await db
    .from("matches")
    .update({
      status: "cancelled" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .in("status", ["pending", "in_progress"]) // ← Atomic guard (CAS)
    .select("id");

  if (matchUpdateError) {
    return { success: false, message: `Failed to cancel match: ${matchUpdateError.message}` };
  }
  if (!cancelledRows || cancelledRows.length === 0) {
    return {
      success: false,
      message: "Match was already cancelled or completed by another request.",
    };
  }

  // 3. Return players to queue WITHOUT incrementing games_played.
  //    Done BEFORE running the engine so returned players are visible
  //    to the matchmaker and can be included in new on-deck matches.
  //
  //    Status guard: only restore players whose current status is NOT
  //    "left". A player who manually checked out while on_deck / in a
  //    pending match should not be pulled back into the queue just
  //    because the organizer later cancelled the match.
  const { data: matchPlayers } = await db
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  let playerIds: string[] = [];
  if (matchPlayers && matchPlayers.length > 0) {
    playerIds = matchPlayers.map((mp) => mp.player_id);
    await db
      .from("queue_entries")
      .update({ status: "waiting" as const })
      .eq("session_id", match.session_id)
      .in("player_id", playerIds)
      .neq("status", "left"); // skip players who already checked out
  }

  // 4. PIPELINE: promote oldest on-deck match to the freed court.
  //    If no on-deck match exists, free the court immediately.
  //    Mirrors the endMatchAction pipeline so behaviour is consistent.
  if (match.court_id) {
    const promoted = await promoteOnDeckMatchInternal(db, match.session_id, match.court_id);
    if (!promoted.success) {
      // Nothing on deck — free the court for manual use.
      await db
        .from("courts")
        .update({ status: "available" as const })
        .eq("id", match.court_id);
    }
  }

  // 5. Refill on-deck pool (engine exits silently if toggle is OFF).
  await runEngineForSession(match.session_id);

  // 6. Notify affected players via Realtime Broadcast so their dashboards
  //    show a friendly explanation instead of a silent state change.
  if (playerIds.length > 0) {
    await broadcastOrganizerIntervention(match.session_id, "match_cancelled", playerIds);
  }

  return { success: true, message: "Match cancelled. Players returned to queue." };
}

// ============================================================
// createManualMatchAction — Organizer-only (P1-2)
// ============================================================
// Moved from the client-side hook to a server action so all
// validation and DB writes run server-side. This prevents a
// disconnected browser from leaving courts permanently in_use
// with no active match row.
// ============================================================
export interface CreateManualMatchResult {
  success: boolean;
  message: string;
  matchId?: string;
}

export async function createManualMatchAction(
  sessionId: string,
  teamAPlayerIds: string[],
  teamBPlayerIds: string[]
): Promise<CreateManualMatchResult> {
  if (!isValidUUID(sessionId)) return { success: false, message: "Invalid session ID." };
  // Validate each player ID in both arrays before any DB call.
  // (allPlayerIds is also used later in the function; a different name avoids redeclaration.)
  const combinedPlayerIds = [...teamAPlayerIds, ...teamBPlayerIds];
  if (combinedPlayerIds.length === 0 || combinedPlayerIds.some((id) => !isValidUUID(id))) {
    return { success: false, message: "Invalid player ID in match." };
  }
  // Auth + organizer check.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }
  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  const allPlayerIds = [...teamAPlayerIds, ...teamBPlayerIds];
  const svc = createServiceClient();

  // Validate all players are in this session's queue (any status).
  // Gives a clear "not in session" error before hitting the RPC.
  const { data: queueEntries } = await svc
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId)
    .in("player_id", allPlayerIds);

  const foundPlayerIds = new Set((queueEntries ?? []).map((e) => e.player_id));
  const missingPlayers = allPlayerIds.filter((id) => !foundPlayerIds.has(id));
  if (missingPlayers.length > 0) {
    return { success: false, message: "One or more selected players are not in this session." };
  }

  // Compute is_mixed_level from player skill levels.
  const { data: playerProfiles } = await svc
    .from("profiles")
    .select("skill_level")
    .in("id", allPlayerIds);
  const skillLevels = new Set((playerProfiles ?? []).map((p) => p.skill_level));
  const isMixedLevel = skillLevels.size > 1;

  // Single atomic write via the create_match_with_players RPC.
  //
  // Routing through the RPC gives us all three TOCTOU guards for free:
  //   Guard 0 — pre-flight: all players must be 'waiting' (blocks 'left',
  //             'on_deck', 'playing' — prevents assigning an already-committed player)
  //   Guard 1 — row-level lock on queue_entries, preventing concurrent
  //             engine/manual runs from double-booking the same player
  //   Guard 2 — post-lock conflict check: no player may already appear in
  //             another pending/in_progress match_players row
  //
  // The RPC also handles queue promotion atomically: with
  // p_is_published=true it updates all players to 'on_deck' inside the
  // same transaction, so the Jackie B / Carlo partial-update bug cannot
  // recur regardless of which Supabase client was used to invoke it.
  const { data: matchId, error: rpcError } = await svc.rpc("create_match_with_players", {
    p_session_id: sessionId,
    p_court_id: null,
    p_status: "pending",
    p_is_mixed_level: isMixedLevel,
    p_started_at: null,
    p_is_on_deck: true,
    p_team_a_ids: teamAPlayerIds,
    p_team_b_ids: teamBPlayerIds,
    p_origin: "manual",
    p_is_published: true,
  });

  if (rpcError) {
    return { success: false, message: rpcError.message };
  }

  if (!matchId) {
    // RPC returned NULL: Guard 0 or Guard 2 fired — a player is not
    // 'waiting' or is already committed to another active match.
    return {
      success: false,
      message:
        "Could not create match — one or more players are unavailable or already assigned to an active match.",
    };
  }

  return { success: true, message: "Match added to On Deck.", matchId };
}
