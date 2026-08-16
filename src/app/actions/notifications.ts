"use server";

// ============================================================
// Notification Server Actions
// ============================================================
// sendPlayerNotification — Web Push via VAPID (existing)
// list / markRead / request / resolve — session inbox (§3.43)
// Writers (emit / close pending) live in session-notice-write.ts (server-only)
// ============================================================

import { pushToPlayers, type NotificationType } from "@/lib/notifications/push-server";
import { createServiceClient } from "@/utils/supabase/service";
import {
  getAuthenticatedUser,
  getActorContext,
  isSessionActive,
  isSessionOrganizer,
} from "@/app/actions/_shared";
import { isValidUUID } from "@/lib/validate";
import { scoreSchema } from "@/lib/schemas/match";
import { pauseRemindBucket, minutesPaused } from "@/lib/organizer-alerts";
import { broadcastQueueNotice } from "@/lib/broadcast";
import { emitOrganizerNotice, isMissingNoticeTable } from "@/lib/session-notice-write";
import { logMatchEvent } from "@/lib/match-event-log";
import { isRpcNotFound } from "@/lib/rpc-utils";
import type { SessionNotification } from "@/types/database";

export type { NotificationType };

/**
 * Send a Web Push notification to all registered devices for `userId`.
 * Delegates to `pushToPlayers`. Silently no-ops if the user has no
 * push subscriptions. Returns `{ sent, errors }`.
 */
export async function sendPlayerNotification(
  userId: string,
  type: NotificationType,
  sessionId?: string
): Promise<{ sent: number; errors: number }> {
  return pushToPlayers([userId], type, sessionId);
}

export type ActionResult = {
  success: boolean;
  error?: string;
  message?: string;
  alreadyResolved?: boolean;
  actorName?: string | null;
  notification?: SessionNotification | null;
  currentScoreA?: number;
  currentScoreB?: number;
};

function asNotification(row: unknown): SessionNotification {
  return row as SessionNotification;
}

export async function listSessionNotifications(sessionId: string): Promise<{
  success: boolean;
  error?: string;
  notifications: SessionNotification[];
}> {
  if (!isValidUUID(sessionId))
    return { success: false, error: "Invalid session.", notifications: [] };
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated.", notifications: [] };
  if (!(await isSessionOrganizer(user.id, sessionId))) {
    return { success: false, error: "Not authorized.", notifications: [] };
  }

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("session_notifications")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (isMissingNoticeTable(error)) return { success: true, notifications: [] };
    return { success: false, error: error.message, notifications: [] };
  }
  return { success: true, notifications: (data ?? []) as SessionNotification[] };
}

export async function markNotificationRead(notificationId: string): Promise<ActionResult> {
  if (!isValidUUID(notificationId)) return { success: false, error: "Invalid notification." };
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const svc = createServiceClient();
  const { data: existing, error: readErr } = await svc
    .from("session_notifications")
    .select("id, session_id, kind, status")
    .eq("id", notificationId)
    .maybeSingle();
  if (readErr || !existing) {
    if (isMissingNoticeTable(readErr)) return { success: true };
    return { success: false, error: "Notification not found." };
  }
  if (!(await isSessionOrganizer(user.id, existing.session_id))) {
    return { success: false, error: "Not authorized." };
  }
  if (
    existing.kind === "score_correction" &&
    (existing.status === "unread" || existing.status === "read")
  ) {
    return { success: true };
  }
  if (existing.status !== "unread") return { success: true };

  const { error } = await svc
    .from("session_notifications")
    .update({ status: "read" as const })
    .eq("id", notificationId)
    .eq("status", "unread");
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function recordPauseReminder(
  sessionId: string,
  playerId: string,
  bucket: number,
  interrupt: boolean
): Promise<ActionResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player." };
  }
  if (!Number.isInteger(bucket) || bucket < 1) {
    return { success: false, error: "Invalid pause bucket." };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };
  if (!(await isSessionOrganizer(user.id, sessionId))) {
    return { success: false, error: "Not authorized." };
  }
  if (!(await isSessionActive(sessionId))) {
    return { success: false, error: "This session has ended." };
  }

  const svc = createServiceClient();
  const { data: entry, error: entryErr } = await svc
    .from("queue_entries")
    .select("player_id, is_paused, paused_at, status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();
  if (entryErr || !entry) return { success: false, error: "Player not in this session." };
  if (!entry.is_paused || entry.status === "left") {
    return { success: false, error: "Player is not paused." };
  }
  const minutes = minutesPaused(entry.paused_at, Date.now());
  if (minutes === null) return { success: false, error: "Pause time is missing." };
  const computed = pauseRemindBucket(minutes);
  if (computed !== bucket) {
    return { success: false, error: "Pause bucket does not match the clock." };
  }

  const actor = await getActorContext(playerId);
  const emitted = await emitOrganizerNotice({
    sessionId,
    kind: "player_paused_long",
    subjectPlayerId: playerId,
    payload: {
      playerName: actor.name ?? "A player",
      bucket,
      interrupt,
    },
    status: interrupt ? "unread" : "read",
  });
  return { success: true, notification: emitted.row };
}

