// ============================================================
// Suite N — updateMatchDetails + clearOnDeckMatch + reorderOnDeckMatches
// ============================================================
// Tests three state-mutating match actions that previously had
// zero coverage:
//
//   updateMatchDetails
//     N-1  Happy: organizer updates scores on a completed match
//     N-2  Happy: organizer reverts a completed match to in_progress
//     N-3  Negative: non-organizer rejected
//     N-4  Negative: invalid match ID rejected
//     N-5  Revert: games_played decremented for waiting players only
//
//   clearOnDeckMatch
//     N-6  Happy: organizer clears pending match, players → waiting
//     N-7  Happy: 'left' player stays 'left' when match is cleared
//     N-8  Negative: non-organizer rejected
//     N-9  Negative: in_progress match cannot be cleared
//
//   reorderOnDeckMatches
//     N-10 Happy: organizer reorders on-deck matches
//     N-11 Negative: non-organizer rejected
//     N-12 Negative: invalid match ID in list rejected
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatchViaRpc } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { updateMatchDetails, clearOnDeckMatch, reorderOnDeckMatches } from "@/app/actions/match";

const faker = new Faker({ locale: [en] });
faker.seed(10005);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Helpers ───────────────────────────────────────────────────

async function seedSessionWithPlayers(n: number) {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  await makeCourt({ sessionId: session.id, name: "Court 1" });
  const players: { id: string; displayName: string }[] = [];
  for (let i = 0; i < n; i++) {
    const p = await makeProfile({ faker });
    players.push(p);
    await makeQueueEntry({ sessionId: session.id, playerId: p.id });
  }
  return { organizer, session, players };
}

async function readMatch(matchId: string) {
  const { data } = await serviceClient().from("matches").select("*").eq("id", matchId).single();
  return data;
}

async function readQueue(sessionId: string, playerId: string) {
  const { data } = await serviceClient()
    .from("queue_entries")
    .select("status, games_played")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();
  return data;
}

// ============================================================
// updateMatchDetails
// ============================================================

describe("updateMatchDetails — Suite N", () => {
  // ── N-1 ────────────────────────────────────────────────────
  it("N-1: organizer updates scores on a completed match", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Complete the match
    await serviceClient()
      .from("matches")
      .update({ status: "completed", team_a_score: 21, team_b_score: 15 })
      .eq("id", match.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await updateMatchDetails(match.id, 25, 20);
      expect(result.success).toBe(true);

      const m = await readMatch(match.id);
      expect(m?.team_a_score).toBe(25);
      expect(m?.team_b_score).toBe(20);
      expect(m?.status).toBe("completed");
    } finally {
      restore();
    }
  });

  // ── N-2 ────────────────────────────────────────────────────
  it("N-2: organizer reverts a completed match to in_progress", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Attach a court so revert logic runs
    const { data: court } = await serviceClient()
      .from("courts")
      .insert({ session_id: session.id, name: "C2", status: "available" })
      .select("id")
      .single();
    await serviceClient()
      .from("matches")
      .update({ court_id: court!.id, status: "completed", team_a_score: 21, team_b_score: 15 })
      .eq("id", match.id);

    // Simulate endMatchAction re-queuing players
    for (const p of players) {
      await serviceClient()
        .from("queue_entries")
        .update({ status: "waiting", games_played: 3 })
        .eq("session_id", session.id)
        .eq("player_id", p.id);
    }

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await updateMatchDetails(match.id, 0, 0, true);
      expect(result.success).toBe(true);

      const m = await readMatch(match.id);
      expect(m?.status).toBe("in_progress");
      expect(m?.team_a_score).toBeNull();
      expect(m?.team_b_score).toBeNull();
      expect(m?.completed_at).toBeNull();
    } finally {
      restore();
    }
  });

  // ── N-3 ────────────────────────────────────────────────────
  it("N-3: non-organizer is rejected", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const rando = await makeProfile({ faker });
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    const restore = mockAuthAs(rando.id);
    try {
      const result = await updateMatchDetails(match.id, 10, 10);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Not authorized/);
    } finally {
      restore();
    }
  });

  // ── N-4 ────────────────────────────────────────────────────
  it("N-4: invalid match ID rejected", async () => {
    const organizer = await makeProfile({ faker });
    const restore = mockAuthAs(organizer.id);
    try {
      const result = await updateMatchDetails("not-a-uuid", 10, 10);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid match ID/);
    } finally {
      restore();
    }
  });

  // ── N-5 ────────────────────────────────────────────────────
  it("N-5: revert decrements games_played only for waiting players", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Set all players to waiting with games_played=3
    for (const p of players.slice(0, 4)) {
      await serviceClient()
        .from("queue_entries")
        .update({ status: "waiting", games_played: 3 })
        .eq("session_id", session.id)
        .eq("player_id", p.id);
    }

    // Complete the match
    await serviceClient()
      .from("matches")
      .update({ status: "completed", team_a_score: 21, team_b_score: 15 })
      .eq("id", match.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await updateMatchDetails(match.id, 0, 0, true);
      expect(result.success).toBe(true);

      // All 4 match players should be reverted to playing with games_played=2
      for (const p of players.slice(0, 4)) {
        const q = await readQueue(session.id, p.id);
        expect(q?.status).toBe("playing");
        expect(q?.games_played).toBe(2);
      }
    } finally {
      restore();
    }
  });
});

