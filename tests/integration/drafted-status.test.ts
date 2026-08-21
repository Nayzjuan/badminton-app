// ============================================================
// Suite: drafted queue_status — Integration Tests
// ============================================================
// Tests the full lifecycle of the "drafted" queue status:
//
//   waiting → drafted  (create_match_with_players, p_is_published=false)
//   drafted → on_deck  (publishMatchAction)
//   drafted → waiting  (cancelMatchAction on a draft)
//   + swap_player_in_match with p_is_published=false → drafted
//   + joinQueueAction blocks "drafted" players
//   + engine excludes "drafted" players from new drafts
//   + session close sets "drafted" players to "left"
//
// Gap tests (G-1 through G-16) fill every negative / edge scenario
// identified in the gap analysis review:
//
//   G-1  CRITICAL – RPC Guard 0: drafted player already in a draft is rejected
//   G-2  CRITICAL – Concurrent overlapping RPC calls: only one wins
//   G-3  HIGH     – cancelMatchAction auth guards (unauth + non-organizer)
//   G-4  HIGH     – publishMatchAction BUG-002: 'left' player blocks publish
//   G-5  HIGH     – Double-cancel returns error
//   G-6  HIGH     – cancelMatchAction on in_progress match
//   G-7  HIGH     – publishAllDraftMatchesAction skips tainted draft
//   G-8  HIGH     – cancelMatchAction: wrong-session organizer rejected
//   G-9  MEDIUM   – Engine with mix of drafted+on_deck+waiting
//   G-10 MEDIUM   – joinQueueAction blocks on_deck players too
//   G-11 MEDIUM   – swap_player_in_match p_is_published=true → on_deck
//   G-12 MEDIUM   – cancelMatchAction on a published (on_deck) match
//   G-13 MEDIUM   – publishMatchAction: non-existent match ID
//   G-14 LOW      – closeSession: mix of all statuses → left
//   G-15 LOW      – RPC with invalid UUID inputs
//   G-16 LOW      – publishMatchAction on a 'completed' match
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import {
  makeProfile,
  makeSession,
  makeQueueEntry,
  makeCourt,
  makeMatch,
  makeMatchViaRpc,
  enableAutoMatchmaking,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { cancelMatchAction } from "@/app/actions/match-lifecycle";
import { publishMatchAction, publishAllDraftMatchesAction } from "@/app/actions/match-drafts";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { joinQueueAction } from "@/app/actions/queue";
import { closeSession } from "@/app/actions/sessions";

const faker = new Faker({ locale: [en] });
faker.seed(9001);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared helpers ─────────────────────────────────────────────

/** Creates organizer + session + 1 court + N queued players. */
async function baseSetup(playerCount = 4) {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });
  const players = await Promise.all(
    Array.from({ length: playerCount }, () => makeProfile({ faker }))
  );
  await Promise.all(players.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })));
  return { organizer, session, court, players };
}

/** Fetches queue statuses for the given player IDs in a session. */
async function getStatuses(sessionId: string, playerIds: string[]) {
  const { data } = await serviceClient()
    .from("queue_entries")
    .select("player_id, status")
    .eq("session_id", sessionId)
    .in("player_id", playerIds);
  const rows = data ?? [];
  // Every caller does `for (const e of getStatuses(...)) expect(e.status)...`,
  // so a short read asserts nothing and the test passes green. Returning one
  // row per requested player is part of this helper's contract — a missing
  // queue_entry is itself a regression, not a reason to assert less.
  expect(rows.map((r) => r.player_id).sort()).toEqual([...playerIds].sort());
  return rows;
}

