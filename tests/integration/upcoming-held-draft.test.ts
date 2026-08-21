// ============================================================
// Suite UH — getUpcomingHeldDraft against real rows
// ============================================================
// upcoming-match.ts had NO test of any kind. It reads the matches table
// through createServiceClient() — RLS bypassed — and returns a fact about
// the CALLER. Four filters are all that separate "am I reserved?" from
// "who else is reserved, in any session, in any state?":
//
//     .eq("session_id", sessionId)
//     .eq("status", "pending")
//     .eq("is_held", true)
//     .contains("pulled_player_ids", [user.id])
//
// Delete the last one and the action reports every player's reservation to
// everyone. Delete the first and a draft leaks across sessions. Each of
// UH-5..UH-8 exists to make exactly one of those deletions fail.
//
//   UH-1  Negative: a malformed sessionId is rejected before auth is consulted
//   UH-2  Negative: an unauthenticated caller is rejected
//   UH-3  Happy:    no held draft → reserved:false, ready:false
//   UH-4  Happy:    caller is a pulled body, not yet ready → reserved, not ready
//   UH-5  Happy:    held_ready_at stamped → reserved AND ready
//   UH-6  Negative: ANOTHER player's held draft is invisible to this caller
//   UH-7  Negative: a held draft in a DIFFERENT session does not leak in
//   UH-8  Negative: a held draft whose match is no longer 'pending' is ignored
//
// ON SEEDING pulled_player_ids DIRECTLY: this suite covers the READ action,
// not the held-draft lifecycle, so seeding the state it reads is legitimate.
// (CLAUDE.md forbids hand-setting lifecycle columns in a test that claims to
// cover the lifecycle — the engine's own writing of held_ready_at is covered
// by Suite J, and nothing here claims otherwise.) Note `is_held` is a
// GENERATED column — cardinality(pulled_player_ids) > 0 — so it is never
// written directly; setting pulled_player_ids is what makes a draft held.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeCourt, makeMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { getUpcomingHeldDraft } from "@/app/actions/upcoming-match";

const faker = new Faker({ locale: [en] });
faker.seed(20260822);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Helpers ───────────────────────────────────────────────────

/** A session with four players and a court. */
async function seedSession() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  await makeCourt({ sessionId: session.id, name: "Court 1" });
  const players = await Promise.all(Array.from({ length: 4 }, () => makeProfile({ faker })));
  return { organizer, session, players };
}

/**
 * Turn a match into a held cross-court draft reserving `pulledIds`.
 *
 * `is_held` is GENERATED from cardinality(pulled_player_ids) > 0, so it is
 * never written — writing pulled_player_ids is what makes the row held.
 */
async function makeHeldDraft(opts: {
  sessionId: string;
  roster: string[];
  pulledIds: string[];
  readyAt?: string | null;
  status?: "pending" | "in_progress";
}) {
  const { sessionId, roster, pulledIds, readyAt = null, status = "pending" } = opts;
  const match = await makeMatch({
    sessionId,
    teamA: [roster[0], roster[1]],
    teamB: [roster[2], roster[3]],
    status,
  });

  const { error } = await serviceClient()
    .from("matches")
    .update({ pulled_player_ids: pulledIds, held_ready_at: readyAt })
    .eq("id", match.id);
  if (error) throw new Error(`[makeHeldDraft] ${error.message}`);

  // Guard the seed itself: if is_held did not become true the whole suite
  // would pass vacuously against rows that are not held drafts at all.
  const { data } = await serviceClient()
    .from("matches")
    .select("is_held, status")
    .eq("id", match.id)
    .single();
  if (!data?.is_held) {
    throw new Error("[makeHeldDraft] seeded row is not is_held — pulled_player_ids did not take");
  }
  return match;
}

// ─────────────────────────────────────────────────────────────

