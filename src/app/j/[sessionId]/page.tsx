// ============================================================
// Short share link — /j/[sessionId]
// ============================================================
// What Share Session copies and what the QR encodes. No query string, no
// club slug — the two things in-app browsers most often mangle. Renders
// the public join screen in place (no hop) so unfurlers see OG tags on
// the URL that was actually shared.
// ============================================================

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getClubBySlug } from "@/lib/clubs";
import { sessionShare } from "@/lib/club-paths";
import { joinPageMetadata } from "@/lib/join-metadata";
import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import { ClubJoinScreen } from "@/components/join/club-join-screen";

interface ShortJoinPageProps {
  params: Promise<{ sessionId: string }>;
}

export async function generateMetadata({ params }: ShortJoinPageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const found = await lookupActiveJoinSession(sessionId);
  const club = found.ok ? await getClubBySlug(found.clubSlug) : null;
  return joinPageMetadata({
    sessionName: found.ok ? found.name : null,
    clubName: club?.name ?? null,
    canonicalPath: sessionShare(sessionId),
  });
}

export default async function ShortJoinPage({ params }: ShortJoinPageProps) {
  const { sessionId } = await params;
  const found = await lookupActiveJoinSession(sessionId);
  if (!found.ok) redirect("/play");
  return <ClubJoinScreen clubSlug={found.clubSlug} sessionId={found.sessionId} />;
}
