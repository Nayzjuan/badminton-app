"use server";

// ============================================================
// Notification Server Actions — sendPlayerNotification
// ============================================================
// Sends Web Push messages to all of a player's registered
// devices.  Uses the service-role client to bypass RLS (the
// action needs to read push_subscriptions for any user_id).
//
// Required environment variables:
//   VAPID_PUBLIC_KEY   — base64url VAPID public key
//   VAPID_PRIVATE_KEY  — base64url VAPID private key
//   VAPID_MAILTO       — mailto: or https: contact for VAPID
//
// Generate these once with:
//   npx web-push generate-vapid-keys
// Then copy the output into .env.local AND Vercel project settings.
// The public key is also exposed as NEXT_PUBLIC_VAPID_PUBLIC_KEY.
// ============================================================

import webpush from "web-push";
import { createServiceClient } from "@/utils/supabase/service";

// ── Alert types ──────────────────────────────────────────────

export type NotificationType = "ON_DECK_WARNING" | "COURT_CALL";

interface NotificationPayload {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
}

const PAYLOADS: Record<NotificationType, Omit<NotificationPayload, "type">> = {
  ON_DECK_WARNING: {
    title: "🏸 Get Ready!",
    body: "Your match is forming — head to the courts!",
  },
  COURT_CALL: {
    title: "🏸 Court Time!",
    body: "Your court is ready. Walk there NOW!",
  },
};

// ── VAPID setup (lazy, so we don't crash on missing keys at import time) ──

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const mailto = process.env.VAPID_MAILTO;

  if (!publicKey || !privateKey || !mailto) {
    throw new Error(
      "[notifications] Missing VAPID environment variables. " +
        "Run `npx web-push generate-vapid-keys` and set VAPID_PUBLIC_KEY, " +
        "VAPID_PRIVATE_KEY, and VAPID_MAILTO."
    );
  }

  webpush.setVapidDetails(mailto, publicKey, privateKey);
  vapidConfigured = true;
}

// ── sendPlayerNotification ───────────────────────────────────

/**
 * Send a Web Push notification to all registered devices for `userId`.
 *
 * Safe to call from any server action or API route.  Silently
 * no-ops if the user has no push subscriptions.
 *
 * Returns `{ sent: number; errors: number }`.
 */
export async function sendPlayerNotification(
  userId: string,
  type: NotificationType
): Promise<{ sent: number; errors: number }> {
  try {
    ensureVapid();
  } catch (err) {
    console.error("[sendPlayerNotification]", err);
    return { sent: 0, errors: 0 };
  }

  // Use service client — RLS blocks reading other users' subscriptions.
  const supabase = createServiceClient();

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .eq("user_id", userId);

  if (error) {
    console.error("[sendPlayerNotification] DB read error:", error);
    return { sent: 0, errors: 1 };
  }

  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, errors: 0 };
  }

  const payload = JSON.stringify({
    type,
    ...PAYLOADS[type],
    data: { url: "/play" },
  });

  let sent = 0;
  let errors = 0;
  const staleEndpoints: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth_key,
            },
          },
          payload
        );
        sent++;
      } catch (err: unknown) {
        // HTTP 410 Gone = subscription expired / unregistered
        if (
          err &&
          typeof err === "object" &&
          "statusCode" in err &&
          (err.statusCode === 410 || err.statusCode === 404)
        ) {
          staleEndpoints.push(sub.endpoint);
        } else {
          console.error("[sendPlayerNotification] push error:", err);
          errors++;
        }
      }
    })
  );

  // Prune stale subscriptions (expired or unsubscribed endpoints).
  if (staleEndpoints.length > 0) {
    await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .in("endpoint", staleEndpoints);
  }

  return { sent, errors };
}
