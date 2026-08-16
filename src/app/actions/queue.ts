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

import { after } from "next/server";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { emitOrganizerNotice } from "@/lib/session-notice-write";
import { isValidUUID } from "@/lib/validate";
import { isSessionOrganizer, isSessionActive, getActorContext } from "@/app/actions/_shared";
import { isRpcNotFound } from "@/lib/rpc-utils";
import { logMatchEvent } from "@/lib/match-event-log";

// ── Checkout ──────────────────────────────────────────────────
// Marks the calling player's queue_entries row as "left" for a
// given session, removing them from matchmaking.
// Calling this while on_deck or playing is allowed — the match
// already in progress is unaffected; they're only removed from
// the future queue so they don't get scheduled again.

export type CheckoutResult = {
  success: boolean;
  error?: string;
};

// ── Soft Pause ────────────────────────────────────────────────
// Toggles `is_paused` on the player's queue_entries row.
// The player remains visible in the organizer dashboard but is
// strictly excluded from the matchmaking engine while paused.
// IMPORTANT: `joined_at` and `games_played` are never touched —
// pausing does NOT forfeit queue position or game stats.

export type TogglePlayerPauseResult = {
  success: boolean;
  error?: string;
};

/**
 * Toggles `is_paused` on a player's queue entry. Paused players remain visible
 * in the organizer dashboard but are excluded from the matchmaking engine.
 *
 * Never touches `joined_at` or `games_played` — pausing does not forfeit queue
 * position or game stats, allowing the organizer to temporarily hold a player
 * without penalising them.
 */
export async function togglePlayerPause(
  sessionId: string,
  playerId: string,
  isPaused: boolean
): Promise<TogglePlayerPauseResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player ID." };
  }
  const supabase = await createServerSupabaseClient();

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
    .update({
      is_paused: isPaused,
      paused_at: isPaused ? new Date().toISOString() : null,
    })
    .eq("session_id", sessionId)
    .eq("player_id", playerId);

  if (error) {
    return { success: false, error: error.message };
  }

  // Engine hook: unpausing re-adds this player to the matching pool.
  // Run the engine so they can be drafted immediately rather than
  // waiting for the next unrelated trigger (join, end-match, etc.).
  // Pausing does not need a trigger — the engine excludes paused players
  // anyway, so no new slots open when a player pauses.
  if (!isPaused) {
    // after(): respond before draft regeneration (mirrors the join path).
    after(() =>
      runEngineForSession(sessionId).catch((err) =>
        console.error("[engine] after() unhandled failure:", err)
      )
    );
  }

  return { success: true };
}

/**
 * Marks the calling player as "left" in the given session, removing them from
 * future matchmaking. REFUSES when the player is on_deck (in a published match
 * awaiting a court) or playing (in an in-progress match): self-leaving mid-match
 * strands a ghost in the roster that breaks the match when it is pulled to a
 * court, so an organizer must remove them (removePlayerFromQueue) instead.
 * 'waiting' and 'drafted' players leave freely.
 *
 * Also cleans up any unpublished draft matches the player is assigned to via the
 * `checkout_player_cleanup_drafts` RPC (falls back to a manual loop if the RPC
 * is not yet deployed on this environment).
 */
