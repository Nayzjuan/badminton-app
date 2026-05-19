"use client";

// ============================================================
// Organizer Dashboard — Main shell with tab navigation
// ============================================================

import { useRouter } from "next/navigation";
import { useOrganizerData } from "@/hooks/use-organizer-data";
import { useSwapState } from "@/hooks/use-swap-state";
import { useOrganizerDashboard } from "@/hooks/use-organizer-dashboard";
import { ActiveCourts } from "./active-courts";
import { OnDeckPanel } from "./on-deck-panel";
import { SwapSheet } from "./swap-sheet";
import { SwapFloatingBar } from "./swap-floating-bar";
import { QueueControl } from "./queue-control";
import { WaitTimeMonitor } from "./wait-time-monitor";
import { MatchHistoryPanel } from "./match-history-panel";
import { DevTools } from "./dev-tools";
import { ShareSessionDialog } from "./share-session-dialog";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronDown,
  ArrowLeft,
  Repeat,
  Power,
  Tv2,
  Share2,
  MoreVertical,
  WifiOff,
} from "lucide-react";

import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";
import type { Profile, Session } from "@/types/database";
import { DASHBOARD_GRID_SIZE_PX } from "@/lib/constants";

// ── Design token constants ───────────────────────────────────
// Command-center surface tokens (theme-aware via cc-* tokens in globals.css).
const HEADER_BG = "bg-cc-header-bg";
const SURFACE_BG = "bg-cc-bg";
const ACTIVE_TAB = "border-b-2 border-cc-accent text-cc-accent font-semibold";

interface OrganizerDashboardProps {
  profile: Profile;
  session: Session;
  otherSessions?: Session[];
}

