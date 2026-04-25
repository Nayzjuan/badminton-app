"use client";

// ============================================================
// PlayerMatchAlertPreview — SANDBOX ONLY
// ============================================================
// Toggle "On Deck" ↔ "Active Court" with the pill at the top.
//
// ROOT CAUSE FIX (overflow):
//   The previous layout put name + VIP pill + skill badge all on
//   one line inside a ~130px grid cell — impossible to fit.
//   Fix: split into two lines per player row:
//     Line 1 → NAME ONLY  (full cell width, w-full truncate)
//     Line 2 → [YOU + VIP left]  [skill dot right]
//   Skill "pill" is replaced with an 8px coloured dot + abbrev
//   so line 2 never overflows regardless of name/VIP length.
//   The YOU row is ALWAYS rendered with an invisible spacer when
//   absent — every row is structurally identical height.
// ============================================================

import { useState } from "react";
import { VipTag } from "@/components/ui/vip-tag";

// ── Mock data — stress-tests all edge cases ───────────────────
// vipTheme uses real keys from VIP_THEMES in vip-config.ts
const MOCK = {
  myName:     "Miggy",
  mySkill:    "Intermediate",
  myVip:      "MVP",
  myVipTheme: "violet-spark",    // ← updated theme (purple neon)
  partner: {
    name:     "Christopher",
    skill:    "Upper Int.",
    vip:      null,
    vipTheme: null,
  },
  opponents: [
    {
      name:     "Stelle",        // ← replaced Jean-Baptiste
      skill:    "Advanced",
      vip:      "8080",          // ← new VIP tag
      vipTheme: "toxic-lime",    // lime neon — techy port-number vibe
    },
    {
      name:     "Ryan",
      skill:    "Intermediate",
      vip:      null,
      vipTheme: null,
    },
  ],
  court: "Court 2",
};

// ── Skill dot + abbreviation ──────────────────────────────────
// Replaces the wide skill pill — takes ~40px instead of ~70px,
// giving the name enough room on its own line.
const SKILL_MAP: Record<string, { color: string; darkColor: string; abbr: string }> = {
  "beginner":          { color: "bg-emerald-500", darkColor: "bg-emerald-400", abbr: "Beg"  },
  "lower_intermediate":{ color: "bg-sky-500",     darkColor: "bg-sky-400",     abbr: "LI"   },
  "intermediate":      { color: "bg-sky-500",     darkColor: "bg-sky-400",     abbr: "Int"  },
  "upper_intermediate":{ color: "bg-sky-600",     darkColor: "bg-sky-400",     abbr: "UI"   },
  "lower_advanced":    { color: "bg-purple-500",  darkColor: "bg-purple-400",  abbr: "LA"   },
  "advanced":          { color: "bg-purple-500",  darkColor: "bg-purple-400",  abbr: "Adv"  },
};

// Sandbox-safe lookup: match by label since mock uses display strings
function getSkillConfig(skill: string) {
  const key = skill.toLowerCase().replace(/[\s.]/g, "_").replace(/_+/g, "_");
  return (
    SKILL_MAP[key] ??
    SKILL_MAP[Object.keys(SKILL_MAP).find(k => skill.toLowerCase().includes(k.split("_")[0])) ?? ""] ??
    { color: "bg-slate-400", darkColor: "bg-slate-500", abbr: skill.slice(0, 3) }
  );
}

function SkillIndicator({ skill, dark }: { skill: string; dark?: boolean }) {
  const cfg = getSkillConfig(skill);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className={`h-2 w-2 rounded-full ${dark ? cfg.darkColor : cfg.color}`} />
      <span className={`text-[9px] font-bold uppercase tracking-wide leading-none
        ${dark ? "text-slate-500" : "text-slate-400"}`}>
        {cfg.abbr}
      </span>
    </div>
  );
}

// VipTag is imported above — no inline pill needed.
// neonOnly={dark} forces the neon glow variant on the dark navy
// active-court card (which doesn't use the .dark CSS class).
// On the light on-deck card (neonOnly=false) VipTag renders its
// holographic shimmer variant automatically.