describe("Suite UH — getUpcomingHeldDraft", () => {
  it("UH-1 (negative): a malformed sessionId is rejected before authentication is consulted", async () => {
    // No auth is mocked. If the UUID guard did NOT run first, this would come
    // back "Not authenticated." instead — which is how the ordering is proven
    // without reaching into the module's internals.
    clearMockAuth();

    const res = await getUpcomingHeldDraft("not-a-uuid");

    expect(res.success).toBe(false);
    expect(
      res.success === false && res.error,
      "the UUID guard did not run before the auth gate"
    ).toMatch(/invalid session id/i);
  });

  it("UH-2 (negative): an unauthenticated caller is rejected", async () => {
    const { session } = await seedSession();
    clearMockAuth();

    const res = await getUpcomingHeldDraft(session.id);

    expect(res.success).toBe(false);
    expect(res.success === false && res.error).toMatch(/not authenticated/i);
  });

  it("UH-3: a player with no held draft is not reserved", async () => {
    const { session, players } = await seedSession();
    mockAuthAs(players[0].id);

    const res = await getUpcomingHeldDraft(session.id);

    expect(res.success).toBe(true);
    expect(res.success === true && res.upcoming).toEqual({ reserved: false, ready: false });
  });

  it("UH-4: the pulled body of a held draft is reserved but not ready until stamped", async () => {
    const { session, players } = await seedSession();
    await makeHeldDraft({
      sessionId: session.id,
      roster: players.map((p) => p.id),
      pulledIds: [players[0].id],
      readyAt: null,
    });
    mockAuthAs(players[0].id);

    const res = await getUpcomingHeldDraft(session.id);

    expect(res.success).toBe(true);
    expect(res.success === true && res.upcoming).toEqual({ reserved: true, ready: false });
  });

  it("UH-5: a stamped held_ready_at makes the reservation ready", async () => {
    const { session, players } = await seedSession();
    await makeHeldDraft({
      sessionId: session.id,
      roster: players.map((p) => p.id),
      pulledIds: [players[0].id],
      readyAt: new Date().toISOString(),
    });
    mockAuthAs(players[0].id);

    const res = await getUpcomingHeldDraft(session.id);

    expect(res.success).toBe(true);
    expect(res.success === true && res.upcoming).toEqual({ reserved: true, ready: true });
  });

  it("UH-6 (negative): another player's held draft is invisible to this caller", async () => {
    const { session, players } = await seedSession();
    // players[1] is the reserved body. players[0] is asking.
    await makeHeldDraft({
      sessionId: session.id,
      roster: players.map((p) => p.id),
      pulledIds: [players[1].id],
      readyAt: new Date().toISOString(),
    });

    mockAuthAs(players[0].id);
    const other = await getUpcomingHeldDraft(session.id);
    expect(
      other.success === true && other.upcoming.reserved,
      "a player was told they are reserved in a draft that belongs to someone else — " +
        '.contains("pulled_player_ids", [user.id]) is missing or bound to the wrong id'
    ).toBe(false);

    // ── Positive control: the SAME row, read by the player it really reserves.
    // Without this, UH-6 is equally satisfied by a query that finds nothing at all.
    mockAuthAs(players[1].id);
    const mine = await getUpcomingHeldDraft(session.id);
    expect(
      mine.success === true && mine.upcoming.reserved,
      "the reserved player could not see their own held draft, so the negative " +
        "assertion above proves nothing"
    ).toBe(true);
  });

  it("UH-7 (negative): a held draft in a different session does not leak in", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const player = a.players[0];

    // The SAME player is reserved — but in session B only.
    await makeHeldDraft({
      sessionId: b.session.id,
      roster: [player.id, b.players[1].id, b.players[2].id, b.players[3].id],
      pulledIds: [player.id],
      readyAt: new Date().toISOString(),
    });
    mockAuthAs(player.id);

    const inA = await getUpcomingHeldDraft(a.session.id);
    expect(
      inA.success === true && inA.upcoming.reserved,
      'a held draft from another session was reported — the .eq("session_id") filter is missing'
    ).toBe(false);

    // ── Positive control: asking about session B finds it.
    const inB = await getUpcomingHeldDraft(b.session.id);
    expect(
      inB.success === true && inB.upcoming.reserved,
      "the draft was not found even in its own session, so the cross-session " +
        "assertion above proves nothing"
    ).toBe(true);
  });

  it("UH-8 (negative): a held draft whose match has left 'pending' is ignored", async () => {
    const { session, players } = await seedSession();
    await makeHeldDraft({
      sessionId: session.id,
      roster: players.map((p) => p.id),
      pulledIds: [players[0].id],
      readyAt: new Date().toISOString(),
      status: "in_progress",
    });
    mockAuthAs(players[0].id);

    const res = await getUpcomingHeldDraft(session.id);

    expect(
      res.success === true && res.upcoming.reserved,
      'a match that already started was reported as an upcoming reservation — the .eq("status", "pending") filter is missing'
    ).toBe(false);
  });
});
