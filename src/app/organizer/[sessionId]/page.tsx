// ============================================================
// Organizer Dashboard Page — /organizer/[sessionId]
// ============================================================
// Server Component that verifies organizer access, then hands
// off to the client-side OrganizerDashboard.
//
// Auth model (stateless — no session-code cookie):
//   Authorized if: sessions.created_by == user.id
//             OR   session_organizers row exists for (session_id, user_id)
//
// Unauthorized users are redirected to /organizer.
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

  // Fetch the session (active OR closed — closed sessions are viewable for history).
  const { data: session } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (!session) notFound();

  // ── Stateless organizer authorization ──────────────────────
  // Check 1: primary organizer (fast path).
  const isPrimaryOrganizer = session.created_by === user.id;

  // Check 2: co-organizer membership row.
  let isCoOrganizer = false;
  if (!isPrimaryOrganizer) {
    const { data: membership } = await supabase
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    isCoOrganizer = !!membership;
  }

  if (!isPrimaryOrganizer && !isCoOrganizer) {
    // Not authorized — send them back to the organizer hub.
    redirect("/organizer");
  }

  // ── Other active sessions for the session switcher ─────────
  // Only include sessions this user actually organizes (owned + co-org).
  const { data: ownedOthers } = await supabase
    .from("sessions")
    .select("*")
    .eq("created_by", user.id)
    .eq("is_active", true)
    .neq("id", sessionId)
    .order("created_at", { ascending: false });

  const { data: coOrgMemberships } = await supabase
    .from("session_organizers")
    .select("session_id")
    .eq("user_id", user.id);

  const coOrgIds = (coOrgMemberships ?? [])
    .map((m) => m.session_id)
    .filter((id) => id !== sessionId);

  let coOrgOthers: Session[] = [];
  if (coOrgIds.length > 0) {
    const { data } = await supabase
      .from("sessions")
      .select("*")
      .in("id", coOrgIds)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    coOrgOthers = data ?? [];
  }

  const ownedOtherIds = new Set((ownedOthers ?? []).map((s) => s.id));
  const otherSessions: Session[] = [
    ...(ownedOthers ?? []),
    ...coOrgOthers.filter((s) => !ownedOtherIds.has(s.id)),
  ];

  return (
    <OrganizerDashboard
      profile={profile}
      session={session}
      otherSessions={otherSessions}
    />
  );
}
