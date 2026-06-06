"use server";

// ============================================================
// live-match-swap — Server actions for fixing active match rosters
// ============================================================
// Three operations the organizer can perform while a match is
// in_progress (long-press a player name on the active court card):
//
//   swapPlayerInActiveMatch   — replace with a queue player
//   swapTeamsInActiveMatch    — mutual team swap within same match
//   swapActiveFromOnDeck      — pull from on-deck + fill the hole
//   undoLiveSwap              — reverse any of the three within 3s
//
// Guard pattern (same across all three):
//   1. UUID validation
//   2. Auth (getAuthenticatedUser)
//   3. Organizer check (isSessionOrganizer)
//   4. Match state checks
//   5. Atomic RPC (all writes in one Postgres transaction)
//   6. Broadcast organizer intervention to affected players
// ============================================================

import { after } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { pushToPlayers } from "@/lib/notifications/push-server";
import { isValidUUID } from "@/lib/validate";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";

// ── Return types ──────────────────────────────────────────────

export type LiveSwapErrorCode =
  | "MATCH_NOT_ACTIVE" // match is no longer in_progress — close sheet
  | "PLAYER_NOT_IN_MATCH" // player already moved — close sheet + toast
  | "PLAYER_UNAVAILABLE" // queue player taken — keep sheet open, re-pick
  | "ONDECK_MATCH_STARTED" // on-deck match promoted mid-confirm — close sheet
  | "FILL_PLAYER_UNAVAILABLE"; // fill queue player taken — keep fill picker open

export type LiveSwapUndoContext =
  | {
      type: "team_swap";
      matchId: string;
      playerAId: string;
      playerBId: string;
      playerAName: string;
      playerBName: string;
    }
  | {
      type: "queue_replacement";
      matchId: string;
      outPlayerId: string;
      inPlayerId: string;
      team: string;
      sessionId: string;
      outPlayerName: string;
      inPlayerName: string;
    }
  | {
      type: "ondeck_replacement";
      activeMatchId: string;
      outPlayerId: string;
      onDeckPlayerId: string;
      onDeckMatchId: string;
      fillPlayerId: string;
      sessionId: string;
      outTeam: string;
      onDeckTeam: string;
      outPlayerName: string;
      onDeckPlayerName: string;
      fillPlayerName: string;
    };

export type LiveSwapResult = {
  success: boolean;
  message: string;
  errorCode?: LiveSwapErrorCode;
  undoContext?: LiveSwapUndoContext;
};

// ── swapPlayerInActiveMatch ───────────────────────────────────

/** Replace a player in an in_progress match with a player from the waiting queue. */
export async function swapPlayerInActiveMatch(
  matchId: string,
  outPlayerId: string,
  inPlayerId: string,
  sessionId: string,
  outPlayerName: string,
  inPlayerName: string
): Promise<LiveSwapResult> {
  if (
    !isValidUUID(matchId) ||
    !isValidUUID(outPlayerId) ||
    !isValidUUID(inPlayerId) ||
    !isValidUUID(sessionId)
  ) {
    return { success: false, message: "Invalid match or player ID." };
  }

  const db = createServiceClient();
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

  // Read the team of the outgoing player (needed for the RPC + undo context).
  const { data: outRow } = await db
    .from("match_players")
    .select("team")
    .eq("match_id", matchId)
    .eq("player_id", outPlayerId)
    .maybeSingle();

  if (!outRow) {
    return {
      success: false,
      errorCode: "PLAYER_NOT_IN_MATCH",
      message: "This player is no longer in the match.",
    };
  }

  const { error } = await db.rpc("swap_player_in_active_match", {
    p_match_id: matchId,
    p_out_player_id: outPlayerId,
    p_in_player_id: inPlayerId,
    p_session_id: sessionId,
    p_team: outRow.team,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("MATCH_NOT_ACTIVE"))
      return {
        success: false,
        errorCode: "MATCH_NOT_ACTIVE",
        message: "Match is no longer active.",
      };
    if (msg.includes("PLAYER_NOT_IN_MATCH"))
      return {
        success: false,
        errorCode: "PLAYER_NOT_IN_MATCH",
        message: "Player already swapped out.",
      };
    if (msg.includes("PLAYER_UNAVAILABLE"))
      return {
        success: false,
        errorCode: "PLAYER_UNAVAILABLE",
        message: "Player is no longer available.",
      };
    return { success: false, message: `Swap failed: ${msg}` };
  }

  await broadcastOrganizerIntervention(sessionId, "active_roster_changed", [
    outPlayerId,
    inPlayerId,
  ]);

  // Court call: the incoming queue player was just dropped into a live match
  // (waiting → playing). Ping them to head to the court now.
  after(() => pushToPlayers([inPlayerId], "COURT_CALL"));

  return {
    success: true,
    message: "Swap complete.",
    undoContext: {
      type: "queue_replacement",
      matchId,
      outPlayerId,
      inPlayerId,
      team: outRow.team,
      sessionId,
      outPlayerName,
      inPlayerName,
    },
  };
}

