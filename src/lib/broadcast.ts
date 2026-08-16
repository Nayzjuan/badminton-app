import "server-only";

// ============================================================
// Server-side Realtime Broadcast Helpers
// ============================================================
// Uses the Supabase Realtime REST API to push ephemeral
// Broadcast messages to all connected clients on a session
// channel — without opening a WebSocket from the server.
//
// All functions are fire-and-forget: failures are logged but
// never propagate to the caller. The underlying DB transaction
// has already succeeded before these are called.
//
// Channel naming — the topic here must match the client's channel name EXACTLY:
//   Server sends to topic: "session-events:{sessionId}"
//   Client subscribes to:  supabase.channel("session-events:{sessionId}")
//
// Do NOT prefix the topic with "realtime:". The REST API answers 202 for any
// topic string, so a prefixed topic looks like a successful send while being
// routed to a channel no client ever joins — every event silently vanishes.
// This was shipped for months and confirmed against PRODUCTION on 2026-08-04:
// an authenticated subscriber on "session-events:{id}" received the unprefixed
// message and never received the prefixed one. It went unnoticed because the
// two toggle events have a 15s polling fallback in use-organizer-session.ts
// that made them look delivered; session_closed, cap_saturation and
// organizer_intervention have no fallback and were simply dead. Covered by
// [R-1]/[R-2] in tests/e2e/scenario-r-resilience.spec.ts, which assert
// delivery inside a window too short for the poll to explain.
//
// FIXED 2026-08-04 — draft_cap_phase was dead for a SECOND, independent reason.
// This module used to have no server-side guard, so it was bundled into any
// client that imported it. use-organizer-dashboard.ts ("use client") called
// broadcastDraftCapPhase for the "clearing"/"generating"/"done" phases, and in
// the browser SUPABASE_SERVICE_ROLE_KEY is undefined — the client build compiles
// it to a runtime process.env read, not an inlined literal (verified in the
// emitted chunk) — so postBroadcast short-circuited at the guard below and
// logged "[broadcast] Missing SUPABASE_URL or service role key". Those phases
// were never sent, and removing the topic prefix did not change that. The
// co-organizer lockout overlay had therefore never engaged.
// All three phases are now emitted server-side by applyDraftCapOverride in
// src/app/actions/sessions.ts, which is the ONLY caller of broadcastDraftCapPhase.
//
// `import "server-only"` above is the real guard: it fails the BUILD if this
// module ever re-enters a client bundle, so the class of bug cannot silently
// return. The missing-key check in postBroadcast is now defence-in-depth for
// misconfigured server environments, not the only thing standing between a
// browser and a dead broadcast.
//
// NEVER add "use server" to this module. It would compile — type exports are
// erased and all six senders are already async — and it would appear to fix the
// original bug by turning the client import into an RPC. It would also publish
// six ungated, POST-able Server Action endpoints with no auth check: anyone with
// an action id could forge session_closed on any session UUID (kicking every
// player to Wrapped), organizer_intervention, cap_saturation, and unbounded
// draft_cap_phase locks. That is exactly the forgery capability migration
// 20260723100000 closed by deliberately shipping NO INSERT policy on
// realtime.messages. Emits belong behind purpose-built, organizer-gated actions.
//
// The channel is PRIVATE (see postBroadcast below and the
// session_events_broadcast_read policy in migration 20260723100000).
// ============================================================

// ── Payload types ─────────────────────────────────────────────

export type OrganizerInterventionType =
  | "on_deck_cleared"
  | "match_cancelled"
  /** Fired when a player is swapped into or out of an in-progress match. */
  | "active_roster_changed";

export interface OrganizerInterventionPayload {
  type: OrganizerInterventionType;
  affectedPlayerIds: string[];
  /**
   * The organizer who performed the action. Lets OTHER organizers show a
   * "{name} cleared a match" toast (so a co-organizer's action doesn't just
   * silently vanish from their board), while the actor's own client skips its
   * own toast by matching this id. Optional for backward compatibility — the
   * player-side listener ignores it, and callers that omit it produce no
   * organizer-side toast.
   */
  actorId?: string | null;
  actorName?: string | null;
}

