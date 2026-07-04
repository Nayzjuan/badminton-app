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
// Both are fire-and-forget from the server. Failures are silent
// on the server side; this hook is the only delivery mechanism.
// ============================================================

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubWrapped } from "@/lib/club-paths";
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

  useEffect(() => {
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
        // Brief toast so the player knows what's happening, then redirect.
        toast.info("Session's over — time to see your awards! 🏆", {
          duration: 2_000,
        });
        // Give the toast 800ms to render before navigating.
        setTimeout(() => {
          const slug = clubSlugRef.current;
          routerRef.current.push(
            slug
              ? clubWrapped(slug, sessionId, playerIdRef.current)
              : `/wrapped/${sessionId}/${playerIdRef.current}`
          );
        }, 800);
      },
    });

    return () => unsub();
  }, [supabase, sessionId]);
}
