"use client";

// ============================================================
// useSessionClosedWatcher — "the organizer closed the session"
// ============================================================
// One place that answers a single question for every in-session
// screen: has this session ended, and if so where does this
// viewer go? Player dashboard and organizer board both mount it.
//
// THREE INDEPENDENT DETECTION PATHS, because each one alone has a
// hole the others cover:
//
//   1. broadcast `session_closed` — fastest (sub-100 ms), but
//      fire-and-forget with no replay and no queue for absent
//      subscribers. A tab that was backgrounded, mid-reconnect, or
//      never authorized on the private channel simply never hears it.
//      Fed in by the caller (see `handleSessionClosed`) rather than
//      subscribed here, so we don't open a second channel on a topic
//      the caller already holds.
//
//   2. `sessions` row postgres_changes — a committed row change, so
//      any tab holding a live join gets it even if the broadcast POST
//      failed outright. Owned by this hook.
//
//   3. status poll + visibility/channel-status triggers — the only
//      path that works with no realtime connection at all. Slowest,
//      and deliberately last.
//
// All three funnel into one latched navigation. The destination is
// resolved per viewer, NOT assumed: a player with no
// session_wrapped_stats row (a walk-in who never got on court, or a
// close whose compute_session_wrapped failed) is sent to the club
// lobby instead of a Wrapped page that would render an all-zero recap
// and then remember having been dismissed.
// ============================================================

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToSessionRow } from "@/lib/realtime";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubBase, clubWrapped } from "@/lib/club-paths";
import { getPlayerSessionStatus } from "@/app/actions/sessions";
import { withTimeout } from "@/lib/with-timeout";
import type { SessionClosedPayload } from "@/lib/broadcast";

/**
 * Let the "session's over" toast register before the route changes.
 *
 * Was 800 ms. The audit that produced this hook measured the server-side
 * pre-work at ~346 ms mean / ~1.4 s tail — i.e. the client's own politeness
 * delay was the single largest term in "why didn't Wrapped fire right away".
 * 250 ms is enough for the toast to paint, and it doubles as the window the
 * destination probe runs in, so the shorter delay costs nothing.
 */
const WRAPPED_REDIRECT_DELAY_MS = 250;

/**
 * How long the per-viewer destination probe gets before we commit anyway.
 * Deliberately longer than the toast delay: if the probe answers we route
 * exactly, and if it doesn't we fall back to the broadcast's session-wide
 * hint rather than stranding the viewer on a dead board.
 */
const DESTINATION_PROBE_MS = 1_200;

/** Hard ceiling on the status server action; see `withTimeout`. */
const STATUS_ACTION_TIMEOUT_MS = 8_000;

/**
 * Safety-net cadence for the closure fallback.
 *
 * Was 120 s, on the reasoning that the broadcast is the real delivery path.
 * That reasoning assumed the broadcast works; when it doesn't, this interval
 * IS the product — the gap between the organizer's click and ~40 phones
 * noticing. 20 s is a worst case someone will sit through without concluding
 * the app is broken, and the request is a single indexed read.
 */
const SESSION_STATUS_POLL_MS = 20_000;

/** Floor on the gap between two closure checks, whatever triggered them. */
const SESSION_STATUS_MIN_GAP_MS = 5_000;

export type SessionClosedWatcher = {
  /**
   * Feed the broadcast `session_closed` event in. Wire this to
   * `subscribeToOrganizerBroadcast`'s `onSessionClosed` at the call site.
   */
  handleSessionClosed: (payload?: SessionClosedPayload) => void;
  /**
   * Feed a broadcast-channel status transition in. Every transition, in both
   * directions, means the channel either never joined or dropped and re-joined
   * — and `session_closed` has no replay, so any gap is a message that can
   * never arrive on its own. Triggers a closure re-check.
   */
  handleChannelStatus: () => void;
  /**
   * Suppress the automatic navigation while THIS tab is running its own close
   * flow, and release it if that flow turns out not to have closed anything.
   *
   * A REST-originated broadcast has no sending socket, so the organizer who
   * clicked "close" receives their own `session_closed` echo — and it lands
   * while `closeSession` is still in flight. Without this the organizer gets
   * two toasts and two competing `router.push`es for one click. `suppress()`
   * must therefore be called BEFORE the action, not after it resolves.
   */
  suppressLocalClose: (suppressed: boolean) => void;
};

