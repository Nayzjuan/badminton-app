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
 * Request-scoped cached auth user. `auth.getUser()` revalidates the JWT against
 * the Auth server over HTTPS on EVERY call, so a layout + its page (+ nested
 * gate helpers) each paid a separate GoTrue round trip. React `cache()` dedupes
 * them to ONE validation per RSC render. Scope is a single render pass, so there
 * is no cross-request staleness. Server actions keep calling `getUser()`
 * directly (each action POST is its own request; caching there changes nothing).
 */
export const getRequestUser = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * Resolve a club by its URL slug. Wrapped in React `cache` so the
 * /c/[clubSlug] layout and the page beneath it share a single query per request.
 * Returns null on miss (callers `notFound()`).
 */
export const getClubBySlug = cache(async (slug: string): Promise<Club | null> => {
  const db = createServiceClient();
  const { data, error } = await db.from("clubs").select("*").eq("slug", slug).maybeSingle();
  // Distinguish a genuine miss (null → callers notFound()) from a transient DB
  // error (throw → nearest error.tsx offers a retry, not a misleading 404).
  if (error) throw new Error(`getClubBySlug(${slug}): ${error.message}`);
  return data ?? null;
});

export type MyClub = { club: Club; role: ClubRole; activeSessions: number };

/** Clubs the authenticated player actively belongs to, with role + active-session count. */
export async function getMyClubs(userId: string): Promise<MyClub[]> {
  const db = createServiceClient();

  const { data: memberships, error: mErr } = await db
    .from("club_members")
    .select("club_id, role")
    .eq("player_id", userId)
    .eq("is_active", true);
  if (mErr) throw new Error(`getMyClubs memberships: ${mErr.message}`);

  if (!memberships || memberships.length === 0) return [];

  const roleByClub = new Map<string, ClubRole>(
    memberships.map((m) => [m.club_id, m.role as ClubRole])
  );

  const clubIds = Array.from(roleByClub.keys());

  const [{ data: clubs, error: cErr }, { data: activeSessions, error: sErr }] = await Promise.all([
    db.from("clubs").select("*").in("id", clubIds).eq("is_active", true),
    db.from("sessions").select("club_id").in("club_id", clubIds).eq("is_active", true),
  ]);
  if (cErr) throw new Error(`getMyClubs clubs: ${cErr.message}`);
  if (sErr) throw new Error(`getMyClubs sessions: ${sErr.message}`);

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
  const { data, error } = await db
    .from("club_members")
    .select("club_id, clubs!inner(is_active)")
    .eq("player_id", userId)
    .eq("is_active", true)
    .eq("clubs.is_active", true);
  if (error) throw new Error(`getMyActiveClubIds: ${error.message}`);
  return (data ?? []).map((m) => m.club_id);
}

/**
 * The club a returning player should land in when they open the app cold (no
 * QR / no active session): the club of their MOST RECENTLY ATTENDED session,
 * falling back to their most recently JOINED active club, or `null` if they
 * belong to no club (→ the caller routes them to the join-via-QR screen).
 *
 * Resolved in one SECURITY-DEFINER RPC (get_primary_club_slug) so the ordering
 * by session recency happens in SQL, not across supabase-js foreign tables.
 */
export async function getPrimaryClubSlug(userId: string): Promise<string | null> {
  const db = createServiceClient();
  const { data, error } = await db.rpc("get_primary_club_slug", { p_user_id: userId });
  if (error) throw new Error(`getPrimaryClubSlug: ${error.message}`);
  return (data as string | null) ?? null;
}

/**
 * The player's role in a club, or null if not an active member.
 * Cached per-request: the /c/[clubSlug] layout and page both resolve role.
 */
