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
  makeMatchViaRpc,
  enableAutoMatchmaking,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { publishMatchAction, publishAllDraftMatchesAction } from "@/app/actions/match-drafts";
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

  // Add players to the queue as "waiting" — the RPC will transition them
  await Promise.all([
    makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
  ]);

  // Create draft via RPC — this atomically sets all 4 players to "drafted".
  // Previously used makeMatch (direct insert) which left players as "waiting";
  // publishMatchAction now guards .eq("status","drafted") so that path is tested
  // separately in drafted-status.test.ts.
  const match = await makeMatchViaRpc({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
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

// ─────────────────────────────────────────────────────────────
// PUB-HELD-DB — publish never touches an UNREADY held draft
// ─────────────────────────────────────────────────────────────
// Migration 20260816000000, exercised against the real RPCs. These are the
// cases the unit suites structurally cannot reach: publish_match's CONFLICT
// predicate needs a genuinely in_progress source match holding the pulled body,
// and publish_all_drafts' candidate filter is a SQL predicate, not a JS one.
//
// -DB suffix on purpose: tests/unit/publish-held-guard.test.ts already owns
// PUB-HELD-1..10 for the JS fallbacks, and these are different tests of the
// other half. Bare "PUB-HELD-2" in a doc would be ambiguous between them.
//
// Field evidence this is regression-guarding, not hypothetical: session
// 3367d4c6, 2026-08-15 — 12 held drafts created, 10 cleared by hand on the
// advice of a CONFLICT message, 2 reached a court.

/**
 * Organizer + session + a live source match on Court 1 + a held cross-court
 * draft = 3 waiting members and 1 pulled body who is still playing.
 *
 * Built through create_held_cross_court_match rather than a raw insert so
 * is_held (GENERATED from pulled_player_ids) and the drafted/playing queue
 * statuses come out exactly as the engine writes them.
 */
async function heldDraftSetup() {
  const organizer = await makeProfile({ faker });
  const [m1, m2, m3, b1, b2, b3, b4] = await Promise.all(
    Array.from({ length: 7 }, () => makeProfile({ faker }))
  );

  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });

  await Promise.all([
    ...[m1, m2, m3].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
    ...[b1, b2, b3, b4].map((p) =>
      makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
    ),
  ]);

  const sourceMatch = await makeMatch({
    sessionId: session.id,
    teamA: [b1.id, b2.id],
    teamB: [b3.id, b4.id],
    courtId: court.id,
    status: "in_progress",
    isPublished: true,
  });
  // fetchPullablePlayers ignores a NULL-started in_progress match; stamp it so
  // the fixture matches a real live court.
  await serviceClient()
    .from("matches")
    .update({ started_at: new Date(Date.now() - 4 * 60_000).toISOString() })
    .eq("id", sourceMatch.id);

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
    throw new Error(`[heldDraftSetup] RPC returned ${heldId} — ${error?.message ?? "guard fired"}`);
  }

  return {
    organizer,
    session,
    court,
    members: [m1, m2, m3],
    body: b1,
    sourceMatch,
    heldId: heldId as string,
  };
}

async function matchRow(id: string) {
  const { data } = await serviceClient()
    .from("matches")
    .select("is_published, is_held, held_ready_at, status")
    .eq("id", id)
    .single();
  return data;
}

