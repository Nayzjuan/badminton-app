"use server";

// ============================================================
// Club Registration — Server Actions (Phase 1)
// ============================================================
// createClub        — create a club + owner membership (atomic-ish)
// createClubInvite  — admin generates a one-time invite token
// acceptClubInvite  — a player redeems a token to join the club
//
// Reads live in src/lib/clubs.ts (server-only). These mutations use the
// service-role client because the club tables are RLS deny-all in Phase 1.
// Standard return shape: { success, message, ... }.
// ============================================================

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser } from "@/app/actions/_shared";
import { isClubAdmin, getClubRole, countActiveOwners } from "@/lib/clubs";
import { isValidUUID } from "@/lib/validate";
import { slugifyClubName, isValidClubSlug } from "@/lib/club-slug";
import type { ClubRole } from "@/types/database";

// ── createClub ────────────────────────────────────────────────

export type CreateClubResult = { success: boolean; message: string; slug?: string };

/**
 * Creates a club owned by the authenticated user and an `owner` membership row.
 * PostgREST has no multi-statement transaction, so the club is inserted first
 * and the membership second; if the membership fails the club is rolled back
 * (best-effort delete) so no ownerless club is left behind.
 */
export async function createClub(opts: { name: string; slug?: string }): Promise<CreateClubResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const name = opts.name.trim();
  if (!name) return { success: false, message: "Club name is required." };
  if (name.length > 60)
    return { success: false, message: "Club name must be 60 characters or less." };

  const slug = opts.slug?.trim() ? opts.slug.trim().toLowerCase() : slugifyClubName(name);
  if (!isValidClubSlug(slug)) {
    return {
      success: false,
      message:
        "Slug must be 3–50 characters: lowercase letters, numbers, and single hyphens (no spaces).",
    };
  }

  const db = createServiceClient();

  const { data: club, error: clubErr } = await db
    .from("clubs")
    .insert({ name, slug, created_by: user.id })
    .select("id, slug")
    .single();

  if (clubErr || !club) {
    // 23505 = unique_violation on clubs.slug
    if (clubErr?.code === "23505") {
      return { success: false, message: "That address is already taken — pick a different slug." };
    }
    // Don't leak the raw Postgres message to the client (info-leak + the CHECK
    // path is already unreachable thanks to pre-validation).
    console.error("createClub: club insert failed:", clubErr);
    return { success: false, message: "Failed to create club. Please try again." };
  }

  const { error: memberErr } = await db
    .from("club_members")
    .insert({ club_id: club.id, player_id: user.id, role: "owner" });

  if (memberErr) {
    // Best-effort rollback so no ownerless club lingers. If the delete itself
    // fails the club is inert (no members → invisible everywhere) but squats the
    // slug — log it so an operator can reclaim it.
    const { error: rollbackErr } = await db.from("clubs").delete().eq("id", club.id);
    if (rollbackErr) {
      console.error(`createClub: rollback of orphan club ${club.id} failed:`, rollbackErr);
    }
    return { success: false, message: "Failed to set up club ownership. Please try again." };
  }

  revalidatePath("/clubs");
  return { success: true, message: "Club created.", slug: club.slug };
}

// ── createClubInvite ──────────────────────────────────────────

export type CreateInviteResult = { success: boolean; message: string; token?: string };

/**
 * Admin-only. Generates a one-time invite token for the club. The token is an
 * opaque 32-hex string; the recipient redeems it at /clubs/join?invite=<token>.
 */
export async function createClubInvite(opts: {
  clubId: string;
  role?: ClubRole;
}): Promise<CreateInviteResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };
  if (!isValidUUID(opts.clubId)) return { success: false, message: "Invalid club." };

  if (!(await isClubAdmin(user.id, opts.clubId))) {
    return { success: false, message: "Only club owners and admins can create invites." };
  }

  // Members can invite members; only owners/admins reach here, and we cap the
  // grantable role at 'admin' (ownership transfer is not an invite operation).
  const role: ClubRole = opts.role === "admin" ? "admin" : "member";
  const token = crypto.randomUUID().replace(/-/g, "");

  const db = createServiceClient();
  const { error } = await db
    .from("club_invites")
    .insert({ club_id: opts.clubId, token, role, created_by: user.id });

  if (error) return { success: false, message: "Failed to create invite." };
  return { success: true, message: "Invite link ready.", token };
}

// ── acceptClubInvite ──────────────────────────────────────────

export type AcceptInviteResult = { success: boolean; message: string; slug?: string };

/**
 * Redeems a one-time invite token: adds the player as a member (idempotent if
 * already a member) and consumes the token. Returns the club slug so the caller
 * can route to /c/[slug].
 */
