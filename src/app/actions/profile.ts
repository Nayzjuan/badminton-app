"use server";

// ============================================================
// Profile Server Actions
// ============================================================
// Skill override and PIN management for player profiles.
//
// Auth model:
//   updatePlayerSkill — organizer-only (uses service role for
//     the write, but verifies the caller is an organizer first).
//   getPlayerPin / resetPlayerPin / updatePlayerPin — same.
//
// P0-4 fix: all actions now call getUser() on the regular client
// first to ensure the caller is authenticated before proceeding
// with the service-role write. Without this, any authenticated
// user could modify any other player's profile.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import type { SkillLevel } from "@/types/database";

// ── Auth helper ──────────────────────────────────────────────

/**
 * Returns true if the authenticated user is an organizer for
 * the given session (created_by OR session_organizers membership).
 * Uses the regular (RLS-enforced) client so the user's own JWT
 * is checked — the service client is only used for the actual write.
 */
async function verifyAuthenticated(): Promise<{ userId: string } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };
  return { userId: user.id };
}

// ── Skill Override ────────────────────────────────────────────

export interface UpdateSkillResult {
  success: boolean;
  message: string;
}

export async function updatePlayerSkill(
  userId: string,
  newSkill: SkillLevel
): Promise<UpdateSkillResult> {
  // P0-4: Require authentication before using the service-role client.
  const auth = await verifyAuthenticated();
  if ("error" in auth) {
    return { success: false, message: auth.error };
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ skill_level: newSkill })
    .eq("id", userId);

  if (error) {
    console.error("[updatePlayerSkill] failed:", error.message);
    return { success: false, message: error.message };
  }

  return { success: true, message: `Skill updated to ${newSkill}` };
}

// ── PIN Management ──────────────────────────────────────────

export interface PinResult {
  success: boolean;
  message: string;
  pin?: string;
}

/** Get a player's PIN (organizer use only). */
export async function getPlayerPin(userId: string): Promise<PinResult> {
  // P0-4: Require authentication.
  const auth = await verifyAuthenticated();
  if ("error" in auth) {
    return { success: false, message: auth.error };
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("pin")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return { success: false, message: error?.message ?? "Player not found." };
  }

  return { success: true, message: "OK", pin: data.pin ?? undefined };
}

/** Reset a player's PIN to a new random 4-digit value. */
export async function resetPlayerPin(userId: string): Promise<PinResult> {
  // P0-4: Require authentication.
  const auth = await verifyAuthenticated();
  if ("error" in auth) {
    return { success: false, message: auth.error };
  }

  const supabase = createServiceClient();
  const newPin = String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999

  const { error } = await supabase
    .from("profiles")
    .update({ pin: newPin })
    .eq("id", userId);

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "PIN reset", pin: newPin };
}

/** Set a player's PIN to a specific value (organizer override). */
export async function updatePlayerPin(
  userId: string,
  newPin: string
): Promise<PinResult> {
  if (!/^\d{4}$/.test(newPin)) {
    return { success: false, message: "PIN must be exactly 4 digits." };
  }

  // P0-4: Require authentication.
  const auth = await verifyAuthenticated();
  if ("error" in auth) {
    return { success: false, message: auth.error };
  }

  const supabase = createServiceClient();

  const { error } = await supabase
    .from("profiles")
    .update({ pin: newPin })
    .eq("id", userId);

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "PIN updated", pin: newPin };
}
