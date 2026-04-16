"use server";

// ============================================================
// Match Server Actions — End Match, Cancel Match, Manual Match
// ============================================================
// endMatchAction
//   1. Auth guard — caller must be authenticated.
//   2. Atomic UPDATE (status guard) prevents double-completion.
//   3. Marks match completed with scores.
//   4. Re-queues all 4 players with incremented games_played.
//   5. AUTO-FILL: promotes the oldest on-deck match to the freed court.
//   6. Refills the on-deck pool with generateOnDeckMatchesInternal.
//
// cancelMatchAction
//   1. Organizer-only auth guard.
//   2. Atomic UPDATE (status guard) prevents double-cancellation.
//   3. Marks match cancelled.
//   4. Frees court (available).
//   5. Returns players to queue WITHOUT incrementing games_played.
//   6. Refills the on-deck pool.
//
// updateMatchDetails — organizer-only score correction / revert.
//
// createManualMatchAction — organizer-only court assignment with
//   chosen players. Moved from client-side hook to server action
//   so all business-logic validation runs server-side.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import {
  promoteOnDeckMatchInternal,
  generateOnDeckMatchesAction,
} from "@/app/actions/matchmaking";

export interface MatchActionResult {
  success: boolean;
  message: string;
}

// ─── Auth helpers ─────────────────────────────────────────────

/**
 * Verify that the calling user is authenticated.
 * Returns the user object or null.
 */
