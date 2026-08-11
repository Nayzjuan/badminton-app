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
//     → hands off to useSessionClosedWatcher, which decides where
//        this player goes (their Wrapped recap, or the club lobby
//        when no recap exists for them) and gets them there.
//
// The closure logic does NOT live here. It is shared with the
// organizer board via useSessionClosedWatcher, and it needs two
// detection paths this channel cannot provide: the session row's own
// postgres_changes stream, and a status poll for tabs with no live
// socket. This hook owns exactly one of the three paths — the fast
// one — and feeds it in.
// ============================================================

import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import { useSessionClosedWatcher } from "@/hooks/use-session-closed-watcher";
import type { OrganizerInterventionPayload } from "@/lib/broadcast";

// Toast copy — friendly, blame-shifting, context-specific.
const TOAST_MESSAGES: Record<OrganizerInterventionPayload["type"], string> = {
  on_deck_cleared:
    "The organizer adjusted the queue. Your match has been rescheduled — you're back in line.",
  match_cancelled: "The organizer cancelled your match. You've been returned to the queue.",
  active_roster_changed: "The organizer updated your court's lineup. Your match continues.",
};

export function useOrganizerBroadcast(sessionId: string, playerId: string): void {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // Keep a stable ref so the subscription callback always reads the current
  // player id without re-registering the channel.
  const playerIdRef = useRef(playerId);
  useEffect(() => {
    playerIdRef.current = playerId;
  });

  const { handleSessionClosed, handleChannelStatus } = useSessionClosedWatcher(sessionId, playerId);

  // Callbacks are re-created whenever the watcher's identity changes; hold them
  // in refs so the channel is registered once per session, not once per render.
  const handleSessionClosedRef = useRef(handleSessionClosed);
  const handleChannelStatusRef = useRef(handleChannelStatus);
  useEffect(() => {
    handleSessionClosedRef.current = handleSessionClosed;
  });
  useEffect(() => {
    handleChannelStatusRef.current = handleChannelStatus;
  });

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
      onSessionClosed: (payload) => {
        handleSessionClosedRef.current(payload);
      },
      onStatus: () => {
        handleChannelStatusRef.current();
      },
    });

    return () => unsub();
  }, [supabase, sessionId]);
}
