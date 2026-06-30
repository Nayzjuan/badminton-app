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

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) redirect("/");

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (!session) notFound();
  if (session.club_id !== club.id) notFound(); // session belongs to another club

  // Session switcher — only OTHER active sessions in THIS club (slug stays put).
  const { data: otherSessionsData } = await supabase
    .from("sessions")
    .select("*")
    .eq("is_active", true)
    .eq("club_id", club.id)
    .neq("id", sessionId)
    .order("created_at", { ascending: false });

  const otherSessions = otherSessionsData ?? [];

  return <OrganizerDashboard profile={profile} session={session} otherSessions={otherSessions} />;
}
