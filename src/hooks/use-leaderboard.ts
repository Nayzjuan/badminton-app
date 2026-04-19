"use client";

// ============================================================
// useLeaderboard — Data hook for the hybrid leaderboard
// ============================================================
// Fetches session or all-time leaderboard data, merges streaks,
// computes rank movement, and wires a real-time subscription so
// the board refreshes automatically when matches complete.
//
// Flash logic: tracks previous ranks in a ref. On subsequent
// fetches (not the first load), rows whose rank changed are
// added to `flashedIds` for 800 ms, then cleared.
//
// Subscription stability: follows the ref-based callback
// pattern from CLAUDE.md — the subscription useEffect only
// re-runs when supabase or sessionId changes, never on
// every state update.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import {
  getSessionLeaderboard,
  getAllTimeLeaderboard,
} from "@/app/actions/leaderboard";
import type { LeaderboardRow } from "@/types/leaderboard";

export type LeaderboardTab = "session" | "alltime";

export interface UseLeaderboardResult {
  rows: LeaderboardRow[];
  loading: boolean;
  error: string | null;
  tab: LeaderboardTab;
  setTab: (t: LeaderboardTab) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  flashedIds: Set<string>;
  refresh: () => void;
}

export function useLeaderboard(
  sessionId: string,
  initialTab: LeaderboardTab = "session"
): UseLeaderboardResult {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<LeaderboardTab>(initialTab);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());

  // Track previous ranks for flash detection
  const prevRanksRef = useRef<Map<string, number>>(new Map());
  const isFirstLoadRef = useRef(true);

  const fetchData = useCallback(async () => {
    const result =
      tab === "session"
        ? await getSessionLeaderboard(sessionId)
        : await getAllTimeLeaderboard();

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    const newRows = result.rows;
    const newRanks = new Map(newRows.map((r) => [r.player_id, r.rank]));

    // Flash rows whose rank changed — skip on initial load
    if (!isFirstLoadRef.current) {
      const flashed = new Set<string>();
      newRows.forEach((r) => {
        const prev = prevRanksRef.current.get(r.player_id);
        if (prev !== undefined && prev !== r.rank) {
          flashed.add(r.player_id);
        }
      });
      if (flashed.size > 0) {
        setFlashedIds(flashed);
        setTimeout(() => setFlashedIds(new Set()), 800);
      }
    }

    isFirstLoadRef.current = false;
    prevRanksRef.current = newRanks;
    setRows(newRows);
    setError(null);
    setLoading(false);
  }, [sessionId, tab]);

  // Re-fetch when tab switches
  useEffect(() => {
    setLoading(true);
    isFirstLoadRef.current = true;
    prevRanksRef.current = new Map();
    fetchData();
  }, [fetchData]);

  // Ref-based pattern: subscription effect only re-runs when
  // supabase or sessionId changes — not on every render
  const fetchRef = useRef(fetchData);
  fetchRef.current = fetchData;

  useEffect(() => {
    const unsub = subscribeToMatches(
      supabase,
      sessionId,
      () => fetchRef.current(),
      "leaderboard"
    );
    return unsub;
  }, [supabase, sessionId]);

  return {
    rows,
    loading,
    error,
    tab,
    setTab,
    showAdvanced,
    setShowAdvanced,
    flashedIds,
    refresh: fetchData,
  };
}
