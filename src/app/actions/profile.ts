"use server";

// ============================================================
// Profile Server Actions
// ============================================================
// Skill override: updates a player's skill_level in the profiles
// table. Does NOT alter any in-progress or on-deck match the
// player is currently in — the new skill only applies to their
// next queue entry / matchmaking cycle.
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
