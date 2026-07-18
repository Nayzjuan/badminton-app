"use client";

// ============================================================
// useMatchHistory — fetch + realtime hook for completed/cancelled
// match history in the organizer view.
// ============================================================

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import { trailingDebounce } from "@/lib/trailing-debounce";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";
import { createUnknownProfile } from "@/lib/utils";
import type { Match, MatchPlayer, Profile } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

export type CompletedMatch = Match & {
  players: (MatchPlayer & { profile: Profile })[];
  courtName: string | null;
};

/**
 * Fetches and subscribes to the completed and cancelled match history for a session.
 *
 * Runs four sequential queries (matches → match_players → profiles → courts) and
 * merges in-memory. The multi-query pattern avoids a Supabase JS nested-select
 * that would require every court and profile to be re-fetched on every match change.
 * Subscribes via `subscribeToMatches` so the panel updates automatically.
 */
export function useMatchHistory(sessionId: string) {
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
      const { data: profiles } = await supabase
        .from("profiles")
        .select(PUBLIC_PROFILE_COLUMNS)
        .in("id", playerIds);
      profileMap = new Map((profiles ?? []).map((p) => [p.id, { ...p, pin: null }]));
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
          profile: profileMap.get(mp.player_id) ?? createUnknownProfile(mp.player_id),
        })),
    }));

    setMatches(enriched);
    setLoading(false);
  }, [supabase, sessionId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHistory();
  }, [fetchHistory]);

  const fetchRef = useRef(fetchHistory);
  useEffect(() => {
    fetchRef.current = fetchHistory;
  }, [fetchHistory]);
  useEffect(() => {
    // Trailing debounce collapses a burst of match events (e.g. several games
    // completing at once) into one history refetch. fetchSeq guard stays.
    const deb = trailingDebounce(() => fetchRef.current(), REALTIME_REFETCH_DEBOUNCE_MS);
    // History shows completed/cancelled matches, so skip the far more frequent
    // draft churn: draft INSERTs (status 'pending') and pending→pending UPDATEs
    // (publish, reorder). Refetch when a row enters that set (completed/cancelled)
    // OR transitions to in_progress — the latter covers "revert to active"
    // (completed→in_progress), which we cannot distinguish from a normal draft
    // promotion because `matches` is REPLICA IDENTITY DEFAULT (payload.old holds
    // only the PK, so old.status is unavailable). Refetching on a plain promotion
    // is a harmless no-op (the completed/cancelled set is unchanged), and every
    // refetch is debounced. DELETE is always relevant (a match may leave history).
    const unsub = subscribeToMatches(
      supabase,
      sessionId,
      (payload) => {
        const newStatus = (payload.new as { status?: string })?.status;
        const relevant =
          payload.eventType === "DELETE" ||
          newStatus === "completed" ||
          newStatus === "cancelled" ||
          newStatus === "in_progress";
        if (relevant) deb.run();
      },
      "org-history"
    );
    return () => {
      deb.cancel();
      unsub();
    };
  }, [supabase, sessionId]);

  // fetchHistory is already stable (useCallback with [supabase, sessionId] deps),
  // so returning it directly is equivalent to wrapping it in another useCallback.
  return { matches, loading, refresh: fetchHistory };
}
