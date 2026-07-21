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
import {
  broadcastSessionClosed,
  broadcastAutoMatchmakingToggled,
  broadcastAutoPublishToggled,
  broadcastDraftCapPhase,
} from "@/lib/broadcast";
import { clearAllUnpublishedDrafts } from "@/app/actions/match-drafts";
import { isSessionOrganizer } from "@/app/actions/_shared";
import { isClubAdmin } from "@/lib/clubs";
import { isValidUUID } from "@/lib/validate";
import type { ScoringFormat } from "@/types/database";
import { scoringFormatSchema } from "@/lib/schemas/sessions";

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

/** Uniform crypto-random integer in [0, max) — no modulo bias for our small maxes. */
function randInt(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}

/**
 * Generates a random badminton-themed passcode.
 * Format: one of the BIRDIE_WORDS + a 4-digit suffix, e.g. "SMASH4271".
 *
 * The word list is public (only 10 values), so the real entropy is the digits.
 * The old form was WORD + ONE digit = 100 total combinations with Math.random —
 * walkable in ~100 requests, and a co-organizer passcode grants full session
 * rights. Now crypto-random with 4 digits = 100,000 combinations, and
 * joinAsCoOrganizer is rate-limited (see recordAndCheckJoinRateLimit), so brute
 * force is no longer practical. Still human-typeable (~9 chars, under the 20-cap).
 */
function generatePasscode(): string {
  const word = BIRDIE_WORDS[randInt(BIRDIE_WORDS.length)];
  const digits = String(randInt(10000)).padStart(4, "0");
  return `${word}${digits}`;
}

// ── createSession ─────────────────────────────────────────────

