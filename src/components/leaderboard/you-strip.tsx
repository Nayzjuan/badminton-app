"use client";

// ============================================================
// YouStrip — Thin amber "YOU" context bar for Stadium leaderboard
// ============================================================
// Replaces LeaderboardHeroCard in the player-panel variant only.
// The hero card remains unchanged for organizer-panel and standalone.
//
// Three states:
//   loading        — animate-pulse skeleton (amber tint)
//   no data / 0 GP — YOU tag + "–" rank + "–" name + "0W–0L" + "·"
//   qualified      — YOU tag + #N rank + name + NW–NL + NN.N% + ▲/▼/·
//
// Always pinned at the top of the leaderboard content area so the
// current player can see their rank without scrolling.
// ============================================================

import type { LeaderboardRow } from "@/types/leaderboard";

interface YouStripProps {
  row: LeaderboardRow | null;
  loading?: boolean;
}

function movementLabel(n: number | null): { label: string; className: string } {
  if (n === null || n === 0) return { label: "·", className: "opacity-30" };
  if (n > 0) return { label: `▲${n}`, className: "text-[#15803d] dark:text-[hsl(142_58%_55%)]" };
  return { label: `▼${Math.abs(n)}`, className: "text-[#dc2626] dark:text-[hsl(0_68%_60%)]" };
}

// ── Module-level sub-component ────────────────────────────────
// Defined outside YouStrip so React's reconciler sees a stable
// component identity across renders and never unmounts/remounts it.
const monoFont = "font-[family-name:var(--font-jetbrains-mono)]";

function YouTag() {
  return (
    <span
      className={`${monoFont} text-[9px] font-extrabold tracking-[.18em] uppercase
                  px-[7px] py-[3px] flex-shrink-0
                  bg-amber-600 text-white dark:bg-[hsl(38_92%_52%)] dark:text-[hsl(217_28%_8%)]`}
    >
      YOU
    </span>
  );
}

export function YouStrip({ row, loading = false }: YouStripProps) {
  // ── Shared outer classes ──────────────────────────────────────
  const outerCls =
    "flex items-center gap-2.5 px-4 border-b" +
    " bg-amber-50 dark:bg-gradient-to-r dark:from-[hsl(38_92%_52%/0.12)] dark:to-transparent" +
    " border-amber-200 dark:border-[hsl(38_92%_52%/0.22)]";

  // monoFont is the module-level constant (avoids re-declaring on every render)
  const barlowFont = "font-[family-name:var(--font-barlow-condensed)]";

  // ── Loading state ─────────────────────────────────────────────
  if (loading) {
    return (
      <div
        className={`${outerCls} h-11 animate-pulse`}
        aria-hidden="true"
      />
    );
  }

  // ── Zero-games / no-data state ────────────────────────────────
  if (!row || row.games_played === 0) {
    return (
      <div
        className={`${outerCls} py-2.5`}
        aria-label="Your status: no games played yet"
      >
        <YouTag />
        <span
          className={`${barlowFont} font-black italic text-[22px] leading-none tracking-[.01em]
                       flex-shrink-0 text-amber-700 dark:text-[hsl(38_92%_52%)]`}
        >
          {/* en-dash matches the qualified state's rank prefix style */}
          –
        </span>
        <span
          className={`${barlowFont} font-bold text-[18px] tracking-[.02em] flex-1 min-w-0
                       truncate text-[#111827] dark:text-white`}
        >
          {row?.display_name ?? "–"}
        </span>
        <span
          className={`${monoFont} text-[10.5px] tracking-[.02em] flex-shrink-0
                       text-[#92400e] dark:text-[hsl(220_10%_52%)]`}
        >
          0W–0L
        </span>
        <span
          className={`${monoFont} text-[11px] font-bold flex-shrink-0 opacity-30`}
        >
          ·
        </span>
      </div>
    );
  }

  // ── Qualified state (has game data) ───────────────────────────
  const mv = movementLabel(row.rank_movement ?? null);

  return (
    <div
      className={`${outerCls} py-2.5`}
      aria-label={`Your rank: #${row.rank} — ${row.wins}W–${row.losses}L — ${row.win_pct.toFixed(1)}%`}
    >
      <YouTag />

      {/* Rank */}
      <span
        className={`${barlowFont} font-black italic text-[22px] leading-none tracking-[.01em]
                     flex-shrink-0 text-amber-700 dark:text-[hsl(38_92%_52%)]`}
      >
        #{row.rank}
      </span>

      {/* Name */}
      <span
        className={`${barlowFont} font-bold text-[18px] tracking-[.02em] flex-1 min-w-0
                     truncate text-[#111827] dark:text-white`}
      >
        {row.display_name.toUpperCase()}
      </span>

      {/* W–L */}
      <span
        className={`${monoFont} text-[10.5px] tracking-[.02em] flex-shrink-0
                     font-medium text-[#92400e] dark:text-[hsl(220_10%_52%)]`}
      >
        {row.wins}W–{row.losses}L
      </span>

      {/* Win% */}
      <span
        className={`${monoFont} text-[10.5px] tracking-[.02em] flex-shrink-0
                     font-medium text-[#92400e] dark:text-[hsl(220_10%_52%)]`}
      >
        {row.win_pct.toFixed(1)}%
      </span>

      {/* Movement delta */}
      <span
        className={`${monoFont} text-[11px] font-bold flex-shrink-0 ${mv.className}`}
        aria-label={mv.label === "·" ? "No change" : `Rank ${mv.label.startsWith("▲") ? "up" : "down"} ${mv.label.slice(1)}`}
      >
        {mv.label}
      </span>
    </div>
  );
}
