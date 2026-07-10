"use client";

// ============================================================
// useOrganizerSession — live session state + realtime health
// ============================================================
// Manages:
//   liveSession     — live session record (updates in real-time)
//   realtimeConnected — health indicator (all channels SUBSCRIBED)
//   capSaturation   — partner-pair cap saturation notice
//
// Provides:
//   handleChannelStatus — callback passed to other sub-hooks so
//                         they can report their channel status.
//   dismissCapSaturation
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import { whenRealtimeAuthReady } from "@/utils/supabase/client";
import { getSessionForOrganizer } from "@/app/actions/sessions";
import type {
  AutoMatchmakingToggledPayload,
  AutoPublishToggledPayload,
  CapSaturationPayload,
  DraftCapPhasePayload,
  OrganizerInterventionPayload,
} from "@/lib/broadcast";
import type { Session } from "@/types/database";

// Organizer-facing copy for a co-organizer's intervention. Distinct from the
// player-side messages in useOrganizerBroadcast — these tell the OTHER
// organizer what a co-organizer just did, so a cleared/cancelled match doesn't
// silently vanish from their board. {actor} is filled from the payload.
const CO_ORGANIZER_INTERVENTION_COPY: Record<
  OrganizerInterventionPayload["type"],
  (actor: string) => string
> = {
  on_deck_cleared: (actor) => `${actor} cleared an on-deck match.`,
  match_cancelled: (actor) => `${actor} cancelled a match.`,
  active_roster_changed: (actor) => `${actor} changed a court lineup.`,
};

// Total number of table channels tracked for the realtimeConnected indicator.
// courts(1) + queue_entries(1) + matches(1) + match_players(1) + profiles(1) = 5
const REALTIME_CHANNEL_COUNT = 5;

/**
 * Manages the live session record, realtime health tracking, and cap saturation signals.
 *
 * `realtimeConnected` is true only after all five table channels have confirmed
 * SUBSCRIBED status. The dashboard shows a ReconnectModal when this is false.
 *
 * `handleChannelStatus` is a stable callback — safe to pass to child sub-hooks
 * without causing subscription restarts on re-renders.
 */
/** Phase exposed to the UI. 'done' is broadcast-only and maps to null here. */
export type CapPhase = "clearing" | "generating" | null;

