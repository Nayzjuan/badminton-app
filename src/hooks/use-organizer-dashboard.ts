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
import {
  closeSession,
  renotifySessionClosed,
  getPlayerSessionStatus,
  toggleAutoMatchmaking,
  toggleAutoPublish,
  applyDraftCapOverride,
} from "@/app/actions/sessions";
import { joinQueueAction } from "@/app/actions/queue";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubBase, clubWrapped } from "@/lib/club-paths";
import { withTimeout } from "@/lib/with-timeout";
import type { CapPhase, CapPhaseSignal } from "@/hooks/use-organizer-session";

// ── Constants ────────────────────────────────────────────────

/** Neutral signal used when the parent does not pass one (tests, storybook). */
const IDLE_CAP_SIGNAL: CapPhaseSignal = { phase: null, opId: null, actorName: null };

/**
 * Budget for the "does the organizer have their own recap?" probe, matching
 * the watcher's constant of the same name. The session is already closed by
 * the time it runs, so this only picks a destination — never block on it.
 */
const DESTINATION_PROBE_MS = 1_200;

/**
 * Hard ceiling on the initiator's optimistic lock. applyDraftCapOverride
 * always resolves (server actions never throw past their own try/finally), so
 * this only fires when the fetch itself never settles — offline tab, sleeping
 * device, proxy that holds the socket open. Longer than the server-side lease
 * (CAP_PHASE_LOCK_TTL_MS = 45s) so the authoritative "done" wins the race in
 * every normal case and this is purely a last-resort escape hatch.
 */
const CAP_LOCK_WATCHDOG_MS = 60_000;

/** Bound on remembered self-op ids — only the in-flight one ever matters. */
const MY_CAP_OPS_MAX = 8;

/**
 * UUID for the op-correlation id. `crypto.randomUUID` is secure-context-only,
 * so it is `undefined` over plain http — e.g. a phone hitting a dev box at
 * http://192.168.x.x:3000. Calling it there would throw on the first line of
 * handleCapChange, before any setState, and the popover's `void onChange(cap)`
 * would swallow the rejection: the chip does nothing, silently. That is the
 * exact failure class this whole change set exists to remove, so fall back to
 * `getRandomValues` (available in insecure contexts too) and hand-assemble a
 * v4. The server validates this with isValidUUID, hence the version/variant
 * nibbles rather than 32 loose hex digits.
 *
 * Deliberately TOTAL — it has no throwing path. A helper whose whole purpose is
 * to stop an exception on the first line of handleCapChange must not be able to
 * raise one itself, so even "no Web Crypto at all" degrades rather than throws.
 */
