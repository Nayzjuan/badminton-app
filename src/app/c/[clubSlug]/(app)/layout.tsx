// ============================================================
// Club app layout — /c/[clubSlug]/(app)/*
// ============================================================
// The MEMBER-GATED shell: auth + membership check + club chrome (switcher,
// role-aware nav). Wraps the lobby, admin, and the in-app player/organizer/
// leaderboard routes. Non-members are bounced to /clubs; unauthenticated to /.
//
// Public club routes (tv, join) live OUTSIDE this group so they are NOT gated.
// ============================================================

import { Suspense } from "react";
import Link from "next/link";
import { requireClubMembership, getMyClubs } from "@/lib/clubs";
import { ClubSwitcher } from "@/components/clubs/club-switcher";
import { ClubJoinToast } from "@/components/clubs/club-join-toast";
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

  const multiClub = myClubs.length > 1;

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-background">
      <Suspense fallback={null}>
        <ClubJoinToast clubName={club.name} />
      </Suspense>
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Tenant switcher only when the player belongs to >1 club; otherwise
                a plain club-name label (no cross-club affordance for single-club). */}
            {multiClub ? (
              <ClubSwitcher
                activeSlug={club.slug}
                clubs={myClubs.map((c) => ({ slug: c.club.slug, name: c.club.name, role: c.role }))}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate px-2 py-1.5 font-bold text-slate-900 dark:text-foreground">
                  {club.name}
                </span>
                {/* Not a tenant switcher (single club) — just keeps the clubs hub
                    reachable from the lobby so a lone-club owner can browse/create. */}
                <Link
                  href="/clubs"
                  className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-muted-foreground dark:hover:bg-muted"
                >
                  All clubs
                </Link>
              </div>
            )}
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