// ── Player Row ────────────────────────────────────────────────
// Two-line layout — solves the overflow problem completely:
//
//   Line 1: ┌──────────────────────────────┐
//            │ NAME (truncates at cell edge) │
//            └──────────────────────────────┘
//
//   Line 2: ┌──────────────────┐ ┌─────────┐
//            │ YOU label  [VIP]│ │ ● Abbr  │
//            └──────────────────┘ └─────────┘
//
// Line 1 has the full cell width to itself — "Jean-Baptiste"
// always renders fully, only truncates at 20+ chars.
// Line 2 carries tags + skill indicator — both tiny, never clash.
// The YOU row is always in the DOM (invisible pad when absent)
// so every row is exactly the same height regardless of content.
function PlayerRow({
  name,
  skill,
  isMe = false,
  dark = false,
  vipTag = null,
  vipTheme = null,
}: {
  name: string;
  skill: string;
  isMe?: boolean;
  dark?: boolean;
  vipTag?: string | null;
  vipTheme?: string | null;
}) {
  return (
    <div
      className={`w-full overflow-hidden rounded-xl px-3 py-2.5 transition-all
        ${isMe && !dark ? "bg-amber-100 ring-1 ring-amber-300" : ""}
        ${isMe && dark  ? "bg-emerald-950/50 ring-1 ring-emerald-500/30" : ""}
        ${!isMe && !dark ? "bg-slate-100/70" : ""}
        ${!isMe && dark  ? "bg-white/[0.04]" : ""}
      `}
    >
      {/* Line 1 — name only, never competes with anything */}
      <p
        className={`w-full truncate text-[14px] font-bold leading-snug
          ${isMe && !dark ? "text-amber-900" : ""}
          ${isMe && dark  ? "text-emerald-200" : ""}
          ${!isMe && !dark ? "text-slate-800" : ""}
          ${!isMe && dark  ? "text-slate-300"  : ""}
        `}
      >
        {name}
      </p>

      {/* Line 2 — YOU + VIP on the left, skill on the right */}
      {/* Always rendered; invisible spacer keeps row height uniform */}
      <div className="mt-0.5 flex items-center justify-between gap-1">
        {/* Left: YOU label + optional VIP pill */}
        <div className="flex items-center gap-1">
          {isMe ? (
            <span
              className={`text-[9px] font-black uppercase tracking-widest leading-none
                ${dark ? "text-emerald-400" : "text-amber-600"}`}
            >
              You
            </span>
          ) : (
            /* Invisible spacer — matches the height of the YOU label */
            <span className="invisible text-[9px] leading-none" aria-hidden="true">
              You
            </span>
          )}
          {vipTag && vipTheme && (
            <VipTag tag={vipTag} theme={vipTheme} neonOnly={dark} />
          )}
        </div>

        {/* Right: skill dot + abbreviation */}
        <SkillIndicator skill={skill} dark={dark} />
      </div>
    </div>
  );
}

