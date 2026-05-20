"use client";

// ============================================================
// useOrganizerData — Thin composer over 4 focused sub-hooks
// ============================================================
// Public API is unchanged — all callers continue to import
// from this module without modification.
//
// Sub-hooks:
//   useOrganizerSession  — live session, realtime health, cap saturation
//   useOrganizerCourts   — court CRUD + time-limit action
//   useOrganizerQueue    — queue, profiles, pause/remove actions
//   useOrganizerMatches  — match lifecycle + draft/publish actions
// ============================================================

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EnrichedMatch } from "@/hooks/use-enriched-matches";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import type { CapSaturationPayload } from "@/lib/broadcast";
import type { MatchmakingResult } from "@/app/actions/matchmaking";
import type { SwapResult, SwapMatchPlayersResult } from "@/app/actions/swap-player";
import type { Court, Profile, QueueFullWithWaitTime, Session } from "@/types/database";
import { useOrganizerSession } from "@/hooks/use-organizer-session";
import { useOrganizerCourts } from "@/hooks/use-organizer-courts";
import { useOrganizerQueue } from "@/hooks/use-organizer-queue";
import { useOrganizerMatches } from "@/hooks/use-organizer-matches";

// EnrichedMatch type is imported from use-enriched-matches.ts.
// Re-export so existing consumers don't need to update their imports.
export type { EnrichedMatch };

export interface UseOrganizerDataResult {
  /** Live session record — updates in real-time when settings change. */
  session: Session;
  courts: Court[];
  queue: QueueFullWithWaitTime[];
  /** All active matches (pending + in_progress). */
  activeMatches: EnrichedMatch[];
  /** Pending matches — formed but waiting for a court (on-deck). */
  onDeckMatches: EnrichedMatch[];
  /**
   * Draft Mode: pending matches that are NOT yet published (hidden from
   * players and TV). Only the organizer can see and publish these.
   */
  draftMatches: EnrichedMatch[];
  /**
   * Draft Mode: pending matches that are published and visible to players
   * and the TV view.
   */
  publishedOnDeckMatches: EnrichedMatch[];
  /** In-progress matches — assigned to a court, currently playing. */
  inProgressMatches: EnrichedMatch[];
  profiles: Map<string, Profile>;
  loading: boolean;
  /**
   * True when all five realtime channels (courts, queue, matches,
   * match_players, profiles) have confirmed SUBSCRIBED status.
   */
  realtimeConnected: boolean;
  // -- Court actions --
  addCourt: (name: string) => Promise<{ error?: string }>;
  updateCourtStatus: (courtId: string, status: Court["status"]) => Promise<{ error?: string }>;
  removeCourt: (courtId: string) => Promise<{ error?: string }>;
  // -- Matchmaking --
  callNextMatch: (courtId: string) => Promise<MatchmakingResult>;
  // -- Match actions --
  createManualMatch: (teamA: string[], teamB: string[]) => Promise<{ error?: string }>;
  endMatch: (
    matchId: string,
    teamAScore: number,
    teamBScore: number
  ) => Promise<{ error?: string }>;
  cancelMatch: (matchId: string) => Promise<{ error?: string }>;
  clearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
  reorderOnDeckMatches: (orderedMatchIds: string[]) => Promise<{ error?: string }>;
  // -- Draft Mode --
  publishMatch: (matchId: string) => Promise<{ error?: string }>;
  publishAllDrafts: () => Promise<{ error?: string; publishedCount?: number }>;
  // -- Swap actions --
  swapPlayer: (matchId: string, outPlayerId: string, inPlayerId: string) => Promise<SwapResult>;
  swapMatchPlayers: (
    aMatchId: string,
    aPlayerId: string,
    bMatchId: string,
    bPlayerId: string,
    sessionId: string
  ) => Promise<SwapMatchPlayersResult>;
  // -- Queue actions --
  removeFromQueue: (playerId: string) => Promise<{ error?: string }>;
  pausePlayer: (playerId: string, isPaused: boolean) => Promise<{ error?: string }>;
  // -- Session settings --
  updateTimeLimit: (minutes: number | null) => Promise<{ error?: string }>;
  // -- Cap saturation --
  /**
   * Non-null when the partner-pair cap blocked the last match attempt.
   */
  capSaturation: CapSaturationPayload | null;
  dismissCapSaturation: () => void;
}

/**
 * Thin composer that wires four focused sub-hooks into a single stable API surface.
 *
 * Sub-hook order matters: courts provides `courtsRef` to matches; matches needs a
 * stable `fetchQueue` ref before the queue hook exists (circular dep workaround via
 * `fetchQueueRef`). Re-exports `EnrichedMatch` so existing consumers don't need to
 * update their import paths when the type was extracted.
 */
