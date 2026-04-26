"use client";

// ============================================================
// MatchAlert — Full-screen takeover card when player is called
// ============================================================
// Replaces the entire queue UI when a player has an active match.
//
// Two states:
//   "pending"     → amber "On Deck" card — no court yet
//   "in_progress" → dark-navy "Head to Court!" card with MASSIVE
//                   court number as the absolute focal point
//
// Player identity:
//   No avatar circles — players are identified by name alone
//   (sports-roster convention). Two-line PlayerRow:
//     Line 1 → NAME (full width, truncates at 20 chars)
//     Line 2 → [YOU label + VIP glow tag] [● skill dot]
//
// Symmetry:
//   CSS grid with explicit col/row placement. VS badge spans
//   both player rows (row-span-2). Invisible YOU spacer on all
//   non-me rows ensures every row is the same height.
//
// VIP tags:
//   Uses the real VipTag component (neon glow in dark mode,
//   holographic shimmer in light mode). Pass myVipTag +
//   myVipTheme from the player's Profile to the component.
// ============================================================

import { VipTag } from "@/components/ui/vip-tag";
import type { Court, Profile, SkillLevel } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────

interface MatchAlertProps {
  matchStatus: "pending" | "in_progress";
  court: Court | null;
  myDisplayName: string;
  mySkillLevel: SkillLevel;
  myVipTag?: string | null;
  myVipTheme?: string | null;
  teammates: Profile[];
  opponents: Profile[];
  isMixedLevel?: boolean;
  /** 1-based position among pending on-deck matches (1 = next court). null when in_progress. */
  onDeckPosition?: number | null;
  /** Total pending on-deck matches right now. */
  totalOnDeck?: number;
}

// ── Skill Indicator ───────────────────────────────────────────
// 8px coloured dot + 3-char abbreviation.
// Replaces the wide SkillBadge pill (saves ~60px per row, giving
// the name full width on its own line without competing elements).

const SKILL_CONFIG: Record<SkillLevel, { dot: string; abbr: string }> = {
  beginner:           { dot: "bg-emerald-500 dark:bg-emerald-400", abbr: "Beg" },
  lower_intermediate: { dot: "bg-sky-500     dark:bg-sky-400",     abbr: "LI"  },
  intermediate:       { dot: "bg-sky-500     dark:bg-sky-400",     abbr: "Int" },
  upper_intermediate: { dot: "bg-sky-600     dark:bg-sky-400",     abbr: "UI"  },
  lower_advanced:     { dot: "bg-purple-500  dark:bg-purple-400",  abbr: "LA"  },
  advanced:           { dot: "bg-purple-500  dark:bg-purple-400",  abbr: "Adv" },
};

function SkillIndicator({ level }: { level: SkillLevel }) {
  const cfg = SKILL_CONFIG[level] ?? { dot: "bg-slate-400", abbr: "?" };
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className={`h-2 w-2 rounded-full ${cfg.dot}`} />
      <span className="text-[10px] font-bold uppercase tracking-wide leading-none
                       text-slate-500 dark:text-slate-400">
        {cfg.abbr}
      </span>
    </div>
  );
}

// ── Player Row ────────────────────────────────────────────────
// accentColor drives the "me" row highlight:
//   "amber"   → on-deck state (warm amber tint)
//   "emerald" → in-progress state (cool emerald tint)

interface PlayerRowProps {
  name: string;
  skill: SkillLevel;
  isMe?: boolean;
  vipTag?: string | null;
  vipTheme?: string | null;
  accentColor: "amber" | "emerald";
}

function PlayerRow({
  name,
  skill,
  isMe = false,
  vipTag = null,
  vipTheme = null,
  accentColor,
}: PlayerRowProps) {
  return (
    <div
      className={`w-full overflow-hidden rounded-xl px-3 py-2.5 transition-all
        ${isMe && accentColor === "amber"
          ? "bg-amber-100 ring-1 ring-amber-300 dark:bg-amber-950/30 dark:ring-amber-700/60"
          : ""}
        ${isMe && accentColor === "emerald"
          ? "bg-emerald-50 ring-1 ring-emerald-300 dark:bg-emerald-950/40 dark:ring-emerald-700/60"
          : ""}
        ${!isMe
          ? "bg-slate-100/70 dark:bg-white/[0.04]"
          : ""}
      `}
    >
      {/* Line 1 — name only, full cell width */}
      <p
        className={`w-full truncate text-[14px] font-bold leading-snug
          ${isMe && accentColor === "amber"
            ? "text-amber-900 dark:text-amber-200"
            : ""}
          ${isMe && accentColor === "emerald"
            ? "text-emerald-900 dark:text-emerald-200"
            : ""}
          ${!isMe
            ? "text-slate-800 dark:text-slate-300"
            : ""}
        `}
      >
        {name}
      </p>

      {/* Line 2 — YOU + VIP (left) · skill dot (right) */}
      {/* Always rendered — invisible spacer keeps all rows the same height */}
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          {isMe ? (
            <span
              className={`text-[10px] font-black uppercase tracking-widest leading-none
                ${accentColor === "amber"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400"
                }`}
            >
              You
            </span>
          ) : (
            /* Invisible spacer — preserves row height uniformly */
            <span className="invisible text-[10px] leading-none" aria-hidden="true">
              You
            </span>
          )}
          {vipTag && vipTheme && (
            <VipTag tag={vipTag} theme={vipTheme} />
          )}
        </div>
        <SkillIndicator level={skill} />
      </div>
    </div>
  );
}

