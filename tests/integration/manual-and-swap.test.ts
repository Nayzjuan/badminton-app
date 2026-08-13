// ============================================================
// Suite M — Manual Match Creation + Swap Origin-Stickiness
// ============================================================
// Covers integration-level behaviour that previously had only
// E2E coverage (scenarios A and C). The contract we lock in:
//
//   createManualMatchAction
//     M-1  Happy:    origin='manual', is_published=true, all 4
//                    players → 'on_deck' (skip 'drafted')
//     M-2  Negative: non-organizer rejected
//     M-3  Negative: player not in session rejected
//     M-4  Negative: a roster player whose queue_entries.status
//                    is NOT 'waiting' blocks creation (Guard 0)
//
//   swap_player_in_match (origin-stickiness — the rule that
//   prevents the engine from "demoting" a human edit)
//     M-5  origin='auto'     → flips to 'modified'
//     M-6  origin='manual'   → STAYS 'manual'   (sticky)
//     M-7  origin='modified' → STAYS 'modified' (sticky)
//
//   swapPlayerInMatch action guards
//     M-8  inPlayer not 'waiting'     → PLAYER_UNAVAILABLE
//     M-9  outPlayer already removed  → PLAYER_NOT_IN_MATCH
//     M-10 match already in_progress  → MATCH_STARTED
//
//   swap_match_players (match-to-match) origin behaviour
//     M-11 auto + auto → both flip to 'modified'
//     M-12 manual + auto → manual STAYS, auto flips to 'modified'
//
//   swapMatchPlayers tenancy
//     M-14  a PENDING match from another session → rejected by guard 3b,
//           reported as MATCH_STARTED (no existence oracle). Audit #12.
//     M-14b a NON-pending match from another session → same wording. Pins
//           guard ORDER: 3b (session) must outrank 3c (pending). Asserts on
//           `message`, because errorCode is MATCH_STARTED either way.
//     M-14c a NON-organizer gets one reply for a real match id and for a
//           random one. Pins the other half of the same reordering: guard 2
//           (organizer) must outrank guard 3 (exists).
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatchViaRpc } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { createManualMatchAction, cancelMatchAction } from "@/app/actions/match-lifecycle";
import { swapPlayerInMatch, swapMatchPlayers } from "@/app/actions/swap-player";

const faker = new Faker({ locale: [en] });
faker.seed(9101);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Helpers ───────────────────────────────────────────────────

/**
 * Seeds an organizer + session + court + N waiting players.
 * Returns everything you need to build manual matches or swap fixtures.
 */
async function seedSessionWithPlayers(playerCount: number) {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

  const players = await Promise.all(
    Array.from({ length: playerCount }, () => makeProfile({ faker }))
  );
  await Promise.all(players.map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id })));

  return { organizer, session, court, players };
}

// NOTE (provenance audit, 2026-06-17): this suite was migrated off the legacy
// `matches.origin` enum to the new model — created_method (immutable birth) +
// modification_count + the generated final_classification. The biggest semantic
// change: a swapped MANUAL match is now `manual_modified` (previously origin
// "stayed manual" by the sticky rule). Requires a live DB run to validate.

/** Reads matches.final_classification via service client. */
async function getMatchClassification(matchId: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("matches")
    .select("final_classification")
    .eq("id", matchId)
    .single();
  if (error || !data) throw new Error(`[getMatchClassification] ${error?.message ?? "not found"}`);
  return data.final_classification;
}

/** Forces a match's birth method (for fixtures). created_method is immutable in
 *  prod but tests may seed it directly. */
async function setMatchCreatedMethod(matchId: string, method: "auto" | "manual" | "held") {
  const { error } = await serviceClient()
    .from("matches")
    .update({ created_method: method })
    .eq("id", matchId);
  if (error) throw new Error(`[setMatchCreatedMethod] ${error.message}`);
}

// ─────────────────────────────────────────────────────────────