export async function checkoutPlayer(sessionId: string): Promise<CheckoutResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Not authenticated." };
  }

  // Service client for the write. The user-context client cannot UPDATE
  // queue_entries once the anon/authenticated UPDATE grant is revoked (that
  // grant is what let an organizer repoint a queue row's player_id at a
  // victim). Authority is unchanged: player_id comes from auth.getUser(), and
  // the .eq("player_id", user.id) filter still scopes the write to the caller's
  // own row — the same shape the organizer path at removePlayerFromQueue uses.
  const svc = createServiceClient();

  // Guard: a player who is ON DECK (in a published match awaiting a court) or
  // PLAYING (in an in-progress match) must not be able to self-checkout. The
  // old behaviour marked them 'left' and only cleaned up UNPUBLISHED drafts, so
  // their published/active match kept a ghost in its roster — and when that
  // on-deck match was pulled to a court it broke the live queue (the incident
  // that motivated this guard). If such a player genuinely must step out, an
  // organizer removes them via removePlayerFromQueue, whose RPC atomically
  // cancels or repairs the affected match. 'waiting'/'drafted' can still leave
  // freely — a drafted player's tentative draft is torn down cleanly below.
  const BLOCKED_WHILE_ACTIVE =
    "You can't leave while you're on deck or in a match. Finish your game, or ask an organizer to remove you.";

  const { data: currentEntry, error: readError } = await svc
    .from("queue_entries")
    .select("status")
    .eq("session_id", sessionId)
    .eq("player_id", user.id)
    .maybeSingle();

  // Fail closed if the status read itself fails. A transient error leaves
  // currentEntry null, and null is indistinguishable from "not in this
  // session": the on_deck/playing check below would not fire, the UPDATE would
  // match 0 rows (an on_deck status is outside its .in() set), and the TOCTOU
  // guard further down is skipped precisely because it requires a non-null
  // currentEntry. The action would return success and the client would
  // navigate away while the player is still in a live roster — the exact
  // false-success this guard exists to remove.
  if (readError) {
    return { success: false, error: "Couldn't check your queue status. Please try again." };
  }

  if (currentEntry?.status === "on_deck" || currentEntry?.status === "playing") {
    return { success: false, error: BLOCKED_WHILE_ACTIVE };
  }

  // Atomic write guarded on a leaveable status. If the engine promoted this
  // player to on_deck/playing in the window between the read above and this
  // write, 0 rows are affected — closing the TOCTOU gap that would otherwise
  // strand a ghost in the freshly-published roster (the exact failure this
  // guard exists to prevent). 'left' stays in the set so a double-checkout
  // remains idempotent (Q-8).
  const { data: leftRows, error } = await svc
    .from("queue_entries")
    .update({ status: "left" as const, is_paused: false, paused_at: null })
    .eq("session_id", sessionId)
    .eq("player_id", user.id)
    .in("status", ["waiting", "drafted", "left"])
    .select("id");

  if (error) {
    return { success: false, error: error.message };
  }

  // currentEntry existed and read as leaveable, yet nothing updated → a
  // concurrent promotion to on_deck/playing beat us. Refuse rather than ghost.
  // (A null currentEntry — player not in this session — updates 0 rows too, but
  // that is a harmless no-op, so it is excluded from this guard.)
  if (currentEntry && (!leftRows || leftRows.length === 0)) {
    return { success: false, error: BLOCKED_WHILE_ACTIVE };
  }

  // Clean up any unpublished draft matches this player is assigned to.
  // The RPC atomically removes the player from draft match_players and
  // cancels the draft if it falls below 4 players.
  const { data: cleanupData, error: cleanupError } = await svc.rpc(
    "checkout_player_cleanup_drafts",
    {
      p_session_id: sessionId,
      p_player_id: user.id,
    }
  );

  const fallbackCancelledIds: string[] = [];
  if (cleanupError) {
    if (isRpcNotFound(cleanupError)) {
      // Fallback: manual non-atomic cleanup (pre-RPC behaviour).
      // TOCTOU risk is acceptable here — the RPC will be deployed soon.
      const { data: draftMatches } = await svc
        .from("matches")
        .select("id")
        .eq("session_id", sessionId)
        .eq("status", "pending")
        .eq("is_published", false);

      if (draftMatches && draftMatches.length > 0) {
        const draftMatchIds = draftMatches.map((m) => m.id);
        const { data: draftEntries } = await svc
          .from("match_players")
          .select("match_id")
          .eq("player_id", user.id)
          .in("match_id", draftMatchIds);

        for (const entry of draftEntries ?? []) {
          await svc
            .from("match_players")
            .delete()
            .eq("match_id", entry.match_id)
            .eq("player_id", user.id);

          const { count } = await svc
            .from("match_players")
            .select("*", { count: "exact", head: true })
            .eq("match_id", entry.match_id);

          if ((count ?? 0) < 4) {
            await svc
              .from("matches")
              .update({ status: "cancelled" as const })
              .eq("id", entry.match_id)
              .eq("status", "pending");
            fallbackCancelledIds.push(entry.match_id);

            // Mirror the RPC: only drafted leftovers return to waiting.
            // A held draft's pulled body stays playing / on_deck.
            const { data: remaining } = await svc
              .from("match_players")
              .select("player_id")
              .eq("match_id", entry.match_id);
            const leftoverIds = (remaining ?? []).map((r) => r.player_id);
            if (leftoverIds.length > 0) {
              await svc
                .from("queue_entries")
                .update({ status: "waiting" as const })
                .eq("session_id", sessionId)
                .in("player_id", leftoverIds)
                .eq("status", "drafted");
            }
          }
        }
      }
    } else {
      console.error("[checkoutPlayer] draft cleanup error:", cleanupError.message);
      // Non-fatal: checkout itself succeeded.
    }
  }

  // Audit: log a 'cancelled' event for each draft the checkout tore down.
  // The RPC soft-cancels (status='cancelled'), so the match row survives and
  // its FK is intact. actorId is null → actor_type 'system' (an automatic
  // consequence of the leaver); the trigger player is recorded in the payload.
  // Best-effort — logMatchEvent never throws.
  const cancelledMatchIds = cleanupError
    ? fallbackCancelledIds
    : (cleanupData ?? [])
        .map((r) => r.cancelled_match_id)
        .filter((id): id is string => Boolean(id));
  for (const mid of cancelledMatchIds) {
    await logMatchEvent({
      matchId: mid,
      sessionId,
      eventType: "cancelled",
      phase: "draft",
      actorId: null,
      actorName: null,
      payload: { reason: "checkout_below_min", trigger_player_id: user.id },
    });
  }

  // Engine hook: the player left, which may have cancelled one or more
  // draft matches (freeing other players back to 'waiting'). Refill those
  // freed slots after the response is sent (mirrors the join path).
  after(() =>
    runEngineForSession(sessionId).catch((err) =>
      console.error("[engine] after() unhandled failure:", err)
    )
  );

  // Q-8 already-left and not-in-session are silent no-ops — do not toast
  // organizers for a retry or a ghost.
  const didLeave = currentEntry != null && currentEntry.status !== "left";
  if (didLeave) {
    const leaver = await getActorContext(user.id);
    await emitOrganizerNotice({
      sessionId,
      kind: "player_left",
      subjectPlayerId: user.id,
      payload: {
        playerName: leaver.name ?? "A player",
        cancelledDraft: cancelledMatchIds.length > 0,
        interrupt: true,
      },
    });
  }

  return { success: true };
}

