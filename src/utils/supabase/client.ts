// ============================================================
// Supabase Browser Client  (for Client Components)
// ============================================================
// Use this in any "use client" component that needs to:
//   • Read/write data from the browser
//   • Subscribe to real-time changes
//   • Call RPC functions (rejoin_queue)
//
// This is a singleton — safe to call createBrowserClient()
// multiple times; @supabase/ssr deduplicates under the hood.
// ============================================================

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
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
// Set once the eager hydration above settles, so whenRealtimeAuthReady() can
// return a already-resolved promise instead of arming a timeout on every call.
let realtimeAuthSettled = false;
// Whether the realtime socket's auth last carried a REAL session (vs anon).
// null = unknown until the eager hydration below resolves. Drives the
// recycle-on-recovery logic: channels that joined during a no-session window
// bound their postgres_changes RLS filters to `anon` and deliver nothing.
let realtimeHadSession: boolean | null = null;
// Guards against overlapping recycles (a burst of auth events would otherwise
// interleave disconnect/connect pairs and re-create the bug this fixes).
let recycleInFlight = false;

/** How long whenRealtimeAuthReady() will wait before giving up and joining anyway. */
const REALTIME_AUTH_READY_TIMEOUT_MS = 3_000;
/** Belt-and-braces re-arm delay after a socket recycle. */
const REALTIME_RECONNECT_REARM_MS = 500;

/**
 * Drop and reopen the Realtime socket so every registered channel REJOINs
 * under the current JWT.
 *
 * The sequencing is load-bearing and was the subject of a real bug. Both
 * calls look symmetric but are not:
 *   • `RealtimeClient.disconnect()` is **async** — it resolves only after the
 *     underlying phoenix socket has finished tearing down — and while it is
 *     in flight `isDisconnecting()` is true.
 *   • `RealtimeClient.connect()` early-returns when
 *     `isConnecting() || isDisconnecting() || isConnected()`.
 * So calling them back to back synchronously means `connect()` hits the
 * `isDisconnecting()` guard and returns having done *nothing*. The socket
 * then stays closed with `closeWasClean = true`, which is exactly the flag
 * phoenix uses to suppress all three recovery paths (the reconnect timer in
 * `onConnClose`, the `visibilitychange` rescue, and the `pageshow` rescue).
 * The tab ends up with no socket and nothing that will ever open one again —
 * strictly worse than the anon-bound channels the recycle was meant to fix.
 *
 * Awaiting the teardown first makes `connect()` actually construct a socket;
 * phoenix then rejoins each errored channel from its own `onOpen` hook
 * (channel.js: `if (this.isErrored()) { this.rejoin() }`).
 */
async function recycleRealtimeSocket(client: SupabaseClient<Database>): Promise<void> {
  if (recycleInFlight) return;
  recycleInFlight = true;
  try {
    await client.realtime.disconnect();
    client.realtime.connect();
  } catch {
    /* non-fatal: fall through to the re-arm below */
  } finally {
    recycleInFlight = false;
    // If the reconnect lost a race (or threw), try once more. `connect()` is
    // a no-op when the socket is already up, so this is safe either way.
    setTimeout(() => {
      if (!client.realtime.isConnected()) {
        try {
          client.realtime.connect();
        } catch {
          /* ignore — the phoenix reconnect timer owns it from here */
        }
      }
    }, REALTIME_RECONNECT_REARM_MS);
  }
}

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
        realtimeHadSession = Boolean(data.session?.access_token);
        if (data.session?.access_token) {
          client.realtime.setAuth(data.session.access_token);
        }
      })
      .catch(() => {
        /* anon / no session — join as anon */
        realtimeHadSession = false;
      })
      .finally(() => {
        realtimeAuthSettled = true;
      });

    // (b) Keep the Realtime JWT current across every later auth transition
    // (INITIAL_SESSION hydration, SIGNED_IN, TOKEN_REFRESHED), and (c)
    // RECYCLE the socket when a session appears after a no-session window.
    //
    // (c) exists because setAuth cannot fix an anon-bound channel:
    // postgres_changes RLS filters bind at JOIN time. Any channel that joined
    // while the client had no session (cold start racing auth hydration, or a
    // mid-session refresh-token death that emitted SIGNED_OUT) is bound to
    // `anon` and delivers nothing, forever. Dropping and reopening the socket
    // makes every registered channel REJOIN with the fresh token — the only
    // way to re-bind. Scoped tightly: only on a no-session → session
    // transition, and only when channels exist. A routine TOKEN_REFRESHED on
    // a live session never recycles (those channels bound correctly at join).
    //
    // RETRACTED 2026-08-11: this comment used to claim "worst case equals the
    // status quo". It did not. The original `disconnect(); connect();` pair
    // left the tab with NO socket at all and every recovery path disarmed —
    // see recycleRealtimeSocket() for the mechanism and the fix.
    client.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        client.realtime.setAuth(session.access_token);
        if (realtimeHadSession === false && client.getChannels().length > 0) {
          void recycleRealtimeSocket(client);
        }
        realtimeHadSession = true;
      } else {
        realtimeHadSession = false;
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
 *
 * BOUNDED on purpose. Every subscribe helper creates its channel *inside* this
 * promise's `.then()`, so a `getSession()` that never settles (a wedged
 * storage read, a hung token refresh) means no channel is ever constructed —
 * no `.subscribe()`, no status callback, nothing logged, and no way for the
 * caller to tell that apart from a healthy idle connection. Joining as `anon`
 * after {@link REALTIME_AUTH_READY_TIMEOUT_MS} is a bad outcome; joining
 * *never* is a worse one, and it is invisible. Once the hydration settles the
 * race is skipped entirely, so this costs a timer only during cold start.
 */
export function whenRealtimeAuthReady(): Promise<void> {
  if (!realtimeAuthReady || realtimeAuthSettled) return Promise.resolve();
  return Promise.race([
    realtimeAuthReady,
    new Promise<void>((resolve) => setTimeout(resolve, REALTIME_AUTH_READY_TIMEOUT_MS)),
  ]);
}

/**
 * True when the browser client currently holds an auth session.
 *
 * `getSession()` re-reads storage and refreshes an expired access token, so
 * `false` here means the client has genuinely fallen back to `anon` — signed
 * out, or its refresh token was rejected (rotation race, multi-tab).
 *
 * Data hooks use this to tell a genuinely-empty result apart from "RLS
 * filtered every row because this client silently lost its auth" before
 * wiping previously-populated state. Under club-scoped RLS an anon fetch
 * returns success-with-0-rows, not an error, so an error check alone cannot
 * catch it — this is what blanked queue/court panels mid-session on 07/25.
 */
export async function hasAuthSession(client: SupabaseClient<Database>): Promise<boolean> {
  try {
    const { data } = await client.auth.getSession();
    return Boolean(data.session);
  } catch {
    return false;
  }
}
