"use server";

// ============================================================
// match-lifecycle.ts — Score submission + match lifecycle
// ============================================================
// submitMatchScore  — player-initiated score submission
// endMatchAction    — organizer ends a match with scores
// cancelMatchAction — cancel a pending/in-progress match
// updateMatchDetails — edit historical match scores / revert
// createManualMatchAction — organizer creates a manual match
// ============================================================

import { after } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import {
  promoteOnDeckMatchInternal,
  runEngineForSession,
  recomputeHeldReadiness,
} from "@/app/actions/matchmaking";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { pushToPlayers } from "@/lib/notifications/push-server";
import { isValidUUID } from "@/lib/validate";
import { shouldRefreshLeaderboard } from "@/lib/leaderboard-refresh";
import {
  getAuthenticatedUser,
  isSessionOrganizer,
  isSessionActive,
  getActorContext,
  type MatchActionResult,
} from "@/app/actions/_shared";
import { scoreSchema } from "@/lib/schemas/match";
import { logMatchEvent } from "@/lib/match-event-log";

// ============================================================
// submitMatchScore — player-initiated score submission
// ============================================================
// Called from the player's dashboard. Validates that the
// calling user is actually in the match before delegating
// to the shared endMatchInternal core.
// ============================================================

/**
 * Player-facing score submission. Verifies the calling user is a participant
 * in the match, then delegates to the shared `endMatchInternal` core with
 * `participantVerified=true` — which skips the duplicate GoTrue lookup and the
 * organizer-probe the old delegation-to-endMatchAction path incurred.
 *
 * The participant check prevents any authenticated user from ending a match
 * they're not in. Callers should not pass matchId from untrusted input without
 * isValidUUID pre-validation (performed here).
 */
export async function submitMatchScore(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };

  // Identify the calling player. Both authentication AND the participation
  // check run before the score payload is validated — see the note in
  // updateMatchDetails, which orders itself the same way. endMatchAction can
  // only get authentication in first: its organizer-OR-player gate lives in
  // endMatchInternal, which takes the parsed scores as arguments.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // Verify this player is in the match (prevents spoofed submissions).
  // Service client + explicit player_id filter confirms ONLY the caller's own
  // participation (no RLS leak) and reuses this client for the write path.
  // .maybeSingle() — .single() throws on 0 rows, which would mask the
  // "not a player" message with a confusing coercion error.
  const db = createServiceClient();
  const { data: mySlot } = await db
    .from("match_players")
    .select("id")
    .eq("match_id", matchId)
    .eq("player_id", user.id)
    .maybeSingle();

  if (!mySlot) {
    return { success: false, message: "You are not a player in this match." };
  }

  // Server-side score bounds — client validation is UI-only and trivially
  // bypassed by a direct POST to the action endpoint.
  const scoreResult = scoreSchema.safeParse({ teamAScore, teamBScore });
  if (!scoreResult.success) {
    return { success: false, message: scoreResult.error.issues[0].message };
  }
  const { teamAScore: safeA, teamBScore: safeB } = scoreResult.data;

  // Participation verified → shared core skips the organizer-OR-player gate.
  return endMatchInternal(db, matchId, safeA, safeB, user, true);
}

// ============================================================
// endMatchAction
// ============================================================
// Auth model:
//   Accepts two kinds of callers:
//     A. A session organizer (primary creator OR co-organizer)
//     B. A player who is in this specific match (via submitMatchScore)
//
//   The RLS client (supabase) is used for read-only auth lookups so
//   we don't leak rows outside the user's visibility. All writes use
//   the service client (db) — bypassing RLS entirely — because JS-
//   level auth is performed first and the old RLS path was silently
//   blocking the primary organizer (sessions.created_by) who never
//   has a session_organizers row.
// ============================================================
export async function endMatchAction(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };

  // P0-3: Require authentication. Runs before score validation — see the note
  // in updateMatchDetails; all three entry points in this file settle "may you
  // call this at all?" before they say anything about the payload. The
  // organizer-OR-player gate itself lives in endMatchInternal, which needs the
  // parsed scores as arguments, so authentication is as early as it can get here.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // Server-side score bounds — client validation in useScoreForm is UI-only
  // and trivially bypassed by a direct POST to the action endpoint.
  const scoreResult = scoreSchema.safeParse({ teamAScore, teamBScore });
  if (!scoreResult.success) {
    return { success: false, message: scoreResult.error.issues[0].message };
  }
  const { teamAScore: safeA, teamBScore: safeB } = scoreResult.data;

  // Organizer-facing entry: participation is NOT pre-verified, so the shared
  // core runs the organizer-OR-player authorization gate.
  const db = createServiceClient();
  return endMatchInternal(db, matchId, safeA, safeB, user, false);
}