// ── VS Badge ──────────────────────────────────────────────────

function VsBadge() {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                    bg-slate-800 dark:bg-slate-700 text-[11px] font-black text-white shadow-md">
      VS
    </div>
  );
}

// ── Empty Row (module-level) ──────────────────────────────────
// Placeholder that matches a real PlayerRow height exactly.
// Defined at module scope — NOT inside TeamsGrid — so React's
// reconciler sees a stable component reference on every render
// (avoids unnecessary unmount/remount of placeholder DOM nodes).

function EmptyRow() {
  return (
    <div className="w-full overflow-hidden rounded-xl bg-slate-100/50
                    dark:bg-white/[0.02] px-3 py-2.5">
      <p className="invisible text-[14px] font-bold leading-snug">·</p>
      <div className="mt-0.5 flex items-center justify-between">
        <span className="invisible text-[10px] leading-none">You</span>
      </div>
    </div>
  );
}

// ── Teams Grid ────────────────────────────────────────────────
// 3-column CSS grid with explicit placement — guarantees both
// player columns are always equal width and equal row height.
//
//   col 1 (1fr)        | col 2 (36px) | col 3 (1fr)
//   ─────────────────────────────────────────────────
//   row 1  "Your Team" |              | "Opponents"
//   row 2  Me row      |    [VS]      | Opp 1 row
//   row 3  Partner     |   (span 2)   | Opp 2 row

interface TeamsGridProps {
  me: { name: string; skill: SkillLevel; vipTag?: string | null; vipTheme?: string | null };
  teammates: Profile[];
  opponents: Profile[];
  accentColor: "amber" | "emerald";
}

function TeamsGrid({ me, teammates, opponents, accentColor }: TeamsGridProps) {
  const partner = teammates[0] ?? null;
  const opp1    = opponents[0] ?? null;
  const opp2    = opponents[1] ?? null;

  return (
    <div className="grid grid-cols-[1fr_36px_1fr] gap-x-2 gap-y-2">
      {/* ── Row 1: column labels ──────────────────────────── */}
      <p
        className={`col-start-1 row-start-1
                    text-center text-[10px] font-black uppercase tracking-widest
                    ${accentColor === "emerald"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                    }`}
      >
        Your Team
      </p>
      <div className="col-start-2 row-start-1" aria-hidden="true" />
      <p className="col-start-3 row-start-1
                    text-center text-[10px] font-black uppercase tracking-widest
                    text-rose-500 dark:text-rose-400">
        Opponents
      </p>

      {/* ── VS badge — spans both player rows ─────────────── */}
      <div className="col-start-2 row-start-2 row-span-2 flex items-center justify-center">
        <VsBadge />
      </div>

      {/* ── Row 2: first player pair ──────────────────────── */}
      <div className="col-start-1 row-start-2">
        <PlayerRow
          name={me.name}
          skill={me.skill}
          isMe
          vipTag={me.vipTag}
          vipTheme={me.vipTheme}
          accentColor={accentColor}
        />
      </div>
      <div className="col-start-3 row-start-2">
        {opp1 ? (
          <PlayerRow
            name={opp1.display_name}
            skill={opp1.skill_level}
            vipTag={opp1.vip_tag}
            vipTheme={opp1.vip_theme}
            accentColor={accentColor}
          />
        ) : (
          <EmptyRow />
        )}
      </div>

      {/* ── Row 3: second player pair ─────────────────────── */}
      <div className="col-start-1 row-start-3">
        {partner ? (
          <PlayerRow
            name={partner.display_name}
            skill={partner.skill_level}
            vipTag={partner.vip_tag}
            vipTheme={partner.vip_theme}
            accentColor={accentColor}
          />
        ) : (
          <EmptyRow />
        )}
      </div>
      <div className="col-start-3 row-start-3">
        {opp2 ? (
          <PlayerRow
            name={opp2.display_name}
            skill={opp2.skill_level}
            vipTag={opp2.vip_tag}
            vipTheme={opp2.vip_theme}
            accentColor={accentColor}
          />
        ) : (
          <EmptyRow />
        )}
      </div>
    </div>
  );
}

// ── Mixed Level Warning ───────────────────────────────────────

