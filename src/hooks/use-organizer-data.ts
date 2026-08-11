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
import type { CapSaturationPayload, SessionClosedPayload } from "@/lib/broadcast";
import type { CapPhaseSignal } from "@/hooks/use-organizer-session";
import type { MatchmakingResult } from "@/app/actions/matchmaking";
import type { SwapResult, SwapMatchPlayersResult } from "@/app/actions/swap-player";
import type { Court, Profile, QueueFullWithWaitTime, Session } from "@/types/database";
import { useOrganizerSession } from "@/hooks/use-organizer-session";
import { useOrganizerCourts } from "@/hooks/use-organizer-courts";
import { useOrganizerQueue } from "@/hooks/use-organizer-queue";
import { useOrganizerMatches } from "@/hooks/use-organizer-matches";
import { useVisibilityRefresh } from "@/hooks/use-visibility-refresh";

/** How often to re-poll the queue so wait-time minutes / bottleneck flags keep
 *  advancing during quiet stretches with no queue mutations (the Monitor's whole
 *  reason to exist). Visible-tab only. */
const WAIT_TIME_POLL_MS = 45_000;

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
   * Monotonic counter that ticks on every `matches` / `match_players`
   * realtime event and after each committed-match mutation. Lets consumers
   * re-derive DB-backed state (repeat-pairing counts) without opening a
   * sixth realtime channel — which would break `realtimeConnected`.
   */
  matchesRevision: number;
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
  /**
   * Draft-cap reset signal received over Broadcast, carrying the phase, the
   * originating opId (so the initiating tab can ignore its own echo) and the
   * actor's name. `phase: null` = idle; 'clearing' / 'generating' = lockout active.
   */
  capSignal: CapPhaseSignal;
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
  initialSession: Session,
  /** The viewing organizer's own id — threaded to useOrganizerSession so a
   *  co-organizer's clear/cancel toast is suppressed on the actor's own screen. */
  currentUserId: string,
  /** Passed straight through to useOrganizerSession — see its `closeHooks`. */
  closeHooks?: {
    onSessionClosed?: (payload: SessionClosedPayload) => void;
    onBroadcastStatus?: () => void;
  }
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
    capSignal,
  } = useOrganizerSession(sessionId, initialSession, supabase, currentUserId, closeHooks);

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
    matchesRevision,
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

  // ── Freshness: visibility + reconnect re-sync (headline fix) ──────────
  // The four table sub-hooks only update on live realtime events, which Supabase
  // does NOT replay after the WebSocket was suspended (tablet sleep, tab switch,
  // network blip). Without this, a co-organizer's board shows pre-sleep state
  // until some new event happens to fire per table. The player side already does
  // this; the organizer side never adopted it. Re-fetch every live slice on
  // tab-wake (throttled 5s by the hook) AND on the realtime false→true edge.
  useVisibilityRefresh(() => {
    void fetchCourts();
    void fetchQueue();
    void fetchActiveMatches();
  });

  const prevRealtimeConnectedRef = useRef(realtimeConnected);
  useEffect(() => {
    if (!prevRealtimeConnectedRef.current && realtimeConnected) {
      // Socket just reconnected — pull the slices it may have missed.
      void fetchCourts();
      void fetchQueue();
      void fetchActiveMatches();
    }
    prevRealtimeConnectedRef.current = realtimeConnected;
  }, [realtimeConnected, fetchCourts, fetchQueue, fetchActiveMatches]);

  // ── Wait-time ticker ──────────────────────────────────────────────────
  // wait_minutes / is_bottleneck come from the v_queue_full_with_wait_time view
  // and only recompute when fetchQueue runs — which is otherwise driven purely
  // by queue mutations. During a quiet session (people standing around waiting,
  // no mutations) the Monitor would freeze and never escalate a bottleneck.
  // Low-frequency poll while visible keeps the minutes advancing.
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void fetchQueue();
      }
    }, WAIT_TIME_POLL_MS);
    return () => clearInterval(id);
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
    matchesRevision,
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
    capSignal,
  };
}
