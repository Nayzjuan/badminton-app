"use server";

// ============================================================
// swapPlayerInMatch — Tap-to-Swap Server Action
// ============================================================
// Surgically replaces one player in a pending (on-deck) match
// with another player from the waiting queue.
//
// Safety model (FIVE pre-write guards; these labels are the ones in the code):
//   1.  Auth                                        (Not authenticated.)
//   1b. Match exists AND caller organizes it        (MATCH_STARTED / not found)
//   2.  match.status === "pending"                  (MATCH_STARTED)
//   3.  outPlayer still in match_players            (PLAYER_NOT_IN_MATCH)
//   4.  inPlayer queue_entries.status === "waiting" (PLAYER_UNAVAILABLE)
//
// Guard 1b sits ABOVE guard 2 on purpose: a missing row has no session_id to
// authorize against, so "no such match" and "not your match" must answer
// identically or the difference between them is itself the answer. Audit #12.
// (This header read "three pre-write guards" while listing four, from before
// 1b existed — a count in a comment is a claim, and this one was never
// recounted when a guard was added. Recount it if you add a sixth.)
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

import { after } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { pushToPlayers } from "@/lib/notifications/push-server";
import { isValidUUID } from "@/lib/validate";
import { getAuthenticatedUser, isSessionOrganizer, getActorContext } from "@/app/actions/_shared";

// ── Return types ──────────────────────────────────────────────

export type SwapErrorCode =
  | "MATCH_STARTED" // not pending, OR missing/not yours (guard 1b) — close Sheet + toast
  | "PLAYER_UNAVAILABLE" // inPlayer not in "waiting" — keep Sheet open, re-pick
  | "PLAYER_NOT_IN_MATCH"; // outPlayer already gone  — close Sheet + info toast

export type SwapResult = {
  success: boolean;
  message: string;
  errorCode?: SwapErrorCode;
};

// ── Match-to-match swap return type ──────────────────────────

// There is deliberately NO distinct "wrong session" code here. A cross-session
// match id returns MATCH_STARTED with the not-found wording, so "belongs to
// another session" is indistinguishable from "does not exist" — no existence
// oracle over match ids. This follows the precedent live-match-swap.ts:123-126
// set explicitly; the reason is recorded there and must not be diverged from
// without a reason recorded here.
//
// The indistinguishability that matters is at THIS boundary, not on screen.
// On screen there is nothing to distinguish anyway: use-swap-state.ts:227
// branches on errorCode and renders its own hardcoded "Match has already
// started — swap cancelled." toast, dropping `message` on that branch. So
// the not-found string below is server-side/API wording only — do not
// describe it as something a user reads. Note the `else` at :231-232 DOES
// render `message` verbatim ("Swap failed: …"), which is fine because in
// `swapMatchPlayers` every errorCode-less FAILURE return is pre-lookup or
// own-session — all four: UUID reject (:333), guard 1 auth (:340), guard 2
// organizer (:348), generic RPC fallback (:454). Scoped to THIS function:
// swapPlayerInMatch's errorCode-less failures land on swap-sheet.tsx:234
// (setInlineError) and on handleUndoSwap's hardcoded toast, which drops
// `message` (use-swap-state.ts:282-283). The success return is errorCode-less
// too, but use-swap-state.ts:214's `if (result.success)` (executeMatchSwap —
// three in that file, the middle one) takes it first. A fifth goes on this list.
// 🪤 Cite the `return` line — not the `if` condition above it, and not a
// `message:` line inside it. This list has now been wrong FOUR times, always
// because this comment block grew ABOVE the lines it cites. The first draft
// cited :413 — a line INSIDE the PLAYER_NOT_IN_MATCH return, an instance of
// the very thing this note warns against; the correction moved it to :415,
// still inside that same return. Then the set went :304/:311/:319/:425 →
// :319/:326/:334/:440 (+15, when the audit-#12 guard comments were appended)
// → :333/:340/:348/:454 (+14, when the header was corrected: it said "three
// pre-write guards" over a list of four and never mentioned guard 1b).
// M-14b's 🪤 in manual-and-swap.test.ts, plus the cite it annotates, records
// those same two shifts from a DIFFERENT pair of lines in this file — that
// corroboration is the point. Earlier drafts asserted them as "11 too low"
// then "10 too low"; both were wrong (15 and 14), neither had ever been
// checked, and a third figure ("3 too low") had no second witness at all and
// is not repeated. Make every edit to this file, THEN read the numbers, THEN
// write them down. A delta with no second witness does not belong here.
export type SwapMatchPlayersErrorCode =
  | "MATCH_STARTED" // one/both matches started, missing, or not in this session
  | "PLAYER_NOT_IN_MATCH"; // a player already moved → toast + clear picking state

