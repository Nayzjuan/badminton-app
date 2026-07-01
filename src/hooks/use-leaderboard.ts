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
  getMonthlyLeaderboard,
  getLeaderboardMonths,
  getPlayerStats,
  getPlayerMonthlyStats,
} from "@/app/actions/leaderboard";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { useClubSlug } from "@/hooks/use-club-slug";
import { subscribeToMatches } from "@/lib/realtime";
import { getCurrentManilaMonth, isCurrentManilaMonth, type YearMonth } from "@/lib/month";
import type { LeaderboardRow, LeaderboardMonth } from "@/types/leaderboard";

// ── Constants ─────────────────────────────────────────────────

export const MIN_SESSION_GP = 1;
export const MIN_MONTH_GP = 8;
export const MIN_ALLTIME_GP = 10;

// ── Types ────────────────────────────────────────────────────

export type ScopeTab = "session" | "monthly" | "alltime";

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
  monthlyRows: LeaderboardRow[];
  alltimeRows: LeaderboardRow[];

  // Monthly scope: selected month + the months offered by the picker
  activeMonth: YearMonth;
  availableMonths: LeaderboardMonth[];
  /** Call when the user picks a month from the picker */
  handleMonthPick: (m: LeaderboardMonth) => void;

  // Loading / error
  sessionLoading: boolean;
  monthlyLoading: boolean;
  alltimeLoading: boolean;
  error: string | null;

  /**
   * Flash (new row pulse for 1.2 s): IDs of players who are new to the board
   * since the last refetch. Maintained by the hook's flash-detection logic.
   *
   * NOTE: currently not wired to StadiumLeaderboard — the component doesn't yet
   * pass this prop. Hook maintains state correctly; connecting it requires adding
   * a `flashedIds` prop to StadiumLeaderboard and passing it at the call sites.
   */
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

/**
 * Data + state hook for the leaderboard page.
 *
 * Owns fetch, realtime subscription, flash detection, and all derived state so
 * LeaderboardPage stays a near-pure layout renderer. Switches between session-scoped
 * and all-time views via `scopeTab`. When `scopeTab` is "session" and no active
 * session is found, falls back gracefully to all-time stats.
 */