function MixedLevelBanner() {
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-center
                    dark:border-amber-800/50 dark:bg-amber-950/30">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300
                       bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-wider
                       text-amber-800 dark:border-amber-700 dark:bg-amber-900/40
                       dark:text-amber-300">
        <span aria-hidden="true">⚠</span>
        Mixed Level Match
      </span>
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────

export function MatchAlert({
  matchStatus,
  court,
  myDisplayName,
  mySkillLevel,
  myVipTag,
  myVipTheme,
  teammates,
  opponents,
  isMixedLevel = false,
  onDeckPosition = null,
  totalOnDeck = 0,
}: MatchAlertProps) {

  const me = {
    name:     myDisplayName,
    skill:    mySkillLevel,
    vipTag:   myVipTag ?? null,
    vipTheme: myVipTheme ?? null,
  };

  // ── In-Progress: "Head to Court" ─────────────────────────────
  if (matchStatus === "in_progress") {
    return (
      <div
        role="alert"
        aria-label={`Match starting${court ? ` — head to ${court.name}` : ""}`}
        className="overflow-hidden rounded-3xl border border-emerald-900/50
                   shadow-[0_8px_64px_rgba(16,185,129,0.15)]
                   animate-in fade-in zoom-in-95 duration-300"
      >

        {/* Court number hero — always dark navy for urgency */}
        <div className="relative overflow-hidden bg-[#0E1C3A] px-6 pb-7 pt-8 text-center">
          {/* Ambient pulsing rings — decorative only */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-64 w-64 animate-ping rounded-full border border-emerald-500/10
                            [animation-duration:3s]" />
          </div>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-44 w-44 animate-ping rounded-full border border-emerald-500/10
                            [animation-duration:3s] [animation-delay:0.8s]" />
          </div>

          {/* Live dot — decorative */}
          <div aria-hidden="true" className="relative mb-4 flex justify-center">
            <span className="relative flex h-4 w-4">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full
                               bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-500" />
            </span>
          </div>

          <p className="relative mb-2 text-[10px] font-black uppercase tracking-[0.28em]
                        text-emerald-400">
            It&apos;s your turn!
          </p>

          {/* THE focal point — readable from arm's length.
              Fluid font-size: scales from 40px on narrow viewports to
              72px on wide ones, so long court names never wrap or overflow. */}
          <h2
            className="relative font-black leading-none tracking-tight text-white
                       drop-shadow-[0_2px_24px_rgba(16,185,129,0.3)]"
            style={{ fontSize: "clamp(40px, 15vw, 72px)" }}
          >
            {court ? court.name : "Head to court!"}
          </h2>

          <p className="relative mt-4 text-sm font-semibold text-emerald-300">
            Your match is starting now 🏸
          </p>
        </div>

        {isMixedLevel && <MixedLevelBanner />}

        {/* Teams */}
        <div className="bg-slate-50 px-4 pb-6 pt-5 dark:bg-card">
          <TeamsGrid
            me={me}
            teammates={teammates}
            opponents={opponents}
            accentColor="emerald"
          />
        </div>
      </div>
    );
  }

  // ── On-Deck: waiting for a court ─────────────────────────────
  // Derive position-aware copy.
  const posLabel =
    onDeckPosition === null || onDeckPosition === 1
      ? "Next Available Court"
      : `#${onDeckPosition} On Deck`;

  const posSubline =
    onDeckPosition === null || onDeckPosition === 1
      ? "Find your team — a court is opening soon 🏸"
      : onDeckPosition === 2
      ? "1 match ahead of you — get warmed up! 🏸"
      : `${onDeckPosition - 1} matches ahead of you — be ready soon 🏸`;

  // Only show positional context (e.g. "2 of 3 on deck") when the
  // player is NOT next — position 1 means they ARE next, so
  // "You're On Deck" is the correct and unambiguous label.
  const posEyebrow =
    onDeckPosition !== null && onDeckPosition > 1 && totalOnDeck > 1
      ? `${onDeckPosition} of ${totalOnDeck} on deck`
      : "You're On Deck";

  return (
    <div
      role="alert"
      aria-label="You're on deck — a court is opening soon"
      className="overflow-hidden rounded-3xl border border-amber-200
                 shadow-xl animate-in fade-in zoom-in-95 duration-300
                 dark:border-amber-800/40"
    >

      {/* Status header */}
      <div className="bg-amber-50 px-6 pb-6 pt-7 text-center dark:bg-amber-950/20">
        {/* Pulse dot — decorative */}
        <div aria-hidden="true" className="mb-3 flex justify-center">
          <span className="relative flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full
                             bg-amber-400 opacity-60" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-amber-500" />
          </span>
        </div>

        <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em]
                      text-amber-600 dark:text-amber-400">
          {posEyebrow}
        </p>

        <h2 className="text-4xl font-black leading-none text-slate-900 dark:text-amber-100">
          {posLabel}
        </h2>

        <p className="mt-3 text-sm font-medium text-slate-500 dark:text-amber-300/80">
          {posSubline}
        </p>
      </div>

      {isMixedLevel && <MixedLevelBanner />}

      {/* Teams */}
      <div className="bg-white px-4 pb-6 pt-5 dark:bg-card">
        <TeamsGrid
          me={me}
          teammates={teammates}
          opponents={opponents}
          accentColor="amber"
        />
        <p className="mt-5 text-center text-[10px] font-medium
                      text-slate-400 dark:text-muted-foreground">
          You&apos;ll be directed to a court as soon as one opens up
        </p>
      </div>
    </div>
  );
}
