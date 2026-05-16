"use server";

// ============================================================
// Wrapped — Server Actions
// ============================================================
// dismissWrappedIntro  — marks the intro overlay as seen for
//                        this (session, player) pair by setting
//                        intro_dismissed_at = now().
//
// This is called when the player clicks the "Done" button on
// the awards page.  Once set, the play-page redirect and the
// wrapped page server component both skip the intro on
// subsequent page loads — across all devices.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { isValidUUID } from "@/lib/validate";

// ── dismissWrappedIntro ───────────────────────────────────────

export interface DismissWrappedIntroResult {
  success: boolean;
  error?:  string;
}

/**
 * Stamps intro_dismissed_at = now() on the session_wrapped_stats
 * row for the given (sessionId, playerId).
 *
 * Idempotent — safe to call multiple times.  If no stats row
 * exists yet (rare race on session close), does nothing and
 * returns success so the UI still navigates away cleanly.
 */
export async function dismissWrappedIntro(
  sessionId: string,
  playerId:  string,
): Promise<DismissWrappedIntroResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player ID." };
  }
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase
    .from("session_wrapped_stats")
    .update({ intro_dismissed_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("player_id",  playerId)
    .is("intro_dismissed_at", null); // no-op if already dismissed

  if (error) {
    console.error("[dismissWrappedIntro] Supabase error:", error.message);
    return { success: false, error: error.message };
  }

  return { success: true };
}
