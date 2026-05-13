"use client";

// ============================================================
// QueueStatus — Full-canvas position display
// ============================================================
// Hero numeral (#3), inline context, thin amber rule, and a
// compact 3-stat row (waited · games · skill). Reads at arm's
// length from across the room — the position number is the
// dominant signal.
// ============================================================

import type { SkillLevel } from "@/types/database";

interface QueueStatusProps {
  position: number | null;
  waitMinutes: number;
  gamesPlayed: number;
  totalInQueue: number;
  /** When provided, shows the player's skill abbreviation in the stats row. */
  skillLevel?: SkillLevel;
  /** When true, paints the position numeral amber (urgency, position ≤ 2). */
  approaching?: boolean;
}

const SKILL_ABBR: Record<SkillLevel, string> = {
  beginner: "BEG",
  lower_intermediate: "L.INT",
  intermediate: "INT",
  upper_intermediate: "U.INT",
  lower_advanced: "L.ADV",
  advanced: "ADV",
};

export function QueueStatus({
  position,
  waitMinutes,
  gamesPlayed,
  totalInQueue,
  skillLevel,
  approaching = false,
}: QueueStatusProps) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 relative">
      {/* Approaching: subtle amber radial glow behind the numeral */}
      {approaching && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 240px 200px at 50% 38%, oklch(0.78 0.16 70 / 0.10), transparent 70%)",
          }}
        />
      )}

      {/* Hero numeral */}
      <span
        className={`relative font-display text-[88px] font-black leading-none tabular-nums
                    ${approaching ? "text-amber-500 dark:text-amber-400" : "text-foreground"}`}
        style={{ letterSpacing: "-0.04em" }}
      >
        {position !== null ? `#${position}` : "—"}
      </span>

      {/* Context line */}
      <p
        className={`relative mt-3 text-sm font-medium
                    ${approaching ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
      >
        {position !== null
          ? `in line · ${totalInQueue} waiting`
          : `${totalInQueue} player${totalInQueue !== 1 ? "s" : ""} ahead`}
      </p>

      {/* Thin rule */}
      <div className={`relative my-7 h-px w-8 ${approaching ? "bg-amber-400/30" : "bg-border"}`} />

      {/* Stats row — waited · games · skill */}
      <div className="relative flex items-end gap-10">
        <Stat value={`${waitMinutes}m`} label="Waited" />
        <Stat value={`${gamesPlayed}`} label="Games" />
        {skillLevel && <Stat value={SKILL_ABBR[skillLevel]} label="Skill" tone="primary" />}
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  tone = "default",
}: {
  value: string;
  label: string;
  tone?: "default" | "primary";
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span
        className={`text-lg font-semibold leading-none tabular-nums
                    ${tone === "primary" ? "text-primary" : "text-foreground/80"}`}
        style={{ letterSpacing: "-0.02em" }}
      >
        {value}
      </span>
      <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
