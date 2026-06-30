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
import { isClubAdmin } from "@/lib/clubs";
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
  await db
    .from("club_invites")
    .update({ consumed_by: user.id, consumed_at: new Date().toISOString() })
    .eq("id", invite.id)
    .is("consumed_at", null);

  revalidatePath("/clubs");
  return { success: true, message: "You've joined the club.", slug: club.slug };
}
