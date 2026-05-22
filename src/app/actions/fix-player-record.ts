"use server";

// ============================================================
// fixPlayerRecord — Historical Match Roster Correction
// ============================================================
// Corrects the player roster of a COMPLETED match.
// Intended for data-correction use cases:
//   • Wrong player recorded (organizer error)
//   • Injury substitution — out_player started but in_player finished
//
// Delegates all DB writes to the fix_record_swap_player Postgres RPC,
// which runs inside a single atomic transaction. The RPC handles:
//   • Team flip (both players already in the match → swap teams)
//   • Full replacement (in_player from another completed match)
//   • queue_entries.games_played delta (full replacement only)
//   • player_partnerships all-time delta
//   • is_mixed_level recomputation
//   • refresh_alltime_leaderboard() for the materialized view
//
// v_session_leaderboard and session-scoped partnership caps auto-update
// because they are live views / runtime queries from match_players.
//
// Post-correction: if the session is already closed (is_active = false),
// compute_session_wrapped is re-run so Session Wrapped stats + awards
// reflect the corrected roster. Non-fatal — a warning is logged on failure
// but the correction itself is still considered successful.
//
// Safety guards (four pre-write checks):
//   1. Input validation (UUID format)
//   2. Auth — authenticated user required
//   3. Organizer — caller must be session organizer
//   4. Match state — match.status must be 'completed' (enforced by RPC too)
//   5. Eligibility — in_player must have ≥1 completed match in this session
//      (OR already be a player in the target match for a team flip)
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import { isValidUUID } from "@/lib/validate";

// ── Return types ──────────────────────────────────────────────

export type FixRecordErrorCode =
  /** match.status !== 'completed' — shouldn't happen if UI guards correctly */
  | "MATCH_NOT_COMPLETED"
  /** out_player not found in match_players */
  | "PLAYER_NOT_IN_MATCH"
  /** in_player has no completed match in this session AND is not in this match */
  | "INELIGIBLE_PLAYER";

export type FixRecordResult = {
  success: boolean;
  message: string;
  errorCode?: FixRecordErrorCode;
};

// ── Main action ───────────────────────────────────────────────

export async function fixPlayerRecord(
  matchId: string,
  outPlayerId: string,
  inPlayerId: string,
  sessionId: string
): Promise<FixRecordResult> {
  // ── Input validation ────────────────────────────────────────
  if (
    !isValidUUID(matchId) ||
    !isValidUUID(outPlayerId) ||
    !isValidUUID(inPlayerId) ||
    !isValidUUID(sessionId)
  ) {
    return { success: false, message: "Invalid ID format." };
  }

  if (outPlayerId === inPlayerId) {
    return { success: false, message: "Cannot swap a player with themselves." };
  }

  const db = createServiceClient();

  // ── Guard 1: Authentication ─────────────────────────────────
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // ── Guard 2: Organizer check ────────────────────────────────
  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // ── Guard 3: Match must be completed ────────────────────────
  const { data: match } = await db
    .from("matches")
    .select("id, status, session_id")
    .eq("id", matchId)
    .maybeSingle();

  if (!match) {
    return {
      success: false,
      errorCode: "MATCH_NOT_COMPLETED",
      message: "Match not found.",
    };
  }

  if (match.status !== "completed") {
    return {
      success: false,
      errorCode: "MATCH_NOT_COMPLETED",
      message: "Only completed matches can be corrected.",
    };
  }

  if (match.session_id !== sessionId) {
    return { success: false, message: "Match does not belong to this session." };
  }

  // ── Guard 4: in_player eligibility ──────────────────────────
  // in_player is eligible if they are:
  //   (a) already in this match (team flip — always valid), OR
  //   (b) have at least one completed match in this session (substitution)
  const { data: inPlayerMatchRow } = await db
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId)
    .eq("player_id", inPlayerId)
    .maybeSingle();

  const isTeamFlip = !!inPlayerMatchRow;

  if (!isTeamFlip) {
    // Check for at least one other completed match in session
    const { data: completedMatches } = await db
      .from("match_players")
      .select("match_id, matches!inner(session_id, status)")
      .eq("player_id", inPlayerId)
      .eq("matches.session_id", sessionId)
      .eq("matches.status", "completed")
      .neq("match_id", matchId) // must be a DIFFERENT match
      .limit(1);

    if (!completedMatches || completedMatches.length === 0) {
      return {
        success: false,
        errorCode: "INELIGIBLE_PLAYER",
        message:
          "The replacement player must have played at least one other completed match in this session.",
      };
    }
  }

  // ── Atomic write via RPC ─────────────────────────────────────
  const { error: rpcError } = await db.rpc("fix_record_swap_player", {
    p_match_id: matchId,
    p_out_player_id: outPlayerId,
    p_in_player_id: inPlayerId,
    p_session_id: sessionId,
  });

  if (rpcError) {
    const msg = rpcError.message ?? "";
    if (msg.includes("MATCH_NOT_COMPLETED")) {
      return {
        success: false,
        errorCode: "MATCH_NOT_COMPLETED",
        message: "This match is no longer in a completed state.",
      };
    }
    if (msg.includes("PLAYER_NOT_IN_MATCH")) {
      return {
        success: false,
        errorCode: "PLAYER_NOT_IN_MATCH",
        message: "The player being replaced is no longer in this match.",
      };
    }
    return { success: false, message: `Failed to correct record: ${msg}` };
  }

  // ── Post-correction: recompute Session Wrapped if session is closed ──
  // If the session has already been closed and Wrapped distributed,
  // the stats + awards need to reflect the corrected roster. We re-run
  // compute_session_wrapped unconditionally on closed sessions — it is
  // idempotent (upserts session_wrapped_stats) and picks up the updated
  // match_players + player_partnerships written by the RPC above.
  //
  // Active sessions: skip — Wrapped hasn't been distributed yet, so
  // there is nothing stale to fix. Stats will be correct at close time.
  const { data: sessionRow } = await db
    .from("sessions")
    .select("is_active")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionRow && !sessionRow.is_active) {
    const { error: wrappedErr } = await db.rpc("compute_session_wrapped", {
      p_session_id: sessionId,
    });
    if (wrappedErr) {
      // Non-fatal — the roster correction succeeded; Wrapped will be
      // slightly stale until manually recomputed.
      console.warn(
        "[fixPlayerRecord] compute_session_wrapped failed after fix (non-fatal):",
        wrappedErr.message
      );
    }
  }

  return { success: true, message: "Player record corrected." };
}
