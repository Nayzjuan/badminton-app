// ============================================================
// Organizer Entry Page — /organizer
// ============================================================
// Lists active sessions the user organizes, or shows a form
// to create a new session / enter a passcode to join as organizer.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { OrganizerEntry } from "@/components/organizer/organizer-entry";

export default async function OrganizerPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/");

  // Get sessions where this user is an organizer.
  const { data: orgEntries } = await supabase
    .from("session_organizers")
    .select("session_id")
    .eq("user_id", user.id);

  const orgSessionIds = (orgEntries ?? []).map((e) => e.session_id);

  let organizedSessions: import("@/types/database").Session[] | null = [];
  if (orgSessionIds.length > 0) {
    const { data } = await supabase
      .from("sessions")
      .select("*")
      .in("id", orgSessionIds)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    organizedSessions = data;
  }

  // Auto-redirect if exactly one active organized session.
  if (organizedSessions && organizedSessions.length === 1) {
    redirect(`/organizer/${organizedSessions[0].id}`);
  }

  return (
    <OrganizerEntry
      profile={profile}
      organizedSessions={organizedSessions ?? []}
    />
  );
}
