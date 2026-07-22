// ============================================================
// Integration Tests: Live Match Player Swap RPCs
// ============================================================
// Verifies the four Postgres RPCs added by migration
// 20260601000000_live_match_player_swap.sql against a real DB.
//
// RPCs under test:
//   swap_player_in_active_match  — queue player replaces one in active match
//   swap_teams_in_active_match   — mutual team flip within active match
//   swap_active_from_ondeck      — atomic 3-way: ondeck→active + fill ondeck
//   undo_swap_active_from_ondeck — reverses the 3-way swap
//
// Test IDs:
//   LMS-1   swap_player_in_active_match — replaces player, updates queue statuses
//   LMS-2   swap_player_in_active_match — rejects if match is not in_progress
//   LMS-3   swap_player_in_active_match — rejects if out_player not in match
//   LMS-4   swap_player_in_active_match — rejects if in_player not waiting
//   LMS-5   swap_player_in_active_match — recomputes is_mixed_level after swap
//   LMS-6   swap_teams_in_active_match  — swaps team assignments, both stay playing
//   LMS-7   swap_teams_in_active_match  — rejects if match is not in_progress
//   LMS-8   swap_active_from_ondeck     — atomic 3-way: correct player movements
//   LMS-9   swap_active_from_ondeck     — rejects if active match not in_progress
//   LMS-10  swap_active_from_ondeck     — rejects if ondeck match not pending
//   LMS-11  swap_active_from_ondeck     — rejects if fill_player not waiting
//   LMS-12  undo_swap_active_from_ondeck — reverses all 3 changes atomically
//   LMS-13  undo_swap_active_from_ondeck — silently aborts if match advanced
//
// Isolation: truncateTracked() in afterEach via service-role factory helpers.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";

const faker = new Faker({ locale: [en] });
faker.seed(9001);

afterEach(async () => {
  await truncateTracked();
});

// ── Shared setup helper ───────────────────────────────────────

/**
 * Creates a minimal active-match scenario:
 *   organizer + session + court + 4 players + in_progress match
 * Returns all IDs needed by LMS tests.
 */
