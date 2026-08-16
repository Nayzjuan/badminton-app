"use server";

// ============================================================
// match-drafts.ts — On-deck management + draft publishing
// ============================================================
// clearOnDeckMatch            — remove a single on-deck match
// clearAllUnpublishedDrafts   — batch-clear all unpublished drafts
// reorderOnDeckMatches        — drag-reorder sort_order
// publishMatchAction          — publish a single draft
// publishAllDraftMatchesAction — publish all drafts at once
// ============================================================

import { after } from "next/server";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { broadcastOrganizerIntervention } from "@/lib/broadcast";
import { pushToPlayers } from "@/lib/notifications/push-server";
import { isValidUUID } from "@/lib/validate";
import {
  getActorContext,
  getAuthenticatedUser,
  isSessionOrganizer,
  type MatchActionResult,
} from "@/app/actions/_shared";
import { isRpcNotFound } from "@/lib/rpc-utils";
import { logMatchEvent } from "@/lib/match-event-log";
import { isHeldAwaitingReadiness } from "@/lib/cross-court/derive-held-state";

/**
 * Copy for publish_match's HELD_NOT_READY code (migration 20260816000000) and
 * for the JS fallback that mirrors it. Kept in one place so the two paths can't
 * drift into telling the organizer two different things about the same state.
 *
 * Deliberately not phrased as a failure: nothing is wrong with the draft. Its
 * fourth player is still finishing a game on another court, and the engine
 * stamps held_ready_at on its own once that game ends. Contrast HAS_LEFT_PLAYERS
 * and CONFLICT, which both end in "clear and regenerate" because those drafts
 * can never publish. This one can — just not yet — so the only instruction is
 * the opt-out.
 */
const HELD_NOT_READY_MESSAGE =
  "Not ready yet — this cross-court draft is waiting on a player who's still on court. It unlocks by itself when that game ends; clear it if you'd rather not wait.";

/**
 * Roster snapshot for audit payloads — [{ team, player_id, player_name }],
 * keyed by match_id. player_name is captured durably (survives a later profile
 * merge/rename), mirroring the shape of the 'created' event payload. Two bulk
 * queries — no N+1.
 */
async function fetchRosterSnapshots(
  db: ReturnType<typeof createServiceClient>,
  matchIds: string[]
): Promise<Map<string, Array<{ team: string; player_id: string; player_name: string }>>> {
  const map = new Map<string, Array<{ team: string; player_id: string; player_name: string }>>();
  if (matchIds.length === 0) return map;

  const { data: mps } = await db
    .from("match_players")
    .select("match_id, team, player_id")
    .in("match_id", matchIds);
  const rows = mps ?? [];
  if (rows.length === 0) return map;

  const playerIds = [...new Set(rows.map((r) => r.player_id))];
  const { data: profs } = await db.from("profiles").select("id, display_name").in("id", playerIds);
  const nameMap = new Map((profs ?? []).map((p) => [p.id, p.display_name]));

  for (const r of rows) {
    const list = map.get(r.match_id) ?? [];
    list.push({
      team: r.team,
      player_id: r.player_id,
      player_name: nameMap.get(r.player_id) ?? "Unknown",
    });
    map.set(r.match_id, list);
  }
  return map;
}

