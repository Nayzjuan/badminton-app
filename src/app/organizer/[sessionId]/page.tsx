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

  // ── Fetch sibling sessions for the session switcher ────────
  const { data: orgEntries } = await supabase
    .from("session_organizers")
    .select("session_id")
    .eq("user_id", user.id);

  const orgSessionIds = (orgEntries ?? []).map((e) => e.session_id);

  const { data: createdSessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("created_by", user.id)
    .eq("is_active", true);

  let orgSessions: Session[] = [];
  if (orgSessionIds.length > 0) {
    const { data } = await supabase
      .from("sessions")
      .select("*")
      .in("id", orgSessionIds)
      .eq("is_active", true);
    orgSessions = data ?? [];
  }

  const sessionMap = new Map<string, Session>();
  for (const s of [...(createdSessions ?? []), ...orgSessions]) {
    sessionMap.set(s.id, s);
  }
  // Remove current session — we only need "other" sessions for the switcher.
  sessionMap.delete(sessionId);
  const otherSessions = Array.from(sessionMap.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <OrganizerDashboard
      profile={profile}
      session={session}
      otherSessions={otherSessions}
    />
  );
}
