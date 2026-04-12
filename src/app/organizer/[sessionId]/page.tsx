// ============================================================
// Organizer Dashboard Page — /organizer/[sessionId]
// ============================================================
// Server Component that verifies organizer access, then hands
// off to the client-side OrganizerDashboard.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { OrganizerDashboard } from "@/components/organizer/organizer-dashboard";
import type { Session } from "@/types/database";

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

  // Verify the session exists and is active.
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("is_active", true)
    .single();

  if (!session) notFound();

  // ── Fetch other active sessions for the session switcher ───
  const { data: allSessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("is_active", true)
    .neq("id", sessionId)
    .order("created_at", { ascending: false });

  const otherSessions = allSessions ?? [];

  return (
    <OrganizerDashboard
      profile={profile}
      session={session}
      otherSessions={otherSessions}
    />
  );
}
