// ============================================================
// Performance Smoke Test (Phase 3)
// ============================================================
// Verifies that performance-critical paths complete within
// acceptable time bounds under realistic load.
//
// From the plan:
//   "closeSession on a 12-player / 30-match session completes < 5s"
//
// Why this matters:
//   closeSession runs 3 RPCs (refresh_cross_session_stats,
//   compute_session_wrapped — which iterates all players — and
//   the broadcastSessionClosed fetch). On large sessions it could
//   accumulate enough latency to time out or cause UI jank.
//   Catching regressions here beats finding them on a real Sunday night.
//
// Tolerance: 5 000 ms (from the plan). We use 7 000 ms in the
// test to account for Docker overhead in local dev and CI cold starts.
// The intent is to catch O(n²) regressions, not to pin exact timing.
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
  makeCompletedMatch,
} from "./factories";
import { truncateTracked } from "./helpers/truncate";
import { mockAuthAs } from "./helpers/mock-auth";
import { closeSession } from "@/app/actions/sessions";

const faker = new Faker({ locale: [en] });
faker.seed(8001);

// Performance tests use a higher timeout — the test itself limits to 7s
// but Vitest needs to account for setup + teardown overhead too.
// The suite-level timeout is set in vitest.integration.config.ts (30s).

afterEach(async () => {
  await truncateTracked();
});

describe("Performance Smoke", () => {
  it("closeSession on a 12-player / 30-match session completes in under 7s", async () => {
    // ── Seed the session ──────────────────────────────────────
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

    // Create 12 players (4 groups of 3 — the 4th will appear in later matches)
    const players = await Promise.all(
      Array.from({ length: 12 }, () => makeProfile({ faker, skill: "intermediate" }))
    );

    // Add all to queue
    await Promise.all(
      players.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );

    // Create 30 completed matches cycling through all 12 players.
    // 30 matches × 4 players each = realistic load for a busy session.
    // Teams rotate to prevent partnership cap from interfering.
    // IMPORTANT: matches are seeded sequentially (not via Promise.all) to avoid
    // exhausting the Supabase HTTP client under 90+ concurrent requests (30 × 3 calls).
    const MATCH_COUNT = 30;

    for (let i = 0; i < MATCH_COUNT; i++) {
      // Rotate through player combinations using modular indexing
      const teamA: [string, string] = [
        players[i % players.length].id,
        players[(i + 1) % players.length].id,
      ];
      const teamB: [string, string] = [
        players[(i + 2) % players.length].id,
        players[(i + 3) % players.length].id,
      ];

      // Stagger scores to create interesting win/loss patterns
      const scoreA = i % 3 === 0 ? 15 : 21;
      const scoreB = i % 3 === 0 ? 21 : 15;

      await makeCompletedMatch({
        sessionId: session.id,
        teamA,
        teamB,
        scoreA,
        scoreB,
        courtId: court.id,
      });
    }

    // ── Measure closeSession ──────────────────────────────────
    const restore = mockAuthAs(organizer.id);
    const start = Date.now();
    let result: Awaited<ReturnType<typeof closeSession>>;
    try {
      result = await closeSession(session.id);
    } finally {
      restore();
    }
    const elapsed = Date.now() - start;

    // ── Assertions ────────────────────────────────────────────
    expect(result.success).toBe(true);

    // 7 000 ms = plan's 5 000 ms + 2 000 ms Docker/CI overhead budget.
    // If this fails consistently, profile compute_session_wrapped for O(n²) loops.
    expect(elapsed).toBeLessThan(7_000);

    // wrappedReady should be true — all 12 players had at least 1 match
    expect(result.wrappedReady).toBe(true);
  }, 15_000); // Increase per-test timeout to 15s for this heavy seed+close cycle
});
