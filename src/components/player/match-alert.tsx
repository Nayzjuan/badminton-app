"use client";

// ============================================================
// MatchAlert — Full-screen takeover card when player is called
// ============================================================
// Replaces the entire queue UI when a player has an active match.
//
// Two states:
//   "on_deck" / status=pending  → amber "You're On Deck!" card
//   "in_progress"               → vibrant green "Head to Court!" card
//
// Layout:
//   ┌─────────────────────────────────┐
//   │  [big status heading]           │
//   │  [court name or "coming soon"]  │
//   │                                 │
//   │  ┌───────────┐  VS  ┌────────┐ │
//   │  │ Your Team │      │ Them   │ │
//   │  │ You       │      │ P3     │ │
//   │  │ Partner   │      │ P4     │ │
//   │  └───────────┘      └────────┘ │
//   └─────────────────────────────────┘
// ============================================================

import { SkillBadge } from "@/components/ui/skill-badge";
import type { Court, Profile, MatchStatus } from "@/types/database";

interface MatchAlertProps {
  matchStatus: MatchStatus;
  court: Court | null;
  myDisplayName: string;
  mySkillLevel: Profile["skill_level"];
  teammates: Profile[];  // excludes self
  opponents: Profile[];
  isMixedLevel?: boolean;
  /** 1-based position among pending on-deck matches (1 = next court). null when in_progress. */
  onDeckPosition?: number | null;
  /** Total pending on-deck matches right now. */
  totalOnDeck?: number;
}

