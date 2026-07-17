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
import { requireClubMembership, getMyClubs, getMyActiveClubIds } from "@/lib/clubs";
import { isPlatformOwner } from "@/lib/platform";
import { ClubSwitcher } from "@/components/clubs/club-switcher";
import { ClubChromeNav } from "@/components/clubs/club-chrome-nav";
import { ClubJoinToast } from "@/components/clubs/club-join-toast";

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
  // Only the platform owner gets cross-club affordances (switch to / browse /
  // create other clubs). Everyone else is scoped to this club.
  const isOwner = isPlatformOwner(userId);
  // Count-first (mirrors the (full) layout): only the club switcher needs the
  // full rows, and only when the member belongs to >1 club — which is rare.
  // Was an unconditional 3-query getMyClubs on every (app) navigation.
  const clubIds = await getMyActiveClubIds(userId);
  const multiClub = clubIds.length > 1;
  const myClubs = multiClub ? await getMyClubs(userId) : [];

  return (
    <div className="min-h-dvh bg-cc-bg">
      <Suspense fallback={null}>
        <ClubJoinToast clubName={club.name} />
      </Suspense>
      <header className="border-b border-cc-border bg-cc-bg-2 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Tenant switcher only when the player belongs to >1 club; otherwise
                a plain club-name label (no cross-club affordance for single-club). */}
            {multiClub ? (
              <ClubSwitcher
                activeSlug={club.slug}
                clubs={myClubs.map((c) => ({ slug: c.club.slug, name: c.club.name, role: c.role }))}
                isPlatformOwner={isOwner}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate px-2 py-1.5 font-display font-bold uppercase italic tracking-tight text-cc-t1">
                  {club.name}
                </span>
                {/* The clubs hub is platform-owner-only — the "All clubs" link is
                    shown only to the owner, so a regular member never sees a
                    cross-club affordance (and it wouldn't work for them anyway). */}
                {isOwner && (
                  <Link
                    href="/clubs"
                    className="clip-cut-sm shrink-0 px-2 py-1 font-command text-xs uppercase tracking-wide text-cc-t2 transition-colors hover:bg-cc-bg-3 hover:text-cc-t1"
                  >
                    All clubs
                  </Link>
                )}
              </div>
            )}
          </div>
          <ClubChromeNav slug={club.slug} isAdmin={isAdmin} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}
