"use client";

// ============================================================
// useOrganizerBroadcast — Player-side intervention listener
// ============================================================
// Subscribes to the session's broadcast channel and surfaces a
// toast notification whenever the organizer clears an On Deck
// match or cancels an In-Progress match that the current player
// was assigned to.
//
// This prevents the silent "your match card just disappeared"
// confusion on the player's screen. The toast gives players
// a human-readable reason for the change and persists until
// they dismiss it.
// ============================================================

import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { createClient } from "@/utils/supabase/client";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import type { OrganizerInterventionPayload } from "@/lib/broadcast";

// Toast copy — friendly, blame-shifting, context-specific.
const TOAST_MESSAGES: Record<OrganizerInterventionPayload["type"], string> = {
  on_deck_cleared:
    "The organizer adjusted the queue. Your match has been rescheduled — you're back in line.",
  match_cancelled:
    "The organizer cancelled your match. You've been returned to the queue.",
};

export function useOrganizerBroadcast(sessionId: string, playerId: string): void {
  const supabase = useMemo(() => createClient(), []);

  // Keep a stable ref to the latest playerId so the subscription
  // callback always reads the current value without re-registering.
  const playerIdRef = useRef(playerId);
  useEffect(() => {
    playerIdRef.current = playerId;
  });

  useEffect(() => {
    const unsub = subscribeToOrganizerBroadcast(
      supabase,
      sessionId,
      (payload: OrganizerInterventionPayload) => {
        // Only show the toast if this player is affected.
        if (!payload.affectedPlayerIds.includes(playerIdRef.current)) return;

        const message = TOAST_MESSAGES[payload.type] ?? TOAST_MESSAGES.match_cancelled;

        toast.info(message, {
          // Keep it on screen long enough to read (5 s).
          duration: 5_000,
          // Explicit dismiss button so players can clear it on their own terms.
          closeButton: true,
          description: "Your queue position and wait time have been preserved.",
        });
      }
    );

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId]);
}
