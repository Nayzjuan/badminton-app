"use client";

// ============================================================
// OnDeckPanel — Organizer view of pre-formed pending matches
// ============================================================
// Shows matches that have been algorithmically generated but
// are waiting for a court to free up. Uses the badminton court
// graphic for visual consistency.
// ============================================================

import { BadmintonCourt } from "@/components/ui/badminton-court";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

interface OnDeckPanelProps {
  matches: EnrichedMatch[];
  onGenerate?: () => void;
  generating?: boolean;
}

export function OnDeckPanel({ matches, onGenerate, generating }: OnDeckPanelProps) {
  if (matches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-2 w-2 rounded-full bg-slate-300" />
            <p className="text-sm font-medium text-slate-500">
              No matches on deck
            </p>
            <span className="text-xs text-slate-400">
              — algorithm will pre-generate when enough players are waiting
            </span>
          </div>
          {onGenerate && (
            <button
              onClick={onGenerate}
              disabled={generating}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium
                         text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
            >
              {generating ? "Generating…" : "Generate Now"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">
            On Deck
          </h2>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
            {matches.length} match{matches.length !== 1 ? "es" : ""} ready
          </span>
        </div>
        {onGenerate && (
          <button
            onClick={onGenerate}
            disabled={generating}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium
                       text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            {generating ? "Generating…" : "Refresh"}
          </button>
        )}
      </div>

      {/* Match cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {matches.map((match, idx) => {
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
          const minutesWaiting = Math.floor(
            (Date.now() - new Date(match.created_at).getTime()) / 60_000
          );

          return (
            <div
              key={match.id}
              className="rounded-2xl border border-amber-100 bg-white shadow-sm overflow-hidden"
            >
              {/* Card header */}
              <div className="flex items-center justify-between bg-amber-50/70 px-4 py-2.5 border-b border-amber-100">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-amber-900">
                    On Deck #{idx + 1}
                  </span>
                  {match.is_mixed_level && (
                    <span className="rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5
                                    text-[10px] font-bold uppercase tracking-wider text-amber-800">
                      Mixed Level
                    </span>
                  )}
                </div>
                <span className="text-xs text-amber-600 font-medium">
                  {minutesWaiting === 0 ? "Just formed" : `${minutesWaiting}m ago`}
                </span>
              </div>

              {/* Court graphic */}
              <div className="p-2">
                <BadmintonCourt teamA={teamA} teamB={teamB} isOnDeck />
              </div>

              {/* Footer hint */}
              <div className="px-4 py-2 bg-slate-50 border-t border-slate-100">
                <p className="text-center text-xs text-slate-400">
                  Will auto-assign when a court frees up
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
