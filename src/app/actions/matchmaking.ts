"use server";

// ============================================================
// Enterprise Matchmaking Engine — Server Actions
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
//   runEngineInternal(supabase, sessionId)  — capacity-limited
//     on-deck filler. Cap = courtCount (one slot per open court).
//   createOneOnDeckMatch / runAlgorithm / promoteOnDeckMatchInternal
//   executeMatch / buildOverlapMap / snakeDraft / isGroupValid / etc.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastCapSaturation } from "@/lib/broadcast";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  PLAYERS_PER_MATCH,
  FALLBACK_WAIT_MINUTES,
  ANTI_REPEAT_LOOKBACK,
  RED_ZONE_SCORE_FLOOR,
  CRITICAL_WAIT_MINUTES,
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
  MAX_AUTO_DRAFTS,
  MIN_FREE_POOL_FOR_ON_DECK,
  MAX_PARTNERSHIP_REPEATS,
} from "@/lib/constants";
import {
  computePriorityScore,
  isGroupValid,
  snakeDraft,
  rotatedDraft,
  isDiversityViolation,
  getEffectiveLookback,
  scoreCandidates,
  buildCombinationGroup,
  pairKey,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import type { QueueWithWaitTime } from "@/types/database";
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
  /** Names of matched players for the toast notification. */
  teamA?: string[];
  teamB?: string[];
  /** True when the time-based fallback was triggered. */
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
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };

  const service = createServiceClient();
  const { data: sessionMeta } = await service
    .from("sessions")
    .select("created_by")
    .eq("id", sessionId)
    .single();
  if (!sessionMeta) return { success: false, message: "Session not found." };

  if (sessionMeta.created_by !== user.id) {
    const { data: coOrg } = await service
      .from("session_organizers")
      .select("id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!coOrg) {
      return { success: false, message: "Not authorized. Organizer access required." };
    }
  }
  // ── End auth gate ─────────────────────────────────────────────

  const supabase = await createClient();

  // 1. Try to promote an existing on-deck match.
  let promoted = await promoteOnDeckMatchInternal(supabase, sessionId, courtId);
  if (promoted.success) {
    // Refill the on-deck slot we just consumed.
    await runEngineInternal(supabase, sessionId);
    return promoted;
  }

  // 2. No on-deck match — check toggle.
  const { data: session } = await supabase
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
  await runEngineInternal(supabase, sessionId, true);
  promoted = await promoteOnDeckMatchInternal(supabase, sessionId, courtId);
  if (promoted.success) return promoted;

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
    // Using the user-context client (createClient) caused a hard-to-spot
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
      console.error(`[engine] runEngineForSession: failed to read session ${sessionId} — ${sessionErr.message}`);
      return;
    }
    if (!session?.is_auto_matchmaking_on) {
      console.log(`[engine] runEngineForSession: toggle is OFF for session ${sessionId} — skipping`);
      return;
    }

    console.log(`[engine] runEngineForSession: toggle ON for session ${sessionId} — starting engine`);
    await runEngineInternal(supabase, sessionId);
  } finally {
    engineRunningFor.delete(sessionId);
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: runEngineInternal
// ─────────────────────────────────────────────────────────────
// Dynamic draft filler. Generates on-deck matches until the combined
// total of published + unpublished pending matches reaches MAX_AUTO_DRAFTS.
//
// slotsAvailable = max(0, MAX_AUTO_DRAFTS − published − drafts)
//   0 approved + 0 drafts → up to 3 slots (pool diversity cap applies)
//   2 approved + 0 drafts → 1 slot (on-deck crowding prevention)
//   2 approved + 1 draft  → 0 slots (at cap)
//   3 total pending       → 0 slots (at cap)
// Fills slots up to slotsAvailable, stopping when queue is exhausted.

async function runEngineInternal(
  supabase: Awaited<ReturnType<typeof createClient>>,
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

  // Count published pending matches (approved by organizer, eligible for court promotion).
  const { count: existingOnDeck, error: deckErr } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", true);

  if (deckErr) {
    console.error(`[engine] runEngineInternal: published pending count failed — ${deckErr.message}`);
    return;
  }

  // Count unpublished draft matches (generated but not yet approved by organizer).
  // Previously invisible to the capacity check — caused up to 7+ drafts accumulating
  // across successive court-finish triggers before the organizer reviewed any of them.
  const { count: existingDrafts, error: draftErr } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false);

  if (draftErr) {
    console.error(`[engine] runEngineInternal: draft count failed — ${draftErr.message}`);
    return;
  }

  // Dynamic cap: total pending (approved + draft) must stay below MAX_AUTO_DRAFTS.
  // Naturally reduces draft output when the organizer has approved matches:
  //   2 approved + 0 drafts → 1 new slot; 2 approved + 1 draft → 0 slots.
  const totalPending   = (existingOnDeck ?? 0) + (existingDrafts ?? 0);
  const slotsAvailable = Math.max(0, MAX_AUTO_DRAFTS - totalPending);

  console.log(
    `[engine] runEngineInternal: courts=${courtCount} ` +
    `published=${existingOnDeck ?? 0} drafts=${existingDrafts ?? 0} ` +
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
  //   When only GATE_POOL_THRESHOLD (4) or fewer players are waiting AND
  //   at least one match is still active, hold on-deck generation so that
  //   players currently playing will return and enable a larger, more
  //   diverse scheduling pool ("same 4 cycle" prevention).
  //   Releases when:
  //     a) Any waiting player has queued ≥ GATE_HOLD_MINUTES (timeout)
  //     b) Any waiting player is in the Red Zone (≥ CRITICAL_WAIT_MINUTES)
  //     c) No active matches exist (nothing to wait for)
  //
  // Pool diversity cap (Fix 1): applied from the 2nd on-deck slot onwards.
  //   Before filling slot i≥1, the engine checks:
  //     estimatedWaiting >= PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK
  //   i.e., 8 players must still be waiting before committing another 4.
  //   Slot 0 is always exempt so the session never stalls on a small pool.
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
        const hasRedZone   = maxWait >= CRITICAL_WAIT_MINUTES;
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
  // Includes completed, in_progress, and pending matches (Fix 2) — all
  // represent real pairings worth tracking for diversity. This snapshot
  // is stable enough for the fill loop: pending matches don't change
  // ownership mid-run and the process-level guard prevents concurrent
  // engine runs for the same session.
  const recentRosters = await fetchRecentRosters(supabase, sessionId);

  for (let i = 0; i < slotsAvailable; i++) {
    // Pool diversity cap: from the 2nd slot onwards, ensure enough players
    // remain in the free pool after this generation so the next court finish
    // doesn't collapse diversity (Fix 1). Slot 0 is always exempt — the
    // session must never stall entirely on a small pool.
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

    const { created, message } = await createOneOnDeckMatch(supabase, sessionId, recentRosters);
    if (!created) {
      // Surface the reason so it's visible in Vercel logs.
      // "Not enough players" is expected and not an error; anything else is.
      const isExpected = message?.includes("Not enough");
      if (!isExpected) {
        console.error(`[matchmaking] runEngineInternal: slot ${i + 1}/${slotsAvailable} failed — ${message}`);
      } else if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(`[matchmaking] runEngineInternal: stopping at slot ${i + 1} — ${message}`);
      }
      break;
    }

    // Match created — 4 players are now locked in on-deck.
    // Track the estimated remaining free pool so the next iteration's
    // cap check uses an up-to-date estimate without a redundant DB query.
    // Only meaningful when !bypassGate (estimatedWaiting is 0/meaningless
    // in bypass mode since the cap check is also gated on !bypassGate).
    if (!bypassGate) {
      estimatedWaiting -= PLAYERS_PER_MATCH;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: createOneOnDeckMatch
// ─────────────────────────────────────────────────────────────

async function createOneOnDeckMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  recentRosters?: string[][]
): Promise<{ created: boolean; message: string }> {
  const result = await runAlgorithm(supabase, sessionId, null, true, recentRosters);
  return { created: result.success, message: result.message };
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: promoteOnDeckMatchInternal
// ─────────────────────────────────────────────────────────────

export async function promoteOnDeckMatchInternal(
  supabase: Awaited<ReturnType<typeof createClient>>,
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
    .eq("status", "pending")    // ← Atomic guard
    .eq("is_published", true)   // ← Draft guard
    .select("id")
    .single();

  if (updateError || !promotedMatch) {
    if (!promotedMatch && !updateError) {
      // Another concurrent request already promoted this match — bail gracefully.
      console.warn("[matchmaking] promoteOnDeckMatch: match already promoted by concurrent request, skipping.");
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

// ─────────────────────────────────────────────────────────────
// CORE: runAlgorithm
// ─────────────────────────────────────────────────────────────
// Unified algorithm used by both on-deck generation and direct
// court assignment. The `isOnDeck` flag controls whether the
// created match is pending (no court) or in_progress.
//
// Priority system (replaces raw games_played sort):
//   RED ZONE (wait ≥ 25 min): score = 1000 + wait → anchor first, no swap immunity
//   NORMAL   (wait < 25 min): score = wait − (games × 12)
// Pool is re-sorted by score DESC before anchor selection.
//
// Red Zone safeguards:
//   1. Skill window expands to ±3 then ±4 if ±2 can't fill the group.
//   2. The 3rd group member (swap target) is immune from diversity swap
//      if their priorityScore ≥ 1000.

async function runAlgorithm(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string | null,
  isOnDeck: boolean,
  cachedRecentRosters?: string[][]
): Promise<MatchmakingResult> {
  // ── 1. Fetch the waiting pool ─────────────────────────────
  const { data: rawPool, error: poolError } = await supabase
    .from("v_queue_with_wait_time")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .order("games_played", { ascending: true })
    .order("joined_at", { ascending: true });

  if (poolError) {
    return { success: false, message: `Failed to fetch queue: ${poolError.message}` };
  }

  // ── 1b. Filter soft-paused players ────────────────────────
  // v_queue_with_wait_time does not expose is_paused, so we do a
  // supplemental query directly on queue_entries and filter in memory.
  // Paused players are strictly invisible to the matchmaking engine.
  const { data: pausedRows } = await supabase
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .eq("is_paused", true);

  const pausedSet = new Set((pausedRows ?? []).map((r) => r.player_id));
  const activePool = (rawPool ?? []).filter((p) => !pausedSet.has(p.player_id));

  if (activePool.length < PLAYERS_PER_MATCH) {
    return {
      success: false,
      message: `Not enough active players in queue. Need ${PLAYERS_PER_MATCH}, have ${activePool.length}.`,
    };
  }

  // ── 1c. Fetch session-scoped partnership counts ───────────
  // Session-scoped (not anchor-specific), so we hoist it here before
  // anchor selection. One fetch per runAlgorithm call — not per candidate.
  const partnershipCounts = await fetchPartnershipCounts(supabase, sessionId);

  // ── 2. Enrich pool with priorityScore, sort DESC ──────────
  // Primary: priorityScore DESC — most urgent player anchors.
  // Tiebreaker: joined_at ASC — among equal-score players (common in
  // the score-0 bucket where game debt is floored), the one who has
  // been waiting longest goes first. Prevents fresh joiners from
  // jumping ahead of players held at 0 by game-debt penalty.
  const pool: ScoredPlayer[] = activePool
    .map((p) => ({ ...p, priorityScore: computePriorityScore(p) }))
    .sort((a, b) => {
      const diff = b.priorityScore - a.priorityScore;
      if (Math.abs(diff) > 0.001) return diff;
      // Same score bucket → earlier joiner wins.
      return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
    });

  // ── 3. Anchor = highest-priority player ──────────────────
  const anchor = pool[0];
  const anchorSkill = anchor.skill_level_int;
  const anchorWaitMinutes = anchor.wait_minutes ?? 0;
  const anchorIsRedZone = anchor.priorityScore >= RED_ZONE_SCORE_FLOOR;

  if (process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[matchmaking] anchor=${anchor.display_name} skill=${anchorSkill} ` +
      `wait=${anchorWaitMinutes.toFixed(1)}min priority=${anchor.priorityScore.toFixed(1)} ` +
      `redZone=${anchorIsRedZone} pool=${pool.length}`
    );
  }

  // ── 4. Build overlap map ──────────────────────────────────
  // buildOverlapMap is anchor-specific (counts pairings with THIS anchor)
  // so it cannot be hoisted above the loop — it must run once per tick as
  // the anchor changes each slot fill.
  const overlapMap = await buildOverlapMap(supabase, sessionId, anchor.player_id);

  // ── 5. Recent rosters for group-level diversity ───────────
  // Use the pre-fetched cache from runEngineInternal when available
  // (saves 2 DB queries per additional on-deck slot filled in one run).
  // Falls back to a fresh fetch when called from single-match paths
  // (callNextMatch inline engine, or direct court assignment).
  const recentRosters = cachedRecentRosters ?? await fetchRecentRosters(supabase, sessionId);

  // Candidates = everyone except the anchor (already priority-sorted),
  // pre-filtered to remove any player who has already reached the hard
  // partner-pair cap with the anchor. This single filter is the universal
  // enforcement point — it propagates through every downstream path:
  // skill expansion, Tier-1/2 diversity swap, Tier-3 rotation, and the
  // last-resort fallback. No waiver logic anywhere in the call stack.
  const candidates = pool.slice(1).filter(
    (c) =>
      (partnershipCounts.get(pairKey(anchor.player_id, c.player_id)) ?? 0) <
      MAX_PARTNERSHIP_REPEATS
  );

  // Track whether the cap reduced the candidate pool.
  // Used at the no-match return to decide whether to fire the saturation signal.
  const capWasActive = pool.length - 1 > candidates.length;

  if (process.env.DEBUG_MATCHMAKING === "true") {
    const filtered = pool.length - 1 - candidates.length;
    if (filtered > 0) {
      console.log(
        `[matchmaking] Partner-cap pre-filter: removed ${filtered} candidate(s) at cap with anchor ${anchor.display_name}`
      );
    }
  }

  // ── 6. Last-resort time fallback (> 15 min, non-Red Zone path) ──
  // Fires only when the anchor has waited > FALLBACK_WAIT_MINUTES
  // and we haven't entered Red Zone yet (15–25 min window) AND
  // the progressive skill expansion below also fails. Handled
  // at the end after all expansion windows are exhausted.

  // ── 7. Build skill window list ────────────────────────────
  // Red Zone anchor: try ±1, ±2, ±3, ±4 to guarantee a match.
  // Normal anchor:   try ±1, ±2 only (existing behaviour).
  const skillWindows = anchorIsRedZone
    ? [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX, 3, 4]
    : [SKILL_VARIANCE_TARGET, SKILL_VARIANCE_MAX];

  // ── 8. Progressive expansion ──────────────────────────────
  for (const maxVariance of skillWindows) {
    const eligible = candidates.filter(
      (c) => Math.abs(c.skill_level_int - anchorSkill) <= maxVariance
    );

    if (eligible.length < 3) {
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] ±${maxVariance} window: only ${eligible.length} eligible, need 3 — expanding`
        );
      }
      continue;
    }

    // ── Dynamic lookback: scale memory to the eligible pool ───
    // eligible.length + 1 (anchor) = total players available in
    // this skill window. Smaller pools get a shorter memory so
    // isolated tiers (e.g. 3 advanced players) don't thrash on
    // swap failures and then accept a repeat anyway.
    const effectiveLookback = getEffectiveLookback(eligible.length + 1);
    const activeRosters = recentRosters.slice(0, effectiveLookback);

    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] ±${maxVariance} window: pool=${eligible.length + 1} → lookback=${effectiveLookback}`
      );
    }

    // Rank eligible candidates: highest priorityScore first, overlap as tiebreaker.
    const scored = scoreCandidates(eligible, overlapMap);

    // Combination group building with cross-validation.
    const group = buildCombinationGroup(anchor, scored, maxVariance);

    if (group.length === 3) {
      const proposedIds = [anchor.player_id, ...group.map((g) => g.player_id)];

      // ── Group-level diversity check ───────────────────────
      if (isDiversityViolation(proposedIds, activeRosters)) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] Diversity violation for [${group.map((g) => g.display_name).join(", ")}] — attempting swap`
          );
        }

        // Red Zone immunity: if the 3rd companion (swap target) is also
        // in the Red Zone, never bench them for diversity — waiting time
        // takes absolute precedence.
        const swapTarget = group[2];
        if (swapTarget.priorityScore >= RED_ZONE_SCORE_FLOOR) {
          if (process.env.DEBUG_MATCHMAKING === "true") {
            console.warn(
              `[matchmaking] Swap target ${swapTarget.display_name} is Red Zone ` +
              `(score=${swapTarget.priorityScore.toFixed(1)}) — diversity swap skipped`
            );
          }
          // Fall through to executeMatch with the original group.
        } else {
          // ── Tier 1: primary swap within current skill window ──────────
          // Keep the top 2 companions; try replacing the 3rd with a fresh
          // candidate from the same ±maxVariance eligible pool.
          const fixedTwo = group.slice(0, 2);
          const alreadyInGroup = new Set(group.map((g) => g.player_id));
          const swapPool = scored.filter(
            ({ candidate }) => !alreadyInGroup.has(candidate.player_id)
          );

          for (const { candidate } of swapPool) {
            const swapGroup = [...fixedTwo, candidate];
            if (!isGroupValid([anchor, ...swapGroup], maxVariance)) continue;

            const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
            if (!isDiversityViolation(swappedIds, activeRosters)) {
              const draft = snakeDraft([anchor, ...swapGroup], partnershipCounts, MAX_PARTNERSHIP_REPEATS);
              if (!draft) {
                if (process.env.DEBUG_MATCHMAKING === "true") {
                  console.log(
                    `[matchmaking] Tier-1 swap: all team splits capped for ${candidate.display_name} — skipping`
                  );
                }
                continue;
              }
              if (process.env.DEBUG_MATCHMAKING === "true") {
                console.log(`[matchmaking] Tier-1 swap succeeded — replaced with ${candidate.display_name}`);
              }
              // Inherit isMixed from the current window — swap doesn't change
              // the skill spread, only the 3rd companion.
              const isMixedSwap = maxVariance > SKILL_VARIANCE_MAX;
              return executeMatch(supabase, sessionId, courtId, draft.teamA, draft.teamB, isMixedSwap, isOnDeck);
            }
          }

          // ── Tier 2: expanded swap at ±SKILL_VARIANCE_MAX ──────────────
          // Primary pool was exhausted (swapPool empty or all repeat).
          // Pull candidates from the wider ±SKILL_VARIANCE_MAX window that
          // aren't already in the proposed group. This breaks tier isolation
          // (e.g. an advanced player whose only ±1 partners have all played
          // together can now reach intermediate-tier players at ±2).
          // Only attempted when currently at a narrower window (maxVariance < MAX).
          if (swapPool.length === 0 && maxVariance < SKILL_VARIANCE_MAX) {
            const widerEligible = candidates.filter(
              (c) =>
                Math.abs(c.skill_level_int - anchorSkill) <= SKILL_VARIANCE_MAX &&
                !alreadyInGroup.has(c.player_id)
            );

            if (widerEligible.length > 0) {
              const widerScored = scoreCandidates(widerEligible, overlapMap);
              for (const { candidate } of widerScored) {
                const swapGroup = [...fixedTwo, candidate];
                if (!isGroupValid([anchor, ...swapGroup], SKILL_VARIANCE_MAX)) continue;

                const swappedIds = [anchor.player_id, ...swapGroup.map((p) => p.player_id)];
                if (!isDiversityViolation(swappedIds, activeRosters)) {
                  const draft = snakeDraft([anchor, ...swapGroup], partnershipCounts, MAX_PARTNERSHIP_REPEATS);
                  if (!draft) {
                    if (process.env.DEBUG_MATCHMAKING === "true") {
                      console.log(
                        `[matchmaking] Tier-2 expanded swap: all team splits capped for ${candidate.display_name} — skipping`
                      );
                    }
                    continue;
                  }
                  if (process.env.DEBUG_MATCHMAKING === "true") {
                    console.log(
                      `[matchmaking] Tier-2 expanded swap (±${SKILL_VARIANCE_MAX}) — replaced with ${candidate.display_name}`
                    );
                  }
                  // ±SKILL_VARIANCE_MAX is still within normal parameters (not mixed).
                  return executeMatch(supabase, sessionId, courtId, draft.teamA, draft.teamB, false, isOnDeck);
                }
              }
            }
          }

          // ── Tier 3: partner rotation ───────────────────────────────────
          // All swap paths exhausted — the same 4 players must play again.
          // rotatedDraft cycles through 3 team-split configurations so that
          // partners change on each forced repeat, providing variety even
          // when the opponent group cannot be changed.
          // If every split is also capped, treat as slot failure and expand.
          const isMixedRotation = maxVariance > SKILL_VARIANCE_MAX;
          const rotatedResult = rotatedDraft(
            [anchor, ...group],
            recentRosters,
            partnershipCounts,
            MAX_PARTNERSHIP_REPEATS
          );
          if (!rotatedResult) {
            if (process.env.DEBUG_MATCHMAKING === "true") {
              console.warn(
                "[matchmaking] Tier-3 rotation: all team splits capped — expanding skill window"
              );
            }
            continue;
          }
          console.warn(
            "[matchmaking] No diverse swap found — applying partner rotation (forced repeat)"
          );
          return executeMatch(supabase, sessionId, courtId, rotatedResult.teamA, rotatedResult.teamB, isMixedRotation, isOnDeck);
        }
      }

      const isMixed = maxVariance > SKILL_VARIANCE_MAX;
      const allFour = [anchor, ...group];
      const draft = snakeDraft(allFour, partnershipCounts, MAX_PARTNERSHIP_REPEATS);
      if (!draft) {
        if (process.env.DEBUG_MATCHMAKING === "true") {
          console.log(
            `[matchmaking] ±${maxVariance} window: group valid but all team splits capped — expanding`
          );
        }
        continue;
      }
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log(
          `[matchmaking] ±${maxVariance} window: matched [${group.map((g) => g.display_name).join(", ")}]` +
          (isMixed ? " (mixed level)" : "")
        );
      }
      return executeMatch(supabase, sessionId, courtId, draft.teamA, draft.teamB, isMixed, isOnDeck);
    }

    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] ±${maxVariance} window: only built group of ${group.length} — expanding`
      );
    }
  }

  // ── 9. Last-resort fallback (15+ min anchor, any 3 players) ──
  // NOTE: This path intentionally skips skill validation. A player who has
  // waited > FALLBACK_WAIT_MINUTES without finding a compatible group will be
  // matched with the next-best available players regardless of skill spread.
  // The match is always flagged isMixedLevel=true so the UI can warn the
  // organizer. Tradeoff: prevents indefinite starvation at the cost of match
  // quality. This only fires when ALL skill-window expansion passes fail.
  if (anchorWaitMinutes > FALLBACK_WAIT_MINUTES) {
    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] LAST-RESORT FALLBACK — anchor waited ${anchorWaitMinutes.toFixed(1)}min > ${FALLBACK_WAIT_MINUTES}min`
      );
    }
    // Apply overlap penalties so we don't accidentally repeat exact matches
    const scoredFallback = scoreCandidates(candidates, overlapMap);
    const fallbackGroup = scoredFallback.slice(0, 3).map((s) => s.candidate);
    
    if (fallbackGroup.length >= 3) {
      const allFour = [anchor, ...fallbackGroup];
      const draft = snakeDraft(allFour, partnershipCounts, MAX_PARTNERSHIP_REPEATS);
      if (draft) {
        return executeMatch(supabase, sessionId, courtId, draft.teamA, draft.teamB, true, isOnDeck);
      }
      // All team splits capped even in last resort — fall through to no-match.
      if (process.env.DEBUG_MATCHMAKING === "true") {
        console.log("[matchmaking] LAST-RESORT FALLBACK: all team splits capped — no match formed");
      }
    }
  }

  // ── Cap saturation signal ──────────────────────────────────────
  // Fire only when the cap was the reason the candidate pool shrank
  // AND no match was formed despite that. This pinpoints cap saturation
  // as the culprit so the organizer can act (manual override or wait for
  // existing matches to complete and free up the pair constraint).
  // Fire-and-forget: broadcast failure must never block the no-match return.
  if (capWasActive) {
    if (process.env.DEBUG_MATCHMAKING === "true") {
      console.log(
        `[matchmaking] Cap saturation signal: anchor=${anchor.display_name} ` +
        `type=${anchorIsRedZone ? "red_zone" : "general"} — emitting broadcast`
      );
    }
    broadcastCapSaturation(sessionId, {
      type: anchorIsRedZone ? "red_zone" : "general",
      anchorPlayerId: anchor.player_id,
      anchorPlayerName: anchor.display_name,
    }).catch((err) => {
      console.warn("[matchmaking] broadcastCapSaturation failed (non-fatal):", err);
    });
  }

  return {
    success: false,
    message:
      "No compatible match could be formed. Skill levels in the queue are too spread out. " +
      "Check the Wait Time Monitor for players needing manual intervention.",
  };
}


