// ============================================================
// Organizer center-alert helpers — pure, no I/O
// ============================================================
// Pause-bucket math and alert copy live here so the dashboard hook
// and the unit tests share one definition of "15 / 30 / 45 minutes".

import { PAUSE_REMIND_MINUTES } from "@/lib/constants";
import type { SessionNotification, SessionNotificationKind } from "@/types/database";

export type OrganizerAlertKind = SessionNotificationKind;

export type OrganizerAlert = {
  id: string;
  kind: OrganizerAlertKind;
  title: string;
  body: string;
  notification?: SessionNotification;
};

export type PauseBadgeTone = "muted" | "amber" | "red";

export type PauseBadge = {
  label: string;
  tone: PauseBadgeTone;
};

/** Whole minutes since `pausedAt`. null when the stamp is missing or unparseable. */
export function minutesPaused(pausedAt: string | null | undefined, nowMs: number): number | null {
  if (!pausedAt) return null;
  const start = Date.parse(pausedAt);
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((nowMs - start) / 60_000));
}

/**
 * 0 = not yet due (0–14 min), 1 = 15–29, 2 = 30–44, …
 * Callers only enqueue when the bucket is >= 1.
 */
export function pauseRemindBucket(
  minutes: number,
  interval: number = PAUSE_REMIND_MINUTES
): number {
  if (interval <= 0 || minutes < interval) return 0;
  return Math.floor(minutes / interval);
}

export function pauseSeenKey(playerId: string, bucket: number): string {
  return `${playerId}:${bucket}`;
}

export function pausedBadge(minutes: number | null): PauseBadge {
  if (minutes === null || minutes < PAUSE_REMIND_MINUTES) {
    return { label: "Paused", tone: "muted" };
  }
  const shown = pauseRemindBucket(minutes) * PAUSE_REMIND_MINUTES;
  return {
    label: `Paused ${shown}m`,
    tone: shown === PAUSE_REMIND_MINUTES ? "amber" : "red",
  };
}

export function enqueueAlert(prev: OrganizerAlert[], alert: OrganizerAlert): OrganizerAlert[] {
  if (prev.some((a) => a.id === alert.id)) return prev;
  return [...prev, alert];
}

export function dismissAlert(prev: OrganizerAlert[]): OrganizerAlert[] {
  return prev.slice(1);
}

export function leaveAlert(
  playerName: string,
  cancelledDraft: boolean,
  id: string
): OrganizerAlert {
  return {
    id,
    kind: "player_left",
    title: `${playerName} left the queue`,
    body: cancelledDraft
      ? "An unpublished draft they were in was cancelled."
      : "They are no longer waiting to be matched.",
  };
}

export function parsePauseAlertId(id: string): { playerId: string; bucket: number } | null {
  if (!id.startsWith("pause:")) return null;
  const rest = id.slice("pause:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const playerId = rest.slice(0, lastColon);
  const bucket = Number(rest.slice(lastColon + 1));
  if (!playerId || !Number.isInteger(bucket) || bucket < 1) return null;
  return { playerId, bucket };
}

export function pauseAlert(playerName: string, bucket: number, playerId: string): OrganizerAlert {
  const minutes = bucket * PAUSE_REMIND_MINUTES;
  return {
    id: `pause:${playerId}:${bucket}`,
    kind: "player_paused_long",
    title: `${playerName} has been paused for ${minutes} minutes`,
    body: "Resume them in Match Control when they are ready to play.",
  };
}

/** Drop every seen pause-bucket for this player (they were resumed). */
export function clearPauseSeenForPlayer(seen: Set<string>, playerId: string): void {
  const prefix = `${playerId}:`;
  for (const key of seen) {
    if (key.startsWith(prefix)) seen.delete(key);
  }
}

export type PauseAlertSource = {
  player_id: string;
  is_paused: boolean;
  paused_at: string | null;
  display_name: string;
};

/**
 * Alerts that are newly due for this snapshot. Does not mutate `seen` —
 * the caller marks keys after it decides to enqueue, so a discarded render
 * cannot swallow a bucket.
 */
export function collectDuePauseAlerts(
  entries: PauseAlertSource[],
  nowMs: number,
  seen: ReadonlySet<string>
): OrganizerAlert[] {
  const out: OrganizerAlert[] = [];
  for (const entry of entries) {
    if (!entry.is_paused) continue;
    const minutes = minutesPaused(entry.paused_at, nowMs);
    if (minutes === null) continue;
    const bucket = pauseRemindBucket(minutes);
    if (bucket < 1) continue;
    const key = pauseSeenKey(entry.player_id, bucket);
    if (seen.has(key)) continue;
    out.push(pauseAlert(entry.display_name, bucket, entry.player_id));
  }
  return out;
}

/**
 * Drop buckets for resumed or departed players. Returns the same Set when
 * nothing changed, so the caller's effect can compare by reference and skip
 * the state write instead of scheduling a render on every tick.
 */
export function prunePauseSeen(
  seen: ReadonlySet<string>,
  entries: PauseAlertSource[]
): Set<string> {
  const present = new Set(entries.map((e) => e.player_id));
  const resumed = new Set(entries.filter((e) => !e.is_paused).map((e) => e.player_id));
  let changed = false;
  const next = new Set<string>();
  for (const key of seen) {
    const playerId = key.slice(0, key.lastIndexOf(":"));
    if (!present.has(playerId) || resumed.has(playerId)) {
      changed = true;
      continue;
    }
    next.add(key);
  }
  if (!changed && seen instanceof Set) return seen;
  return next;
}
