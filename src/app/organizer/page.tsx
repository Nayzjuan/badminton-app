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
// Club scoping: sessions ARE filtered by club_id (clubs the caller is an
// active member of). Without this, any authenticated user would see every
// other club's session names + live stats — the anonymous-auth reasoning
// above only justifies skipping the created_by filter, not skipping
// multi-tenant isolation.
//
// Routing logic (server-side):
//   1+ active sessions → render session picker + demoted create/join
//   0 active sessions  → render create + join forms prominently
// ============================================================

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { getMyActiveClubIds } from "@/lib/clubs";
import { OrganizerEntry } from "@/components/organizer/organizer-entry";
import type { Session } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

export type SessionWithStats = Session & {
  playerCount: number;
  courtCount: number;
  matchCount: number;
};

export default async function OrganizerPage() {
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

  // ── 1. Fetch ALL sessions (active + closed) — scoped to the caller's clubs
  const clubIds = await getMyActiveClubIds(user.id);

  // Service client — OrganizerEntry displays each active session's
  // organizer_passcode (for the organizer to read aloud to co-organizers),
  // and the browser/anon-key client's column privilege on sessions no
  // longer includes that column (20260701000010_column_lockdown_fix_table_grants.sql).
  // club_id/user scoping above is already verified, so this is the sanctioned
  // service-role-for-secrets use case (CLAUDE.md §Database Strictness).
  const db = createServiceClient();
  const allSessions =
    clubIds.length === 0
      ? []
      : ((
          await db
            .from("sessions")
            .select("*")
            .in("club_id", clubIds)
            .order("created_at", { ascending: false })
        ).data ?? []);
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

  // createSession() defaults to the default club (CHILLAX) when no clubId is
  // passed — fine when the caller belongs to exactly one club (unambiguous), wrong
  // for 0 or 2+ (would silently misattribute the new session). Only thread
  // a clubId through in the unambiguous case; OrganizerEntry disables
  // creation otherwise and points multi-club organizers at a specific
  // club's admin page instead.
  const soloClubId = clubIds.length === 1 ? clubIds[0] : null;

  return (
    <OrganizerEntry
      profile={profile}
      activeSessions={activeWithStats}
      pastSessions={pastWithStats}
      soloClubId={soloClubId}
    />
  );
}