// ── Internal REST helper ──────────────────────────────────────

/**
 * Hard ceiling on a single broadcast POST.
 *
 * Without one, `fetch` inherits the platform default (effectively the whole
 * request budget on Vercel). Every sender is awaited inside a server action, so
 * a Realtime endpoint that accepts the connection and then stalls would hold
 * the organizer's "Close Session" spinner open for as long as the platform
 * allows — for a message whose entire contract is fire-and-forget.
 */
const BROADCAST_TIMEOUT_MS = 3_000;

/** Backoff before the single retry (only for senders that opt in). */
const BROADCAST_RETRY_DELAY_MS = 300;

/**
 * POST a single broadcast message to the Supabase Realtime REST
 * endpoint. Requires the service-role key so any caller can emit
 * without being subscribed first.
 *
 * Never throws — failures are logged and reported through the return value so
 * the calling server action can decide what to tell the user, and still return
 * success regardless.
 *
 * @returns `true` only when the Realtime API accepted the message. `false`
 *   means the event definitively did not go out (missing config, non-2xx,
 *   timeout, transport error) — the caller's fallback paths are the only thing
 *   that will deliver it.
 *
 * `private: true` is load-bearing and must stay in lockstep with the client:
 * subscribeToOrganizerBroadcast() joins `session-events:{id}` as a private
 * channel, and Realtime does not deliver public messages to private
 * subscribers. Marking the message private is also what keeps it away from
 * anyone who opened the same topic as a *public* channel — verified against a
 * local stack: a public subscriber receives the public copy and never sees the
 * private one. Authorization for the join itself lives in the
 * `session_events_broadcast_read` policy on `realtime.messages`
 * (migration 20260723100000); the service-role key used here bypasses RLS, so
 * the server can still emit without any INSERT policy existing — which is
 * deliberate, since an INSERT policy would let browsers forge these events.
 */
async function postBroadcast(
  topic: string,
  event: string,
  payload: object,
  /**
   * Send twice on failure. OFF by default: Realtime fans every message to every
   * subscriber with no dedupe, so a retry after a request that actually
   * succeeded but timed out client-side is a *duplicate delivery*. Only enable
   * it for events whose handlers are idempotent — `session_closed` latches on
   * the receiver, `organizer_intervention` would raise a second toast.
   */
  options?: { retry?: boolean }
): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[broadcast] Missing SUPABASE_URL or service role key — skipping broadcast.");
    return false;
  }

  // `url`/`key` are passed in rather than captured: a hoisted function
  // declaration is reachable before the guard above as far as TS is concerned,
  // so the narrowing to `string` would not survive the closure.
  async function attempt(baseUrl: string, serviceKey: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          messages: [{ topic, event, payload, private: true }],
        }),
        signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "(no body)");
        console.warn(`[broadcast] ${event} → Realtime API responded ${res.status}: ${text}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[broadcast] ${event} → failed to emit:`, err);
      return false;
    }
  }

  if (await attempt(url, key)) return true;
  if (!options?.retry) return false;

  await new Promise((r) => setTimeout(r, BROADCAST_RETRY_DELAY_MS));
  const delivered = await attempt(url, key);
  if (!delivered) {
    console.error(`[broadcast] ${event} → giving up after retry; topic=${topic}`);
  }
  return delivered;
}

// ── Public API ────────────────────────────────────────────────

// ── session_closed ────────────────────────────────────────

export interface SessionClosedPayload {
  sessionId: string;
  /**
   * Whether compute_session_wrapped succeeded before this event was emitted,
   * i.e. whether `session_wrapped_stats` rows exist for the session.
   *
   * Optional for rolling-deploy compatibility: a client that receives an older
   * payload without it must treat `undefined` as "unknown", not as `false`.
   * Receivers use it to skip the wasted navigation to a Wrapped page that
   * would render an all-zero recap — see useSessionClosedWatcher.
   */
  wrappedReady?: boolean;
}

