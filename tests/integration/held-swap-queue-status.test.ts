// ============================================================
// Held-draft roster edits must not stick a player in the wrong
// queue_status. Prod 2026-09-19: Darwin (pulled body) was bench-swapped
// off a hold, unseated to 'waiting' mid-game, then re-reserved 'drafted'
// by R3-1 from a stale pulled_player_ids pointer.
//
// These tests drive the real RPCs + server actions against local
// Supabase. queue_status_after_roster_change is the derivation;
// recomputeHeldReadiness N-2 / N-2b is the hold-pointer cleanup.
//
//   HS-1  Darwin path: bench-swap the body off a hold, then end the
//         source court → body stays playing through the swap, waiting
//         after the source ends, never drafted
//   HS-2  waiter swap on a hold: outgoing waiter → waiting, incoming
//         → drafted, body stays playing, hold stays held
//   HS-3  cancel the hold after the body was swapped off it → body
//         still playing
//   HS-4  tap-swap of a still-playing body is PLAYER_UNAVAILABLE
//   HS-5  draft↔published tap-swap: status follows the destination
//   HS-6  live fill into an unpublished pending match → fill is drafted
//   HS-8  live-swap undo of a player who has since been drafted must
//         raise PLAYER_UNAVAILABLE (do not double-book court + draft)
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
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { cancelMatchAction, endMatchAction } from "@/app/actions/match-lifecycle";
import { recomputeHeldReadiness } from "@/app/actions/matchmaking";
import { swapMatchPlayers, swapPlayerInMatch } from "@/app/actions/swap-player";

const faker = new Faker({ locale: [en] });

beforeEach(() => {
  faker.seed(20260920);
});

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

async function makePlayers(n: number) {
  return Promise.all(
    Array.from({ length: n }, () => makeProfile({ faker, skill: "intermediate" }))
  );
}

async function startMatch(matchId: string, minutesAgo: number): Promise<void> {
  const { error } = await serviceClient()
    .from("matches")
    .update({ started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
    .eq("id", matchId);
  if (error) throw new Error(`[startMatch] ${error.message}`);
}

async function queueStatus(sessionId: string, playerId: string) {
  const { data, error } = await serviceClient()
    .from("queue_entries")
    .select("status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .single();
  if (error) throw new Error(`[queueStatus] ${error.message}`);
  return data.status;
}

async function seedHeldDraft() {
  const organizer = await makeProfile({ faker });
  const [m1, m2, m3] = await makePlayers(3);
  const [b1, b2, b3, b4] = await makePlayers(4);
  const jay = await makeProfile({ faker, skill: "intermediate" });

  const session = await makeSession({ faker, organizer: organizer.id });
  const court1 = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });

  await Promise.all([
    ...[m1, m2, m3, jay].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
    ...[b1, b2, b3, b4].map((p) =>
      makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
    ),
  ]);

  const sourceMatch = await makeMatch({
    sessionId: session.id,
    teamA: [b1.id, b2.id],
    teamB: [b3.id, b4.id],
    courtId: court1.id,
    status: "in_progress",
    isPublished: true,
  });
  await startMatch(sourceMatch.id, 4);

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
    throw new Error(`[seedHeldDraft] RPC returned ${heldId} — ${error?.message ?? "guard fired"}`);
  }

  return {
    organizer,
    session,
    members: [m1, m2, m3],
    body: b1,
    jay,
    sourceMatch,
    heldId: heldId as string,
  };
}

describe("HS-1: Darwin path — bench-swap the pulled body, then end the source", () => {
  it("keeps the body playing through the swap and waiting after the source ends — never drafted", async () => {
    const { organizer, session, body, jay, sourceMatch, heldId } = await seedHeldDraft();

    const restore = mockAuthAs(organizer.id);
    try {
      const swap = await swapPlayerInMatch(heldId, body.id, jay.id);
      expect(swap.success).toBe(true);
      expect(swap.undoable).toBe(false);

      expect(await queueStatus(session.id, body.id)).toBe("playing");
      expect(await queueStatus(session.id, jay.id)).toBe("drafted");

      const { data: hold } = await serviceClient()
        .from("matches")
        .select("is_held, pulled_player_ids")
        .eq("id", heldId)
        .single();
      expect(hold?.is_held).toBe(false);
      expect(hold?.pulled_player_ids).toEqual([]);

      const ended = await endMatchAction(sourceMatch.id, 21, 17);
      expect(ended.success).toBe(true);

      expect(await queueStatus(session.id, body.id)).toBe("waiting");
    } finally {
      restore();
    }
  });
});

