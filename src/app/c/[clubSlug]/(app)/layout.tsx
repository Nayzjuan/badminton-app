// ============================================================
// Club app layout — /c/[clubSlug]/(app)/*
// ============================================================
// The MEMBER-GATED shell: auth + membership check + club chrome (switcher,
// role-aware nav). Wraps the lobby, admin, and the in-app player/organizer/
// leaderboard routes. Non-members are bounced to /clubs; unauthenticated to /.
//
// Public club routes (tv, join) live OUTSIDE this group so they are NOT gated.
// ============================================================

import Link from "next/link";
import { requireClubMembership, getMyClubs } from "@/lib/clubs";
import { ClubSwitcher } from "@/components/clubs/club-switcher";
import { clubBase, clubAdmin, clubLeaderboard } from "@/lib/club-paths";

export default async function ClubAppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;

  const { userId, club, role } = await requireClubMembership(clubSlug);
  const isAdmin = role === "owner" || role === "admin";
  const myClubs = await getMyClubs(userId);

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-background">
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <ClubSwitcher
              activeSlug={club.slug}
              clubs={myClubs.map((c) => ({ slug: c.club.slug, name: c.club.name, role: c.role }))}
            />
          </div>
          <nav className="flex items-center gap-1 text-xs font-semibold">
            <Link
              href={clubBase(club.slug)}
              className="rounded-lg px-3 py-1.5 text-slate-600 transition-colors hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted"
            >
              Lobby
            </Link>
            <Link
              href={clubLeaderboard(club.slug)}
              className="rounded-lg px-3 py-1.5 text-slate-600 transition-colors hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted"
            >
              Leaderboard
            </Link>
            {isAdmin && (
              <Link
                href={clubAdmin(club.slug)}
                className="rounded-lg px-3 py-1.5 text-slate-600 transition-colors hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted"
              >
                Admin
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}