// ============================================================
// clearOnDeckMatch
// ============================================================
// Clears a pending (on-deck) match and returns its players to
// the waiting queue WITHOUT touching games_played or joined_at,
// preserving their original queue position.
//
// Only works on matches with status = "pending". Rejects if
// the match is already in_progress, completed, or cancelled.
// ============================================================
export async function clearOnDeckMatch(matchId: string): Promise<MatchActionResult> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };
  // Auth + organizer check — caller must be authenticated and an organizer
  // for the session this match belongs to.
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // Use service-role client for all DB operations so RLS does not interfere.
  const db = createServiceClient();

  // 1. Fetch and validate the match.
  const { data: match, error: matchFetchError } = await db
    .from("matches")
    .select("id, session_id, status, is_published, created_method")
    .eq("id", matchId)
    .single();

  // One reply for "no such match" and "not your match". This fetch used to
  // answer `Match not found: <raw PostgREST error>` to any authenticated
  // caller for any match UUID, before a single authorization check ran, and it
  // reads through the service client so RLS is no backstop. A missing row has
  // no session_id to authorize against, so the two cases cannot be told apart
  // without leaking the first; the error text is logged instead. Audit #12.
  //
  // ONE condition and ONE return, not two adjacent `if`s holding the same
  // string: two of them drift apart under a later edit and one cannot.
  // (isSessionOrganizer reads through the service client too — see _shared.ts
  // — so this is a JS-layer gate, not an RLS one.)
  if (matchFetchError) {
    console.error("[clearOnDeckMatch] match fetch failed:", matchFetchError.message);
  }
  if (!match || !(await isSessionOrganizer(user.id, match.session_id))) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (match.status !== "pending") {
    return {
      success: false,
      message: `Cannot clear a match with status "${match.status}". Only pending on-deck matches can be cleared.`,
    };
  }

  // Audit: record the clear BEFORE the RPC deletes the match, so the event's
  // match_id FK is still valid at insert time (ON DELETE SET NULL then nulls
  // match_id while match_id_snapshot preserves it). Best-effort — logMatchEvent
  // never throws, so it can't block the clear. This is the trail that answers
  // "who cleared this match?" for a single on-deck Clear.
  // Actor context and roster snapshot are independent → fetch in parallel.
  const [clearActor, clearRoster] = await Promise.all([
    getActorContext(user.id),
    fetchRosterSnapshots(db, [matchId]),
  ]);
  await logMatchEvent({
    matchId,
    sessionId: match.session_id,
    eventType: "cancelled",
    phase: "draft",
    actorId: clearActor.id,
    actorName: clearActor.name,
    payload: {
      reason: "on_deck_cleared",
      created_method: match.created_method,
      is_published: match.is_published,
      roster: clearRoster.get(matchId) ?? [],
    },
  });

  // 2. Atomic clear via RPC (migration 20260512200001).
  //    The RPC locks the match row, restores players to 'waiting' (skipping
  //    'left' players), deletes the match, and returns the player ID array —
  //    all in a single Postgres transaction.
  const { data: atomicPlayerIds, error: atomicError } = await db.rpc("clear_on_deck_match_atomic", {
    p_match_id: matchId,
    p_session_id: match.session_id,
  });

  let playerIds: string[];

  if (!atomicError) {
    // RPC succeeded — player IDs are returned directly.
    playerIds = (atomicPlayerIds as string[]) ?? [];
  } else if (atomicError.code === "PGRST202") {
    // RPC not yet deployed on this environment — fall back to the original
    // non-atomic sequence (acceptable until all environments are migrated).
    const { data: matchPlayers, error: playersError } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", matchId);

    if (playersError || !matchPlayers) {
      return {
        success: false,
        message: `Failed to fetch match players: ${playersError?.message ?? "unknown"}`,
      };
    }

    playerIds = matchPlayers.map((mp) => mp.player_id);

    if (playerIds.length > 0) {
      const { error: restoreError } = await db
        .from("queue_entries")
        .update({ status: "waiting" as const })
        .eq("session_id", match.session_id)
        .in("player_id", playerIds)
        .neq("status", "left");

      if (restoreError) {
        return {
          success: false,
          message: `Failed to restore players to queue: ${restoreError.message}`,
        };
      }
    }

    const { error: deleteError } = await db.from("matches").delete().eq("id", matchId);
    if (deleteError) {
      return { success: false, message: `Failed to delete on-deck match: ${deleteError.message}` };
    }
  } else {
    // RPC exists but returned a domain error.
    const msg = atomicError.message ?? "";
    if (msg.includes("MATCH_NOT_FOUND")) {
      return { success: false, message: "Match not found." };
    }
    if (msg.includes("MATCH_NOT_PENDING")) {
      return {
        success: false,
        message: `Cannot clear a match with status "${match.status}". Only pending on-deck matches can be cleared.`,
      };
    }
    return { success: false, message: `Failed to clear match: ${msg}` };
  }

  // 3. Notify affected players AND co-organizers via Realtime Broadcast. The
  //    match row is deleted, so every organizer's board drops the card via
  //    Postgres change events — the broadcast turns that silent disappearance
  //    into an explanatory toast (players: "your match was rescheduled";
  //    co-organizers: "{actor} cleared an on-deck match"). The acting
  //    organizer passes their own id so their client suppresses the self-toast.
  if (playerIds.length > 0) {
    await broadcastOrganizerIntervention(match.session_id, "on_deck_cleared", playerIds, {
      id: user.id,
      name: clearActor.name,
    });
  }

  // 4. Engine hook: a slot just opened up — refill on-deck if toggle is ON.
  await runEngineForSession(match.session_id);

  return { success: true, message: "On-deck match cleared. Players returned to queue." };
}

