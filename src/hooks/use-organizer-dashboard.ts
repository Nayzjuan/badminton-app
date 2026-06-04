"use client";

// ============================================================
// useOrganizerDashboard — UI controller hook for OrganizerDashboard
// ============================================================
//
// Owns all UI state that is orthogonal to data-fetching:
//   - Tab navigation (activeTab, tabs config with badges)
//   - Dropdown / dialog open states (sessionSwitcher, moreMenu,
//     shareDialog, closeDialog)
//   - Auto-matchmaking optimistic toggle (pendingAuto, togglingAuto)
//   - Session close flow (closing)
//   - Click-outside handlers for dropdowns
//   - Esc key handler for swap cancel
//   - joinQueue callback for organizer self-join
//
// Keeping this separate from useOrganizerData lets modal lifecycle
// and toggle flows be tested without a Supabase mock.
//
// Params:
//   sessionId          — session UUID
//   sessionIsActive    — whether session.is_active (determines initial tab
//                        and controls isClosed-gated UI)
//   liveAutoMatchmaking — liveSession.is_auto_matchmaking_on (kept live via
//                         broadcast in useOrganizerData)
//   bottleneckCount    — queue.filter(q => q.is_bottleneck).length
//   draftCount         — draftMatches.length
//   handleCancelSwap   — from useSwapState; bound to the Esc key
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { closeSession, toggleAutoMatchmaking, setCapAndClearDrafts } from "@/app/actions/sessions";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { broadcastDraftCapPhase } from "@/lib/broadcast";
import { joinQueueAction } from "@/app/actions/queue";
import type { CapPhase } from "@/hooks/use-organizer-session";
import { TOAST_DISMISS_MS } from "@/lib/constants";

// ── Types ────────────────────────────────────────────────────

export type OrganizerTab = "courts" | "queue" | "monitor" | "history" | "leaderboard";

export type TabConfig = {
  key: OrganizerTab;
  label: string;
  badge?: number;
  badgeVariant?: "default" | "amber";
};

export interface UseOrganizerDashboardParams {
  sessionId: string;
  sessionIsActive: boolean;
  /** liveSession.is_auto_matchmaking_on — updated via broadcast */
  liveAutoMatchmaking: boolean;
  /** queue.filter(q => q.is_bottleneck).length */
  bottleneckCount: number;
  /** draftMatches.length */
  draftCount: number;
  /** from useSwapState — wired to the Esc key */
  handleCancelSwap: () => void;
  /** Phase received from a co-organizer's cap-change broadcast. */
  externalCapPhase?: CapPhase;
}

export interface UseOrganizerDashboardResult {
  // Tab navigation
  activeTab: OrganizerTab;
  setActiveTab: (tab: OrganizerTab) => void;
  tabs: TabConfig[];

  // Dropdown / dialog states
  switcherOpen: boolean;
  setSwitcherOpen: (open: boolean) => void;
  moreMenuOpen: boolean;
  setMoreMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  shareOpen: boolean;
  setShareOpen: (open: boolean) => void;
  closeOpen: boolean;
  setCloseOpen: (open: boolean) => void;

  // Refs (click-outside handlers wired internally)
  switcherRef: React.RefObject<HTMLDivElement | null>;
  moreMenuRef: React.RefObject<HTMLDivElement | null>;

  // Session close flow
  closing: boolean;
  handleCloseSession: () => Promise<void>;

  // Auto-matchmaking toggle
  autoMatchmaking: boolean;
  togglingAuto: boolean;
  handleToggleAuto: () => Promise<void>;

  // Draft cap override
  capPhase: CapPhase;
  isDashboardLocked: boolean;
  handleCapChange: (cap: number | null) => Promise<void>;

  // Organizer self-join
  joinQueue: () => Promise<void>;

  // Derived
  isClosed: boolean;
}

// ── Hook ─────────────────────────────────────────────────────

/**
 * UI controller for the organizer dashboard shell.
 *
 * Owns tab navigation, dropdown/dialog open states, auto-matchmaking optimistic
 * toggle, session-close flow, and click-outside handlers. Deliberately isolated
 * from data fetching (useOrganizerData) so modal lifecycle and toggle flows can
 * be tested without a Supabase mock.
 */
