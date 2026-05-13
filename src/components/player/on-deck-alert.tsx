"use client";

// ============================================================
// OnDeckAlert — Approaching banner (waiting state, position ≤ 4)
// ============================================================
// MatchAlert now owns the pending + in_progress full-screen
// overlays. This component is reduced to a single concern:
// the "approaching" banner shown above the queue position when
// the player is near the front of the line (positions 1–4).
//
// Returns null for any other state.
// ============================================================

import type { MatchStatus, QueueStatus as QueueStatusType } from "@/types/database";

interface OnDeckAlertProps {
  matchStatus: MatchStatus | null;
  queueStatus: QueueStatusType | null;
  position: number | null;
}

export function OnDeckAlert({ matchStatus, queueStatus, position }: OnDeckAlertProps) {
  // Show only for waiting players near the front. Everything else is null —
  // active match states are owned by MatchAlert (full-screen overlay).
  if (matchStatus || queueStatus !== "waiting" || position === null || position > 4) {
    return null;
  }

  const isUrgent = position <= 2;

  const label =
    position === 1
      ? "You're Next!"
      : position === 2
        ? "Almost there…"
        : position === 3
          ? "Get ready!"
          : "Coming up soon";

  return (
    <div
      role="status"
      aria-label={`Position ${position}: ${label}`}
      className={`flex items-center justify-center gap-2.5 rounded-full px-4 py-2
        ${
          isUrgent
            ? "bg-amber-100 ring-1 ring-amber-300 dark:bg-amber-950/30 dark:ring-amber-700/40"
            : "bg-sky-50 ring-1 ring-sky-200 dark:bg-sky-950/30 dark:ring-sky-800/40"
        }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${isUrgent ? "bg-amber-500" : "bg-sky-500"}`}
        style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
      />
      <span
        className={`text-[11px] font-bold uppercase tracking-[0.14em]
          ${isUrgent ? "text-amber-800 dark:text-amber-300" : "text-sky-800 dark:text-sky-300"}`}
      >
        {label}
      </span>
    </div>
  );
}
