// ============================================================
// Accept club invite — /clubs/join?invite=<token>
// ============================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { JoinClubPanel } from "@/components/clubs/join-club-panel";

export default async function JoinClubPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Preserve the invite through login so the player lands back here.
  if (!user) redirect(`/?next=${encodeURIComponent(`/clubs/join?invite=${invite ?? ""}`)}`);

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-background">
      <div className="mx-auto flex max-w-md flex-col px-4 py-12">
        {invite ? (
          <JoinClubPanel token={invite} />
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center dark:border-border dark:bg-card">
            <p className="text-sm font-semibold text-slate-700 dark:text-foreground">
              No invite token
            </p>
            <p className="mt-1 text-xs text-slate-400 dark:text-muted-foreground">
              This page needs a valid invite link.
            </p>
            <Link
              href="/clubs"
              className="mt-4 inline-block text-xs font-semibold text-cc-accent-text underline underline-offset-2"
            >
              Go to your clubs
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
