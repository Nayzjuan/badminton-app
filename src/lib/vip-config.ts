// ============================================================
// VIP Player Tag Config — Single source of truth
// ============================================================
// All 10 preset themes live here.
// To add a new preset: append one entry to VIP_THEMES.
// No database migration needed — the DB stores the theme key
// string; visuals are entirely code-side.
// ============================================================

export type VipTheme =
  | "cyber-neon"
  | "gold-prestige"
  | "crimson-elite"
  | "violet-spark"
  | "emerald-legend"
  | "solar-flare"
  | "arctic-ice"
  | "rose-titan"
  | "toxic-lime"
  | "silver-phantom";

export type VipThemeConfig = {
  label: string;
  /** Dark mode: Tailwind text-color class + layered text-shadow arbitrary classes. */
  neonClass: string;
  /** Light mode: Tailwind gradient-from / via / to classes for bg-clip-text shimmer. */
  holoFrom: string;
  holoVia: string;
  holoTo: string;
};

export const VIP_THEMES: Record<VipTheme, VipThemeConfig> = {
  "cyber-neon": {
    label: "Cyber Neon",
    neonClass: "text-cyan-300 [text-shadow:0_0_8px_#67e8f9,0_0_16px_#22d3ee,0_0_32px_#06b6d4]",
    holoFrom: "from-cyan-600",
    holoVia: "via-sky-500",
    holoTo: "to-cyan-600",
  },
  "gold-prestige": {
    label: "Gold Prestige",
    neonClass: "text-amber-300 [text-shadow:0_0_8px_#fde68a,0_0_16px_#fbbf24,0_0_32px_#f59e0b]",
    holoFrom: "from-amber-600",
    holoVia: "via-yellow-500",
    holoTo: "to-amber-600",
  },
  "crimson-elite": {
    label: "Crimson Elite",
    neonClass: "text-red-300 [text-shadow:0_0_8px_#fca5a5,0_0_16px_#f87171,0_0_32px_#ef4444]",
    holoFrom: "from-red-600",
    holoVia: "via-orange-500",
    holoTo: "to-red-600",
  },
  "violet-spark": {
    label: "Violet Spark",
    neonClass: "text-purple-300 [text-shadow:0_0_8px_#d8b4fe,0_0_16px_#a855f7,0_0_32px_#9333ea]",
    holoFrom: "from-purple-600",
    holoVia: "via-fuchsia-500",
    holoTo: "to-purple-600",
  },
  "emerald-legend": {
    label: "Emerald Legend",
    neonClass: "text-emerald-300 [text-shadow:0_0_8px_#6ee7b7,0_0_16px_#34d399,0_0_32px_#10b981]",
    holoFrom: "from-emerald-600",
    holoVia: "via-green-500",
    holoTo: "to-emerald-600",
  },
  "solar-flare": {
    label: "Solar Flare",
    neonClass: "text-orange-300 [text-shadow:0_0_8px_#fdba74,0_0_16px_#fb923c,0_0_32px_#f97316]",
    holoFrom: "from-orange-500",
    holoVia: "via-amber-500",
    holoTo: "to-orange-500",
  },
  "arctic-ice": {
    label: "Arctic Ice",
    neonClass: "text-sky-200 [text-shadow:0_0_8px_#bae6fd,0_0_16px_#7dd3fc,0_0_32px_#38bdf8]",
    holoFrom: "from-sky-500",
    holoVia: "via-cyan-400",
    holoTo: "to-sky-500",
  },
  "rose-titan": {
    label: "Rose Titan",
    neonClass: "text-rose-300 [text-shadow:0_0_8px_#fda4af,0_0_16px_#fb7185,0_0_32px_#f43f5e]",
    holoFrom: "from-rose-500",
    holoVia: "via-pink-500",
    holoTo: "to-rose-500",
  },
  "toxic-lime": {
    label: "Toxic Lime",
    neonClass: "text-lime-300 [text-shadow:0_0_8px_#bef264,0_0_16px_#a3e635,0_0_32px_#84cc16]",
    holoFrom: "from-lime-500",
    holoVia: "via-green-500",
    holoTo: "to-lime-500",
  },
  "silver-phantom": {
    label: "Silver Phantom",
    neonClass: "text-slate-200 [text-shadow:0_0_8px_#e2e8f0,0_0_16px_#cbd5e1,0_0_32px_#94a3b8]",
    holoFrom: "from-slate-500",
    holoVia: "via-slate-400",
    holoTo: "to-slate-500",
  },
};

/** Returns the theme config for a key, or null if invalid/missing. */
export function getVipThemeConfig(theme: string | null | undefined): VipThemeConfig | null {
  if (!theme || !isVipTheme(theme)) return null;
  return VIP_THEMES[theme];
}

/** Type guard: is this string a valid VipTheme key? */
export function isVipTheme(theme: string | null | undefined): theme is VipTheme {
  if (!theme) return false;
  return theme in VIP_THEMES;
}
