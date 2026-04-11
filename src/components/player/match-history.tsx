"use client";

// ============================================================
// Match History — Player's completed matches this session
// ============================================================

import { useEffect, useMemo, useState } from "react";
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
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-muted-foreground text-sm">No matches yet this session.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Your completed matches will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {history.map((match, i) => {
        const isTeamA = match.team === "a";
        const myScore = isTeamA ? match.team_a_score : match.team_b_score;
        const theirScore = isTeamA ? match.team_b_score : match.team_a_score;
        const won = myScore !== null && theirScore !== null && myScore > theirScore;

        return (
          <div
            key={match.match_id}
            className="rounded-xl border border-border bg-card p-4"
          >
            {/* Header row */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Match {history.length - i}
                {match.court_name && ` — ${match.court_name}`}
              </span>
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  won
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {won ? "Won" : "Lost"}
              </span>
            </div>

            {/* Score */}
            <p className="text-2xl font-bold mt-2 text-center">
              {myScore ?? "?"} – {theirScore ?? "?"}
            </p>

            {/* Game scores (multi-set) */}
            {match.game_scores && match.game_scores.length > 0 && (
              <div className="flex justify-center gap-2 mt-1">
                {match.game_scores.map((gs) => {
                  const mine = isTeamA ? gs.team_a_score : gs.team_b_score;
                  const theirs = isTeamA ? gs.team_b_score : gs.team_a_score;
                  return (
                    <span key={gs.game_number} className="text-xs text-muted-foreground">
                      G{gs.game_number}: {mine}-{theirs}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Players */}
            <div className="mt-3 text-xs text-muted-foreground">
              <p>
                Partner: {match.teammates?.join(", ") ?? "—"}
              </p>
              <p>
                vs {match.opponents?.join(" & ") ?? "—"}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
