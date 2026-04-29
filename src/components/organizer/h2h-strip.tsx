"use client";

// ============================================================
// H2HStrip — compact head-to-head record strip for on-deck cards
// ============================================================
// Only renders when the exact 2v2 pairing has prior history.
// First-meeting pairs and errored fetches both return null
// (no skeleton, no placeholder) to keep the card compact
// until there's real data to show.
//
// When history exists, shows:
//   [A 3] — [B 5]  all-time  ·  [A 1] — [B 0] tonight
//
// "A" and "B" labels are shown explicitly so the direction is
// unambiguous without relying on sky/amber color alone.
// ============================================================

import { useH2H } from "@/hooks/use-h2h";
import { Swords } from "lucide-react";

interface H2HStripProps {
  teamAIds: string[];
  teamBIds: string[];
  sessionId: string;
}

export function H2HStrip({ teamAIds, teamBIds, sessionId }: H2HStripProps) {
  const { record, loading, error } = useH2H(teamAIds, teamBIds, sessionId);

  // No skeleton while loading — avoids layout shift for first-meeting pairs.
  if (loading) return null;
  // Error already logged in useH2H; render nothing rather than a broken strip.
  if (error) return null;

  const totalAllTime = (record?.alltime_a ?? 0) + (record?.alltime_b ?? 0);

  // No prior history — don't render at all. "First meeting" adds noise, not value.
  if (totalAllTime === 0) return null;

  const sessionTotal = (record?.session_a ?? 0) + (record?.session_b ?? 0);

  return (
    <div
      data-testid="h2h-strip"
      className="px-4 py-2 border-t border-slate-100 dark:border-border flex items-center gap-2"
    >
      {/* Icon */}
      <Swords className="h-3 w-3 shrink-0 text-slate-300 dark:text-muted-foreground" aria-hidden="true" />

      <div className="flex items-center gap-1.5 flex-wrap">
        {/* ── All-time record ─────────────────────────────── */}
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground">
          A
        </span>
        <span
          data-testid="h2h-alltime-a"
          className="text-xs font-semibold text-sky-600 dark:text-sky-400 tabular-nums"
        >
          {record!.alltime_a}
        </span>
        <span className="text-[10px] text-slate-300 dark:text-muted-foreground">–</span>
        <span
          data-testid="h2h-alltime-b"
          className="text-xs font-semibold text-amber-600 dark:text-amber-400 tabular-nums"
        >
          {record!.alltime_b}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground">
          B
        </span>
        <span className="text-[10px] text-slate-400 dark:text-muted-foreground">all-time</span>

        {/* ── Session divider ──────────────────────────────── */}
        <span className="text-[10px] text-slate-200 dark:text-muted-foreground/40 select-none">·</span>

        {/* ── Tonight ─────────────────────────────────────── */}
        {sessionTotal === 0 ? (
          <span
            data-testid="h2h-first-tonight"
            className="text-[10px] text-slate-400 dark:text-muted-foreground italic"
          >
            first time tonight
          </span>
        ) : (
          <>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground">
              A
            </span>
            <span
              data-testid="h2h-tonight-a"
              className="text-xs font-semibold text-sky-500 dark:text-sky-400/80 tabular-nums"
            >
              {record!.session_a}
            </span>
            <span className="text-[10px] text-slate-300 dark:text-muted-foreground">–</span>
            <span
              data-testid="h2h-tonight-b"
              className="text-xs font-semibold text-amber-500 dark:text-amber-400/80 tabular-nums"
            >
              {record!.session_b}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground">
              B
            </span>
            <span className="text-[10px] text-slate-400 dark:text-muted-foreground">tonight</span>
          </>
        )}
      </div>
    </div>
  );
}
