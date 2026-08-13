"use server";

// ============================================================
// Session Lifecycle — Server Actions
// ============================================================
// createSession        — creates a new session with uniqueness-
//                        enforced passcode (auto-generated if blank)
// joinAsCoOrganizer    — co-organizer joins using ONLY the passcode
// closeSession         — archives an active session
// applyDraftCapOverride — saves the max-draft cap and, when Auto is ON,
//                        clears drafts + re-runs the engine, emitting the
//                        co-organizer lockout broadcasts around that work
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
import type { DraftCapPhase } from "@/lib/broadcast";
import { clearAllUnpublishedDrafts } from "@/app/actions/match-drafts";
import { isSessionOrganizer, isSessionActive, getActorContext } from "@/app/actions/_shared";
import { isClubAdmin } from "@/lib/clubs";
import { isValidUUID } from "@/lib/validate";
import { getClientIp } from "@/lib/client-ip";
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
  /** Set when creation was refused because another active session was just
   *  created in the same club — the one the caller should join instead. */
  existingSessionId?: string;
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

  // ── Duplicate-creation guard ──────────────────────────────
  // 07/25 incident: two organizers created "the" Saturday session 343 ms
  // apart; three players checked into the wrong one and were dumped when it
  // was closed. A second ACTIVE session in the same club within this window
  // is far more likely a race than intent, so refuse it and point the caller
  // at the existing one. The window is long enough to cover "both organizers
  // tap Create as the gym opens" and short enough to never block a genuine
  // second session later in the day.
  //
  // Best-effort SELECT-then-INSERT: a sub-commit-latency tie can still slip
  // through (closing that fully needs a DB constraint, and time-window
  // uniqueness can't be expressed as an index). This catches the realistic
  // human race; the 343 ms real one would have been caught.
  // is_hidden=false keeps the E2E sandbox session out of the guard.
  const DUPLICATE_SESSION_WINDOW_MS = 10 * 60_000;
  const dupCutoff = new Date(Date.now() - DUPLICATE_SESSION_WINDOW_MS).toISOString();
  const { data: justCreated } = await service
    .from("sessions")
    .select("id, name")
    .eq("club_id", clubId)
    .eq("is_active", true)
    .eq("is_hidden", false)
    .gte("created_at", dupCutoff)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (justCreated) {
    return {
      success: false,
      message: `"${justCreated.name}" was created in this club moments ago — join it instead of starting a duplicate.`,
      existingSessionId: justCreated.id,
    };
  }

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
/** Failed attempts allowed for one ACCOUNT before lockout, within the window. */
const JOIN_MAX_FAILED_USER = 10;
/**
 * Failed attempts allowed for one IP before lockout, within the window.
 *
 * Deliberately far above the per-account limit. A badminton club is the
 * canonical single-NAT environment — the whole venue shares one gym Wi-Fi, and
 * mobile users share CGNAT — so a tight IP budget is a griefing DoS: a handful
 * of co-organizers fumbling a 9-character code, or one malcontent on the venue
 * network, would lock co-organizer join for everyone. 60/15min is still far
 * below what brute-forcing a 100k-combination passcode needs (~17 days from a
 * single IP) while sitting well clear of plausible venue traffic.
 */
