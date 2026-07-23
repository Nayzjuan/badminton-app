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
// Channel naming:
//   Server sends to topic: "realtime:session-events:{sessionId}"
//   Client subscribes to:  supabase.channel("session-events:{sessionId}")
//   (The Supabase SDK strips the "realtime:" prefix for the client.)
//
// KNOWN DISCREPANCY — the "realtime:" prefix on the server topic is NOT
// accepted by the Realtime image the Supabase CLI runs locally: a message
// posted to "realtime:session-events:{id}" is delivered to nobody there, while
// the same message posted to "session-events:{id}" is delivered normally.
// It is left as-is because production demonstrably delivers these events (the
// session_closed → Wrapped redirect and the co-organizer intervention toasts
// are in daily use), so production's Realtime evidently normalises the prefix.
// Consequence for testing: broadcast DELIVERY cannot be exercised end-to-end
// against the local stack without dropping the prefix. Do not "fix" this on
// the strength of a local repro alone — confirm against production first.
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
 * POST a single broadcast message to the Supabase Realtime REST
 * endpoint. Requires the service-role key so any caller can emit
 * without being subscribed first.
 *
 * Never throws — failures are silently logged so the calling
 * server action can return success regardless.
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
async function postBroadcast(topic: string, event: string, payload: object): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[broadcast] Missing SUPABASE_URL or service role key — skipping broadcast.");
    return;
  }

  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({
        messages: [{ topic, event, payload, private: true }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      console.warn(`[broadcast] Realtime API responded ${res.status}: ${text}`);
    }
  } catch (err) {
    console.warn("[broadcast] Failed to emit broadcast:", err);
  }
}

// ── Public API ────────────────────────────────────────────────

// ── session_closed ────────────────────────────────────────

export interface SessionClosedPayload {
  sessionId: string;
}

/**
 * Notify all players in a session that the session has been
 * closed by the organizer. The client-side hook uses this to
 * redirect each player to their personal Wrapped page.
 *
 * Broadcast on channel: session-events:{sessionId}
 * Event name:           session_closed
 */
export async function broadcastSessionClosed(sessionId: string): Promise<void> {
  const payload: SessionClosedPayload = { sessionId };
  await postBroadcast(`realtime:session-events:${sessionId}`, "session_closed", payload);
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
  await postBroadcast(`realtime:session-events:${sessionId}`, "auto_matchmaking_toggled", payload);
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
  await postBroadcast(`realtime:session-events:${sessionId}`, "auto_publish_toggled", payload);
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
  await postBroadcast(`realtime:session-events:${sessionId}`, "cap_saturation", payload);
}

// ── draft_cap_phase ───────────────────────────────────────

export type DraftCapPhase = "clearing" | "generating" | "done";

export interface DraftCapPhasePayload {
  phase: DraftCapPhase;
  /** The override cap being applied. null = Dynamic. */
  override: number | null;
}

/**
 * Broadcast the current phase of a draft-cap reset operation to all
 * co-organizers so they can display the lockout overlay in sync.
 *
 * Three phases emitted sequentially by the hook:
 *   'clearing'   — phase 1 started (all organizers lock)
 *   'generating' — phase 2 started (engine running)
 *   'done'       — operation complete (all organizers unlock)
 *
 * 'done' is also emitted on failure so screens never stay locked.
 */
export async function broadcastDraftCapPhase(
  sessionId: string,
  phase: DraftCapPhase,
  override: number | null
): Promise<void> {
  const payload: DraftCapPhasePayload = { phase, override };
  await postBroadcast(`realtime:session-events:${sessionId}`, "draft_cap_phase", payload);
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

  await postBroadcast(`realtime:session-events:${sessionId}`, "organizer_intervention", payload);
}
