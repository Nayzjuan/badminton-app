// ============================================================
// Create club — /clubs/new
// ============================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { isPlatformOwner } from "@/lib/platform";
import { CreateClubForm } from "@/components/clubs/create-club-form";

export default async function NewClubPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Creating a club is platform-owner-only (defense in depth with the createClub
  // server-action gate). Non-owners are bounced to their own club context.
  if (!isPlatformOwner(user.id)) redirect("/play");

  return (
    <div className="min-h-dvh bg-cc-bg">
      <div className="mx-auto max-w-md px-4 py-8">
        <Link
          href="/clubs"
          className="mb-5 inline-flex items-center gap-1 font-command text-xs uppercase tracking-wide text-cc-t2 transition-colors hover:text-cc-t1"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Your clubs
        </Link>
        <h1 className="font-display text-2xl font-bold uppercase italic tracking-tight text-cc-t1">
          Create a club
        </h1>
        <p className="mt-1 text-sm text-cc-t2">
          You&apos;ll be the owner. Invite players and run sessions under your club&apos;s own
          space.
        </p>
        <div className="mt-6">
          <CreateClubForm />
        </div>
      </div>
    </div>
  );
}