const JOIN_MAX_FAILED_IP = 60;
/** Rolling lockout window, minutes. */
const JOIN_WINDOW_MIN = 15;

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
  // One RPC records the attempt and returns the in-window verdict in a SINGLE
  // transaction. A read-then-write pair let concurrent serverless invocations
  // all observe a sub-threshold count and pass together, and a swallowed insert
  // error silently disabled the limiter. This is atomic and FAIL-CLOSED: any
  // error denies the join rather than waving it through.
  const ip = await getClientIp();
  const { data: gate, error: gateErr } = await service
    .rpc("cojoin_record_and_check", {
      p_user_id: user.id,
      p_ip: ip,
      p_window_min: JOIN_WINDOW_MIN,
      p_user_max: JOIN_MAX_FAILED_USER,
      p_ip_max: JOIN_MAX_FAILED_IP,
    })
    .maybeSingle();

  if (gateErr || !gate) {
    console.error("[joinAsCoOrganizer] rate-limit check failed:", gateErr?.message);
    return { success: false, message: LOCKED };
  }
  if (gate.over_user_limit || gate.over_ip_limit) {
    // Log WHICH arm fired so support can tell shared-venue-IP exhaustion apart
    // from a genuine per-account brute force.
    console.warn(
      `[joinAsCoOrganizer] locked out (user=${gate.over_user_limit} ip=${gate.over_ip_limit})`
    );
    return { success: false, message: LOCKED };
  }

  // The attempt above was recorded pessimistically as a failure; flip it once a
  // passcode actually matches so legitimate joins don't burn the window.
  // attempt_id is null only on the over-limit path, which returned above.
  const attemptId = gate.attempt_id;
  const markAttemptSucceeded = async () => {
    if (!attemptId) {
      // Unreachable: null only comes back on the over-limit path, which
      // returned above. Warn rather than no-op silently — a broken contract
      // here would quietly burn a legitimate organizer's budget.
      console.warn("[joinAsCoOrganizer] no attempt id to flip — limiter contract changed?");
      return;
    }
    // Destructure the error rather than using .then(onRejected): a PostgREST
    // builder RESOLVES with { data, error } on a DB error and only rejects on a
    // transport throw, so a rejection handler here would be dead code — and a
    // silently-failed flip leaves a legitimate join logged as a failure,
    // burning one of the caller's 10-per-15-min slots with nothing in the log.
    const { error } = await service
      .from("co_organizer_join_attempts")
      .update({ succeeded: true })
      .eq("id", attemptId);
    if (error) {
      console.error("[joinAsCoOrganizer] attempt-log update failed:", error.message);
    }
  };

  // Exact match — ILIKE would allow SQL wildcard characters (%, _) to
  // match unintended sessions. The passcode is already normalised to
  // uppercase so case-insensitivity is not needed here.
  const { data: session } = await service
    .from("sessions")
    .select("id, created_by")
    .eq("is_active", true)
    .eq("organizer_passcode", normalized)
    .maybeSingle();

  // The pessimistic attempt row is already logged as a failure — nothing to do.
  if (!session) return { success: false, message: INVALID };

  // Prevent the primary organizer from joining their own session. The passcode
  // was CORRECT, so clear the pessimistic failure — the limiter exists to
  // punish wrong guesses, not an organizer typing their own code.
  if (session.created_by === user.id) {
    await markAttemptSucceeded();
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
    await markAttemptSucceeded();
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

  // A correct passcode: clear the pessimistic failure and let the caller in.
  await markAttemptSucceeded();
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

  // A co-organizer whose board never learned the session closed can still hit
  // this toggle. Flipping it ON would then run the engine against a closed
  // session, drafting matches for players who have already gone home.
  if (!(await isSessionActive(sessionId))) {
    return { success: false, isOn: false, message: "This session has ended." };
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

// ── applyDraftCapOverride ─────────────────────────────────────
// Single server-owned orchestration of a draft-cap change:
//   gate → persist → clear → engine → all three lockout broadcasts.
//
// Replaces setCapAndClearDrafts plus the client-side three-phase emit, which
// never worked: src/lib/broadcast.ts was reachable from the browser bundle,
// where SUPABASE_SERVICE_ROLE_KEY is undefined, so every phase was dropped at
// the missing-key guard and the co-organizer lockout overlay never engaged.
//
// ONE action, not two, because the process that TAKES the lock must be the
// process that RELEASES it. With a client-orchestrated split, a tab closed
// between phase 1 and phase 2 leaves every co-organizer locked with no 'done'
// ever coming.

// NOT exported: a "use server" module may only export async functions
// (see _shared.ts:19-22). The receiver clamps this into its own bounds
// independently, which also means the lease can be retuned server-side without
// shipping a client deploy.
const CAP_PHASE_LOCK_TTL_MS = 45_000;

export type ApplyDraftCapResult = {
  success: boolean;
  message?: string;
  error?: string;
  /** Whether auto-matchmaking was ON — i.e. whether the engine actually ran. */
  autoIsOn?: boolean;
  clearedCount?: number;
};

/**
 * Save the organizer's max-draft override and, when Auto is ON, clear all
 * unpublished drafts and re-run the engine against the new cap — emitting the
 * clearing/generating/done lockout broadcasts around that work so every OTHER
 * organizer's dashboard locks and unlocks in step.
 *
 * SECURITY — this is deliberately NOT a general-purpose emit endpoint. There is
 * no `phase` parameter and there must never be one: the phase strings are
 * server-side literals, so no authorized caller can emit a lock without its
 * matching unlock. A `broadcastCapPhaseAction(sessionId, phase)` would recreate,
 * behind a gate, exactly the forgery capability that migration 20260723100000
 * closed by refusing an INSERT policy on realtime.messages.
 *
 * `opId` is minted by the calling tab so it can recognise (and ignore) its own
 * echo — the REST broadcast has no sending socket, so Realtime fans every
 * message back to the actor too. It is validated as a UUID and only ever echoed.
 */
export async function applyDraftCapOverride(
  sessionId: string,
  cap: number | null,
  opId: string
): Promise<ApplyDraftCapResult> {
  // Gate order is load-bearing: uuid → bounds → opId → auth → organizer.
  // Nothing below emits until all of them have passed.
  if (!isValidUUID(sessionId)) {
    return { success: false, error: "Invalid session ID." };
  }
  // Validate cap: null = dynamic, 1–5 = override ceiling.
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 5)) {
    return { success: false, error: "Cap must be null or an integer between 1 and 5." };
  }
  if (!isValidUUID(opId)) {
    return { success: false, error: "Invalid operation ID." };
  }

  // Auth, authorization and the cap write share ONE try/catch: client
  // construction and PostgREST transport can both throw, and CLAUDE.md forbids
  // throwing out of a server action — the caller would get a network-shaped
  // rejection instead of a result. Collapsing them into a single handler is safe
  // precisely because this whole span is emit-free (see the box below): no path
  // through it can leave anyone holding a lock.
  let actor: Awaited<ReturnType<typeof getActorContext>>;
  let autoIsOn: boolean;
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Not authenticated." };

    // Independent lookups → run in parallel. The denial message is uniform:
    // isSessionOrganizer returns false for both "not yours" and "does not exist",
    // so a distinct message would turn this into a session-UUID existence oracle.
    const [isOrganizer, actorContext] = await Promise.all([
      isSessionOrganizer(user.id, sessionId),
      getActorContext(user.id),
    ]);
    if (!isOrganizer) return { success: false, error: "Organizer access required." };
    actor = actorContext;

    // Persist the override and read is_auto_matchmaking_on atomically in one
    // UPDATE...RETURNING statement. This eliminates the race window where a
    // co-organizer toggle between a separate read and write would produce a stale value.
    const { data: updatedSession, error: updateErr } = await createServiceClient()
      .from("sessions")
      .update({ max_auto_drafts_override: cap })
      .eq("id", sessionId)
      .select("is_auto_matchmaking_on")
      .single();

    if (updateErr) {
      // Nothing was locked — emit nothing.
      return { success: false, error: `Failed to save cap: ${updateErr.message}` };
    }

    autoIsOn = updatedSession?.is_auto_matchmaking_on ?? false;
  } catch (err) {
    console.error("[applyDraftCapOverride] pre-flight failed:", err);
    return { success: false, error: "Couldn't save the draft cap. Please try again." };
  }

  // ┌──────────────────────────────────────────────────────────────────────┐
  // │ NOTHING ABOVE THIS LINE EMITS. Every rejection path is emit-free, so  │
  // │ a failed or forged call can never leave anyone holding a lock.        │
  // └──────────────────────────────────────────────────────────────────────┘

  // Every emit is AWAITED, not void'd. Two reasons: (1) ordering — POST N+1 is
  // not issued until N has been ingested, so a 'done' cannot overtake its
  // 'clearing' and strand every co-organizer behind an overlay that has no
  // dismiss control; (2) Vercel freezes the instance once the response is sent,
  // so a trailing void'd fetch can be killed mid-flight. postBroadcast never
  // rejects; the .catch keeps that true even if that ever changes, so no emit
  // can break this action's return contract.
  const emit = (phase: DraftCapPhase) =>
    broadcastDraftCapPhase(sessionId, phase, cap, {
      opId,
      actorId: actor.id,
      actorName: actor.name,
      ttlMs: CAP_PHASE_LOCK_TTL_MS,
    }).catch((err) => {
      console.warn("[applyDraftCapOverride] broadcast failed (non-fatal):", phase, err);
    });

  if (!autoIsOn) {
    // Auto is OFF: the preference is stored, nothing was cleared, nothing
    // regenerated — so NO lock is taken. A lone terminal 'done' is emitted
    // purely so every co-organizer refetches and their cap chip converges. It
    // is inversion-proof precisely because no 'clearing' is ever emitted here.
    await emit("done");
    return { success: true, autoIsOn: false, clearedCount: 0 };
  }

  await emit("clearing");

  try {
    // Wrapped like the engine call below, and for the same reason: CLAUDE.md
    // forbids throwing out of a server action. Without this, a PostgREST/fetch
    // failure inside the clear would emit 'done' from the finally and then
    // REJECT — the caller gets a network-shaped error rather than a result.
    let clearResult: Awaited<ReturnType<typeof clearAllUnpublishedDrafts>>;
    try {
      clearResult = await clearAllUnpublishedDrafts(sessionId);
    } catch (err) {
      console.error("[applyDraftCapOverride] clearAllUnpublishedDrafts threw:", err);
      return { success: false, autoIsOn: true, error: "Failed to clear drafts." };
    }
    if (!clearResult.success) {
      return { success: false, autoIsOn: true, error: clearResult.message };
    }

    await emit("generating");

    try {
      await runEngineForSession(sessionId);
    } catch (err) {
      // Best-effort. The cap is persisted and the drafts are cleared — both
      // organizer-visible guarantees already hold — and the next queue mutation
      // re-runs the engine anyway. CLAUDE.md: never throw out of a server action.
      console.error("[applyDraftCapOverride] engine threw unexpectedly:", err);
    }

    return {
      success: true,
      autoIsOn: true,
      clearedCount: clearResult.clearedCount,
      message: `Draft cap applied. ${clearResult.clearedCount} draft(s) cleared.`,
    };
  } finally {
    // THE single unlock point for the locked region. Covers the clear-failure
    // early return, the engine path, and any unexpected throw. An async
    // function's promise does not settle until its finally completes, so this
    // POST is on the wire BEFORE the HTTP response and cannot be lost to
    // post-response instance suspension. Do NOT move this into after():
    // after() work that fails cannot report back, and 'done' must not be
    // best-effort — it is what releases every co-organizer's dashboard.
    await emit("done");
  }
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
 * under concurrent organizer clicks — last write wins, mirroring applyDraftCapOverride.
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

