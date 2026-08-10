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
import { ensureClubMembership } from "@/lib/clubs";
import { clubOrganizer } from "@/lib/club-paths";
import { isValidUUID } from "@/lib/validate";

/** The session facts this shim needs — the redirect target and the two columns
 *  the organizer predicate is built on. */
type SessionRedirectRow = {
  createdBy: string;
  clubId: string;
  clubSlug: string | null;
};

/**
 * One read for all of it.
 *
 * Was two: `resolveSessionClubSlug()` for the slug, then a second `sessions`
 * select inside the organizer check for `created_by, club_id`. Same row both
 * times, so the second bought nothing but a window in which the session could
 * be re-homed between them. `resolveSessionClubSlug` stays as-is — the /play
 * shim, push send and reconnect all still want just the slug.
 */
async function loadSessionForRedirect(sessionId: string): Promise<SessionRedirectRow | null> {
  if (!isValidUUID(sessionId)) return null;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("sessions")
    .select("created_by, club_id, clubs(slug)")
    .eq("id", sessionId)
    .maybeSingle();
  // Same posture as resolveSessionClubSlug: a query ERROR throws rather than
  // reading as "no such session", because a blip must not 404 a real bookmark.
  if (error) throw new Error(`OrganizerSessionRedirect: ${error.message}`);
  if (!data?.club_id) return null;
  const club = data.clubs as unknown as { slug: string } | null;
  return { createdBy: data.created_by, clubId: data.club_id, clubSlug: club?.slug ?? null };
}

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
 * client, so RLS on `session_organizers` cannot hide the very rows that prove
 * the caller is an organizer. Mirrors `isQueuedInSession` in the sibling
 * `/play` shim. If these ever move to a `server-only` lib, both pages should
 * import from there instead.
 *
 * `session` is passed in rather than re-read — see loadSessionForRedirect.
 * `member` is NOT an organizer role: club membership is what gets you into the
 * club route at all, so treating it as organizership here would hand every
 * member of the club an auto-enroll on any session id they can name.
 */
async function isSessionOrganizerLocal(
  userId: string,
  sessionId: string,
  session: SessionRedirectRow
): Promise<boolean> {
  if (session.createdBy === userId) return true;

  const svc = createServiceClient();
  const [organizerRes, clubRes] = await Promise.all([
    svc
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", userId)
      .maybeSingle(),
    svc
      .from("club_members")
      .select("role")
      .eq("club_id", session.clubId)
      .eq("player_id", userId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  if (organizerRes.data) return true;
  const role = clubRes.data?.role;
  return role === "owner" || role === "admin";
}

export default async function OrganizerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await loadSessionForRedirect(sessionId);
  const slug = session?.clubSlug;
  if (!session || !slug) notFound();

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
  if (user && (await isSessionOrganizerLocal(user.id, sessionId, session))) {
    const enroll = await ensureClubMembership(slug, user.id);
    if (enroll.reason === "write_failed" || enroll.reason === "club_not_found") {
      // The write itself errored, so the whole reason for this branch — giving
      // a membership-less co-organizer a club_members row before the club
      // layout's gate sees them — did not happen. That gate bounces to /play,
      // so go there directly rather than through it.
      //
      // An ALLOWLIST of known-negative reasons on purpose, matching the sibling
      // /play shim. Everything else forwards — today that is `read_failed`,
      // which means the membership SELECT errored, not that they lack a row.
      // Every club owner/admin following a legacy /organizer link passes
      // through this same read, so diverting them on a blip would read a
      // transient error as "not a member"; the layout re-queries instead. A
      // future reason must opt IN to diverting rather than inherit it.
      redirect("/play");
    }
  }
  redirect(clubOrganizer(slug, sessionId));
}
