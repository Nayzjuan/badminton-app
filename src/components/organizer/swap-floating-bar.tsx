"use client";

// ============================================================
// SwapFloatingBar — Contextual bar shown during Tap-to-Swap
// picking mode
// ============================================================
// Appears as a fixed bottom pill when the organizer taps a
// player and enters "picking" mode (first tap done, waiting for
// second selection).
//
// Shows who is selected and provides two escape hatches:
//   "Pick from Bench" — promotes to sheet mode (legacy bench path)
//   "Cancel" (×)      — clears picking mode entirely
//
// Slides up on mount, slides down on unmount via CSS animation.
// Respects prefers-reduced-motion.
// ============================================================

import { X, Users } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { SkillLevel } from "@/types/database";

interface SwapFloatingBarProps {
  /** Name of the player selected for swapping out. */
  playerName: string;
  /** Team label of the selected player. */
  team: "a" | "b";
  /** Skill level for the badge. */
  skill: SkillLevel;
  /** Opens the legacy bench-swap sheet. */
  onPickFromBench: () => void;
  /** Cancels picking mode and clears selection. */
  onCancel: () => void;
}

function teamLabel(team: "a" | "b") {
  return team === "a" ? "Team A" : "Team B";
}

export function SwapFloatingBar({
  playerName,
  team,
  skill,
  onPickFromBench,
  onCancel,
}: SwapFloatingBarProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Swap mode active. ${playerName} from ${teamLabel(team)} selected. Tap another player to swap, or pick from bench.`}
      className={[
        // Positioning: fixed bottom-center, above any bottom nav
        "fixed bottom-5 left-1/2 -translate-x-1/2 z-50",
        // Layout
        "flex items-center gap-3 rounded-2xl px-4 py-3",
        // Visuals: amber pill with subtle shadow
        "bg-amber-50 dark:bg-amber-950/90",
        "border border-amber-300 dark:border-amber-700",
        "shadow-xl shadow-amber-200/60 dark:shadow-amber-900/60",
        // Entrance animation — slide up from bottom
        "animate-in slide-in-from-bottom-3 fade-in duration-250",
        // Prevent the pill from being wider than the viewport on mobile
        "max-w-[calc(100vw-2rem)]",
      ].join(" ")}
    >
      {/* ── Selected player info ──────────────────────────── */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Pulsing amber dot — "swap mode active" signal */}
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
        </span>

        <div className="min-w-0">
          <p className="text-xs font-bold text-amber-900 dark:text-amber-200 truncate max-w-[10rem]">
            {playerName}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400 shrink-0">
              {teamLabel(team)}
            </span>
            <SkillBadge level={skill} className="text-[9px]" />
          </div>
        </div>
      </div>

      {/* ── Divider ───────────────────────────────────────── */}
      <div className="h-8 w-px bg-amber-200 dark:bg-amber-700/60 shrink-0" />

      {/* ── Actions ───────────────────────────────────────── */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Pick from Bench */}
        <button
          onClick={onPickFromBench}
          className="flex items-center gap-1.5 rounded-xl
                     bg-amber-500 hover:bg-amber-600
                     dark:bg-amber-600 dark:hover:bg-amber-700
                     px-3 py-1.5 text-xs font-bold text-white
                     transition-colors"
        >
          <Users className="h-3 w-3 shrink-0" />
          Pick from Bench
        </button>

        {/* Cancel */}
        <button
          onClick={onCancel}
          aria-label="Cancel swap"
          className="flex h-7 w-7 items-center justify-center rounded-full
                     border border-amber-300 dark:border-amber-700
                     text-amber-600 dark:text-amber-400
                     hover:bg-amber-100 dark:hover:bg-amber-900/50
                     transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