// ── getPlayerSessionStatus ────────────────────────────────────

export type PlayerSessionStatusResult =
  | {
      success: true;
      isActive: boolean;
      /**
       * Whether THIS caller has a `session_wrapped_stats` row for the session,
       * i.e. whether a redirect to Wrapped would render a real recap.
       *
       * Only meaningful when `isActive` is false — it is always false while the
       * session is still running, because the rows are written at close.
       */
      hasWrapped: boolean;
    }
  | { success: false; error: string };

/**
 * Reports whether a session is still running, for the player side.
 *
 * Why this exists: `session_closed` used to reach players over the broadcast
 * channel and nowhere else. Nothing the player dashboard polls carries the
 * fact — useSessionData reads `courts` and `queue_entries`, never the session
 * row — so a player whose channel never joined (or dropped across the exact
 * moment the organizer closed) sat on a frozen dashboard indefinitely.
 * useOrganizerBroadcast now calls this as a slow fallback. See
 * PENDING_WORK_2026-07-23.md §2.3.
 *
 * Why a server action rather than a client read: `sessions_select` is
 * `is_session_organizer(id) OR is_club_member(club_id)`. Every client that can
 * mount the caller has already passed the club layout's membership gate, so
 * that predicate holds for them AT MOUNT — but it is not a property of the
 * player, it is a property of a row that can change under them. If an admin
 * soft-removes a member (`club_members.is_active = false`) mid-session, the
 * predicate starts failing AND `session_access_level` goes NULL, so the private
 * broadcast channel refuses the join at the same instant. That player is
 * stranded on both paths, and only an RLS-bypassing read can answer them. The
 * action returns a single boolean, never the row (which carries
 * organizer_passcode).
 *
 * Not covered, deliberately: a de-authed client. The `getUser()` gate below and
 * the `TO authenticated` channel policy fail together, so this is a fallback
 * for a dead CHANNEL, not for a dead SESSION. Auth loss has its own recovery
 * path (APP_MANIFEST §3.26) and a `sessions` read is not the place to re-solve
 * it — reporting "closed" to someone whose token merely expired would eject
 * them from a live session.
 *
 * Disclosure: an authenticated caller who already knows a session UUID learns
 * only whether it is active. `lookup_active_session` already exposes almost the
 * same bit to anon for the QR-join path — with ONE genuine delta: it carries
 * `AND s.is_active = true`, so it collapses "closed session" and "no such
 * session" into the same empty answer, whereas this action distinguishes them
 * (`isActive: false` vs. `isActive: null`). That is one bit, to an
 * authenticated caller, about a UUID they already hold — accepted, not nil.
 * Booked in PENDING_WORK_2026-07-23.md §4 alongside the other `"use server"`
 * oracles.
 */
