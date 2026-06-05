"use server";

// ============================================================
// Notification Server Actions — sendPlayerNotification
// ============================================================
// Thin server-action wrapper around the shared push core in
// src/lib/notifications/push-server.ts.
//
// Most pushes are now fired server-side via `after(() =>
// pushToPlayers(...))` directly from the actions that change a
// player's status (publish, promote-to-court, live swaps). This
// action remains for any caller that needs a single-user send
// behind the "use server" boundary.
// ============================================================

import { pushToPlayers, type NotificationType } from "@/lib/notifications/push-server";

export type { NotificationType };

/**
 * Send a Web Push notification to all registered devices for `userId`.
 * Delegates to `pushToPlayers`. Silently no-ops if the user has no
 * push subscriptions. Returns `{ sent, errors }`.
 */
export async function sendPlayerNotification(
  userId: string,
  type: NotificationType
): Promise<{ sent: number; errors: number }> {
  return pushToPlayers([userId], type);
}
