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

  // ── Fetch ALL active sessions ───────────────────────────────
  // Any organizer can see and manage any active session.
  // This avoids confusion with anonymous auth identities where
  // each browser window creates a different user.
  const { data: allSessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const organizedSessions = allSessions ?? [];

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
