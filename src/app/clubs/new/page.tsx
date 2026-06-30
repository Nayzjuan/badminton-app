// ============================================================
// Create club — /clubs/new
// ============================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { CreateClubForm } from "@/components/clubs/create-club-form";

export default async function NewClubPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-background">
      <div className="mx-auto max-w-md px-4 py-8">
        <Link
          href="/clubs"
          className="mb-5 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Your clubs
        </Link>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-foreground">
          Create a club
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-muted-foreground">
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
