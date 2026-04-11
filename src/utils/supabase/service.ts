// ============================================================
// Supabase Service-Role Client  (SERVER ONLY — never import
// this in client components or expose to the browser)
// ============================================================
// Uses SUPABASE_SERVICE_ROLE_KEY which bypasses Row Level
// Security entirely. Only use this for:
//   • Dev-tools / seed actions that create fake auth users
//   • Admin operations that need to write across user boundaries
//
// Add to .env.local:
//   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
// (Get it from: Supabase Dashboard → Project Settings → API
//  → service_role secret key)
// ============================================================

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  // Accept either naming convention. SUPABASE_SERVICE_ROLE_KEY is preferred
  // (server-only, never sent to the browser). NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
  // also works but NOTE: NEXT_PUBLIC_ variables are bundled into the client-side
  // JavaScript — rename to SUPABASE_SERVICE_ROLE_KEY when you want to tighten
  // security before going to production.
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing service role key. Add one of these to your .env.local and restart the dev server:\n" +
        "  SUPABASE_SERVICE_ROLE_KEY=<key>           ← preferred (server-only)\n" +
        "  NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=<key> ← also works\n" +
        "Get the key: Supabase Dashboard → Project Settings → API → service_role secret"
    );
  }

  return createSupabaseClient<Database>(url, serviceKey, {
    auth: {
      // Disable the auto-refresh and session persistence — this client
      // is ephemeral per server action invocation, not a browser session.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
