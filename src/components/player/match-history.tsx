"use client";

// ============================================================
// Match History — Player's completed matches this session
// ============================================================
// Shows a chronological list of completed matches with clear
// Win/Lost indicators, scores, partners, and opponents.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Trophy, History } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import type { MatchHistory as MatchHistoryType } from "@/types/database";

interface MatchHistoryProps {
  sessionId: string;
  playerId: string;
}

export function MatchHistory({ sessionId, playerId }: MatchHistoryProps) {
  const [history, setHistory] = useState<MatchHistoryType[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from("v_match_history")
        .select("*")
        .eq("session_id", sessionId)
        .eq("player_id", playerId)
        .order("completed_at", { ascending: false });

      if (data) setHistory(data);
      setLoading(false);
    }
    fetch();
  }, [supabase, sessionId, playerId]);

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        Loading history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
          <History className="h-5 w-5 text-slate-400" />
        </div>
        <p className="text-sm font-medium text-slate-600">No matches yet</p>
        <p className="mt-1 text-xs text-slate-400">
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
  const losses = history.length - wins;

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="flex items-center justify-between rounded-xl bg-white border border-slate-200 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-bold text-slate-700">
            {history.length} match{history.length !== 1 ? "es" : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-bold text-emerald-600">{wins}W</span>
          <span className="text-slate-300">/</span>
          <span className="font-bold text-red-500">{losses}L</span>
        </div>
      </div>

      {/* Match list */}
      <div className="space-y-3">
        {history.map((match, i) => {
          const isTeamA = match.team === "a";
          const myScore = isTeamA ? match.team_a_score : match.team_b_score;
          const theirScore = isTeamA ? match.team_b_score : match.team_a_score;
          const won = myScore !== null && theirScore !== null && myScore > theirScore;
          const completedAt = match.completed_at
            ? new Date(match.completed_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })
            : "";

          return (
            <div
              key={match.match_id}
              className={`rounded-2xl border overflow-hidden bg-white shadow-sm
                          ${won ? "border-emerald-200" : "border-slate-200"}`}
            >
              {/* Header */}
              <div
                className={`flex items-center justify-between px-4 py-2 border-b
                            ${won ? "bg-emerald-50 border-emerald-100" : "bg-slate-50 border-slate-100"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-500">
                    Match {history.length - i}
                    {match.court_name && ` · ${match.court_name}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {completedAt && (
                    <span className="text-[10px] text-slate-400">{completedAt}</span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase
                                ${
                                  won
                                    ? "bg-emerald-500 text-white"
                                    : "bg-red-100 text-red-700"
                                }`}
                  >
                    {won ? "Won" : "Lost"}
                  </span>
                </div>
              </div>

              {/* Score + players */}
              <div className="px-4 py-3">
                {/* Big score */}
                <div className="flex items-center justify-center gap-3 mb-3">
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${won ? "text-emerald-600" : "text-slate-400"}`}
                  >
                    {myScore ?? "?"}
                  </span>
                  <span className="text-sm font-bold text-slate-300">–</span>
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${!won ? "text-red-500" : "text-slate-400"}`}
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
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                        >
                          G{gs.game_number}: {mine}-{theirs}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Players */}
                <div className="flex items-center justify-center gap-3 text-xs text-slate-500">
                  <div className="text-center">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
                      Partner
                    </p>
                    <p className="font-medium text-slate-700">
                      {match.teammates?.join(", ") ?? "—"}
                    </p>
                  </div>
                  <span className="text-slate-300">vs</span>
                  <div className="text-center">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
                      Opponents
                    </p>
                    <p className="font-medium text-slate-700">
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
