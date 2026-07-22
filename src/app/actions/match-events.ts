"use server";

// ============================================================
// match-events — read the provenance/modification audit trail
// ============================================================
// Organizer-only. The service client bypasses RLS, so the organizer
// check is enforced here in the action layer (same pattern as the
// other organizer-gated reads).
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { isValidUUID } from "@/lib/validate";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import type { MatchEvent, MatchCreatedMethod } from "@/types/database";

export type GetMatchEventsResult =
  | { success: true; events: MatchEvent[] }
  | { success: false; error: string };

/**
 * Returns the ordered audit trail for a single match (seq ascending).
 * Empty for matches created before the audit cutover (no trail exists).
 */
export async function getMatchEvents(
  matchId: string,
  sessionId: string
): Promise<GetMatchEventsResult> {
  if (!isValidUUID(matchId) || !isValidUUID(sessionId)) {
    return { success: false, error: "Invalid id." };
  }

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, error: "Organizer access required." };

  const db = createServiceClient();
  // Filter on BOTH ids. The organizer check above authorizes `sessionId`, but the
  // read was keyed only on `matchId` — two independent arguments from the client,
  // so an organizer of session A could pass a match id from session B and read
  // another club's audit trail (actor names, swap history) through the service
  // client. Binding the read to the session the caller was authorized for makes
  // the mismatch return zero rows. `session_id_snapshot` is NOT NULL and, unlike
  // the live FK, survives match deletion, so it holds for historical rows too.
  const { data, error } = await db
    .from("match_events")
    .select("*")
    .eq("match_id_snapshot", matchId)
    .eq("session_id_snapshot", sessionId)
    .order("seq", { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, events: (data ?? []) as MatchEvent[] };
}

export type SessionProvenanceSummary = {
  total: number; // completed matches
  byMethod: Record<MatchCreatedMethod, number>;
  modified: number; // completed matches with a composition change
};

export type GetSessionProvenanceResult =
  | { success: true; summary: SessionProvenanceSummary }
  | { success: false; error: string };

/**
 * Aggregate provenance for a session, completed matches only (the denominator
 * that matches the headline "% manual vs auto" question — cancelled/pending
 * matches are excluded).
 */
export async function getSessionProvenance(sessionId: string): Promise<GetSessionProvenanceResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid id." };

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };
  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, error: "Organizer access required." };

  const db = createServiceClient();
  const { data, error } = await db
    .from("matches")
    .select("created_method, modification_count")
    .eq("session_id", sessionId)
    .eq("status", "completed");

  if (error) return { success: false, error: error.message };

  const byMethod: Record<MatchCreatedMethod, number> = { auto: 0, manual: 0, held: 0 };
  let modified = 0;
  for (const row of data ?? []) {
    byMethod[row.created_method] = (byMethod[row.created_method] ?? 0) + 1;
    if (row.modification_count > 0) modified += 1;
  }
  return { success: true, summary: { total: data?.length ?? 0, byMethod, modified } };
}
