"use client";

// ============================================================
// BoltIcons — SVG lightning bolt streak indicators
// ============================================================
// Used by StadiumLeaderboardRow and LeaderboardPodium to show
// win-streak count without emoji dependency.
//
// BoltSvg  — a single 8×14 lightning bolt path
// Bolts    — renders up to 3 bolts side-by-side, followed by
//             ×N count in JetBrains Mono
// ============================================================

export function BoltSvg() {
  return (
    <svg
      viewBox="0 0 8 14"
      fill="currentColor"
      width={7}
      height={11}
      aria-hidden="true"
    >
      <path d="M5 0 L0 8 H3 L2 14 L8 5 H5 Z" />
    </svg>
  );
}

interface BoltsProps {
  /** Streak count — up to 3 bolt icons are shown */
  n: number;
}

export function Bolts({ n }: BoltsProps) {
  return (
    <span className="inline-flex gap-px">
      {Array.from({ length: Math.min(n, 3) }).map((_, i) => (
        <BoltSvg key={i} />
      ))}
    </span>
  );
}
