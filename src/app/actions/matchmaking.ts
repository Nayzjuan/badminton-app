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
import { logPublishedEvents } from "@/lib/match-event-log";
import {
  PLAYERS_PER_MATCH,
  CRITICAL_WAIT_MINUTES,
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
  MIN_FREE_POOL_FOR_ON_DECK,
  CROSS_COURT_REST_FALLBACK_MINUTES,
  CROSS_COURT_MAX_HOLD_MINUTES,
} from "@/lib/constants";
import {
  getDynamicDraftCap,
  shouldAutoPublishMatch,
  runAlgorithm,
  scoreAndSortPool,
  isHeldMatchReady,
  heldDraftExpired,
  isPullEligible,
  countConsecutiveOpponentRepeats,
  wantsFresherFour,
  anchorBlocksReach,
  buildCrossCourtProposal,
  isRedZonePlayer,
} from "@/lib/matchmaking-core";
import {
  fetchActivePool,
  fetchRecentClearedRosters,
  fetchSessionMatchSnapshot,
  deriveRecentRosters,
  derivePairCounts,
  deriveOverlapMap,
  deriveLastOpponents,
  executeMatch,
  fetchPullablePlayers,
  hasFeedableCapacity,
  executeHeldMatch,
} from "@/lib/matchmaking-db";
import { isHeldAwaitingReadiness } from "@/lib/cross-court/derive-held-state";
import { isSessionOrganizer, isSessionActive } from "@/app/actions/_shared";
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

  // ── Closed-session gate ───────────────────────────────────────
  // A co-organizer's stale board can still fire this after someone else closed
  // the session. It is the most damaging of the post-close writes: it re-opens
  // a court, creates a match, and moves queue entries back to "playing" on a
  // session whose Wrapped stats have already been computed.
  if (!(await isSessionActive(sessionId))) {
    return { success: false, message: "This session has ended." };
  }

  const service = createServiceClient();

  // ── Court-ownership gate ──────────────────────────────────────
  // The gate above proves the caller organizes `sessionId`; it says nothing
  // about where `courtId` lives, and both ids arrive from the client
  // independently. promoteOnDeckMatchInternal writes `matches.court_id =
  // courtId` and flips that court to "in_use", so without this an organizer
  // of session A could seize a court belonging to another club's session —
  // blocking its board and leaving its own match pointing at a foreign court.
  // Same defect shape as the swap fix in swap-player.ts guard 3b, and the one
  // updateCourtStatusAction/removeCourtAction already guard by appending
  // `.eq("session_id", sessionId)` to their writes. `service` bypasses RLS,
  // so nothing downstream re-checks this.
  const { data: court } = await service
    .from("courts")
    .select("id")
    .eq("id", courtId)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (!court) {
    return { success: false, message: "That court does not belong to this session." };
  }

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
// Draft review queue filler.
//
// slotsAvailable = max(0, effectiveCap − draftCount), then fills slots one at a
// time, stopping when the queue is exhausted. Neither term is a constant:
//
//   effectiveCap = override != null ? min(override, getDynamicDraftCap(waiting))
//                                   : getDynamicDraftCap(waiting)
//     getDynamicDraftCap returns MAX_AUTO_DRAFTS (3) / MAX_AUTO_DRAFTS_LARGE (5)
//     / MAX_AUTO_DRAFTS_XLARGE (6) by waiting-pool size, switching at
//     DRAFT_CAP_LARGE_THRESHOLD (25) and DRAFT_CAP_XLARGE_THRESHOLD (30) — the
//     *_THRESHOLD pair are waiting counts, not caps; do not read them as caps.
//     The organizer's max_auto_drafts_override is a CEILING on the result,
//     never a raise.
//
//   draftCount is mode-dependent, and the two modes count held drafts
//     differently on purpose — see the long comment at the definition below.
//     Draft mode: unpublished pending, minus unready held drafts.
//     Auto-publish mode: published-or-held pending.
//
// Published on-deck matches never count in draft mode: they have already been
// reviewed and are not blocking the review queue.

