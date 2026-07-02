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
import { createServiceClient } from "@/utils/supabase/service";
import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function PublicLeaderboardPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  // Service client — this route is an intentional public share link (no auth,
  // works cross-club by design, same as the TV board and Wrapped share page).
  // sessions_select RLS is club-scoped, which would 404 this for anyone
  // without the caller's club membership; a single known sessionId lookup
  // (not a browse-all query) is the sanctioned service-role-for-public-share
  // use case (CLAUDE.md §Database Strictness).
  const db = createServiceClient();
  const { data: session } = await db
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
