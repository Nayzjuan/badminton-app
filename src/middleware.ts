// ============================================================
// Next.js Root Middleware
// ============================================================
// Runs on every matched request to refresh the Supabase auth
// session. Without this, tokens expire and real-time
// subscriptions silently disconnect.
// ============================================================

import { type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on all routes except static files and Next.js internals.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
