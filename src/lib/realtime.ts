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

type TypedClient = SupabaseClient<Database>;
type ChangeHandler<T extends Record<string, unknown>> = (
  payload: RealtimePostgresChangesPayload<T>
) => void;

/**
 * Subscribe to all changes on a table, filtered by session_id.
 * Returns a cleanup function that removes the channel.
 */
function subscribeToTable<T extends Record<string, unknown>>(
  supabase: TypedClient,
  table: string,
  sessionId: string,
  onChange: ChangeHandler<T>
): () => void {
  const channelName = `${table}:${sessionId}`;

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
      } else {
        console.log(`[realtime] ${channelName} →`, status);
        // Expected statuses:
        //   SUBSCRIBED      — channel is live and receiving events ✓
        //   CHANNEL_ERROR   — something went wrong (check err above)
        //   TIMED_OUT       — no response from server within timeout
        //   CLOSED          — channel removed (cleanup called)
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
  onChange: ChangeHandler<Database["public"]["Tables"]["courts"]["Row"]>
) {
  return subscribeToTable(supabase, "courts", sessionId, onChange);
}

export function subscribeToQueue(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["queue_entries"]["Row"]>
) {
  return subscribeToTable(supabase, "queue_entries", sessionId, onChange);
}

export function subscribeToMatches(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["matches"]["Row"]>
) {
  return subscribeToTable(supabase, "matches", sessionId, onChange);
}

export function subscribeToMatchPlayers(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["match_players"]["Row"]>
) {
  // match_players has no session_id column, so we subscribe broadly
  // and let the callback + state refresh handle filtering.
  const channelName = `match_players:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "match_players" },
      (payload) => {
        console.log(`[realtime] ${channelName} event:`, payload.eventType);
        onChange(payload as RealtimePostgresChangesPayload<Database["public"]["Tables"]["match_players"]["Row"]>);
      }
    )
    .subscribe((status, err) => {
      if (err) {
        console.error(`[realtime] ${channelName} subscription error:`, err);
      } else {
        console.log(`[realtime] ${channelName} →`, status);
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

export function subscribeToMatchGames(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["match_games"]["Row"]>
) {
  const channelName = `match_games:${sessionId}`;

  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "match_games" },
      (payload) => {
        console.log(`[realtime] ${channelName} event:`, payload.eventType);
        onChange(payload as RealtimePostgresChangesPayload<Database["public"]["Tables"]["match_games"]["Row"]>);
      }
    )
    .subscribe((status, err) => {
      if (err) {
        console.error(`[realtime] ${channelName} subscription error:`, err);
      } else {
        console.log(`[realtime] ${channelName} →`, status);
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

export function subscribeToSessionOrganizers(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["session_organizers"]["Row"]>
) {
  return subscribeToTable(supabase, "session_organizers", sessionId, onChange);
}