export function useSessionClosedWatcher(
  sessionId: string,
  playerId: string,
  options?: {
    /**
     * Where to send a viewer who has no Wrapped recap. Defaults to the club
     * lobby (or `/play` off-club). The organizer board passes its own.
     */
    fallbackPath?: string;
    /** Copy for the pre-redirect toast. */
    toastMessage?: string;
  }
): SessionClosedWatcher {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const router = useRouter();
  const clubSlug = useClubSlug();

  const fallbackPath = options?.fallbackPath;
  const toastMessage = options?.toastMessage ?? "Session's over — time to see your awards! 🏆";

  // Keep stable refs so subscription callbacks always read current values
  // without re-registering channels.
  const playerIdRef = useRef(playerId);
  const routerRef = useRef(router);
  const clubSlugRef = useRef(clubSlug);
  const fallbackPathRef = useRef(fallbackPath);
  const toastMessageRef = useRef(toastMessage);
  useEffect(() => {
    playerIdRef.current = playerId;
  });
  useEffect(() => {
    routerRef.current = router;
  });
  useEffect(() => {
    clubSlugRef.current = clubSlug;
  });
  useEffect(() => {
    fallbackPathRef.current = fallbackPath;
  });
  useEffect(() => {
    toastMessageRef.current = toastMessage;
  });

  // All three detection paths can conclude "closed" for the same closure
  // within the same second. This latches on the first so the viewer is
  // navigated exactly once.
  const navigatedRef = useRef(false);
  const unmountedRef = useRef(false);
  // See `suppressLocalClose`. Separate from `navigatedRef` because it is
  // releasable — a failed close must not leave this tab permanently deaf.
  const suppressedRef = useRef(false);

  // The redirect delay means a push can still be pending after this component
  // is gone. That is a real race, not a theoretical one: the closed session
  // also makes the RSC redirect the player (the club play page bounces a
  // returning player to the lobby once the session is inactive), and an
  // uncancelled push would then yank them off the page they just landed on.
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Reset on every mount, not just the first: StrictMode's double-invoke in
    // dev would otherwise leave this latched true for the surviving mount.
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (redirectTimerRef.current !== null) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  /** The path a viewer with no recap goes to. */
  const resolveFallbackPath = useCallback(() => {
    const slug = clubSlugRef.current;
    return fallbackPathRef.current ?? (slug ? clubBase(slug) : "/play");
  }, []);

  /** Resolve where THIS viewer goes, given whatever the signal already told us. */
  const resolveDestination = useCallback(
    async (known: boolean | undefined): Promise<string> => {
      const slug = clubSlugRef.current;
      const wrappedPath = slug
        ? clubWrapped(slug, sessionId, playerIdRef.current)
        : `/wrapped/${sessionId}/${playerIdRef.current}`;
      const lobbyPath = resolveFallbackPath();

      // `false` is session-wide and authoritative: compute_session_wrapped did
      // not succeed, so no recap exists for anyone. Skip the probe.
      if (known === false) return lobbyPath;

      const status = await withTimeout(
        getPlayerSessionStatus(sessionId).catch(() => null),
        DESTINATION_PROBE_MS
      );
      // `!isActive` is part of the guard on purpose: getPlayerSessionStatus
      // documents `hasWrapped` as meaningful only for a closed session. It is
      // not reachable today (the flip commits before any signal we react to),
      // but reading the field without it would silently become wrong the day
      // that ordering changes.
      if (status?.success && !status.isActive) {
        return status.hasWrapped ? wrappedPath : lobbyPath;
      }

      // Probe inconclusive. `known === true` means the server confirmed the
      // session-wide compute succeeded, so Wrapped is the better guess; with
      // nothing at all, prefer the page that always renders.
      return known === true ? wrappedPath : lobbyPath;
    },
    [sessionId, resolveFallbackPath]
  );

  /**
   * Announce the close and move this viewer. Idempotent.
   *
   * @param wrappedReady session-wide hint from whichever signal detected the
   *   close: `true`/`false` from the broadcast payload, `undefined` when it
   *   came from the row subscription or a poll (older clients also send
   *   `undefined`, which must NOT be read as `false`).
   */
  const leaveClosedSession = useCallback(
    (wrappedReady: boolean | undefined) => {
      if (navigatedRef.current || suppressedRef.current) return;
      navigatedRef.current = true;

      toast.info(toastMessageRef.current, { duration: 2_000 });

      // Repaint the current route from the server immediately, so anything
      // still on screen reflects the closed session even if the push below is
      // slow or the viewer is on a page that does not redirect.
      routerRef.current.refresh();

      // Resolve the destination while the toast is on screen, then navigate.
      //
      // The delay is a MINIMUM, not a deadline. Racing the probe against it
      // instead would make WRAPPED_REDIRECT_DELAY_MS the probe's real budget:
      // at 250 ms against a round-trip that costs about that much, the probe
      // would lose nearly every time and every viewer would be sent to the
      // lobby — the precise outcome this hook exists to avoid. `resolveDestination`
      // bounds itself at DESTINATION_PROBE_MS, so this can wait safely.
      //
      // The timer is what makes this cancellable: clearing it on unmount leaves
      // the promise permanently pending, so nothing pushes onto a dead route.
      // `unmountedRef` covers the same case for an unmount that lands after the
      // timer already fired.
      const toastShown = new Promise<void>((resolve) => {
        redirectTimerRef.current = setTimeout(() => {
          redirectTimerRef.current = null;
          resolve();
        }, WRAPPED_REDIRECT_DELAY_MS);
      });

      void Promise.all([resolveDestination(wrappedReady), toastShown]).then(([path]) => {
        if (unmountedRef.current) return;
        routerRef.current.push(path);
      });
    },
    [resolveDestination]
  );

  // ── Path 1: broadcast (fed in by the caller) ──────────────────
  const handleSessionClosed = useCallback(
    (payload?: SessionClosedPayload) => {
      leaveClosedSession(payload?.wrappedReady);
    },
    [leaveClosedSession]
  );

  // ── Path 3: status poll ───────────────────────────────────────
  // Declared before path 2 because the row subscription's status handler
  // shares this ref. A ref (not a dependency) so wiring them together cannot
  // re-register a channel.
  const checkClosedRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let lastCheckAt = 0;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function checkClosed() {
      if (cancelled || navigatedRef.current || inFlight) return;

      const now = Date.now();
      const wait = SESSION_STATUS_MIN_GAP_MS - (now - lastCheckAt);
      if (wait > 0) {
        // RESCHEDULE rather than discard. Dropping the tick meant a burst of
        // triggers (channel flap, tab restore) could consume every check in a
        // window and then leave nothing scheduled until the next interval —
        // exactly the moment a closure is most likely to have been missed.
        if (retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void checkClosed();
          }, wait);
        }
        return;
      }

      lastCheckAt = now;
      inFlight = true;
      try {
        const result = await withTimeout(
          getPlayerSessionStatus(sessionId),
          STATUS_ACTION_TIMEOUT_MS
        );
        if (cancelled || navigatedRef.current) return;
        // ONLY a definite "still exists, no longer active" navigates. Every
        // other outcome — null (timed out), unauthenticated, transport
        // failure, row unreadable — holds the dashboard, because a false
        // positive would yank a player out of a session that is still running.
        if (result?.success && !result.isActive) leaveClosedSession(result.hasWrapped);
      } catch {
        // Server-action transport failure. Hold; the next trigger retries.
      } finally {
        inFlight = false;
      }
    }

    checkClosedRef.current = () => void checkClosed();

    const interval = setInterval(() => void checkClosed(), SESSION_STATUS_POLL_MS);

    // Phone unlock / tab restore is the realistic recovery moment: the socket
    // was killed while the screen was off, so the missed message (if any) is
    // waiting to be discovered right here. Separate from useVisibilityRefresh
    // — that hook also calls router.refresh(), which the dashboard already
    // does; this listener only asks the one question.
    function onVisibilityChange() {
      if (document.visibilityState === "visible") void checkClosed();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (retryTimer !== null) clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId, leaveClosedSession]);

  const handleChannelStatus = useCallback(() => {
    checkClosedRef.current();
  }, []);

  const suppressLocalClose = useCallback((suppressed: boolean) => {
    suppressedRef.current = suppressed;
  }, []);

  // ── Path 2: the session's own row ─────────────────────────────
  useEffect(() => {
    const unsub = subscribeToSessionRow(
      supabase,
      sessionId,
      (payload) => {
        // UPDATE carries the full new row, so `is_active` is always readable
        // here. Guarded anyway: an unexpected shape should stall the watcher,
        // not eject someone from a live session.
        const next = payload.new as { is_active?: boolean };
        if (next?.is_active === false) leaveClosedSession(undefined);
      },
      // No channelPrefix: one watcher per session per tab, and a bare name
      // keeps it out of the organizer board's REALTIME_CHANNEL_COUNT bucket.
      undefined,
      // Any status transition on THIS channel is also a reason to re-check —
      // it means we may have been deaf across the moment of closure.
      () => checkClosedRef.current()
    );
    return () => unsub();
  }, [supabase, sessionId, leaveClosedSession]);

  return { handleSessionClosed, handleChannelStatus, suppressLocalClose };
}