async function getAuthUser(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * Verify that the calling user is an organizer for the given session.
 * Accepts either created_by ownership OR a session_organizers membership row.
 */
async function isSessionOrganizer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  sessionId: string
): Promise<boolean> {
  // Check sessions.created_by first (fast path).
  const { data: session } = await supabase
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .single();

  if (session?.created_by === userId) return true;

  // Fall back to session_organizers membership table.
  const { data: membership } = await supabase
    .from("session_organizers")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .single();

  return !!membership;
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
  const supabase = await createClient();

  // Identify the calling player.
  const user = await getAuthUser(supabase);
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // Verify this player is in the match (prevents spoofed submissions).
  const { data: mySlot } = await supabase
    .from("match_players")
    .select("id")
    .eq("match_id", matchId)
    .eq("player_id", user.id)
    .single();

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
export async function endMatchAction(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  const supabase = await createClient();

  // P0-3: Require authentication — organizer or player (via submitMatchScore).
  const user = await getAuthUser(supabase);
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // 1. Fetch the match.
  const { data: match, error: matchFetchError } = await supabase
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

  // 2. P0-1: Atomic UPDATE — only succeeds if status is still "in_progress".
  //    Adding .eq("status", "in_progress") makes this a compare-and-swap:
  //    if a concurrent caller already changed the status, 0 rows are affected
  //    and `updatedMatch` will be null — we bail out instead of double-completing.
  const { data: updatedMatch, error: matchUpdateError } = await supabase
    .from("matches")
    .update({
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      status: "completed" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .eq("status", "in_progress")   // ← Atomic guard (CAS)
    .select("id")
    .single();

  if (matchUpdateError || !updatedMatch) {
    // Either a DB error OR another concurrent caller already completed/cancelled
    // this match. Return a friendly message — the match IS done, just not by us.
    if (!updatedMatch && !matchUpdateError) {
      return { success: false, message: "Match was already completed by another request." };
    }
    return { success: false, message: `Failed to save scores: ${matchUpdateError?.message}` };
  }

  // 3. Fetch all players in this match.
  const { data: matchPlayers, error: playersError } = await supabase
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
  const now = new Date().toISOString();
  if (matchPlayers && matchPlayers.length > 0) {
    await Promise.all(
      matchPlayers.map(async (mp) => {
        const { data: entry } = await supabase
          .from("queue_entries")
          .select("games_played")
          .eq("session_id", match.session_id)
          .eq("player_id", mp.player_id)
          .single();

        const updatedGames = (entry?.games_played ?? 0) + 1;

        return supabase
          .from("queue_entries")
          .update({
            status: "waiting" as const,
            games_played: updatedGames,
            joined_at: now,
          })
          .eq("session_id", match.session_id)
          .eq("player_id", mp.player_id);
      })
    );
  }

  // 5. AUTO-FILL: if there is an on-deck match ready, promote it to this court immediately.
  //    This is the core of the automated system — courts never idle after a scored match.
  if (match.court_id) {
    const promoted = await promoteOnDeckMatchInternal(supabase, match.session_id, match.court_id);

    if (!promoted.success) {
      // No on-deck match to promote — just free the court for manual use.
      await supabase
        .from("courts")
        .update({ status: "available" as const })
        .eq("id", match.court_id);
    }
    // If promotion succeeded, the court was already marked in_use by promoteOnDeckMatchInternal.
  }

  // 6. Refill the on-deck pool now that 4 players have re-joined the waiting list
  //    and (possibly) one pending slot was consumed by the auto-fill above.
  await generateOnDeckMatchesAction(match.session_id);

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
  const supabase = await createClient();

  // P0-3: Organizer-only action.
  const user = await getAuthUser(supabase);
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const { data: match, error: fetchErr } = await supabase
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  if (fetchErr || !match) {
    return { success: false, message: `Match not found: ${fetchErr?.message ?? "unknown"}` };
  }

  // Verify caller is an organizer for this session.
  const organizer = await isSessionOrganizer(supabase, user.id, match.session_id);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (!revertToActive) {
    // ── Score-only edit ──────────────────────────────────────
    const { error } = await supabase
      .from("matches")
      .update({ team_a_score: teamAScore, team_b_score: teamBScore })
      .eq("id", matchId);

    if (error) return { success: false, message: error.message };
    return { success: true, message: "Scores updated." };
  }

  // ── Revert to in_progress ────────────────────────────────
  const { error: revertErr } = await supabase
    .from("matches")
    .update({
      status: "in_progress" as const,
      team_a_score: null,
      team_b_score: null,
      completed_at: null,
    })
    .eq("id", matchId);

  if (revertErr) return { success: false, message: revertErr.message };

  // Court handling: reclaim if free, detach if occupied or closed.
  if (match.court_id) {
    const { data: court } = await supabase
      .from("courts")
      .select("status")
      .eq("id", match.court_id)
      .single();

    if (court?.status === "available") {
      await supabase
        .from("courts")
        .update({ status: "in_use" as const })
        .eq("id", match.court_id);
    } else {
      // Another match occupies or the court is closed — detach.
      await supabase
        .from("matches")
        .update({ court_id: null })
        .eq("id", matchId);
    }
  }

  // Revert player queue entries that are currently "waiting"
  // (meaning endMatchAction already re-queued them).
  const { data: matchPlayers } = await supabase
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  if (matchPlayers && matchPlayers.length > 0) {
    await Promise.all(
      matchPlayers.map(async (mp) => {
        const { data: entry } = await supabase
          .from("queue_entries")
          .select("games_played, status")
          .eq("session_id", match.session_id)
          .eq("player_id", mp.player_id)
          .single();

        // Only revert players currently waiting — those already in
        // another on_deck / playing match are left untouched.
        if (entry?.status === "waiting") {
          return supabase
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

  return { success: true, message: "Match reverted. Players can re-submit the correct score." };
}

// ============================================================
// cancelMatchAction
// ============================================================
export async function cancelMatchAction(matchId: string): Promise<MatchActionResult> {
  const supabase = await createClient();

  // P0-3: Organizer-only action.
  const user = await getAuthUser(supabase);
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // 1. Fetch the match.
  const { data: match, error: matchFetchError } = await supabase
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  if (matchFetchError || !match) {
    return { success: false, message: `Match not found: ${matchFetchError?.message ?? "unknown"}` };
  }

  // Verify caller is an organizer for this session.
  const organizer = await isSessionOrganizer(supabase, user.id, match.session_id);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (match.status === "completed" || match.status === "cancelled") {
    return { success: false, message: `Match is already ${match.status}.` };
  }

  // 2. P0-1: Atomic UPDATE — guard against double-cancellation.
  //    Only succeeds if the match is still in a cancellable state.
  const { data: cancelledMatch, error: matchUpdateError } = await supabase
    .from("matches")
    .update({
      status: "cancelled" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .in("status", ["pending", "in_progress"])  // ← Atomic guard (CAS)
    .select("id")
    .single();

  if (matchUpdateError || !cancelledMatch) {
    if (!cancelledMatch && !matchUpdateError) {
      return { success: false, message: "Match was already cancelled or completed by another request." };
    }
    return { success: false, message: `Failed to cancel match: ${matchUpdateError?.message}` };
  }

  // 3. Free the court — available for manual organizer use.
  //    Intentionally NOT calling promoteOnDeckMatchInternal here so the
  //    organizer can choose to start a custom match via the Queue Control tab.
  if (match.court_id) {
    await supabase
      .from("courts")
      .update({ status: "available" as const })
      .eq("id", match.court_id);
  }

  // 4. Return players to queue WITHOUT incrementing games_played.
  //    They keep their priority position as if the match never happened.
  const { data: matchPlayers } = await supabase
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  if (matchPlayers && matchPlayers.length > 0) {
    const playerIds = matchPlayers.map((mp) => mp.player_id);
    await supabase
      .from("queue_entries")
      .update({ status: "waiting" as const })
      .eq("session_id", match.session_id)
      .in("player_id", playerIds);
  }

  // 5. Refill the on-deck pool. The returned players are now waiting again,
  //    so they can potentially form new on-deck matches.
  //    Court is intentionally left available (no auto-promotion).
  await generateOnDeckMatchesAction(match.session_id);

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
  courtId: string,
  teamAPlayerIds: string[],
  teamBPlayerIds: string[]
): Promise<CreateManualMatchResult> {
  const supabase = await createClient();

  // Auth + organizer check.
  const user = await getAuthUser(supabase);
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }
  const organizer = await isSessionOrganizer(supabase, user.id, sessionId);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // Validate the court belongs to this session.
  const { data: court } = await supabase
    .from("courts")
    .select("id, status")
    .eq("id", courtId)
    .eq("session_id", sessionId)
    .single();

  if (!court) {
    return { success: false, message: "Court not found in this session." };
  }

  // Validate all players are in this session's queue.
  const allPlayerIds = [...teamAPlayerIds, ...teamBPlayerIds];
  const { data: queueEntries } = await supabase
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId)
    .in("player_id", allPlayerIds);

  const foundPlayerIds = new Set((queueEntries ?? []).map((e) => e.player_id));
  const missingPlayers = allPlayerIds.filter((id) => !foundPlayerIds.has(id));
  if (missingPlayers.length > 0) {
    return { success: false, message: "One or more selected players are not in this session." };
  }

  // 1. Create the match row.
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
    return { success: false, message: matchError?.message ?? "Failed to create match." };
  }

  // 2. Assign players to the match.
  const playerRows = [
    ...teamAPlayerIds.map((pid) => ({ match_id: match.id, player_id: pid, team: "a" as const })),
    ...teamBPlayerIds.map((pid) => ({ match_id: match.id, player_id: pid, team: "b" as const })),
  ];

  const { error: playersError } = await supabase.from("match_players").insert(playerRows);
  if (playersError) {
    // Roll back the match row to avoid an orphaned match.
    await supabase.from("matches").delete().eq("id", match.id);
    return { success: false, message: playersError.message };
  }

  // 3. Mark the court in_use.
  await supabase
    .from("courts")
    .update({ status: "in_use" as const })
    .eq("id", courtId);

  // 4. Mark all players as "playing" in the queue.
  await supabase
    .from("queue_entries")
    .update({ status: "playing" as const })
    .eq("session_id", sessionId)
    .in("player_id", allPlayerIds);

  return { success: true, message: "Match created.", matchId: match.id };
}
