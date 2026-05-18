"use server";

// ============================================================
// Enterprise Matchmaking Engine — Server Actions (Orchestrator)
// ============================================================
//
// Pipeline: Queue → On Deck → Active Court
// -----------------------------------------
// The engine is PURELY an on-deck filler. It never places
// players directly onto courts. Court assignment happens only
// via promoteOnDeckMatchInternal when a court frees up.
//
// Engine entry points (all check the toggle before running):
//   runEngineForSession(sessionId)   — called by: toggle-ON,
//     joinQueue, endMatch, clearOnDeck, callNextMatch
//
// Organizer surface:
//   callNextMatch(sessionId, courtId)  — promote oldest on-deck;
//     if none, run engine inline then retry once.
//
// Internal only:
//   runEngineInternal(supabase, sessionId) — capacity-limited
//     on-deck filler; orchestrates data-fetch + pure algorithm + commit.
//   promoteOnDeckMatchInternal — CAS promote, player status updates.
//
// Module boundaries:
//   matchmaking-core.ts — pure algorithm (runAlgorithm, scoreAndSortPool,
//     snakeDraft, scoreCandidates, etc.). Zero DB calls, zero side effects.
//   matchmaking-db.ts   — DB helpers (fetchActivePool, buildOverlapMap,
//     fetchPartnershipCounts, fetchRecentRosters, executeMatch).
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastCapSaturation } from "@/lib/broadcast";
import {
  PLAYERS_PER_MATCH,
  RED_ZONE_SCORE_FLOOR,
  CRITICAL_WAIT_MINUTES,
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
  MAX_AUTO_DRAFTS,
  MIN_FREE_POOL_FOR_ON_DECK,
} from "@/lib/constants";
import { runAlgorithm, scoreAndSortPool } from "@/lib/matchmaking-core";
import {
  fetchActivePool,
  fetchRecentRosters,
  fetchPartnershipCounts,
  buildOverlapMap,
  executeMatch,
} from "@/lib/matchmaking-db";
import { isSessionOrganizer } from "@/app/actions/_shared";
import { isValidUUID } from "@/lib/validate";

// ── Process-level concurrency guard ──────────────────────────
// Tracks session IDs for which the engine is currently running
// within this process. If a second invocation arrives for the
// same session while the first is still in-flight (e.g. two
// players join within milliseconds of each other), the second
// call is a no-op — the first run will already produce the
// correct on-deck state when it finishes.
//
// Scope: single Node.js process only — this Set has no effect in
// multi-process or serverless deployments (e.g. Vercel, where each
// request may land on a different worker).
//
// Cross-process serialisation is now enforced at the DB layer:
// create_match_with_players (migration 20260507000000) acquires a
// row-level lock (SELECT … FOR UPDATE ORDER BY player_id) on the
// target queue_entries rows before checking for conflicts in
// match_players. A second concurrent transaction blocks at the lock
// and then hits the conflict check — returning NULL — once the first
// commits. executeMatch treats NULL as a graceful slot-skip.
const engineRunningFor = new Set<string>();

