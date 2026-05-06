"use client";

// ============================================================
// LeaderboardPodium — Top-3 podium cards for Stadium leaderboard
// ============================================================
// Displays rank #1, #2, #3 in an asymmetric 3-column grid:
//   grid-template-columns: 1fr 1.2fr 1fr
//   column order:         [#2] [#1] [#3]
//
// #1 card is center and taller: 88px rank numeral, amber border,
//   ghost watermark "1" at 100px behind the rank.
// #2/#3 flanking at 68px rank numeral, neutral border.
//
// Uses Barlow Condensed for rank numerals and player names.
// No emoji medals — rank numerals ARE the medal.
// ============================================================

import type { LeaderboardRow } from "@/types/leaderboard";
import { Bolts } from "./bolt-icons";

interface LeaderboardPodiumProps {
  /** Exactly 3 rows, rank-sorted ascending (#1 at index 0) */
  top3: LeaderboardRow[];
}

interface PodiumCellProps {
  row: LeaderboardRow;
  position: 1 | 2 | 3;
}

function PodiumCell({ row, position }: PodiumCellProps) {
  const monoFont = "font-[family-name:var(--font-jetbrains-mono)]";
  const barlowFont = "font-[family-name:var(--font-barlow-condensed)]";
  const isFirst = position === 1;

  const rankSize = isFirst ? "text-[88px]" : "text-[68px]";

  // Card border color
  const cardBorder = isFirst
    ? "border-amber-400 dark:border-[hsl(38_92%_52%/0.55)]"
    : "border-slate-200 dark:border-[hsl(217_18%_17%)]";

  // Card background
  const cardBg = isFirst
    ? "bg-amber-50 dark:bg-[hsl(217_25%_12%)]"
    : "bg-slate-50 dark:bg-[hsl(217_25%_11%)]";

  // Rank numeral color
  const rankColor = isFirst
    ? "text-amber-600 dark:text-[hsl(38_92%_52%)]"
    : position === 2
    ? "text-[#6b7280]"
    : "text-[#92400e] dark:text-[hsl(38_70%_40%)]";

  return (
    <div
      className={`relative overflow-hidden rounded-[14px] border ${cardBorder} ${cardBg}
                  ${isFirst ? "pt-5 pb-3.5 px-2.5" : "p-3"}`}
    >
      {/* Ghost watermark for #1 */}
      {isFirst && (
        <span
          className={`${barlowFont} font-black italic absolute right-[-4px] top-[-12px]
                       text-[100px] leading-none pointer-events-none select-none
                       text-amber-600/[0.07] dark:text-[hsl(38_92%_52%/0.07)]`}
          aria-hidden="true"
        >
          1
        </span>
      )}

      {/* Rank numeral */}
      <div
        className={`${barlowFont} font-black italic ${rankSize} leading-[.82] tracking-tight ${rankColor}`}
        aria-label={`Rank ${position}`}
      >
        {position}
      </div>

      {/* Player name */}
      <div
        className={`${barlowFont} font-bold dark:font-extrabold text-[13px] tracking-[.03em] uppercase
                     truncate mt-1 text-[#111827] dark:text-amber-50
                     ${isFirst ? "text-[14px]" : ""}`}
      >
        {row.display_name}
      </div>

      {/* Stats: W · Win% */}
      <div
        className={`${monoFont} text-[10px] tracking-[.02em] flex items-center gap-1 mt-0.5`}
      >
        <span className="text-[#15803d] dark:text-[hsl(142_58%_55%)]">
          {row.wins}W
        </span>
        <span className="opacity-30">·</span>
        <span className="text-[#6b7280] dark:text-[hsl(220_10%_46%)]">
          {row.win_pct.toFixed(0)}%
        </span>
      </div>

      {/* Streak bolts (≥3 only) */}
      {row.win_streak >= 3 && (
        <div
          className={`${monoFont} text-[10px] font-bold flex items-center gap-0.5 mt-1.5
                       text-amber-600 dark:text-[hsl(38_92%_52%)]`}
          aria-label={`Win streak: ${row.win_streak}`}
        >
          <Bolts n={row.win_streak} />
          <span>×{row.win_streak}</span>
        </div>
      )}
    </div>
  );
}

export function LeaderboardPodium({ top3 }: LeaderboardPodiumProps) {
  if (top3.length < 3) return null;

  const [first, second, third] = top3;
  const monoFont = "font-[family-name:var(--font-jetbrains-mono)]";

  return (
    <div className="px-4 pt-2.5 pb-4">
      {/* Podium section header */}
      <div
        className={`${monoFont} text-[9.5px] tracking-[.2em] font-bold uppercase
                     flex items-center gap-2 mb-3`}
      >
        <span className="text-amber-600 dark:text-[hsl(38_92%_52%)]">PODIUM</span>
        {/* Amber gradient rule */}
        <span
          className="flex-1 h-px bg-gradient-to-r from-amber-500 to-transparent
                        dark:from-[hsl(38_92%_52%)] dark:to-transparent"
          aria-hidden="true"
        />
        <span className="text-[#6b7280] dark:text-[hsl(220_10%_38%)]">TOP 3</span>
      </div>

      {/* 3-card grid: [#2] [#1 wider] [#3] */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1.2fr 1fr" }}>
        <PodiumCell row={second} position={2} />
        <PodiumCell row={first}  position={1} />
        <PodiumCell row={third}  position={3} />
      </div>
    </div>
  );
}