export async function requestScoreCorrection(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<ActionResult> {
  if (!isValidUUID(matchId)) return { success: false, error: "Invalid match." };
  const parsed = scoreSchema.safeParse({ teamAScore, teamBScore });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid scores." };
  }

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const svc = createServiceClient();
  const { data: match, error: matchErr } = await svc
    .from("matches")
    .select("id, session_id, status, team_a_score, team_b_score")
    .eq("id", matchId)
    .maybeSingle();
  if (matchErr || !match) return { success: false, error: "Match not found." };
  if (match.status !== "completed") {
    return { success: false, error: "You can only request a correction on a completed match." };
  }
  if (!(await isSessionActive(match.session_id))) {
    return { success: false, error: "This session has ended." };
  }

  const { data: seat } = await svc
    .from("match_players")
    .select("player_id, team")
    .eq("match_id", matchId)
    .eq("player_id", user.id)
    .maybeSingle();
  if (!seat) return { success: false, error: "You were not in this match." };

  const { data: roster } = await svc
    .from("match_players")
    .select("player_id, team")
    .eq("match_id", matchId);
  const ids = (roster ?? []).map((r) => r.player_id);
  const { data: profiles } = await svc.from("profiles").select("id, display_name").in("id", ids);
  const nameOf = (id: string) => profiles?.find((p) => p.id === id)?.display_name ?? "Player";
  const teamANames = (roster ?? []).filter((r) => r.team === "a").map((r) => nameOf(r.player_id));
  const teamBNames = (roster ?? []).filter((r) => r.team === "b").map((r) => nameOf(r.player_id));

  const requester = await getActorContext(user.id);
  const emitted = await emitOrganizerNotice({
    sessionId: match.session_id,
    kind: "score_correction",
    subjectPlayerId: user.id,
    matchId,
    payload: {
      playerName: requester.name ?? "A player",
      proposedScoreA: parsed.data.teamAScore,
      proposedScoreB: parsed.data.teamBScore,
      teamANames,
      teamBNames,
      interrupt: true,
    },
  });
  if (emitted.duplicate) {
    return { success: false, error: "A correction is already pending for this match." };
  }
  return { success: true, notification: emitted.row, message: "Correction requested." };
}

export async function listMyScoreCorrections(sessionId: string): Promise<{
  success: boolean;
  error?: string;
  notifications: SessionNotification[];
}> {
  if (!isValidUUID(sessionId))
    return { success: false, error: "Invalid session.", notifications: [] };
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated.", notifications: [] };

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("session_notifications")
    .select("*")
    .eq("session_id", sessionId)
    .eq("kind", "score_correction")
    .eq("subject_player_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingNoticeTable(error)) return { success: true, notifications: [] };
    return { success: false, error: error.message, notifications: [] };
  }
  return { success: true, notifications: (data ?? []) as SessionNotification[] };
}

export async function resolveScoreCorrection(
  notificationId: string,
  teamAScore: number,
  teamBScore: number
): Promise<ActionResult> {
  if (!isValidUUID(notificationId)) return { success: false, error: "Invalid notification." };
  const parsed = scoreSchema.safeParse({ teamAScore, teamBScore });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid scores." };
  }

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const svc = createServiceClient();
  const { data: existing, error: readErr } = await svc
    .from("session_notifications")
    .select("id, session_id, match_id, kind, status, subject_player_id, payload, created_at")
    .eq("id", notificationId)
    .maybeSingle();
  if (readErr || !existing) {
    if (isMissingNoticeTable(readErr))
      return { success: false, error: "Notifications are not available yet." };
    return { success: false, error: "Notification not found." };
  }
  if (!(await isSessionOrganizer(user.id, existing.session_id))) {
    return { success: false, error: "Not authorized." };
  }

  const { data: result, error: rpcErr } = await svc.rpc("resolve_score_correction", {
    p_notification_id: notificationId,
    p_actor_id: user.id,
    p_score_a: parsed.data.teamAScore,
    p_score_b: parsed.data.teamBScore,
  });

  if (rpcErr) {
    if (isRpcNotFound(rpcErr) || isMissingNoticeTable(rpcErr)) {
      return { success: false, error: "Score-correction resolve is not available yet." };
    }
    return { success: false, error: rpcErr.message };
  }
  if (!result?.success) {
    let currentScoreA: number | undefined;
    let currentScoreB: number | undefined;
    if (result?.alreadyResolved && existing.match_id) {
      const { data: match } = await svc
        .from("matches")
        .select("team_a_score, team_b_score")
        .eq("id", existing.match_id)
        .maybeSingle();
      currentScoreA = match?.team_a_score ?? undefined;
      currentScoreB = match?.team_b_score ?? undefined;
    }
    return {
      success: false,
      error: result?.error ?? "Could not save the correction.",
      alreadyResolved: result?.alreadyResolved,
      actorName: result?.actorName ?? null,
      currentScoreA,
      currentScoreB,
    };
  }

  const actor = await getActorContext(user.id);
  if (result.matchId && result.sessionId) {
    await logMatchEvent({
      matchId: result.matchId,
      sessionId: result.sessionId,
      eventType: "score_edit",
      phase: "post_completion",
      actorId: actor.id,
      actorName: actor.name,
      payload: {
        old: { a: result.oldScoreA, b: result.oldScoreB },
        new: { a: parsed.data.teamAScore, b: parsed.data.teamBScore },
        via: "score_correction",
      },
    });
  }

  const { data: updated } = await svc
    .from("session_notifications")
    .select("*")
    .eq("id", notificationId)
    .maybeSingle();
  const resolvedRow = updated
    ? asNotification(updated)
    : ({
        id: notificationId,
        session_id: existing.session_id,
        kind: "score_correction",
        status: "resolved",
        subject_player_id: existing.subject_player_id,
        match_id: existing.match_id,
        payload: existing.payload,
        resolved_by: actor.id,
        resolved_at: new Date().toISOString(),
        created_at: existing.created_at,
      } as SessionNotification);

  await broadcastQueueNotice(existing.session_id, {
    kind: "score_correction",
    playerId: existing.subject_player_id,
    playerName: existing.payload.playerName ?? "A player",
    cancelledDraft: false,
    actorId: actor.id,
    actorName: actor.name,
    matchId: existing.match_id ?? undefined,
    interrupt: false,
    notification: resolvedRow,
  });

  return { success: true, message: "Scores updated." };
}