// ============================================================
// clearAllUnpublishedDrafts — batch clear for cap-change reset
// ============================================================
// Atomically clears ALL is_published=false pending matches for
// a session via a single Postgres RPC. Returns all affected
// players to 'waiting' status. Published on-deck matches are
// untouched.
//
// Does NOT trigger the engine — the caller (applyDraftCapOverride)
// is responsible for running the engine after this resolves.
// ============================================================

export type ClearAllDraftsResult = {
  success: boolean;
  message: string;
  clearedCount: number;
  affectedPlayerIds: string[];
};

/**
 * Batch-clear all unpublished draft matches for a session.
 * Called as phase 1 of the cap-change reset flow.
 */
export async function clearAllUnpublishedDrafts(sessionId: string): Promise<ClearAllDraftsResult> {
  if (!isValidUUID(sessionId)) {
    return {
      success: false,
      message: "Invalid session ID.",
      clearedCount: 0,
      affectedPlayerIds: [],
    };
  }

  const user = await getAuthenticatedUser();
  if (!user) {
    return {
      success: false,
      message: "Not authenticated.",
      clearedCount: 0,
      affectedPlayerIds: [],
    };
  }

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) {
    return {
      success: false,
      message: "Organizer access required.",
      clearedCount: 0,
      affectedPlayerIds: [],
    };
  }

  const db = createServiceClient();

  // Audit: capture the drafts + rosters and log a 'cancelled' event per match
  // BEFORE the RPC deletes them (best-effort). Filter mirrors the RPC exactly
  // (pending + unpublished + not-held) so the audit set matches what's swept.
  const { data: draftRows } = await db
    .from("matches")
    .select("id, created_method")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false)
    .not("is_held", "is", true);
  const draftMatches = draftRows ?? [];
  if (draftMatches.length > 0) {
    // Actor context and roster snapshots are independent → fetch in parallel.
    const [batchActor, batchRoster] = await Promise.all([
      getActorContext(user.id),
      fetchRosterSnapshots(
        db,
        draftMatches.map((m) => m.id)
      ),
    ]);
    await Promise.all(
      draftMatches.map((m) =>
        logMatchEvent({
          matchId: m.id,
          sessionId,
          eventType: "cancelled",
          phase: "draft",
          actorId: batchActor.id,
          actorName: batchActor.name,
          payload: {
            reason: "batch_clear_unpublished",
            created_method: m.created_method,
            roster: batchRoster.get(m.id) ?? [],
          },
        })
      )
    );
  }

  // Single atomic RPC — clears all drafts and returns player IDs in one transaction.
  const { data: playerIds, error } = await db.rpc("clear_all_unpublished_drafts", {
    p_session_id: sessionId,
  });

  if (error) {
    return {
      success: false,
      message: `Failed to clear drafts: ${error.message}`,
      clearedCount: 0,
      affectedPlayerIds: [],
    };
  }

  const ids = (playerIds as string[]) ?? [];

  // Broadcast so affected players see the "you've been removed" notification.
  if (ids.length > 0) {
    void broadcastOrganizerIntervention(sessionId, "on_deck_cleared", ids);
  }

  return {
    success: true,
    message: `Cleared all unpublished drafts. ${ids.length} player(s) returned to queue.`,
    clearedCount: ids.length,
    affectedPlayerIds: ids,
  };
}

// ============================================================
// reorderOnDeckMatches — persist drag-and-drop sort order
// ============================================================
// Bulk-updates the sort_order column for a set of on-deck
// matches in one round trip. Called optimistically — the UI
// has already reordered before this resolves.
// ============================================================

/**
 * Persists the drag-and-drop sort order for on-deck matches.
 *
 * Called optimistically — the UI has already reordered locally. A failure here
 * causes a soft desync that resolves on the next realtime refresh, which is
 * acceptable since `sort_order` is a UX hint, not a functional constraint.
 *
 * Uses concurrent updates rather than a transaction because each row's
 * `sort_order` is independent and partial writes are recoverable.
 */
