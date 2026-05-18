"use client";

// ============================================================
// useLeaderboard — Data + state hook for LeaderboardPage
// ============================================================
//
// Owns all fetch logic, realtime subscription, flash detection,
// monotonic sequence refs, and derived state for the leaderboard.
//
// Extracted from LeaderboardPage so:
//   - Fetch/subscription logic is testable without mounting the component
//   - The component becomes a near-pure layout renderer
//   - The flash-detection (prevIdsRef), stale-response guards
//     (fetchSessionSeq / fetchAllTimeSeq), and debounced realtime
//     refetch all have locality inside this hook
//
// Params:
//   initialSessionId   — pre-selected session from props (may be null)
//   initialSessionName — display name for the pre-selected session
//   currentUserId      — logged-in user (null for unauthenticated)
//
// Note: `use-leaderboard.ts` was previously deleted during the Stadium
// refactor; this is a re-extraction with improved type exports and the
// handleClearSession / handleSessionPick named handlers added.
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getSessionLeaderboard,
  getAllTimeLeaderboard,
  getPlayerStats,
} from "@/app/actions/leaderboard";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import type { LeaderboardRow } from "@/types/leaderboard";

// ── Constants ─────────────────────────────────────────────────

export const MIN_SESSION_GP = 1;
export const MIN_ALLTIME_GP = 10;

// ── Types ────────────────────────────────────────────────────

export type ScopeTab = "session" | "alltime";

/** Session metadata used by the picker when sessionId is null */
export type LeaderboardSessionOption = {
  id: string;
  name: string;
  created_at: string;
  is_active: boolean;
};

export interface UseLeaderboardParams {
  initialSessionId?: string | null;
  initialSessionName?: string;
  currentUserId: string | null;
}

export interface UseLeaderboardResult {
  // Scope tab
  scopeTab: ScopeTab;
  setScopeTab: (tab: ScopeTab) => void;

  // Active session (may differ from initialSessionId after picker interaction)
  activeSessionId: string | null;
  activeSessionName: string | undefined;
  /** Call when user picks a session from the picker list */
  handleSessionPick: (s: LeaderboardSessionOption) => void;
  /** Call when user hits "Change session" — clears selection back to picker */
  handleClearSession: () => void;

  // Board data
  sessionRows: LeaderboardRow[];
  alltimeRows: LeaderboardRow[];

  // Loading / error
  sessionLoading: boolean;
  alltimeLoading: boolean;
  error: string | null;

  // Flash (new row pulse for 1.2 s)
  flashedIds: Set<string>;

  // Hero card raw stats (below-threshold users)
  myStats: LeaderboardRow | null;
  myStatsLoading: boolean;

  // Derived — computed here so the component is pure layout
  activeRows: LeaderboardRow[];
  activeLoading: boolean;
  minGP: number;
  /** Current user's row in the qualified board (has real rank), or null */
  myRow: LeaderboardRow | null | undefined;
  handleRefresh: () => void;
}

// ── Hook ─────────────────────────────────────────────────────

