"use server";

// ============================================================
// Court Actions — add, update status, and remove courts
// ============================================================
// These are the authoritative server-side mutations for the courts
// table. useOrganizerCourts delegates all writes here so that:
//   1. Auth + organizer-role checks run server-side (TypeScript
//      types are erased at runtime — inline client validation is
//      not sufficient against a crafted call).
//   2. Writes go through the service client, which bypasses RLS
//      consistently. The browser client's RLS policy for courts
//      only covers reads; write policy is organizer-only and is
//      enforced here rather than split across client + DB layer.
// ============================================================

import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import { createServiceClient } from "@/utils/supabase/service";
import type { CourtStatus } from "@/types/database";

export type CourtActionResult = {
  success: boolean;
  message: string;
};

/**
 * Adds a new court to a session.
 *
 * Requires the caller to be the session organizer. Uses the service
 * client so the insert bypasses RLS — the organizer check above is
 * the sole write-gate, matching how other organizer-only mutations
 * (e.g. cancelMatchAction) are structured.
 */
export async function addCourtAction(sessionId: string, name: string): Promise<CourtActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const isOrg = await isSessionOrganizer(user.id, sessionId);
  if (!isOrg) return { success: false, message: "Not authorized." };

  const svc = createServiceClient();
  const { error } = await svc.from("courts").insert({ session_id: sessionId, name });
  if (error) {
    // 23505 = unique_violation on courts_session_id_name_key (session_id, name).
    // Re-adding an existing court name is the single most likely way an organizer
    // reaches this branch, and the raw Postgres text names an index rather than
    // telling them what to do about it.
    if (error.code === "23505") {
      // Typographic quotes, not ASCII ": a court literally named `Court "A"` would
      // otherwise render as ...named "Court "A"", where the delimiters are
      // indistinguishable from the name's own quotes.
      return { success: false, message: `This session already has a court named “${name}”.` };
    }
    console.error("addCourtAction: insert failed:", error);
    return { success: false, message: "Failed to add court. Please try again." };
  }
  return { success: true, message: "Court added." };
}

/**
 * Updates the status of a court (available → closed, or vice-versa).
 *
 * The organizer check is required even though the browser-client RLS
 * would also enforce it, because this action is used by useOrganizerCourts
 * which uses the service client for consistency with all other court writes.
 */
export async function updateCourtStatusAction(
  sessionId: string,
  courtId: string,
  status: CourtStatus
): Promise<CourtActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const isOrg = await isSessionOrganizer(user.id, sessionId);
  if (!isOrg) return { success: false, message: "Not authorized." };

  const svc = createServiceClient();
  // Scope to sessionId so an organizer of Session A cannot mutate a court
  // from Session B by supplying their own sessionId alongside a foreign courtId.
  // The service client bypasses RLS, making this double-check mandatory.
  const { error } = await svc
    .from("courts")
    .update({ status })
    .eq("id", courtId)
    .eq("session_id", sessionId);
  if (error) return { success: false, message: error.message };
  return { success: true, message: "Court status updated." };
}

/**
 * Permanently removes a court from a session.
 *
 * Soft-delete is not used because courts are display scaffolding only —
 * removing one does not affect match or queue history. The organizer
 * typically removes empty / closed courts at session end.
 */
export async function removeCourtAction(
  sessionId: string,
  courtId: string
): Promise<CourtActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const isOrg = await isSessionOrganizer(user.id, sessionId);
  if (!isOrg) return { success: false, message: "Not authorized." };

  const svc = createServiceClient();
  // Same session-scope guard as updateCourtStatusAction — prevents cross-session
  // court deletion when the service client has bypassed RLS.
  const { error } = await svc.from("courts").delete().eq("id", courtId).eq("session_id", sessionId);
  if (error) return { success: false, message: error.message };
  return { success: true, message: "Court removed." };
}
