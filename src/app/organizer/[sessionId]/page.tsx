// ============================================================
// Organizer Dashboard Page — /organizer/[sessionId]
// ============================================================
// Server Component that verifies organizer access, then hands
// off to the client-side OrganizerDashboard.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { OrganizerDashboard } from "@/components/organizer/organizer-dashboard";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function OrganizerDashboardPage({ params }: PageProps) {
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

  // Verify this user is an organizer for this session.
  // Check both session_organizers AND sessions.created_by.
  const { data: orgEntry } = await supabase
    .from("session_organizers")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("is_active", true)
    .single();

  if (!session) notFound();

  const isOrganizer = !!orgEntry || session.created_by === user.id;
  if (!isOrganizer) {
    redirect("/organizer");
  }

  return <OrganizerDashboard profile={profile} session={session} />;
}
