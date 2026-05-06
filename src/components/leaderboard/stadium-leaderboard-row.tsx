"use client";

// ============================================================
// StadiumLeaderboardRow — Row for the Direction A Stadium layout
// ============================================================
// Uses a strict 6-column CSS grid matching the column header:
//   grid-template-columns: 34px 1fr 30px 64px 52px 26px
//   # | PLAYER | GP | W–L | WIN% | Δ
//
// Key differences from leaderboard-row.tsx:
//   - Barlow Condensed (not Space Grotesk) for player name + win%
//   - JetBrains Mono for all numeric columns
//   - No emoji medals — rank number styled in JetBrains Mono (muted)
//   - No emoji streaks — lightning bolt SVGs via Bolts component
//   - Δ column is ALWAYS rendered (never conditionally hidden)
//   - YOU row: amber left-border + amber tint bg + inline YOU tag
//
// leaderboard-row.tsx is NOT modified — it's still used by
// organizer-panel and standalone variants.
// ============================================================

import type { LeaderboardRow } from "@/types/leaderboard";
import { Bolts } from "./bolt-icons";

interface StadiumLeaderboardRowProps {
  row: LeaderboardRow;
  isCurrentUser: boolean;
  flash: boolean;
}

function movementDisplay(n: number | null): { label: string; cls: string } {
  if (n === null || n === 0)
    return { label: "·", cls: "opacity-[.28]" };
  if (n > 0)
    return {
      label: `▲${n}`,
      cls: "text-[#15803d] dark:text-[hsl(142_58%_55%)]",
    };
  return {
    label: `▼${Math.abs(n)}`,
    cls: "text-[#dc2626] dark:text-[hsl(0_68%_60%)]",
  };
}

export function StadiumLeaderboardRow({
  row,
  isCurrentUser,
  flash,
}: StadiumLeaderboardRowProps) {
  const monoFont = "font-[family-name:var(--font-jetbrains-mono)]";
  const barlowFont = "font-[family-name:var(--font-barlow-condensed)]";
  const mv = movementDisplay(row.rank_movement ?? null);

  // YOU row shifts padding-left to 13px to visually clear the 2px left-border
  const gridCls = [
    "grid items-center py-[11px]",
    "border-b border-[#f3f4f6] dark:border-[hsl(217_18%_12%)] last:border-b-0",
    "transition-colors duration-150",
    isCurrentUser
      ? "bg-amber-50 dark:bg-[hsl(38_92%_52%/0.10)] border-l-2 border-amber-400 dark:border-l-[hsl(38_92%_52%)] pr-4 pl-[13px]"
      : "px-4 hover:bg-[#f9fafb] dark:hover:bg-[hsl(217_25%_12%)]",
    flash ? "animate-[flash_1.2s_ease-out]" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="row"
      data-flash={flash ? "true" : undefined}
      className={gridCls}
      style={{ gridTemplateColumns: "34px 1fr 30px 64px 52px 26px", gap: "6px" }}
    >
      {/* # — rank number */}
      <div
        role="gridcell"
        className={`${monoFont} text-[11px] font-bold text-right tracking-[.02em]
                     text-[#9ca3af] dark:text-[hsl(220_10%_34%)]`}
      >
        {String(row.rank).padStart(2, "0")}
      </div>

      {/* PLAYER — name + optional YOU tag + optional streak */}
      <div
        role="gridcell"
        className="flex items-center gap-1.5 min-w-0"
      >
        {/* YOU inline tag */}
        {isCurrentUser && (
          <span
            className={`${monoFont} text-[8.5px] font-extrabold tracking-[.14em] uppercase
                         px-1.5 py-0.5 flex-shrink-0
                         bg-[#111827] text-amber-400
                         dark:bg-[hsl(38_92%_52%)] dark:text-[hsl(217_28%_8%)]`}
          >
            YOU
          </span>
        )}

        {/* Player name */}
        <span
          className={`${barlowFont} font-bold text-[18px] tracking-[.02em]
                       truncate text-[#111827] dark:text-white`}
        >
          {row.display_name}
        </span>

        {/* Streak bolts (≥3) */}
        {row.win_streak >= 3 && (
          <span
            className={`${monoFont} text-[10px] font-bold flex items-center gap-0.5 flex-shrink-0
                         text-amber-600 dark:text-[hsl(38_92%_52%)]`}
            aria-label={`Win streak: ${row.win_streak}`}
          >
            <Bolts n={row.win_streak} />
            ×{row.win_streak}
          </span>
        )}
      </div>

      {/* GP */}
      <div
        role="gridcell"
        className={`${monoFont} text-[11px] text-right
                     text-[#9ca3af] dark:text-[hsl(220_10%_40%)]`}
      >
        {row.games_played}
      </div>

      {/* W–L */}
      <div
        role="gridcell"
        className={`${monoFont} text-[11px] font-semibold text-right tracking-[.01em]`}
      >
        <span className="text-[#15803d] dark:text-[hsl(142_58%_55%)]">
          {row.wins}W
        </span>
        <span className="opacity-30 mx-[1px]">–</span>
        <span className="text-[#dc2626] dark:text-[hsl(0_68%_60%)]">
          {row.losses}L
        </span>
      </div>

      {/* WIN% */}
      <div
        role="gridcell"
        className={`${barlowFont} font-bold italic text-[16px] text-right
                     text-[#111827] dark:text-[hsl(220_12%_85%)]`}
      >
        {row.win_pct.toFixed(1)}
      </div>

      {/* Δ — rank movement (always shown; · when null/0) */}
      <div
        role="gridcell"
        className={`${monoFont} text-[10px] font-bold text-right ${mv.cls}`}
        aria-label={
          mv.label === "·"
            ? "No rank change"
            : `Rank ${mv.label.startsWith("▲") ? "up" : "down"} ${mv.label.slice(1)}`
        }
      >
        {mv.label}
      </div>
    </div>
  );
}
