// ============================================================
// TV Scoreboard Page — /tv/[sessionId]
// ============================================================
// Completely public — no auth required. Uses the service-role
// client for the initial data fetch so RLS never blocks it.
// Real-time updates are handled by the client TvBoard component.
// ============================================================

import { notFound } from "next/navigation";
import { getTvData } from "@/app/actions/tv";
import { TvBoard } from "./tv-board";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function TvPage({ params }: PageProps) {
  const { sessionId } = await params;

  const { session, matches } = await getTvData(sessionId);

  if (!session) notFound();

  return (
    <TvBoard
      sessionId={sessionId}
      session={session}
      initialMatches={matches}
    />
  );
}
