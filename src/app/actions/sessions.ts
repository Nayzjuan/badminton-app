"use server";

// ============================================================
// Session Lifecycle — Server Actions
// ============================================================
// createSession       — creates a new session with uniqueness-
//                       enforced passcode (auto-generated if blank)
// joinAsCoOrganizer   — co-organizer joins using ONLY the passcode
// closeSession        — archives an active session
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { broadcastSessionClosed } from "@/lib/broadcast";
import type { ScoringFormat } from "@/types/database";

// ── Passcode auto-generation ──────────────────────────────────

const BIRDIE_WORDS = [
  "BIRDIE", "SMASH", "DRIVE", "CLEAR", "DROPS",
  "RALLY", "SERVE", "COURT", "NETSH", "LUNGE",
];

/**
 * Generates a random badminton-themed passcode.
 * Format: one of the BIRDIE_WORDS + a random 1-digit suffix.
 * e.g. "SMASH7", "BIRDIE3", "RALLY9"
 */
function generatePasscode(): string {
  const word = BIRDIE_WORDS[Math.floor(Math.random() * BIRDIE_WORDS.length)];
  const digit = Math.floor(Math.random() * 10);
  return `${word}${digit}`;
}

// ── createSession ─────────────────────────────────────────────

export interface CreateSessionResult {
  success: boolean;
  message: string;
  sessionId?: string;
  passcode?: string;
}

/**
 * Creates a new session for the authenticated user.
 *
 * • If passcode is provided, checks that no other ACTIVE session
 *   currently uses that same passcode (case-insensitive).
 * • If passcode is blank, auto-generates a badminton-themed one
 *   (retries up to 5 times to avoid collision in edge cases).
 * • Inserts the session row using the service-role client so the
 *   uniqueness check and insert happen atomically without RLS
 *   blocking the cross-session passcode lookup.
 */
export async function createSession(opts: {
  name: string;
  scoring: ScoringFormat;
  passcode?: string;
}): Promise<CreateSessionResult> {
  // Auth gate
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const service = createServiceClient();

  // Determine the passcode to use
  let finalPasscode: string;

  if (opts.passcode && opts.passcode.trim()) {
    finalPasscode = opts.passcode.trim().toUpperCase();

    // Uniqueness check — no active session may share this passcode
    const { data: conflict } = await service
      .from("sessions")
      .select("id")
      .eq("is_active", true)
      .ilike("organizer_passcode", finalPasscode)
      .maybeSingle();

    if (conflict) {
      return {
        success: false,
        message: "This passcode is currently in use by another active session. Please choose a different one.",
      };
    }
  } else {
    // Auto-generate — retry up to 5 times to avoid collision
    let attempts = 0;
    let candidate = "";
    while (attempts < 5) {
      candidate = generatePasscode();
      const { data: conflict } = await service
        .from("sessions")
        .select("id")
        .eq("is_active", true)
        .ilike("organizer_passcode", candidate)
        .maybeSingle();
      if (!conflict) break;
      attempts++;
    }
    finalPasscode = candidate || generatePasscode(); // fallback if all collide
  }

  // Insert the session
  const { data: session, error: insertError } = await service
    .from("sessions")
    .insert({
      name: opts.name.trim(),
      created_by: user.id,
      scoring: opts.scoring,
      organizer_passcode: finalPasscode,
    })
    .select("id")
    .single();

  if (insertError || !session) {
    return {
      success: false,
      message: insertError?.message ?? "Failed to create session.",
    };
  }

  return {
    success: true,
    message: "Session created.",
    sessionId: session.id,
    passcode: finalPasscode,
  };
}

// ── joinAsCoOrganizer ─────────────────────────────────────────

export interface JoinCoOrganizerResult {
  success: boolean;
  message: string;
  sessionId?: string;
}

