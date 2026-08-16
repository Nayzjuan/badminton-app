"use client";

// ============================================================
// Organizer Dashboard — Main shell with tab navigation
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useOrganizerData } from "@/hooks/use-organizer-data";
import { useSwapState } from "@/hooks/use-swap-state";
import { useOrganizerDashboard } from "@/hooks/use-organizer-dashboard";
import { ActiveCourts } from "./active-courts";
import { DraftCapPopover } from "./draft-cap-popover";
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
import { useClubSlug } from "@/hooks/use-club-slug";
import { useSessionClosedWatcher } from "@/hooks/use-session-closed-watcher";
import { clubBase, clubOrganizer, clubTv } from "@/lib/club-paths";
import type { Profile, Session } from "@/types/database";
import { DASHBOARD_GRID_SIZE_PX, TOAST_DISMISS_MS } from "@/lib/constants";
import { useOrganizerAlerts } from "@/hooks/use-organizer-alerts";
import { OrganizerCenterAlert } from "@/components/organizer/organizer-center-alert";
import { OrganizerNoticeInbox } from "@/components/organizer/organizer-notice-inbox";
import { EditMatchDialog } from "@/components/organizer/edit-match-dialog";
import type { QueueNoticePayload } from "@/lib/broadcast";
import type { SessionNotification } from "@/types/database";
import { isPendingCorrectionStatus } from "@/lib/session-notifications";

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
  // Active club slug when rendered under /c/[clubSlug]/… ; null on legacy routes.
  const clubSlug = useClubSlug();

  // Mounted BEFORE useOrganizerData so its callbacks can be handed to the
  // session broadcast channel. Covers the case the close flow cannot: a
  // CO-ORGANIZER (or this organizer's other tab) ends the session, leaving this
  // board live-looking and fully interactive over a session that is gone.
  const {
    handleSessionClosed,
    handleChannelStatus: handleClosedWatcherStatus,
    suppressLocalClose,
  } = useSessionClosedWatcher(session.id, profile.id, {
    fallbackPath: clubSlug ? clubBase(clubSlug) : "/organizer",
    toastMessage: "This session was closed.",
  });

  // Leave notices arrive on the session broadcast before useOrganizerAlerts
  // exists (it needs the queue from useOrganizerData). The ref is written
  // after both hooks settle — same pattern as fetchXxxRef.
  const enqueueNoticeRef = useRef<(payload: QueueNoticePayload) => void>(() => {});
  const onQueueNotice = useCallback((payload: QueueNoticePayload) => {
    enqueueNoticeRef.current(payload);
  }, []);

  const {
    session: liveSession,
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    draftMatches,
    profiles,
    loading,
    matchesRevision,
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
    capSignal,
  } = useOrganizerData(session.id, session, profile.id, {
    onSessionClosed: handleSessionClosed,
    onBroadcastStatus: handleClosedWatcherStatus,
    onQueueNotice,
  });

  const [reviewNotice, setReviewNotice] = useState<SessionNotification | null>(null);

  const {
    swapContext,
    handlePlayerTap,
    handleOpenBenchSwap,
    handleCancelSwap,
    handleSwapComplete,
    showFloatingBar,
  } = useSwapState(session.id, onDeckMatches, swapMatchPlayers, swapPlayer);

  // ── Memoized queue derivations ────────────────────────────
  // Declared before useOrganizerDashboard since bottleneckCount is passed as a prop.
  const bottleneckCount = useMemo(() => queue.filter((q) => q.is_bottleneck).length, [queue]);
  const waitingCount = useMemo(() => queue.filter((q) => q.status === "waiting").length, [queue]);

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
    autoPublish,
    togglingAutoPublish,
    handleToggleAutoPublish,
    capPhase,
    capPhaseActorName,
    isDashboardLocked,
    handleCapChange,
    joinQueue,
    isClosed,
  } = useOrganizerDashboard({
    sessionId: session.id,
    // `liveSession`, not the `session` RSC prop: that prop is frozen at the
    // last server render, so a co-organizer's close (or your own, in another
    // tab) left this board reading ACTIVE forever — every isClosed-gated
    // control stayed live on a session that had ended.
    sessionIsActive: liveSession.is_active,
    organizerId: profile.id,
    liveAutoMatchmaking: liveSession.is_auto_matchmaking_on,
    liveAutoPublish: liveSession.auto_publish,
    bottleneckCount,
    // Draft Mode badge: amber on Courts tab when drafts need approval.
    // Suppress badge when organizer is already on Courts tab — the
    // Publish All banner handles the prompt there.
    draftCount: draftMatches.length,
    handleCancelSwap,
    capSignal,
    suppressCloseWatcher: suppressLocalClose,
  });

  const alerts = useOrganizerAlerts(session.id, queue, isClosed, !loading);
  useEffect(() => {
    enqueueNoticeRef.current = alerts.enqueueNotice;
  }, [alerts.enqueueNotice]);

  // Refs for the --cc-header-h ResizeObserver (see the effect below).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);

  // ── New-draft notification ────────────────────────────────
  // Show a toast + transient badge the first time unpublished drafts appear
  // after the queue was empty. Fires only on 0 → ≥1 transitions so the
  // organizer isn't spammed when the engine generates multiple slots, and
  // `prevDraftCount` is seeded from the current count so a page-load with
  // existing drafts never triggers a spurious notification.
  //
  // The edge itself is detected while rendering, not in an effect: React
  // supports adjusting state from a changed value during render and re-runs
  // the component before committing, so the badge lands in the same paint as
  // the drafts it announces instead of one render behind them.
  // `draftNotice` carries the whole notification — its presence *is* the
  // badge, and a fresh object per edge is what re-arms the toast effect below.
  const [prevDraftCount, setPrevDraftCount] = useState(draftMatches.length);
  const [draftNotice, setDraftNotice] = useState<{ count: number } | null>(null);
  if (prevDraftCount !== draftMatches.length) {
    setPrevDraftCount(draftMatches.length);
    if (prevDraftCount === 0 && draftMatches.length > 0) {
      setDraftNotice({ count: draftMatches.length });
    }
  }
  const hasNewDraft = draftNotice !== null;
  // Confirm dialog for enabling auto-publish while unreviewed drafts exist (D9).
  const [autoPublishConfirmOpen, setAutoPublishConfirmOpen] = useState(false);

  // The toast is a real external side effect, so it stays in an effect — and
  // the badge-reset timer rides with it. Keying on the notice (not on the
  // draft count) means an unrelated count change mid-window can no longer run
  // the cleanup and strand the badge on forever; only a *new* notice cancels
  // the pending reset, so rapid 0→1→0→1 transitions never race two timers.
  useEffect(() => {
    if (draftNotice === null) return;
    const { count } = draftNotice;
    toast("Draft ready", {
      description: `${count} new match draft${count !== 1 ? "s" : ""} — review and publish to put on deck.`,
      duration: TOAST_DISMISS_MS,
    });
    const timer = setTimeout(() => setDraftNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [draftNotice]);

  // ── Publish the header height as --cc-header-h ────────────
  // The header is `sticky top-0 z-20`, so anything else that wants to pin
  // below it needs its live height (QueueControl's manual-match bar does).
  // It is not a constant: crossing `lg` flips py-3 -> py-4 and stacks Row 2
  // differently, and closing the session removes a whole strip and three
  // tabs. ResizeObserver keeps the var honest without a resize listener.
  // Published on the dashboard root (not documentElement) so it disappears
  // with the tree on SPA navigation.
  useEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;
    if (!header || !root || typeof ResizeObserver === "undefined") return;

    const publish = () => {
      root.style.setProperty("--cc-header-h", `${Math.round(header.offsetHeight)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    return () => observer.disconnect();
    // `loading` is a dep because the header does not exist on the loading
    // branch — the observer has to attach on the render that mounts it.
  }, [loading]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading organizer dashboard...</p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`min-h-screen ${SURFACE_BG}`}
      style={{
        backgroundImage:
          "linear-gradient(var(--cc-grid-color) 1px, transparent 1px), linear-gradient(90deg, var(--cc-grid-color) 1px, transparent 1px)",
        backgroundSize: `${DASHBOARD_GRID_SIZE_PX}px ${DASHBOARD_GRID_SIZE_PX}px`,
      }}
    >
      {/* Top Header */}
      <header
        ref={headerRef}
        className={`sticky top-0 z-20 ${HEADER_BG} border-b border-cc-border`}
      >
        <div className="max-w-7xl mx-auto px-3 lg:px-6 py-3 lg:py-4">
          {/* ── Row 1: back link + mobile controls ── */}
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => router.push(clubSlug ? clubBase(clubSlug) : "/organizer")}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cc-t3
                         hover:text-cc-t1 hover:bg-cc-bg-3 transition-colors -ml-1 px-3 py-2
                         min-h-[44px] rounded"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All Sessions
            </button>

            <div className="flex items-center gap-2">
              <OrganizerNoticeInbox
                inbox={alerts.inbox}
                unreadCount={alerts.unreadCount}
                isClosed={isClosed}
                onMarkRead={alerts.markRead}
                onReview={setReviewNotice}
              />
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
                    {togglingAuto ? (
                      <span className="h-2 w-2 shrink-0 animate-spin">
                        <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                          <circle
                            cx="5"
                            cy="5"
                            r="3.5"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeDasharray="14 8"
                            strokeLinecap="round"
                            opacity=".9"
                          />
                        </svg>
                      </span>
                    ) : (
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        {autoMatchmaking && (
                          <span className="animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-cc-accent opacity-50" />
                        )}
                        <span
                          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${autoMatchmaking ? "bg-cc-accent" : "bg-cc-t3"}`}
                        />
                      </span>
                    )}
                    {togglingAuto ? "…" : autoMatchmaking ? "Auto" : "Off"}
                  </button>

                  {/* Auto-publish toggle — mobile compact. State shown via accent
                    color; disabled until Auto-Matchmaking is ON (D11). */}
                  {!isClosed && (
                    <button
                      data-testid="toggle-auto-publish-mobile"
                      onClick={() => {
                        const enabling = !autoPublish;
                        if (enabling && draftMatches.length > 0) {
                          setAutoPublishConfirmOpen(true);
                        } else {
                          void handleToggleAutoPublish(enabling);
                        }
                      }}
                      disabled={togglingAutoPublish || !autoMatchmaking || isDashboardLocked}
                      aria-pressed={autoPublish}
                      aria-label={autoPublish ? "Auto-publish on" : "Auto-publish off"}
                      className={`inline-flex items-center gap-1 clip-cut-sm px-2 py-1.5 min-h-[36px]
                                font-command text-[9px] uppercase tracking-[0.08em] transition-colors border
                                ${
                                  autoPublish
                                    ? "bg-cc-accent-dim border-cc-accent/45 text-cc-accent"
                                    : "bg-cc-bg-3 border-cc-border text-cc-t3"
                                }
                                disabled:opacity-50 disabled:cursor-not-allowed`}
                      title={
                        !autoMatchmaking ? "Enable Auto-Matchmaking first" : "Auto-publish mode"
                      }
                    >
                      <span
                        className={`relative inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${autoPublish ? "bg-cc-accent" : "bg-cc-t3"}`}
                      />
                      {togglingAutoPublish ? "…" : "Pub"}
                    </button>
                  )}

                  {/* Draft cap chip — mobile compact */}
                  {!isClosed && (
                    <DraftCapPopover
                      value={liveSession.max_auto_drafts_override ?? null}
                      autoIsOn={autoMatchmaking}
                      autoPublishIsOn={autoPublish}
                      capPhase={capPhase}
                      onChange={handleCapChange}
                      compact
                    />
                  )}

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
                          href={clubSlug ? clubTv(clubSlug, session.id) : `/tv/${session.id}`}
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
                            router.push(
                              clubSlug ? clubOrganizer(clubSlug, s.id) : `/organizer/${s.id}`
                            );
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
                          router.push(clubSlug ? clubBase(clubSlug) : "/organizer");
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
                  {/* Dot: spins as arc while saving, pings when ON, static when OFF */}
                  {togglingAuto ? (
                    <span className="h-2.5 w-2.5 shrink-0 animate-spin">
                      <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <circle
                          cx="5"
                          cy="5"
                          r="3.5"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeDasharray="14 8"
                          strokeLinecap="round"
                          opacity=".9"
                        />
                      </svg>
                    </span>
                  ) : (
                    <span className="relative flex h-2 w-2 shrink-0">
                      {autoMatchmaking && (
                        <span className="animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-cc-accent opacity-50" />
                      )}
                      <span
                        className={`relative inline-flex h-2 w-2 rounded-full ${autoMatchmaking ? "bg-cc-accent" : "bg-cc-t3"}`}
                      />
                    </span>
                  )}
                  {togglingAuto ? "Saving…" : autoMatchmaking ? "Auto On" : "Auto Off"}
                </button>

                {/* Auto-publish toggle — desktop. Disabled until Auto-Matchmaking
                    is ON (D11): the engine is paused otherwise. */}
                {!isClosed && (
                  <button
                    data-testid="toggle-auto-publish"
                    onClick={() => {
                      const enabling = !autoPublish;
                      if (enabling && draftMatches.length > 0) {
                        setAutoPublishConfirmOpen(true);
                      } else {
                        void handleToggleAutoPublish(enabling);
                      }
                    }}
                    disabled={togglingAutoPublish || !autoMatchmaking || isDashboardLocked}
                    aria-pressed={autoPublish}
                    className={`inline-flex items-center gap-1.5 clip-cut-sm px-3 py-2
                                min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] transition-colors border
                                ${
                                  autoPublish
                                    ? "bg-cc-accent-dim border-cc-accent/45 text-cc-accent hover:bg-cc-accent/20"
                                    : "bg-cc-bg-3 border-cc-border text-cc-t3 hover:bg-cc-bg-2"
                                }
                                disabled:opacity-50 disabled:cursor-not-allowed`}
                    title={
                      !autoMatchmaking
                        ? "Enable Auto-Matchmaking first — auto-publish only works while the engine runs"
                        : "Auto-publish: when ON, generated matches skip review and go straight to On Deck"
                    }
                  >
                    {togglingAutoPublish ? (
                      <span className="h-2.5 w-2.5 shrink-0 animate-spin">
                        <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                          <circle
                            cx="5"
                            cy="5"
                            r="3.5"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeDasharray="14 8"
                            strokeLinecap="round"
                            opacity=".9"
                          />
                        </svg>
                      </span>
                    ) : (
                      <span
                        className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${autoPublish ? "bg-cc-accent" : "bg-cc-t3"}`}
                      />
                    )}
                    {togglingAutoPublish ? "Saving…" : autoPublish ? "Publish On" : "Publish Off"}
                  </button>
                )}

                {/* Draft cap separator + chip — desktop */}
                {!isClosed && (
                  <>
                    <div className="w-px h-5 bg-cc-border shrink-0" aria-hidden="true" />
                    <DraftCapPopover
                      value={liveSession.max_auto_drafts_override ?? null}
                      autoIsOn={autoMatchmaking}
                      autoPublishIsOn={autoPublish}
                      capPhase={capPhase}
                      onChange={handleCapChange}
                    />
                  </>
                )}

                <ThemeToggle className="text-cc-t2 hover:text-cc-t1 hover:bg-cc-bg-3" />
                {process.env.NODE_ENV === "development" && <DevTools sessionId={session.id} />}

                {/* TV View */}
                <a
                  href={clubSlug ? clubTv(clubSlug, session.id) : `/tv/${session.id}`}
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

      {/* ── Controlled dialogs (shared between desktop + mobile menu) ──
          `|| closing` is load-bearing and pairs with the preventDefault on the
          close button below. `isClosed` reads from `liveSession`, and the
          organizer receives their OWN session_closed echo while closeSession is
          still in flight (a REST broadcast has no sending socket) — so gating on
          `!isClosed` alone unmounts this dialog, and the "Closing session…"
          label with it, a beat BEFORE the action resolves. That is the same
          no-feedback gap preventDefault exists to close, reintroduced from the
          other end. */}
      {(!isClosed || closing) && (
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
                  be closed. Completed match history will be preserved. Everyone still on the app
                  gets sent to their session recap.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={closing}>Cancel</AlertDialogCancel>
                {/*
                  preventDefault is load-bearing. AlertDialogAction IS Radix's
                  Dialog.Close, so without it the dialog dismisses on the same
                  click that starts the close — the "Closing…" label paints once
                  onto a node already fading out, and the organizer watches ~1.2 s
                  of Wrapped pre-compute with no feedback at all. That is the
                  organizer-side half of "the wrap didn't fire right away".
                  handleCloseSession closes the dialog itself when it lands.
                */}
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    void handleCloseSession();
                  }}
                  disabled={closing}
                >
                  {closing ? "Closing session…" : "Yes, close session"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Enable Auto-Publish confirmation — only shown when unreviewed
              drafts exist, since enabling clears them (D3/D9). */}
          <AlertDialog open={autoPublishConfirmOpen} onOpenChange={setAutoPublishConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Enable auto-publish?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears {draftMatches.length} unreviewed draft
                  {draftMatches.length !== 1 ? "s" : ""} (their players return to waiting), then the
                  engine publishes new matches straight to On Deck without review. You can turn this
                  off anytime — live on-deck matches stay put.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep drafts</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setAutoPublishConfirmOpen(false);
                    void handleToggleAutoPublish(true);
                  }}
                >
                  Enable auto-publish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      {/* ── Dashboard lockout overlay ─────────────────────────────
          Shown during a draft-cap reset so no organizer (local or
          co-organizer) can interact with the dashboard mid-flight.
          There is no dismiss control: the overlay clears when the
          terminal "done" broadcast arrives, or when the co-organizer's
          lease expires (useOrganizerSession's TTL self-unlock).
      ──────────────────────────────────────────────────────── */}
      <OrganizerCenterAlert
        alert={reviewNotice ? null : alerts.current}
        remaining={alerts.remaining}
        onDismiss={alerts.dismiss}
        onReview={() => {
          const row = alerts.current?.notification;
          alerts.dismiss();
          if (row?.match_id) setReviewNotice(row);
        }}
      />

      {reviewNotice?.match_id && (
        <EditMatchDialog
          key={reviewNotice.id}
          hideTrigger
          open
          onOpenChange={(next) => {
            if (!next) setReviewNotice(null);
          }}
          matchId={reviewNotice.match_id}
          initialScoreA={reviewNotice.payload.proposedScoreA ?? 0}
          initialScoreB={reviewNotice.payload.proposedScoreB ?? 0}
          notificationId={isPendingCorrectionStatus(reviewNotice.status) ? reviewNotice.id : null}
          teamALabel={
            reviewNotice.payload.teamANames?.length
              ? reviewNotice.payload.teamANames.join(" & ")
              : "Team A"
          }
          teamBLabel={
            reviewNotice.payload.teamBNames?.length
              ? reviewNotice.payload.teamBNames.join(" & ")
              : "Team B"
          }
          onSaved={alerts.refreshInbox}
        />
      )}

      {isDashboardLocked && (
        <div
          data-testid="cap-lockout-overlay"
          data-cap-phase={capPhase}
          className="fixed inset-0 z-[200] flex items-center justify-center"
          style={{ background: "oklch(0.07 0.012 245 / 0.60)", backdropFilter: "blur(2px)" }}
          aria-live="polite"
          aria-label={capPhase === "clearing" ? "Clearing drafts…" : "Generating new drafts…"}
        >
          <div
            className="flex flex-col items-center gap-1.5 bg-cc-bg-2 border border-cc-border-hi
                       px-5 py-3"
            style={{
              clipPath:
                "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))",
            }}
          >
            <div className="flex items-center gap-3 font-command text-[10px] uppercase tracking-[0.14em] text-cc-t1">
              <span
                className="h-[10px] w-[10px] shrink-0 rounded-full border-[1.5px]
                           border-current border-t-transparent animate-spin"
              />
              {capPhase === "clearing" ? "Clearing drafts…" : "Generating new drafts…"}
            </div>
            {/* Attribution — only set when a CO-ORGANIZER started this, so the
                lock never looks like it came from nowhere. */}
            {capPhaseActorName && (
              <p data-testid="cap-lockout-actor" className="text-[10px] text-cc-t3">
                Started by {capPhaseActorName}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <main
        className="max-w-7xl mx-auto px-3 lg:px-6 py-4 lg:py-6"
        style={isDashboardLocked ? { pointerEvents: "none", userSelect: "none" } : undefined}
      >
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
                isAutoMatchmakingOn={liveSession.is_auto_matchmaking_on}
                autoPublishIsOn={autoPublish}
                waitingCount={waitingCount}
                maxAutoDraftsOverride={liveSession.max_auto_drafts_override}
                hasNewDraft={hasNewDraft}
                queue={queue}
              />

              <ActiveCourts
                courts={courts}
                activeMatches={activeMatches}
                onDeckMatches={onDeckMatches}
                queuePlayers={queue}
                sessionId={session.id}
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
              sessionId={session.id}
              queue={queue}
              profiles={profiles}
              onCreateManualMatch={createManualMatch}
              onRemoveFromQueue={removeFromQueue}
              onPausePlayer={pausePlayer}
              organizerPlayerId={profile.id}
              onJoinQueue={joinQueue}
              matchesRevision={matchesRevision}
              /* The cap-saturation notice already tells the organizer to
                 override manually — a repeat warning on top of it would
                 fire hardest exactly when they have no alternative. */
              capSaturationActive={capSaturation !== null}
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
