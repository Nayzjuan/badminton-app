"use client";

// ============================================================
// LeaderboardPage — Layout shell for all leaderboard variants
// ============================================================
// All variants show the 3-way scope switcher (Session / Monthly / All-Time).
// The `variant` prop only controls padding + centering:
//
//   player-panel    — embedded in player dashboard tab. Compact padding.
//   organizer-panel — embedded in organizer dashboard tab.
//   standalone      — public /leaderboard[/sessionId] page. Max-width centered.
//
// Default tab: the live session when one is in context, else the current
// month (the lobby's headline) — decided in useLeaderboard.
//
// All data fetching, realtime subscription, flash detection, and
// derived state live in useLeaderboard (src/hooks/use-leaderboard.ts).
// This component is a near-pure layout renderer.
// ============================================================

import { RefreshCw, ChevronLeft, TriangleAlert } from "lucide-react";
import { StadiumLeaderboard } from "./stadium-leaderboard";
import { LeaderboardHeroCard } from "./leaderboard-hero-card";
import { useLeaderboard, type LeaderboardSessionOption } from "@/hooks/use-leaderboard";
import { formatMonthLabel } from "@/lib/month";
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
  const isCentered = variant === "standalone";

  const {
    scopeTab,
    setScopeTab,
    activeSessionId,
    activeSessionName,
    handleSessionPick,
    handleClearSession,
    activeMonth,
    availableMonths,
    handleMonthPick,
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

  // The leaderboard scope tabs (Session / Monthly / All-Time) now show on every
  // variant so Monthly + All-Time are reachable everywhere; the default tab is
  // the live session in-session, else the current month (handled by the hook).
  const SCOPE_TABS = [
    { key: "session", label: "This Session" },
    { key: "monthly", label: "Monthly" },
    { key: "alltime", label: "All-Time" },
  ] as const;

  const monthLabel = formatMonthLabel(activeMonth.year, activeMonth.month);
  const boardTitle =
    scopeTab === "session" ? activeSessionName : scopeTab === "monthly" ? monthLabel : "All-Time";
  const scopeLabel =
    scopeTab === "session" ? "Session" : scopeTab === "monthly" ? "Monthly" : "All-Time";
  const emptyMsg =
    scopeTab === "monthly"
      ? `No ranked players this month yet — play ${minGP}+ games to appear.`
      : minGP === 1
        ? "No completed games in this session yet."
        : `No players with ${minGP}+ games yet.`;

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

  // ── Render — unified across all variants ──────────────────
  // Every variant (player-panel, organizer-panel, standalone) shows the 3-way
  // scope switcher; padding/centering differ via wrapperClass.
  return (
    <div className={wrapperClass}>
      {/* StadiumLeaderboard owns its own header + refresh button —
          no duplicate header needed here. */}

      {/* ── Scope tab switcher: Session / Monthly / All-Time ── */}
      <div
        role="tablist"
        aria-label="Leaderboard scope"
        className="flex gap-1 rounded-xl bg-muted/50 p-1"
      >
        {SCOPE_TABS.map((t, idx) => {
          const selected = scopeTab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={selected}
              // Roving tabindex: only the selected tab is in the tab order.
              tabIndex={selected ? 0 : -1}
              onClick={() => setScopeTab(t.key)}
              // APG tablist: ←/→ move to the previous/next tab and activate it.
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const dir = e.key === "ArrowRight" ? 1 : -1;
                const nextIdx = (idx + dir + SCOPE_TABS.length) % SCOPE_TABS.length;
                setScopeTab(SCOPE_TABS[nextIdx].key);
                (
                  e.currentTarget.parentElement?.children[nextIdx] as HTMLElement | undefined
                )?.focus();
              }}
              className={[
                "flex-1 rounded-lg py-2 min-h-[36px] text-xs font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── Month picker — Monthly tab only ──────────────────── */}
      {scopeTab === "monthly" &&
        (availableMonths.length > 1 ? (
          <div className="flex items-center justify-end gap-2">
            <label htmlFor="leaderboard-month" className="sr-only">
              Select month
            </label>
            <select
              id="leaderboard-month"
              value={`${activeMonth.year}-${activeMonth.month}`}
              onChange={(e) => {
                const picked = availableMonths.find(
                  (m) => `${m.year}-${m.month}` === e.target.value
                );
                if (picked) handleMonthPick(picked);
              }}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold
                         text-foreground transition-colors hover:bg-muted
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {availableMonths.map((m) => (
                <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-right text-xs font-semibold text-muted-foreground">{monthLabel}</p>
        ))}

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
            <p className="text-sm text-muted-foreground">{emptyMsg}</p>
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
            title={boardTitle}
            rows={activeRows}
            currentUserId={currentUserId}
            onRefresh={handleRefresh}
            showMovement={scopeTab === "alltime"}
            scopeLabel={scopeLabel}
            minGP={minGP}
          />
        ))}
    </div>
  );
}
