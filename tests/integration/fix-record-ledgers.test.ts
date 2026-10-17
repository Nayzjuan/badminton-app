// ============================================================
// Suite FRL — post-completion corrections rebuild ledgers
// ============================================================
// Discriminators for 20261018000000 (Fix RPC) and the matching
// updateMatchDetails ledger refresh:
//
//   FRL-1  Team flip that creates new partnership pairs succeeds
//          (pre-fix: 42P10 from _fix_record_partnership_delta)
//          and partnership W/L matches match-history truth.
//   FRL-2  Score edit that flips the winner flips partnership W/L.
//   FRL-3  Revert removes the match from partnership truth.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeCompletedMatch, makeCourt } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { closeSession } from "@/app/actions/sessions";
import { updateMatchDetails } from "@/app/actions/match-lifecycle";

const faker = new Faker({ locale: [en] });
faker.seed(1018);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

async function makeFour() {
  return Promise.all([
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
  ]);
}

async function closeAs(sessionId: string, organizerId: string) {
  const restore = mockAuthAs(organizerId);
  try {
    return await closeSession(sessionId);
  } finally {
    restore();
  }
}

async function readPartnership(playerId: string, partnerId: string) {
  const { data } = await serviceClient()
    .from("player_partnerships")
    .select("games_together, wins_together, losses_together")
    .eq("player_id", playerId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  return data;
}

async function readMatchTeams(matchId: string) {
  const { data } = await serviceClient()
    .from("match_players")
    .select("player_id, team")
    .eq("match_id", matchId);
  return data ?? [];
}

describe("post-completion ledger rebuild — Suite FRL", () => {
  // ── FRL-1 ──────────────────────────────────────────────────
  it("FRL-1: team flip succeeds and partnership ledger matches the new roster", async () => {
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4] = await makeFour();
    const session = await makeSession({ faker, organizer: organizer.id });

    // Team A (p1,p2) beat Team B (p3,p4). Flip p2 ↔ p3 so the new pairs are
    // p1+p3 (win) and p2+p4 (loss) — pairs that did not exist before the flip.
    const match = await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
    });

    await closeAs(session.id, organizer.id);

    expect(await readPartnership(p1.id, p2.id)).toEqual({
      games_together: 1,
      wins_together: 1,
      losses_together: 0,
    });
    expect(await readPartnership(p3.id, p4.id)).toEqual({
      games_together: 1,
      wins_together: 0,
      losses_together: 1,
    });
    expect(await readPartnership(p1.id, p3.id)).toBeNull();
    expect(await readPartnership(p2.id, p4.id)).toBeNull();

    const { error } = await serviceClient().rpc("fix_record_swap_player", {
      p_match_id: match.id,
      p_out_player_id: p2.id,
      p_in_player_id: p3.id,
      p_session_id: session.id,
      p_actor_id: organizer.id,
      p_actor_name: "organizer",
    });
    expect(error).toBeNull();

    const teams = await readMatchTeams(match.id);
    const byPlayer = Object.fromEntries(teams.map((r) => [r.player_id, r.team]));
    expect(byPlayer[p1.id]).toBe("a");
    expect(byPlayer[p3.id]).toBe("a");
    expect(byPlayer[p2.id]).toBe("b");
    expect(byPlayer[p4.id]).toBe("b");

    // Old pairs gone; new pairs carry the (unchanged) score outcome.
    expect(await readPartnership(p1.id, p2.id)).toBeNull();
    expect(await readPartnership(p3.id, p4.id)).toBeNull();
    expect(await readPartnership(p1.id, p3.id)).toEqual({
      games_together: 1,
      wins_together: 1,
      losses_together: 0,
    });
    expect(await readPartnership(p2.id, p4.id)).toEqual({
      games_together: 1,
      wins_together: 0,
      losses_together: 1,
    });
  });

  // ── FRL-2 ──────────────────────────────────────────────────
  it("FRL-2: score edit that flips the winner flips partnership W/L", async () => {
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4] = await makeFour();
    const session = await makeSession({ faker, organizer: organizer.id });

    const match = await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
    });
    await closeAs(session.id, organizer.id);

    expect(await readPartnership(p1.id, p2.id)).toEqual({
      games_together: 1,
      wins_together: 1,
      losses_together: 0,
    });
    expect(await readPartnership(p3.id, p4.id)).toEqual({
      games_together: 1,
      wins_together: 0,
      losses_together: 1,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await updateMatchDetails(match.id, 15, 21);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    expect(await readPartnership(p1.id, p2.id)).toEqual({
      games_together: 1,
      wins_together: 0,
      losses_together: 1,
    });
    expect(await readPartnership(p3.id, p4.id)).toEqual({
      games_together: 1,
      wins_together: 1,
      losses_together: 0,
    });
  });

  // ── FRL-3 ──────────────────────────────────────────────────
  it("FRL-3: revert removes the match from partnership truth", async () => {
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4] = await makeFour();
    const session = await makeSession({ faker, organizer: organizer.id });
    const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

    const match = await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
      courtId: court.id,
    });

    // Seed ledgers without closing — revert needs an active court/session path.
    const { error: seedErr } = await serviceClient().rpc("refresh_cross_session_stats", {
      p_session_id: session.id,
    });
    expect(seedErr).toBeNull();
    expect(await readPartnership(p1.id, p2.id)).not.toBeNull();

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await updateMatchDetails(match.id, 0, 0, true);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    const { data: m } = await serviceClient()
      .from("matches")
      .select("status, team_a_score, team_b_score")
      .eq("id", match.id)
      .single();
    expect(m?.status).toBe("in_progress");
    expect(m?.team_a_score).toBeNull();
    expect(m?.team_b_score).toBeNull();

    // Match is no longer completed → absolute rebuild drops the partnership.
    expect(await readPartnership(p1.id, p2.id)).toBeNull();
    expect(await readPartnership(p3.id, p4.id)).toBeNull();
  });
});