describe("HS-2: waiter swap on a hold", () => {
  it("returns the waiter to waiting, drafts the incoming, leaves the body playing and the hold held", async () => {
    const { organizer, session, members, body, jay, heldId } = await seedHeldDraft();
    const waiter = members[0];

    const restore = mockAuthAs(organizer.id);
    try {
      const swap = await swapPlayerInMatch(heldId, waiter.id, jay.id);
      expect(swap.success).toBe(true);
      expect(swap.undoable).toBe(true);

      expect(await queueStatus(session.id, waiter.id)).toBe("waiting");
      expect(await queueStatus(session.id, jay.id)).toBe("drafted");
      expect(await queueStatus(session.id, body.id)).toBe("playing");

      const { data: hold } = await serviceClient()
        .from("matches")
        .select("is_held")
        .eq("id", heldId)
        .single();
      expect(hold?.is_held).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("HS-3: cancel the hold after the body was swapped off it", () => {
  it("leaves the still-playing body at playing", async () => {
    const { organizer, session, body, jay, heldId } = await seedHeldDraft();

    const restore = mockAuthAs(organizer.id);
    try {
      const swap = await swapPlayerInMatch(heldId, body.id, jay.id);
      expect(swap.success).toBe(true);

      const cancelled = await cancelMatchAction(heldId);
      expect(cancelled.success).toBe(true);

      expect(await queueStatus(session.id, body.id)).toBe("playing");
      expect(await queueStatus(session.id, jay.id)).toBe("waiting");
    } finally {
      restore();
    }
  });
});

describe("HS-4: tap-swap of a still-playing body", () => {
  it("rejects with PLAYER_UNAVAILABLE", async () => {
    const { organizer, session, body, heldId } = await seedHeldDraft();
    const extras = await makePlayers(4);
    await Promise.all(extras.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })));
    const other = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [extras[0].id, extras[1].id],
      teamB: [extras[2].id, extras[3].id],
      isPublished: false,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapMatchPlayers(heldId, body.id, other.id, extras[0].id, session.id);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PLAYER_UNAVAILABLE");
      expect(await queueStatus(session.id, body.id)).toBe("playing");
    } finally {
      restore();
    }
  });
});

describe("HS-5: draft↔published tap-swap — status follows the destination", () => {
  it("moves drafted onto a published match as on_deck and on_deck onto a draft as drafted", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const players = await makePlayers(8);
    await Promise.all(
      players.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );

    const draft = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: false,
    });
    const published = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[4].id, players[5].id],
      teamB: [players[6].id, players[7].id],
      isPublished: true,
    });

    expect(await queueStatus(session.id, players[0].id)).toBe("drafted");
    expect(await queueStatus(session.id, players[4].id)).toBe("on_deck");

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapMatchPlayers(
        draft.id,
        players[0].id,
        published.id,
        players[4].id,
        session.id
      );
      expect(result.success).toBe(true);

      expect(await queueStatus(session.id, players[0].id)).toBe("on_deck");
      expect(await queueStatus(session.id, players[4].id)).toBe("drafted");
    } finally {
      restore();
    }
  });
});

