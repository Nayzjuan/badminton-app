"use server";

// ============================================================
// Session Lifecycle — Server Actions
// ============================================================
// createSession       — creates a new session with uniqueness-
//                       enforced passcode (auto-generated if blank)
// joinAsCoOrganizer   — co-organizer joins using ONLY the passcode
// closeSession        — archives an active session
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { broadcastSessionClosed, broadcastAutoMatchmakingToggled } from "@/lib/broadcast";
import { isValidUUID } from "@/lib/validate";
import type { ScoringFormat } from "@/types/database";

// ── Passcode auto-generation ──────────────────────────────────

const BIRDIE_WORDS = [
  "BIRDIE",
  "SMASH",
  "DRIVE",
  "CLEAR",
  "DROPS",
  "RALLY",
  "SERVE",
  "COURT",
  "NETSH",
  "LUNGE",
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
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  // ── Input validation ──────────────────────────────────────
  const trimmedName = opts.name.trim();
  if (!trimmedName) return { success: false, message: "Session name is required." };
  if (trimmedName.length > 60) {
    return { success: false, message: "Session name must be 60 characters or less." };
  }
  if (opts.passcode && opts.passcode.trim().length > 20) {
    return { success: false, message: "Passcode must be 20 characters or less." };
  }

  const service = createServiceClient();

  // Determine the passcode to use
  let finalPasscode: string;

  if (opts.passcode && opts.passcode.trim()) {
    finalPasscode = opts.passcode.trim().toUpperCase();

    // Uniqueness check — no active session may share this passcode.
    // Use exact match (.eq) — ILIKE would allow SQL wildcard characters
    // like % or _ to match unintended sessions.
    const { data: conflict } = await service
      .from("sessions")
      .select("id")
      .eq("is_active", true)
      .eq("organizer_passcode", finalPasscode)
      .maybeSingle();

    if (conflict) {
      return {
        success: false,
        message:
          "This passcode is currently in use by another active session. Please choose a different one.",
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
        .eq("organizer_passcode", candidate)
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
      name: trimmedName,
      created_by: user.id,
      scoring: opts.scoring,
      organizer_passcode: finalPasscode,
    })
    .select("id")
    .single();

  if (insertError || !session) {
    // 23505 = unique_violation — the partial unique index on
    // (organizer_passcode) WHERE is_active = true fired.
    // This is the authoritative DB guard against the TOCTOU window
    // between the app-layer uniqueness check above and this INSERT.
    if (insertError?.code === "23505") {
      return {
        success: false,
        message:
          "This passcode is currently in use by another active session. Please choose a different one.",
      };
    }
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
export async function joinAsCoOrganizer(passcode: string): Promise<JoinCoOrganizerResult> {
  const INVALID = "Invalid passcode. No active session found.";

  // Auth gate
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const normalized = passcode.trim().toUpperCase();
  if (!normalized) return { success: false, message: INVALID };

  // Service client — bypass RLS so we can search all active sessions
  const service = createServiceClient();

  // Exact match — ILIKE would allow SQL wildcard characters (%, _) to
  // match unintended sessions. The passcode is already normalised to
  // uppercase so case-insensitivity is not needed here.
  const { data: session } = await service
    .from("sessions")
    .select("id, created_by")
    .eq("is_active", true)
    .eq("organizer_passcode", normalized)
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
  if (!isValidUUID(sessionId)) {
    return { success: false, isOn: false, message: "Invalid session ID." };
  }

  // Auth gate
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, isOn: false, message: "Not authenticated." };

  const service = createServiceClient();

  // Verify caller is an organizer of this session (primary or co-organizer).
  // Uses the two-path check: sessions.created_by first, then session_organizers.
  const { data: sessionMeta } = await service
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .single();

  if (!sessionMeta) {
    return { success: false, isOn: false, message: "Session not found." };
  }

  if (sessionMeta.created_by !== user.id) {
    const { data: coOrg } = await service
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!coOrg) {
      return { success: false, isOn: false, message: "Not authorized. Organizer access required." };
    }
  }

  // Atomic flip via DB function — eliminates the read→write
  // lost-update race that existed when we did SELECT then UPDATE.
  const { data: newValue, error: rpcErr } = await service.rpc("toggle_auto_matchmaking", {
    p_session_id: sessionId,
  });

  if (rpcErr) {
    return { success: false, isOn: false, message: rpcErr.message };
  }
  if (newValue === null || newValue === undefined) {
    return { success: false, isOn: false, message: "Session not found." };
  }

  // If toggled ON, immediately run the engine so the on-deck queue
  // fills up right away without waiting for the next player event.
  if (newValue) {
    await runEngineForSession(sessionId);
  }

  // Broadcast the new toggle state to all co-organizers on this session.
  // Uses Broadcast (not postgres_changes) so it bypasses the sessions
  // table RLS SELECT policy — co-organizers (non-creators) would
  // otherwise never receive the Realtime UPDATE event.
  // Fire-and-forget: broadcast failure does not affect the DB result.
  broadcastAutoMatchmakingToggled(sessionId, newValue).catch((err) => {
    console.warn("[toggleAutoMatchmaking] broadcast failed (non-fatal):", err);
  });

  return {
    success: true,
    isOn: newValue,
    message: newValue ? "Auto-matchmaking enabled." : "Auto-matchmaking paused.",
  };
}

// ── updateSessionSettings ─────────────────────────────────────

/**
 * Updates mutable session settings (e.g. court_time_limit_minutes).
 * Caller must be an organizer of the session.
 */
export async function updateSessionSettings(
  sessionId: string,
  updates: { court_time_limit_minutes?: number | null }
): Promise<{ error?: string }> {
  if (!isValidUUID(sessionId)) return { error: "Invalid session ID." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  // Two-path organizer check: created_by fast-path first (the primary organizer
  // never has a session_organizers row), then session_organizers membership.
  // Uses service client so read-side RLS never blocks either query.
  const svc = createServiceClient();
  const { data: sessionMeta } = await svc
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .maybeSingle();

  const isPrimaryOrganizer = sessionMeta?.created_by === user.id;

  if (!isPrimaryOrganizer) {
    const { data: org } = await svc
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!org) return { error: "Not an organizer of this session." };
  }

  // Explicitly allowlist updatable fields — prevents a crafted call from
  // updating sensitive columns (is_active, organizer_passcode, created_by, etc.)
  // even though TypeScript narrows `updates` at compile time.
  // Each allowed field is destructured and re-assembled into a typed object.
  if (updates.court_time_limit_minutes === undefined) return {};

  // Validate bounds: null disables the time limit; integers must be 5–180 min.
  if (updates.court_time_limit_minutes !== null) {
    const mins = updates.court_time_limit_minutes;
    if (!Number.isInteger(mins) || mins < 5 || mins > 180) {
      return { error: "Court time limit must be between 5 and 180 minutes." };
    }
  }

  // Use service client for the write so the primary organizer's update is
  // never silently blocked by write-side RLS on the sessions table.
  const { error } = await svc
    .from("sessions")
    .update({ court_time_limit_minutes: updates.court_time_limit_minutes })
    .eq("id", sessionId);

  if (error) return { error: "Failed to update session settings." };
  return {};
}

// ── getSessionForOrganizer ────────────────────────────────────

export interface GetSessionResult {
  success: boolean;
  session?: import("@/types/database").Session;
  error?: string;
}

/**
 * Lightweight read-only fetch of a session row for the organizer dashboard
 * polling / reconnect layers (Layer 2 + Layer 3 of the auto-toggle sync fix).
 *
 * Why a server action and not a direct browser-client query?
 *   The sessions table RLS SELECT policy only grants read access to the
 *   session creator (sessions.created_by). Co-organizers (session_organizers
 *   members who are not the creator) are blocked by RLS and receive no rows.
 *   Using the service-role client here bypasses RLS so both the primary
 *   organizer and all co-organizers can read the canonical session state.
 *
 * Auth: two-path organizer check (same as toggleAutoMatchmaking / updateSessionSettings).
 *   1. authenticated (RLS client getUser)
 *   2. sessions.created_by === user.id  OR  session_organizers membership
 * The session row includes organizer_passcode — restricting to organizers
 * ensures a plain authenticated player cannot read it by knowing the session UUID.
 */
export async function getSessionForOrganizer(sessionId: string): Promise<GetSessionResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const service = createServiceClient();

  // ── Two-path organizer check ──────────────────────────────────
  // Primary organizer: sessions.created_by === user.id (fast path).
  // Co-organizer:      session_organizers row exists for this user.
  const { data: sessionMeta } = await service
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .maybeSingle();

  if (!sessionMeta) return { success: false, error: "Session not found." };

  if (sessionMeta.created_by !== user.id) {
    const { data: membership } = await service
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return { success: false, error: "Not authorized. Organizer access required." };
  }

  // ── Fetch full session row ────────────────────────────────────
  const { data, error } = await service.from("sessions").select("*").eq("id", sessionId).single();

  if (error || !data) {
    return { success: false, error: error?.message ?? "Session not found." };
  }

  return { success: true, session: data };
}