export function OrganizerDashboard({
  profile,
  session,
  otherSessions = [],
}: OrganizerDashboardProps) {
  // router is used for inline navigation in the session switcher JSX.
  // Session close navigation lives inside useOrganizerDashboard.
  const router = useRouter();

  const {
    session: liveSession,
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    draftMatches,
    profiles,
    loading,
    realtimeConnected,
    addCourt,
    updateCourtStatus,
    removeCourt,
    callNextMatch,
    createManualMatch,
    endMatch,
    cancelMatch,
    clearOnDeckMatch,
    reorderOnDeckMatches,
    publishMatch,
    publishAllDrafts,
    swapPlayer,
    swapMatchPlayers,
    removeFromQueue,
    pausePlayer,
    updateTimeLimit,
    capSaturation,
    dismissCapSaturation,
  } = useOrganizerData(session.id, session);

  const {
    swapContext,
    handlePlayerTap,
    handleOpenBenchSwap,
    handleCancelSwap,
    handleSwapComplete,
    showFloatingBar,
  } = useSwapState(session.id, onDeckMatches, swapMatchPlayers, swapPlayer);

  const {
    activeTab,
    setActiveTab,
    tabs,
    switcherOpen,
    setSwitcherOpen,
    moreMenuOpen,
    setMoreMenuOpen,
    shareOpen,
    setShareOpen,
    closeOpen,
    setCloseOpen,
    switcherRef,
    moreMenuRef,
    closing,
    handleCloseSession,
    autoMatchmaking,
    togglingAuto,
    handleToggleAuto,
    joinQueue,
    isClosed,
  } = useOrganizerDashboard({
    sessionId: session.id,
    sessionIsActive: session.is_active,
    liveAutoMatchmaking: liveSession.is_auto_matchmaking_on,
    bottleneckCount: queue.filter((q) => q.is_bottleneck).length,
    // Draft Mode badge: amber on Courts tab when drafts need approval.
    // Suppress badge when organizer is already on Courts tab — the
    // Publish All banner handles the prompt there.
    draftCount: draftMatches.length,
    handleCancelSwap,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading organizer dashboard...</p>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen ${SURFACE_BG}`}
      style={{
        backgroundImage:
          "linear-gradient(var(--cc-grid-color) 1px, transparent 1px), linear-gradient(90deg, var(--cc-grid-color) 1px, transparent 1px)",
        backgroundSize: `${DASHBOARD_GRID_SIZE_PX}px ${DASHBOARD_GRID_SIZE_PX}px`,
      }}
    >
      {/* Top Header */}
      <header className={`sticky top-0 z-20 ${HEADER_BG} border-b border-cc-border`}>
        <div className="max-w-7xl mx-auto px-3 lg:px-6 py-3 lg:py-4">
          {/* ── Row 1: back link + mobile controls ── */}
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => router.push("/organizer")}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cc-t3
                         hover:text-cc-t1 hover:bg-cc-bg-3 transition-colors -ml-1 px-3 py-2
                         min-h-[44px] rounded"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All Sessions
            </button>

            {/* Mobile-only: mini auto toggle + more-options menu */}
            {!isClosed && (
              <div className="flex items-center gap-2 lg:hidden">
                {/* Mini auto-matchmaking toggle */}
                <button
                  onClick={handleToggleAuto}
                  disabled={togglingAuto}
                  aria-pressed={autoMatchmaking}
                  title="Auto matchmaking: when ON, the engine automatically forms the next match when a court opens"
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1.5
                              text-[11px] font-semibold transition-colors border
                              ${
                                autoMatchmaking
                                  ? "bg-cc-accent-dim border-cc-accent/45 text-cc-accent"
                                  : "bg-cc-bg-3 border-cc-border text-cc-t3"
                              }
                              disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0
                                    ${autoMatchmaking ? "bg-cc-accent" : "bg-cc-t3"}`}
                  />
                  {autoMatchmaking ? "Auto" : "Off"}
                </button>

                {/* More-options dropdown */}
                <div className="relative" ref={moreMenuRef}>
                  <button
                    onClick={() => setMoreMenuOpen((v) => !v)}
                    className="inline-flex items-center justify-center h-9 w-9 rounded-lg
                               text-cc-t2 hover:text-cc-t1 hover:bg-cc-bg-3 transition-colors"
                    aria-label="More options"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>

                  {moreMenuOpen && (
                    <div
                      className="absolute right-0 top-full mt-1.5 w-52 rounded-xl
                                    border border-cc-border bg-cc-bg-2
                                    shadow-xl z-50 overflow-hidden
                                    animate-in fade-in slide-in-from-top-1 duration-150"
                    >
                      {/* TV View */}
                      <a
                        href={`/tv/${session.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setMoreMenuOpen(false)}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm
                                   text-cc-t2 hover:bg-cc-bg-3
                                   hover:text-cc-t1 transition-colors"
                      >
                        <Tv2 className="h-4 w-4 text-cc-t3 shrink-0" />
                        TV Scoreboard
                      </a>

                      {/* Share Session */}
                      <button
                        onClick={() => {
                          setMoreMenuOpen(false);
                          setShareOpen(true);
                        }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                   text-cc-t2 hover:bg-cc-bg-3
                                   hover:text-cc-t1 transition-colors"
                      >
                        <Share2 className="h-4 w-4 text-cc-t3 shrink-0" />
                        Share Session
                      </button>

                      <div className="border-t border-cc-border" />

                      {/* Close Session */}
                      <button
                        onClick={() => {
                          setMoreMenuOpen(false);
                          setCloseOpen(true);
                        }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                   text-cc-red hover:bg-cc-red-dim
                                   hover:text-cc-red transition-colors"
                      >
                        <Power className="h-4 w-4 shrink-0" />
                        Close Session
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Row 2: title (left) + desktop action strip (right) ── */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-y-2 gap-x-6">
            {/* Title + profile name + closed badge */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative min-w-0" ref={switcherRef}>
                <button
                  onClick={() => otherSessions.length > 0 && setSwitcherOpen(!switcherOpen)}
                  className={`flex items-center gap-2 min-w-0 rounded-lg px-2 py-2 -mx-2 -my-2
                              min-h-[44px] transition-colors
                              ${
                                otherSessions.length > 0
                                  ? "hover:bg-cc-bg-3 cursor-pointer"
                                  : "cursor-default"
                              }`}
                >
                  <h1 className="font-command text-lg lg:text-xl font-bold text-cc-t1 tracking-wide truncate">
                    {session.name}
                  </h1>
                  {otherSessions.length > 0 && (
                    <ChevronDown
                      className={`h-4 w-4 text-cc-t3 shrink-0 transition-transform
                                             ${switcherOpen ? "rotate-180" : ""}`}
                    />
                  )}
                </button>

                {/* Session switcher dropdown */}
                {switcherOpen && otherSessions.length > 0 && (
                  <div
                    className="absolute left-0 top-full mt-2 w-72 rounded-xl
                                  border border-cc-border bg-cc-bg-2
                                  shadow-xl z-50 overflow-hidden
                                  animate-in fade-in slide-in-from-top-1 duration-150"
                  >
                    <div className="px-3 py-2 bg-cc-bg-3 border-b border-cc-border">
                      <p className="font-command text-[9px] font-bold uppercase tracking-[0.22em] text-cc-t3">
                        Switch Session
                      </p>
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {otherSessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => {
                            setSwitcherOpen(false);
                            router.push(`/organizer/${s.id}`);
                          }}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left
                                     hover:bg-cc-bg-3 transition-colors"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cc-bg-3">
                            <Repeat className="h-3.5 w-3.5 text-cc-t3" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-cc-t1 truncate">{s.name}</p>
                            <p className="text-[10px] text-cc-t3">
                              Created{" "}
                              {new Date(s.created_at).toLocaleDateString("en-US", {
                                weekday: "short",
                                month: "short",
                                day: "numeric",
                              })}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-cc-border px-3 py-2">
                      <button
                        onClick={() => {
                          setSwitcherOpen(false);
                          router.push("/organizer");
                        }}
                        className="flex items-center gap-2 w-full text-xs font-medium
                                   text-cc-accent hover:text-cc-accent/80 transition-colors py-1"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        View all sessions & create new
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-sm text-cc-t3 hidden xl:block shrink-0">
                — {profile.display_name}
              </p>

              {isClosed && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-cc-bg-3
                                 border border-cc-border px-2.5 py-0.5 text-[10px]
                                 font-bold uppercase tracking-wider text-cc-t2 shrink-0"
                >
                  Closed
                </span>
              )}
            </div>

            {/* Desktop action strip (hidden on mobile) */}
            {!isClosed && (
              <div className="hidden lg:flex items-center gap-2 text-sm text-cc-t2 shrink-0">
                {/* Stats cluster */}
                <span className="text-cc-t2 tabular-nums">
                  {courts.length} court{courts.length !== 1 ? "s" : ""}
                </span>
                <span className="text-cc-t3">·</span>
                <span className="text-cc-t2 tabular-nums">{queue.length} in queue</span>
                <span className="text-cc-t3">·</span>
                <span className="text-cc-t2 tabular-nums">{activeMatches.length} in play</span>
                {!realtimeConnected && (
                  <>
                    <span className="text-cc-t3">·</span>
                    <span
                      className="inline-flex items-center gap-1 text-cc-amber"
                      title="Realtime channels disconnected — displayed data may be stale. Reconnecting…"
                    >
                      <WifiOff className="h-3 w-3" aria-hidden="true" />
                      <span>Sync offline</span>
                    </span>
                  </>
                )}

                {/* Visual divider between stats and action buttons */}
                <span className="h-4 w-px bg-cc-border mx-1 shrink-0" aria-hidden="true" />

                {/* Auto-matchmaking toggle */}
                <button
                  data-testid="toggle-auto-matchmaking"
                  onClick={handleToggleAuto}
                  disabled={togglingAuto}
                  aria-pressed={autoMatchmaking}
                  className={`inline-flex items-center gap-1.5 clip-cut-sm px-3 py-2
                              min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] transition-colors border
                              ${
                                autoMatchmaking
                                  ? "bg-cc-accent-dim border-cc-accent/45 text-cc-accent hover:bg-cc-accent/20"
                                  : "bg-cc-bg-3 border-cc-border text-cc-t3 hover:bg-cc-bg-2"
                              }
                              disabled:opacity-50 disabled:cursor-not-allowed`}
                  title="Auto matchmaking: when ON, the engine automatically forms the next match when a court opens"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${autoMatchmaking ? "bg-cc-accent" : "bg-cc-t3"}`}
                  />
                  {autoMatchmaking ? "Auto On" : "Auto Off"}
                </button>

                <ThemeToggle className="text-cc-t2 hover:text-cc-t1 hover:bg-cc-bg-3" />
                {process.env.NODE_ENV === "development" && <DevTools sessionId={session.id} />}

                {/* TV View */}
                <a
                  href={`/tv/${session.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 clip-cut-sm border border-cc-border
                             bg-cc-bg-3 px-3 py-2.5 min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] text-cc-t2
                             hover:bg-cc-bg-2 hover:text-cc-t1 hover:border-cc-border-hi transition-colors"
                  title="Open TV scoreboard in a new tab"
                >
                  <Tv2 className="h-3.5 w-3.5" />
                  TV View
                </a>

                {/* Share Session — desktop trigger */}
                <button
                  onClick={() => setShareOpen(true)}
                  className="inline-flex items-center gap-1.5 clip-cut-sm border border-cc-border
                             bg-cc-bg-3 px-3 py-2.5 min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] text-cc-t2
                             hover:bg-cc-bg-2 hover:text-cc-t1 hover:border-cc-border-hi transition-colors"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  Share Session
                </button>

                {/* Close Session — desktop trigger */}
                <button
                  onClick={() => setCloseOpen(true)}
                  className="inline-flex items-center gap-1.5 clip-cut-sm border border-cc-red/50
                             bg-cc-red-dim px-3 py-2.5 min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] text-cc-red
                             hover:bg-cc-red/20 hover:border-cc-red transition-colors"
                >
                  <Power className="h-3.5 w-3.5" />
                  Close Session
                </button>
              </div>
            )}
          </div>

          {/* Mobile stats row — visible only below md */}
          {!isClosed && (
            <div className="mt-2 flex items-center gap-2 text-xs text-cc-t3 lg:hidden">
              <span>
                {courts.length} court{courts.length !== 1 ? "s" : ""}
              </span>
              <span className="text-cc-t3">·</span>
              <span>{queue.length} in queue</span>
              <span className="text-cc-t3">·</span>
              <span>{activeMatches.length} active</span>
              {!realtimeConnected && (
                <>
                  <span className="text-cc-t3">·</span>
                  <span
                    className="inline-flex items-center gap-1 text-cc-amber"
                    title="Realtime channels disconnected — displayed data may be stale. Reconnecting…"
                  >
                    <WifiOff className="h-3 w-3" aria-hidden="true" />
                    Sync offline
                  </span>
                </>
              )}
              <span className="text-cc-t3">·</span>
              <ThemeToggle className="text-cc-t3 hover:text-cc-t1 hover:bg-cc-bg-3 -my-1" />
            </div>
          )}
        </div>

        {/* ── Tab Navigation — horizontally scrollable on mobile ── */}
        <div className="max-w-7xl mx-auto px-3 lg:px-6">
          <nav
            className="flex overflow-x-auto gap-1 pt-2
                       [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
            role="tablist"
            aria-label="Dashboard sections"
          >
            {tabs.map((tab) => (
              <button
                key={tab.key}
                id={`tab-${tab.key}`}
                role="tab"
                aria-selected={activeTab === tab.key}
                aria-controls={`tabpanel-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                className={`relative shrink-0 whitespace-nowrap px-4 lg:px-5 py-2.5
                            font-command text-[10px] uppercase tracking-[0.14em] transition-colors
                            ${
                              activeTab === tab.key
                                ? ACTIVE_TAB
                                : "text-cc-t3 hover:text-cc-t2 hover:bg-cc-bg-3"
                            }`}
              >
                {tab.label}
                {tab.badge !== undefined && (
                  <span
                    className={[
                      "absolute -top-1 -right-1 h-5 w-5 rounded-full text-white",
                      "text-xs flex items-center justify-center font-bold",
                      // amber = drafts waiting for approval; red = bottleneck players
                      tab.badgeVariant === "amber"
                        ? "bg-amber-500 animate-pulse"
                        : "bg-red-500 animate-pulse",
                    ].join(" ")}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ── Controlled dialogs (shared between desktop + mobile menu) ── */}
      {!isClosed && (
        <>
          {/* Share Session dialog — controlled by shareOpen state */}
          <ShareSessionDialog
            sessionId={session.id}
            sessionName={session.name}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />

          {/* Close Session confirmation dialog — controlled by closeOpen state */}
          <AlertDialog open={closeOpen} onOpenChange={setCloseOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close &ldquo;{session.name}&rdquo;?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently end the session. All remaining players will be removed from
                  the queue, any in-progress or on-deck matches will be cancelled, and courts will
                  be closed. Completed match history will be preserved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleCloseSession} disabled={closing}>
                  {closing ? "Closing..." : "Yes, close session"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      {/* Content */}
      <main className="max-w-7xl mx-auto px-3 lg:px-6 py-4 lg:py-6">
        <div role="tabpanel" id={`tabpanel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
          {activeTab === "courts" && (
            <div className="space-y-6">
              {/* On-deck panel — always visible, collapses to empty state when no matches */}
              <OnDeckPanel
                matches={onDeckMatches}
                swapContext={swapContext}
                onClearOnDeckMatch={clearOnDeckMatch}
                onReorderMatches={reorderOnDeckMatches}
                onPlayerTap={handlePlayerTap}
                onPublishMatch={publishMatch}
                onPublishAllDrafts={publishAllDrafts}
                capSaturation={capSaturation}
                onDismissCapSaturation={dismissCapSaturation}
              />

              <ActiveCourts
                courts={courts}
                activeMatches={activeMatches}
                timeLimitMinutes={liveSession.court_time_limit_minutes}
                onAddCourt={addCourt}
                onUpdateCourtStatus={updateCourtStatus}
                onRemoveCourt={removeCourt}
                onCallNextMatch={callNextMatch}
                onEndMatch={endMatch}
                onCancelMatch={cancelMatch}
                onClearOnDeckMatch={clearOnDeckMatch}
                onUpdateTimeLimit={updateTimeLimit}
              />
            </div>
          )}

          {activeTab === "queue" && (
            <QueueControl
              queue={queue}
              profiles={profiles}
              onCreateManualMatch={createManualMatch}
              onRemoveFromQueue={removeFromQueue}
              onPausePlayer={pausePlayer}
              organizerPlayerId={profile.id}
              onJoinQueue={joinQueue}
            />
          )}

          {activeTab === "monitor" && (
            <WaitTimeMonitor queue={queue} onRemoveFromQueue={removeFromQueue} />
          )}

          {activeTab === "history" && <MatchHistoryPanel sessionId={session.id} />}

          {activeTab === "leaderboard" && (
            <LeaderboardPage
              sessionId={session.id}
              sessionName={session.name}
              currentUserId={profile.id}
              variant="organizer-panel"
            />
          )}
        </div>
      </main>

      {/* ── SwapSheet — rendered OUTSIDE DndContext so the drawer
            portal never interferes with the dnd-kit drag layer.
            Only opens when mode is "sheet" (bench replacement path).
            Key resets all internal sheet state when the organizer
            taps a different player badge.                          ── */}
      <SwapSheet
        key={
          swapContext?.mode === "sheet"
            ? `${swapContext.matchId}-${swapContext.outPlayerId}`
            : "closed"
        }
        context={swapContext?.mode === "sheet" ? swapContext : null}
        queue={queue}
        activeMatches={activeMatches}
        swapPlayer={swapPlayer}
        onClose={handleCancelSwap}
        onSwapComplete={handleSwapComplete}
      />

      {/* ── SwapFloatingBar — shown during picking mode.
            Gives the organizer an escape hatch to the bench-swap
            sheet and a one-tap cancel. Fixed at bottom-center,
            rendered outside any scroll container.               ── */}
      {showFloatingBar && swapContext && (
        <SwapFloatingBar
          playerName={swapContext.outPlayerName}
          team={swapContext.outTeam}
          skill={swapContext.outPlayerSkill}
          onPickFromBench={handleOpenBenchSwap}
          onCancel={handleCancelSwap}
        />
      )}
    </div>
  );
}