export function MatchAlert({
  matchStatus,
  court,
  myDisplayName,
  mySkillLevel,
  teammates,
  opponents,
  isMixedLevel = false,
  onDeckPosition = null,
  totalOnDeck = 0,
}: MatchAlertProps) {
  const isPlaying = matchStatus === "in_progress";

  // ── In-Progress: "Head to Court" ───────────────────────────
  if (isPlaying) {
    return (
      <div className="rounded-3xl overflow-hidden shadow-xl animate-in fade-in zoom-in-95 duration-300">
        {/* Gradient header */}
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 px-6 pt-8 pb-6 text-center">
          {/* Pulsing dot */}
          <div className="flex justify-center mb-3">
            <span className="relative flex h-4 w-4">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60" />
              <span className="relative inline-flex h-4 w-4 rounded-full bg-white" />
            </span>
          </div>
          <p className="text-sm font-bold uppercase tracking-widest text-emerald-100">
            It&apos;s your turn!
          </p>
          <h2 className="mt-2 text-4xl font-black text-white leading-tight">
            {court ? `Head to ${court.name}` : "Head to court!"}
          </h2>
          <p className="mt-2 text-emerald-100 text-sm font-medium">
            Your match is starting now 🏸
          </p>
        </div>

        {/* Mixed level warning */}
        {isMixedLevel && (
          <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/50 px-5 py-2.5 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
              ⚠ Mixed Level Match
            </span>
          </div>
        )}

        {/* Teams section */}
        <div className="bg-slate-50 dark:bg-card px-5 pt-5 pb-6">
          <div className="flex items-stretch gap-3">
            {/* Your team */}
            <div className="flex-1 rounded-2xl bg-emerald-50 dark:bg-emerald-950/20 p-4 text-center">
              <p className="mb-3 text-xs font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Your Team
              </p>

              {/* You — first-initial circle instead of generic "YOU" label */}
              <div className="mb-3 flex flex-col items-center">
                <div className="mx-auto mb-1.5 flex h-9 w-9 items-center justify-center rounded-full
                                bg-emerald-600 dark:bg-emerald-700 text-base font-bold text-white select-none">
                  {myDisplayName.charAt(0).toUpperCase()}
                </div>
                <p className="text-sm font-bold text-slate-900 dark:text-foreground leading-tight">{myDisplayName}</p>
                <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">You</span>
                <SkillBadge level={mySkillLevel} className="mt-0.5" />
              </div>

              {/* Teammates (1 in doubles) */}
              {teammates.map((t) => (
                <div key={t.id} className="flex flex-col items-center">
                  <p className="text-sm font-bold text-slate-900 dark:text-foreground">{t.display_name}</p>
                  <SkillBadge level={t.skill_level} className="mt-0.5" />
                </div>
              ))}
            </div>

            {/* VS badge */}
            <div className="flex shrink-0 items-center justify-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-800 dark:bg-slate-700 text-sm font-black text-white shadow-md">
                VS
              </div>
            </div>

            {/* Opponents */}
            <div className="flex-1 rounded-2xl bg-rose-50 dark:bg-rose-950/20 p-4 text-center">
              <p className="mb-3 text-xs font-black uppercase tracking-wider text-rose-700 dark:text-rose-400">
                Opponents
              </p>
              {opponents.map((o) => (
                <div key={o.id} className="mb-2.5 last:mb-0">
                  <p className="text-sm font-bold text-slate-900 dark:text-foreground">{o.display_name}</p>
                  <SkillBadge level={o.skill_level} className="mt-0.5" />
                </div>
              ))}
              {opponents.length === 0 && (
                <p className="text-sm text-slate-400 dark:text-muted-foreground">Loading…</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── On-Deck: "You're On Deck!" ─────────────────────────────
  // Derive position-aware copy.
  // pos=1 (or unknown) → "You're Next Up!" — court any second
  // pos=2 → "#2 On Deck" — 1 match ahead of you
  // pos=3+ → "#N On Deck" — N-1 matches ahead of you
  const posLabel =
    onDeckPosition === null || onDeckPosition === 1
      ? "You're Next Up!"
      : `#${onDeckPosition} On Deck`;

  const posSubline =
    onDeckPosition === null || onDeckPosition === 1
      ? "Find your team — a court is opening soon 🏸"
      : onDeckPosition === 2
      ? "1 match ahead of you — get warmed up!"
      : `${onDeckPosition - 1} matches ahead of you — be ready soon`;

  const posEyebrow =
    onDeckPosition !== null && totalOnDeck > 1
      ? `${onDeckPosition} of ${totalOnDeck} on deck`
      : "On Deck";

  return (
    <div className="rounded-3xl overflow-hidden shadow-xl animate-in fade-in zoom-in-95 duration-300">
      {/* Gradient header */}
      <div className="bg-gradient-to-br from-amber-400 to-orange-500 px-6 pt-8 pb-6 text-center">
        {/* Animated badge */}
        <div className="flex justify-center mb-3">
          <span className="relative flex h-4 w-4">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-white" />
          </span>
        </div>
        <p className="text-sm font-bold uppercase tracking-widest text-amber-100">
          {posEyebrow}
        </p>
        <h2 className="mt-2 text-4xl font-black text-white leading-tight">
          {posLabel}
        </h2>
        <p className="mt-2 text-amber-100 text-sm font-medium">
          {posSubline}
        </p>
      </div>

      {/* Mixed level warning */}
      {isMixedLevel && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/50 px-5 py-2.5 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            ⚠ Mixed Level Match
          </span>
        </div>
      )}

      {/* Teams section */}
      <div className="bg-slate-50 dark:bg-card px-5 pt-5 pb-6">
        <div className="flex items-stretch gap-3">
          {/* Your team */}
          <div className="flex-1 rounded-2xl bg-amber-50 dark:bg-amber-950/20 p-4 text-center">
            <p className="mb-3 text-xs font-black uppercase tracking-wider text-amber-700 dark:text-amber-400">
              Your Team
            </p>

            {/* You — first-initial circle instead of generic "YOU" label */}
            <div className="mb-3 flex flex-col items-center">
              <div className="mx-auto mb-1.5 flex h-9 w-9 items-center justify-center rounded-full
                              bg-amber-500 dark:bg-amber-600 text-base font-bold text-white select-none">
                {myDisplayName.charAt(0).toUpperCase()}
              </div>
              <p className="text-sm font-bold text-slate-900 dark:text-foreground leading-tight">{myDisplayName}</p>
              <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide">You</span>
              <SkillBadge level={mySkillLevel} className="mt-0.5" />
            </div>

            {teammates.map((t) => (
              <div key={t.id} className="flex flex-col items-center">
                <p className="text-sm font-bold text-slate-900 dark:text-foreground">{t.display_name}</p>
                <SkillBadge level={t.skill_level} className="mt-0.5" />
              </div>
            ))}
          </div>

          {/* VS badge */}
          <div className="flex shrink-0 items-center justify-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-700 dark:bg-slate-600 text-sm font-black text-white shadow-md">
              VS
            </div>
          </div>

          {/* Opponents */}
          <div className="flex-1 rounded-2xl bg-slate-100 dark:bg-slate-800/40 p-4 text-center">
            <p className="mb-3 text-xs font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
              Opponents
            </p>
            {opponents.map((o) => (
              <div key={o.id} className="mb-2.5 last:mb-0">
                <p className="text-sm font-bold text-slate-900 dark:text-foreground">{o.display_name}</p>
                <SkillBadge level={o.skill_level} className="mt-0.5" />
              </div>
            ))}
            {opponents.length === 0 && (
              <p className="text-sm text-slate-400 dark:text-muted-foreground">Loading…</p>
            )}
          </div>
        </div>

        {/* Footer tip */}
        <p className="mt-4 text-center text-xs text-slate-400 dark:text-muted-foreground">
          You&apos;ll be directed to a court as soon as one opens up
        </p>
      </div>
    </div>
  );
}