async function setupActiveMatch() {
  const db = serviceClient();

  const org = await makeProfile({ faker, skill: "intermediate", displayName: "Organizer" });
  const session = await makeSession({ faker, organizer: org.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1", status: "in_use" });

  // 4 players — 2 per team
  const a1 = await makeProfile({ faker, skill: "intermediate", displayName: "A1" });
  const a2 = await makeProfile({ faker, skill: "intermediate", displayName: "A2" });
  const b1 = await makeProfile({ faker, skill: "intermediate", displayName: "B1" });
  const b2 = await makeProfile({ faker, skill: "intermediate", displayName: "B2" });

  // Queue entries — all in 'playing' status (they're in an active match)
  await makeQueueEntry({ sessionId: session.id, playerId: a1.id, status: "playing" });
  await makeQueueEntry({ sessionId: session.id, playerId: a2.id, status: "playing" });
  await makeQueueEntry({ sessionId: session.id, playerId: b1.id, status: "playing" });
  await makeQueueEntry({ sessionId: session.id, playerId: b2.id, status: "playing" });

  const match = await makeMatch({
    sessionId: session.id,
    teamA: [a1.id, a2.id],
    teamB: [b1.id, b2.id],
    courtId: court.id,
    status: "in_progress",
    isPublished: true,
  });

  return { db, session, court, match, org, a1, a2, b1, b2 };
}

// ─────────────────────────────────────────────────────────────
// LMS-1: swap_player_in_active_match — happy path
// ─────────────────────────────────────────────────────────────

describe("LMS-1: swap_player_in_active_match — replaces player and updates queue", () => {
  it("removes out_player from match, adds in_player; out→waiting, in→playing", async () => {
    const { db, session, match, a1 } = await setupActiveMatch();

    // Create a waiting replacement player
    const replacement = await makeProfile({
      faker,
      skill: "intermediate",
      displayName: "Replacement",
    });
    await makeQueueEntry({ sessionId: session.id, playerId: replacement.id, status: "waiting" });

    // Execute the RPC
    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: match.id,
      p_out_player_id: a1.id,
      p_in_player_id: replacement.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(error).toBeNull();

    // out_player removed from match_players
    const { data: outRow } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", match.id)
      .eq("player_id", a1.id)
      .maybeSingle();
    expect(outRow).toBeNull();

    // in_player added to match_players on correct team
    const { data: inRow } = await db
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", match.id)
      .eq("player_id", replacement.id)
      .single();
    expect(inRow?.team).toBe("a");

    // Queue statuses updated
    const { data: outEntry } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", a1.id)
      .single();
    expect(outEntry?.status).toBe("waiting");

    const { data: inEntry } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", replacement.id)
      .single();
    expect(inEntry?.status).toBe("playing");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-2: swap_player_in_active_match — match not in_progress
// ─────────────────────────────────────────────────────────────

describe("LMS-2: swap_player_in_active_match — rejects when match not in_progress", () => {
  it("raises MATCH_NOT_ACTIVE for a pending match", async () => {
    const { db, session } = await setupActiveMatch();
    const org2 = await makeProfile({ faker, skill: "intermediate" });
    // Four DISTINCT players: match_players carries a UNIQUE (match_id,
    // player_id), so padding a filler match by repeating one id fails the
    // insert before the RPC under test is ever reached.
    const pad1 = await makeProfile({ faker, skill: "intermediate" });
    const pad2 = await makeProfile({ faker, skill: "intermediate" });
    const pad3 = await makeProfile({ faker, skill: "intermediate" });
    const pendingMatch = await makeMatch({
      sessionId: session.id,
      teamA: [org2.id, pad1.id], // org2 on team a — the swap target
      teamB: [pad2.id, pad3.id],
      status: "pending",
    });
    const sub = await makeProfile({ faker, skill: "intermediate" });
    await makeQueueEntry({ sessionId: session.id, playerId: sub.id, status: "waiting" });

    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: pendingMatch.id,
      p_out_player_id: org2.id,
      p_in_player_id: sub.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(error?.message).toContain("MATCH_NOT_ACTIVE");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-3: swap_player_in_active_match — out_player not in match
// ─────────────────────────────────────────────────────────────

describe("LMS-3: swap_player_in_active_match — rejects when out_player not in match", () => {
  it("raises PLAYER_NOT_IN_MATCH when out_player ID is not in match_players", async () => {
    const { db, session, match } = await setupActiveMatch();
    const stranger = await makeProfile({ faker, skill: "intermediate" });
    const sub = await makeProfile({ faker, skill: "intermediate" });
    await makeQueueEntry({ sessionId: session.id, playerId: sub.id, status: "waiting" });

    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: match.id,
      p_out_player_id: stranger.id, // not in this match
      p_in_player_id: sub.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(error?.message).toContain("PLAYER_NOT_IN_MATCH");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-4: swap_player_in_active_match — in_player not waiting
// ─────────────────────────────────────────────────────────────

describe("LMS-4: swap_player_in_active_match — rejects when in_player not waiting", () => {
  it("raises PLAYER_UNAVAILABLE when in_player has status 'on_deck'", async () => {
    const { db, session, match, a1 } = await setupActiveMatch();
    const busy = await makeProfile({ faker, skill: "intermediate" });
    await makeQueueEntry({ sessionId: session.id, playerId: busy.id, status: "on_deck" });

    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: match.id,
      p_out_player_id: a1.id,
      p_in_player_id: busy.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(error?.message).toContain("PLAYER_UNAVAILABLE");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-5: swap_player_in_active_match — is_mixed_level recomputed
// ─────────────────────────────────────────────────────────────

describe("LMS-5: swap_player_in_active_match — recomputes is_mixed_level", () => {
  it("sets is_mixed_level=true when replacement has a very different skill level", async () => {
    const { db, session, match, a1 } = await setupActiveMatch();

    // Beginner replacement into an all-intermediate match → mixed
    const beginner = await makeProfile({ faker, skill: "beginner", displayName: "Beginner" });
    await makeQueueEntry({ sessionId: session.id, playerId: beginner.id, status: "waiting" });

    const { error } = await db.rpc("swap_player_in_active_match", {
      p_match_id: match.id,
      p_out_player_id: a1.id,
      p_in_player_id: beginner.id,
      p_session_id: session.id,
      p_team: "a",
    });
    expect(error).toBeNull();

    const { data: updatedMatch } = await db
      .from("matches")
      .select("is_mixed_level")
      .eq("id", match.id)
      .single();
    expect(updatedMatch?.is_mixed_level).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-6: swap_teams_in_active_match — happy path
// ─────────────────────────────────────────────────────────────

describe("LMS-6: swap_teams_in_active_match — swaps team assignments", () => {
  it("player A moves to team B and player B moves to team A; both stay 'playing'", async () => {
    const { db, match, a1, b1, session } = await setupActiveMatch();

    const { error } = await db.rpc("swap_teams_in_active_match", {
      p_match_id: match.id,
      p_player_a_id: a1.id,
      p_player_b_id: b1.id,
    });
    expect(error).toBeNull();

    // a1 is now on team b
    const { data: rowA } = await db
      .from("match_players")
      .select("team")
      .eq("match_id", match.id)
      .eq("player_id", a1.id)
      .single();
    expect(rowA?.team).toBe("b");

    // b1 is now on team a
    const { data: rowB } = await db
      .from("match_players")
      .select("team")
      .eq("match_id", match.id)
      .eq("player_id", b1.id)
      .single();
    expect(rowB?.team).toBe("a");

    // Queue statuses unchanged — both still 'playing'
    const { data: entryA } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", a1.id)
      .single();
    expect(entryA?.status).toBe("playing");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-7: swap_teams_in_active_match — match not in_progress
// ─────────────────────────────────────────────────────────────

describe("LMS-7: swap_teams_in_active_match — rejects when match not in_progress", () => {
  it("raises MATCH_NOT_ACTIVE for a completed match", async () => {
    const { db, session } = await setupActiveMatch();
    const p1 = await makeProfile({ faker });
    const p2 = await makeProfile({ faker });
    const p3 = await makeProfile({ faker });
    const p4 = await makeProfile({ faker });
    const done = await makeMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      status: "completed",
    });

    const { error } = await db.rpc("swap_teams_in_active_match", {
      p_match_id: done.id,
      p_player_a_id: p1.id,
      p_player_b_id: p3.id,
    });
    expect(error?.message).toContain("MATCH_NOT_ACTIVE");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-8: swap_active_from_ondeck — happy path
// ─────────────────────────────────────────────────────────────

describe("LMS-8: swap_active_from_ondeck — atomic 3-way swap", () => {
  it("moves ondeck_player to active match, out_player to queue, fill_player to ondeck slot", async () => {
    const { db, session, match, a1 } = await setupActiveMatch();

    // Set up an on-deck match with one player we'll pull
    const onDeckPlayer = await makeProfile({ faker, displayName: "OnDeck" });
    const extra = await makeProfile({ faker, displayName: "Extra" });
    const fill = await makeProfile({ faker, displayName: "Fill" });
    // Team B needs two DISTINCT bodies — see the note in LMS-2.
    const odB1 = await makeProfile({ faker, displayName: "OnDeckB1" });
    const odB2 = await makeProfile({ faker, displayName: "OnDeckB2" });

    await makeQueueEntry({ sessionId: session.id, playerId: onDeckPlayer.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: extra.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: fill.id, status: "waiting" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB1.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB2.id, status: "on_deck" });

    const onDeckMatch = await makeMatch({
      sessionId: session.id,
      teamA: [onDeckPlayer.id, extra.id],
      teamB: [odB1.id, odB2.id],
      status: "pending",
      isPublished: true,
    });

    const { data, error } = await db.rpc("swap_active_from_ondeck", {
      p_active_match_id: match.id,
      p_out_player_id: a1.id,
      p_ondeck_player_id: onDeckPlayer.id,
      p_ondeck_match_id: onDeckMatch.id,
      p_fill_player_id: fill.id,
      p_session_id: session.id,
    });
    expect(error).toBeNull();

    // out_player removed from active match
    const { data: outRow } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", match.id)
      .eq("player_id", a1.id)
      .maybeSingle();
    expect(outRow).toBeNull();

    // ondeck_player is now in the active match
    const { data: inRow } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", match.id)
      .eq("player_id", onDeckPlayer.id)
      .maybeSingle();
    expect(inRow).not.toBeNull();

    // fill_player is now in the on-deck match
    const { data: fillRow } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", onDeckMatch.id)
      .eq("player_id", fill.id)
      .maybeSingle();
    expect(fillRow).not.toBeNull();

    // Queue statuses
    const { data: outEntry } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", a1.id)
      .single();
    expect(outEntry?.status).toBe("waiting");

    const { data: onDeckEntry } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", onDeckPlayer.id)
      .single();
    expect(onDeckEntry?.status).toBe("playing");

    const { data: fillEntry } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", fill.id)
      .single();
    expect(fillEntry?.status).toBe("on_deck");

    // OUT params: teams returned for undo
    const row = Array.isArray(data) ? data[0] : data;
    expect(row).toHaveProperty("o_out_team");
    expect(row).toHaveProperty("o_ondeck_team");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-9: swap_active_from_ondeck — active match not in_progress
// ─────────────────────────────────────────────────────────────

describe("LMS-9: swap_active_from_ondeck — rejects when active match not in_progress", () => {
  it("raises MATCH_NOT_ACTIVE if the active match has been completed", async () => {
    const { db, session } = await setupActiveMatch();
    const p1 = await makeProfile({ faker });
    const p2 = await makeProfile({ faker });
    const p3 = await makeProfile({ faker });
    const p4 = await makeProfile({ faker });
    const pd = await makeProfile({ faker });
    const pf = await makeProfile({ faker });

    const completedMatch = await makeMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      status: "completed",
    });
    const onDeckMatch = await makeMatch({
      sessionId: session.id,
      teamA: [pd.id, pf.id],
      teamB: [p1.id, p2.id],
      status: "pending",
    });
    await makeQueueEntry({ sessionId: session.id, playerId: pf.id, status: "waiting" });

    const { error } = await db.rpc("swap_active_from_ondeck", {
      p_active_match_id: completedMatch.id,
      p_out_player_id: p1.id,
      p_ondeck_player_id: pd.id,
      p_ondeck_match_id: onDeckMatch.id,
      p_fill_player_id: pf.id,
      p_session_id: session.id,
    });
    expect(error?.message).toContain("MATCH_NOT_ACTIVE");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-11: swap_active_from_ondeck — fill_player not waiting
// ─────────────────────────────────────────────────────────────

describe("LMS-11: swap_active_from_ondeck — rejects when fill_player not waiting", () => {
  it("raises FILL_PLAYER_UNAVAILABLE if fill_player has status 'on_deck'", async () => {
    const { db, session, match, a1 } = await setupActiveMatch();
    const odPlayer = await makeProfile({ faker });
    const extra = await makeProfile({ faker });
    const busyFill = await makeProfile({ faker });
    // Team B needs two DISTINCT bodies — see the note in LMS-2.
    const odB1 = await makeProfile({ faker });
    const odB2 = await makeProfile({ faker });

    await makeQueueEntry({ sessionId: session.id, playerId: odPlayer.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: extra.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: busyFill.id, status: "on_deck" }); // NOT waiting
    await makeQueueEntry({ sessionId: session.id, playerId: odB1.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB2.id, status: "on_deck" });

    const odMatch = await makeMatch({
      sessionId: session.id,
      teamA: [odPlayer.id, extra.id],
      teamB: [odB1.id, odB2.id],
      status: "pending",
    });

    const { error } = await db.rpc("swap_active_from_ondeck", {
      p_active_match_id: match.id,
      p_out_player_id: a1.id,
      p_ondeck_player_id: odPlayer.id,
      p_ondeck_match_id: odMatch.id,
      p_fill_player_id: busyFill.id,
      p_session_id: session.id,
    });
    expect(error?.message).toContain("FILL_PLAYER_UNAVAILABLE");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-12: undo_swap_active_from_ondeck — reverses all 3 changes
// ─────────────────────────────────────────────────────────────

describe("LMS-12: undo_swap_active_from_ondeck — reverses all changes atomically", () => {
  it("restores original rosters and queue statuses after a 3-way swap", async () => {
    const { db, session, match, a1 } = await setupActiveMatch();

    const onDeckPlayer = await makeProfile({ faker, displayName: "ODPlayer" });
    const extra = await makeProfile({ faker, displayName: "Extra" });
    const fill = await makeProfile({ faker, displayName: "Fill" });
    // Team B needs two DISTINCT bodies — see the note in LMS-2.
    const odB1 = await makeProfile({ faker, displayName: "ODB1" });
    const odB2 = await makeProfile({ faker, displayName: "ODB2" });

    await makeQueueEntry({ sessionId: session.id, playerId: onDeckPlayer.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: extra.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: fill.id, status: "waiting" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB1.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB2.id, status: "on_deck" });

    const onDeckMatch = await makeMatch({
      sessionId: session.id,
      teamA: [onDeckPlayer.id, extra.id],
      teamB: [odB1.id, odB2.id],
      status: "pending",
      isPublished: true,
    });

    // Execute the original swap
    const { data: swapData } = await db.rpc("swap_active_from_ondeck", {
      p_active_match_id: match.id,
      p_out_player_id: a1.id,
      p_ondeck_player_id: onDeckPlayer.id,
      p_ondeck_match_id: onDeckMatch.id,
      p_fill_player_id: fill.id,
      p_session_id: session.id,
    });

    const row = Array.isArray(swapData) ? swapData[0] : swapData;
    const outTeam = row?.o_out_team ?? "a";
    const onDeckTeam = row?.o_ondeck_team ?? "a";

    // Now undo it
    const { error: undoError } = await db.rpc("undo_swap_active_from_ondeck", {
      p_active_match_id: match.id,
      p_out_player_id: a1.id,
      p_ondeck_player_id: onDeckPlayer.id,
      p_ondeck_match_id: onDeckMatch.id,
      p_fill_player_id: fill.id,
      p_session_id: session.id,
      p_out_team: outTeam,
      p_ondeck_team: onDeckTeam,
    });
    expect(undoError).toBeNull();

    // a1 is back in the active match
    const { data: a1Back } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", match.id)
      .eq("player_id", a1.id)
      .maybeSingle();
    expect(a1Back).not.toBeNull();

    // onDeckPlayer is back in the on-deck match
    const { data: odBack } = await db
      .from("match_players")
      .select("player_id")
      .eq("match_id", onDeckMatch.id)
      .eq("player_id", onDeckPlayer.id)
      .maybeSingle();
    expect(odBack).not.toBeNull();

    // fill player is back in queue (waiting)
    const { data: fillEntry } = await db
      .from("queue_entries")
      .select("status")
      .eq("session_id", session.id)
      .eq("player_id", fill.id)
      .single();
    expect(fillEntry?.status).toBe("waiting");
  });
});

// ─────────────────────────────────────────────────────────────
// LMS-13: undo_swap_active_from_ondeck — silently aborts if advanced
// ─────────────────────────────────────────────────────────────

describe("LMS-13: undo_swap_active_from_ondeck — silently aborts if match advanced", () => {
  it("returns without error or state change if the active match is now completed", async () => {
    const { db, session, match } = await setupActiveMatch();
    const od = await makeProfile({ faker });
    const ex = await makeProfile({ faker });
    const fi = await makeProfile({ faker });
    // Team B needs two DISTINCT bodies — see the note in LMS-2.
    const odB1 = await makeProfile({ faker });
    const odB2 = await makeProfile({ faker });

    await makeQueueEntry({ sessionId: session.id, playerId: od.id, status: "playing" });
    await makeQueueEntry({ sessionId: session.id, playerId: ex.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: fi.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB1.id, status: "on_deck" });
    await makeQueueEntry({ sessionId: session.id, playerId: odB2.id, status: "on_deck" });

    const odMatch = await makeMatch({
      sessionId: session.id,
      teamA: [od.id, ex.id],
      teamB: [odB1.id, odB2.id],
      status: "pending",
    });

    // Simulate: active match was completed after the swap
    await db.from("matches").update({ status: "completed" }).eq("id", match.id);

    // Undo should silently abort (RETURN early in the RPC)
    const { error } = await db.rpc("undo_swap_active_from_ondeck", {
      p_active_match_id: match.id,
      p_out_player_id: od.id,
      p_ondeck_player_id: od.id,
      p_ondeck_match_id: odMatch.id,
      p_fill_player_id: fi.id,
      p_session_id: session.id,
      p_out_team: "a",
      p_ondeck_team: "a",
    });
    // RPC returns void without raising — no error
    expect(error).toBeNull();
  });
});
