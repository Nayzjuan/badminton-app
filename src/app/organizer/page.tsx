// ============================================================
// Organizer Landing Page — /organizer
// ============================================================
// Dashboard hub: shows the user's active sessions, a form to
// create a new one, and a co-organizer join panel.
//
// If the user has exactly one active session, we auto-redirect
// to it so they don't waste a click.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { OrganizerEntry } from "@/components/organizer/organizer-entry";
import type { Session } from "@/types/database";

export type SessionWithStats = Session & {
  playerCount: number;
  courtCount: number;
};

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

  // ── Fetch sessions this user organizes ─────────────────────
  // Check both session_organizers table AND sessions.created_by
  // to cover cases where the trigger didn't fire or the user is
  // on a different anonymous auth identity.
  const { data: orgEntries } = await supabase
    .from("session_organizers")
    .select("session_id")
    .eq("user_id", user.id);

  const orgSessionIds = (orgEntries ?? []).map((e) => e.session_id);

  // Also fetch sessions the user directly created.
  const { data: createdSessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("created_by", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  // Fetch sessions from session_organizers if any.
  let orgSessions: Session[] = [];
  if (orgSessionIds.length > 0) {
    const { data } = await supabase
      .from("sessions")
      .select("*")
      .in("id", orgSessionIds)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    orgSessions = data ?? [];
  }

  // Merge and deduplicate by session ID.
  const sessionMap = new Map<string, Session>();
  for (const s of [...(createdSessions ?? []), ...orgSessions]) {
    sessionMap.set(s.id, s);
  }
  const organizedSessions = Array.from(sessionMap.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Note: we no longer auto-redirect for a single session.
  // The organizer should always be able to see the hub to create
  // new sessions or switch between existing ones.

  // ── Enrich sessions with player + court counts ─────────────
  const sessionsWithStats: SessionWithStats[] = await Promise.all(
    organizedSessions.map(async (session) => {
      const { count: playerCount } = await supabase
        .from("queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session.id)
        .in("status", ["waiting", "on_deck", "playing"]);

      const { count: courtCount } = await supabase
        .from("courts")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session.id)
        .neq("status", "closed");

      return {
        ...session,
        playerCount: playerCount ?? 0,
        courtCount: courtCount ?? 0,
      };
    })
  );

  return (
    <OrganizerEntry
      profile={profile}
      organizedSessions={sessionsWithStats}
    />
  );
}
