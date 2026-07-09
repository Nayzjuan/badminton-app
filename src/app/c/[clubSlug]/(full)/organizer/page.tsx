// ============================================================
// Club Organizer Hub — /c/[clubSlug]/organizer
// ============================================================
// Club-scoped version of the legacy /organizer landing. Membership is enforced
// by the (full) layout (requireClubMembership); this page additionally scopes
// every session query to THIS club, so the hub only ever lists / creates
// sessions for the club in the URL. Renders the same OrganizerEntry hub.
// ============================================================

import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { getClubBySlug } from "@/lib/clubs";
import { OrganizerEntry, type SessionWithStats } from "@/components/organizer/organizer-entry";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

interface PageProps {
  params: Promise<{ clubSlug: string }>;
}

export default async function ClubOrganizerHubPage({ params }: PageProps) {
  const { clubSlug } = await params;
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profileRow } = await supabase
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("id", user.id)
    .single();
  if (!profileRow) redirect("/");
  const profile = { ...profileRow, pin: null };

  // The (full) layout already ran requireClubMembership; resolve the club row
  // here for its id (notFound is defensive — the layout would have 404'd first).
  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  // ── Fetch this club's sessions (active + closed) ──────────────
  // Service client — OrganizerEntry shows each active session's
  // organizer_passcode, and the browser/anon client's column privilege on
  // sessions no longer includes it. Scoped to this one club_id, so the
  // service-role read is the sanctioned secrets use case (CLAUDE.md).
  const db = createServiceClient();
  const allSessions =
    (
      await db
        .from("sessions")
        .select("*")
        .eq("club_id", club.id)
        .order("created_at", { ascending: false })
    ).data ?? [];
  const activeSessions = allSessions.filter((s) => s.is_active);
  const pastSessions = allSessions.filter((s) => !s.is_active);

  // ── Enrich active sessions with live counts ───────────────────
  const activeWithStats: SessionWithStats[] = await Promise.all(
    activeSessions.map(async (session) => {
      const [{ count: playerCount }, { count: courtCount }, { count: matchCount }] =
        await Promise.all([
          supabase
            .from("queue_entries")
            .select("id", { count: "exact", head: true })
            .eq("session_id", session.id)
            .in("status", ["waiting", "drafted", "on_deck", "playing"]),
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

  // ── Enrich past sessions with completed match count ───────────
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

  // Unambiguous: creation attaches to THIS club (the one in the URL).
  return (
    <OrganizerEntry
      profile={profile}
      activeSessions={activeWithStats}
      pastSessions={pastWithStats}
      soloClubId={club.id}
    />
  );
}
