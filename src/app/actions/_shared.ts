"use server";

// ============================================================
// Shared Action Helpers
// ============================================================
// isSessionOrganizer was duplicated across match.ts, queue.ts,
// and swap-player.ts. It lives here so a single definition can be
// imported by every action module.
//
// getAuthenticatedUser is a thin wrapper around auth.getUser() that
// creates its own server client. Callers no longer need to create a
// client just for the auth check — they can still create a separate
// service client for DB writes.
//
// MatchActionResult is the standard return shape for all match
// server actions. Defined once here; previously duplicated in both
// match-lifecycle.ts and match-drafts.ts.
//
// Note: isRpcNotFound is in src/lib/rpc-utils.ts (pure sync util,
// not a server action — Turbopack requires all "use server" exports
// to be async functions). Type-only exports (like MatchActionResult)
// are erased at compile time and are not subject to that constraint.
//
// Client usage:
//   getAuthenticatedUser — uses createServerSupabaseClient (user-context, respects RLS)
//                          because it calls auth.getUser() which is always user-scoped.
//   isSessionOrganizer   — uses createServiceClient (service-role, bypasses RLS)
//                          so the primary organizer is never blocked by read-side
//                          RLS on sessions or session_organizers.
// ============================================================

/**
 * Standard return shape for match server actions.
 *
 * Consistent with the broader action convention used in sessions.ts,
 * matchmaking.ts, and queue.ts. The `message` field is always present
 * so callers can surface a human-readable reason for both success and
 * failure without null-checking.
 */
export type MatchActionResult = {
  success: boolean;
  message: string;
};

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";

/**
 * Returns the currently authenticated Supabase user, or null if the
 * request is unauthenticated. Creates its own server client so callers
 * do not need to instantiate one solely for the auth check.
 */
export async function getAuthenticatedUser() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Returns true when `userId` is an organizer of `sessionId`.
 *
 * Accepts any of:
 *   • sessions.created_by === userId  (fast path — avoids a second query)
 *   • a row in session_organizers with (session_id, user_id)
 *   • an active owner/admin club_members row for the session's own club
 *     (C6 — club owner/admin = implicit organizer on every session in
 *     their own club; mirrors is_session_organizer() in
 *     20260701000014_club_admin_auto_organizer.sql)
 *
 * Uses the service-role client so the primary organizer is never
 * blocked by read-side RLS on sessions or session_organizers.
 */
export async function isSessionOrganizer(userId: string, sessionId: string): Promise<boolean> {
  const svc = createServiceClient();

  // sessions + session_organizers both depend only on the args → fetch in
  // parallel (was 3 strictly-sequential round trips on the core mutation loop).
  // Semantics unchanged: created_by OR session_organizers OR active owner/admin
  // club_members of the session's club.
  const [sessionRes, membershipRes] = await Promise.all([
    svc.from("sessions").select("created_by, club_id").eq("id", sessionId).maybeSingle(),
    svc
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const session = sessionRes.data; // deleted/invalid sessions return null, not an error
  if (!session) return false;
  if (session.created_by === userId) return true;
  if (membershipRes.data) return true;

  const { data: clubMembership } = await svc
    .from("club_members")
    .select("role")
    .eq("club_id", session.club_id)
    .eq("player_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  return clubMembership?.role === "owner" || clubMembership?.role === "admin";
}

/**
 * True when `targetUserId` is legitimately in scope for `sessionId` — i.e. the
 * organizer-gated service-role actions (PIN read/reset, skill edit) may operate
 * on that player.
 *
 * WHY THIS EXISTS: the organizer gate proves the CALLER organizes `sessionId`,
 * but the mutation target is a caller-supplied `userId` against the GLOBAL
 * profiles table. Without this, an organizer of ANY session (and anyone can
 * self-provision one) could read or overwrite the PIN of ANY player in the DB —
 * a cross-session / cross-club account-takeover primitive (PIN + name drives
 * reconnect identity migration). "Authorize on A, operate on B" must prove A and
 * B share scope.
 *
 * In scope = the target is in this session's queue (any status, incl. paused/
 * left) OR is an active member of the session's club. Service client: the check
 * must not itself be blocked by RLS.
 */
export async function isPlayerInSessionScope(
  targetUserId: string,
  sessionId: string
): Promise<boolean> {
  const svc = createServiceClient();

  const { data: session } = await svc
    .from("sessions")
    .select("club_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return false;

  const [queueRes, memberRes] = await Promise.all([
    svc
      .from("queue_entries")
      .select("id")
      .eq("session_id", sessionId)
      .eq("player_id", targetUserId)
      .limit(1)
      .maybeSingle(),
    svc
      .from("club_members")
      .select("id")
      .eq("club_id", session.club_id)
      .eq("player_id", targetUserId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle(),
  ]);

  return !!queueRes.data || !!memberRes.data;
}

/**
 * Resolves the actor context for a match audit event: the organizer's profile
 * id (= auth user id) and their current display_name snapshot. The name is
 * looked up via the service client (the auth user carries no display_name).
 * Returns null name when the profile can't be resolved — the event still
 * records with a null actor_name rather than failing.
 */
export async function getActorContext(
  userId: string
): Promise<{ id: string; name: string | null }> {
  const svc = createServiceClient();
  const { data: profile } = await svc
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();
  return { id: userId, name: profile?.display_name ?? null };
}
