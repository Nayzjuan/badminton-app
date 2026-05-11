"use server";

// ============================================================
// Queue Server Actions
// ============================================================
// joinQueueAction applies Inherited Games logic so late-joining
// players cannot jump to position #1 in the queue.
//
// ── Inherited Games ────────────────────────────────────────
// The queue sorts by (games_played ASC, joined_at ASC).
// A player who joins with games_played=0 while everyone else
// has played 3+ games lands at #1 — completely unfair.
//
// Fix: before inserting OR re-activating a row, query the
// session floor (MIN games_played across active players).
// The player's games_played is set to MAX(their_current, floor).
//
// ── Both branches must apply the floor ─────────────────────
// BUG that was causing line-jumping:
//   The floor query was ONLY run for first-time joiners.
//   Returning players (row exists with status="left") went
//   through a fast-path that kept their old games_played — often 0.
//   A player who joined at the start, never played, left, and
//   re-joined hours later would land at #1.
//
// Fix: compute the floor in BOTH branches, then take the max.
//
// ── Edge cases ──────────────────────────────────────────────
// • Empty session → floor = 0, player starts at 0 ✓
// • Everyone at 0 → floor = 0, correct ✓
// • Floor query fails → log + fall back to 0 (non-blocking) ✓
// • Player already on_deck/playing → allowed by DB; UI prevents
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { isValidUUID } from "@/lib/validate";

// ── Organizer check ───────────────────────────────────────────
// Accepts created_by ownership OR session_organizers membership.
// Uses the service client so the primary organizer is never
// blocked by read-side RLS on the sessions/session_organizers tables.
async function isSessionOrganizer(userId: string, sessionId: string): Promise<boolean> {
  const svc = createServiceClient();
  const { data: session } = await svc
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .single();
  if (session?.created_by === userId) return true;
  const { data: membership } = await svc
    .from("session_organizers")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!membership;
}

// ── Checkout ──────────────────────────────────────────────────
// Marks the calling player's queue_entries row as "left" for a
// given session, removing them from matchmaking.
// Calling this while on_deck or playing is allowed — the match
// already in progress is unaffected; they're only removed from
// the future queue so they don't get scheduled again.

export interface CheckoutResult {
  success: boolean;
  error?: string;
}

// ── Soft Pause ────────────────────────────────────────────────
// Toggles `is_paused` on the player's queue_entries row.
// The player remains visible in the organizer dashboard but is
// strictly excluded from the matchmaking engine while paused.
// IMPORTANT: `joined_at` and `games_played` are never touched —
// pausing does NOT forfeit queue position or game stats.

export interface TogglePlayerPauseResult {
  success: boolean;
  error?: string;
}

export async function togglePlayerPause(
  sessionId: string,
  playerId: string,
  isPaused: boolean
): Promise<TogglePlayerPauseResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player ID." };
  }
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Not authenticated." };
  }

  // Organizer-only: any authenticated player could otherwise pause any other
  // player by calling this action with an arbitrary playerId. Verify the caller
  // is the session creator OR a co-organizer before writing.
  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return { success: false, error: "Not authorized. Organizer access required." };
  }

  // Update is_paused ONLY — never touch joined_at or games_played.
  // Use service client so the write succeeds for the primary organizer
  // (sessions.created_by), who has no session_organizers row and would
  // be silently blocked by write-side RLS on queue_entries.
  const svc = createServiceClient();
  const { error } = await svc
    .from("queue_entries")
    .update({ is_paused: isPaused })
    .eq("session_id", sessionId)
    .eq("player_id", playerId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

export async function checkoutPlayer(sessionId: string): Promise<CheckoutResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Not authenticated." };
  }

  const { error } = await supabase
    .from("queue_entries")
    .update({ status: "left" as const })
    .eq("session_id", sessionId)
    .eq("player_id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }

  // Clean up any unpublished draft matches this player is assigned to.
  // The RPC atomically removes the player from draft match_players and
  // cancels the draft if it falls below 4 players.
  const svc = createServiceClient();
  const { error: cleanupError } = await svc.rpc(
    "checkout_player_cleanup_drafts",
    { p_session_id: sessionId, p_player_id: user.id }
  );

  if (cleanupError) {
    console.error("[checkoutPlayer] draft cleanup error:", cleanupError.message);
    // Non-fatal: checkout itself succeeded.
  }

  return { success: true };
}

export interface JoinQueueResult {
  error?: string;
}

export async function joinQueueAction(sessionId: string): Promise<JoinQueueResult> {
  if (!isValidUUID(sessionId)) return { error: "Invalid session ID." };
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "Not authenticated. Please refresh and try again." };
  }

  const { data: result, error: rpcError } = await supabase.rpc("join_queue", {
    p_session_id: sessionId,
    p_player_id: user.id,
  });

  if (rpcError) {
    console.error("[joinQueueAction] RPC error:", rpcError.message);
    return { error: rpcError.message };
  }

  if (!result?.success) {
    return { error: result?.error ?? "Failed to join queue." };
  }

  console.log(`[joinQueueAction] ${result.action} games_played=${result.games_played}`);

  await runEngineForSession(sessionId);
  return {};
}
