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
// ============================================================

// ── Payload types ─────────────────────────────────────────────

export type OrganizerInterventionType = "on_deck_cleared" | "match_cancelled";

export interface OrganizerInterventionPayload {
  type: OrganizerInterventionType;
  affectedPlayerIds: string[];
}

// ── Internal REST helper ──────────────────────────────────────

/**
 * POST a single broadcast message to the Supabase Realtime REST
 * endpoint. Requires the service-role key so any caller can emit
 * without being subscribed first.
 *
 * Never throws — failures are silently logged so the calling
 * server action can return success regardless.
 */
async function postBroadcast(topic: string, event: string, payload: object): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

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
        messages: [{ topic, event, payload }],
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

/**
 * Notify all players in a session that the organizer has
 * intervened (cleared an On Deck match or cancelled an
 * In-Progress match). Clients filter by their own player ID.
 */
export async function broadcastOrganizerIntervention(
  sessionId: string,
  type: OrganizerInterventionType,
  affectedPlayerIds: string[]
): Promise<void> {
  if (affectedPlayerIds.length === 0) return;

  const payload: OrganizerInterventionPayload = { type, affectedPlayerIds };

  await postBroadcast(
    `realtime:session-events:${sessionId}`,
    "organizer_intervention",
    payload
  );
}
