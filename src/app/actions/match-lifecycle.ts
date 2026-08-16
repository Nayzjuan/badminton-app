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
import { partitionCancelRestore } from "@/lib/cancel-restore";
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
import { closePendingScoreCorrections } from "@/lib/session-notice-write";
import { DUPLICATE_ROSTER_WINDOW_MINUTES } from "@/lib/constants";

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

  // Losing this check is the ordinary outcome of the organizer and a player
  // submitting the same match at almost the same time — the match IS scored,
  // just not by this caller. Tag it so the UI can move the loser on instead of
  // stranding them on a form whose match no longer exists (see the CAS below,
  // which catches the same race one step later).
  if (match.status === "completed" || match.status === "cancelled") {
    return {
      success: false,
      message: `Match is already ${match.status}.`,
      code: match.status === "completed" ? "already_scored" : "match_cancelled",
    };
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
    // This is the true concurrency window: the status check above passed, then
    // the other caller's UPDATE landed first. Settled either way, so the code
    // lets the UI transition rather than surface a red error for something the
    // user cannot act on.
    //
    // Re-read the status instead of assuming "completed". The two outcomes need
    // OPPOSITE copy — after a concurrent complete a score exists and was kept,
    // after a concurrent cancel there is none and the game has to be re-run —
    // and settledMatchToast can only keep them apart if it is handed the right
    // code.
    //
    // Only "cancelled" takes the cancel arm, and the asymmetry is deliberate.
    // The cancel copy states that no score was recorded; an organizer reading
    // that re-runs the game, and re-running one that was in fact scored is how
    // a second row for the same match gets created — the defect this change set
    // exists for. So everything else lands on "already scored": a read error, a
    // deleted row, and one status that is neither settled outcome — "pending",
    // which passes the check above (it rejects only completed/cancelled) and
    // then misses the CAS. That last case is not reachable from either UI today
    // (the player card renders only on in_progress, the organizer's modal opens
    // from a court card), and its copy would be wrong if it ever were, but the
    // wrong-and-harmless direction is the one that does not invent a re-run.
    const { data: settledRow } = await db
      .from("matches")
      .select("status")
      .eq("id", matchId)
      .maybeSingle();
    if (settledRow?.status === "cancelled") {
      return {
        success: false,
        message: "This match was cancelled while the score form was open.",
        code: "match_cancelled",
      };
    }
    return {
      success: false,
      message: "This match was already scored by someone else.",
      code: "already_scored",
    };
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
  //    Without this guard, a player who is already 'left' while their match
  //    was in_progress would be silently re-added to the queue every time the
  //    match ended — creating ghost "waiting" entries for people who
  //    physically left the gym.
  //
  //    NOTE: self-checkout can no longer produce that state — checkoutPlayer
  //    refuses while the caller is on_deck/playing (APP_MANIFEST §3.39). The
  //    guard is still load-bearing via the ORGANIZER path: the
  //    remove_player_from_queue_organizer RPC only sweeps m.status='pending',
  //    so removing a player mid-game sets queue status='left' and leaves the
  //    in_progress match's roster intact — exactly the row this guard skips.
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
    // Deliberately NOT idempotency-guarded: correcting a score is a repeatable
    // operation and the organizer may need several passes at it (a first fix
    // that swapped the teams, then a second that fixes a digit). Every pass
    // writes and appends its own score_edit event.
    //
    // It IS status-guarded. `.eq("status","completed")` makes this a
    // compare-and-swap against the row we authorized: the Edit control only
    // exists on a completed history card, so if the row is no longer completed
    // a concurrent "Revert to Active Court" moved it back onto a court, and
    // stamping a final score onto a live match would silently corrupt the game
    // in progress. 0 rows affected → say so and let the organizer re-read the
    // board. (`.select("id")`, not `.single()`: PostgREST returns an empty
    // array on 0 rows and `.single()` throws a coercion error on it.)
    const { data: editedRows, error } = await db
      .from("matches")
      .update({ team_a_score: safeA, team_b_score: safeB })
      .eq("id", matchId)
      .eq("status", "completed")
      .select("id");

    if (error) return { success: false, message: "Failed to update scores." };
    if (!editedRows || editedRows.length === 0) {
      return {
        success: false,
        message: "This match is no longer completed — it was reverted to an active court.",
        code: "not_completed",
      };
    }

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
    await closePendingScoreCorrections(matchId, "resolved", actor.id);
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

  await closePendingScoreCorrections(matchId, "superseded", actor.id);
  return { success: true, message: "Match reverted. Players can re-submit the correct score." };
}

