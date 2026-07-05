// ============================================================
// Multi-club home — /clubs
// ============================================================
// The cross-tenant entry point: every club the player belongs to, badged
// with their role + active-session count, plus a "create club" CTA.
// (MULTI_TENANT_PLAN.md §3.4)
// ============================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Users } from "lucide-react";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getMyClubs } from "@/lib/clubs";
import { isPlatformOwner } from "@/lib/platform";
import { ClubList } from "@/components/clubs/club-list";

export default async function ClubsHomePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // The cross-club hub is platform-owner-only. Everyone else is scoped to their
  // own club — send them to the session picker (which resolves their club or the
  // join-via-QR screen). Blocks non-owners even if they type the URL directly.
  if (!isPlatformOwner(user.id)) redirect("/play");

  const clubs = await getMyClubs(user.id);

  return (
    <div className="min-h-dvh bg-cc-bg">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold uppercase italic tracking-tight text-cc-t1">
              Your clubs
            </h1>
            <p className="mt-0.5 text-sm text-cc-t2">Pick a club to run or play in.</p>
          </div>
          <Link
            href="/clubs/new"
            className="clip-cut-sm inline-flex items-center gap-1.5 bg-cc-accent px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-cc-btn-on-accent transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New club
          </Link>
        </div>

        {clubs.length === 0 ? (
          <div className="clip-cut border border-dashed border-cc-border bg-cc-bg-2 px-6 py-14 text-center">
            <div className="clip-cut-sm mx-auto mb-3 flex h-11 w-11 items-center justify-center bg-cc-bg-3">
              <Users className="h-5 w-5 text-cc-t3" aria-hidden="true" />
            </div>
            <p className="font-command text-sm font-semibold uppercase tracking-wide text-cc-t1">
              You&apos;re not in any clubs yet
            </p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-cc-t3">
              Create your own club, or open an invite link someone shared with you.
            </p>
            <Link
              href="/clubs/new"
              className="clip-cut-sm mt-4 inline-flex items-center gap-1.5 bg-cc-accent px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-cc-btn-on-accent transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create a club
            </Link>
          </div>
        ) : (
          <ClubList initialClubs={clubs} />
        )}
      </div>
    </div>
  );
}
