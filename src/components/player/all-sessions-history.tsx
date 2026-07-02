"use client";

// ============================================================
// AllSessionsHistory — Cross-session match history for the lobby
// ============================================================
// Fetches ALL completed matches for a player across every session,
// then groups them by session with a labeled header per group.
//
// Two queries total:
//   1. v_match_history WHERE player_id = ?  (all matches)
//   2. sessions WHERE id IN (...)           (names + dates)
//
// No real-time subscription — lobby view is read-only recap.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { History } from "lucide-react";
import { getAllSessionsHistory } from "@/app/actions/history";
import type { MatchHistory as MatchHistoryType } from "@/types/database";
import type { SessionMeta } from "@/app/actions/history";

// ── Types ──────────────────────────────────────────────────────
// SessionMeta is imported from @/app/actions/history.

interface SessionGroup {
  session: SessionMeta;
  matches: MatchHistoryType[]; // oldest → newest within the session
  wins: number;
  losses: number;
  draws: number;
}

interface AllSessionsHistoryProps {
  playerId: string;
}

// ── Helpers ────────────────────────────────────────────────────

function outcomeOf(match: MatchHistoryType) {
  const isA = match.team === "a";
  const my = isA ? match.team_a_score : match.team_b_score;
  const their = isA ? match.team_b_score : match.team_a_score;
  if (my === null || their === null) return "unknown";
  if (my > their) return "won";
  if (my === their) return "draw";
  return "lost";
}

// `showClub` labels each session with its club name — only turned on when the
// player's history actually spans more than one club, so the common
// single-club case stays uncluttered (matches only ever belong to one club,
// but /play deliberately shows every club a player is in — see route-9).
function sessionLabel(session: SessionMeta, showClub: boolean): string {
  const date = new Date(session.created_at);
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const base = session.name ? `${session.name} · ${dateStr}` : dateStr;
  if (showClub && session.club_name) return `${session.club_name} · ${base}`;
  return base;
}

// ── Match card (visual clone of MatchHistory card) ─────────────

