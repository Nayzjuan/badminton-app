"use client";

// ============================================================
// VIP Player Tags — Design Preview Sandbox
// ============================================================
// Route: /vip-preview
// Purpose: Visual preview of VIP tag themes and animations
//          on both Active Courts (dark emerald) and On Deck
//          (light cream) backgrounds before real implementation.
// No database queries — all data is hardcoded mock data.
// Safe to delete once the real VIP tags are implemented.
// ============================================================

import { useState } from "react";

// ── VIP Config Map (proposed — not yet live) ─────────────────
// Keys are lowercase normalized display names.
const VIP_PLAYERS: Record<string, { tag: string; theme: VipTheme }> = {
  miggy:  { tag: "DEV",  theme: "cyber-neon"    },
  stelle: { tag: "8080", theme: "violet-spark"   },
  cogs:   { tag: "MVP",  theme: "gold-prestige"  },
  raf:    { tag: "BOSS", theme: "crimson-elite"  },
};

type VipTheme = "cyber-neon" | "gold-prestige" | "crimson-elite" | "violet-spark";

// ── Theme token definitions ───────────────────────────────────
//
// Light mode strategy: box-shadow creates a physically visible
// colored halo around the pill shape — filter: drop-shadow
// bleeds into white/cream and disappears.
//
// Dark mode strategy: filter: drop-shadow stacks produce the
// layered neon bloom effect on dark surfaces.
//
const THEME_TOKENS: Record<
  VipTheme,
  {
    label: string;
    gradientLight: string;  // darker stops — contrast on cream
    gradientDark: string;   // bright stops — neon on black
    // Light: box-shadow string (ring + soft outer glow)
    glowLight: string;
    // Dark: filter value (drop-shadow stacks)
    glowDark: string;
    borderLight: string;
    borderDark: string;
    bgLight: string;
    bgDark: string;
  }
> = {
  "cyber-neon": {
    label: "Cyber Neon",
    gradientLight: "from-[hsl(165_100%_28%)] via-[hsl(185_100%_36%)] to-[hsl(165_100%_28%)]",
    gradientDark:  "from-[hsl(165_100%_55%)] via-[hsl(185_100%_68%)] to-[hsl(165_100%_55%)]",
    glowLight:
      "0 0 0 1.5px hsl(165 100% 35%), 0 0 8px 3px hsl(165 100% 42% / 0.55), 0 0 18px 5px hsl(185 100% 50% / 0.35)",
    glowDark:
      "drop-shadow(0 0 5px hsl(165 100% 55% / 1)) drop-shadow(0 0 12px hsl(185 100% 65% / 0.85)) drop-shadow(0 0 22px hsl(165 100% 50% / 0.55))",
    borderLight: "hsl(165 100% 35% / 0.9)",
    borderDark:  "hsl(165 100% 58% / 0.85)",
    bgLight: "hsl(165 100% 38% / 0.12)",
    bgDark:  "hsl(165 100% 48% / 0.16)",
  },
  "violet-spark": {
    label: "Violet Spark",
    gradientLight: "from-[hsl(270_100%_45%)] via-[hsl(290_100%_55%)] to-[hsl(270_100%_45%)]",
    gradientDark:  "from-[hsl(270_100%_72%)] via-[hsl(290_100%_80%)] to-[hsl(270_100%_72%)]",
    glowLight:
      "0 0 0 1.5px hsl(270 100% 48%), 0 0 8px 3px hsl(270 100% 55% / 0.55), 0 0 18px 5px hsl(290 100% 62% / 0.35)",
    glowDark:
      "drop-shadow(0 0 5px hsl(270 100% 72% / 1)) drop-shadow(0 0 12px hsl(290 100% 78% / 0.85)) drop-shadow(0 0 22px hsl(270 100% 65% / 0.55))",
    borderLight: "hsl(270 100% 48% / 0.9)",
    borderDark:  "hsl(270 100% 72% / 0.85)",
    bgLight: "hsl(270 100% 52% / 0.1)",
    bgDark:  "hsl(270 100% 60% / 0.16)",
  },
  "gold-prestige": {
    label: "Gold Prestige",
    gradientLight: "from-[hsl(43_100%_32%)] via-[hsl(38_100%_42%)] to-[hsl(43_100%_32%)]",
    gradientDark:  "from-[hsl(43_100%_58%)] via-[hsl(38_100%_70%)] to-[hsl(43_100%_58%)]",
    glowLight:
      "0 0 0 1.5px hsl(43 100% 38%), 0 0 8px 3px hsl(43 100% 45% / 0.55), 0 0 18px 5px hsl(38 100% 52% / 0.35)",
    glowDark:
      "drop-shadow(0 0 5px hsl(43 100% 58% / 1)) drop-shadow(0 0 12px hsl(38 100% 68% / 0.85)) drop-shadow(0 0 22px hsl(43 100% 52% / 0.55))",
    borderLight: "hsl(43 100% 36% / 0.9)",
    borderDark:  "hsl(43 100% 62% / 0.85)",
    bgLight: "hsl(43 100% 42% / 0.12)",
    bgDark:  "hsl(43 100% 52% / 0.16)",
  },
  "crimson-elite": {
    label: "Crimson Elite",
    gradientLight: "from-[hsl(0_100%_40%)] via-[hsl(15_100%_50%)] to-[hsl(0_100%_40%)]",
    gradientDark:  "from-[hsl(0_100%_62%)] via-[hsl(15_100%_72%)] to-[hsl(0_100%_62%)]",
    glowLight:
      "0 0 0 1.5px hsl(0 100% 42%), 0 0 8px 3px hsl(0 100% 50% / 0.55), 0 0 18px 5px hsl(15 100% 55% / 0.35)",
    glowDark:
      "drop-shadow(0 0 5px hsl(0 100% 60% / 1)) drop-shadow(0 0 12px hsl(15 100% 68% / 0.85)) drop-shadow(0 0 22px hsl(0 100% 55% / 0.55))",
    borderLight: "hsl(0 100% 40% / 0.9)",
    borderDark:  "hsl(0 100% 62% / 0.85)",
    bgLight: "hsl(0 100% 45% / 0.1)",
    bgDark:  "hsl(0 100% 55% / 0.16)",
  },
};