// ─────────────────────────────────────────────────────────────
// HELPER: fetchRecentRosters
// ─────────────────────────────────────────────────────────────
// Returns the last ANTI_REPEAT_LOOKBACK match rosters (completed,
// in_progress, and pending) as arrays of player IDs. Used by the
// diversity-violation check.
//
// Fix 2: including in_progress and pending matches means the engine
// sees players who are CURRENTLY paired together, not only those who
// have already finished. This prevents the engine from forming the
// same pairing "again" just because the first game is still live.
//
// This snapshot is stable enough for a single engine run: the
// process-level concurrency guard prevents concurrent engine runs
// for the same session, and match ownership doesn't change mid-run.
// runEngineInternal pre-fetches this once and passes it to each
// runAlgorithm call rather than re-fetching per slot.

async function fetchRecentRosters(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string
): Promise<string[][]> {
  const { data: recentMatchRows } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", ["completed", "in_progress", "pending"])
    .order("created_at", { ascending: false })
    .limit(ANTI_REPEAT_LOOKBACK);

  const recentMatchIds = (recentMatchRows ?? []).map((m) => m.id);
  if (recentMatchIds.length === 0) return [];

  const { data: recentPlayers } = await supabase
    .from("match_players")
    .select("match_id, player_id")
    .in("match_id", recentMatchIds);

  if (!recentPlayers) return [];

  const rosterMap = new Map<string, string[]>();
  for (const row of recentPlayers) {
    const list = rosterMap.get(row.match_id) ?? [];
    list.push(row.player_id);
    rosterMap.set(row.match_id, list);
  }

  return recentMatchIds
    .map((id) => rosterMap.get(id) ?? [])
    .filter((r) => r.length > 0);
}

