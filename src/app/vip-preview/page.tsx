"use client";

// ============================================================
// VIP Player Tags — Design Preview Sandbox
// ============================================================
// Route: /vip-preview
// No database queries. Safe to delete after implementation.
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
// Dark  → pure Tailwind arbitrary text-shadow on bright/white text
// Light → bg-clip-text gradient with background-position shimmer
const THEMES: Record<
  VipTheme,
  {
    label: string;
    // Dark: solid text color + layered text-shadow class string
    neonClass: string;
    // Light: gradient classes for bg-clip-text
    holoFrom:  string;
    holoVia:   string;
    holoTo:    string;
  }
> = {
  "cyber-neon": {
    label:     "Cyber Neon",
    neonClass: "text-cyan-300 [text-shadow:0_0_8px_#67e8f9,0_0_16px_#22d3ee,0_0_32px_#06b6d4]",
    holoFrom:  "from-cyan-600",
    holoVia:   "via-sky-300",
    holoTo:    "to-cyan-600",
  },
  "violet-spark": {
    label:     "Violet Spark",
    neonClass: "text-purple-300 [text-shadow:0_0_8px_#d8b4fe,0_0_16px_#a855f7,0_0_32px_#9333ea]",
    holoFrom:  "from-purple-600",
    holoVia:   "via-fuchsia-300",
    holoTo:    "to-purple-600",
  },
  "gold-prestige": {
    label:     "Gold Prestige",
    neonClass: "text-amber-300 [text-shadow:0_0_8px_#fde68a,0_0_16px_#fbbf24,0_0_32px_#f59e0b]",
    holoFrom:  "from-amber-600",
    holoVia:   "via-yellow-300",
    holoTo:    "to-amber-600",
  },
  "crimson-elite": {
    label:     "Crimson Elite",
    neonClass: "text-red-300 [text-shadow:0_0_8px_#fca5a5,0_0_16px_#f87171,0_0_32px_#ef4444]",
    holoFrom:  "from-red-600",
    holoVia:   "via-orange-300",
    holoTo:    "to-red-600",
  },
};

// ── VipTag ────────────────────────────────────────────────────
// No container. No background. No border. Just floating light.

function VipTag({ tag, theme, dark }: { tag: string; theme: VipTheme; dark: boolean }) {
  const t = THEMES[theme];

  if (dark) {
    // Pure neon: bright text colour + layered text-shadow bloom, pulsing
    return (
      <span
        className={[
          "font-black tracking-widest uppercase",
          "text-[11px] leading-none",
          t.neonClass,
          "animate-pulse",
        ].join(" ")}
      >
        {tag}
      </span>
    );
  }

  // Holographic foil: gradient bg-clip-text + background-position shimmer sweep
  return (
    <span
      className={[
        "bg-gradient-to-r",
        t.holoFrom, t.holoVia, t.holoTo,
        "bg-clip-text text-transparent",
        "font-black tracking-widest uppercase",
        "text-[11px] leading-none",
      ].join(" ")}
      style={{
        backgroundSize:  "200% auto",
        animation:       "vip-holo-shimmer 2.5s linear infinite",
        display:         "inline-block",
      }}
    >
      {tag}
    </span>
  );
}

// ── MockPill ──────────────────────────────────────────────────

function MockPill({ name, skill = "intermediate", dark = false }: {
  name:   string;
  skill?: string;
  dark?:  boolean;
}) {
  const vip = VIP_PLAYERS[name.toLowerCase()];

  const skillColors: Record<string, string> = {
    beginner:     dark ? "bg-emerald-900/40 text-emerald-300" : "bg-emerald-100 text-emerald-800",
    intermediate: dark ? "bg-blue-900/40 text-blue-300"       : "bg-blue-100 text-blue-800",
    advanced:     dark ? "bg-purple-900/40 text-purple-300"   : "bg-purple-100 text-purple-800",
  };

  return (
    <div className={[
      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold",
      dark ? "bg-black/60 text-[hsl(80_100%_60%)]" : "bg-white/90 text-slate-900",
    ].join(" ")}>

      <span>{name}</span>

      {vip && (
        <>
          <span className={dark ? "text-white/20" : "text-slate-300"}>|</span>
          <VipTag tag={vip.tag} theme={vip.theme} dark={dark} />
        </>
      )}

      <span className={[
        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        skillColors[skill] ?? skillColors.intermediate,
      ].join(" ")}>
        {skill}
      </span>
    </div>
  );
}

