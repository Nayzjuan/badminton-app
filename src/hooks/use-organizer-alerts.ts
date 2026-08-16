"use client";

// ============================================================
// useOrganizerAlerts — queued centered notices for Match Control
// ============================================================
// Leave notices arrive via broadcast (enqueueLeave). Pause reminders
// are derived during render from paused_at + a 15s now-tick so the
// card fires even during a quiet stretch with no queue mutations.

import { useCallback, useEffect, useState } from "react";
import type { QueueNoticePayload } from "@/lib/broadcast";
import type { QueueFullWithWaitTime } from "@/types/database";
import {
  collectDuePauseAlerts,
  dismissAlert,
  enqueueAlert,
  leaveAlert,
  prunePauseSeen,
  type OrganizerAlert,
} from "@/lib/organizer-alerts";

const PAUSE_TICK_MS = 15_000;

export function useOrganizerAlerts(queue: QueueFullWithWaitTime[]): {
  current: OrganizerAlert | null;
  remaining: number;
  enqueueLeave: (payload: QueueNoticePayload) => void;
  dismiss: () => void;
} {
  const [alerts, setAlerts] = useState<OrganizerAlert[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [seenPause, setSeenPause] = useState<Set<string>>(() => new Set());

  const enqueueLeave = useCallback((payload: QueueNoticePayload) => {
    if (payload.kind !== "player_left") return;
    const name = payload.playerName.trim() || "A player";
    setAlerts((prev) =>
      enqueueAlert(
        prev,
        leaveAlert(name, payload.cancelledDraft, `leave:${payload.playerId}:${Date.now()}`)
      )
    );
  }, []);

  const dismiss = useCallback(() => {
    setAlerts((prev) => dismissAlert(prev));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), PAUSE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Adjust state while rendering (React 19). Already-queued pause ids count
  // as seen so this pass cannot loop; dismissed buckets stay in seenPause
  // so a 45s poll does not bring them back.
  const prunedSeen = prunePauseSeen(seenPause, queue);
  const seenThisRender = new Set(prunedSeen);
  for (const alert of alerts) {
    if (alert.kind === "player_paused_long") {
      seenThisRender.add(alert.id.slice("pause:".length));
    }
  }
  const due = collectDuePauseAlerts(queue, nowMs, seenThisRender);
  if (due.length > 0 || prunedSeen !== seenPause) {
    const nextSeen = new Set(prunedSeen);
    for (const alert of due) {
      nextSeen.add(alert.id.slice("pause:".length));
    }
    setSeenPause(nextSeen);
    if (due.length > 0) {
      setAlerts((prev) => due.reduce(enqueueAlert, prev));
    }
  }

  return {
    current: alerts[0] ?? null,
    remaining: alerts.length,
    enqueueLeave,
    dismiss,
  };
}
