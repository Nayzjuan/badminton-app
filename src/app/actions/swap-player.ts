"use server";

// ============================================================
// swapPlayerInMatch — Tap-to-Swap Server Action
// ============================================================
// Surgically replaces one player in a pending (on-deck) match
// with another player from the waiting queue.
//
// Safety model (three pre-write guards):
//   1. Auth + organizer check
//   2. match.status === "pending" guard  (MATCH_STARTED)
//   3. outPlayer still in match_players  (PLAYER_NOT_IN_MATCH)
//   4. inPlayer queue_entries.status === "waiting" (PLAYER_UNAVAILABLE)
//
// Writes (single atomic Postgres transaction via swap_player_in_match RPC):
//   a. DELETE outPlayerId from match_players
//   b. INSERT inPlayerId  into match_players (same team)
//   c. UPDATE inPlayerId  queue_entries → "on_deck"
//   d. UPDATE outPlayerId queue_entries → "waiting"
//   e. Recompute is_mixed_level from current roster (COUNT DISTINCT skill_level)
//
// Atomicity: if the server crashes at any point Postgres rolls back the
// entire transaction automatically — no partial-state corruption possible.
//
// Concurrent swap safety:
//   - Scenario A (same outgoing player):    guard 3 returns PLAYER_NOT_IN_MATCH
//   - Scenario B (same incoming player):    guard 4 returns PLAYER_UNAVAILABLE
//   - Scenario C (different slots, same match): row-level isolation, step e handles is_mixed_level
//   - Scenario D (double-tap):              isConfirming UI flag + guard 3 fallback
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";

// ── Return types ──────────────────────────────────────────────

export type SwapErrorCode =
  | "MATCH_STARTED"       // match.status !== "pending" — close Sheet + toast
  | "PLAYER_UNAVAILABLE"  // inPlayer not in "waiting" — keep Sheet open, re-pick
  | "PLAYER_NOT_IN_MATCH"; // outPlayer already gone  — close Sheet + info toast

export type SwapResult = {
  success: boolean;
  message: string;
  errorCode?: SwapErrorCode;
};

// ── Auth helpers (mirrors pattern in match.ts) ────────────────

async function getAuthUser(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

async function isSessionOrganizer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const { data: session } = await supabase
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .single();

  if (session?.created_by === userId) return true;

  const { data: membership } = await supabase
    .from("session_organizers")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .single();

  return !!membership;
}

// ── Main action ───────────────────────────────────────────────

export async function swapPlayerInMatch(
  matchId: string,
  outPlayerId: string,
  inPlayerId: string
): Promise<SwapResult> {
  // Use RLS client for auth verification, service client for all DB writes
  // so Row Level Security doesn't interfere with cross-user mutations.
  const supabase = await createClient();
  const db = createServiceClient();

  // ── Guard 1: Authentication ───────────────────────────────
  const user = await getAuthUser(supabase);
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // ── Guard 2: Match status — must still be pending ─────────
  // Read via service client so RLS doesn't block.
  const { data: match } = await db
    .from("matches")
    .select("id, status, session_id")
    .eq("id", matchId)
    .single();

  if (!match) {
    return {
      success: false,
      errorCode: "MATCH_STARTED",
      message: "Match not found.",
    };
  }

  if (match.status !== "pending") {
    return {
      success: false,
      errorCode: "MATCH_STARTED",
      message: "This match has already started — the swap was cancelled automatically.",
    };
  }

  // ── Organizer auth (requires sessionId from match) ────────
  const organizer = await isSessionOrganizer(supabase, user.id, match.session_id);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // ── Guard 3: outPlayer must still be in this match ────────
  const { data: outPlayerRow } = await db
    .from("match_players")
    .select("id, team")
    .eq("match_id", matchId)
    .eq("player_id", outPlayerId)
    .maybeSingle();

  if (!outPlayerRow) {
    return {
      success: false,
      errorCode: "PLAYER_NOT_IN_MATCH",
      message: "This player was already swapped out.",
    };
  }

  // ── Guard 4: inPlayer must be waiting in the queue ────────
  const { data: inPlayerEntry } = await db
    .from("queue_entries")
    .select("id, status")
    .eq("session_id", match.session_id)
    .eq("player_id", inPlayerId)
    .maybeSingle();

  if (!inPlayerEntry || inPlayerEntry.status !== "waiting") {
    return {
      success: false,
      errorCode: "PLAYER_UNAVAILABLE",
      message: "This player is no longer available.",
    };
  }

  // ── Atomic write: all 4 steps + is_mixed_level recompute ─
  // Runs inside a single Postgres transaction via the
  // swap_player_in_match RPC (migration 20260420000000).
  // If the server crashes mid-execution Postgres rolls back
  // automatically — no manual compensation needed.
  const { error: swapError } = await db.rpc("swap_player_in_match", {
    p_match_id:      matchId,
    p_out_player_id: outPlayerId,
    p_in_player_id:  inPlayerId,
    p_session_id:    match.session_id,
    p_team:          outPlayerRow.team,
  });

  if (swapError) {
    return { success: false, message: `Failed to swap: ${swapError.message}` };
  }

  // ── Broadcast: notify outgoing player their on-deck slot is gone
  // The incoming player's dashboard will update via subscribeToMatchPlayers
  // Postgres realtime (new match_players row fires fetchMyMatch).
  await broadcastOrganizerIntervention(
    match.session_id,
    "on_deck_cleared",
    [outPlayerId]
  );

  return { success: true, message: "Swap complete." };
}