describe("HS-6: live fill into an unpublished pending match", () => {
  it("sets the fill player to drafted, not on_deck", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const court = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });
    const [a1, a2, b1, b2] = await makePlayers(4);
    const [od, extra, odB1, odB2] = await makePlayers(4);
    const fill = await makeProfile({ faker, skill: "intermediate" });

    await Promise.all([
      ...[a1, a2, b1, b2].map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
      ),
      ...[od, extra, odB1, odB2].map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "drafted" })
      ),
      makeQueueEntry({ sessionId: session.id, playerId: fill.id, status: "waiting" }),
    ]);

    const live = await makeMatch({
      sessionId: session.id,
      teamA: [a1.id, a2.id],
      teamB: [b1.id, b2.id],
      courtId: court.id,
      status: "in_progress",
      isPublished: true,
    });
    const unpublished = await makeMatch({
      sessionId: session.id,
      teamA: [od.id, extra.id],
      teamB: [odB1.id, odB2.id],
      status: "pending",
      isPublished: false,
    });

    const { error } = await serviceClient().rpc("swap_active_from_ondeck", {
      p_active_match_id: live.id,
      p_out_player_id: a1.id,
      p_ondeck_player_id: od.id,
      p_ondeck_match_id: unpublished.id,
      p_fill_player_id: fill.id,
      p_session_id: session.id,
    });
    expect(error).toBeNull();

    expect(await queueStatus(session.id, fill.id)).toBe("drafted");
    expect(await queueStatus(session.id, a1.id)).toBe("waiting");
    expect(await queueStatus(session.id, od.id)).toBe("playing");
  });
});

describe("HS-7: live-swap the body off its source court", () => {
  it("drafts the body on the hold, then N-2b downgrades the hold", async () => {
    const { session, body, sourceMatch, heldId } = await seedHeldDraft();
    const replacement = await makeProfile({ faker, skill: "intermediate" });
    await makeQueueEntry({ sessionId: session.id, playerId: replacement.id, status: "waiting" });

    const { error } = await serviceClient().rpc("swap_player_in_active_match", {
      p_match_id: sourceMatch.id,
      p_out_player_id: body.id,
      p_in_player_id: replacement.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(error).toBeNull();

    expect(await queueStatus(session.id, body.id)).toBe("drafted");
    expect(await queueStatus(session.id, replacement.id)).toBe("playing");

    await recomputeHeldReadiness(serviceClient(), session.id);

    const { data: hold } = await serviceClient()
      .from("matches")
      .select("is_held, pulled_player_ids")
      .eq("id", heldId)
      .single();
    expect(hold?.is_held).toBe(false);
    expect(hold?.pulled_player_ids).toEqual([]);
    expect(await queueStatus(session.id, body.id)).toBe("drafted");
  });
});

describe("HS-8: live-swap undo refuses a drafted incoming player", () => {
  it("raises PLAYER_UNAVAILABLE instead of seating them on court and a pending draft at once", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const court = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });
    const [a1, a2, b1, b2] = await makePlayers(4);
    const replacement = await makeProfile({ faker, skill: "intermediate" });
    const extras = await makePlayers(3);

    await Promise.all([
      ...[a1, a2, b1, b2].map((p) =>
        makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "playing" })
      ),
      makeQueueEntry({ sessionId: session.id, playerId: replacement.id, status: "waiting" }),
      ...extras.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })),
    ]);

    const live = await makeMatch({
      sessionId: session.id,
      teamA: [a1.id, a2.id],
      teamB: [b1.id, b2.id],
      courtId: court.id,
      status: "in_progress",
      isPublished: true,
    });

    const { error: swapErr } = await serviceClient().rpc("swap_player_in_active_match", {
      p_match_id: live.id,
      p_out_player_id: a1.id,
      p_in_player_id: replacement.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(swapErr).toBeNull();
    expect(await queueStatus(session.id, a1.id)).toBe("waiting");

    await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [a1.id, extras[0].id],
      teamB: [extras[1].id, extras[2].id],
      isPublished: false,
    });
    expect(await queueStatus(session.id, a1.id)).toBe("drafted");

    const { error: undoErr } = await serviceClient().rpc("swap_player_in_active_match", {
      p_match_id: live.id,
      p_out_player_id: replacement.id,
      p_in_player_id: a1.id,
      p_session_id: session.id,
      p_team: "a",
      p_is_undo: true,
    });
    expect(undoErr?.message).toContain("PLAYER_UNAVAILABLE");
    expect(await queueStatus(session.id, a1.id)).toBe("drafted");
    expect(await queueStatus(session.id, replacement.id)).toBe("playing");
  });
});
