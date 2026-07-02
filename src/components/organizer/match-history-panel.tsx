"use client";

// ============================================================
// MatchHistoryPanel — Organizer view of completed + cancelled matches
// ============================================================
// Shows every completed or cancelled match in the session.
//
// Completed matches: full scores, team panels with win/loss
//   indicators, static MatchTimer showing game duration.
// Cancelled matches: muted "Cancelled" banner — no scores, no
//   timer. Players' names still visible for reference.
//
// Player filter: type-to-filter searchable list at the top lets
//   the organizer narrow to a single player's matches. Filtering
//   is 100% client-side (useMemo over already-fetched data).
//   Selected player gets a solid cc-accent ring; their partner(s)
//   get a dashed ring so team composition reads at a glance.
// ============================================================

import { useState, useMemo } from "react";
import { Trophy, History, Ban, X } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import { MatchTimer } from "@/components/ui/match-timer";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import { EditMatchDialog } from "./edit-match-dialog";
import { FixRecordSheet } from "./fix-record-sheet";
import { MatchEventTimeline } from "./match-event-timeline";
import { MatchHistoryPlayerFilter } from "./match-history-player-filter";
import { useMatchHistory } from "@/hooks/use-match-history";
import {
  filterMatchesByPlayer,
  derivePlayerOptions,
  resolvePartnerIds,
} from "@/lib/match-history-filter";

interface MatchHistoryPanelProps {
  sessionId: string;
}

