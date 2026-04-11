"use client";

// ============================================================
// SkillBadge — Colour-coded pill for a player's skill level
// ============================================================
// Three tiers:
//   Beginner (1–2)      → green
//   Intermediate (3–5)  → blue / indigo
//   Advanced (6–7)      → orange / amber
//
// Each tier has two distinct shades so adjacent levels look
// subtly different while staying clearly in the same family.
// ============================================================

import { cn } from "@/lib/utils";
import type { SkillLevel } from "@/types/database";

interface SkillBadgeProps {
  level: SkillLevel;
  className?: string;
}

const LEVEL_CONFIG: Record<
  SkillLevel,
  { label: string; cls: string }
> = {
  beginner: {
    label: "Beginner",
    cls: "bg-green-100 text-green-800 border-green-200",
  },
  upper_beginner: {
    label: "Upper Beg.",
    cls: "bg-teal-100 text-teal-800 border-teal-200",
  },
  lower_intermediate: {
    label: "Lower Int.",
    cls: "bg-sky-100 text-sky-800 border-sky-200",
  },
  intermediate: {
    label: "Intermediate",
    cls: "bg-blue-100 text-blue-800 border-blue-200",
  },
  upper_intermediate: {
    label: "Upper Int.",
    cls: "bg-indigo-100 text-indigo-800 border-indigo-200",
  },
  lower_advanced: {
    label: "Lower Adv.",
    cls: "bg-orange-100 text-orange-800 border-orange-200",
  },
  advanced: {
    label: "Advanced",
    cls: "bg-amber-100 text-amber-900 border-amber-300",
  },
};

export function SkillBadge({ level, className }: SkillBadgeProps) {
  const config = LEVEL_CONFIG[level];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5",
        "text-[10px] font-semibold leading-none tracking-wide",
        config.cls,
        className
      )}
    >
      {config.label}
    </span>
  );
}
