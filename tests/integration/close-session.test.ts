// ============================================================
// Suite B — closeSession + Wrapped Pipeline (Phase 2)
// ============================================================
// Tests the closeSession server action and the three RPCs it invokes:
//   1. refresh_cross_session_stats — upserts player_rivalries + player_partnerships
//   2. compute_session_wrapped — computes per-player awards + carry_forward
//   3. broadcastSessionClosed — fire-and-forget; side effects not asserted
//
// Key invariants tested:
//   • Idempotency: second close returns "already closed" with no side effects
//   • Authorization: non-organizer rejected; co-organizer succeeds
//   • Authorization ORDER: the denial is not a session-UUID existence or
//     status oracle (Test 1b) — the gate must precede the session fetch
//   • Cross-session accumulation: sessions_faced increments per session
//   • Wrapped pipeline: wrappedReady = true when RPC succeeds
//   • Session state: is_active=false, pending matches cancelled, queue drained
//
// Isolation: Layer B — truncateTracked() in afterEach.
// Note: compute_session_wrapped and refresh_cross_session_stats are real
//       Supabase RPCs. They run against the local DB with real data.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import {
  makeProfile,
  makeSession,
  makeQueueEntry,
  makeCourt,
  makeCompletedMatch,
  makeMatch,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs } from "./helpers/mock-auth";
import { closeSession } from "@/app/actions/sessions";

const faker = new Faker({ locale: [en] });
faker.seed(3001);

afterEach(async () => {
  await truncateTracked();
});

// ── Shared helper ──────────────────────────────────────────────

/**
 * Seeds a session with 4 players and 2 completed matches.
 * Enough for refresh_cross_session_stats and compute_session_wrapped to run.
 */
async function seedActiveSession() {
  const organizer = await makeProfile({ faker, skill: "intermediate" });
  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

  const [p1, p2, p3, p4] = await Promise.all([
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
  ]);

  // Add all to the queue
  await Promise.all([
    makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
    makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
  ]);

  // Seed 2 completed matches for wrapped + rivalry stats
  await makeCompletedMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    scoreA: 21,
    scoreB: 15,
    courtId: court.id,
  });
  await makeCompletedMatch({
    sessionId: session.id,
    teamA: [p3.id, p4.id],
    teamB: [p1.id, p2.id],
    scoreA: 21,
    scoreB: 18,
    courtId: court.id,
  });

  return { organizer, session, court, players: [p1, p2, p3, p4] };
}

// ─────────────────────────────────────────────────────────────

