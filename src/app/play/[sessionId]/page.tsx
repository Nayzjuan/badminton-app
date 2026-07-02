// ============================================================
// Player Dashboard Page — /play/[sessionId]
// ============================================================
// Server Component that fetches profile + session, then hands
// off to the client-side PlayerDashboard with real-time hooks.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { enforceRenameGate } from "@/lib/rename-gate";
import { PlayerDashboard } from "@/components/player/player-dashboard";
import { createServiceClient } from "@/utils/supabase/service";
import { PUBLIC_SESSION_COLUMNS } from "@/types/database";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function PlayerDashboardPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  // Must be authenticated.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Determine whether this user already has a Google identity linked so the
  // dashboard can conditionally show upgrade prompts.
  const hasGoogleLinked = user.identities?.some((id) => id.provider === "google") ?? false;

  // Get profile via the service client: PlayerDashboard shows the player their
  // own reconnect PIN, and the authenticated role can no longer read
  // profiles.pin (column lockdown). Scoped to the caller's own id.
  const service = createServiceClient();
  const { data: profile } = await service.from("profiles").select("*").eq("id", user.id).single();

  if (!profile) redirect("/");

  // Duplicate-name gate (L1): route flagged duplicates to /rename first.
  await enforceRenameGate(profile, `/play/${sessionId}`);

  // Get session — do NOT filter by is_active so closed sessions don't 404.
  // PlayerDashboard never displays organizer_passcode → explicit column list.
  const { data: sessionRow } = await supabase
    .from("sessions")
    .select(PUBLIC_SESSION_COLUMNS)
    .eq("id", sessionId)
    .single();

  if (!sessionRow) notFound();
  const session = { ...sessionRow, organizer_passcode: null };

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

  return <PlayerDashboard profile={profile} session={session} hasGoogleLinked={hasGoogleLinked} />;
}
