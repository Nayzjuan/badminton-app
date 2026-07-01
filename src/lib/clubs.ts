import "server-only";

// ============================================================
// Club data layer — server-only read helpers
// ============================================================
// Used by Server Components (the /c/[clubSlug] layout, club home, admin) and
// by the club Server Actions. All reads go through the service-role client:
// the club tables have RLS enabled with NO policies (deny-all to anon /
// authenticated), so only the service role can read them in Phase 0/1.
//
// Membership is keyed on profiles.id (= auth uid). Unlike sessions — which
// deliberately avoid created_by filtering because of anonymous multi-UUID
// users (see organizer/page.tsx) — club_members is reliable here: the
// reconnect/identity system (migrate_player_identity) preserves a returning
// player's profile id, so "my clubs" stays stable across reconnects.
// ============================================================

import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { createServiceClient } from "@/utils/supabase/service";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { isValidUUID } from "@/lib/validate";
import type { Club, ClubRole, Session } from "@/types/database";

/** Rank for sorting members: owners first, then admins, then members. */
function roleRank(role: ClubRole): number {
  return role === "owner" ? 0 : role === "admin" ? 1 : 2;
}

/**
 * Resolve a club by its URL slug. Wrapped in React `cache` so the
 * /c/[clubSlug] layout and the page beneath it share a single query per request.
 * Returns null on miss (callers `notFound()`).
 */
export const getClubBySlug = cache(async (slug: string): Promise<Club | null> => {
  const db = createServiceClient();
  const { data } = await db.from("clubs").select("*").eq("slug", slug).maybeSingle();
  return data ?? null;
});

export type MyClub = { club: Club; role: ClubRole; activeSessions: number };

/** Clubs the authenticated player actively belongs to, with role + active-session count. */
export async function getMyClubs(userId: string): Promise<MyClub[]> {
  const db = createServiceClient();

  const { data: memberships } = await db
    .from("club_members")
    .select("club_id, role")
    .eq("player_id", userId)
    .eq("is_active", true);

  if (!memberships || memberships.length === 0) return [];

  const roleByClub = new Map<string, ClubRole>(
    memberships.map((m) => [m.club_id, m.role as ClubRole])
  );

  const clubIds = Array.from(roleByClub.keys());

  const [{ data: clubs }, { data: activeSessions }] = await Promise.all([
    db.from("clubs").select("*").in("id", clubIds).eq("is_active", true),
    db.from("sessions").select("club_id").in("club_id", clubIds).eq("is_active", true),
  ]);

  const sessionCountByClub = new Map<string, number>();
  for (const { club_id } of activeSessions ?? []) {
    sessionCountByClub.set(club_id, (sessionCountByClub.get(club_id) ?? 0) + 1);
  }

  const result = (clubs ?? []).map((club) => ({
    club,
    role: roleByClub.get(club.id) as ClubRole,
    activeSessions: sessionCountByClub.get(club.id) ?? 0,
  }));

  return result.sort((a, b) => a.club.name.localeCompare(b.club.name));
}

/**
 * Club IDs the player is an active member of. Cheaper than getMyClubs when
 * only membership scoping is needed (no session counts / club rows).
 * Used to scope legacy cross-club listings (e.g. /play, /organizer session
 * pickers, all-time match history) to clubs the caller actually belongs to.
 *
 * Joins clubs!inner(is_active) so a deactivated club (same filter getMyClubs
 * applies) never counts as one of "my" clubs here either.
 */
export async function getMyActiveClubIds(userId: string): Promise<string[]> {
  const db = createServiceClient();
  const { data } = await db
    .from("club_members")
    .select("club_id, clubs!inner(is_active)")
    .eq("player_id", userId)
    .eq("is_active", true)
    .eq("clubs.is_active", true);
  return (data ?? []).map((m) => m.club_id);
}

/**
 * The player's role in a club, or null if not an active member.
 * Cached per-request: the /c/[clubSlug] layout and page both resolve role.
 */
export const getClubRole = cache(
  async (userId: string, clubId: string): Promise<ClubRole | null> => {
    const db = createServiceClient();
    const { data } = await db
      .from("club_members")
      .select("role")
      .eq("player_id", userId)
      .eq("club_id", clubId)
      .eq("is_active", true)
      .maybeSingle();
    return (data?.role as ClubRole) ?? null;
  }
);

/** True when the player is an active member of the club. */
export async function isClubMember(userId: string, clubId: string): Promise<boolean> {
  return (await getClubRole(userId, clubId)) !== null;
}

