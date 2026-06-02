// ============================================================
// Real-Time Subscription Helpers
// ============================================================
// Thin wrappers around Supabase Realtime to subscribe to
// table changes scoped to a session. Each returns an
// unsubscribe function for cleanup in useEffect.
//
// Debugging: only errors (CHANNEL_ERROR, TIMED_OUT) are logged to the
// console to avoid noise in production. Successful subscriptions are
// tracked via the onStatus callback (called with `true` on SUBSCRIBED).
// A failure (e.g. due to missing RLS SELECT policy) prints:
//   [realtime] courts:abc123 → CHANNEL_ERROR
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
type StatusHandler = (channelId: string, connected: boolean) => void;

/**
 * Narrows an untyped Realtime payload to a typed one.
 *
 * Supabase does not provide generic typing for unfiltered table subscriptions
 * (those without a `filter` clause) because the SDK can't guarantee the row
 * shape at compile time. The cast here is safe: the Realtime server always
 * sends the full row as `new` / `old` for the exact table schema registered
 * in the publication. Any divergence would be a Supabase server-side change,
 * not a client-side type error.
 */
function castPayload<T extends Record<string, unknown>>(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>
): RealtimePostgresChangesPayload<T> {
  return payload as RealtimePostgresChangesPayload<T>;
}

/**
 * Returns a reusable Supabase channel `.subscribe()` callback that logs
 * connection status and calls `onStatus` (if provided) so callers can
 * track per-channel connectivity state in a Set rather than a counter.
 *
 * Common failure: the table is in the realtime publication but the
 * caller's JWT fails the SELECT RLS policy. Supabase silently drops
 * events server-side; if the channel itself errors you'll see it via
 * the onStatus(channelId, false) call.
 */
function createStatusHandler(
  channelName: string,
  onStatus?: StatusHandler
): (status: string, err?: Error) => void {
  return (status, err) => {
    if (err) {
      console.error(`[realtime] ${channelName} subscription error:`, err);
      onStatus?.(channelName, false);
    } else {
      // Only log non-nominal statuses — SUBSCRIBED is expected and logged
      // at the onStatus level; CLOSED is expected on cleanup. Logging every
      // status transition creates 10+ log lines per session load in prod.
      if (status === "SUBSCRIBED") {
        onStatus?.(channelName, true);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(`[realtime] ${channelName} → ${status}`);
        onStatus?.(channelName, false);
      }
    }
  };
}

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
        onChange(payload);
      }
    )
    .subscribe(createStatusHandler(channelName, onStatus));

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
      onChange(castPayload<Database["public"]["Tables"]["match_players"]["Row"]>(payload));
    })
    .subscribe(createStatusHandler(channelName, onStatus));

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Handlers for the session-level broadcast channel.
 * `onIntervention` is required; all others are optional so callers can
 * subscribe only to the events they actually handle.
 */
export type OrganizerBroadcastHandlers = {
  /** Fired after an organizer clears an on-deck match or cancels an in-progress one. */
  onIntervention: (payload: OrganizerInterventionPayload) => void;
  /** Fired when the organizer closes the session; clients should redirect to Wrapped. */
  onSessionClosed?: (payload: SessionClosedPayload) => void;
  /** Fired when any organizer flips the auto-matchmaking toggle. */
  onAutoMatchmakingToggled?: (payload: AutoMatchmakingToggledPayload) => void;
  /** Fired when the partner-pair cap blocks match formation for a waiting player. */
  onCapSaturation?: (payload: CapSaturationPayload) => void;
};

/**
 * Subscribe to organizer broadcast events on the session's dedicated channel.
 *
 * The server emits these after organizer actions (match clear/cancel,
 * session close, auto-matchmaking toggle) so clients react immediately
 * without polling. Pass only the handlers you need — the rest are optional.
 *
 * Channel: "session-events:{sessionId}"
 */
export function subscribeToOrganizerBroadcast(
  supabase: TypedClient,
  sessionId: string,
  handlers: OrganizerBroadcastHandlers
): () => void {
  const { onIntervention, onSessionClosed, onAutoMatchmakingToggled, onCapSaturation } = handlers;
  const channelName = `session-events:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on(
      "broadcast",
      { event: "organizer_intervention" },
      (msg: { payload: OrganizerInterventionPayload }) => {
        onIntervention(msg.payload);
      }
    )
    .on("broadcast", { event: "session_closed" }, (msg: { payload: SessionClosedPayload }) => {
      onSessionClosed?.(msg.payload);
    })
    .on(
      "broadcast",
      { event: "auto_matchmaking_toggled" },
      (msg: { payload: AutoMatchmakingToggledPayload }) => {
        onAutoMatchmakingToggled?.(msg.payload);
      }
    )
    .on("broadcast", { event: "cap_saturation" }, (msg: { payload: CapSaturationPayload }) => {
      onCapSaturation?.(msg.payload);
    })
    .subscribe((status, err) => {
      if (err) {
        console.error(`[realtime] ${channelName} broadcast subscription error:`, err);
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to all profile changes. Profiles have no session_id column, so
 * this subscribes broadly — the callback should re-fetch the queue view,
 * match players, or any derived data to pick up the updated skill level.
 */
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
      onChange(castPayload<Database["public"]["Tables"]["profiles"]["Row"]>(payload));
    })
    .subscribe(createStatusHandler(channelName, onStatus));

  return () => {
    supabase.removeChannel(channel);
  };
}
