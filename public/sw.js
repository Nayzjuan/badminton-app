// ============================================================
// Badminton Queue — Service Worker (PWA + Push Notifications)
// ============================================================
// Single combined SW handling:
//   1. Caching strategies (PWA offline support)
//   2. Web Push notifications (Pocket Pings)
//
// CRITICAL CACHING RULES:
//   NEVER cache *.supabase.co/* — all queue/match/session state
//   is live. Stale data = organizer sees wrong court state.
//   NEVER cache POST requests — Server Actions are POSTs.
//   WebSockets (wss://) are never intercepted by fetch handlers.
// ============================================================

const CACHE_VERSION = "v1";

const CACHE_NAMES = {
  static:   `bq-static-${CACHE_VERSION}`,     // /_next/static/* and icons
  pages:    `bq-pages-${CACHE_VERSION}`,       // HTML pages (Network First)
  fonts:    `bq-fonts-${CACHE_VERSION}`,       // Google Fonts (Cache First)
};

// Pages to precache at install time so they work offline.
const PRECACHE_URLS = ["/offline"];

// Patterns that must ALWAYS go to the network — no exceptions.
// Checked before any caching strategy runs.
const NETWORK_ONLY = [
  // All Supabase endpoints: REST, Auth, Realtime, Storage, Edge Functions
  /https:\/\/[^/]*\.supabase\.co\//,
  // Next.js internal: RSC payloads, server action pings
  /\/_next\/data\//,
  /\/_action/,
];

// ── Install ───────────────────────────────────────────────────
// Precache the offline fallback page immediately.

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAMES.pages)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────
// Delete caches from old versions to free disk space.

self.addEventListener("activate", (event) => {
  const activeCaches = Object.values(CACHE_NAMES);

  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !activeCaches.includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Hard bypass: POST requests + Supabase + internals ──────
  // POST = Server Actions; Supabase = live data; internals = RSC.
  // These must always hit the network — never read from cache.
  if (
    request.method !== "GET" ||
    NETWORK_ONLY.some((pattern) => pattern.test(request.url))
  ) {
    return; // Let the browser handle it normally (network only).
  }

  // ── Cache First: Next.js static assets ─────────────────────
  // /_next/static/* filenames are content-hashed — serving from
  // cache is always safe. New deploy = new hash = new entry.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, CACHE_NAMES.static, 30));
    return;
  }

  // ── Cache First: App icons ──────────────────────────────────
  if (
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon-32.png"
  ) {
    event.respondWith(cacheFirst(request, CACHE_NAMES.static, 7));
    return;
  }

  // ── Cache First: Google Fonts ───────────────────────────────
  if (
    url.hostname === "fonts.gstatic.com" ||
    url.hostname === "fonts.googleapis.com"
  ) {
    event.respondWith(cacheFirst(request, CACHE_NAMES.fonts, 365));
    return;
  }

  // ── Network First: HTML page navigations ───────────────────
  // Always try the network. Falls back to cached version or the
  // offline page if the network is unreachable.
  if (request.destination === "document") {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  // All other requests: network only (no caching).
});

// ── Caching strategy helpers ──────────────────────────────────

/**
 * Cache First strategy.
 * Returns the cached response if present; fetches and caches on miss.
 * maxDays controls the Time-To-Live enforced via a custom header.
 */
async function cacheFirst(request, cacheName, maxDays) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Refresh in background if entry is older than maxDays.
    const fetched = cached.headers.get("x-sw-cached-at");
    if (fetched) {
      const age = (Date.now() - parseInt(fetched, 10)) / 1000 / 60 / 60 / 24;
      if (age > maxDays) {
        fetchAndCache(request, cache).catch(() => {});
      }
    }
    return cached;
  }

  return fetchAndCache(request, cache);
}

async function fetchAndCache(request, cache) {
  const response = await fetch(request);
  if (response.ok) {
    // Clone and stamp with a cached-at timestamp header.
    const headers = new Headers(response.headers);
    headers.set("x-sw-cached-at", Date.now().toString());
    const stamped = new Response(await response.clone().blob(), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    cache.put(request, stamped);
  }
  return response;
}

/**
 * Network First strategy with 3-second timeout.
 * Falls back to cached HTML, then to /offline if nothing is cached.
 */
async function networkFirstWithOfflineFallback(request) {
  const cache = await caches.open(CACHE_NAMES.pages);

  try {
    const networkResponse = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 3000)
      ),
    ]);

    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    // Last resort: serve the precached offline page.
    const offline = await cache.match("/offline");
    return (
      offline ??
      new Response("You are offline. Please reconnect to use Badminton Queue.", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }
}

// ============================================================
// Push Notifications (Pocket Pings)
// ============================================================
// Handles Web Push so players get alerted when the app is
// backgrounded or the screen is locked.
//
// Notification types:
//   ON_DECK_WARNING — player's match is forming; get ready
//   COURT_CALL      — court assigned, walk to it now
// ============================================================

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      type: "ON_DECK_WARNING",
      title: "Badminton Queue",
      body: event.data.text(),
    };
  }

  const { type, title, body, data } = payload;

  let vibrate = [200, 100, 200];
  // badge: small monochrome icon shown in the notification tray on Android.
  // Should be 96×96 for sharp rendering at notification badge size.
  // icon: full-colour icon shown in the notification body.
  const badge = "/icons/icon-96.png";
  const icon = "/icons/icon-192.png";
  let tag = "pocket-ping";
  let requireInteraction = false;

  if (type === "COURT_CALL") {
    vibrate = [300, 100, 300, 100, 300];
    tag = "court-call";
    requireInteraction = true;
  } else if (type === "ON_DECK_WARNING") {
    vibrate = [200, 150, 200];
    tag = "on-deck-warning";
  }

  event.waitUntil(
    self.registration.showNotification(title ?? "Badminton Queue", {
      body: body ?? "Check the Badminton Queue app",
      icon,
      badge,
      vibrate,
      tag,
      requireInteraction,
      data: { url: data?.url ?? "/play", type, ...data },
      actions: [
        { action: "open", title: "Open App" },
        { action: "dismiss", title: "Got it" },
      ],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url ?? "/play";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            client.navigate(targetUrl);
            return;
          }
        }
        return clients.openWindow(targetUrl);
      })
  );
});
