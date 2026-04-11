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
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the auth token. IMPORTANT: do NOT remove this line.
  // Even if we don't use the user object here, calling getUser()
  // ensures the session cookie is refreshed before it expires.
  await supabase.auth.getUser();

  return supabaseResponse;
}
