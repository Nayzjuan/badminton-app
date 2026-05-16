// ============================================================
// Public Leaderboard Page — /leaderboard/[sessionId]
// ============================================================
// Server Component. No auth required — works when logged out.
// Designed for sharing via QR code, gym display screens, or
// direct link. Auth is attempted but never enforced; the
// currentUserId is passed through so the Hero Card appears
// for authenticated visitors.
//
// Mirrors the /play/[sessionId] pattern for public access.
// ============================================================

import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function PublicLeaderboardPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  // Fetch session — required (404 on missing session)
  const { data: session } = await supabase
    .from("sessions")
    .select("id, name")
    .eq("id", sessionId)
    .single();

  if (!session) notFound();

  // Auth is best-effort — never redirect on failure
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <LeaderboardPage
      sessionId={session.id}
      sessionName={session.name}
      currentUserId={user?.id ?? null}
      variant="standalone"
    />
  );
}
