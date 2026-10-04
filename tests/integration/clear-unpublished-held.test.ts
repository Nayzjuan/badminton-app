// ============================================================
// Clear unpublished — held drafts survive (real RPC seed)
// ============================================================
// The hold must come from create_held_cross_court_match. Hand-setting
// is_held / held_ready_at does not test the writer that production uses.
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
import { flushAfterCallbacks } from "./helpers/after-queue";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { clearUnpublishedDraftsAction } from "@/app/actions/match-drafts";

const faker = new Faker({ locale: [en] });

beforeEach(() => {
  faker.seed(2025);
});

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

async function seedHeldAndUnpublished() {
  const organizer = await makeProfile({ faker });
  const [m1, m2, m3, b1, b2, b3, b4, d1, d2, d3, d4] = await Promise.all(
    Array.from({ length: 11 }, () => makeProfile({ faker }))
  );

  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });

  await Promise.all([
    ...[m1, m2, m3].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
    ...[b1, b2, b3, b4].map((p) =>
      makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
    ),
    ...[d1, d2, d3, d4].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
  ]);

  const sourceMatch = await makeMatch({
    sessionId: session.id,
    teamA: [b1.id, b2.id],
    teamB: [b3.id, b4.id],
    courtId: court.id,
    status: "in_progress",
    isPublished: true,
  });
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
    throw new Error(`[held seed] RPC returned ${heldId} — ${error?.message ?? "guard fired"}`);
  }

  const unpublished = await makeMatchViaRpc({
    sessionId: session.id,
    teamA: [d1.id, d2.id],
    teamB: [d3.id, d4.id],
    isPublished: false,
  });

  return { organizer, session, heldId: heldId as string, unpublishedId: unpublished.id };
}

describe("clearUnpublishedDraftsAction — held skip", () => {
  it("CUD-H1: Auto OFF clears unpublished drafts and leaves the RPC-seeded hold", async () => {
    const { organizer, session, heldId, unpublishedId } = await seedHeldAndUnpublished();

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof clearUnpublishedDraftsAction>>;
    try {
      result = await clearUnpublishedDraftsAction(session.id);
    } finally {
      restore();
    }

    expect(result.success).toBe(true);
    await flushAfterCallbacks();

    const { data: remaining } = await serviceClient()
      .from("matches")
      .select("id, is_held, status")
      .eq("session_id", session.id)
      .eq("status", "pending");
    const ids = remaining?.map((m) => m.id) ?? [];
    expect(ids).toContain(heldId);
    expect(ids).not.toContain(unpublishedId);
    expect(remaining?.find((m) => m.id === heldId)?.is_held).toBe(true);
  });

  it("CUD-H2: Auto ON may refill after drain; the RPC-seeded hold still remains", async () => {
    const { organizer, session, heldId, unpublishedId } = await seedHeldAndUnpublished();
    await enableAutoMatchmaking(session.id);

    const refill = await Promise.all(Array.from({ length: 4 }, () => makeProfile({ faker })));
    await Promise.all(
      refill.map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "waiting" })
      )
    );

    const restore = mockAuthAs(organizer.id);
    let result: Awaited<ReturnType<typeof clearUnpublishedDraftsAction>>;
    try {
      result = await clearUnpublishedDraftsAction(session.id);
    } finally {
      restore();
    }

    expect(result.success).toBe(true);
    await flushAfterCallbacks();

    const { data: remaining } = await serviceClient()
      .from("matches")
      .select("id, is_held, status, is_published")
      .eq("session_id", session.id)
      .eq("status", "pending");
    const ids = remaining?.map((m) => m.id) ?? [];
    expect(ids).toContain(heldId);
    expect(ids).not.toContain(unpublishedId);
    expect(remaining?.find((m) => m.id === heldId)?.is_held).toBe(true);
  });
});
