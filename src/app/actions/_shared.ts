"use server";

// ============================================================
// Shared Action Helpers
// ============================================================
// isSessionOrganizer and isRpcNotFound were duplicated across
// match.ts, queue.ts, and swap-player.ts. They live here so
// a single definition can be imported by every action module.
//
// All helpers use the service-role client so they bypass RLS;
// auth is always verified by the calling action via getUser()
// before any of these helpers are invoked.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";

/**
 * Returns true when `userId` is an organizer of `sessionId`.
 *
 * Accepts either:
 *   • sessions.created_by === userId  (fast path — avoids a second query)
 *   • a row in session_organizers with (session_id, user_id)
 *
 * Uses the service-role client so the primary organizer is never
 * blocked by read-side RLS on sessions or session_organizers.
 */
export async function isSessionOrganizer(userId: string, sessionId: string): Promise<boolean> {
  const svc = createServiceClient();

  const { data: session } = await svc
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .maybeSingle(); // maybeSingle — deleted/invalid sessions return null, not an error

  if (session?.created_by === userId) return true;

  const { data: membership } = await svc
    .from("session_organizers")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();

  return !!membership;
}

