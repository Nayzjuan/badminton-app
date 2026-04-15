"use server";

// ============================================================
// Match Server Actions — End Match & Cancel Match
// ============================================================
// endMatchAction
//   1. Marks match completed with scores.
//   2. Frees court (available).
//   3. Re-queues all 4 players with incremented games_played.
//   4. AUTO-FILL: promotes the oldest on-deck match to the freed court.
//   5. Refills the on-deck pool with generateOnDeckMatchesInternal.
//
// cancelMatchAction
//   1. Marks match cancelled.
//   2. Frees court (available).
//   3. Returns players to queue WITHOUT incrementing games_played.
//   4. Refills the on-deck pool (cancelled players can now form new on-deck).
//   5. Does NOT auto-promote — court stays "available" for manual organizer use.
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
  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  // 2. Mark match completed with scores.
  const { error: matchUpdateError } = await supabase
    .from("matches")
    .update({
      team_a_score: teamAScore,
      team_b_score: teamBScore,
      status: "completed" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId);

  if (matchUpdateError) {
    return { success: false, message: `Failed to save scores: ${matchUpdateError.message}` };
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

  const { data: match, error: fetchErr } = await supabase
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  if (fetchErr || !match) {
    return { success: false, message: `Match not found: ${fetchErr?.message ?? "unknown"}` };
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

  // 2. Mark match cancelled.
  const { error: matchUpdateError } = await supabase
    .from("matches")
    .update({
      status: "cancelled" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId);

  if (matchUpdateError) {
    return { success: false, message: `Failed to cancel match: ${matchUpdateError.message}` };
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
