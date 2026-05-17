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
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trophy, History, Ban } from "lucide-react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import { SkillBadge } from "@/components/ui/skill-badge";
import { MatchTimer } from "@/components/ui/match-timer";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import { EditMatchDialog } from "./edit-match-dialog";
import type { Match, MatchPlayer, Profile } from "@/types/database";

interface CompletedMatch extends Match {
  players: (MatchPlayer & { profile: Profile })[];
  courtName: string | null;
}

interface MatchHistoryPanelProps {
  sessionId: string;
}

export function MatchHistoryPanel({ sessionId }: MatchHistoryPanelProps) {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [matches, setMatches] = useState<CompletedMatch[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    // Fetch both completed AND cancelled matches so cancellations
    // are preserved in history (with a distinct visual treatment).
    const { data: rawMatches } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .in("status", ["completed", "cancelled"])
      .order("completed_at", { ascending: false });

    if (!rawMatches || rawMatches.length === 0) {
      setMatches([]);
      setLoading(false);
      return;
    }

    const matchIds = rawMatches.map((m) => m.id);

    // Fetch players for all matches.
    const { data: matchPlayers } = await supabase
      .from("match_players")
      .select("*")
      .in("match_id", matchIds);

    // Fetch profiles.
    const playerIds = [...new Set((matchPlayers ?? []).map((mp) => mp.player_id))];
    let profileMap = new Map<string, Profile>();
    if (playerIds.length > 0) {
      const { data: profiles } = await supabase.from("profiles").select("*").in("id", playerIds);
      profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    }

    // Fetch court names.
    const courtIds = [...new Set(rawMatches.map((m) => m.court_id).filter(Boolean))] as string[];
    let courtMap = new Map<string, string>();
    if (courtIds.length > 0) {
      const { data: courts } = await supabase.from("courts").select("id, name").in("id", courtIds);
      courtMap = new Map((courts ?? []).map((c) => [c.id, c.name]));
    }

    const enriched: CompletedMatch[] = rawMatches.map((match) => ({
      ...match,
      courtName: match.court_id ? (courtMap.get(match.court_id) ?? null) : null,
      players: (matchPlayers ?? [])
        .filter((mp) => mp.match_id === match.id)
        .map((mp) => ({
          ...mp,
          profile: profileMap.get(mp.player_id) ?? {
            id: mp.player_id,
            display_name: "Unknown",
            skill_level: "beginner" as const,
            pin: null,
            vip_tag: null,
            vip_theme: null,
            created_at: "",
            updated_at: "",
          },
        })),
    }));

    setMatches(enriched);
    setLoading(false);
  }, [supabase, sessionId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Real-time: refetch when matches change.
  const fetchRef = useRef(fetchHistory);
  // eslint-disable-next-line react-hooks/refs
  fetchRef.current = fetchHistory;
  useEffect(() => {
    const unsub = subscribeToMatches(supabase, sessionId, () => fetchRef.current(), "org-history");
    return unsub;
  }, [supabase, sessionId]);

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

  return (
    <div className="space-y-4">
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

      <div className="space-y-3">
        {matches.map((match, idx) => {
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
                      Match #{matches.length - idx}
                    </span>
                    {match.courtName && (
                      <span className="text-xs text-slate-400 dark:text-muted-foreground">
                        &middot; {match.courtName}
                      </span>
                    )}
                    <MatchOriginTag origin={match.origin} />
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

                {/* Players — muted since match didn't complete */}
                <div className="px-4 py-3 opacity-60">
                  <div className="flex gap-3">
                    <div className="flex-1 rounded-xl bg-slate-50 dark:bg-muted/50 p-3 text-center">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 dark:text-muted-foreground mb-2">
                        Team A
                      </p>
                      {teamA.map((p) => (
                        <div key={p.player_id} className="mb-1 last:mb-0">
                          <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground">
                            {p.profile.display_name}
                          </p>
                        </div>
                      ))}
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
                      {teamB.map((p) => (
                        <div key={p.player_id} className="mb-1 last:mb-0">
                          <p className="text-sm font-medium text-slate-500 dark:text-muted-foreground">
                            {p.profile.display_name}
                          </p>
                        </div>
                      ))}
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
                    Match #{matches.length - idx}
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
                  <MatchOriginTag origin={match.origin} />
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
                    {teamA.map((p) => (
                      <div key={p.player_id} className="mb-1 last:mb-0">
                        <p
                          className={`text-sm leading-snug ${aWon ? "font-bold text-emerald-900 dark:text-emerald-300" : "font-medium text-slate-600 dark:text-foreground"}`}
                        >
                          {p.profile.display_name}
                        </p>
                        <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                      </div>
                    ))}
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
                    {teamB.map((p) => (
                      <div key={p.player_id} className="mb-1 last:mb-0">
                        <p
                          className={`text-sm leading-snug ${bWon ? "font-bold text-emerald-900 dark:text-emerald-300" : "font-medium text-slate-600 dark:text-foreground"}`}
                        >
                          {p.profile.display_name}
                        </p>
                        <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

