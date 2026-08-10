"use client";

// ============================================================
// useOrganizerBroadcast — Player-side broadcast listener
// ============================================================
// Subscribes to the session's broadcast channel and handles
// two events:
//
//   organizer_intervention — organizer cleared/cancelled a match
//     → shows a toast so the player knows why their card changed
//
//   session_closed — organizer closed the session
//     → redirects the player to their personal Wrapped page
//        (club-scoped /c/[slug]/wrapped/... when a club slug is
//        resolvable from the current path, else root /wrapped/...)
//
// Both are fire-and-forget from the server. The broadcast is the
// FAST path for closure; because it has no replay and no delivery
// guarantee, this hook also runs a slow server-action fallback so
// a player whose channel never joined still reaches Wrapped.
// ============================================================

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubWrapped } from "@/lib/club-paths";
import { getPlayerSessionStatus } from "@/app/actions/sessions";
import type { OrganizerInterventionPayload } from "@/lib/broadcast";

// Toast copy — friendly, blame-shifting, context-specific.
const TOAST_MESSAGES: Record<OrganizerInterventionPayload["type"], string> = {
  on_deck_cleared:
    "The organizer adjusted the queue. Your match has been rescheduled — you're back in line.",
  match_cancelled: "The organizer cancelled your match. You've been returned to the queue.",
  active_roster_changed: "The organizer updated your court's lineup. Your match continues.",
};

/** Let the "session's over" toast render before the route changes. */
const WRAPPED_REDIRECT_DELAY_MS = 800;

/**
 * Safety-net cadence for the closure fallback. Deliberately slow: the
 * broadcast is the real delivery path and the visibility / channel-status
 * triggers below cover the realistic recovery moments, so this only has to
 * catch a tab that is awake, joined, and silently missing messages.
 */
const SESSION_STATUS_POLL_MS = 120_000;

/** Floor on the gap between two closure checks, whatever triggered them. */
const SESSION_STATUS_MIN_GAP_MS = 10_000;

export function useOrganizerBroadcast(sessionId: string, playerId: string): void {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const router = useRouter();
  const clubSlug = useClubSlug();

  // Keep stable refs so the subscription callback always reads
  // current values without re-registering the channel.
  const playerIdRef = useRef(playerId);
  const routerRef = useRef(router);
  const clubSlugRef = useRef(clubSlug);
  useEffect(() => {
    playerIdRef.current = playerId;
  });
  useEffect(() => {
    routerRef.current = router;
  });
  useEffect(() => {
    clubSlugRef.current = clubSlug;
  });

  // The broadcast and the fallback poll can both conclude "closed" — for the
  // same closure — within the same second. This latches on the first one so
  // the player is navigated exactly once.
  const navigatedRef = useRef(false);

  // The 800 ms delay means a push can still be pending after this component is
  // gone. That is a real race, not a theoretical one: the closed session also
  // makes the RSC redirect the player (the club play page bounces a returning
  // player to the lobby once the session is inactive), and an uncancelled push
  // would then yank them off the page they just landed on, 800 ms late.
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (redirectTimerRef.current !== null) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  /** Toast + redirect to this player's Wrapped page. Idempotent. */
  const goToWrapped = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;

    // Brief toast so the player knows what's happening, then redirect.
    toast.info("Session's over — time to see your awards! 🏆", {
      duration: 2_000,
    });
    redirectTimerRef.current = setTimeout(() => {
      redirectTimerRef.current = null;
      const slug = clubSlugRef.current;
      routerRef.current.push(
        slug
          ? clubWrapped(slug, sessionId, playerIdRef.current)
          : `/wrapped/${sessionId}/${playerIdRef.current}`
      );
    }, WRAPPED_REDIRECT_DELAY_MS);
  }, [sessionId]);

  // ── Closure fallback ──────────────────────────────────────────
  // Set by the poll effect below; called by the channel-status handler in the
  // subscription effect. A ref (not a dependency) so wiring the two together
  // cannot re-register the channel.
  const checkClosedRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let lastCheckAt = 0;
    let inFlight = false;

    async function checkClosed() {
      if (cancelled || navigatedRef.current || inFlight) return;
      const now = Date.now();
      if (now - lastCheckAt < SESSION_STATUS_MIN_GAP_MS) return;
      lastCheckAt = now;
      inFlight = true;
      try {
        const result = await getPlayerSessionStatus(sessionId);
        if (cancelled || navigatedRef.current) return;
        // ONLY a definite "still exists, no longer active" navigates. Every
        // error path — unauthenticated, transport failure, row unreadable —
        // holds the dashboard, because a false positive would yank a player
        // out of a session that is still running.
        if (result.success && !result.isActive) goToWrapped();
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
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId, goToWrapped]);

  useEffect(() => {
    // `onStatus` carries no user-visible signal on purpose: transient
    // CHANNEL_ERROR / TIMED_OUT is normal on gym wifi and Realtime reconnects
    // on its own, so a "live updates are down" toast would misfire constantly.
    // It drives the closure re-check instead — every transition, in both
    // directions, means either the channel never joined or it dropped and
    // re-joined, and session_closed is fire-and-forget with no replay, so any
    // gap is a message that can never arrive on its own.
    //
    // Failures stay visible in the console: createStatusHandler logs them, and
    // since the channel went private (migration 20260723100000) an
    // authorization refusal arrives with an explicit "Unauthorized: You do not
    // have permissions to read from this Channel topic: session-events:<id>".
    const unsub = subscribeToOrganizerBroadcast(supabase, sessionId, {
      // ── organizer_intervention ────────────────────────────
      onIntervention: (payload: OrganizerInterventionPayload) => {
        if (!payload.affectedPlayerIds.includes(playerIdRef.current)) return;

        const message = TOAST_MESSAGES[payload.type] ?? TOAST_MESSAGES.match_cancelled;
        toast.info(message, {
          duration: 5_000,
          closeButton: true,
          description: "Your queue position and wait time have been preserved.",
        });
      },
      // ── session_closed ────────────────────────────────────
      onSessionClosed: () => {
        goToWrapped();
      },
      onStatus: () => {
        checkClosedRef.current();
      },
    });

    return () => unsub();
  }, [supabase, sessionId, goToWrapped]);
}