export async function acceptClubInvite(token: string): Promise<AcceptInviteResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const cleaned = token.trim();
  if (!cleaned) return { success: false, message: "Missing invite token." };

  const db = createServiceClient();

  const { data: invite } = await db
    .from("club_invites")
    .select("id, club_id, role, consumed_at, expires_at")
    .eq("token", cleaned)
    .maybeSingle();

  if (!invite) return { success: false, message: "This invite link is not valid." };
  if (invite.consumed_at) return { success: false, message: "This invite has already been used." };
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return { success: false, message: "This invite has expired." };
  }

  const { data: club } = await db
    .from("clubs")
    .select("slug")
    .eq("id", invite.club_id)
    .maybeSingle();
  if (!club) return { success: false, message: "That club no longer exists." };

  // Join, handling the three membership states explicitly. A blind
  // ignoreDuplicates upsert would silently skip a soft-removed (is_active=false)
  // row, leaving the player inactive while reporting success — the layout guard
  // would then bounce them straight back to /clubs.
  const { data: existing } = await db
    .from("club_members")
    .select("id, is_active")
    .eq("club_id", invite.club_id)
    .eq("player_id", user.id)
    .maybeSingle();

  if (!existing) {
    // New member — grant the invite's role.
    const { error: insErr } = await db.from("club_members").insert({
      club_id: invite.club_id,
      player_id: user.id,
      role: invite.role as ClubRole,
    });
    if (insErr) return { success: false, message: "Failed to join the club. Please try again." };
  } else if (!existing.is_active) {
    // Previously removed — re-activate. Role is preserved (re-grading a member
    // is a separate admin action), only membership is restored.
    const { error: reErr } = await db
      .from("club_members")
      .update({ is_active: true })
      .eq("id", existing.id);
    if (reErr) return { success: false, message: "Failed to re-join the club. Please try again." };
  }
  // else: already an active member — no-op (don't downgrade an owner/admin who
  // re-redeems a member invite).

  // Consume the token (one-time). The `is(consumed_at, null)` guard makes a
  // double-redeem race a no-op rather than overwriting the first consumer.
  // Membership was already granted above, so a failure here doesn't block the
  // join — but it's logged since a silently-unconsumed token could otherwise
  // be redeemed indefinitely.
  const { error: consumeErr } = await db
    .from("club_invites")
    .update({ consumed_by: user.id, consumed_at: new Date().toISOString() })
    .eq("id", invite.id)
    .is("consumed_at", null);
  if (consumeErr) {
    console.error(`acceptClubInvite: failed to consume invite ${invite.id}:`, consumeErr);
  }

  revalidatePath("/clubs");
  return { success: true, message: "You've joined the club.", slug: club.slug };
}

// ── leaveClub ─────────────────────────────────────────────────

export type LeaveClubResult = { success: boolean; message: string };

/**
 * Self-service: the authenticated player leaves a club they belong to.
 * Soft-removes their own membership row (is_active=false), preserving
 * historical stats. Blocked if they're the club's only active owner —
 * ownership must be handed off first.
 */
export async function leaveClub(clubId: string): Promise<LeaveClubResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };
  if (!isValidUUID(clubId)) return { success: false, message: "Invalid club." };

  const db = createServiceClient();
  const { data: membership } = await db
    .from("club_members")
    .select("id, role")
    .eq("club_id", clubId)
    .eq("player_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!membership) return { success: false, message: "You're not a member of this club." };

  if (membership.role === "owner" && (await countActiveOwners(clubId)) <= 1) {
    return {
      success: false,
      message: "You're the only owner — promote someone else to owner before leaving.",
    };
  }

  const { error } = await db
    .from("club_members")
    .update({ is_active: false })
    .eq("id", membership.id)
    .eq("club_id", clubId);

  if (error) return { success: false, message: "Failed to leave the club. Please try again." };

  revalidatePath("/clubs");
  return { success: true, message: "You've left the club." };
}

// ── Member management (owner/admin) ──────────────────────────
//
// Permission hierarchy: owners may manage admins, members, and other owners
// (subject to the last-active-owner guard); admins may only manage plain
// members. Nobody can act on their own row through these actions — self
// exits go through `leaveClub`. Every mutation filters by BOTH the member's
// row id AND clubId as defense-in-depth against acting on a row that
// resolves to a different club.

function canManageTarget(actorRole: ClubRole, targetRole: ClubRole): boolean {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return targetRole === "member";
  return false;
}

export type MemberActionResult = { success: boolean; message: string };

/**
 * Owner/admin action: soft-removes another member (is_active=false).
 * Admins may only remove plain members; owners may also remove admins and
 * other owners, subject to the last-active-owner guard.
 */
