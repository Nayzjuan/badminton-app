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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import { getSessionForOrganizer } from "@/app/actions/sessions";
import type { AutoMatchmakingToggledPayload, CapSaturationPayload } from "@/lib/broadcast";
import type { Session } from "@/types/database";

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
export function useOrganizerSession(
  sessionId: string,
  initialSession: Session,
  supabase: SupabaseClient<Database>
): {
  liveSession: Session;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  realtimeConnected: boolean;
  capSaturation: CapSaturationPayload | null;
  dismissCapSaturation: () => void;
  handleChannelStatus: (channelId: string, connected: boolean) => void;
} {
  const [liveSession, setSession] = useState<Session>(initialSession);
  const [realtimeConnected, setRealtimeConnected] = useState(true);
  const [capSaturation, setCapSaturation] = useState<CapSaturationPayload | null>(null);

  // Tracks which channel IDs have confirmed SUBSCRIBED — Set prevents double-counting.
  const connectedChannelIds = useRef(new Set<string>());

  // Monotonic sequence counter for session refresh — guards against stale polls.
  const fetchSessionSeq = useRef(0);

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
    const sessionChannel = supabase
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
          // Apply all session field changes EXCEPT is_auto_matchmaking_on.
          // That field is synced via Broadcast so co-organizers also receive it.
          const next = payload.new as Partial<Session>;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { is_auto_matchmaking_on: _, ...rest } = next;
          setSession((prev) => ({ ...prev, ...rest }));
        }
      )
      .subscribe();

    // Auto-matchmaking toggle sync via Broadcast (bypasses RLS).
    const unsubBroadcast = subscribeToOrganizerBroadcast(supabase, sessionId, {
      onIntervention: () => {},
      onAutoMatchmakingToggled: (payload: AutoMatchmakingToggledPayload) => {
        // Invalidate any in-flight fetchSession poll (F3 fix).
        ++fetchSessionSeq.current;
        setSession((prev) => ({
          ...prev,
          is_auto_matchmaking_on: payload.isOn,
        }));
      },
      onCapSaturation: (payload: CapSaturationPayload) => {
        setCapSaturation(payload);
      },
    });

    return () => {
      supabase.removeChannel(sessionChannel);
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
  };
}
