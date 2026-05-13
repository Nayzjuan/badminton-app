// ============================================================
// Real-Time Subscription Helpers
// ============================================================
// Thin wrappers around Supabase Realtime to subscribe to
// table changes scoped to a session. Each returns an
// unsubscribe function for cleanup in useEffect.
//
// Debugging: open your browser DevTools console and look for
// [realtime] log lines. A successful subscription prints:
//   [realtime] courts:abc123 → SUBSCRIBED
// A failure (e.g. due to missing RLS SELECT policy) prints:
//   [realtime] courts:abc123 → CHANNEL_ERROR ...
// ============================================================

import type { SupabaseClient, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type {
  OrganizerInterventionPayload,
  SessionClosedPayload,
  AutoMatchmakingToggledPayload,
  CapSaturationPayload,
} from "@/lib/broadcast";

type TypedClient = SupabaseClient<Database>;
type ChangeHandler<T extends Record<string, unknown>> = (
  payload: RealtimePostgresChangesPayload<T>
) => void;

/**
 * Subscribe to all changes on a table, filtered by session_id.
 * Returns a cleanup function that removes the channel.
 *
 * @param onStatus  Optional callback invoked whenever the channel's
 *                  connection state changes. Receives the channel's
 *                  unique name and `true` (SUBSCRIBED) or `false`
 *                  (CHANNEL_ERROR / TIMED_OUT). Passing the channel ID
 *                  lets callers track per-channel state in a Set rather
 *                  than a bare counter — preventing double-count when a
 *                  channel fires SUBSCRIBED twice on reconnect.
 */
function subscribeToTable<T extends Record<string, unknown>>(
  supabase: TypedClient,
  table: string,
  sessionId: string,
  onChange: ChangeHandler<T>,
  channelPrefix?: string,
  onStatus?: (channelId: string, connected: boolean) => void
): () => void {
  const channelName = channelPrefix
    ? `${channelPrefix}:${table}:${sessionId}`
    : `${table}:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on<T>(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table,
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        console.log(`[realtime] ${channelName} event:`, payload.eventType);
        onChange(payload);
      }
    )
    .subscribe((status, err) => {
      if (err) {
        // The most common cause: the table is in the realtime publication
        // but the user lacks a SELECT RLS policy. Supabase silently drops
        // the event server-side, but if the channel itself fails you'll
        // see it here.
        console.error(`[realtime] ${channelName} subscription error:`, err);
        onStatus?.(channelName, false);
      } else {
        console.log(`[realtime] ${channelName} →`, status);
        // Expected statuses:
        //   SUBSCRIBED      — channel is live and receiving events ✓
        //   CHANNEL_ERROR   — something went wrong (check err above)
        //   TIMED_OUT       — no response from server within timeout
        //   CLOSED          — channel removed (cleanup called)
        if (status === "SUBSCRIBED") {
          onStatus?.(channelName, true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onStatus?.(channelName, false);
        }
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

// ---- Table-specific exports ----

export function subscribeToCourts(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["courts"]["Row"]>,
  channelPrefix?: string,
  onStatus?: (channelId: string, connected: boolean) => void
) {
  return subscribeToTable(supabase, "courts", sessionId, onChange, channelPrefix, onStatus);
}

export function subscribeToQueue(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["queue_entries"]["Row"]>,
  channelPrefix?: string,
  onStatus?: (channelId: string, connected: boolean) => void
) {
  return subscribeToTable(supabase, "queue_entries", sessionId, onChange, channelPrefix, onStatus);
}

export function subscribeToMatches(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["matches"]["Row"]>,
  channelPrefix?: string,
  onStatus?: (channelId: string, connected: boolean) => void
) {
  return subscribeToTable(supabase, "matches", sessionId, onChange, channelPrefix, onStatus);
}

export function subscribeToMatchPlayers(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["match_players"]["Row"]>,
  channelPrefix?: string,
  onStatus?: (channelId: string, connected: boolean) => void
) {
  // match_players has no session_id column, so we subscribe broadly
  // and let the callback + state refresh handle filtering.
  const channelName = channelPrefix
    ? `${channelPrefix}:match_players:${sessionId}`
    : `match_players:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on("postgres_changes", { event: "*", schema: "public", table: "match_players" }, (payload) => {
      console.log(`[realtime] ${channelName} event:`, payload.eventType);
      onChange(
        payload as RealtimePostgresChangesPayload<
          Database["public"]["Tables"]["match_players"]["Row"]
        >
      );
    })
    .subscribe((status, err) => {
      if (err) {
        console.error(`[realtime] ${channelName} subscription error:`, err);
        onStatus?.(channelName, false);
      } else {
        console.log(`[realtime] ${channelName} →`, status);
        if (status === "SUBSCRIBED") {
          onStatus?.(channelName, true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onStatus?.(channelName, false);
        }
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to all profile changes. Profiles have no session_id, so
 * this subscribes broadly — the callback should re-fetch relevant
 * data (queue view, match players, etc.) to pick up the new skill.
 */
/**
 * Subscribe to organizer intervention broadcast events on the
 * session's dedicated broadcast channel.
 *
 * The server emits these after clearOnDeckMatch and cancelMatchAction
 * so affected players can be shown a contextual toast instead of
 * experiencing a silent UI state change.
 *
 * Channel: "session-events:{sessionId}"
 * Event:   "organizer_intervention"
 */
export function subscribeToOrganizerBroadcast(
  supabase: TypedClient,
  sessionId: string,
  onIntervention: (payload: OrganizerInterventionPayload) => void,
  onSessionClosed?: (payload: SessionClosedPayload) => void,
  onAutoMatchmakingToggled?: (payload: AutoMatchmakingToggledPayload) => void,
  onCapSaturation?: (payload: CapSaturationPayload) => void
): () => void {
  const channelName = `session-events:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on(
      "broadcast",
      { event: "organizer_intervention" },
      (msg: { payload: OrganizerInterventionPayload }) => {
        console.log(`[realtime] ${channelName} broadcast:`, msg.payload);
        onIntervention(msg.payload);
      }
    )
    .on("broadcast", { event: "session_closed" }, (msg: { payload: SessionClosedPayload }) => {
      console.log(`[realtime] ${channelName} session_closed:`, msg.payload);
      onSessionClosed?.(msg.payload);
    })
    .on(
      "broadcast",
      { event: "auto_matchmaking_toggled" },
      (msg: { payload: AutoMatchmakingToggledPayload }) => {
        console.log(`[realtime] ${channelName} auto_matchmaking_toggled:`, msg.payload);
        onAutoMatchmakingToggled?.(msg.payload);
      }
    )
    .on("broadcast", { event: "cap_saturation" }, (msg: { payload: CapSaturationPayload }) => {
      console.log(`[realtime] ${channelName} cap_saturation:`, msg.payload);
      onCapSaturation?.(msg.payload);
    })
    .subscribe((status, err) => {
      if (err) {
        console.error(`[realtime] ${channelName} broadcast subscription error:`, err);
      } else {
        console.log(`[realtime] ${channelName} broadcast →`, status);
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

export function subscribeToProfiles(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["profiles"]["Row"]>,
  channelPrefix?: string,
  onStatus?: (channelId: string, connected: boolean) => void
) {
  const channelName = channelPrefix
    ? `${channelPrefix}:profiles:${sessionId}`
    : `profiles:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, (payload) => {
      console.log(`[realtime] ${channelName} event:`, payload.eventType);
      onChange(
        payload as RealtimePostgresChangesPayload<Database["public"]["Tables"]["profiles"]["Row"]>
      );
    })
    .subscribe((status, err) => {
      if (err) {
        console.error(`[realtime] ${channelName} subscription error:`, err);
        onStatus?.(channelName, false);
      } else {
        console.log(`[realtime] ${channelName} →`, status);
        if (status === "SUBSCRIBED") {
          onStatus?.(channelName, true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onStatus?.(channelName, false);
        }
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
