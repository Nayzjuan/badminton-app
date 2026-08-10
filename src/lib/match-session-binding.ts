// ============================================================
// Match ↔ session binding (authorization helper)
// ============================================================
// Lives here rather than inside `src/app/actions/live-match-swap.ts` because
// that is a `"use server"` module: exporting it there would publish it as a
// dispatchable Server Action endpoint — a cross-tenant boolean oracle over two
// caller-supplied uuids. Keeping it non-exported meant the empty-list guard
// could only be tested by asserting on the module's SOURCE TEXT. From here the
// tests import and call the real thing.
//
// Type-only import of createServiceClient, deliberately: that module is
// `server-only`, and a value import would drag the guard (and the env-var
// requirement) into anything that touches this file.
// ============================================================

import type { createServiceClient } from "@/utils/supabase/service";

/**
 * Do ALL of these match ids belong to `sessionId`?
 *
 * The organizer gate proves the caller may act on `sessionId`. It says nothing
 * about a match id that arrived in the same request, and every id here is
 * independently client-supplied — including the ones inside a
 * `LiveSwapUndoContext`, which is a plain object the client round-trips and can
 * therefore forge field by field.
 *
 * Deliberately on the service client: RLS on `matches` is derived from club
 * membership, so a cross-club id would come back empty under the caller's own
 * client too — but for the wrong reason, and it would silently start failing for
 * legitimate organizers the moment the read path changes. This is an
 * authorization check, the sanctioned service-role use.
 *
 * `.in()` with a de-duplicated list and a count comparison, rather than one
 * query per id: a partial match must fail, and comparing counts makes "one of
 * the two is someone else's" indistinguishable from "neither exists", which is
 * what we want to expose to the caller.
 */
export async function allMatchesInSession(
  db: ReturnType<typeof createServiceClient>,
  sessionId: string,
  matchIds: string[]
): Promise<boolean> {
  const ids = [...new Set(matchIds)];
  // No caller passes an empty list today, but `0 === 0` would make the vacuous
  // case "authorized", and this is a security helper — the next caller with an
  // optional match id would inherit a silent bypass. Refuse instead.
  if (ids.length === 0) return false;
  const { data, error } = await db
    .from("matches")
    .select("id")
    .in("id", ids)
    .eq("session_id", sessionId);
  if (error) return false;
  return (data?.length ?? 0) === ids.length;
}
