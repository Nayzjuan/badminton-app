// ============================================================
// Suite C — publishMatchAction + Queue Side Effects (Phase 2)
// ============================================================
// Tests the publish + draft-mode pipeline:
//   • publishMatchAction — single draft → published
//   • publishAllDraftMatchesAction — all drafts → published in one go
//   • RLS firewall — anon / non-organizer / wrong-session organizer rejected
//   • Queue entry state transitions on publish
//   • hasDraftsBlocking signal via callNextMatch
//
// The "3-layer RLS firewall" described in the plan refers to:
//   1. Auth gate (getUser)
//   2. Organizer role check (isSessionOrganizer)
//   3. Service-role client for writes (bypasses RLS but keeps the auth check)
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
  enableAutoMatchmaking,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import {
  publishMatchAction,
  publishAllDraftMatchesAction,
} from "@/app/actions/match";
import { callNextMatch } from "@/app/actions/matchmaking";

const faker = new Faker({ locale: [en] });
faker.seed(4001);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared setup ───────────────────────────────────────────────

/**
 * Creates organizer + session + court + 4 queued players + 1 draft match.
 * Returns everything needed for publish tests.
 */
async function draftMatchSetup() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

  const [p1, p2, p3, p4] = await Promise.all([
    makeProfile({ faker }),
    makeProfile({ faker }),
    makeProfile({ faker }),
    makeProfile({ faker }),
  ]);

  // Add players to the queue (status: "waiting")
  await Promise.all([
    makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
  ]);

  // Create 1 draft match (is_published = false)
  const match = await makeMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    status: "pending",
    isPublished: false,
  });

  return { organizer, session, court, players: [p1, p2, p3, p4], match };
}

// ─────────────────────────────────────────────────────────────

describe("publishMatchAction — Suite C", () => {
  // ── Test 1: Publish flips is_published ─────────────────────

  it("publishing a draft match sets is_published=true", async () => {
    const { organizer, match } = await draftMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data: updatedMatch } = await serviceClient()
      .from("matches")
      .select("is_published, status")
      .eq("id", match.id)
      .single();

    expect(updatedMatch?.is_published).toBe(true);
    expect(updatedMatch?.status).toBe("pending"); // status stays pending until promoted to court
  });

  // ── Test 2: Queue entries → on_deck after publish ─────────

  it("all 4 players transition from 'waiting' to 'on_deck' when match is published", async () => {
    const { organizer, session, players, match } = await draftMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      await publishMatchAction(match.id);
    } finally {
      restore();
    }

    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("player_id, status")
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    expect(entries).not.toBeNull();
    for (const e of entries!) {
      expect(e.status).toBe("on_deck");
    }
  });

  // ── Test 3: Idempotency — double-publish is a no-op ───────

  it("publishing an already-published match returns success with no duplicate side effects", async () => {
    const { organizer, session, players, match } = await draftMatchSetup();

    // First publish
    let restore = mockAuthAs(organizer.id);
    await publishMatchAction(match.id);
    restore();

    // Second publish — idempotent
    restore = mockAuthAs(organizer.id);
    try {
      const result = await publishMatchAction(match.id);
      // The action returns success (already published guard)
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    // Queue entries should still be "on_deck" (not doubled)
    const { count: onDeckCount } = await serviceClient()
      .from("queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "on_deck")
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    expect(onDeckCount).toBe(4); // exactly 4, not 8
  });

  // ── Test 4: RLS — non-organizer rejected ──────────────────

  it("rejects a non-organizer caller", async () => {
    const { match } = await draftMatchSetup();
    const stranger = await makeProfile({ faker });

    const restore = mockAuthAs(stranger.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/forbidden|unauthorized/i);
    } finally {
      restore();
    }

    // Match should still be a draft
    const { data: m } = await serviceClient()
      .from("matches")
      .select("is_published")
      .eq("id", match.id)
      .single();
    expect(m?.is_published).toBe(false);
  });

  // ── Test 5: RLS — unauthenticated rejected ────────────────

  it("rejects an unauthenticated caller", async () => {
    const { match } = await draftMatchSetup();

    // No mockAuthAs → authState.currentUserId = null → getUser() returns null user
    clearMockAuth();

    const result = await publishMatchAction(match.id);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/unauthorized/i);
  });

  // ── Test 6: publishAllDraftMatchesAction ──────────────────

  it("publishAllDraftMatchesAction publishes all draft matches in one call", async () => {
    const { organizer, session } = await draftMatchSetup();

    // Create 2 more draft matches (3 total in session)
    const extraPlayers1 = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    await Promise.all(
      extraPlayers1.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );
    await makeMatch({
      sessionId: session.id,
      teamA: [extraPlayers1[0].id, extraPlayers1[1].id],
      teamB: [extraPlayers1[2].id, extraPlayers1[3].id],
      isPublished: false,
    });

    const extraPlayers2 = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    await Promise.all(
      extraPlayers2.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );
    await makeMatch({
      sessionId: session.id,
      teamA: [extraPlayers2[0].id, extraPlayers2[1].id],
      teamB: [extraPlayers2[2].id, extraPlayers2[3].id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await publishAllDraftMatchesAction(session.id);
      expect(result.success).toBe(true);
      expect(result.publishedCount).toBe(3);
    } finally {
      restore();
    }

    // All draft matches are now published
    const { count: unpublishedCount } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("is_published", false)
      .eq("status", "pending");

    expect(unpublishedCount).toBe(0);
  });

  // ── Test 7: Organizer of different session rejected ────────

  it("organizer of a different session cannot publish a match they don't own", async () => {
    const { match } = await draftMatchSetup();

    // Different organizer who owns a different session
    const otherOrg = await makeProfile({ faker });
    await makeSession({ faker, organizer: otherOrg.id });

    const restore = mockAuthAs(otherOrg.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(false);
    } finally {
      restore();
    }
  });

  // ── Test 8: hasDraftsBlocking via callNextMatch ────────────

  it("callNextMatch returns hasDraftsBlocking=true when only unpublished drafts exist", async () => {
    const { organizer, session, court } = await draftMatchSetup();
    await enableAutoMatchmaking(session.id);

    // Move all queue entries to on_deck so engine can't create more
    await serviceClient()
      .from("queue_entries")
      .update({ status: "on_deck" as const })
      .eq("session_id", session.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await callNextMatch(session.id, court.id);
      // Should signal that drafts need review before calling next match
      expect(result.hasDraftsBlocking).toBe(true);
      expect(result.success).toBe(false);
    } finally {
      restore();
    }
  });
});
