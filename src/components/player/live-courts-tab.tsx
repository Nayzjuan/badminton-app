"use client";

// ============================================================
// LiveCourtsTab — Read-only view of all active matches
// ============================================================
// Shows in-progress matches (on a court) as cards, then
// on-deck matches (pending, no court) in a separate section.
// No organizer actions — purely informational for players.
// ============================================================

import { Swords } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { SessionMatch } from "@/hooks/use-session-data";

interface LiveCourtsTabProps {
  inProgressMatches: SessionMatch[];
  onDeckMatches: SessionMatch[];
  loading: boolean;
}

export function LiveCourtsTab({
  inProgressMatches,
  onDeckMatches,
  loading,
}: LiveCourtsTabProps) {
  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-slate-400">
        Loading courts...
      </div>
    );
  }

  const hasNothing = inProgressMatches.length === 0 && onDeckMatches.length === 0;

  if (hasNothing) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
          <Swords className="h-5 w-5 text-slate-400" />
        </div>
        <p className="text-sm font-medium text-slate-600">No active matches</p>
        <p className="mt-1 text-xs text-slate-400">
          Matches will appear here once the organizer starts them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── In Progress ─────────────────────────────────────── */}
      {inProgressMatches.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Now Playing
            </h2>
            <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              {inProgressMatches.length}
            </span>
          </div>

          <div className="space-y-3">
            {inProgressMatches.map((match) => (
              <MatchCard key={match.id} match={match} variant="in_progress" />
            ))}
          </div>
        </section>
      )}

      {/* ── On Deck ─────────────────────────────────────────── */}
      {onDeckMatches.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              On Deck
            </h2>
            <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              {onDeckMatches.length}
            </span>
          </div>

          <div className="space-y-3">
            {onDeckMatches.map((match) => (
              <MatchCard key={match.id} match={match} variant="on_deck" />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MatchCard — Read-only court card for players
// ─────────────────────────────────────────────────────────────

function MatchCard({
  match,
  variant,
}: {
  match: SessionMatch;
  variant: "in_progress" | "on_deck";
}) {
  const teamA = match.players.filter((p) => p.team === "a");
  const teamB = match.players.filter((p) => p.team === "b");
  const isOnDeck = variant === "on_deck";

  return (
    <div
      className={`rounded-2xl overflow-hidden shadow-sm
                  ${
                    isOnDeck
                      ? "border border-dashed border-amber-200 bg-slate-50"
                      : "border border-slate-200 bg-white"
                  }`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-4 py-2.5 border-b
                    ${
                      isOnDeck
                        ? "bg-amber-50/60 border-amber-100"
                        : "bg-slate-50 border-slate-100"
                    }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-bold ${
              isOnDeck ? "text-amber-900" : "text-slate-900"
            }`}
          >
            {isOnDeck ? "On Deck" : match.court?.name ?? "Court"}
          </span>
          {match.is_mixed_level && (
            <span className="rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
              Mixed Level
            </span>
          )}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider
                      ${
                        isOnDeck
                          ? "bg-amber-100 text-amber-700"
                          : "bg-violet-100 text-violet-700"
                      }`}
        >
          {isOnDeck ? "Waiting for court" : "In Progress"}
        </span>
      </div>

      {/* Teams */}
      <div className="flex items-stretch gap-3 p-3">
        {/* Team A */}
        <div className="flex-1 rounded-xl bg-blue-50 p-3 text-center">
          <p className="mb-2 text-[10px] font-black tracking-wider text-slate-500 uppercase">
            Team A
          </p>
          {teamA.map((p) => (
            <div key={p.player_id} className="mb-1.5 last:mb-0">
              <p className="text-sm font-bold text-slate-900 leading-snug">
                {p.profile.display_name}
              </p>
              <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
            </div>
          ))}
        </div>

        {/* VS */}
        <div className="flex shrink-0 items-center justify-center">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white shadow-sm">
            VS
          </div>
        </div>

        {/* Team B */}
        <div className="flex-1 rounded-xl bg-rose-50 p-3 text-center">
          <p className="mb-2 text-[10px] font-black tracking-wider text-slate-500 uppercase">
            Team B
          </p>
          {teamB.map((p) => (
            <div key={p.player_id} className="mb-1.5 last:mb-0">
              <p className="text-sm font-bold text-slate-900 leading-snug">
                {p.profile.display_name}
              </p>
              <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
