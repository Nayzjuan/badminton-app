// ============================================================
// Legacy redirect shim — /organizer/[sessionId] → /c/[clubSlug]/organizer/[sessionId]
// ============================================================
// The organizer dashboard now lives under the club-namespaced route. This stub
// resolves the session's club and 308-redirects, so bookmarks and push
// deep-links keep resolving. Auth + membership are enforced at the club route.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { resolveSessionClubSlug, ensureClubMembership } from "@/lib/clubs";
import { clubOrganizer } from "@/lib/club-paths";

export default async function OrganizerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const slug = await resolveSessionClubSlug(sessionId);
  if (!slug) notFound();
  // Auto-enroll the requester so a non-member organizer who just created or
  // co-joined a session via the legacy /organizer entry (createSession /
  // joinAsCoOrganizer write no club_members row) isn't bounced out of it.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) await ensureClubMembership(slug, user.id);
  redirect(clubOrganizer(slug, sessionId));
}