// ============================================================
// cancelMatchAction
// ============================================================

/**
 * Cancels an active (in_progress or pending) match and returns its roster to the
 * queue. Players are restored BEFORE the engine runs so they are immediately
 * eligible for the next match generation cycle.
 *
 * "Restored" is a three-way partition, not a blanket "waiting" — see step 3 and
 * `partitionCancelRestore`. Ordinary rosters are all-waiting, as before; the two
 * exceptions exist only where a cross-court held draft is involved.
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
  //    Where each roster member goes is a PARTITION, not a constant —
  //    partitionCancelRestore owns the rule, this block only feeds it:
  //
  //    (a) A pulled body whose held draft is still pending comes back
  //        'drafted', not 'waiting' — mirroring endMatchInternal's R3-1 above.
  //        A cancelled source FREES the body (recomputeHeldReadiness counts
  //        'cancelled' alongside 'completed' — matchmaking.ts) and therefore
  //        KEEPS the hold alive, so the seat it reserved must stay reserved.
  //        Recompute cannot repair a wrong status here: no path in it ever
  //        writes 'drafted' — its only queue_entries writes are the ones its
  //        RPCs do (clear_on_deck_match_atomic → 'waiting', auto_publish_match
  //        → 'on_deck'), and neither restores a lost reservation. It also runs
  //        after this block, not before.
  //    (b) A member who physically holds an in_progress match in this session
  //        is not written AT ALL. That is the physical-truth rule migration
  //        20260812000000 put inside clear_on_deck_match_atomic — which this
  //        action bypasses, so it needs its own copy. Reachable here by
  //        cancelling the held draft itself: three drafted members plus one
  //        body who is mid-game on another court.
  //
  //    Both arms rely on the CAS above having ALREADY flipped this match out of
  //    pending/in_progress, which is what lets one predicate set cover both
  //    cases: this match can no longer be the "in_progress match" of (b) nor
  //    the "pending held draft" of (a). Do NOT branch on `match.status` — that
  //    variable holds the PRE-CAS status (it is correct for the audit `phase`
  //    above and wrong for this).
  //
  //    ⚠️ The pending branch is reachable at the server-action level even
  //    though today's UI only offers Cancel on an in_progress court card
  //    (active-courts.tsx filters to in_progress; court-card.tsx renders Clear,
  //    not Cancel, for a pending row). Every export of a "use server" file is a
  //    public endpoint — the UI is not the gate.
  //
  //    Status guard: only restore players whose current status is NOT
  //    "left". A player who manually checked out while on_deck / in a
  //    pending match should not be pulled back into the queue just
  //    because the organizer later cancelled the match. It stays INSIDE each
  //    UPDATE so it is evaluated server-side and honours a checkout that lands
  //    between our reads and our writes.
  //
  //    ⚖️ The three partition-feeding reads below (liveMatches, heldDrafts,
  //    liveRoster — not the roster read, whose degrade is "no restore at all")
  //    are FAIL-OPEN: on error they contribute an empty set and the partition
  //    degrades to the old bulk 'waiting'. Aborting instead is not available:
  //    the CAS above has ALREADY committed the cancel, so an abort cannot
  //    un-cancel it — it would leave all four members at 'playing'/'on_deck'
  //    against a cancelled match, invisible to fetchActivePool, with no
  //    orphaned-status reconciler anywhere in src/. Fail-open degrades to the
  //    known pre-fix bug, which is bounded and self-healing; aborting invents an
  //    unrecoverable state. Moving these reads BEFORE the CAS to allow a clean
  //    abort would destroy the post-CAS ordering the correctness argument rests
  //    on. But a silent degrade is how the original defect hid, so all four
  //    reads log, each naming its own consequence.
  const { data: matchPlayers, error: rosterError } = await db
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  if (rosterError) {
    console.error("[cancelMatch] roster read failed:", rosterError);
  }

  let playerIds: string[] = [];
  if (matchPlayers && matchPlayers.length > 0) {
    playerIds = matchPlayers.map((mp) => mp.player_id);

    const [
      { data: liveMatches, error: liveMatchesError },
      { data: heldDrafts, error: heldDraftsError },
    ] = await Promise.all([
      // Manual join (this codebase declares Relationships: [] — see CLAUDE.md);
      // same two-step shape as fetchPullablePlayers in matchmaking-db.ts.
      db
        .from("matches")
        .select("id")
        .eq("session_id", match.session_id)
        .eq("status", "in_progress"),
      // Same narrowing as R3-1: the partial index on session_id (WHERE
      // is_held=true AND status='pending') limits the scan, then && filters.
      db
        .from("matches")
        .select("pulled_player_ids")
        .eq("session_id", match.session_id)
        .eq("status", "pending")
        .eq("is_held", true)
        .overlaps("pulled_player_ids", playerIds),
    ]);

    // A failed held-draft read degrades to "no holds" → a reserved body is
    // restored to 'waiting' and the hold is stranded: the original defect.
    if (heldDraftsError) {
      console.error(
        "[cancelMatch] held-draft read failed — held seats may be released:",
        heldDraftsError
      );
    }
    // A failed live-match read degrades to "nobody playing" → a mid-game body is
    // flipped to 'waiting': the unseating defect 20260812000000 removed.
    if (liveMatchesError) {
      console.error(
        "[cancelMatch] live-match read failed — a playing body may be unseated:",
        liveMatchesError
      );
    }

    const reservedAsHeld = new Set(
      (heldDrafts ?? [])
        .flatMap((m) => m.pulled_player_ids ?? [])
        .filter((id) => playerIds.includes(id)) // safety: only flag IDs on this roster
    );

    const liveMatchIds = (liveMatches ?? []).map((m) => m.id);
    let playingElsewhere = new Set<string>();
    if (liveMatchIds.length > 0) {
      const { data: liveRoster, error: liveRosterError } = await db
        .from("match_players")
        .select("player_id")
        .in("match_id", liveMatchIds)
        .in("player_id", playerIds);
      // Same degrade as liveMatchesError above — we know live matches exist here
      // but not who is on them, so the skip set comes back empty.
      if (liveRosterError) {
        console.error(
          "[cancelMatch] live-roster read failed — a playing body may be unseated:",
          liveRosterError
        );
      }
      playingElsewhere = new Set((liveRoster ?? []).map((r) => r.player_id));
    }

    const { waitingIds, draftedIds } = partitionCancelRestore({
      rosterIds: playerIds,
      playingElsewhere,
      reservedAsHeld,
    });

    // 'waiting' FIRST, 'drafted' second. If the second write fails, everyone
    // already restored sits at 'waiting' — the benign pre-existing behaviour.
    // The other order would strand up to three members at 'playing': invisible
    // to the queue and physically off court.
    if (waitingIds.length > 0) {
      const { error: waitingError } = await db
        .from("queue_entries")
        .update({ status: "waiting" as const })
        .eq("session_id", match.session_id)
        .in("player_id", waitingIds)
        .neq("status", "left"); // skip players who already checked out
      if (waitingError) {
        console.error("[cancelMatch] restore to waiting failed:", waitingError);
      }
    }
    if (draftedIds.length > 0) {
      const { error: draftedError } = await db
        .from("queue_entries")
        .update({ status: "drafted" as const })
        .eq("session_id", match.session_id)
        .in("player_id", draftedIds)
        .neq("status", "left");
      if (draftedError) {
        console.error("[cancelMatch] held re-reservation failed:", draftedError);
      }
    }
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
  /**
   * `duplicate_roster` is a *soft* refusal: these four already have a completed
   * match in this session inside the recent window. The caller is expected to
   * ask the organizer and, on a yes, re-send with `confirmDuplicate = true`.
   * Any other failure has no code and must not be retried this way.
   */
  code?: "duplicate_roster";
};

