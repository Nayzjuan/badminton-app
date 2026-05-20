// ============================================================
// Suite P — Player Pause (togglePlayerPause)
// ============================================================
// togglePlayerPause is the ONLY queue action with zero coverage
// anywhere in the test suite.  It is organizer-only and modifies
// is_paused on a queue_entries row WITHOUT touching joined_at or
// games_played — preserving the player's queue position and stats.
//
// Behaviours under test:
//   P-1  Organizer can pause a waiting player (is_paused → true)
//   P-2  Organizer can unpause a paused player (is_paused → false)
//   P-3  Pausing does NOT modify games_played or joined_at
//   P-4  Non-organizer (random player) is rejected with auth error
//   P-5  Unauthenticated caller is rejected
//   P-6  Invalid UUID arguments are rejected without a DB round-trip
//   P-7  Pausing a player not in the queue is a no-op (no error)
//   P-8  Pausing a 'playing' player succeeds (status unaffected)
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

vi.mock("@/app/actions/matchmaking", () => ({
  runEngineForSession: vi.fn().mockResolvedValue(undefined),
}));

import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { togglePlayerPause } from "@/app/actions/queue";
import { runEngineForSession } from "@/app/actions/matchmaking";

const faker = new Faker({ locale: [en] });
faker.seed(9001);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared helper ──────────────────────────────────────────────

async function pauseTestSetup() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const player = await makeProfile({ faker, skill: "intermediate" });
  const entry = await makeQueueEntry({ sessionId: session.id, playerId: player.id });

  return { organizer, session, player, entryId: entry.id };
}

// ─────────────────────────────────────────────────────────────

describe("togglePlayerPause — Suite P", () => {
  // ── P-1: Pause ───────────────────────────────────────────────

  it("P-1: organizer can pause a waiting player (is_paused → true)", async () => {
    const { organizer, session, player } = await pauseTestSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, player.id, true);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);

    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("is_paused")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    expect(entry?.is_paused).toBe(true);
  });

  // ── P-2: Unpause ─────────────────────────────────────────────

  it("P-2: organizer can unpause a paused player (is_paused → false)", async () => {
    const { organizer, session, player } = await pauseTestSetup();

    // First pause the player directly via service client (setup)
    await serviceClient()
      .from("queue_entries")
      .update({ is_paused: true })
      .eq("session_id", session.id)
      .eq("player_id", player.id);

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, player.id, false);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);

    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("is_paused")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    expect(entry?.is_paused).toBe(false);
  });

  // ── P-3: Queue position invariant ────────────────────────────

  it("P-3: pausing does NOT modify games_played or joined_at", async () => {
    const { organizer, session, player } = await pauseTestSetup();

    // Record baseline values before pause
    const { data: before } = await serviceClient()
      .from("queue_entries")
      .select("games_played, joined_at")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    expect(before).not.toBeNull();

    const restore = mockAuthAs(organizer.id);
    try {
      await togglePlayerPause(session.id, player.id, true);
    } finally {
      restore();
    }

    const { data: after } = await serviceClient()
      .from("queue_entries")
      .select("games_played, joined_at")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    // Neither field may change — queue position is fully preserved
    expect(after?.games_played).toBe(before!.games_played);
    expect(after?.joined_at).toBe(before!.joined_at);
  });

  // ── P-4: Non-organizer rejection ─────────────────────────────

  it("P-4: non-organizer player cannot pause another player", async () => {
    const { session, player } = await pauseTestSetup();
    // random_user has no organizer role for this session
    const randomUser = await makeProfile({ faker });

    const restore = mockAuthAs(randomUser.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, player.id, true);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/not authorized|organizer/i);

    // DB must be untouched
    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("is_paused")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    expect(entry?.is_paused).toBe(false);
  });

  // ── P-5: Unauthenticated rejection ───────────────────────────

  it("P-5: unauthenticated caller is rejected", async () => {
    const { session, player } = await pauseTestSetup();
    // No mockAuthAs — currentUserId is null

    const result = await togglePlayerPause(session.id, player.id, true);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
  });

  // ── P-6: UUID validation ──────────────────────────────────────

  it("P-6: invalid sessionId UUID is rejected without a DB round-trip", async () => {
    const { organizer, player } = await pauseTestSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause("not-a-uuid", player.id, true);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/invalid/i);
  });

  it("P-6b: invalid playerId UUID is rejected without a DB round-trip", async () => {
    const { organizer, session } = await pauseTestSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, "not-a-uuid", true);
    } finally {
      restore();
    }

    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/invalid/i);
  });

  // ── P-7: Player not in queue ──────────────────────────────────

  it("P-7: pausing a player not in the queue is a no-op success (no rows updated)", async () => {
    const { organizer, session } = await pauseTestSetup();
    // outsider has a profile but no queue_entries row for this session
    const outsider = await makeProfile({ faker });

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, outsider.id, true);
    } finally {
      restore();
    }

    // UPDATE with no matching rows is not an error — Postgres returns 0 rows
    // affected, Supabase returns no error. Action should succeed gracefully.
    expect(result!.success).toBe(true);
  });

  // ── P-9/P-10: Engine trigger ──────────────────────────────────

  beforeEach(() => {
    vi.mocked(runEngineForSession).mockClear();
  });

  // ── P-8: Pausing a 'playing' player ──────────────────────────

  it("P-8: organizer can pause a player whose queue status is 'playing' (status unaffected)", async () => {
    const { organizer, session, player } = await pauseTestSetup();

    // Simulate player currently in a match
    await serviceClient()
      .from("queue_entries")
      .update({ status: "playing" as const })
      .eq("session_id", session.id)
      .eq("player_id", player.id);

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, player.id, true);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);

    const { data: entry } = await serviceClient()
      .from("queue_entries")
      .select("is_paused, status")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    expect(entry?.is_paused).toBe(true);
    // Status must remain 'playing' — togglePlayerPause only touches is_paused
    expect(entry?.status).toBe("playing");
  });

  // ── P-9: Unpause triggers engine ─────────────────────────────

  it("P-9: unpausing a player (isPaused=false) calls runEngineForSession once", async () => {
    const { organizer, session, player } = await pauseTestSetup();

    // First pause the player directly via service client (setup)
    await serviceClient()
      .from("queue_entries")
      .update({ is_paused: true })
      .eq("session_id", session.id)
      .eq("player_id", player.id);

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, player.id, false);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);
    expect(runEngineForSession).toHaveBeenCalledOnce();
    expect(runEngineForSession).toHaveBeenCalledWith(session.id);
  });

  // ── P-10: Pause does NOT trigger engine ──────────────────────

  it("P-10: pausing a player (isPaused=true) does NOT call runEngineForSession", async () => {
    const { organizer, session, player } = await pauseTestSetup();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof togglePlayerPause>>;
    try {
      result = await togglePlayerPause(session.id, player.id, true);
    } finally {
      restore();
    }

    expect(result!.success).toBe(true);
    expect(runEngineForSession).not.toHaveBeenCalled();
  });
});
