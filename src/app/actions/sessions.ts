"use server";

// ============================================================
// Session Lifecycle — Server Actions
// ============================================================
// closeSession    — archives an active session
// joinAsCoOrganizer — lets a second organizer join by short code
//                    (first 6 chars of the session UUID, uppercased)
//                    instead of pasting the full UUID
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";

// ── Session Code helpers ──────────────────────────────────────

/**
 * Derives the short 6-character human-readable "Session Code"
 * from a full session UUID. Strips hyphens, takes the first 6
 * hex characters, uppercases them.
 *
 * Example: "abc123de-f456-..." → "ABC123"
 *
 * No DB column needed — the code is deterministically derived
 * from the UUID that already exists.
 */
export function toSessionCode(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 6).toUpperCase();
}

// ── joinAsCoOrganizer ─────────────────────────────────────────

export interface JoinCoOrganizerResult {
  success: boolean;
  message: string;
  sessionId?: string;
}

/**
 * Co-organizer join flow using a SHORT SESSION CODE instead of
 * pasting the full UUID.
 *
 * 1. Resolves the session by matching the code against the
 *    prefix of the session UUID (case-insensitive ILIKE).
 * 2. Validates the organizer_passcode.
 * 3. Inserts a session_organizers row for the caller.
 * 4. Returns the resolved UUID so the client can redirect.
 *
 * Security: always returns the same generic error message when
 * validation fails — never reveals which part was wrong.
 */
export async function joinAsCoOrganizer(
  sessionCode: string,
  passcode: string
): Promise<JoinCoOrganizerResult> {
  const INVALID = "Invalid session code or passcode.";

  // Auth gate — must be authenticated.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // Normalize: strip whitespace, uppercase.
  const code = sessionCode.trim().toUpperCase();
  if (!code || code.length !== 6) {
    return { success: false, message: "Session code must be exactly 6 characters." };
  }
  if (!passcode.trim()) {
    return { success: false, message: INVALID };
  }

  // Use service client so we can read all sessions regardless of RLS.
  const service = createServiceClient();

  // Look up active sessions whose UUID starts with this code.
  // UUIDs are hex + hyphens; after stripping hyphens, the first 6 chars
  // are exactly what toSessionCode() produces.
  // e.g. code "ABC123" → ilike filter "abc123%"
  const { data: sessions } = await service
    .from("sessions")
    .select("id, organizer_passcode, created_by")
    .eq("is_active", true)
    .ilike("id", `${code.toLowerCase().split("").join("")}%`);

  if (!sessions || sessions.length === 0) {
    return { success: false, message: INVALID };
  }

  // Among matches (should be exactly one), find one whose passcode matches.
  // We intentionally don't short-circuit on "code found but wrong passcode"
  // to avoid leaking information.
  const session = sessions.find(
    (s) => s.organizer_passcode === passcode.trim()
  );

  if (!session) {
    return { success: false, message: INVALID };
  }

  // Prevent the primary organizer from adding themselves again.
  if (session.created_by === user.id) {
    return { success: false, message: "You are already the primary organizer of this session." };
  }

  // Check if already a co-organizer.
  const { data: existing } = await service
    .from("session_organizers")
    .select("id")
    .eq("session_id", session.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) {
    // Already a co-organizer — just redirect them in.
    return { success: true, message: "Already a co-organizer.", sessionId: session.id };
  }

  // Insert the co-organizer row.
  const { error: insertError } = await service
    .from("session_organizers")
    .insert({ session_id: session.id, user_id: user.id });

  if (insertError) {
    console.error("[joinAsCoOrganizer] insert failed:", insertError.message);
    return { success: false, message: "Failed to join session. Please try again." };
  }

  return { success: true, message: "Joined as co-organizer.", sessionId: session.id };
}

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
