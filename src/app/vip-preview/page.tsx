"use client";

// ============================================================
// VIP Player Tags — Design Preview Sandbox
// ============================================================
// Route: /vip-preview
// Purpose: Visual preview of VIP tag themes and animations
//          on both Active Courts (dark emerald) and On Deck
//          (light cream) backgrounds before real implementation.
// No database queries — all data is hardcoded mock data.
// ============================================================

import { useState } from "react";

// ── VIP Config Map ────────────────────────────────────────────
const VIP_PLAYERS: Record<string, { tag: string; theme: VipTheme }> = {
  miggy:  { tag: "DEV",  theme: "cyber-neon"    },
  stelle: { tag: "8080", theme: "violet-spark"   },
  cogs:   { tag: "MVP",  theme: "gold-prestige"  },
  raf:    { tag: "BOSS", theme: "crimson-elite"  },
};

type VipTheme = "cyber-neon" | "violet-spark" | "gold-prestige" | "crimson-elite";

// ── Theme tokens ──────────────────────────────────────────────
//
// DARK MODE  → Neon typography: near-white text + heavy text-shadow bloom.
//              Container is almost invisible — the glowing letters ARE the tag.
//
// LIGHT MODE → Holographic shimmer: gradient bg-clip-text, no glow needed.
//              A highlight sweep animates across the letters like a foil card.
//
interface ThemeTokens {
  label: string;
  // Dark neon —  text-shadow values
  neonCore: string;   // tight inner glow (near-white text looks like it's lit)
  neonOuter: string;  // wide outer bloom
  neonBorder: string; // very subtle pill border so the tag has shape
  neonBg: string;     // 5–8% fill — just enough to catch the eye
  // Light holo — full CSS linear-gradient for background-clip trick
  holoGradient: string;
  // Subtle light pill border (thin, barely there)
  holoBorder: string;
}

const THEME_TOKENS: Record<VipTheme, ThemeTokens> = {
  "cyber-neon": {
    label: "Cyber Neon",
    neonCore:   "hsl(175 100% 72%)",
    neonOuter:  "hsl(185 100% 55%)",
    neonBorder: "hsl(175 100% 65% / 0.25)",
    neonBg:     "hsl(175 100% 50% / 0.07)",
    holoGradient:
      "linear-gradient(90deg, hsl(165,100%,30%) 0%, hsl(185,100%,50%) 25%, hsl(180,100%,82%) 50%, hsl(185,100%,50%) 75%, hsl(165,100%,30%) 100%)",
    holoBorder: "hsl(165 100% 35% / 0.3)",
  },
  "violet-spark": {
    label: "Violet Spark",
    neonCore:   "hsl(280 100% 82%)",
    neonOuter:  "hsl(270 100% 65%)",
    neonBorder: "hsl(280 100% 75% / 0.25)",
    neonBg:     "hsl(275 100% 60% / 0.07)",
    holoGradient:
      "linear-gradient(90deg, hsl(270,100%,38%) 0%, hsl(285,100%,58%) 25%, hsl(280,100%,84%) 50%, hsl(285,100%,58%) 75%, hsl(270,100%,38%) 100%)",
    holoBorder: "hsl(270 100% 45% / 0.3)",
  },
  "gold-prestige": {
    label: "Gold Prestige",
    neonCore:   "hsl(45 100% 72%)",
    neonOuter:  "hsl(38 100% 55%)",
    neonBorder: "hsl(45 100% 65% / 0.25)",
    neonBg:     "hsl(43 100% 55% / 0.07)",
    holoGradient:
      "linear-gradient(90deg, hsl(43,100%,30%) 0%, hsl(38,100%,50%) 25%, hsl(46,100%,78%) 50%, hsl(38,100%,50%) 75%, hsl(43,100%,30%) 100%)",
    holoBorder: "hsl(43 100% 38% / 0.3)",
  },
  "crimson-elite": {
    label: "Crimson Elite",
    neonCore:   "hsl(5 100% 72%)",
    neonOuter:  "hsl(0 100% 55%)",
    neonBorder: "hsl(5 100% 65% / 0.25)",
    neonBg:     "hsl(0 100% 55% / 0.07)",
    holoGradient:
      "linear-gradient(90deg, hsl(0,100%,35%) 0%, hsl(10,100%,52%) 25%, hsl(15,100%,78%) 50%, hsl(10,100%,52%) 75%, hsl(0,100%,35%) 100%)",
    holoBorder: "hsl(0 100% 42% / 0.3)",
  },
};

