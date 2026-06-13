"use server";

// ============================================================
// Rename Server Actions — forced duplicate-name resolution
// ============================================================
// checkNameAvailable — async R1 + R2 pre-check for the /rename screen
//                      (debounced on the client). UX pre-validation only.
// renamePlayer        — commits the rename via rename_player_identity RPC
//                      (atomic name change + flag clear + audit; the partial
//                      UNIQUE index is the real R2 authority).
//
// Both derive the player id from the authenticated session (never a client
// argument) so there is no IDOR surface. Standard result shapes; never throw.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser } from "@/app/actions/_shared";
import { displayNameSchema } from "@/lib/schemas/auth";
import { isNameTaken } from "@/lib/dup-name";
import { normalizeName } from "@/lib/normalize-name";

export type NameCheckResult =
  | { available: true }
  | { available: false; code: "invalid" | "reused" | "taken"; message: string };

/**
 * Live availability check for a candidate name. Runs the full ladder:
 * Zod shape → R1 (vs this profile's persisted collided_name) → R2 (global
 * uniqueness vs all non-flagged profiles). Returns a structured reason so the
 * screen can pick the right tone (amber guidance for R1, red error for R2).
 */
export async function checkNameAvailable(rawName: string): Promise<NameCheckResult> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { available: false, code: "invalid", message: "Not signed in." };
  }

  const parsed = displayNameSchema.safeParse(rawName ?? "");
  if (!parsed.success) {
    return { available: false, code: "invalid", message: parsed.error.issues[0].message };
  }
  const name = parsed.data;

  const svc = createServiceClient();

  // R1 — cannot reuse the specific duplicated name (persisted collided_name).
  const { data: profile } = await svc
    .from("profiles")
    .select("collided_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.collided_name && normalizeName(name) === normalizeName(profile.collided_name)) {
    return {
      available: false,
      code: "reused",
      message: "That's the name we need to change. Add an initial or number to make it yours.",
    };
  }

  // R2 — must be unique across all (non-flagged) profiles.
  if (await isNameTaken(svc, name, user.id)) {
    return {
      available: false,
      code: "taken",
      message: `Someone already uses "${name}". Try adding an initial or number.`,
    };
  }

  return { available: true };
}

export type RenameResult =
  | { success: true }
  | { success: false; code: "invalid" | "reused" | "taken" | "error"; error: string };

/**
 * Commit the rename. Validates shape, then calls the atomic RPC. The RPC's
 * unique-index 23505 (race lost) and server-side R1 re-check are mapped to
 * friendly, recoverable messages.
 */
export async function renamePlayer(rawName: string): Promise<RenameResult> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { success: false, code: "error", error: "Not signed in. Please refresh." };
  }

  const parsed = displayNameSchema.safeParse(rawName ?? "");
  if (!parsed.success) {
    return { success: false, code: "invalid", error: parsed.error.issues[0].message };
  }
  const name = parsed.data;

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("rename_player_identity", {
    p_user_id: user.id,
    p_new_name: name,
  });

  if (error) {
    console.error("[renamePlayer] RPC error:", error.message);
    return { success: false, code: "error", error: "Couldn't save your name. Please try again." };
  }

  if (!data?.success) {
    switch (data?.error) {
      case "reused_dup_name":
        return {
          success: false,
          code: "reused",
          error: "That's the name we need to change. Add an initial or number.",
        };
      case "name_taken":
        return {
          success: false,
          code: "taken",
          error: `Just missed it — "${name}" was taken a second ago. Add one more letter or number.`,
        };
      case "profile_not_found":
        return { success: false, code: "error", error: "Profile not found. Please sign in again." };
      default:
        return {
          success: false,
          code: "error",
          error: "Couldn't save your name. Please try again.",
        };
    }
  }

  return { success: true };
}