// ── swapTeamsInActiveMatch ────────────────────────────────────

/** Swap two players between teams within the same in_progress match. */
export async function swapTeamsInActiveMatch(
  matchId: string,
  sessionId: string,
  playerAId: string,
  playerBId: string,
  playerAName: string,
  playerBName: string
): Promise<LiveSwapResult> {
  if (
    !isValidUUID(matchId) ||
    !isValidUUID(sessionId) ||
    !isValidUUID(playerAId) ||
    !isValidUUID(playerBId)
  ) {
    return { success: false, message: "Invalid match or player ID." };
  }

  const db = createServiceClient();
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

  const { error } = await db.rpc("swap_teams_in_active_match", {
    p_match_id: matchId,
    p_player_a_id: playerAId,
    p_player_b_id: playerBId,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("MATCH_NOT_ACTIVE"))
      return {
        success: false,
        errorCode: "MATCH_NOT_ACTIVE",
        message: "Match is no longer active.",
      };
    if (msg.includes("PLAYER_NOT_IN_MATCH"))
      return { success: false, errorCode: "PLAYER_NOT_IN_MATCH", message: "Player already moved." };
    return { success: false, message: `Swap failed: ${msg}` };
  }

  await broadcastOrganizerIntervention(sessionId, "active_roster_changed", [playerAId, playerBId]);

  return {
    success: true,
    message: "Teams swapped.",
    undoContext: {
      type: "team_swap",
      matchId,
      playerAId,
      playerBId,
      playerAName,
      playerBName,
    },
  };
}

// ── swapActiveFromOnDeck ──────────────────────────────────────

/**
 * Atomic 3-way: pull an on-deck player into the active match, and
 * fill the vacated on-deck slot with a queue player.
 */
export async function swapActiveFromOnDeck(
  activeMatchId: string,
  outPlayerId: string,
  onDeckPlayerId: string,
  onDeckMatchId: string,
  fillPlayerId: string,
  sessionId: string,
  outPlayerName: string,
  onDeckPlayerName: string,
  fillPlayerName: string
): Promise<LiveSwapResult> {
  if (
    !isValidUUID(activeMatchId) ||
    !isValidUUID(outPlayerId) ||
    !isValidUUID(onDeckPlayerId) ||
    !isValidUUID(onDeckMatchId) ||
    !isValidUUID(fillPlayerId) ||
    !isValidUUID(sessionId)
  ) {
    return { success: false, message: "Invalid IDs provided." };
  }

  const db = createServiceClient();
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

  // The RPC returns the original teams via OUT params, needed for undo.
  const { data, error } = await db.rpc("swap_active_from_ondeck", {
    p_active_match_id: activeMatchId,
    p_out_player_id: outPlayerId,
    p_ondeck_player_id: onDeckPlayerId,
    p_ondeck_match_id: onDeckMatchId,
    p_fill_player_id: fillPlayerId,
    p_session_id: sessionId,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("MATCH_NOT_ACTIVE"))
      return {
        success: false,
        errorCode: "MATCH_NOT_ACTIVE",
        message: "Match is no longer active.",
      };
    if (msg.includes("ONDECK_MATCH_STARTED"))
      return {
        success: false,
        errorCode: "ONDECK_MATCH_STARTED",
        message: "The on-deck match already started.",
      };
    if (msg.includes("PLAYER_NOT_IN_MATCH"))
      return {
        success: false,
        errorCode: "PLAYER_NOT_IN_MATCH",
        message: "A player already moved.",
      };
    if (msg.includes("FILL_PLAYER_UNAVAILABLE"))
      return {
        success: false,
        errorCode: "FILL_PLAYER_UNAVAILABLE",
        message: "Fill player is no longer available.",
      };
    return { success: false, message: `Swap failed: ${msg}` };
  }

  // PostgREST wraps OUT-param functions in an array (same as RETURNS TABLE).
  const row = Array.isArray(data)
    ? (data as { o_out_team: string; o_ondeck_team: string }[])[0]
    : data;
  const outTeam = row?.o_out_team ?? "a";
  const onDeckTeam = row?.o_ondeck_team ?? "a";

  await broadcastOrganizerIntervention(sessionId, "active_roster_changed", [
    outPlayerId,
    onDeckPlayerId,
    fillPlayerId,
  ]);

  // Two pings: the on-deck player was promoted into the live match
  // (on_deck → playing = court call), and the fill player took the vacated
  // on-deck slot (waiting → on_deck = get ready). The displaced outPlayer
  // returns to 'waiting' and is intentionally not pinged.
  after(() => pushToPlayers([onDeckPlayerId], "COURT_CALL"));
  after(() => pushToPlayers([fillPlayerId], "ON_DECK_WARNING"));

  return {
    success: true,
    message: "Swap complete.",
    undoContext: {
      type: "ondeck_replacement",
      activeMatchId,
      outPlayerId,
      onDeckPlayerId,
      onDeckMatchId,
      fillPlayerId,
      sessionId,
      outTeam,
      onDeckTeam,
      outPlayerName,
      onDeckPlayerName,
      fillPlayerName,
    },
  };
}

