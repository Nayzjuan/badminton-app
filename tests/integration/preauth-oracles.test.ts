// ============================================================
// Suite PA — pre-authorization oracles (audit #12)
// ============================================================
// Five organizer-gated match actions each fetched the match row through the
// SERVICE client and answered a distinct message when that fetch came back
// empty — before a single authorization check had run. An authenticated
// caller who organizes nothing could therefore probe an arbitrary match UUID
// and learn, from the reply alone, whether the row existed and sometimes what
// status it was in. RLS is no backstop on a service-client read.
//
// The rule under test: a missing row carries no session_id and so cannot be
// authorized at all, which means "no such match" and "not your match" MUST
// answer identically — otherwise the difference between them is itself the
// answer. Everything after the gate may distinguish freely.
//
// This suite is about guard ORDER, not guard existence. Measured 2026-08-13:
// with all five pre-fix orderings restored at once, the ENTIRE pre-existing
// integration suite stayed green — 24 files / 278 tests — and only these five
// tests failed. Three of the five actions already had a "rejects non-organizer"
// test (`N-3`, `N-8`, `G-3b`/`F-cancel-3`) and all three passed with the gate in
// either position, because they only ever probe an existing match in the
// expected status — the single input for which both orderings answer the same
// thing. The other two are worse, not better: `endMatchAction`'s only auth test
// is *unauthenticated* (score-submission.test.ts:220), and `swapPlayerInMatch`
// had no authorization test at all (M-8/M-9/M-10 are organizer-driven state
// guards). Each test below probes the three inputs that separate the orderings:
//
//     (a) a real match in someone else's session   → "not yours"
//     (b) a real match in a state-revealing status → "not yours" (not the status)
//     (c) a syntactically valid, nonexistent UUID  → "not yours" (not "not found")
//
// and pins them to be byte-identical. Each test also carries a POSITIVE
// CONTROL: the true organizer still gets the distinguishing reply, so none of
// these can pass by flattening every caller's answer into one string.
//
// Perturbation: restoring any of the five original orderings makes (b) or (c)
// diverge from (a) and the test fails. That is the whole point — see
// close-session.test.ts Test 1b, the same shape for closeSession.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeCourt, makeMatch, makeCompletedMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import {
  endMatchAction,
  updateMatchDetails,
  cancelMatchAction,
} from "@/app/actions/match-lifecycle";
import { clearOnDeckMatch } from "@/app/actions/match-drafts";
import { swapPlayerInMatch } from "@/app/actions/swap-player";

const faker = new Faker({ locale: [en] });
faker.seed(12012);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared fixture ─────────────────────────────────────────────

/**
 * One session owned by `owner`, holding a match in each of the three statuses
 * these actions branch on, plus two callers who must not be able to tell those
 * apart: a stranger who organizes nothing, and the organizer of a DIFFERENT
 * session (cross-tenant — just as much a stranger for this session's rows).
 */
async function seedTenants() {
  const owner = await makeProfile({ faker, skill: "intermediate" });
  const session = await makeSession({ faker, organizer: owner.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

  const [p1, p2, p3, p4] = await Promise.all([
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
    makeProfile({ faker, skill: "intermediate" }),
  ]);

  const pending = await makeMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    status: "pending",
  });
  const inProgress = await makeMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    status: "in_progress",
    courtId: court.id,
    isPublished: true,
  });
  const completed = await makeCompletedMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    courtId: court.id,
  });

  // A second tenant: someone who genuinely organizes something, just not this.
  const otherOwner = await makeProfile({ faker });
  await makeSession({ faker, organizer: otherOwner.id });

  // Authenticated, organizes nothing at all.
  const stranger = await makeProfile({ faker });

  return {
    owner,
    otherOwner,
    stranger,
    session,
    players: [p1, p2, p3, p4],
    pending: pending.id,
    inProgress: inProgress.id,
    completed: completed.id,
    nonexistent: faker.string.uuid(),
  };
}

/**
 * Runs `probe` as `userId`, always restoring the auth mock.
 *
 * ⚠️ The mocked identity is ONE module-level global (`authState.currentUserId`
 * — see helpers/mock-auth.ts), so these probes must run SEQUENTIALLY. Batching
 * them through Promise.all interleaves the writes and every in-flight probe
 * ends up running as whichever caller happened to set the global last — which
 * would make this whole suite pass by accident, since all four probes would be
 * the same caller and would naturally agree.
 */
async function as<T>(userId: string, probe: () => Promise<T>): Promise<T> {
  const restore = mockAuthAs(userId);
  try {
    return await probe();
  } finally {
    restore();
  }
}

/** Asserts a match row is still in the status the fixture left it in. */
async function expectStatus(matchId: string, status: string) {
  const { data } = await serviceClient()
    .from("matches")
    .select("status")
    .eq("id", matchId)
    .single();
  expect(data?.status).toBe(status);
}

// ─────────────────────────────────────────────────────────────

