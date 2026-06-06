"use client";

// ============================================================
// useVisibilityRefresh — Mobile tab / phone-unlock recovery
// ============================================================
// Mobile browsers suspend JavaScript and kill WebSocket
// connections when the screen locks or the user switches tabs.
// This hook fires whenever the page becomes visible again:
//
//   1. router.refresh() — re-runs Next.js Server Components so
//      the latest profile/session data is pushed down as props.
//   2. onVisible() callback — lets each realtime hook re-fetch
//      its own slice of data immediately, without waiting for
//      the Supabase WebSocket to complete its reconnect cycle.
//
// Throttle: fires at most once per `throttleMs` (default 5 s)
// so rapid tab-switching doesn't spam the database.
//
// Usage:
//   useVisibilityRefresh(() => {
//     refreshQueue();
//     refreshMatch();
//     refreshSession();
//   });
// ============================================================

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function useVisibilityRefresh(onVisible?: () => void, throttleMs = 5_000): void {
  const router = useRouter();
  const lastFiredAt = useRef<number>(0);

  // Keep a stable ref to the latest callback so the useEffect
  // doesn't need to list `onVisible` as a dependency (which
  // would re-register the listener on every render if the
  // caller passes an inline function).
  const onVisibleRef = useRef(onVisible);
  useEffect(() => {
    onVisibleRef.current = onVisible;
  });

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;

      const now = Date.now();
      if (now - lastFiredAt.current < throttleMs) return;
      lastFiredAt.current = now;

      // Re-run the current route's Server Components.
      // Syncs profile, session, and any server-rendered data
      // without a full page reload.
      router.refresh();

      // Immediately re-fetch client-side data without waiting
      // for the Supabase WebSocket to finish reconnecting.
      onVisibleRef.current?.();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router, throttleMs]);
}
