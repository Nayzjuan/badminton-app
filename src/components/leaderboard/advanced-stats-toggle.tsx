"use client";

// ============================================================
// AdvancedStatsToggle — Show / hide PF · PA · +/- columns
// ============================================================
// Used in organizer-panel and standalone variants only.
// 180° chevron rotation signals open/closed state.
// Min touch target: min-h-[36px] (secondary action — 44px
// reserved for primary CTAs per the UI spec).
// ============================================================

import { ChevronDown } from "lucide-react";

interface AdvancedStatsToggleProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function AdvancedStatsToggle({ isOpen, onToggle }: AdvancedStatsToggleProps) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-controls="advanced-stats-columns"
      className="flex items-center gap-1.5 rounded-lg border border-slate-200
                 dark:border-border px-3 min-h-[36px] text-xs font-medium
                 text-muted-foreground hover:text-foreground hover:bg-muted/50
                 transition-colors"
    >
      <span>{isOpen ? "Hide Advanced Stats" : "Show Advanced Stats"}</span>
      <ChevronDown
        className={`h-3.5 w-3.5 transition-transform duration-200 ${
          isOpen ? "rotate-180" : ""
        }`}
        aria-hidden="true"
      />
    </button>
  );
}
