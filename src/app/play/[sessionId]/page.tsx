// ============================================================
// Player Dashboard Page — /play/[sessionId]
// ============================================================
// Server Component that fetches profile + session, then hands
// off to the client-side PlayerDashboard with real-time hooks.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { PlayerDashboard } from "@/components/player/player-dashboard";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function PlayerDashboardPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createClient();

  // Must be authenticated.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Get profile.
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/");

  // Get session — do NOT filter by is_active so closed sessions don't 404.
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (!session) notFound();

  // Session has ended — send the player to their Wrapped page,
  // but only if they haven't already dismissed the intro.
  // Once dismissed, /play is the correct landing page (no spam).
  if (!session.is_active) {
    const { data: wrappedStats } = await supabase
      .from("session_wrapped_stats")
      .select("intro_dismissed_at")
      .eq("session_id", sessionId)
      .eq("player_id", user.id)
      .maybeSingle();

    if (wrappedStats?.intro_dismissed_at) {
      // Already seen and dismissed — don't redirect back to Wrapped.
      redirect("/play");
    }

    redirect(`/wrapped/${sessionId}/${user.id}`);
  }

  return <PlayerDashboard profile={profile} session={session} />;
}