export function useOrganizerSession(
  sessionId: string,
  initialSession: Session,
  supabase: SupabaseClient<Database>,
  /** The viewing organizer's own id — used to suppress their own intervention toast. */
  currentUserId: string
): {
  liveSession: Session;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  realtimeConnected: boolean;
  capSaturation: CapSaturationPayload | null;
  dismissCapSaturation: () => void;
  handleChannelStatus: (channelId: string, connected: boolean) => void;
  /** Phase of a draft-cap reset driven by a co-organizer or self. */
  externalCapPhase: CapPhase;
} {
  const [liveSession, setSession] = useState<Session>(initialSession);
  const [realtimeConnected, setRealtimeConnected] = useState(true);
  const [capSaturation, setCapSaturation] = useState<CapSaturationPayload | null>(null);
  const [externalCapPhase, setExternalCapPhase] = useState<CapPhase>(null);

  // Tracks which channel IDs have confirmed SUBSCRIBED — Set prevents double-counting.
  const connectedChannelIds = useRef(new Set<string>());

  // Monotonic sequence counter for session refresh — guards against stale polls.
  const fetchSessionSeq = useRef(0);

  // Stable ref so the broadcast callback reads the current id without
  // re-registering the channel (the subscription effect deps stay minimal).
  const currentUserIdRef = useRef(currentUserId);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  });

  // ── Session refresh ───────────────────────────────────────────
  // Lightweight poll/reconnect handler. Uses server action (getSessionForOrganizer)
  // backed by service-role so it works for both the creator AND co-organizers.
  const fetchSession = useCallback(async () => {
    const mySeq = ++fetchSessionSeq.current;
    const result = await getSessionForOrganizer(sessionId);
    if (mySeq !== fetchSessionSeq.current) return; // stale — discard
    if (!result.success || !result.session) {
      console.error("[useOrganizerSession] fetchSession error:", result.error);
      return;
    }
    setSession(result.session);
  }, [sessionId]);

  // Stable ref so polling effects don't need fetchSession in dep arrays.
  const fetchSessionRef = useRef(fetchSession);
  // eslint-disable-next-line react-hooks/refs
  fetchSessionRef.current = fetchSession;

  // ── Stable handleChannelStatus callback ───────────────────────
  // Passed to every sub-hook so they can report their channel status.
  const handleChannelStatus = useCallback(
    (channelId: string, connected: boolean) => {
      if (connected) {
        connectedChannelIds.current.add(channelId);
      } else {
        connectedChannelIds.current.delete(channelId);
      }
      setRealtimeConnected(connectedChannelIds.current.size === REALTIME_CHANNEL_COUNT);
    },
    [] // stable — only accesses refs and stable setState dispatchers
  );

  // ── Session settings channel + organizer broadcast ─────────────
  useEffect(() => {
    connectedChannelIds.current.clear();

    // Session settings channel — filtered to this session ID.
    // Handles court_time_limit_minutes changes made by the organizer.
    // Not included in the health counter — it's a metadata channel, not
    // a player-data channel, so we don't need it to be "live" for gameplay.
    //
    // NOTE: is_auto_matchmaking_on is intentionally NOT synced through
    // this channel. The sessions table RLS SELECT policy only grants access
    // to the session creator, so co-organizers would never receive this
    // UPDATE event. Auto-toggle state is synced via the Broadcast channel.
    // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady
    // in src/utils/supabase/client.ts): postgres_changes RLS binds to the
    // socket's role at join time, and the club-scoped sessions SELECT policy
    // rejects `anon`, so joining before the organizer's JWT propagates would
    // silently deliver zero events. The 15s poll below is the fallback.
    let sessionChannel: RealtimeChannel | null = null;
    let sessionChannelCancelled = false;

    void whenRealtimeAuthReady().then(() => {
      if (sessionChannelCancelled) return;
      sessionChannel = supabase
        .channel(`session-settings:${sessionId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "sessions",
            filter: `id=eq.${sessionId}`,
          },
          (payload) => {
            // Apply all session field changes EXCEPT is_auto_matchmaking_on and
            // auto_publish. Those are synced via Broadcast so co-organizers (who
            // are blocked by the sessions RLS SELECT policy) also receive them.
            const next = payload.new as Partial<Session>;
            const { is_auto_matchmaking_on: _a, auto_publish: _p, ...rest } = next;
            setSession((prev) => ({ ...prev, ...rest }));
          }
        )
        .subscribe();
    });

    // Auto-matchmaking toggle sync via Broadcast (bypasses RLS).
    const unsubBroadcast = subscribeToOrganizerBroadcast(supabase, sessionId, {
      // A co-organizer cleared/cancelled a match. The board already drops the
      // card (Postgres row-delete event), but silently — this toast explains
      // WHO did WHAT so it isn't a mysterious disappearance. Only fires when an
      // actor is attached (clear/cancel) and it wasn't THIS organizer.
      onIntervention: (payload: OrganizerInterventionPayload) => {
        const actorId = payload.actorId;
        if (!actorId || actorId === currentUserIdRef.current) return;
        const copy = CO_ORGANIZER_INTERVENTION_COPY[payload.type];
        if (!copy) return;
        toast.info(copy(payload.actorName ?? "A co-organizer"), {
          duration: 5_000,
          closeButton: true,
        });
      },
      onAutoMatchmakingToggled: (payload: AutoMatchmakingToggledPayload) => {
        // Invalidate any in-flight fetchSession poll (F3 fix).
        ++fetchSessionSeq.current;
        setSession((prev) => ({
          ...prev,
          is_auto_matchmaking_on: payload.isOn,
        }));
      },
      onAutoPublishToggled: (payload: AutoPublishToggledPayload) => {
        ++fetchSessionSeq.current;
        setSession((prev) => ({
          ...prev,
          auto_publish: payload.isOn,
        }));
      },
      onCapSaturation: (payload: CapSaturationPayload) => {
        setCapSaturation(payload);
      },
      onDraftCapPhaseChanged: (payload: DraftCapPhasePayload) => {
        // Sync co-organizer lockout overlay with whoever triggered the cap reset.
        setExternalCapPhase(payload.phase === "done" ? null : payload.phase);
        // When 'done', also sync the cap value from the session refresh.
        if (payload.phase === "done") {
          ++fetchSessionSeq.current;
          fetchSessionRef.current();
        }
      },
    });

    return () => {
      sessionChannelCancelled = true;
      if (sessionChannel) supabase.removeChannel(sessionChannel);
      unsubBroadcast();
    };
  }, [supabase, sessionId]);

  // ── Layer 2 — Polling + visibility refresh ────────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchSessionRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchSessionRef.current();
      }
    }, 15000);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(interval);
    };
  }, []);

  // ── Layer 3 — Reconnect refresh ───────────────────────────────
  const prevRealtimeConnected = useRef(realtimeConnected);
  useEffect(() => {
    if (realtimeConnected && !prevRealtimeConnected.current) {
      fetchSessionRef.current();
    }
    prevRealtimeConnected.current = realtimeConnected;
  }, [realtimeConnected]);

  const dismissCapSaturation = useCallback(() => {
    setCapSaturation(null);
  }, []);

  return {
    liveSession,
    setSession,
    realtimeConnected,
    capSaturation,
    dismissCapSaturation,
    handleChannelStatus,
    externalCapPhase,
  };
}
