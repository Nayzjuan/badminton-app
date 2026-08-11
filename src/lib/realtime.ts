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

import type {
  SupabaseClient,
  RealtimePostgresChangesPayload,
  RealtimeChannel,
} from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { whenRealtimeAuthReady } from "@/utils/supabase/client";
import type {
  OrganizerInterventionPayload,
  SessionClosedPayload,
  AutoMatchmakingToggledPayload,
  AutoPublishToggledPayload,
  CapSaturationPayload,
  DraftCapPhasePayload,
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

  // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady):
  // postgres_changes RLS binds to the socket's role at join time, so joining
  // before the user's JWT propagates would evaluate club-scoped policies as
  // `anon` and silently deliver zero rows.
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  void whenRealtimeAuthReady().then(() => {
    if (cancelled) return;
    channel = supabase
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
  });

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
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
  // match_players has no session_id column, so we subscribe broadly and let the
  // callback + state refresh handle filtering.
  //
  // Denormalizing session_id onto match_players to make this filterable was
  // designed, costed and DECLINED on 2026-08-04 — the design is banked in
  // PENDING_WORK_2026-07-23.md so nobody re-derives it. The short version:
  //
  //   • It would suppress no measured traffic. postgres_changes re-checks
  //     `match_players_select` → has_match_access → session_access_level per row,
  //     so cross-CLUB events are already suppressed server-side, and the club has
  //     never run two sessions concurrently — a session_id filter's entire
  //     remaining job is cross-session-within-a-club events, of which prod has
  //     had zero across 27 sessions.
  //   • It could not cover DELETE anyway. Filters are matched against the OLD
  //     row for a DELETE, and this table is REPLICA IDENTITY DEFAULT, so `old`
  //     carries only the PK — a session_id filter silently drops every DELETE.
  //     Fixing THAT needs REPLICA IDENTITY FULL, i.e. a WAL cost on a hot table
  //     to buy a filter that suppresses nothing.
  //
  // The real cost this binding was blamed for was a CLIENT problem, not a filter
  // problem. Each draft is 1 `matches` row + 4 `match_players` rows, so at
  // MAX_AUTO_DRAFTS_XLARGE (6) a clear-then-regenerate DELIVERS ~54 events: 24
  // match_players DELETEs on the clear (this channel is unfiltered, and Realtime
  // skips RLS on DELETE), then 6 matches + 24 match_players INSERTs on the
  // rebuild. The 6 matches DELETEs are dropped by subscribeToTable's
  // `session_id` filter for the reason given two bullets up — it matches the OLD
  // row, which is PK-only. Every delivered event used to trigger its own refetch.
  // The fix is caller-side: share one trailingDebounce with the caller's
  // `matches` subscription so a match INSERT and its four match_players INSERTs
  // collapse into a single refetch. Four of the five call sites do that
  // (use-session-data, use-organizer-matches, use-player-match, use-tv-board);
  // use-match-alerts deliberately does not — see the note at its subscription.
  // Revisit the column only if a second club goes live AND two sessions run
  // concurrently in one of them.
  const channelName = channelPrefix
    ? `${channelPrefix}:match_players:${sessionId}`
    : `match_players:${sessionId}`;

  // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady).
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  void whenRealtimeAuthReady().then(() => {
    if (cancelled) return;
    channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "match_players" },
        (payload) => {
          onChange(castPayload<Database["public"]["Tables"]["match_players"]["Row"]>(payload));
        }
      )
      .subscribe(createStatusHandler(channelName, onStatus));
  });

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to the session's OWN row (`sessions.id = sessionId`).
 *
 * This exists as a second, independent delivery path for "the organizer closed
 * the session". The broadcast on `session-events:{sessionId}` is the fast path,
 * but it is fire-and-forget: `postBroadcast` swallows every failure, the
 * Realtime broadcast API does not queue for absent subscribers, and a tab that
 * was backgrounded or mid-reconnect at close time simply never hears it. The
 * `is_active` flip, by contrast, is a committed row change — so any tab holding
 * a live postgres_changes join gets it, and the two paths fail independently.
 *
 * No migration is needed: `sessions` is already in the `supabase_realtime`
 * publication, and `sessions_select` admits both the organizer
 * (`is_session_organizer(id)`) and every club member (`is_club_member(club_id)`),
 * which is a superset of the audience that can already see the board.
 *
 * ⚠️ Do NOT wire this channel's `onStatus` into useOrganizerSession's
 * `handleChannelStatus`. That counter asserts an EXACT
 * REALTIME_CHANNEL_COUNT (use-organizer-session.ts:48) of *postgres_changes*
 * channels, so a sixth would peg the board's "live" indicator to disconnected
 * forever — the same trap documented on OrganizerBroadcastHandlers.onStatus.
 *
 * Note the filter column: `id`, not `session_id`, which is why this cannot go
 * through subscribeToTable.
 */
