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
import type { ClubRole } from "@/types/database";

const ROLE_LABEL: Record<ClubRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export default async function ClubsHomePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const clubs = await getMyClubs(user.id);

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-background">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-foreground">
              Your clubs
            </h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-muted-foreground">
              Pick a club to run or play in.
            </p>
          </div>
          <Link
            href="/clubs/new"
            className="inline-flex items-center gap-1.5 rounded-xl bg-cc-accent px-3.5 py-2 text-sm font-bold text-cc-btn-on-accent shadow-sm transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New club
          </Link>
        </div>

        {clubs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-14 text-center dark:border-border dark:bg-card">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 dark:bg-muted">
              <Users className="h-5 w-5 text-slate-400 dark:text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold text-slate-700 dark:text-foreground">
              You&apos;re not in any clubs yet
            </p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-slate-400 dark:text-muted-foreground">
              Create your own club, or open an invite link someone shared with you.
            </p>
            <Link
              href="/clubs/new"
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-cc-accent px-4 py-2 text-sm font-bold text-cc-btn-on-accent transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              Create a club
            </Link>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {clubs.map(({ club, role, activeSessions }) => (
              <li key={club.id}>
                <Link
                  href={`/c/${club.slug}`}
                  className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition-colors hover:bg-slate-50 dark:border-border dark:bg-card dark:hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold text-slate-900 dark:text-foreground">
                      {club.name}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-muted-foreground">
                      /c/{club.slug}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {activeSessions > 0 && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                        {activeSessions} live
                      </span>
                    )}
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:bg-muted dark:text-muted-foreground">
                      {ROLE_LABEL[role]}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
