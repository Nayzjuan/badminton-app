// ============================================================
// Suite XS — the cross-session ledgers REBUILD; they do not accumulate
// ============================================================
// player_rivalries and player_partnerships are the club's all-time H2H and
// partner records. Until 20260812100000 the RPC that maintains them read ONE
// session and ADDed it onto the stored total, behind a one-shot guard that
// 20260510000000's header had already retracted as "not idempotence". The drift
// that produced was measured on production 2026-08-12 — 2342 rivalry rows
// stored against 3504 of truth — and MEMORY.md owns that breakdown.
//
// XS-1, XS-2 and XS-4 are discriminators — each was run against the restored
// additive function on 2026-08-12 and failed there (3 wins over 3 "sessions"
// instead of 2; 1 instead of 2; the unbacked row still standing at 9/9/9). Suite
// B's existing sessions_faced test does not distinguish them, because it only
// ever closes each session once, in order, with no gaps. XS-3 is the odd one
// out: it passes under BOTH functions and is here to pin a predicate the
// club-wide scan newly needs — see its own comment.
//
// Isolation: Layer B — truncateTracked() in afterEach (it clears both ledgers).
// The RPCs are real and run against the local DB.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeCompletedMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { queryCommitted } from "./helpers/withTx";
import { mockAuthAs } from "./helpers/mock-auth";
import { closeSession } from "@/app/actions/sessions";

const faker = new Faker({ locale: [en] });
faker.seed(4201);

afterEach(async () => {
  await truncateTracked();
});

/** The legacy club — sessions.club_id defaults to it, so every session the
 *  factories make lands in the same tenant, which is what these tests need. */
const LEGACY_CLUB_ID = "00000000-0000-0000-0000-000000000001";

// ── Helpers ────────────────────────────────────────────────────

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

async function readRivalry(playerId: string, rivalId: string) {
  const { data } = await serviceClient()
    .from("player_rivalries")
    .select("wins_vs, losses_vs, sessions_faced")
    .eq("player_id", playerId)
    .eq("rival_id", rivalId)
    .maybeSingle();
  return data;
}

