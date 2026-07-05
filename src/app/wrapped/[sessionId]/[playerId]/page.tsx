// ============================================================
// Wrapped Page — server component
// ============================================================
// Route: /wrapped/[sessionId]/[playerId]
//
// The true public/shareable Wrapped link (printed QR codes, push deep-links
// with no club context, external shares). A club-namespaced convenience
// variant also exists at /c/[clubSlug]/wrapped/[sessionId]/[playerId] for
// in-app navigation — see that page for the session↔club cross-check.
//
// Data-fetching is shared with the club-scoped variant via getWrappedData.
// If no stats row exists (session not yet closed, or player had 0 completed
// matches), that returns a graceful empty-state instead of throwing.
// ============================================================

import { notFound } from "next/navigation";
import { getWrappedData } from "@/app/actions/wrapped";
import { WrappedShell } from "@/components/wrapped/wrapped-shell";

interface WrappedPageProps {
  params: Promise<{ sessionId: string; playerId: string }>;
  searchParams: Promise<{ recap?: string }>;
}

export default async function WrappedPage({ params, searchParams }: WrappedPageProps) {
  const { sessionId, playerId } = await params;
  // ?recap=1 = the player reached this from their session history (a revisit),
  // so skip the celebratory intro overlay and go straight to the recap. The
  // one-time close-broadcast entry (no flag) still plays the intro.
  const { recap } = await searchParams;

  const data = await getWrappedData(sessionId, playerId);

  // If the profile doesn't exist, the URL is genuinely invalid.
  if (!data.profile) return notFound();

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