export async function reorderOnDeckMatches(
  sessionId: string,
  orderedMatchIds: string[]
): Promise<MatchActionResult> {
  if (!isValidUUID(sessionId)) return { success: false, message: "Invalid session ID." };
  if (orderedMatchIds.some((id) => !isValidUUID(id))) {
    return { success: false, message: "Invalid match ID in reorder list." };
  }
  const db = createServiceClient();

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Unauthorized" };

  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) return { success: false, message: "Forbidden" };

  // One set-based UPDATE (was one UPDATE per match): the RPC assigns
  // sort_order = array position (0-based), scoped to this session's pending
  // matches — identical semantics to the old per-row loop.
  const { error } = await db.rpc("reorder_on_deck_matches", {
    p_session_id: sessionId,
    p_match_ids: orderedMatchIds,
  });
  if (error) {
    return { success: false, message: "Failed to save order." };
  }

  return { success: true, message: "Order saved." };
}

// ============================================================
// publishMatchAction
// ============================================================
// Transitions a single draft (is_published=false, status=pending)
// match to published (is_published=true). Once published the match
// becomes visible to players and the TV view, and is eligible for
// court promotion by promoteOnDeckMatchInternal.
//
// The UPDATE is guarded by .eq("status", "pending") so a match that
// has already been promoted or cancelled cannot be accidentally
// republished.

export async function publishMatchAction(
  matchId: string
): Promise<{ success: boolean; message: string }> {
  if (!isValidUUID(matchId)) return { success: false, message: "Invalid match ID." };

  const db = await createServerSupabaseClient();
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Unauthorized" };

  const { data: match } = await db.from("matches").select("session_id").eq("id", matchId).single();

  if (!match) return { success: false, message: "Match not found." };

  const isOrganizer = await isSessionOrganizer(user.id, match.session_id);
  if (!isOrganizer) return { success: false, message: "Forbidden" };

  const svc = createServiceClient();
  const { data: result, error: rpcError } = await svc.rpc("publish_match", {
    p_match_id: matchId,
    p_session_id: match.session_id,
    p_user_id: user.id,
  });

  if (rpcError) {
    if (isRpcNotFound(rpcError)) {
      // Fallback: manual non-atomic publish (pre-RPC behaviour).
      return await publishMatchFallback(svc, matchId, match.session_id);
    }
    return { success: false, message: `Publish failed: ${rpcError.message}` };
  }

  switch (result) {
    case "SUCCESS": {
      // On-deck ping: this draft's players just transitioned drafted → on_deck.
      // Fetch the roster and notify them (OS-level push for backgrounded phones),
      // fired after the response flushes.
      const { data: rosterRows } = await svc
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchId);
      const rosterIds = (rosterRows ?? []).map((r) => r.player_id);
      after(() => pushToPlayers(rosterIds, "ON_DECK_WARNING", match.session_id));

      // Engine hook: publishing moves this draft out of the review queue,
      // opening a slot. Refill immediately so the organizer has fresh drafts.
      await runEngineForSession(match.session_id);
      return { success: true, message: "Match published." };
    }
    case "NOT_ORGANIZER":
      return { success: false, message: "Forbidden" };
    case "NOT_FOUND":
      return { success: false, message: "Match not found." };
    case "NOT_PENDING":
      return { success: false, message: "Only pending (on-deck) matches can be published." };
    case "ALREADY_PUBLISHED":
      // Already on-deck — no slot was newly vacated, no engine trigger needed.
      return { success: true, message: "Already published." };
    case "HELD_NOT_READY":
      return { success: false, message: HELD_NOT_READY_MESSAGE };
    case "HAS_LEFT_PLAYERS":
      return {
        success: false,
        message:
          "Cannot publish — a player has left the session. Clear this draft and let the engine regenerate.",
      };
    case "CONFLICT":
      return {
        success: false,
        message:
          "Cannot publish — a player is already assigned to another active match. Clear this draft and let the engine regenerate.",
      };
    default:
      return { success: false, message: "Publish failed." };
  }
}