function newOpId(): string {
  const c = typeof crypto === "undefined" ? undefined : crypto;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(b);
  } else {
    // Unreachable in practice — getRandomValues is not secure-context-gated and
    // ships in every browser and Node >= 19. Math.random is acceptable as the
    // floor because this id is a self-echo correlator, never a secret: the
    // server only ever validates its shape and echoes it back.
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  /**
   * The viewing organizer's profile id. Used to route them to their OWN
   * Wrapped recap on close — they played tonight too. Optional so existing
   * tests and any non-authenticated render path keep working; without it the
   * close flow falls back to the lobby.
   */
  organizerId?: string;
  /** liveSession.is_auto_matchmaking_on — updated via broadcast */
  liveAutoMatchmaking: boolean;
  /** liveSession.auto_publish — updated via broadcast */
  liveAutoPublish: boolean;
  /** queue.filter(q => q.is_bottleneck).length */
  bottleneckCount: number;
  /** draftMatches.length */
  draftCount: number;
  /** from useSwapState — wired to the Esc key */
  handleCancelSwap: () => void;
  /**
   * Latest `draft_cap_phase` signal observed on the session broadcast channel
   * (from useOrganizerSession). Because REST-originated broadcasts have no
   * sending socket, the initiator receives its own echo too — `opId` is what
   * lets this hook tell "my own operation" apart from a co-organizer's.
   */
  capSignal?: CapPhaseSignal;
  /**
   * `suppressLocalClose` from useSessionClosedWatcher. Called with `true` for
   * the duration of this tab's own close so the watcher does not also react to
   * the organizer's own broadcast echo (two toasts, two competing pushes), and
   * released when the close turns out not to have closed anything.
   */
  suppressCloseWatcher?: (suppressed: boolean) => void;
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

  // Auto-publish mode toggle
  autoPublish: boolean;
  togglingAutoPublish: boolean;
  /** enabled = the desired new state. ON triggers the clear-and-refill (D3). */
  handleToggleAutoPublish: (enabled: boolean) => Promise<void>;

  // Draft cap override
  capPhase: CapPhase;
  /**
   * Display name of the co-organizer who triggered the in-flight cap change,
   * or null when the phase is self-initiated / the name is unknown.
   */
  capPhaseActorName: string | null;
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
  organizerId,
  liveAutoMatchmaking,
  liveAutoPublish,
  bottleneckCount,
  draftCount,
  handleCancelSwap,
  capSignal = IDLE_CAP_SIGNAL,
  suppressCloseWatcher,
}: UseOrganizerDashboardParams): UseOrganizerDashboardResult {
  const router = useRouter();
  const clubSlug = useClubSlug();
  const isClosed = !sessionIsActive;

  // ── Tab navigation ────────────────────────────────────────
  // Initial value only. `isClosed` now flips WHILE the board is mounted (a
  // co-organizer closed it, or this organizer just did), and the closed board
  // offers a different, shorter tab set — so the stored value is clamped
  // against `tabs` below rather than trusted.
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

  // ── Auto-publish optimistic toggle (mirrors auto-matchmaking) ──
  const [pendingAutoPublish, setPendingAutoPublish] = useState<boolean | null>(null);
  const [togglingAutoPublish, setTogglingAutoPublish] = useState(false);

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

  // ── pendingAutoPublish yield-back (mirrors pendingAuto) ───
  useEffect(() => {
    if (pendingAutoPublish !== null && liveAutoPublish === pendingAutoPublish) {
      setPendingAutoPublish(null);
    }
  }, [liveAutoPublish, pendingAutoPublish]);

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

  /**
   * Close the session, then get the organizer off the dead board.
   *
   * The caller MUST have called `event.preventDefault()` — this runs from an
   * AlertDialogAction, which is Radix's Dialog.Close, so without that the
   * dialog dismisses on the same click that starts the request and the
   * "Closing…" label paints exactly once onto a node already fading out. That
   * is the whole of "it didn't fire right away" on the organizer's screen: the
   * ~1.2 s of Wrapped pre-compute happens behind a dialog that already left.
   * We hold the dialog open for the duration and dismiss it ourselves.
   */
  const handleCloseSession = useCallback(async () => {
    setClosing(true);
    // BEFORE the action, not after: a REST broadcast has no sending socket, so
    // this tab receives its own session_closed echo while closeSession is still
    // in flight.
    suppressCloseWatcher?.(true);
    try {
      const result = await closeSession(sessionId);

      // `alreadyClosed` is a success from the organizer's point of view: a
      // double-submit, or a co-organizer who got there first. The session is
      // in the state they asked for, so say so and leave.
      if (result.success || result.alreadyClosed) {
        setCloseOpen(false);

        if (result.success) {
          toast.success(result.message);
        } else {
          toast.info("This session was already closed.");
        }

        // The one thing the organizer can act on: the session is committed
        // closed but no phone was told. Offer the re-send rather than letting
        // 40 players sit on a stale board until their poll catches up.
        if (result.success && result.delivered === false) {
          toast.warning("Players weren't notified", {
            duration: 15_000,
            closeButton: true,
            description: "The session is closed, but the live alert didn't go out.",
            action: {
              label: "Re-send",
              onClick: () => {
                void renotifySessionClosed(sessionId).then((r) => {
                  if (r.success) toast.success(r.message);
                  else toast.error(r.message);
                });
              },
            },
          });
        }

        // The organizer played too — send them to their own recap, same as
        // everyone else, and fall back to the lobby when there is nothing to
        // show (compute failed, or they only ran the board tonight).
        const lobbyPath = clubSlug ? clubBase(clubSlug) : "/organizer";

        if (result.wrappedReady === false || !organizerId) {
          router.push(lobbyPath);
          return;
        }

        const wrappedPath = clubSlug
          ? clubWrapped(clubSlug, sessionId, organizerId)
          : `/wrapped/${sessionId}/${organizerId}`;

        // Bounded and caught, both load-bearing. The session is already
        // committed closed at this point, so this probe only chooses between
        // two destinations — but an unguarded await here would be the one path
        // in the whole flow that can strand the organizer: a rejection escapes
        // into the catch below and reports a FAILURE for a close that
        // succeeded, and a hang means `finally` never runs, so `closing` stays
        // true, no push fires, and suppressCloseWatcher is never released —
        // leaving all three watcher paths dead with nothing to recover them.
        // Giving up costs the organizer a lobby instead of their own recap.
        const status = await withTimeout(
          getPlayerSessionStatus(sessionId).catch(() => null),
          DESTINATION_PROBE_MS
        );
        router.push(
          status?.success && !status.isActive && status.hasWrapped ? wrappedPath : lobbyPath
        );
        return;
      }

      // Nothing was closed — hand the watcher back, so a co-organizer closing
      // it a minute later still moves this board.
      suppressCloseWatcher?.(false);
      toast.error(result.message ?? "Failed to close session.");
    } catch (err) {
      // A transport failure here says nothing about whether the close landed —
      // the action may have committed and only the response was lost. Ask.
      console.error("[handleCloseSession] unexpected throw:", err);
      // Bounded for the same reason as the probe above, and more so: the thing
      // that put us in this catch is a misbehaving transport, which is exactly
      // the condition that produces a hang rather than a rejection. Unbounded,
      // `finally` never runs — `closing` stays true and suppressCloseWatcher is
      // never released, so all three watcher paths stay deaf with nothing left
      // to recover them. Giving up costs a spurious "please try again" on a
      // close that landed; the watcher then moves this board anyway.
      const status = await withTimeout(
        getPlayerSessionStatus(sessionId).catch(() => null),
        DESTINATION_PROBE_MS
      );
      if (status?.success && !status.isActive) {
        setCloseOpen(false);
        toast.success("Session closed.");
        router.push(clubSlug ? clubBase(clubSlug) : "/organizer");
        return;
      }
      suppressCloseWatcher?.(false);
      toast.error("Failed to close session. Please try again.");
    } finally {
      setClosing(false);
    }
  }, [sessionId, organizerId, router, clubSlug, suppressCloseWatcher]);

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

  const handleToggleAutoPublish = useCallback(
    async (enabled: boolean) => {
      setTogglingAutoPublish(true);
      setPendingAutoPublish(enabled); // optimistic
      try {
        const result = await toggleAutoPublish(sessionId, enabled);
        if (result.success) {
          setPendingAutoPublish(result.isOn);
          if (result.isOn) {
            const clearedNote =
              result.clearedCount && result.clearedCount > 0
                ? ` Cleared ${result.clearedCount} draft${result.clearedCount !== 1 ? "s" : ""}.`
                : "";
            toast.success("Auto-publish ON", {
              description: `New matches skip review and go straight to On Deck.${clearedNote}`,
              position: "bottom-right",
              duration: 3_000,
            });
          } else {
            toast("Auto-publish OFF", {
              description: "New matches return to draft review. On-deck matches stay live.",
              position: "bottom-right",
              duration: 3_000,
            });
          }
        } else {
          setPendingAutoPublish(null);
          toast.error(result.message ?? "Failed to toggle auto-publish.");
        }
      } catch (err) {
        console.error("[handleToggleAutoPublish] unexpected throw:", err);
        setPendingAutoPublish(null);
        toast.error("Failed to toggle auto-publish. Please try again.");
      } finally {
        setTogglingAutoPublish(false);
      }
    },
    [sessionId]
  );

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
  //
  // The whole clear → regenerate sequence runs inside ONE server action
  // (applyDraftCapOverride). It is the action — not this hook — that emits
  // clearing / generating / done on the session broadcast channel, because
  // the service-role key required to publish only exists on the server.
  // (Before 2026-08-04 this hook called broadcastDraftCapPhase directly; in
  // the browser the key is undefined, so every emit silently no-op'd and
  // co-organizers were never locked out. See APP_MANIFEST §3.28.)
  //
  // Two lock sources feed the overlay:
  //   localCapPhase — optimistic, so the initiator sees the lock on click
  //                   instead of waiting for a broadcast round-trip.
  //   capSignal     — the authoritative phase from the channel; this is what
  //                   locks CO-ORGANIZERS out.
  //
  // A REST-published broadcast has no sending socket, so the initiator also
  // receives its own echo. myOpIds is the self-correlator: opId (not actorId,
  // which would misclassify the same organizer's second tab as "self") tells
  // our own echo apart from a co-organizer's. Without it, our own trailing
  // "clearing" could re-lock this dashboard right after the action resolved.
  const [localCapPhase, setLocalCapPhase] = useState<CapPhase>(null);
  const [myOpIds, setMyOpIds] = useState<string[]>([]);

  const isSelfSignal = capSignal.opId !== null && myOpIds.includes(capSignal.opId);
  // A co-organizer's phase — the only one allowed to lock us on its own.
  const remotePhase: CapPhase = isSelfSignal ? null : capSignal.phase;
  // Our own echo never *creates* a lock; it only advances the label of the
  // optimistic one we already hold ("Clearing…" → "Generating…").
  const selfPhase: CapPhase = isSelfSignal ? capSignal.phase : null;
  const capPhase: CapPhase = localCapPhase === null ? remotePhase : (selfPhase ?? localCapPhase);
  const capPhaseActorName =
    localCapPhase === null && remotePhase !== null ? capSignal.actorName : null;
  const isDashboardLocked = capPhase !== null;

  // Last-resort unlock for the initiator: see CAP_LOCK_WATCHDOG_MS.
  useEffect(() => {
    if (localCapPhase === null) return;
    const timer = setTimeout(() => {
      setLocalCapPhase(null);
      toast.error("Draft cap change timed out. Refresh to confirm the result.");
    }, CAP_LOCK_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [localCapPhase]);

  const handleCapChange = useCallback(
    async (cap: number | null) => {
      const opId = newOpId();
      // Registered BEFORE the await so our own echo can never arrive first.
      setMyOpIds((prev) => [...prev, opId].slice(-MY_CAP_OPS_MAX));
      setLocalCapPhase("clearing");

      try {
        const result = await applyDraftCapOverride(sessionId, cap, opId);
        if (!result.success) {
          toast.error(result.error ?? "Failed to apply the draft cap. Please try again.");
        }
      } catch (err) {
        // Server actions return errors rather than throwing, so this is a
        // transport failure (offline, deploy mid-flight, aborted navigation).
        console.error("[handleCapChange] applyDraftCapOverride threw:", err);
        toast.error("Couldn't reach the server. Please try again.");
      } finally {
        // Always unlock this dashboard. The action's own `finally` emits the
        // terminal "done" that unlocks everyone else.
        setLocalCapPhase(null);
      }
    },
    [sessionId]
  );

  // ── Derived values ────────────────────────────────────────

  // Show the optimistic value during the server round-trip, then
  // yield back to the authoritative liveAutoMatchmaking once confirmed.
  const autoMatchmaking = pendingAuto ?? liveAutoMatchmaking;
  const autoPublish = pendingAutoPublish ?? liveAutoPublish;

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

  // A live close drops the tab set from five to two. Derive the effective tab
  // instead of storing it: an organizer sitting on "Active Courts" when the
  // session ends would otherwise keep a panel full of live court controls on
  // screen with no tab in the strip selected — controls that now silently
  // no-op against the post-close write guard.
  const effectiveTab = tabs.some((t) => t.key === activeTab) ? activeTab : tabs[0].key;

  return {
    activeTab: effectiveTab,
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
  };
}