export async function getPlayerSessionStatus(
  sessionId: string
): Promise<PlayerSessionStatusResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };

  const userClient = await createServerSupabaseClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  let service: ReturnType<typeof createServiceClient>;
  try {
    service = createServiceClient();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const { data, error } = await service
    .from("sessions")
    .select("is_active")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) return { success: false, error: "Failed to read session status." };
  // No row: treat as unknown, not as closed. The caller navigates only on a
  // definite `isActive: false`, so an ambiguous answer holds the dashboard
  // rather than yanking a player out of a session that is still live.
  if (!data) return { success: false, error: "Session not found." };

  // Still running: nothing has been computed yet, so skip the second read.
  if (data.is_active) return { success: true, isActive: true, hasWrapped: false };

  // Closed: does a recap actually exist for this caller? Scoped to
  // `user.id` — never a caller-supplied player id — so this cannot be used to
  // probe whether some other player attended.
  const { data: wrapped, error: wrappedError } = await service
    .from("session_wrapped_stats")
    .select("id")
    .eq("session_id", sessionId)
    .eq("player_id", user.id)
    .maybeSingle();

  // A failed lookup must not strand the player on a dead board. Fall back to
  // "no recap", which routes them to the club lobby — a page that always
  // renders — instead of a Wrapped page that may be all zeros.
  return { success: true, isActive: false, hasWrapped: !wrappedError && Boolean(wrapped) };
}