function MatchCard({
  match,
  index,
  total,
}: {
  match: MatchHistoryType;
  index: number; // 0-based, oldest first
  total: number;
}) {
  const isTeamA = match.team === "a";
  const myScore = isTeamA ? match.team_a_score : match.team_b_score;
  const theirScore = isTeamA ? match.team_b_score : match.team_a_score;
  const outcome = outcomeOf(match);
  const won = outcome === "won";
  const draw = outcome === "draw";
  const lost = outcome === "lost";

  const timeStr = match.completed_at
    ? new Date(match.completed_at).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  const borderColor = won
    ? "border-emerald-200 dark:border-emerald-800/50"
    : draw
      ? "border-slate-300 dark:border-border"
      : "border-slate-200 dark:border-border";

  const headerBg = won
    ? "bg-emerald-50 border-emerald-100 dark:bg-emerald-950/30 dark:border-emerald-800/40"
    : draw
      ? "bg-slate-100 border-slate-200 dark:bg-muted/60 dark:border-border"
      : "bg-slate-50 border-slate-100 dark:bg-muted/40 dark:border-border";

  const badgeStyle = won
    ? "bg-emerald-500 text-white"
    : draw
      ? "bg-slate-400 text-white dark:bg-slate-600"
      : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";

  const badgeLabel = won ? "Won" : draw ? "Draw" : "Lost";

  const scoreColorMine = won
    ? "text-emerald-600 dark:text-emerald-400"
    : draw
      ? "text-slate-500 dark:text-muted-foreground"
      : "text-slate-400 dark:text-muted-foreground";

  const scoreColorTheirs = lost
    ? "text-red-500 dark:text-red-400"
    : "text-slate-400 dark:text-muted-foreground";

  return (
    <div
      className={`rounded-2xl border overflow-hidden bg-white dark:bg-card shadow-sm ${borderColor}`}
    >
      {/* Card header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${headerBg}`}>
        <span className="text-xs font-medium text-slate-500 dark:text-muted-foreground">
          Match {index + 1} of {total}
          {match.court_name ? ` · ${match.court_name}` : ""}
        </span>
        <div className="flex items-center gap-2">
          {timeStr && (
            <span className="text-[10px] text-slate-400 dark:text-muted-foreground">{timeStr}</span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badgeStyle}`}
          >
            {badgeLabel}
          </span>
        </div>
      </div>

      {/* Score + players */}
      <div className="px-4 py-3">
        {/* Score */}
        <div className="flex items-center justify-center gap-3 mb-3">
          <span className={`text-3xl font-black tabular-nums ${scoreColorMine}`}>
            {myScore ?? "?"}
          </span>
          <span className="text-sm font-bold text-slate-300 dark:text-muted-foreground/40">–</span>
          <span className={`text-3xl font-black tabular-nums ${scoreColorTheirs}`}>
            {theirScore ?? "?"}
          </span>
        </div>

        {/* Multi-set scores */}
        {match.game_scores && match.game_scores.length > 0 && (
          <div className="flex justify-center gap-2 mb-3">
            {match.game_scores.map((gs) => {
              const mine = isTeamA ? gs.team_a_score : gs.team_b_score;
              const theirs = isTeamA ? gs.team_b_score : gs.team_a_score;
              return (
                <span
                  key={gs.game_number}
                  className="rounded-full bg-slate-100 dark:bg-muted px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:text-muted-foreground"
                >
                  G{gs.game_number}: {mine}-{theirs}
                </span>
              );
            })}
          </div>
        )}

        {/* Players */}
        <div className="flex items-center justify-center gap-3 text-xs text-slate-500 dark:text-muted-foreground">
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground mb-0.5">
              Partner
            </p>
            <p className="font-medium text-slate-700 dark:text-foreground">
              {match.teammates?.join(", ") ?? "—"}
            </p>
          </div>
          <span className="text-slate-300 dark:text-muted-foreground/40">vs</span>
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground mb-0.5">
              Opponents
            </p>
            <p className="font-medium text-slate-700 dark:text-foreground">
              {match.opponents?.join(" & ") ?? "—"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Session group section ──────────────────────────────────────

function SessionSection({ group, showClub }: { group: SessionGroup; showClub: boolean }) {
  const [open, setOpen] = useState(true);
  // Memoize the label — toLocaleDateString parses a Date on every call, which
  // is cheap but wasteful since the session object never changes once loaded.
  const label = useMemo(() => sessionLabel(group.session, showClub), [group.session, showClub]);
  const winPct =
    group.matches.length > 0 ? Math.round((group.wins / group.matches.length) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* Session header — acts as a toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* Collapse indicator */}
          <span
            className="text-muted-foreground transition-transform duration-200"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}
          >
            ▶
          </span>
          <span className="text-sm font-bold text-foreground truncate">{label}</span>
        </div>

        {/* Session W/L pill */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-bold text-muted-foreground">
            {group.matches.length}G
          </span>
          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
            {group.wins}W
          </span>
          <span className="text-[10px] font-bold text-red-500 dark:text-red-400">
            {group.losses}L
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-black tabular-nums
              ${
                winPct >= 50
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              }`}
          >
            {winPct}%
          </span>
        </div>
      </button>

      {/* Match cards */}
      {open && (
        <div className="space-y-3 pl-4 border-l-2 border-border">
          {group.matches.map((match, i) => (
            <MatchCard key={match.match_id} match={match} index={i} total={group.matches.length} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Root component ─────────────────────────────────────────────

export function AllSessionsHistory({ playerId }: AllSessionsHistoryProps) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setFetchError(null);
    const result = await getAllSessionsHistory(playerId);

    if (!result.success) {
      setFetchError("Failed to load match history. Please refresh.");
      setLoading(false);
      return;
    }

    const { matches, sessions } = result;

    if (matches.length === 0) {
      setLoading(false);
      return;
    }

    // Unique session IDs, preserving newest-session-first order.
    const sessionIdOrder: string[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      if (!seen.has(m.session_id)) {
        seen.add(m.session_id);
        sessionIdOrder.push(m.session_id);
      }
    }

    const sessionMap = new Map<string, SessionMeta>(sessions.map((s) => [s.id, s]));

    // Group matches by session (newest-session-first, oldest match first within each session).
    const matchesBySession = new Map<string, MatchHistoryType[]>();
    for (const m of matches) {
      const arr = matchesBySession.get(m.session_id) ?? [];
      arr.push(m);
      matchesBySession.set(m.session_id, arr);
    }

    const grouped: SessionGroup[] = sessionIdOrder.map((sid) => {
      const sessionMatches = (matchesBySession.get(sid) ?? []).slice().reverse();
      const wins = sessionMatches.filter((m) => outcomeOf(m) === "won").length;
      const draws = sessionMatches.filter((m) => outcomeOf(m) === "draw").length;

      const fallbackSession: SessionMeta = {
        id: sid,
        name: null,
        created_at: sessionMatches[0]?.completed_at ?? new Date().toISOString(),
        ended_at: null,
        club_id: null,
        club_name: null,
      };

      return {
        session: sessionMap.get(sid) ?? fallbackSession,
        matches: sessionMatches,
        wins,
        losses: sessionMatches.length - wins - draws,
        draws,
      };
    });

    setGroups(grouped);
    setLoading(false);
  }, [playerId]);

  // fetchAll is a stable useCallback (deps: playerId). It calls the
  // getAllSessionsHistory server action — no browser client needed.
  // No infinite-loop risk: fetchAll identity only changes when playerId changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading match history">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-3">
            {/* Session header row skeleton */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded bg-muted animate-pulse" />
                <div className="h-4 w-44 rounded-full bg-muted animate-pulse" />
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-6 rounded-full bg-muted animate-pulse" />
                <div className="h-3 w-6 rounded-full bg-muted animate-pulse" />
                <div className="h-5 w-10 rounded-full bg-muted animate-pulse" />
              </div>
            </div>
            {/* One match-card skeleton per group */}
            <div className="pl-4 border-l-2 border-border space-y-3">
              <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
                {/* Card header */}
                <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/40 dark:bg-muted/30">
                  <div className="h-3 w-24 rounded-full bg-muted animate-pulse" />
                  <div className="h-4 w-12 rounded-full bg-muted animate-pulse" />
                </div>
                {/* Score + players */}
                <div className="px-4 py-3 space-y-3">
                  <div className="flex items-center justify-center gap-3">
                    <div className="h-8 w-7 rounded bg-muted animate-pulse" />
                    <div className="h-4 w-3 rounded bg-muted/50 animate-pulse" />
                    <div className="h-8 w-7 rounded bg-muted animate-pulse" />
                  </div>
                  <div className="flex items-center justify-center gap-4">
                    <div className="h-3.5 w-20 rounded-full bg-muted animate-pulse" />
                    <div className="h-3 w-4 rounded bg-muted/50 animate-pulse" />
                    <div className="h-3.5 w-20 rounded-full bg-muted animate-pulse" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="rounded-2xl border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-950/30 px-6 py-8 text-center">
        <p className="text-sm font-medium text-red-700 dark:text-red-400">{fetchError}</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <History className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No matches yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Your completed matches will appear here once you start playing.
        </p>
      </div>
    );
  }

  const showClub = new Set(groups.map((g) => g.session.club_id).filter(Boolean)).size > 1;

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <SessionSection key={group.session.id} group={group} showClub={showClub} />
      ))}
    </div>
  );
}
