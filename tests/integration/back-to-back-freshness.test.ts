// ============================================================
// Back-to-back freshness — real DB integration
// ============================================================
// Intent: runEngineForSession derives last-game maps from the snapshot
// and the wrapper produces a fresh four when an alternative exists,
// without stalling when it does not. Kill switch restores today.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import {
  makeProfile,
  makeSession,
  makeQueueEntry,
  makeCourt,
  makeCompletedMatch,
  enableAutoMatchmaking,
  ageQueueEntry,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { runEngineForSession } from "@/app/actions/matchmaking";
import type { SkillLevel } from "@/types/database";

const faker = new Faker({ locale: [en] });
faker.seed(4040);

afterEach(async () => {
  await truncateTracked();
  delete process.env.MATCHMAKING_FRESHNESS_REFRESH;
});

async function setupSession() {
  const organizer = await makeProfile({ faker, skill: "intermediate" });
  const session = await makeSession({ faker, organizer: organizer.id });
  await enableAutoMatchmaking(session.id);
  await makeCourt({ sessionId: session.id, name: "Court 1" });
  return { organizer, session };
}

async function player(skill: SkillLevel) {
  return makeProfile({ faker, skill });
}

async function waiters(
  sessionId: string,
  people: { id: string; minutes: number; games?: number }[]
) {
  const entries = [];
  for (const p of people) {
    const entry = await makeQueueEntry({ sessionId, playerId: p.id });
    await ageQueueEntry(entry.id, p.minutes);
    if (p.games != null) {
      const { error } = await serviceClient()
        .from("queue_entries")
        .update({ games_played: p.games })
        .eq("id", entry.id);
      if (error) throw new Error(error.message);
    }
    entries.push(entry);
  }
  return entries;
}

async function completed(
  sessionId: string,
  teamA: [string, string],
  teamB: [string, string],
  minutesAgo: number
) {
  return makeCompletedMatch({
    sessionId,
    teamA,
    teamB,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
}

async function firstPendingRoster(sessionId: string): Promise<string[]> {
  const { data: matches } = await serviceClient()
    .from("matches")
    .select("id, created_at, status")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  expect(matches && matches.length).toBeGreaterThan(0);
  const { data: rows } = await serviceClient()
    .from("match_players")
    .select("player_id")
    .eq("match_id", matches![0].id);
  return (rows ?? []).map((r) => r.player_id);
}

describe("I-1 lookback-gap Oct 3 shape", () => {
  it("drafts a fresh four when the previous near-identical game sits past the lookback", async () => {
    const { session } = await setupSession();
    const dom = await player("lower_intermediate");
    const pat = await player("beginner");
    const nic = await player("beginner");
    const ram = await player("beginner");
    const luis = await player("intermediate");
    const fillers = await Promise.all(Array.from({ length: 12 }, () => player("advanced")));

    await completed(session.id, [pat.id, nic.id], [ram.id, fillers[0].id], 80);
    await completed(session.id, [fillers[1].id, fillers[2].id], [fillers[3].id, fillers[4].id], 50);
    await completed(session.id, [fillers[5].id, fillers[6].id], [fillers[7].id, fillers[8].id], 30);
    await completed(
      session.id,
      [fillers[9].id, fillers[10].id],
      [fillers[11].id, fillers[0].id],
      10
    );

    await waiters(session.id, [
      { id: dom.id, minutes: 14, games: 3 },
      { id: pat.id, minutes: 12, games: 3 },
      { id: nic.id, minutes: 12, games: 3 },
      { id: ram.id, minutes: 12, games: 3 },
      { id: luis.id, minutes: 8, games: 3 },
    ]);

    await runEngineForSession(session.id);
    const roster = await firstPendingRoster(session.id);
    const stale = new Set([pat.id, nic.id, ram.id]);
    expect(roster).toContain(dom.id);
    expect(roster.filter((id) => stale.has(id)).length).toBeLessThanOrEqual(2);
    expect(roster).toContain(luis.id);
  });
});

describe("I-2 thin band fail-open", () => {
  it("still drafts when no fresher four exists", async () => {
    const { session } = await setupSession();
    const a = await player("beginner");
    const b = await player("beginner");
    const c = await player("beginner");
    const d = await player("beginner");
    const fillers = await Promise.all(Array.from({ length: 8 }, () => player("advanced")));

    await completed(session.id, [a.id, b.id], [c.id, d.id], 80);
    await completed(session.id, [fillers[0].id, fillers[1].id], [fillers[2].id, fillers[3].id], 40);
    await completed(session.id, [fillers[4].id, fillers[5].id], [fillers[6].id, fillers[7].id], 10);

    await waiters(session.id, [
      { id: a.id, minutes: 14, games: 2 },
      { id: b.id, minutes: 12, games: 2 },
      { id: c.id, minutes: 12, games: 2 },
      { id: d.id, minutes: 12, games: 2 },
    ]);

    await runEngineForSession(session.id);
    const roster = await firstPendingRoster(session.id);
    expect(roster.length).toBe(4);
    expect(new Set(roster)).toEqual(new Set([a.id, b.id, c.id, d.id]));
  });
});

describe("I-3 / I-4 sibling draft is last game for the next slot", () => {
  it("the second draft in a burst shares ≤2 players with the first", async () => {
    const { session } = await setupSession();
    const people = await Promise.all(Array.from({ length: 12 }, () => player("intermediate")));
    await waiters(
      session.id,
      people.map((p, i) => ({ id: p.id, minutes: 16 - i, games: 1 }))
    );

    await runEngineForSession(session.id);
    const { data: pending } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    expect((pending ?? []).length).toBeGreaterThan(1);

    const { data: first } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", pending![0].id);
    const { data: second } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", pending![1].id);
    const firstIds = new Set((first ?? []).map((r) => r.player_id));
    const secondIds = (second ?? []).map((r) => r.player_id);
    expect(secondIds.filter((id) => firstIds.has(id)).length).toBeLessThanOrEqual(2);
  });
});

describe("I-6 kill switch", () => {
  it("MATCHMAKING_FRESHNESS_REFRESH=false serves today's near-identical four", async () => {
    process.env.MATCHMAKING_FRESHNESS_REFRESH = "false";
    const { session } = await setupSession();
    const dom = await player("lower_intermediate");
    const pat = await player("beginner");
    const nic = await player("beginner");
    const ram = await player("beginner");
    const luis = await player("intermediate");
    const fillers = await Promise.all(Array.from({ length: 12 }, () => player("advanced")));

    await completed(session.id, [pat.id, nic.id], [ram.id, fillers[0].id], 80);
    await completed(session.id, [fillers[1].id, fillers[2].id], [fillers[3].id, fillers[4].id], 50);
    await completed(session.id, [fillers[5].id, fillers[6].id], [fillers[7].id, fillers[8].id], 30);
    await completed(
      session.id,
      [fillers[9].id, fillers[10].id],
      [fillers[11].id, fillers[0].id],
      10
    );

    await waiters(session.id, [
      { id: dom.id, minutes: 14, games: 3 },
      { id: pat.id, minutes: 12, games: 3 },
      { id: nic.id, minutes: 12, games: 3 },
      { id: ram.id, minutes: 12, games: 3 },
      { id: luis.id, minutes: 8, games: 3 },
    ]);

    await runEngineForSession(session.id);
    const roster = await firstPendingRoster(session.id);
    expect(new Set(roster)).toEqual(new Set([dom.id, pat.id, nic.id, ram.id]));
    expect(roster).not.toContain(luis.id);
  });
});