export const getClubRole = cache(
  async (userId: string, clubId: string): Promise<ClubRole | null> => {
    const db = createServiceClient();
    const { data, error } = await db
      .from("club_members")
      .select("role")
      .eq("player_id", userId)
      .eq("club_id", clubId)
      .eq("is_active", true)
      .maybeSingle();
    // A transient error must NOT read as "not a member" — that would bounce a
    // real owner/member out of a gated route. Throw → error.tsx retry instead.
    if (error) throw new Error(`getClubRole: ${error.message}`);
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
  const { data: members, error: memErr } = await query;
  if (memErr) throw new Error(`getClubMembers: ${memErr.message}`);

  if (!members || members.length === 0) return [];

  const { data: profiles, error: profErr } = await db
    .from("profiles")
    .select("id, display_name")
    .in(
      "id",
      members.map((m) => m.player_id)
    );
  if (profErr) throw new Error(`getClubMembers profiles: ${profErr.message}`);

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

/** All sessions belonging to a club, newest first. */
export async function getClubSessions(clubId: string): Promise<Session[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("sessions")
    .select("*")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getClubSessions: ${error.message}`);
  return data ?? [];
}

/**
 * Route guard for member-only club routes. Resolves auth + club + membership
 * and short-circuits via redirect/notFound; returns the resolved trio on
 * success. Used by the /c/[clubSlug] gated route-group layouts.
 *   - unauthenticated → redirect("/")
 *   - unknown slug    → notFound()
 *   - non-member      → redirect("/play")  (their own club context, not the
 *                       platform-owner-only /clubs hub)
 */
export async function requireClubMembership(
  clubSlug: string
): Promise<{ userId: string; club: Club; role: ClubRole }> {
  const user = await getRequestUser();
  if (!user) redirect("/");

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const role = await getClubRole(user.id, club.id);
  // Not a member of THIS club → send them to their own player context (/play
  // resolves their primary club, or the join-via-QR screen). Not /clubs — that
  // is the platform-owner-only hub.
  if (!role) redirect("/play");

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
  // One embedded round trip (was sessions → clubs, two serial hops). Runs on
  // every push send + the legacy redirect shims + reconnect.
  const { data, error } = await db
    .from("sessions")
    .select("club_id, clubs(slug)")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`resolveSessionClubSlug: ${error.message}`);
  if (!data?.club_id) return null;
  const club = data.clubs as unknown as { slug: string } | null;
  return club?.slug ?? null;
}

/**
 * Result of an auto-enroll attempt.
 *   ok     — the caller is an active member afterwards (or already was).
 *   joined — a NEW membership was created, or a soft-removed one reactivated,
 *            by THIS call (i.e. their membership actually changed). false when
 *            they were already an active member. Drives the one-time
 *            "Welcome to X" confirmation on the QR-join path.
 */
export type EnsureClubMembershipResult = { ok: boolean; joined: boolean };

/**
 * Auto-enroll a player as an active member of the club (QR-join path).
 * Insert if missing · re-activate if soft-removed · no-op if already active —
 * never downgrades an existing owner/admin. Service-role write (bypasses RLS).
 * ok=false only when the club can't be resolved or the membership write fails.
 */
export async function ensureClubMembership(
  clubSlug: string,
  userId: string
): Promise<EnsureClubMembershipResult> {
  const club = await getClubBySlug(clubSlug);
  if (!club) return { ok: false, joined: false };
  const db = createServiceClient();
  const { data: existing, error: readErr } = await db
    .from("club_members")
    .select("id, is_active")
    .eq("club_id", club.id)
    .eq("player_id", userId)
    .maybeSingle();
  // Called fire-and-forget from redirect flows (route handlers / server
  // actions), so report failure via ok=false rather than throwing — a throw
  // would abort the enclosing redirect. The QR-join guard turns ok=false into
  // a safe /clubs fallback.
  if (readErr) return { ok: false, joined: false };
  if (!existing) {
    const { error } = await db
      .from("club_members")
      .insert({ club_id: club.id, player_id: userId, role: "member" });
    return { ok: !error, joined: !error };
  }
  if (!existing.is_active) {
    const { error } = await db
      .from("club_members")
      .update({ is_active: true })
      .eq("id", existing.id);
    return { ok: !error, joined: !error };
  }
  return { ok: true, joined: false }; // already an active member — keep their role
}