// ── VipTag ────────────────────────────────────────────────────

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

  if (dark) {
    // ── DARK: Neon typography ─────────────────────────────────
    // Near-white text surrounded by a heavy colored text-shadow bloom.
    // Container is minimal — the lit letters do all the work.
    return (
      <span
        className="inline-flex items-center justify-center rounded-sm px-[5px]"
        style={{
          background:  t.neonBg,
          border:      `1px solid ${t.neonBorder}`,
          height:      "20px",
          lineHeight:  "1",
        }}
      >
        <span
          className="font-black uppercase tracking-widest"
          style={{
            fontSize:   "10px",
            color:      "#fff",
            textShadow: [
              `0 0 6px  ${t.neonCore}`,
              `0 0 14px ${t.neonCore}`,
              `0 0 28px ${t.neonOuter}`,
              `0 0 50px ${t.neonOuter}`,
            ].join(", "),
            animation:      "vip-neon-pulse 2.4s ease-in-out infinite",
            display:        "inline-block",
            transform:      "translateY(0.5px)",
          }}
        >
          {tag}
        </span>
      </span>
    );
  }

  // ── LIGHT: Holographic shimmer ──────────────────────────────
  // Gradient bg-clip-text with a continuous shine sweep.
  // No background fill — the colored letters float on the cream card.
  return (
    <span
      className="inline-flex items-center justify-center rounded-sm px-[5px]"
      style={{
        border:     `1px solid ${t.holoBorder}`,
        background: "transparent",
        height:     "20px",
        lineHeight: "1",
      }}
    >
      <span
        className="font-black uppercase tracking-widest"
        style={{
          fontSize:              "10px",
          background:            t.holoGradient,
          backgroundSize:        "300% 100%",
          WebkitBackgroundClip:  "text",
          WebkitTextFillColor:   "transparent",
          backgroundClip:        "text",
          animation:             "vip-holo-shimmer 3s linear infinite",
          display:               "inline-block",
          transform:             "translateY(0.5px)",
        }}
      >
        {tag}
      </span>
    </span>
  );
}