export function MatchHistoryPanel({ sessionId }: MatchHistoryPanelProps) {
  const { matches, loading } = useMatchHistory(sessionId);

  // Pinned selection object — name captured at select time so the chip stays
  // correct even if the player later vanishes from playerOptions (identity merge,
  // score revert, etc.). Never a bare id.
  const [selected, setSelected] = useState<{ id: string; display_name: string } | null>(null);

  // Option list derived only from players present in history (guarantees ≥1 result per name).
  const playerOptions = useMemo(() => derivePlayerOptions(matches), [matches]);

  // Filtered list — pure client-side, no new Supabase trip.
  const visibleMatches = useMemo(
    () => filterMatchesByPlayer(matches, selected?.id ?? null),
    [matches, selected]
  );

  // Stable display number per match (newest = highest). Precomputed from the full
  // history so a filter never renumbers, keyed by id (O(n), not O(n²) indexOf).
  const matchNumberById = useMemo(
    () => new Map(matches.map((m, i) => [m.id, matches.length - i])),
    [matches]
  );

  // Selection split out so JSX value-accesses don't need non-null casts.
  // We deliberately never auto-clear the filter when the selected player leaves
  // every roster (e.g. a score-revert): visibleMatches goes empty and the
  // safety-net state renders with the pinned name; the organizer clears via ✕.
  const selectedId = selected?.id ?? null;
  const selectedName = selected?.display_name ?? null;

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading match history">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <div className="h-3 w-28 rounded-full bg-slate-200 dark:bg-muted/60 animate-pulse" />
          <div className="h-5 w-24 rounded-full bg-slate-200 dark:bg-muted/60 animate-pulse" />
        </div>
        {/* Three card-shaped pulse skeletons */}
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden"
            >
              {/* Header bar */}
              <div className="flex items-center justify-between bg-slate-50 dark:bg-muted/50 px-4 py-2.5 border-b border-slate-100 dark:border-border">
                <div className="h-3.5 w-24 rounded-full bg-slate-200 dark:bg-muted animate-pulse" />
                <div className="h-3.5 w-16 rounded-full bg-slate-200 dark:bg-muted animate-pulse" />
              </div>
              {/* Score row + two-column teams */}
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-center gap-4">
                  <div className="h-8 w-7 rounded bg-slate-200 dark:bg-muted animate-pulse" />
                  <div className="h-4 w-3 rounded bg-slate-100 dark:bg-muted/50 animate-pulse" />
                  <div className="h-8 w-7 rounded bg-slate-200 dark:bg-muted animate-pulse" />
                </div>
                <div className="flex gap-3">
                  {[0, 1].map((t) => (
                    <div
                      key={t}
                      className="flex-1 rounded-xl bg-slate-50 dark:bg-muted/50 p-3 space-y-2"
                    >
                      <div className="h-2.5 w-14 rounded-full bg-slate-200 dark:bg-muted animate-pulse mx-auto" />
                      <div className="h-4 w-20 rounded-full bg-slate-200 dark:bg-muted animate-pulse mx-auto" />
                      <div className="h-3.5 w-16 rounded-full bg-slate-100 dark:bg-muted/60 animate-pulse mx-auto" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 dark:border-border bg-white dark:bg-card px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-muted">
          <History className="h-5 w-5 text-slate-400 dark:text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-slate-600 dark:text-foreground">
          No completed matches yet
        </p>
        <p className="mt-1 text-xs text-slate-400 dark:text-muted-foreground">
          Matches will appear here once they are scored and ended.
        </p>
      </div>
    );
  }

  const completedCount = matches.filter((m) => m.status === "completed").length;
  const cancelledCount = matches.filter((m) => m.status === "cancelled").length;
  const isFiltered = !!selected;

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
          Match History
        </h2>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-100 dark:bg-muted px-2.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-foreground">
            {completedCount} completed
          </span>
          {cancelledCount > 0 && (
            <span className="rounded-full bg-slate-100 dark:bg-muted px-2.5 py-0.5 text-[10px] font-bold text-slate-500 dark:text-muted-foreground">
              {cancelledCount} cancelled
            </span>
          )}
        </div>
      </div>

      {/* Player filter — only shown when there are players in history */}
      {playerOptions.length > 0 && (
        <MatchHistoryPlayerFilter
          players={playerOptions}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      )}

      {/* Active-filter chip + match count */}
      {isFiltered && (
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1.5 rounded-full px-3 py-1
                          bg-cc-accent-dim outline outline-1 outline-cc-accent/55
                          text-xs font-semibold text-cc-accent-text"
          >
            <span>Showing {selectedName}</span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Clear player filter"
              className="ml-0.5 rounded-full p-0.5 hover:bg-cc-accent/20 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {visibleMatches.length} of {matches.length} matches
          </span>
        </div>
      )}

      {/* Safety-net empty state when filter active but no matches found */}
      {isFiltered && visibleMatches.length === 0 && (
        <div className="rounded-2xl border border-dashed border-cc-border bg-white dark:bg-card px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-600 dark:text-foreground">
            No matches for {selectedName} in this session yet.
          </p>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="mt-2 text-xs text-cc-accent-text underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Match cards */}
      <div className="space-y-3">
        {visibleMatches.map((match) => {
          const isCancelled = match.status === "cancelled";
          const teamA = match.players.filter((p) => p.team === "a");
          const teamB = match.players.filter((p) => p.team === "b");
          const scoreA = match.team_a_score ?? 0;
          const scoreB = match.team_b_score ?? 0;
          const aWon = !isCancelled && scoreA > scoreB;
          const bWon = !isCancelled && scoreB > scoreA;
          const completedAt = match.completed_at
            ? new Date(match.completed_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })
            : "";

          // Highlight helpers — computed per card when a filter is active.
          const partnerIds = selectedId ? resolvePartnerIds(match, selectedId) : [];

          // Cancelled match — distinct muted styling
          if (isCancelled) {
            return (
              <div
                key={match.id}
                className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden"
              >
                {/* Header — full opacity so "Cancelled" label stays legible */}
                <div className="flex items-center justify-between bg-slate-50 dark:bg-muted/40 px-4 py-2.5 border-b border-slate-100 dark:border-border">
                  <div className="flex items-center gap-2">
                    <Ban className="h-3.5 w-3.5 text-slate-400 dark:text-muted-foreground" />
                    <span className="text-sm font-bold text-slate-500 dark:text-muted-foreground">
                      Match #{matchNumberById.get(match.id)}
                    </span>
                    {match.courtName && (
                      <span className="text-xs text-slate-400 dark:text-muted-foreground">
                        &middot; {match.courtName}
                      </span>
                    )}
                    <MatchOriginTag classification={match.final_classification} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 dark:text-muted-foreground">
                      {completedAt}
                    </span>
                    <span
                      className="rounded-full bg-slate-200 dark:bg-muted text-slate-500 dark:text-muted-foreground
                                     px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                    >
                      Cancelled
                    </span>
                  </div>
                </div>

                {/* Players — muted since match didn't complete.
                    Highlight rings use stronger opacity so they read through opacity-60. */}
                <div className="px-4 py-3 opacity-60">
                  <div className="flex gap-3">
                    <div className="flex-1 rounded-xl bg-slate-50 dark:bg-muted/50 p-3 text-center">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 dark:text-muted-foreground mb-2">
                        Team A
                      </p>
                      {teamA.map((p) => {
                        const isSelf = isFiltered && p.player_id === selectedId;
                        const isPartner = isFiltered && partnerIds.includes(p.player_id);
                        return (
                          <div key={p.player_id} className="mb-1 last:mb-0">
                            <p
                              className={[
                                "text-sm font-medium rounded px-1 py-0.5 inline-block",
                                isSelf
                                  ? "bg-cc-accent-dim outline outline-2 outline-cc-accent text-cc-accent-text"
                                  : isPartner
                                    ? "outline outline-2 outline-dashed outline-cc-accent text-slate-500 dark:text-muted-foreground"
                                    : "text-slate-500 dark:text-muted-foreground",
                              ].join(" ")}
                            >
                              {p.profile.display_name}
                            </p>
                            {isPartner && !isSelf && (
                              <p className="text-[10px] uppercase tracking-wider text-cc-t3 mt-0.5">
                                partner
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center">
                      <span className="text-xs text-slate-300 dark:text-muted-foreground/40 font-bold">
                        vs
                      </span>
                    </div>
                    <div className="flex-1 rounded-xl bg-slate-50 dark:bg-muted/50 p-3 text-center">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 dark:text-muted-foreground mb-2">
                        Team B
                      </p>
                      {teamB.map((p) => {
                        const isSelf = isFiltered && p.player_id === selectedId;
                        const isPartner = isFiltered && partnerIds.includes(p.player_id);
                        return (
                          <div key={p.player_id} className="mb-1 last:mb-0">
                            <p
                              className={[
                                "text-sm font-medium rounded px-1 py-0.5 inline-block",
                                isSelf
                                  ? "bg-cc-accent-dim outline outline-2 outline-cc-accent text-cc-accent-text"
                                  : isPartner
                                    ? "outline outline-2 outline-dashed outline-cc-accent text-slate-500 dark:text-muted-foreground"
                                    : "text-slate-500 dark:text-muted-foreground",
                              ].join(" ")}
                            >
                              {p.profile.display_name}
                            </p>
                            {isPartner && !isSelf && (
                              <p className="text-[10px] uppercase tracking-wider text-cc-t3 mt-0.5">
                                partner
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          // Completed match — full scores + static duration timer
          return (
            <div
              key={match.id}
              className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between bg-slate-50 dark:bg-muted/50 px-4 py-2.5 border-b border-slate-100 dark:border-border">
                <div className="flex items-center gap-2">
                  <Trophy className="h-3.5 w-3.5 text-slate-400 dark:text-muted-foreground" />
                  <span className="text-sm font-bold text-slate-700 dark:text-foreground">
                    Match #{matchNumberById.get(match.id)}
                  </span>
                  {match.courtName && (
                    <span className="text-xs text-slate-400 dark:text-muted-foreground">
                      &middot; {match.courtName}
                    </span>
                  )}
                  {match.is_mixed_level && (
                    <span
                      className="rounded-full border px-2 py-0.5
                                    text-[10px] font-bold uppercase tracking-wider
                                    bg-amber-100 border-amber-300 text-amber-800
                                    dark:bg-[hsl(var(--amber-accent-hsl))]/20 dark:border-[hsl(var(--amber-accent-hsl))]/50 dark:text-[hsl(var(--amber-accent-hsl))]"
                    >
                      Mixed Level
                    </span>
                  )}
                  <MatchOriginTag classification={match.final_classification} />
                </div>
                <div className="flex items-center gap-3">
                  {/* Static game-duration timer */}
                  {match.started_at && match.completed_at && (
                    <MatchTimer
                      startedAt={match.started_at}
                      endedAt={match.completed_at}
                      variant="static"
                    />
                  )}
                  <span className="text-xs text-slate-400 dark:text-muted-foreground">
                    {completedAt}
                  </span>
                  <EditMatchDialog
                    matchId={match.id}
                    initialScoreA={match.team_a_score ?? 0}
                    initialScoreB={match.team_b_score ?? 0}
                  />
                  <FixRecordSheet match={match} sessionId={sessionId} onCorrected={() => {}} />
                </div>
              </div>

              {/* Score + Teams */}
              <div className="p-4">
                {/* Score banner */}
                <div className="flex items-center justify-center gap-4 mb-4">
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${aWon ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-muted-foreground"}`}
                  >
                    {scoreA}
                  </span>
                  <span className="text-sm font-bold text-slate-300 dark:text-muted-foreground/50">
                    –
                  </span>
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${bWon ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-muted-foreground"}`}
                  >
                    {scoreB}
                  </span>
                </div>

                {/* Teams side by side */}
                <div className="flex gap-3">
                  {/* Team A */}
                  <div
                    className={`flex-1 rounded-xl p-3 text-center
                                ${aWon ? "bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200 dark:ring-emerald-700/40" : "bg-slate-50 dark:bg-muted/50"}`}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                        Team A
                      </p>
                      {aWon && (
                        <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white uppercase">
                          Win
                        </span>
                      )}
                    </div>
                    {teamA.map((p) => {
                      const isSelf = isFiltered && p.player_id === selectedId;
                      const isPartner = isFiltered && partnerIds.includes(p.player_id);
                      return (
                        <div key={p.player_id} className="mb-1 last:mb-0">
                          <p
                            className={[
                              "text-sm leading-snug rounded px-1 py-0.5 inline-block",
                              isSelf
                                ? "bg-cc-accent-dim outline outline-1 outline-cc-accent/55 text-cc-accent-text font-bold"
                                : isPartner
                                  ? "outline outline-1 outline-dashed outline-cc-accent/55 font-medium"
                                  : aWon
                                    ? "font-bold text-emerald-900 dark:text-emerald-300"
                                    : "font-medium text-slate-600 dark:text-foreground",
                            ].join(" ")}
                          >
                            {p.profile.display_name}
                          </p>
                          {isPartner && !isSelf && (
                            <p className="text-[10px] uppercase tracking-wider text-cc-t3 mt-0.5">
                              partner
                            </p>
                          )}
                          <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                        </div>
                      );
                    })}
                  </div>

                  {/* Team B */}
                  <div
                    className={`flex-1 rounded-xl p-3 text-center
                                ${bWon ? "bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200 dark:ring-emerald-700/40" : "bg-slate-50 dark:bg-muted/50"}`}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                        Team B
                      </p>
                      {bWon && (
                        <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white uppercase">
                          Win
                        </span>
                      )}
                    </div>
                    {teamB.map((p) => {
                      const isSelf = isFiltered && p.player_id === selectedId;
                      const isPartner = isFiltered && partnerIds.includes(p.player_id);
                      return (
                        <div key={p.player_id} className="mb-1 last:mb-0">
                          <p
                            className={[
                              "text-sm leading-snug rounded px-1 py-0.5 inline-block",
                              isSelf
                                ? "bg-cc-accent-dim outline outline-1 outline-cc-accent/55 text-cc-accent-text font-bold"
                                : isPartner
                                  ? "outline outline-1 outline-dashed outline-cc-accent/55 font-medium"
                                  : bWon
                                    ? "font-bold text-emerald-900 dark:text-emerald-300"
                                    : "font-medium text-slate-600 dark:text-foreground",
                            ].join(" ")}
                          >
                            {p.profile.display_name}
                          </p>
                          {isPartner && !isSelf && (
                            <p className="text-[10px] uppercase tracking-wider text-cc-t3 mt-0.5">
                              partner
                            </p>
                          )}
                          <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Provenance / modification trail */}
                <div className="mt-3 border-t border-slate-100 pt-3 dark:border-border">
                  <MatchEventTimeline
                    matchId={match.id}
                    sessionId={sessionId}
                    preCutover={match.provenance_backfilled}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend — only shown when a filter is active and there are visible matches */}
      {isFiltered && visibleMatches.length > 0 && (
        <p className="text-[10px] text-muted-foreground text-center">
          ◍ solid = selected &middot; ◌ dashed = partner
        </p>
      )}
    </div>
  );
}