// Fallback implementation used when the publish_match RPC is not yet deployed.
async function publishMatchFallback(
  svc: ReturnType<typeof createServiceClient>,
  matchId: string,
  sessionId: string
): Promise<{ success: boolean; message: string }> {
  const { data: match } = await svc
    .from("matches")
    .select("session_id, status, is_published, is_held, held_ready_at")
    .eq("id", matchId)
    .single();

  if (!match) return { success: false, message: "Match not found." };
  if (match.status !== "pending")
    return { success: false, message: "Only pending (on-deck) matches can be published." };
  if (match.is_published) return { success: true, message: "Already published." };

  // Mirrors publish_match's HELD_NOT_READY guard, and for the same reason it
  // sits ahead of the left/conflict checks below: the held draft's fourth player
  // is on court, so the conflict query is guaranteed to match and would report a
  // waiting draft as a broken one.
  if (isHeldAwaitingReadiness(match)) {
    return { success: false, message: HELD_NOT_READY_MESSAGE };
  }

  const { data: matchPlayerRows } = await svc
    .from("match_players")
    .select("player_id")
    .eq("match_id", matchId);

  const playerIds = (matchPlayerRows ?? []).map((r) => r.player_id);

  if (playerIds.length > 0) {
    const { data: leftPlayers } = await svc
      .from("queue_entries")
      .select("player_id")
      .eq("session_id", sessionId)
      .in("player_id", playerIds)
      .eq("status", "left");

    if (leftPlayers && leftPlayers.length > 0) {
      return {
        success: false,
        message: `Cannot publish — ${leftPlayers.length} player${leftPlayers.length !== 1 ? "s have" : " has"} left the session. Clear this draft and let the engine regenerate.`,
      };
    }

    const { data: otherActiveMatches } = await svc
      .from("matches")
      .select("id")
      .eq("session_id", sessionId)
      .in("status", ["pending", "in_progress"])
      .neq("id", matchId);

    if (otherActiveMatches && otherActiveMatches.length > 0) {
      const { data: conflictRows } = await svc
        .from("match_players")
        .select("player_id")
        .in(
          "match_id",
          otherActiveMatches.map((m) => m.id)
        )
        .in("player_id", playerIds);

      if (conflictRows && conflictRows.length > 0) {
        return {
          success: false,
          message: `Cannot publish — ${conflictRows.length} player${conflictRows.length !== 1 ? "s are" : " is"} already assigned to another active match. Clear this draft and let the engine regenerate.`,
        };
      }
    }
  }

  const { error } = await svc
    .from("matches")
    .update({ is_published: true })
    .eq("id", matchId)
    .eq("status", "pending")
    .eq("is_published", false);

  if (error) return { success: false, message: "Failed to publish match." };

  if (playerIds.length > 0) {
    // Promote players to 'on_deck'. Engine-generated drafts keep players at
    // 'waiting' (the RPC never updates status for p_is_published=false — see
    // migration 20260507000000 comment "Draft (unpublished) → no update").
    // Swap-drafted players land at 'drafted'. Include both so either path works.
    await svc
      .from("queue_entries")
      .update({ status: "on_deck" as const })
      .eq("session_id", sessionId)
      .in("player_id", playerIds)
      .in("status", ["drafted", "waiting"]);
  }

  // Engine hook: publishing a draft moves it out of the review queue,
  // opening a slot for a new draft. Refill immediately so the organizer
  // always has a fresh set of drafts ready to review.
  await runEngineForSession(sessionId);

  return { success: true, message: "Match published." };
}

// ============================================================
// publishAllDraftMatchesAction
// ============================================================
// Publishes ALL draft (is_published=false, status=pending) matches
// for a session in a single UPDATE. Used by the "Publish All" banner
// in the On-Deck panel.

