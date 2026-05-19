"use client";

// ============================================================
// useTvBoard — data + realtime hook for the TV scoreboard
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { getTvData } from "@/app/actions/tv";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import type { TvMatch } from "@/app/actions/tv";
import type { MatchStatus } from "@/types/database";

// Typed constants — prevent silent breakage if MatchStatus values change.
const IN_PROGRESS: MatchStatus = "in_progress";
const PENDING: MatchStatus = "pending";

/**
 * Manages the TV board's data freshness via two mechanisms:
 *
 *   1. Realtime subscriptions — fires on match or match_player changes so
 *      the board updates instantly without waiting for the 15 s polling cycle.
 *
 *   2. 15 s polling fallback — ensures freshness when the anon Supabase role
 *      has RLS policies that filter realtime events. Without this, the board
 *      could silently go stale in production environments where anon RT access
 *      is restricted.
 *
 * Returns pre-filtered match lists so TvBoard stays a pure layout component.
 */
export function useTvBoard(
  sessionId: string,
  initialMatches: TvMatch[]
): {
  inProgress: TvMatch[];
  onDeck: TvMatch[];
  lastUpdated: Date | null;
} {
  const [matches, setMatches] = useState<TvMatch[]>(initialMatches);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const refresh = useCallback(async () => {
    const { matches: fresh } = await getTvData(sessionId);
    setMatches(fresh);
    setLastUpdated(new Date());
  }, [sessionId]);

  // Stable ref so subscription callbacks always call the latest refresh closure
  // without needing to re-create the subscription on every render.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const unsubMatches = subscribeToMatches(
      supabase,
      sessionId,
      () => refreshRef.current(),
      "tv"
    );
    const unsubPlayers = subscribeToMatchPlayers(
      supabase,
      sessionId,
      () => refreshRef.current(),
      "tv"
    );
    // Polling fallback — 15 s interval ensures board never goes stale even
    // when anon-role RLS filters realtime events before they reach the client.
    const poll = setInterval(() => refreshRef.current(), 15_000);

    return () => {
      unsubMatches();
      unsubPlayers();
      clearInterval(poll);
    };
  }, [supabase, sessionId]);

  const inProgress = useMemo(
    () => matches.filter((m) => m.status === IN_PROGRESS),
    [matches]
  );
  const onDeck = useMemo(
    () => matches.filter((m) => m.status === PENDING),
    [matches]
  );

  return { inProgress, onDeck, lastUpdated };
}