// ── VipTag component ──────────────────────────────────────────

function VipTag({
  tag,
  theme,
  dark = false,
}: {
  tag: string;
  theme: VipTheme;
  dark?: boolean;
}) {
  const t = THEME_TOKENS[theme];

  return (
    <span
      className="inline-flex items-center justify-center rounded-[3px] border px-[6px]"
      style={{
        background:  dark ? t.bgDark    : t.bgLight,
        borderColor: dark ? t.borderDark : t.borderLight,
        // Light → box-shadow: colored ring + soft outer bloom visible on cream
        // Dark  → filter drop-shadow: layered neon bloom on dark surfaces
        ...(dark
          ? { filter:     t.glowDark }
          : { boxShadow:  t.glowLight }),
        animation: "vip-glow-pulse 2.6s ease-in-out infinite",
        height:     "18px",
        lineHeight: "1",
      }}
    >
      <span
        className={[
          "bg-gradient-to-r bg-clip-text text-transparent",
          "font-black uppercase tracking-[0.2em] text-[10px]",
          dark ? t.gradientDark : t.gradientLight,
        ].join(" ")}
        style={{
          backgroundSize: "200% auto",
          animation: "vip-shimmer 4.5s linear infinite",
          display: "inline-block",
          transform: "translateY(0.5px)",
        }}
      >
        {tag}
      </span>
    </span>
  );
}

// ── MockPill — mimics the PlayerPill in badminton-court.tsx ──

function MockPill({
  name,
  skill = "intermediate",
  dark = false,
}: {
  name: string;
  skill?: string;
  dark?: boolean;
}) {
  const vip = VIP_PLAYERS[name.toLowerCase()];

  const skillColors: Record<string, string> = {
    beginner: dark
      ? "bg-emerald-900/40 text-emerald-300"
      : "bg-emerald-100 text-emerald-800",
    intermediate: dark
      ? "bg-blue-900/40 text-blue-300"
      : "bg-blue-100 text-blue-800",
    advanced: dark
      ? "bg-purple-900/40 text-purple-300"
      : "bg-purple-100 text-purple-800",
  };

  return (
    <div
      className={[
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold",
        dark
          ? "bg-black/60 text-[hsl(80_100%_60%)]"
          : "bg-white/90 text-slate-900",
      ].join(" ")}
    >
      {/* Name */}
      <span>{name}</span>

      {/* Separator + VIP tag */}
      {vip && (
        <>
          <span className={dark ? "text-white/30" : "text-slate-300"}>|</span>
          <VipTag tag={vip.tag} theme={vip.theme} dark={dark} />
        </>
      )}

      {/* Skill badge */}
      <span
        className={[
          "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
          skillColors[skill] ?? skillColors.intermediate,
        ].join(" ")}
      >
        {skill}
      </span>
    </div>
  );
}

// ── Court surface mockup ──────────────────────────────────────