describe("pre-authorization oracles — Suite PA", () => {
  // ── PA-1: endMatchAction ──────────────────────────────────
  // Was: the match fetch ran first and answered "Match not found." to any
  // authenticated caller; the `Match is already ${status}.` check then ran
  // ABOVE the organizer-OR-player gate, so a stranger also learned the status.

  it("PA-1: endMatchAction gives one answer for missing, foreign, and already-completed matches", async () => {
    const t = await seedTenants();
    const DENIED = "Not authorized. You must be a session organizer or a player in this match.";

    const onForeign = await as(t.stranger.id, () => endMatchAction(t.inProgress, 21, 15));
    const onCompleted = await as(t.stranger.id, () => endMatchAction(t.completed, 21, 15));
    const onMissing = await as(t.stranger.id, () => endMatchAction(t.nonexistent, 21, 15));
    const crossTenant = await as(t.otherOwner.id, () => endMatchAction(t.completed, 21, 15));

    expect(onForeign.message).toBe(DENIED);
    expect(onCompleted.message).toBe(onForeign.message);
    expect(onMissing.message).toBe(onForeign.message);
    expect(crossTenant.message).toBe(onForeign.message);
    expect([onForeign, onCompleted, onMissing, crossTenant].map((r) => r.success)).toEqual([
      false,
      false,
      false,
      false,
    ]);

    // Positive control — the organizer DOES learn the status.
    const owned = await as(t.owner.id, () => endMatchAction(t.completed, 21, 15));
    expect(owned.message).toBe("Match is already completed.");

    // A player in the match is authorized too, so the gate is not just "owner".
    const asPlayer = await as(t.players[0].id, () => endMatchAction(t.completed, 21, 15));
    expect(asPlayer.message).toBe("Match is already completed.");

    await expectStatus(t.inProgress, "in_progress");
  });

  // ── PA-2: updateMatchDetails ──────────────────────────────
  // Was: the fetch ran above the organizer gate and returned "Match not found."
  // The comment above the function reasoned carefully about the ORDER of score
  // validation vs the gate and still missed this, because it only considered
  // what runs after the gate.

  it("PA-2: updateMatchDetails gives one answer for missing and foreign matches", async () => {
    const t = await seedTenants();
    const DENIED = "Not authorized. Organizer access required.";

    // 🪤 Three DISTINCT and all-VALID score pairs, on purpose. The fixture seeds
    // 21-15 (makeCompletedMatch's defaults), the strangers attempt 25-23, the
    // positive control writes 30-28. Two earlier drafts got this wrong in two
    // different ways, and both made the read-back below true by construction:
    //   1. every caller sent 21-15, so the read-back ran after the owner's own
    //      successful 21-15 and could not tell "the stranger was rejected" from
    //      "the owner overwrote what the stranger wrote";
    //   2. the strangers then sent 99-0 — which exceeds MAX_BADMINTON_SCORE, so
    //      scoreSchema would have refused the write even with no gate at all.
    // An assertion about a rejected write only means something if that write
    // could otherwise have landed.
    const onForeign = await as(t.stranger.id, () => updateMatchDetails(t.completed, 25, 23));
    const onMissing = await as(t.stranger.id, () => updateMatchDetails(t.nonexistent, 25, 23));
    const crossTenant = await as(t.otherOwner.id, () => updateMatchDetails(t.completed, 25, 23));

    expect(onForeign.message).toBe(DENIED);
    expect(onMissing.message).toBe(onForeign.message);
    expect(crossTenant.message).toBe(onForeign.message);
    expect([onForeign, onMissing, crossTenant].map((r) => r.success)).toEqual([
      false,
      false,
      false,
    ]);

    // Nothing a stranger sent landed. Read back BEFORE the positive control
    // writes, so 25-23 is the only value that could be here by mistake — this
    // is what catches a reply that denies while the write goes through anyway.
    const { data: before } = await serviceClient()
      .from("matches")
      .select("team_a_score, team_b_score")
      .eq("id", t.completed)
      .single();
    expect(before?.team_a_score).toBe(21);
    expect(before?.team_b_score).toBe(15);

    // Score validation must stay BELOW the gate: an out-of-bounds payload from
    // a stranger still gets DENIED, not "Score cannot exceed 31." Otherwise the
    // authorization outcome reads as conditional on the request shape, and a
    // caller can separate "well-formed but unauthorized" from "malformed".
    // (Verified by perturbation: weaken the gate and this line reports
    // `expected 'Score cannot exceed 31.' to be 'Not authorized…'`.)
    const outOfBounds = await as(t.stranger.id, () => updateMatchDetails(t.completed, 99, 0));
    expect(outOfBounds.message).toBe(DENIED);

    // Positive control — the organizer's call on that same row succeeds, so the
    // denials above are about the caller and not about the arguments. Assert on
    // the row, not just the return value: a write that reports success and does
    // not land would still pass a bare `success === true` check.
    const owned = await as(t.owner.id, () => updateMatchDetails(t.completed, 30, 28));
    expect(owned.success).toBe(true);

    const { data: after } = await serviceClient()
      .from("matches")
      .select("team_a_score, team_b_score")
      .eq("id", t.completed)
      .single();
    expect(after?.team_a_score).toBe(30);
    expect(after?.team_b_score).toBe(28);
  });

  // ── PA-3: cancelMatchAction ───────────────────────────────

  it("PA-3: cancelMatchAction gives one answer for missing, foreign, and already-completed matches", async () => {
    const t = await seedTenants();
    const DENIED = "Not authorized. Organizer access required.";

    const onForeign = await as(t.stranger.id, () => cancelMatchAction(t.pending));
    const onCompleted = await as(t.stranger.id, () => cancelMatchAction(t.completed));
    const onMissing = await as(t.stranger.id, () => cancelMatchAction(t.nonexistent));
    const crossTenant = await as(t.otherOwner.id, () => cancelMatchAction(t.completed));

    expect(onForeign.message).toBe(DENIED);
    expect(onCompleted.message).toBe(onForeign.message);
    expect(onMissing.message).toBe(onForeign.message);
    expect(crossTenant.message).toBe(onForeign.message);

    // Positive control — the organizer still gets the status-revealing reply.
    const owned = await as(t.owner.id, () => cancelMatchAction(t.completed));
    expect(owned.message).toBe("Match is already completed.");

    await expectStatus(t.pending, "pending");
  });

  // ── PA-4: clearOnDeckMatch ────────────────────────────────
  // Was: `Match not found: <raw PostgREST error text>` — the leak carried the
  // database's own error string out to an unauthorized caller.

  it("PA-4: clearOnDeckMatch gives one answer for missing, foreign, and non-pending matches", async () => {
    const t = await seedTenants();
    const DENIED = "Not authorized. Organizer access required.";

    const onForeign = await as(t.stranger.id, () => clearOnDeckMatch(t.pending));
    const onInProgress = await as(t.stranger.id, () => clearOnDeckMatch(t.inProgress));
    const onMissing = await as(t.stranger.id, () => clearOnDeckMatch(t.nonexistent));
    const crossTenant = await as(t.otherOwner.id, () => clearOnDeckMatch(t.inProgress));

    expect(onForeign.message).toBe(DENIED);
    expect(onInProgress.message).toBe(onForeign.message);
    expect(onMissing.message).toBe(onForeign.message);
    expect(crossTenant.message).toBe(onForeign.message);
    // The old reply interpolated the PostgREST error; nothing DB-shaped may
    // reach a caller who has not been authorized.
    expect(onMissing.message).not.toMatch(/PGRST|coerce|JSON|row/i);

    // Positive control — the organizer learns why the clear was refused.
    const owned = await as(t.owner.id, () => clearOnDeckMatch(t.inProgress));
    expect(owned.message).toBe(
      'Cannot clear a match with status "in_progress". Only pending on-deck matches can be cleared.'
    );

    await expectStatus(t.pending, "pending");
  });

  // ── PA-5: swapPlayerInMatch ───────────────────────────────
  // Was a three-way oracle: "Match not found." / "…already started…" /
  // "Not authorized." The rule it broke was already written down in its own
  // file: swap-player.ts:62-67 states it for the sibling `swapMatchPlayers`,
  // 92 lines above the guard site that broke it (:159 is now the fix). A
  // rule written down in a file is not a rule applied in that file.

  it("PA-5: swapPlayerInMatch gives one answer for missing, foreign, and started matches", async () => {
    const t = await seedTenants();
    const [pOut, pIn] = [t.players[0].id, t.players[3].id];
    const strangerOut = faker.string.uuid();
    const strangerIn = faker.string.uuid();

    const onForeign = await as(t.stranger.id, () =>
      swapPlayerInMatch(t.pending, strangerOut, strangerIn)
    );
    const onStarted = await as(t.stranger.id, () =>
      swapPlayerInMatch(t.inProgress, strangerOut, strangerIn)
    );
    const onMissing = await as(t.stranger.id, () =>
      swapPlayerInMatch(t.nonexistent, strangerOut, strangerIn)
    );
    const crossTenant = await as(t.otherOwner.id, () =>
      swapPlayerInMatch(t.inProgress, strangerOut, strangerIn)
    );

    expect(onForeign.message).toBe("Match not found.");
    expect(onStarted.message).toBe(onForeign.message);
    expect(onMissing.message).toBe(onForeign.message);
    expect(crossTenant.message).toBe(onForeign.message);
    // errorCode is a second channel — the swap UI branches on it, not on the
    // message (use-swap-state.ts), so a message-only pin would miss a leak here.
    expect(onStarted.errorCode).toBe(onForeign.errorCode);
    expect(onMissing.errorCode).toBe(onForeign.errorCode);
    expect(crossTenant.errorCode).toBe(onForeign.errorCode);

    // Positive control — the organizer still gets the started-match reply, and
    // it is a DIFFERENT string from the one every stranger above received.
    const owned = await as(t.owner.id, () => swapPlayerInMatch(t.inProgress, pOut, pIn));
    expect(owned.message).toBe(
      "This match has already started — the swap was cancelled automatically."
    );
    expect(owned.message).not.toBe(onForeign.message);

    // The pending match's roster is untouched by any rejected swap.
    const { data: roster } = await serviceClient()
      .from("match_players")
      .select("player_id")
      .eq("match_id", t.pending);
    expect(roster).toHaveLength(4);
  });
});
