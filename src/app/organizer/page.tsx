// ============================================================
// Organizer Landing Page — /organizer
// ============================================================
// Dashboard hub: shows active sessions prominently, past
// (closed) sessions in a muted section, plus forms to create
// or join sessions.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { OrganizerEntry } from "@/components/organizer/organizer-entry";
import type { Session } from "@/types/database";

export type SessionWithStats = Session & {
  playerCount: number;
  courtCount: number;
  matchCount: number;
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

  // ── Fetch ALL sessions (active + closed) ──────────────────
  const { data: allSessions } = await supabase
    .from("sessions")
    .select("*")
    .order("created_at", { ascending: false });

  const activeSessions = (allSessions ?? []).filter((s) => s.is_active);
  const pastSessions = (allSessions ?? []).filter((s) => !s.is_active);

  // ── Enrich active sessions with live counts ───────────────
  const activeWithStats: SessionWithStats[] = await Promise.all(
    activeSessions.map(async (session) => {
      const [{ count: playerCount }, { count: courtCount }, { count: matchCount }] =
        await Promise.all([
          supabase
            .from("queue_entries")
            .select("id", { count: "exact", head: true })
            .eq("session_id", session.id)
            .in("status", ["waiting", "on_deck", "playing"]),
          supabase
            .from("courts")
            .select("id", { count: "exact", head: true })
            .eq("session_id", session.id)
            .neq("status", "closed"),
          supabase
            .from("matches")
            .select("id", { count: "exact", head: true })
            .eq("session_id", session.id)
            .eq("status", "completed"),
        ]);

      return {
        ...session,
        playerCount: playerCount ?? 0,
        courtCount: courtCount ?? 0,
        matchCount: matchCount ?? 0,
      };
    })
  );

  // ── Enrich past sessions with completed match count ───────
  const pastWithStats: SessionWithStats[] = await Promise.all(
    pastSessions.map(async (session) => {
      const { count: matchCount } = await supabase
        .from("matches")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session.id)
        .eq("status", "completed");

      return {
        ...session,
        playerCount: 0,
        courtCount: 0,
        matchCount: matchCount ?? 0,
      };
    })
  );

  return (
    <OrganizerEntry
      profile={profile}
      activeSessions={activeWithStats}
      pastSessions={pastWithStats}
    />
  );
}
