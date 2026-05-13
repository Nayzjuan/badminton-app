"use client";

// ============================================================
// Match History — Player's completed matches this session
// ============================================================
// Shows a chronological list of completed matches with clear
// Won/Lost/Draw indicators, scores, partners, and opponents.
// Real-time: subscribes to match changes so new completions
// appear automatically without page reload.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trophy, History } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import type { MatchHistory as MatchHistoryType } from "@/types/database";

interface MatchHistoryProps {
  /** When provided, shows history for this session only (+ real-time updates).
   *  When omitted, shows all-time history across every session. */
  sessionId?: string;
  playerId: string;
  /** Cap the number of results returned. Default: unlimited. */
  limit?: number;
}

export function MatchHistory({ sessionId, playerId, limit }: MatchHistoryProps) {
  const [history, setHistory] = useState<MatchHistoryType[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  const fetchHistory = useCallback(async () => {
    let query = supabase
      .from("v_match_history")
      .select("*")
      .eq("player_id", playerId)
      .order("completed_at", { ascending: false });

    // Filter by session when provided.
    if (sessionId) {
      query = query.eq("session_id", sessionId);
    }

    // Cap results when a limit is given.
    if (limit) {
      query = query.limit(limit);
    }

    const { data } = await query;
    if (data) setHistory(data);
    setLoading(false);
  }, [supabase, sessionId, playerId, limit]);

  // Initial fetch.
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Real-time: only subscribe when scoped to a specific session.
  const fetchRef = useRef(fetchHistory);
  fetchRef.current = fetchHistory;

  useEffect(() => {
    if (!sessionId) return; // No real-time for all-time view.
    const unsub = subscribeToMatches(
      supabase,
      sessionId,
      () => fetchRef.current(),
      "player-history"
    );
    return unsub;
  }, [supabase, sessionId]);

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">Loading history...</div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <History className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No matches yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Your completed matches will appear here.
        </p>
      </div>
    );
  }

  // Stats summary.
  const wins = history.filter((m) => {
    const isA = m.team === "a";
    const myScore = isA ? m.team_a_score : m.team_b_score;
    const theirScore = isA ? m.team_b_score : m.team_a_score;
    return myScore !== null && theirScore !== null && myScore > theirScore;
  }).length;
  const draws = history.filter((m) => {
    const isA = m.team === "a";
    const myScore = isA ? m.team_a_score : m.team_b_score;
    const theirScore = isA ? m.team_b_score : m.team_a_score;
    return myScore !== null && theirScore !== null && myScore === theirScore;
  }).length;
  const losses = history.length - wins - draws;

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="flex items-center justify-between rounded-xl bg-card border border-border px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-bold text-foreground">
            {history.length} match{history.length !== 1 ? "es" : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-bold text-emerald-600 dark:text-emerald-400">{wins}W</span>
          <span className="text-muted-foreground/40">/</span>
          <span className="font-bold text-red-500 dark:text-red-400">{losses}L</span>
          {draws > 0 && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="font-bold text-muted-foreground">{draws}D</span>
            </>
          )}
        </div>
      </div>

      {/* Match list */}
      <div className="space-y-3">
        {history.map((match, i) => {
          const isTeamA = match.team === "a";
          const myScore = isTeamA ? match.team_a_score : match.team_b_score;
          const theirScore = isTeamA ? match.team_b_score : match.team_a_score;
          const won = myScore !== null && theirScore !== null && myScore > theirScore;
          const draw = myScore !== null && theirScore !== null && myScore === theirScore;
          const lost = !won && !draw;

          const completedDate = match.completed_at ? new Date(match.completed_at) : null;
          const dateStr = completedDate
            ? completedDate.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })
            : "";
          const timeStr = completedDate
            ? completedDate.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })
            : "";

          const borderColor = won
            ? "border-emerald-200 dark:border-emerald-800/50"
            : draw
              ? "border-slate-300 dark:border-border"
              : "border-border";
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

          return (
            <div
              key={match.match_id}
              className={`rounded-2xl border overflow-hidden bg-card shadow-sm ${borderColor}`}
            >
              {/* Header */}
              <div className={`flex items-center justify-between px-4 py-2 border-b ${headerBg}`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-500 dark:text-muted-foreground">
                    Match {history.length - i}
                    {match.court_name && ` · ${match.court_name}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {(dateStr || timeStr) && (
                    <span className="text-[10px] text-muted-foreground">
                      {dateStr}
                      {dateStr && timeStr ? " · " : ""}
                      {timeStr}
                    </span>
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
                {/* Big score */}
                <div className="flex items-center justify-center gap-3 mb-3">
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${won ? "text-emerald-600 dark:text-emerald-400" : draw ? "text-slate-500 dark:text-muted-foreground" : "text-muted-foreground"}`}
                  >
                    {myScore ?? "?"}
                  </span>
                  <span className="text-sm font-bold text-slate-300 dark:text-muted-foreground/40">
                    –
                  </span>
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${lost ? "text-red-500 dark:text-red-400" : "text-muted-foreground"}`}
                  >
                    {theirScore ?? "?"}
                  </span>
                </div>

                {/* Game scores (multi-set) */}
                {match.game_scores && match.game_scores.length > 0 && (
                  <div className="flex justify-center gap-2 mb-3">
                    {match.game_scores.map((gs) => {
                      const mine = isTeamA ? gs.team_a_score : gs.team_b_score;
                      const theirs = isTeamA ? gs.team_b_score : gs.team_a_score;
                      return (
                        <span
                          key={gs.game_number}
                          className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:text-muted-foreground"
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
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                      Partner
                    </p>
                    <p className="font-medium text-foreground">
                      {match.teammates?.join(", ") ?? "—"}
                    </p>
                  </div>
                  <span className="text-slate-300 dark:text-muted-foreground/40">vs</span>
                  <div className="text-center">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">
                      Opponents
                    </p>
                    <p className="font-medium text-foreground">
                      {match.opponents?.join(" & ") ?? "—"}
                    </p>
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
