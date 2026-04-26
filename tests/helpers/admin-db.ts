/**
 * Shared Supabase service-role client for E2E tests.
 *
 * Uses the service-role key so tests can bypass RLS for seeding and
 * asserting database state without going through the app's auth layer.
 *
 * Import this wherever you need direct DB access in a spec file:
 *   import { adminDb } from "../helpers/admin-db";
 */
import { createClient } from "@supabase/supabase-js";

export function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
