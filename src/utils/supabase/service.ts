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

  // Use SUPABASE_SERVICE_ROLE_KEY only — NOT the NEXT_PUBLIC_ variant.
  // NEXT_PUBLIC_ variables are bundled into client-side JavaScript by Next.js,
  // which would expose the service-role key to every browser that loads the app.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase service role key.\n" +
        "Add to your .env.local and restart the dev server:\n" +
        "  SUPABASE_SERVICE_ROLE_KEY=<key>\n" +
        "Get the key: Supabase Dashboard → Project Settings → API → service_role secret\n" +
        "IMPORTANT: Use SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix) — the key must never reach the browser."
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
