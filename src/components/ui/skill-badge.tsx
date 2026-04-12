"use client";

// ============================================================
// SkillBadge — Vibrant pill badge for a player's skill level
// ============================================================
// Three colour tiers, no border — pure pill shape:
//   Beginner  (beginner, upper_beginner)                → emerald
//   Intermediate (lower_int, int, upper_int)            → blue
//   Advanced  (lower_advanced, advanced)                → purple
// ============================================================

import { cn } from "@/lib/utils";
import type { SkillLevel } from "@/types/database";

interface SkillBadgeProps {
  level: SkillLevel;
  className?: string;
}

const LEVEL_CONFIG: Record<SkillLevel, { label: string; cls: string }> = {
  beginner: {
    label: "Beginner",
    cls: "bg-emerald-100 text-emerald-800",
  },
  upper_beginner: {
    label: "Upper Beg.",
    cls: "bg-emerald-100 text-emerald-800",
  },
  lower_intermediate: {
    label: "Lower Int.",
    cls: "bg-blue-100 text-blue-800",
  },
  intermediate: {
    label: "Intermediate",
    cls: "bg-blue-100 text-blue-800",
  },
  upper_intermediate: {
    label: "Upper Int.",
    cls: "bg-blue-100 text-blue-800",
  },
  lower_advanced: {
    label: "Lower Adv.",
    cls: "bg-purple-100 text-purple-800",
  },
  advanced: {
    label: "Advanced",
    cls: "bg-purple-100 text-purple-800",
  },
};

export function SkillBadge({ level, className }: SkillBadgeProps) {
  const config = LEVEL_CONFIG[level];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5",
        "text-xs font-semibold leading-none",
        config.cls,
        className
      )}
    >
      {config.label}
    </span>
  );
}
