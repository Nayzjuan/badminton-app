// ============================================================
// Legacy redirect shim — /organizer → /c/[clubSlug]/organizer
// ============================================================
// The organizer hub now lives under the club-namespaced route (mirrors the
// /organizer/[sessionId] shim and the /play routing). This resolves the
// caller's organizing club and redirects, so bookmarks and old links keep
// working. Auth + membership + rendering all happen at the club route.
// ============================================================

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getPrimaryClubSlug } from "@/lib/clubs";
import { clubOrganizer } from "@/lib/club-paths";

export default async function OrganizerRedirect() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // The club to organize in: the club of the caller's most-recently-attended
  // session, falling back to their most-recently-joined active club (the same
  // resolver /play uses). No club at all → the join-via-QR screen; there is
  // nothing to organize yet. Multi-club organizers land in their most-recent
  // club and switch via the in-club club switcher.
  const slug = await getPrimaryClubSlug(user.id);
  if (!slug) redirect("/welcome");
  redirect(clubOrganizer(slug));
}
