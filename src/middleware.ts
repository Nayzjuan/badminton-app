// ============================================================
// Next.js Root Middleware
// ============================================================
// Runs on every matched request to refresh the Supabase auth
// session. Without this, tokens expire and real-time
// subscriptions silently disconnect.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";
import { resolveJoinRedirect } from "@/lib/repair-encoded-query-path";
import { REQUEST_PATH_HEADER, requestPathHeaderValue } from "@/lib/request-path";

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

  // Stamp the path the player asked for so club-layout rename gates
  // can return them there (layouts only receive clubSlug).
  const headers = new Headers(request.headers);
  headers.set(
    REQUEST_PATH_HEADER,
    requestPathHeaderValue(request.nextUrl.pathname, request.nextUrl.search)
  );
  return await updateSession(new NextRequest(request, { headers }));
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
