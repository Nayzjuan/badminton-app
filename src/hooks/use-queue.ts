"use client";

// ============================================================
// useQueue Hook — Real-time queue state for a player
// ============================================================
// Fetches the full queue for a session, subscribes to real-time
// changes, and provides the current player's queue entry plus
// their computed position and wait time.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createBrowserSupabaseClient, hasAuthSession } from "@/utils/supabase/client";
import { subscribeToQueue } from "@/lib/realtime";
import { useAuthRecoveryRefetch } from "@/hooks/use-auth-recovery-refetch";
import { joinQueueAction, checkoutPlayer } from "@/app/actions/queue";
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
  const router = useRouter();
  const pathname = usePathname();
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // Monotonic sequence guard (CLAUDE.md mandate).
  const fetchQueueSeq = useRef(0);

  // Fetch the full queue for this session.
  const fetchQueue = useCallback(async () => {
    const mySeq = ++fetchQueueSeq.current;
    const { data, error } = await supabase
      .from("queue_entries")
      .select("*")
      .eq("session_id", sessionId)
      .in("status", ["waiting", "drafted", "on_deck", "playing"])
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    if (mySeq !== fetchQueueSeq.current) return;

    if (error) {
      // Preserve stale queue — a transient failure must not null out myEntry
      // and flip the dashboard to the "not in queue" (= kicked-out) state.
      console.error("[useQueue] fetchQueue error:", error.message);
      setLoading(false);
      return;
    }

    const rows = data ?? [];
    // Empty success + no auth session = this client is running as anon and
    // RLS filtered every row (a success, so the error branch can't catch it)
    // — NOT an actually-empty queue. This page only exists for authenticated
    // players, so anon-emptiness is never authoritative — including on the
    // FIRST fetch: on a cold PWA start racing auth hydration (the player
    // unlocked their phone because the on-deck push fired), committing []
    // nulls myEntry and paints "Ready to play?" over an on-deck player. Hold
    // instead; loading stays as-is (skeleton on cold start, stale list
    // mid-session) and useAuthRecoveryRefetch refetches on recovery.
    if (rows.length === 0) {
      const authed = await hasAuthSession(supabase);
      if (mySeq !== fetchQueueSeq.current) return;
      if (!authed) {
        console.warn("[useQueue] empty queue without auth — holding state");
        return;
      }
    }

    setQueue(rows);
    setLoading(false);
  }, [supabase, sessionId]);

  // Auth recovery → refetch, so a player whose token died mid-session gets
  // their live queue back the moment the session refreshes.
  useAuthRecoveryRefetch(supabase, fetchQueue);

  // Initial fetch + real-time subscription.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchQueue();

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

  // Join queue with optimistic update.
  // Immediately inserts a 'waiting' entry into local state so the UI
  // transitions instantly, then confirms (or rolls back) via the server action.
  const joinQueue = useCallback(async () => {
    // Capture previous state + apply optimistic entry in a single setState call
    // so the snapshot is always consistent with what was replaced.
    let snapshot: QueueEntry[] = [];
    setQueue((prev) => {
      snapshot = prev;
      const existing = prev.find((q) => q.player_id === playerId);
      const now = new Date().toISOString();
      const optimistic: QueueEntry = {
        id: existing?.id ?? `optimistic-${playerId}`,
        session_id: sessionId,
        player_id: playerId,
        joined_at: now,
        games_played: existing?.games_played ?? 0,
        status: "waiting",
        position: null,
        is_paused: false,
        paused_at: null,
        created_at: existing?.created_at ?? now,
      };
      return [...prev.filter((q) => q.player_id !== playerId), optimistic];
    });

    const result = await joinQueueAction(sessionId);

    if (result.requiresRename) {
      // Flagged duplicate (L2 backstop — the page gate usually catches this
      // first). Roll back the optimistic entry and route to the rename gate.
      // Uses the current pathname (not a hardcoded /play/[id]) so this also
      // works from the club-namespaced /c/[clubSlug]/play/[id] route.
      setQueue(snapshot);
      router.push(`/rename?next=${encodeURIComponent(pathname ?? `/play/${sessionId}`)}`);
      return { error: result.error };
    }

    if (result.error) {
      setQueue(snapshot); // Rollback on failure
      return { error: result.error };
    }

    return {};
  }, [sessionId, playerId, router, pathname]);

  // Leave queue.
  // Delegates to checkoutPlayer (server action) so the atomic
  // checkout_player_cleanup_drafts RPC runs — removing the player from any
  // unpublished draft matches and cancelling those drafts if they fall below
  // 4 players. The old inline .update() skipped this cleanup entirely.
  // Note: checkoutPlayer uses auth.getUser() server-side, which always equals
  // the playerId prop in the only call site (player-dashboard.tsx).
  const leaveQueue = useCallback(async () => {
    const result = await checkoutPlayer(sessionId);
    if (result.error) return { error: result.error };
    return {};
  }, [sessionId]);

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