/**
 * Notify all players in a session that the session has been
 * closed by the organizer. The client-side hook uses this to
 * redirect each player to their personal Wrapped page.
 *
 * Retried once, unlike every other sender here, because this is the only
 * event with no cheap alternative: it is what moves ~40 phones off a dead
 * board. The receiver latches on `navigatedRef`, so a duplicate delivery is a
 * no-op. Its non-broadcast fallbacks (the `sessions` row subscription and the
 * status poll) still exist and still matter — this just stops a single flaky
 * POST from handing the whole room to them.
 *
 * Broadcast on channel: session-events:{sessionId}
 * Event name:           session_closed
 *
 * @returns whether the Realtime API accepted the message.
 */
export async function broadcastSessionClosed(
  sessionId: string,
  wrappedReady: boolean
): Promise<boolean> {
  const payload: SessionClosedPayload = { sessionId, wrappedReady };
  return await postBroadcast(`session-events:${sessionId}`, "session_closed", payload, {
    retry: true,
  });
}

// ── auto_matchmaking_toggled ──────────────────────────────

export interface AutoMatchmakingToggledPayload {
  /** The new state of the auto-matchmaking toggle after the flip. */
  isOn: boolean;
}

/**
 * Notify all organizers in a session that the auto-matchmaking
 * toggle has changed.
 *
 * This uses Broadcast (not postgres_changes) so it bypasses the
 * RLS SELECT check on the sessions table. Co-organizers who are
 * not the session creator would otherwise never receive the UPDATE
 * event because their JWT fails the RLS SELECT policy.
 *
 * Channel: session-events:{sessionId}
 * Event:   auto_matchmaking_toggled
 */
export async function broadcastAutoMatchmakingToggled(
  sessionId: string,
  isOn: boolean
): Promise<void> {
  const payload: AutoMatchmakingToggledPayload = { isOn };
  await postBroadcast(`session-events:${sessionId}`, "auto_matchmaking_toggled", payload);
}

// ── auto_publish_toggled ──────────────────────────────────

export interface AutoPublishToggledPayload {
  /** The new state of the auto-publish toggle after the flip. */
  isOn: boolean;
}

/**
 * Notify all organizers in a session that the auto-publish mode
 * toggle has changed. Same Broadcast-over-RLS rationale as
 * broadcastAutoMatchmakingToggled.
 *
 * Channel: session-events:{sessionId}
 * Event:   auto_publish_toggled
 */
export async function broadcastAutoPublishToggled(sessionId: string, isOn: boolean): Promise<void> {
  const payload: AutoPublishToggledPayload = { isOn };
  await postBroadcast(`session-events:${sessionId}`, "auto_publish_toggled", payload);
}

// ── cap_saturation ────────────────────────────────────────

export interface CapSaturationPayload {
  /**
   * "general"  — anchor is waiting but not yet Red Zone;
   *              the UI surfaces an informational notice.
   * "red_zone" — anchor has waited ≥ CRITICAL_WAIT_MINUTES;
   *              the UI surfaces an urgent alert.
   */
  type: "general" | "red_zone";
  anchorPlayerId: string;
  anchorPlayerName: string;
}

/**
 * Notify organizers that the partner-pair cap prevented the engine
 * from forming a match for the anchor player.
 *
 * Fire-and-forget: failures are logged but never surfaced to the
 * caller — the no-match return already communicates the outcome.
 *
 * Channel: session-events:{sessionId}
 * Event:   cap_saturation
 */
export async function broadcastCapSaturation(
  sessionId: string,
  payload: CapSaturationPayload
): Promise<void> {
  await postBroadcast(`session-events:${sessionId}`, "cap_saturation", payload);
}

// ── draft_cap_phase ───────────────────────────────────────

export type DraftCapPhase = "clearing" | "generating" | "done";

