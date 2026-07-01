// ============================================================
// Club Leaderboard — /c/[clubSlug]/leaderboard
// ============================================================
// Member-gated (under the (app) group). Renders the standalone leaderboard
// scoped to THIS club: the session picker lists only club sessions, and
// useLeaderboard reads the slug from the path (useClubSlug) so the all-time +
// monthly boards filter by club_id via the Phase-3 club-scoped views/RPCs.
// ============================================================

import { Trophy } from "lucide-react";
import { requireClubMembership, getClubSessions } from "@/lib/clubs";
import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";

export default async function ClubLeaderboardPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { userId, club } = await requireClubMembership(clubSlug);

  const sessions = await getClubSessions(club.id);
  const sessionOptions = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    created_at: s.created_at,
    is_active: s.is_active,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4 text-amber-500" aria-hidden="true" />
        <h1 className="text-base font-semibold text-foreground">Leaderboard</h1>
      </div>
      <LeaderboardPage
        sessionId={null}
        sessions={sessionOptions}
        currentUserId={userId}
        variant="standalone"
      />
    </div>
  );
}
