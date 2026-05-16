"use client";

// ============================================================
// LeaderboardPage — Orchestrates all leaderboard variants
// ============================================================
// Three variants controlled by the `variant` prop:
//
//   player-panel    — embedded in player dashboard tab.
//                     Session stats only. No advanced toggle.
//                     Compact padding.
//
//   organizer-panel — embedded in organizer dashboard tab.
//                     Session + All-Time tabs.
//                     Advanced stats toggle (PF/PA/+/-).
//
//   standalone      — public /leaderboard/[sessionId] page.
//                     Session + All-Time tabs.
//                     Advanced stats toggle.
//                     Max-width centered layout.
//
// Data flow:
//   Session tab  → getSessionLeaderboard(sessionId)
//   All-Time tab → getAllTimeLeaderboard() (lazy: fetched on first visit)
//
// Flash: rows new to the board after a refresh pulse for 1.2 s.
// Hero card: current user's row is pinned above the table so
//   they can always see their rank without scrolling.
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, ChevronLeft, TriangleAlert } from "lucide-react";
import { StadiumLeaderboard } from "./stadium-leaderboard";
import { LeaderboardHeroCard } from "./leaderboard-hero-card";
import {
  getSessionLeaderboard,
  getAllTimeLeaderboard,
  getPlayerStats,
} from "@/app/actions/leaderboard";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import type { LeaderboardRow, LeaderboardVariant } from "@/types/leaderboard";

const MIN_SESSION_GP = 1;
const MIN_ALLTIME_GP = 10;

// ── Props ─────────────────────────────────────────────────────

/** Session metadata used by the picker when sessionId is null */
export type LeaderboardSessionOption = {
  id: string;
  name: string;
  created_at: string;
  is_active: boolean;
};

interface LeaderboardPageProps {
  /**
   * Pre-selected session. Pass null (or omit) to start on the All-Time tab
   * with a session picker on the "This Session" tab.
   */
  sessionId?: string | null;
  /** Display name shown in the header subtitle when a session is pre-selected. */
  sessionName?: string;
  /**
   * Session list for the picker — only needed when sessionId is null.
   * Ordered newest-first by the server.
   */
  sessions?: LeaderboardSessionOption[];
  /** Currently logged-in user — null for unauthenticated public page. */
  currentUserId: string | null;
  variant?: LeaderboardVariant;
}

// ── Scope tab type ────────────────────────────────────────────

type ScopeTab = "session" | "alltime";

// ── Component ─────────────────────────────────────────────────