export interface DraftCapPhasePayload {
  phase: DraftCapPhase;
  /** The override cap being applied. null = Dynamic. */
  override: number | null;
  /**
   * One id per cap-reset operation, minted by the initiating tab and echoed on
   * every phase of that operation. It does two jobs:
   *   1. the initiating TAB recognises its own echo and never lets it drive its
   *      own lock — the REST broadcast endpoint has no sending socket, so
   *      Realtime fans every message back to the actor's own tab too;
   *   2. one organizer's 'done' cannot release another organizer's in-flight
   *      reset, and a 'clearing' that arrives after its own 'done' is discarded.
   *
   * Deliberately NOT actorId: actorId would classify a SECOND TAB of the same
   * organizer as "self", so that tab would silently skip a lock it should honour.
   * Optional only for rolling-deploy compatibility with older clients.
   */
  opId?: string;
  /** Organizer who started the reset — drives "{name} is changing the draft cap". */
  actorId?: string | null;
  actorName?: string | null;
  /**
   * Milliseconds after receipt at which the receiver MUST self-unlock even if no
   * 'done' ever arrives. The lockout is a LEASE, not a latch — this is the only
   * reason a dropped 'done' cannot brick a co-organizer's dashboard until reload
   * (the overlay has no dismiss control, no Esc handler and no polling fallback).
   */
  ttlMs?: number;
}

/**
 * Broadcast the current phase of a draft-cap reset operation to all
 * co-organizers so they can display the lockout overlay in sync.
 *
 * Emitted ONLY by applyDraftCapOverride (src/app/actions/sessions.ts) — never
 * from a client, and never from a general-purpose "emit any phase" endpoint.
 * That restriction is the security property: no caller can emit a lock without
 * also emitting its unlock.
 *
 *   'clearing'   — drafts are being cleared (all OTHER organizers lock)
 *   'generating' — the engine is running
 *   'done'       — operation complete (unlock + session refetch)
 *
 * 'done' is emitted from a `finally` so screens never stay locked on failure.
 */
export async function broadcastDraftCapPhase(
  sessionId: string,
  phase: DraftCapPhase,
  override: number | null,
  meta: { opId: string; actorId: string | null; actorName: string | null; ttlMs: number }
): Promise<void> {
  const payload: DraftCapPhasePayload = { phase, override, ...meta };
  await postBroadcast(`session-events:${sessionId}`, "draft_cap_phase", payload);
}

// ── queue_notice ──────────────────────────────────────────

export type QueueNoticeKind = "player_left";

export interface QueueNoticePayload {
  kind: QueueNoticeKind;
  playerId: string;
  playerName: string;
  cancelledDraft: boolean;
  /**
   * Set only on an organizer kick. The actor's own dashboard suppresses
   * the card (they just confirmed the dialog). Self-leave omits this so
   * every organizer with Match Control open sees the notice.
   */
  actorId?: string | null;
  actorName?: string | null;
}

/**
 * Tell organizers a player left the queue. Dedicated event so the
 * player-side listener (useOrganizerBroadcast) never handles it —
 * they share the session-events channel.
 *
 * Channel: session-events:{sessionId}
 * Event:   queue_notice
 */
export async function broadcastQueueNotice(
  sessionId: string,
  payload: QueueNoticePayload
): Promise<void> {
  await postBroadcast(`session-events:${sessionId}`, "queue_notice", payload);
}

/**
 * Notify a session's clients that an organizer has intervened (cleared an On
 * Deck match or cancelled an In-Progress match). Players filter by their own
 * player ID for an explanatory toast; other organizers show a "{actor} did X"
 * toast so the change isn't a silent disappearance on their board.
 *
 * Pass `actor` on clear/cancel so co-organizers get the notice and the acting
 * organizer's own client can suppress its self-toast. Omit it (e.g. batch
 * cap-reset clears, which already drive their own co-organizer overlay) to
 * notify only players.
 */
export async function broadcastOrganizerIntervention(
  sessionId: string,
  type: OrganizerInterventionType,
  affectedPlayerIds: string[],
  actor?: { id: string | null; name: string | null }
): Promise<void> {
  if (affectedPlayerIds.length === 0) return;

  const payload: OrganizerInterventionPayload = {
    type,
    affectedPlayerIds,
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? null,
  };

  await postBroadcast(`session-events:${sessionId}`, "organizer_intervention", payload);
}
