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
import { getClubBySlug, getRequestUser } from "@/lib/clubs";
import { OrganizerEntry, type SessionWithStats } from "@/components/organizer/organizer-entry";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

interface PageProps {
  params: Promise<{ clubSlug: string }>;
}

export default async function ClubOrganizerHubPage({ params }: PageProps) {
  const { clubSlug } = await params;
  const supabase = await createServerSupabaseClient();

  // Deduped with the (full) layout's requireClubMembership() getUser via cache().
  const user = await getRequestUser();
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
        // Infrastructure sessions (the E2E sandbox) are never listed: this one
        // rendered at the TOP of the active list with its organizer_passcode
        // on show, which is why its name had to say "DO NOT JOIN".
        .eq("is_hidden", false)
        .order("created_at", { ascending: false })
    ).data ?? [];
  const activeSessions = allSessions.filter((s) => s.is_active);
  const pastSessions = allSessions.filter((s) => !s.is_active);

  // ── Enrich sessions with live counts ──────────────────────────
  // Was one count query per session (queue + courts + matches for each active
  // session, matches for each past session) — up to ~200 round trips on a club
  // with many past sessions. Replaced with 3 bulk fetches grouped in memory.
  // Same user-context client + filters, so per-row RLS scoping is unchanged.
  const activeIds = activeSessions.map((s) => s.id);
  const allIds = allSessions.map((s) => s.id);

  const countBy = <T extends { session_id: string }>(rows: T[] | null): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.session_id, (m.get(r.session_id) ?? 0) + 1);
    return m;
  };

  const [completedCounts, queueRows, courtRows] = await Promise.all([
    // Completed matches are unbounded over a club's lifetime, so count them with
    // a GROUP BY RPC — the payload is one row PER SESSION (cap-safe at any
    // history size), not one row per match. queue/courts are active-session
    // scoped and naturally small, so a plain row fetch + JS group is fine there.
    allIds.length
      ? supabase.rpc("count_completed_matches_by_session", { p_session_ids: allIds })
      : Promise.resolve({ data: [] as { session_id: string; cnt: number }[] }),
    activeIds.length
      ? supabase
          .from("queue_entries")
          .select("session_id")
          .in("session_id", activeIds)
          .in("status", ["waiting", "drafted", "on_deck", "playing"])
      : Promise.resolve({ data: [] as { session_id: string }[] }),
    activeIds.length
      ? supabase
          .from("courts")
          .select("session_id")
          .in("session_id", activeIds)
          .neq("status", "closed")
      : Promise.resolve({ data: [] as { session_id: string }[] }),
  ]);

  const matchCounts = new Map<string, number>(
    (completedCounts.data ?? []).map((r) => [r.session_id, Number(r.cnt)])
  );
  const playerCounts = countBy(queueRows.data);
  const courtCounts = countBy(courtRows.data);

  const activeWithStats: SessionWithStats[] = activeSessions.map((session) => ({
    ...session,
    playerCount: playerCounts.get(session.id) ?? 0,
    courtCount: courtCounts.get(session.id) ?? 0,
    matchCount: matchCounts.get(session.id) ?? 0,
  }));

  const pastWithStats: SessionWithStats[] = pastSessions.map((session) => ({
    ...session,
    playerCount: 0,
    courtCount: 0,
    matchCount: matchCounts.get(session.id) ?? 0,
  }));

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
