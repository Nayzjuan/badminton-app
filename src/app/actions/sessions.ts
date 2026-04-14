"use server";

// ============================================================
// Session Lifecycle — Server Actions
// ============================================================
// Handles closing/archiving sessions. Uses the service role
// client to bypass RLS and clean up all related data atomically.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";

export interface CloseSessionResult {
  success: boolean;
  message: string;
}

export async function closeSession(sessionId: string): Promise<CloseSessionResult> {
  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }

  // Verify the session exists and is currently active.
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, is_active")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return { success: false, message: "Session not found." };
  }
  if (!session.is_active) {
    return { success: false, message: "Session is already closed." };
  }

  // ── 1. Cancel any lingering on_deck / in_progress matches ───
  const { data: activeMatches } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", ["pending", "in_progress"]);

  const matchIds = (activeMatches ?? []).map((m) => m.id);

  if (matchIds.length > 0) {
    await supabase
      .from("matches")
      .update({ status: "cancelled" as const })
      .in("id", matchIds);
  }

  // ── 2. Remove all remaining queue entries ───────────────────
  // Mark everyone as "left" so their history is preserved.
  await supabase
    .from("queue_entries")
    .update({ status: "left" as const })
    .eq("session_id", sessionId)
    .in("status", ["waiting", "on_deck", "playing"]);

  // ── 3. Reset courts to closed ──────────────────────────────
  await supabase
    .from("courts")
    .update({ status: "closed" as const })
    .eq("session_id", sessionId);

  // ── 4. Mark session as inactive ────────────────────────────
  const { error: updateError } = await supabase
    .from("sessions")
    .update({
      is_active: false,
      ended_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  if (updateError) {
    return { success: false, message: `Failed to close session: ${updateError.message}` };
  }

  return {
    success: true,
    message: `Session closed. ${matchIds.length} match(es) cancelled, all players removed from queue.`,
  };
}