export type CreateSessionResult = {
  success: boolean;
  message: string;
  sessionId?: string;
  passcode?: string;
};

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
  /** When set, the session is created inside this club (caller must be a club
   *  owner/admin). When omitted, the DB DEFAULT routes it to the default club (CHILLAX). */
  clubId?: string;
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

  // Validate scoring format against the canonical ScoringFormat enum at runtime.
  // TypeScript narrows the type at compile time but `opts.scoring` arrives as an
  // unknown value from the client; a crafted call could send any string.
  const scoringResult = scoringFormatSchema.safeParse(opts.scoring);
  if (!scoringResult.success) {
    return { success: false, message: scoringResult.error.issues[0].message };
  }
  const scoring: ScoringFormat = scoringResult.data;

  // Club scoping (multi-tenant): a session ALWAYS belongs to an explicit club,
  // and the caller must be that club's owner/admin.
  //
  // clubId is REQUIRED. The old behaviour — omit clubId and let the
  // sessions.club_id DB DEFAULT route the session into CHILLAX, skipping the
  // admin check entirely — was a privilege-escalation primitive: any
  // authenticated user (including an anonymous one) could self-provision a real
  // organizer session in the founding club without being a member, which then
  // unlocked the whole organizer server-action surface. Both real callers
  // (club-admin-panel, organizer-entry) always pass a clubId, so requiring it
  // costs no legitimate flow.
  const clubId = opts.clubId?.trim();
  if (!clubId) {
    return { success: false, message: "A club is required to create a session." };
  }
  if (!isValidUUID(clubId)) return { success: false, message: "Invalid club." };
  if (!(await isClubAdmin(user.id, clubId))) {
    return { success: false, message: "Only club owners and admins can create sessions." };
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
      scoring,
      organizer_passcode: finalPasscode,
      club_id: clubId,
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

export type JoinCoOrganizerResult = {
  success: boolean;
  message: string;
  sessionId?: string;
};

// ── Rate limiting for the co-organizer passcode-join brute-force surface ──
/** Failed attempts allowed per identifier before lockout, within the window. */
const JOIN_MAX_FAILED = 10;
/** Rolling lockout window, minutes. */
const JOIN_WINDOW_MIN = 15;

/**
 * Best-effort client IP from the proxy headers Vercel sets. Rate-limiting by
 * user_id alone is defeated by rotating anonymous accounts, so we also key on
 * IP. Missing/spoofed headers just mean the IP arm doesn't bite — the user_id
 * arm and the raised passcode entropy still apply.
 */
async function getClientIp(): Promise<string | null> {
  const { headers } = await import("next/headers");
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip");
}

/**
 * Co-organizer join flow using ONLY the session passcode.
 *
 * 1. Rate-limit the caller (by user_id and IP) — the passcode space is small
 *    enough to be worth brute-forcing, and a hit grants full session rights.
 * 2. Looks up an active session whose organizer_passcode matches (exact).
 * 3. Inserts a session_organizers row for the caller.
 *
 * Security: returns the same generic error when nothing matches — never reveals
 * whether the passcode exists — and records every attempt for the rate limiter.
 */
export async function joinAsCoOrganizer(passcode: string): Promise<JoinCoOrganizerResult> {
  const INVALID = "Invalid passcode. No active session found.";
  const LOCKED = "Too many attempts. Please wait a few minutes and try again.";

  // Auth gate
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const normalized = passcode.trim().toUpperCase();
  if (!normalized) return { success: false, message: INVALID };

  // Service client — bypass RLS so we can search all active sessions and
  // read/write the (service-role-only) attempts log.
  const service = createServiceClient();

  // ── Rate-limit gate ──────────────────────────────────────────
  const ip = await getClientIp();
  const windowStart = new Date(Date.now() - JOIN_WINDOW_MIN * 60_000).toISOString();
  // Count recent FAILED attempts for this user, and (separately) this IP.
  const [userFails, ipFails] = await Promise.all([
    service
      .from("co_organizer_join_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("succeeded", false)
      .gte("attempted_at", windowStart),
    ip
      ? service
          .from("co_organizer_join_attempts")
          .select("id", { count: "exact", head: true })
          .eq("ip", ip)
          .eq("succeeded", false)
          .gte("attempted_at", windowStart)
      : Promise.resolve({ count: 0 }),
  ]);
  if ((userFails.count ?? 0) >= JOIN_MAX_FAILED || (ipFails.count ?? 0) >= JOIN_MAX_FAILED) {
    return { success: false, message: LOCKED };
  }

  const recordAttempt = (succeeded: boolean) =>
    service
      .from("co_organizer_join_attempts")
      .insert({ user_id: user.id, ip, succeeded })
      .then(
        () => undefined,
        (err: unknown) => console.error("[joinAsCoOrganizer] attempt-log failed:", err)
      );

  // Exact match — ILIKE would allow SQL wildcard characters (%, _) to
  // match unintended sessions. The passcode is already normalised to
  // uppercase so case-insensitivity is not needed here.
  const { data: session } = await service
    .from("sessions")
    .select("id, created_by")
    .eq("is_active", true)
    .eq("organizer_passcode", normalized)
    .maybeSingle();

  if (!session) {
    await recordAttempt(false);
    return { success: false, message: INVALID };
  }

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

  // A correct passcode: log the success (so it doesn't count toward the
  // failure window) and let the caller in.
  await recordAttempt(true);
  return { success: true, message: "Joined as co-organizer.", sessionId: session.id };
}

// ── toggleAutoMatchmaking ─────────────────────────────────────

export type ToggleAutoMatchmakingResult = {
  success: boolean;
  isOn: boolean;
  message: string;
};

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

  // isSessionOrganizer queries sessions.created_by (fast path) then falls back
  // to session_organizers — one round-trip instead of two.
  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) {
    return { success: false, isOn: false, message: "Not authorized. Organizer access required." };
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
): Promise<{ success?: boolean; error?: string }> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const svc = createServiceClient();

  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) return { success: false, error: "Not an organizer of this session." };

  // Explicitly allowlist updatable fields — prevents a crafted call from
  // updating sensitive columns (is_active, organizer_passcode, created_by, etc.)
  // even though TypeScript narrows `updates` at compile time.
  // Each allowed field is destructured and re-assembled into a typed object.
  if (updates.court_time_limit_minutes === undefined) return {};

  // Validate bounds: null disables the time limit; integers must be 5–180 min.
  if (updates.court_time_limit_minutes !== null) {
    const mins = updates.court_time_limit_minutes;
    if (!Number.isInteger(mins) || mins < 5 || mins > 180) {
      return { success: false, error: "Court time limit must be between 5 and 180 minutes." };
    }
  }

  // Use service client for the write so the primary organizer's update is
  // never silently blocked by write-side RLS on the sessions table.
  const { error } = await svc
    .from("sessions")
    .update({ court_time_limit_minutes: updates.court_time_limit_minutes })
    .eq("id", sessionId);

  if (error) return { success: false, error: "Failed to update session settings." };
  return {};
}

