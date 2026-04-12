"use client";

// ============================================================
// LiveCourtsTab — Read-only view of all active matches
// ============================================================
// Shows in-progress matches as badminton court graphics, then
// on-deck matches in a separate section. No organizer actions.
// ============================================================

import { Swords } from "lucide-react";
import { BadmintonCourt } from "@/components/ui/badminton-court";
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

          <div className="space-y-4">
            {inProgressMatches.map((match) => (
              <CourtMatchCard key={match.id} match={match} variant="in_progress" />
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

          <div className="space-y-4">
            {onDeckMatches.map((match) => (
              <CourtMatchCard key={match.id} match={match} variant="on_deck" />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CourtMatchCard — Header bar + badminton court graphic
// ─────────────────────────────────────────────────────────────

function CourtMatchCard({
  match,
  variant,
}: {
  match: SessionMatch;
  variant: "in_progress" | "on_deck";
}) {
  const teamA = match.players
    .filter((p) => p.team === "a")
    .map((p) => ({
      player_id: p.player_id,
      display_name: p.profile.display_name,
      skill_level: p.profile.skill_level,
    }));

  const teamB = match.players
    .filter((p) => p.team === "b")
    .map((p) => ({
      player_id: p.player_id,
      display_name: p.profile.display_name,
      skill_level: p.profile.skill_level,
    }));

  const isOnDeck = variant === "on_deck";

  return (
    <div className="rounded-2xl overflow-hidden shadow-sm border border-slate-200 bg-white">
      {/* Header bar */}
      <div
        className={`flex items-center justify-between px-4 py-2.5
                    ${isOnDeck ? "bg-amber-50" : "bg-slate-900"}`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-bold
                        ${isOnDeck ? "text-amber-900" : "text-white"}`}
          >
            {isOnDeck ? "On Deck" : match.court?.name ?? "Court"}
          </span>
          {match.is_mixed_level && (
            <span className="rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5
                            text-[10px] font-bold uppercase tracking-wider text-amber-800">
              Mixed Level
            </span>
          )}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider
                      ${
                        isOnDeck
                          ? "bg-amber-200/60 text-amber-800"
                          : "bg-white/20 text-white/90"
                      }`}
        >
          {isOnDeck ? "Waiting for court" : "In Progress"}
        </span>
      </div>

      {/* Court graphic */}
      <div className="p-2">
        <BadmintonCourt teamA={teamA} teamB={teamB} isOnDeck={isOnDeck} />
      </div>
    </div>
  );
}
