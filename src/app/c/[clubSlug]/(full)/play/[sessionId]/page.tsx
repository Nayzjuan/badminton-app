// ============================================================
// Club Player Dashboard — /c/[clubSlug]/play/[sessionId]
// ============================================================
// Club-scoped version of /play/[sessionId]. Membership is enforced by the
// (full) layout. Cross-checks the session belongs to this club, and routes
// the rename-gate / ended-session redirects to club-scoped paths.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { enforceRenameGate } from "@/lib/rename-gate";
import { getClubBySlug } from "@/lib/clubs";
import { clubPlay, clubBase, clubWrapped } from "@/lib/club-paths";
import { PlayerDashboard } from "@/components/player/player-dashboard";

interface PageProps {
  params: Promise<{ clubSlug: string; sessionId: string }>;
}

export default async function ClubPlayerDashboardPage({ params }: PageProps) {
  const { clubSlug, sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const hasGoogleLinked = user.identities?.some((id) => id.provider === "google") ?? false;

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) redirect("/");

  // Duplicate-name gate (L1) — return to the club-scoped player path after rename.
  await enforceRenameGate(profile, clubPlay(clubSlug, sessionId));

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (!session) notFound();
  if (session.club_id !== club.id) notFound(); // session belongs to another club

  // Session ended → Wrapped (unless the intro was already dismissed → club lobby).
  if (!session.is_active) {
    const { data: wrappedStats } = await supabase
      .from("session_wrapped_stats")
      .select("intro_dismissed_at")
      .eq("session_id", sessionId)
      .eq("player_id", user.id)
      .maybeSingle();

    if (wrappedStats?.intro_dismissed_at) {
      redirect(clubBase(clubSlug));
    }
    redirect(clubWrapped(clubSlug, sessionId, user.id));
  }

  return <PlayerDashboard profile={profile} session={session} hasGoogleLinked={hasGoogleLinked} />;
}
