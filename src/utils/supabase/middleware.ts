// ============================================================
// Supabase Auth Middleware Helper
// ============================================================
// Refreshes the auth session on every request so tokens stay
// valid. Called from the root middleware.ts.
//
// Also handles redirects for unauthenticated users if needed
// (currently all pages are accessible — auth is "anonymous").
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Forward cookies to both the request (for downstream) and response.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the auth token. IMPORTANT: do NOT remove this call.
  // Even if we don't use the user object here, calling getUser()
  // ensures the session cookie is refreshed before it expires.
  //
  // Bounded + non-fatal: middleware runs on EVERY page request, and this call
  // hits the Supabase auth endpoint. On 07/25 two requests hung here until
  // Vercel killed them at 25 s — the player got an error page mid-session.
  // A refresh that can't complete in 5 s (or fails: invalid/already-used
  // refresh token) is abandoned and the request passes through with the
  // cookies it came with; the browser client owns its own recovery. If the
  // refresh won the race, setAll() has already rebuilt supabaseResponse with
  // the fresh cookies, so returning it is correct in both outcomes.
  const AUTH_REFRESH_TIMEOUT_MS = 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, AUTH_REFRESH_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      supabase.auth
        .getUser()
        .then(() => undefined)
        .catch(() => undefined),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }

  return supabaseResponse;
}
