"use client";

// ============================================================
// useQueue Hook — Real-time queue state for a player
// ============================================================
// Fetches the full queue for a session, subscribes to real-time
// changes, and provides the current player's queue entry plus
// their computed position and wait time.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToQueue } from "@/lib/realtime";
import { joinQueueAction } from "@/app/actions/queue";
import type { QueueEntry } from "@/types/database";

interface UseQueueResult {
  /** All waiting/on_deck entries sorted by matchmaking priority. */
  queue: QueueEntry[];
  /** The current player's queue entry (null if not in queue). */
  myEntry: QueueEntry | null;
  /** The player's 1-based position in the waiting queue. */
  myPosition: number | null;
  /** Minutes the player has been waiting (live-updating). */
  myWaitMinutes: number;
  /** Whether data is currently loading. */
  loading: boolean;
  /** Join the queue. */
  joinQueue: () => Promise<{ error?: string }>;
  /** Leave the queue. */
  leaveQueue: () => Promise<{ error?: string }>;
  /** Manually re-fetch queue data (used by useVisibilityRefresh). */
  refresh: () => Promise<void>;
}

export function useQueue(sessionId: string, playerId: string): UseQueueResult {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  // Fetch the full queue for this session.
  const fetchQueue = useCallback(async () => {
    const { data } = await supabase
      .from("queue_entries")
      .select("*")
      .eq("session_id", sessionId)
      .in("status", ["waiting", "drafted", "on_deck", "playing"])
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    if (data) setQueue(data);
    setLoading(false);
  }, [supabase, sessionId]);

  // Initial fetch + real-time subscription.
  useEffect(() => {
    fetchQueue();

    const unsub = subscribeToQueue(supabase, sessionId, () => {
      // Re-fetch the full queue on any change for consistent ordering.
      fetchQueue();
    });

    return () => {
      unsub();
    };
  }, [supabase, sessionId, fetchQueue]);

  // Find my entry.
  const myEntry = useMemo(
    () => queue.find((q) => q.player_id === playerId) ?? null,
    [queue, playerId]
  );

  // Compute my position (1-based, among "waiting" entries only).
  const myPosition = useMemo(() => {
    if (!myEntry || myEntry.status !== "waiting") return null;
    const waitingOnly = queue.filter((q) => q.status === "waiting");
    const idx = waitingOnly.findIndex((q) => q.player_id === playerId);
    return idx >= 0 ? idx + 1 : null;
  }, [queue, myEntry, playerId]);

  // Live wait time (updates every 15 seconds via interval).
  const [myWaitMinutes, setMyWaitMinutes] = useState(0);

  useEffect(() => {
    function calc() {
      if (!myEntry || myEntry.status === "left") {
        setMyWaitMinutes(0);
        return;
      }
      const joined = new Date(myEntry.joined_at).getTime();
      const now = Date.now();
      setMyWaitMinutes(Math.floor((now - joined) / 60_000));
    }

    calc();
    const interval = setInterval(calc, 15_000);
    return () => clearInterval(interval);
  }, [myEntry]);

  // Join queue.
  // Calls the server action instead of the RPC so the Inherited Games
  // logic is applied: first-time joiners receive the session's current
  // minimum games_played rather than 0, preventing them from jumping
  // to position #1 ahead of players who have been waiting.
  const joinQueue = useCallback(async () => {
    return await joinQueueAction(sessionId);
  }, [sessionId]);

  // Leave queue.
  const leaveQueue = useCallback(async () => {
    const { error } = await supabase
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", sessionId)
      .eq("player_id", playerId);

    if (error) return { error: error.message };
    return {};
  }, [supabase, sessionId, playerId]);

  return {
    queue,
    myEntry,
    myPosition,
    myWaitMinutes,
    loading,
    joinQueue,
    leaveQueue,
    refresh: fetchQueue,
  };
}