// ============================================================
// clearOnDeckMatch
// ============================================================

describe("clearOnDeckMatch — Suite N", () => {
  // ── N-6 ────────────────────────────────────────────────────
  it("N-6: organizer clears pending match, players return to waiting", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Move players to on_deck (simulating publish)
    for (const p of players) {
      await serviceClient()
        .from("queue_entries")
        .update({ status: "on_deck" })
        .eq("session_id", session.id)
        .eq("player_id", p.id);
    }

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await clearOnDeckMatch(match.id);
      expect(result.success).toBe(true);

      // Match deleted
      const { data: gone } = await serviceClient()
        .from("matches")
        .select("id")
        .eq("id", match.id)
        .maybeSingle();
      expect(gone).toBeNull();

      // Players back to waiting
      for (const p of players) {
        const q = await readQueue(session.id, p.id);
        expect(q?.status).toBe("waiting");
      }
    } finally {
      restore();
    }
  });

  // ── N-7 ────────────────────────────────────────────────────
  it("N-7: 'left' player stays 'left' when match is cleared", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    for (const p of players) {
      await serviceClient()
        .from("queue_entries")
        .update({ status: "on_deck" })
        .eq("session_id", session.id)
        .eq("player_id", p.id);
    }

    // Player 0 checks out while on-deck
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" })
      .eq("session_id", session.id)
      .eq("player_id", players[0].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await clearOnDeckMatch(match.id);
      expect(result.success).toBe(true);

      // Player 0 stays left
      const q0 = await readQueue(session.id, players[0].id);
      expect(q0?.status).toBe("left");

      // Others return to waiting
      for (const p of players.slice(1)) {
        const q = await readQueue(session.id, p.id);
        expect(q?.status).toBe("waiting");
      }
    } finally {
      restore();
    }
  });

  // ── N-8 ────────────────────────────────────────────────────
  it("N-8: non-organizer is rejected", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const rando = await makeProfile({ faker });
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    const restore = mockAuthAs(rando.id);
    try {
      const result = await clearOnDeckMatch(match.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Not authorized/);
    } finally {
      restore();
    }
  });

  // ── N-9 ────────────────────────────────────────────────────
  it("N-9: in_progress match cannot be cleared", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    await serviceClient().from("matches").update({ status: "in_progress" }).eq("id", match.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await clearOnDeckMatch(match.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot clear/);
    } finally {
      restore();
    }
  });
});

// ============================================================
// reorderOnDeckMatches
// ============================================================

describe("reorderOnDeckMatches — Suite N", () => {
  // ── N-10 ───────────────────────────────────────────────────
  it("N-10: organizer reorders on-deck matches", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(8);
    const m1 = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });
    const m2 = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[4].id, players[5].id],
      teamB: [players[6].id, players[7].id],
      isPublished: true,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      // Reverse order: m2 first, m1 second
      const result = await reorderOnDeckMatches(session.id, [m2.id, m1.id]);
      expect(result.success).toBe(true);

      const { data: rows } = await serviceClient()
        .from("matches")
        .select("id, sort_order")
        .eq("session_id", session.id)
        .eq("status", "pending")
        .order("sort_order", { ascending: true });

      expect(rows?.[0].id).toBe(m2.id);
      expect(rows?.[0].sort_order).toBe(0);
      expect(rows?.[1].id).toBe(m1.id);
      expect(rows?.[1].sort_order).toBe(1);
    } finally {
      restore();
    }
  });

  // ── N-11 ───────────────────────────────────────────────────
  it("N-11: non-organizer is rejected", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const rando = await makeProfile({ faker });
    const m1 = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    const restore = mockAuthAs(rando.id);
    try {
      const result = await reorderOnDeckMatches(session.id, [m1.id]);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Forbidden/);
    } finally {
      restore();
    }
  });

  // ── N-12 ───────────────────────────────────────────────────
  it("N-12: invalid match ID in list rejected", async () => {
    const { organizer, session } = await seedSessionWithPlayers(4);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await reorderOnDeckMatches(session.id, ["not-a-uuid"]);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid match ID/);
    } finally {
      restore();
    }
  });
});
