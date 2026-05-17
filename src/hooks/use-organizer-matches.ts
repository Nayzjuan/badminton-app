"use client";

// ============================================================
// useOrganizerMatches — active match state, subscriptions, actions
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { useEnrichedMatches, type EnrichedMatch } from "@/hooks/use-enriched-matches";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import {
  callNextMatch as callNextMatchAction,
  type MatchmakingResult,
} from "@/app/actions/matchmaking";
import {
  endMatchAction,
  cancelMatchAction,
  createManualMatchAction,
} from "@/app/actions/match-lifecycle";
import {
  clearOnDeckMatch as clearOnDeckMatchAction,
  reorderOnDeckMatches as reorderOnDeckMatchesAction,
  publishMatchAction,
  publishAllDraftMatchesAction,
} from "@/app/actions/match-drafts";
import {
  swapPlayerInMatch as swapPlayerInMatchAction,
  swapMatchPlayers as swapMatchPlayersAction,
  type SwapResult,
  type SwapMatchPlayersResult,
} from "@/app/actions/swap-player";
import type { Court, Profile } from "@/types/database";

/**
 * Factory for thin server-action wrappers (matches context).
 */
function useAction<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<{ success: boolean; message?: string; error?: string }>,
  refreshers: (() => Promise<void>)[],
  deps: React.DependencyList
): (...args: TArgs) => Promise<{ error?: string }> {
  return useCallback(
    async (...args: TArgs): Promise<{ error?: string }> => {
      const result = await action(...args);
      if (!result.success) return { error: result.message ?? result.error ?? "Action failed" };
      await Promise.all(refreshers.map((r) => r()));
      return {};
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps
  );
}

export function useOrganizerMatches(
  sessionId: string,
  supabase: SupabaseClient<Database>,
  courtsRef: MutableRefObject<Court[]>,
  onProfilesLoaded: (profileMap: Map<string, Profile>) => void,
  fetchCourts: () => Promise<void>,
  fetchQueue: () => Promise<void>,
  onChannelStatusMatches?: (channelId: string, connected: boolean) => void,
  onChannelStatusMatchPlayers?: (channelId: string, connected: boolean) => void
): {
  activeMatches: EnrichedMatch[];
  setActiveMatches: React.Dispatch<React.SetStateAction<EnrichedMatch[]>>;
  fetchActiveMatches: () => Promise<void>;
  onDeckMatches: EnrichedMatch[];
  draftMatches: EnrichedMatch[];
  publishedOnDeckMatches: EnrichedMatch[];
  inProgressMatches: EnrichedMatch[];
  loading: boolean;
  callNextMatch: (courtId: string) => Promise<MatchmakingResult>;
  createManualMatch: (teamA: string[], teamB: string[]) => Promise<{ error?: string }>;
  endMatch: (matchId: string, teamAScore: number, teamBScore: number) => Promise<{ error?: string }>;
  cancelMatch: (matchId: string) => Promise<{ error?: string }>;
  clearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
  reorderOnDeckMatches: (orderedMatchIds: string[]) => Promise<{ error?: string }>;
  publishMatch: (matchId: string) => Promise<{ error?: string }>;
  publishAllDrafts: () => Promise<{ error?: string; publishedCount?: number }>;
  swapPlayer: (matchId: string, outPlayerId: string, inPlayerId: string) => Promise<SwapResult>;
  swapMatchPlayers: (
    aMatchId: string,
    aPlayerId: string,
    bMatchId: string,
    bPlayerId: string,
    sessionId: string
  ) => Promise<SwapMatchPlayersResult>;
} {
  const { activeMatches, setActiveMatches, fetchActiveMatches } = useEnrichedMatches(
    supabase,
    sessionId,
    courtsRef,
    { includeDrafts: true, onProfilesLoaded }
  );

  // ── Initial load ──────────────────────────────────────────────
  const [loading, setLoadingState] = React.useState(true);
  useEffect(() => {
    fetchActiveMatches().then(() => setLoadingState(false));
  }, [fetchActiveMatches]);

  // ── Stable refs for subscriptions ────────────────────────────
  const fetchActiveMatchesRef = useRef(fetchActiveMatches);
  // eslint-disable-next-line react-hooks/refs
  fetchActiveMatchesRef.current = fetchActiveMatches;

  // ── Realtime subscriptions ────────────────────────────────────
  useEffect(() => {
    const unsubMatches = subscribeToMatches(
      supabase,
      sessionId,
      () => fetchActiveMatchesRef.current(),
      undefined,
      onChannelStatusMatches
    );
    const unsubMatchPlayers = subscribeToMatchPlayers(
      supabase,
      sessionId,
      () => fetchActiveMatchesRef.current(),
      undefined,
      onChannelStatusMatchPlayers
    );
    return () => {
      unsubMatches();
      unsubMatchPlayers();
    };
  }, [supabase, sessionId, onChannelStatusMatches, onChannelStatusMatchPlayers]);

  // ── Derived match lists ───────────────────────────────────────
  const onDeckMatches = useMemo(
    () => activeMatches.filter((m) => m.status === "pending"),
    [activeMatches]
  );
  const draftMatches = useMemo(
    () => onDeckMatches.filter((m) => !m.is_published),
    [onDeckMatches]
  );
  const publishedOnDeckMatches = useMemo(
    () => onDeckMatches.filter((m) => m.is_published),
    [onDeckMatches]
  );
  const inProgressMatches = useMemo(
    () => activeMatches.filter((m) => m.status === "in_progress"),
    [activeMatches]
  );

  // ── Match actions ─────────────────────────────────────────────

  const callNextMatch = useCallback(
    async (courtId: string): Promise<MatchmakingResult> => {
      const result = await callNextMatchAction(sessionId, courtId);
      await Promise.all([fetchCourts(), fetchActiveMatches()]);
      return result;
    },
    [sessionId, fetchCourts, fetchActiveMatches]
  );

  const createManualMatch = useCallback(
    async (teamA: string[], teamB: string[]) => {
      const result = await createManualMatchAction(sessionId, teamA, teamB);
      if (!result.success) return { error: result.message };
      await Promise.all([fetchQueue(), fetchActiveMatches()]);
      return {};
    },
    [sessionId, fetchQueue, fetchActiveMatches]
  );

  const endMatch = useCallback(
    async (matchId: string, teamAScore: number, teamBScore: number) => {
      const result = await endMatchAction(matchId, teamAScore, teamBScore);
      if (!result.success) return { error: result.message };
      await Promise.all([fetchCourts(), fetchActiveMatches()]);
      return {};
    },
    [fetchCourts, fetchActiveMatches]
  );

  const cancelMatch = useAction(
    cancelMatchAction,
    [fetchCourts, fetchActiveMatches],
    [fetchCourts, fetchActiveMatches]
  );

  const clearOnDeckMatch = useAction(
    clearOnDeckMatchAction,
    [fetchQueue, fetchActiveMatches],
    [fetchQueue, fetchActiveMatches]
  );

  const reorderOnDeckMatches = useCallback(
    async (orderedMatchIds: string[]) => {
      const result = await reorderOnDeckMatchesAction(sessionId, orderedMatchIds);
      if (!result.success) return { error: result.message };
      return {};
    },
    [sessionId]
  );

  const publishMatch = useCallback(async (matchId: string): Promise<{ error?: string }> => {
    const result = await publishMatchAction(matchId);
    return result.success ? {} : { error: result.message };
  }, []);

  const publishAllDrafts = useCallback(
    async (): Promise<{ error?: string; publishedCount?: number }> => {
      const result = await publishAllDraftMatchesAction(sessionId);
      return result.success ? { publishedCount: result.publishedCount } : { error: result.message };
    },
    [sessionId]
  );

  const swapPlayer = useCallback(
    async (matchId: string, outPlayerId: string, inPlayerId: string): Promise<SwapResult> => {
      const result = await swapPlayerInMatchAction(matchId, outPlayerId, inPlayerId);
      await Promise.all([fetchQueue(), fetchActiveMatches()]);
      return result;
    },
    [fetchQueue, fetchActiveMatches]
  );

  const swapMatchPlayers = useCallback(
    async (
      aMatchId: string,
      aPlayerId: string,
      bMatchId: string,
      bPlayerId: string,
      sId: string
    ): Promise<SwapMatchPlayersResult> => {
      const result = await swapMatchPlayersAction(aMatchId, aPlayerId, bMatchId, bPlayerId, sId);
      await fetchActiveMatches();
      return result;
    },
    [fetchActiveMatches]
  );

  return {
    activeMatches,
    setActiveMatches,
    fetchActiveMatches,
    onDeckMatches,
    draftMatches,
    publishedOnDeckMatches,
    inProgressMatches,
    loading,
    callNextMatch,
    createManualMatch,
    endMatch,
    cancelMatch,
    clearOnDeckMatch,
    reorderOnDeckMatches,
    publishMatch,
    publishAllDrafts,
    swapPlayer,
    swapMatchPlayers,
  };
}
