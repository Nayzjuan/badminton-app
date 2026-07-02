// ============================================================
// Club full-screen layout — /c/[clubSlug]/(full)/*
// ============================================================
// Member-gated. The player & organizer dashboards are full-screen apps with
// their own headers, so we add NO chrome for single-club users. When the player
// belongs to more than one club (e.g. after scanning another club's QR), we add
// a slim STICKY switcher bar above the dashboard — sticky (not fixed/overlay) so
// it never collides with the dashboard's own header. Also fires the one-time
// "Welcome to <club>" toast after a QR join.
// ============================================================

import { Suspense } from "react";
import { requireClubMembership, getMyClubs, getMyActiveClubIds } from "@/lib/clubs";
import { ClubSwitcher } from "@/components/clubs/club-switcher";
import { ClubJoinToast } from "@/components/clubs/club-join-toast";

export default async function ClubFullLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const { userId, club } = await requireClubMembership(clubSlug); // auth + 404 + member gate

  // Hot path (play/organizer): do the cheap 1-query count first; only load the
  // full club rows (names/roles for the switcher) when the player is multi-club.
  const clubIds = await getMyActiveClubIds(userId);
  const myClubs = clubIds.length > 1 ? await getMyClubs(userId) : [];

  return (
    <>
      {myClubs.length > 1 && (
        <div className="sticky top-0 z-40 flex items-center border-b border-slate-200 bg-white/90 px-3 py-1.5 backdrop-blur dark:border-border dark:bg-card/90">
          <ClubSwitcher
            activeSlug={club.slug}
            clubs={myClubs.map((c) => ({ slug: c.club.slug, name: c.club.name, role: c.role }))}
          />
        </div>
      )}
      <Suspense fallback={null}>
        <ClubJoinToast clubName={club.name} />
      </Suspense>
      {children}
    </>
  );
}
