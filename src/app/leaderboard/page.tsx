// ============================================================
// Lobby Leaderboard Page — /leaderboard
// ============================================================
// Accessible from the lobby (/play) without an active session.
// Server Component. Auth is best-effort — never redirects.
//
// Starts on the All-Time tab. "This Session" tab shows a picker
// so the player can choose which session to inspect.
//
// All sessions are fetched (active + past) ordered newest-first.
// ============================================================

import Link from "next/link";
import { ChevronLeft, Trophy } from "lucide-react";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getMyActiveClubIds } from "@/lib/clubs";
import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";

export default async function LobbyLeaderboardPage() {
  const supabase = await createServerSupabaseClient();

  // Auth is best-effort — a logged-out player can still browse All-Time.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Session picker is scoped to the caller's own clubs — sessions_select RLS
  // now enforces this too, but we filter here first so a logged-out visitor
  // (no club membership possible) gets an empty picker instead of relying on
  // the club-scoped policy to deny every row.
  const clubIds = user ? await getMyActiveClubIds(user.id) : [];
  const { data: sessions } =
    clubIds.length === 0
      ? { data: [] }
      : await supabase
          .from("sessions")
          .select("id, name, created_at, is_active")
          .in("club_id", clubIds)
          .order("created_at", { ascending: false });

  return (
    <main className="flex min-h-screen flex-col">
      {/* ── Sticky top bar ────────────────────────────────── */}
      <div
        className="sticky top-0 z-10 flex items-center gap-3 border-b border-border
                      bg-background/95 backdrop-blur px-4 py-3"
      >
        <Link
          href="/play"
          className="flex items-center justify-center h-11 w-11 rounded-lg
                     border border-border hover:bg-muted/50 transition-colors"
          aria-label="Back to lobby"
        >
          <ChevronLeft className="h-4 w-4 text-muted-foreground" />
        </Link>
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-500" aria-hidden="true" />
          <h1 className="text-base font-semibold text-foreground">Leaderboard</h1>
        </div>
      </div>

      {/* ── Leaderboard shell ───────────────────────────────
           variant="standalone" is required here — the compact
           "player-panel" variant has no tab switcher and no
           session picker, so passing sessionId={null} traps
           fetchSession on its early-return and the page is stuck
           on the empty state forever. Standalone gives the full
           UX: All-Time tab by default, This-Session tab with
           session picker, hero card, centered max-w-2xl layout. */}
      <LeaderboardPage
        sessionId={null}
        sessions={sessions ?? []}
        currentUserId={user?.id ?? null}
        variant="standalone"
      />
    </main>
  );
}