export async function publishAllDraftMatchesAction(
  sessionId: string
): Promise<{ success: boolean; message: string; publishedCount?: number; skippedCount?: number }> {
  if (!isValidUUID(sessionId)) return { success: false, message: "Invalid session ID." };

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Unauthorized" };

  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) return { success: false, message: "Forbidden" };

  const svc = createServiceClient();

  // Snapshot which matches are drafts right now, so after the bulk publish we
  // can ping exactly the players who transitioned drafted → on_deck.
  //
  // Unready held drafts are dropped from the snapshot to match publish_all_drafts,
  // which excludes them from its candidate set. They are the one draft the RPC
  // will not touch, so including them here would only widen the "did this one
  // flip to is_published?" re-read below onto rows that cannot have flipped.
  const { data: draftMatches } = await svc
    .from("matches")
    .select("id, is_held, held_ready_at")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false);
  const draftMatchIds = (draftMatches ?? [])
    .filter((m) => !isHeldAwaitingReadiness(m))
    .map((m) => m.id);

  const { data: result, error: rpcError } = await svc.rpc("publish_all_drafts", {
    p_session_id: sessionId,
    p_user_id: user.id,
  });

  if (rpcError) {
    if (isRpcNotFound(rpcError)) {
      // Fallback: manual non-atomic bulk publish (pre-RPC behaviour).
      return await publishAllDraftsFallback(svc, sessionId);
    }
    return { success: false, message: `Publish failed: ${rpcError.message}` };
  }

  if (!result?.success) {
    return { success: false, message: result?.error ?? "Publish failed." };
  }

  const publishedCount = result.published_count ?? 0;
  const skippedCount = result.skipped_count ?? 0;

  // A skip is now a roster problem the organizer has to clear. It used to read
  // "(left players)" unconditionally, which was wrong for every held draft: those
  // were skipped as CONFLICTs because their fourth player was mid-game, and
  // "clear and regenerate" was exactly the wrong advice. Held drafts are no longer
  // candidates at all (see migration 20260816000000), so the causes an organizer
  // can act on are a departed player and a genuine double-booking — both of which
  // do want a clear. The RPC has a third skip arm (the row stopped being a pending
  // unpublished draft between the candidate snapshot and the FOR UPDATE), but that
  // is a concurrency race resolved by someone else's action, not a state the
  // organizer has to fix; it is rare enough to leave under the same copy rather
  // than widen the message for it.
  const skippedMsg =
    skippedCount > 0
      ? ` ${skippedCount} draft${skippedCount !== 1 ? "s" : ""} skipped — a player left or is already in another match. Clear and regenerate.`
      : "";

  // On-deck ping: of the snapshot drafts, the ones now is_published=true were
  // actually published (skipped drafts stay false). Notify their rosters that
  // they're on deck.
  if (publishedCount > 0 && draftMatchIds.length > 0) {
    const { data: publishedMatches } = await svc
      .from("matches")
      .select("id")
      .in("id", draftMatchIds)
      .eq("is_published", true)
      .eq("status", "pending");
    const publishedIds = (publishedMatches ?? []).map((m) => m.id);
    if (publishedIds.length > 0) {
      const { data: rosterRows } = await svc
        .from("match_players")
        .select("player_id")
        .in("match_id", publishedIds);
      const rosterIds = (rosterRows ?? []).map((r) => r.player_id);
      after(() => pushToPlayers(rosterIds, "ON_DECK_WARNING", sessionId));
    }
  }

  // Engine hook: all drafts were just moved to on-deck, emptying the review
  // queue. Refill immediately so new drafts are ready for the next review cycle.
  if (publishedCount > 0) {
    await runEngineForSession(sessionId);
  }

  return {
    success: true,
    message:
      publishedCount > 0
        ? `${publishedCount} draft match${publishedCount !== 1 ? "es" : ""} published.${skippedMsg}`
        : `No drafts published.${skippedMsg}`,
    publishedCount,
    skippedCount,
  };
}

