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
}

export function MatchAlert({
  matchStatus,
  court,
  myDisplayName,
  mySkillLevel,
  teammates,
  opponents,
  isMixedLevel = false,
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
          <div className="bg-amber-50 border-b border-amber-200 px-5 py-2.5 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 border border-amber-300 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-800">
              ⚠ Mixed Level Match
            </span>
          </div>
        )}

        {/* Teams section */}
        <div className="bg-white px-5 pt-5 pb-6">
          <div className="flex items-stretch gap-3">
            {/* Your team */}
            <div className="flex-1 rounded-2xl bg-emerald-50 p-4 text-center">
              <p className="mb-3 text-[10px] font-black uppercase tracking-wider text-emerald-600">
                Your Team
              </p>

              {/* You */}
              <div className="mb-3">
                <div className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-black text-white">
                  YOU
                </div>
                <p className="text-sm font-bold text-slate-900">{myDisplayName}</p>
                <SkillBadge level={mySkillLevel} className="mt-0.5" />
              </div>

              {/* Teammates (1 in doubles) */}
              {teammates.map((t) => (
                <div key={t.id}>
                  <p className="text-sm font-bold text-slate-900">{t.display_name}</p>
                  <SkillBadge level={t.skill_level} className="mt-0.5" />
                </div>
              ))}
            </div>

            {/* VS badge */}
            <div className="flex shrink-0 items-center justify-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-800 text-sm font-black text-white shadow-md">
                VS
              </div>
            </div>

            {/* Opponents */}
            <div className="flex-1 rounded-2xl bg-rose-50 p-4 text-center">
              <p className="mb-3 text-[10px] font-black uppercase tracking-wider text-rose-600">
                Opponents
              </p>
              {opponents.map((o) => (
                <div key={o.id} className="mb-2.5 last:mb-0">
                  <p className="text-sm font-bold text-slate-900">{o.display_name}</p>
                  <SkillBadge level={o.skill_level} className="mt-0.5" />
                </div>
              ))}
              {opponents.length === 0 && (
                <p className="text-sm text-slate-400">Loading…</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── On-Deck: "You're On Deck!" ─────────────────────────────
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
          Get ready!
        </p>
        <h2 className="mt-2 text-4xl font-black text-white leading-tight">
          You&apos;re On Deck!
        </h2>
        <p className="mt-2 text-amber-100 text-sm font-medium">
          Find your team — a court is opening soon
        </p>
      </div>

      {/* Mixed level warning */}
      {isMixedLevel && (
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-2.5 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 border border-amber-300 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-800">
            ⚠ Mixed Level Match
          </span>
        </div>
      )}

      {/* Teams section */}
      <div className="bg-white px-5 pt-5 pb-6">
        <div className="flex items-stretch gap-3">
          {/* Your team */}
          <div className="flex-1 rounded-2xl bg-amber-50 p-4 text-center">
            <p className="mb-3 text-[10px] font-black uppercase tracking-wider text-amber-600">
              Your Team
            </p>

            {/* You */}
            <div className="mb-3">
              <div className="mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-sm font-black text-white">
                YOU
              </div>
              <p className="text-sm font-bold text-slate-900">{myDisplayName}</p>
              <SkillBadge level={mySkillLevel} className="mt-0.5" />
            </div>

            {teammates.map((t) => (
              <div key={t.id}>
                <p className="text-sm font-bold text-slate-900">{t.display_name}</p>
                <SkillBadge level={t.skill_level} className="mt-0.5" />
              </div>
            ))}
          </div>

          {/* VS badge */}
          <div className="flex shrink-0 items-center justify-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-700 text-sm font-black text-white shadow-md">
              VS
            </div>
          </div>

          {/* Opponents */}
          <div className="flex-1 rounded-2xl bg-slate-100 p-4 text-center">
            <p className="mb-3 text-[10px] font-black uppercase tracking-wider text-slate-500">
              Opponents
            </p>
            {opponents.map((o) => (
              <div key={o.id} className="mb-2.5 last:mb-0">
                <p className="text-sm font-bold text-slate-900">{o.display_name}</p>
                <SkillBadge level={o.skill_level} className="mt-0.5" />
              </div>
            ))}
            {opponents.length === 0 && (
              <p className="text-sm text-slate-400">Loading…</p>
            )}
          </div>
        </div>

        {/* Footer tip */}
        <p className="mt-4 text-center text-xs text-slate-400">
          You&apos;ll be directed to a court as soon as one opens up
        </p>
      </div>
    </div>
  );
}
