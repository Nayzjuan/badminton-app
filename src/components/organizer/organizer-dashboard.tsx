"use client";

// ============================================================
// Organizer Dashboard — Main shell with tab navigation
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import { ShareSessionDialog } from "./share-session-dialog";
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

import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";
import { useClubSlug } from "@/hooks/use-club-slug";
import { useSessionClosedWatcher } from "@/hooks/use-session-closed-watcher";
import { clubBase } from "@/lib/club-paths";
import type { Profile, Session } from "@/types/database";
import { DASHBOARD_GRID_SIZE_PX, TOAST_DISMISS_MS } from "@/lib/constants";
import { useOrganizerAlerts } from "@/hooks/use-organizer-alerts";
import { OrganizerCenterAlert } from "@/components/organizer/organizer-center-alert";
import { OrganizerSessionHeader } from "@/components/organizer/session-header";
import { EditMatchDialog } from "@/components/organizer/edit-match-dialog";
import type { QueueNoticePayload } from "@/lib/broadcast";
import type { SessionNotification } from "@/types/database";
import { isPendingCorrectionStatus } from "@/lib/session-notifications";

// ── Design token constants ───────────────────────────────────
// Command-center surface tokens (theme-aware via cc-* tokens in globals.css).
const SURFACE_BG = "bg-cc-bg";

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
      <OrganizerSessionHeader
        headerRef={headerRef}
        session={session}
        liveSession={liveSession}
        profile={profile}
        otherSessions={otherSessions}
        isClosed={isClosed}
        isDashboardLocked={isDashboardLocked}
        realtimeConnected={realtimeConnected}
        counts={{
          courts: courts.length,
          queue: queue.length,
          active: activeMatches.length,
          drafts: draftMatches.length,
        }}
        alerts={alerts}
        setReviewNotice={setReviewNotice}
        autoMatchmaking={autoMatchmaking}
        togglingAuto={togglingAuto}
        handleToggleAuto={handleToggleAuto}
        autoPublish={autoPublish}
        togglingAutoPublish={togglingAutoPublish}
        handleToggleAutoPublish={handleToggleAutoPublish}
        setAutoPublishConfirmOpen={setAutoPublishConfirmOpen}
        capPhase={capPhase}
        handleCapChange={handleCapChange}
        switcherOpen={switcherOpen}
        setSwitcherOpen={setSwitcherOpen}
        switcherRef={switcherRef}
        moreMenuOpen={moreMenuOpen}
        setMoreMenuOpen={setMoreMenuOpen}
        moreMenuRef={moreMenuRef}
        setShareOpen={setShareOpen}
        setCloseOpen={setCloseOpen}
        tabs={tabs}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

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