export function LeaderboardPage({
  sessionId,
  sessionName,
  sessions,
  currentUserId,
  variant = "player-panel",
}: LeaderboardPageProps) {
  const isCompact = variant === "player-panel";
  const showAllTimeTab = variant === "organizer-panel" || variant === "standalone";
  const isCentered = variant === "standalone";

  // ── State ──────────────────────────────────────────────────
  // Default to all-time tab when no session is pre-selected (lobby use case).
  const [scopeTab, setScopeTab] = useState<ScopeTab>(sessionId ? "session" : "alltime");
  // Tracks the currently selected session (may differ from the prop after picker interaction).
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId ?? null);
  const [activeSessionName, setActiveSessionName] = useState<string | undefined>(sessionName);
  const [sessionRows, setSessionRows] = useState<LeaderboardRow[]>([]);
  const [alltimeRows, setAlltimeRows] = useState<LeaderboardRow[]>([]);
  const [sessionLoading, setSessionLoading] = useState(!!sessionId);
  const [alltimeLoading, setAlltimeLoading] = useState(false);
  const [alltimeFetched, setAlltimeFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());
  /** Raw stats for the current user regardless of MIN_GP — drives LeaderboardHeroCard */
  const [myStats, setMyStats] = useState<LeaderboardRow | null>(null);
  const [myStatsLoading, setMyStatsLoading] = useState(false);

  // Track previous row IDs to detect new entrants for flash effect.
  const prevIdsRef = useRef<Set<string>>(new Set());

  // Monotonic sequence refs (CLAUDE.md mandate): discard stale concurrent
  // fetch results so a slow-returning earlier fetch can't overwrite a
  // faster-returning later fetch's data. Critical now that realtime can
  // trigger refetches in rapid succession.
  const fetchSessionSeq = useRef(0);
  const fetchAllTimeSeq = useRef(0);

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

  // ── Fetch functions ───────────────────────────────────────
  const fetchSession = useCallback(async () => {
    if (!activeSessionId) return;
    const seq = ++fetchSessionSeq.current;
    setSessionLoading(true);
    setError(null);
    const result = await getSessionLeaderboard(activeSessionId);
    // Stale-response guard: drop this result if a newer fetch has started.
    if (seq !== fetchSessionSeq.current) return;
    setSessionLoading(false);
    if (result.success) {
      flashNewEntrants(result.rows);
      setSessionRows(result.rows);
    } else {
      setError(result.error);
    }
  }, [activeSessionId, flashNewEntrants]);

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
  // fetchSession re-memoizes when activeSessionId changes, which re-triggers this effect.
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // ── Lazy load all-time on first tab visit ─────────────────
  useEffect(() => {
    if (scopeTab === "alltime" && !alltimeFetched && !alltimeLoading) {
      fetchAllTime();
    }
  }, [scopeTab, alltimeFetched, alltimeLoading, fetchAllTime]);

  // ── Realtime: refetch session leaderboard on match changes ─
  // Why we needed this: the component used to fetch only on mount,
  // so players who opened the Leaderboard tab before any matches had
  // completed got stuck on the "No ranked players yet" empty state
  // even after games started finishing. Now any INSERT/UPDATE on the
  // matches table (most importantly status → completed and score
  // updates) triggers a debounced refetch.
  //
  // Ref-based callback (per CLAUDE.md mandate) keeps the subscription
  // stable across re-renders — subscribing only re-runs when scopeTab
  // or activeSessionId actually changes.
  //
  // Debounce 500 ms collapses bursts (score submit cascades into
  // multiple match_players updates + a matches UPDATE) into one fetch.
  //
  // Only wires up on the session scope with a real session id — the
  // all-time tab is intentionally not realtime (refresh button only).
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

  // ── Fetch current user's raw stats for the hero card ──────
  // Runs in parallel with the main board fetch whenever scope or
  // session changes. Returns a rank-0 LeaderboardRow so the hero
  // card can show the below-threshold state even when the user
  // isn't in the qualified rows.  Cancelled on unmount / dep change
  // via the cleanup flag so stale responses are never applied.
  useEffect(() => {
    if (!currentUserId) return;
    if (scopeTab === "session" && !activeSessionId) {
      // Session picker is showing — clear stale data and bail.
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

  // ── Session picker handler ────────────────────────────────
  const handleSessionPick = useCallback((s: LeaderboardSessionOption) => {
    setActiveSessionId(s.id);
    setActiveSessionName(s.name);
    setSessionRows([]); // clear stale rows immediately
    setMyStats(null); // clear stale hero card data
  }, []);

  // ── Derived state ─────────────────────────────────────────
  const activeRows = scopeTab === "session" ? sessionRows : alltimeRows;
  const activeLoading = scopeTab === "session" ? sessionLoading : alltimeLoading;
  const minGP = scopeTab === "session" ? MIN_SESSION_GP : MIN_ALLTIME_GP;
  // Show session picker when on session tab but no session is selected yet
  const showSessionPicker = scopeTab === "session" && !activeSessionId && !!sessions?.length;
  const myRow = currentUserId ? activeRows.find((r) => r.player_id === currentUserId) : null;

  const handleRefresh = () => {
    if (scopeTab === "session" && activeSessionId) fetchSession();
    else if (scopeTab === "alltime") fetchAllTime();
  };

  // ── Layout classes ────────────────────────────────────────
  const wrapperClass = [
    "space-y-4",
    isCompact ? "px-4 py-4" : "px-4 py-6",
    isCentered ? "max-w-2xl mx-auto" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Render: player-panel → Stadium layout ─────────────────
  // The compact player-panel variant short-circuits the regular table
  // and renders the dedicated Stadium component. It uses session rows
  // only (no all-time / advanced toggle in the player dashboard).
  if (isCompact) {
    return (
      <div className="px-1">
        {error && (
          <p
            role="alert"
            className="my-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        {sessionLoading && sessionRows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading leaderboard…
          </div>
        ) : sessionRows.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm font-medium text-foreground">No ranked players yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {MIN_SESSION_GP === 1
                ? "Complete at least 1 game to appear."
                : `Min. ${MIN_SESSION_GP} games to appear on the board.`}
            </p>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={sessionLoading}
              aria-label="Refresh leaderboard"
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border
                         bg-card px-3 py-1.5 text-xs font-medium text-foreground
                         hover:bg-muted transition-colors disabled:opacity-50
                         disabled:cursor-not-allowed"
            >
              <RefreshCw
                className={`h-3 w-3 ${sessionLoading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        ) : (
          <StadiumLeaderboard
            sessionName={activeSessionName}
            rows={sessionRows}
            currentUserId={currentUserId}
            onRefresh={handleRefresh}
          />
        )}
      </div>
    );
  }

  // ── Render: organizer / standalone ────────────────────────
  return (
    <div className={wrapperClass}>
      {/* StadiumLeaderboard owns its own header + refresh button —
          no duplicate header needed here. */}

      {/* ── Scope tab switcher (organizer-panel + standalone) ── */}
      {showAllTimeTab && (
        <div
          role="tablist"
          aria-label="Leaderboard scope"
          className="flex gap-1 rounded-xl bg-muted/50 p-1"
        >
          {(["session", "alltime"] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={scopeTab === tab}
              onClick={() => setScopeTab(tab)}
              className={[
                "flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors",
                scopeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {tab === "session" ? "This Session" : "All-Time"}
            </button>
          ))}
        </div>
      )}

      {/* ── Error banner ───────────────────────────────────── */}
      {error && !activeLoading && (
        <div
          className="rounded-xl border border-destructive/50 bg-destructive/10
                        px-3 py-3 text-sm text-destructive flex items-start gap-2"
        >
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">Failed to load leaderboard data.</span>
          <button
            onClick={handleRefresh}
            className="shrink-0 text-xs font-medium underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Session picker — shown when no session is selected ── */}
      {showSessionPicker && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Choose a session to view its leaderboard</p>
          <div className="space-y-2">
            {sessions!.map((s) => (
              <button
                key={s.id}
                onClick={() => handleSessionPick(s)}
                className="w-full text-left rounded-xl border border-border bg-card
                           px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">{s.name}</span>
                  {s.is_active && (
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider
                                     text-emerald-600 dark:text-emerald-400 shrink-0"
                    >
                      ● Live
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(s.created_at).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── "Change session" back button (picker mode, session selected) ── */}
      {scopeTab === "session" && activeSessionId && sessions && (
        <button
          onClick={() => {
            setActiveSessionId(null);
            setActiveSessionName(undefined);
            setSessionRows([]);
          }}
          className="flex items-center gap-1 text-xs text-muted-foreground
                     hover:text-foreground transition-colors py-2 -my-2"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Change session
        </button>
      )}

      {/* ── Hero card — always visible for logged-in users ─────
           Three states handled by LeaderboardHeroCard:
             qualified       → rank + GP + W/L + win% + streak
             below threshold → "Play N more games to appear"
             zero games      → "You haven't played yet"
           myRow  = user's row from qualified board (has real rank)
           myStats = raw stats fetched without the MIN_GP filter
           Prefer myRow so the real rank is always shown when
           available; fall back to myStats for below-threshold.
      */}
      {currentUserId && !showSessionPicker && (
        <LeaderboardHeroCard
          row={myRow ?? myStats}
          totalPlayers={activeRows.length}
          scope={scopeTab}
          loading={activeLoading || myStatsLoading}
        />
      )}

      {/* ── Leaderboard — hidden during picker ─────────────── */}
      {!showSessionPicker &&
        (activeLoading && activeRows.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : activeRows.length === 0 && !activeLoading ? (
          <div className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {scopeTab === "session"
                ? MIN_SESSION_GP === 1
                  ? "No completed games in this session yet."
                  : `No players with ${MIN_SESSION_GP}+ games yet.`
                : `No players with ${MIN_ALLTIME_GP}+ games yet.`}
            </p>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={activeLoading}
              aria-label="Refresh leaderboard"
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border
                         bg-card px-3 py-1.5 text-xs font-medium text-foreground
                         hover:bg-muted transition-colors disabled:opacity-50
                         disabled:cursor-not-allowed"
            >
              <RefreshCw
                className={`h-3 w-3 ${activeLoading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        ) : (
          <StadiumLeaderboard
            sessionName={scopeTab === "session" ? activeSessionName : undefined}
            rows={activeRows}
            currentUserId={currentUserId}
            onRefresh={handleRefresh}
          />
        ))}
    </div>
  );
}
