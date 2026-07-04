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
    <div className="min-h-dvh bg-cc-bg">
      <div className="mx-auto flex max-w-md flex-col px-4 py-12">
        {invite ? (
          <JoinClubPanel token={invite} />
        ) : (
          <div className="clip-cut border border-cc-border bg-cc-bg-2 px-6 py-10 text-center">
            <p className="font-command text-sm font-semibold uppercase tracking-wide text-cc-t1">
              No invite token
            </p>
            <p className="mt-1 text-xs text-cc-t3">This page needs a valid invite link.</p>
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
