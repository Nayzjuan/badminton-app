"use client";

// ============================================================
// useEnrichedMatches — Shared match enrichment hook
// ============================================================
// Both useOrganizerData and useSessionData run the same 4-query
// sequence: matches → match_players → profiles → enrich with courts.
// The only difference is the query filter:
//   includeDrafts: true  — organizer sees all pending matches
//                          (drafts + published) and in_progress.
//   includeDrafts: false — players/TV see only published pending +
//                          in_progress (Draft Mode firewall).
//
// The race-condition guard (seqRef) ensures that when multiple
// fetches are in flight, only the last-started call's result is
// applied — stale calls are silently discarded.
// ============================================================

import { useCallback, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Court, Match, MatchPlayer, Profile } from "@/types/database";
import type { Database } from "@/types/database";
import { createUnknownProfile } from "@/lib/utils";

/**
 * A match enriched with its player profiles and the court it is
 * assigned to (null when waiting on deck without a court).
 */
export type EnrichedMatch = Match & {
  court: Court | null;
  players: (MatchPlayer & { profile: Profile })[];
};

export interface UseEnrichedMatchesOptions {
  /**
   * When true: fetches all pending (drafts + published) + in_progress
   * matches — the organizer needs to see unpublished engine drafts.
   *
   * When false: fetches only published pending + in_progress matches,
   * enforcing the Draft Mode firewall for players and the TV view.
   */
  includeDrafts: boolean;
  /**
   * Optional callback fired after each successful enrich with the
   * resulting profile Map. Used by useOrganizerData to keep its
   * separate `profiles` state (used for the queue panel) in sync.
   */
  onProfilesLoaded?: (profileMap: Map<string, Profile>) => void;
}

/**
 * Fetches and subscribes to active matches (pending + in_progress), enriching
 * each player record with their profile and court name.
 *
 * Designed for stability — `fetchActiveMatches` identity only changes when
 * `sessionId` or `supabase` changes, so callers can safely include it in their
 * own subscription `useEffect` deps without triggering restart loops.
 *
 * Set `includeDrafts: true` to include unpublished matches (organizer view).
 * Omit or set `false` to mirror the player/TV view.
 */
export function useEnrichedMatches(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  courtsRef: MutableRefObject<Court[]>,
  options: UseEnrichedMatchesOptions
) {
  const [activeMatches, setActiveMatches] = useState<EnrichedMatch[]>([]);
  const seqRef = useRef(0);
  const { includeDrafts, onProfilesLoaded } = options;

  const fetchActiveMatches = useCallback(async () => {
    const mySeq = ++seqRef.current;

    // ── Phase 1: fetch matches ─────────────────────────────────
    const { data: matches } = includeDrafts
      ? await supabase
          .from("matches")
          .select("*")
          .eq("session_id", sessionId)
          .in("status", ["pending", "in_progress"])
          .order("sort_order", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: true })
      : await supabase
          .from("matches")
          .select("*")
          .eq("session_id", sessionId)
          // Draft Mode firewall: pending matches only visible when published.
          .or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)")
          .order("created_at", { ascending: true });

    if (mySeq !== seqRef.current) return;

    if (!matches || matches.length === 0) {
      setActiveMatches([]);
      return;
    }

    // ── Phase 2: fetch match players ───────────────────────────
    const matchIds = matches.map((m) => m.id);
    const { data: matchPlayers } = await supabase
      .from("match_players")
      .select("*")
      .in("match_id", matchIds);

    if (mySeq !== seqRef.current) return;

    // ── Phase 3: fetch profiles ────────────────────────────────
    const playerIds = [...new Set((matchPlayers ?? []).map((mp) => mp.player_id))];
    let profileMap = new Map<string, Profile>();
    if (playerIds.length > 0) {
      const { data: profileData } = await supabase.from("profiles").select("*").in("id", playerIds);

      if (mySeq !== seqRef.current) return;

      profileMap = new Map((profileData ?? []).map((p) => [p.id, p]));
    }

    // Notify caller so they can merge into their own profiles state
    // (organizer hook uses this to keep the queue panel profile data fresh).
    onProfilesLoaded?.(profileMap);

    // ── Phase 4: enrich ────────────────────────────────────────
    const enriched: EnrichedMatch[] = matches.map((match) => ({
      ...match,
      court: courtsRef.current.find((c) => c.id === match.court_id) ?? null,
      players: (matchPlayers ?? [])
        .filter((mp) => mp.match_id === match.id)
        .map((mp) => ({
          ...mp,
          profile: profileMap.get(mp.player_id) ?? createUnknownProfile(mp.player_id),
        })),
    }));

    setActiveMatches(enriched);
  // courtsRef is intentionally excluded: MutableRefObject identity is stable
  // across renders (React never reassigns the wrapper object), so listing it
  // would be redundant and misleading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId, includeDrafts, onProfilesLoaded]);

  return { activeMatches, setActiveMatches, fetchActiveMatches };
}
