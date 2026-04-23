"use client";

// ============================================================
// Organizer Dashboard — Main shell with tab navigation
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useOrganizerData } from "@/hooks/use-organizer-data";
import { ActiveCourts } from "./active-courts";
import { OnDeckPanel } from "./on-deck-panel";
import type { SwapContext } from "./on-deck-panel";
import { SwapSheet } from "./swap-sheet";
import type { UndoableSwap } from "./swap-sheet";
import { QueueControl } from "./queue-control";
import { WaitTimeMonitor } from "./wait-time-monitor";
import { MatchHistoryPanel } from "./match-history-panel";
import { DevTools } from "./dev-tools";
import { ShareSessionDialog } from "./share-session-dialog";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { closeSession, toggleAutoMatchmaking } from "@/app/actions/sessions";
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
import { ChevronDown, ArrowLeft, Repeat, Power, Tv2, Share2, MoreVertical } from "lucide-react";

import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";
import type { Profile, Session } from "@/types/database";

// ── Design token constants ───────────────────────────────────
// Centralised so a future CSS-variable migration touches one place.
const HEADER_BG = "bg-[#1D3A6F] dark:bg-[hsl(217_30%_11%)]";
const SURFACE_BG = "bg-[#FAFAF7] dark:bg-background";
const ACTIVE_TAB = "border-b-2 border-white text-white font-semibold dark:border-primary dark:text-primary";

interface OrganizerDashboardProps {
  profile: Profile;
  session: Session;
  otherSessions?: Session[];
}

type Tab = "courts" | "queue" | "monitor" | "history" | "leaderboard";

