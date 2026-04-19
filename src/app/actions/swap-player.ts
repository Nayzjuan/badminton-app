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
// Writes (sequential with compensation on failure):
//   a. DELETE outPlayerId from match_players
//   b. INSERT inPlayerId  into match_players (same team)
//   c. UPDATE inPlayerId  queue_entries → "on_deck"
//   d. UPDATE outPlayerId queue_entries → "waiting"
//   e. READ-AFTER-WRITE: recompute is_mixed_level from current players
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

  // ── Write step a: DELETE outPlayerId from match_players ───
  const { error: deleteError } = await db
    .from("match_players")
    .delete()
    .eq("match_id", matchId)
    .eq("player_id", outPlayerId);

  if (deleteError) {
    return { success: false, message: `Failed to swap: ${deleteError.message}` };
  }

  // ── Write step b: INSERT inPlayerId (same team) ───────────
  const { error: insertError } = await db.from("match_players").insert({
    match_id: matchId,
    player_id: inPlayerId,
    team: outPlayerRow.team,
  });

  if (insertError) {
    // Compensation: re-insert outPlayerId to restore original state.
    await db.from("match_players").insert({
      match_id: matchId,
      player_id: outPlayerId,
      team: outPlayerRow.team,
    });
    return { success: false, message: `Failed to swap: ${insertError.message}` };
  }

  // ── Write step c: inPlayerId → "on_deck" ─────────────────
  const { error: inUpdateError } = await db
    .from("queue_entries")
    .update({ status: "on_deck" as const })
    .eq("session_id", match.session_id)
    .eq("player_id", inPlayerId);

  if (inUpdateError) {
    // Compensation: undo the insert, re-insert outPlayerId.
    await db
      .from("match_players")
      .delete()
      .eq("match_id", matchId)
      .eq("player_id", inPlayerId);
    await db.from("match_players").insert({
      match_id: matchId,
      player_id: outPlayerId,
      team: outPlayerRow.team,
    });
    return { success: false, message: `Failed to swap: ${inUpdateError.message}` };
  }

  // ── Write step d: outPlayerId → "waiting" ────────────────
  // Non-fatal if this fails — the match assignment is already consistent.
  const { error: outUpdateError } = await db
    .from("queue_entries")
    .update({ status: "waiting" as const })
    .eq("session_id", match.session_id)
    .eq("player_id", outPlayerId);

  if (outUpdateError) {
    console.error("[swapPlayerInMatch] Failed to restore outPlayer queue status:", outUpdateError.message);
    // Continue — the match itself is consistent at this point.
  }

  // ── Write step e: READ-AFTER-WRITE is_mixed_level recompute
  // Fetch ALL current match_players AFTER the insert so we see the
  // true post-swap composition. This handles Scenario C (two concurrent
  // swaps on different slots) correctly — last writer wins with the
  // correct final state.
  const { data: currentPlayers } = await db
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  const currentIds = (currentPlayers ?? []).map((p) => p.player_id);

  if (currentIds.length > 0) {
    const { data: currentProfiles } = await db
      .from("profiles")
      .select("skill_level")
      .in("id", currentIds);

    const levels = new Set((currentProfiles ?? []).map((p) => p.skill_level));
    const isMixed = levels.size > 1;

    await db
      .from("matches")
      .update({ is_mixed_level: isMixed })
      .eq("id", matchId);
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
