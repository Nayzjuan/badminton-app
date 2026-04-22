"use client";

// ============================================================
// WrappedAwardCard — single award in the Wrapped feed
// ============================================================
// Displays one earned award with:
//   • Rarity-coded background tint
//   • Big emoji
//   • Award title + personalized subtitle
//   • Subtle rarity badge
//   • Entrance animation (staggered via CSS custom prop)
//
// Constraints for html-to-image capture:
//   • No backdrop-filter
//   • No dark: variants (capture div is always dark)
//   • No grid layout — flex only
//   • No Google Font URLs in inline styles
// ============================================================

import { AWARD_META, renderSubtitle, type AwardRarity } from "@/lib/wrapped-awards";

// ── Rarity color palettes ─────────────────────────────────────
// These are inline-style objects (not Tailwind dark: classes)
// so they survive html-to-image capture on a dark background.

const RARITY_STYLES: Record<
  AwardRarity,
  { border: string; bg: string; badge: string; glow: string }
> = {
  legendary: {
    border: "rgba(251,191,36,0.55)",
    bg:     "rgba(245,158,11,0.12)",
    badge:  "rgba(245,158,11,0.25)",
    glow:   "0 0 18px rgba(245,158,11,0.2)",
  },
  rare: {
    border: "rgba(139,92,246,0.45)",
    bg:     "rgba(139,92,246,0.1)",
    badge:  "rgba(139,92,246,0.2)",
    glow:   "0 0 14px rgba(139,92,246,0.15)",
  },
  uncommon: {
    border: "rgba(52,211,153,0.35)",
    bg:     "rgba(52,211,153,0.08)",
    badge:  "rgba(52,211,153,0.15)",
    glow:   "none",
  },
  common: {
    border: "rgba(255,255,255,0.1)",
    bg:     "rgba(255,255,255,0.04)",
    badge:  "rgba(255,255,255,0.1)",
    glow:   "none",
  },
};

const RARITY_LABELS: Record<AwardRarity, string> = {
  legendary: "Legendary",
  rare:      "Rare",
  uncommon:  "Uncommon",
  common:    "Common",
};

// ── Props ──────────────────────────────────────────────────────

interface WrappedAwardCardProps {
  slug: string;
  /** The award_data[slug] object from the database */
  data: Record<string, unknown>;
  /** Animation delay index (0 = first card) */
  index?: number;
}

// ── Component ─────────────────────────────────────────────────

export function WrappedAwardCard({ slug, data, index = 0 }: WrappedAwardCardProps) {
  const meta = AWARD_META[slug];
  if (!meta) return null;

  const s      = RARITY_STYLES[meta.rarity];
  const label  = RARITY_LABELS[meta.rarity];
  const sub    = renderSubtitle(slug, data);
  const delay  = 200 + index * 90;   // stagger each card by 90ms

  return (
    <div
      style={{
        borderRadius: "1rem",
        border:       `1px solid ${s.border}`,
        background:   s.bg,
        boxShadow:    s.glow,
        padding:      "1.25rem 1rem",
        display:      "flex",
        flexDirection: "column",
        gap:           "0.5rem",
        animation:     `wi-up 380ms cubic-bezier(0.22,1,0.36,1) ${delay}ms both`,
      }}
    >
      {/* ── Rarity badge + emoji row ───────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {/* Rarity badge */}
        <span
          style={{
            fontSize:      "9px",
            fontWeight:    "900",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color:         "rgba(255,255,255,0.5)",
            background:    s.badge,
            borderRadius:  "999px",
            padding:       "2px 8px",
          }}
        >
          {label}
        </span>

        {/* Emoji */}
        <span style={{ fontSize: "2.25rem", lineHeight: 1 }} aria-hidden="true">
          {meta.emoji}
        </span>
      </div>

      {/* ── Title ──────────────────────────────────────────── */}
      <p
        style={{
          fontSize:   "1.125rem",
          fontWeight: "800",
          color:      "#FFFFFF",
          lineHeight: 1.2,
          margin:     0,
        }}
      >
        {meta.title}
      </p>

      {/* ── Subtitle ───────────────────────────────────────── */}
      <p
        style={{
          fontSize:   "0.8125rem",
          fontWeight: "400",
          color:      "rgba(255,255,255,0.6)",
          lineHeight: 1.5,
          margin:     0,
        }}
      >
        {sub}
      </p>
    </div>
  );
}
