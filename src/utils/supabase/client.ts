// ============================================================
// Supabase Browser Client  (for Client Components)
// ============================================================
// Use this in any "use client" component that needs to:
//   • Read/write data from the browser
//   • Subscribe to real-time changes
//   • Call RPC functions (elevate_to_organizer, rejoin_queue)
//
// This is a singleton — safe to call createBrowserClient()
// multiple times; @supabase/ssr deduplicates under the hood.
// ============================================================

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

// supabase-js's built-in auth listener (SupabaseClient#_handleTokenChanged)
// only forwards the JWT to the Realtime client on TOKEN_REFRESHED/SIGNED_IN.
// It does NOT handle INITIAL_SESSION — the event fired when a persisted
// session (restored from cookies) is hydrated on page load. Without this,
// an already-logged-in user's postgres_changes subscriptions are evaluated
// under the `anon` Postgres role forever, so any RLS policy relying on
// auth.uid() never matches and no realtime events are ever delivered.
//
// Crucially, INITIAL_SESSION fires *asynchronously* during auth
// initialization, which loses the race against channel `.subscribe()`
// calls made synchronously in hook effects: the channel joins as `anon`
// and Supabase binds the postgres_changes RLS filter at join time, so a
// later setAuth never re-evaluates it. We fix this by (a) kicking off an
// eager getSession()→setAuth() at client-creation time and exposing the
// resulting promise via `whenRealtimeAuthReady()` so subscribe helpers can
// await it *before* joining, and (b) keeping the Realtime JWT fresh on
// every subsequent auth transition. Guarded by a module flag since
// createBrowserClient() is a singleton called from many hooks.
let hasWiredRealtimeAuth = false;
let realtimeAuthReady: Promise<void> | null = null;

export function createBrowserSupabaseClient() {
  const client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  if (!hasWiredRealtimeAuth) {
    hasWiredRealtimeAuth = true;

    // (a) Eagerly hydrate the Realtime JWT from the persisted session, and
    // record the promise so subscribers can defer `.subscribe()` until it
    // settles. A failure (e.g. no session / anon visitor) is non-fatal —
    // channels simply join as `anon`, which is correct for public tables.
    realtimeAuthReady = client.auth
      .getSession()
      .then(({ data }) => {
        if (data.session?.access_token) {
          client.realtime.setAuth(data.session.access_token);
        }
      })
      .catch(() => {
        /* anon / no session — join as anon */
      });

    // (b) Keep the Realtime JWT current across every later auth transition
    // (INITIAL_SESSION hydration, SIGNED_IN, TOKEN_REFRESHED).
    client.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        client.realtime.setAuth(session.access_token);
      }
    });
  }

  return client;
}

/**
 * Resolves once the persisted session's JWT has been pushed to the Realtime
 * client (or immediately, for anon visitors / before any client is created).
 *
 * Realtime binds a channel's `postgres_changes` RLS filter to the socket's
 * JWT **at join time**, and a later `setAuth` does not re-bind an
 * already-joined channel. Subscribe helpers therefore await this before
 * calling `.subscribe()` so club-scoped RLS evaluates under the real user
 * instead of `anon` (which silently delivers zero rows).
 */
export function whenRealtimeAuthReady(): Promise<void> {
  return realtimeAuthReady ?? Promise.resolve();
}
