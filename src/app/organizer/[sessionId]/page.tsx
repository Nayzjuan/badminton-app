// ============================================================
// Legacy redirect shim — /organizer/[sessionId] → /c/[clubSlug]/organizer/[sessionId]
// ============================================================
// The organizer dashboard now lives under the club-namespaced route. This stub
// resolves the session's club and 308-redirects, so bookmarks and push
// deep-links keep resolving. Auth + membership are enforced at the club route.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { resolveSessionClubSlug } from "@/lib/clubs";
import { clubOrganizer } from "@/lib/club-paths";

export default async function OrganizerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const slug = await resolveSessionClubSlug(sessionId);
  if (!slug) notFound();
  redirect(clubOrganizer(slug, sessionId));
}
