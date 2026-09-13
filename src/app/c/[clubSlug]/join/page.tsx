// ============================================================
// Club join — /c/[clubSlug]/join  (?session= still accepted, 308'd to path)
// ============================================================
// PUBLIC (outside the (app)/(full) membership gate). Club-only join, or a
// back-compat hop from printed QR codes that still carry ?session=.
// ============================================================

import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { getClubBySlug } from "@/lib/clubs";
import { clubJoin } from "@/lib/club-paths";
import { joinPageMetadata } from "@/lib/join-metadata";
import { isValidUUID } from "@/lib/validate";
import { ClubJoinScreen } from "@/components/join/club-join-screen";

interface ClubJoinPageProps {
  params: Promise<{ clubSlug: string }>;
  searchParams: Promise<{ session?: string }>;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}): Promise<Metadata> {
  const { clubSlug } = await params;
  const club = await getClubBySlug(clubSlug);
  return joinPageMetadata({
    clubName: club?.name ?? null,
    canonicalPath: clubJoin(clubSlug),
  });
}

export default async function ClubJoinPage({ params, searchParams }: ClubJoinPageProps) {
  const { clubSlug } = await params;
  const { session: sessionId } = await searchParams;
  if (sessionId && isValidUUID(sessionId)) {
    permanentRedirect(clubJoin(clubSlug, sessionId));
  }
  return <ClubJoinScreen clubSlug={clubSlug} />;
}