// success field is mandatory per the action contract (CLAUDE.md).
// Callers that previously only checked `result.error` continue to work
// since the field is additive; new callers should check `result.success`.
export type JoinQueueResult = {
  success: boolean;
  error?: string;
  /** Set when the player must resolve a duplicate name before joining (→ /rename). */
  requiresRename?: boolean;
};

/**
 * Adds or re-activates the calling player in the session queue, applying
 * Inherited Games logic to prevent late joiners from unfairly reaching position #1.
 *
 * Sets `games_played = MAX(player's current, session floor)` in both the first-join
 * and re-join paths — a previous bug applied the floor only on first join, allowing
 * returning players to line-jump with stale 0-game counts.
 *
 * Delegates to the `join_queue` RPC for atomicity; falls back to a manual
 * non-atomic implementation if the RPC is not yet deployed on this environment.
 */
export async function joinQueueAction(sessionId: string): Promise<JoinQueueResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { success: false, error: "Not authenticated. Please refresh and try again." };
  }

  // Duplicate-name gate (L2): a flagged duplicate must resolve their name before
  // a queue entry is created (this is the real mutation boundary — the page-level
  // gate is only a UX redirect). The client routes a requiresRename result to
  // /rename. Single cheap lookup; the column is indexed for flagged rows.
  const { data: gateProfile } = await supabase
    .from("profiles")
    .select("needs_rename")
    .eq("id", user.id)
    .maybeSingle();

  if (gateProfile?.needs_rename) {
    return {
      success: false,
      requiresRename: true,
      error: "Please finish setting your name before joining.",
    };
  }

  // Closed-session gate. `join_queue` has never checked this, and production
  // carries the receipts: two queue entries created 46.7 s and 2.2 s after
  // their session's `ended_at`, both from this button, both by non-organizers
  // whose dashboards had not yet learned the session was over. A late entry is
  // not harmless — closeSession has already marked every entry "left" and run
  // the Wrapped computation, so the new row is both invisible to the recap and
  // permanently stuck in "waiting".
  if (!(await isSessionActive(sessionId))) {
    return { success: false, error: "This session has ended." };
  }

  const svc = createServiceClient();
  const { data: result, error: rpcError } = await svc.rpc("join_queue", {
    p_session_id: sessionId,
    p_player_id: user.id,
  });

  if (rpcError) {
    if (isRpcNotFound(rpcError)) {
      // Fallback: manual non-atomic join (pre-RPC behaviour).
      return await joinQueueFallback(svc, sessionId, user.id);
    }
    console.error("[joinQueueAction] RPC error:", rpcError.message);
    return { success: false, error: rpcError.message };
  }

  if (!result?.success) {
    return { success: false, error: result?.error ?? "Failed to join queue." };
  }

  console.log(`[joinQueueAction] ${result.action} games_played=${result.games_played}`);

  // join_queue does not touch pause. A kicked-while-paused row (or a leftover
  // from before remove started clearing) would otherwise re-enter still paused
  // with a stale paused_at and fire a 15-minute reminder immediately.
  await svc
    .from("queue_entries")
    .update({ is_paused: false, paused_at: null })
    .eq("session_id", sessionId)
    .eq("player_id", user.id)
    .eq("status", "waiting");

  // Fire-and-forget: schedule the engine after the response is sent so the
  // client gets confirmation immediately rather than waiting for matchmaking.
  after(() =>
    runEngineForSession(sessionId).catch((err) =>
      console.error("[engine] after() unhandled failure:", err)
    )
  );
  return { success: true };
}

