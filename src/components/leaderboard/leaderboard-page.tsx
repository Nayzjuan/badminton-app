"use client";

// ============================================================
// LeaderboardPage — Layout shell for all leaderboard variants
// ============================================================
// Three variants controlled by the `variant` prop:
//
//   player-panel    — embedded in player dashboard tab.
//                     Session stats only. Compact padding.
//
//   organizer-panel — embedded in organizer dashboard tab.
//                     Session + All-Time tabs.
//
//   standalone      — public /leaderboard/[sessionId] page.
//                     Session + All-Time tabs. Max-width centered.
//
// All data fetching, realtime subscription, flash detection, and
// derived state live in useLeaderboard (src/hooks/use-leaderboard.ts).
// This component is a near-pure layout renderer.
// ============================================================

import { RefreshCw, ChevronLeft, TriangleAlert } from "lucide-react";
import { StadiumLeaderboard } from "./stadium-leaderboard";
import { LeaderboardHeroCard } from "./leaderboard-hero-card";
import { useLeaderboard, type LeaderboardSessionOption } from "@/hooks/use-leaderboard";
import type { LeaderboardVariant } from "@/types/leaderboard";

// ── Props ─────────────────────────────────────────────────────

// LeaderboardSessionOption is re-exported from useLeaderboard for
// callers that need to construct the sessions array.
export type { LeaderboardSessionOption } from "@/hooks/use-leaderboard";

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

  const {
    scopeTab,
    setScopeTab,
    activeSessionId,
    activeSessionName,
    handleSessionPick,
    handleClearSession,
    sessionRows,
    sessionLoading,
    error,
    myStats,
    myStatsLoading,
    activeRows,
    activeLoading,
    minGP,
    myRow,
    handleRefresh,
  } = useLeaderboard({
    initialSessionId: sessionId,
    initialSessionName: sessionName,
    currentUserId,
  });

  // Show session picker when on session tab but no session is selected.
  // Computed here (not in the hook) because it depends on the `sessions`
  // prop that is only available in the component.
  const showSessionPicker = scopeTab === "session" && !activeSessionId && !!sessions?.length;

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
              {minGP === 1
                ? "Complete at least 1 game to appear."
                : `Min. ${minGP} games to appear on the board.`}
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
          onClick={handleClearSession}
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
              {minGP === 1
                ? "No completed games in this session yet."
                : `No players with ${minGP}+ games yet.`}
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
