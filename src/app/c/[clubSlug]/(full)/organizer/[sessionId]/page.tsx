// ============================================================
// Club Organizer Dashboard — /c/[clubSlug]/organizer/[sessionId]
// ============================================================
// Club-scoped version of /organizer/[sessionId]. Membership is enforced by
// the (full) layout. This page additionally:
//   - cross-checks the session belongs to THIS club (404 otherwise), and
//   - scopes the session switcher to the SAME club (blueprint §3.4).
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getClubBySlug } from "@/lib/clubs";
import { OrganizerDashboard } from "@/components/organizer/organizer-dashboard";
import { PUBLIC_PROFILE_COLUMNS, PUBLIC_SESSION_COLUMNS } from "@/types/database";

interface PageProps {
  params: Promise<{ clubSlug: string; sessionId: string }>;
}

export default async function ClubOrganizerDashboardPage({ params }: PageProps) {
  const { clubSlug, sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Explicit column lists — OrganizerDashboard never displays this player's
  // own PIN or any session's organizer_passcode, and the browser client's
  // column privilege on profiles/sessions no longer includes them
  // (20260701000010_column_lockdown_fix_table_grants.sql).
  const { data: profileRow } = await supabase
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("id", user.id)
    .single();
  if (!profileRow) redirect("/");
  const profile = { ...profileRow, pin: null };

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const { data: sessionRow } = await supabase
    .from("sessions")
    .select(PUBLIC_SESSION_COLUMNS)
    .eq("id", sessionId)
    .single();
  if (!sessionRow) notFound();
  if (sessionRow.club_id !== club.id) notFound(); // session belongs to another club
  const session = { ...sessionRow, organizer_passcode: null };

  // Session switcher — only OTHER active sessions in THIS club (slug stays put).
  const { data: otherSessionsData } = await supabase
    .from("sessions")
    .select(PUBLIC_SESSION_COLUMNS)
    .eq("is_active", true)
    .eq("club_id", club.id)
    .neq("id", sessionId)
    .order("created_at", { ascending: false });

  const otherSessions = (otherSessionsData ?? []).map((s) => ({ ...s, organizer_passcode: null }));

  return <OrganizerDashboard profile={profile} session={session} otherSessions={otherSessions} />;
}