// ============================================================
// removePlayerFromQueue — Organizer kick with match cleanup (F4)
// ============================================================
// Replaces the raw hook-level UPDATE so that kicking a player
// also cleans up any pending match_players rows. Without this,
// an 'on_deck' player who gets kicked stays in match_players for
// the published pending match, causing contradictory UI state.
//
// Calls remove_player_from_queue_organizer RPC (migration
// 20260512200002) which atomically:
//   1. Locks the queue_entries row.
//   2. Finds all pending matches (published or draft) the player
//      is in and removes them from the roster.
//   3. Cancels any match that falls below 4 players after removal,
//      returning the other players to 'waiting'.
//   4. Sets the player's queue status = 'left'.
//   5. Returns an array of affected match IDs for broadcast.
//
// Falls back to a simple status='left' UPDATE if the RPC is not
// yet deployed on this environment (PGRST202).
// ============================================================

export type RemovePlayerFromQueueResult = {
  success: boolean;
  error?: string;
};

/**
 * Organizer kick with atomic match cleanup — removes a player and cancels any
 * pending matches they're assigned to, returning the other players to "waiting".
 *
 * Delegates to the `remove_player_from_queue_organizer` RPC (migration 20260512200002)
 * which locks the queue row, removes the player from rosters, cancels under-strength
 * matches, and sets queue status = "left" in a single transaction. Falls back to a
 * simple status update if the RPC is not yet deployed (known TOCTOU gap in fallback).
 *
 * On RPC success, broadcasts `match_cancelled` to the remaining players in any
 * cancelled match so they see a toast rather than a silent UI state change.
 */
