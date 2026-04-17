// ============================================================
// Organizer Landing Page — /organizer
// ============================================================
// Auto-discovery: shows only sessions this user owns or co-organizes.
//
// Routing logic (server-side):
//   1 active session  → redirect directly into the dashboard
//   2+ active sessions → render session picker + demoted create/join
//   0 active sessions  → render create + join forms
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

  // ── 1. Sessions where user is the primary organizer ────────
  const { data: ownedSessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false });

  // ── 2. Sessions where user is a co-organizer ───────────────
  const { data: memberships } = await supabase
    .from("session_organizers")
    .select("session_id")
    .eq("user_id", user.id);

  const coOrgSessionIds = (memberships ?? []).map((m) => m.session_id);

  let coOrgSessions: Session[] = [];
  if (coOrgSessionIds.length > 0) {
    const { data } = await supabase
      .from("sessions")
      .select("*")
      .in("id", coOrgSessionIds)
      .order("created_at", { ascending: false });
    coOrgSessions = data ?? [];
  }

  // ── 3. Merge + deduplicate (owned takes precedence) ────────
  const ownedIds = new Set((ownedSessions ?? []).map((s) => s.id));
  const allSessions = [
    ...(ownedSessions ?? []),
    ...coOrgSessions.filter((s) => !ownedIds.has(s.id)),
  ].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const activeSessions = allSessions.filter((s) => s.is_active);
  const pastSessions = allSessions.filter((s) => !s.is_active);

  // ── 4. Auto-redirect when there is exactly one active session
  if (activeSessions.length === 1) {
    redirect(`/organizer/${activeSessions[0].id}`);
  }

  // ── 5. Enrich active sessions with live counts ─────────────
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

  // ── 6. Enrich past sessions with completed match count ──────
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
