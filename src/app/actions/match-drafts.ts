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
    .select("id, session_id, status")
    .eq("id", matchId)
    .single();

  if (matchFetchError || !match) {
    return { success: false, message: `Match not found: ${matchFetchError?.message ?? "unknown"}` };
  }

  // Verify caller is an organizer for this session (using the RLS client).
  const organizer = await isSessionOrganizer(user.id, match.session_id);
  if (!organizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  if (match.status !== "pending") {
    return {
      success: false,
      message: `Cannot clear a match with status "${match.status}". Only pending on-deck matches can be cleared.`,
    };
  }

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
    const actor = await getActorContext(user.id);
    await broadcastOrganizerIntervention(match.session_id, "on_deck_cleared", playerIds, {
      id: user.id,
      name: actor.name,
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
// Does NOT trigger the engine — the caller (setCapAndClearDrafts)
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

  // Build individual updates — Supabase JS client doesn't support
  // bulk UPDATE with per-row values, so we fire them concurrently.
  // Use service client so the primary organizer's writes are never
  // silently dropped by write-side RLS on the matches table.
  const updates = orderedMatchIds.map((id, index) =>
    db
      .from("matches")
      .update({ sort_order: index })
      .eq("id", id)
      .eq("session_id", sessionId)
      .eq("status", "pending")
  );

  const results = await Promise.all(updates);
  const firstError = results.find((r) => r.error);
  if (firstError?.error) {
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
    .select("session_id, status, is_published")
    .eq("id", matchId)
    .single();

  if (!match) return { success: false, message: "Match not found." };
  if (match.status !== "pending")
    return { success: false, message: "Only pending (on-deck) matches can be published." };
  if (match.is_published) return { success: true, message: "Already published." };

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
  const { data: draftMatches } = await svc
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false);
  const draftMatchIds = (draftMatches ?? []).map((m) => m.id);

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

  const skippedMsg =
    skippedCount > 0
      ? ` ${skippedCount} draft${skippedCount !== 1 ? "s" : ""} skipped (left players — clear and regenerate).`
      : "";

  // On-deck ping: of the snapshot drafts, the ones now is_published=true were
  // actually published (skipped left-player drafts stay false). Notify their
  // rosters that they're on deck.
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
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false);

  if (draftErr) return { success: false, message: draftErr.message };

  const allDraftIds = (draftMatches ?? []).map((m) => m.id);
  if (allDraftIds.length === 0) {
    return { success: true, message: "No drafts to publish.", publishedCount: 0 };
  }

  const { data: matchPlayerRows } = await svc
    .from("match_players")
    .select("match_id, player_id")
    .in("match_id", allDraftIds);

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

  const allPublishableBeforeConflict = allDraftIds.filter((id) => !taintedMatchIdSet.has(id));
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

  const publishableIds = allDraftIds.filter((id) => !taintedMatchIdSet.has(id));
  const skippedCount = taintedMatchIdSet.size;

  if (publishableIds.length === 0) {
    return {
      success: false,
      message: `All ${allDraftIds.length} draft match${allDraftIds.length !== 1 ? "es have" : " has"} players who left — clear them and let the engine regenerate.`,
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

  const skippedMsg =
    skippedCount > 0
      ? ` ${skippedCount} draft${skippedCount !== 1 ? "s" : ""} skipped (left players — clear and regenerate).`
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
