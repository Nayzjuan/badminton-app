// ============================================================
// Organizer Dashboard Page — /organizer/[sessionId]
// ============================================================
// Server Component that authenticates the user, then hands off
// to the client-side OrganizerDashboard.
//
// Access model:
//   Any authenticated user can view the organizer dashboard UI.
//   All write operations (score input, court management, queue
//   changes) are protected at the DB layer via RLS policies that
//   check is_session_organizer(). The page itself does not gate
//   by ownership — doing so would break multi-device anonymous
//   auth where sessions may be owned by a different user UUID
//   than the current session.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { OrganizerDashboard } from "@/components/organizer/organizer-dashboard";
import { PUBLIC_PROFILE_COLUMNS, PUBLIC_SESSION_COLUMNS } from "@/types/database";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function OrganizerDashboardPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createServerSupabaseClient();

  // Must be authenticated.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Get profile. Neither this page nor the dashboard displays the caller's own
  // PIN, and the authenticated role can no longer select it (column lockdown).
  const { data: profileRow } = await supabase
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("id", user.id)
    .single();

  if (!profileRow) redirect("/");
  const profile = { ...profileRow, pin: null };

  // Fetch the session (active OR closed — closed sessions are viewable for history).
  // OrganizerDashboard doesn't display organizer_passcode → explicit column list.
  const { data: sessionRow } = await supabase
    .from("sessions")
    .select(PUBLIC_SESSION_COLUMNS)
    .eq("id", sessionId)
    .single();

  if (!sessionRow) notFound();
  const session = { ...sessionRow, organizer_passcode: null };

  // ── Other active sessions for the session switcher ─────────
  // Fetch ALL other active sessions — not filtered by ownership.
  // See the comment at the top of this file for why.
  const { data: otherSessionsData } = await supabase
    .from("sessions")
    .select(PUBLIC_SESSION_COLUMNS)
    .eq("is_active", true)
    .neq("id", sessionId)
    .order("created_at", { ascending: false });

  const otherSessions = (otherSessionsData ?? []).map((s) => ({
    ...s,
    organizer_passcode: null,
  }));

  return <OrganizerDashboard profile={profile} session={session} otherSessions={otherSessions} />;
}
