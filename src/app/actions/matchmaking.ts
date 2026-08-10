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
//     draft filler; orchestrates data-fetch + pure algorithm + commit.
//     Draft cap: MAX_AUTO_DRAFTS (tiered by waiting player count via
//     getDynamicDraftCap). Counts only is_published=false pending
//     matches — published on-deck matches do NOT block new draft gen.
//   promoteOnDeckMatchInternal — CAS promote, player status updates.
//
// Module boundaries:
//   matchmaking-core.ts — pure algorithm (runAlgorithm, scoreAndSortPool,
//     snakeDraft, scoreCandidates, etc.). Zero DB calls, zero side effects.
//   matchmaking-db.ts   — DB helpers. The engine's read phase is ONE
//     fetchSessionMatchSnapshot (committed matches + their rosters) plus
//     fetchActivePool; recent rosters, pair counts and the overlap map are
//     PURE derivations off that snapshot. executeMatch commits.
// ============================================================

import { after } from "next/server";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { broadcastCapSaturation } from "@/lib/broadcast";
import { pushToPlayers } from "@/lib/notifications/push-server";
import {
  PLAYERS_PER_MATCH,
  RED_ZONE_SCORE_FLOOR,
  CRITICAL_WAIT_MINUTES,
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
  MIN_FREE_POOL_FOR_ON_DECK,
  CROSS_COURT_REST_FALLBACK_MINUTES,
} from "@/lib/constants";
import {
  getDynamicDraftCap,
  shouldAutoPublishMatch,
  runAlgorithm,
  scoreAndSortPool,
  isHeldMatchReady,
  isPullEligible,
  type ScoredPlayer,
} from "@/lib/matchmaking-core";
import {
  fetchActivePool,
  fetchSessionMatchSnapshot,
  deriveRecentRosters,
  derivePairCounts,
  deriveOverlapMap,
  executeMatch,
  fetchPullablePlayers,
  executeHeldMatch,
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
    // Refill the on-deck slot we just consumed — only if toggle is ON.
    // runEngineForSession checks is_auto_matchmaking_on before running,
    // preventing draft generation when the organizer has paused auto-matchmaking.
    await runEngineForSession(sessionId);
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
// Draft review queue filler. Generates unpublished drafts until the
// count of UNPUBLISHED pending matches reaches MAX_AUTO_DRAFTS.
//
// slotsAvailable = max(0, MAX_AUTO_DRAFTS − draftCount)
//   draftCount = status='pending' AND is_published=false only.
//   Published on-deck matches do NOT count against the cap — they have
//   already been reviewed and are not blocking the review queue.
//   0 drafts → up to 3 slots (pool diversity cap applies)
//   1 draft  → up to 2 slots
//   2 drafts → 1 slot
//   3 drafts → 0 slots (review queue full)
// Fills slots up to slotsAvailable, stopping when queue is exhausted.

/**
 * Core engine loop — computes how many on-deck slots are available (capped by
 * MAX_AUTO_DRAFTS), then fills each slot by calling `runAlgorithm` against the
 * waiting player pool.
 *
 * Why a loop rather than a batch: each iteration consumes players from the pool
 * and must commit the match before the next slot can be computed accurately.
 * Concurrency is handled by two mechanisms: (1) the process-level `engineRunningFor`
 * Set that prevents re-entrancy within the same Node.js process, and (2) row-level
 * locking inside the `create_match_with_players` RPC that makes each slot commit
 * atomic against concurrent RPC calls from other processes.
 *
 * Soft gate: if the pool is at or below GATE_POOL_THRESHOLD AND a match is live,
 * the gate defers scheduling so returning court players can be included in a
 * larger, more diverse pool. Bypassed when `bypassGate` is true.
 */
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

  // ── Fetch waiting players + draft count + session in parallel ─
  //
  // waitingRows is hoisted here (outside !bypassGate) for two reasons:
  //   1. The waiting count drives getDynamicDraftCap — we need it before
  //      computing slotsAvailable, regardless of bypassGate.
  //   2. The same rows are reused for the soft gate and estimatedWaiting,
  //      so we avoid a second round-trip later.
  //
  // Draft count cap (is_published=false only):
  //   Published on-deck matches are already reviewed. Counting them against
  //   the cap would block fresh draft generation while reviewed matches wait
  //   to be called to courts. The cap is a REVIEW QUEUE cap, not a total
  //   on-deck cap.
  const [
    { data: waitingRows, error: waitErr },
    { count: draftCountRaw, error: draftErr },
    { data: sessionRow, error: sessionErr },
  ] = await Promise.all([
    supabase
      .from("v_queue_with_wait_time")
      .select("wait_minutes")
      .eq("session_id", sessionId)
      .eq("status", "waiting"),
    supabase
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .eq("is_published", false),
    supabase
      .from("sessions")
      .select("max_auto_drafts_override, auto_publish")
      .eq("id", sessionId)
      .single(),
  ]);
  if (sessionErr) {
    console.warn(`[engine] runEngineInternal: session fetch failed — ${sessionErr.message}`);
  }

  if (draftErr) {
    console.error(`[engine] runEngineInternal: draft count failed — ${draftErr.message}`);
    return;
  }
  // waitErr is non-fatal — fall back to default cap if the view is unavailable.
  if (waitErr) {
    console.warn(`[engine] runEngineInternal: waiting-rows fetch failed — ${waitErr.message}`);
  }

  const autoPublish = shouldAutoPublishMatch(sessionRow?.auto_publish ?? false);

  const waitingCount = waitingRows?.length ?? 0;
  const dynamicCap = getDynamicDraftCap(waitingCount);
  // Apply organizer override as a ceiling: min(override, dynamicCap).
  // null override means "use dynamic cap as-is".
  const override = sessionRow?.max_auto_drafts_override ?? null;
  const effectiveCap = override != null ? Math.min(override, dynamicCap) : dynamicCap;

  // Mode-dependent cap count. Draft mode counts the unpublished review queue
  // (fetched above). Auto-publish mode has no review step, so the cap instead
  // limits the on-deck queue — re-count published on-deck matches PLUS held
  // drafts. Held drafts are born is_published=false (hidden until their pulled
  // body is free) but they RESERVE a future on-deck slot — they auto-publish at
  // readiness. Counting them here stops the engine over-generating while several
  // held drafts are pending, which would otherwise overshoot the cap when they
  // all publish at once.
  let draftCount = draftCountRaw ?? 0;
  if (autoPublish) {
    const { count: onDeckCountRaw } = await supabase
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .or("is_published.eq.true,is_held.eq.true");
    draftCount = onDeckCountRaw ?? 0;
  }
  const slotsAvailable = Math.max(0, effectiveCap - draftCount);

  console.log(
    `[engine] runEngineInternal: mode=${autoPublish ? "auto" : "draft"} courts=${courtCount} ` +
      `waiting=${waitingCount} pending=${draftCount} dynamic=${dynamicCap} ` +
      `effective=${effectiveCap} slots=${slotsAvailable}`
  );
  if (slotsAvailable <= 0) {
    console.log(
      `[engine] runEngineInternal: draft cap reached (${draftCount}/${effectiveCap}) — skipping`
    );
    return;
  }

  // ── Soft gate + pool diversity cap ───────────────────────────
  //
  // waitingRows was already fetched above and reused here.
  // When bypassGate = true (organizer explicitly clicked "Call Next Match"),
  // both checks are skipped entirely.
  //
  // Soft gate: defer on-deck when pool is too small for cross-court mixing.
  //   Releases when: any player waits ≥ GATE_HOLD_MINUTES, any Red Zone,
  //   or no active matches exist.
  //
  // Pool diversity cap: from the 2nd slot onwards, ≥8 players must be
  //   waiting before committing another 4. Slot 0 is always exempt.
  //   After each successful generation, estimatedWaiting decrements by 4.

  let estimatedWaiting = waitingCount; // already fetched above

  if (!bypassGate) {
    if (waitingRows && waitingCount > 0 && waitingCount <= GATE_POOL_THRESHOLD) {
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

    // ── Per-slot data fetch ──────────────────────────────────────
    // Everything here is re-read PER SLOT, never hoisted out of the loop:
    // sibling drafts committed by slots 1–2 have to be visible to slot 3's
    // diversity check, partnership cap and overlap map, or a burst happily
    // drafts the same pairing three times.
    //
    // The snapshot (2 queries) and the pool (1) are independent, so they run
    // concurrently — the slot's read phase costs 2 round trips, not 3. The
    // interleave is deterministic for order-sensitive test mocks: `matches`,
    // then `v_queue_with_wait_time`, then `match_players`.
    const [snapshotResult, rawPool] = await Promise.all([
      fetchSessionMatchSnapshot(supabase, sessionId),
      fetchActivePool(supabase, sessionId),
    ]);

    // Fail CLOSED. Every diversity input the engine has — recent rosters, the
    // partnership/opponent caps, the overlap map — is derived from this one
    // snapshot, so without it the algorithm would not degrade gracefully; it
    // would run with empty history and read every repeat as a fresh pairing,
    // producing exactly the duplicate rosters the caps exist to prevent.
    // Stopping the burst leaves the organizer with fewer drafts, which is
    // recoverable; a batch of confidently-wrong ones is not.
    if (!snapshotResult.ok) {
      console.error(
        `[matchmaking] runEngineInternal: slot ${i + 1}/${slotsAvailable} — ` +
          `stopping, match snapshot unavailable (${snapshotResult.reason})`
      );
      break;
    }
    const snapshot = snapshotResult.snapshot;

    const recentRosters = deriveRecentRosters(snapshot);
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

    // Both derived from the snapshot above — no further round trips. The
    // overlap map is per-ANCHOR, and the anchor changes each slot as the pool
    // reorders, so it is derived here rather than alongside the rosters.
    const { partnershipCounts, opponentCounts } = derivePairCounts(snapshot);
    const overlapMap = deriveOverlapMap(snapshot, pool[0].player_id);

    // ── Pure algorithm — zero DB calls ───────────────────────────
    const result = runAlgorithm(pool, partnershipCounts, overlapMap, recentRosters, opponentCounts);
    const { proposal, capSaturation } = result;

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

    // ── Cross-court augmented composition (Phase 4) ──────────────
    // Fires only when the waiting pool could manage no better than a FORCED
    // REPEAT, this is NOT a bypass run (M-4), we're past slot 0 (keep-courts-fed:
    // slot 0 always seats a ready waiting-only match), and the anchor is not in
    // the Red Zone (decision 4 — a Red-Zone player is seated now, never held).
    // Reach into a live court for ONE fresh body to break the repeat.
    let committedHeld = false;
    const anchorIsRedZone = pool[0].priorityScore >= RED_ZONE_SCORE_FLOOR;
    if (result.forcedRepeat && !bypassGate && i > 0 && !anchorIsRedZone) {
      const pullable = await fetchPullablePlayers(supabase, sessionId);
      const eligible = pullable
        .filter((b) => isPullEligible(b, { streak: b.streak, alreadyHeld: b.alreadyHeld }))
        // N-3: earliest-finishing first so the combination search prefers it on a fit tie.
        .sort(
          (a, b) =>
            new Date(a.currentMatchStartedAt).getTime() -
            new Date(b.currentMatchStartedAt).getTime()
        );
      if (eligible.length > 0) {
        const pulledMatchId = new Map(eligible.map((b) => [b.player_id, b.currentMatchId]));
        const augmented: ScoredPlayer[] = [
          ...pool,
          ...eligible.map((b) => ({ ...b, priorityScore: -1, isPulled: true as const })),
        ];
        const augResult = runAlgorithm(
          augmented,
          partnershipCounts,
          overlapMap,
          recentRosters,
          opponentCounts
        );
        const augFour = augResult.proposal
          ? [...augResult.proposal.teamA, ...augResult.proposal.teamB]
          : [];
        const pulledInFour = augFour.filter((p) => p.isPulled);
        // Take it only if it's a genuinely FRESH match with exactly ONE pulled body (N-1).
        if (augResult.proposal && !augResult.forcedRepeat && pulledInFour.length === 1) {
          const fromMatchId = pulledMatchId.get(pulledInFour[0].player_id);
          if (fromMatchId) {
            const heldExec = await executeHeldMatch(
              supabase,
              sessionId,
              augResult.proposal,
              pulledInFour[0].player_id,
              fromMatchId
            );
            if (heldExec.success) {
              committedHeld = true;
              // A held draft consumes 3 waiting players, not 4 (C-1).
              if (!bypassGate) estimatedWaiting -= PLAYERS_PER_MATCH - 1;
            }
          }
        }
      }
    }

    if (committedHeld) continue; // held draft created — on to the next slot

    // ── Commit the match ─────────────────────────────────────────
    const execResult = await executeMatch(supabase, sessionId, null, proposal, true, autoPublish);
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

    // Auto-publish mode: the match went straight to On Deck (is_published=true),
    // skipping the publish action where ON_DECK_WARNING normally fires. Send it
    // here so players learn they're on deck. Fire-and-forget; never blocks the
    // engine. (Draft mode stays silent until the organizer publishes.)
    if (autoPublish) {
      const rosterIds = [...proposal.teamA, ...proposal.teamB].map((p) => p.player_id);
      after(() => pushToPlayers(rosterIds, "ON_DECK_WARNING", sessionId));
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
  const { data: pendingAll, error } = await supabase
    .from("matches")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error) {
    // Real DB error — don't mask it as a draft-blocking message.
    return { success: false, message: `Failed to fetch on-deck matches: ${error.message}` };
  }

  // TS-filter (C-4 / R3-A): promote the front-most READY match. A held cross-court
  // match is ready only once held_ready_at is stamped and due; a not-ready held
  // match is SKIPPED so a ready match queued behind it still promotes (skip-and-defer).
  // No timestamp goes into the query — we compare held_ready_at in JS (the published
  // pending set is tiny), sidestepping the PostgREST filter-string fragility.
  const nowMs = Date.now();
  const readyCandidates = (pendingAll ?? []).filter(
    (m) => !m.is_held || (m.held_ready_at !== null && new Date(m.held_ready_at).getTime() <= nowMs)
  );

  // Pre-promotion safety guard (auto-publish): a match can reach On Deck and
  // then have a roster player leave before a court frees. Promoting it would put
  // a "ghost" on court — the TV shows 4 but only 3 arrive. The downstream
  // status update already refuses to flip a 'left' player to 'playing', but the
  // match itself would still promote. So here we skip (and clear) any ready
  // candidate that contains a 'left' player and promote the first clean one.
  // The ready set is tiny (≤ cap), and the roster fetch is reused below instead
  // of a second round-trip, so the hot path costs one extra query.
  let match: NonNullable<typeof pendingAll>[number] | null = null;
  let matchPlayers: Array<{ player_id: string; team: string }> | null = null;
  for (const candidate of readyCandidates) {
    const { data: rosterRows } = await supabase
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", candidate.id);
    const rosterIds = (rosterRows ?? []).map((r) => r.player_id);

    const { count: leftCount } = await supabase
      .from("queue_entries")
      .select("player_id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .in("player_id", rosterIds)
      .eq("status", "left");

    if ((leftCount ?? 0) > 0) {
      // Tainted roster — clear it (returns the remaining players to waiting and
      // frees the slot for the engine to refill) and try the next ready match.
      console.warn(
        `[matchmaking] promoteOnDeckMatch: skipping match ${candidate.id} — a roster ` +
          `player has left; clearing it so the court isn't blocked.`
      );
      await supabase.rpc("clear_on_deck_match_atomic", {
        p_match_id: candidate.id,
        p_session_id: sessionId,
      });
      continue;
    }

    match = candidate;
    matchPlayers = rosterRows ?? [];
    break;
  }

  if (!match) {
    // Nothing READY. Surface a contextual warning if unpublished drafts are blocking;
    // held-not-ready matches simply wait their turn (the engine builds a ready match
    // to feed the court, so it never idles).
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

  // matchPlayers was fetched during candidate selection above — reused here
  // instead of re-querying.
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

  // Court call: ping every player on this match (OS-level notification for
  // backgrounded/locked phones). Fired after the response flushes so it
  // never delays or fails the promotion. pushToPlayers no-ops on empty.
  after(() => pushToPlayers(playerIds, "COURT_CALL", sessionId));

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
// recomputeHeldReadiness — cross-court held-draft health check
// ─────────────────────────────────────────────────────────────
// Runs before the engine / promotion at every lifecycle event (Phase 6).
// For each HELD, not-yet-ready, PENDING match in the session:
//   1. Roster integrity (N-2): if the pulled body was swapped OUT of the
//      roster, clear the held columns → downgrade to a normal draft.
//   2. Source integrity (R3-B): if pulled_from_match_id is null/missing
//      (source purged, FK set null), cancel the held draft — it can never
//      resolve readiness, so leaving it would silently lock "Holding".
//   3. Readiness: once the source match is completed/cancelled (body free)
//      AND isHeldMatchReady (≥1 promotion since freed OR rest fallback),
//      stamp held_ready_at so the promotion path may pick it up.
// Idempotent and never throws — safe to call fire-and-forget before a run.
export async function recomputeHeldReadiness(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string
): Promise<void> {
  const { data: heldMatches, error } = await supabase
    .from("matches")
    .select("id, pulled_player_ids, pulled_from_match_id, held_ready_at")
    .eq("session_id", sessionId)
    .eq("is_held", true)
    .eq("status", "pending")
    .is("held_ready_at", null);

  if (error || !heldMatches || heldMatches.length === 0) return;

  // Auto-publish mode publishes each held draft the moment it becomes ready
  // (below), rather than at creation — see the if (ready) block. Fetch once.
  const { data: heldSessionRow } = await supabase
    .from("sessions")
    .select("auto_publish")
    .eq("id", sessionId)
    .single();
  const autoPublish = shouldAutoPublishMatch(heldSessionRow?.auto_publish ?? false);

  for (const held of heldMatches) {
    const pulledId = held.pulled_player_ids?.[0];

    // 1. Roster integrity (N-2) — pulled body still in this match's roster?
    if (pulledId) {
      const { data: rosterRows } = await supabase
        .from("match_players")
        .select("player_id")
        .eq("match_id", held.id);
      const stillIn = (rosterRows ?? []).some((r) => r.player_id === pulledId);
      if (!stillIn) {
        await supabase
          .from("matches")
          .update({ pulled_player_ids: [], pulled_from_match_id: null, held_ready_at: null })
          .eq("id", held.id);
        continue; // downgraded to a normal draft
      }
    }

    // 2. Source integrity (R3-B) — no source match ⇒ cancel the held draft.
    if (!held.pulled_from_match_id) {
      await supabase.rpc("clear_on_deck_match_atomic", {
        p_match_id: held.id,
        p_session_id: sessionId,
      });
      continue;
    }

    const { data: srcMatch } = await supabase
      .from("matches")
      .select("status, completed_at")
      .eq("id", held.pulled_from_match_id)
      .maybeSingle();

    if (!srcMatch) {
      await supabase.rpc("clear_on_deck_match_atomic", {
        p_match_id: held.id,
        p_session_id: sessionId,
      });
      continue;
    }

    // 3. Readiness — the body is free only once its source match ended.
    const freed = srcMatch.status === "completed" || srcMatch.status === "cancelled";
    const pulledFreedAt = freed ? srcMatch.completed_at : null;
    if (!pulledFreedAt) continue; // still Holding (body playing)

    // promotionsSinceFreed = matches that got a started_at after the body freed (C-5,
    // derivable from existing timestamps — no dedicated counter column).
    const { count: promotionsSinceFreed } = await supabase
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .in("status", ["in_progress", "completed", "cancelled"])
      .gt("started_at", pulledFreedAt);

    const ready = isHeldMatchReady({
      pulledFreedAt,
      promotionsSinceFreed: promotionsSinceFreed ?? 0,
      now: Date.now(),
      restFallbackMs: CROSS_COURT_REST_FALLBACK_MINUTES * 60_000,
    });

    if (ready) {
      const { error: stampErr } = await supabase
        .from("matches")
        .update({ held_ready_at: new Date().toISOString() })
        .eq("id", held.id)
        .is("held_ready_at", null); // idempotent — stamp once

      // Auto-publish (D12): publish the held draft the instant it's ready, so it
      // can take a court with no organizer review. Publishing HERE — not at
      // creation — means the still-playing pulled body was never pinged or shown
      // on-deck early; by now its source match has ended and all four members are
      // 'drafted'. auto_publish_match keeps the left/conflict guards and skips
      // (non-SUCCESS) rather than publishing a tainted roster.
      if (!stampErr && autoPublish) {
        const { data: pubResult } = await supabase.rpc("auto_publish_match", {
          p_match_id: held.id,
          p_session_id: sessionId,
        });
        if (pubResult === "SUCCESS") {
          const { data: roster } = await supabase
            .from("match_players")
            .select("player_id")
            .eq("match_id", held.id);
          const rosterIds = (roster ?? []).map((r) => r.player_id);
          after(() => pushToPlayers(rosterIds, "ON_DECK_WARNING", sessionId));
        } else if (pubResult === "HAS_LEFT_PLAYERS" || pubResult === "CONFLICT") {
          // The draft is ready (held_ready_at now stamped) but the roster turned
          // tainted between the stamp and the publish (a player left, or got
          // committed elsewhere). We CANNOT leave it stamped-ready-but-unpublished:
          // recompute only reprocesses held_ready_at IS NULL rows, and promotion
          // only looks at is_published=true — so it would be orphaned forever
          // (and invisible: auto mode hides the draft section). Clear it instead,
          // returning the clean players to waiting so the engine regenerates.
          console.warn(
            `[matchmaking] recomputeHeldReadiness: held draft ${held.id} became ready but ` +
              `auto-publish was blocked (${pubResult}) — clearing it so players re-enter the pool.`
          );
          await supabase.rpc("clear_on_deck_match_atomic", {
            p_match_id: held.id,
            p_session_id: sessionId,
          });
        }
      }
    }
  }
}