// Fallback implementation used when the publish_all_drafts RPC is not yet deployed.
async function publishAllDraftsFallback(
  svc: ReturnType<typeof createServiceClient>,
  sessionId: string
): Promise<{ success: boolean; message: string; publishedCount?: number; skippedCount?: number }> {
  const { data: draftMatches, error: draftErr } = await svc
    .from("matches")
    .select("id, is_held, held_ready_at")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false);

  if (draftErr) return { success: false, message: draftErr.message };

  // Two lists, deliberately. allDraftIds keeps EVERY draft, because it is the
  // exclusion set for the conflict probe further down — narrowing it would turn
  // held drafts into "other active matches" and let them taint their neighbours.
  // candidateIds is what we actually try to publish, and unready held drafts are
  // not candidates (mirrors publish_all_drafts' v_all_draft_ids predicate).
  const allDraftIds = (draftMatches ?? []).map((m) => m.id);
  const candidateIds = (draftMatches ?? [])
    .filter((m) => !isHeldAwaitingReadiness(m))
    .map((m) => m.id);
  if (candidateIds.length === 0) {
    return { success: true, message: "No drafts to publish.", publishedCount: 0 };
  }

  const { data: matchPlayerRows } = await svc
    .from("match_players")
    .select("match_id, player_id")
    .in("match_id", candidateIds);

  const allPlayerIds = [...new Set((matchPlayerRows ?? []).map((r) => r.player_id))];

  const taintedMatchIdSet = new Set<string>();
  if (allPlayerIds.length > 0) {
    const { data: leftEntries } = await svc
      .from("queue_entries")
      .select("player_id")
      .eq("session_id", sessionId)
      .in("player_id", allPlayerIds)
      .eq("status", "left");

    if (leftEntries && leftEntries.length > 0) {
      const leftPlayerSet = new Set(leftEntries.map((e) => e.player_id));
      for (const row of matchPlayerRows ?? []) {
        if (leftPlayerSet.has(row.player_id)) taintedMatchIdSet.add(row.match_id);
      }
    }
  }

  const allPublishableBeforeConflict = candidateIds.filter((id) => !taintedMatchIdSet.has(id));
  if (allPublishableBeforeConflict.length > 0) {
    const { data: otherActiveMatches } = await svc
      .from("matches")
      .select("id")
      .eq("session_id", sessionId)
      .in("status", ["pending", "in_progress"])
      .not("id", "in", `(${allDraftIds.join(",")})`);

    if (otherActiveMatches && otherActiveMatches.length > 0) {
      const otherMatchIds = otherActiveMatches.map((m) => m.id);
      const publishablePlayers = (matchPlayerRows ?? []).filter((r) =>
        allPublishableBeforeConflict.includes(r.match_id)
      );
      const { data: conflictRows } = await svc
        .from("match_players")
        .select("player_id, match_id")
        .in("match_id", otherMatchIds)
        .in(
          "player_id",
          publishablePlayers.map((r) => r.player_id)
        );

      if (conflictRows && conflictRows.length > 0) {
        const conflictPlayerSet = new Set(conflictRows.map((r) => r.player_id));
        for (const row of publishablePlayers) {
          if (conflictPlayerSet.has(row.player_id)) {
            taintedMatchIdSet.add(row.match_id);
          }
        }
      }
    }
  }

  const publishableIds = candidateIds.filter((id) => !taintedMatchIdSet.has(id));
  const skippedCount = taintedMatchIdSet.size;

  if (publishableIds.length === 0) {
    return {
      success: false,
      // Counts candidates, not all drafts: an unready held draft was never
      // attempted, so it is not one of the matches that "can't publish".
      message: `All ${candidateIds.length} draft match${candidateIds.length !== 1 ? "es have" : " has"} a player who left or is already in another match — clear them and let the engine regenerate.`,
      publishedCount: 0,
      skippedCount,
    };
  }

  const { data, error } = await svc
    .from("matches")
    .update({ is_published: true })
    .in("id", publishableIds)
    .eq("status", "pending")
    .eq("is_published", false)
    .select("id");

  if (error) return { success: false, message: "Failed to publish drafts." };

  const publishedCount = data?.length ?? 0;

  if (publishedCount > 0) {
    const publishedMatchIds = new Set(data.map((m) => m.id));
    const publishedPlayerIds = [
      ...new Set(
        (matchPlayerRows ?? [])
          .filter((r) => publishedMatchIds.has(r.match_id))
          .map((r) => r.player_id)
      ),
    ];

    if (publishedPlayerIds.length > 0) {
      // Same fix as publishMatchFallback: engine-generated drafts keep players
      // at 'waiting'; swap-drafted players land at 'drafted'. Include both.
      await svc
        .from("queue_entries")
        .update({ status: "on_deck" as const })
        .eq("session_id", sessionId)
        .in("player_id", publishedPlayerIds)
        .in("status", ["drafted", "waiting"]);
    }
  }

  // Same wording as the RPC path — see the note there.
  const skippedMsg =
    skippedCount > 0
      ? ` ${skippedCount} draft${skippedCount !== 1 ? "s" : ""} skipped — a player left or is already in another match. Clear and regenerate.`
      : "";

  // Engine hook: refill the review queue after publishing.
  if (publishedCount > 0) {
    await runEngineForSession(sessionId);
  }

  return {
    success: true,
    message:
      publishedCount > 0
        ? `${publishedCount} draft match${publishedCount !== 1 ? "es" : ""} published.${skippedMsg}`
        : `No drafts published.${skippedMsg}`,
    publishedCount,
    skippedCount,
  };
}
