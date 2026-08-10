// ============================================================
// Suite A — Matchmaking Engine Integration Tests (Phase 2)
// ============================================================
// Tests the matchmaking engine behaviour via two public entry points:
//   • runEngineForSession(sessionId) — used for most engine tests;
//     requires is_auto_matchmaking_on = true
//   • callNextMatch(sessionId, courtId) — used for promotion tests;
//     requires mockAuthAs(organizerId)
//
// The engine (runEngineInternal) is private, so we test it
// indirectly by seeding DB state and asserting the resulting
// matches / queue entries after a runEngineForSession call.
//
// Isolation: Layer B — truncateTracked() in afterEach wipes all
// domain tables and deletes auth.users created by makeProfile().
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import {
  makeProfile,
  makeSession,
  makeQueueEntry,
  makeCourt,
  makeMatch,
  makeCompletedMatch,
  enableAutoMatchmaking,
  ageQueueEntry,
} from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs } from "./helpers/mock-auth";
import { runEngineForSession, callNextMatch } from "@/app/actions/matchmaking";
import { MAX_AUTO_DRAFTS, MAX_PARTNERSHIP_REPEATS, CRITICAL_WAIT_MINUTES } from "@/lib/constants";

const faker = new Faker({ locale: [en] });
faker.seed(2001);

afterEach(async () => {
  await truncateTracked();
});

// ── Shared setup helpers ───────────────────────────────────────

/** Creates organizer + session with auto-matchmaking ON + 1 court. */
async function baseSetup(opts: { skillLevel?: Parameters<typeof makeProfile>[0]["skill"] } = {}) {
  const organizer = await makeProfile({ faker, skill: opts.skillLevel ?? "intermediate" });
  const session = await makeSession({ faker, organizer: organizer.id });
  await enableAutoMatchmaking(session.id);
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });
  return { organizer, session, court };
}

/** Creates N players and adds them to the queue for a session. */
async function seedPlayers(
  sessionId: string,
  n: number,
  skill: Parameters<typeof makeProfile>[0]["skill"] = "intermediate"
) {
  const players = await Promise.all(Array.from({ length: n }, () => makeProfile({ faker, skill })));
  const entries = await Promise.all(
    players.map((p) => makeQueueEntry({ sessionId, playerId: p.id }))
  );
  return { players, entries };
}

// ─────────────────────────────────────────────────────────────

