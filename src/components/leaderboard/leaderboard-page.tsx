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
import { Trophy, RefreshCw, ChevronLeft } from "lucide-react";
import { LeaderboardTable } from "./leaderboard-table";
import { AdvancedStatsToggle } from "./advanced-stats-toggle";
import { VipTag } from "@/components/ui/vip-tag";
import { getSessionLeaderboard, getAllTimeLeaderboard } from "@/app/actions/leaderboard";
import type { LeaderboardRow, LeaderboardVariant } from "@/types/leaderboard";

const MIN_SESSION_GP = 3;
const MIN_ALLTIME_GP = 10;

const MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

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
  const isCompact       = variant === "player-panel";
  const showAllTimeTab  = variant === "organizer-panel" || variant === "standalone";
  const showAdvToggle   = variant === "organizer-panel" || variant === "standalone";
  const isCentered      = variant === "standalone";

  // ── State ──────────────────────────────────────────────────
  // Default to all-time tab when no session is pre-selected (lobby use case).
  const [scopeTab,         setScopeTab]       = useState<ScopeTab>(sessionId ? "session" : "alltime");
  // Tracks the currently selected session (may differ from the prop after picker interaction).
  const [activeSessionId,  setActiveSessionId] = useState<string | null>(sessionId ?? null);
  const [activeSessionName, setActiveSessionName] = useState<string | undefined>(sessionName);
  const [sessionRows,      setSessionRows]    = useState<LeaderboardRow[]>([]);
  const [alltimeRows,      setAlltimeRows]    = useState<LeaderboardRow[]>([]);
  const [sessionLoading,   setSessionLoading] = useState(!!sessionId);
  const [alltimeLoading,   setAlltimeLoading] = useState(false);
  const [alltimeFetched,   setAlltimeFetched] = useState(false);
  const [error,            setError]          = useState<string | null>(null);
  const [showAdvanced,     setShowAdvanced]   = useState(false);
  const [flashedIds,       setFlashedIds]     = useState<Set<string>>(new Set());

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

  // ── Fetch functions ───────────────────────────────────────
  const fetchSession = useCallback(async () => {
    if (!activeSessionId) return;
    setSessionLoading(true);
    setError(null);
    const result = await getSessionLeaderboard(activeSessionId);
    setSessionLoading(false);
    if (result.success) {
      flashNewEntrants(result.rows);
      setSessionRows(result.rows);
    } else {
      setError(result.error);
    }
  }, [activeSessionId, flashNewEntrants]);

  const fetchAllTime = useCallback(async () => {
    setAlltimeLoading(true);
    setError(null);
    const result = await getAllTimeLeaderboard();
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
  useEffect(() => { fetchSession(); }, [fetchSession]);

  // ── Lazy load all-time on first tab visit ─────────────────
  useEffect(() => {
    if (scopeTab === "alltime" && !alltimeFetched && !alltimeLoading) {
      fetchAllTime();
    }
  }, [scopeTab, alltimeFetched, alltimeLoading, fetchAllTime]);

  // ── Session picker handler ────────────────────────────────
  const handleSessionPick = useCallback((s: LeaderboardSessionOption) => {
    setActiveSessionId(s.id);
    setActiveSessionName(s.name);
    setSessionRows([]); // clear stale rows immediately
  }, []);

  // ── Derived state ─────────────────────────────────────────
  const activeRows    = scopeTab === "session" ? sessionRows    : alltimeRows;
  const activeLoading = scopeTab === "session" ? sessionLoading : alltimeLoading;
  const minGP         = scopeTab === "session" ? MIN_SESSION_GP : MIN_ALLTIME_GP;
  const showRankMov   = scopeTab === "alltime";
  // Show session picker when on session tab but no session is selected yet
  const showSessionPicker = scopeTab === "session" && !activeSessionId && !!sessions?.length;
  const myRow         = currentUserId
    ? activeRows.find((r) => r.player_id === currentUserId)
    : null;

  const handleRefresh = () => {
    if (scopeTab === "session" && activeSessionId) fetchSession();
    else if (scopeTab === "alltime") fetchAllTime();
  };

  // ── Layout classes ────────────────────────────────────────
  const wrapperClass = [
    "space-y-4",
    isCompact  ? "px-4 py-4"      : "px-4 py-6",
    isCentered ? "max-w-2xl mx-auto" : "",
  ].filter(Boolean).join(" ");

  // ── Render ────────────────────────────────────────────────
  return (
    <div className={wrapperClass}>

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Trophy
            className="h-5 w-5 text-amber-500 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground leading-tight">
              Leaderboard
            </h2>
            {activeSessionName && scopeTab === "session" && (
              <p className="text-xs text-muted-foreground truncate">
                {activeSessionName}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {showAdvToggle && (
            <AdvancedStatsToggle
              isOpen={showAdvanced}
              onToggle={() => setShowAdvanced((v) => !v)}
            />
          )}
          <button
            onClick={handleRefresh}
            disabled={activeLoading}
            aria-label="Refresh leaderboard"
            className="flex items-center justify-center w-10 h-10 rounded-lg
                       border border-slate-200 dark:border-border
                       hover:bg-muted/50 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-muted-foreground ${
                activeLoading ? "animate-spin" : ""
              }`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

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
        <div className="rounded-xl border border-destructive/30 bg-destructive/5
                        px-4 py-3 text-sm text-destructive">
          Failed to load: {error}
        </div>
      )}

      {/* ── Session picker — shown when no session is selected ── */}
      {showSessionPicker && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Choose a session to view its leaderboard
          </p>
          <div className="space-y-2">
            {sessions!.map((s) => (
              <button
                key={s.id}
                onClick={() => handleSessionPick(s)}
                className="w-full text-left rounded-xl border border-border bg-card
                           px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">
                    {s.name}
                  </span>
                  {s.is_active && (
                    <span className="text-[10px] font-bold uppercase tracking-wider
                                     text-emerald-600 dark:text-emerald-400 shrink-0">
                      ● Live
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(s.created_at).toLocaleDateString("en-US", {
                    weekday: "short",
                    month:   "short",
                    day:     "numeric",
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

      {/* ── Hero card — current user's rank pinned at top ──── */}
      {myRow && !activeLoading && !showSessionPicker && (
        <div
          className="rounded-xl border-2 border-indigo-200 dark:border-indigo-800
                     bg-indigo-50/70 dark:bg-indigo-950/20
                     px-3 py-2.5 flex items-center gap-3"
          aria-label={`Your rank: #${myRow.rank}`}
        >
          {/* Rank / medal */}
          <div className="w-7 shrink-0 text-center">
            {MEDALS[myRow.rank] ? (
              <span className="text-base leading-none">{MEDALS[myRow.rank]}</span>
            ) : (
              <span className="text-sm font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                #{myRow.rank}
              </span>
            )}
          </div>

          {/* Name + VIP tag + streak */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-semibold text-foreground truncate">
                {myRow.display_name}
              </p>
              {myRow.vip_tag && myRow.vip_theme && (
                <VipTag tag={myRow.vip_tag} theme={myRow.vip_theme} />
              )}
              <span className="text-xs font-normal text-indigo-500 dark:text-indigo-400">
                (you)
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {myRow.wins}W–{myRow.losses}L ·{" "}
              {myRow.win_pct.toFixed(1)}% win rate
              {myRow.win_streak >= 3 && (
                <span className="ml-1 text-orange-500">
                  {myRow.win_streak === 3
                    ? "🔥🔥🔥"
                    : `🔥×${myRow.win_streak}`}
                </span>
              )}
            </p>
          </div>

          {/* Rank movement (all-time tab only) */}
          {showRankMov && myRow.rank_movement !== undefined && (
            <div className="shrink-0 text-right">
              {myRow.rank_movement === null ? (
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500">
                  NEW
                </span>
              ) : myRow.rank_movement > 0 ? (
                <span className="text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  ↑{myRow.rank_movement}
                </span>
              ) : myRow.rank_movement < 0 ? (
                <span className="text-xs font-bold tabular-nums text-red-500 dark:text-red-400">
                  ↓{Math.abs(myRow.rank_movement)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Leaderboard table — hidden during picker ───────── */}
      {!showSessionPicker && (
        <LeaderboardTable
          rows={activeRows}
          loading={activeLoading}
          currentUserId={currentUserId}
          flashedIds={flashedIds}
          showAdvanced={showAdvanced}
          showRankMovement={showRankMov}
          minGP={minGP}
        />
      )}

      {/* ── Footer note ────────────────────────────────────── */}
      {!activeLoading && !showSessionPicker && activeRows.length > 0 && (
        <p className="text-[10px] text-muted-foreground text-center">
          {scopeTab === "session"
            ? `Min. ${MIN_SESSION_GP} completed games to appear · Session stats only`
            : `Min. ${MIN_ALLTIME_GP} completed games to appear · All sessions combined`}
        </p>
      )}
    </div>
  );
}
