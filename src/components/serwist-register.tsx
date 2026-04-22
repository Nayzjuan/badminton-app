"use client";

// ============================================================
// SerwistRegister — Service Worker lifecycle manager
// ============================================================
// Handles three concerns:
//   1. Emergency kill switch: NEXT_PUBLIC_KILL_SW=true
//      unregisters all active SWs immediately (Vercel env var).
//   2. ?clear_sw=1 URL param: unregisters SW for a single user
//      without requiring a full redeploy (support tool).
//   3. Normal registration: registers /sw.js on production builds.
//
// This is a client component so it can access window/navigator.
// It renders nothing — purely a side-effect component.
// ============================================================

import { useEffect } from "react";

export function SerwistRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // ── Emergency kill switch ─────────────────────────────────
    // Set NEXT_PUBLIC_KILL_SW=true in Vercel environment variables
    // to instantly unregister all service workers on next page load.
    if (process.env.NEXT_PUBLIC_KILL_SW === "true") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((reg) => reg.unregister());
          console.warn("[SW] Kill switch active — all service workers unregistered.");
        });
      return;
    }

    // ── Per-user escape hatch: ?clear_sw=1 ───────────────────
    const params = new URLSearchParams(window.location.search);
    if (params.get("clear_sw") === "1") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((reg) => reg.unregister());
          console.warn("[SW] ?clear_sw=1 — service worker unregistered for this client.");
          // Remove the query param so normal operation resumes on next load.
          params.delete("clear_sw");
          const newUrl =
            window.location.pathname +
            (params.toString() ? `?${params.toString()}` : "");
          window.history.replaceState({}, "", newUrl);
        });
      return;
    }

    // ── Normal registration (production only) ────────────────
    // The SW is only built and available in production.
    // In development, Serwist is disabled (set in next.config.ts)
    // to prevent stale cache interfering with hot-reload.
    if (process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration) => {
          console.log("[SW] Registered, scope:", registration.scope);
        })
        .catch((err) => {
          console.error("[SW] Registration failed:", err);
        });
    }
  }, []);

  return null;
}
