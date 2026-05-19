"use client";

// ============================================================
// VIP Player Tags — Design Preview Sandbox
// ============================================================
// Route: /vip-preview
// No database queries. Safe to delete after implementation.
// Now imports VipTag + VIP_THEMES from shared lib.
// ============================================================

import { useState } from "react";
import { VipTag } from "@/components/ui/vip-tag";
import { VIP_THEMES } from "@/lib/vip-config";
import type { VipTheme } from "@/lib/vip-config";
import type { SkillLevel } from "@/types/database";

// ── Preview config ────────────────────────────────────────────
// Edit this map to change which tag/theme each player uses in the preview.
const PREVIEW_PLAYERS: Record<string, { tag: string; theme: VipTheme }> = {
  miggy: { tag: "DEV", theme: "cyber-neon" },
  stelle: { tag: "8080", theme: "violet-spark" },
  cogs: { tag: "MVP", theme: "gold-prestige" },
  raf: { tag: "BOSS", theme: "crimson-elite" },
  jun: { tag: "LEGEND", theme: "emerald-legend" },
  nino: { tag: "FLARE", theme: "solar-flare" },
  lou: { tag: "ICE", theme: "arctic-ice" },
  mika: { tag: "TITAN", theme: "rose-titan" },
  jan: { tag: "TOXIC", theme: "toxic-lime" },
  gab: { tag: "GHOST", theme: "silver-phantom" },
};

// ── MockPill ──────────────────────────────────────────────────

