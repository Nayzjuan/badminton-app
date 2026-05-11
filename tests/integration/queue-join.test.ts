// ============================================================
// Suite L — joinQueueAction + Inherited Games
// ============================================================
// Locks in the contract of joinQueueAction (and the underlying
// join_queue RPC at migration 20260511210000_atomic_server_actions).
//
// The "Inherited Games" rule prevents a late joiner from leaping
// to position #1 when everyone else already has 3+ games played:
//   first-time joiner   → games_played = session floor
//   returning ('left')  → games_played = MAX(existing, floor)
//
//   L-1  Happy: first-time join, empty session → games_played=0
//   L-2  Happy: first-time join inherits floor when others have played
//   L-3  Happy: returning 'left' player rejoins with refreshed
//              joined_at + inherited games
//   L-4  Negative: player currently 'drafted'  → rejected
//   L-5  Negative: player currently 'on_deck'  → rejected
//   L-6  Negative: player currently 'playing'  → rejected
//   L-7  Negative: unauthenticated caller      → rejected
//   L-8  Happy: checkoutPlayer marks status='left' and removes the
//              player from any unpublished draft they were in
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatchViaRpc } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { joinQueueAction, checkoutPlayer } from "@/app/actions/queue";

const faker = new Faker({ locale: [en] });
faker.seed(10001);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Helpers ───────────────────────────────────────────────────

async function seedSession() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  await makeCourt({ sessionId: session.id, name: "Court 1" });
  return { organizer, session };
}

async function readEntry(sessionId: string, playerId: string) {
  const { data } = await serviceClient()
    .from("queue_entries")
    .select("status, games_played, joined_at")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();
  return data;
}

// ─────────────────────────────────────────────────────────────

