// ============================================================
// Club Session Wrapped — /c/[clubSlug]/wrapped/[sessionId]/[playerId]
// ============================================================
// Public (no membership gate — sits outside the (app)/(full) groups, so only
// the club root layout's resolve+404 applies). Club-namespaced convenience
// variant of /wrapped/[sessionId]/[playerId] for in-app navigation (organizer
// broadcast + end-of-session redirects); cross-checks the session belongs to
// this club (404 on mismatch) to avoid /c/club-a/wrapped/<club-b-session>/...
// — mirrors /c/[clubSlug]/tv/[sessionId]. The root route remains the "true"
// public/shareable link (printed QR codes, external shares).
// ============================================================

import { notFound } from "next/navigation";
import { getWrappedData } from "@/app/actions/wrapped";
import { getClubBySlug } from "@/lib/clubs";
import { WrappedShell } from "@/components/wrapped/wrapped-shell";

interface PageProps {
  params: Promise<{ clubSlug: string; sessionId: string; playerId: string }>;
  searchParams: Promise<{ recap?: string }>;
}

export default async function ClubWrappedPage({ params, searchParams }: PageProps) {
  const { clubSlug, sessionId, playerId } = await params;
  // ?recap=1 = revisit from session history — skip the intro, go to the recap.
  const { recap } = await searchParams;

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const data = await getWrappedData(sessionId, playerId);
  if (!data.profile) notFound();
  if (data.sessionClubId !== club.id) notFound(); // session belongs to another club

  return (
    <WrappedShell
      stats={data.stats}
      sessionId={sessionId}
      playerId={playerId}
      matchHistory={data.matchHistory}
      introDismissed={data.introDismissed || recap === "1"}
    />
  );
}