/** True when the player is an owner or admin of the club (implicit organizer). */
export async function isClubAdmin(userId: string, clubId: string): Promise<boolean> {
  const role = await getClubRole(userId, clubId);
  return role === "owner" || role === "admin";
}

export type ClubMemberRow = {
  id: string;
  player_id: string;
  role: ClubRole;
  display_name: string;
  joined_at: string;
  is_active: boolean;
};

/**
 * Members of a club with their display names, sorted active-first then by
 * role then name. Pass `includeInactive` to also return soft-removed
 * (is_active=false) rows — the admin roster needs these to offer "restore".
 */
export async function getClubMembers(
  clubId: string,
  opts?: { includeInactive?: boolean }
): Promise<ClubMemberRow[]> {
  const db = createServiceClient();

  let query = db
    .from("club_members")
    .select("id, player_id, role, joined_at, is_active")
    .eq("club_id", clubId);
  if (!opts?.includeInactive) query = query.eq("is_active", true);
  const { data: members } = await query;

  if (!members || members.length === 0) return [];

  const { data: profiles } = await db
    .from("profiles")
    .select("id, display_name")
    .in(
      "id",
      members.map((m) => m.player_id)
    );

  const nameById = new Map<string, string>((profiles ?? []).map((p) => [p.id, p.display_name]));

  return members
    .map((m) => ({
      id: m.id,
      player_id: m.player_id,
      role: m.role as ClubRole,
      joined_at: m.joined_at,
      is_active: m.is_active,
      display_name: nameById.get(m.player_id) ?? "Unknown player",
    }))
    .sort(
      (a, b) =>
        Number(b.is_active) - Number(a.is_active) ||
        roleRank(a.role) - roleRank(b.role) ||
        a.display_name.localeCompare(b.display_name)
    );
}

/** Count of active owners in a club — used to guard against a zero-owner club. */
export async function countActiveOwners(clubId: string): Promise<number> {
  const db = createServiceClient();
  const { count } = await db
    .from("club_members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .eq("role", "owner")
    .eq("is_active", true);
  return count ?? 0;
}

/** All sessions belonging to a club, newest first. */
export async function getClubSessions(clubId: string): Promise<Session[]> {
  const db = createServiceClient();
  const { data } = await db
    .from("sessions")
    .select("*")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false });
  return data ?? [];
}

/**
 * Route guard for member-only club routes. Resolves auth + club + membership
 * and short-circuits via redirect/notFound; returns the resolved trio on
 * success. Used by the /c/[clubSlug] gated route-group layouts.
 *   - unauthenticated → redirect("/")
 *   - unknown slug    → notFound()
 *   - non-member      → redirect("/clubs")
 */
export async function requireClubMembership(
  clubSlug: string
): Promise<{ userId: string; club: Club; role: ClubRole }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const role = await getClubRole(user.id, club.id);
  if (!role) redirect("/clubs");

  return { userId: user.id, club, role };
}

/**
 * Resolve a session's owning club slug (for the legacy → /c/[slug] redirect
 * shims). Service-role read — no auth needed, the redirect target enforces it.
 * Returns null if the session or its club can't be resolved.
 */
export async function resolveSessionClubSlug(sessionId: string): Promise<string | null> {
  if (!isValidUUID(sessionId)) return null;
  const db = createServiceClient();
  const { data: session } = await db
    .from("sessions")
    .select("club_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session?.club_id) return null;
  const { data: club } = await db
    .from("clubs")
    .select("slug")
    .eq("id", session.club_id)
    .maybeSingle();
  return club?.slug ?? null;
}

/**
 * Auto-enroll a player as an active member of the club (QR-join path).
 * Insert if missing · re-activate if soft-removed · no-op if already active —
 * never downgrades an existing owner/admin. Service-role write (bypasses RLS).
 * Returns true on success / already-member, false if the club can't be resolved.
 */
export async function ensureClubMembership(clubSlug: string, userId: string): Promise<boolean> {
  const club = await getClubBySlug(clubSlug);
  if (!club) return false;
  const db = createServiceClient();
  const { data: existing } = await db
    .from("club_members")
    .select("id, is_active")
    .eq("club_id", club.id)
    .eq("player_id", userId)
    .maybeSingle();
  if (!existing) {
    const { error } = await db
      .from("club_members")
      .insert({ club_id: club.id, player_id: userId, role: "member" });
    return !error;
  }
  if (!existing.is_active) {
    const { error } = await db
      .from("club_members")
      .update({ is_active: true })
      .eq("id", existing.id);
    return !error;
  }
  return true; // already an active member — keep their role
}
