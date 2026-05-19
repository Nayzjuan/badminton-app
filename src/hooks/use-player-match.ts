"use client";

// ============================================================
// usePlayerMatch Hook — Detects on-deck / active match assignment
// ============================================================
// Watches for matches where this player is assigned (via
// match_players) and the match is pending or in_progress.
// Provides court info and teammate/opponent names for the
// on-deck alert UI.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import type { Match, MatchPlayer, Court, Profile, Team } from "@/types/database";

interface PlayerMatchInfo {
  match: Match;
  court: Court | null;
  myTeam: Team;
  teammates: Profile[];
  opponents: Profile[];
  /**
   * 1-based position among all pending (on-deck) matches for this session,
   * ordered by sort_order ASC then created_at ASC.
   * - 1  = next match to receive a court (highest priority)
   * - 2+ = waiting behind N-1 other pending matches
   * - null if the match is already in_progress (position is no longer relevant)
   */
  onDeckPosition: number | null;
  /** Total number of pending (on-deck) matches right now (including this one). */
  totalOnDeck: number;
}

interface UsePlayerMatchResult {
  /** The player's current/upcoming match, or null if none. */
  currentMatch: PlayerMatchInfo | null;
  /** Whether data is loading. */
  loading: boolean;
  /** Manually re-fetch match data (used by useVisibilityRefresh). */
  refresh: () => Promise<void>;
}

export function usePlayerMatch(sessionId: string, playerId: string): UsePlayerMatchResult {
  const [currentMatch, setCurrentMatch] = useState<PlayerMatchInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // ── Sequence guard ────────────────────────────────────────────
  // fetchMyMatch makes 5–6 sequential DB queries. When two Realtime
  // events fire in rapid succession (e.g., sort_order reorder AND
  // match_players update from a swap), two concurrent calls race.
  // The earlier call can finish AFTER the later one and overwrite
  // the correct fresh state with stale data.
  //
  // Guard: increment on entry, check before every setState. If a
  // newer call has started (seq advanced), silently discard.
  // Mirrors the fetchActiveMatchesSeq pattern in use-organizer-data.ts
  // and the fetchQueueSeq pattern in use-organizer-data.ts.
  const fetchMyMatchSeq = useRef(0);

  const fetchMyMatch = useCallback(async () => {
    const mySeq = ++fetchMyMatchSeq.current;

    // Find match_players rows for this player in this session's active matches.
    // P1-6: Scope by session_id via a join filter so we don't pull stale
    // assignments from historical sessions when a player reconnects.
    const { data: myAssignments } = await supabase
      .from("match_players")
      .select("match_id, team, matches!inner(session_id)")
      .eq("player_id", playerId)
      .eq("matches.session_id", sessionId);

    if (mySeq !== fetchMyMatchSeq.current) return;

    if (!myAssignments || myAssignments.length === 0) {
      setCurrentMatch(null);
      setLoading(false);
      return;
    }

    const matchIds = myAssignments.map((a) => a.match_id);

    // Find the active match (pending or in_progress) for this session.
    // Draft Mode firewall: pending matches are only visible when published.
    const { data: matches } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .in("id", matchIds)
      .or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)")
      .order("created_at", { ascending: false })
      .limit(1);

    if (mySeq !== fetchMyMatchSeq.current) return;

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

    // ── On-deck position ─────────────────────────────────────
    // Count how many pending (on-deck) matches exist in this session,
    // ordered by sort_order ASC then created_at ASC (same order as the
    // organizer's On Deck panel). Position 1 = next to receive a court.
    // Only relevant when match is still pending — once in_progress the
    // player is already on a court so position is moot.
    let onDeckPosition: number | null = null;
    let totalOnDeck = 0;

    if (match.status === "pending") {
      const { data: pendingMatches } = await supabase
        .from("matches")
        .select("id, sort_order, created_at")
        .eq("session_id", sessionId)
        .eq("status", "pending")
        .eq("is_published", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (mySeq !== fetchMyMatchSeq.current) return;

      if (pendingMatches && pendingMatches.length > 0) {
        totalOnDeck = pendingMatches.length;
        const idx = pendingMatches.findIndex((m) => m.id === match.id);
        onDeckPosition = idx >= 0 ? idx + 1 : null;
      }
    }

    // Get all players in this match.
    const { data: allPlayers } = await supabase
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", match.id);

    if (mySeq !== fetchMyMatchSeq.current) return;

    if (!allPlayers) {
      setCurrentMatch(null);
      setLoading(false);
      return;
    }

    // Fetch profiles for all players.
    const playerIds = allPlayers.map((p) => p.player_id);
    const { data: profiles } = await supabase.from("profiles").select("*").in("id", playerIds);

    if (mySeq !== fetchMyMatchSeq.current) return;

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

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
      onDeckPosition,
      totalOnDeck,
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

  return { currentMatch, loading, refresh: fetchMyMatch };
}
