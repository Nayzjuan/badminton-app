// ============================================================
// Join-via-QR landing — /welcome
// ============================================================
// Shown to an authenticated player who belongs to NO club yet — i.e. someone
// who registered via the plain login link without scanning an organizer's QR.
// Instead of stranding them on an empty session picker, we tell them how to
// join: scan the session QR from their organizer.
//
// A player who scans a club/session QR is enrolled *before* landing (see
// signInAnonymously / the /c/[slug]/join flow) and is routed straight to the
// session — so they never see this screen. Terminal page: if the user actually
// does have a club, bounce them back to their session picker (no redirect loop —
// /play sends the no-club case here, this sends the has-club case there, and the
// two states converge).
// ============================================================

import { redirect } from "next/navigation";
import { QrCode } from "lucide-react";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getPrimaryClubSlug } from "@/lib/clubs";
import { SignOutButton } from "@/components/sign-out-button";

export default async function WelcomePage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // If they already belong to a club, they don't belong here.
  const primaryClubSlug = await getPrimaryClubSlug(user.id);
  if (primaryClubSlug) redirect("/play");

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  const name = profileRow?.display_name ?? null;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-cc-bg px-6 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="clip-cut-sm mx-auto flex h-14 w-14 items-center justify-center bg-cc-bg-3">
          <QrCode className="h-7 w-7 text-cc-accent" aria-hidden="true" />
        </div>

        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold uppercase italic tracking-tight text-cc-t1">
            {name ? `You're registered, ${name}` : "You're registered"}
          </h1>
          <p className="text-sm leading-relaxed text-cc-t2">
            You&apos;re not part of a club yet. Ask your session organizer for the{" "}
            <span className="font-semibold text-cc-t1">join QR code</span> — scan it to jump
            straight into their session.
          </p>
        </div>

        <p className="text-xs text-cc-t3">
          Once you join a club, you&apos;ll go straight to its sessions next time you sign in.
        </p>

        <div className="pt-2">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
