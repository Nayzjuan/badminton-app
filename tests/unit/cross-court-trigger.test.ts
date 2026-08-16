// ============================================================
// Unit Tests: Cross-Court Trigger — the decision to reach for a fresher four
// ============================================================
//
// Cross-court held drafts pull ONE body off a live court to complete a four.
// Every downstream helper (fetchPullablePlayers, executeHeldMatch, the
// promotion TS-filter, recomputeHeldReadiness) already had coverage in
// matchmaking-engine.test.ts — and the feature still produced ZERO held drafts
// across 945 production matches, because nothing tested whether the engine ever
// DECIDES to reach. That is the gap this file closes.
//
// Three independent blockers were fixed, and each gets its own section:
//
//   The courts-stay-fed gate (hasFeedableCapacity) — was the proxy `i > 0`,
//   meaning "not the first draft of this run". 91% of engine runs commit
//   exactly one draft, so the branch was unreachable by construction. The
//   invariant it was standing in for is "a freeing court still has something to
//   promote", which is what hasFeedableCapacity asks — as CAPACITY (feedable >
//   held), since a held draft is is_held and so never consumes the spare it was
//   authorised against.
//
//   The trigger (wantsFresherFour / pullImprovesFreshness) — was
//   `forcedRepeat` alone, which fires only when the engine has already failed
//   (22/550 replayed matches, 4%) and gets RARER as waiting-pool selection
//   improves. Widened to consecutive-opponent staleness, the metric P2
//   optimises and the one players actually complain about.
//
//   The selection (buildCrossCourtProposal) — the blocker that survived fixing
//   the other two. The producer appended pulled bodies to the pool at
//   priorityScore -1 and asked runAlgorithm to choose between them and the
//   waiting players. That never worked, because the body's score is not what
//   decides: buildCombinationGroup's argmin ranks whole TRIPLES by
//   `fairness + 3 × repeats`, and the repeats term is a property of the four.
//   The pull is now FORCED into every candidate four and judged on freshness
//   alone, with fairness preserved structurally (the anchor is in every
//   candidate) rather than by scoring. CCT-BUILD-1 asserts the old behaviour so
//   the deadlock cannot quietly return.
//
//   ⚠️ The arithmetic here is deliberately NOT restated — the canonical
//   derivation, plus the three wrong versions of it, lives on
//   buildCrossCourtProposal in src/lib/matchmaking-core.ts. This file is
//   untracked-new, so a `git diff`-driven sweep cannot see stale copies in it;
//   grep the working tree, not the diff.
//
//   Scope note: blockers 1 and 2 are what produced the 0/945. This third one is
//   what would have kept the feature near-useless after fixing them.
//
// Cases covered:
//   CCT-FEED-1: a feedable match, no held draft ⇒ authorised
//   CCT-FEED-2: no pending match at all ⇒ refused (nothing would feed a court)
//   CCT-FEED-3: query error ⇒ FAILS CLOSED (an idle court is the worse loss)
//   CCT-FEED-4: null data on a clean read ⇒ refused (same fail-closed floor)
//   CCT-FEED-5: the query is scoped to this session's PENDING matches
//   CCT-FEED-6: held drafts cannot STACK against one feedable match
//   CCT-FEED-7: a NULL is_held counts as feedable, not held
//   CCT-FEED-8: the UNREADY-hold ceiling — the second, absolute bound that
//               replaced the draft cap's accidental one
//   CCT-TRIG-1: forcedRepeat arms the reach even at zero staleness
//   CCT-TRIG-2: staleness alone arms it — the case the old trigger missed
//   CCT-TRIG-3: fresh four + no forced repeat ⇒ no reach, no queries spent
//   CCT-TRIG-4: undefined forcedRepeat is treated as false, not truthy
//   CCT-ACC-1: freshness path REJECTS a pull that does not reduce staleness
//   CCT-ACC-2: freshness path REJECTS a pull that makes staleness worse
//   CCT-ACC-3: freshness path ACCEPTS a strict reduction
//   CCT-ACC-4: forced-repeat path keeps its original (weaker) acceptance
//   CCT-WIRE-1: the predicates agree with countConsecutiveOpponentRepeats on
//               real splits — the policy is bound to the metric, not a proxy
//   CCT-ANCH-1: the anchor guard's boundary, both sides (16 reaches, 17 refuses)
//   CCT-ANCH-2: the Red-Zone score arm refuses on score alone
//   CCT-ANCH-3: the two arms are nested, not independent
//   CCT-ANCH-4: a below-floor Red-Zone score is still caught by the wait arm
//   CCT-BUILD-1: the deadlock reproduced, then broken
//   CCT-BUILD-2: the ANCHOR is in every candidate four (fairness)
//   CCT-BUILD-3: exactly one pulled body is seated
//   CCT-BUILD-4: null when no candidate beats baseStaleness
//   CCT-BUILD-5: the forced-repeat path accepts without a staleness drop
//   CCT-BUILD-6: null with no body, or too few waiting players
//   CCT-BUILD-7: seats rank fresh-FIRST — games-ahead outranks staleness
//   CCT-BUILD-8: gamesAhead is measured off the SEAT pool's minimum
//   CCT-LOOK-1:  positive control — unblocked, the first four IS taken
//   CCT-LOOK-2:  a four blocked only by the OUTER lookback is rejected
//   CCT-LOOK-3:  the inner window is still honoured
//   CCT-LOOK-4:  a rejected roster is never re-served by the reach
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { hasFeedableCapacity, type DbClient } from "@/lib/matchmaking-db";
import {
  wantsFresherFour,
  pullImprovesFreshness,
  anchorBlocksReach,
  countConsecutiveOpponentRepeats,
  buildCrossCourtProposal,
  isDiversityViolation,
  runAlgorithm,
  computePriorityScore,
  type ScoredPlayer,
  type LastOpponents,
} from "@/lib/matchmaking-core";
import {
  CRITICAL_WAIT_MINUTES,
  CROSS_COURT_MAX_UNREADY_HOLDS,
  CROSS_COURT_REST_FALLBACK_MINUTES,
  HARD_WAIT_CAP_MINUTES,
  RED_ZONE_SCORE_FLOOR,
} from "@/lib/constants";
import type { QueueWithWaitTime } from "@/types/database";