export interface CloseSessionResult {
  success: boolean;
  message: string;
  /** true when compute_session_wrapped succeeded and Wrapped pages are ready. */
  wrappedReady?: boolean;
}

export async function closeSession(sessionId: string): Promise<CloseSessionResult> {
  if (!isValidUUID(sessionId)) return { success: false, message: "Invalid session ID." };

  // ── Auth gate ────────────────────────────────────────────────
  // closeSession is a destructive operation — all callers must be an
  // organizer of the session. Without this check any authenticated user
  // who learns a session UUID can close it (service client bypasses RLS).
  const userClient = await createServerSupabaseClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }

  // Verify the session exists and is currently active, and capture
  // created_by for the organizer check below.
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, is_active, created_by")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return { success: false, message: "Session not found." };
  }
  if (!session.is_active) {
    return { success: false, message: "Session is already closed." };
  }

  // ── Organizer check ──────────────────────────────────────────
  // Two-path check mirrors toggleAutoMatchmaking: primary organizer
  // (created_by) OR any co-organizer row in session_organizers.
  if (session.created_by !== user.id) {
    const { data: coOrg } = await supabase
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!coOrg) {
      return { success: false, message: "Not authorized. Organizer access required." };
    }
  }

  // ── 0. Pre-compute Wrapped stats ────────────────────────────
  // Runs before broadcast so rows exist when players' browsers
  // receive the session_closed event.
  //
  // Step 0a: refresh_cross_session_stats populates the all-time
  // rivalry and partnership ledgers from this session's completed
  // matches. Must run before compute_session_wrapped so the award
  // RPC can read up-to-date cross-session data. Non-fatal: a failure
  // here is logged but does not abort the close or block Wrapped.
  {
    const { error: crossErr } = await supabase.rpc("refresh_cross_session_stats", {
      p_session_id: sessionId,
    });
    if (crossErr) {
      console.warn(
        "[closeSession] refresh_cross_session_stats failed (non-fatal, cross-session awards may be stale):",
        crossErr.message
      );
    }
  }

  // Step 0b: compute per-player stats and awards.
  //
  // NOTE: supabase.rpc() resolves with { data, error } — it never
  // throws. The old try/catch only caught network-level exceptions,
  // not Supabase-level errors. We now check { error } explicitly
  // and retry once before giving up.
  let wrappedReady = false;
  {
    const { error: rpcError } = await supabase.rpc("compute_session_wrapped", {
      p_session_id: sessionId,
    });
    if (rpcError) {
      console.warn(
        "[closeSession] compute_session_wrapped failed, retrying in 600 ms:",
        rpcError.message
      );
      await new Promise((r) => setTimeout(r, 600));
      const { error: retryError } = await supabase.rpc("compute_session_wrapped", {
        p_session_id: sessionId,
      });
      if (retryError) {
        console.error(
          "[closeSession] compute_session_wrapped retry also failed — Wrapped pages will show empty stats:",
          retryError.message
        );
      } else {
        wrappedReady = true;
      }
    } else {
      wrappedReady = true;
    }
  }

  // ── 1. Cancel any lingering pending / in_progress matches ────
  // Direct filtered UPDATE — skipping the SELECT avoids the gap
  // where new matches could be inserted between SELECT and UPDATE.
  const { count: cancelledCount } = await supabase
    .from("matches")
    .update({ status: "cancelled" as const }, { count: "exact" })
    .eq("session_id", sessionId)
    .in("status", ["pending", "in_progress"]);

  // ── 2. Remove all remaining queue entries ───────────────────
  // Mark everyone as "left" so their history is preserved.
  await supabase
    .from("queue_entries")
    .update({ status: "left" as const })
    .eq("session_id", sessionId)
    .in("status", ["waiting", "drafted", "on_deck", "playing"]);

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
    message: `Session closed. ${cancelledCount ?? 0} match(es) cancelled, all players removed from queue.`,
    wrappedReady,
  };
}