export function subscribeToSessionRow(
  supabase: TypedClient,
  sessionId: string,
  onChange: ChangeHandler<Database["public"]["Tables"]["sessions"]["Row"]>,
  channelPrefix?: string,
  onStatus?: StatusHandler
): () => void {
  const channelName = channelPrefix
    ? `${channelPrefix}:session-row:${sessionId}`
    : `session-row:${sessionId}`;

  // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady):
  // `sessions_select` is club-scoped, so an `anon`-bound join delivers nothing.
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  void whenRealtimeAuthReady().then(() => {
    if (cancelled) return;
    channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          onChange(castPayload<Database["public"]["Tables"]["sessions"]["Row"]>(payload));
        }
      )
      .subscribe(createStatusHandler(channelName, onStatus));
  });

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
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
  /** Fired when any organizer flips the auto-publish mode toggle. */
  onAutoPublishToggled?: (payload: AutoPublishToggledPayload) => void;
  /** Fired when the partner-pair cap blocks match formation for a waiting player. */
  onCapSaturation?: (payload: CapSaturationPayload) => void;
  /**
   * Fired during a draft-cap reset: 'clearing' → 'generating' → 'done'.
   * All co-organizers use this to display the lockout overlay in sync.
   */
  onDraftCapPhaseChanged?: (payload: DraftCapPhasePayload) => void;
  /**
   * Optional connection-state callback, same contract as the postgres_changes
   * subscribers. It exists because this channel went private (migration
   * 20260723100000) and can now be refused for *authorization* reasons, not
   * only connectivity ones.
   *
   * No caller passes it today, and that is a considered choice rather than an
   * oversight — see the note in use-organizer-broadcast.ts for the player side.
   * On the organizer side it must NOT be fed to useOrganizerSession's
   * `handleChannelStatus`: that counter asserts an exact
   * REALTIME_CHANNEL_COUNT of *postgres_changes* channels, so adding a sixth
   * would peg the board's "live" indicator to disconnected forever.
   */
  onStatus?: StatusHandler;
};

/**
 * Subscribe to organizer broadcast events on the session's dedicated channel.
 *
 * The server emits these after organizer actions (match clear/cancel,
 * session close, auto-matchmaking toggle) so clients react immediately
 * without polling. Pass only the handlers you need — the rest are optional.
 *
 * Channel: "session-events:{sessionId}" — PRIVATE. The join is authorized by
 * the `session_events_broadcast_read` policy on `realtime.messages`
 * (migration 20260723100000), which admits anyone with a non-NULL
 * `session_access_level` for the session — the same predicate that already
 * gates `courts_select` and `queue_select`, so the audience is unchanged from
 * the set that can already read the board.
 *
 * Two consequences of `private: true` that the public version did not have:
 *   • the join MUST happen after the Realtime JWT is set, or it is evaluated
 *     as `anon` and refused outright (the policy is `TO authenticated`);
 *   • the server must mark its messages private too — see postBroadcast() in
 *     src/lib/broadcast.ts. Private subscribers do not receive public messages.
 */
export function subscribeToOrganizerBroadcast(
  supabase: TypedClient,
  sessionId: string,
  handlers: OrganizerBroadcastHandlers
): () => void {
  const {
    onIntervention,
    onSessionClosed,
    onAutoMatchmakingToggled,
    onAutoPublishToggled,
    onCapSaturation,
    onDraftCapPhaseChanged,
    onStatus,
  } = handlers;
  const channelName = `session-events:${sessionId}`;

  // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady).
  // For a private channel this is not an optimisation: joining as `anon` fails
  // the policy and the channel errors out instead of quietly delivering
  // nothing, so every session event would be lost for the tab's lifetime.
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  void whenRealtimeAuthReady().then(() => {
    if (cancelled) return;
    channel = supabase
      .channel(channelName, { config: { private: true } })
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
      .on(
        "broadcast",
        { event: "auto_publish_toggled" },
        (msg: { payload: AutoPublishToggledPayload }) => {
          onAutoPublishToggled?.(msg.payload);
        }
      )
      .on("broadcast", { event: "cap_saturation" }, (msg: { payload: CapSaturationPayload }) => {
        onCapSaturation?.(msg.payload);
      })
      .on("broadcast", { event: "draft_cap_phase" }, (msg: { payload: DraftCapPhasePayload }) => {
        onDraftCapPhaseChanged?.(msg.payload);
      })
      .subscribe(createStatusHandler(channelName, onStatus));
  });

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to all profile changes. Profiles have no session_id column, so
 * this subscribes broadly — the callback should re-fetch the queue view,
 * match players, or any derived data to pick up the updated skill level.
 *
 * No `filter` on purpose, and this is NOT the unscoped firehose it looks like.
 * postgres_changes evaluates the table's SELECT policy per row at delivery
 * under the role bound at JOIN time (see whenRealtimeAuthReady above), so
 * migration 20260723200000 narrowing `profiles_select` to
 * shared-club-or-shared-session narrowed this stream with it — that migration
 * says so explicitly under "DELIBERATELY NOT DONE HERE". A client-side filter
 * would be redundant, and is also not expressible: postgres_changes filters
 * take a single column with eq/neq/lt/lte/gt/gte/in, "shared club" is not a
 * single-column predicate, and an `id=in.(…)` approximation would need a
 * teardown+rejoin on every queue mutation — which the organizer board cannot
 * absorb: its `realtimeConnected` indicator asserts an EXACT
 * REALTIME_CHANNEL_COUNT of simultaneously-connected postgres_changes channels
 * (use-organizer-session.ts:212), so a channel cycling through re-join would
 * flap the board to "disconnected" on every queue mutation. What remains is
 * intra-club refetch noise, and
 * profile writes are rare and organizer-initiated (skill edit, PIN reset,
 * OAuth rename, registration upsert).
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

  // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady).
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  void whenRealtimeAuthReady().then(() => {
    if (cancelled) return;
    channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, (payload) => {
        onChange(castPayload<Database["public"]["Tables"]["profiles"]["Row"]>(payload));
      })
      .subscribe(createStatusHandler(channelName, onStatus));
  });

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}