// ── CourtCard ─────────────────────────────────────────────────

function CourtCard({ dark }: { dark: boolean }) {
  const rows: Array<{ name: string; skill: string }> = [
    { name: "Miggy",  skill: "advanced"     },
    { name: "Stelle", skill: "intermediate" },
    { name: "Cogs",   skill: "beginner"     },
    { name: "Raf",    skill: "advanced"     },
    { name: "Jordan", skill: "beginner"     },
    { name: "Sam",    skill: "intermediate" },
  ];

  return (
    <div className={[
      "rounded-xl p-5 space-y-2.5",
      dark ? "bg-emerald-800" : "bg-[#FAFAF7] border border-slate-200",
    ].join(" ")}>
      <p className={[
        "text-[10px] font-semibold uppercase tracking-widest mb-3",
        dark ? "text-white/50" : "text-slate-400",
      ].join(" ")}>
        {dark ? "Active Courts — dark court" : "On Deck — light card"}
      </p>
      {rows.map((r) => (
        <div key={r.name}>
          <MockPill name={r.name} skill={r.skill} dark={dark} />
        </div>
      ))}
    </div>
  );
}

// ── ThemeLegend ───────────────────────────────────────────────

function ThemeLegend() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {(Object.entries(THEMES) as [VipTheme, (typeof THEMES)[VipTheme]][]).map(([key, t]) => {
        const tag = VIP_PLAYERS[
          Object.keys(VIP_PLAYERS).find((n) => VIP_PLAYERS[n].theme === key) ?? ""
        ]?.tag ?? key.toUpperCase().slice(0, 4);

        return (
          <div key={key} className="space-y-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t.label}</p>
            {/* Dark swatch */}
            <div className="rounded-lg bg-emerald-800 px-3 py-2 inline-flex items-center gap-1">
              <span className="text-[10px] text-white/40 mr-1">🌙</span>
              <VipTag tag={tag} theme={key} dark={true} />
            </div>
            {/* Light swatch */}
            <div className="rounded-lg bg-[#FAFAF7] border border-slate-200 px-3 py-2 inline-flex items-center gap-1">
              <span className="text-[10px] text-slate-300 mr-1">☀️</span>
              <VipTag tag={tag} theme={key} dark={false} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────

export default function VipPreviewPage() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <>
      <style>{`
        @keyframes vip-holo-shimmer {
          0%   { background-position: 200% center; }
          100% { background-position: -200% center; }
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-pulse { animation: none !important; }
          [style*="vip-holo-shimmer"] { animation: none !important; }
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
                <p className="text-sm text-muted-foreground mt-1">
                  Dark = neon text-shadow · Light = holographic foil
                </p>
              </div>
              <button
                onClick={() => setDarkMode((d) => !d)}
                className="rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                {darkMode ? "☀️ Light" : "🌙 Dark"}
              </button>
            </div>

            {/* Theme legend — each theme on both backgrounds */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Themes
              </h2>
              <ThemeLegend />
            </section>

            {/* In-context — side by side */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                In Context
              </h2>
              <p className="text-xs text-muted-foreground">
                VIP players alongside regular players exactly as they'll appear on court.
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
                <li><strong>NEW</strong> <code className="text-xs">src/lib/vip-players.ts</code> — config map + <code className="text-xs">getVipMeta()</code></li>
                <li><strong>APPEND</strong> <code className="text-xs">src/app/globals.css</code> — <code className="text-xs">@keyframes vip-holo-shimmer</code></li>
                <li><strong>EDIT</strong> <code className="text-xs">src/components/ui/badminton-court.tsx</code> — inject <code className="text-xs">&lt;VipTag&gt;</code> in <code className="text-xs">PlayerPill</code></li>
              </ul>
              <p className="text-xs text-muted-foreground pt-1">Awaiting design approval before touching implementation files.</p>
            </section>

          </div>
        </div>
      </div>
    </>
  );
}