export function useLeaderboard({
  initialSessionId,
  initialSessionName,
  currentUserId,
}: UseLeaderboardParams): UseLeaderboardResult {
  // Default to all-time tab when no session is pre-selected (lobby / standalone).
  const [scopeTab, setScopeTab] = useState<ScopeTab>(initialSessionId ? "session" : "alltime");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId ?? null);
  const [activeSessionName, setActiveSessionName] = useState<string | undefined>(
    initialSessionName
  );
  const [sessionRows, setSessionRows] = useState<LeaderboardRow[]>([]);
  const [alltimeRows, setAlltimeRows] = useState<LeaderboardRow[]>([]);
  const [sessionLoading, setSessionLoading] = useState(!!initialSessionId);
  const [alltimeLoading, setAlltimeLoading] = useState(false);
  const [alltimeFetched, setAlltimeFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());
  const [myStats, setMyStats] = useState<LeaderboardRow | null>(null);
  const [myStatsLoading, setMyStatsLoading] = useState(false);

  // ── Stale-response guards ─────────────────────────────────
  // Monotonic sequence refs (CLAUDE.md mandate): discard stale concurrent
  // fetch results so a slow-returning earlier fetch can't overwrite a
  // faster-returning later one. Critical when realtime triggers rapid refetches.
  const fetchSessionSeq = useRef(0);
  const fetchAllTimeSeq = useRef(0);

  // Track previous row IDs to detect new entrants for flash effect.
  const prevIdsRef = useRef<Set<string>>(new Set());

  // ── Flash helper ──────────────────────────────────────────
  const flashNewEntrants = useCallback((rows: LeaderboardRow[]) => {
    const toFlash = new Set<string>();
    rows.forEach((r) => {
      if (!prevIdsRef.current.has(r.player_id)) toFlash.add(r.player_id);
    });
    prevIdsRef.current = new Set(rows.map((r) => r.player_id));
    if (toFlash.size === 0) return;
    setFlashedIds(toFlash);
    setTimeout(() => setFlashedIds(new Set()), 1200);
  }, []);

  // ── Fetch: session leaderboard ────────────────────────────
  const fetchSession = useCallback(async () => {
    if (!activeSessionId) return;
    const seq = ++fetchSessionSeq.current;
    setSessionLoading(true);
    setError(null);
    const result = await getSessionLeaderboard(activeSessionId);
    // Stale-response guard: drop if a newer fetch has started.
    if (seq !== fetchSessionSeq.current) return;
    setSessionLoading(false);
    if (result.success) {
      flashNewEntrants(result.rows);
      setSessionRows(result.rows);
    } else {
      setError(result.error);
    }
  }, [activeSessionId, flashNewEntrants]);

  // ── Fetch: all-time leaderboard ───────────────────────────
  const fetchAllTime = useCallback(async () => {
    const seq = ++fetchAllTimeSeq.current;
    setAlltimeLoading(true);
    setError(null);
    const result = await getAllTimeLeaderboard();
    if (seq !== fetchAllTimeSeq.current) return;
    setAlltimeLoading(false);
    setAlltimeFetched(true);
    if (result.success) {
      setAlltimeRows(result.rows);
    } else {
      setError(result.error);
    }
  }, []);

  // ── Initial load ──────────────────────────────────────────
  // Re-triggers when activeSessionId changes (fetchSession re-memoizes).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSession();
  }, [fetchSession]);

  // ── Lazy load all-time on first tab visit ─────────────────
  useEffect(() => {
    if (scopeTab === "alltime" && !alltimeFetched && !alltimeLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAllTime();
    }
  }, [scopeTab, alltimeFetched, alltimeLoading, fetchAllTime]);

  // ── Realtime: refetch session board on match changes ──────
  // Ref-based callback (CLAUDE.md mandate) keeps the subscription
  // stable across re-renders. Re-subscribes only when scopeTab or
  // activeSessionId actually changes.
  //
  // Debounce 500 ms collapses bursts (score submit → multiple
  // match_players updates + matches UPDATE) into one refetch.
  //
  // Only active on session scope with a real sessionId.
  const fetchSessionRef = useRef(fetchSession);
  useEffect(() => {
    fetchSessionRef.current = fetchSession;
  }, [fetchSession]);

  useEffect(() => {
    if (scopeTab !== "session" || !activeSessionId) return;
    const supabase = createBrowserSupabaseClient();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => fetchSessionRef.current(), 500);
    };
    const unsubscribe = subscribeToMatches(supabase, activeSessionId, refetch, "leaderboard");
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [scopeTab, activeSessionId]);

  // ── Fetch hero card stats ─────────────────────────────────
  // Runs whenever scope or session changes. Returns raw stats without
  // the MIN_GP filter so the hero card shows below-threshold state.
  // Uses a cancelled flag (not a seq ref) because getPlayerStats is
  // not expected to be called in rapid succession.
  useEffect(() => {
    if (!currentUserId) return;
    if (scopeTab === "session" && !activeSessionId) {
      // Picker mode — clear stale data and bail.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMyStats(null);
      return;
    }

    let cancelled = false;
    setMyStats(null); // clear stale immediately while loading
    setMyStatsLoading(true);

    getPlayerStats(currentUserId, scopeTab === "session" ? activeSessionId! : null).then(
      (result) => {
        if (cancelled) return;
        setMyStatsLoading(false);
        if (result.success) setMyStats(result.row);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [currentUserId, scopeTab, activeSessionId]);

  // ── Handlers ──────────────────────────────────────────────

  const handleSessionPick = useCallback((s: LeaderboardSessionOption) => {
    setActiveSessionId(s.id);
    setActiveSessionName(s.name);
    setSessionRows([]); // clear stale rows immediately
    setMyStats(null); // clear stale hero card data
  }, []);

  const handleClearSession = useCallback(() => {
    setActiveSessionId(null);
    setActiveSessionName(undefined);
    setSessionRows([]);
  }, []);

  const handleRefresh = useCallback(() => {
    if (scopeTab === "session" && activeSessionId) fetchSession();
    else if (scopeTab === "alltime") fetchAllTime();
  }, [scopeTab, activeSessionId, fetchSession, fetchAllTime]);

  // ── Derived state ─────────────────────────────────────────

  const activeRows = scopeTab === "session" ? sessionRows : alltimeRows;
  const activeLoading = scopeTab === "session" ? sessionLoading : alltimeLoading;
  const minGP = scopeTab === "session" ? MIN_SESSION_GP : MIN_ALLTIME_GP;
  const myRow = currentUserId ? activeRows.find((r) => r.player_id === currentUserId) : null;

  return {
    scopeTab,
    setScopeTab,
    activeSessionId,
    activeSessionName,
    handleSessionPick,
    handleClearSession,
    sessionRows,
    alltimeRows,
    sessionLoading,
    alltimeLoading,
    error,
    flashedIds,
    myStats,
    myStatsLoading,
    activeRows,
    activeLoading,
    minGP,
    myRow,
    handleRefresh,
  };
}
