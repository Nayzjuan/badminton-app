// ============================================================
// Organizer Landing Page — /organizer
// ============================================================
// Shows ALL sessions (active + past) for any authenticated user.
//
// Why no user-ownership filter:
//   This app uses anonymous Supabase auth — each new browser session
//   produces a different user UUID. A single physical organizer can
//   accumulate sessions under several user IDs. Filtering by
//   created_by / session_organizers would hide those sessions.
//   The sessions_select RLS policy intentionally allows all
//   authenticated users to read all sessions, so this is safe.
//
// Routing logic (server-side):
//   1+ active sessions → render session picker + demoted create/join
//   0 active sessions  → render create + join forms prominently
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

  // ── 1. Fetch ALL sessions (active + closed) ───────────────
  const { data: allSessionsData } = await supabase
    .from("sessions")
    .select("*")
    .order("created_at", { ascending: false });

  const allSessions = allSessionsData ?? [];
  const activeSessions = allSessions.filter((s) => s.is_active);
  const pastSessions = allSessions.filter((s) => !s.is_active);

  // ── 2. Enrich active sessions with live counts ─────────────
  // No auto-redirect for single sessions — always render the picker so
  // the "All Sessions" back button always lands somewhere meaningful.
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

  // ── 3. Enrich past sessions with completed match count ──────
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
