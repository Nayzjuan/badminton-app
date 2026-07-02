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
}

export default async function WrappedPage({ params }: WrappedPageProps) {
  const { sessionId, playerId } = await params;

  const data = await getWrappedData(sessionId, playerId);

  // If the profile doesn't exist, the URL is genuinely invalid.
  if (!data.profile) return notFound();

  return (
    <WrappedShell
      stats={data.stats}
      sessionId={sessionId}
      playerId={playerId}
      matchHistory={data.matchHistory}
      introDismissed={data.introDismissed}
    />
  );
}