export type CloseSessionResult = {
  success: boolean;
  message: string;
  /** true when compute_session_wrapped succeeded and Wrapped pages are ready. */
  wrappedReady?: boolean;
  /**
   * true when the Realtime API accepted the `session_closed` broadcast.
   *
   * false does NOT mean the close failed — the session row is committed either
   * way. It means the fast path to every connected phone did not go out, so
   * players will be moved by the slower fallbacks (their `sessions` row
   * subscription, or the status poll) instead of instantly. The organizer's UI
   * uses this to say so, and to offer `renotifySessionClosed`.
   */
  delivered?: boolean;
  /**
   * true when the close was refused because the session was ALREADY closed.
   *
   * The organizer's UI treats this as a success — a double-submit, or a
   * co-organizer who closed it first, is not an error the organizer can act on,
   * and showing "Session is already closed." in red next to a board that is
   * genuinely finished is the wrong story. An explicit flag rather than
   * matching on `message`, so re-wording the copy cannot silently turn this
   * back into a red toast.
   */
  alreadyClosed?: boolean;
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

  // Construct the service client BEFORE the organizer gate, even though the
  // gate must precede every *lookup*. Building it reveals nothing about
  // sessionId, and isSessionOrganizer calls createServiceClient() itself,
  // unguarded (_shared.ts). With SUPABASE_SERVICE_ROLE_KEY missing, gating
  // first would throw out of this action instead of returning the documented
  // { success: false, message } shape — and would leave this try/catch, which
  // exists for exactly that case, unreachable.
  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }

  // ── Organizer check — BEFORE any lookup keyed on sessionId ───
  // Order matters, not just presence. This gate used to sit below the
  // fetch, which handed any authenticated caller holding a session UUID a
  // three-way oracle: "Session not found." (does not exist) vs "Session is
  // already closed." (exists, closed) vs "Not authorized." (exists, active,
  // someone else's). isSessionOrganizer returns false for both "not yours"
  // and "does not exist", so gating first collapses all three into one
  // answer. Same rule as `applyDraftCapOverride` (above its Promise.all), and
  // renotifySessionClosed's gate-before-LOOKUP order — that axis only.
  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  // Verify the session is currently active. Only an organizer reaches here,
  // so both branches below are safe to distinguish.
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, is_active")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return { success: false, message: "Session not found." };
  }
  if (!session.is_active) {
    return { success: false, message: "Session is already closed.", alreadyClosed: true };
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
  // not Supabase-level errors. We check { error } explicitly and
  // retry once, EXCEPT when retrying is provably pointless (below).
  let wrappedReady = false;
  {
    const { error: rpcError } = await supabase.rpc("compute_session_wrapped", {
      p_session_id: sessionId,
    });
    if (rpcError) {
      // 57014 = statement timeout, 55P03 = lock_not_available. Both mean the
      // 8 s budget was spent waiting on the per-club advisory lock this RPC
      // takes; an immediate retry queues behind the same holder and burns
      // another 8 s (plus the 600 ms sleep) before failing identically. The
      // organizer is holding a spinner for all of it, so we stop here and let
      // wrappedReady=false drive the fallback instead.
      if (rpcError.code === "57014" || rpcError.code === "55P03") {
        console.error(
          `[closeSession] compute_session_wrapped timed out (${rpcError.code}) — not retrying; Wrapped will be empty until recomputed:`,
          rpcError.message
        );
      } else {
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
      }
    } else {
      wrappedReady = true;
    }
  }

  // ── 1. Mark session as inactive ────────────────────────────
  // ORDERING (changed 2026-08-11): the flip and the broadcast now come BEFORE
  // the cleanups, not after. The cleanups below cancel every live match, mark
  // every queue entry "left" and close every court — on a full night that is
  // ~30 postgres_changes events fanned out to ~40 phones. Running them first
  // meant players watched their queue position and their in-progress match
  // evaporate while the session still read ACTIVE and nothing had told them
  // why. That is the "I got kicked out of the queue" report. Announcing the
  // close first makes the teardown legible: every client has already latched
  // onto "session over" before the first row disappears.
  //
  // Wrapped is still computed above, so the invariant the old order existed to
  // protect — rows exist before anyone is sent to /wrapped — is unchanged.
  //
  // The failure mode also improves. Before: cleanups applied but the session
  // left active if the flip failed (a half-torn-down session nobody was told
  // about). Now: session closed but rows possibly stale — invisible, because a
  // closed session's board is unreachable, and joinQueueAction refuses to add
  // anything back.
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

  // ── 2. Broadcast session_closed to all connected players ───
  // Emitted the instant the session row is committed. Retried once inside the
  // helper; `delivered` is reported back so the organizer's UI can say so
  // rather than claiming a clean close that no phone heard.
  const delivered = await broadcastSessionClosed(sessionId, wrappedReady);

  // ── 3. Independent cleanups (different tables, no interdependency) run
  //       in parallel: cancel lingering matches, mark queue entries "left"
  //       (preserving history), and close courts. Direct filtered UPDATEs —
  //       skipping the SELECTs avoids the gap where new rows could be
  //       inserted between SELECT and UPDATE. 3 serial round trips → 1.
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

  return {
    success: true,
    message: `Session closed. ${cancelledCount ?? 0} match(es) cancelled, all players removed from queue.`,
    wrappedReady,
    delivered,
  };
}

