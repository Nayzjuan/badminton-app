// ============================================================
// Club session join — /c/[clubSlug]/join/[sessionId]
// ============================================================
// Path-based so in-app browsers cannot encode `?session=` into a 404.
// ============================================================

import type { Metadata } from "next";
import { getClubBySlug } from "@/lib/clubs";
import { clubJoin } from "@/lib/club-paths";
import { joinPageMetadata } from "@/lib/join-metadata";
import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import { ClubJoinScreen } from "@/components/join/club-join-screen";

interface ClubSessionJoinPageProps {
  params: Promise<{ clubSlug: string; sessionId: string }>;
}

export async function generateMetadata({ params }: ClubSessionJoinPageProps): Promise<Metadata> {
  const { clubSlug, sessionId } = await params;
  const [club, found] = await Promise.all([
    getClubBySlug(clubSlug),
    lookupActiveJoinSession(sessionId),
  ]);
  const sessionName = found.ok && found.clubSlug === clubSlug ? found.name : null;
  return joinPageMetadata({
    sessionName,
    clubName: club?.name ?? null,
    canonicalPath: clubJoin(clubSlug, sessionId),
  });
}

export default async function ClubSessionJoinPage({ params }: ClubSessionJoinPageProps) {
  const { clubSlug, sessionId } = await params;
  return <ClubJoinScreen clubSlug={clubSlug} sessionId={sessionId} />;
}
