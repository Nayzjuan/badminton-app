// ============================================================
// /rename — name gate (duplicate force OR Google confirm)
// ============================================================
// force-dynamic so the flags are read fresh per request.
// ============================================================

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { RenameScreen } from "@/components/player/rename-screen";
import { safeNext } from "@/lib/safe-next";
import { renamePageDecision } from "@/lib/rename-decision";
import type { SkillLevel } from "@/types/database";

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
    .select("display_name, collided_name, needs_rename, needs_name_confirm, skill_level")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) redirect("/");

  const decision = renamePageDecision(profile);
  if (decision.action === "bounce") redirect(dest);

  return (
    <RenameScreen
      mode={decision.action}
      currentName={decision.currentName}
      next={dest}
      currentSkill={profile.skill_level as SkillLevel}
    />
  );
}
