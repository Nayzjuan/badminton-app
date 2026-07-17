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
import type { Profile, QueueFullWithWaitTime } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

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
  queue: QueueFullWithWaitTime[];
  profiles: Map<string, Profile>;
  setProfiles: React.Dispatch<React.SetStateAction<Map<string, Profile>>>;
  fetchQueue: () => Promise<void>;
  loading: boolean;
  removeFromQueue: (playerId: string) => Promise<{ error?: string }>;
  pausePlayer: (playerId: string, isPaused: boolean) => Promise<{ error?: string }>;
} {
  const [queue, setQueue] = useState<QueueFullWithWaitTime[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [loading, setLoading] = useState(true);

  // Monotonic sequence counter — guards against stale concurrent fetches.
  const fetchQueueSeq = useRef(0);

  const fetchQueue = useCallback(async () => {
    // Capture sequence number up-front. Any newer fetchQueue call will
    // increment fetchQueueSeq.current, making our mySeq stale.
    const mySeq = ++fetchQueueSeq.current;

    // Fetch waiting + drafted + on_deck players. on_deck/drafted rows are
    // visible but non-selectable in the organizer UI; only waiting rows feed
    // the matchmaking engine (engine reads v_queue_with_wait_time separately).
    const { data, error } = await supabase
      .from("v_queue_full_with_wait_time")
      .select("*")
      .eq("session_id", sessionId)
      // status_priority: on_deck=0, drafted=1, waiting=2 — then matchmaking order.
      .order("status_priority", { ascending: true })
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    if (mySeq !== fetchQueueSeq.current) return;

    if (error) {
      console.error("[useOrganizerQueue] fetchQueue error:", error);
    }
    if (data) {
      setQueue(data);
    }
  }, [supabase, sessionId]);

  // Refetch player profiles only when the SET of queued players changes.
  // Reorders and wait-time ticks produce a new queue array with the SAME
  // membership; keying the fetch on queue identity refetched profiles on every
  // such tick. playerIdsKey is a value-typed (string) effect dependency, so the
  // effect only re-runs on a real membership change; the live ids are read from
  // a ref to keep fetchQueueProfiles itself stable across reorders.
  const playerIdsKey = queue
    .map((q) => q.player_id)
    .sort()
    .join(",");
  const queueIdsRef = useRef<string[]>([]);
  useEffect(() => {
    queueIdsRef.current = queue.map((q) => q.player_id);
  }, [queue]);

  const fetchQueueProfiles = useCallback(async () => {
    const playerIds = queueIdsRef.current;
    if (playerIds.length === 0) return;
    const { data } = await supabase
      .from("profiles")
      .select(PUBLIC_PROFILE_COLUMNS)
      .in("id", playerIds);
    if (data) {
      setProfiles((prev) => {
        const next = new Map(prev);
        data.forEach((p) => next.set(p.id, { ...p, pin: null }));
        return next;
      });
    }
  }, [supabase]);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchQueue().then(() => setLoading(false));
  }, [fetchQueue]);

  // Refetch profiles on membership change (playerIdsKey), not every reorder.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchQueueProfiles();
  }, [fetchQueueProfiles, playerIdsKey]);

  // Stable ref so the profiles subscription can also refresh the profiles map on
  // VIP/skill edits — the membership-keyed effect above won't fire when only a
  // player's fields changed (their id stayed in the set).
  const fetchQueueProfilesRef = useRef(fetchQueueProfiles);
  useEffect(() => {
    fetchQueueProfilesRef.current = fetchQueueProfiles;
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

    // Profile changes (e.g. skill/VIP override) → re-fetch the queue (view
    // includes skill_level) AND the profiles map (holds vip_tag/vip_theme) so
    // field edits on players still in the queue stay fresh, then optionally
    // active matches (embedded profiles).
    const unsubProfiles = subscribeToProfiles(
      supabase,
      sessionId,
      () => {
        fetchQueueRef.current();
        fetchQueueProfilesRef.current();
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