describe("Matchmaking Engine — Suite A", () => {
  // ── Test 1: Draft mode ────────────────────────────────────

  it("engine creates matches with is_published=false (draft mode)", async () => {
    const { session } = await baseSetup();
    await seedPlayers(session.id, 8);

    await runEngineForSession(session.id);

    const { data: matches } = await serviceClient()
      .from("matches")
      .select("id, is_published, status")
      .eq("session_id", session.id);

    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(1);

    for (const m of matches!) {
      expect(m.is_published).toBe(false);
      expect(m.status).toBe("pending");
    }
  });

  // ── Test 2: Draft mode — drafted players get 'drafted' status ──

  it("players in an unpublished draft get 'drafted' status; others stay 'waiting'", async () => {
    const { session } = await baseSetup();
    const { players } = await seedPlayers(session.id, 8);

    await runEngineForSession(session.id);

    // The engine creates exactly 1 draft (pool diversity cap stops it at 4 players
    // committed). The RPC sets those 4 to 'drafted'; the other 4 stay 'waiting'.
    //
    // Migration 20260511000000_add_drafted_queue_status changed the behavior:
    //   OLD: all players stayed 'waiting' until the organizer published
    //   NEW: players IN a draft are set to 'drafted' immediately, giving the DB
    //        a first-class exclusion signal (v_queue_with_wait_time filters on
    //        status='waiting', so 'drafted' players can't be re-drafted).

    // Fetch the created draft and find which players are in it
    const { data: draftMatches } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false);

    expect(draftMatches).not.toBeNull();
    expect(draftMatches!.length).toBe(1); // exactly 1 draft at the cap

    const { data: draftPlayers } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", draftMatches![0].id);

    const draftedIds = new Set((draftPlayers ?? []).map((r) => r.player_id));

    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("player_id, status")
      .eq("session_id", session.id)
      .in(
        "player_id",
        players.map((p) => p.id)
      );

    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(8);

    for (const e of entries!) {
      if (draftedIds.has(e.player_id)) {
        // In the draft → should be 'drafted'
        expect(e.status, `player ${e.player_id} is in draft, expected drafted`).toBe("drafted");
      } else {
        // Not in any draft → should still be 'waiting'
        expect(e.status, `player ${e.player_id} not in draft, expected waiting`).toBe("waiting");
      }
    }
  });

  // ── Test 3: Partnership cap ───────────────────────────────

  it("engine does not pair players who have reached MAX_PARTNERSHIP_REPEATS", async () => {
    const { session } = await baseSetup();

    // Create 6 players — do NOT queue them yet (seedPlayers would queue them,
    // causing duplicate entries after makeCompletedMatch re-adds them).
    const [p1, p2, p3, p4, p5, p6] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);

    // Seed MAX_PARTNERSHIP_REPEATS completed matches with p1+p2 as same-team partners.
    // The engine snapshots completed/in_progress/pending matches per slot and
    // derives the partnership counts from that.
    for (let i = 0; i < MAX_PARTNERSHIP_REPEATS; i++) {
      await makeCompletedMatch({
        sessionId: session.id,
        teamA: [p1.id, p2.id],
        teamB: [p3.id, p4.id],
      });
    }

    // Now queue all 6 players so the engine has them available.
    // p1 and p2 are at the partnership cap with each other.
    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p5.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p6.id }),
    ]);

    await runEngineForSession(session.id);

    // Find the created draft match
    const { data: newMatches } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false);

    expect(newMatches).not.toBeNull();
    expect(newMatches!.length).toBeGreaterThanOrEqual(1);

    // For each created match, assert p1 and p2 are NOT on the same team
    for (const match of newMatches!) {
      const { data: matchPlayers } = await serviceClient()
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", match.id);

      if (!matchPlayers) continue;

      const p1Row = matchPlayers.find((r) => r.player_id === p1.id);
      const p2Row = matchPlayers.find((r) => r.player_id === p2.id);

      // If both are in the match, they must be on opposite teams
      if (p1Row && p2Row) {
        expect(p1Row.team).not.toBe(p2Row.team);
      }
    }
  });

  // ── Test 4: Mixed-skill flag ──────────────────────────────

  it("match is flagged is_mixed_level=true when skill spread exceeds threshold", async () => {
    const { session } = await baseSetup();

    // 1 beginner (skill_level_int=1) + 3 advanced (skill_level_int=5)
    // The normal ±1 and ±2 windows cannot match the beginner with anyone.
    // After 15+ min wait, the last-resort path fires and always sets is_mixed_level=true.
    const beginner = await makeProfile({ faker, skill: "beginner" });
    const [adv1, adv2, adv3] = await Promise.all([
      makeProfile({ faker, skill: "advanced" }),
      makeProfile({ faker, skill: "advanced" }),
      makeProfile({ faker, skill: "advanced" }),
    ]);

    // Add all to queue — beginner first so they become the anchor
    const beginnerEntry = await makeQueueEntry({ sessionId: session.id, playerId: beginner.id });
    await makeQueueEntry({ sessionId: session.id, playerId: adv1.id });
    await makeQueueEntry({ sessionId: session.id, playerId: adv2.id });
    await makeQueueEntry({ sessionId: session.id, playerId: adv3.id });

    // Age the beginner's queue entry past FALLBACK_WAIT_MINUTES (15) to trigger last-resort
    // Use 20 minutes to be safely above the threshold
    await ageQueueEntry(beginnerEntry.id, 20);

    await runEngineForSession(session.id);

    const { data: matches } = await serviceClient()
      .from("matches")
      .select("id, is_mixed_level")
      .eq("session_id", session.id)
      .eq("status", "pending");

    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(1);

    // At least one match should be flagged as mixed level
    const hasMixed = matches!.some((m) => m.is_mixed_level === true);
    expect(hasMixed).toBe(true);
  });

  // ── Test 5: Red Zone priority ─────────────────────────────

  it("Red Zone player (wait > CRITICAL_WAIT_MINUTES) is included in the match", async () => {
    const { session } = await baseSetup();

    // All intermediate players — one has been waiting a very long time
    const { players, entries } = await seedPlayers(session.id, 8);
    const redZonePlayer = players[0];
    const redZoneEntry = entries[0];

    // Age red zone player past CRITICAL_WAIT_MINUTES (25)
    await ageQueueEntry(redZoneEntry.id, CRITICAL_WAIT_MINUTES + 5);

    await runEngineForSession(session.id);

    const { data: newMatches } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("session_id", session.id)
      .eq("status", "pending");

    expect(newMatches).not.toBeNull();
    expect(newMatches!.length).toBeGreaterThanOrEqual(1);

    // The Red Zone player should be the anchor and MUST appear in a match
    let redZoneInAMatch = false;
    for (const match of newMatches!) {
      const { data: matchPlayers } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", match.id);

      if (matchPlayers?.some((mp) => mp.player_id === redZonePlayer.id)) {
        redZoneInAMatch = true;
        break;
      }
    }
    expect(redZoneInAMatch).toBe(true);
  });

  // ── Test 6: MAX_AUTO_DRAFTS cap ──────────────────────────

  it("engine exits early when total pending matches reaches MAX_AUTO_DRAFTS", async () => {
    const { session } = await baseSetup();

    // Seed 4 players as dummy participants for the pre-existing matches
    const { players: dummyPlayers } = await seedPlayers(session.id, 8);
    const [d1, d2, d3, d4, d5, d6, d7, d8] = dummyPlayers;

    // Create MAX_AUTO_DRAFTS pending matches (filling the cap)
    await makeMatch({
      sessionId: session.id,
      teamA: [d1.id, d2.id],
      teamB: [d3.id, d4.id],
      status: "pending",
    });
    await makeMatch({
      sessionId: session.id,
      teamA: [d5.id, d6.id],
      teamB: [d7.id, d8.id],
      status: "pending",
    });
    // Create a third match with fresh players
    const { players: extraPlayers } = await seedPlayers(session.id, 4);
    const [e1, e2, e3, e4] = extraPlayers;
    await makeMatch({
      sessionId: session.id,
      teamA: [e1.id, e2.id],
      teamB: [e3.id, e4.id],
      status: "pending",
    });

    // Measure actual pending count before running the engine
    const { count: beforeCount } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending");

    // 3 matches created above → cap is at MAX_AUTO_DRAFTS (3)
    expect(beforeCount).toBe(MAX_AUTO_DRAFTS);

    // Add fresh players to queue — engine should ignore them (cap already reached)
    await seedPlayers(session.id, 8);

    await runEngineForSession(session.id);

    const { count: afterCount } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending");

    // No additional matches should have been created
    expect(afterCount).toBe(beforeCount);
  });

  // ── Test 7: TOCTOU — player already committed ─────────────

  it("engine does not double-book a player already committed to a pending match", async () => {
    const { session } = await baseSetup();
    const { players } = await seedPlayers(session.id, 8);
    const [p1, p2, p3, p4] = players;

    // Create one pending match that already uses p1-p4.
    // Save its ID so we can exclude it from the "engine-created drafts" query below.
    const { id: preExistingMatchId } = await makeMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      status: "pending",
    });

    // Remove p1-p4 from queue (they're committed) — mark as on_deck so the
    // engine's v_queue_with_wait_time view (filters status='waiting') skips them.
    await serviceClient()
      .from("queue_entries")
      .update({ status: "on_deck" as const })
      .eq("session_id", session.id)
      .in("player_id", [p1.id, p2.id, p3.id, p4.id]);

    // p5-p8 are still waiting — enough for a new match
    await runEngineForSession(session.id);

    // Collect match_players only from matches created by the engine run above.
    // We must exclude the pre-existing match (preExistingMatchId) because that
    // match also has status=pending & is_published=false — including it would
    // make p1-p4 show up in the set and produce a false failure.
    const { data: newMatches } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .eq("is_published", false)
      .neq("id", preExistingMatchId);

    const newMatchIds = (newMatches ?? []).map((m) => m.id);

    if (newMatchIds.length > 0) {
      const { data: allNewMatchPlayers } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .in("match_id", newMatchIds);

      const newPlayerIds = new Set((allNewMatchPlayers ?? []).map((r) => r.player_id));

      // None of the already-committed players should appear in the new drafts
      expect(newPlayerIds.has(p1.id)).toBe(false);
      expect(newPlayerIds.has(p2.id)).toBe(false);
      expect(newPlayerIds.has(p3.id)).toBe(false);
      expect(newPlayerIds.has(p4.id)).toBe(false);
    }
  });

  // ── Test 8: hasDraftsBlocking propagation ────────────────

  it("callNextMatch returns hasDraftsBlocking=true when drafts exist but none are published", async () => {
    const { session, organizer, court } = await baseSetup();

    // Seed 8 players and 3 draft matches (at MAX_AUTO_DRAFTS cap)
    const { players } = await seedPlayers(session.id, 12);
    const [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12] = players;

    // All three draft slots filled — no room for engine to create more
    await makeMatch({ sessionId: session.id, teamA: [p1.id, p2.id], teamB: [p3.id, p4.id] });
    await makeMatch({ sessionId: session.id, teamA: [p5.id, p6.id], teamB: [p7.id, p8.id] });
    await makeMatch({ sessionId: session.id, teamA: [p9.id, p10.id], teamB: [p11.id, p12.id] });

    // Move these players to on_deck so engine won't try to schedule them
    await serviceClient()
      .from("queue_entries")
      .update({ status: "on_deck" as const })
      .eq("session_id", session.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await callNextMatch(session.id, court.id);
      expect(result.hasDraftsBlocking).toBe(true);
      expect(result.success).toBe(false);
    } finally {
      restore();
    }
  });

  // ── Test 9: Paused-player exclusion ──────────────────────
  // Soft-paused players (queue_entries.is_paused=true) MUST be invisible
  // to the matchmaking engine even when they would otherwise satisfy
  // FIFO and skill constraints. With 5 waiting players + 1 paused, the
  // engine should form 1 match using only the 4 unpaused players.

  it("Test 9: engine excludes paused players from candidate pool", async () => {
    const { session } = await baseSetup();
    const { players } = await seedPlayers(session.id, 5);

    // Pause player[0] directly — togglePlayerPause is exercised in Suite K-style
    // tests; here we go straight to the DB so the engine assertion stays focused.
    await serviceClient()
      .from("queue_entries")
      .update({ is_paused: true })
      .eq("session_id", session.id)
      .eq("player_id", players[0].id);

    await runEngineForSession(session.id);

    // Engine should form exactly 1 match — using players[1..4], NOT players[0].
    const { data: matches } = await serviceClient()
      .from("matches")
      .select("id")
      .eq("session_id", session.id);
    expect(matches).toHaveLength(1);

    const { data: roster } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", matches![0].id);
    const ids = (roster ?? []).map((r) => r.player_id);

    expect(ids).not.toContain(players[0].id); // paused — excluded
    expect(ids).toHaveLength(4);

    // Paused player's queue entry untouched: still 'waiting' + 'is_paused=true'.
    const { data: pausedEntry } = await serviceClient()
      .from("queue_entries")
      .select("status, is_paused")
      .eq("session_id", session.id)
      .eq("player_id", players[0].id)
      .single();
    expect(pausedEntry?.status).toBe("waiting");
    expect(pausedEntry?.is_paused).toBe(true);
  });

  // ── Test 10: Partnership cap saturation → no match formed ─
  // When every possible 2v2 split among the only 4 eligible players
  // exceeds MAX_PARTNERSHIP_REPEATS, the engine returns success=false
  // and writes NO new match. (The accompanying cap_saturation broadcast
  // is fire-and-forget; we assert the observable DB outcome.)
  //
  // To saturate ALL 6 pairs at MAX_PARTNERSHIP_REPEATS=2, we need 12
  // completed-match teammate occurrences — 2 occurrences per pair.
  // The 6-match Round-Robin double cycle below produces exactly that:
  //   pairs (1,2)+(3,4), (1,3)+(2,4), (1,4)+(2,3), each twice.

  it("Test 10: engine forms no match when every 2v2 split is partnership-capped", async () => {
    const { session } = await baseSetup();
    const { players } = await seedPlayers(session.id, 4);
    const [p1, p2, p3, p4] = players;

    // Two iterations of the 3 unique 2v2 splits = 6 matches.
    // After this loop every same-team pair has games_together=2, hitting
    // MAX_PARTNERSHIP_REPEATS exactly.
    for (let cycle = 0; cycle < 2; cycle++) {
      await makeCompletedMatch({
        sessionId: session.id,
        teamA: [p1.id, p2.id],
        teamB: [p3.id, p4.id],
      });
      await makeCompletedMatch({
        sessionId: session.id,
        teamA: [p1.id, p3.id],
        teamB: [p2.id, p4.id],
      });
      await makeCompletedMatch({
        sessionId: session.id,
        teamA: [p1.id, p4.id],
        teamB: [p2.id, p3.id],
      });
    }

    // Capture the count of pre-existing pending matches (none expected) so we
    // can assert the engine added zero new ones.
    const { count: before } = await serviceClient()
      .from("matches")
      .select("*", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending");
    expect(before).toBe(0);

    await runEngineForSession(session.id);

    const { count: after } = await serviceClient()
      .from("matches")
      .select("*", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "pending");

    // No new pending match — every team split exceeded the partnership cap.
    expect(after).toBe(0);

    // The 4 players remain 'waiting' — none drafted.
    const { data: entries } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .in("player_id", [p1.id, p2.id, p3.id, p4.id]);
    for (const e of entries ?? []) {
      expect(e.status).toBe("waiting");
    }
  });
});
