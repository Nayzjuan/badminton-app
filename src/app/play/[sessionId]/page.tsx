// ============================================================
// Legacy redirect shim — /play/[sessionId] → /c/[clubSlug]/play/[sessionId]
// ============================================================
// The player dashboard now lives under the club-namespaced route. This stub
// resolves the session's club and 308-redirects, so already-printed links,
// QR-join forwards, and push deep-links keep resolving. Auth + membership +
// rename-gate + ended-session branching all happen at the club route.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { resolveSessionClubSlug, ensureClubMembership } from "@/lib/clubs";
import { clubPlay } from "@/lib/club-paths";

/**
 * Is this player actually in the session's queue?
 *
 * The one legitimate case for enrolling here is the walk-in an organizer added
 * to the queue directly — they have a `queue_entries` row but no `club_members`
 * one, so the club gate would bounce them out of a session they are literally
 * queued for. Every other route into this shim (the home-page redirect, PIN
 * reconnect, the /play picker) either already implies such a row or already
 * implies membership.
 *
 * Read through the service client on purpose: RLS on `queue_entries` is
 * `session_access_level(session_id) IS NOT NULL` — club-membership-derived,
 * with no "own row" arm — so the caller's own client cannot see the very row
 * that proves a non-member belongs here. This is an authorization check, the
 * sanctioned use of the service role, same rationale as the organizer
 * predicate in the sibling /organizer shim.
 *
 * Note the argument order is (sessionId, playerId) — the reverse of
 * `isSessionOrganizerLocal(userId, sessionId)` next door and of
 * `_shared.isPlayerInSessionScope(userId, sessionId)`. Both are (string,
 * string), so a swapped call compiles silently. Kept in this order because it
 * reads with the query below; check the signature before copying a call site.
 */
async function isQueuedInSession(sessionId: string, playerId: string): Promise<boolean> {
  const db = createServiceClient();
  const { data } = await db
    .from("queue_entries")
    .select("id")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();
  return !!data;
}

export default async function PlayerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const slug = await resolveSessionClubSlug(sessionId);
  if (!slug) notFound();

  // Enroll ONLY someone already queued for this session. This used to enroll
  // every logged-in visitor, which made a bare session UUID a self-service
  // membership in someone else's club: guess or share an id, load this URL, and
  // the club's roster, sessions and history all opened up. Enrollment is the
  // job of /c/[clubSlug]/join, which is reached by QR and writes the queue row
  // itself; this shim only preserves access for people who already have one.
  //
  // A non-participant still redirects — the club route's membership gate is the
  // single authority on what they may see, and duplicating it here would give
  // two places to keep in sync.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && (await isQueuedInSession(sessionId, user.id))) {
    await ensureClubMembership(slug, user.id);
  }
  redirect(clubPlay(slug, sessionId));
}
