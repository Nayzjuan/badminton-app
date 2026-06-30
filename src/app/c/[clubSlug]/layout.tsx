// ============================================================
// Club shell layout — /c/[clubSlug]
// ============================================================
// Resolves the slug → club, gates on membership, and renders the club
// chrome (name, club switcher, role-aware nav) around every club route.
// Non-members are bounced to /clubs; unknown slugs 404.
// ============================================================

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getClubBySlug, getClubRole, getMyClubs } from "@/lib/clubs";
import { ClubSwitcher } from "@/components/clubs/club-switcher";

export default async function ClubLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const role = await getClubRole(user.id, club.id);
  if (!role) redirect("/clubs"); // not a member of this club

  const isAdmin = role === "owner" || role === "admin";
  const myClubs = await getMyClubs(user.id);

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
              href={`/c/${club.slug}`}
              className="rounded-lg px-3 py-1.5 text-slate-600 transition-colors hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted"
            >
              Lobby
            </Link>
            {isAdmin && (
              <Link
                href={`/c/${club.slug}/admin`}
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