export async function createManualMatchAction(
  sessionId: string,
  teamAPlayerIds: string[],
  teamBPlayerIds: string[],
  confirmDuplicate = false
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

  // ── Duplicate-roster soft confirm ─────────────────────────────
  //
  // The one production incident of "two scores for the same match" was not a
  // concurrent double-submit — the CAS in endMatchInternal has always made that
  // impossible on a single row. It was two SEPARATE completed rows for the same
  // game: same four players, same session, created 10 minutes apart, both by the
  // organizer, the second a 19-second retroactive hand-entry of a game that had
  // already been recorded on another court. Nothing downstream can tell those
  // apart from a genuine rematch, so the only place to catch it is here, at
  // creation, while the organizer is still looking at the roster.
  //
  // Deliberately a confirm and not a block: the same four DO rematch, and a hard
  // rule would make a legitimate game unrecordable with no way through. An
  // organizer who means it re-sends with confirmDuplicate.
  if (!confirmDuplicate) {
    const windowStart = new Date(
      Date.now() - DUPLICATE_ROSTER_WINDOW_MINUTES * 60_000
    ).toISOString();

    const { data: recentMatches } = await svc
      .from("matches")
      .select("id, completed_at")
      .eq("session_id", sessionId)
      .eq("status", "completed")
      .gte("completed_at", windowStart);

    if (recentMatches && recentMatches.length > 0) {
      const { data: recentPlayers } = await svc
        .from("match_players")
        .select("match_id, player_id")
        .in(
          "match_id",
          recentMatches.map((m) => m.id)
        );

      // Roster identity is the SET of participants — which side they were on is
      // irrelevant, a rematch with the teams swapped is still the same four.
      const rosterByMatch = new Map<string, Set<string>>();
      for (const row of recentPlayers ?? []) {
        const set = rosterByMatch.get(row.match_id) ?? new Set<string>();
        set.add(row.player_id);
        rosterByMatch.set(row.match_id, set);
      }

      const wanted = new Set(allPlayerIds);
      const duplicate = recentMatches.find((m) => {
        const roster = rosterByMatch.get(m.id);
        if (!roster || roster.size !== wanted.size) return false;
        for (const id of wanted) if (!roster.has(id)) return false;
        return true;
      });

      if (duplicate) {
        // The null arm is a type-level fallback, not a state that can occur:
        // the .gte above already dropped every NULL completed_at (a comparison
        // against NULL is never true). It stays because the column is nullable
        // in the schema, so narrowing it away would mean asserting non-null on
        // a value the type still says may be missing.
        const minutesAgo = duplicate.completed_at
          ? Math.max(
              0,
              Math.round((Date.now() - new Date(duplicate.completed_at).getTime()) / 60_000)
            )
          : null;
        const when =
          minutesAgo === null
            ? "already have a completed match in this session"
            : minutesAgo === 0
              ? "just finished a match together"
              : `finished a match together ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`;
        return {
          success: false,
          code: "duplicate_roster",
          message: `These players ${when}. Creating this match will record a second result for the same lineup. Create it anyway?`,
        };
      }
    }
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
