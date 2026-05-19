"use client";

// ============================================================
// useOrganizerQueue — queue state, subscriptions, and actions
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { subscribeToQueue, subscribeToProfiles } from "@/lib/realtime";
import {
  togglePlayerPause,
  removePlayerFromQueue as removePlayerFromQueueAction,
} from "@/app/actions/queue";
import type { Profile, QueueWithWaitTime } from "@/types/database";

/**
 * Factory for thin server-action wrappers that:
 *   1. Call the action with the supplied arguments.
 *   2. Return `{ error }` on failure.
 *   3. Await all refreshers in parallel on success, then return `{}`.
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

/**
 * Manages queue state, profile map, realtime subscriptions, and queue write actions.
 *
 * Uses a monotonic `fetchQueueSeq` ref to guard against stale concurrent fetches —
 * only the most recent call commits its result to state, even if an older call
 * resolves after a newer one.
 *
 * `onProfileChange` is an optional bridge callback: the composer (useOrganizerData)
 * passes it to trigger `fetchActiveMatches` when a profile realtime event arrives,
 * so match cards reflect updated skill levels without waiting for a match event.
 */
export function useOrganizerQueue(
  sessionId: string,
  supabase: SupabaseClient<Database>,
  onChannelStatusQueue?: (channelId: string, connected: boolean) => void,
  onChannelStatusProfiles?: (channelId: string, connected: boolean) => void,
  /**
   * Additional callback fired when a profile change is received via realtime.
   * The composer uses this to also trigger fetchActiveMatches so match cards
   * reflect updated skill levels without waiting for the next match change event.
   */
  onProfileChange?: () => void
): {
  queue: QueueWithWaitTime[];
  profiles: Map<string, Profile>;
  setProfiles: React.Dispatch<React.SetStateAction<Map<string, Profile>>>;
  fetchQueue: () => Promise<void>;
  loading: boolean;
  removeFromQueue: (playerId: string) => Promise<{ error?: string }>;
  pausePlayer: (playerId: string, isPaused: boolean) => Promise<{ error?: string }>;
} {
  const [queue, setQueue] = useState<QueueWithWaitTime[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [loading, setLoading] = useState(true);

  // Monotonic sequence counter — guards against stale concurrent fetches.
  const fetchQueueSeq = useRef(0);

  const fetchQueue = useCallback(async () => {
    // Capture sequence number up-front. Any newer fetchQueue call will
    // increment fetchQueueSeq.current, making our mySeq stale.
    const mySeq = ++fetchQueueSeq.current;

    // ── Phase 1: fetch waiting players from the view ──────────────
    const { data, error } = await supabase
      .from("v_queue_with_wait_time")
      .select("*")
      .eq("session_id", sessionId)
      // Must match the matchmaking sort so the organizer sees the real queue order.
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    // Abort if a newer call started while Phase 1 was in flight.
    if (mySeq !== fetchQueueSeq.current) return;

    if (error) {
      console.error("[useOrganizerQueue] fetchQueue error:", error);
    }
    if (data) {
      // ── Phase 2: merge is_paused flag ─────────────────────────────
      // v_queue_with_wait_time doesn't expose is_paused; fetch it
      // directly from queue_entries and merge in-memory.
      const { data: pauseData } = await supabase
        .from("queue_entries")
        .select("player_id, is_paused")
        .eq("session_id", sessionId);

      // Abort if a newer call started while Phase 2 was in flight.
      if (mySeq !== fetchQueueSeq.current) return;

      const pauseMap = new Map((pauseData ?? []).map((r) => [r.player_id, r.is_paused]));
      setQueue(data.map((row) => ({ ...row, is_paused: pauseMap.get(row.player_id) ?? false })));
    }
  }, [supabase, sessionId]);

  const fetchQueueProfiles = useCallback(async () => {
    const playerIds = queue.map((q) => q.player_id);
    if (playerIds.length === 0) return;
    const { data } = await supabase.from("profiles").select("*").in("id", playerIds);
    if (data) {
      setProfiles((prev) => {
        const next = new Map(prev);
        data.forEach((p) => next.set(p.id, p));
        return next;
      });
    }
  }, [supabase, queue]);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchQueue().then(() => setLoading(false));
  }, [fetchQueue]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchQueueProfiles();
  }, [fetchQueueProfiles]);

  // ── Stable refs for subscriptions ────────────────────────────
  const fetchQueueRef = useRef(fetchQueue);
  useEffect(() => {
    fetchQueueRef.current = fetchQueue;
  }, [fetchQueue]);

  // ── Realtime subscriptions ────────────────────────────────────
  useEffect(() => {
    const unsubQueue = subscribeToQueue(
      supabase,
      sessionId,
      () => fetchQueueRef.current(),
      undefined,
      onChannelStatusQueue
    );

    // Profile changes (e.g. skill override) → re-fetch queue (view includes
    // skill_level from profiles) and optionally active matches (embedded profiles).
    const unsubProfiles = subscribeToProfiles(
      supabase,
      sessionId,
      () => {
        fetchQueueRef.current();
        onProfileChange?.();
      },
      undefined,
      onChannelStatusProfiles
    );

    return () => {
      unsubQueue();
      unsubProfiles();
    };
  }, [supabase, sessionId, onChannelStatusQueue, onChannelStatusProfiles, onProfileChange]);

  // ── Queue actions ─────────────────────────────────────────────

  // removeFromQueue: delegates to the removePlayerFromQueue server action
  // which calls the remove_player_from_queue_organizer RPC atomically.
  const removeFromQueue = useAction(
    (playerId: string) => removePlayerFromQueueAction(sessionId, playerId),
    [],
    [sessionId]
  );

  // Soft pause: keeps player in queue but excludes them from matchmaking.
  const pausePlayer = useAction(
    (playerId: string, isPaused: boolean) => togglePlayerPause(sessionId, playerId, isPaused),
    [fetchQueue],
    [sessionId, fetchQueue]
  );

  return {
    queue,
    profiles,
    setProfiles,
    fetchQueue,
    loading,
    removeFromQueue,
    pausePlayer,
  };
}