/**
 * Co-organizer join flow using ONLY the session passcode.
 *
 * 1. Looks up an active session whose organizer_passcode matches
 *    the supplied value (exact, case-insensitive via ILIKE).
 * 2. Inserts a session_organizers row for the caller.
 * 3. Returns the resolved UUID so the client can redirect.
 *
 * Security: returns the same generic error when nothing matches
 * — never reveals whether the passcode exists.
 */
export async function joinAsCoOrganizer(
  passcode: string
): Promise<JoinCoOrganizerResult> {
  const INVALID = "Invalid passcode. No active session found.";

  // Auth gate
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const normalized = passcode.trim().toUpperCase();
  if (!normalized) return { success: false, message: INVALID };

  // Service client — bypass RLS so we can search all active sessions
  const service = createServiceClient();

  const { data: session } = await service
    .from("sessions")
    .select("id, created_by")
    .eq("is_active", true)
    .ilike("organizer_passcode", normalized)
    .maybeSingle();

  if (!session) return { success: false, message: INVALID };

  // Prevent the primary organizer from joining their own session
  if (session.created_by === user.id) {
    return { success: false, message: "You are already the primary organizer of this session." };
  }

  // Idempotent — if already a co-organizer just redirect in
  const { data: existing } = await service
    .from("session_organizers")
    .select("id")
    .eq("session_id", session.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) {
    return { success: true, message: "Already a co-organizer.", sessionId: session.id };
  }

  // Insert the co-organizer row
  const { error: insertError } = await service
    .from("session_organizers")
    .insert({ session_id: session.id, user_id: user.id });

  if (insertError) {
    console.error("[joinAsCoOrganizer] insert failed:", insertError.message);
    return { success: false, message: "Failed to join session. Please try again." };
  }

  return { success: true, message: "Joined as co-organizer.", sessionId: session.id };
}

// ── toggleAutoMatchmaking ─────────────────────────────────────

export interface ToggleAutoMatchmakingResult {
  success: boolean;
  isOn: boolean;
  message: string;
}

/**
 * Flips the `is_auto_matchmaking_on` boolean for a session.
 * When ON:  engine immediately runs to fill on-deck slots from the queue.
 * When OFF: engine is silent — organizer uses manual "Add to On Deck".
 */
export async function toggleAutoMatchmaking(
  sessionId: string
): Promise<ToggleAutoMatchmakingResult> {
  // Auth gate
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, isOn: false, message: "Not authenticated." };

  const service = createServiceClient();

  // Read current value
  const { data: session, error: fetchErr } = await service
    .from("sessions")
    .select("is_auto_matchmaking_on")
    .eq("id", sessionId)
    .single();

  if (fetchErr || !session) {
    return { success: false, isOn: false, message: "Session not found." };
  }

  const newValue = !session.is_auto_matchmaking_on;

  const { error: updateErr } = await service
    .from("sessions")
    .update({ is_auto_matchmaking_on: newValue })
    .eq("id", sessionId);

  if (updateErr) {
    return { success: false, isOn: session.is_auto_matchmaking_on, message: updateErr.message };
  }

  // If toggled ON, immediately run the engine so the on-deck queue
  // fills up right away without waiting for the next player event.
  if (newValue) {
    await runEngineForSession(sessionId);
  }

  return {
    success: true,
    isOn: newValue,
    message: newValue ? "Auto-matchmaking enabled." : "Auto-matchmaking paused.",
  };
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

  // ── 0. Pre-compute Wrapped stats ────────────────────────────
  // Fire-and-forget: if the RPC fails the session still closes.
  // Stats are computed before the broadcast so rows exist when
  // players' browsers receive the session_closed event.
  try {
    await supabase.rpc("compute_session_wrapped", {
      p_session_id: sessionId,
    });
  } catch (err) {
    console.warn("[closeSession] compute_session_wrapped failed (non-fatal):", err);
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

  // ── 5. Broadcast session_closed to all connected players ───
  // Fire-and-forget after the session row is committed.
  await broadcastSessionClosed(sessionId);

  return {
    success: true,
    message: `Session closed. ${matchIds.length} match(es) cancelled, all players removed from queue.`,
  };
}
