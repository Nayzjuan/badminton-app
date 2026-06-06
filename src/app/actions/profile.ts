"use server";

// ============================================================
// Profile Server Actions
// ============================================================
// Skill override and PIN management for player profiles.
//
// Auth model (enforced on every action):
//   1. getAuthenticatedUser()  — must be logged in
//   2. isSessionOrganizer()    — must be organizer of the given
//      session. Without this, any authenticated player could
//      call these actions against any other player's profile
//      using a crafted POST request (IDOR).
//
// The `sessionId` parameter is required by all four actions so
// the organizer gate can be verified before the service-role
// write executes.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import type { SkillLevel } from "@/types/database";

// ── Skill Override ────────────────────────────────────────────

export type UpdateSkillResult = {
  success: boolean;
  message: string;
};

export async function updatePlayerSkill(
  sessionId: string,
  userId: string,
  newSkill: SkillLevel
): Promise<UpdateSkillResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

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

// ── PIN Management ────────────────────────────────────────────

export type PinResult = {
  success: boolean;
  message: string;
  pin?: string;
};

/** Get a player's PIN — organizer of the given session only. */
export async function getPlayerPin(sessionId: string, userId: string): Promise<PinResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

  const supabase = createServiceClient();
  const { data, error } = await supabase.from("profiles").select("pin").eq("id", userId).single();

  if (error || !data) {
    return { success: false, message: error?.message ?? "Player not found." };
  }

  return { success: true, message: "OK", pin: data.pin ?? undefined };
}

/** Reset a player's PIN to a new cryptographically random 4-digit value. */
export async function resetPlayerPin(sessionId: string, userId: string): Promise<PinResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

  // crypto.getRandomValues produces a cryptographically secure random number,
  // unlike Math.random() which is predictable given sufficient observations.
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const newPin = String(1000 + (arr[0] % 9000)); // 1000–9999

  const supabase = createServiceClient();
  const { error } = await supabase.from("profiles").update({ pin: newPin }).eq("id", userId);

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "PIN reset", pin: newPin };
}

/** Set a player's PIN to a specific value — organizer of the given session only. */
export async function updatePlayerPin(
  sessionId: string,
  userId: string,
  newPin: string
): Promise<PinResult> {
  // Must be exactly 4 digits and not trivially guessable "0000".
  if (!/^\d{4}$/.test(newPin) || newPin === "0000") {
    return { success: false, message: "PIN must be 4 digits and cannot be 0000." };
  }

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, message: "Organizer access required." };

  const supabase = createServiceClient();
  const { error } = await supabase.from("profiles").update({ pin: newPin }).eq("id", userId);

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "PIN updated", pin: newPin };
}
