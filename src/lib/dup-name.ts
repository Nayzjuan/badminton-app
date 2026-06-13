import "server-only";

// ============================================================
// Duplicate-name availability check (server-only)
// ============================================================
// Shared by registration (signInAnonymously) and the rename gate
// (checkNameAvailable). Mirrors the partial UNIQUE index domain
// (WHERE needs_rename = false) so the app-side pre-check and the DB
// authority agree on what "taken" means.
//
// This is a UX PRE-VALIDATION only. The partial UNIQUE index on the
// normalized name is the real arbiter at write time — it is the only
// thing that closes the TOCTOU race this read cannot.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { normalizeName } from "@/lib/normalize-name";

type ServiceClient = SupabaseClient<Database>;

// Escape ILIKE metacharacters so a caller-supplied string is matched literally,
// never as a wildcard pattern. (Identical to the helper in auth.ts.)
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * True when `name` collides — by normalized key — with any NON-FLAGGED profile
 * other than `excludeId`. Flagged duplicates are excluded to match the partial
 * unique index (a returning duplicate keeps its name until it renames).
 *
 * Fails OPEN on a read error: a transient DB blip should not block a legitimate
 * registration/rename, because the unique index still guarantees correctness at
 * the actual write.
 */
export async function isNameTaken(
  svc: ServiceClient,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const normalized = normalizeName(name);

  const { data, error } = await svc
    .from("profiles")
    .select("id, display_name")
    .eq("needs_rename", false)
    .ilike("display_name", escapeLike(name)); // case-insensitive exact (no wildcards)

  if (error) {
    console.warn("[dup-name] isNameTaken read failed (non-fatal):", error.message);
    return false;
  }

  return (data ?? []).some(
    (row) => row.id !== excludeId && normalizeName(row.display_name) === normalized
  );
}