export function useOrganizerData(
  sessionId: string,
  initialSession: Session
): UseOrganizerDataResult {
  // Single Supabase client shared across all sub-hooks.
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // ── Session sub-hook ──────────────────────────────────────────
  // Owns: liveSession, realtimeConnected, capSaturation, channel health tracking.
  const {
    liveSession,
    setSession,
    realtimeConnected,
    capSaturation,
    dismissCapSaturation,
    handleChannelStatus,
  } = useOrganizerSession(sessionId, initialSession, supabase);

  // ── Courts sub-hook ───────────────────────────────────────────
  // Needs setSession for the updateTimeLimit optimistic update.
  const {
    courts,
    courtsRef,
    fetchCourts,
    loading: courtsLoading,
    addCourt,
    updateCourtStatus,
    removeCourt,
    updateTimeLimit,
  } = useOrganizerCourts(sessionId, supabase, setSession, handleChannelStatus);

  // ── onProfilesLoaded bridge ───────────────────────────────────
  // When useEnrichedMatches finishes enriching match players, it fires this
  // callback with the resulting profile Map. We merge it into the queue's
  // profiles state so player cards in the queue panel reflect updated data.
  // useCallback with setProfiles (stable dispatcher) → no deps needed.
  // onProfilesLoaded bridges useOrganizerMatches → useOrganizerQueue:
  // when match enrichment fetches player profiles, it merges them into the
  // queue's profiles Map so player cards in the queue panel stay fresh.
  // setProfiles is declared after the queue hook; captured via closure — safe
  // because React state dispatchers are stable across renders.
  const onProfilesLoaded = useCallback(
    (profileMap: Map<string, Profile>) => {
      setProfiles((prev) => {
        const next = new Map(prev);
        profileMap.forEach((v, k) => next.set(k, v));
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // stable: setProfiles dispatcher never changes identity
  );

  // ── Matches sub-hook ──────────────────────────────────────────
  // Needs courtsRef (stable) + fetchCourts + fetchQueue (passed after queue hook).
  // fetchQueue is referenced via the closure set up below — we define a stable
  // ref so the callback identity doesn't cause extra re-renders.
  // Initialized to a no-op because fetchQueue doesn't exist yet (it comes from
  // useOrganizerQueue which is called after useOrganizerMatches). The ref is
  // wired up via useEffect once fetchQueue is available.
  const fetchQueueRef = useRef<() => Promise<void>>(async () => {});

  const {
    activeMatches,
    fetchActiveMatches,
    onDeckMatches,
    draftMatches,
    publishedOnDeckMatches,
    inProgressMatches,
    loading: matchesLoading,
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
  } = useOrganizerMatches(
    sessionId,
    supabase,
    courtsRef,
    onProfilesLoaded,
    fetchCourts,
    () => fetchQueueRef.current(),
    handleChannelStatus,
    handleChannelStatus
  );

  // ── Queue sub-hook ────────────────────────────────────────────
  // fetchActiveMatches ref so profile changes also refresh match cards.
  const fetchActiveMatchesRef = useRef<() => Promise<void>>(fetchActiveMatches);
  useEffect(() => {
    fetchActiveMatchesRef.current = fetchActiveMatches;
  }, [fetchActiveMatches]);

  // Stable callback — closes over the ref so it always calls the latest
  // fetchActiveMatches without a new function identity each render.
  // This prevents the profiles realtime subscription from restarting on
  // every parent render (same pattern as handleChannelStatus pass-through).
  const onProfileChange = useCallback(
    () => fetchActiveMatchesRef.current(),
    [] // stable: fetchActiveMatchesRef is a useRef (never changes identity)
  );

  const {
    queue,
    profiles,
    setProfiles,
    fetchQueue,
    loading: queueLoading,
    removeFromQueue,
    pausePlayer,
  } = useOrganizerQueue(
    sessionId,
    supabase,
    handleChannelStatus,
    handleChannelStatus,
    onProfileChange
  );

  // Wire fetchQueue into the ref so useOrganizerMatches can call it.
  // useEffect ensures this runs after all sub-hooks have settled and
  // before any realtime events fire (subscriptions are also in useEffect).
  useEffect(() => {
    fetchQueueRef.current = fetchQueue;
  }, [fetchQueue]);

  const loading = courtsLoading || queueLoading || matchesLoading;

  return {
    session: liveSession,
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    draftMatches,
    publishedOnDeckMatches,
    inProgressMatches,
    profiles,
    loading,
    realtimeConnected,
    addCourt,
    updateCourtStatus,
    removeCourt,
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
    removeFromQueue,
    pausePlayer,
    updateTimeLimit,
    capSaturation,
    dismissCapSaturation,
  };
}