describe("joinQueueAction — Suite L", () => {
  // ── L-1: First-time join, empty session ───────────────────
  it("L-1: first-time join into an empty session creates an entry with games_played=0", async () => {
    const { session } = await seedSession();
    const player = await makeProfile({ faker });

    const restore = mockAuthAs(player.id);
    try {
      const result = await joinQueueAction(session.id);
      expect(result.error).toBeUndefined();

      const entry = await readEntry(session.id, player.id);
      expect(entry).not.toBeNull();
      expect(entry?.status).toBe("waiting");
      expect(entry?.games_played).toBe(0);
      expect(entry?.joined_at).toBeDefined();
    } finally {
      restore();
    }
  });

  // ── L-2: Inherited Games on first-time join ───────────────
  it("L-2: first-time join inherits the session floor (Inherited Games rule)", async () => {
    // Depends on makeSession's default is_auto_matchmaking_on=false: with the
    // engine silent, joinQueueAction's runEngineForSession() is a no-op, so the
    // newcomer's games_played stays at the inherited floor instead of getting
    // bumped by an immediate auto-draft.
    const { session } = await seedSession();

    // Seed two existing players who have played 3 games each.
    const veteran1 = await makeProfile({ faker });
    const veteran2 = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: veteran1.id });
    await makeQueueEntry({ sessionId: session.id, playerId: veteran2.id });
    await serviceClient()
      .from("queue_entries")
      .update({ games_played: 3 })
      .eq("session_id", session.id)
      .in("player_id", [veteran1.id, veteran2.id]);

    // New player joins.
    const newcomer = await makeProfile({ faker });
    const restore = mockAuthAs(newcomer.id);
    try {
      const result = await joinQueueAction(session.id);
      expect(result.error).toBeUndefined();

      const entry = await readEntry(session.id, newcomer.id);
      // Floor among (waiting/drafted/on_deck/playing) = 3 → newcomer inherits 3.
      expect(entry?.games_played).toBe(3);
      expect(entry?.status).toBe("waiting");
    } finally {
      restore();
    }
  });

  // ── L-3: Returning 'left' player rejoin ───────────────────
  it("L-3: returning 'left' player rejoins with refreshed joined_at and inherited games", async () => {
    const { session } = await seedSession();
    const player = await makeProfile({ faker });

    // Seed the player as 'left' with an old joined_at and games_played=2.
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "left" });
    const oldJoinedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await serviceClient()
      .from("queue_entries")
      .update({ games_played: 2, joined_at: oldJoinedAt })
      .eq("session_id", session.id)
      .eq("player_id", player.id);

    // Seed a veteran with games_played=5 so the floor is 5 (after rejoin both contribute).
    const veteran = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: veteran.id });
    await serviceClient()
      .from("queue_entries")
      .update({ games_played: 5 })
      .eq("session_id", session.id)
      .eq("player_id", veteran.id);

    const restore = mockAuthAs(player.id);
    try {
      const result = await joinQueueAction(session.id);
      expect(result.error).toBeUndefined();

      const entry = await readEntry(session.id, player.id);
      // Inherited = MAX(existing=2, floor=5) = 5.
      expect(entry?.games_played).toBe(5);
      expect(entry?.status).toBe("waiting");
      // joined_at refreshed (newer than the seeded oldJoinedAt).
      expect(new Date(entry!.joined_at).getTime()).toBeGreaterThan(new Date(oldJoinedAt).getTime());
    } finally {
      restore();
    }
  });

  // ── L-4: drafted player rejoin rejected ───────────────────
  it("L-4: rejects a re-join while the player is still 'drafted'", async () => {
    const { session } = await seedSession();
    const player = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "drafted" });

    const restore = mockAuthAs(player.id);
    try {
      const result = await joinQueueAction(session.id);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/currently in a match/i);

      // Status untouched
      const entry = await readEntry(session.id, player.id);
      expect(entry?.status).toBe("drafted");
    } finally {
      restore();
    }
  });

  // ── L-5: on_deck player rejoin rejected ───────────────────
  it("L-5: rejects a re-join while the player is 'on_deck'", async () => {
    const { session } = await seedSession();
    const player = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "on_deck" });

    const restore = mockAuthAs(player.id);
    try {
      const result = await joinQueueAction(session.id);
      expect(result.error).toBeDefined();

      const entry = await readEntry(session.id, player.id);
      expect(entry?.status).toBe("on_deck");
    } finally {
      restore();
    }
  });

  // ── L-6: playing player rejoin rejected ───────────────────
  it("L-6: rejects a re-join while the player is 'playing'", async () => {
    const { session } = await seedSession();
    const player = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "playing" });

    const restore = mockAuthAs(player.id);
    try {
      const result = await joinQueueAction(session.id);
      expect(result.error).toBeDefined();

      const entry = await readEntry(session.id, player.id);
      expect(entry?.status).toBe("playing");
    } finally {
      restore();
    }
  });

  // ── L-7: unauthenticated rejected ─────────────────────────
  it("L-7: rejects an unauthenticated caller with no DB write", async () => {
    const { session } = await seedSession();
    // No mockAuthAs — caller is anonymous.
    const result = await joinQueueAction(session.id);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/not authenticated/i);

    const { count } = await serviceClient()
      .from("queue_entries")
      .select("*", { count: "exact", head: true })
      .eq("session_id", session.id);
    expect(count).toBe(0);
  });

  // ── L-8: checkoutPlayer + draft cleanup ───────────────────
  it("L-8: checkoutPlayer flips status to 'left' AND drops the player from any unpublished draft", async () => {
    const { session } = await seedSession();
    const players = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    await Promise.all(
      players.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );

    // Build an unpublished draft (engine-style) — players become 'drafted'.
    const draft = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });

    // players[0] checks out — should be removed from the draft AND the draft
    // should be cancelled (falls below 4 players).
    const restore = mockAuthAs(players[0].id);
    try {
      const result = await checkoutPlayer(session.id);
      expect(result.success).toBe(true);

      const entry = await readEntry(session.id, players[0].id);
      expect(entry?.status).toBe("left");

      // The match is either cancelled OR has < 4 players. Either way, players[0]
      // must not appear in match_players anymore.
      const { data: roster } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", draft.id);
      const ids = (roster ?? []).map((r) => r.player_id);
      expect(ids).not.toContain(players[0].id);

      const { data: matchAfter } = await serviceClient()
        .from("matches")
        .select("status")
        .eq("id", draft.id)
        .single();
      // Cleanup RPC cancels the draft when it falls below 4 players.
      expect(matchAfter?.status).toBe("cancelled");
    } finally {
      restore();
    }
  });
});
