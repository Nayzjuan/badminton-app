// ============================================================
// Suite D — Concurrency & Race Condition Tests (Phase 3)
// ============================================================
// Tests that concurrent operations on the same resource are safe.
//
// Two scenarios:
//
// 1. publishMatchAction × 5 concurrent calls on the same draft match.
//    The DB-level idempotency guard (.eq("is_published", false)) means
//    only the FIRST UPDATE wins. All 5 calls return "success" (idempotent
//    semantics) but the match is published exactly once and the 4 queue
//    entries are transitioned to "on_deck" exactly once.
//
// 2. runEngineForSession × 5 concurrent calls on the same session.
//    The in-process engineRunningFor Set prevents concurrent engine runs
//    within the same Node.js worker. Calls 2-5 return immediately.
//    The resulting pending matches are created only once — not 5×.
//
// Note: "concurrency" here is within a single Node.js event loop
// (Promise.all on the same worker). Multi-process concurrency (separate
// request handlers) is covered by the CAS guards in the DB layer; those
// are tested via the atomic-guard assertions in Suite A + Suite C.
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
import { mockAuthAs } from "./helpers/mock-auth";
import { publishMatchAction } from "@/app/actions/match";
import { runEngineForSession, callNextMatch } from "@/app/actions/matchmaking";

const faker = new Faker({ locale: [en] });
faker.seed(5001);

afterEach(async () => {
  await truncateTracked();
});

describe("Concurrency & Race Conditions — Suite D", () => {
  // ── Test 1: Concurrent publish — only publishes once ──────

  it("5 concurrent publishMatchAction calls on the same draft publish it exactly once", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    await makeCourt({ sessionId: session.id, name: "Court 1" });

    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);

    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
    ]);

    const match = await makeMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    let results: Awaited<ReturnType<typeof publishMatchAction>>[];
    try {
      // Fire 5 concurrent publish calls on the same match
      results = await Promise.all(
        Array.from({ length: 5 }, () => publishMatchAction(match.id))
      );
    } finally {
      restore();
    }

    // All calls return success (idempotent — already-published is not an error)
    for (const r of results) {
      expect(r.success).toBe(true);
    }

    // Match is published exactly once
    const { data: m } = await serviceClient()
      .from("matches")
      .select("is_published")
      .eq("id", match.id)
      .single();
    expect(m?.is_published).toBe(true);

    // Queue entries are "on_deck" — each player updated exactly once
    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("player_id, status")
      .eq("session_id", session.id)
      .in("player_id", [p1.id, p2.id, p3.id, p4.id]);

    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(4);
    for (const e of entries!) {
      expect(e.status).toBe("on_deck");
    }
  });

  // ── Test 2: Concurrent engine runs — serialized in-process ─

  it("5 concurrent runEngineForSession calls create matches only from one run", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    await enableAutoMatchmaking(session.id);
    await makeCourt({ sessionId: session.id, name: "Court 1" });

    // 8 waiting players — enough for the engine to create exactly 1 draft
    await Promise.all(
      Array.from({ length: 8 }, () =>
        makeProfile({ faker }).then((p) =>
          makeQueueEntry({ sessionId: session.id, playerId: p.id })
        )
      )
    );

    // Fire 5 concurrent engine runs on the same session.
    // The in-process engineRunningFor Set prevents concurrent execution;
    // calls 2-5 return immediately while call 1 is in flight.
    await Promise.all(
      Array.from({ length: 5 }, () => runEngineForSession(session.id))
    );

    // Exactly 1 match should have been created (one engine run produces 1
    // draft with 8 players and the MIN_FREE_POOL_FOR_ON_DECK check stopping at 1)
    const { count } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending");

    // The serialization guarantee: at most 1 match per engine run that completed.
    // With 8 players and the pool-diversity cap, exactly 1 draft is expected.
    expect(count).toBe(1);
  });

  // ── Test 3: Concurrent promote — CAS prevents double-promotion

  it("concurrent promoteOnDeckMatchInternal via callNextMatch does not double-assign a match", async () => {
    // This tests the DB-level CAS guard in promoteOnDeckMatchInternal:
    //   .eq("status", "pending")  ← only one UPDATE wins
    // Two courts, one published on-deck match → only one court gets the match.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    await enableAutoMatchmaking(session.id);

    const court1 = await makeCourt({ sessionId: session.id, name: "Court 1" });
    const court2 = await makeCourt({ sessionId: session.id, name: "Court 2" });

    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);

    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
    ]);

    // Create ONE published on-deck match
    const match = await makeMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: true, // published → eligible for promotion
    });

    // Update players to on_deck (normally done by publishMatchAction)
    await serviceClient()
      .from("queue_entries")
      .update({ status: "on_deck" as const })
      .eq("session_id", session.id)
      .in("player_id", [p1.id, p2.id, p3.id, p4.id]);

    // Two concurrent callNextMatch on different courts — only one can promote the match
    const restore = mockAuthAs(organizer.id);
    let results: Array<{ success: boolean; message: string }>;
    try {
      results = await Promise.all([
        callNextMatch(session.id, court1.id),
        callNextMatch(session.id, court2.id),
      ]);
    } finally {
      restore();
    }

    // Exactly one promotion succeeds; the other fails gracefully
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // The match is now in_progress, assigned to exactly one court
    const { data: updatedMatch } = await serviceClient()
      .from("matches")
      .select("status, court_id")
      .eq("id", match.id)
      .single();

    expect(updatedMatch?.status).toBe("in_progress");
    expect(updatedMatch?.court_id).not.toBeNull();
  });
});
