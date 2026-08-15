// ============================================================
// Suite Q — Player Self-Checkout (checkoutPlayer)
// ============================================================
// checkoutPlayer marks the calling player's queue_entries row
// as "left", blocking future matchmaking for them.  It also
// cleans up any unpublished draft matches they were assigned to.
// A player who is ON DECK or PLAYING is NOT allowed to self-check
// out — that would strand a ghost in a live match roster; an
// organizer must remove them instead (removePlayerFromQueue).
//
// Behaviours under test:
//   Q-1  Player can check out → status becomes 'left'
//   Q-2  Unauthenticated caller is rejected
//   Q-3  Invalid session UUID is rejected without DB round-trip
//   Q-4  Checkout while on_deck is REJECTED — status + match unchanged
//   Q-5  Checkout while 'playing' is REJECTED — status + match unchanged
//   Q-6  Draft match is cleaned up when player checks out
//   Q-7  Published (on-deck) match is NOT cancelled by checkout
//   Q-8  Checking out twice is idempotent (second call still succeeds)
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

vi.mock("@/app/actions/matchmaking", () => ({
  runEngineForSession: vi.fn().mockResolvedValue(undefined),
}));

import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { checkoutPlayer } from "@/app/actions/queue";
import { runEngineForSession } from "@/app/actions/matchmaking";

const faker = new Faker({ locale: [en] });
faker.seed(9101);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared helper ──────────────────────────────────────────────

async function checkoutSetup() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const player = await makeProfile({ faker, skill: "intermediate" });
  await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "waiting" });
  return { organizer, session, player };
}

// ─────────────────────────────────────────────────────────────

