// ============================================================
// Session notification helpers — pure, no I/O
// ============================================================

import { CENTER_ALERT_CAP, PAUSE_REMIND_MINUTES } from "@/lib/constants";
import type {
  SessionNotification,
  SessionNotificationKind,
  SessionNotificationStatus,
} from "@/types/database";
import type { OrganizerAlert } from "@/lib/organizer-alerts";

export function isPendingCorrectionStatus(status: SessionNotificationStatus): boolean {
  return status === "unread" || status === "read";
}

export function isActionable(row: SessionNotification): boolean {
  return row.kind === "score_correction" && isPendingCorrectionStatus(row.status);
}

export function countsAsUnread(row: SessionNotification): boolean {
  if (row.kind === "score_correction") return isPendingCorrectionStatus(row.status);
  return row.status === "unread";
}

export function upsertNotification(
  prev: SessionNotification[],
  row: SessionNotification
): SessionNotification[] {
  const idx = prev.findIndex((n) => n.id === row.id);
  if (idx === -1) return [row, ...prev].sort(byCreatedDesc);
  const next = prev.slice();
  next[idx] = row;
  return next.sort(byCreatedDesc);
}

function byCreatedDesc(a: SessionNotification, b: SessionNotification): number {
  return b.created_at.localeCompare(a.created_at);
}

export function shouldInterrupt(row: SessionNotification): boolean {
  if (row.payload.interrupt === false) return false;
  if (row.kind === "score_correction") return isPendingCorrectionStatus(row.status);
  return row.status === "unread";
}

export function capCenterQueue<T>(queued: T[], cap: number = CENTER_ALERT_CAP): T[] {
  return queued.slice(0, cap);
}

/**
 * Unique-key collisions must not fan out a second center card.
 * Any other insert outcome (including a missing table) still
 * broadcasts so a successful leave/checkout is never silent.
 */
export function shouldBroadcastAfterNoticeInsert(
  error: {
    code?: string;
  } | null
): boolean {
  return error?.code !== "23505";
}

export function noticeTitle(row: SessionNotification): string {
  const name = row.payload.playerName.trim() || "A player";
  switch (row.kind) {
    case "player_left":
      return `${name} left the queue`;
    case "player_checked_out":
      return `${name} was checked out`;
    case "player_paused_long": {
      const minutes = (row.payload.bucket ?? 1) * PAUSE_REMIND_MINUTES;
      return `${name} has been paused for ${minutes} minutes`;
    }
    case "score_correction":
      return `${name} requested a score correction`;
  }
}

export function noticeBody(row: SessionNotification): string {
  switch (row.kind) {
    case "player_left":
      return row.payload.cancelledDraft
        ? "An unpublished draft they were in was cancelled."
        : "They are no longer waiting to be matched.";
    case "player_checked_out":
      return row.payload.actorName
        ? `${row.payload.actorName} removed them from the queue.`
        : "An organizer removed them from the queue.";
    case "player_paused_long":
      return "Resume them in Match Control when they are ready to play.";
    case "score_correction": {
      const a = row.payload.proposedScoreA;
      const b = row.payload.proposedScoreB;
      if (a == null || b == null) return "Open Edit Match to review their proposed scores.";
      return `Proposed ${a}–${b}. You can still change the numbers.`;
    }
  }
}

export function alertFromNotification(row: SessionNotification): OrganizerAlert {
  return {
    id: row.id,
    kind: row.kind,
    title: noticeTitle(row),
    body: noticeBody(row),
    notification: row,
  };
}

export function kindLabel(kind: SessionNotificationKind): string {
  switch (kind) {
    case "player_left":
      return "Left";
    case "player_checked_out":
      return "Checked out";
    case "player_paused_long":
      return "Paused";
    case "score_correction":
      return "Score";
  }
}
