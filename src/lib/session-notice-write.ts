import "server-only";

// ============================================================
// Session notice writers — not Server Actions
// ============================================================
// These use the service client. They must not live in a
// "use server" module or they become public POST endpoints.

import { createServiceClient } from "@/utils/supabase/service";
import { getActorContext } from "@/app/actions/_shared";
import { broadcastQueueNotice } from "@/lib/broadcast";
import type {
  SessionNotification,
  SessionNotificationInsert,
  SessionNotificationKind,
  SessionNotificationPayload,
  SessionNotificationStatus,
} from "@/types/database";

function asNotification(row: unknown): SessionNotification {
  return row as SessionNotification;
}

export function isMissingNoticeTable(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const msg = (error.message ?? "").toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (msg.includes("session_notifications") &&
      (msg.includes("does not exist") || msg.includes("schema cache")))
  );
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export async function emitOrganizerNotice(input: {
  sessionId: string;
  kind: SessionNotificationKind;
  subjectPlayerId: string;
  matchId?: string | null;
  payload: SessionNotificationPayload;
  status?: SessionNotificationStatus;
  actorId?: string | null;
  actorName?: string | null;
}): Promise<{ row: SessionNotification | null; duplicate: boolean }> {
  const svc = createServiceClient();
  const insert: SessionNotificationInsert = {
    session_id: input.sessionId,
    kind: input.kind,
    subject_player_id: input.subjectPlayerId,
    match_id: input.matchId ?? null,
    payload: input.payload,
    status: input.status ?? "unread",
  };
  const { data, error } = await svc
    .from("session_notifications")
    .insert(insert)
    .select("*")
    .maybeSingle();

  if (error && isUniqueViolation(error)) {
    return { row: null, duplicate: true };
  }
  if (error && !isMissingNoticeTable(error)) {
    console.error("[emitOrganizerNotice] insert failed:", error.message);
  }

  const row = data ? asNotification(data) : null;
  await broadcastQueueNotice(input.sessionId, {
    kind: input.kind,
    playerId: input.subjectPlayerId,
    playerName: input.payload.playerName,
    cancelledDraft: input.payload.cancelledDraft ?? false,
    actorId: input.actorId,
    actorName: input.actorName,
    notification: row,
    bucket: input.payload.bucket,
    interrupt: input.payload.interrupt,
    matchId: input.matchId ?? undefined,
    proposedScoreA: input.payload.proposedScoreA,
    proposedScoreB: input.payload.proposedScoreB,
  });
  return { row, duplicate: false };
}

export async function closePendingScoreCorrections(
  matchId: string,
  nextStatus: "resolved" | "superseded",
  actorId: string
): Promise<void> {
  const svc = createServiceClient();
  const { data: pending, error: readErr } = await svc
    .from("session_notifications")
    .select("*")
    .eq("match_id", matchId)
    .eq("kind", "score_correction")
    .in("status", ["unread", "read"]);
  if (readErr) {
    if (!isMissingNoticeTable(readErr)) {
      console.error("[closePendingScoreCorrections]", readErr.message);
    }
    return;
  }
  if (!pending || pending.length === 0) return;

  const resolvedAt = new Date().toISOString();
  const { error } = await svc
    .from("session_notifications")
    .update({
      status: nextStatus,
      resolved_by: actorId,
      resolved_at: resolvedAt,
    })
    .eq("match_id", matchId)
    .eq("kind", "score_correction")
    .in("status", ["unread", "read"]);
  if (error) {
    if (!isMissingNoticeTable(error)) {
      console.error("[closePendingScoreCorrections]", error.message);
    }
    return;
  }

  const actor = await getActorContext(actorId);
  for (const row of pending as SessionNotification[]) {
    const closed: SessionNotification = {
      ...row,
      status: nextStatus,
      resolved_by: actorId,
      resolved_at: resolvedAt,
    };
    await broadcastQueueNotice(row.session_id, {
      kind: "score_correction",
      playerId: row.subject_player_id,
      playerName: row.payload.playerName,
      cancelledDraft: false,
      actorId,
      actorName: actor.name,
      matchId,
      interrupt: false,
      notification: closed,
    });
  }
}