export async function removeMember(
  clubId: string,
  memberId: string,
  clubSlug: string
): Promise<MemberActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };
  if (!isValidUUID(clubId) || !isValidUUID(memberId)) {
    return { success: false, message: "Invalid request." };
  }

  const actorRole = await getClubRole(user.id, clubId);
  if (actorRole !== "owner" && actorRole !== "admin") {
    return { success: false, message: "Only club owners and admins can remove members." };
  }

  const db = createServiceClient();
  const { data: target } = await db
    .from("club_members")
    .select("id, player_id, role")
    .eq("id", memberId)
    .eq("club_id", clubId)
    .eq("is_active", true)
    .maybeSingle();

  if (!target) return { success: false, message: "That member is not active in this club." };
  if (target.player_id === user.id) {
    return { success: false, message: "Use the Leave club option to remove yourself." };
  }
  if (!canManageTarget(actorRole, target.role as ClubRole)) {
    return { success: false, message: "Admins can only remove plain members." };
  }
  if (target.role === "owner" && (await countActiveOwners(clubId)) <= 1) {
    return { success: false, message: "Can't remove the club's only owner." };
  }

  const { error } = await db
    .from("club_members")
    .update({ is_active: false })
    .eq("id", memberId)
    .eq("club_id", clubId);

  if (error) return { success: false, message: "Failed to remove member. Please try again." };

  revalidatePath(`/c/${clubSlug}/admin`);
  return { success: true, message: "Member removed." };
}

/**
 * Owner/admin action: restores a previously-removed member (is_active=true).
 * Their prior role is preserved. Same permission hierarchy as `removeMember`.
 */
export async function restoreMember(
  clubId: string,
  memberId: string,
  clubSlug: string
): Promise<MemberActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };
  if (!isValidUUID(clubId) || !isValidUUID(memberId)) {
    return { success: false, message: "Invalid request." };
  }

  const actorRole = await getClubRole(user.id, clubId);
  if (actorRole !== "owner" && actorRole !== "admin") {
    return { success: false, message: "Only club owners and admins can restore members." };
  }

  const db = createServiceClient();
  const { data: target } = await db
    .from("club_members")
    .select("id, player_id, role")
    .eq("id", memberId)
    .eq("club_id", clubId)
    .eq("is_active", false)
    .maybeSingle();

  if (!target) return { success: false, message: "That member isn't removed." };
  if (target.player_id === user.id) {
    return { success: false, message: "You can't restore your own membership this way." };
  }
  if (!canManageTarget(actorRole, target.role as ClubRole)) {
    return { success: false, message: "Admins can only restore plain members." };
  }

  const { error } = await db
    .from("club_members")
    .update({ is_active: true })
    .eq("id", memberId)
    .eq("club_id", clubId);

  if (error) return { success: false, message: "Failed to restore member. Please try again." };

  revalidatePath(`/c/${clubSlug}/admin`);
  return { success: true, message: "Member restored." };
}

/**
 * Owner-only action: changes another active member's role. Demoting the
 * club's only owner is blocked by the same last-active-owner guard used by
 * `leaveClub` and `removeMember`.
 */
export async function changeMemberRole(
  clubId: string,
  memberId: string,
  newRole: ClubRole,
  clubSlug: string
): Promise<MemberActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };
  if (!isValidUUID(clubId) || !isValidUUID(memberId)) {
    return { success: false, message: "Invalid request." };
  }
  if (newRole !== "owner" && newRole !== "admin" && newRole !== "member") {
    return { success: false, message: "Invalid role." };
  }

  const actorRole = await getClubRole(user.id, clubId);
  if (actorRole !== "owner") {
    return { success: false, message: "Only club owners can change roles." };
  }

  const db = createServiceClient();
  const { data: target } = await db
    .from("club_members")
    .select("id, player_id, role")
    .eq("id", memberId)
    .eq("club_id", clubId)
    .eq("is_active", true)
    .maybeSingle();

  if (!target) return { success: false, message: "That member is not active in this club." };
  if (target.player_id === user.id) {
    return { success: false, message: "You can't change your own role." };
  }
  if (target.role === "owner" && newRole !== "owner" && (await countActiveOwners(clubId)) <= 1) {
    return { success: false, message: "Can't demote the club's only owner." };
  }
  if (target.role === newRole) {
    return { success: true, message: "No change." };
  }

  const { error } = await db
    .from("club_members")
    .update({ role: newRole })
    .eq("id", memberId)
    .eq("club_id", clubId);

  if (error) return { success: false, message: "Failed to change role. Please try again." };

  revalidatePath(`/c/${clubSlug}/admin`);
  return { success: true, message: "Role updated." };
}