describe("closeSession — Suite B", () => {
  // ── Test 1: Authorization — non-organizer rejected ────────

  it("rejects non-organizer callers", async () => {
    const { session } = await seedActiveSession();
    const stranger = await makeProfile({ faker });

    const restore = mockAuthAs(stranger.id);
    try {
      const result = await closeSession(session.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not authorized|organizer/i);
    } finally {
      restore();
    }

    // Session should still be active
    const { data: s } = await serviceClient()
      .from("sessions")
      .select("is_active")
      .eq("id", session.id)
      .single();
    expect(s?.is_active).toBe(true);
  });

  // ── Test 1b: the denial must not be an oracle ─────────────
  // Guard ORDER, not guard existence. Test 1 passes with the organizer gate
  // in either position, because it only ever probes an existing ACTIVE
  // session — the one input for which both orderings answer identically.
  // With the gate below the session fetch, an authenticated caller who
  // organizes nothing could tell three cases apart from the reply alone:
  // "Session not found." / "Session is already closed." / "Not authorized."
  // — a session-UUID existence-and-status oracle across tenants.
  //
  // The rule is already written down at sessions.ts (see the note above
  // applyDraftCapOverride's Promise.all): isSessionOrganizer returns false
  // for both "not yours" and "does not exist", so a distinct message is what
  // creates the leak. Asserts on `message` — every branch here would share
  // an errorCode even if one existed.

  it("Test 1b: a non-organizer cannot tell an active, a closed, and a nonexistent session apart", async () => {
    const active = await seedActiveSession();
    const closed = await seedActiveSession();
    const stranger = await makeProfile({ faker });
    const nonexistent = faker.string.uuid();

    // Close the second one as its own organizer, so it is genuinely closed.
    const asOwner = mockAuthAs(closed.organizer.id);
    try {
      const closeIt = await closeSession(closed.session.id);
      expect(closeIt.success).toBe(true);
    } finally {
      asOwner();
    }

    const restore = mockAuthAs(stranger.id);
    try {
      const onActive = await closeSession(active.session.id);
      const onClosed = await closeSession(closed.session.id);
      const onMissing = await closeSession(nonexistent);

      expect(onActive.message).toBe("Not authorized. Organizer access required.");
      expect(onClosed.message).toBe(onActive.message);
      expect(onMissing.message).toBe(onActive.message);
      // `alreadyClosed` is a second channel a message-only pin would miss: the
      // UI treats it as a success, so leaking it would both disclose state and
      // tell a stranger their close "worked".
      expect(onActive.alreadyClosed).toBeUndefined();
      expect(onClosed.alreadyClosed).toBeUndefined();
      expect(onMissing.alreadyClosed).toBeUndefined();
      expect([onActive.success, onClosed.success, onMissing.success]).toEqual([
        false,
        false,
        false,
      ]);
    } finally {
      restore();
    }

    // An organizer of a DIFFERENT session is just as much a stranger here.
    const asOtherOrganizer = mockAuthAs(active.organizer.id);
    try {
      const crossTenant = await closeSession(closed.session.id);
      expect(crossTenant.message).toBe("Not authorized. Organizer access required.");
      expect(crossTenant.alreadyClosed).toBeUndefined();
    } finally {
      asOtherOrganizer();
    }

    // Positive control — the real organizer DOES get the state-revealing
    // reply, so this test cannot pass by making every caller's answer uniform.
    const asClosedOwner = mockAuthAs(closed.organizer.id);
    try {
      const secondClose = await closeSession(closed.session.id);
      expect(secondClose.message).toBe("Session is already closed.");
      expect(secondClose.alreadyClosed).toBe(true);
    } finally {
      asClosedOwner();
    }

    // The still-open session must be untouched by any of the above.
    const { data: s } = await serviceClient()
      .from("sessions")
      .select("is_active")
      .eq("id", active.session.id)
      .single();
    expect(s?.is_active).toBe(true);
  });

  // ── Test 2: Authorization — co-organizer succeeds ─────────

  it("allows a co-organizer (session_organizers row) to close the session", async () => {
    const { session } = await seedActiveSession();
    const coOrg = await makeProfile({ faker });

    // Insert co-organizer row
    await serviceClient()
      .from("session_organizers")
      .insert({ session_id: session.id, user_id: coOrg.id });

    const restore = mockAuthAs(coOrg.id);
    try {
      const result = await closeSession(session.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }
  });

  // ── Test 3: Idempotency ───────────────────────────────────

  it("returns 'already closed' with no side effects on second call", async () => {
    const { session, organizer } = await seedActiveSession();

    // First close
    const restore1 = mockAuthAs(organizer.id);
    await closeSession(session.id);
    restore1();

    // Second close — should be idempotent
    const restore2 = mockAuthAs(organizer.id);
    try {
      const result = await closeSession(session.id);
      expect(result.success).toBe(false);
      expect(result.message).toBe("Session is already closed.");
    } finally {
      restore2();
    }

    // Verify wrapped stats weren't doubled
    const { count: wrappedCount } = await serviceClient()
      .from("session_wrapped_stats")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id);

    // Should have stats for all 4 players — not duplicated
    expect(wrappedCount).toBeLessThanOrEqual(4);
  });

  // ── Test 4: Happy path — session state ───────────────────

  it("marks session inactive, cancels pending matches, drains queue", async () => {
    const { session, organizer, players } = await seedActiveSession();

    // Add a pending match that should be cancelled
    await makeMatch({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      status: "pending",
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await closeSession(session.id);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    // Session is inactive
    const { data: s } = await serviceClient()
      .from("sessions")
      .select("is_active, ended_at")
      .eq("id", session.id)
      .single();
    expect(s?.is_active).toBe(false);
    expect(s?.ended_at).not.toBeNull();

    // Pending match was cancelled
    const { data: matches } = await serviceClient()
      .from("matches")
      .select("status")
      .eq("session_id", session.id)
      .eq("status", "pending");
    expect(matches).toHaveLength(0);

    // Queue entries marked "left"
    const { data: queueEntries } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .in("status", ["waiting", "on_deck", "playing"]);
    expect(queueEntries).toHaveLength(0);
  });

  // ── Test 5: Wrapped pipeline — wrappedReady ───────────────

  it("returns wrappedReady=true when compute_session_wrapped succeeds", async () => {
    const { session, organizer } = await seedActiveSession();

    const restore = mockAuthAs(organizer.id);
    let result;
    try {
      result = await closeSession(session.id);
    } finally {
      restore();
    }

    expect(result.success).toBe(true);
    expect(result.wrappedReady).toBe(true);
  });

  // ── Test 6: Wrapped pipeline — session_wrapped_stats created ─

  it("creates session_wrapped_stats rows for all players who played", async () => {
    const { session, organizer, players } = await seedActiveSession();

    const restore = mockAuthAs(organizer.id);
    try {
      await closeSession(session.id);
    } finally {
      restore();
    }

    const { data: wrappedStats } = await serviceClient()
      .from("session_wrapped_stats")
      .select("player_id")
      .eq("session_id", session.id);

    // All 4 players who participated in matches should have wrapped stats
    expect(wrappedStats).not.toBeNull();
    expect(wrappedStats!.length).toBe(4);

    const wrappedPlayerIds = new Set(wrappedStats!.map((r) => r.player_id));
    for (const p of players) {
      expect(wrappedPlayerIds.has(p.id)).toBe(true);
    }
  });

  // ── Test 7: Cross-session stats — rivalry accumulation ────

  it("player_rivalries sessions_faced increments per distinct session close", async () => {
    // Session 1
    const { session: s1, organizer: org1, players: p1s } = await seedActiveSession();
    const restore1 = mockAuthAs(org1.id);
    await closeSession(s1.id);
    restore1();

    // After session 1: p1s[0] and p1s[2] are rivals (opposing teams)
    const { data: rivalry1 } = await serviceClient()
      .from("player_rivalries")
      .select("sessions_faced, wins_vs, losses_vs")
      .eq("player_id", p1s[0].id)
      .eq("rival_id", p1s[2].id)
      .maybeSingle();

    expect(rivalry1).not.toBeNull();
    expect(rivalry1!.sessions_faced).toBe(1);

    // Session 2 — same players face each other again
    const org2 = await makeProfile({ faker });
    const s2 = await makeSession({ faker, organizer: org2.id });

    // All 4 players from session 1 join session 2 and play each other
    await makeCompletedMatch({
      sessionId: s2.id,
      teamA: [p1s[0].id, p1s[1].id],
      teamB: [p1s[2].id, p1s[3].id],
      scoreA: 21,
      scoreB: 10,
    });

    const restore2 = mockAuthAs(org2.id);
    await closeSession(s2.id);
    restore2();

    // After session 2: sessions_faced should be 2
    const { data: rivalry2 } = await serviceClient()
      .from("player_rivalries")
      .select("sessions_faced, wins_vs, losses_vs")
      .eq("player_id", p1s[0].id)
      .eq("rival_id", p1s[2].id)
      .maybeSingle();

    expect(rivalry2).not.toBeNull();
    expect(rivalry2!.sessions_faced).toBe(2);

    // wins_vs should be cumulative across both sessions
    expect(rivalry2!.wins_vs).toBeGreaterThanOrEqual(rivalry1!.wins_vs);
  });
});