export interface MatchmakingResult {
  success: boolean;
  matchId?: string;
  message: string;
  /**
   * Names of matched players for the toast notification.
   * Populated by promoteOnDeckMatchInternal (court-promote path).
   * NOT populated by runEngineInternal (on-deck fill path — ExecuteMatchResult
   * is intentionally narrower and callers don't surface team names for fills).
   */
  teamA?: string[];
  teamB?: string[];
  /** True when the match spans a wider-than-normal skill window (mixed level). */
  isMixedLevel?: boolean;
  /**
   * Draft Mode: true when there are no published on-deck matches to
   * promote because all pending matches are drafts. Callers surface
   * an amber "review drafts" warning toast instead of the normal
   * "no match available" message.
   */
  hasDraftsBlocking?: boolean;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: callNextMatch
// ─────────────────────────────────────────────────────────────
// Organizer clicks "Call Next Match" on a court card.
// Step 1: promote the oldest on-deck match.
// Step 2: if none exists and toggle is ON, run engine inline
//   to form one from the queue, then retry promotion once.
// Always triggers engine after success so the slot is refilled.

export async function callNextMatch(
  sessionId: string,
  courtId: string
): Promise<MatchmakingResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(courtId)) {
    return { success: false, message: "Invalid session or court ID." };
  }

  // ── Organizer authorization gate ──────────────────────────────
  // Without this, any authenticated user could POST to this server
  // action with an arbitrary sessionId/courtId and force the engine
  // to run + promote a match on a court they have no rights to.
  // The downstream engine now uses the service-role client (see
  // runEngineForSession) so RLS no longer rescues us — the gate
  // must live here, in the public entry point.
  const userClient = await createServerSupabaseClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const isOrganizer = await isSessionOrganizer(user.id, sessionId);
  if (!isOrganizer) {
    return { success: false, message: "Not authorized. Organizer access required." };
  }

  const service = createServiceClient();

  // 1. Try to promote an existing on-deck match.
  let promoted = await promoteOnDeckMatchInternal(service, sessionId, courtId);
  if (promoted.success) {
    // Refill the on-deck slot we just consumed.
    await runEngineInternal(service, sessionId);
    return promoted;
  }

  // 2. No on-deck match — check toggle.
  // Must use the service client: the sessions table RLS SELECT policy only
  // grants read to sessions.created_by, so co-organizers would silently
  // receive null from an RLS-scoped client.
  const { data: session } = await service
    .from("sessions")
    .select("is_auto_matchmaking_on")
    .eq("id", sessionId)
    .single();

  if (!session?.is_auto_matchmaking_on) {
    return {
      success: false,
      message: "No on-deck matches. Auto-matchmaking is paused — create one manually.",
    };
  }

  // 3. Toggle ON: run engine now, then retry promotion.
  // bypassGate=true: organizer explicitly requested a match — don't let the
  // soft gate defer it. Serve the best available group immediately.
  await runEngineInternal(service, sessionId, true);
  promoted = await promoteOnDeckMatchInternal(service, sessionId, courtId);
  if (promoted.success) return promoted;
  // Surface the draft-blocking signal so the organizer sees "review drafts"
  // rather than the generic "not enough players" when drafts are the real reason.
  if (promoted.hasDraftsBlocking) return promoted;

  return {
    success: false,
    message: "Not enough players in the queue to form a match.",
  };
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: runEngineForSession
// ─────────────────────────────────────────────────────────────
// Called from: toggleAutoMatchmaking (ON), joinQueueAction,
// endMatchAction, clearOnDeckMatch.
// Checks the toggle itself — callers need not check it first.