export function useLeaderboard({
  initialSessionId,
  initialSessionName,
  currentUserId,
}: UseLeaderboardParams): UseLeaderboardResult {
  // Default tab: the live session when one is in context, else the current
  // month (the lobby's headline view — O-1).
  // Active club slug when rendered under /c/[clubSlug]/… ; null on the global
  // /leaderboard (→ all-clubs = today's behavior). Session board is club-implicit.
  const clubSlug = useClubSlug();
  const [scopeTab, setScopeTab] = useState<ScopeTab>(initialSessionId ? "session" : "monthly");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId ?? null);
  const [activeSessionName, setActiveSessionName] = useState<string | undefined>(
    initialSessionName
  );
  const [sessionRows, setSessionRows] = useState<LeaderboardRow[]>([]);
  const [monthlyRows, setMonthlyRows] = useState<LeaderboardRow[]>([]);
  const [alltimeRows, setAlltimeRows] = useState<LeaderboardRow[]>([]);
  const [sessionLoading, setSessionLoading] = useState(!!initialSessionId);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [alltimeLoading, setAlltimeLoading] = useState(false);
  const [alltimeFetched, setAlltimeFetched] = useState(false);
  // Monthly scope: default to the current Manila month (re-derived on mount so
  // it rolls over naturally). availableMonths populates the picker (lazy).
  const [activeMonth, setActiveMonth] = useState<YearMonth>(() => getCurrentManilaMonth());
  const [availableMonths, setAvailableMonths] = useState<LeaderboardMonth[]>([]);
  const [monthsFetched, setMonthsFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());
  const [myStats, setMyStats] = useState<LeaderboardRow | null>(null);
  const [myStatsLoading, setMyStatsLoading] = useState(false);

  // ── Stale-response guards ─────────────────────────────────
  // Monotonic sequence refs (CLAUDE.md mandate): discard stale concurrent
  // fetch results so a slow-returning earlier fetch can't overwrite a
  // faster-returning later one. Critical when realtime triggers rapid refetches.
  const fetchSessionSeq = useRef(0);
  const fetchMonthlySeq = useRef(0);
  const fetchAllTimeSeq = useRef(0);

  // Track previous row IDs to detect new entrants for flash effect.
  const prevIdsRef = useRef<Set<string>>(new Set());

  // ── Flash helper ──────────────────────────────────────────
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const flashNewEntrants = useCallback((rows: LeaderboardRow[]) => {
    const toFlash = new Set<string>();
    rows.forEach((r) => {
      if (!prevIdsRef.current.has(r.player_id)) toFlash.add(r.player_id);
    });
    prevIdsRef.current = new Set(rows.map((r) => r.player_id));
    if (toFlash.size === 0) return;
    setFlashedIds(toFlash);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashedIds(new Set()), 1200);
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
    const result = await getAllTimeLeaderboard(clubSlug);
    if (seq !== fetchAllTimeSeq.current) return;
    setAlltimeLoading(false);
    setAlltimeFetched(true);
    if (result.success) {
      setAlltimeRows(result.rows);
    } else {
      setError(result.error);
    }
  }, [clubSlug]);

  // ── Fetch: monthly leaderboard ────────────────────────────
  // Re-memoizes on activeMonth, so switching months refetches; the seq guard
  // discards a slow prior-month result that returns after a newer pick.
  const fetchMonthly = useCallback(async () => {
    const seq = ++fetchMonthlySeq.current;
    setMonthlyLoading(true);
    setError(null);
    const result = await getMonthlyLeaderboard(activeMonth.year, activeMonth.month, clubSlug);
    if (seq !== fetchMonthlySeq.current) return;
    setMonthlyLoading(false);
    if (result.success) {
      flashNewEntrants(result.rows);
      setMonthlyRows(result.rows);
    } else {
      setError(result.error);
    }
  }, [activeMonth, flashNewEntrants, clubSlug]);

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

  // ── Monthly: fetch board on tab visit + on month change ────
  // Unlike all-time (fetch once), monthly must refetch when activeMonth changes,
  // so this depends on fetchMonthly (which re-memoizes per month).
  useEffect(() => {
    if (scopeTab !== "monthly") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMonthly();
  }, [scopeTab, fetchMonthly]);

  // ── Lazy load the month picker options on first monthly visit ──
  useEffect(() => {
    if (scopeTab !== "monthly" || monthsFetched) return;
    let cancelled = false;
    getLeaderboardMonths(clubSlug).then((result) => {
      if (cancelled) return;
      setMonthsFetched(true);
      if (result.success) setAvailableMonths(result.months);
    });
    return () => {
      cancelled = true;
    };
  }, [scopeTab, monthsFetched, clubSlug]);

  // ── Fetch hero card stats ─────────────────────────────────
  // Extracted as a stable callback so the realtime subscription can
  // also trigger it. Without this, a match completing while the player
  // is on the leaderboard tab would update the session rows (fetchSession)
  // but leave myStats stale until the user navigates away and back.
  const fetchMyStats = useCallback(async () => {
    if (!currentUserId) return;
    if (scopeTab === "session" && !activeSessionId) {
      setMyStats(null);
      return;
    }
    setMyStatsLoading(true);
    const result =
      scopeTab === "monthly"
        ? await getPlayerMonthlyStats(currentUserId, activeMonth.year, activeMonth.month, clubSlug)
        : await getPlayerStats(
            currentUserId,
            scopeTab === "session" ? activeSessionId! : null,
            clubSlug
          );
    setMyStatsLoading(false);
    if (result.success) setMyStats(result.row);
  }, [currentUserId, scopeTab, activeSessionId, activeMonth, clubSlug]);

  // Initial load + reload on scope/session change.
  useEffect(() => {
    if (!currentUserId) return;
    if (scopeTab === "session" && !activeSessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMyStats(null);
      return;
    }
    setMyStats(null); // clear stale immediately while loading
    fetchMyStats();
  }, [currentUserId, scopeTab, activeSessionId, fetchMyStats]);

  // ── Realtime: refetch session board + hero stats on match changes ──
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

  const fetchMonthlyRef = useRef(fetchMonthly);
  useEffect(() => {
    fetchMonthlyRef.current = fetchMonthly;
  }, [fetchMonthly]);

  const fetchMyStatsRef = useRef(fetchMyStats);
  useEffect(() => {
    fetchMyStatsRef.current = fetchMyStats;
  }, [fetchMyStats]);

  useEffect(() => {
    // Live updates ride a session's match stream. Subscribe for the active
    // session board, OR for the monthly board when viewing the CURRENT month
    // during a live session (new completed matches fall into this month).
    const liveSession = scopeTab === "session" && !!activeSessionId;
    const liveMonthly =
      scopeTab === "monthly" &&
      !!activeSessionId &&
      isCurrentManilaMonth(activeMonth.year, activeMonth.month);
    if (!liveSession && !liveMonthly) return;

    const supabase = createBrowserSupabaseClient();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (liveSession) fetchSessionRef.current();
        else fetchMonthlyRef.current();
        fetchMyStatsRef.current(); // keep hero card in sync with updated stats
      }, 500);
    };
    const unsubscribe = subscribeToMatches(supabase, activeSessionId!, refetch, "leaderboard");
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, [scopeTab, activeSessionId, activeMonth]);

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

  const handleMonthPick = useCallback((m: LeaderboardMonth) => {
    setActiveMonth({ year: m.year, month: m.month });
    setMonthlyRows([]); // clear stale rows immediately (loading skeleton shows)
    setMyStats(null); // clear stale hero card data
  }, []);

  const handleRefresh = useCallback(() => {
    if (scopeTab === "session" && activeSessionId) fetchSession();
    else if (scopeTab === "monthly") fetchMonthly();
    else if (scopeTab === "alltime") fetchAllTime();
  }, [scopeTab, activeSessionId, fetchSession, fetchMonthly, fetchAllTime]);

  // ── Derived state ─────────────────────────────────────────

  const activeRows =
    scopeTab === "session" ? sessionRows : scopeTab === "monthly" ? monthlyRows : alltimeRows;
  const activeLoading =
    scopeTab === "session"
      ? sessionLoading
      : scopeTab === "monthly"
        ? monthlyLoading
        : alltimeLoading;
  const minGP =
    scopeTab === "session"
      ? MIN_SESSION_GP
      : scopeTab === "monthly"
        ? MIN_MONTH_GP
        : MIN_ALLTIME_GP;
  const myRow = currentUserId ? activeRows.find((r) => r.player_id === currentUserId) : null;

  return {
    scopeTab,
    setScopeTab,
    activeSessionId,
    activeSessionName,
    handleSessionPick,
    handleClearSession,
    sessionRows,
    monthlyRows,
    alltimeRows,
    activeMonth,
    availableMonths,
    handleMonthPick,
    sessionLoading,
    monthlyLoading,
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
