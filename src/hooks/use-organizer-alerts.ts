"use client";

// ============================================================
// useOrganizerAlerts — inbox + centered interrupts
// ============================================================
// Hydrate from session_notifications. Live updates via queue_notice
// broadcast (no 6th table channel). Pause buckets insert through
// recordPauseReminder; catch-up rows do not interrupt.

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueNoticePayload } from "@/lib/broadcast";
import type { QueueFullWithWaitTime, SessionNotification } from "@/types/database";
import {
  collectDuePauseAlerts,
  dismissAlert,
  enqueueAlert,
  parsePauseAlertId,
  prunePauseSeen,
  type OrganizerAlert,
} from "@/lib/organizer-alerts";
import {
  alertFromNotification,
  capCenterQueue,
  countsAsUnread,
  shouldInterrupt,
  upsertNotification,
} from "@/lib/session-notifications";
import {
  listSessionNotifications,
  markNotificationRead,
  recordPauseReminder,
} from "@/app/actions/notifications";
import { CENTER_ALERT_CAP } from "@/lib/constants";
import { useVisibilityRefresh } from "@/hooks/use-visibility-refresh";

const PAUSE_TICK_MS = 15_000;
const INBOX_POLL_MS = 45_000;

export function useOrganizerAlerts(
  sessionId: string,
  queue: QueueFullWithWaitTime[],
  isClosed: boolean,
  queueReady: boolean
): {
  inbox: SessionNotification[];
  unreadCount: number;
  current: OrganizerAlert | null;
  remaining: number;
  enqueueNotice: (payload: QueueNoticePayload) => void;
  dismiss: () => void;
  markRead: (id: string) => void;
  refreshInbox: () => void;
} {
  const [inbox, setInbox] = useState<SessionNotification[]>([]);
  const [alerts, setAlerts] = useState<OrganizerAlert[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [inboxReady, setInboxReady] = useState(false);
  const shownCenterRef = useRef(new Set<string>());
  const fetchSeq = useRef(0);
  const knownPauseKeys = useRef(new Set<string>());
  const catchUpKeys = useRef(new Set<string>());
  const catchUpArmed = useRef(false);

  const rememberPauseRow = useCallback((row: SessionNotification) => {
    if (row.kind === "player_paused_long" && row.payload.bucket) {
      knownPauseKeys.current.add(`${row.subject_player_id}:${row.payload.bucket}`);
    }
  }, []);

  const refreshInbox = useCallback(() => {
    const seq = ++fetchSeq.current;
    void listSessionNotifications(sessionId).then((result) => {
      if (seq !== fetchSeq.current) return;
      if (!result.success) {
        setInboxReady(true);
        return;
      }
      setInbox(result.notifications);
      for (const row of result.notifications) {
        shownCenterRef.current.add(row.id);
        rememberPauseRow(row);
      }
      setInboxReady(true);
    });
  }, [sessionId, rememberPauseRow]);

  useEffect(() => {
    refreshInbox();
  }, [refreshInbox]);

  useVisibilityRefresh(() => {
    refreshInbox();
  });

  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshInbox();
      }
    }, INBOX_POLL_MS);
    return () => clearInterval(id);
  }, [refreshInbox]);

  const enqueueNotice = useCallback(
    (payload: QueueNoticePayload) => {
      const row = payload.notification;
      if (row) {
        setInbox((prev) => upsertNotification(prev, row));
        rememberPauseRow(row);
        const interrupt =
          payload.interrupt !== false &&
          shouldInterrupt(row) &&
          !shownCenterRef.current.has(row.id);
        if (interrupt) {
          shownCenterRef.current.add(row.id);
          setAlerts((prev) =>
            capCenterQueue(enqueueAlert(prev, alertFromNotification(row)), CENTER_ALERT_CAP)
          );
        }
        return;
      }

      if (payload.interrupt === false) return;

      const ephemeral: OrganizerAlert = {
        id: `ephemeral:${payload.kind}:${payload.playerId}:${Date.now()}`,
        kind: payload.kind,
        title:
          payload.kind === "player_checked_out"
            ? `${payload.playerName.trim() || "A player"} was checked out`
            : payload.kind === "score_correction"
              ? `${payload.playerName.trim() || "A player"} requested a score correction`
              : payload.kind === "player_paused_long"
                ? `${payload.playerName.trim() || "A player"} has been paused`
                : `${payload.playerName.trim() || "A player"} left the queue`,
        body:
          payload.kind === "score_correction"
            ? "Open Edit Match to review their proposed scores."
            : payload.cancelledDraft
              ? "An unpublished draft they were in was cancelled."
              : "They are no longer waiting to be matched.",
      };
      setAlerts((prev) => capCenterQueue(enqueueAlert(prev, ephemeral), CENTER_ALERT_CAP));
    },
    [rememberPauseRow]
  );

  const dismiss = useCallback(() => {
    setAlerts((prev) => {
      const current = prev[0];
      if (current?.notification && current.kind !== "score_correction") {
        void markNotificationRead(current.id);
        setInbox((inboxPrev) =>
          inboxPrev.map((n) =>
            n.id === current.id && n.status === "unread" ? { ...n, status: "read" } : n
          )
        );
      }
      return dismissAlert(prev);
    });
  }, []);

  const markRead = useCallback((id: string) => {
    void markNotificationRead(id);
    setInbox((prev) =>
      prev.map((n) =>
        n.id === id && n.status === "unread" && n.kind !== "score_correction"
          ? { ...n, status: "read" }
          : n
      )
    );
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), PAUSE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const pauseClockReady = inboxReady && queueReady;
  useEffect(() => {
    if (!pauseClockReady || catchUpArmed.current) return;
    // An error / unauth hold leaves queue as []. Arming then would treat a
    // later real fetch's already-due buckets as live interrupts.
    if (queue.length === 0) return;
    const dueAtHydrate = collectDuePauseAlerts(queue, Date.now(), new Set());
    for (const alert of dueAtHydrate) {
      const parsed = parsePauseAlertId(alert.id);
      if (parsed) catchUpKeys.current.add(`${parsed.playerId}:${parsed.bucket}`);
    }
    catchUpArmed.current = true;
  }, [pauseClockReady, queue]);

  // seenPause suppresses a bucket that is still due on the next 15 s tick from
  // being re-offered for ever. It is BOOKKEEPING, not rendered state: nothing
  // this hook returns is derived from it.
  //
  // It used to be useState, marked during the RENDER phase, and that is what
  // made pause reminders unreachable in production. A setState called during
  // render makes React throw the pass away and re-render before commit; on
  // that second pass every due bucket is already marked, so the due list comes
  // out empty, and the empty list is the one that gets COMMITTED — the effect
  // that writes the row then sees nothing to write. An organizer was never
  // told a player had been paused past the threshold, and the symptom hid
  // itself: the centred card is fed from the session_notifications row this
  // effect inserts, so it simply never appeared rather than appearing wrong.
  //
  // A ref closes both halves: marking it is not a state write, so no pass can
  // be discarded and no cascading render is scheduled. The prune is applied to
  // a COPY at read time rather than written back, so a player who resumes and
  // re-pauses is offered again; the set grows only to (players × buckets) for
  // the life of one mounted dashboard.
  const seenPause = useRef<Set<string>>(new Set());

  // The whole pause-reminder pipeline is a side effect, so all of it lives in
  // one: deriving the due list during render is what required marking during
  // render, and marking during render is what killed it. Nothing this hook
  // returns is derived from the due list — the centred card comes from
  // `alerts`, fed by the notification row this effect inserts.
  useEffect(() => {
    if (!pauseClockReady || isClosed) return;
    const due = collectDuePauseAlerts(queue, nowMs, prunePauseSeen(seenPause.current, queue));
    for (const alert of due) {
      const parsed = parsePauseAlertId(alert.id);
      if (!parsed) continue;
      const key = `${parsed.playerId}:${parsed.bucket}`;
      seenPause.current.add(key);
      // knownPauseKeys — not seenPause — is what makes the WRITE exactly-once.
      // seenPause only stops the bucket being re-offered; this ref is what
      // stops a second row being inserted, and it is seeded from the inbox
      // rows that already exist (rememberPauseRow) as well as from here.
      if (knownPauseKeys.current.has(key)) continue;
      knownPauseKeys.current.add(key);
      void recordPauseReminder(
        sessionId,
        parsed.playerId,
        parsed.bucket,
        !catchUpKeys.current.has(key)
      );
    }
  }, [pauseClockReady, isClosed, queue, nowMs, sessionId]);

  return {
    inbox,
    unreadCount: inbox.filter(countsAsUnread).length,
    current: alerts[0] ?? null,
    remaining: alerts.length,
    enqueueNotice,
    dismiss,
    markRead,
    refreshInbox,
  };
}