/**
 * Core engine loop — computes how many on-deck slots are available (capped by
 * `effectiveCap`, derived above; MAX_AUTO_DRAFTS is only its small-session
 * value), then fills each slot by calling `runAlgorithm` against the waiting
 * player pool.
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

  // ── Fetch waiting players + pending matches + session in parallel ─
  //
  // waitingRows is hoisted here (outside !bypassGate) for two reasons:
  //   1. The waiting count drives getDynamicDraftCap — we need it before
  //      computing slotsAvailable, regardless of bypassGate.
  //   2. The same rows are reused for the soft gate and estimatedWaiting,
  //      so we avoid a second round-trip later.
  //
  // pendingMatchRows is fetched as ROWS, not as two `head: true` counts, because
  // both modes need a different predicate over the same tiny set (pending matches
  // are bounded by the draft cap plus the court count — single digits), and one
  // read is cheaper than the count-then-recount round-trip this replaces.
  const [
    { data: waitingRows, error: waitErr },
    { data: pendingMatchRows, error: draftErr },
    { data: sessionRow, error: sessionErr },
    // Rejection memory — per RUN, not per slot: cleared-roster events are only
    // written by organizer actions, never by the engine's own slot commits, so
    // one read covers the whole burst. Fail-open (helper returns [] on error).
    rejectedRosters,
  ] = await Promise.all([
    supabase
      .from("v_queue_with_wait_time")
      .select("wait_minutes")
      .eq("session_id", sessionId)
      .eq("status", "waiting"),
    supabase
      .from("matches")
      .select("id, is_published, is_held, held_ready_at")
      .eq("session_id", sessionId)
      .eq("status", "pending"),
    supabase
      .from("sessions")
      .select("max_auto_drafts_override, auto_publish")
      .eq("id", sessionId)
      .single(),
    fetchRecentClearedRosters(supabase, sessionId),
  ]);
  if (sessionErr) {
    console.warn(`[engine] runEngineInternal: session fetch failed — ${sessionErr.message}`);
  }

  if (draftErr) {
    console.error(`[engine] runEngineInternal: pending-match fetch failed — ${draftErr.message}`);
    return;
  }
  // waitErr is non-fatal — fall back to default cap if the view is unavailable.
  if (waitErr) {
    console.warn(`[engine] runEngineInternal: waiting-rows fetch failed — ${waitErr.message}`);
  }

  // ── Held-draft heartbeat ─────────────────────────────────────
  //
  // Until this existed, recomputeHeldReadiness had exactly two callers, both in
  // match-lifecycle.ts (match end / cancel), so a hold could only advance when
  // some OTHER match happened to end. That is the gap behind the field report:
  // the RESTING→READY stamp needs CROSS_COURT_REST_FALLBACK_MINUTES of rest to
  // have elapsed, which by construction is never true at the instant the source
  // match ends — so the one event that fires the recompute is the one event that
  // cannot stamp. Nothing fires again until the next match ends, and in session
  // 3367d4c6 two holds sat unresolved for ~10 minutes waiting for that. The
  // engine also runs on queue joins, publishes and clears, so calling it here
  // is a materially denser heartbeat. Still not a timer: on a session where
  // nothing at all happens, nothing fires, and this sits below the courtCount
  // early-return and inside the is_auto_matchmaking_on gate, so a session with
  // every court closed or the engine switched off gets no heartbeat from here.
  // The ⚠️ on CROSS_COURT_MAX_HOLD_MINUTES still holds — ATTENTION, not elapsed
  // time — it is only widened.
  //
  // Gated on the rows we already have, so a session with no live hold pays
  // NOTHING for it. When one does fire we re-read the pending set rather than
  // count the pre-recompute snapshot, because the recompute can stamp (a hold
  // becomes publishable, so draft mode must now count it), cancel (a hold past
  // its age cap disappears) or downgrade (the pulled body was swapped out, so it
  // becomes a plain draft) — all three change the number below.
  //
  // Safe to re-enter: endMatchAction already calls it, so a match end now runs
  // it twice. Idempotent by construction (the stamp is `.is("held_ready_at",
  // null)`), and the second pass is the useful one, because it lands AFTER that
  // end's promotion and so sees the incremented promotionsSinceFreed.
  let pendingRows = pendingMatchRows ?? [];
  if (pendingRows.some(isHeldAwaitingReadiness)) {
    await recomputeHeldReadiness(supabase, sessionId);
    const { data: refreshedPending, error: refreshErr } = await supabase
      .from("matches")
      .select("id, is_published, is_held, held_ready_at")
      .eq("session_id", sessionId)
      .eq("status", "pending");
    if (refreshErr) {
      console.warn(
        `[engine] runEngineInternal: pending re-read after held recompute failed — ${refreshErr.message}`
      );
    } else if (refreshedPending) {
      pendingRows = refreshedPending;
    }
  }

  const autoPublish = shouldAutoPublishMatch(sessionRow?.auto_publish ?? false);

  const waitingCount = waitingRows?.length ?? 0;
  const dynamicCap = getDynamicDraftCap(waitingCount);
  // Apply organizer override as a ceiling: min(override, dynamicCap).
  // null override means "use dynamic cap as-is".
  const override = sessionRow?.max_auto_drafts_override ?? null;
  const effectiveCap = override != null ? Math.min(override, dynamicCap) : dynamicCap;

  // Mode-dependent cap count, both derived from the single pending-match read.
  //
  // Draft mode — the REVIEW QUEUE: unpublished drafts, MINUS held drafts whose
  //   hold is not yet ready. Published on-deck matches are already reviewed;
  //   counting them would block fresh generation while reviewed matches wait for
  //   a court. Unready held drafts are excluded for the same reason in reverse:
  //   the organizer cannot action them at all (publish_match refuses until
  //   held_ready_at is stamped), so a cap slot spent on one is a slot nothing can
  //   ever free. That was the deadlock: with max_auto_drafts_override low enough,
  //   a single hold saturated the cap, the engine stopped generating, and the
  //   organizer's only exit was to clear the draft the UI was telling them to
  //   publish. A hold that HAS been stamped ready is publishable, so it counts.
  //   OnDeckPanel's publishableDraftMatches applies the identical predicate — the
  //   two must agree or the cap notice describes a cap nobody is enforcing.
  //
  // Auto-publish mode — the ON-DECK queue: there is no review step, so the cap
  //   limits what is on deck. Held drafts count here even though they are
  //   is_published=false, because in this mode they auto-publish the instant they
  //   are ready (recomputeHeldReadiness), so each one RESERVES an on-deck slot.
  //   Not counting them would let the engine overshoot the cap the moment a batch
  //   of holds resolved together. This is why the two branches differ on held
  //   drafts: the draft-mode question is "can the organizer act on it?", the
  //   auto-mode question is "will this take a court slot?".
  //
  // ⚠️ Draft mode's exclusion means this cap no longer bounds unready holds at
  //   all — it used to, by accident, back when every unpublished draft counted.
  //   The replacement bound is CROSS_COURT_MAX_UNREADY_HOLDS, enforced in
  //   hasFeedableCapacity at the moment a hold is created. Do not reason about
  //   draft-mode pending totals from `effectiveCap` alone: unready holds add up
  //   to CROSS_COURT_MAX_UNREADY_HOLDS on top of it, and PUBLISHED pending rows
  //   are excluded by this same branch and bounded by nothing here at all (they
  //   drain as courts free). `effectiveCap` bounds the review queue, not the
  //   pending set.
  const draftCount = autoPublish
    ? pendingRows.filter((m) => m.is_published || m.is_held).length
    : pendingRows.filter((m) => !m.is_published && !isHeldAwaitingReadiness(m)).length;
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
    // Whole-pool, not anchor-relative: 79% of back-to-back opponent repeats are
    // between two NON-anchor co-players, which the anchor-relative overlapMap
    // structurally cannot see. Re-derived per slot because the match just
    // committed above is a new "last match" for four players.
    const lastOpponents = deriveLastOpponents(snapshot);

    // ── Pure algorithm — zero DB calls ───────────────────────────
    const result = runAlgorithm(
      pool,
      partnershipCounts,
      overlapMap,
      recentRosters,
      opponentCounts,
      rejectedRosters,
      lastOpponents
    );
    const { proposal, capSaturation } = result;

    if (!proposal) {
      // Broadcast cap-saturation warning when the cap (not player shortage)
      // was the reason no match formed. The broadcast is fire-and-forget.
      if (capSaturation) {
        const anchor = pool[0];
        broadcastCapSaturation(sessionId, {
          // isRedZonePlayer, not a score test: CapSaturationPayload documents
          // "red_zone" as "anchor has waited >= CRITICAL_WAIT_MINUTES" and the
          // UI copy in sortable-card.tsx says "waiting over 20 min", so a score
          // test made the payload disagree with both (a wait-22 / 3-games anchor
          // scores 998 and was broadcast as "general").
          type: isRedZonePlayer(anchor) ? "red_zone" : "general",
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
    // Reach into a live court for ONE fresh body when the waiting pool alone
    // can only produce a STALE four. Requires: not a bypass run (M-4), the
    // anchor is not in the Red Zone (decision 4 — a Red-Zone player is seated
    // now, never held), and a courts-stay-fed guard (see below).
    //
    // "Stale" is two conditions, not one:
    //   * forcedRepeat — the pool could manage no better than a repeat. This
    //     was the ORIGINAL sole trigger, and on its own it is self-defeating:
    //     it fires only when the engine fails, measured at 22/550 replayed
    //     matches (4%), and P2 made repeats rarer still. The better the engine
    //     gets at avoiding repeats with waiting players, the less often the
    //     cross-court escape hatch could ever arm.
    //   * consecutive-opponent staleness — at least one of the four would face
    //     someone they faced in their immediately-previous game. This is the
    //     condition the owner actually complains about, and it is true far more
    //     often than forcedRepeat. Same metric P2 optimises, so the two agree
    //     on what "fresher" means.
    const baseSplit = { teamA: proposal.teamA, teamB: proposal.teamB };
    const baseStaleness = countConsecutiveOpponentRepeats(baseSplit, lastOpponents);

    let committedHeld = false;

    // Never hold the front of the queue when it is close to needing service.
    // Dropping the old `i > 0` proxy changed who this anchor is: it used to be
    // the 5th-highest-priority waiter and is now the HIGHEST-priority one.
    // (Not "the longest waiter" — an earlier revision of this comment said so
    // and was wrong; scoreAndSortPool sorts by priorityScore, which nets off
    // games played. See the ⚠️ on anchorBlocksReach.) Full rationale, and the
    // MIN_REST_MINUTES interaction, live there.
    //
    // ⚠️ This covers the ANCHOR ONLY. There is deliberately NO seat-level
    // guard inside buildCrossCourtProposal's loop — one was tried and is
    // unreachable dead code (a Tier-2 player always outranks any Tier-1 player,
    // so a Red-Zone seat below pool[0] cannot exist); see the ⚠️ on
    // anchorBlocksReach, which says "Do not re-add it". The two seated waiters
    // are covered by the hold-age cancel instead — see the next paragraph.
    //
    // Residual, accepted — and NOT what the margin bounds. The guard bounds the
    // anchor's wait when the hold is CREATED; it does not bound how long the
    // hold lasts. isHeldMatchReady returns false until pulledFreedAt is set, so
    // the hold runs for the remainder of the source game plus up to
    // CROSS_COURT_REST_FALLBACK_MINUTES. That duration is bounded — BEST-EFFORT,
    // not guaranteed — by recomputeHeldReadiness' hold-age cancel
    // (CROSS_COURT_MAX_HOLD_MINUTES), which is what covers the two seated
    // waiters this guard does not see. Best-effort because the cancel is
    // evaluated on an event, not on a timer: match-lifecycle.ts calls it when a
    // match on a court ends or is cancelled, and this engine calls it on any run
    // that already sees an unready hold. On a session that goes quiet — or with
    // the engine off, or every court closed — a hold can still outlive the cap
    // until the next such event. See the doc on CROSS_COURT_MAX_HOLD_MINUTES in
    // constants.ts.
    // Measured on production, the soonest
    // court to free at draft time is p50 4.7 min / p90 12.7 / p99 18.1, so most
    // holds outlast the 3-minute fallback by a wide margin. What makes that
    // acceptable is not the fallback but WHO passes this guard: modelled over
    // 94 allowed reaches, the anchor's wait at release is p50 13.5 / p90 18.5,
    // crossing CRITICAL_WAIT_MINUTES in 5.3% of holds and HARD_WAIT_CAP_MINUTES
    // in 2.1%. ⚠️ That model measures the ANCHOR, i.e. 1 of the 3 held waiters,
    // so it understates the true residual — do not quote it as the figure for
    // the hold as a whole. The hold-age cancel named above is what bounds it,
    // on the best-effort terms stated there.
    const anchorBlocked = anchorBlocksReach(pool[0].priorityScore, pool[0].wait_minutes ?? 0);

    // The courts-stay-fed guard, formerly the `i > 0` proxy. A held draft seats
    // nobody when it is created, so it is only safe while pending FEEDABLE
    // matches still outnumber pending held drafts — capacity, not mere
    // existence, or successive slots in this same run would stack held drafts
    // against one spare. Checked AFTER the cheap predicates so the extra round
    // trip only happens on the path that actually wants a pull.
    if (
      wantsFresherFour(result.forcedRepeat, baseStaleness) &&
      !bypassGate &&
      !anchorBlocked &&
      (await hasFeedableCapacity(supabase, sessionId))
    ) {
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

        // The pull is FORCED into every candidate four rather than competed for.
        // Appending bodies at priorityScore -1 and letting runAlgorithm choose —
        // what this did before — does not work, because the body's score is not
        // what decides: buildCombinationGroup's argmin ranks whole TRIPLES by
        // `fairness + 3 × repeats`, and the repeats term depends on the four, not
        // the candidate. `priorityScore: -1` is not a control surface.
        // Full derivation (and the three wrong versions of it) lives on
        // buildCrossCourtProposal — read it there rather than paraphrasing.
        const pick = buildCrossCourtProposal(
          pool,
          eligible.map((b) => ({ ...b, priorityScore: -1, isPulled: true as const })),
          {
            partnershipCounts,
            overlapMap,
            recentRosters,
            opponentCounts,
            rejectedRosters,
            lastOpponents,
            baseStaleness,
            forcedRepeat: result.forcedRepeat,
          }
        );

        if (pick) {
          const fromMatchId = pulledMatchId.get(pick.pulledPlayerId);
          if (fromMatchId) {
            const heldExec = await executeHeldMatch(
              supabase,
              sessionId,
              pick.proposal,
              pick.pulledPlayerId,
              fromMatchId
            );
            if (heldExec.success) {
              committedHeld = true;
              // A held draft consumes 3 waiting players, not 4 (C-1). The
              // enclosing branch already requires !bypassGate, so this is
              // unconditional in practice — left explicit as a guard against
              // the branch condition being relaxed without revisiting this.
              if (!bypassGate) estimatedWaiting -= PLAYERS_PER_MATCH - 1;
            }
          }
        }
      }
    }

    if (committedHeld) continue; // held draft created — on to the next slot

    // ── Commit the match ─────────────────────────────────────────
    // bypassGate slot 0 must be born PUBLISHED regardless of the session's
    // draft-mode flag: callNextMatch retries promotion immediately after this
    // run, and promotion only considers is_published=true (the draft guard).
    // Without this, the organizer's primary button composes a match it can
    // never seat and nags "review drafts" instead — the draft-mode dead end
    // (verified live on 08/06: every Call Next during draft mode failed).
    // Only slot 0: the promotion retry consumes exactly one match; any extra
    // slots a bypass run fills are background work and stay in the review flow.
    // bypassGate=true has a single caller (callNextMatch), which is organizer-
    // authenticated and court-scoped — keep it that way before adding callers.
    const effectiveAutoPublish = autoPublish || (bypassGate && i === 0);
    const execResult = await executeMatch(
      supabase,
      sessionId,
      null,
      proposal,
      true,
      effectiveAutoPublish
    );
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

    // The match went straight to On Deck (is_published=true), skipping the
    // publish action where ON_DECK_WARNING normally fires. Send it here so
    // players learn they're on deck. Fire-and-forget; never blocks the engine.
    // (Draft mode stays silent until the organizer publishes.) Keyed off the
    // EFFECTIVE flag: a bypassGate slot-0 match is published too, and if its
    // promotion retry loses a race and it stays on deck, the four players
    // must still have been warned.
    if (effectiveAutoPublish) {
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
  // ── Court-ownership gate (audit #12) ──────────────────────────
  // Authorize BEFORE any lookup. `sessionId` and `courtId` arrive as two
  // independent arguments, and `supabase` here is always the service client,
  // so RLS re-checks nothing downstream.
  //
  // 🪤 The `.eq("session_id", …)` on the courts UPDATE further down CANNOT do
  // this job, and an earlier draft of this branch wrongly implied it could.
  // By the time that predicate runs, the CAS has already committed the match
  // row `in_progress` with `court_id = courtId`: a foreign court would still
  // be stamped onto the match and the caller would still get `success: true`.
  // Only the `courts.status` flip would have been blocked. A guard placed
  // after the write it is meant to prevent is not a guard.
  //
  // For every in-repo caller this is redundant — callNextMatch validates the
  // pair at :183-192, and endMatch/cancelMatch pass `match.court_id` +
  // `match.session_id` off the same row behind an `if (match.court_id)`. It is
  // here for reason #0 on the courts UPDATE below: this helper is an export of
  // a `"use server"` module, so it is one client-side import away from being
  // dispatchable with no auth gate of its own.
  const { data: ownedCourt } = await supabase
    .from("courts")
    .select("id")
    .eq("id", courtId)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (!ownedCourt) {
    return { success: false, message: "That court does not belong to this session." };
  }

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
    //
    // That second clause used to be a comment the query contradicted: a head-count
    // of every unpublished draft included unready holds, so a session whose only
    // draft was a hold answered "1 draft match needs review before the next game
    // can start" and ActiveCourts raised the amber "Drafts Waiting for Approval"
    // banner — pointing at a card that now deliberately has no Publish button.
    // Fetching the rows instead of head-counting lets the same predicate the
    // publish paths and the cap use decide what "needs review" means.
    const { data: draftRows, error: draftCountError } = await supabase
      .from("matches")
      .select("id, is_held, held_ready_at")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .eq("is_published", false);
    const draftCount = (draftRows ?? []).filter((m) => !isHeldAwaitingReadiness(m)).length;

    if (!draftCountError && draftCount > 0) {
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

  // `.eq("session_id", …)` is redundant for every in-repo caller as things
  // stand — callNextMatch validates `courtId` against `sessionId` before it
  // gets here, and endMatch/cancelMatch pass `match.court_id` +
  // `match.session_id` off the same row. It is here so the invariant is
  // enforced at the write itself, for three reasons the callers cannot supply:
  //   0. In-repo callers are not the only thing that decides reachability.
  //      This module is `"use server"` and this function is exported, so the
  //      build DOES mint it an action id (`registerServerReference`). What
  //      stops a hand-crafted POST is not this signature and not any gate in
  //      here — it is that the id is absent from `server-reference-manifest`'s
  //      `node` map, because no CLIENT component imports it. Next rejects at
  //      the `serverModuleMap[actionId]` lookup (next/dist/server/app-render/
  //      action-handler.js:932-934) before it deserializes any argument.
  //      Same for `recomputeHeldReadiness`. Verified on the 2026-08-13 build:
  //      of this module's four exports only `callNextMatch` is in the manifest.
  //      ⚠ That is a BUILD-DERIVED property and it flips the first time a
  //      client component imports either helper — at which point they become
  //      dispatchable with no auth gate of their own. This predicate is the
  //      defence-in-depth for that day.
  //      🪤 An earlier draft of this note claimed they fail closed "because
  //      argument 1 is a Supabase client that cannot be serialized". Plausible,
  //      and wrong: the request never reaches argument binding. Do not restate
  //      it — check the manifest.
  //   1. A future caller could reach this helper without the gate.
  //   2. The invariant is code-maintained, NOT schema-enforced — `matches`
  //      has `court_id uuid REFERENCES courts(id)` (initial_schema:223), a
  //      single-column FK, so nothing in the DB stops a match from pointing
  //      at a court in another session.
  // Scope, precisely: this predicate is the SECOND half of the pair. The
  // cross-session write is stopped by the gate at the top of this function,
  // which runs before the CAS; by the time we get here the match row is
  // already committed pointing at `courtId`, so all this can still protect is
  // the `courts.status` flip. Do not describe it as what closes audit #12.
  // It is not vacuous, though — because of (2) it can genuinely match 0 rows,
  // so that is reported rather than swallowed: otherwise the caller would see
  // success with the match `in_progress` while the court stayed `available` —
  // a board showing a free court under a live match, with nothing logged.
  const { error: courtError, count: courtCount } = await supabase
    .from("courts")
    .update({ status: "in_use" as const }, { count: "exact" })
    .eq("id", courtId)
    .eq("session_id", sessionId);

  if (courtError || courtCount === 0) {
    console.error(
      `[promoteOnDeckMatch] court ${courtId} was not marked in_use for session ${sessionId}: ${
        courtError?.message ?? "no matching court row"
      }`
    );
  }

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
// Runs before the engine / promotion at every lifecycle event (Phase 6), and —
// since the RESTING→READY stamp can never land on the event that ends the source
// match — again from runEngineInternal on any run whose pending set still holds
// an unready hold. Callers must assume it is re-entered; every step below is
// idempotent.
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
    .select("id, pulled_player_ids, pulled_from_match_id, held_ready_at, created_at")
    .eq("session_id", sessionId)
    .eq("is_held", true)
    .eq("status", "pending")
    .is("held_ready_at", null);

  if (error) {
    // A read that FAILED is not a session with no holds. Both used to return
    // here identically, so every silent branch below was also silent about the
    // one condition that explains the other three.
    console.warn(
      `[matchmaking] recomputeHeldReadiness: held-draft fetch failed for session ${sessionId} — ` +
        `${error.message}; nothing recomputed this pass.`
    );
    return;
  }
  if (!heldMatches || heldMatches.length === 0) return;

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
      const { data: rosterRows, error: rosterErr } = await supabase
        .from("match_players")
        .select("player_id")
        .eq("match_id", held.id);
      // `?? []` used to fold a FAILED read into "the body is not in the roster",
      // which downgrades the draft and throws the pull away — a destructive
      // answer derived from no answer. Leave the row exactly as it is and let
      // the next pass decide on a real read.
      if (rosterErr || !rosterRows) {
        console.warn(
          `[matchmaking] recomputeHeldReadiness: roster read failed for held draft ${held.id} — ` +
            `${rosterErr?.message ?? "no rows returned"}; left untouched this pass.`
        );
        continue;
      }
      const stillIn = rosterRows.some((r) => r.player_id === pulledId);
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

    const { data: srcMatch, error: srcErr } = await supabase
      .from("matches")
      .select("status, completed_at")
      .eq("id", held.pulled_from_match_id)
      .maybeSingle();

    // Same distinction as the roster read, and `maybeSingle` already draws it:
    // a source that is GONE is data null WITH error null. Cancelling on the
    // other case releases three seated players because one SELECT failed.
    if (srcErr) {
      console.warn(
        `[matchmaking] recomputeHeldReadiness: source-match read failed for held draft ${held.id} — ` +
          `${srcErr.message}; left untouched this pass.`
      );
      continue;
    }

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

    // 3a. Hold-age cancel — the guard for the two seated waiters that
    // anchorBlocksReach does not cover (it bounds the ANCHOR's wait, at
    // creation time only). A body that is still playing this far in is not
    // worth parking three people for: release them so the engine can seat them
    // in a normal draft. Only fires while still Holding — once the body frees,
    // isHeldMatchReady resolves on its own within the rest fallback.
    if (
      heldDraftExpired({
        createdAt: held.created_at,
        pulledFreedAt,
        now: Date.now(),
        maxHoldMs: CROSS_COURT_MAX_HOLD_MINUTES * 60_000,
      })
    ) {
      console.warn(
        `[matchmaking] recomputeHeldReadiness: held draft ${held.id} exceeded ` +
          `CROSS_COURT_MAX_HOLD_MINUTES (${CROSS_COURT_MAX_HOLD_MINUTES}m) with its body ` +
          `still playing — cancelling so the three parked players re-enter the pool.`
      );
      await supabase.rpc("clear_on_deck_match_atomic", {
        p_match_id: held.id,
        p_session_id: sessionId,
      });
      continue;
    }

    if (!pulledFreedAt) continue; // still Holding (body playing)

    // promotionsSinceFreed = matches that got a started_at after the body freed (C-5,
    // derivable from existing timestamps — no dedicated counter column).
    const { count: promotionsSinceFreed, error: promoErr } = await supabase
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .in("status", ["in_progress", "completed", "cancelled"])
      .gt("started_at", pulledFreedAt);

    // Falling back to 0 only DELAYS the stamp — the rest-fallback arm below
    // still resolves the hold on its own — so it stays the default. It does not
    // stay silent: a persistently failing count reads as "the promotion arm
    // never fires", which is indistinguishable from a wrong threshold.
    if (promoErr) {
      console.warn(
        `[matchmaking] recomputeHeldReadiness: promotion count failed for held draft ${held.id} — ` +
          `${promoErr.message}; treating it as 0 (the rest fallback still applies).`
      );
    }

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

      if (stampErr) {
        // The one write this whole function exists to make. Unlogged, a failure
        // here is indistinguishable from "not ready yet" at every observation
        // point the app has — including the tests.
        console.warn(
          `[matchmaking] recomputeHeldReadiness: readiness stamp failed for held draft ${held.id} — ` +
            `${stampErr.message}; the hold stays unready until the next pass.`
        );
      }

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
          // Audit: the third draft → published transition, and the only one with
          // no organizer behind it — actorType 'engine', not the actorId-derived
          // 'system', because this IS the matchmaking engine acting. Without this
          // row an auto-published held draft is indistinguishable in the ledger
          // from one that was never published at all, which is precisely the
          // inference the 08/15 cross-court post-mortem could not make.
          // Best-effort — logPublishedEvents never throws.
          await logPublishedEvents({
            db: supabase,
            sessionId,
            matchIds: [held.id],
            reason: "auto_publish_held",
            actorId: null,
            actorName: null,
            actorType: "engine",
          });

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
