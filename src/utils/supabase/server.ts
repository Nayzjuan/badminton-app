// ============================================================
// Supabase Server Client  (for Server Components / Route Handlers / Actions)
// ============================================================
// Use this in:
//   • Server Components (RSC) — data fetching at render time
//   • Route Handlers (app/api/...)
//   • Server Actions ("use server")
//
// This client reads/writes cookies for session management.
// It must be created fresh per request (NOT a singleton).
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll can fail in Server Components (read-only context).
            // This is expected — the middleware handles refresh instead.
          }
        },
      },
    }
  );
}