const SESSION_ID = "sess-1";

// ── Mock factory ─────────────────────────────────────────────
// hasFeedableCapacity issues ONE query:
//   from("matches").select("is_held, held_ready_at").eq(session).eq(status pending)
// and compares the two populations itself. The chain records every filter so
// the tests can assert the query SHAPE, not just its result — a guard that
// returned the right boolean off the wrong predicate would be
// indistinguishable otherwise.
//
// `rows` is the pending-match population: is_held true = a held draft (seats
// nobody yet), false = a feedable match (a freeing court can take it). A held
// row with a null held_ready_at is additionally UNREADY — the pulled body is
// still on court — which is what the second bound counts.

type Filter = { op: string; args: unknown[] };

function makeCountMock(result: {
  data: { is_held: boolean | null; held_ready_at?: string | null }[] | null;
  error: { message: string } | null;
}) {
  const filters: Filter[] = [];
  const tables: string[] = [];
  let selectArgs: unknown[] = [];

  const chain: Record<string, unknown> = {};
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      filters.push({ op, args });
      return chain;
    };
  chain["select"] = vi.fn((...args: unknown[]) => {
    selectArgs = args;
    return chain;
  });
  chain["eq"] = vi.fn(record("eq"));
  chain["then"] = (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);

  const client = {
    from: vi.fn((table: string) => {
      tables.push(table);
      return chain;
    }),
  } as unknown as DbClient;

  return { client, filters, tables, selectArgs: () => selectArgs };
}

/**
 * Pending-match population: `feedable` promotable matches + `held` held drafts
 * + `readyHeld` held drafts whose hold has already resolved.
 *
 * Held rows default to UNREADY (held_ready_at null), which is what a hold looks
 * like the instant it is created — and the only kind CROSS_COURT_MAX_UNREADY_HOLDS
 * counts. A READY hold is publishable and promotable, so it is not parking anyone.
 */
function rows(feedable: number, held: number, readyHeld = 0) {
  return [
    ...Array.from({ length: feedable }, () => ({ is_held: false, held_ready_at: null })),
    ...Array.from({ length: held }, () => ({ is_held: true, held_ready_at: null })),
    ...Array.from({ length: readyHeld }, () => ({
      is_held: true,
      held_ready_at: "2026-08-16T00:00:00.000Z",
    })),
  ];
}

// ── Player factory (mirrors matchmaking-core.test.ts) ─────────

function makePlayer(id: string, skillInt = 3, waitMinutes = 5, gamesPlayed = 1): ScoredPlayer {
  const base: QueueWithWaitTime = {
    id: `entry-${id}`,
    session_id: SESSION_ID,
    player_id: id,
    joined_at: new Date(Date.now() - waitMinutes * 60_000).toISOString(),
    games_played: gamesPlayed,
    status: "waiting",
    position: null,
    is_paused: false,
    created_at: new Date().toISOString(),
    display_name: `Player-${id}`,
    skill_level: "intermediate",
    skill_level_int: skillInt,
    wait_minutes: waitMinutes,
    is_bottleneck: false,
  };
  return { ...base, priorityScore: computePriorityScore(base) };
}

// ─────────────────────────────────────────────────────────────
// The courts-stay-fed gate
// ─────────────────────────────────────────────────────────────

