"use client";

// ============================================================
// MatchTimer — Live or static elapsed-time display
// ============================================================
// Two modes determined by props:
//
//   LIVE  (startedAt set, endedAt null/undefined)
//     → Runs a setInterval every 1 s, calculates
//       Date.now() – startedAt, formats as MM:SS.
//       Cleans up the interval on unmount.
//
//   STATIC (both startedAt and endedAt set)
//     → Calculates the fixed diff endedAt – startedAt once.
//       No interval. Suitable for match history cards.
//
//   NOTHING (startedAt null/undefined)
//     → Returns null. Pending matches have not started yet.
//
// Styling variants:
//   variant="live"   — neon lime glow + pulsing dot (dark),
//                      emerald text (light)
//   variant="static" — muted monospace, no glow (history use)
// ============================================================

import { useEffect, useState } from "react";

// ── Helpers ───────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

// ── Props ─────────────────────────────────────────────────────

interface MatchTimerProps {
  /** ISO timestamp — when the match went in_progress. */
  startedAt: string | null | undefined;
  /** ISO timestamp — when the match completed or was cancelled.
   *  If provided, the timer is static (no interval). */
  endedAt?: string | null;
  /** Display variant. Defaults to "live" for active courts. */
  variant?: "live" | "static" | "command";
  className?: string;
}

// ── Component ─────────────────────────────────────────────────

export function MatchTimer({
  startedAt,
  endedAt,
  variant = "live",
  className = "",
}: MatchTimerProps) {
  const [display, setDisplay] = useState<string>("");

  useEffect(() => {
    if (!startedAt) {
      setDisplay("");
      return;
    }

    const start = new Date(startedAt).getTime();
    // Guard against invalid ISO strings — formatElapsed(NaN) would render "NaN:NaN".
    if (isNaN(start)) {
      setDisplay("");
      return;
    }

    // STATIC mode — fixed diff, no interval.
    if (endedAt) {
      const end = new Date(endedAt).getTime();
      if (isNaN(end)) {
        setDisplay("");
        return;
      }
      setDisplay(formatElapsed(end - start));
      return;
    }

    // LIVE mode — interval updates every second.
    function tick() {
      setDisplay(formatElapsed(Date.now() - start));
    }
    tick(); // immediate first render
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [startedAt, endedAt]);

  if (!startedAt || !display) return null;

  // ── Command variant — large amber Chakra Petch, no dot ───
  if (variant === "command" && !endedAt) {
    return (
      <span
        className={`tabular-nums font-command text-[22px] font-bold
                    leading-none tracking-[0.04em]
                    text-[oklch(0.78_0.17_62)]
                    ${className}`}
      >
        {display}
      </span>
    );
  }

  // ── Live variant ─────────────────────────────────────────
  if (variant === "live" && !endedAt) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 tabular-nums
                    text-xs font-semibold
                    text-emerald-700
                    dark:text-[hsl(80_100%_62%)]
                    dark:[text-shadow:0_0_8px_hsl(80_100%_60%/0.65)]
                    ${className}`}
      >
        {/* Pulsing live indicator dot */}
        <span
          className="h-1.5 w-1.5 rounded-full shrink-0
                     bg-emerald-500 animate-pulse
                     dark:bg-[hsl(80_100%_60%)]
                     dark:shadow-[0_0_6px_hsl(80_100%_60%/0.8)]"
        />
        {display}
      </span>
    );
  }

  // ── Static variant (history / completed) ─────────────────
  return (
    <span
      className={`tabular-nums text-xs
                  text-slate-400 dark:text-muted-foreground
                  ${className}`}
    >
      {display}
    </span>
  );
}
