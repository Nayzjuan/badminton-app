"use client";

// ============================================================
// MatchHistoryPanel — Organizer view of all completed matches
// ============================================================
// Shows every completed match in the session with scores,
// team compositions, and win/loss indicators. Fetches data
// independently with its own subscription.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trophy, History } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { Match, MatchPlayer, Profile } from "@/types/database";

interface CompletedMatch extends Match {
  players: (MatchPlayer & { profile: Profile })[];
  courtName: string | null;
}

interface MatchHistoryPanelProps {
  sessionId: string;
}

export function MatchHistoryPanel({ sessionId }: MatchHistoryPanelProps) {
  const supabase = useMemo(() => createClient(), []);
  const [matches, setMatches] = useState<CompletedMatch[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    const { data: rawMatches } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .eq("status", "completed")
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
      const { data: profiles } = await supabase
        .from("profiles")
        .select("*")
        .in("id", playerIds);
      profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    }

    // Fetch court names.
    const courtIds = [...new Set(rawMatches.map((m) => m.court_id).filter(Boolean))] as string[];
    let courtMap = new Map<string, string>();
    if (courtIds.length > 0) {
      const { data: courts } = await supabase
        .from("courts")
        .select("id, name")
        .in("id", courtIds);
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
  fetchRef.current = fetchHistory;
  useEffect(() => {
    const unsub = subscribeToMatches(
      supabase,
      sessionId,
      () => fetchRef.current(),
      "org-history"
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId]);

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-slate-400">
        Loading match history...
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
          <History className="h-5 w-5 text-slate-400" />
        </div>
        <p className="text-sm font-medium text-slate-600">No completed matches yet</p>
        <p className="mt-1 text-xs text-slate-400">
          Matches will appear here once they are scored and ended.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          Completed Matches
        </h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold text-slate-600">
          {matches.length} match{matches.length !== 1 ? "es" : ""}
        </span>
      </div>

      <div className="space-y-3">
        {matches.map((match, idx) => {
          const teamA = match.players.filter((p) => p.team === "a");
          const teamB = match.players.filter((p) => p.team === "b");
          const scoreA = match.team_a_score ?? 0;
          const scoreB = match.team_b_score ?? 0;
          const aWon = scoreA > scoreB;
          const bWon = scoreB > scoreA;
          const completedAt = match.completed_at
            ? new Date(match.completed_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })
            : "";

          return (
            <div
              key={match.id}
              className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between bg-slate-50 px-4 py-2.5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Trophy className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-sm font-bold text-slate-700">
                    Match #{matches.length - idx}
                  </span>
                  {match.courtName && (
                    <span className="text-xs text-slate-400">
                      &middot; {match.courtName}
                    </span>
                  )}
                  {match.is_mixed_level && (
                    <span className="rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5
                                    text-[10px] font-bold uppercase tracking-wider text-amber-800">
                      Mixed Level
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-400">{completedAt}</span>
              </div>

              {/* Score + Teams */}
              <div className="p-4">
                {/* Score banner */}
                <div className="flex items-center justify-center gap-4 mb-4">
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${aWon ? "text-emerald-600" : "text-slate-400"}`}
                  >
                    {scoreA}
                  </span>
                  <span className="text-sm font-bold text-slate-300">–</span>
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${bWon ? "text-emerald-600" : "text-slate-400"}`}
                  >
                    {scoreB}
                  </span>
                </div>

                {/* Teams side by side */}
                <div className="flex gap-3">
                  {/* Team A */}
                  <div
                    className={`flex-1 rounded-xl p-3 text-center
                                ${aWon ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-slate-50"}`}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
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
                        <p className={`text-sm leading-snug ${aWon ? "font-bold text-emerald-900" : "font-medium text-slate-600"}`}>
                          {p.profile.display_name}
                        </p>
                        <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                      </div>
                    ))}
                  </div>

                  {/* Team B */}
                  <div
                    className={`flex-1 rounded-xl p-3 text-center
                                ${bWon ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-slate-50"}`}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
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
                        <p className={`text-sm leading-snug ${bWon ? "font-bold text-emerald-900" : "font-medium text-slate-600"}`}>
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