export function OrganizerDashboard({ profile, session, otherSessions = [] }: OrganizerDashboardProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>(session.is_active ? "courts" : "history");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [autoMatchmaking, setAutoMatchmaking] = useState(session.is_auto_matchmaking_on);
  const [togglingAuto, setTogglingAuto] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // ── Tap-to-Swap state ───────────────────────────────────────
  // swapContext !== null means the SwapSheet is open.
  // Derived open/close from one piece of state — no separate boolean.
  const [swapContext, setSwapContext] = useState<SwapContext | null>(null);
  // Ref holds the last successful swap for the 5-second undo toast.
  // Using a ref (not state) so setting it doesn't cause a re-render.
  const lastSwapRef = useRef<UndoableSwap | null>(null);

  async function handleCloseSession() {
    setClosing(true);
    const result = await closeSession(session.id);
    if (result.success) {
      router.push("/organizer");
    } else {
      setClosing(false);
      alert(result.message);
    }
  }

  async function handleToggleAuto() {
    setTogglingAuto(true);
    const prev = autoMatchmaking;
    setAutoMatchmaking(!prev); // optimistic
    const result = await toggleAutoMatchmaking(session.id);
    if (!result.success) {
      setAutoMatchmaking(prev); // revert on failure
    } else {
      setAutoMatchmaking(result.isOn);
    }
    setTogglingAuto(false);
  }

  // Close switcher on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    }
    if (switcherOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [switcherOpen]);

  // Close mobile more-menu on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    if (moreMenuOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [moreMenuOpen]);

  const {
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    profiles,
    loading,
    addCourt,
    updateCourtStatus,
    removeCourt,
    callNextMatch,
    createManualMatch,
    endMatch,
    cancelMatch,
    clearOnDeckMatch,
    reorderOnDeckMatches,
    swapPlayer,
    removeFromQueue,
    pausePlayer,
  } = useOrganizerData(session.id);

  // ── Layer 2 — Frontend Race Condition Guard ─────────────────
  // When a match transitions from pending → in_progress (promoted
  // by promoteOnDeckMatchInternal), it disappears from onDeckMatches.
  // This effect proactively closes the SwapSheet ~100ms after promotion
  // so the organizer sees a clear warning rather than a server error.
  //
  // Zero new subscriptions needed — onDeckMatches is already driven
  // by the existing subscribeToMatches → fetchActiveMatches pipeline.
  useEffect(() => {
    if (!swapContext) return;
    const matchStillPending = onDeckMatches.some((m) => m.id === swapContext.matchId);
    if (!matchStillPending) {
      setSwapContext(null);
      toast.warning("Match has started — the swap was cancelled automatically.");
    }
  }, [onDeckMatches, swapContext]);

  // ── Stable swap open handler (useCallback so OnDeckPanel memo holds) ──
  const handleOpenSwap = useCallback((ctx: SwapContext) => {
    setSwapContext(ctx);
  }, []);

  // ── Swap complete: close sheet + fire undo toast ───────────
  function handleSwapComplete(swap: UndoableSwap) {
    lastSwapRef.current = swap;
    toast.success(`Swapped ${swap.outName} → ${swap.inName}`, {
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => handleUndoSwap(swap),
      },
    });
    // Sheet is closed by SwapSheet itself after calling onSwapComplete
  }

  // ── Undo: reverse-call swapPlayerInMatch ───────────────────
  async function handleUndoSwap(swap: UndoableSwap) {
    lastSwapRef.current = null;
    const result = await swapPlayer(
      swap.matchId,
      swap.inPlayerId,   // inPlayer becomes the new "out"
      swap.outPlayerId   // outPlayer comes back in
    );
    if (result.success) {
      toast.success("Swap undone.");
    } else if (result.errorCode === "MATCH_STARTED") {
      toast.error("Couldn't undo — match has already started.");
    } else {
      toast.error("Couldn't undo — match may have changed.");
    }
  }

  const isClosed = !session.is_active;
  const bottleneckCount = queue.filter((q) => q.is_bottleneck).length;

  const tabs: { key: Tab; label: string; badge?: number }[] = isClosed
    ? [
        { key: "history", label: "Match History" },
        { key: "leaderboard", label: "Leaderboard" },
      ]
    : [
        { key: "courts", label: "Active Courts" },
        { key: "queue", label: "Queue & Match Control" },
        { key: "monitor", label: "Wait Time Monitor", badge: bottleneckCount > 0 ? bottleneckCount : undefined },
        { key: "history", label: "Match History" },
        { key: "leaderboard", label: "Leaderboard" },
      ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading organizer dashboard...</p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${SURFACE_BG}`}>
      {/* Top Header */}
      <header className={`sticky top-0 z-20 ${HEADER_BG} shadow-lg dark:border-b dark:border-border`}>
        <div className="max-w-7xl mx-auto px-3 md:px-6 py-3 md:py-4">

          {/* ── Row 1: back link + mobile controls ── */}
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => router.push("/organizer")}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-white/60
                         hover:text-white hover:bg-white/10 transition-colors -ml-1 px-3 py-2
                         min-h-[44px] rounded"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All Sessions
            </button>

            {/* Mobile-only: mini auto toggle + more-options menu */}
            {!isClosed && (
              <div className="flex items-center gap-2 md:hidden">
                {/* Mini auto-matchmaking toggle */}
                <button
                  onClick={handleToggleAuto}
                  disabled={togglingAuto}
                  aria-pressed={autoMatchmaking}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1.5
                              text-[11px] font-semibold transition-colors border
                              ${autoMatchmaking
                                ? "bg-emerald-500/20 border-emerald-400/50 text-emerald-300"
                                : "bg-white/10 border-white/20 text-white/50"
                              }
                              disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0
                                    ${autoMatchmaking ? "bg-emerald-400" : "bg-white/40"}`} />
                  {autoMatchmaking ? "Auto" : "Off"}
                </button>

                {/* More-options dropdown */}
                <div className="relative" ref={moreMenuRef}>
                  <button
                    onClick={() => setMoreMenuOpen((v) => !v)}
                    className="inline-flex items-center justify-center h-9 w-9 rounded-lg
                               text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                    aria-label="More options"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>

                  {moreMenuOpen && (
                    <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl
                                    border border-slate-200 bg-white shadow-xl z-50 overflow-hidden
                                    animate-in fade-in slide-in-from-top-1 duration-150">
                      {/* TV View */}
                      <a
                        href={`/tv/${session.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setMoreMenuOpen(false)}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm
                                   text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Tv2 className="h-4 w-4 text-slate-400 shrink-0" />
                        TV Scoreboard
                      </a>

                      {/* Share Session */}
                      <button
                        onClick={() => { setMoreMenuOpen(false); setShareOpen(true); }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                   text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Share2 className="h-4 w-4 text-slate-400 shrink-0" />
                        Share Session
                      </button>

                      <div className="border-t border-slate-100" />

                      {/* Close Session */}
                      <button
                        onClick={() => { setMoreMenuOpen(false); setCloseOpen(true); }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                   text-red-600 hover:bg-red-50 transition-colors"
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
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-y-2 gap-x-4">

            {/* Title + profile name + closed badge */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative min-w-0" ref={switcherRef}>
                <button
                  onClick={() => otherSessions.length > 0 && setSwitcherOpen(!switcherOpen)}
                  className={`flex items-center gap-2 min-w-0 rounded-lg px-2 py-2 -mx-2 -my-2
                              min-h-[44px] transition-colors
                              ${otherSessions.length > 0
                                ? "hover:bg-white/10 cursor-pointer"
                                : "cursor-default"}`}
                >
                  <h1 className="text-lg md:text-xl font-bold text-white truncate">{session.name}</h1>
                  {otherSessions.length > 0 && (
                    <ChevronDown className={`h-4 w-4 text-white/60 shrink-0 transition-transform
                                             ${switcherOpen ? "rotate-180" : ""}`} />
                  )}
                </button>

                {/* Session switcher dropdown */}
                {switcherOpen && otherSessions.length > 0 && (
                  <div className="absolute left-0 top-full mt-2 w-72 rounded-xl border border-slate-200
                                  bg-white shadow-xl z-50 overflow-hidden
                                  animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        Switch Session
                      </p>
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {otherSessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => { setSwitcherOpen(false); router.push(`/organizer/${s.id}`); }}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left
                                     hover:bg-slate-50 transition-colors"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                            <Repeat className="h-3.5 w-3.5 text-slate-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-slate-800 truncate">{s.name}</p>
                            <p className="text-[10px] text-slate-400">
                              Created {new Date(s.created_at).toLocaleDateString("en-US", {
                                weekday: "short", month: "short", day: "numeric",
                              })}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-slate-100 px-3 py-2">
                      <button
                        onClick={() => { setSwitcherOpen(false); router.push("/organizer"); }}
                        className="flex items-center gap-2 w-full text-xs font-medium text-blue-600
                                   hover:text-blue-800 transition-colors py-1"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        View all sessions & create new
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-sm text-white/60 hidden sm:block shrink-0">
                — {profile.display_name}
              </p>

              {isClosed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15
                                 border border-white/30 px-2.5 py-0.5 text-[10px]
                                 font-bold uppercase tracking-wider text-white/80 shrink-0">
                  Closed
                </span>
              )}
            </div>

            {/* Desktop action strip (hidden on mobile) */}
            {!isClosed && (
              <div className="hidden md:flex items-center gap-3 text-sm text-white/70 shrink-0">
                <span>{courts.length} court{courts.length !== 1 ? "s" : ""}</span>
                <span className="text-white/40">|</span>
                <span>{queue.length} in queue</span>
                <span className="text-white/40">|</span>
                <span>{activeMatches.length} active match{activeMatches.length !== 1 ? "es" : ""}</span>
                <span className="text-white/40">|</span>

                {/* Auto-matchmaking toggle */}
                <button
                  onClick={handleToggleAuto}
                  disabled={togglingAuto}
                  aria-pressed={autoMatchmaking}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-2
                              min-h-[44px] text-xs font-semibold transition-colors border
                              ${autoMatchmaking
                                ? "bg-emerald-500/20 border-emerald-400/50 text-emerald-300 hover:bg-emerald-500/30"
                                : "bg-white/10 border-white/20 text-white/50 hover:bg-white/15"
                              }
                              disabled:opacity-50 disabled:cursor-not-allowed`}
                  title={autoMatchmaking ? "Auto-matchmaking is ON — click to pause" : "Auto-matchmaking is PAUSED — click to enable"}
                >
                  <span className={`h-2 w-2 rounded-full ${autoMatchmaking ? "bg-emerald-400" : "bg-white/40"}`} />
                  {autoMatchmaking ? "Auto On" : "Auto Off"}
                </button>

                <span className="text-white/40">|</span>
                <ThemeToggle className="text-white/60 hover:text-white hover:bg-white/10
                                        dark:text-primary dark:hover:bg-primary/10" />
                {process.env.NODE_ENV === "development" && (
                  <DevTools sessionId={session.id} />
                )}

                {/* TV View */}
                <a
                  href={`/tv/${session.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/30
                             bg-white/10 px-3 py-2.5 min-h-[44px] text-xs font-semibold text-white/80
                             hover:bg-white/20 hover:text-white hover:border-white/50 transition-colors"
                  title="Open TV scoreboard in a new tab"
                >
                  <Tv2 className="h-3.5 w-3.5" />
                  TV View
                </a>

                {/* Share Session — desktop trigger */}
                <button
                  onClick={() => setShareOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/40
                             bg-white/10 px-3 py-2.5 min-h-[44px] text-xs font-semibold text-white
                             hover:bg-white/20 hover:border-white/60 transition-colors"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  Share Session
                </button>

                {/* Close Session — desktop trigger */}
                <button
                  onClick={() => setCloseOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300/50
                             bg-white/10 px-3 py-2.5 min-h-[44px] text-xs font-semibold text-red-300
                             hover:bg-red-500/20 hover:border-red-300 transition-colors"
                >
                  <Power className="h-3.5 w-3.5" />
                  Close Session
                </button>
              </div>
            )}
          </div>

          {/* Mobile stats row — visible only below md */}
          {!isClosed && (
            <div className="mt-2 flex items-center gap-2 text-xs text-white/50 md:hidden">
              <span>{courts.length} court{courts.length !== 1 ? "s" : ""}</span>
              <span className="text-white/30">·</span>
              <span>{queue.length} in queue</span>
              <span className="text-white/30">·</span>
              <span>{activeMatches.length} active</span>
              <span className="text-white/30">·</span>
              <ThemeToggle className="text-white/50 hover:text-white hover:bg-white/10
                                      dark:text-primary dark:hover:bg-primary/10 -my-1" />
            </div>
          )}
        </div>

        {/* ── Tab Navigation — horizontally scrollable on mobile ── */}
        <div className="max-w-7xl mx-auto px-3 md:px-6">
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
                className={`relative shrink-0 whitespace-nowrap px-4 md:px-5 py-2.5 text-sm
                            font-medium transition-colors
                            ${
                              activeTab === tab.key
                                ? ACTIVE_TAB
                                : "text-white/70 hover:text-white hover:bg-white/10 dark:hover:bg-white/5"
                            }`}
              >
                {tab.label}
                {tab.badge !== undefined && (
                  <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white
                                   text-xs flex items-center justify-center font-bold animate-pulse">
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
                  This will permanently end the session. All remaining players will be
                  removed from the queue, any in-progress or on-deck matches will be
                  cancelled, and courts will be closed. Completed match history will
                  be preserved.
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
      <main className="max-w-7xl mx-auto px-3 md:px-6 py-4 md:py-6">
        <div
          role="tabpanel"
          id={`tabpanel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
        >
        {activeTab === "courts" && (
          <div className="space-y-6">
            {/* On-deck panel — always visible, collapses to empty state when no matches */}
            <OnDeckPanel
              matches={onDeckMatches}
              onClearOnDeckMatch={clearOnDeckMatch}
              onReorderMatches={reorderOnDeckMatches}
              onOpenSwap={handleOpenSwap}
            />

            <ActiveCourts
              courts={courts}
              activeMatches={activeMatches}
              onAddCourt={addCourt}
              onUpdateCourtStatus={updateCourtStatus}
              onRemoveCourt={removeCourt}
              onCallNextMatch={callNextMatch}
              onEndMatch={endMatch}
              onCancelMatch={cancelMatch}
              onClearOnDeckMatch={clearOnDeckMatch}
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
          />
        )}

        {activeTab === "monitor" && (
          <WaitTimeMonitor
            queue={queue}
            onRemoveFromQueue={removeFromQueue}
          />
        )}

        {activeTab === "history" && (
          <MatchHistoryPanel sessionId={session.id} />
        )}

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
            Key resets all internal sheet state when the organizer
            taps a different player badge.                          ── */}
      <SwapSheet
        key={swapContext ? `${swapContext.matchId}-${swapContext.outPlayerId}` : "closed"}
        context={swapContext}
        queue={queue}
        activeMatches={activeMatches}
        swapPlayer={swapPlayer}
        onClose={() => setSwapContext(null)}
        onSwapComplete={handleSwapComplete}
      />
    </div>
  );
}