describe("Manual Match Creation & Swap Origin — Suite M", () => {
  // ============================================================
  // createManualMatchAction
  // ============================================================

  // ── M-1: Happy path ───────────────────────────────────────
  it("M-1: createManualMatchAction creates origin='manual', published, players → on_deck", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);
    const restore = mockAuthAs(organizer.id);

    try {
      const result = await createManualMatchAction(
        session.id,
        [players[0].id, players[1].id],
        [players[2].id, players[3].id]
      );

      expect(result.success).toBe(true);
      expect(result.matchId).toBeDefined();

      const { data: match } = await serviceClient()
        .from("matches")
        .select("final_classification, is_published, status")
        .eq("id", result.matchId!)
        .single();

      expect(match?.final_classification).toBe("manual_clean");
      expect(match?.is_published).toBe(true);
      expect(match?.status).toBe("pending");

      // All 4 players promoted to on_deck (not drafted) because the RPC
      // routes published matches straight to on_deck.
      const { data: entries } = await serviceClient()
        .from("queue_entries")
        .select("player_id, status")
        .eq("session_id", session.id)
        .in(
          "player_id",
          players.map((p) => p.id)
        );

      expect(entries).toHaveLength(4);
      for (const e of entries ?? []) {
        expect(e.status).toBe("on_deck");
      }

      // 4 match_players rows, two per team.
      const { data: mp } = await serviceClient()
        .from("match_players")
        .select("team")
        .eq("match_id", result.matchId!);
      expect(mp).toHaveLength(4);
      const teamCounts = (mp ?? []).reduce<Record<string, number>>((acc, r) => {
        acc[r.team] = (acc[r.team] ?? 0) + 1;
        return acc;
      }, {});
      expect(teamCounts.a).toBe(2);
      expect(teamCounts.b).toBe(2);
    } finally {
      restore();
    }
  });

  // ── M-2: Non-organizer rejected ───────────────────────────
  it("M-2: createManualMatchAction rejects a non-organizer caller", async () => {
    const { session, players } = await seedSessionWithPlayers(4);
    const outsider = await makeProfile({ faker });

    const restore = mockAuthAs(outsider.id);
    try {
      const result = await createManualMatchAction(
        session.id,
        [players[0].id, players[1].id],
        [players[2].id, players[3].id]
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/organizer/i);

      // No match row created
      const { count } = await serviceClient()
        .from("matches")
        .select("*", { count: "exact", head: true })
        .eq("session_id", session.id);
      expect(count).toBe(0);
    } finally {
      restore();
    }
  });

  // ── M-3: Player not in session rejected ───────────────────
  it("M-3: createManualMatchAction rejects when a roster player is not in the session", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(3);
    // Create a 4th player but do NOT add them to this session's queue.
    const outsidePlayer = await makeProfile({ faker });

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await createManualMatchAction(
        session.id,
        [players[0].id, players[1].id],
        [players[2].id, outsidePlayer.id]
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not in this session/i);

      const { count } = await serviceClient()
        .from("matches")
        .select("*", { count: "exact", head: true })
        .eq("session_id", session.id);
      expect(count).toBe(0);
    } finally {
      restore();
    }
  });

  // ── M-4: Player not 'waiting' rejected (Guard 0) ──────────
  it("M-4: createManualMatchAction rejects when a roster player has status='left'", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(4);

    // Manually flip one player's queue entry to 'left' to simulate them checking out.
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", session.id)
      .eq("player_id", players[0].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await createManualMatchAction(
        session.id,
        [players[0].id, players[1].id],
        [players[2].id, players[3].id]
      );

      // Guard 0 in the RPC returns NULL → action returns an "unavailable" message.
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unavailable|left|already assigned/i);

      const { count } = await serviceClient()
        .from("matches")
        .select("*", { count: "exact", head: true })
        .eq("session_id", session.id);
      expect(count).toBe(0);
    } finally {
      restore();
    }
  });

  // ============================================================
  // swap_player_in_match — origin-stickiness
  // ============================================================

  // ── M-5: auto → modified ─────────────────────────────────
  // Step f (origin auto → modified) was dropped by two rewrites of
  // swap_player_in_match (20260509000000, 20260511000001) and restored
  // by 20260512000000_restore_swap_player_origin_flip.sql. This test is
  // the contract guard against another silent drop.
  it("M-5: swap_player_in_match flips origin 'auto' → 'modified'", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    // Build a published on-deck match with 4 of the 5 players,
    // then force origin='auto' so we can observe the sticky-rule flip.
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });
    await setMatchCreatedMethod(match.id, "auto");

    const restore = mockAuthAs(organizer.id);
    try {
      // Swap player[0] (in match) out for player[4] (waiting in queue).
      const result = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(result.success).toBe(true);

      const cls = await getMatchClassification(match.id);
      expect(cls).toBe("auto_modified");

      // Outgoing player → waiting; incoming player → on_deck (because is_published=true).
      const { data: entries } = await serviceClient()
        .from("queue_entries")
        .select("player_id, status")
        .eq("session_id", session.id)
        .in("player_id", [players[0].id, players[4].id]);

      const byId = Object.fromEntries((entries ?? []).map((e) => [e.player_id, e.status]));
      expect(byId[players[0].id]).toBe("waiting");
      expect(byId[players[4].id]).toBe("on_deck");
    } finally {
      restore();
    }
  });

  // ── M-6: manual stays manual (sticky) ────────────────────
  it("M-6: swap_player_in_match STAYS 'manual' when origin is already 'manual' (sticky rule)", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });
    // makeMatchViaRpc inserts with origin='manual' already; assert before the swap.
    expect(await getMatchClassification(match.id)).toBe("manual_clean");

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(result.success).toBe(true);

      // Manual MUST NOT be demoted to modified.
      const cls = await getMatchClassification(match.id);
      expect(cls).toBe("manual_modified");
    } finally {
      restore();
    }
  });

  // ── M-7: modified stays modified ─────────────────────────
  it("M-7: swap_player_in_match STAYS 'modified' on subsequent swaps", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(6);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });
    // Seed an already-modified auto match (created_method auto + count 1).
    await serviceClient()
      .from("matches")
      .update({ created_method: "auto", modification_count: 1 })
      .eq("id", match.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(result.success).toBe(true);

      // Stays modified — another swap increments the count (now 2).
      expect(await getMatchClassification(match.id)).toBe("auto_modified");
    } finally {
      restore();
    }
  });

  // ============================================================
  // swapPlayerInMatch — server-action guards
  // ============================================================

  // ── M-8: inPlayer not 'waiting' → PLAYER_UNAVAILABLE ─────
  it("M-8: swapPlayerInMatch rejects when incoming player is not 'waiting'", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Flip the incoming candidate to 'left' so the action's Guard 4 fires.
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" as const })
      .eq("session_id", session.id)
      .eq("player_id", players[4].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PLAYER_UNAVAILABLE");

      // Match roster unchanged — players[0] still on the team.
      const { data: mp } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", match.id);
      const ids = (mp ?? []).map((r) => r.player_id);
      expect(ids).toContain(players[0].id);
      expect(ids).not.toContain(players[4].id);
    } finally {
      restore();
    }
  });

  // ── M-9: outPlayer already gone → PLAYER_NOT_IN_MATCH ────
  it("M-9: swapPlayerInMatch rejects when outgoing player is no longer in the match", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Race-simulator: delete the outgoing player's match_players row first.
    await serviceClient()
      .from("match_players")
      .delete()
      .eq("match_id", match.id)
      .eq("player_id", players[0].id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PLAYER_NOT_IN_MATCH");
    } finally {
      restore();
    }
  });

  // ── M-10: match started → MATCH_STARTED ──────────────────
  it("M-10: swapPlayerInMatch rejects when the match is already in_progress", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    // Promote match to in_progress to trigger Guard 2.
    await serviceClient()
      .from("matches")
      .update({ status: "in_progress" as const })
      .eq("id", match.id);

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("MATCH_STARTED");
    } finally {
      restore();
    }
  });

  // ============================================================
  // swap_match_players (match-to-match) — origin behaviour
  // ============================================================

  // ── M-11: auto + auto → both modified ────────────────────
  it("M-11: swap_match_players flips both origin='auto' matches to 'modified'", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(8);

    const matchA = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });
    const matchB = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[4].id, players[5].id],
      teamB: [players[6].id, players[7].id],
      isPublished: true,
    });

    await setMatchCreatedMethod(matchA.id, "auto");
    await setMatchCreatedMethod(matchB.id, "auto");

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapMatchPlayers(
        matchA.id,
        players[0].id,
        matchB.id,
        players[4].id,
        session.id
      );
      expect(result.success).toBe(true);

      expect(await getMatchClassification(matchA.id)).toBe("auto_modified");
      expect(await getMatchClassification(matchB.id)).toBe("auto_modified");

      // Player 0 now in match B, player 4 now in match A.
      const { data: mpA } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchA.id);
      const { data: mpB } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchB.id);
      const idsA = (mpA ?? []).map((r) => r.player_id);
      const idsB = (mpB ?? []).map((r) => r.player_id);
      expect(idsA).toContain(players[4].id);
      expect(idsA).not.toContain(players[0].id);
      expect(idsB).toContain(players[0].id);
      expect(idsB).not.toContain(players[4].id);
    } finally {
      restore();
    }
  });

  // ── M-12: manual + auto → manual stays, auto becomes modified
  it("M-12: swap_match_players keeps 'manual' sticky and flips only the 'auto' side", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(8);

    const matchManual = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });
    const matchAuto = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[4].id, players[5].id],
      teamB: [players[6].id, players[7].id],
      isPublished: true,
    });

    // makeMatchViaRpc inserts as 'manual' — keep matchManual as is, demote matchAuto.
    await setMatchCreatedMethod(matchAuto.id, "auto");

    const restore = mockAuthAs(organizer.id);
    try {
      const result = await swapMatchPlayers(
        matchManual.id,
        players[0].id,
        matchAuto.id,
        players[4].id,
        session.id
      );
      expect(result.success).toBe(true);

      // Sticky rule: manual stays manual; auto becomes modified.
      expect(await getMatchClassification(matchManual.id)).toBe("manual_modified");
      expect(await getMatchClassification(matchAuto.id)).toBe("auto_modified");
    } finally {
      restore();
    }
  });

  // ── M-14: cross-session swap is rejected ─────────────────
  // Guard 3b (audit #12). swapMatchPlayers authorizes with
  // isSessionOrganizer(user.id, sessionId) against the CALLER-SUPPLIED
  // sessionId and then writes through the service-role client, so RLS
  // is not a backstop. Before guard 3b an organizer of session A could
  // pass a pending match id from session B and rewrite a roster in
  // another club's session. This is the draft-path twin of the defect
  // 20260723000001 bound the four live-swap RPCs against.
  //
  // ⚠ The rejection reports MATCH_STARTED, which guard 3 also returns for
  // a missing or already-started match. So this test asserts the
  // precondition explicitly: matchB must exist AND be pending at call
  // time, leaving guard 3b as the only thing that can produce the code.
  // Without that assert the test would pass just as happily against a
  // match that was never created.
  it("M-14: swapMatchPlayers rejects a match belonging to another session", async () => {
    const a = await seedSessionWithPlayers(4);
    const b = await seedSessionWithPlayers(4);

    const matchA = await makeMatchViaRpc({
      sessionId: a.session.id,
      teamA: [a.players[0].id, a.players[1].id],
      teamB: [a.players[2].id, a.players[3].id],
      isPublished: true,
    });
    const matchB = await makeMatchViaRpc({
      sessionId: b.session.id,
      teamA: [b.players[0].id, b.players[1].id],
      teamB: [b.players[2].id, b.players[3].id],
      isPublished: true,
    });

    // Precondition: the victim match is real and still swappable, so the
    // MATCH_STARTED below can only have come from guard 3b.
    const { data: preB } = await serviceClient()
      .from("matches")
      .select("id, status, session_id")
      .eq("id", matchB.id)
      .single();
    expect(preB?.status).toBe("pending");
    expect(preB?.session_id).toBe(b.session.id);

    // a.organizer organizes session A only, and passes session A's id —
    // so guard 2 (organizer) says yes. Only guard 3b stops this.
    const restore = mockAuthAs(a.organizer.id);
    try {
      const result = await swapMatchPlayers(
        matchA.id,
        a.players[0].id,
        matchB.id,
        b.players[0].id,
        a.session.id
      );

      expect(result.success).toBe(false);
      // MATCH_STARTED, not a distinct cross-session code: "belongs to another
      // session" is deliberately indistinguishable from "does not exist", so
      // this action is not an existence oracle over match ids.
      expect(result.errorCode).toBe("MATCH_STARTED");

      // Neither roster moved.
      const { data: mpA } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchA.id);
      const { data: mpB } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchB.id);
      expect((mpA ?? []).map((r) => r.player_id).sort()).toEqual(a.players.map((p) => p.id).sort());
      expect((mpB ?? []).map((r) => r.player_id).sort()).toEqual(b.players.map((p) => p.id).sort());

      // And the victim's match was not even reclassified — guard 3b
      // returns before the RPC, so no modification_count bump.
      expect(await getMatchClassification(matchB.id)).toBe("manual_clean");
    } finally {
      restore();
    }
  });

  // ── M-14b: guard 3b must outrank guard 3c ────────────────
  // M-14 only covers a cross-session match that is still PENDING, and the
  // first version of the fix ran the status check before the session check.
  // For a cross-session match that is NOT pending, that ordering returned
  // "A match has already started …" while a nonexistent id returned "One or
  // both matches could not be found." — two distinguishable replies, i.e.
  // the existence oracle guard 3b exists to prevent, reintroduced one guard
  // later. errorCode is MATCH_STARTED in every branch this test can reach
  // (swapMatchPlayers does also return PLAYER_NOT_IN_MATCH, at :420 and :448 of
  // swap-player.ts, but neither is reachable from a foreign match id — guard 3b
  // rejects first). So the code alone cannot detect the regression: this test
  // asserts on `message`.
  // 🪤 Both cites are the `return {` line, not the `if` above it and not the
  // `errorCode:` line inside it. They have now been wrong THREE times, always
  // the same way: :383/:411 (the `if` lines, and 8 low besides), then :391/:419,
  // then :406/:434 — each read before a further round of comment edits to
  // swap-player.ts pushed both returns down again. A cite into another file is
  // only as fresh as that file's LAST edit, not your last read of it. Re-derive
  // after it; see the same 🪤 in swap-player.ts:84.
  it("M-14b: a NON-pending match from another session gets the not-found wording, not 'already started'", async () => {
    // Session A needs eight players: create_match_with_players refuses to seat
    // anyone already committed to a pending match, so the positive control's
    // second match cannot reuse matchA's four.
    const a = await seedSessionWithPlayers(8);
    const b = await seedSessionWithPlayers(4);

    const matchA = await makeMatchViaRpc({
      sessionId: a.session.id,
      teamA: [a.players[0].id, a.players[1].id],
      teamB: [a.players[2].id, a.players[3].id],
      isPublished: true,
    });
    const matchB = await makeMatchViaRpc({
      sessionId: b.session.id,
      teamA: [b.players[0].id, b.players[1].id],
      teamB: [b.players[2].id, b.players[3].id],
      isPublished: true,
    });

    // The distinguishing condition: session B's match is no longer pending.
    await serviceClient().from("matches").update({ status: "in_progress" }).eq("id", matchB.id);
    const { data: preB } = await serviceClient()
      .from("matches")
      .select("status, session_id")
      .eq("id", matchB.id)
      .single();
    expect(preB?.status).toBe("in_progress");
    expect(preB?.session_id).toBe(b.session.id);

    const restore = mockAuthAs(a.organizer.id);
    try {
      const cross = await swapMatchPlayers(
        matchA.id,
        a.players[0].id,
        matchB.id,
        b.players[0].id,
        a.session.id
      );

      expect(cross.success).toBe(false);
      expect(cross.errorCode).toBe("MATCH_STARTED");
      expect(cross.message).toBe("One or both matches could not be found.");

      // Positive control: the two wordings really are different, so the
      // assertion above is not just matching the only string the action
      // ever returns. Same organizer, same non-pending condition — but the
      // match is in THEIR session, so guard 3c is allowed to be specific.
      const ownStarted = await makeMatchViaRpc({
        sessionId: a.session.id,
        teamA: [a.players[4].id, a.players[5].id],
        teamB: [a.players[6].id, a.players[7].id],
        isPublished: true,
      });
      await serviceClient()
        .from("matches")
        .update({ status: "in_progress" })
        .eq("id", ownStarted.id);

      const sameSession = await swapMatchPlayers(
        matchA.id,
        a.players[0].id,
        ownStarted.id,
        a.players[4].id,
        a.session.id
      );

      expect(sameSession.success).toBe(false);
      expect(sameSession.errorCode).toBe("MATCH_STARTED");
      expect(sameSession.message).toBe("A match has already started — the swap was cancelled.");
    } finally {
      restore();
    }
  });

  // ── M-14c: guard 2 must outrank guard 3 ──────────────────
  // M-14/M-14b both pin orderings *among* the match guards, and both are run
  // by an organizer. Neither covers the other half of the same reordering:
  // guard 2 (organizer) was originally BELOW guard 3 (exists), which let a
  // caller who organizes nothing at all learn whether a match id exists — the
  // same oracle, one guard earlier, and reachable by any authenticated user
  // rather than only by an organizer of something.
  //
  // The pin: for a NON-organizer, a nonexistent id and a real id must be
  // indistinguishable. If guard 3 ever floats back above guard 2, the random
  // UUID keeps answering "Not authorized." while the real started match starts
  // answering "A match has already started …" — and this test fails on the
  // second assertion. Asserting on `message` is deliberate for the same reason
  // as M-14b: the two branches differ in wording before they differ in code.
  it("M-14c: a non-organizer cannot tell a real match id from a random one", async () => {
    const a = await seedSessionWithPlayers(4);
    const outsider = await makeProfile({ faker });

    const realMatch = await makeMatchViaRpc({
      sessionId: a.session.id,
      teamA: [a.players[0].id, a.players[1].id],
      teamB: [a.players[2].id, a.players[3].id],
      isPublished: true,
    });
    // Started, so guard 3c would have something specific to say if it were
    // reachable. A pending match would be rejected by 3b/3c wording that the
    // organizer path already covers.
    await serviceClient().from("matches").update({ status: "in_progress" }).eq("id", realMatch.id);

    const nonexistent = faker.string.uuid();

    const restore = mockAuthAs(outsider.id);
    try {
      const withReal = await swapMatchPlayers(
        realMatch.id,
        a.players[0].id,
        realMatch.id,
        a.players[1].id,
        a.session.id
      );
      const withRandom = await swapMatchPlayers(
        nonexistent,
        a.players[0].id,
        nonexistent,
        a.players[1].id,
        a.session.id
      );

      expect(withReal.success).toBe(false);
      expect(withRandom.success).toBe(false);
      expect(withReal.message).toBe("Not authorized. Organizer access required.");
      // The actual pin — same reply for both, so nothing leaks.
      expect(withRandom.message).toBe(withReal.message);
      expect(withRandom.errorCode).toBe(withReal.errorCode);

      // Positive control: the organizer of that same session DOES get past
      // guard 2 and reaches a match-specific answer. Without this, the test
      // would still pass if swapMatchPlayers rejected literally everyone.
      restore();
      const asOrganizer = mockAuthAs(a.organizer.id);
      try {
        const organizerReply = await swapMatchPlayers(
          realMatch.id,
          a.players[0].id,
          realMatch.id,
          a.players[1].id,
          a.session.id
        );
        expect(organizerReply.success).toBe(false);
        expect(organizerReply.message).not.toBe("Not authorized. Organizer access required.");
        expect(organizerReply.errorCode).toBe("MATCH_STARTED");
      } finally {
        asOrganizer();
      }
    } finally {
      clearMockAuth();
    }
  });

  // ============================================================
  // Hygiene: cancel after swap leaves no orphan players
  // ============================================================
  it("M-13: cancelMatchAction after a swap returns all (current) roster players to 'waiting'", async () => {
    const { organizer, session, players } = await seedSessionWithPlayers(5);
    const match = await makeMatchViaRpc({
      sessionId: session.id,
      teamA: [players[0].id, players[1].id],
      teamB: [players[2].id, players[3].id],
      isPublished: true,
    });

    const restore = mockAuthAs(organizer.id);
    try {
      // Swap p0 → p4. After the swap the roster is p4, p1, p2, p3.
      const swap = await swapPlayerInMatch(match.id, players[0].id, players[4].id);
      expect(swap.success).toBe(true);

      // Tighten the assertion: prove the swap (not the upcoming cancel) is
      // what restored p0 to 'waiting'. Without this checkpoint, a regression
      // in swap_player_in_match step d would be masked by cancelMatchAction
      // sweeping every roster player back to 'waiting'.
      const { data: p0AfterSwap } = await serviceClient()
        .from("queue_entries")
        .select("status")
        .eq("session_id", session.id)
        .eq("player_id", players[0].id)
        .single();
      expect(p0AfterSwap?.status).toBe("waiting");

      // p0 must be gone from the match roster too — cancel only touches
      // the post-swap roster (p4, p1, p2, p3).
      const { data: rosterAfterSwap } = await serviceClient()
        .from("match_players")
        .select("player_id")
        .eq("match_id", match.id);
      const rosterIds = (rosterAfterSwap ?? []).map((r) => r.player_id);
      expect(rosterIds).not.toContain(players[0].id);
      expect(rosterIds).toContain(players[4].id);

      // Cancel — the four CURRENT roster players (p4,p1,p2,p3) should be 'waiting'
      // again; p0 (already swapped out) stays 'waiting' too. games_played stays 0
      // for everyone because cancel does NOT increment it.
      const cancel = await cancelMatchAction(match.id);
      expect(cancel.success).toBe(true);

      const { data: entries } = await serviceClient()
        .from("queue_entries")
        .select("player_id, status, games_played")
        .eq("session_id", session.id)
        .in(
          "player_id",
          players.map((p) => p.id)
        );

      for (const e of entries ?? []) {
        expect(e.status).toBe("waiting");
        expect(e.games_played).toBe(0);
      }
    } finally {
      restore();
    }
  });
});