// ── setCapAndClearDrafts ──────────────────────────────────────

export type SetCapResult = {
  success: boolean;
  message?: string;
  error?: string;
  autoIsOn?: boolean;
  clearedCount?: number;
};

/**
 * Save the organizer's max-draft override and — when Auto is ON —
 * atomically clear all unpublished drafts so the engine can
 * regenerate fresh ones against the new cap.
 *
 * Called as Phase 1 of the cap-change reset flow. The hook
 * calls runEngineForSession separately as Phase 2.
 * Does NOT trigger the engine itself.
 */
export async function setCapAndClearDrafts(
  sessionId: string,
  cap: number | null
): Promise<SetCapResult> {
  if (!isValidUUID(sessionId)) {
    return { success: false, error: "Invalid session ID." };
  }
  // Validate cap: null = dynamic, 1–5 = override ceiling.
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 5)) {
    return { success: false, error: "Cap must be null or an integer between 1 and 5." };
  }

  const db = createServiceClient();
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const organizer = await isSessionOrganizer(user.id, sessionId);
  if (!organizer) return { success: false, error: "Organizer access required." };

  // Persist the override and read is_auto_matchmaking_on atomically in one
  // UPDATE...RETURNING statement. This eliminates the race window where a
  // co-organizer toggle between a separate read and write would produce a stale value.
  const { data: updatedSession, error: updateErr } = await db
    .from("sessions")
    .update({ max_auto_drafts_override: cap })
    .eq("id", sessionId)
    .select("is_auto_matchmaking_on")
    .single();

  if (updateErr) {
    return { success: false, error: `Failed to save cap: ${updateErr.message}` };
  }

  const autoIsOn = updatedSession?.is_auto_matchmaking_on ?? false;

  if (!autoIsOn) {
    // Auto is OFF — just saved the preference, nothing to clear.
    return { success: true, autoIsOn: false, clearedCount: 0 };
  }

  const clearResult = await clearAllUnpublishedDrafts(sessionId);

  if (!clearResult.success) {
    // Clearing failed — broadcast 'done' so all organizer screens unlock.
    void broadcastDraftCapPhase(sessionId, "done", cap);
    return { success: false, error: clearResult.message };
  }

  return {
    success: true,
    autoIsOn: true,
    clearedCount: clearResult.clearedCount,
  };
}

// ── toggleAutoPublish ─────────────────────────────────────────

export type ToggleAutoPublishResult = {
  success: boolean;
  isOn: boolean;
  message: string;
  /** Drafts cleared on an ON flip (D3). 0 on OFF flips and when nothing pending. */
  clearedCount?: number;
};

/**
 * Flips the `auto_publish` mode for a session.
 *
 *   ON  (D3): persist auto_publish=true, then — when Auto-Matchmaking is ON —
 *             clear all unpublished drafts (return players to waiting) and re-run
 *             the engine, which now writes matches straight to On Deck. Fills
 *             immediately (D8).
 *   OFF (D4): persist auto_publish=false only. Live published on-deck matches are
 *             committed and left untouched; the engine generates drafts for the
 *             NEXT batch.
 *
 * Auto-publish is meaningless while Auto-Matchmaking is OFF (the engine never
 * runs), so the UI disables this toggle in that state (D11). Defensively, an ON
 * flip while Auto-Matchmaking is OFF persists the preference but skips the
 * clear-and-rerun — there is nothing to regenerate against.
 *
 * Takes an explicit target (not an atomic flip) so the result is deterministic
 * under concurrent organizer clicks — last write wins, mirroring setCapAndClearDrafts.
 */