/**
 * Re-emit `session_closed` for an ALREADY-CLOSED session.
 *
 * The escape hatch for the one failure the close flow cannot self-heal: the
 * broadcast POST failed (both attempts), so the session is closed in the
 * database but nobody's phone was told. Without this the organizer's only
 * remedy is to wait out each player's 20 s status poll — or to walk the gym.
 *
 * Deliberately a SEPARATE action rather than loosening closeSession's
 * `is_active` guard. That guard is what makes closeSession non-repeatable, and
 * re-running it on a closed session would re-run compute_session_wrapped over
 * a *changed* club-wide ledger — which is not idempotent and can silently
 * revoke awards it previously granted (see the cross-session-stats notes in
 * APP_MANIFEST). This action only re-sends a message.
 */
export async function renotifySessionClosed(
  sessionId: string
): Promise<{ success: boolean; message: string }> {
  if (!isValidUUID(sessionId)) return { success: false, message: "Invalid session ID." };

  const userClient = await createServerSupabaseClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("is_active")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !session) return { success: false, message: "Session not found." };
  // Only ever announces a fact that is already true.
  if (session.is_active) {
    return { success: false, message: "Session is still open — nothing to re-announce." };
  }

  const { count } = await supabase
    .from("session_wrapped_stats")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);

  const delivered = await broadcastSessionClosed(sessionId, (count ?? 0) > 0);
  return delivered
    ? { success: true, message: "Players notified." }
    : { success: false, message: "Realtime is unreachable — players will catch up on their own." };
}