export function useOrganizerDashboard({
  sessionId,
  sessionIsActive,
  liveAutoMatchmaking,
  bottleneckCount,
  draftCount,
  handleCancelSwap,
  externalCapPhase = null,
}: UseOrganizerDashboardParams): UseOrganizerDashboardResult {
  const router = useRouter();
  const isClosed = !sessionIsActive;

  // ── Tab navigation ────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<OrganizerTab>(isClosed ? "history" : "courts");

  // ── Dropdown / dialog open states ────────────────────────
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  // ── Session close flow ────────────────────────────────────
  const [closing, setClosing] = useState(false);

  // ── Auto-matchmaking optimistic toggle ────────────────────
  // pendingAuto: holds the expected value during the server round-trip.
  // null = no in-flight toggle; use liveAutoMatchmaking as truth.
  const [pendingAuto, setPendingAuto] = useState<boolean | null>(null);
  const [togglingAuto, setTogglingAuto] = useState(false);

  // ── Click-outside refs ────────────────────────────────────
  const switcherRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // ── Close session switcher on outside click ───────────────
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

  // ── Close mobile more-menu on outside click ───────────────
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

  // ── pendingAuto yield-back ────────────────────────────────
  // Once the broadcast updates liveAutoMatchmaking to agree with pendingAuto,
  // clear pendingAuto so liveAutoMatchmaking becomes the sole source of truth.
  // Without this, a co-organizer toggle in another tab would update
  // liveAutoMatchmaking via broadcast but local pendingAuto would still override it.
  useEffect(() => {
    if (pendingAuto !== null && liveAutoMatchmaking === pendingAuto) {
      setPendingAuto(null);
    }
  }, [liveAutoMatchmaking, pendingAuto]);

  // ── Esc key cancels swap picking mode ────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleCancelSwap();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // handleCancelSwap is a plain function (redeclared each render), so this
    // effect captures a stale closure. This is safe because handleCancelSwap
    // only calls setSwapContext(null) — a stable React dispatcher that never
    // changes identity. If handleCancelSwap ever reads from a ref or closes
    // over other state, revisit this with a stable useCallback wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ──────────────────────────────────────────────

  const handleCloseSession = useCallback(async () => {
    setClosing(true);
    try {
      const result = await closeSession(sessionId);
      if (result.success) {
        router.push("/organizer");
      } else {
        toast.error(result.message ?? "Failed to close session.");
      }
    } catch (err) {
      console.error("[handleCloseSession] unexpected throw:", err);
      toast.error("Failed to close session. Please try again.");
    } finally {
      setClosing(false);
    }
  }, [sessionId, router]);

  const handleToggleAuto = useCallback(async () => {
    setTogglingAuto(true);
    setPendingAuto(!liveAutoMatchmaking); // optimistic
    try {
      const result = await toggleAutoMatchmaking(sessionId);
      if (result.success) {
        // Hold the server-confirmed value as authoritative until the broadcast
        // updates liveAutoMatchmaking. This prevents the toggle from flickering
        // while waiting for the realtime broadcast to arrive.
        setPendingAuto(result.isOn);
        if (result.isOn) {
          toast.success("Engine running", {
            description: "Auto-matchmaking is ON — drafts will appear as courts open.",
            // Position bottom-right so the toast never overlaps the header
            // toggle button (which sits at top-center behind the default toaster).
            position: "bottom-right",
            duration: 3_000,
          });
        } else {
          toast("Engine paused", {
            description: "Auto-matchmaking is OFF — create matches manually.",
            position: "bottom-right",
            duration: 3_000,
          });
        }
      } else {
        setPendingAuto(null);
        toast.error(result.message ?? "Failed to toggle auto-matchmaking.");
      }
    } catch (err) {
      console.error("[handleToggleAuto] unexpected throw:", err);
      setPendingAuto(null);
      toast.error("Failed to toggle auto-matchmaking. Please try again.");
    } finally {
      setTogglingAuto(false);
    }
  }, [sessionId, liveAutoMatchmaking]);

  const joinQueue = useCallback(async () => {
    try {
      const result = await joinQueueAction(sessionId);
      if (result.error) {
        toast.error(result.error);
      }
    } catch (err) {
      console.error("[joinQueue] unexpected throw:", err);
      toast.error("Failed to join queue. Please try again.");
    }
  }, [sessionId]);

  // ── Draft cap override ────────────────────────────────────
  // Local capPhase tracks the phase when THIS organizer triggers the change.
  // externalCapPhase tracks the phase when a CO-ORGANIZER triggers it.
  // The effective phase shown in the UI is whichever is non-null.
  const [localCapPhase, setLocalCapPhase] = useState<CapPhase>(null);
  const capPhase: CapPhase = localCapPhase ?? externalCapPhase;
  const isDashboardLocked = capPhase !== null;

  const handleCapChange = useCallback(
    async (cap: number | null) => {
      // Phase 1: clear drafts + save cap.
      setLocalCapPhase("clearing");
      void broadcastDraftCapPhase(sessionId, "clearing", cap);

      const clearResult = await setCapAndClearDrafts(sessionId, cap);

      if (!clearResult.success) {
        toast.error(clearResult.error ?? "Failed to reset drafts. Please try again.");
        setLocalCapPhase(null);
        void broadcastDraftCapPhase(sessionId, "done", cap);
        return;
      }

      // Auto OFF — just saved the preference, no engine run needed.
      if (!clearResult.autoIsOn) {
        setLocalCapPhase(null);
        void broadcastDraftCapPhase(sessionId, "done", cap);
        return;
      }

      // Phase 2: regenerate drafts with the new effective cap.
      setLocalCapPhase("generating");
      void broadcastDraftCapPhase(sessionId, "generating", cap);

      try {
        await runEngineForSession(sessionId);
      } catch (err) {
        console.error("[handleCapChange] engine threw unexpectedly:", err);
      } finally {
        // Always unlock — whether engine succeeded, returned an error, or threw.
        setLocalCapPhase(null);
        void broadcastDraftCapPhase(sessionId, "done", cap);
      }
    },
    [sessionId]
  );

  // ── Derived values ────────────────────────────────────────

  // Show the optimistic value during the server round-trip, then
  // yield back to the authoritative liveAutoMatchmaking once confirmed.
  const autoMatchmaking = pendingAuto ?? liveAutoMatchmaking;

  const tabs: TabConfig[] = isClosed
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
        {
          key: "monitor",
          label: "Wait Time Monitor",
          badge: bottleneckCount > 0 ? bottleneckCount : undefined,
        },
        { key: "history", label: "Match History" },
        { key: "leaderboard", label: "Leaderboard" },
      ];

  return {
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
    capPhase,
    isDashboardLocked,
    handleCapChange,
    joinQueue,
    isClosed,
  };
}
