"use client";

// ============================================================
// useSessionCompletedPlayers — fetch players eligible for history swap
// ============================================================
// Returns all distinct players who have at least one completed match
// in the session (excluding the match being corrected). These are the
// candidates for the "FROM OTHER SESSION MATCHES" section of the
// FixRecordSheet step-2 picker.
//
// Also returns basic session stats (games, wins, losses) for each
// candidate so the organiser can visually confirm they have the right
// person ("Esmé · 3G · 2W 1L").
//
// Excludes players already in the target match (they appear in the
// "SWITCH WITHIN THIS MATCH" section which is derived from CompletedMatch
// data already in hand — no network request needed).
// ============================================================

import { useState, useCallback, useEffect, useMemo } from "react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import type { SkillLevel } from "@/types/database";

export type SessionCompletedPlayer = {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  games_played: number;
  wins: number;
  losses: number;
};

/**
 * Fetches distinct players who have at least one completed match in
 * `sessionId`, excluding players already in `excludeMatchId`.
 *
 * Returns:
 *   players — sorted by display_name ascending
 *   loading  — true while the first fetch is in flight
 *
 * Query strategy — 3 sequential DB round-trips + in-memory aggregation:
 *   1. matches        — get completed match IDs for the session (with early-exit
 *                       if none exist, avoiding steps 2–3 entirely)
 *   2. match_players  — get player+team rows with !inner join to scores
 *   3. profiles       — resolve display_name + skill_level for distinct IDs
 *   4. (in-memory)    — compute per-player GP/W/L from the already-fetched rows
 *
 * A single SQL query with window functions would also work, but would
 * require a raw RPC and always run to completion. The 3-query approach
 * bails early when the session has no other completed matches, and the
 * dataset is bounded (one session's players — typically < 30 rows).
 */
export function useSessionCompletedPlayers(
  sessionId: string,
  excludeMatchId: string
): { players: SessionCompletedPlayer[]; loading: boolean } {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [players, setPlayers] = useState<SessionCompletedPlayer[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPlayers = useCallback(async () => {
    setLoading(true);

    // Step 1: all completed match IDs in the session (excluding the target match)
    const { data: completedMatches } = await supabase
      .from("matches")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "completed")
      .neq("id", excludeMatchId);

    if (!completedMatches || completedMatches.length === 0) {
      setPlayers([]);
      setLoading(false);
      return;
    }

    const matchIds = completedMatches.map((m) => m.id);

    // Step 2: distinct player IDs from those matches (excludes current match players)
    const { data: matchPlayerRows } = await supabase
      .from("match_players")
      .select("player_id, match_id, team, matches!inner(team_a_score, team_b_score)")
      .in("match_id", matchIds);

    if (!matchPlayerRows || matchPlayerRows.length === 0) {
      setPlayers([]);
      setLoading(false);
      return;
    }

    // Step 3: fetch profiles for the distinct player IDs
    const distinctPlayerIds = [...new Set(matchPlayerRows.map((r) => r.player_id))];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name, skill_level")
      .in("id", distinctPlayerIds);

    if (!profiles) {
      setPlayers([]);
      setLoading(false);
      return;
    }

    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    // Step 4: compute per-player session stats from match_players rows
    const statsMap = new Map<string, { games: number; wins: number; losses: number }>();

    for (const row of matchPlayerRows) {
      const match = row.matches as unknown as {
        team_a_score: number | null;
        team_b_score: number | null;
      };
      const scoreA = match.team_a_score ?? 0;
      const scoreB = match.team_b_score ?? 0;
      const won = (row.team === "a" && scoreA > scoreB) || (row.team === "b" && scoreB > scoreA);

      const current = statsMap.get(row.player_id) ?? { games: 0, wins: 0, losses: 0 };
      statsMap.set(row.player_id, {
        games: current.games + 1,
        wins: current.wins + (won ? 1 : 0),
        losses: current.losses + (won ? 0 : 1),
      });
    }

    // Step 5: build result, sorted by display_name
    const result: SessionCompletedPlayer[] = distinctPlayerIds
      .map((pid) => {
        const profile = profileMap.get(pid);
        const stats = statsMap.get(pid) ?? { games: 0, wins: 0, losses: 0 };
        if (!profile) return null;
        return {
          player_id: pid,
          display_name: profile.display_name,
          skill_level: profile.skill_level as SkillLevel,
          games_played: stats.games,
          wins: stats.wins,
          losses: stats.losses,
        };
      })
      .filter((p): p is SessionCompletedPlayer => p !== null)
      .sort((a, b) => a.display_name.localeCompare(b.display_name));

    setPlayers(result);
    setLoading(false);
  }, [supabase, sessionId, excludeMatchId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPlayers();
  }, [fetchPlayers]);

  return { players, loading };
}
