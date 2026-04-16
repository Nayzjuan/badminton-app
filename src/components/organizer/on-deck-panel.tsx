"use client";

// ============================================================
// OnDeckPanel — Organizer view of pre-formed pending matches
// ============================================================
// Shows matches that have been formed but are waiting for a
// court to free up. Each card has a "Clear" button so the
// organizer can dismantle a pending match and return its
// players to the waiting queue (preserving queue position).
// ============================================================

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { BadmintonCourt } from "@/components/ui/badminton-court";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

interface OnDeckPanelProps {
  matches: EnrichedMatch[];
  onClearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
}

export function OnDeckPanel({ matches, onClearOnDeckMatch }: OnDeckPanelProps) {
  const [clearingIds, setClearingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handleClear(matchId: string) {
    setClearingIds((prev) => new Set(prev).add(matchId));
    setErrors((prev) => { const e = { ...prev }; delete e[matchId]; return e; });

    const result = await onClearOnDeckMatch(matchId);

    setClearingIds((prev) => {
      const s = new Set(prev);
      s.delete(matchId);
      return s;
    });

    if (result.error) {
      setErrors((prev) => ({ ...prev, [matchId]: result.error! }));
    }
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 dark:border-border bg-slate-50/60 dark:bg-card/50 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="h-2 w-2 rounded-full bg-slate-300 dark:bg-muted-foreground" />
          <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground">
            No matches on deck
          </p>
          <span className="text-xs text-slate-400 dark:text-muted-foreground/70 hidden sm:inline">
            — the engine fills this automatically, or create one manually in Queue &amp; Match Control
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        </span>
        <h2 className="text-sm font-bold text-slate-700 dark:text-foreground uppercase tracking-wider">
          On Deck
        </h2>
        <span className="rounded-full px-2 py-0.5 text-xs font-bold
                         bg-amber-100 text-amber-800
                         dark:bg-[hsl(35_100%_55%)]/20 dark:text-[hsl(35_100%_65%)]
                         dark:ring-1 dark:ring-[hsl(35_100%_55%)]/50">
          {matches.length} match{matches.length !== 1 ? "es" : ""} ready
        </span>
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
          const isClearing = clearingIds.has(match.id);
          const error = errors[match.id];

          return (
            <div
              key={match.id}
              className="rounded-2xl border border-amber-100 dark:border-amber-900/40 bg-white dark:bg-card shadow-sm overflow-hidden"
            >
              {/* Card header */}
              <div className="flex items-center justify-between bg-amber-50/70 dark:bg-amber-900/20 px-4 py-2.5 border-b border-amber-100 dark:border-amber-900/40">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-amber-900 dark:text-amber-300">
                    On Deck #{idx + 1}
                  </span>
                  {match.is_mixed_level && (
                    <span className="rounded-full border px-2 py-0.5
                                    text-[10px] font-bold uppercase tracking-wider
                                    bg-amber-100 border-amber-300 text-amber-800
                                    dark:bg-[hsl(35_100%_55%)]/20 dark:border-[hsl(35_100%_60%)]/70 dark:text-[hsl(35_100%_65%)]">
                      Mixed Level
                    </span>
                  )}
                </div>
                <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                  {minutesWaiting === 0 ? "Just formed" : `${minutesWaiting}m ago`}
                </span>
              </div>

              {/* Court graphic */}
              <div className="p-2">
                <BadmintonCourt teamA={teamA} teamB={teamB} isOnDeck />
              </div>

              {/* Footer — Clear button */}
              <div className="px-4 py-2.5 bg-slate-50 dark:bg-muted/50 border-t border-slate-100 dark:border-border flex items-center justify-between gap-3">
                <p className="text-xs text-slate-400 dark:text-muted-foreground">
                  Will be assigned when a court frees up
                </p>
                <button
                  onClick={() => handleClear(match.id)}
                  disabled={isClearing}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200
                             bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700
                             hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40
                             dark:text-red-400 dark:hover:bg-red-950/60
                             disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  {isClearing ? "Clearing…" : "Clear"}
                </button>
              </div>

              {/* Inline error */}
              {error && (
                <p className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{error}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