// ─────────────────────────────────────────────────────────────
// HELPER: fetchPartnershipCounts
// ─────────────────────────────────────────────────────────────
// Returns a Map<pairKey, count> of how many times each same-team
// pair has played together in this session. Covers all match statuses
// that represent a committed team assignment (completed, in_progress,
// pending — including unpublished drafts) so the cap applies the
// moment a draft match is created, not only after publish.
//
// Called once per runAlgorithm invocation (hoisted above the anchor
// selection loop) so it is NOT re-fetched per candidate scan.

async function fetchPartnershipCounts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  // Step 1: all match IDs for this session with committed statuses.
  const { data: sessionMatches, error: matchErr } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", ["completed", "in_progress", "pending"]);

  if (matchErr || !sessionMatches || sessionMatches.length === 0) {
    if (matchErr) {
      console.warn("[matchmaking] fetchPartnershipCounts: match query failed:", matchErr.message);
    }
    return counts;
  }

  const matchIds = sessionMatches.map((m) => m.id);

  // Step 2: all match_players rows for those matches.
  const { data: rows, error: rowsErr } = await supabase
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", matchIds);

  if (rowsErr || !rows || rows.length === 0) {
    if (rowsErr) {
      console.warn("[matchmaking] fetchPartnershipCounts: players query failed:", rowsErr.message);
    }
    return counts;
  }

  // Step 3: group by (match_id, team), count all same-team pairs.
  // Using a composite key avoids a nested match_id lookup on each row.
  const byMatchTeam = new Map<string, string[]>();
  for (const row of rows) {
    if (row.team == null) continue;
    const key = `${row.match_id}:${row.team}`;
    const group = byMatchTeam.get(key) ?? [];
    group.push(row.player_id);
    byMatchTeam.set(key, group);
  }

  for (const teammates of byMatchTeam.values()) {
    for (let i = 0; i < teammates.length; i++) {
      for (let j = i + 1; j < teammates.length; j++) {
        const key = pairKey(teammates[i], teammates[j]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  if (process.env.DEBUG_MATCHMAKING === "true") {
    console.log(
      `[matchmaking] fetchPartnershipCounts: ${counts.size} tracked pair(s) across ` +
      `${sessionMatches.length} match(es) for session ${sessionId}`
    );
  }

  return counts;
}

// ─────────────────────────────────────────────────────────────
// HELPER: buildOverlapMap
// ─────────────────────────────────────────────────────────────
// Returns a Map<player_id, weight> representing how "familiar"
// each co-player is to the anchor across recent matches in this
// session. Used by scoreCandidates to apply anti-repeat penalties.
//
// Fix 3 — Team-aware weighting:
//   Teammate appearance  → weight += 2  (same side; stronger familiarity)
//   Opponent appearance  → weight += 1  (opposing; weaker familiarity)
//
// Rationale: playing alongside the same partner is more repetitive
// than facing the same opponent — the feel of a match changes more
// when your partner changes than when your opponent does.
//
// Implementation: 3-step join to avoid relying on v_recent_pairings
// (which lacks team data and only tracks completed matches).
//   Step 1 — find the anchor's match IDs (global, via match_players)
//   Step 2 — filter to session + recent statuses (Fix 2: includes
//             in_progress and pending alongside completed)
//   Step 3 — fetch all co-players + teams, compute weighted map

async function buildOverlapMap(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  anchorPlayerId: string
): Promise<Map<string, number>> {
  const overlapMap = new Map<string, number>();

  // Step 1: Find all match IDs the anchor has participated in.
  // match_players has no session_id column, so we start here and
  // filter to the correct session in Step 2.
  // Safety cap: limit to 200 rows so the allAnchorMatchIds array
  // stays bounded for the .in() clause in Step 2. A prolific player
  // attending twice a week for a year accumulates ~1 000 match rows;
  // 200 is enough to capture all recent-session matches (sessions
  // rarely exceed 20 matches each) while keeping the PostgREST URL
  // parameter well within reasonable length limits.
  const { data: anchorRows, error: anchorErr } = await supabase
    .from("match_players")
    .select("match_id")
    .eq("player_id", anchorPlayerId)
    .limit(200);

  if (anchorErr || !anchorRows || anchorRows.length === 0) {
    if (anchorErr) {
      console.warn("[matchmaking] buildOverlapMap: anchor query failed:", anchorErr.message);
    }
    return overlapMap; // First-time player or error — no overlap data
  }

  const allAnchorMatchIds = anchorRows.map((r) => r.match_id);

  // Step 2: Filter to this session's recent matches (completed +
  // in_progress + pending) that actually include the anchor.
  const { data: sessionMatches, error: sessionErr } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", ["completed", "in_progress", "pending"])
    .in("id", allAnchorMatchIds)
    .order("created_at", { ascending: false })
    .limit(ANTI_REPEAT_LOOKBACK);

  if (sessionErr || !sessionMatches || sessionMatches.length === 0) {
    if (sessionErr) {
      console.warn("[matchmaking] buildOverlapMap: session filter failed:", sessionErr.message);
    }
    return overlapMap;
  }

  const recentMatchIds = sessionMatches.map((m) => m.id);

  // Step 3: Fetch all players + teams for those matches.
  // This gives us both the anchor's team per match and every co-player's team.
  const { data: allPlayers, error: playersErr } = await supabase
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", recentMatchIds);

  if (playersErr || !allPlayers) {
    if (playersErr) {
      console.warn("[matchmaking] buildOverlapMap: co-players query failed:", playersErr.message);
    }
    return overlapMap;
  }

  // Build a map of match_id → anchor's team assignment.
  // Only store when team is a non-null string (pending matches may not
  // have team assignments yet; null-vs-null compares equal in JS and
  // would incorrectly score unknown co-players as "teammates").
  const anchorTeamByMatch = new Map<string, string>();
  for (const row of allPlayers) {
    if (row.player_id === anchorPlayerId && row.team != null) {
      anchorTeamByMatch.set(row.match_id, row.team);
    }
  }

  // Apply team-weighted overlap for every co-player.
  for (const row of allPlayers) {
    if (row.player_id === anchorPlayerId) continue;
    const anchorTeam = anchorTeamByMatch.get(row.match_id);
    // Skip if anchor's team is unknown for this match (not stored above
    // because team was null, or anchor wasn't in this match at all).
    if (anchorTeam === undefined) continue;
    // Also skip if co-player's team is null — can't determine relationship.
    if (row.team == null) continue;
    // Teammate (same team) is weighted 2×; opponent 1×.
    const weight = row.team === anchorTeam ? 2 : 1;
    overlapMap.set(row.player_id, (overlapMap.get(row.player_id) ?? 0) + weight);
  }

  return overlapMap;
}

// ─────────────────────────────────────────────────────────────
// HELPER: executeMatch
// ─────────────────────────────────────────────────────────────
// Unified match creation — handles both on-deck (pending, null
// court_id) and direct (in_progress, real court_id).

async function executeMatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  courtId: string | null,
  teamA: ScoredPlayer[],
  teamB: ScoredPlayer[],
  isMixedLevel: boolean,
  isOnDeck: boolean
): Promise<MatchmakingResult> {
  // ── Atomic write: match + players + queue statuses + court ──
  // All steps run inside a single Postgres transaction via the
  // create_match_with_players RPC.
  //
  // RPC evolution:
  //   20260421000000 — initial atomic write (3 sequential writes → 1 RPC)
  //   20260506000000 — adds p_is_published for Draft Mode (BUG-001)
  //   20260507000000 — adds TOCTOU guards (Guard 0 + Guard 1 + Guard 2)
  //
  // NULL return convention:
  //   The RPC returns RETURNS uuid (scalar). When any guard detects a
  //   conflict or a player no longer 'waiting', it returns NULL instead
  //   of raising an exception. The Supabase JS client surfaces this as
  //   { data: null, error: null } — distinct from a hard error
  //   ({ data: null, error: PostgrestError }). The split checks below
  //   rely on this scalar-NULL contract; if the RPC were ever changed to
  //   RETURNS SETOF uuid, PostgREST would wrap null as [] and this
  //   detection would break silently.
  const now = new Date().toISOString();

  // BUG-001 fix: pass p_is_published=false so the RPC skips the
  // queue_entries update for engine drafts. Players stay 'waiting'
  // until publishMatchAction promotes them to 'on_deck', preventing
  // the ON_DECK_WARNING alert from firing for an invisible match.
  const { data: matchId, error: rpcError } = await supabase.rpc(
    "create_match_with_players",
    {
      p_session_id:     sessionId,
      p_court_id:       isOnDeck ? null : courtId,
      p_status:         isOnDeck ? "pending" : "in_progress",
      p_is_mixed_level: isMixedLevel,
      p_started_at:     isOnDeck ? null : now,
      p_is_on_deck:     isOnDeck,
      p_team_a_ids:     teamA.map((p) => p.player_id),
      p_team_b_ids:     teamB.map((p) => p.player_id),
      p_origin:         "auto" as const,
      p_is_published:   false,
    }
  );

  if (rpcError) {
    // Hard DB error — surface as a genuine failure.
    return {
      success: false,
      message: `Failed to create match: ${rpcError.message}`,
    };
  }

  if (!matchId) {
    // RPC returned NULL: the DB-level TOCTOU guard detected that a
    // concurrent transaction already committed one or more of the
    // proposed players into an active match. This is not an error —
    // it's the correct serialised outcome. Log a warning so operators
    // can monitor frequency, then signal a graceful slot-skip to the
    // caller (runEngineInternal logs the skip and moves to the next slot).
    console.warn(
      "[matchmaking] executeMatch: RPC returned NULL — concurrent matchmaking " +
      "run already committed one or more of these players. Skipping slot gracefully.",
      { sessionId, teamA: teamA.map((p) => p.display_name), teamB: teamB.map((p) => p.display_name) }
    );
    return {
      success: false,
      message: "Slot skipped: player already committed by a concurrent matchmaking run.",
    };
  }

  return {
    success: true,
    matchId,
    message: isOnDeck ? "On-deck match created!" : "Match created successfully!",
    teamA: teamA.map((p) => p.display_name),
    teamB: teamB.map((p) => p.display_name),
    isMixedLevel,
  };
}
