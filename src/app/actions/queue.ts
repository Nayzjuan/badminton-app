"use server";

// ============================================================
// Queue Server Actions
// ============================================================
// joinQueueAction replaces the client-side supabase.rpc("rejoin_queue")
// call so we can apply Inherited Games logic before inserting a
// brand-new queue_entries row.
//
// The problem with plain RPC / INSERT games_played=0
// ---------------------------------------------------
// The matchmaking primary sort is games_played ASC, joined_at ASC.
// A player joining 2 hours into a session with games_played=0
// would land at position #1, ahead of players who have been
// waiting their turn. That is unfair.
//
// The fix: Inherited Games
// -------------------------
// When a player's queue_entries row for this session does NOT
// yet exist (true first-time joiner), we query the minimum
// games_played across every currently active player (waiting,
// on_deck, playing). The new row is inserted with that minimum
// instead of 0.
//
// Because their joined_at is brand-new, they will sort AFTER
// everyone else who shares that same games_played tier — going
// to the absolute back of the line while still being treated
// fairly as a peer once others cycle past them.
//
// Returning players (row already exists with any status)
// -------------------------------------------------------
// We simply reset status → "waiting" and update joined_at
// to now, preserving their real accumulated games_played.
// This mirrors what the old rejoin_queue RPC did.
//
// Edge cases
// ----------
// • Empty session (no active players) → inheritedGames = 0
// • All active players at games_played=0 → inheritedGames = 0
//   (new joiner starts at 0 too, which is correct)
// • Player already playing/on_deck → operation succeeds but
//   has no practical effect; the UI should prevent this path.
// ============================================================

import { createClient } from "@/utils/supabase/server";

export interface JoinQueueResult {
  error?: string;
}

export async function joinQueueAction(sessionId: string): Promise<JoinQueueResult> {
  const supabase = await createClient();

  // Resolve the caller's identity server-side so the client
  // cannot spoof a different player_id.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "Not authenticated. Please refresh and try again." };
  }

  const playerId = user.id;

  // ----------------------------------------------------------
  // 1. Check for an existing queue entry for this player+session
  // ----------------------------------------------------------
  const { data: existing, error: fetchError } = await supabase
    .from("queue_entries")
    .select("id, games_played, status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();

  if (fetchError) {
    return { error: fetchError.message };
  }

  // ----------------------------------------------------------
  // 2a. RETURNING PLAYER — row already exists
  //     Reset to waiting + fresh joined_at, keep games_played.
  // ----------------------------------------------------------
  if (existing) {
    const { error: updateError } = await supabase
      .from("queue_entries")
      .update({
        status: "waiting" as const,
        joined_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (updateError) return { error: updateError.message };
    return {};
  }

  // ----------------------------------------------------------
  // 2b. FIRST-TIME JOINER — no row yet
  //
  //     Query the session floor: minimum games_played among all
  //     players currently active (waiting OR on_deck OR playing).
  //     We include "playing" so that a session where everyone
  //     is mid-match doesn't look empty and give the joiner 0.
  // ----------------------------------------------------------
  const { data: floorRow, error: floorError } = await supabase
    .from("queue_entries")
    .select("games_played")
    .eq("session_id", sessionId)
    .in("status", ["waiting", "on_deck", "playing"])
    .order("games_played", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (floorError) {
    // Non-fatal: fall back to 0 rather than blocking the join.
    console.error("[joinQueueAction] floor query failed:", floorError.message);
  }

  // Default to 0 if the session is empty or the query failed.
  const inheritedGames: number = floorRow?.games_played ?? 0;

  // ----------------------------------------------------------
  // 3. Insert the new row with the inherited games_played floor
  // ----------------------------------------------------------
  const { error: insertError } = await supabase.from("queue_entries").insert({
    session_id: sessionId,
    player_id: playerId,
    status: "waiting" as const,
    games_played: inheritedGames,
    joined_at: new Date().toISOString(),
  });

  if (insertError) return { error: insertError.message };
  return {};
}