describe("hasFeedableCapacity — the courts-stay-fed gate", () => {
  it("CCT-FEED-1: a feedable match with no held draft ⇒ authorised", async () => {
    const { client } = makeCountMock({ data: rows(1, 0), error: null });
    expect(await hasFeedableCapacity(client, SESSION_ID)).toBe(true);
  });

  it("CCT-FEED-2: no pending match at all ⇒ refused", async () => {
    // A held draft seats nobody at creation. With nothing else pending it would
    // be the only thing between a freeing court and a match — an idle court.
    const { client } = makeCountMock({ data: rows(0, 0), error: null });
    expect(await hasFeedableCapacity(client, SESSION_ID)).toBe(false);
  });

  it("CCT-FEED-3: query error ⇒ fails CLOSED", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeCountMock({ data: null, error: { message: "boom" } });

    // Skipping the reach costs a slightly staler match; wrongly authorising it
    // costs an idle court, which is the one thing this gate exists to prevent.
    expect(await hasFeedableCapacity(client, SESSION_ID)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("CCT-FEED-4: null data on a clean read ⇒ refused", async () => {
    const { client } = makeCountMock({ data: null, error: null });
    expect(await hasFeedableCapacity(client, SESSION_ID)).toBe(false);
  });

  it("CCT-FEED-5: reads is_held + held_ready_at for PENDING matches in this session only", async () => {
    const { client, filters, tables, selectArgs } = makeCountMock({
      data: rows(2, 0),
      error: null,
    });
    await hasFeedableCapacity(client, SESSION_ID);

    expect(tables).toEqual(["matches"]);
    // Both columns must be SELECTED, not filtered away: is_held for the
    // stacking bound (the guard has to see the held population to know whether
    // the feedable one still outnumbers it), held_ready_at for the unready-hold
    // ceiling (CCT-FEED-8) — dropping it makes every hold look READY and the
    // ceiling never fires.
    expect(selectArgs()[0]).toBe("is_held, held_ready_at");

    const eqs = filters.filter((f) => f.op === "eq").map((f) => f.args);
    expect(eqs).toContainEqual(["session_id", SESSION_ID]);
    expect(eqs).toContainEqual(["status", "pending"]);
  });

  it("CCT-FEED-6: held drafts cannot STACK against a single feedable match", async () => {
    // The bug an existence check hides. A held draft is is_held, so it never
    // consumes the spare it was authorised against — one pending match would
    // authorise every slot in the run. 12 waiting at a cap of 3 then yields
    // 1 promotable match + 2 held drafts holding 6 players, and when two courts
    // free, one promotes and the other IDLES.
    const first = makeCountMock({ data: rows(1, 0), error: null });
    expect(await hasFeedableCapacity(first.client, SESSION_ID)).toBe(true);

    // Slot 1, after that held draft committed: 1 feedable, 1 held. Refused.
    const second = makeCountMock({ data: rows(1, 1), error: null });
    expect(await hasFeedableCapacity(second.client, SESSION_ID)).toBe(false);

    // A second feedable match earns the second held draft honestly.
    const backed = makeCountMock({ data: rows(2, 1), error: null });
    expect(await hasFeedableCapacity(backed.client, SESSION_ID)).toBe(true);
  });

  it("CCT-FEED-7: a NULL is_held row counts as feedable, not held", async () => {
    // is_held is generated from cardinality(pulled_player_ids), and that SOURCE
    // column is `uuid[] NOT NULL DEFAULT '{}'` — so a NULL flag is unreachable
    // and this row cannot occur. Pinned anyway because the arm it exercises is a
    // deliberate choice: a null must not be read as "held" and silently tighten
    // the gate into never authorising. See the comment in hasFeedableCapacity.
    const { client } = makeCountMock({ data: [{ is_held: null }], error: null });
    expect(await hasFeedableCapacity(client, SESSION_ID)).toBe(true);
  });

  it("CCT-FEED-8: at most CROSS_COURT_MAX_UNREADY_HOLDS unresolved holds, however many spares back them", async () => {
    // The SECOND bound, and the one the stacking rule above cannot express.
    // feedable > held is a RATIO: a session with enough pending matches satisfies
    // it at any hold count, and the draft cap used to be what actually stopped
    // the third hold — by accident, back when every unpublished draft counted
    // against it. Draft mode now excludes unready holds from that count (they are
    // unpublishable, so a cap slot spent on one is a slot nothing can free), which
    // removed the accidental ceiling and left nothing bounding how many bodies can
    // be parked at once. This is the deliberate replacement.
    //
    // 5 feedable vs 2 unready holds passes the ratio comfortably and is still
    // refused. Each hold parks 3 waiting players, so 2 is a 6-player budget.
    const atCeiling = makeCountMock({ data: rows(5, CROSS_COURT_MAX_UNREADY_HOLDS), error: null });
    expect(await hasFeedableCapacity(atCeiling.client, SESSION_ID)).toBe(false);

    // One below the ceiling, same ratio ⇒ authorised. Pins that it is the hold
    // COUNT being refused above and not the fixture's shape.
    const below = makeCountMock({
      data: rows(5, CROSS_COURT_MAX_UNREADY_HOLDS - 1),
      error: null,
    });
    expect(await hasFeedableCapacity(below.client, SESSION_ID)).toBe(true);

    // READY holds are exempt. They are publishable and promotable — nobody is
    // parked behind an unfinished game — so a session that has resolved its holds
    // may reach again. Counting them here would make the ceiling a lifetime
    // budget per session rather than a concurrency limit.
    const resolved = makeCountMock({
      data: rows(5, 0, CROSS_COURT_MAX_UNREADY_HOLDS + 1),
      error: null,
    });
    expect(await hasFeedableCapacity(resolved.client, SESSION_ID)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// The trigger
// ─────────────────────────────────────────────────────────────

describe("wantsFresherFour — when to reach", () => {
  it("CCT-TRIG-1: forcedRepeat arms the reach even at zero staleness", () => {
    expect(wantsFresherFour(true, 0)).toBe(true);
  });

  it("CCT-TRIG-2: staleness alone arms it — the case the old trigger missed", () => {
    // The whole point of the widening. Under the old `forcedRepeat`-only
    // trigger this returned false, and the reach never happened.
    expect(wantsFresherFour(false, 1)).toBe(true);
    expect(wantsFresherFour(false, 4)).toBe(true);
  });

  it("CCT-TRIG-3: a fresh four with no forced repeat ⇒ no reach", () => {
    // Guards the cost side: fetchPullablePlayers and the head count must not
    // run on every engine tick, only when the four is actually stale.
    expect(wantsFresherFour(false, 0)).toBe(false);
  });

  it("CCT-TRIG-4: undefined forcedRepeat is false, not truthy", () => {
    // runAlgorithm's result type declares forcedRepeat as optional.
    expect(wantsFresherFour(undefined, 0)).toBe(false);
    expect(wantsFresherFour(undefined, 2)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// The acceptance test
// ─────────────────────────────────────────────────────────────

describe("pullImprovesFreshness — whether the reach earned its cost", () => {
  it("CCT-ACC-1: freshness path REJECTS a pull that does not reduce staleness", () => {
    // The non-vacuous case. Pulling a body off a live court to land on a four
    // that is exactly as stale as the one already in hand is pure cost.
    expect(pullImprovesFreshness(false, 2, 2)).toBe(false);
  });

  it("CCT-ACC-2: freshness path REJECTS a pull that makes staleness worse", () => {
    expect(pullImprovesFreshness(false, 1, 3)).toBe(false);
  });

  it("CCT-ACC-3: freshness path ACCEPTS a strict reduction", () => {
    expect(pullImprovesFreshness(false, 2, 1)).toBe(true);
    expect(pullImprovesFreshness(false, 1, 0)).toBe(true);
  });

  it("CCT-ACC-4: forced-repeat path keeps its original, weaker acceptance", () => {
    // Untouched by design: when the pool could produce nothing but a repeat,
    // any non-repeat four is an improvement, so equal staleness still passes.
    // The caller's `!augResult.forcedRepeat` check is what carries this path.
    expect(pullImprovesFreshness(true, 2, 2)).toBe(true);
    expect(pullImprovesFreshness(true, 0, 3)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// The anchor guard — the one knob with a MEASURED reach cost
// ─────────────────────────────────────────────────────────────
// Dropping `i > 0` made pool[0] the session's LONGEST waiter rather than the
// 5th-longest, so this guard is what stops the reach holding someone who is
// about to need a court. It refuses 22 percentage points more production
// auto-matches than the Red-Zone check it replaced, which makes it the single
// most expensive line in the feature — and until these cases existed, moving
// the threshold from 17 to 25, or deleting the guard outright, left the whole
// suite green.
//
//   CCT-ANCH-1: the boundary, both sides — 16 reaches, 17 refuses; the margin
//               is derived from the constants, not hardcoded
//   CCT-ANCH-2: the Red-Zone arm still refuses on score alone
//   CCT-ANCH-3: the arms are NESTED, not independent (the drift guard)
//   CCT-ANCH-4: a below-floor Red-Zone score is still caught, by the wait arm

describe("anchorBlocksReach — never hold a player who is about to need a court", () => {
  const MARGIN = CRITICAL_WAIT_MINUTES - CROSS_COURT_REST_FALLBACK_MINUTES;

  it("CCT-ANCH-1: refuses AT the margin and allows one minute below it", () => {
    // Pinning both sides is the point: a one-sided assertion passes on a guard
    // that refuses everything.
    expect(anchorBlocksReach(6, MARGIN - 1)).toBe(false);
    expect(anchorBlocksReach(6, MARGIN)).toBe(true);
    expect(anchorBlocksReach(6, MARGIN + 1)).toBe(true);
  });

  it("CCT-ANCH-2: the Red-Zone score arm refuses regardless of the wait figure", () => {
    // wait_minutes is nullable upstream and coalesces to 0; a Red-Zone score
    // must still refuse, or a null read would hold a critical player.
    expect(anchorBlocksReach(RED_ZONE_SCORE_FLOOR, 0)).toBe(true);
    expect(anchorBlocksReach(RED_ZONE_SCORE_FLOOR + 14, 0)).toBe(true);
  });

  it("CCT-ANCH-3: the score arm is currently SUBSUMED by the wait arm", () => {
    // computePriorityScore only reaches RED_ZONE_SCORE_FLOOR through the
    // wait >= 20 and wait >= 25 tiers, both above the margin — so on real
    // scores the wait arm already refuses everything the score arm would.
    // This pins that nesting so the redundancy stays deliberate rather than
    // becoming a silent behaviour change if a constant moves.
    expect(MARGIN).toBeLessThan(CRITICAL_WAIT_MINUTES);
    // Count the firings: the assertion is inside a conditional, so without this
    // a future GAME_PENALTY_MINUTES bump would push every iteration below the
    // floor and the test would pass having asserted nothing — the exact
    // constant-drift it exists to catch.
    let redZoneCases = 0;
    for (const wait of [CRITICAL_WAIT_MINUTES, HARD_WAIT_CAP_MINUTES, 40]) {
      const score = computePriorityScore(makePlayer("x", 3, wait));
      if (score >= RED_ZONE_SCORE_FLOOR) {
        redZoneCases += 1;
        expect(anchorBlocksReach(0, wait)).toBe(true);
      }
    }
    expect(redZoneCases).toBe(3);
  });

  it("CCT-ANCH-4: a below-floor Red-Zone score is still caught, by the wait arm", () => {
    // The latent trap this guard incidentally covers: the Tier-2 formula is
    // 1000 + wait - games×8, which dips BELOW 1000 whenever the game penalty
    // exceeds the wait (wait 22, 3 games → 998). `score >= RED_ZONE_SCORE_FLOOR`
    // is therefore not a sound red-zone test on its own. The wait arm does not
    // care about the score at all, so it catches the case anyway.
    const stale = { ...makePlayer("y", 3, 22), games_played: 3 };
    const score = computePriorityScore(stale);
    expect(score).toBeLessThan(RED_ZONE_SCORE_FLOOR);
    expect(anchorBlocksReach(score, 22)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Wiring: policy ↔ metric
// ─────────────────────────────────────────────────────────────

describe("the trigger is bound to countConsecutiveOpponentRepeats", () => {
  it("CCT-WIRE-1: a rematch four arms the reach; swapping in a fresh body accepts it", () => {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((id) => makePlayer(id));

    // a+b just played c+d. The waiting-only four is that same game again:
    // all four face a last-game opponent ⇒ staleness 4.
    const lastOpponents: LastOpponents = new Map([
      ["a", new Set(["c", "d"])],
      ["b", new Set(["c", "d"])],
      ["c", new Set(["a", "b"])],
      ["d", new Set(["a", "b"])],
    ]);

    const baseSplit = { teamA: [a, b], teamB: [c, d] };
    const baseStaleness = countConsecutiveOpponentRepeats(baseSplit, lastOpponents);
    expect(baseStaleness).toBe(4);
    expect(wantsFresherFour(false, baseStaleness)).toBe(true);

    // Pull `e` off a live court in place of `d`: a and b still face c, and c
    // still faces both of them, but `e` is fresh to everyone. 4 → 3.
    const augSplit = { teamA: [a, b], teamB: [c, e] };
    const augStaleness = countConsecutiveOpponentRepeats(augSplit, lastOpponents);
    expect(augStaleness).toBe(3);
    expect(pullImprovesFreshness(false, baseStaleness, augStaleness)).toBe(true);

    // A reshuffle of the SAME four buys nothing, and this is the case the
    // strict inequality exists to reject: swapping partners still leaves every
    // player across the net from someone they just faced (a↔d, c↔b, b↔c, d↔a).
    const sideways = { teamA: [a, c], teamB: [b, d] };
    const sidewaysStaleness = countConsecutiveOpponentRepeats(sideways, lastOpponents);
    expect(sidewaysStaleness).toBe(4);
    expect(pullImprovesFreshness(false, baseStaleness, sidewaysStaleness)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// buildCrossCourtProposal — the forced pull
// ─────────────────────────────────────────────────────────────
// The third blocker, and the one that survived fixing the trigger and the gate.
// The old producer appended pulled bodies to the pool at priorityScore -1 and
// let runAlgorithm choose. On the pool below that returns the waiting-only four
// and silently drops the pull. That is an assertion about THIS pool, not a
// universal — whether a body wins depends on the repeats term across the whole
// four, not on its own score (see buildCrossCourtProposal for the derivation).
//
//   CCT-BUILD-1: the deadlock, reproduced — the OLD augmented-pool approach
//                returns the same four; the new search returns a fresher one
//   CCT-BUILD-2: the ANCHOR is in the four — the one structural fairness
//                invariant. ⚠️ NOT "the longest waiter": pool[0] is the
//                highest-PRIORITY player, and priorityScore subtracts games.
//   CCT-BUILD-3: exactly one pulled body is seated
//   CCT-BUILD-4: null when no candidate four beats baseStaleness
//   CCT-BUILD-5: forced-repeat path accepts without a staleness drop
//   CCT-BUILD-6: null when there is no body, or too few waiting players
//   CCT-BUILD-7: the two SEAT slots rank games-ahead before staleness — the
//                seats are not structurally fair, so the ranking is the only
//                thing imposing fresh-first on them
//   CCT-BUILD-8: gamesAhead is relative to the SEAT pool's minimum, not the
//                whole pool's — otherwise it never reaches 0 and the early
//                return is dead

describe("buildCrossCourtProposal — the forced pull", () => {
  // a0 last-faced a1; a2 last-faced a1 in an older game; w and p4 are fresh.
  // Every candidate four overlaps a recent roster by at most 2, so the ≥3
  // diversity rule never fires and the search is judged purely on freshness.
  const lastOpponents: LastOpponents = new Map([
    ["a0", new Set(["a1", "q"])],
    ["a1", new Set(["a0", "q"])],
    ["a2", new Set(["a1", "r"])],
  ]);
  const recentRosters = [
    ["a0", "p", "a1", "q"],
    ["a2", "s", "a1", "r"],
  ];

  // Distinct wait times, sorted by priority — pool[0] = a0 is the anchor. The
  // SPREAD is load-bearing, and the first version of this fixture (everyone at
  // wait 5) INVERTED the bug rather than hiding it: at one game each, Tier 1
  // scores wait − 8, so a flat pool at 5 puts every waiter at −3 and the body
  // at −1 sorts AHEAD of them. The old code then picked the body for the wrong
  // reason and the test "passed" against a fixture that could not express the
  // defect. With this spread the waiters score 6/4/2/0, and swapping a2 (2) for
  // the body costs 1 + 2 = 3 fairness against the 3 that one saved repeat buys
  // — a dead tie the strict `<` resolves for the incumbent. That is the bug.
  const WAITS: Record<string, number> = { a0: 14, a1: 12, a2: 10, w: 8 };
  const waiting = () => ["a0", "a1", "a2", "w"].map((id) => makePlayer(id, 3, WAITS[id]));
  const bodies = () => [{ ...makePlayer("p4"), priorityScore: -1, isPulled: true as const }];

  const args = (over: Partial<Parameters<typeof buildCrossCourtProposal>[2]> = {}) => ({
    partnershipCounts: new Map<string, number>(),
    overlapMap: new Map<string, number>(),
    recentRosters,
    opponentCounts: new Map<string, number>(),
    rejectedRosters: [] as string[][],
    lastOpponents,
    baseStaleness: 1,
    forcedRepeat: undefined as boolean | undefined,
    ...over,
  });

  const ids = (p: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }) =>
    [...p.teamA, ...p.teamB].map((x) => x.player_id).sort();

  it("CCT-BUILD-1: reproduces the deadlock, then breaks it", () => {
    const pool = waiting();

    // The OLD approach: append the body at -1 and let runAlgorithm choose.
    const augmented = [...pool, ...bodies()];
    const old = runAlgorithm(
      augmented,
      new Map(),
      new Map(),
      recentRosters,
      new Map(),
      [],
      lastOpponents
    );
    const oldFour = old.proposal ? ids(old.proposal) : [];

    // It hands back the waiting-only four: here the fairness gap (3) exactly
    // cancels the repeat saving (3 × 1), so the two fours tie and the strict `<`
    // keeps the incumbent. This is the bug, asserted rather than described.
    expect(oldFour).not.toContain("p4");
    expect(countConsecutiveOpponentRepeats(old.proposal!, lastOpponents)).toBe(1);

    // The new search forces the pull and finds a strictly fresher four.
    const pick = buildCrossCourtProposal(pool, bodies(), args());
    expect(pick).not.toBeNull();
    expect(ids(pick!.proposal)).toContain("p4");
    expect(pick!.staleness).toBeLessThan(1);
  });

  it("CCT-BUILD-2: the anchor is always seated (fairness invariant)", () => {
    const pick = buildCrossCourtProposal(waiting(), bodies(), args());
    // a0 is pool[0]. The reach must never let a player still mid-game jump
    // ahead of the front of the queue.
    //
    // ⚠️ pool[0] is the HIGHEST-PRIORITY player, not "the longest waiter" —
    // this test used to be named for the latter. scoreAndSortPool sorts by
    // priorityScore, which subtracts games_played × GAME_PENALTY_MINUTES, so a
    // longer waiter with more games sorts BELOW a fresher short waiter. That
    // distinction is the whole reason CCT-BUILD-8 (below) exists.
    expect(ids(pick!.proposal)).toContain("a0");
  });

  it("CCT-BUILD-7: seat pairs are ranked FRESH-FIRST — staleness only separates within a games-ahead tier", () => {
    // Two seat pairs are available to complete the four. The game-heavy pair
    // would buy one extra unit of freshness; the fresh pair would not. The
    // engine's own weighting makes games-ahead dominate staleness by 833×
    // (GAMES_AHEAD_PENALTY 10_000 vs 4 seats × CONSECUTIVE_OPPONENT_PENALTY 3),
    // so the fresh pair must win outright.
    //
    // Ranking on staleness ALONE — what this did before review — inverted that:
    // with exactly 4 players the inner buildCombinationGroup has no choice to
    // make, so no fairness term participates in seat selection at all, and the
    // sole criterion was the staleness argmin.
    const anchor = makePlayer("a0", 3, 14, 1);
    // Fresh pair: at the seat pool's minimum games. Sorted above the heavy pair
    // by priorityScore, so iteration reaches them first.
    const fresh1 = makePlayer("f1", 3, 13, 1);
    const fresh2 = makePlayer("f2", 3, 12, 1);
    // Heavy pair: four games each — 3 above the seat minimum, 6 combined.
    const heavy1 = makePlayer("h1", 3, 11, 4);
    const heavy2 = makePlayer("h2", 3, 10, 4);
    const pool = [anchor, fresh1, fresh2, heavy1, heavy2];

    // ⚠️ The heavy pair must be the STRICTLY FRESHER option, or the test proves
    // nothing — the first draft of this fixture left every four at staleness 0,
    // so both rankings picked the same pair and it passed under bug injection.
    // Both fresh seats last faced the body, so any four containing one of them
    // scores 2 (the cross-net pair counts once per player); the heavy four
    // scores 0. Staleness-only ranking therefore PREFERS the heavy pair.
    const seatOpponents: LastOpponents = new Map([
      ["f1", new Set(["p4"])],
      ["f2", new Set(["p4"])],
      ["p4", new Set(["f1", "f2"])],
    ]);
    // baseStaleness 3 so BOTH options clear the freshness floor — otherwise the
    // fresh pair is filtered out before the ranking is ever consulted.
    const overrides = { lastOpponents: seatOpponents, baseStaleness: 3 };

    // Premise guard: the pool really is in priorityScore order, and the two
    // groups really do sit in different games-ahead tiers.
    const scores = pool.map((p) => p.priorityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(heavy1.games_played - fresh1.games_played).toBe(3);

    const pick = buildCrossCourtProposal(pool, bodies(), args(overrides));
    expect(pick).not.toBeNull();
    const seated = ids(pick!.proposal);
    expect(seated).toContain("a0");
    expect(seated).toContain("p4");
    // The decisive assertion: neither game-heavy player took a seat, even
    // though seating them would have bought a strictly fresher four.
    expect(seated).not.toContain("h1");
    expect(seated).not.toContain("h2");
    expect(pick!.gamesAhead).toBe(0);
    // ...and the fairness win really did cost freshness — proving the ranking
    // chose against staleness rather than getting it for free.
    expect(pick!.staleness).toBeGreaterThan(0);
  });

  it("CCT-BUILD-8: gamesAhead is measured against the SEAT pool minimum, and reported on the pick", () => {
    // Every seat candidate carries the same game count, so no pair can be
    // fairer than any other and the ranking falls through to staleness — the
    // pre-review behaviour, which is still correct INSIDE a tier.
    const pool = ["a0", "a1", "a2", "w"].map((id) => makePlayer(id, 3, WAITS[id], 3));
    const pick = buildCrossCourtProposal(pool, bodies(), args());
    expect(pick).not.toBeNull();
    // All seats tied at 3 games ⇒ the minimum is 3 ⇒ zero above it.
    expect(pick!.gamesAhead).toBe(0);
    expect(pick!.staleness).toBeLessThan(1);
  });

  it("CCT-BUILD-3: exactly one pulled body is seated", () => {
    const twoBodies = [
      { ...makePlayer("p4"), priorityScore: -1, isPulled: true as const },
      { ...makePlayer("p5"), priorityScore: -1, isPulled: true as const },
    ];
    const pick = buildCrossCourtProposal(waiting(), twoBodies, args());
    const seated = ids(pick!.proposal).filter((id) => id === "p4" || id === "p5");
    expect(seated).toHaveLength(1);
    expect(seated[0]).toBe(pick!.pulledPlayerId);
  });

  it("CCT-BUILD-4: null when no candidate four beats baseStaleness", () => {
    // baseStaleness 0 — the waiting-only four is already perfectly fresh, so no
    // pull can strictly improve on it and none should be attempted.
    expect(buildCrossCourtProposal(waiting(), bodies(), args({ baseStaleness: 0 }))).toBeNull();
  });

  it("CCT-BUILD-5: the forced-repeat path accepts without a staleness drop", () => {
    // baseStaleness 0 would reject every candidate on the freshness path, but a
    // forced repeat has no staleness floor to beat: the waiting-only four is
    // unservable regardless of what the metric says about it.
    const pick = buildCrossCourtProposal(
      waiting(),
      bodies(),
      args({ baseStaleness: 0, forcedRepeat: true })
    );
    expect(pick).not.toBeNull();
    expect(ids(pick!.proposal)).toContain("p4");
  });

  it("CCT-BUILD-6: null when there is no body, or too few waiting players", () => {
    expect(buildCrossCourtProposal(waiting(), [], args())).toBeNull();
    // Two waiting + one body cannot make a four of 3 waiting + 1 pulled.
    expect(buildCrossCourtProposal(waiting().slice(0, 2), bodies(), args())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// The diversity lookback the reach is judged against
// ─────────────────────────────────────────────────────────────
// buildCrossCourtProposal calls runAlgorithm with a pool of exactly 4, and
// getEffectiveLookback(4) is 2 — while the engine's own run, drawing on the
// real waiting pool, earns 4 (10–15 waiting) or 7 (16+). Left uncorrected the
// cross-court path would enforce a WEAKER anti-repeat rule than the plain draft
// it replaces: a four sharing ≥3 players with the 3rd-most-recent roster would
// pass the inner check and commit. Backwards, for a feature whose whole
// justification is freshness.

describe("buildCrossCourtProposal — judged on the OUTER lookback", () => {
  // 12 waiting ⇒ getEffectiveLookback(12) = 4. Uniform skill so nothing is
  // filtered for skill spread, and no lastOpponents so every four is fresh —
  // the diversity rule is then the only thing that can reject a candidate.
  const POOL_IDS = Array.from({ length: 12 }, (_, i) => `a${i}`);
  const pool = () => POOL_IDS.map((id, i) => makePlayer(id, 3, 20 - i));
  const body = () => [{ ...makePlayer("p4", 3, 0), priorityScore: -1, isPulled: true as const }];

  // The four the search reaches FIRST: anchor + the two highest-priority seats
  // + the body. Iteration is bodies → i<j over seatPool, and a staleness-0 four
  // returns immediately, so this one wins unless diversity rejects it.
  const FIRST_FOUR = ["a0", "a1", "a2", "p4"];
  const noise = (n: number) => Array.from({ length: 4 }, (_, k) => `z${n}${k}`);

  const argsWithBlockAt = (index: number) => {
    const rosters = [noise(0), noise(1), noise(2), noise(3), noise(4), noise(5), noise(6)];
    rosters[index] = FIRST_FOUR;
    return {
      partnershipCounts: new Map<string, number>(),
      overlapMap: new Map<string, number>(),
      recentRosters: rosters,
      opponentCounts: new Map<string, number>(),
      rejectedRosters: [] as string[][],
      lastOpponents: new Map() as LastOpponents,
      baseStaleness: 1,
      forcedRepeat: undefined as boolean | undefined,
    };
  };

  const idsOf = (p: { teamA: ScoredPlayer[]; teamB: ScoredPlayer[] }) =>
    [...p.teamA, ...p.teamB].map((x) => x.player_id).sort();

  it("CCT-LOOK-1: positive control — unblocked, the first four is the one taken", () => {
    // The blocking roster sits at index 5, outside the outer lookback of 4, so
    // nothing rejects FIRST_FOUR. Without this the next test proves nothing:
    // it has to be shown that this fixture WOULD otherwise pick that four.
    const pick = buildCrossCourtProposal(pool(), body(), argsWithBlockAt(5));
    expect(pick).not.toBeNull();
    expect(idsOf(pick!.proposal)).toEqual([...FIRST_FOUR].sort());
  });

  it("CCT-LOOK-2: a four blocked ONLY by the outer lookback is rejected", () => {
    // Index 2 is inside the outer window (4) but outside the inner one (2).
    // Pre-fix this four was committed; the reach ran on a 2-match memory.
    const args = argsWithBlockAt(2);
    const pick = buildCrossCourtProposal(pool(), body(), args);

    expect(pick).not.toBeNull();
    expect(idsOf(pick!.proposal)).not.toEqual([...FIRST_FOUR].sort());
    // And whatever it settled on is clean against the window the ENGINE uses.
    expect(isDiversityViolation(idsOf(pick!.proposal), args.recentRosters.slice(0, 4))).toBe(false);
  });

  it("CCT-LOOK-3: the reach still honours the inner window it always had", () => {
    // Index 0 is inside both windows — a guard against a fix that swapped one
    // blind spot for another.
    const args = argsWithBlockAt(0);
    const pick = buildCrossCourtProposal(pool(), body(), args);
    expect(idsOf(pick!.proposal)).not.toEqual([...FIRST_FOUR].sort());
  });

  it("CCT-LOOK-4: a rejected roster is never re-served by the reach", () => {
    // ⚠️ Belt-and-braces, NOT coverage of the outer isRejectedRoster call.
    // runAlgorithm already applies rejectedRosters internally and returns any
    // such group flagged forcedRepeat, which the search discards before the
    // outer check runs — so deleting that outer line leaves this test green.
    // It is kept because the property is worth asserting end-to-end; do not
    // count it as protection for the line it sits next to.
    const args = { ...argsWithBlockAt(5), rejectedRosters: [FIRST_FOUR] };
    const pick = buildCrossCourtProposal(pool(), body(), args);
    expect(idsOf(pick!.proposal)).not.toEqual([...FIRST_FOUR].sort());
  });
});
