// ============================================================
// /rename — forced duplicate-name resolution gate (L1 screen)
// ============================================================
// A flagged-duplicate profile is routed here before it can view any
// authenticated screen under the duplicated name. force-dynamic so the
// needs_rename flag is read fresh per request (never RSC/route-cached).
// ============================================================

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { RenameScreen } from "@/components/player/rename-screen";
import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";

export default async function RenamePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNext(next);

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, collided_name, needs_rename")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) redirect("/"); // profileless → recovery path
  if (!profile.needs_rename) redirect(dest); // not flagged → nothing to resolve

  // Stem the player is disambiguating from (the persisted collided name,
  // falling back to the current display name).
  const stem = profile.collided_name ?? profile.display_name;

  return <RenameScreen collidedName={stem} next={dest} />;
}