export async function removePlayerFromQueue(
  sessionId: string,
  playerId: string
): Promise<RemovePlayerFromQueueResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player ID." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Not authenticated." };
  }

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return { success: false, error: "Not authorized. Organizer access required." };
  }

  const svc = createServiceClient();

  // Try the atomic RPC first (migration 20260512200002).
  // The RPC returns the UUIDs of every pending match that was affected
  // (i.e. had the player removed from its roster). We use this list to
  // broadcast a "match_cancelled" notification to the remaining players
  // in those matches so they see a toast instead of a silent state change.
  const { data: affectedMatchIds, error: rpcErr } = await svc.rpc(
    "remove_player_from_queue_organizer",
    { p_session_id: sessionId, p_player_id: playerId }
  );

  if (!rpcErr) {
    // Notify remaining players in any matches that were cancelled.
    const matchIds = (affectedMatchIds ?? []) as string[];
    let cancelledDraft = false;
    if (matchIds.length > 0) {
      const { data: matchPlayers } = await svc
        .from("match_players")
        .select("player_id")
        .in("match_id", matchIds);

      const otherPlayerIds = (matchPlayers ?? []).map((mp) => mp.player_id);
      if (otherPlayerIds.length > 0) {
        await broadcastOrganizerIntervention(sessionId, "match_cancelled", otherPlayerIds);
      }

      // Audit: log a 'cancelled' event for each match the removal actually
      // tore down. The RPC returns EVERY match the player was pulled from, but
      // only those that fell below 4 players were cancelled (status='cancelled');
      // matches that survived the removal are not cancellations and must not be
      // logged as such. Filter to the truly-cancelled rows so the trail answers
      // "who kicked this on-deck match?" — this is the organizer-remove path that
      // PR #22 left un-audited (the Bri/Veejay/Stelle/Alvin incident). The RPC
      // soft-cancels, so the row + FK survive; logging after is safe.
      // Best-effort — logMatchEvent never throws.
      const { data: cancelledRows } = await svc
        .from("matches")
        .select("id, is_published")
        .in("id", matchIds)
        .eq("status", "cancelled");

      if (cancelledRows && cancelledRows.length > 0) {
        // Only unpublished drafts use the "draft was cancelled" card line.
        // Kicking someone off a published on-deck match is a different path.
        cancelledDraft = cancelledRows.some((r) => !r.is_published);
        const actor = await getActorContext(user.id);
        for (const row of cancelledRows) {
          await logMatchEvent({
            matchId: row.id,
            sessionId,
            // The RPC only cancels 'pending' matches (never in_progress), so
            // phase is always "draft" per the codebase convention. The
            // published/on-deck distinction is preserved in the payload.
            eventType: "cancelled",
            phase: "draft",
            actorId: actor.id,
            actorName: actor.name,
            payload: {
              reason: "organizer_removed_player",
              trigger_player_id: playerId,
              was_published: row.is_published,
            },
          });
        }
      }
    }
    // Engine hook: kicking a player may have cancelled a draft (freed other
    // players back to 'waiting'). Refill the freed slot after responding.
    after(() =>
      runEngineForSession(sessionId).catch((err) =>
        console.error("[engine] after() unhandled failure:", err)
      )
    );
    // The organizer RPC only flips status='left'. Clear pause so a kicked
    // paused player who later rejoins does not inherit a stale paused_at.
    await svc
      .from("queue_entries")
      .update({ is_paused: false, paused_at: null })
      .eq("session_id", sessionId)
      .eq("player_id", playerId);
    const [actor, target] = await Promise.all([
      getActorContext(user.id),
      getActorContext(playerId),
    ]);
    await emitOrganizerNotice({
      sessionId,
      kind: "player_checked_out",
      subjectPlayerId: playerId,
      payload: {
        playerName: target.name ?? "A player",
        cancelledDraft,
        actorName: actor.name,
        interrupt: true,
      },
      actorId: actor.id,
      actorName: actor.name,
    });
    return { success: true };
  }

  if (!isRpcNotFound(rpcErr)) {
    // RPC deployed but returned a domain error.
    const msg = rpcErr.message ?? "";
    if (msg.includes("PLAYER_NOT_IN_SESSION")) {
      return { success: false, error: "Player not found in this session." };
    }
    return { success: false, error: msg };
  }

  // Fallback: RPC not yet deployed — simple status update without cleanup.
  // TOCTOU risk is accepted here; the RPC eliminates it once deployed.
  const { error } = await svc
    .from("queue_entries")
    .update({ status: "left" as const, is_paused: false, paused_at: null })
    .eq("session_id", sessionId)
    .eq("player_id", playerId);

  if (error) {
    return { success: false, error: error.message };
  }

  // Engine hook: player removed — refill any freed draft slots after responding.
  after(() =>
    runEngineForSession(sessionId).catch((err) =>
      console.error("[engine] after() unhandled failure:", err)
    )
  );
  const [actor, target] = await Promise.all([getActorContext(user.id), getActorContext(playerId)]);
  await emitOrganizerNotice({
    sessionId,
    kind: "player_checked_out",
    subjectPlayerId: playerId,
    payload: {
      playerName: target.name ?? "A player",
      cancelledDraft: false,
      actorName: actor.name,
      interrupt: true,
    },
    actorId: actor.id,
    actorName: actor.name,
  });
  return { success: true };
}

