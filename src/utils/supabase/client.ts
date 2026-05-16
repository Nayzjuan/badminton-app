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

export function createBrowserSupabaseClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