async function queueStatusOf(sessionId: string, playerId: string) {
  const { data } = await serviceClient()
    .from("queue_entries")
    .select("status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();
  return data?.status ?? null;
}

describe("publish + held drafts — Suite PUB-HELD-DB", () => {
  it("PUB-HELD-DB-1: publish_match refuses a HOLDING draft as 'not ready', not as a conflict", async () => {
    const { organizer, session, members, body, heldId } = await heldDraftSetup();

    // Sanity: the fixture really is the unpublishable state.
    expect(await matchRow(heldId)).toMatchObject({ is_held: true, held_ready_at: null });

    const restore = mockAuthAs(organizer.id);
    let result;
    try {
      result = await publishMatchAction(heldId);
    } finally {
      restore();
    }

    expect(result.success).toBe(false);
    // The distinction the whole migration exists for. Before it, the pulled body
    // sitting in an in_progress match made the conflict predicate fire every
    // time, and the organizer was told to clear a draft that was merely waiting.
    expect(result.message).toMatch(/still on court/i);
    expect(result.message).not.toMatch(/regenerate/i);

    // Nothing moved: not the row...
    expect(await matchRow(heldId)).toMatchObject({ is_published: false });
    // ...not the three parked members...
    for (const m of members) {
      expect(await queueStatusOf(session.id, m.id)).toBe("drafted");
    }
    // ...and above all not the body, who is physically on Court 1.
    expect(await queueStatusOf(session.id, body.id)).toBe("playing");
  });

  it("PUB-HELD-DB-2: the same draft publishes once the hold resolves", async () => {
    const { organizer, session, members, body, heldId, sourceMatch } = await heldDraftSetup();

    // What READY actually is in production: the source game ended (so the body is
    // no longer double-booked), endMatchAction re-reserved the body as 'drafted'
    // rather than 'waiting' because it appears in a pending draft's
    // pulled_player_ids, and recomputeHeldReadiness stamped the row. All three
    // halves matter — the stamp alone would still trip the conflict check.
    await serviceClient().from("matches").update({ status: "completed" }).eq("id", sourceMatch.id);
    await serviceClient()
      .from("queue_entries")
      .update({ status: "drafted" })
      .eq("session_id", session.id)
      .eq("player_id", body.id);
    await serviceClient()
      .from("matches")
      .update({ held_ready_at: new Date().toISOString() })
      .eq("id", heldId);

    const restore = mockAuthAs(organizer.id);
    let result;
    try {
      result = await publishMatchAction(heldId);
    } finally {
      restore();
    }

    // A guard that never lifts is the original bug with the sign flipped, and
    // permanent — the draft could never reach a court at all.
    expect(result.success).toBe(true);
    expect(await matchRow(heldId)).toMatchObject({ is_published: true });
    for (const p of [...members, body]) {
      expect(await queueStatusOf(session.id, p.id)).toBe("on_deck");
    }
  });

  it("PUB-HELD-DB-3: Publish All publishes the ordinary drafts and leaves the hold alone — without calling it a skip", async () => {
    const { organizer, session, heldId } = await heldDraftSetup();

    // A plain draft alongside the hold, from four fresh waiting players.
    const [q1, q2, q3, q4] = await Promise.all(
      Array.from({ length: 4 }, () => makeProfile({ faker }))
    );
    await Promise.all(
      [q1, q2, q3, q4].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );
    const plain = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [q1.id, q2.id],
      teamB: [q3.id, q4.id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    let result;
    try {
      result = await publishAllDraftMatchesAction(session.id);
    } finally {
      restore();
    }

    expect(result.success).toBe(true);
    expect(result.publishedCount).toBe(1);
    // skipped_count is the number the client turns into "clear and regenerate".
    // The hold was never a candidate, so it is not an attempt, so it must not
    // appear here — this is the difference between excluding it from
    // v_all_draft_ids and letting it fall through into v_skipped_ids.
    expect(result.skippedCount).toBe(0);
    expect(result.message).not.toMatch(/skipped/i);

    expect(await matchRow(plain.id)).toMatchObject({ is_published: true });
    expect(await matchRow(heldId)).toMatchObject({ is_published: false });
  });

  it("PUB-HELD-DB-4: Publish All with nothing but an unready hold is a clean no-op", async () => {
    const { organizer, session, members, body, heldId } = await heldDraftSetup();

    const restore = mockAuthAs(organizer.id);
    let result;
    try {
      result = await publishAllDraftMatchesAction(session.id);
    } finally {
      restore();
    }

    // v_all_draft_ids comes back NULL and the RPC returns its early success.
    // Reported as success with zero counts, not as a failure: nothing is broken.
    expect(result.success).toBe(true);
    expect(result.publishedCount).toBe(0);
    expect(result.skippedCount).toBe(0);

    // The RESTING-window failure this prevents: publishing here would flip these
    // four rows to on_deck and fire an ON_DECK_WARNING push, while
    // promoteOnDeckMatchInternal still refused the match (it filters on
    // held_ready_at IS NOT NULL) — a card parked on deck that no court would take.
    expect(await matchRow(heldId)).toMatchObject({ is_published: false });
    for (const m of members) {
      expect(await queueStatusOf(session.id, m.id)).toBe("drafted");
    }
    expect(await queueStatusOf(session.id, body.id)).toBe("playing");
  });
});