function MockPill({ name, skill = "intermediate" }: { name: string; skill?: string }) {
  const vip = PREVIEW_PLAYERS[name.toLowerCase()];

  const skillColors: Record<string, string> = {
    beginner: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    intermediate: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    advanced: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  };

  return (
    <div className="inline-flex flex-col items-center gap-1">
      <div
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold
                      bg-white/90 text-slate-900 dark:bg-black/60 dark:text-[hsl(80_100%_60%)]"
      >
        <span>{name}</span>
        {vip && (
          <>
            <span className="text-slate-300 dark:text-white/20">|</span>
            <VipTag tag={vip.tag} theme={vip.theme} />
          </>
        )}
      </div>
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

const COURT_ROWS: Array<{ name: string; skill: SkillLevel }> = [
  { name: "Miggy", skill: "advanced" },
  { name: "Stelle", skill: "intermediate" },
  { name: "Cogs", skill: "beginner" },
  { name: "Raf", skill: "advanced" },
  { name: "Jun", skill: "lower_intermediate" },
  { name: "Nino", skill: "upper_intermediate" },
];

function CourtCard({ dark }: { dark: boolean }) {
  return (
    <div
      className={[
        "rounded-xl p-5 space-y-2.5",
        dark ? "bg-emerald-800" : "bg-[#FAFAF7] border border-slate-200",
      ].join(" ")}
    >
      <p
        className={[
          "text-[10px] font-semibold uppercase tracking-widest mb-3",
          dark ? "text-white/50" : "text-slate-400",
        ].join(" ")}
      >
        {dark ? "Active Courts — dark" : "On Deck — light"}
      </p>
      <div className="flex flex-wrap gap-3">
        {COURT_ROWS.map((r) => (
          <MockPill key={r.name} name={r.name} skill={r.skill} />
        ))}
      </div>
    </div>
  );
}

// ── InlinePill — "Username | VipTag" side-by-side layout ──────

function InlinePill({ name, skill = "intermediate" }: { name: string; skill?: string }) {
  const vip = PREVIEW_PLAYERS[name.toLowerCase()];

  const skillColors: Record<string, string> = {
    beginner: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    intermediate: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    advanced: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  };

  return (
    <div className="inline-flex flex-col items-center gap-1">
      {/* Name pill with VIP tag inline */}
      <div
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-2
                      text-sm font-bold shadow-md
                      bg-white text-slate-900 shadow-black/15
                      dark:bg-black/60 dark:text-[hsl(80_100%_60%)]
                      dark:ring-1 dark:ring-[hsl(80_100%_60%)]/30"
      >
        <span>{name}</span>
        {vip && (
          <>
            <span className="text-slate-300 dark:text-white/20 font-normal">|</span>
            <VipTag tag={vip.tag} theme={vip.theme} neonOnly />
          </>
        )}
      </div>
      {/* Skill badge below */}
      <span
        className={[
          "rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
          skillColors[skill] ?? skillColors.intermediate,
        ].join(" ")}
      >
        {skill}
      </span>
    </div>
  );
}

function InlineCourtCard({ dark }: { dark: boolean }) {
  return (
    <div
      className={[
        "rounded-xl p-5 space-y-2.5",
        dark ? "bg-emerald-800" : "bg-[#FAFAF7] border border-slate-200",
      ].join(" ")}
    >
      <p
        className={[
          "text-[10px] font-semibold uppercase tracking-widest mb-3",
          dark ? "text-white/50" : "text-slate-400",
        ].join(" ")}
      >
        {dark ? "Inline style — dark" : "Inline style — light"}
      </p>
      <div className="flex flex-wrap gap-3">
        {COURT_ROWS.map((r) => (
          <InlinePill key={r.name} name={r.name} skill={r.skill} />
        ))}
      </div>
    </div>
  );
}

// ── ThemeLegend ───────────────────────────────────────────────

function ThemeLegend() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {(Object.entries(VIP_THEMES) as [VipTheme, (typeof VIP_THEMES)[VipTheme]][]).map(
        ([key, t]) => {
          const previewPlayer = Object.values(PREVIEW_PLAYERS).find((p) => p.theme === key);
          const tag = previewPlayer?.tag ?? key.toUpperCase().slice(0, 4);

          return (
            <div key={key} className="space-y-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                {t.label}
              </p>
              {/* Dark swatch */}
              <div className="rounded-lg bg-emerald-800 px-3 py-2 inline-flex items-center gap-1.5">
                <span className="text-[10px] text-white/40">🌙</span>
                <VipTag tag={tag} theme={key} />
              </div>
              {/* Light swatch */}
              <div className="rounded-lg bg-[#FAFAF7] border border-slate-200 px-3 py-2 inline-flex items-center gap-1.5">
                <span className="text-[10px] text-slate-300">☀️</span>
                <VipTag tag={tag} theme={key} />
              </div>
            </div>
          );
        }
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────

export default function VipPreviewPage() {
  const [darkMode, setDarkMode] = useState(false);

  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-4xl px-4 py-10 space-y-10">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Preview Sandbox · /vip-preview
              </p>
              <h1 className="text-2xl font-black tracking-tight mt-1">VIP Player Tags</h1>
              <p className="text-sm text-muted-foreground mt-1">
                10 presets · Dark = neon text-shadow · Light = holographic foil
              </p>
            </div>
            <button
              onClick={() => setDarkMode((d) => !d)}
              className="rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              {darkMode ? "☀️ Light" : "🌙 Dark"}
            </button>
          </div>

          {/* Theme legend — all 10 presets */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              All 10 Presets
            </h2>
            <ThemeLegend />
          </section>

          {/* In-context — current stacked layout */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Current — Stacked (name above tag)
            </h2>
            <p className="text-xs text-muted-foreground">
              VIP tag sits below the name pill. Skill badge below that.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <CourtCard dark={true} />
              <CourtCard dark={false} />
            </div>
          </section>

          {/* Inline layout preview */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Proposed — Inline (Username | Tag)
            </h2>
            <p className="text-xs text-muted-foreground">
              VIP tag sits inside the name pill, separated by a pipe. Skill badge below.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InlineCourtCard dark={true} />
              <InlineCourtCard dark={false} />
            </div>
          </section>

          {/* How to assign */}
          <section className="rounded-xl border border-border bg-muted/30 p-5 space-y-3">
            <h2 className="text-sm font-semibold">How to Assign a Tag</h2>
            <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
              <li>
                Open <strong>Supabase Dashboard → Table Editor → profiles</strong>
              </li>
              <li>
                Find the player by <code className="text-xs">display_name</code>
              </li>
              <li>
                Set <code className="text-xs">vip_tag</code> = label (e.g.{" "}
                <code className="text-xs">&quot;DEV&quot;</code>) and{" "}
                <code className="text-xs">vip_theme</code> = preset key (e.g.{" "}
                <code className="text-xs">&quot;cyber-neon&quot;</code>)
              </li>
              <li>
                To remove: set both columns to <code className="text-xs">NULL</code>
              </li>
            </ol>
            <div className="pt-1 space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Available theme keys
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.keys(VIP_THEMES).map((key) => (
                  <code key={key} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    {key}
                  </code>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
