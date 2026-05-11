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
import {
  publishMatchAction,
  publishAllDraftMatchesAction,
  cancelMatchAction,
} from "@/app/actions/match";
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
  return data ?? [];
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

  // ── 4. publishMatchAction guard: does NOT touch 'waiting' players ─
  // Verifies the .eq("status","drafted") guard is respected —
  // manually-created drafts where players stayed "waiting" are a no-op.
  it("publishMatchAction does NOT promote 'waiting' players (guard check)", async () => {
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

    // But queue statuses remain "waiting" — the .eq("status","drafted") guard
    // in publishMatchAction is a no-op when players were never set to "drafted"
    // by the RPC (i.e. the draft was manually inserted via makeMatch).
    const statuses = await getStatuses(
      session.id,
      players.map((p) => p.id)
    );
    for (const entry of statuses) {
      expect(entry.status).toBe("waiting");
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
    const [d1, d2, d3, d4, w1, w2, w3, w4] = players;

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
});