// ============================================================
// endMatchInternal — shared match-completion core
// ============================================================
// Both public entries funnel here after authenticating the GoTrue user and
// validating scores. `participantVerified` lets submitMatchScore skip the
// organizer-OR-player gate (it already proved the caller is in the match),
// removing a duplicate getAuthenticatedUser() + the 2-3-query organizer probe
// on the player score-submit path.
async function endMatchInternal(
  db: ReturnType<typeof createServiceClient>,
  matchId: string,
  safeA: number,
  safeB: number,
  user: { id: string },
  participantVerified: boolean
): Promise<MatchActionResult> {
  // 1. Fetch the match (via service client — guarantees read succeeds
  //    regardless of any read-side RLS policy).
  const { data: match, error: matchFetchError } = await db
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  // Every pre-authorization rejection returns this one object. A missing row
  // carries no session_id and so cannot be authorized at all, which means "no
  // such match" and "not your match" have to answer identically — otherwise the
  // difference between them is itself the answer, and this read goes through
  // the service client, so RLS is no backstop. Audit #12.
  const DENIED = {
    success: false,
    message: "Not authorized. You must be a session organizer or a player in this match.",
  };

  if (matchFetchError || !match) {
    // `participantVerified` means submitMatchScore already proved this caller
    // is in this match, so it already knows the row existed — telling it the
    // row is gone reveals nothing it did not have. Every other caller is still
    // unauthenticated for this match and gets the indistinguishable answer.
    if (matchFetchError) console.error("[endMatch] match fetch failed:", matchFetchError.message);
    return participantVerified ? { success: false, message: "Match not found." } : DENIED;
  }

  // 1b. JS-level authorization: organizer OR player in this match.
  //    Skipped when the caller (submitMatchScore) already verified the player
  //    is in this match. Otherwise run both checks in parallel to avoid serial
  //    round-trips — isSessionOrganizer checks sessions.created_by FIRST (fast
  //    path), then falls back to session_organizers membership.
  //
  //    ORDER: this runs before the status check below, not after. The status
  //    check answers `Match is already completed.` for a row the caller may
  //    have no business reading; only an authorized caller may learn that.
  if (!participantVerified) {
    const [isOrg, playerSlot] = await Promise.all([
      isSessionOrganizer(user.id, match.session_id),
      db
        .from("match_players")
        .select("id")
        .eq("match_id", matchId)
        .eq("player_id", user.id)
        .maybeSingle(),
    ]);

    if (!isOrg && !playerSlot.data) {
      return DENIED;
    }
  }

  if (match.status === "completed" || match.status === "cancelled") {
    return { success: false, message: `Match is already ${match.status}.` };
  }

  // 2. P0-1: Atomic UPDATE — only succeeds if status is still "in_progress".
  //    Adding .eq("status", "in_progress") makes this a compare-and-swap:
  //    if a concurrent caller already changed the status, 0 rows are affected
  //    and `updatedRows` will be empty — we bail out instead of double-completing.
  //
  //    Uses the service client so the primary organizer (sessions.created_by)
  //    is never blocked. JS auth above is the gate; RLS is intentionally bypassed.
  //
  //    NOTE: Do NOT use .single() here. When the CAS guard causes 0 rows to be
  //    updated (concurrent request already completed the match), PostgREST returns
  //    an empty array — .single() throws "Cannot coerce the result to a single JSON
  //    object" instead of returning null, surfacing a confusing error to the player.
  const { data: updatedRows, error: matchUpdateError } = await db
    .from("matches")
    .update({
      team_a_score: safeA,
      team_b_score: safeB,
      status: "completed" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .eq("status", "in_progress") // ← Atomic guard (CAS)
    .select("id");

  if (matchUpdateError) {
    return { success: false, message: `Failed to save scores: ${matchUpdateError.message}` };
  }
  if (!updatedRows || updatedRows.length === 0) {
    // 0 rows affected — another concurrent caller already completed/cancelled.
    return { success: false, message: "Match was already completed by another request." };
  }

  // 3. Fetch all players in this match.
  const { data: matchPlayers, error: playersError } = await db
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
  //
  //    Status guard: only update rows where status is NOT "left".
  //    Without this guard, players who explicitly checked out while
  //    their match was in_progress would be silently re-added to the
  //    queue every time the match ended — creating ghost "waiting"
  //    entries for people who physically left the gym.
  if (matchPlayers && matchPlayers.length > 0) {
    // Ghost-availability fix (R3-1): a finishing player who is the pulled body of
    // a PENDING held draft must be re-reserved as 'drafted', NOT 'waiting' —
    // otherwise they reappear in fetchActivePool and the engine wastes slots on
    // them (each blocked by a guard, so no corruption, but it's a reservation leak).
    const finishingIds = matchPlayers.map((mp) => mp.player_id);
    // Narrow at the DB level: only fetch held drafts where at least one of the
    // finishing players appears in pulled_player_ids. Uses the && (overlaps)
    // operator. Postgres uses the partial B-tree index on session_id (WHERE
    // is_held=true AND status='pending') to limit the scan to the held-pending
    // rows in this session; the && predicate then filters within that small set.
    const { data: heldDrafts } = await db
      .from("matches")
      .select("pulled_player_ids")
      .eq("session_id", match.session_id)
      .eq("status", "pending")
      .eq("is_held", true)
      .overlaps("pulled_player_ids", finishingIds);
    const reservedAsHeld = new Set(
      (heldDrafts ?? [])
        .flatMap((m) => m.pulled_player_ids ?? [])
        .filter((id) => finishingIds.includes(id)) // safety: only flag IDs that are actually finishing
    );

    // Single atomic requeue (replaces a per-player SELECT+UPDATE loop whose JS
    // read-modify-write of games_played could lose a concurrent increment):
    // increment games_played, stamp joined_at, and set status (drafted for a
    // re-reserved held body, else waiting) in one statement. The `status <>
    // 'left'` predicate in the RPC reproduces the maybeSingle-null skip.
    const draftedIds = finishingIds.filter((id) => reservedAsHeld.has(id));
    const { error: requeueError } = await db.rpc("requeue_finished_players", {
      p_session_id: match.session_id,
      p_player_ids: finishingIds,
      p_drafted_ids: draftedIds,
    });
    if (requeueError) {
      console.error("[endMatch] requeue_finished_players failed:", requeueError);
    }
  }

  // 5. PIPELINE: promote oldest on-deck match to the freed court.
  //    Then run the engine so it refills the on-deck slot (if toggle ON).
  //    If no on-deck match exists, free the court — the engine will form
  //    one for next time.
  //    Pass the service client so promotion writes are never RLS-blocked.
  if (match.court_id) {
    // Phase 6: this match just completed, which may have freed a held draft's
    // pulled body — refresh readiness so a now-ready held draft can take the court.
    await recomputeHeldReadiness(db, match.session_id);
    const promoted = await promoteOnDeckMatchInternal(db, match.session_id, match.court_id);

    if (!promoted.success) {
      // No on-deck match — free the court immediately.
      await db
        .from("courts")
        .update({ status: "available" as const })
        .eq("id", match.court_id);
    }
    // Either way, run the engine to refill on-deck from the queue.
    await runEngineForSession(match.session_id);
  }

  // 6. Refresh the all-time leaderboard materialized view.
  //    Fire without awaiting so a slow refresh never delays the player's UI.
  //    CONCURRENTLY means reads are never blocked during refresh. Debounced
  //    since the RPC rebuilds across ALL clubs, not just this match's club.
  if (shouldRefreshLeaderboard()) {
    void db.rpc("refresh_alltime_leaderboard").then(({ error }) => {
      if (error) console.warn("[endMatchAction] leaderboard refresh failed:", error.message);
    });
  }

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

/**
 * Organizer-only score correction or match revert.
 *
 * Two modes controlled by `revertToActive`:
 *   false — corrects the recorded scores on a completed match without re-opening it.
 *   true  — resets scores to 0/0 and transitions the match back to `in_progress`,
 *           reverting players' queue entries to "playing" with games_played decremented.
 *           Use when a score was submitted by accident before the game finished.
 */
export async function updateMatchDetails(
  matchId: string,
  teamAScore: number,
  teamBScore: number,
  revertToActive = false
): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };

  // Score validation deliberately runs AFTER the organizer check below, not
  // here. This is about which answer the caller gets, not about secrecy — the
  // scores are the caller's own arguments, so a validation message tells them
  // nothing they did not already know. The point is that a caller with no
  // business here should be told exactly that, and told it for any payload:
  // with validation first, "Not authorized" is reachable only by sending a
  // well-formed body, which makes the authorization outcome look conditional on
  // the request shape. submitMatchScore above settles authorization the same
  // way (auth + participation, then validate); endMatchAction gets only
  // authentication in first, because its organizer-OR-player gate is inside
  // endMatchInternal, which needs the parsed scores as arguments.
  //
  // ⚠️ This paragraph reasoned only about what runs after the gate, and for a
  // while that made it read as a clean bill of health for the whole function.
  // It was not: the match fetch below ran ABOVE the gate and answered "Match
  // not found." to any authenticated caller, for any match UUID, through the
  // service client. Reasoning carefully about a guard's PRESENCE says nothing
  // about its POSITION. Fixed under audit #12; see the fetch below.

  // All writes use the service client so the primary organizer
  // (sessions.created_by) is never silently blocked by write-side RLS.
  // Auth is verified at the JS layer (getUser + isSessionOrganizer) before any write.
  const db = createServiceClient();

  // P0-3: Organizer-only action.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const { data: match, error: fetchErr } = await db
    .from("matches")
    .select("id, session_id, court_id, status, team_a_score, team_b_score")
    .eq("id", matchId)
    .single();

  // One reply for "no such match" and "not your match". The comment above this
  // function argues about the ORDER of the score validation and the gate; it
  // said nothing about this fetch, which sat above the gate and answered
  // "Match not found." to any authenticated caller for any match UUID, through
  // the service client. A missing row has no session_id to authorize against,
  // so the two cases cannot be told apart without leaking the first. Audit #12.
  if (fetchErr) console.error("[updateMatchDetails] match fetch failed:", fetchErr.message);
  if (fetchErr || !match || !(await isSessionOrganizer(user.id, match.session_id))) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // Validate scores for the edit-only path. The revert path ignores the passed
  // scores entirely (it writes NULL to the DB), so we only gate score-edit calls.
  // Validating unconditionally is still safe because the client always sends 0, 0
  // for revert — but the explicit check communicates intent clearly.
  let safeA = 0;
  let safeB = 0;
  if (!revertToActive) {
    const scoreResult = scoreSchema.safeParse({ teamAScore, teamBScore });
    if (!scoreResult.success) {
      return { success: false, message: scoreResult.error.issues[0].message };
    }
    safeA = scoreResult.data.teamAScore;
    safeB = scoreResult.data.teamBScore;
  }

  const actor = await getActorContext(user.id);

  if (!revertToActive) {
    // ── Score-only edit ──────────────────────────────────────
    const { error } = await db
      .from("matches")
      .update({ team_a_score: safeA, team_b_score: safeB })
      .eq("id", matchId);

    if (error) return { success: false, message: "Failed to update scores." };

    // Best-effort audit (score edits never count as composition modifications).
    await logMatchEvent({
      matchId,
      sessionId: match.session_id,
      eventType: "score_edit",
      phase: "post_completion",
      actorId: actor.id,
      actorName: actor.name,
      payload: {
        old: { a: match.team_a_score, b: match.team_b_score },
        new: { a: safeA, b: safeB },
      },
    });
    return { success: true, message: "Scores updated." };
  }

  // ── Revert to in_progress ────────────────────────────────
  // Try the atomic RPC first (migration 20260512200003).
  // The RPC reverts the match status + bulk-updates all roster players
  // from 'waiting' → 'playing' (games_played - 1) in one transaction,
  // eliminating the N+1 round-trip loop and its silent failure modes.
  const { error: rpcRevertErr } = await db.rpc("revert_match_to_active", {
    p_match_id: matchId,
    p_session_id: match.session_id,
  });

  if (rpcRevertErr && rpcRevertErr.code !== "PGRST202") {
    // RPC exists but returned a domain error.
    const msg = rpcRevertErr.message ?? "";
    if (msg.includes("MATCH_NOT_FOUND")) {
      return { success: false, message: "Match not found." };
    }
    return { success: false, message: "Failed to revert match." };
  }

  if (rpcRevertErr?.code === "PGRST202") {
    // RPC not yet deployed — fall back to the original non-atomic sequence.
    const { error: revertErr } = await db
      .from("matches")
      .update({
        status: "in_progress" as const,
        team_a_score: null,
        team_b_score: null,
        completed_at: null,
      })
      .eq("id", matchId);

    if (revertErr) return { success: false, message: "Failed to revert match." };

    const { data: matchPlayers } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", matchId);

    if (matchPlayers && matchPlayers.length > 0) {
      await Promise.all(
        matchPlayers.map(async (mp) => {
          const { data: entry } = await db
            .from("queue_entries")
            .select("games_played, status")
            .eq("session_id", match.session_id)
            .eq("player_id", mp.player_id)
            .maybeSingle();

          if (entry?.status === "waiting") {
            return db
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
  }

  // Court handling: reclaim if free, detach if occupied or closed.
  // Kept in JS (not in RPC) — conditional court logic, not part of
  // the player-state race condition that the RPC targets.
  if (match.court_id) {
    const { data: court } = await db
      .from("courts")
      .select("status")
      .eq("id", match.court_id)
      .single();

    if (court?.status === "available") {
      await db
        .from("courts")
        .update({ status: "in_use" as const })
        .eq("id", match.court_id);
    } else {
      // Another match occupies or the court is closed — detach.
      await db.from("matches").update({ court_id: null }).eq("id", matchId);
    }
  }

  // Best-effort audit: a revert un-completes a match (players unchanged → never
  // counts as a composition modification).
  await logMatchEvent({
    matchId,
    sessionId: match.session_id,
    eventType: "revert",
    phase: "post_completion",
    actorId: actor.id,
    actorName: actor.name,
    payload: { from_status: match.status },
  });

  return { success: true, message: "Match reverted. Players can re-submit the correct score." };
}

// ============================================================
// cancelMatchAction
// ============================================================

/**
 * Cancels an active (in_progress or pending) match and returns all players to
 * "waiting" status. Players are restored BEFORE the engine runs so they are
 * immediately eligible for the next match generation cycle.
 *
 * Uses a CAS-style guard: reads the current status and aborts if it has already
 * changed — prevents double-cancel under concurrent organizer actions.
 */
export async function cancelMatchAction(matchId: string): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };
  const db = createServiceClient();

  // All DB writes use db (service client) so the primary organizer
  // (sessions.created_by) is never silently blocked by write-side RLS.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // 1. Fetch the match (service client — guarantees read succeeds regardless
  //    of read-side RLS policies).
  const { data: match, error: matchFetchError } = await db
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();

  // One reply for "no such match" and "not your match" — a missing row has no
  // session_id to authorize against, and this read bypasses RLS, so answering
  // them differently is an existence oracle over match UUIDs. The raw
  // PostgREST error text is logged rather than returned: it went to the caller
  // before any authorization ran. Audit #12.
  //
  // ONE condition and ONE return, not two adjacent `if`s holding the same
  // string: two of them drift apart under a later edit and one cannot.
  if (matchFetchError) {
    console.error("[cancelMatch] match fetch failed:", matchFetchError.message);
  }
  if (!match || !(await isSessionOrganizer(user.id, match.session_id))) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (match.status === "completed" || match.status === "cancelled") {
    return { success: false, message: `Match is already ${match.status}.` };
  }

  // 2. P0-1: Atomic UPDATE — guard against double-cancellation.
  //    Only succeeds if the match is still in a cancellable state.
  //
  //    NOTE: Do NOT use .single() here. When .in("status", [...]) matches
  //    0 rows (already cancelled/completed), PostgREST returns an empty array
  //    and .single() throws "Cannot coerce the result to a single JSON object"
  //    instead of returning null.
  const { data: cancelledRows, error: matchUpdateError } = await db
    .from("matches")
    .update({
      status: "cancelled" as const,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .in("status", ["pending", "in_progress"]) // ← Atomic guard (CAS)
    .select("id");

  if (matchUpdateError) {
    return { success: false, message: `Failed to cancel match: ${matchUpdateError.message}` };
  }
  if (!cancelledRows || cancelledRows.length === 0) {
    return {
      success: false,
      message: "Match was already cancelled or completed by another request.",
    };
  }

  // Best-effort audit: lifecycle cancel (does not count as a composition change).
  const cancelActor = await getActorContext(user.id);
  await logMatchEvent({
    matchId,
    sessionId: match.session_id,
    eventType: "cancelled",
    phase: match.status === "in_progress" ? "active" : "draft",
    actorId: cancelActor.id,
    actorName: cancelActor.name,
    payload: { from_status: match.status },
  });

  // 3. Return players to queue WITHOUT incrementing games_played.
  //    Done BEFORE running the engine so returned players are visible
  //    to the matchmaker and can be included in new on-deck matches.
  //
  //    Status guard: only restore players whose current status is NOT
  //    "left". A player who manually checked out while on_deck / in a
  //    pending match should not be pulled back into the queue just
  //    because the organizer later cancelled the match.
  const { data: matchPlayers } = await db
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  let playerIds: string[] = [];
  if (matchPlayers && matchPlayers.length > 0) {
    playerIds = matchPlayers.map((mp) => mp.player_id);
    await db
      .from("queue_entries")
      .update({ status: "waiting" as const })
      .eq("session_id", match.session_id)
      .in("player_id", playerIds)
      .neq("status", "left"); // skip players who already checked out
  }

  // 4. PIPELINE: promote oldest on-deck match to the freed court.
  //    If no on-deck match exists, free the court immediately.
  //    Mirrors the endMatchAction pipeline so behaviour is consistent.
  if (match.court_id) {
    // Phase 6: a cancelled match also frees a held draft's pulled body — refresh readiness.
    await recomputeHeldReadiness(db, match.session_id);
    const promoted = await promoteOnDeckMatchInternal(db, match.session_id, match.court_id);
    if (!promoted.success) {
      // Nothing on deck — free the court for manual use.
      await db
        .from("courts")
        .update({ status: "available" as const })
        .eq("id", match.court_id);
    }
  }

  // 5. Refill on-deck pool (engine exits silently if toggle is OFF).
  await runEngineForSession(match.session_id);

  // 6. Notify affected players AND co-organizers via Realtime Broadcast so
  //    dashboards show a friendly explanation instead of a silent state change.
  //    cancelActor (computed above for the audit log) also lets co-organizers
  //    see "{actor} cancelled a match" while the actor's client skips its own.
  if (playerIds.length > 0) {
    await broadcastOrganizerIntervention(match.session_id, "match_cancelled", playerIds, {
      id: cancelActor.id,
      name: cancelActor.name,
    });
  }

  return { success: true, message: "Match cancelled. Players returned to queue." };
}

// ============================================================
// createManualMatchAction — Organizer-only (P1-2)
// ============================================================
// Moved from the client-side hook to a server action so all
// validation and DB writes run server-side. This prevents a
// disconnected browser from leaving courts permanently in_use
// with no active match row.
// ============================================================
export type CreateManualMatchResult = {
  success: boolean;
  message: string;
  matchId?: string;
};

export async function createManualMatchAction(
  sessionId: string,
  teamAPlayerIds: string[],
  teamBPlayerIds: string[]
): Promise<CreateManualMatchResult> {
  if (!isValidUUID(sessionId)) return { success: false, message: "Invalid session ID." };
  // Validate each player ID in both arrays before any DB call.
  // (allPlayerIds is also used later in the function; a different name avoids redeclaration.)
  const combinedPlayerIds = [...teamAPlayerIds, ...teamBPlayerIds];
  if (combinedPlayerIds.length === 0 || combinedPlayerIds.some((id) => !isValidUUID(id))) {
    return { success: false, message: "Invalid player ID in match." };
  }
  // Auth + organizer check.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }
  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // Closed-session gate — same reasoning as callNextMatch: a stale
  // co-organizer board must not create a new match on a session that has
  // already had its Wrapped stats computed.
  if (!(await isSessionActive(sessionId))) {
    return { success: false, message: "This session has ended." };
  }

  const actor = await getActorContext(user.id);

  const allPlayerIds = [...teamAPlayerIds, ...teamBPlayerIds];
  const svc = createServiceClient();

  // Validate all players are in this session's queue (any status).
  // Gives a clear "not in session" error before hitting the RPC.
  const { data: queueEntries } = await svc
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId)
    .in("player_id", allPlayerIds);

  const foundPlayerIds = new Set((queueEntries ?? []).map((e) => e.player_id));
  const missingPlayers = allPlayerIds.filter((id) => !foundPlayerIds.has(id));
  if (missingPlayers.length > 0) {
    return { success: false, message: "One or more selected players are not in this session." };
  }

  // Compute is_mixed_level from player skill levels.
  const { data: playerProfiles } = await svc
    .from("profiles")
    .select("skill_level")
    .in("id", allPlayerIds);
  const skillLevels = new Set((playerProfiles ?? []).map((p) => p.skill_level));
  const isMixedLevel = skillLevels.size > 1;

  // Single atomic write via the create_match_with_players RPC.
  //
  // Routing through the RPC gives us all three TOCTOU guards for free:
  //   Guard 0 — pre-flight: all players must be 'waiting' (blocks 'left',
  //             'on_deck', 'playing' — prevents assigning an already-committed player)
  //   Guard 1 — row-level lock on queue_entries, preventing concurrent
  //             engine/manual runs from double-booking the same player
  //   Guard 2 — post-lock conflict check: no player may already appear in
  //             another pending/in_progress match_players row
  //
  // The RPC also handles queue promotion atomically: with
  // p_is_published=true it updates all players to 'on_deck' inside the
  // same transaction, so the Jackie B / Carlo partial-update bug cannot
  // recur regardless of which Supabase client was used to invoke it.
  const { data: matchId, error: rpcError } = await svc.rpc("create_match_with_players", {
    p_session_id: sessionId,
    p_court_id: null,
    p_status: "pending",
    p_is_mixed_level: isMixedLevel,
    p_started_at: null,
    p_is_on_deck: true,
    p_team_a_ids: teamAPlayerIds,
    p_team_b_ids: teamBPlayerIds,
    p_origin: "manual",
    p_is_published: true,
    p_actor_id: actor.id,
    p_actor_name: actor.name,
  });

  if (rpcError) {
    return { success: false, message: rpcError.message };
  }

  if (!matchId) {
    // RPC returned NULL: Guard 0 or Guard 2 fired — a player is not
    // 'waiting' or is already committed to another active match.
    return {
      success: false,
      message:
        "Could not create match — one or more players are unavailable or already assigned to an active match.",
    };
  }

  // On-deck ping: a manual on-deck match (p_is_published=true) moves all four
  // players waiting → on_deck. Notify them (OS-level push for backgrounded
  // phones), fired after the response flushes.
  after(() => pushToPlayers(allPlayerIds, "ON_DECK_WARNING", sessionId));

  return { success: true, message: "Match added to On Deck.", matchId };
}
