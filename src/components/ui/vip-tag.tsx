"use client";

// ============================================================
// VipTag — Floating player prestige badge
// ============================================================
// Renders two spans: one for dark mode (neon text-shadow bloom),
// one for light mode (holographic foil shimmer). CSS shows/hides
// the correct variant — no JS theme detection needed.
//
// Dark:  pure neon — bright text color + layered text-shadow + pulse
// Light: holographic foil — gradient bg-clip-text + shimmer sweep
//
// The vip-holo-shimmer keyframe lives in globals.css.
// prefers-reduced-motion: both animations are suppressed there.
// ============================================================

import { getVipThemeConfig } from "@/lib/vip-config";

interface VipTagProps {
  /** Display label stored on the profile (e.g. "DEV", "MVP"). */
  tag: string;
  /** Theme key from VIP_THEMES (e.g. "cyber-neon"). */
  theme: string;
}

export function VipTag({ tag, theme }: VipTagProps) {
  const config = getVipThemeConfig(theme);
  if (!config) return null;

  return (
    <>
      {/* ── Dark mode: neon text-shadow bloom ─────────────── */}
      <span
        className={[
          "hidden dark:inline",
          "font-black tracking-widest uppercase text-[13px] leading-none",
          config.neonClass,
          "animate-pulse",
        ].join(" ")}
      >
        {tag}
      </span>

      {/* ── Light mode: holographic foil shimmer ──────────── */}
      <span
        className={[
          "inline dark:hidden",
          "bg-gradient-to-r",
          config.holoFrom,
          config.holoVia,
          config.holoTo,
          "bg-clip-text text-transparent",
          "font-black tracking-widest uppercase text-[13px] leading-none",
        ].join(" ")}
        style={{
          backgroundSize: "200% auto",
          animation: "vip-holo-shimmer 2.5s linear infinite",
          display: "inline-block",
        }}
      >
        {tag}
      </span>
    </>
  );
}