// ─────────────────────────────────────────────────────────────
describe("drafted queue_status", () => {
  // ── 1. RPC sets 'drafted' for unpublished drafts ─────────────
  it("create_match_with_players with p_is_published=false sets all 4 players to 'drafted'", async () => {
    const { session, players } = await baseSetup(4);

    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );

    expect(statuses).toHaveLength(4);
    for (const entry of statuses) {
      expect(entry.status).toBe("drafted");
    }
  });

  // ── 2. RPC sets 'on_deck' for published matches ──────────────
  it("create_match_with_players with p_is_published=true sets all 4 players to 'on_deck'", async () => {
    const { session, players } = await baseSetup(4);

    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );

    expect(statuses).toHaveLength(4);
    for (const entry of statuses) {
      expect(entry.status).toBe("on_deck");
    }
  });

  // ── 3. publishMatchAction: drafted → on_deck ─────────────────
  it("publishMatchAction transitions all 4 players from 'drafted' to 'on_deck'", async () => {
    const { organizer, session, players } = await baseSetup(4);

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("on_deck");
    }
  });

  // ── 4. publishMatchAction heals 'waiting' roster members ─────
  // publish_match originally promoted only status = 'drafted', so publishing a
  // draft whose players were never marked 'drafted' silently left them behind.
  // 20260717165546 widened the predicate to IN ('drafted','waiting') precisely
  // to heal those rows: everyone in a roster being published belongs on deck,
  // and the conflict checks have already run by that point. This test pins the
  // healing behaviour (it previously asserted the old drafted-only guard, which
  // no integration run ever exercised — the suite could not start until the
  // migration replay was fixed).
  it("publishMatchAction promotes 'waiting' roster members to 'on_deck'", async () => {
    const { organizer, session, players } = await baseSetup(4);

    // makeMatch bypasses the RPC — players stay "waiting"
    const match = await makeMatch({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      status: "pending",
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof publishMatchAction>>;
    try {
      result = await publishMatchAction(match.id);
    } finally {
      restore();
    }

    // Publish itself succeeds (it flips is_published=true on the match row)
    expect(result!.success).toBe(true);

    // ...and the roster is healed onto the deck even though makeMatch bypassed
    // the RPC and left every player "waiting".
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    expect(statuses).toHaveLength(4);
    for (const entry of statuses) {
      expect(entry.status).toBe("on_deck");
    }
  });

  // ── 5. cancelMatchAction on draft: drafted → waiting ────────
  it("cancelling a draft match restores all 4 players to 'waiting'", async () => {
    const { organizer, session, players } = await baseSetup(4);

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    // Confirm players are "drafted" before cancelling
    const before = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    expect(before.every((e) => e.status === "drafted")).toBe(true);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const after = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of after) {
      expect(entry.status).toBe("waiting");
    }
  });

  // ── 6. swap_player_in_match: incoming player gets 'drafted' ──
  it("swap_player_in_match with p_is_published=false sets incoming player to 'drafted'", async () => {
    // 4 drafted + 1 waiting (the swap candidate)
    const { session, players } = await baseSetup(5);
    const [p1, p2, p3, p4, swapIn] = players;

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: false,
    });

    // swapIn should still be "waiting" (only the drafted 4 were set)
    const [swapInBefore] = await getStatuses(session.id, [swapIn.id]);
    expect(swapInBefore.status).toBe("waiting");

    // Call swap_player_in_match RPC: swap out p4, swap in swapIn
    // p_is_published=false → incoming player should get "drafted"
    const { error } = await serviceClient().rpc("swap_player_in_match", {
      p_match_id: match.id,
      p_out_player_id: p4.id,
      p_in_player_id: swapIn.id,
      p_session_id: session.id,
      p_team: "b",
      p_is_published: false,
    });
    expect(error).toBeNull();

    // swapIn should now be "drafted"
    const [swapInAfter] = await getStatuses(session.id, [swapIn.id]);
    expect(swapInAfter.status).toBe("drafted");

    // p4 (outgoing) should now be "waiting"
    const [p4After] = await getStatuses(session.id, [p4.id]);
    expect(p4After.status).toBe("waiting");
  });

  // ── 7. publishMatchAction after draft swap: all 4 → on_deck ──
  // The critical regression test: after swapping a player into a draft,
  // publishMatchAction must promote ALL 4 players (incl. swapped-in one).
  it("publishMatchAction after draft swap promotes swapped-in player to 'on_deck'", async () => {
    const { organizer, session, players } = await baseSetup(5);
    const [p1, p2, p3, p4, swapIn] = players;

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: false,
    });

    // Swap p4 out, swapIn in (both end up with "drafted")
    await serviceClient().rpc("swap_player_in_match", {
      p_match_id: match.id,
      p_out_player_id: p4.id,
      p_in_player_id: swapIn.id,
      p_session_id: session.id,
      p_team: "b",
      p_is_published: false,
    });

    // Publish — should promote p1, p2, p3, swapIn to "on_deck"
    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    // Roster after publish: p1, p2, p3, swapIn → all "on_deck"
    const rosterStatuses = await getStatuses(session.id, [p1.id, p2.id, p3.id, swapIn.id]);
    for (const entry of rosterStatuses) {
      expect(entry.status).toBe("on_deck");
    }

    // p4 (removed from match) should have returned to "waiting" during swap
    const [p4Status] = await getStatuses(session.id, [p4.id]);
    expect(p4Status.status).toBe("waiting");
  });

  // ── 8. joinQueueAction blocks 'drafted' players ──────────────
  it("joinQueueAction returns an error for a player already in 'drafted' status", async () => {
    const { session, players } = await baseSetup(4);

    // Puts players[0] in "drafted" state via RPC
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    // Attempt to re-join — should be blocked
    const restore = mockAuthAs(players[0].id);
    try {
      const result = await joinQueueAction(session.id);
      // Must return an error, not succeed
      expect("error" in result).toBe(true);
      expect(typeof (result as { error: string }).error).toBe("string");
    } finally {
      restore();
    }
  });

  // ── 9. Engine excludes 'drafted' players from new drafts ─────
  it("runEngineForSession does not re-draft players already in 'drafted' status", async () => {
    // 4 players drafted into match 1, 4 more waiting — only the 4 waiting should form match 2
    const { session, players } = await baseSetup(8);
    await enableAutoMatchmaking(session.id);
    await makeCourt({ sessionId: session.id, name: "Court 2" });

    const [a1, a2, a3, a4, w1, w2, w3, w4] = players;

    // Draft first 4 players via RPC
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [a1.id, a2.id],
      teamB: [a3.id, a4.id],
      isPublished: false,
    });

    // Confirm first 4 are "drafted"
    const drafted = await getStatuses(session.id, [a1.id, a2.id, a3.id, a4.id]);
    expect(drafted.every((e) => e.status === "drafted")).toBe(true);

    // NOTE: this test relies on there being zero in_progress matches at engine run time.
    // With activeCount=0, the soft gate (which only fires when activeCount>0) does not
    // block. The 4 waiting players form slot 0; slot 1 stops because estimatedWaiting
    // drops to 0 after slot 0. If a future refactor seeds an in_progress match here,
    // the soft gate may defer slot 0 and the test will fail non-deterministically.

    // Run engine — should draft only the 4 remaining "waiting" players
    await runEngineForSession(session.id);

    // The 4 originally drafted players must still be "drafted" (not moved to a new match)
    const draftedAfter = await getStatuses(session.id, [a1.id, a2.id, a3.id, a4.id]);
    expect(draftedAfter.every((e) => e.status === "drafted")).toBe(true);

    // The 4 waiting players should now be "drafted" into a second match
    const waitingAfter = await getStatuses(session.id, [w1.id, w2.id, w3.id, w4.id]);
    expect(waitingAfter.every((e) => e.status === "drafted")).toBe(true);

    // Total matches: 2 (both drafts)
    const { count } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false);
    expect(count).toBe(2);
  });

  // ── 10. publishAllDraftMatchesAction: all drafted → on_deck ──
  it("publishAllDraftMatchesAction promotes all drafted players across multiple drafts", async () => {
    const { organizer, session, players } = await baseSetup(8);
    await makeCourt({ sessionId: session.id, name: "Court 2" });

    const [a1, a2, a3, a4, b1, b2, b3, b4] = players;

    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [a1.id, a2.id],
      teamB: [a3.id, a4.id],
      isPublished: false,
    });
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [b1.id, b2.id],
      teamB: [b3.id, b4.id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishAllDraftMatchesAction(session.id);
      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(2);
    } finally {
      restore();
    }

    // All 8 players should now be "on_deck"
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("on_deck");
    }
  });

  // ── 11. closeSession sets 'drafted' players to 'left' ────────
  it("closeSession marks 'drafted' players as 'left' alongside 'waiting' players", async () => {
    const { organizer, session, players } = await baseSetup(8);
    const [d1, d2, d3, d4] = players;

    // First 4 drafted, last 4 still waiting
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [d1.id, d2.id],
      teamB: [d3.id, d4.id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await closeSession(session.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    // All 8 players — drafted and waiting — should now be "left"
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("left");
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Gap Tests (G-1 through G-16)
  // ─────────────────────────────────────────────────────────────

  // ── G-1 CRITICAL: RPC Guard 0 — drafted player input rejected ─
  // create_match_with_players has a Guard 0 that checks all input
  // players are in 'waiting' status. A player already 'drafted'
  // into another match should cause the RPC to return NULL.
  it("G-1: RPC returns null when a 'drafted' player is included in the input set", async () => {
    const { session, players } = await baseSetup(8);
    const [a1, a2, a3, a4, b1, b2, b3] = players;

    // Draft the first 4 players
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [a1.id, a2.id],
      teamB: [a3.id, a4.id],
      isPublished: false,
    });

    // Confirm a1 is now "drafted"
    const [a1Status] = await getStatuses(session.id, [a1.id]);
    expect(a1Status.status).toBe("drafted");

    // Attempt to create a second match including a1 (already drafted)
    // RPC Guard 0 checks all input players are 'waiting' — a1 is 'drafted'
    // so the guard should fire and return NULL (match not created).
    const { data: matchId, error } = await serviceClient().rpc("create_match_with_players", {
      p_session_id: session.id,
      p_court_id: null,
      p_status: "pending",
      p_is_mixed_level: false,
      p_started_at: null,
      p_is_on_deck: true,
      p_team_a_ids: [a1.id, b1.id], // a1 is drafted — guard fires
      p_team_b_ids: [b2.id, b3.id],
      p_origin: "manual",
      p_is_published: false,
    });

    // Guard fires → matchId is NULL and no error (graceful rejection)
    expect(error).toBeNull();
    expect(matchId).toBeNull();

    // a1 must still be "drafted" in the original match (not moved)
    const [a1After] = await getStatuses(session.id, [a1.id]);
    expect(a1After.status).toBe("drafted");

    // b1, b2, b3 must still be "waiting" (the rejected call left them untouched)
    const remainingStatuses = await getStatuses(session.id, [b1.id, b2.id, b3.id]);
    for (const entry of remainingStatuses) {
      expect(entry.status).toBe("waiting");
    }
  });

  // ── G-2 CRITICAL: Concurrent RPC calls — only one wins ───────
  // Two concurrent calls to create_match_with_players with the
  // same 4 players. The RPC uses FOR UPDATE SELECT in Guard 0 to
  // serialize concurrent writes. Exactly one call should succeed
  // (return a non-null match ID); the other should return NULL.
  it("G-2: concurrent RPC calls on the same 4 players: exactly one succeeds", async () => {
    const { session, players } = await baseSetup(4);
    const [p1, p2, p3, p4] = players;

    const rpcArgs = {
      p_session_id: session.id,
      p_court_id: null,
      p_status: "pending" as const,
      p_is_mixed_level: false,
      p_started_at: null,
      p_is_on_deck: true,
      p_team_a_ids: [p1.id, p2.id],
      p_team_b_ids: [p3.id, p4.id],
      p_origin: "manual" as const,
      p_is_published: false,
    };

    // Fire both RPCs simultaneously
    const [result1, result2] = await Promise.all([
      serviceClient().rpc("create_match_with_players", rpcArgs),
      serviceClient().rpc("create_match_with_players", rpcArgs),
    ]);

    expect(result1.error).toBeNull();
    expect(result2.error).toBeNull();

    const matchIds = [result1.data, result2.data];
    const successes = matchIds.filter((id) => id !== null);
    const failures = matchIds.filter((id) => id === null);

    // Exactly one call wins; the other is rejected by the TOCTOU guard
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Exactly one match was created
    const { count: matchCount } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending");
    expect(matchCount).toBe(1);

    // All 4 players are drafted (winner set them; loser left them alone)
    const statuses = await getStatuses(session.id, [p1.id, p2.id, p3.id, p4.id]);
    for (const entry of statuses) {
      expect(entry.status).toBe("drafted");
    }
  });

  // ── G-3 HIGH: cancelMatchAction auth guards ───────────────────
  it("G-3a: cancelMatchAction rejects unauthenticated caller", async () => {
    const { session, players } = await baseSetup(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    clearMockAuth(); // no auth
    const result = await cancelMatchAction(match.id);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authenticated|unauthorized/i);

    // Players must still be drafted (match untouched)
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("drafted");
    }
  });

  it("G-3b: cancelMatchAction rejects non-organizer caller", async () => {
    const { session, players } = await baseSetup(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    const stranger = await makeProfile({ faker });
    const restore = mockAuthAs(stranger.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not authorized|organizer/i);
    } finally {
      restore();
    }

    // Players must still be drafted (match untouched)
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("drafted");
    }
  });

  // ── G-4 HIGH: publishMatchAction BUG-002 left-player guard ───
  // If any roster player has 'left' status when the organizer tries
  // to publish, publishMatchAction must refuse to publish (BUG-002).
  it("G-4: publishMatchAction returns error when a roster player has 'left' the session", async () => {
    const { organizer, session, players } = await baseSetup(4);

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    // Simulate players[0] leaving the session after being drafted
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", session.id)
      .eq("player_id", players[0].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(false);
      // Error message must mention 'left' or players leaving
      expect(result.message).toMatch(/left/i);
    } finally {
      restore();
    }

    // Match must still be a draft (not published)
    const { data: m } = await serviceClient()
      .from("matches")
      .select("is_published")
      .eq("id", match.id)
      .single();
    expect(m?.is_published).toBe(false);
  });

  // ── G-5 HIGH: Double-cancel returns failure ───────────────────
  // cancelMatchAction on an already-cancelled match must return
  // success=false (the CAS atomic guard prevents double-cancel).
  it("G-5: cancelling an already-cancelled match returns success=false", async () => {
    const { organizer, session, players } = await baseSetup(4);

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    // First cancel — should succeed
    let restore = mockAuthAs(organizer.id);
    const first = await cancelMatchAction(match.id);
    restore();
    expect(first.success).toBe(true);

    // Second cancel — must fail (already cancelled)
    restore = mockAuthAs(organizer.id);
    try {
      const second = await cancelMatchAction(match.id);
      expect(second.success).toBe(false);
      expect(second.message).toMatch(/already cancelled|completed/i);
    } finally {
      restore();
    }
  });

  // ── G-6 HIGH: cancelMatchAction on in_progress match ─────────
  // An in_progress match should be cancellable. Players (status
  // "playing") must be returned to "waiting" (BUG-002 layer: neq
  // 'left' guard skips checked-out players).
  it("G-6: cancelling an in_progress match returns 'playing' players to 'waiting'", async () => {
    const { organizer, session, court, players } = await baseSetup(4);

    // Create an in_progress match directly (players stay "waiting" via makeMatch)
    const match = await makeMatch({
      sessionId: session.id,
      courtId: court.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      status: "in_progress",
      isPublished: true,
    });

    // Manually set players to "playing" (bypassing the RPC that normally does this)
    await serviceClient()
      .from("queue_entries")
      .update({ status: "playing" as const })
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    // All 4 players must be back to "waiting"
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("waiting");
    }
  });

  // ── G-7 HIGH: publishAllDraftMatchesAction with a tainted draft ─
  // When one draft has a 'left' player, publishAllDraftMatchesAction
  // should still publish the clean draft(s) and skip (not error on)
  // the tainted one. publishedCount reflects only successful publishes.
  it("G-7: publishAllDraftMatchesAction publishes clean drafts and skips tainted ones", async () => {
    const { organizer, session } = await baseSetup(0); // organizer + session, no players yet
    await makeCourt({ sessionId: session.id, name: "Court 2" });

    // Clean draft (4 fresh players)
    const cleanPlayers = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    await Promise.all(
      cleanPlayers.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );
    const cleanMatch = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [cleanPlayers[0].id, cleanPlayers[1].id],
      teamB: [cleanPlayers[2].id, cleanPlayers[3].id],
      isPublished: false,
    });

    // Tainted draft (4 fresh players, one will leave)
    const taintedPlayers = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    await Promise.all(
      taintedPlayers.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [taintedPlayers[0].id, taintedPlayers[1].id],
      teamB: [taintedPlayers[2].id, taintedPlayers[3].id],
      isPublished: false,
    });

    // Simulate taintedPlayers[0] leaving after being drafted
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", session.id)
      .eq("player_id", taintedPlayers[0].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishAllDraftMatchesAction(session.id);
      // Should succeed overall but only count the clean draft
      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(1);
    } finally {
      restore();
    }

    // Clean match must be published
    const { data: cm } = await serviceClient()
      .from("matches")
      .select("is_published")
      .eq("id", cleanMatch.id)
      .single();
    expect(cm?.is_published).toBe(true);

    // Clean players must be on_deck
    const cleanStatuses = await getStatuses(
      session.id,
      cleanPlayers.map((p) => p.id)
    );
    for (const entry of cleanStatuses) {
      expect(entry.status).toBe("on_deck");
    }
  });

  // ── G-8 HIGH: cancelMatchAction — wrong-session organizer ─────
  it("G-8: organizer of a different session cannot cancel a match they don't own", async () => {
    const { session, players } = await baseSetup(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    // Create an unrelated organizer who owns a different session
    const otherOrg = await makeProfile({ faker });
    await makeSession({ faker, organizer: otherOrg.id });

    const restore = mockAuthAs(otherOrg.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(false);
    } finally {
      restore();
    }

    // Players must still be drafted
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("drafted");
    }
  });

  // ── G-9 MEDIUM: Engine with drafted+on_deck+waiting mix ──────
  // When the queue contains players in different active statuses,
  // the engine should only draw from "waiting" players for new drafts.
  it("G-9: engine only draws 'waiting' players when queue has drafted+on_deck+waiting mix", async () => {
    // 8 players total: 4 drafted, 2 on_deck, 2 waiting
    const { session } = await baseSetup(0);
    await enableAutoMatchmaking(session.id);
    await makeCourt({ sessionId: session.id, name: "Court 2" });

    const draftedPlayers = await Promise.all(
      Array.from({ length: 4 }, () => makeProfile({ faker }))
    );
    const onDeckPlayers = await Promise.all(
      Array.from({ length: 2 }, () => makeProfile({ faker }))
    );
    const waitingPlayers = await Promise.all(
      Array.from({ length: 4 }, () => makeProfile({ faker }))
    );

    await Promise.all([
      ...draftedPlayers.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
      ...onDeckPlayers.map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "on_deck" })
      ),
      ...waitingPlayers.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
    ]);

    // Draft the 4 "waiting" drafted players
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [draftedPlayers[0].id, draftedPlayers[1].id],
      teamB: [draftedPlayers[2].id, draftedPlayers[3].id],
      isPublished: false,
    });

    // Run engine — should draft only the 4 waiting players (not on_deck or drafted)
    await runEngineForSession(session.id);

    // on_deck players must remain "on_deck"
    const onDeckStatuses = await getStatuses(
      session.id,
      onDeckPlayers.map((p) => p.id)
    );
    for (const entry of onDeckStatuses) {
      expect(entry.status).toBe("on_deck");
    }

    // drafted players must remain "drafted"
    const draftedStatuses = await getStatuses(
      session.id,
      draftedPlayers.map((p) => p.id)
    );
    for (const entry of draftedStatuses) {
      expect(entry.status).toBe("drafted");
    }

    // The 4 waiting players should now be "drafted"
    const waitingStatuses = await getStatuses(
      session.id,
      waitingPlayers.map((p) => p.id)
    );
    for (const entry of waitingStatuses) {
      expect(entry.status).toBe("drafted");
    }
  });

  // ── G-10 MEDIUM: joinQueueAction blocks on_deck players ──────
  // A player in "on_deck" status is already committed to a match.
  // Attempting to re-join the queue should be rejected.
  it("G-10: joinQueueAction returns an error for a player already in 'on_deck' status", async () => {
    const { session, players } = await baseSetup(4);

    // Publish the match → players go from drafted → on_deck
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true, // published → on_deck immediately
    });
    void match; // unused but RPC side-effect is what matters

    const [p0Status] = await getStatuses(session.id, [players[0].id]);
    expect(p0Status.status).toBe("on_deck");

    const restore = mockAuthAs(players[0].id);
    try {
      const result = await joinQueueAction(session.id);
      expect("error" in result).toBe(true);
    } finally {
      restore();
    }
  });

  // ── G-11 MEDIUM: swap with p_is_published=true → on_deck ─────
  // When swapping into a published match (p_is_published=true), the
  // incoming player should land in "on_deck" status, not "drafted".
  it("G-11: swap_player_in_match with p_is_published=true sets incoming player to 'on_deck'", async () => {
    const { session, players } = await baseSetup(5);
    const [p1, p2, p3, p4, swapIn] = players;

    // Create a published match — all 4 players are "on_deck"
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: true,
    });

    // swapIn is still "waiting"
    const [swapInBefore] = await getStatuses(session.id, [swapIn.id]);
    expect(swapInBefore.status).toBe("waiting");

    const { error } = await serviceClient().rpc("swap_player_in_match", {
      p_match_id: match.id,
      p_out_player_id: p4.id,
      p_in_player_id: swapIn.id,
      p_session_id: session.id,
      p_team: "b",
      p_is_published: true, // published → incoming gets "on_deck"
    });
    expect(error).toBeNull();

    // swapIn should be "on_deck" (not "drafted")
    const [swapInAfter] = await getStatuses(session.id, [swapIn.id]);
    expect(swapInAfter.status).toBe("on_deck");

    // p4 (outgoing) should be back to "waiting"
    const [p4After] = await getStatuses(session.id, [p4.id]);
    expect(p4After.status).toBe("waiting");
  });

  // ── G-12 MEDIUM: cancel a published (on_deck) match ──────────
  // An on_deck (published, pending) match should also be cancellable.
  // Players in "on_deck" status must return to "waiting".
  it("G-12: cancelling a published on_deck match returns 'on_deck' players to 'waiting'", async () => {
    const { organizer, session, players } = await baseSetup(4);

    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Confirm on_deck
    const before = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    expect(before.every((e) => e.status === "on_deck")).toBe(true);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const after = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of after) {
      expect(entry.status).toBe("waiting");
    }
  });

  // ── G-13 MEDIUM: publishMatchAction — non-existent match ID ──
  it("G-13: publishMatchAction returns error for a non-existent match ID", async () => {
    const { organizer } = await baseSetup(0);

    const fakeMatchId = "00000000-dead-beef-cafe-000000000001";
    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(fakeMatchId);
      expect(result.success).toBe(false);
    } finally {
      restore();
    }
  });

  // ── G-14 LOW: closeSession — all statuses → left ─────────────
  // closeSession should set ALL non-playing players to "left":
  // waiting, drafted, and on_deck. Players already "playing" or
  // "left" are edge cases handled by the .neq("status","left") guard.
  it("G-14: closeSession marks waiting+drafted+on_deck players all as 'left'", async () => {
    const { organizer, session } = await baseSetup(0);

    const [
      waitingPlayer,
      draftedGroup1,
      draftedGroup2,
      draftedGroup3,
      draftedGroup4,
      onDeckGroup1,
      onDeckGroup2,
      onDeckGroup3,
      onDeckGroup4,
    ] = await Promise.all(Array.from({ length: 9 }, () => makeProfile({ faker })));

    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: waitingPlayer.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: draftedGroup1.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: draftedGroup2.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: draftedGroup3.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: draftedGroup4.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: onDeckGroup1.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: onDeckGroup2.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: onDeckGroup3.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: onDeckGroup4.id, status: "waiting" }),
    ]);

    // Draft 4 players
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [draftedGroup1.id, draftedGroup2.id],
      teamB: [draftedGroup3.id, draftedGroup4.id],
      isPublished: false,
    });

    // Publish 4 players (on_deck)
    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [onDeckGroup1.id, onDeckGroup2.id],
      teamB: [onDeckGroup3.id, onDeckGroup4.id],
      isPublished: true,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await closeSession(session.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const allPlayerIds = [
      waitingPlayer.id,
      draftedGroup1.id,
      draftedGroup2.id,
      draftedGroup3.id,
      draftedGroup4.id,
      onDeckGroup1.id,
      onDeckGroup2.id,
      onDeckGroup3.id,
      onDeckGroup4.id,
    ];
    const statuses = await getStatuses(session.id, allPlayerIds);
    for (const entry of statuses) {
      expect(entry.status).toBe("left");
    }
  });

  // ── G-15 LOW: RPC with invalid UUID inputs ───────────────────
  // create_match_with_players should gracefully handle invalid UUIDs
  // rather than throwing a Postgres exception. The publishMatchAction
  // input validation guard also covers this.
  it("G-15: publishMatchAction rejects an invalid (non-UUID) match ID", async () => {
    const { organizer } = await baseSetup(0);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction("not-a-valid-uuid");
      expect(result.success).toBe(false);
    } finally {
      restore();
    }
  });

  // ── G-16 LOW: publishMatchAction on a 'completed' match ──────
  // A completed match cannot be published (it's already done).
  // The "only pending matches" guard should reject it.
  it("G-16: publishMatchAction returns error for a 'completed' match", async () => {
    const { organizer, session, court, players } = await baseSetup(4);

    // Create a completed match directly (bypassing RPC — no queue status change needed)
    const { data: completedMatch } = await serviceClient()
      .from("matches")
      .insert({
        session_id: session.id,
        court_id: court.id,
        status: "completed" as const,
        is_published: true,
        is_mixed_level: false,
        created_method: "auto",
      })
      .select("id")
      .single();

    if (!completedMatch) throw new Error("[G-16] Failed to insert completed match");

    await serviceClient()
      .from("match_players")
      .insert([
        { match_id: completedMatch.id, player_id: players[0].id, team: "a" as const },
        { match_id: completedMatch.id, player_id: players[1].id, team: "a" as const },
        { match_id: completedMatch.id, player_id: players[2].id, team: "b" as const },
        { match_id: completedMatch.id, player_id: players[3].id, team: "b" as const },
      ]);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(completedMatch.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/pending|already|completed/i);
    } finally {
      restore();
    }
  });
});
