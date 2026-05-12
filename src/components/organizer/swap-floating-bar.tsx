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
        "bg-cc-bg-2",
        "border border-cc-accent/40",
        "shadow-[0_0_24px_var(--cc-accent-glow),0_8px_32px_rgb(0_0_0/0.40)]",
        // Geometry — sharp cut-corner clip matching command-center cards
        "rounded-2xl",
        // Entrance animation
        "animate-in slide-in-from-bottom-3 fade-in duration-250",
        "max-w-[calc(100vw-2rem)]",
      ].join(" ")}
    >
      {/* ── Teal pulse dot — "swap mode active" signal ────── */}
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cc-accent opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-cc-accent shadow-[0_0_8px_var(--cc-accent-glow)]" />
      </span>

      {/* ── Selected player info ──────────────────────────── */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0">
          <p className="font-command text-[12px] font-bold text-cc-t1 truncate max-w-[9rem] uppercase tracking-wide leading-tight">
            {playerName}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="font-command text-[9px] font-semibold text-cc-t2 uppercase tracking-[0.14em]">
              {teamLabel(team)}
            </span>
            <span className="font-command text-[9px] text-cc-t3 uppercase tracking-[0.10em]">
              · {SKILL_ABBREV[skill]}
            </span>
          </div>
        </div>
      </div>

      {/* ── Divider ───────────────────────────────────────── */}
      <div className="h-8 w-px bg-cc-border shrink-0" />

      {/* ── Actions ───────────────────────────────────────── */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Pick from Bench — teal translucent command button */}
        <button
          onClick={onPickFromBench}
          className="flex items-center gap-1.5
                     bg-cc-accent-dim hover:bg-cc-accent/30
                     border border-cc-accent/45
                     px-3 py-2.5 rounded-lg
                     font-command text-[10px] font-bold uppercase tracking-[0.12em]
                     text-cc-accent-text
                     transition-colors min-h-[44px]"
        >
          <ArrowLeftRight className="h-3 w-3 shrink-0" />
          Bench
        </button>

        {/* Cancel — red dim dismiss */}
        <button
          onClick={onCancel}
          aria-label="Cancel swap"
          className="flex h-11 w-11 items-center justify-center rounded-lg
                     bg-cc-red-dim border border-cc-red/30
                     text-cc-red
                     hover:bg-cc-red/20 hover:border-cc-red/50
                     transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
