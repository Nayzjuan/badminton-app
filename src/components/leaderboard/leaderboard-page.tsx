"use client";

// ============================================================
// LeaderboardPage — Orchestrates all leaderboard variants
// ============================================================
// Three variants controlled by the `variant` prop:
//
//   player-panel    — embedded in player dashboard tab.
//                     Renders the Direction A "Stadium" layout:
//                     Barlow Condensed title, podium top-3,
//                     JetBrains Mono stats, YOU strip.
//                     Supports THIS SESSION / ALL-TIME filter chips.
//
//   organizer-panel — embedded in organizer dashboard tab.
//                     Classic layout unchanged.
//                     Session + All-Time tabs.
//                     Advanced stats toggle (PF/PA/+/-).
//
//   standalone      — public /leaderboard/[sessionId] page.
//                     Classic layout unchanged.
//                     Session + All-Time tabs.
//                     Advanced stats toggle.
//                     Max-width centered layout.
//
// Data flow:
//   Session tab  → getSessionLeaderboard(sessionId)
//   All-Time tab → getAllTimeLeaderboard() (lazy: fetched on first visit)
//
// Flash: rows new to the board after a refresh pulse for 1.2 s.
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Trophy, RefreshCw, ChevronLeft, TriangleAlert } from "lucide-react";
import { LeaderboardTable } from "./leaderboard-table";
import { LeaderboardHeroCard } from "./leaderboard-hero-card";
import { AdvancedStatsToggle } from "./advanced-stats-toggle";
import { YouStrip } from "./you-strip";
import { LeaderboardPodium } from "./leaderboard-podium";
import { StadiumLeaderboardRow } from "./stadium-leaderboard-row";
import { cn } from "@/lib/utils";
import { barlowFont, monoFont } from "@/lib/fonts";
import {
  getSessionLeaderboard,
  getAllTimeLeaderboard,
  getPlayerStats,
} from "@/app/actions/leaderboard";
import type { LeaderboardRow, LeaderboardVariant } from "@/types/leaderboard";

const MIN_SESSION_GP = 3;
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

// ── Stadium sort key ─────────────────────────────────────────

type StadiumSort = "rank" | "pct" | "w" | "streak";

// ── Component ─────────────────────────────────────────────────

