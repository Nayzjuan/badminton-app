"use server";

// ============================================================
// Match Server Actions — End Match & Cancel Match
// ============================================================
// These run on the server with the user's authenticated session,
// so they respect RLS while having reliable access to DB state.
//
// Why server actions instead of client-side hook calls?
// -------------------------------------------------------
// endMatch previously looked up `games_played` from the React
// `queue` state — but that state comes from v_queue_with_wait_time,
// which only shows "waiting" players. Players currently in a match
// have status "playing" and are excluded from that view. So
// `queue.find()` always returned undefined, meaning games_played
// was always reset to 1 instead of being properly incremented.
//
// Here we query queue_entries directly from the server, where we
// get the real current value regardless of status.
// ============================================================

import { createClient } from "@/utils/supabase/server";

export interface MatchActionResult {
  success: boolean;
  message: string;
}

// ============================================================
// endMatchAction
// ============================================================
// 1. Marks the match as completed with final scores.
// 2. Frees the court (status → available).
// 3. For each player: reads their real games_played from
//    queue_entries, increments it by 1, resets status to
//    "waiting" with a fresh joined_at so they re-queue.
// ============================================================
export async function endMatchAction(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  const supabase = await createClient();

  // 1. Fetch the match so we have session_id and court_id.
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

  // 3. Free the court.
  if (match.court_id) {
    const { error: courtError } = await supabase
      .from("courts")
      .update({ status: "available" as const })
      .eq("id", match.court_id);

    if (courtError) {
      console.error("[endMatchAction] Failed to free court:", courtError.message);
      // Non-fatal — match is already saved.
    }
  }

  // 4. Fetch all players in this match.
  const { data: matchPlayers, error: playersError } = await supabase
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  if (playersError || !matchPlayers) {
    console.error("[endMatchAction] Failed to fetch match players:", playersError?.message);
    return { success: true, message: "Match completed, but failed to re-queue players." };
  }

  // 5. For each player, read their real games_played from queue_entries
  //    (NOT from v_queue_with_wait_time — that view excludes "playing" status),
  //    then increment and reset to waiting with a fresh timestamp.
  const now = new Date().toISOString();
  const requeueResults = await Promise.all(
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
          joined_at: now, // Fresh timestamp so wait time resets.
        })
        .eq("session_id", match.session_id)
        .eq("player_id", mp.player_id);
    })
  );

  const requeueErrors = requeueResults.filter((r) => r.error);
  if (requeueErrors.length > 0) {
    console.error("[endMatchAction] Some players failed to re-queue:", requeueErrors);
  }

  return { success: true, message: "Match completed. Players returned to queue." };
}

// ============================================================
// cancelMatchAction
// ============================================================
// 1. Marks the match as cancelled.
// 2. Frees the court (status → available).
// 3. Returns all 4 players to the queue WITHOUT incrementing
//    games_played — they were never able to play, so they
//    keep their priority position.
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

  // 3. Free the court.
  if (match.court_id) {
    await supabase
      .from("courts")
      .update({ status: "available" as const })
      .eq("id", match.court_id);
  }

  // 4. Return players to queue. Do NOT increment games_played —
  //    they never played. Keep their original joined_at so their
  //    queue priority is preserved as if the match never happened.
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

  return { success: true, message: "Match cancelled. Players returned to queue." };
}