// ── MockPill ──────────────────────────────────────────────────

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
    beginner:     dark ? "bg-emerald-900/40 text-emerald-300" : "bg-emerald-100 text-emerald-800",
    intermediate: dark ? "bg-blue-900/40 text-blue-300"       : "bg-blue-100 text-blue-800",
    advanced:     dark ? "bg-purple-900/40 text-purple-300"   : "bg-purple-100 text-purple-800",
  };

  return (
    <div
      className={[
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold",
        dark ? "bg-black/60 text-[hsl(80_100%_60%)]" : "bg-white/90 text-slate-900",
      ].join(" ")}
    >
      <span>{name}</span>

      {vip && (
        <>
          <span className={dark ? "text-white/25" : "text-slate-300"}>|</span>
          <VipTag tag={vip.tag} theme={vip.theme} dark={dark} />
        </>
      )}

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

// ── CourtCard ─────────────────────────────────────────────────

function CourtCard({ dark }: { dark: boolean }) {
  return (
    <div
      className={[
        "rounded-xl p-5 space-y-3",
        dark ? "bg-emerald-800" : "bg-[#FAFAF7] border border-slate-200",
      ].join(" ")}
    >
      <p className={[
        "text-[10px] font-semibold uppercase tracking-widest",
        dark ? "text-white/50" : "text-slate-400",
      ].join(" ")}>
        {dark ? "Active Courts (dark court)" : "On Deck (light card)"}
      </p>

      {Object.entries(VIP_PLAYERS).map(([name], i) => {
        const display = name.charAt(0).toUpperCase() + name.slice(1);
        const skill = (["beginner", "intermediate", "advanced", "beginner"] as const)[i % 4];
        return (
          <div key={name}>
            <MockPill name={display} skill={skill} dark={dark} />
          </div>
        );
      })}

      <div><MockPill name="Jordan" skill="beginner"  dark={dark} /></div>
      <div><MockPill name="Sam"    skill="advanced"  dark={dark} /></div>
    </div>
  );
}

// ── ThemeLegend ───────────────────────────────────────────────

function ThemeLegend() {
  const tagLabels: Record<VipTheme, string> = {
    "cyber-neon":    "DEV",
    "violet-spark":  "8080",
    "gold-prestige": "MVP",
    "crimson-elite": "BOSS",
  };

  return (
    <div className="flex flex-wrap gap-4">
      {(Object.entries(THEME_TOKENS) as [VipTheme, ThemeTokens][]).map(([key, t]) => (
        <div key={key} className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t.label}</p>
          <div className="flex items-center gap-2">
            <div className="rounded-md px-2 py-1 bg-emerald-800 inline-flex">
              <VipTag tag={tagLabels[key]} theme={key} dark={true} />
            </div>
            <div className="rounded-md px-2 py-1 bg-[#FAFAF7] border border-slate-200 inline-flex">
              <VipTag tag={tagLabels[key]} theme={key} dark={false} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── VipConfigTable ────────────────────────────────────────────

function VipConfigTable() {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {["Player", "Tag", "Theme", "Dark", "Light"].map((h) => (
              <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(VIP_PLAYERS).map(([name, meta], i) => (
            <tr key={name} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
              <td className="px-4 py-3 font-medium capitalize">{name}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{meta.tag}</td>
              <td className="px-4 py-3 text-muted-foreground">{THEME_TOKENS[meta.theme].label}</td>
              <td className="px-4 py-3">
                <div className="rounded px-2 py-1 bg-emerald-800 inline-flex">
                  <VipTag tag={meta.tag} theme={meta.theme} dark={true} />
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="rounded px-2 py-1 bg-[#FAFAF7] border border-slate-200 inline-flex">
                  <VipTag tag={meta.tag} theme={meta.theme} dark={false} />
                </div>
              </td>
            </tr>
          ))}
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
      <style>{`
        /* Dark mode: neon text-shadow pulse */
        @keyframes vip-neon-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.65; }
        }

        /* Light mode: holographic background-position sweep (foil card) */
        @keyframes vip-holo-shimmer {
          0%   { background-position: 150% center; }
          100% { background-position: -50% center; }
        }

        @media (prefers-reduced-motion: reduce) {
          [style*="vip-neon-pulse"],
          [style*="vip-holo-shimmer"] {
            animation: none !important;
          }
        }
      `}</style>

      <div className={darkMode ? "dark" : ""}>
        <div className="min-h-screen bg-background text-foreground">
          <div className="mx-auto max-w-3xl px-4 py-10 space-y-10">

            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Preview Sandbox · /vip-preview
                </p>
                <h1 className="text-2xl font-black tracking-tight mt-1">VIP Player Tags</h1>
                <p className="text-sm text-muted-foreground mt-1">Easter egg — not yet live in the app.</p>
              </div>
              <button
                onClick={() => setDarkMode((d) => !d)}
                className="rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                {darkMode ? "☀️ Light" : "🌙 Dark"}
              </button>
            </div>

            {/* Theme legend — each shown on both bg types */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Themes — Dark vs Light
              </h2>
              <ThemeLegend />
            </section>

            {/* Config table */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Config Map
              </h2>
              <VipConfigTable />
            </section>

            {/* In-context preview */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                In Context
              </h2>
              <p className="text-xs text-muted-foreground">
                VIP players alongside regular players — exactly how they'll appear in Active Courts and On Deck cards.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <CourtCard dark={true} />
                <CourtCard dark={false} />
              </div>
            </section>

            {/* Implementation plan */}
            <section className="rounded-xl border border-border bg-muted/30 p-5 space-y-2">
              <h2 className="text-sm font-semibold">Implementation Plan</h2>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li><strong>NEW</strong> <code className="text-xs">src/lib/vip-players.ts</code> — config map + <code className="text-xs">getVipMeta(name)</code> helper</li>
                <li><strong>APPEND</strong> <code className="text-xs">src/app/globals.css</code> — <code className="text-xs">@keyframes vip-neon-pulse</code> + <code className="text-xs">vip-holo-shimmer</code></li>
                <li><strong>EDIT</strong> <code className="text-xs">src/components/ui/badminton-court.tsx</code> — inject <code className="text-xs">&lt;VipTag&gt;</code> inside <code className="text-xs">PlayerPill</code></li>
              </ul>
              <p className="text-xs text-muted-foreground pt-1">Awaiting design approval before any of the above files are touched.</p>
            </section>

          </div>
        </div>
      </div>
    </>
  );
}
