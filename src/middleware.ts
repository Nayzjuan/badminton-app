// ============================================================
// Next.js Root Middleware
// ============================================================
// Runs on every matched request to refresh the Supabase auth
// session. Without this, tokens expire and real-time
// subscriptions silently disconnect.
// ============================================================

import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";
import { resolveJoinRedirect } from "@/lib/repair-encoded-query-path";

export async function middleware(request: NextRequest) {
  // In-app browsers sometimes encode `?session=` into the path (`%3F`).
  // Printed `?session=` links also land here — next.config redirects
  // cannot drop the query (Next always forwards it), so the clean
  // path-form 308 has to happen in middleware.
  const repaired = resolveJoinRedirect(request.nextUrl.pathname, request.nextUrl.search);
  if (repaired) {
    const url = request.nextUrl.clone();
    url.pathname = repaired;
    url.search = "";
    return NextResponse.redirect(url, 308);
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on all routes except static files and Next.js internals.
    // NOTE: /sw.js, /offline, and /manifest.webmanifest are NOT excluded —
    // updateSession() is harmless for these (it never redirects, only
    // refreshes the auth token cookie if needed and passes through).
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