export function LeaderboardPage({
  sessionId,
  sessionName,
  sessions,
  currentUserId,
  variant = "player-panel",
}: LeaderboardPageProps) {
  const isCompact = variant === "player-panel";
  // organizer-panel and standalone keep their existing showAdvanced toggle;
  // player-panel uses the Stadium layout which has no advanced stats.
  const showAdvToggle = variant === "organizer-panel" || variant === "standalone";
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());
  /** Raw stats for the current user regardless of MIN_GP — drives YouStrip / LeaderboardHeroCard */
  const [myStats, setMyStats] = useState<LeaderboardRow | null>(null);
  const [myStatsLoading, setMyStatsLoading] = useState(false);

  // Stadium-specific: sort key for the rows below the podium
  const [sortKey, setSortKey] = useState<StadiumSort>("rank");

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
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // ── Lazy load all-time on first tab visit ─────────────────
  useEffect(() => {
    if (scopeTab === "alltime" && !alltimeFetched && !alltimeLoading) {
      fetchAllTime();
    }
  }, [scopeTab, alltimeFetched, alltimeLoading, fetchAllTime]);

  // ── Fetch current user's raw stats ────────────────────────
  useEffect(() => {
    if (!currentUserId) return;
    if (scopeTab === "session" && !activeSessionId) {
      setMyStats(null);
      return;
    }

    let cancelled = false;
    setMyStats(null);
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
    setSessionRows([]);
    setMyStats(null);
  }, []);

  // ── Derived state ─────────────────────────────────────────
  const activeRows = scopeTab === "session" ? sessionRows : alltimeRows;
  const activeLoading = scopeTab === "session" ? sessionLoading : alltimeLoading;
  const minGP = scopeTab === "session" ? MIN_SESSION_GP : MIN_ALLTIME_GP;
  const showRankMov = scopeTab === "alltime";
  const showSessionPicker = scopeTab === "session" && !activeSessionId && !!sessions?.length;
  const myRow = currentUserId ? activeRows.find((r) => r.player_id === currentUserId) : null;

  const handleRefresh = () => {
    if (scopeTab === "session" && activeSessionId) fetchSession();
    else if (scopeTab === "alltime") fetchAllTime();
  };

  // ── Stadium: podium (rank-sorted top 3) + sorted rest ─────
  // Podium is always rank-sorted regardless of the sort key.
  // The sort key only applies to rows 4+ in the list below.
  const { podiumRows, sortedRestRows } = useMemo(() => {
    const byRank = [...activeRows].sort((a, b) => a.rank - b.rank);
    const top3 = byRank.slice(0, 3);
    const rest = byRank.slice(3);
    const sorted =
      sortKey === "rank"
        ? rest
        : [...rest].sort((a, b) => {
            if (sortKey === "pct") return b.win_pct - a.win_pct;
            if (sortKey === "w") return b.wins - a.wins;
            if (sortKey === "streak") return b.win_streak - a.win_streak;
            return 0;
          });
    return { podiumRows: top3, sortedRestRows: sorted };
  }, [activeRows, sortKey]);

  // ═════════════════════════════════════════════════════════════
  // STADIUM LAYOUT — player-panel only
  // ═════════════════════════════════════════════════════════════
  if (isCompact) {
    return (
      <div className="min-h-full">
        {/* ── 1. Section header ──────────────────────────────── */}
        <div
          className="px-4 pt-[18px] pb-[14px] flex items-end justify-between
                     border-b border-slate-200 dark:border-[hsl(217_18%_14%)]"
        >
          <div>
            {/* Eyebrow — session name + date */}
            <div
              className={`${monoFont} text-[9.5px] tracking-[.2em] font-bold uppercase mb-1
                           text-amber-700 dark:text-[hsl(38_92%_52%)]`}
            >
              {activeSessionName
                ? activeSessionName.toUpperCase()
                : scopeTab === "alltime"
                  ? "ALL-TIME STANDINGS"
                  : "LEADERBOARD"}
            </div>
            {/* Large italic title */}
            <div
              className={`${barlowFont} font-black italic text-[52px] leading-[.85]
                           tracking-tight uppercase text-[#111827] dark:text-white`}
            >
              LEADER
              <br />
              BOARD
            </div>
          </div>

          <div className="flex items-end gap-2 pb-1">
            {/* Player count */}
            <div className="text-right">
              <div
                className={`${barlowFont} font-black italic text-[44px] leading-[.9]
                             text-amber-600 dark:text-[hsl(38_92%_52%)]`}
              >
                {activeRows.length}
              </div>
              <div
                className={`${monoFont} text-[9px] tracking-[.18em] mt-0.5
                             text-[#9ca3af] dark:text-[hsl(220_10%_40%)]`}
              >
                PLAYERS
              </div>
            </div>

            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={activeLoading}
              aria-label="Refresh leaderboard"
              className="w-9 h-9 rounded-[10px] border border-slate-200 dark:border-[hsl(217_18%_22%)]
                         bg-transparent grid place-items-center
                         text-[#9ca3af] dark:text-[hsl(220_10%_48%)]
                         hover:bg-slate-50 dark:hover:bg-[hsl(217_25%_12%)]
                         transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${activeLoading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        {/* ── 2. Error banner ───────────────────────────────── */}
        {error && !activeLoading && (
          <div
            className="mx-4 mt-3 rounded-xl border border-destructive/50 bg-destructive/10
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

        {/* ── 3. YOU strip ──────────────────────────────────── */}
        {currentUserId && !showSessionPicker && (
          <YouStrip row={myRow ?? myStats} loading={activeLoading || myStatsLoading} />
        )}

        {/* ── 4. Filter chips: THIS SESSION / ALL-TIME / LAST 30 ── */}
        <div className="flex gap-1 px-4 py-3 overflow-x-auto scrollbar-hide">
          {(
            [
              { k: "session", label: "THIS SESSION", disabled: false },
              { k: "alltime", label: "ALL-TIME", disabled: false },
              { k: "30d", label: "LAST 30", disabled: true },
            ] as const
          ).map(({ k, label, disabled }) => (
            <button
              key={k}
              disabled={disabled}
              onClick={() => {
                if (!disabled && (k === "session" || k === "alltime")) {
                  setScopeTab(k);
                }
              }}
              className={cn(
                monoFont,
                "text-[9.5px] tracking-[.14em] font-semibold",
                "border px-[11px] py-1.5 uppercase whitespace-nowrap transition-all",
                scopeTab === k && !disabled
                  ? "bg-[#111827] text-amber-400 border-[#111827] dark:bg-[hsl(38_92%_52%)] dark:text-[hsl(217_28%_8%)] dark:border-transparent"
                  : "text-[#6b7280] border-[#d1d5db] dark:text-[hsl(220_10%_40%)] dark:border-[hsl(217_18%_18%)]",
                disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── 5. Podium (rank #1–3, always rank-sorted) ──────── */}
        {!activeLoading && !showSessionPicker && podiumRows.length === 3 && (
          <LeaderboardPodium top3={podiumRows} />
        )}

        {/* ── 6. Sort bar ───────────────────────────────────── */}
        {/* Only shown when there are rows outside the podium (rank 4+) or
            fewer than 3 qualified players (no podium shown), so the sort
            controls are never orphaned above an empty row list.           */}
        {!showSessionPicker &&
          (sortedRestRows.length > 0 || (activeRows.length > 0 && podiumRows.length < 3)) && (
            <div
              className="flex items-center gap-0.5 px-4 py-2.5
                       border-t border-[#f3f4f6] dark:border-[hsl(217_18%_13%)]"
            >
              <span
                className={`${monoFont} text-[9px] tracking-[.18em] uppercase mr-1.5
                           text-[#9ca3af] dark:text-[hsl(220_10%_36%)]`}
              >
                SORT
              </span>
              {(
                [
                  { k: "rank", label: "RANK" },
                  { k: "pct", label: "WIN%" },
                  { k: "w", label: "WINS" },
                  { k: "streak", label: "STREAK" },
                ] as const
              ).map(({ k, label }) => (
                <button
                  key={k}
                  onClick={() => setSortKey(k)}
                  className={cn(
                    barlowFont,
                    "font-bold text-[13px] tracking-[.06em] uppercase",
                    "bg-transparent border-none cursor-pointer px-[7px] py-1 transition-colors",
                    sortKey === k
                      ? "text-[#111827] border-b-2 border-amber-600 dark:text-[hsl(38_92%_52%)] dark:border-[hsl(38_92%_52%)]"
                      : "text-[#6b7280] dark:text-[hsl(220_10%_38%)]"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

        {/* ── 7. Column headers (6-col grid) ────────────────── */}
        {/* Same gate as sort bar — only render when rows will follow. */}
        {!showSessionPicker &&
          (sortedRestRows.length > 0 || (activeRows.length > 0 && podiumRows.length < 3)) && (
            <div
              className={`${monoFont} text-[9px] tracking-[.16px] uppercase font-bold
                         grid px-4 py-[7px]
                         border-t border-b border-slate-200 dark:border-[hsl(217_18%_13%)]
                         bg-[#f9fafb] dark:bg-[hsl(217_25%_10%)]
                         text-[#6b7280] dark:text-[hsl(220_10%_32%)]`}
              style={{ gridTemplateColumns: "34px 1fr 30px 64px 52px 26px", gap: "6px" }}
              role="row"
              aria-label="Column headers"
            >
              <span className="text-right">#</span>
              <span>PLAYER</span>
              <span className="text-right">GP</span>
              <span className="text-right">W–L</span>
              <span className="text-right">WIN%</span>
              <span className="text-right">Δ</span>
            </div>
          )}

        {/* ── 8. Rows ────────────────────────────────────────── */}
        {!showSessionPicker && (
          <div role="grid" aria-label="Leaderboard standings">
            {/* Loading skeletons */}
            {activeLoading && (
              <>
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="h-[44px] px-4 flex items-center gap-1.5
                               border-b border-[#f3f4f6] dark:border-[hsl(217_18%_12%)]"
                  >
                    <div className="w-[34px] shrink-0">
                      <div className="h-3 w-5 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto" />
                    </div>
                    <div className="flex-1">
                      <div className="h-4 w-32 bg-slate-200 dark:bg-muted rounded animate-pulse" />
                    </div>
                    <div className="w-[30px] shrink-0">
                      <div className="h-3 w-4 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto" />
                    </div>
                    <div className="w-[64px] shrink-0">
                      <div className="h-3 w-10 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto" />
                    </div>
                    <div className="w-[52px] shrink-0">
                      <div className="h-4 w-10 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto" />
                    </div>
                    <div className="w-[26px] shrink-0">
                      <div className="h-3 w-4 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto" />
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Empty state */}
            {!activeLoading && activeRows.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <p
                  className={`${monoFont} text-[11px] tracking-[.08em] text-[#9ca3af] dark:text-[hsl(220_10%_40%)]`}
                >
                  NO PLAYERS QUALIFIED YET
                </p>
                <p
                  className={`${monoFont} text-[10px] text-[#9ca3af] dark:text-[hsl(220_10%_36%)] mt-1.5`}
                >
                  NEED {minGP}+ COMPLETED GAMES TO APPEAR
                </p>
              </div>
            )}

            {/* Ranks 1–3 are always shown in the podium section above.
                This list always starts at rank 4+, regardless of sort key.
                The sort key reorders rows within this set only — podium
                players never appear here. */}
            {!activeLoading &&
              sortedRestRows.map((row) => (
                <StadiumLeaderboardRow
                  key={row.player_id}
                  row={row}
                  isCurrentUser={row.player_id === currentUserId}
                  flash={flashedIds.has(row.player_id)}
                />
              ))}
          </div>
        )}

        {/* ── Session picker (fallback when sessionId is null) ── */}
        {showSessionPicker && (
          <div className="px-4 py-4 space-y-3">
            <p
              className={`${monoFont} text-[10px] tracking-[.08em] text-[#9ca3af] dark:text-[hsl(220_10%_40%)]`}
            >
              CHOOSE A SESSION
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

        {/* ── 9. Footer note ─────────────────────────────────── */}
        {!activeLoading && !showSessionPicker && activeRows.length > 0 && (
          <p
            className={`${monoFont} text-center text-[9.5px] tracking-[.08em] px-4 py-3.5
                         text-[#9ca3af] dark:text-[hsl(220_10%_32%)]`}
          >
            Min. {minGP} GP to appear · Confidence-weighted win rate
          </p>
        )}
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════
  // CLASSIC LAYOUT — organizer-panel and standalone (unchanged)
  // ═════════════════════════════════════════════════════════════

  const wrapperClass = cn("space-y-4 px-4 py-6", isCentered && "max-w-2xl mx-auto");

  return (
    <div className={wrapperClass}>
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Trophy className="h-5 w-5 text-amber-500 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground leading-tight">Leaderboard</h2>
            {activeSessionName && scopeTab === "session" && (
              <p className="text-xs text-muted-foreground truncate">{activeSessionName}</p>
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
            className="flex items-center justify-center w-11 h-11 rounded-lg
                       border border-slate-200 dark:border-border
                       hover:bg-muted/50 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-muted-foreground ${activeLoading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {/* ── Scope tab switcher (organizer-panel + standalone) ── */}
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

      {/* ── "Change session" back button ────────────────────── */}
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

      {/* ── Hero card — classic variant ──────────────────────── */}
      {currentUserId && !showSessionPicker && (
        <LeaderboardHeroCard
          row={myRow ?? myStats}
          totalPlayers={activeRows.length}
          scope={scopeTab}
          loading={activeLoading || myStatsLoading}
        />
      )}

      {/* ── Leaderboard table — classic variant ─────────────── */}
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

      {/* ── Footer note ─────────────────────────────────────── */}
      {!activeLoading && !showSessionPicker && activeRows.length > 0 && (
        <p className="text-[10px] text-muted-foreground text-center">
          {scopeTab === "session"
            ? `Min. ${MIN_SESSION_GP} GP to appear · Ranked by confidence-weighted win rate`
            : `Min. ${MIN_ALLTIME_GP} GP to appear · Ranked by confidence-weighted win rate`}
        </p>
      )}
    </div>
  );
}
