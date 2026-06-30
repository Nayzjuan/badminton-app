import "server-only";

// ============================================================
// push-server — Server-side Web Push delivery (shared core)
// ============================================================
// Single source of truth for sending Pocket Ping notifications.
// Called by:
//   • sendPlayerNotification (server action wrapper, notifications.ts)
//   • every server action that transitions a player to on_deck /
//     playing — wired via Next.js `after()` so the push send never
//     blocks or fails the action's response.
//
// WHY THIS LIVES SERVER-SIDE:
//   The push used to be triggered from the client hook
//   (use-match-alerts.ts) when the player's OWN browser received the
//   realtime status change. That only works when the app is open —
//   a backgrounded/locked phone suspends the websocket, so the
//   trigger never ran. Firing here, at the moment the status changes,
//   reaches the device regardless of app state.
//
// Required environment variables:
//   VAPID_PUBLIC_KEY   — base64url VAPID public key
//   VAPID_PRIVATE_KEY  — base64url VAPID private key
//   VAPID_MAILTO       — mailto: or https: contact for VAPID
//   (NEXT_PUBLIC_VAPID_PUBLIC_KEY mirrors the public key for the client)
// ============================================================

import webpush from "web-push";
import { createServiceClient } from "@/utils/supabase/service";

// ── Alert types ──────────────────────────────────────────────

export type NotificationType = "ON_DECK_WARNING" | "COURT_CALL";

const PAYLOADS: Record<NotificationType, { title: string; body: string }> = {
  ON_DECK_WARNING: {
    title: "🏸 Get Ready!",
    body: "Your match is forming — head to the courts!",
  },
  COURT_CALL: {
    title: "🏸 Court Time!",
    body: "Your court is ready. Walk there NOW!",
  },
};

// ── Delivery hardening (Option B): per-type send headers ──────
// urgency:high → push services deliver promptly even to dozing devices.
// TTL          → drop the message if undelivered after N seconds (a stale
//                court call is worse than none).
// topic        → a newer message with the same topic REPLACES an older
//                still-undelivered one for that device (no stale stacking).
type SendOpts = {
  urgency: "very-low" | "low" | "normal" | "high";
  TTL: number;
  topic: string;
};

const SEND_OPTIONS: Record<NotificationType, SendOpts> = {
  COURT_CALL: { urgency: "high", TTL: 600, topic: "court-call" },
  ON_DECK_WARNING: { urgency: "high", TTL: 300, topic: "on-deck" },
};

// ── VAPID setup (lazy, so a missing key doesn't crash at import) ──

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const mailto = process.env.VAPID_MAILTO;

  if (!publicKey || !privateKey || !mailto) {
    throw new Error(
      "[push-server] Missing VAPID environment variables. " +
        "Run `npx web-push generate-vapid-keys` and set VAPID_PUBLIC_KEY, " +
        "VAPID_PRIVATE_KEY, and VAPID_MAILTO."
    );
  }

  webpush.setVapidDetails(mailto, publicKey, privateKey);
  vapidConfigured = true;
}

// ── pushToPlayers ────────────────────────────────────────────

/**
 * Send a Web Push notification of `type` to ALL registered devices for
 * every user in `userIds`.  De-dupes ids, no-ops on an empty list, and
 * never throws — it swallows its own errors and returns counts, so it is
 * safe to call fire-and-forget from inside `after()`.
 *
 * Returns `{ sent, errors }` aggregated across every device.
 */
export async function pushToPlayers(
  userIds: string[],
  type: NotificationType
): Promise<{ sent: number; errors: number }> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return { sent: 0, errors: 0 };

  try {
    ensureVapid();
  } catch (err) {
    console.error("[pushToPlayers]", err);
    return { sent: 0, errors: 0 };
  }

  // Service client — RLS blocks reading other users' subscriptions.
  const supabase = createServiceClient();

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .in("user_id", ids);

  if (error) {
    console.error("[pushToPlayers] DB read error:", error);
    return { sent: 0, errors: 1 };
  }

  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, errors: 0 };
  }

  // Deep-link target. Club-consistent default (/clubs → the player's club →
  // session). NOTE: a direct /c/<slug>/play/<sessionId> link would be better UX
  // for an urgent court call — deferred, as it needs sessionId threaded through
  // pushToPlayers' ~10 call sites + a send-time club-slug lookup.
  const payload = JSON.stringify({
    type,
    ...PAYLOADS[type],
    data: { url: "/clubs" },
  });

  let sent = 0;
  let errors = 0;
  const staleEndpoints: string[] = [];

  const sendOne = async (sub: (typeof subscriptions)[number]) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key },
        },
        payload,
        SEND_OPTIONS[type]
      );
      sent++;
    } catch (err: unknown) {
      // HTTP 410 Gone / 404 = subscription expired or unregistered.
      if (
        err &&
        typeof err === "object" &&
        "statusCode" in err &&
        (err.statusCode === 410 || err.statusCode === 404)
      ) {
        staleEndpoints.push(sub.endpoint);
      } else {
        console.error("[pushToPlayers] push error:", err);
        errors++;
      }
    }
  };

  // Cap concurrency so a large fan-out (e.g. publish-all pinging every player's
  // devices) doesn't open hundreds of simultaneous web-push HTTPS sockets.
  const PUSH_CONCURRENCY = 20;
  for (let i = 0; i < subscriptions.length; i += PUSH_CONCURRENCY) {
    await Promise.all(subscriptions.slice(i, i + PUSH_CONCURRENCY).map(sendOne));
  }

  // Prune stale subscriptions (endpoints are globally unique).
  if (staleEndpoints.length > 0) {
    await supabase.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
  }

  return { sent, errors };
}
