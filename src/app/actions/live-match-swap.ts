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
//   4. Session binding — every match id belongs to the session from step 3
//   5. Match state checks
//   6. Atomic RPC (all writes in one Postgres transaction)
//   7. Broadcast organizer intervention to affected players
// ============================================================
// Step 4 exists because steps 3 and 6 used to be keyed on DIFFERENT
// client-supplied ids: the organizer check on `sessionId`, the RPC on `matchId`.
// Nothing tied them together, in this file or in the SQL, so an organizer of any
// session could rewrite the live roster of a match in another club's session by
// passing that match's id (TENANCY_AUDIT_2026-07-21.md #10).
//
// 20260723000001 binds the RPCs themselves, which is the authoritative fix — but
// these actions run on the SERVICE client, so the guard below is what turns a
// raised exception into the ordinary error contract, and it is the layer that
// still holds if a future RPC edit drops the SQL predicate.
// ============================================================

import { after } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { pushToPlayers } from "@/lib/notifications/push-server";
import { isValidUUID } from "@/lib/validate";
import { getAuthenticatedUser, isSessionOrganizer, getActorContext } from "@/app/actions/_shared";

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

// ── Session binding ───────────────────────────────────────────

/**
 * Do ALL of these match ids belong to `sessionId`?
 *
 * The organizer gate proves the caller may act on `sessionId`. It says nothing
 * about a match id that arrived in the same request, and every id here is
 * independently client-supplied — including the ones inside a
 * `LiveSwapUndoContext`, which is a plain object the client round-trips and can
 * therefore forge field by field.
 *
 * Deliberately on the service client: RLS on `matches` is derived from club
 * membership, so a cross-club id would come back empty under the caller's own
 * client too — but for the wrong reason, and it would silently start failing for
 * legitimate organizers the moment the read path changes. This is an
 * authorization check, the sanctioned service-role use.
 *
 * `.in()` with a de-duplicated list and a count comparison, rather than one
 * query per id: a partial match must fail, and comparing counts makes "one of
 * the two is someone else's" indistinguishable from "neither exists", which is
 * what we want to expose to the caller.
 */
async function allMatchesInSession(
  db: ReturnType<typeof createServiceClient>,
  sessionId: string,
  matchIds: string[]
): Promise<boolean> {
  const ids = [...new Set(matchIds)];
  const { data, error } = await db
    .from("matches")
    .select("id")
    .in("id", ids)
    .eq("session_id", sessionId);
  if (error) return false;
  return (data?.length ?? 0) === ids.length;
}

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

  // The organizer gate above authorized `sessionId`, not `matchId`. Reported as
  // MATCH_NOT_ACTIVE on purpose: it is the code the sheet already closes on, and
  // it keeps "belongs to another session" indistinguishable from "does not
  // exist" — no existence oracle over match ids.
  if (!(await allMatchesInSession(db, sessionId, [matchId]))) {
    return {
      success: false,
      errorCode: "MATCH_NOT_ACTIVE",
      message: "Match is no longer active.",
    };
  }

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

  const actor = await getActorContext(user.id);
  const { error } = await db.rpc("swap_player_in_active_match", {
    p_match_id: matchId,
    p_out_player_id: outPlayerId,
    p_in_player_id: inPlayerId,
    p_session_id: sessionId,
    p_team: outRow.team,
    p_actor_id: actor.id,
    p_actor_name: actor.name,
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
  after(() => pushToPlayers([inPlayerId], "COURT_CALL", sessionId));

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

  if (!(await allMatchesInSession(db, sessionId, [matchId]))) {
    return {
      success: false,
      errorCode: "MATCH_NOT_ACTIVE",
      message: "Match is no longer active.",
    };
  }

  const actor = await getActorContext(user.id);
  const { error } = await db.rpc("swap_teams_in_active_match", {
    p_match_id: matchId,
    p_player_a_id: playerAId,
    p_player_b_id: playerBId,
    p_actor_id: actor.id,
    p_actor_name: actor.name,
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

  // BOTH match ids, not just the active one: the on-deck id addresses its own
  // DELETE/INSERT pair inside the RPC and is just as forgeable.
  if (!(await allMatchesInSession(db, sessionId, [activeMatchId, onDeckMatchId]))) {
    return {
      success: false,
      errorCode: "MATCH_NOT_ACTIVE",
      message: "Match is no longer active.",
    };
  }

  const actor = await getActorContext(user.id);
  // The RPC returns the original teams via OUT params, needed for undo.
  const { data, error } = await db.rpc("swap_active_from_ondeck", {
    p_active_match_id: activeMatchId,
    p_out_player_id: outPlayerId,
    p_ondeck_player_id: onDeckPlayerId,
    p_ondeck_match_id: onDeckMatchId,
    p_fill_player_id: fillPlayerId,
    p_session_id: sessionId,
    p_actor_id: actor.id,
    p_actor_name: actor.name,
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
  after(() => pushToPlayers([onDeckPlayerId], "COURT_CALL", sessionId));
  after(() => pushToPlayers([fillPlayerId], "ON_DECK_WARNING", sessionId));

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

    const actor = await getActorContext(user.id);
    // Team swap is self-undoing — call with the same players to swap back.
    // p_is_undo records an 'undo' event (decrements modification_count) rather
    // than a second team_flip (which would over-count) — see plan §14 B1.
    const { error } = await db.rpc("swap_teams_in_active_match", {
      p_match_id: ctx.matchId,
      p_player_a_id: ctx.playerAId,
      p_player_b_id: ctx.playerBId,
      p_actor_id: actor.id,
      p_actor_name: actor.name,
      p_is_undo: true,
      // Tautological here — session_id was read FROM this match — but passed so
      // that every call site supplies it, which is the precondition for the
      // follow-up migration that makes the parameter NULL-rejecting.
      p_session_id: match.session_id,
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
    // `ctx` is a plain object the client round-trips, so ctx.matchId and
    // ctx.sessionId are forgeable independently of each other. The team_swap
    // branch above needs no such check — it derives the session FROM the match
    // rather than trusting a second field.
    if (!(await allMatchesInSession(db, ctx.sessionId, [ctx.matchId]))) return { success: false };
    const actor = await getActorContext(user.id);
    // Undo: swap the players back (in_player → out_player, out_player → in_player).
    // p_is_undo records an 'undo' event (decrements) — see plan §14 B1.
    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: ctx.matchId,
      p_out_player_id: ctx.inPlayerId,
      p_in_player_id: ctx.outPlayerId,
      p_session_id: ctx.sessionId,
      p_team: ctx.team,
      p_actor_id: actor.id,
      p_actor_name: actor.name,
      p_is_undo: true,
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
    if (!(await allMatchesInSession(db, ctx.sessionId, [ctx.activeMatchId, ctx.onDeckMatchId])))
      return { success: false };
    const actor = await getActorContext(user.id);
    const { error } = await db.rpc("undo_swap_active_from_ondeck", {
      p_active_match_id: ctx.activeMatchId,
      p_out_player_id: ctx.outPlayerId,
      p_ondeck_player_id: ctx.onDeckPlayerId,
      p_ondeck_match_id: ctx.onDeckMatchId,
      p_fill_player_id: ctx.fillPlayerId,
      p_session_id: ctx.sessionId,
      p_out_team: ctx.outTeam,
      p_ondeck_team: ctx.onDeckTeam,
      p_actor_id: actor.id,
      p_actor_name: actor.name,
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