// ── VS badge ──────────────────────────────────────────────────
function VsBadge({ dark }: { dark?: boolean }) {
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                  text-[11px] font-black
        ${dark
          ? "border border-white/10 bg-white/[0.06] text-white/40"
          : "bg-slate-900 text-white shadow-sm"
        }`}
    >
      VS
    </div>
  );
}

// ── Teams Grid ────────────────────────────────────────────────
// 3-column CSS grid, all items explicitly placed so nothing
// auto-flows into the wrong cell:
//
//   col 1 (1fr)      | col 2 (36px) | col 3 (1fr)
//   ──────────────────────────────────────────────
//   row 1  Your Team |              | Opponents
//   row 2  Me row    |    [VS]      | Opp 1 row
//   row 3  Partner   |    (span)    | Opp 2 row
//
// VS badge: col-start-2 row-start-2 row-span-2 → always centred
// between the two player rows.
function TeamsGrid({ dark }: { dark?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_36px_1fr] gap-x-2 gap-y-2">
      {/* ── Row 1: column labels ───────────────────────────── */}
      <p
        className={`col-start-1 row-start-1
                    text-center text-[9px] font-black uppercase tracking-widest
                    ${dark ? "text-emerald-400" : "text-emerald-600"}`}
      >
        Your Team
      </p>
      <div className="col-start-2 row-start-1" aria-hidden="true" />
      <p
        className={`col-start-3 row-start-1
                    text-center text-[9px] font-black uppercase tracking-widest
                    ${dark ? "text-rose-400" : "text-rose-500"}`}
      >
        Opponents
      </p>

      {/* ── VS badge: spans rows 2–3, always centred ────────── */}
      <div
        className="col-start-2 row-start-2 row-span-2
                   flex items-center justify-center"
      >
        <VsBadge dark={dark} />
      </div>

      {/* ── Row 2: first player pair ──────────────────────── */}
      <div className="col-start-1 row-start-2">
        <PlayerRow
          name={MOCK.myName}
          skill={MOCK.mySkill}
          isMe
          dark={dark}
          vipTag={MOCK.myVip}
          vipTheme={MOCK.myVipTheme}
        />
      </div>
      <div className="col-start-3 row-start-2">
        <PlayerRow
          name={MOCK.opponents[0].name}
          skill={MOCK.opponents[0].skill}
          dark={dark}
          vipTag={MOCK.opponents[0].vip}
          vipTheme={MOCK.opponents[0].vipTheme}
        />
      </div>

      {/* ── Row 3: second player pair ─────────────────────── */}
      <div className="col-start-1 row-start-3">
        <PlayerRow
          name={MOCK.partner.name}
          skill={MOCK.partner.skill}
          dark={dark}
          vipTag={MOCK.partner.vip}
          vipTheme={MOCK.partner.vipTheme}
        />
      </div>
      <div className="col-start-3 row-start-3">
        <PlayerRow
          name={MOCK.opponents[1].name}
          skill={MOCK.opponents[1].skill}
          dark={dark}
          vipTag={MOCK.opponents[1].vip}
          vipTheme={MOCK.opponents[1].vipTheme}
        />
      </div>
    </div>
  );
}

// ── On Deck Card (Light mode) ─────────────────────────────────
function OnDeckCard() {
  return (
    <div
      className="overflow-hidden rounded-3xl border border-amber-200 shadow-2xl
                 animate-in fade-in slide-in-from-bottom-6 duration-500"
    >
      <div className="bg-amber-50 px-6 pb-6 pt-7 text-center">
        <div className="mb-3 flex justify-center">
          <span className="relative flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-amber-500" />
          </span>
        </div>
        <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-amber-600">
          You&apos;re On Deck
        </p>
        <h2 className="text-4xl font-black leading-none text-slate-900">
          Next Available<br />Court
        </h2>
        <p className="mt-3 text-sm font-medium text-slate-500">
          Find your team — a court is opening soon 🏸
        </p>
      </div>

      <div className="bg-white px-4 pb-6 pt-5">
        <TeamsGrid />
        <p className="mt-5 text-center text-[10px] font-medium text-slate-400">
          You&apos;ll be directed to a court as soon as one opens up
        </p>
      </div>
    </div>
  );
}

// ── Active Court Card (Dark mode) ─────────────────────────────
function ActiveCourtCard() {
  return (
    <div
      className="overflow-hidden rounded-3xl
                 border border-emerald-900/50
                 shadow-[0_8px_64px_rgba(16,185,129,0.18)]
                 animate-in fade-in slide-in-from-bottom-8 duration-500"
    >
      {/* Court number hero */}
      <div className="relative overflow-hidden bg-[#0E1C3A] px-6 pb-7 pt-8 text-center">
        {/* Ambient pulsing rings — pointer-events-none, decorative */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-64 w-64 animate-ping rounded-full border border-emerald-500/10 [animation-duration:3s]" />
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-44 w-44 animate-ping rounded-full border border-emerald-500/10 [animation-duration:3s] [animation-delay:0.8s]" />
        </div>

        <div className="relative mb-4 flex justify-center">
          <span className="relative flex h-4 w-4">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-500" />
          </span>
        </div>

        <p className="relative mb-2 text-[10px] font-black uppercase tracking-[0.28em] text-emerald-400">
          It&apos;s Your Turn
        </p>

        {/* THE focal point — 72px, readable from arm's length */}
        <h2
          className="relative text-[72px] font-black leading-none tracking-tight text-white
                     drop-shadow-[0_2px_24px_rgba(16,185,129,0.3)]"
        >
          {MOCK.court}
        </h2>

        <p className="relative mt-4 text-sm font-semibold text-emerald-300">
          Your match is starting now 🏸
        </p>
      </div>

      {/* Teams */}
      <div className="border-t border-white/[0.06] bg-[#0A1628] px-4 pb-5 pt-5">
        <TeamsGrid dark />

        {/* CTA — solid amber, zero gradient */}
        <button
          className="mt-5 w-full rounded-2xl bg-[#F59E0B] py-4 text-[15px] font-black
                     text-slate-900 shadow-[0_4px_20px_rgba(245,158,11,0.25)]
                     transition-all duration-150 hover:bg-amber-400 active:scale-[0.98]"
        >
          I&apos;m Heading There →
        </button>
      </div>
    </div>
  );
}

// ── Preview Shell ─────────────────────────────────────────────
export function PlayerMatchAlertPreview() {
  const [state, setState] = useState<"on_deck" | "in_progress">("on_deck");
  const [animKey, setAnimKey] = useState(0);

  function switchState(next: typeof state) {
    if (next === state) return;
    setAnimKey((k) => k + 1);
    setState(next);
  }

  const isActive = state === "in_progress";

  return (
    <div
      className={`min-h-screen transition-colors duration-500
                  ${isActive ? "bg-[#060E1D]" : "bg-slate-200"}`}
    >
      <div className="mx-auto max-w-sm px-4 py-6">
        {/* State toggle */}
        <div
          className={`mx-auto mb-6 flex w-fit items-center rounded-full p-1
                      ${isActive ? "bg-white/10" : "bg-white shadow-sm"}`}
        >
          <button
            onClick={() => switchState("on_deck")}
            className={`rounded-full px-5 py-2 text-xs font-bold transition-all duration-200
              ${!isActive
                ? "bg-amber-500 text-white shadow-sm"
                : "text-slate-400 hover:text-white/70"
              }`}
          >
            On Deck
          </button>
          <button
            onClick={() => switchState("in_progress")}
            className={`rounded-full px-5 py-2 text-xs font-bold transition-all duration-200
              ${isActive
                ? "bg-emerald-500 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700"
              }`}
          >
            Active Court
          </button>
        </div>

        {/* Card — key forces remount so entrance animation re-fires */}
        <div key={animKey}>
          {isActive ? <ActiveCourtCard /> : <OnDeckCard />}
        </div>
      </div>
    </div>
  );
}
