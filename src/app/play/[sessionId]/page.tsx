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
import { resolveSessionClubSlug, ensureClubMembership } from "@/lib/clubs";
import { clubPlay } from "@/lib/club-paths";

export default async function PlayerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const slug = await resolveSessionClubSlug(sessionId);
  if (!slug) notFound();
  // Auto-enroll the requester (same philosophy as QR-join): anyone arriving via
  // a legacy session link — the post-login home redirect, an actively-queued
  // walk-in, an old bookmark — is enrolled so the club gate doesn't bounce them
  // out of a session they legitimately reached.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) await ensureClubMembership(slug, user.id);
  redirect(clubPlay(slug, sessionId));
}