// Fallback implementation used when the join_queue RPC is not yet deployed.
// This mirrors the pre-RPC logic and carries the same benign TOCTOU caveats
// documented in the original inline comments.
async function joinQueueFallback(
  // Service client, not the user-context one: the re-join branch UPDATEs
  // queue_entries, and the anon/authenticated UPDATE grant is revoked. Passing
  // the service client adds no authority — playerId is already resolved from
  // auth.getUser() at the only call site.
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string,
  playerId: string
): Promise<JoinQueueResult> {
  const { data: existing, error: fetchError } = await supabase
    .from("queue_entries")
    .select("id, games_played, status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();

  if (fetchError) {
    console.error("[joinQueueAction] fetch existing error:", fetchError.message);
    return { success: false, error: fetchError.message };
  }

  if (
    existing &&
    (existing.status === "drafted" ||
      existing.status === "on_deck" ||
      existing.status === "playing")
  ) {
    return {
      success: false,
      error: "You're currently in a match — wait for it to finish before rejoining the queue.",
    };
  }

  const { data: floorRow, error: floorError } = await supabase
    .from("queue_entries")
    .select("games_played")
    .eq("session_id", sessionId)
    .in("status", ["waiting", "drafted", "on_deck", "playing"])
    .order("games_played", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (floorError) {
    console.error("[joinQueueAction] floor query failed:", floorError.message);
  }

  const sessionFloor: number = floorRow?.games_played ?? 0;

  if (existing) {
    const inheritedGames = Math.max(existing.games_played, sessionFloor);
    const { error: updateError } = await supabase
      .from("queue_entries")
      .update({
        status: "waiting" as const,
        games_played: inheritedGames,
        joined_at: new Date().toISOString(),
        is_paused: false,
        paused_at: null,
      })
      .eq("id", existing.id);

    if (updateError) {
      console.error("[joinQueueAction] update error:", updateError.message);
      return { success: false, error: updateError.message };
    }

    after(() =>
      runEngineForSession(sessionId).catch((err) =>
        console.error("[engine] after() unhandled failure:", err)
      )
    );
    return { success: true };
  }

  const { error: insertError } = await supabase.from("queue_entries").insert({
    session_id: sessionId,
    player_id: playerId,
    status: "waiting" as const,
    games_played: sessionFloor,
    joined_at: new Date().toISOString(),
  });

  if (insertError) {
    console.error("[joinQueueAction] insert error:", insertError.message);
    return { success: false, error: insertError.message };
  }

  after(() =>
    runEngineForSession(sessionId).catch((err) =>
      console.error("[engine] after() unhandled failure:", err)
    )
  );
  return { success: true };
}
