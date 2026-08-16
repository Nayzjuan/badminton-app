// ============================================================
// Suite XC — Cross-Court Held Drafts (Real DB)
// ============================================================
// The cross-court reach shipped dead: 0 held drafts in 945 production
// matches. tests/unit/cross-court-trigger.test.ts pins every predicate
// on the path — read its CCT-* group headers for the roster rather than
// duplicating it here, where it would go stale on the next one added —
// and the replay harness structurally cannot measure the feature at all —
// simplification 3 in scripts/replay/simulate.ts owns that reasoning; read it
// there rather than paraphrasing. So nothing anywhere proved the whole chain
// fires against a real database.
//
// This suite is that proof. It drives the REAL engine through the REAL
// server action (endMatchAction → runEngineForSession) against local
// Supabase and asserts a held draft row actually lands, then exercises
// the hold-age cancel that releases one when the pull goes stale.
//
// Tests:
//   XC-1  auto ON + a stale waiting-only four + a live court
//           → engine commits a HELD draft (is_held, pulled_player_ids,
//             pulled_from_match_id), seats 3 waiters as 'drafted' and
//             leaves the pulled body 'playing'
//   XC-2  a held draft older than CROSS_COURT_MAX_HOLD_MINUTES whose body
//           is still playing → endMatchAction's recomputeHeldReadiness
//           cancels it, releasing the 3 waiters WITHOUT unseating the body
//   XC-3  control for XC-2 — the same event with a fresh held draft leaves
//           it untouched, so the cancel is age-gated, not "any recompute
//           kills holds"
//   CC-CAN-HELD-01  cancelling the SOURCE match re-reserves the pulled body
//           as 'drafted' (the hold survives a cancel), so they never re-enter
//           fetchActivePool while committed to it
//   CC-CAN-HELD-02  cancelling the HELD DRAFT ITSELF leaves the still-playing
//           body untouched at 'playing' — the physical-truth rule
//           clear_on_deck_match_atomic has, applied to the path that bypasses it
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import {
  makeProfile,
  makeSession,
  makeQueueEntry,
  makeCourt,
  makeMatch,
  makeCompletedMatch,
  makeMatchViaRpc,
  enableAutoMatchmaking,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { queryCommitted } from "./helpers/withTx";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { cancelMatchAction, endMatchAction } from "@/app/actions/match-lifecycle";
import { fetchActivePool } from "@/lib/matchmaking-db";
import { CROSS_COURT_MAX_HOLD_MINUTES } from "@/lib/constants";

const faker = new Faker({ locale: [en] });

beforeEach(() => {
  faker.seed(4242);
});

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Local helpers ─────────────────────────────────────────────

/** Creates N intermediate profiles. Same skill throughout — the skill window is not what these tests exercise. */
async function makePlayers(n: number) {
  return Promise.all(
    Array.from({ length: n }, () => makeProfile({ faker, skill: "intermediate" }))
  );
}

/**
 * Sets a waiting player's games_played and joined_at in one statement.
 *
 * Both matter and neither is settable through makeQueueEntry: `games_played`
 * drives computePriorityScore's `wait − games × 8` term, and `joined_at` drives
 * `wait_minutes` in v_queue_with_wait_time, which is both the rest filter
 * (MIN_REST_MINUTES) and the anchor's anchorBlocksReach margin.
 *
 * `waitMinutes` is measured from a caller-supplied `now` so every waiter in a
 * scenario is aged against ONE instant — the score GAPS are what decide the
 * anchor, and they only stay fixed if the whole pool drifts together.
 */
async function ageWaiter(
  entryId: string,
  now: number,
  opts: { games: number; waitMinutes: number }
): Promise<void> {
  const { error } = await serviceClient()
    .from("queue_entries")
    .update({
      games_played: opts.games,
      joined_at: new Date(now - opts.waitMinutes * 60_000).toISOString(),
    })
    .eq("id", entryId);
  if (error) throw new Error(`[ageWaiter] ${error.message}`);
}

/** Stamps started_at on a match. makeMatch leaves it NULL, and fetchPullablePlayers silently returns [] for a NULL-started in_progress match. */
async function startMatch(matchId: string, minutesAgo: number): Promise<void> {
  const { error } = await serviceClient()
    .from("matches")
    .update({ started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
    .eq("id", matchId);
  if (error) throw new Error(`[startMatch] ${error.message}`);
}

/** queue_entries.status for one player, or null if absent. */
async function queueStatusOf(sessionId: string, playerId: string): Promise<string | null> {
  const { data } = await serviceClient()
    .from("queue_entries")
    .select("status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();
  return data?.status ?? null;
}

// ─────────────────────────────────────────────────────────────

describe("Cross-Court Held Drafts (Real DB) — Suite XC", () => {
  // ── XC-1: the engine actually reaches into a live court ─────

  it("XC-1: a stale waiting-only four makes the engine pull a playing body into a HELD draft", async () => {
    // ── Setup ──────────────────────────────────────────────────
    // The scenario is built so exactly one thing can happen. Every number
    // below is load-bearing; the comment on each says which gate it clears.
    const organizer = await makeProfile({ faker });
    const [anchor, w1, w2, w3] = await makePlayers(4); // the waiting pool
    const [b1, b2, b3, b4] = await makePlayers(4); // live on Court 1 — pull candidates
    const [e1, e2, e3, e4] = await makePlayers(4); // live on Court 2 — the match we end
    const [x1, x2, x3, x4] = await makePlayers(4); // the feedable pending draft

    const session = await makeSession({ faker, organizer: organizer.id });
    await enableAutoMatchmaking(session.id);

    const court1 = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });
    const court2 = await makeCourt({ sessionId: session.id, name: "Court 2", status: "in_use" });

    const anchorEntry = await makeQueueEntry({ sessionId: session.id, playerId: anchor.id });
    const w1Entry = await makeQueueEntry({ sessionId: session.id, playerId: w1.id });
    const w2Entry = await makeQueueEntry({ sessionId: session.id, playerId: w2.id });
    const w3Entry = await makeQueueEntry({ sessionId: session.id, playerId: w3.id });
    await Promise.all(
      [b1, b2, b3, b4, e1, e2, e3, e4].map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
      )
    );
    await Promise.all(
      [x1, x2, x3, x4].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );

    // History, oldest first. The order of these two inserts pins the exact
    // lastOpponents sets quoted below — deriveLastOpponents keeps the NEWEST
    // entry per player, so after H2:
    //   w1 → {w2, x2}   w2 → {w3, x4}   w3 → {w2, x3}   anchor → (none)
    // Every one of the three ways to split {anchor,w1,w2,w3} then leaves at
    // least one player facing a last-game opponent (1, 3 and 2 repeats
    // respectively), so baseStaleness ≥ 1 whichever split runAlgorithm picks
    // and wantsFresherFour arms. That ≥ 1 — not the specific sets — is the
    // property the test rests on, and it survives the two inserts landing the
    // other way round (the counts become 2, 3, 1).
    //
    // Pulling any body B instead gives
    // {anchor,B} v {w1,w2} at staleness 0 — a strict improvement, which is
    // what pullImprovesFreshness demands on the non-forcedRepeat path.
    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [w1.id, x1.id],
      teamB: [w2.id, x2.id],
    });
    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [w2.id, x3.id],
      teamB: [w3.id, x4.id],
    });

    // Court 1 — the source of the pull. started_at is mandatory: without it
    // fetchPullablePlayers drops the match and returns no bodies at all.
    const liveMatch = await makeMatch({
      sessionId: session.id,
      teamA: [b1.id, b2.id],
      teamB: [b3.id, b4.id],
      courtId: court1.id,
      status: "in_progress",
      isPublished: true,
    });
    await startMatch(liveMatch.id, 6);

    // Court 2 — ending this is what triggers the engine.
    const endingMatch = await makeMatch({
      sessionId: session.id,
      teamA: [e1.id, e2.id],
      teamB: [e3.id, e4.id],
      courtId: court2.id,
      status: "in_progress",
      isPublished: true,
    });
    await startMatch(endingMatch.id, 8);

    // The courts-stay-fed guard is CAPACITY, not existence: hasFeedableCapacity
    // needs feedable > held, so one pending non-held draft must exist before the
    // engine is allowed to hold anybody. Unpublished, so promoteOnDeckMatchInternal
    // cannot consume it when Court 2 frees.
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [x1.id, x2.id],
      teamB: [x3.id, x4.id],
      isPublished: false,
    });

    // Age the pool LAST — not for the score gaps (the shared `now` already makes
    // those order-independent, see ageWaiter above) but for the ABSOLUTE bounds,
    // which keep drifting for as long as the seeding above still has work to do.
    // The three waiters have to land inside a 2-minute window — [18, 20) — and
    // stay there until the action runs, so the less wall-clock between this block
    // and the call, the more headroom there is. (The anchor's own bound is looser:
    // 12.0 against a ceiling of 17, five minutes away.)
    //   anchor  wait 12.0, 0 games → score 12.0 — top of the pool, and both
    //           anchorBlocksReach arms clear (12 < 17, 12 < 1000).
    //   w1..w3  wait ~18.x, 1 game → score ~10.x — past MIN_REST_MINUTES (18)
    //           so they survive fetchActivePool's rest filter, and short of
    //           CRITICAL_WAIT_MINUTES (20) so none of them jumps to Tier 2 and
    //           out-anchors the anchor.
    // The lower bound is the fragile one: if w3 slipped under 18, only 3 of the
    // 4 would be rested, fetchActivePool would WAIVE the filter and hand back
    // all 8 rows, and a four like {anchor,e1,e2,w1} scores staleness 0 — no
    // repeat to fix, so the reach never arms and the test fails for a reason
    // that has nothing to do with cross-court.
    const now = Date.now();
    await Promise.all([
      ageWaiter(anchorEntry.id, now, { games: 0, waitMinutes: 12.0 }),
      ageWaiter(w1Entry.id, now, { games: 1, waitMinutes: 18.5 }),
      ageWaiter(w2Entry.id, now, { games: 1, waitMinutes: 18.4 }),
      ageWaiter(w3Entry.id, now, { games: 1, waitMinutes: 18.3 }),
    ]);

    // ── Action ─────────────────────────────────────────────────
    // e1–e4 requeue at joined_at=now with games_played=1, so they fail the rest
    // filter and the pool the engine draws from is exactly {anchor, w1, w2, w3}.
    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof endMatchAction>>;
    try {
      result = await endMatchAction(endingMatch.id, 21, 15);
    } finally {
      restore();
    }

    // ── Assert ─────────────────────────────────────────────────
    expect(result!.success).toBe(true);

    const { data: held, error } = await serviceClient()
      .from("matches")
      .select(
        "id, status, is_held, is_published, pulled_player_ids, pulled_from_match_id, held_ready_at, court_id, created_method"
      )
      .eq("session_id", session.id)
      .eq("is_held", true);

    expect(error).toBeNull();
    expect(held).toHaveLength(1);

    const draft = held![0];
    expect(draft.status).toBe("pending");
    expect(draft.court_id).toBeNull();
    expect(draft.created_method).toBe("held");
    // Born hidden — the pulled body is still mid-game, so nothing may show
    // on-deck until recomputeHeldReadiness stamps held_ready_at.
    expect(draft.is_published).toBe(false);
    expect(draft.held_ready_at).toBeNull();
    expect(draft.pulled_from_match_id).toBe(liveMatch.id);
    expect(draft.pulled_player_ids).toHaveLength(1);

    const pulledId = draft.pulled_player_ids[0];
    const bodyIds = [b1.id, b2.id, b3.id, b4.id];
    expect(bodyIds).toContain(pulledId);

    // Roster: the anchor, two of the three waiters, and exactly one pulled body.
    const { data: roster } = await serviceClient()
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", draft.id);
    expect(roster).toHaveLength(4);
    const rosterIds = (roster ?? []).map((r) => r.player_id);
    expect(rosterIds).toContain(anchor.id);
    expect(rosterIds).toContain(pulledId);
    expect(rosterIds.filter((id) => bodyIds.includes(id))).toHaveLength(1);
    const seated = rosterIds.filter((id) => [w1.id, w2.id, w3.id].includes(id));
    expect(seated).toHaveLength(2);

    // The three waiting members are reserved; the pulled body stays on court.
    for (const memberId of [anchor.id, ...seated]) {
      expect(await queueStatusOf(session.id, memberId)).toBe("drafted");
    }
    expect(await queueStatusOf(session.id, pulledId)).toBe("playing");
  });

  // ── XC-2 / XC-3 shared scenario ─────────────────────────────
  //
  // Three waiters parked in a held draft, one body still playing on Court 1,
  // and a second live match on Court 2 whose completion is the real-world
  // event that calls recomputeHeldReadiness. Auto-matchmaking stays OFF so
  // the engine cannot add drafts of its own — these two tests are about the
  // readiness pass alone.
  async function seedHeldDraft() {
    const organizer = await makeProfile({ faker });
    const [m1, m2, m3] = await makePlayers(3);
    const [b1, b2, b3, b4] = await makePlayers(4);
    const [e1, e2, e3, e4] = await makePlayers(4);

    const session = await makeSession({ faker, organizer: organizer.id });
    const court1 = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });
    const court2 = await makeCourt({ sessionId: session.id, name: "Court 2", status: "in_use" });

    await Promise.all([
      ...[m1, m2, m3].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
      ...[b1, b2, b3, b4, e1, e2, e3, e4].map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
      ),
    ]);

    const sourceMatch = await makeMatch({
      sessionId: session.id,
      teamA: [b1.id, b2.id],
      teamB: [b3.id, b4.id],
      courtId: court1.id,
      status: "in_progress",
      isPublished: true,
    });
    await startMatch(sourceMatch.id, 4);

    const triggerMatch = await makeMatch({
      sessionId: session.id,
      teamA: [e1.id, e2.id],
      teamB: [e3.id, e4.id],
      courtId: court2.id,
      status: "in_progress",
      isPublished: true,
    });
    await startMatch(triggerMatch.id, 9);

    const { data: heldId, error } = await serviceClient().rpc("create_held_cross_court_match", {
      p_session_id: session.id,
      p_is_mixed_level: false,
      p_team_a_ids: [m1.id, m2.id],
      p_team_b_ids: [m3.id, b1.id],
      p_pulled_player_id: b1.id,
      p_pulled_from_match_id: sourceMatch.id,
      p_origin: "auto" as const,
    });
    if (error || !heldId) {
      throw new Error(
        `[seedHeldDraft] RPC returned ${heldId} — ${error?.message ?? "guard fired"}`
      );
    }

    return {
      organizer,
      session,
      members: [m1, m2, m3],
      body: b1,
      sourceMatch,
      triggerMatch,
      heldId: heldId as string,
    };
  }

  /** Ends the Court 2 match as the organizer — the real call site of recomputeHeldReadiness. */
  async function endTrigger(organizerId: string, triggerMatchId: string) {
    const restore = mockAuthAs(organizerId);
    try {
      return await endMatchAction(triggerMatchId, 21, 17);
    } finally {
      restore();
    }
  }

  // ── XC-2: hold-age cancel ───────────────────────────────────

  it("XC-2: a held draft past CROSS_COURT_MAX_HOLD_MINUTES is cancelled without unseating its still-playing body", async () => {
    const { organizer, session, members, body, heldId, triggerMatch } = await seedHeldDraft();

    // Backdate past the cap. created_at is deliberately absent from MatchUpdate
    // (nothing in the app rewrites it), so this goes through raw SQL — see
    // queryCommitted. Faking the clock instead would also move the timestamps
    // endMatchAction itself writes, which is a bigger blast radius than one column.
    await queryCommitted(
      "UPDATE matches SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1",
      [heldId, String(CROSS_COURT_MAX_HOLD_MINUTES + 5)]
    );

    const result = await endTrigger(organizer.id, triggerMatch.id);
    expect(result.success).toBe(true);

    // The draft row is deleted by clear_on_deck_match_atomic.
    const { data: after } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("id", heldId)
      .maybeSingle();
    expect(after).toBeNull();

    // The three parked players go back to the pool...
    for (const m of members) {
      expect(await queueStatusOf(session.id, m.id)).toBe("waiting");
    }
    // ...and the body, who is physically on Court 1, does NOT. Flipping them to
    // 'waiting' is the bug 20260812000000 fixed; that migration's header owns the
    // production consequence chain (a body carrying a real wait clears
    // MIN_REST_MINUTES, sorts near the top, gets seated, and then
    // create_match_with_players' Guard 2 returns NULL on their in_progress match,
    // so the engine produces zero matches every tick).
    //
    // This fixture does not reproduce that chain and is not trying to: seedHeldDraft
    // leaves the body at games_played 0 / joined_at ≈ now, so a flip would admit
    // them to the pool via the zero-games branch and score them ≈ 0 — not the
    // elevated wait the production chain turns on. What this assertion pins is the
    // invariant underneath the chain: the queue status never contradicts where the
    // player physically is.
    expect(await queueStatusOf(session.id, body.id)).toBe("playing");
  });

  // ── XC-3: control — a fresh hold survives the same event ────

  it("XC-3: a hold younger than CROSS_COURT_MAX_HOLD_MINUTES survives the same lifecycle event", async () => {
    const { organizer, session, members, body, heldId, triggerMatch } = await seedHeldDraft();

    const result = await endTrigger(organizer.id, triggerMatch.id);
    expect(result.success).toBe(true);

    const { data: after } = await serviceClient()
      .from("matches")
      .select("id, is_held, status, held_ready_at")
      .eq("id", heldId)
      .maybeSingle();

    expect(after).not.toBeNull();
    expect(after!.is_held).toBe(true);
    expect(after!.status).toBe("pending");
    // Its source match is still in_progress, so the body is not free and
    // isHeldMatchReady stays false — still Holding, not ready.
    expect(after!.held_ready_at).toBeNull();

    for (const m of members) {
      expect(await queueStatusOf(session.id, m.id)).toBe("drafted");
    }
    expect(await queueStatusOf(session.id, body.id)).toBe("playing");
  });

  // ── CC-CAN-HELD-01 / -02: cancelMatchAction and a live hold ──
  //
  // Two directions out of the same fixture. seedHeldDraft leaves exactly one
  // player in each of the two states the plain bulk restore gets wrong, and the
  // cancelled match decides which one you hit:
  //   cancel the SOURCE  → the body is FREED and must come back reserved
  //   cancel the HOLD    → the body is still ON COURT and must not be touched
  // Both go through cancelMatchAction, which never calls
  // clear_on_deck_match_atomic and therefore does not inherit that RPC's
  // physical-truth guard (migration 20260812000000).

  /** Cancels a match as the organizer. */
  async function cancelAs(organizerId: string, matchId: string) {
    const restore = mockAuthAs(organizerId);
    try {
      return await cancelMatchAction(matchId);
    } finally {
      restore();
    }
  }

  it("CC-CAN-HELD-01: cancelling the SOURCE match re-reserves the pulled body as 'drafted'", async () => {
    const { organizer, session, members, body, sourceMatch, heldId } = await seedHeldDraft();

    const result = await cancelAs(organizer.id, sourceMatch.id);
    expect(result.success).toBe(true);

    // The hold SURVIVES a cancelled source: recomputeHeldReadiness counts
    // 'cancelled' alongside 'completed' as the event that frees the body, so the
    // draft moves Holding → Resting rather than being torn down. It is not yet
    // stamped — the body was freed a millisecond ago, so neither the promotion
    // nor the 3-minute rest fallback can have been satisfied.
    const { data: held } = await serviceClient()
      .from("matches")
      .select("status, is_held, held_ready_at, pulled_player_ids")
      .eq("id", heldId)
      .maybeSingle();
    expect(held).not.toBeNull();
    expect(held!.status).toBe("pending");
    expect(held!.is_held).toBe(true);
    expect(held!.held_ready_at).toBeNull();
    expect(held!.pulled_player_ids).toEqual([body.id]);

    // The body's seat survives with it. 'waiting' here is the bug: the hold is
    // still holding a seat for them, so the general pool must not see them.
    expect(await queueStatusOf(session.id, body.id)).toBe("drafted");

    // Their three co-members on the cancelled match have no such reservation.
    const { data: sourceRoster } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", sourceMatch.id);
    const others = (sourceRoster ?? []).map((r) => r.player_id).filter((id) => id !== body.id);
    expect(others).toHaveLength(3);
    for (const id of others) {
      expect(await queueStatusOf(session.id, id)).toBe("waiting");
    }

    // The three parked members are untouched — cancelling a source match is not
    // an event about them.
    for (const m of members) {
      expect(await queueStatusOf(session.id, m.id)).toBe("drafted");
    }

    // The mechanism, asserted directly rather than through the engine. A body at
    // 'waiting' is admitted to fetchActivePool, gets seated in a new draft, and
    // create_match_with_players' Guard 2 then returns NULL because they already
    // hold the pending held draft — executeMatch fails and the slot loop breaks.
    // Driving that chain end-to-end needs a pool large and precisely-aged enough
    // for the engine to actually PICK this body, which would make the test's
    // outcome depend on scoring rather than on the fix. Pool admission is the
    // link the fix owns, so that is what this pins.
    const pool = await fetchActivePool(serviceClient(), session.id);
    expect(pool.map((p) => p.player_id)).not.toContain(body.id);
    expect(pool.map((p) => p.player_id)).toEqual(expect.arrayContaining(others));
  });

  it("CC-CAN-HELD-02: cancelling the HELD DRAFT itself never unseats its still-playing body", async () => {
    const { organizer, session, members, body, sourceMatch, heldId } = await seedHeldDraft();

    // The UI never sends this today (active-courts.tsx only surfaces Cancel for
    // an in_progress court, and court-card.tsx renders Clear for a pending row),
    // but cancelMatchAction is an exported server action — a public endpoint —
    // and its CAS accepts 'pending'. This calls it the way an endpoint can be
    // called, which is the only way the guard can be tested.
    const result = await cancelAs(organizer.id, heldId);
    expect(result.success).toBe(true);

    const { data: held } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", heldId)
      .maybeSingle();
    // cancelMatchAction's contract is a SURVIVING row marked cancelled — unlike
    // clear_on_deck_match_atomic, which deletes. The audit event references it.
    expect(held!.status).toBe("cancelled");

    // The three parked members go back to the pool...
    for (const m of members) {
      expect(await queueStatusOf(session.id, m.id)).toBe("waiting");
    }

    // ...and the body does not, because they are physically mid-game on Court 1.
    // Their source match is untouched by this cancel.
    expect(await queueStatusOf(session.id, body.id)).toBe("playing");
    const { data: src } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", sourceMatch.id)
      .maybeSingle();
    expect(src!.status).toBe("in_progress");

    // Not in the pool either — the status and the pool must agree, since it is
    // pool admission (not the string) that stalls the engine.
    const pool = await fetchActivePool(serviceClient(), session.id);
    expect(pool.map((p) => p.player_id)).not.toContain(body.id);
  });
});
