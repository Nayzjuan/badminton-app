"use client";

// ============================================================
// usePlayerMatch Hook — Detects on-deck / active match assignment
// ============================================================
// Watches for matches where this player is assigned (via
// match_players) and the match is pending or in_progress.
// Provides court info and teammate/opponent names for the
// on-deck alert UI.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import type { Match, MatchPlayer, Court, Profile, Team } from "@/types/database";

interface PlayerMatchInfo {
  match: Match;
  court: Court | null;
  myTeam: Team;
  teammates: Profile[];
  opponents: Profile[];
}

interface UsePlayerMatchResult {
  /** The player's current/upcoming match, or null if none. */
  currentMatch: PlayerMatchInfo | null;
  /** Whether data is loading. */
  loading: boolean;
}

export function usePlayerMatch(
  sessionId: string,
  playerId: string
): UsePlayerMatchResult {
  const [currentMatch, setCurrentMatch] = useState<PlayerMatchInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  const fetchMyMatch = useCallback(async () => {
    // Find match_players rows for this player in active matches.
    const { data: myAssignments } = await supabase
      .from("match_players")
      .select("match_id, team")
      .eq("player_id", playerId);

    if (!myAssignments || myAssignments.length === 0) {
      setCurrentMatch(null);
      setLoading(false);
      return;
    }

    const matchIds = myAssignments.map((a) => a.match_id);

    // Find the active match (pending or in_progress) for this session.
    const { data: matches } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .in("id", matchIds)
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(1);

    if (!matches || matches.length === 0) {
      setCurrentMatch(null);
      setLoading(false);
      return;
    }

    const match = matches[0];
    const myAssignment = myAssignments.find((a) => a.match_id === match.id)!;

    // Get court info.
    let court: Court | null = null;
    if (match.court_id) {
      const { data: courtData } = await supabase
        .from("courts")
        .select("*")
        .eq("id", match.court_id)
        .single();
      court = courtData;
    }

    // Get all players in this match.
    const { data: allPlayers } = await supabase
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", match.id);

    if (!allPlayers) {
      setCurrentMatch(null);
      setLoading(false);
      return;
    }

    // Fetch profiles for all players.
    const playerIds = allPlayers.map((p) => p.player_id);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("*")
      .in("id", playerIds);

    const profileMap = new Map(
      (profiles ?? []).map((p) => [p.id, p])
    );

    const teammates: Profile[] = [];
    const opponents: Profile[] = [];

    for (const mp of allPlayers) {
      const profile = profileMap.get(mp.player_id);
      if (!profile || mp.player_id === playerId) continue;
      if (mp.team === myAssignment.team) {
        teammates.push(profile);
      } else {
        opponents.push(profile);
      }
    }

    setCurrentMatch({
      match,
      court,
      myTeam: myAssignment.team as Team,
      teammates,
      opponents,
    });
    setLoading(false);
  }, [supabase, sessionId, playerId]);

  // Initial fetch + real-time subscriptions.
  useEffect(() => {
    fetchMyMatch();

    const unsubMatches = subscribeToMatches(supabase, sessionId, () => {
      fetchMyMatch();
    });

    const unsubPlayers = subscribeToMatchPlayers(supabase, sessionId, () => {
      fetchMyMatch();
    });

    return () => {
      unsubMatches();
      unsubPlayers();
    };
  }, [supabase, sessionId, fetchMyMatch]);

  return { currentMatch, loading };
}