export type SwapMatchPlayersResult = {
  success: boolean;
  message: string;
  errorCode?: SwapMatchPlayersErrorCode;
};

// getAuthenticatedUser and isSessionOrganizer are imported from ./_shared.

// ── Main action ───────────────────────────────────────────────

export async function swapPlayerInMatch(
  matchId: string,
  outPlayerId: string,
  inPlayerId: string
): Promise<SwapResult> {
  if (!isValidUUID(matchId) || !isValidUUID(outPlayerId) || !isValidUUID(inPlayerId)) {
    return { success: false, message: "Invalid match or player ID." };
  }
  // Use RLS client for auth verification, service client for all DB writes
  // so Row Level Security doesn't interfere with cross-user mutations.
  const db = createServiceClient();

  // ── Guard 1: Authentication ───────────────────────────────
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // ── Match lookup (the organizer gate needs its session_id) ─
  // Read via service client so RLS doesn't block.
  // BUG-001 fix: fetch is_published so we can pass it to the swap RPC.
  // For draft matches (is_published=false), the RPC skips step c so the
  // incoming player stays 'waiting' and no ON_DECK_WARNING alert fires.
  const { data: match } = await db
    .from("matches")
    .select("id, status, session_id, is_published")
    .eq("id", matchId)
    .single();

  // ── Guard 1b: organizer, BEFORE any state-revealing answer ─
  // The status check below used to run here, above the gate, which handed any
  // authenticated caller a three-way oracle over an arbitrary match UUID:
  // "Match not found." (no such row) vs "…already started…" (exists, not
  // pending) vs "Not authorized." (exists, pending, someone else's). This read
  // goes through the service client, so RLS is no backstop.
  //
  // A missing row carries no session_id and therefore cannot be authorized at
  // all — so "no such match" and "not your match" MUST answer identically, or
  // the difference between them is itself the answer. One condition, one
  // return, so the two cannot drift apart later. Everything below this line
  // may distinguish freely; it is only reachable by an organizer.
  //
  // Same rule the type block above `SwapMatchPlayersErrorCode` records for the
  // sibling `swapMatchPlayers`. Audit #12. `closeSession` obeys it by hoisting
  // its gate above every lookup; impossible here — the gate needs session_id.
  if (!match || !(await isSessionOrganizer(user.id, match.session_id))) {
    return {
      success: false,
      errorCode: "MATCH_STARTED",
      message: "Match not found.",
    };
  }

  // ── Guard 2: Match status — must still be pending ─────────
  if (match.status !== "pending") {
    return {
      success: false,
      errorCode: "MATCH_STARTED",
      message: "This match has already started — the swap was cancelled automatically.",
    };
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
  const actor = await getActorContext(user.id);
  const { error: swapError } = await db.rpc("swap_player_in_match", {
    p_match_id: matchId,
    p_out_player_id: outPlayerId,
    p_in_player_id: inPlayerId,
    p_session_id: match.session_id,
    p_team: outPlayerRow.team,
    p_is_published: match.is_published,
    p_actor_id: actor.id,
    p_actor_name: actor.name,
  });

  if (swapError) {
    // The RPC now raises named exceptions for concurrent-race scenarios.
    // Map them to the typed errorCode so the UI can respond appropriately.
    const msg = swapError.message ?? "";
    if (msg.includes("PLAYER_UNAVAILABLE")) {
      return {
        success: false,
        errorCode: "PLAYER_UNAVAILABLE",
        message:
          "This player is no longer available — they may have been swapped by a concurrent action.",
      };
    }
    if (msg.includes("MATCH_STARTED")) {
      return {
        success: false,
        errorCode: "MATCH_STARTED",
        message: "This match has already started — the swap was cancelled automatically.",
      };
    }
    return { success: false, message: `Failed to swap: ${msg}` };
  }

  // ── Broadcast: notify outgoing player their on-deck slot is gone
  // The incoming player's dashboard will update via subscribeToMatchPlayers
  // Postgres realtime (new match_players row fires fetchMyMatch).
  await broadcastOrganizerIntervention(match.session_id, "on_deck_cleared", [outPlayerId]);

  // On-deck ping: only when this is a PUBLISHED match — the incoming player
  // transitions waiting → on_deck. For an unpublished draft they go to
  // 'drafted' (still hidden), so we stay silent until publish.
  if (match.is_published) {
    after(() => pushToPlayers([inPlayerId], "ON_DECK_WARNING", match.session_id));
  }

  return { success: true, message: "Swap complete." };
}

// ============================================================
// swapMatchPlayers — Direct Match↔Match Player Swap
// ============================================================
// Swaps two players who are already inside on-deck matches,
// either within the same match (team reassignment) or across
// two different on-deck matches (match + team reassignment).
//
// Unlike swapPlayerInMatch, neither player touches the queue —
// both remain "on_deck" throughout; only match_players rows change.
//
// Safety guards (six pre-write checks), in this order for a reason:
//   1. Auth
//   2. Caller is organizer of `sessionId`
//   3. Both matches exist
//   3b. Both matches belong to `sessionId`  ← see below
//   3c. Both matches still have status === "pending"
//   4. Both players still present in their respective matches
//
// ⚠ Authorization comes BEFORE any lookup. Guards 3/3b/3c answer questions
// about specific match ids ("does it exist", "is it yours", "is it
// pending"), so running them first would let any authenticated caller —
// organizer of nothing — probe them. That is why guard 2 moved above
// guard 3 rather than 3b being slotted in beneath it.
//
// ⚠ 3b before 3c, not the other way round. The first version of this fix
// had the status check first, which meant a cross-session id belonging to
// an already-started match came back with different wording than one that
// does not exist — reinstating, through the back door, the very oracle 3b
// was added to avoid. Only ids already proven to be in `sessionId` reach
// the status check.
//
// ⚠ Guard 3b is load-bearing, not defensive noise. Guard 2 authorizes
// against the CALLER-SUPPLIED `sessionId`, and `db` is the service-role
// client, so RLS is not a second line of defence here. Without 3b, an
// organizer of session A could pass a pending match id belonging to
// session B and rewrite a roster in another club's session — the exact
// defect 20260723000001 bound the four LIVE-swap RPCs against (audit
// #10 / #4). This draft-path sibling was left unbound; see audit #12.
// The session ids were already being SELECTed at guard 3 and simply
// discarded, which is why the hole read as covered.
//
// The DB half was deliberately NOT mirrored, unlike the live swaps:
// swap_match_players takes no p_session_id, and 20260723000000 made it
// service_role-only, so this action is the entire boundary. Rationale
// and its expiry condition are in audit #12 — if that grant ever widens,
// the RPC needs binding too.
//
// Writes (single atomic Postgres transaction via swap_match_players RPC):
//   a. DELETE both players from match_players
//   b. INSERT Player A into match B (on B's team)
//   c. INSERT Player B into match A (on A's team)
//   d. Recompute is_mixed_level for both affected matches
//
// queue_entries.status is intentionally UNCHANGED — both players
// remain "on_deck" since they are still assigned to some match.
// ============================================================

export async function swapMatchPlayers(
  aMatchId: string,
  aPlayerId: string,
  bMatchId: string,
  bPlayerId: string,
  sessionId: string
): Promise<SwapMatchPlayersResult> {
  if (
    !isValidUUID(aMatchId) ||
    !isValidUUID(aPlayerId) ||
    !isValidUUID(bMatchId) ||
    !isValidUUID(bPlayerId) ||
    !isValidUUID(sessionId)
  ) {
    return { success: false, message: "Invalid match, player, or session ID." };
  }
  const db = createServiceClient();

  // ── Guard 1: Authentication ───────────────────────────────
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // ── Guard 2: Caller must be organizer of this session ─────
  // Runs before any match lookup so guards 3/3b cannot be used as a
  // probe by a caller who organizes nothing.
  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // ── Guard 3: Both matches exist ───────────────────────────
  const matchIds = aMatchId === bMatchId ? [aMatchId] : [aMatchId, bMatchId];
  const { data: matches } = await db
    .from("matches")
    .select("id, status, session_id")
    .in("id", matchIds);

  if (!matches || matches.length < matchIds.length) {
    return {
      success: false,
      errorCode: "MATCH_STARTED",
      message: "One or both matches could not be found.",
    };
  }

  // ── Guard 3b: Both matches must belong to THIS session ────
  // Guard 2 proves the caller organizes `sessionId`, which says nothing
  // about where these matches live. The live-swap actions express this
  // as allMatchesInSession(db, sessionId, ids); here guard 3 has already
  // SELECTed session_id for exactly these ids, so the check costs no
  // extra round-trip. Reported as MATCH_STARTED with the not-found
  // wording on purpose — see the note on SwapMatchPlayersErrorCode.
  //
  // ⚠ This MUST stay above guard 3c. When the status check ran first, a
  // cross-session id whose match was NOT pending got the "already started"
  // wording instead of the not-found wording — distinguishable, so the two
  // together were an existence oracle over foreign match ids after all.
  // live-match-swap.ts binds the session at :127, immediately after its
  // organizer gate at :120 and before any status read, for this reason.
  for (const m of matches) {
    if (m.session_id !== sessionId) {
      console.warn(
        `[swapMatchPlayers] cross-session match id rejected: match ${m.id} is in session ${m.session_id}, caller authorized for ${sessionId}`
      );
      return {
        success: false,
        errorCode: "MATCH_STARTED",
        message: "One or both matches could not be found.",
      };
    }
  }

  // ── Guard 3c: Both matches are still pending ──────────────
  // Only reachable for matches guard 3b proved are in `sessionId`, so the
  // distinct "already started" wording discloses nothing the caller is not
  // already entitled to see on their own board.
  for (const m of matches) {
    if (m.status !== "pending") {
      return {
        success: false,
        errorCode: "MATCH_STARTED",
        message: "A match has already started — the swap was cancelled.",
      };
    }
  }

  // ── Guard 4: Both players must still be in their matches ──
  // Scoped to `matchIds` — guard 3b already proved those live in this
  // session, so this cannot read (or match on) a row from another one.
  const { data: playerRows } = await db
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", matchIds)
    .in("player_id", [aPlayerId, bPlayerId]);

  const aRow = playerRows?.find((r) => r.match_id === aMatchId && r.player_id === aPlayerId);
  const bRow = playerRows?.find((r) => r.match_id === bMatchId && r.player_id === bPlayerId);

  if (!aRow || !bRow) {
    return {
      success: false,
      errorCode: "PLAYER_NOT_IN_MATCH",
      message: "One or both players are no longer in their match.",
    };
  }

  // ── Atomic write via swap_match_players RPC ───────────────
  const actor = await getActorContext(user.id);
  const { error: swapError } = await db.rpc("swap_match_players", {
    p_a_match_id: aMatchId,
    p_a_player_id: aPlayerId,
    p_b_match_id: bMatchId,
    p_b_player_id: bPlayerId,
    p_actor_id: actor.id,
    p_actor_name: actor.name,
  });

  if (swapError) {
    const msg = swapError.message ?? "";
    if (msg.includes("MATCH_STARTED")) {
      return {
        success: false,
        errorCode: "MATCH_STARTED",
        message: "A match has already started.",
      };
    }
    if (msg.includes("PLAYER_NOT_IN_MATCH")) {
      return {
        success: false,
        errorCode: "PLAYER_NOT_IN_MATCH",
        message: "Player no longer in match.",
      };
    }
    return { success: false, message: `Failed to swap: ${msg}` };
  }

  return { success: true, message: "Swap complete." };
}
