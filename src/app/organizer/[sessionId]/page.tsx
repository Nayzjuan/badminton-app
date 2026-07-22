// ============================================================
// Legacy redirect shim — /organizer/[sessionId] → /c/[clubSlug]/organizer/[sessionId]
// ============================================================
// The organizer dashboard now lives under the club-namespaced route. This stub
// resolves the session's club and 308-redirects, so bookmarks and push
// deep-links keep resolving. Auth + membership are enforced at the club route.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { resolveSessionClubSlug, ensureClubMembership } from "@/lib/clubs";
import { clubOrganizer } from "@/lib/club-paths";

/**
 * Does this user run this session? Local copy of `isSessionOrganizer` from
 * `@/app/actions/_shared`, deliberately NOT the import.
 *
 * `_shared.ts` is a `"use server"` module. Importing it from an *action* module
 * is a plain function call and registers nothing — that is why it has no entry
 * in the server-reference manifest today. Importing it from an RSC page like
 * this one is different: its exports must become passable references, so Next
 * registers ALL FOUR as dispatchable Server Action endpoints under this route.
 * Two of them are cross-tenant oracles taking a caller-supplied uuid, and
 * `getActorContext` is an unauthenticated display-name lookup for any uuid.
 * Publishing them from a tenancy fix would widen the surface this file exists
 * to narrow. Verified by diffing server-reference-manifest.json between builds:
 * the import adds +4 actions, all scoped to `app/organizer/[sessionId]/page`.
 *
 * Same predicate as the original — created_by OR session_organizers OR an
 * active owner/admin of the session's club — and the same use of the service
 * client, so RLS on `sessions`/`session_organizers` cannot hide the very rows
 * that prove the caller is an organizer. Mirrors `isQueuedInSession` in the
 * sibling `/play` shim. If these ever move to a `server-only` lib, both pages
 * should import from there instead.
 */
async function isSessionOrganizerLocal(userId: string, sessionId: string): Promise<boolean> {
  const svc = createServiceClient();

  const [sessionRes, organizerRes] = await Promise.all([
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
  if (organizerRes.data) return true;

  const { data: clubMembership } = await svc
    .from("club_members")
    .select("role")
    .eq("club_id", session.club_id)
    .eq("player_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  return clubMembership?.role === "owner" || clubMembership?.role === "admin";
}

export default async function OrganizerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const slug = await resolveSessionClubSlug(sessionId);
  if (!slug) notFound();

  // Enroll ONLY a real organizer of this session. The case worth keeping is the
  // non-member organizer who co-joined via the legacy entry — joinAsCoOrganizer
  // writes `session_organizers` but no `club_members` row, so without this they
  // are bounced out of a session they legitimately run.
  //
  // Enrolling every logged-in visitor (what this used to do) turned a bare
  // session UUID into a self-service club membership: knowing the id was enough
  // to become a member of someone else's club and see its roster and history.
  // The gate is the same predicate every organizer-only action already applies
  // (created_by OR session_organizers OR an active owner/admin of the club), so
  // it admits exactly the people who could already act as organizers here.
  //
  // A non-organizer still redirects — the club route's own membership gate is
  // the single authority on what they may see, and duplicating it here would
  // give two places to keep in sync.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && (await isSessionOrganizerLocal(user.id, sessionId))) {
    await ensureClubMembership(slug, user.id);
  }
  redirect(clubOrganizer(slug, sessionId));
}