async function readPartnership(playerId: string, partnerId: string) {
  const { data } = await serviceClient()
    .from("player_partnerships")
    .select("games_together, wins_together, losses_together, sessions_together")
    .eq("player_id", playerId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  return data;
}

// ─────────────────────────────────────────────────────────────

describe("cross-session ledgers — Suite XS", () => {
  // ── XS-1: the guard decays, so the add must not ────────────

  it("re-running the refresh for an older session does not double-count it", async () => {
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4] = await makeFour();

    const s1 = await makeSession({ faker, organizer: organizer.id });
    await makeCompletedMatch({
      sessionId: s1.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
    });
    await closeAs(s1.id, organizer.id);

    // The same four meet again. This is what disarms the old guard: it only
    // returned early when some ledger row still pointed at p_session_id, and
    // last_session_id is overwritten every time a pair meets. After this close,
    // every row from s1 carries s2 — so a refresh for s1 sails past the guard.
    const s2 = await makeSession({ faker, organizer: organizer.id });
    await makeCompletedMatch({
      sessionId: s2.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 19,
    });
    await closeAs(s2.id, organizer.id);

    expect(await readRivalry(p1.id, p3.id)).toEqual({
      wins_vs: 2,
      losses_vs: 0,
      sessions_faced: 2,
    });
    expect(await readPartnership(p1.id, p2.id)).toEqual({
      games_together: 2,
      wins_together: 2,
      losses_together: 0,
      sessions_together: 2,
    });

    const { error } = await serviceClient().rpc("refresh_cross_session_stats", {
      p_session_id: s1.id,
    });
    expect(error).toBeNull();

    // Additive body: 3 wins over 3 "sessions", 3 games together. Rebuild: unchanged.
    expect(await readRivalry(p1.id, p3.id)).toEqual({
      wins_vs: 2,
      losses_vs: 0,
      sessions_faced: 2,
    });
    expect(await readPartnership(p1.id, p2.id)).toEqual({
      games_together: 2,
      wins_together: 2,
      losses_together: 0,
      sessions_together: 2,
    });
  });

  // ── XS-2: a miss is permanent under an additive ledger ─────

  it("folds in a session that was never closed", async () => {
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4] = await makeFour();

    // Never closed — the same shape as a close whose step 0a failed, which is
    // non-fatal by design, or an evening that was simply abandoned. The additive
    // function had no path back to it: nothing ever revisited an old session.
    const abandoned = await makeSession({ faker, organizer: organizer.id });
    await makeCompletedMatch({
      sessionId: abandoned.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
    });

    const closed = await makeSession({ faker, organizer: organizer.id });
    await makeCompletedMatch({
      sessionId: closed.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 19,
    });
    await closeAs(closed.id, organizer.id);

    // Additive: 1 win over 1 session — the abandoned night is lost for good.
    expect(await readRivalry(p1.id, p3.id)).toEqual({
      wins_vs: 2,
      losses_vs: 0,
      sessions_faced: 2,
    });
  });

  // ── XS-3: the club-wide scan must still skip sandbox rows ──

  it("never lets a hidden session reach the ledgers", async () => {
    const organizer = await makeProfile({ faker });
    const [h1, h2, h3, h4] = await makeFour();

    // Infrastructure sessions were kept out for free while the function only
    // ever looked at the one session being closed. A club-wide scan has to
    // exclude them explicitly, for the reason 20260804000000 gives: these
    // ledgers CACHE a cross-session aggregate, so a sandbox match that lands in
    // them stays until something else overwrites the row.
    const hidden = await makeSession({ faker, organizer: organizer.id });
    // Raw SQL because is_hidden is deliberately absent from SessionUpdate —
    // nothing in the app flips it; 20260721101500 set it by hand. sessions is on
    // truncate.ts's list, so this write is cleaned up like any other.
    await queryCommitted("update public.sessions set is_hidden = true where id = $1", [hidden.id]);
    await makeCompletedMatch({
      sessionId: hidden.id,
      teamA: [h1.id, h2.id],
      teamB: [h3.id, h4.id],
      scoreA: 21,
      scoreB: 15,
    });

    const [p1, p2, p3, p4] = await makeFour();
    const real = await makeSession({ faker, organizer: organizer.id });
    await makeCompletedMatch({
      sessionId: real.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
    });
    await closeAs(real.id, organizer.id);

    expect(await readRivalry(h1.id, h3.id)).toBeNull();
    expect(await readPartnership(h1.id, h2.id)).toBeNull();
    // ...and the real session in the same club still landed.
    expect(await readRivalry(p1.id, p3.id)).not.toBeNull();
  });

  // ── XS-4: rows with no match backing are retracted ─────────

  it("prunes a ledger row that no match backs any more", async () => {
    const organizer = await makeProfile({ faker });
    const [p1, p2, p3, p4] = await makeFour();
    const ghost = await makeProfile({ faker });

    // Stands in for what an identity merge, a deleted match or a swap
    // correction leaves behind. Production carried 2 of these on
    // player_partnerships. An add-only ledger can never take a row back.
    await serviceClient().from("player_rivalries").insert({
      club_id: LEGACY_CLUB_ID,
      player_id: p1.id,
      rival_id: ghost.id,
      wins_vs: 9,
      losses_vs: 9,
      sessions_faced: 9,
      last_session_id: null,
      last_faced_at: null,
    });

    const session = await makeSession({ faker, organizer: organizer.id });
    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      scoreA: 21,
      scoreB: 15,
    });
    await closeAs(session.id, organizer.id);

    expect(await readRivalry(p1.id, ghost.id)).toBeNull();
    expect(await readRivalry(p1.id, p3.id)).not.toBeNull();
  });
});
