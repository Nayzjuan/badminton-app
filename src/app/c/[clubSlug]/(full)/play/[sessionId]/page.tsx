// ============================================================
// Club Player Dashboard — /c/[clubSlug]/play/[sessionId]
// ============================================================
// Club-scoped version of /play/[sessionId]. Membership is enforced by the
// (full) layout. Cross-checks the session belongs to this club, and routes
// the rename-gate / ended-session redirects to club-scoped paths.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { enforceRenameGate } from "@/lib/rename-gate";
import { getClubBySlug, getRequestUser } from "@/lib/clubs";
import { clubPlay, clubBase, clubWrapped } from "@/lib/club-paths";
import { PlayerDashboard } from "@/components/player/player-dashboard";
import { PUBLIC_SESSION_COLUMNS } from "@/types/database";

interface PageProps {
  params: Promise<{ clubSlug: string; sessionId: string }>;
}

export default async function ClubPlayerDashboardPage({ params }: PageProps) {
  const { clubSlug, sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  // Deduped with the (full) layout's requireClubMembership() getUser via cache().
  const user = await getRequestUser();
  if (!user) redirect("/");

  const hasGoogleLinked = user.identities?.some((id) => id.provider === "google") ?? false;

  // Service client — PlayerDashboard displays the player's OWN pin (reconnect
  // reminder), and the browser client's column privilege on profiles no
  // longer includes it (20260701000010_column_lockdown_fix_table_grants.sql).
  // Already scoped to this exact authenticated user.id, so this is the
  // sanctioned service-role-for-PINs use case (CLAUDE.md §Database Strictness).
  const db = createServiceClient();
  const { data: profile } = await db.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) redirect("/");

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  // player-dashboard.tsx never displays organizer_passcode — explicit column list.
  const { data: sessionRow } = await supabase
    .from("sessions")
    .select(PUBLIC_SESSION_COLUMNS)
    .eq("id", sessionId)
    .single();
  if (!sessionRow) notFound();
  if (sessionRow.club_id !== club.id) notFound(); // session belongs to another club
  const session = { ...sessionRow, organizer_passcode: null };

  // Duplicate-name gate (L1) — run AFTER confirming the session exists AND
  // belongs to this club, so the post-rename return to clubPlay(...) can never
  // land on a guaranteed notFound() (a hand-crafted /c/club-a/play/<club-b-id>).
  await enforceRenameGate(profile, clubPlay(clubSlug, sessionId));

  // Session ended → Wrapped (unless there is nothing to show, or the intro was
  // already dismissed → club lobby).
  if (!session.is_active) {
    const { data: wrappedStats } = await supabase
      .from("session_wrapped_stats")
      .select("intro_dismissed_at")
      .eq("session_id", sessionId)
      .eq("player_id", user.id)
      .maybeSingle();

    // No row at all → the lobby. compute_session_wrapped builds its rows from
    // completed matches, so anyone who never finished one has none: walk-ins,
    // late arrivals, and the organizer who only ran the board. Falling through
    // to Wrapped would render them an all-zero recap — and this branch now runs
    // far more often than it used to, because the close watcher calls
    // router.refresh() the moment the session ends. Without this the watcher's
    // own carefully-probed push to the lobby loses: the server redirect
    // unmounts the dashboard first, which cancels it.
    if (!wrappedStats) {
      redirect(clubBase(clubSlug));
    }

    if (wrappedStats.intro_dismissed_at) {
      redirect(clubBase(clubSlug));
    }
    // Club-namespaced Wrapped variant (mirrors the TV board's dual-path
    // pattern: root stays the public/shareable link, this is for in-app nav).
    redirect(clubWrapped(clubSlug, sessionId, user.id));
  }

  return <PlayerDashboard profile={profile} session={session} hasGoogleLinked={hasGoogleLinked} />;
}
