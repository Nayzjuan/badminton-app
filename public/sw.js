// ============================================================
// Badminton Queue — Service Worker
// ============================================================
// Handles Web Push notifications (Pocket Pings) so players
// get alerted even when the app is backgrounded or the screen
// is locked.
//
// Notification types:
//   ON_DECK_WARNING — player's match is forming; get ready
//   COURT_CALL      — court assigned, walk to it now
// ============================================================

// ── Push event handler ────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // Fallback for plain-text payloads (shouldn't happen but be safe)
    payload = { type: "ON_DECK_WARNING", title: "Badminton Queue", body: event.data.text() };
  }

  const { type, title, body, data } = payload;

  // ── Per-type vibration + icon config ──────────────────────
  let vibrate = [200, 100, 200];
  let badge = "/icons/icon-96.png";
  let icon = "/icons/icon-192.png";
  let tag = "pocket-ping";
  let requireInteraction = false;

  if (type === "COURT_CALL") {
    // Energetic triple-pulse: you're up NOW
    vibrate = [300, 100, 300, 100, 300];
    tag = "court-call";
    requireInteraction = true; // Stay visible until user interacts
  } else if (type === "ON_DECK_WARNING") {
    // Gentle double-pulse: heads-up, get ready
    vibrate = [200, 150, 200];
    tag = "on-deck-warning";
  }

  const notificationOptions = {
    body: body ?? "Check the Badminton Queue app",
    icon,
    badge,
    vibrate,
    tag,
    requireInteraction,
    data: {
      url: data?.url ?? "/play",
      type,
      ...data,
    },
    actions: [
      {
        action: "open",
        title: "Open App",
      },
      {
        action: "dismiss",
        title: "Got it",
      },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title ?? "Badminton Queue", notificationOptions)
  );
});

// ── Notification click handler ────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url ?? "/play";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // If the app is already open, focus it and navigate.
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            client.navigate(targetUrl);
            return;
          }
        }
        // Otherwise open a new window.
        return clients.openWindow(targetUrl);
      })
  );
});

// ── Install / Activate lifecycle ─────────────────────────────
// Skip waiting so a new SW version activates immediately
// without needing the user to close all tabs.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});