function CourtCard({ dark }: { dark: boolean }) {
  const bg = dark
    ? "bg-emerald-800"
    : "bg-[#FAFAF7] border border-slate-200";

  const label = dark ? "Active Courts (dark court)" : "On Deck (light card)";
  const labelColor = dark ? "text-white/50" : "text-slate-400";

  return (
    <div className={`rounded-xl p-5 space-y-3 ${bg}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-widest ${labelColor}`}>
        {label}
      </p>

      {Object.entries(VIP_PLAYERS).map(([name]) => {
        const display = name.charAt(0).toUpperCase() + name.slice(1);
        const skills = ["beginner", "intermediate", "advanced"];
        const skill = skills[Object.keys(VIP_PLAYERS).indexOf(name) % 3];
        return (
          <div key={name}>
            <MockPill name={display} skill={skill} dark={dark} />
          </div>
        );
      })}

      {/* Non-VIP player for contrast */}
      <div>
        <MockPill name="Jordan" skill="beginner" dark={dark} />
      </div>
      <div>
        <MockPill name="Sam" skill="advanced" dark={dark} />
      </div>
    </div>
  );
}

// ── Theme swatch legend ───────────────────────────────────────

function ThemeLegend() {
  return (
    <div className="flex flex-wrap gap-3">
      {(Object.entries(THEME_TOKENS) as [VipTheme, (typeof THEME_TOKENS)[VipTheme]][]).map(
        ([key, t]) => {
          const tagLabels: Record<VipTheme, string> = {
            "cyber-neon":    "DEV",
            "violet-spark":  "8080",
            "gold-prestige": "MVP",
            "crimson-elite": "BOSS",
          };
          return (
            <div key={key} className="flex items-center gap-2">
              <VipTag tag={tagLabels[key]} theme={key} />
              <span className="text-xs text-muted-foreground">{t.label}</span>
            </div>
          );
        }
      )}
    </div>
  );
}

// ── VIP config table ─────────────────────────────────────────

function VipConfigTable() {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Display Name
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tag
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Theme
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Preview
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(VIP_PLAYERS).map(([name, meta], i) => {
            const display = name.charAt(0).toUpperCase() + name.slice(1);
            return (
              <tr
                key={name}
                className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}
              >
                <td className="px-4 py-3 font-medium">{display}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {meta.tag}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{THEME_TOKENS[meta.theme].label}</td>
                <td className="px-4 py-3 flex gap-2">
                  <VipTag tag={meta.tag} theme={meta.theme} dark={false} />
                  <VipTag tag={meta.tag} theme={meta.theme} dark={true} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────

export default function VipPreviewPage() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <>
      {/* Keyframe injection */}
      <style>{`
        @keyframes vip-shimmer {
          0%   { background-position: 0% center; }
          100% { background-position: 200% center; }
        }
        @keyframes vip-glow-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.55; }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="vip-shimmer"],
          [style*="vip-glow-pulse"] {
            animation: none !important;
          }
        }
      `}</style>

      <div className={darkMode ? "dark" : ""}>
        <div className="min-h-screen bg-background text-foreground">
          <div className="mx-auto max-w-3xl px-4 py-10 space-y-10">

            {/* Header */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Preview Sandbox · /vip-preview
                  </p>
                  <h1 className="text-2xl font-black tracking-tight mt-1">
                    VIP Player Tags
                  </h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Easter egg — not yet live in the app.
                  </p>
                </div>
                <button
                  onClick={() => setDarkMode((d) => !d)}
                  className="rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
                >
                  {darkMode ? "☀️ Light" : "🌙 Dark"}
                </button>
              </div>
            </div>

            {/* Theme legend */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Themes
              </h2>
              <ThemeLegend />
            </section>

            {/* VIP config */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Config Map
              </h2>
              <VipConfigTable />
            </section>

            {/* Live preview — both backgrounds */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                In Context
              </h2>
              <p className="text-xs text-muted-foreground">
                VIP pills alongside regular players — how they'll appear in Active Courts and On Deck cards.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <CourtCard dark={true} />
                <CourtCard dark={false} />
              </div>
            </section>

            {/* Implementation note */}
            <section className="rounded-xl border border-border bg-muted/30 p-5 space-y-2">
              <h2 className="text-sm font-semibold">Implementation Plan</h2>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li>
                  <strong>NEW</strong> <code className="text-xs">src/lib/vip-players.ts</code> — config map + <code className="text-xs">getVipMeta(name)</code> helper
                </li>
                <li>
                  <strong>APPEND</strong> <code className="text-xs">src/app/globals.css</code> — <code className="text-xs">@keyframes vip-shimmer</code> + <code className="text-xs">vip-glow-pulse</code>
                </li>
                <li>
                  <strong>EDIT</strong> <code className="text-xs">src/components/ui/badminton-court.tsx</code> — inject <code className="text-xs">&lt;VipTag&gt;</code> inside <code className="text-xs">PlayerPill</code>
                </li>
              </ul>
              <p className="text-xs text-muted-foreground pt-1">
                Awaiting design approval before any of the above files are touched.
              </p>
            </section>

          </div>
        </div>
      </div>
    </>
  );
}
