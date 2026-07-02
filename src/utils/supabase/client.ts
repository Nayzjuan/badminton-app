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
// Guarded by a module flag since createBrowserClient() is a singleton and
// this function is called from many hooks — without the guard we'd attach
// a duplicate listener per call site.
let hasWiredRealtimeAuth = false;

export function createBrowserSupabaseClient() {
  const client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  if (!hasWiredRealtimeAuth) {
    hasWiredRealtimeAuth = true;
    client.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" && session?.access_token) {
        client.realtime.setAuth(session.access_token);
      }
    });
  }

  return client;
}
