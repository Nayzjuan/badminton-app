// ============================================================
// Legacy redirect shim — /play/[sessionId] → /c/[clubSlug]/play/[sessionId]
// ============================================================
// The player dashboard now lives under the club-namespaced route. This stub
// resolves the session's club and 308-redirects, so already-printed links,
// QR-join forwards, and push deep-links keep resolving. Auth + membership +
// rename-gate + ended-session branching all happen at the club route.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { resolveSessionClubSlug } from "@/lib/clubs";
import { clubPlay } from "@/lib/club-paths";

export default async function PlayerSessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const slug = await resolveSessionClubSlug(sessionId);
  if (!slug) notFound();
  redirect(clubPlay(slug, sessionId));
}
