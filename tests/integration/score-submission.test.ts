// ============================================================
// Suite F — Score Submission Cascade (Phase 3)
// ============================================================
// Tests the full endMatchAction / submitMatchScore pipeline:
//
//   endMatchAction(matchId, 21, 15)
//     ├── Atomic CAS update: status → "completed", scores set
//     ├── Players re-queued: status → "waiting", games_played + 1
//     ├── Court freed (if no on-deck match) or next on-deck promoted
//     └── refresh_alltime_leaderboard fired (fire-and-forget)
//
// submitMatchScore delegates to endMatchAction after verifying
// the caller is a player in the match.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { endMatchAction, submitMatchScore } from "@/app/actions/match";

const faker = new Faker({ locale: [en] });
faker.seed(7001);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared helper ──────────────────────────────────────────────

/**
 * Seeds an in-progress match on a court with 4 playing players in the queue.
 * Returns everything needed to call endMatchAction.
 */
async function inProgressMatchSetup() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

  const [p1, p2, p3, p4] = await Promise.all([
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
  ]);

  // Set court in_use
  await serviceClient()
    .from("courts")
    .update({ status: "in_use" as const })
    .eq("id", court.id);

  // Create in-progress match on the court
  const match = await makeMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    courtId: court.id,
    status: "in_progress",
    isPublished: true,
  });

  // Add players to queue as "playing"
  await Promise.all([
    makeQueueEntry({ sessionId: session.id, playerId: p1.id, status: "playing" }),
    makeQueueEntry({ sessionId: session.id, playerId: p2.id, status: "playing" }),
    makeQueueEntry({ sessionId: session.id, playerId: p3.id, status: "playing" }),
    makeQueueEntry({ sessionId: session.id, playerId: p4.id, status: "playing" }),
  ]);

  return { organizer, session, court, players: [p1, p2, p3, p4], match };
}

// ─────────────────────────────────────────────────────────────

describe("Score Submission Cascade — Suite F", () => {
  // ── Test 1: Match completes with scores ───────────────────

  it("endMatchAction sets match status to completed with correct scores", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await endMatchAction(match.id, 21, 15);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data: m } = await serviceClient()
      .from("matches")
      .select("status, team_a_score, team_b_score, completed_at")
      .eq("id", match.id)
      .single();

    expect(m?.status).toBe("completed");
    expect(m?.team_a_score).toBe(21);
    expect(m?.team_b_score).toBe(15);
    expect(m?.completed_at).not.toBeNull();
  });

  // ── Test 2: Players re-queued ────────────────────────────

  it("all 4 players are returned to 'waiting' with games_played incremented", async () => {
    const { organizer, session, players, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      await endMatchAction(match.id, 21, 15);
    } finally {
      restore();
    }

    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("player_id, status, games_played")
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    expect(entries).not.toBeNull();
    for (const e of entries!) {
      expect(e.status).toBe("waiting");
      expect(e.games_played).toBe(1); // was 0 (playing), now 1 after completion
    }
  });

  // ── Test 3: Court freed when no on-deck match ─────────────

  it("court status returns to 'available' when no on-deck match exists", async () => {
    const { organizer, court, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      await endMatchAction(match.id, 21, 15);
    } finally {
      restore();
    }

    // No on-deck match seeded → court should be freed
    const { data: c } = await serviceClient()
      .from("courts")
      .select("status")
      .eq("id", court.id)
      .single();

    expect(c?.status).toBe("available");
  });

  // ── Test 4: CAS guard — concurrent completion ─────────────

  it("second concurrent endMatchAction on same match returns 'already completed'", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    let results: Awaited<ReturnType<typeof endMatchAction>>[];
    try {
      results = await Promise.all([
        endMatchAction(match.id, 21, 15),
        endMatchAction(match.id, 21, 15),
      ]);
    } finally {
      restore();
    }

    // Exactly one succeeds, the other hits the CAS guard
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].message).toMatch(/already completed/i);
  });

  // ── Test 5: submitMatchScore — player submits their own score

  it("submitMatchScore allows a player in the match to submit the score", async () => {
    const { players, match } = await inProgressMatchSetup();

    // Submit as p1 (team A player)
    const restore = mockAuthAs(players[0].id);
    try {
      const result = await submitMatchScore(match.id, 21, 15);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data: m } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("completed");
  });

  // ── Test 6: submitMatchScore — non-player rejected ────────

  it("submitMatchScore rejects a user not in the match", async () => {
    const { match } = await inProgressMatchSetup();
    const stranger = await makeProfile({ faker });

    const restore = mockAuthAs(stranger.id);
    try {
      const result = await submitMatchScore(match.id, 21, 15);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not a player/i);
    } finally {
      restore();
    }
  });

  // ── Test 7: endMatchAction — unauthenticated rejected ─────

  it("endMatchAction rejects unauthenticated callers", async () => {
    const { match } = await inProgressMatchSetup();

    clearMockAuth();
    const result = await endMatchAction(match.id, 21, 15);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authenticated/i);
  });

  // ── Test 8: Leaderboard view exists after match completion ─

  it("v_alltime_leaderboard_mat is queryable after match completion", async () => {
    const { organizer, match, players } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      await endMatchAction(match.id, 21, 15);
    } finally {
      restore();
    }

    // refresh_alltime_leaderboard is fire-and-forget — give it a moment
    await new Promise((r) => setTimeout(r, 500));

    // The materialized view should be queryable (may or may not contain
    // these players yet, depending on when the refresh lands, but it must exist)
    const { error } = await serviceClient()
      .from("v_alltime_leaderboard_mat")
      .select("player_id, games_played")
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    expect(error).toBeNull();
  });
});
