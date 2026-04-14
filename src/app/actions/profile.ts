"use server";

// ============================================================
// Profile Server Actions
// ============================================================
// Skill override and PIN management for player profiles.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import type { SkillLevel } from "@/types/database";

export interface UpdateSkillResult {
  success: boolean;
  message: string;
}

export async function updatePlayerSkill(
  userId: string,
  newSkill: SkillLevel
): Promise<UpdateSkillResult> {
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
