// ============================================================
// Suite ET — Engine Trigger (Real DB)
// ============================================================
// Verifies that the matchmaking engine actually creates draft
// matches when triggered by endMatchAction and clearOnDeckMatch
// with is_auto_matchmaking_on=true.
//
// These are REAL DB integration tests — runEngineForSession is
// NOT mocked.  The engine reads from v_queue_with_wait_time and
// inserts rows into matches + match_players via create_match_with_players.
//
// Tests:
//   ET-1  endMatchAction + auto ON → engine creates a draft
//   ET-2  clearOnDeckMatch + auto ON → engine refills the draft
//   ET-3  clearOnDeckMatch + auto OFF → engine does NOT create a draft
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach, beforeEach } from "vitest";
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
import { endMatchAction } from "@/app/actions/match-lifecycle";
import { clearOnDeckMatch } from "@/app/actions/match-drafts";

// Faker instance shared across helpers — seed is reset per-test in beforeEach
// so each test gets a fully deterministic, order-independent stream regardless
// of how many tests are added or reordered within this file.
const faker = new Faker({ locale: [en] });

beforeEach(() => {
  faker.seed(2025);
});

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ─────────────────────────────────────────────────────────────

describe("Engine Trigger (Real DB) — Suite ET", () => {
  // ── ET-1: endMatchAction + auto ON → draft created ─────────

  it("ET-1: endMatchAction with auto=ON creates a new draft match from waiting players", async () => {
    // ── Setup ──────────────────────────────────────────────────
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4, p5, p6, p7, p8] = await Promise.all([
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
    ]);

    const session = await makeSession({ faker, organizer: organizer.id });
    await enableAutoMatchmaking(session.id);

    const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

    // Set court to in_use (it's occupied by the in-progress match)
    await serviceClient()
      .from("courts")
      .update({ status: "in_use" as const })
      .eq("id", court.id);

    // Create an in-progress, published match on the court with p1-p4
    const match = await makeMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      courtId: court.id,
      status: "in_progress",
      isPublished: true,
    });

    // Put p1-p4 in queue as "playing"
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id, status: "playing" }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id, status: "playing" }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id, status: "playing" }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id, status: "playing" }),
    ]);

    // Put p5-p8 in queue as "waiting" — the engine will draft them
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p5.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p6.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p7.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p8.id, status: "waiting" }),
    ]);

    // ── Action ─────────────────────────────────────────────────
    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof endMatchAction>>;
    try {
      result = await endMatchAction(match.id, 21, 15);
    } finally {
      restore();
    }

    // ── Assert ─────────────────────────────────────────────────
    expect(result!.success).toBe(true);

    // After endMatchAction, p1-p4 transition from "playing" → "waiting" and
    // the engine sees 8 waiting players (p1-p4 restored + p5-p8 already waiting).
    // Pool diversity cap (estimatedWaiting=4 < 8 at slot 2) limits output to 1 draft.
    // Assertion: >= 1 (allows 1 or 2 drafts if cap tier changes).
    const { data: draftMatches, error } = await serviceClient()
      .from("matches")
      .select("id, status, is_published")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false);

    expect(error).toBeNull();
    expect(draftMatches).not.toBeNull();
    expect(draftMatches!.length).toBeGreaterThanOrEqual(1);
  });

  // ── ET-2: clearOnDeckMatch + auto ON → draft refills ───────

  it("ET-2: clearOnDeckMatch with auto=ON creates a new draft after clearing the existing one", async () => {
    // ── Setup ──────────────────────────────────────────────────
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4, p5, p6, p7, p8] = await Promise.all([
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
    ]);

    const session = await makeSession({ faker, organizer: organizer.id });
    await enableAutoMatchmaking(session.id);

    await makeCourt({ sessionId: session.id, name: "Court 1" });

    // Create queue entries for p1-p4 as "waiting" so makeMatchViaRpc can draft them
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id, status: "waiting" }),
    ]);

    // Create a draft match with p1-p4 via RPC — this transitions them to "drafted"
    const draft = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: false,
    });

    // Put p5-p8 in queue as "waiting"
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p5.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p6.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p7.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p8.id, status: "waiting" }),
    ]);

    // ── Action ─────────────────────────────────────────────────
    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof clearOnDeckMatch>>;
    try {
      result = await clearOnDeckMatch(draft.id);
    } finally {
      restore();
    }

    // ── Assert ─────────────────────────────────────────────────
    expect(result!.success).toBe(true);

    // After clearing, p1-p4 are restored to "waiting" by clearOnDeckMatch; combined
    // with p5-p8 (already waiting) the engine sees 8 players and creates a new draft.
    //
    // The clearOnDeckMatch action deletes the original draft row, so .neq("id", draft.id)
    // is technically redundant (the deleted row cannot be returned). It is kept as a
    // belt-and-suspenders guard: if the clear RPC failed silently we'd still exclude the
    // old cancelled match from the "new draft" count, making the failure visible via
    // the > 0 assertion rather than a false positive.
    const { data: newDrafts, error } = await serviceClient()
      .from("matches")
      .select("id, status, is_published")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false)
      .neq("id", draft.id);

    expect(error).toBeNull();
    expect(newDrafts).not.toBeNull();
    expect(newDrafts!.length).toBeGreaterThanOrEqual(1);
  });

  // ── ET-3: auto OFF → engine does NOT create draft ──────────

  it("ET-3: clearOnDeckMatch with auto=OFF does NOT create a new draft", async () => {
    // ── Setup ──────────────────────────────────────────────────
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4, p5, p6, p7, p8] = await Promise.all([
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
      makeProfile({ faker, skill: "intermediate" }),
    ]);

    // Intentionally do NOT call enableAutoMatchmaking — auto stays OFF
    const session = await makeSession({ faker, organizer: organizer.id });

    await makeCourt({ sessionId: session.id, name: "Court 1" });

    // Create queue entries for p1-p4 as "waiting" so makeMatchViaRpc can draft them
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id, status: "waiting" }),
    ]);

    // Create a draft match with p1-p4 via RPC — this transitions them to "drafted"
    const draft = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: false,
    });

    // Put p5-p8 in queue as "waiting"
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p5.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p6.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p7.id, status: "waiting" }),
      makeQueueEntry({ sessionId: session.id, playerId: p8.id, status: "waiting" }),
    ]);

    // ── Action ─────────────────────────────────────────────────
    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof clearOnDeckMatch>>;
    try {
      result = await clearOnDeckMatch(draft.id);
    } finally {
      restore();
    }

    // ── Assert ─────────────────────────────────────────────────
    expect(result!.success).toBe(true);

    // With auto=OFF the engine short-circuits on the toggle check — no new draft.
    // .neq("id", draft.id) is redundant (the cleared draft row is deleted) but kept
    // defensively so any leaked cancelled row cannot mask a missing-new-draft failure.
    const { data: newDrafts, error } = await serviceClient()
      .from("matches")
      .select("id, status, is_published")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false)
      .neq("id", draft.id);

    expect(error).toBeNull();
    // No new pending drafts should have been created
    expect(newDrafts!.length).toBe(0);
  });
});
