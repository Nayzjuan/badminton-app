"use client";

// Shared Match Control pause badge. Ticks locally off paused_at so the
// "Paused 15m" / "Paused 30m" label advances without a queue refetch.

import { useEffect, useState } from "react";
import { minutesPaused, pausedBadge } from "@/lib/organizer-alerts";

const TICK_MS = 15_000;

const TONE_CLASS: Record<ReturnType<typeof pausedBadge>["tone"], string> = {
  muted: "bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400",
  amber: "bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300",
  red: "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300",
};

interface PausedBadgeProps {
  pausedAt: string | null | undefined;
  /** Extra classes for the By-Skill clip-cut chip. */
  className?: string;
}

export function PausedBadge({ pausedAt, className }: PausedBadgeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const badge = pausedBadge(minutesPaused(pausedAt, now));

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONE_CLASS[badge.tone]} ${className ?? ""}`}
    >
      {badge.label}
    </span>
  );
}