export async function runEngineForSession(sessionId: string): Promise<void> {
  if (!isValidUUID(sessionId)) return; // malformed ID — silently no-op (internal helper)

  // Concurrency guard: skip if another invocation is already running
  // for this session in this process (e.g. two simultaneous queue joins).
  if (engineRunningFor.has(sessionId)) {
    console.log(`[engine] runEngineForSession: already in-flight for ${sessionId} — skipping`);
    return;
  }
  engineRunningFor.add(sessionId);

  try {
    // Use the SERVICE-ROLE client for the entire engine pipeline.
    //
    // Why: every caller of this function (toggleAutoMatchmaking, joinQueue,
    // endMatch, callNextMatch, clearOnDeck) already authenticates the user
    // and verifies they may operate on this session.  Once that check has
    // passed, the engine itself is internal infrastructure that needs full
    // read/write visibility into queue_entries, v_queue_with_wait_time,
    // matches, match_players, and courts — across rows whose RLS may not
    // grant SELECT to the calling user (e.g. anonymous queue history or
    // co-organizer-owned rows).
    //
    // Using the user-context client (createServerSupabaseClient) caused a hard-to-spot
    // bug in production: when toggleAutoMatchmaking enabled auto, the
    // engine read 0 waiting players from v_queue_with_wait_time even
    // though 30 were inserted, because the view's underlying RLS hid
    // them from the organizer's anon-equivalent JWT in some deployment
    // configs.  No INSERT INTO matches happened, the toggle silently
    // produced no on-deck matches, and the only signal in the UI was an
    // empty on-deck panel.  Switching to service role makes the engine
    // observable behavior match its specification: given waiting players
    // and open courts, it produces matches.
    //
    // Safety: this client never touches user-context state.  Authorization
    // is the caller's responsibility — do NOT call runEngineForSession
    // from anywhere that hasn't already gated the user.
    const supabase = createServiceClient();

    const { data: session, error: sessionErr } = await supabase
      .from("sessions")
      .select("is_auto_matchmaking_on")
      .eq("id", sessionId)
      .single();

    if (sessionErr) {
      console.error(
        `[engine] runEngineForSession: failed to read session ${sessionId} — ${sessionErr.message}`
      );
      return;
    }
    if (!session?.is_auto_matchmaking_on) {
      console.log(
        `[engine] runEngineForSession: toggle is OFF for session ${sessionId} — skipping`
      );
      return;
    }

    console.log(
      `[engine] runEngineForSession: toggle ON for session ${sessionId} — starting engine`
    );
    await runEngineInternal(supabase, sessionId);
  } finally {
    engineRunningFor.delete(sessionId);
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: runEngineInternal
// ─────────────────────────────────────────────────────────────
// Dynamic draft filler. Generates on-deck matches until the combined
// total of pending matches (published + unpublished) reaches MAX_AUTO_DRAFTS.
//
// slotsAvailable = max(0, MAX_AUTO_DRAFTS − totalPending)
//   totalPending is fetched in a single atomic query (no race between
//   published and draft sub-counts).
//   0 pending → up to 3 slots (pool diversity cap applies)
//   1 pending → up to 2 slots
//   2 pending → 1 slot
//   3 pending → 0 slots (at cap)
// Fills slots up to slotsAvailable, stopping when queue is exhausted.

async function runEngineInternal(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string,
  bypassGate = false
): Promise<void> {
  const { data: courts, error: courtsErr } = await supabase
    .from("courts")
    .select("id")
    .eq("session_id", sessionId)
    .neq("status", "closed");

  if (courtsErr) {
    console.error(`[engine] runEngineInternal: courts query failed — ${courtsErr.message}`);
    return;
  }

  const courtCount = courts?.length ?? 0;
  if (courtCount === 0) {
    console.log(`[engine] runEngineInternal: no open courts for session ${sessionId} — skipping`);
    return;
  }

  // Count all pending matches (published + unpublished) in one atomic query.
  // Using a single query rather than two sequential published/draft sub-counts
  // eliminates a narrow race window: if a draft were published between the two
  // queries, totalPending could be underestimated by 1, allowing a spurious
  // extra draft. The single query reads a consistent snapshot.
  const { count: totalPendingRaw, error: totalErr } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "pending");

  if (totalErr) {
    console.error(`[engine] runEngineInternal: pending count failed — ${totalErr.message}`);
    return;
  }

  const totalPending = totalPendingRaw ?? 0;
  const slotsAvailable = Math.max(0, MAX_AUTO_DRAFTS - totalPending);

  console.log(
    `[engine] runEngineInternal: courts=${courtCount} ` +
      `total=${totalPending} cap=${MAX_AUTO_DRAFTS} slots=${slotsAvailable}`
  );
  if (slotsAvailable <= 0) {
    console.log(
      `[engine] runEngineInternal: draft cap reached (${totalPending}/${MAX_AUTO_DRAFTS}) — skipping`
    );
    return;
  }

  // ── Soft gate + pool diversity cap ───────────────────────────
  //
  // Both checks share the same `v_queue_with_wait_time` query, so
  // it is fetched once inside the `!bypassGate` block and used for
  // both purposes. When bypassGate = true (organizer explicitly
  // clicked "Call Next Match"), both checks are skipped entirely.
  //
  // Soft gate: defer on-deck when pool is too small for cross-court mixing.
  //   Releases when: any player waits ≥ GATE_HOLD_MINUTES, any Red Zone,
  //   or no active matches exist.
  //
  // Pool diversity cap: from the 2nd slot onwards, ≥8 players must be
  //   waiting before committing another 4. Slot 0 is always exempt.
  //   After each successful generation, estimatedWaiting decrements by 4.

  let estimatedWaiting = 0; // populated below if !bypassGate

  if (!bypassGate) {
    const { data: waitingRows, error: waitErr } = await supabase
      .from("v_queue_with_wait_time")
      .select("wait_minutes")
      .eq("session_id", sessionId)
      .eq("status", "waiting");

    if (!waitErr && waitingRows) {
      estimatedWaiting = waitingRows.length;
      const waitingCount = estimatedWaiting;

      if (waitingCount > 0 && waitingCount <= GATE_POOL_THRESHOLD) {
        const maxWait = Math.max(...waitingRows.map((r) => (r.wait_minutes as number | null) ?? 0));
        const hasRedZone = maxWait >= CRITICAL_WAIT_MINUTES;
        const gateTimedOut = maxWait >= GATE_HOLD_MINUTES;

        if (!hasRedZone && !gateTimedOut) {
          const { count: activeCount, error: activeErr } = await supabase
            .from("matches")
            .select("id", { count: "exact", head: true })
            .eq("session_id", sessionId)
            .eq("status", "in_progress");

          if (!activeErr && (activeCount ?? 0) > 0) {
            console.log(
              `[engine] Soft gate active: pool=${waitingCount} ≤ ${GATE_POOL_THRESHOLD}, ` +
                `maxWait=${maxWait.toFixed(1)}min < ${GATE_HOLD_MINUTES}min, ` +
                `activeCourts=${activeCount} — deferring on-deck for cross-court mix`
            );
            return;
          }
        }
      }
    }
  }

  // Pre-fetch recent rosters once for the entire fill loop.
  // Stable snapshot: pending matches don't change ownership mid-run and
  // the process-level guard prevents concurrent engine runs per session.
  const recentRosters = await fetchRecentRosters(supabase, sessionId);

  for (let i = 0; i < slotsAvailable; i++) {
    // Pool diversity cap: from the 2nd slot onwards.
    if (!bypassGate && i > 0) {
      const minPool = PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK; // 8
      if (estimatedWaiting < minPool) {
        console.log(
          `[engine] Pool diversity cap at slot ${i + 1}: ` +
            `estimatedWaiting=${estimatedWaiting} < ${minPool} — stopping to preserve pool`
        );
        break;
      }
    }

    // ── Per-slot: fetch pool (changes as players are drafted) ────
    const rawPool = await fetchActivePool(supabase, sessionId);
    const pool = scoreAndSortPool(rawPool);

    if (pool.length < PLAYERS_PER_MATCH) {
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] runEngineInternal: stopping at slot ${i + 1} — ` +
            `only ${pool.length} waiting players, need ${PLAYERS_PER_MATCH}`
        );
      }
      break;
    }

    // partnershipCounts is per-slot: new drafts from previous iterations
    // add pairs that must be counted before the next slot's cap check.
    const partnershipCounts = await fetchPartnershipCounts(supabase, sessionId);
    // overlapMap is per-anchor: anchor changes each slot as pool reorders.
    const overlapMap = await buildOverlapMap(supabase, sessionId, pool[0].player_id);

    // ── Pure algorithm — zero DB calls ───────────────────────────
    const { proposal, capSaturation } = runAlgorithm(
      pool,
      partnershipCounts,
      overlapMap,
      recentRosters
    );

    if (!proposal) {
      // Broadcast cap-saturation warning when the cap (not player shortage)
      // was the reason no match formed. The broadcast is fire-and-forget.
      if (capSaturation) {
        const anchor = pool[0];
        broadcastCapSaturation(sessionId, {
          type: anchor.priorityScore >= RED_ZONE_SCORE_FLOOR ? "red_zone" : "general",
          anchorPlayerId: anchor.player_id,
          anchorPlayerName: anchor.display_name,
        }).catch((err) => {
          console.warn("[matchmaking] broadcastCapSaturation failed (non-fatal):", err);
        });
      } else {
        console.error(
          `[matchmaking] runEngineInternal: slot ${i + 1}/${slotsAvailable} — ` +
            "no compatible match (skill spread or diversity exhausted)"
        );
      }
      break;
    }

    // ── Commit the match ─────────────────────────────────────────
    const execResult = await executeMatch(supabase, sessionId, null, proposal, true);
    if (!execResult.success) {
      // "Slot skipped" = TOCTOU guard fired — expected under concurrent load.
      const isExpected = execResult.message?.includes("Slot skipped");
      if (!isExpected) {
        console.error(
          `[matchmaking] runEngineInternal: slot ${i + 1}/${slotsAvailable} failed — ${execResult.message}`
        );
      } else if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] runEngineInternal: stopping at slot ${i + 1} — ${execResult.message}`
        );
      }
      break;
    }

    // Match created — 4 players locked in on-deck.
    if (!bypassGate) {
      estimatedWaiting -= PLAYERS_PER_MATCH;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: promoteOnDeckMatchInternal
// ─────────────────────────────────────────────────────────────

export async function promoteOnDeckMatchInternal(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string,
  courtId: string
): Promise<MatchmakingResult> {
  // Order by sort_order first (drag-and-drop priority), fall back to
  // created_at for new matches that haven't been manually reordered yet
  // (sort_order is NULL until the organizer drags a card).
  // Draft Mode: only promote published matches — drafts are hidden from
  // the court promotion pipeline until the organizer explicitly publishes.
  const { data: pending, error } = await supabase
    .from("matches")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    // Real DB error — don't mask it as a draft-blocking message.
    return { success: false, message: `Failed to fetch on-deck matches: ${error.message}` };
  }

  if (!pending || pending.length === 0) {
    // Empty result — check whether drafts are blocking the queue so callers
    // can surface a contextual "review drafts" warning to the organizer.
    const { count: draftCount, error: draftCountError } = await supabase
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .eq("is_published", false);

    if (!draftCountError && (draftCount ?? 0) > 0) {
      return {
        success: false,
        message: `Court freed — ${draftCount} draft match${draftCount !== 1 ? "es need" : " needs"} review before the next game can start.`,
        hasDraftsBlocking: true,
      };
    }

    return { success: false, message: "No on-deck match available." };
  }

  const match = pending[0];
  const now = new Date().toISOString();

  // P0-2: Atomic compare-and-swap — add .eq("status", "pending") so that
  // if two courts free simultaneously and both call this function with the
  // same on-deck match, only the FIRST UPDATE wins. The second will affect
  // 0 rows (promotedMatch = null) and returns early, preventing the same
  // match from being assigned to two courts at once.
  // Also guard is_published=true so a draft that was un-published between
  // the SELECT and this UPDATE cannot be accidentally promoted.
  const { data: promotedMatch, error: updateError } = await supabase
    .from("matches")
    .update({
      court_id: courtId,
      status: "in_progress" as const,
      started_at: now,
    })
    .eq("id", match.id)
    .eq("status", "pending") // ← Atomic guard
    .eq("is_published", true) // ← Draft guard
    .select("id")
    .single();

  if (updateError || !promotedMatch) {
    if (!promotedMatch && !updateError) {
      // Another concurrent request already promoted this match — bail gracefully.
      console.warn(
        "[matchmaking] promoteOnDeckMatch: match already promoted by concurrent request, skipping."
      );
      return { success: false, message: "On-deck match was already promoted by another request." };
    }
    return {
      success: false,
      message: `Failed to promote on-deck match: ${updateError?.message}`,
    };
  }

  await supabase
    .from("courts")
    .update({ status: "in_use" as const })
    .eq("id", courtId);

  const { data: matchPlayers } = await supabase
    .from("match_players")
    .select("player_id, team")
    .eq("match_id", match.id);

  if (matchPlayers && matchPlayers.length > 0) {
    const playerIds = matchPlayers.map((mp) => mp.player_id);
    // BUG-002 fix: guard against overwriting a 'left' player's status.
    // If the organizer removed a player between publish and promote,
    // their queue_entries row should remain 'left', not flip to 'playing'.
    await supabase
      .from("queue_entries")
      .update({ status: "playing" as const })
      .eq("session_id", sessionId)
      .in("player_id", playerIds)
      .neq("status", "left");
  }

  const playerIds = (matchPlayers ?? []).map((mp) => mp.player_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", playerIds);

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));
  const teamANames = (matchPlayers ?? [])
    .filter((mp) => mp.team === "a")
    .map((mp) => profileMap.get(mp.player_id) ?? "Unknown");
  const teamBNames = (matchPlayers ?? [])
    .filter((mp) => mp.team === "b")
    .map((mp) => profileMap.get(mp.player_id) ?? "Unknown");

  return {
    success: true,
    matchId: match.id,
    message: "On-deck match promoted to court!",
    teamA: teamANames,
    teamB: teamBNames,
    isMixedLevel: match.is_mixed_level ?? false,
  };
}