describe("checkoutPlayer — Suite Q", () => {
  beforeEach(() => {
    vi.mocked(runEngineForSession).mockClear();
  });

  // ── Q-1: Happy path ──────────────────────────────────────────

  it("Q-1: player can check out of queue (status → 'left')", async () => {
    const { session, player } = await checkoutSetup();

    const restore = mockAuthAs(player.id);
    let result: Awaited<ReturnType<typeof checkoutPlayer>>;
    try {
      result = await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);

    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    expect(entry?.status).toBe("left");
  });

  // ── Q-2: Unauthenticated rejection ───────────────────────────

  it("Q-2: unauthenticated caller is rejected", async () => {
    const { session } = await checkoutSetup();
    // No mockAuthAs — currentUserId is null

    const result = await checkoutPlayer(session.id);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
  });

  // ── Q-3: UUID validation ──────────────────────────────────────

  it("Q-3: invalid session UUID is rejected without a DB round-trip", async () => {
    const { player } = await checkoutSetup();

    const restore = mockAuthAs(player.id);
    let result: Awaited<ReturnType<typeof checkoutPlayer>>;
    try {
      result = await checkoutPlayer("not-a-uuid");
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/invalid/i);
  });

  // ── Q-4: Checkout while on_deck ──────────────────────────────

  it("Q-4: player CANNOT check out while on_deck — rejected, status + match unchanged", async () => {
    const { session, player } = await checkoutSetup();
    const other1 = await makeProfile({ faker });
    const other2 = await makeProfile({ faker });
    const other3 = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: other1.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other2.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other3.id });

    // Seed a published pending match with the player on Team A
    const match = await makeMatch({
      sessionId: session.id,
      teamA: [player.id, other1.id],
      teamB: [other2.id, other3.id],
      status: "pending",
      isPublished: true,
    });

    // Update queue status to on_deck for the 4 players
    await serviceClient()
      .from("queue_entries")
      .update({ status: "on_deck" as const })
      .eq("session_id", session.id)
      .in("player_id", [player.id, other1.id, other2.id, other3.id]);

    const restore = mockAuthAs(player.id);
    let result: Awaited<ReturnType<typeof checkoutPlayer>>;
    try {
      result = await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    // Self-checkout is REJECTED for an on-deck player — leaving would strand a
    // ghost in the published roster that breaks the match when it hits a court.
    expect(result!.success).toBe(false);

    // Player's queue entry is untouched — still on_deck.
    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();
    expect(entry?.status).toBe("on_deck");

    // The published match is untouched.
    const { data: m } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("pending");
  });

  // ── Q-5: Checkout while playing is blocked ───────────────────

  it("Q-5: player CANNOT check out while playing — rejected, status + match unchanged", async () => {
    const { session, player } = await checkoutSetup();
    const other1 = await makeProfile({ faker });
    const other2 = await makeProfile({ faker });
    const other3 = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: other1.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other2.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other3.id });
    const court = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });

    const match = await makeMatch({
      sessionId: session.id,
      teamA: [player.id, other1.id],
      teamB: [other2.id, other3.id],
      courtId: court.id,
      status: "in_progress",
      isPublished: true,
    });

    // Mark all 4 as playing
    await serviceClient()
      .from("queue_entries")
      .update({ status: "playing" as const })
      .eq("session_id", session.id)
      .in("player_id", [player.id, other1.id, other2.id, other3.id]);

    const restore = mockAuthAs(player.id);
    let result: Awaited<ReturnType<typeof checkoutPlayer>>;
    try {
      result = await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    // Rejected — a player in an in-progress match cannot self-leave.
    expect(result!.success).toBe(false);

    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();
    expect(entry?.status).toBe("playing");

    // In-progress match is untouched.
    const { data: m } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("in_progress");
  });

  // ── Q-6: Draft match cleanup ──────────────────────────────────

  it("Q-6: unpublished draft match is cancelled when player checks out", async () => {
    const { session, player } = await checkoutSetup();
    const other1 = await makeProfile({ faker });
    const other2 = await makeProfile({ faker });
    const other3 = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: other1.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other2.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other3.id });

    // Seed an UNPUBLISHED draft match containing the player
    const draft = await makeMatch({
      sessionId: session.id,
      teamA: [player.id, other1.id],
      teamB: [other2.id, other3.id],
      status: "pending",
      isPublished: false, // draft — not yet visible to players
    });

    const restore = mockAuthAs(player.id);
    try {
      await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    // Player is left
    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();
    expect(entry?.status).toBe("left");

    // The draft match must be cleaned up (cancelled or player removed).
    // Either the RPC or the fallback loop should leave the match in a
    // consistent state.  We check that the player is no longer in the
    // match AND that the match is cancelled (< 4 players remaining).
    const { data: mpRow } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", draft.id)
      .eq("player_id", player.id)
      .maybeSingle();

    const { data: matchRow } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", draft.id)
      .single();

    // Player removed from match_players and/or match cancelled
    expect(mpRow).toBeNull();
    expect(matchRow?.status).toBe("cancelled");
  });

  // ── Q-7: Published match not cancelled ───────────────────────

  it("Q-7: published (on-deck) match is NOT cancelled when player checks out", async () => {
    const { session, player } = await checkoutSetup();
    const other1 = await makeProfile({ faker });
    const other2 = await makeProfile({ faker });
    const other3 = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: other1.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other2.id });
    await makeQueueEntry({ sessionId: session.id, playerId: other3.id });

    // Seed a PUBLISHED pending match — this is already on-deck for players
    const published = await makeMatch({
      sessionId: session.id,
      teamA: [player.id, other1.id],
      teamB: [other2.id, other3.id],
      status: "pending",
      isPublished: true,
    });

    const restore = mockAuthAs(player.id);
    try {
      await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    // Published match must remain pending — cleanup only targets unpublished drafts
    const { data: m } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", published.id)
      .single();
    expect(m?.status).toBe("pending");
  });

  // ── Q-8: Idempotency ─────────────────────────────────────────

  it("Q-8: checking out twice is idempotent — second call still returns success", async () => {
    const { session, player } = await checkoutSetup();

    const restore = mockAuthAs(player.id);
    let r1: Awaited<ReturnType<typeof checkoutPlayer>>;
    let r2: Awaited<ReturnType<typeof checkoutPlayer>>;
    try {
      r1 = await checkoutPlayer(session.id);
      r2 = await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    expect(r1!.success).toBe(true);
    // Second call updates zero rows but is still a successful UPDATE statement
    expect(r2!.success).toBe(true);

    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();
    expect(entry?.status).toBe("left");
  });

  // ── Q-9: Engine trigger after checkout ───────────────────────

  it("Q-9: checkoutPlayer calls runEngineForSession after cleanup", async () => {
    const { session, player } = await checkoutSetup();

    const restore = mockAuthAs(player.id);
    let result: Awaited<ReturnType<typeof checkoutPlayer>>;
    try {
      result = await checkoutPlayer(session.id);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);
    expect(runEngineForSession).toHaveBeenCalledOnce();
    expect(runEngineForSession).toHaveBeenCalledWith(session.id);
  });
});
