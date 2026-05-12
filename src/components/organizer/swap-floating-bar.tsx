"use client";

// ============================================================
// SwapFloatingBar — HUD pill shown during Tap-to-Swap picking mode
// ============================================================
// Fixed bottom-center bar that appears when the organizer taps
// a player and enters "picking" mode (first tap done, awaiting
// second selection).
//
// Command-center aesthetic: dark teal-bordered HUD, Chakra Petch
// labels, teal pulse dot. Matches the organizer dashboard palette.
//
// Actions:
//   "Pick from Bench" — promotes to sheet mode (legacy bench path)
//   "Cancel" (×)      — clears picking mode entirely
//
// Slides up on mount. Respects prefers-reduced-motion.
// ============================================================

import { X, ArrowLeftRight } from "lucide-react";
import type { SkillLevel } from "@/types/database";

const SKILL_ABBREV: Record<SkillLevel, string> = {
  beginner: "BEG",
  lower_intermediate: "BEG",
  intermediate: "INT",
  upper_intermediate: "INT",
  lower_advanced: "ADV",
  advanced: "ADV",
};

interface SwapFloatingBarProps {
  playerName: string;
  team: "a" | "b";
  skill: SkillLevel;
  onPickFromBench: () => void;
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
      data-testid="swap-floating-bar"
      aria-label={`Swap mode active. ${playerName} from ${teamLabel(team)} selected. Tap another player to swap, or pick from bench.`}
      className={[
        // Positioning — floats above PwaNavBar (z-[100]) + iOS safe area
        "fixed left-1/2 -translate-x-1/2 z-[110]",
        "[bottom:calc(3rem+max(1rem,env(safe-area-inset-bottom,0px)))]",
        // Layout
        "flex items-center gap-3 px-4 py-3",
        // Command-center dark surface
        "bg-[oklch(0.14_0.018_238)]",
        "border border-[oklch(0.79_0.18_188/0.50)]",
        "shadow-[0_0_24px_oklch(0.79_0.18_188/0.18),0_8px_32px_oklch(0.10_0.016_238/0.60)]",
        // Geometry — sharp cut-corner clip matching command-center cards
        "rounded-2xl",
        // Entrance animation
        "animate-in slide-in-from-bottom-3 fade-in duration-250",
        "max-w-[calc(100vw-2rem)]",
      ].join(" ")}
    >
      {/* ── Teal pulse dot — "swap mode active" signal ────── */}
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[oklch(0.79_0.18_188)] opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[oklch(0.79_0.18_188)]" />
      </span>

      {/* ── Selected player info ──────────────────────────── */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0">
          <p className="font-command text-[12px] font-bold text-[oklch(0.94_0.008_238)] truncate max-w-[9rem] uppercase tracking-wide leading-tight">
            {playerName}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="font-command text-[9px] font-semibold text-[oklch(0.68_0.014_238)] uppercase tracking-[0.14em]">
              {teamLabel(team)}
            </span>
            <span className="font-command text-[9px] text-[oklch(0.48_0.016_238)] uppercase tracking-[0.10em]">
              · {SKILL_ABBREV[skill]}
            </span>
          </div>
        </div>
      </div>

      {/* ── Divider ───────────────────────────────────────── */}
      <div className="h-8 w-px bg-[oklch(0.30_0.025_240)] shrink-0" />

      {/* ── Actions ───────────────────────────────────────── */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Pick from Bench — teal translucent command button */}
        <button
          onClick={onPickFromBench}
          className="flex items-center gap-1.5
                     bg-[oklch(0.79_0.18_188/0.16)] hover:bg-[oklch(0.79_0.18_188/0.28)]
                     border border-[oklch(0.79_0.18_188/0.45)]
                     px-3 py-2.5 rounded-lg
                     font-command text-[10px] font-bold uppercase tracking-[0.12em]
                     text-[oklch(0.79_0.18_188)]
                     transition-colors min-h-[44px]"
        >
          <ArrowLeftRight className="h-3 w-3 shrink-0" />
          Bench
        </button>

        {/* Cancel — ghost border */}
        <button
          onClick={onCancel}
          aria-label="Cancel swap"
          className="flex h-11 w-11 items-center justify-center rounded-lg
                     border border-[oklch(0.30_0.025_240)]
                     text-[oklch(0.48_0.016_238)] hover:text-[oklch(0.68_0.014_238)]
                     hover:border-[oklch(0.44_0.032_240)] hover:bg-[oklch(0.19_0.020_238)]
                     transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
