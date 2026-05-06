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
import { SwapFloatingBar } from "./swap-floating-bar";
import { QueueControl } from "./queue-control";
import { WaitTimeMonitor } from "./wait-time-monitor";
import { MatchHistoryPanel } from "./match-history-panel";
import { DevTools } from "./dev-tools";
import { ShareSessionDialog } from "./share-session-dialog";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { closeSession, toggleAutoMatchmaking } from "@/app/actions/sessions";
import { joinQueueAction } from "@/app/actions/queue";
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
import { ChevronDown, ArrowLeft, Repeat, Power, Tv2, Share2, MoreVertical, WifiOff } from "lucide-react";

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
  // swapContext drives both picking-mode (direct match↔match swap)
  // and sheet-mode (legacy bench replacement).
  //
  // mode: "picking" — first tap done; floating bar shown; pills have
  //                   ring/valid-target visual treatment.
  // mode: "sheet"   — SwapSheet open for picking a bench replacement.
  const [swapContext, setSwapContext] = useState<SwapContext | null>(null);

  // Ref mirrors swapContext so the stable useCallback can read current
  // value without being included in deps (avoids breaking OnDeckPanel memo).
  const swapContextRef = useRef<SwapContext | null>(null);
  swapContextRef.current = swapContext;

  // Ref mirrors executeMatchSwap so the stable handlePlayerTap useCallback
  // always calls the latest version — avoids a stale closure over swapMatchPlayers
  // or onDeckMatches if they ever change identity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executeMatchSwapRef = useRef<(...args: any[]) => void>(() => {});

  // Ref holds the last successful bench swap for the 5-second undo toast.
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

  // Esc key cancels picking mode.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && swapContextRef.current?.mode === "picking") {
        setSwapContext(null);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
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

  // ── Organizer self-join ─────────────────────────────────────
  // Allows the organizer to add themselves to the queue directly from
  // the organizer dashboard — useful when running a session and also
  // wanting to play. joinQueueAction uses the caller's auth session to
  // resolve the player_id, so no extra arguments are needed.
  const joinQueue = useCallback(async () => {
    const result = await joinQueueAction(session.id);
    if (result.error) {
      toast.error(result.error);
    }
  }, [session.id]);

  // ── Layer 2 — Frontend Race Condition Guard ─────────────────
  // When a match transitions from pending → in_progress (promoted
  // by promoteOnDeckMatchInternal), it disappears from onDeckMatches.
  // This effect proactively closes the SwapSheet / clears picking mode
  // ~100ms after promotion so the organizer sees a clear warning rather
  // than a server error.
  //
  // Checks swapContext.matchId (the first selected player's match).
  // If the TARGET match (second player) starts while picking, executeMatchSwap
  // catches it via its own pre-check before calling the server.
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

  // ── handlePlayerTap ─────────────────────────────────────────
  // Stable callback (reads swapContext via ref) so OnDeckPanel memo is not
  // broken — this function reference never changes between renders.
  //
  // First tap  → enter "picking" mode, show floating bar.
  // Same player again → cancel (toggle off).
  // Different player → execute direct match↔match swap.
  const handlePlayerTap = useCallback((ctx: Omit<SwapContext, "mode">) => {
    const current = swapContextRef.current;

    if (!current || current.mode !== "picking") {
      // No active picking context → start a new one
      setSwapContext({ ...ctx, mode: "picking" });
      return;
    }

    // Already in picking mode
    if (current.outPlayerId === ctx.outPlayerId && current.matchId === ctx.matchId) {
      // Same player tapped again → cancel
      setSwapContext(null);
      return;
    }

    // Different player tapped → execute the direct swap.
    // Use the ref so we always call the latest version of executeMatchSwap
    // (which closes over current onDeckMatches for the Bug 3 pre-check).
    executeMatchSwapRef.current(current, ctx);
  }, []); // stable — reads from swapContextRef + executeMatchSwapRef

  // ── executeMatchSwap ────────────────────────────────────────
  // Calls the server action and shows undo-able toast on success.
  // Clears picking mode immediately (optimistic).
  //
  // Bug 3 fix: pre-checks BOTH match IDs against onDeckMatches before
  // calling the server. If either match started between the first tap
  // and the second tap, this catches it client-side so we never hit
  // a confusing server error in this edge case.
  async function executeMatchSwap(
    first: Omit<SwapContext, "mode">,
    second: Omit<SwapContext, "mode">
  ) {
    // Pre-check: both matches must still be on-deck (pending).
    const firstStillPending = onDeckMatches.some((m) => m.id === first.matchId);
    const secondStillPending = onDeckMatches.some((m) => m.id === second.matchId);
    if (!firstStillPending || !secondStillPending) {
      setSwapContext(null);
      toast.warning("A match has started — the swap was cancelled automatically.");
      return;
    }

    // Clear picking mode immediately — UI snaps to idle while server responds
    setSwapContext(null);

    const result = await swapMatchPlayers(
      first.matchId,
      first.outPlayerId,
      second.matchId,
      second.outPlayerId,
      first.sessionId,
    );

    if (result.success) {
      const sameMatch = first.matchId === second.matchId;
      const toastTitle = sameMatch
        ? `Swapped teams: ${first.outPlayerName} ↔ ${second.outPlayerName}`
        : `Swapped matches: ${first.outPlayerName} ↔ ${second.outPlayerName}`;

      toast.success(toastTitle, {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => handleUndoMatchSwap(first, second),
        },
      });
    } else if (result.errorCode === "MATCH_STARTED") {
      toast.error("Match has already started — swap cancelled.");
    } else if (result.errorCode === "PLAYER_NOT_IN_MATCH") {
      toast.error("A player was already moved — swap cancelled.");
    } else {
      toast.error(`Swap failed: ${result.message}`);
    }
  }

  // Keep the ref current so handlePlayerTap always calls the latest closure
  // (which captures the up-to-date onDeckMatches for the pre-check above).
  executeMatchSwapRef.current = executeMatchSwap;

  // ── handleUndoMatchSwap ─────────────────────────────────────
  // Reverses a direct match↔match swap.
  //
  // After the initial swap:
  //   first.outPlayerId  is now in  second.matchId
  //   second.outPlayerId is now in  first.matchId
  //
  // So the undo must REVERSE the matchId arguments — pass each
  // player's NEW match as the source, restoring original placement.
  // For a same-match team swap (first.matchId == second.matchId)
  // the argument order doesn't matter and this still works correctly.
  async function handleUndoMatchSwap(
    first: Omit<SwapContext, "mode">,
    second: Omit<SwapContext, "mode">
  ) {
    const result = await swapMatchPlayers(
      second.matchId,    // first.outPlayerId is NOW here
      first.outPlayerId,
      first.matchId,     // second.outPlayerId is NOW here
      second.outPlayerId,
      first.sessionId,
    );
    if (result.success) {
      toast.success("Swap undone.");
    } else if (result.errorCode === "MATCH_STARTED") {
      toast.error("Couldn't undo — match has already started.");
    } else {
      toast.error("Couldn't undo — match may have changed.");
    }
  }

  // ── handleOpenBenchSwap ─────────────────────────────────────
  // Promotes picking mode → sheet mode (opens the bench-replacement drawer).
  function handleOpenBenchSwap() {
    if (swapContextRef.current?.mode === "picking") {
      setSwapContext((prev) => (prev ? { ...prev, mode: "sheet" } : null));
    }
  }

  // ── handleCancelSwap ────────────────────────────────────────
  function handleCancelSwap() {
    setSwapContext(null);
  }

  // ── Bench swap complete: close sheet + fire undo toast ──────
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

  // ── Undo bench swap ─────────────────────────────────────────
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

  // Draft Mode: show an amber badge on the Courts tab when the organizer
  // is on a different tab and drafts are waiting for approval. When they're
  // already on the Courts tab the Publish All banner handles the prompt —
  // no need to double up the indicator.
  const draftCount = draftMatches.length;

  const tabs: { key: Tab; label: string; badge?: number; badgeVariant?: "default" | "amber" }[] = isClosed
    ? [
        { key: "history", label: "Match History" },
        { key: "leaderboard", label: "Leaderboard" },
      ]
    : [
        {
          key: "courts",
          label: "Active Courts",
          badge: draftCount > 0 && activeTab !== "courts" ? draftCount : undefined,
          badgeVariant: "amber",
        },
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

  // Whether the floating bar should be shown
  const showFloatingBar = swapContext?.mode === "picking";

  return (
    <div className={`min-h-screen ${SURFACE_BG}`}>
      {/* Top Header */}
      <header className={`sticky top-0 z-20 ${HEADER_BG} shadow-lg dark:border-b dark:border-border`}>
        <div className="max-w-7xl mx-auto px-3 lg:px-6 py-3 lg:py-4">

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
              <div className="flex items-center gap-2 lg:hidden">
                {/* Mini auto-matchmaking toggle */}
                <button
                  onClick={handleToggleAuto}
                  disabled={togglingAuto}
                  aria-pressed={autoMatchmaking}
                  title="Auto matchmaking: when ON, the engine automatically forms the next match when a court opens"
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
                                   text-slate-700 hover:bg-slate-50 dark:text-foreground dark:hover:bg-muted transition-colors"
                      >
                        <Tv2 className="h-4 w-4 text-slate-400 shrink-0" />
                        TV Scoreboard
                      </a>

                      {/* Share Session */}
                      <button
                        onClick={() => { setMoreMenuOpen(false); setShareOpen(true); }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                   text-slate-700 hover:bg-slate-50 dark:text-foreground dark:hover:bg-muted transition-colors"
                      >
                        <Share2 className="h-4 w-4 text-slate-400 shrink-0" />
                        Share Session
                      </button>

                      <div className="border-t border-slate-100" />

                      {/* Close Session */}
                      <button
                        onClick={() => { setMoreMenuOpen(false); setCloseOpen(true); }}
                        className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                   text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/20 transition-colors"
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
                              ${otherSessions.length > 0
                                ? "hover:bg-white/10 cursor-pointer"
                                : "cursor-default"}`}
                >
                  <h1 className="text-lg lg:text-xl font-bold text-white truncate">{session.name}</h1>
                  {otherSessions.length > 0 && (
                    <ChevronDown className={`h-4 w-4 text-white/60 shrink-0 transition-transform
                                             ${switcherOpen ? "rotate-180" : ""}`} />
                  )}
                </button>

                {/* Session switcher dropdown */}
                {switcherOpen && otherSessions.length > 0 && (
                  <div className="absolute left-0 top-full mt-2 w-72 rounded-xl border border-slate-200
                                  dark:border-border bg-white dark:bg-card shadow-xl z-50 overflow-hidden
                                  animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="px-3 py-2 bg-slate-50 dark:bg-muted border-b border-slate-100 dark:border-border">
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
                                     hover:bg-slate-50 dark:hover:bg-muted transition-colors"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-muted">
                            <Repeat className="h-3.5 w-3.5 text-slate-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-slate-800 dark:text-foreground truncate">{s.name}</p>
                            <p className="text-[10px] text-slate-400">
                              Created {new Date(s.created_at).toLocaleDateString("en-US", {
                                weekday: "short", month: "short", day: "numeric",
                              })}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-slate-100 dark:border-border px-3 py-2">
                      <button
                        onClick={() => { setSwitcherOpen(false); router.push("/organizer"); }}
                        className="flex items-center gap-2 w-full text-xs font-medium text-blue-600
                                   dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors py-1"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        View all sessions & create new
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-sm text-white/60 hidden xl:block shrink-0">
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
              <div className="hidden lg:flex items-center gap-2 text-sm text-white/70 shrink-0">
                {/* Stats cluster */}
                <span className="text-white/60 tabular-nums">{courts.length} court{courts.length !== 1 ? "s" : ""}</span>
                <span className="text-white/40">·</span>
                <span className="text-white/60 tabular-nums">{queue.length} in queue</span>
                <span className="text-white/40">·</span>
                <span className="text-white/60 tabular-nums">{activeMatches.length} in play</span>
                {!realtimeConnected && (
                  <>
                    <span className="text-white/40">·</span>
                    <span
                      className="inline-flex items-center gap-1 text-amber-400/90"
                      title="Realtime channels disconnected — displayed data may be stale. Reconnecting…"
                    >
                      <WifiOff className="h-3 w-3" aria-hidden="true" />
                      <span>Sync offline</span>
                    </span>
                  </>
                )}

                {/* Visual divider between stats and action buttons */}
                <span className="h-4 w-px bg-white/20 mx-1 shrink-0" aria-hidden="true" />

                {/* Auto-matchmaking toggle */}
                <button
                  data-testid="toggle-auto-matchmaking"
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
                  title="Auto matchmaking: when ON, the engine automatically forms the next match when a court opens"
                >
                  <span className={`h-2 w-2 rounded-full ${autoMatchmaking ? "bg-emerald-400" : "bg-white/40"}`} />
                  {autoMatchmaking ? "Auto On" : "Auto Off"}
                </button>

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
            <div className="mt-2 flex items-center gap-2 text-xs text-white/50 lg:hidden">
              <span>{courts.length} court{courts.length !== 1 ? "s" : ""}</span>
              <span className="text-white/40">·</span>
              <span>{queue.length} in queue</span>
              <span className="text-white/40">·</span>
              <span>{activeMatches.length} active</span>
              {!realtimeConnected && (
                <>
                  <span className="text-white/40">·</span>
                  <span
                    className="inline-flex items-center gap-1 text-amber-400/90"
                    title="Realtime channels disconnected — displayed data may be stale. Reconnecting…"
                  >
                    <WifiOff className="h-3 w-3" aria-hidden="true" />
                    Sync offline
                  </span>
                </>
              )}
              <span className="text-white/40">·</span>
              <ThemeToggle className="text-white/50 hover:text-white hover:bg-white/10
                                      dark:text-primary dark:hover:bg-primary/10 -my-1" />
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
                className={`relative shrink-0 whitespace-nowrap px-4 lg:px-5 py-2.5 text-sm
                            font-medium transition-colors
                            ${
                              activeTab === tab.key
                                ? ACTIVE_TAB
                                : "text-white/70 hover:text-white hover:bg-white/10 dark:hover:bg-white/5"
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
      <main className="max-w-7xl mx-auto px-3 lg:px-6 py-4 lg:py-6">
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
