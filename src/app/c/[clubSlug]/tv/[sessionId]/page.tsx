// ============================================================
// Club TV Scoreboard — /c/[clubSlug]/tv/[sessionId]
// ============================================================
// Public (no membership gate — sits outside the (app)/(full) groups, so only
// the club root layout's resolve+404 applies). Club-namespaced variant of
// /tv/[sessionId] for in-app navigation; cross-checks the session belongs to
// this club (404 on mismatch) to avoid /c/club-a/tv/<club-b-session>.
// ============================================================

import { notFound } from "next/navigation";
import { getTvData } from "@/app/actions/tv";
import { getClubBySlug } from "@/lib/clubs";
import { TvBoard } from "@/app/tv/[sessionId]/tv-board";

interface PageProps {
  params: Promise<{ clubSlug: string; sessionId: string }>;
}

export default async function ClubTvPage({ params }: PageProps) {
  const { clubSlug, sessionId } = await params;

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const { session, matches } = await getTvData(sessionId);
  if (!session) notFound();
  if (session.club_id !== club.id) notFound(); // session belongs to another club

  return <TvBoard sessionId={sessionId} session={session} initialMatches={matches} />;
}