export async function toggleAutoPublish(
  sessionId: string,
  enabled: boolean
): Promise<ToggleAutoPublishResult> {
  if (!isValidUUID(sessionId)) {
    return { success: false, isOn: false, message: "Invalid session ID." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, isOn: false, message: "Not authenticated." };

  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) {
    return { success: false, isOn: false, message: "Organizer access required." };
  }

  const db = createServiceClient();

  // Persist the new mode and read is_auto_matchmaking_on atomically — closes the
  // read→write race where a co-organizer toggle lands between a separate read and write.
  const { data: updatedSession, error: updateErr } = await db
    .from("sessions")
    .update({ auto_publish: enabled })
    .eq("id", sessionId)
    .select("auto_publish, is_auto_matchmaking_on")
    .single();

  if (updateErr) {
    return {
      success: false,
      isOn: false,
      message: `Failed to save auto-publish: ${updateErr.message}`,
    };
  }
  if (!updatedSession) {
    return { success: false, isOn: false, message: "Session not found." };
  }

  const autoMmOn = updatedSession.is_auto_matchmaking_on ?? false;

  // Broadcast the new state to co-organizers regardless of the path taken.
  // Fire-and-forget: broadcast failure never affects the DB result.
  broadcastAutoPublishToggled(sessionId, enabled).catch((err) => {
    console.warn("[toggleAutoPublish] broadcast failed (non-fatal):", err);
  });

  if (!enabled) {
    // OFF flip (D4): leave live on-deck matches alone, engine drafts going forward.
    return { success: true, isOn: false, message: "Auto-publish disabled." };
  }

  // ON flip (D3). Only meaningful while the engine can run.
  if (!autoMmOn) {
    return {
      success: true,
      isOn: true,
      message: "Auto-publish enabled — it takes effect once Auto-Matchmaking is on.",
      clearedCount: 0,
    };
  }

  // Clear unpublished drafts so the engine can regenerate them as published
  // on-deck matches against the cap, then run it immediately (D8).
  const clearResult = await clearAllUnpublishedDrafts(sessionId);
  if (!clearResult.success) {
    return { success: false, isOn: true, message: clearResult.message };
  }

  await runEngineForSession(sessionId);

  return {
    success: true,
    isOn: true,
    message: "Auto-publish enabled.",
    clearedCount: clearResult.clearedCount,
  };
}

// ── getSessionForOrganizer ────────────────────────────────────

export type GetSessionResult = {
  success: boolean;
  session?: import("@/types/database").Session;
  error?: string;
};

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

  // isSessionOrganizer does the created_by fast-path + session_organizers
  // fallback in a single helper — no need for a separate existence fetch.
  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) return { success: false, error: "Not authorized. Organizer access required." };

  // ── Fetch full session row ────────────────────────────────────
  const { data, error } = await service.from("sessions").select("*").eq("id", sessionId).single();

  if (error || !data) {
    return { success: false, error: error?.message ?? "Session not found." };
  }

  return { success: true, session: data };
}

export type CloseSessionResult = {
  success: boolean;
  message: string;
  /** true when compute_session_wrapped succeeded and Wrapped pages are ready. */
  wrappedReady?: boolean;
};

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
  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
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

  // ── 1–3. Independent cleanups (different tables, no interdependency) run
  //         in parallel: cancel lingering matches, mark queue entries "left"
  //         (preserving history), and close courts. Direct filtered UPDATEs —
  //         skipping the SELECTs avoids the gap where new rows could be
  //         inserted between SELECT and UPDATE. 3 serial round trips → 1.
  const [cancelResult] = await Promise.all([
    supabase
      .from("matches")
      .update({ status: "cancelled" as const }, { count: "exact" })
      .eq("session_id", sessionId)
      .in("status", ["pending", "in_progress"]),
    supabase
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", sessionId)
      .in("status", ["waiting", "drafted", "on_deck", "playing"]),
    supabase
      .from("courts")
      .update({ status: "closed" as const })
      .eq("session_id", sessionId),
  ]);
  const cancelledCount = cancelResult.count;

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