// ── undoLiveSwap ──────────────────────────────────────────────

/** Reverses any live match swap within the 3-second undo window. */
export async function undoLiveSwap(ctx: LiveSwapUndoContext): Promise<{ success: boolean }> {
  const db = createServiceClient();
  const user = await getAuthenticatedUser();
  if (!user) return { success: false };

  if (ctx.type === "team_swap") {
    // Lookup session_id from the match — team_swap undo context doesn't carry it.
    const { data: match } = await db
      .from("matches")
      .select("session_id")
      .eq("id", ctx.matchId)
      .single();
    if (!match) return { success: false };
    const isOrg = await isSessionOrganizer(user.id, match.session_id);
    if (!isOrg) return { success: false };

    // Team swap is self-undoing — call with the same players to swap back.
    const { error } = await db.rpc("swap_teams_in_active_match", {
      p_match_id: ctx.matchId,
      p_player_a_id: ctx.playerAId,
      p_player_b_id: ctx.playerBId,
    });
    if (!error) {
      await broadcastOrganizerIntervention(match.session_id, "active_roster_changed", [
        ctx.playerAId,
        ctx.playerBId,
      ]);
    }
    return { success: !error };
  }

  if (ctx.type === "queue_replacement") {
    const organizer = await isSessionOrganizer(user.id, ctx.sessionId);
    if (!organizer) return { success: false };
    // Undo: swap the players back (in_player → out_player, out_player → in_player)
    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: ctx.matchId,
      p_out_player_id: ctx.inPlayerId,
      p_in_player_id: ctx.outPlayerId,
      p_session_id: ctx.sessionId,
      p_team: ctx.team,
    });
    if (!error) {
      await broadcastOrganizerIntervention(ctx.sessionId, "active_roster_changed", [
        ctx.outPlayerId,
        ctx.inPlayerId,
      ]);
    }
    return { success: !error };
  }

  if (ctx.type === "ondeck_replacement") {
    const organizer = await isSessionOrganizer(user.id, ctx.sessionId);
    if (!organizer) return { success: false };
    const { error } = await db.rpc("undo_swap_active_from_ondeck", {
      p_active_match_id: ctx.activeMatchId,
      p_out_player_id: ctx.outPlayerId,
      p_ondeck_player_id: ctx.onDeckPlayerId,
      p_ondeck_match_id: ctx.onDeckMatchId,
      p_fill_player_id: ctx.fillPlayerId,
      p_session_id: ctx.sessionId,
      p_out_team: ctx.outTeam,
      p_ondeck_team: ctx.onDeckTeam,
    });
    if (!error) {
      await broadcastOrganizerIntervention(ctx.sessionId, "active_roster_changed", [
        ctx.outPlayerId,
        ctx.onDeckPlayerId,
        ctx.fillPlayerId,
      ]);
    }
    return { success: !error };
  }

  return { success: false };
}
