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
import { endMatchAction, submitMatchScore, cancelMatchAction } from "@/app/actions/match-lifecycle";

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

    // Assert on `code`, not on the copy. This is a genuine race, so the loser
    // may land on either of two branches — the status pre-check, or the CAS
    // itself — and they word it differently for the user ("Match is already
    // completed." vs "This match was already scored by someone else."). Both
    // report `already_scored`, which is the contract the UI actually consumes
    // to transition the loser out instead of stranding them on the form.
    expect(failures[0].code).toBe("already_scored");
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

  // ============================================================
  // cancelMatchAction — contract distinct from endMatchAction
  // ============================================================
  // The key contract distinction: cancel returns players to the queue
  // WITHOUT incrementing games_played, because the match never finished.
  // endMatchAction always increments. Both transition status to 'waiting'
  // (or skip if 'left'), but only end touches games_played.

  // ── F-cancel-1: status flips, scores untouched ────────────
  it("F-cancel-1: cancelMatchAction sets status='cancelled' and completed_at", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data } = await serviceClient()
      .from("matches")
      .select("status, team_a_score, team_b_score, completed_at")
      .eq("id", match.id)
      .single();
    expect(data?.status).toBe("cancelled");
    expect(data?.completed_at).not.toBeNull();
    // Cancel never writes scores.
    expect(data?.team_a_score).toBeNull();
    expect(data?.team_b_score).toBeNull();
  });

  // ── F-cancel-2: games_played NOT incremented ──────────────
  it("F-cancel-2: cancelMatchAction returns players to 'waiting' WITHOUT incrementing games_played", async () => {
    const { organizer, session, players, match } = await inProgressMatchSetup();

    // Set every player's games_played to a known value so we can assert no change.
    await serviceClient()
      .from("queue_entries")
      .update({ games_played: 7 })
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    const { data: before } = await serviceClient()
      .from("queue_entries")
      .select("player_id, joined_at")
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );
    const joinedAtBefore = new Map((before ?? []).map((e) => [e.player_id, e.joined_at]));

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("player_id, status, games_played, joined_at")
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    expect(entries).toHaveLength(4);
    for (const e of entries ?? []) {
      expect(e.status).toBe("waiting");
      expect(e.games_played).toBe(7); // ← unchanged. endMatchAction would set 8.
      // joined_at is the OTHER column requeue_finished_players rewrites
      // (`joined_at = now()`), and the reason that RPC cannot be reused on the
      // cancel path even though its p_drafted_ids argument looks like exactly
      // what the held re-reservation needs. Restamping it would cost every
      // cancelled player their place in the queue: wait_minutes resets to 0 and
      // they sort to the back of fetchActivePool. Cancel must write `status` and
      // nothing else.
      expect(e.joined_at).toBe(joinedAtBefore.get(e.player_id));
    }
  });

  // ── F-cancel-3: non-organizer rejected ────────────────────
  it("F-cancel-3: cancelMatchAction rejects a non-organizer caller", async () => {
    const { session, match, players } = await inProgressMatchSetup();
    const outsider = await makeProfile({ faker });

    const restore = mockAuthAs(outsider.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/organizer/i);
    } finally {
      restore();
    }

    const { data } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", match.id)
      .single();
    expect(data?.status).toBe("in_progress"); // unchanged

    // Side-effect backstop: the organizer guard runs BEFORE the queue update.
    // Confirm queue_entries are untouched — every player still 'playing'.
    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );
    for (const e of entries ?? []) {
      expect(e.status).toBe("playing");
    }
  });

  // ── F-cancel-4: CAS guard against double-cancel ──────────
  it("F-cancel-4: cancelMatchAction is idempotent — second call rejects via CAS guard", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    try {
      const r1 = await cancelMatchAction(match.id);
      expect(r1.success).toBe(true);

      const r2 = await cancelMatchAction(match.id);
      expect(r2.success).toBe(false);
      expect(r2.message).toMatch(/already cancelled|already completed/i);
    } finally {
      restore();
    }
  });

  // ── F-cancel-5: 'left' players are not pulled back ───────
  it("F-cancel-5: cancelMatchAction does NOT restore players whose status is 'left'", async () => {
    const { organizer, session, players, match } = await inProgressMatchSetup();

    // Player[0] checked out mid-match — their queue entry is now 'left'.
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", session.id)
      .eq("player_id", players[0].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await cancelMatchAction(match.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data: leftEntry } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", players[0].id)
      .single();
    expect(leftEntry?.status).toBe("left"); // NOT pulled back to 'waiting'

    // Other 3 players were restored as expected.
    const { data: others } = await serviceClient()
      .from("queue_entries")
      .select("player_id, status")
      .eq("session_id", session.id)
      .in("player_id", [players[1].id, players[2].id, players[3].id]);
    for (const e of others ?? []) {
      expect(e.status).toBe("waiting");
    }
  });

  // ============================================================
  // Score schema server-side validation (P0 coverage gap)
  // ============================================================
  // scoreSchema (src/lib/schemas/match.ts) gates endMatchAction and
  // submitMatchScore before any DB write.  These tests verify the
  // server action rejects out-of-range scores even when called
  // directly (bypassing any UI form validation).

  it("F-score-1: endMatchAction rejects teamAScore > 30 (server-side schema)", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof endMatchAction>>;
    try {
      result = await endMatchAction(match.id, 999, 15);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.message).toMatch(/exceed|30|score/i);

    // DB must be untouched — match still in_progress
    const { data: m } = await serviceClient()
      .from("matches")
      .select("status, team_a_score")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("in_progress");
    expect(m?.team_a_score).toBeNull();
  });

  it("F-score-2: endMatchAction rejects teamBScore < 0 (server-side schema)", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof endMatchAction>>;
    try {
      result = await endMatchAction(match.id, 21, -1);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.message).toMatch(/negative|score/i);

    const { data: m } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("in_progress");
  });

  it("F-score-3: endMatchAction rejects non-integer score (float bypass attempt)", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof endMatchAction>>;
    try {
      // 21.5 is a float — scoreSchema requires .int()
      result = await endMatchAction(match.id, 21.5, 15);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.message).toMatch(/whole number|integer|score/i);
  });

  it("F-score-4: submitMatchScore also inherits server-side score validation", async () => {
    const { players, match } = await inProgressMatchSetup();

    // Player submitting their own score — still subject to scoreSchema
    const restore = mockAuthAs(players[0].id);
    let result: Awaited<ReturnType<typeof submitMatchScore>>;
    try {
      result = await submitMatchScore(match.id, 999, 15);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.message).toMatch(/exceed|30|score/i);

    const { data: m } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("in_progress");
  });

  it("F-score-5: exact boundary values 0 and 30 are accepted", async () => {
    const { organizer, match } = await inProgressMatchSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof endMatchAction>>;
    try {
      result = await endMatchAction(match.id, 30, 0);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);

    const { data: m } = await serviceClient()
      .from("matches")
      .select("status, team_a_score, team_b_score")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("completed");
    expect(m?.team_a_score).toBe(30);
    expect(m?.team_b_score).toBe(0);
  });
});
