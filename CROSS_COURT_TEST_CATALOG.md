# Cross-Court Diversity Drafting — Test Catalog

> Companion to `CROSS_COURT_DRAFTING_PLAN.md` (Phase 8). Authored test-first (2026-06-07) before any implementation,
> while intent was fresh. This is the **build's TDD checklist** — each case is transplantable into the named test file.
> Case ids are stable; regression cases name their plan tag (C-1, C-3, N-1, N-2, R3-1, R3-B, M-4, M-6, L-1, N-4, R3-C, R3-2…).

> ## ⚠️ HISTORICAL — the per-slot mock ordering in §"Engine" is OBSOLETE (2026-08-04)
>
> This catalog was authored against the engine's old three-helper diversity read
> (`fetchRecentRosters` + `fetchPartnershipCounts` + `buildOverlapMap`). Those helpers no longer
> exist: one `fetchSessionMatchSnapshot` per slot replaced all three, and the derivations are now
> pure. **Every `queriedTables` sequence, FIFO index and "step 1/2/3 overlap" comment below is wrong
> for current code** — the assertions and intent are still valid, the query order is not.
>
> Current per-slot order (`matches` → `v_queue_with_wait_time` → `match_players`, the roster hop
> landing *after* the pool because it follows an await) is documented in the header of
> `tests/unit/matchmaking-engine.test.ts` and APP_MANIFEST §"Session match snapshot". Read those,
> not this file, when wiring engine mocks. The feature itself shipped — `fetchPullablePlayers` is
> live in `src/app/actions/matchmaking.ts`.

---

## 1. Pure Core

### CC-PURE — Pure Core (`tests/unit/matchmaking-core.test.ts`, extend)

**Target file:** `/Users/miggy-onb/Downloads/badminton-app/tests/unit/matchmaking-core.test.ts`
**Under test (new pure exports in `src/lib/matchmaking-core.ts`):** `isPullEligible`, `isHeldMatchReady`, `pickEarliestFinishing`; the extended `ScoredPlayer` (`isPulled?`, `currentMatchStartedAt?`), the extended `AlgorithmResult` (`forcedRepeat: boolean`), the `forcedRepeat` flag on `runAlgorithm`, the ≤1-pulled augmented-pool constraint inside `buildCombinationGroup`, and the C-3 fix in `scoreAndSortPool`.

**Conventions to match (already in this file):** `import { describe, it, expect } from "vitest"`; no Supabase/`next/server` mocks (this file is mock-free — these are DB-free helpers); the shared `makePlayer(id, { skillInt, waitMinutes?, gamesPlayed? })` factory; `runAlgorithm(pool, partnershipCounts, overlapMap, recentRosters)`; stable case ids in `it(...)` titles.

**New imports to add** to the existing import block: `isPullEligible, isHeldMatchReady, pickEarliestFinishing` from `@/lib/matchmaking-core`; `MAX_CONSECUTIVE_GAMES_FOR_PULL, CROSS_COURT_REST_FALLBACK_MINUTES` from `@/lib/constants`.

**New test-data helpers** (add near `makePlayer`):

```ts
// A pulled (playing) candidate body for the augmented pool. Always priorityScore:-1 (C-3),
// isPulled:true, with an in_progress match start time. waitMinutes only seeds joined_at.
function makePulled(
  id: string,
  opts: { skillInt: number; currentMatchStartedAt?: string; joinedMinutesAgo?: number }
): ScoredPlayer {
  const joinedMinutesAgo = opts.joinedMinutesAgo ?? 0;
  const base: QueueWithWaitTime = {
    id: `entry-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: new Date(Date.now() - joinedMinutesAgo * 60_000).toISOString(),
    games_played: 0,
    status: "playing",
    position: null,
    is_paused: false,
    created_at: new Date().toISOString(),
    display_name: `Pulled-${id}`,
    skill_level: "intermediate",
    skill_level_int: opts.skillInt,
    wait_minutes: 0,
    is_bottleneck: false,
  };
  return {
    ...base,
    priorityScore: -1, // C-3: pulled bodies are forced to -1, NOT computePriorityScore
    isPulled: true,
    currentMatchStartedAt: opts.currentMatchStartedAt ?? new Date().toISOString(),
  };
}

// Streak/cooldown opts object shape consumed by isPullEligible.
function pullOpts(o: Partial<{ streak: number; alreadyHeld: boolean }> = {}) {
  return { streak: o.streak ?? 0, alreadyHeld: o.alreadyHeld ?? false };
}
```

> Note on signature: `isPullEligible(player, opts)` — `opts` carries the **precomputed** `streak` (consecutive-games run from `fetchPullablePlayers`, Phase 4a) and `alreadyHeld` (body already reserved in a pending held draft). It performs **NO skill-window check (N-4)** — `fetchPullablePlayers` runs before the anchor is known, so skill compatibility is left to `runAlgorithm`. The cooldown is relational, expressed entirely through `streak >= MAX_CONSECUTIVE_GAMES_FOR_PULL` (R3-C); there is no time-based cooldown field. If the final implementation reads the streak off the `player` object instead of `opts`, set it on the `makePulled` body — keep the assertions, adjust the wiring.

---

#### `isPullEligible` (pure predicate, N-4 regression)

```ts
describe("isPullEligible", () => {
  // CC-PURE-01
  it("CC-PURE-01: eligible — streak 0, not already held → true", () => {
    const p = makePulled("p", { skillInt: 5 });
    expect(isPullEligible(p, pullOpts({ streak: 0 }))).toBe(true);
  });

  // CC-PURE-02 — streak at the cap is excluded (relational cooldown, R3-C)
  it("CC-PURE-02: streak === MAX_CONSECUTIVE_GAMES_FOR_PULL (2) → excluded", () => {
    const p = makePulled("p", { skillInt: 5 });
    expect(isPullEligible(p, pullOpts({ streak: MAX_CONSECUTIVE_GAMES_FOR_PULL }))).toBe(false);
  });

  // CC-PURE-03 — boundary: one below the cap is still eligible
  it("CC-PURE-03: streak === MAX_CONSECUTIVE_GAMES_FOR_PULL - 1 (1) → eligible", () => {
    const p = makePulled("p", { skillInt: 5 });
    expect(isPullEligible(p, pullOpts({ streak: MAX_CONSECUTIVE_GAMES_FOR_PULL - 1 }))).toBe(true);
  });

  // CC-PURE-04 — streak above cap excluded (defensive ≥, not ===)
  it("CC-PURE-04: streak > cap (3) → excluded", () => {
    const p = makePulled("p", { skillInt: 5 });
    expect(isPullEligible(p, pullOpts({ streak: MAX_CONSECUTIVE_GAMES_FOR_PULL + 1 }))).toBe(false);
  });

  // CC-PURE-05 — already in another held draft → excluded (Guard-1b mirror at pure layer)
  it("CC-PURE-05: alreadyHeld=true → excluded even with streak 0", () => {
    const p = makePulled("p", { skillInt: 5 });
    expect(isPullEligible(p, pullOpts({ streak: 0, alreadyHeld: true }))).toBe(false);
  });

  // CC-PURE-06 — N-4 REGRESSION: NO skill-window argument exists/affects the result.
  // A pulled body whose skill is wildly far from any hypothetical anchor is STILL eligible
  // at this layer — skill is the anchor-relative concern of runAlgorithm, not isPullEligible.
  it("CC-PURE-06 [N-4]: extreme skill is irrelevant — eligibility depends only on streak/held", () => {
    const lowSkill = makePulled("lo", { skillInt: 1 });
    const highSkill = makePulled("hi", { skillInt: 10 });
    expect(isPullEligible(lowSkill, pullOpts({ streak: 0 }))).toBe(true);
    expect(isPullEligible(highSkill, pullOpts({ streak: 0 }))).toBe(true);
    // Guard against an accidentally-added 3rd skill-window param: calling with only (player, opts)
    // must compile and pass. (If a skill window is ever added, THIS test must be deleted with a
    // referenced ADR — it is the canary for the N-4 decision.)
    expect(isPullEligible.length).toBeLessThanOrEqual(2);
  });
});
```

---

#### `isHeldMatchReady` (pure readiness predicate — boundary suite)

Signature: `isHeldMatchReady({ pulledFreedAt, promotionsSinceFreed, now, restFallbackMs })`. `pulledFreedAt` is `string | null` (the body's `pulled_from_match.completed_at`; `null` ⇒ still playing). `restFallbackMs` is the 3-min fallback in ms (`CROSS_COURT_REST_FALLBACK_MINUTES * 60_000`). Ready iff **(a)** the body is free **and** **(b)** `promotionsSinceFreed >= 1` **OR** `now - pulledFreedAt >= restFallbackMs`.

```ts
describe("isHeldMatchReady", () => {
  const FALLBACK_MS = CROSS_COURT_REST_FALLBACK_MINUTES * 60_000;
  const NOW = new Date("2026-06-07T12:00:00.000Z").getTime();
  const freedAt = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  // CC-PURE-07 — still playing (not freed) → false regardless of timers
  it("CC-PURE-07: pulledFreedAt=null (body still playing) → false", () => {
    expect(
      isHeldMatchReady({ pulledFreedAt: null, promotionsSinceFreed: 5, now: NOW, restFallbackMs: FALLBACK_MS })
    ).toBe(false);
  });

  // CC-PURE-08 — freed + ≥1 intervening promotion → ready immediately (no need to wait fallback)
  it("CC-PURE-08: freed + 1 promotion → true (promotion path, fallback not needed)", () => {
    expect(
      isHeldMatchReady({ pulledFreedAt: freedAt(0), promotionsSinceFreed: 1, now: NOW, restFallbackMs: FALLBACK_MS })
    ).toBe(true);
  });

  // CC-PURE-09 — freed + 0 promotions + elapsed < fallback → NOT yet ready
  it("CC-PURE-09: freed + 0 promotions + 2 min elapsed (< 3-min fallback) → false", () => {
    expect(
      isHeldMatchReady({ pulledFreedAt: freedAt(2 * 60_000), promotionsSinceFreed: 0, now: NOW, restFallbackMs: FALLBACK_MS })
    ).toBe(false);
  });

  // CC-PURE-10 — freed + 0 promotions + elapsed > fallback → ready via fallback
  it("CC-PURE-10: freed + 0 promotions + 4 min elapsed (> 3-min fallback) → true", () => {
    expect(
      isHeldMatchReady({ pulledFreedAt: freedAt(4 * 60_000), promotionsSinceFreed: 0, now: NOW, restFallbackMs: FALLBACK_MS })
    ).toBe(true);
  });

  // CC-PURE-11 — EXACT boundary: elapsed === restFallbackMs → ready (>= is inclusive)
  it("CC-PURE-11: freed + 0 promotions + exactly restFallbackMs elapsed → true (inclusive boundary)", () => {
    expect(
      isHeldMatchReady({ pulledFreedAt: freedAt(FALLBACK_MS), promotionsSinceFreed: 0, now: NOW, restFallbackMs: FALLBACK_MS })
    ).toBe(true);
  });

  // CC-PURE-12 — just under the exact boundary → still false (proves strict < on the off side)
  it("CC-PURE-12: freed + 0 promotions + (restFallbackMs - 1ms) elapsed → false", () => {
    expect(
      isHeldMatchReady({ pulledFreedAt: freedAt(FALLBACK_MS - 1), promotionsSinceFreed: 0, now: NOW, restFallbackMs: FALLBACK_MS })
    ).toBe(false);
  });
});
```

---

#### `pickEarliestFinishing` (court-preference tiebreak, N-3)

Signature: `pickEarliestFinishing(candidates: ScoredPlayer[]): ScoredPlayer` — returns the candidate with the smallest `currentMatchStartedAt` (oldest start = closest to finishing). Deterministic tie-break on equal start times (stable: returns the first such candidate as supplied — i.e. input order, which the caller has already ordered by fit).

```ts
describe("pickEarliestFinishing", () => {
  // CC-PURE-13 — earliest currentMatchStartedAt wins
  it("CC-PURE-13: returns the candidate with the oldest currentMatchStartedAt", () => {
    const early = makePulled("early", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:40:00.000Z" });
    const mid = makePulled("mid", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:50:00.000Z" });
    const late = makePulled("late", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:55:00.000Z" });
    expect(pickEarliestFinishing([late, mid, early]).player_id).toBe("early");
  });

  // CC-PURE-14 — deterministic tie: equal start times → first-in-input wins (stable)
  it("CC-PURE-14: equal currentMatchStartedAt → returns the first candidate in input order (deterministic)", () => {
    const t = "2026-06-07T11:45:00.000Z";
    const a = makePulled("a", { skillInt: 5, currentMatchStartedAt: t });
    const b = makePulled("b", { skillInt: 5, currentMatchStartedAt: t });
    expect(pickEarliestFinishing([a, b]).player_id).toBe("a");
    // Reversed input proves it is input-order-stable, not id-sorted
    expect(pickEarliestFinishing([b, a]).player_id).toBe("b");
  });

  // CC-PURE-15 — single candidate is returned as-is
  it("CC-PURE-15: single candidate → returned unchanged", () => {
    const only = makePulled("only", { skillInt: 5 });
    expect(pickEarliestFinishing([only]).player_id).toBe("only");
  });
});
```

---

#### `forcedRepeat` flag on `runAlgorithm` (C-2 regression — extend existing RA / MC-new suites)

`AlgorithmResult` gains `forcedRepeat: boolean`. It is `true` on exactly two return literals — the Tier-3 rotation return (`matchmaking-core.ts:~690`) and the **successful** last-resort fallback return (`~747`, inside `if (draft)`). It is `false` on Tier-1 (`~621`), Tier-2 (`~662`), and the normal snakeDraft success (`~718`). When `proposal === null`, `forcedRepeat` is `false` (irrelevant/no proposal). These extend the assertions already present in the named cases rather than re-creating fixtures.

```ts
describe("runAlgorithm — forcedRepeat flag (C-2 regression)", () => {
  // CC-PURE-16 — normal direct snakeDraft success → forcedRepeat=false
  // Reuses the RA-1 fixture shape.
  it("CC-PURE-16 [C-2]: Tier-0 normal match → forcedRepeat=false", () => {
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10 });
    const pool = [
      anchor,
      makePlayer("p1", { skillInt: 5, waitMinutes: 9 }),
      makePlayer("p2", { skillInt: 4, waitMinutes: 8 }),
      makePlayer("p3", { skillInt: 5, waitMinutes: 7 }),
    ];
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).not.toBeNull();
    expect(result.forcedRepeat).toBe(false);
  });

  // CC-PURE-17 — Tier-3 rotation (forced repeat): diversity violation, swap pool exhausted,
  // non-Red-Zone swap target, all-4 in a recent roster → rotatedDraft return → forcedRepeat=true.
  // Construct: exactly 4 players (no spare to swap in), all played together last match,
  // swap target NOT Red Zone (so the swap branch is entered, then exhausted).
  it("CC-PURE-17 [C-2]: Tier-3 partner rotation → forcedRepeat=true", () => {
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10 });
    const g0 = makePlayer("g0", { skillInt: 5, waitMinutes: 9 });
    const g1 = makePlayer("g1", { skillInt: 5, waitMinutes: 8 });
    const g2 = makePlayer("g2", { skillInt: 5, waitMinutes: 7 });
    // All 4 (and only these 4) → no candidate left to swap in → Tier-1/2 exhausted → Tier-3.
    const recentRosters = [[anchor.player_id, g0.player_id, g1.player_id, g2.player_id]];
    const result = runAlgorithm([anchor, g0, g1, g2], new Map(), new Map(), recentRosters);
    expect(result.proposal).not.toBeNull();
    expect(result.forcedRepeat).toBe(true);
  });

  // CC-PURE-18 — successful last-resort fallback → forcedRepeat=true.
  // Mirrors MC-new-1 (anchor wait > FALLBACK_WAIT_MINUTES, all skill windows fail).
  it("CC-PURE-18 [C-2]: successful last-resort fallback → forcedRepeat=true", () => {
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: FALLBACK_WAIT_MINUTES + 1 });
    const pool = [
      anchor,
      makePlayer("c1", { skillInt: 10, waitMinutes: 5 }),
      makePlayer("c2", { skillInt: 10, waitMinutes: 4 }),
      makePlayer("c3", { skillInt: 10, waitMinutes: 3 }),
    ];
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.isMixedLevel).toBe(true);
    expect(result.forcedRepeat).toBe(true);
  });

  // CC-PURE-19 — proposal:null → forcedRepeat=false (irrelevant on no-match).
  // Mirrors MC-new-3 (wait === FALLBACK threshold, fallback does NOT fire).
  it("CC-PURE-19 [C-2]: no-match (proposal null) → forcedRepeat=false", () => {
    const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: FALLBACK_WAIT_MINUTES });
    const pool = [
      anchor,
      makePlayer("c1", { skillInt: 10, waitMinutes: 5 }),
      makePlayer("c2", { skillInt: 10, waitMinutes: 4 }),
      makePlayer("c3", { skillInt: 10, waitMinutes: 3 }),
    ];
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).toBeNull();
    expect(result.forcedRepeat).toBe(false);
  });

  // CC-PURE-20 — Red Zone swap-skip falls through to snakeDraft (RA-3 shape) → forcedRepeat=false.
  // Confirms the fall-through-to-snakeDraft return at ~718 is NOT mislabeled as a forced repeat.
  it("CC-PURE-20 [C-2]: Red-Zone swap-skip → snakeDraft fall-through → forcedRepeat=false", () => {
    const anchorRZ = makePlayer("anchorRZ", { skillInt: 5, waitMinutes: 30 });
    const g0 = makePlayer("g0", { skillInt: 5, waitMinutes: 29 });
    const g1 = makePlayer("g1", { skillInt: 5, waitMinutes: 28 });
    const g2 = makePlayer("g2", { skillInt: 5, waitMinutes: 26 });
    const recentRosters = [[anchorRZ.player_id, g0.player_id, g1.player_id, g2.player_id]];
    const result = runAlgorithm([anchorRZ, g0, g1, g2], new Map(), new Map(), recentRosters);
    expect(result.proposal).not.toBeNull();
    expect(result.forcedRepeat).toBe(false);
  });
});
```

> Wiring note for Tier-1/Tier-2 `forcedRepeat=false` (optional CC-PURE-21/22): the existing engine suite already exercises Tier-1/Tier-2 success returns; if a pure spare-pool fixture is added here (anchor + 3 in last roster + 1 fresh spare of compatible skill so a diverse swap succeeds at Tier-1), assert `forcedRepeat === false`. Mark these as **lower priority** — the two `true` sites (CC-PURE-17/18) are the load-bearing C-2 regressions.

---

#### Augmented-pool composition — ≤1 pulled body (N-1)

These exercise the new ≤1-pulled constraint that the orchestrator (Phase 4) applies when it builds the augmented pool and re-runs the pure pipeline. The constraint lives in `buildCombinationGroup` (skip any triple containing ≥2 `isPulled` members) and/or in the candidate-injection step (inject only the single best-fit pulled candidate). Tested here at the **pure** layer by feeding an augmented pool directly into `runAlgorithm` and asserting the resulting 4-player proposal contains **at most one** `isPulled`.

```ts
describe("runAlgorithm — augmented pool ≤1 pulled (N-1)", () => {
  const countPulled = (r: AlgorithmResult) =>
    [...r.proposal!.teamA, ...r.proposal!.teamB].filter((p) => p.isPulled).length;

  // CC-PURE-23 — 3 waiting + 1 eligible pulled → fresh combo with exactly one isPulled.
  // Anchor must be a WAITING player (C-3 guarantees pulled never anchors). The pulled body
  // is skill-compatible so it survives runAlgorithm's ±1/±2 window and joins the combo.
  it("CC-PURE-23 [N-1]: 3 waiting + 1 eligible pulled → combo has exactly one isPulled", () => {
    const anchor = makePlayer("w0", { skillInt: 5, waitMinutes: 12 });
    const w1 = makePlayer("w1", { skillInt: 5, waitMinutes: 11 });
    const w2 = makePlayer("w2", { skillInt: 5, waitMinutes: 10 });
    const pulled = makePulled("pull1", { skillInt: 5 }); // priorityScore -1, isPulled true
    const pool = [anchor, w1, w2, pulled]; // pre-sorted: pulled(-1) sorts last
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).not.toBeNull();
    expect(countPulled(result)).toBe(1);
    // Anchor (pool[0]) is the waiting player, never the pulled body (C-3 invariant)
    expect(result.proposal!.teamA.concat(result.proposal!.teamB).find((p) => p.isPulled)!.player_id)
      .toBe("pull1");
  });

  // CC-PURE-24 — 2 waiting + 2 pulled candidates where a 2-pulled combo would otherwise be
  // the "best fit": the ≤1 constraint must REJECT the 2-pulled combo and instead pick a
  // 1-pulled combo (anchor + 1 waiting + 1 pulled + ... ) — never 2 pulled.
  it("CC-PURE-24 [N-1]: combo wanting 2 pulled is reduced to a 1-pulled combo", () => {
    const anchor = makePlayer("w0", { skillInt: 5, waitMinutes: 12 });
    const w1 = makePlayer("w1", { skillInt: 5, waitMinutes: 11 });
    const pullA = makePulled("pullA", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:40:00.000Z" });
    const pullB = makePulled("pullB", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:50:00.000Z" });
    const pool = [anchor, w1, pullA, pullB];
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).not.toBeNull();
    // Hard invariant: never more than one pulled body in the final 4.
    expect(countPulled(result)).toBeLessThanOrEqual(1);
  });

  // CC-PURE-25 — when NO valid ≤1-pulled diverse combo exists, fall back to the waiting-only
  // result (zero pulled), NOT to a 2-pulled combo. Provide enough waiting players to form a
  // clean waiting-only match so the salvageable-vs-give-up distinction is exercised.
  it("CC-PURE-25 [N-1]: no valid 1-pulled combo → waiting-only result (zero pulled)", () => {
    // 4 waiting players form a perfect match; pulled bodies are skill-incompatible (skill 10
    // vs anchor 5, outside ±2) so no valid combo can include them → waiting-only wins.
    const pool = [
      makePlayer("w0", { skillInt: 5, waitMinutes: 12 }),
      makePlayer("w1", { skillInt: 5, waitMinutes: 11 }),
      makePlayer("w2", { skillInt: 5, waitMinutes: 10 }),
      makePlayer("w3", { skillInt: 5, waitMinutes: 9 }),
      makePulled("pullHi", { skillInt: 10 }),
    ];
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).not.toBeNull();
    expect(countPulled(result)).toBe(0);
  });
});
```

> N-3 tiebreak inside composition (CC-PURE-26, optional but recommended): when ≥2 pulled bodies tie on skill+diversity fit for the single slot, the orchestrator chooses via `pickEarliestFinishing`. At the pure layer this is only fully observable if `runAlgorithm`'s candidate ordering surfaces the earliest-finishing pulled first. If the ≤1-pulled injection happens in the **orchestrator** (matchmaking.ts) rather than inside `runAlgorithm`, move CC-PURE-26 to the engine cluster (`matchmaking-engine.test.ts`) and assert `pickEarliestFinishing` was the selector (CC-PURE-13/14 already cover the pure selector itself). Flag this boundary to the build: **if injection is orchestrator-side, CC-PURE-23/24/25 belong in the engine suite with a mocked augmented pool, and only CC-PURE-13/14/15 (the selector) stay purely here.**

---

#### C-3 regression — `scoreAndSortPool` keeps a waiting player at `pool[0]`

The bug: a pulled body scored `0` with an older `joined_at` could sort to `pool[0]` and wrongly anchor. The fix forces pulled `priorityScore:-1`, keeping every waiting player strictly ahead in the primary comparator.

```ts
describe("scoreAndSortPool — C-3 pulled-body never anchors", () => {
  // CC-PURE-27 [C-3] — all-zero waiting scores + a pulled body with the OLDEST joined_at:
  // scoreAndSortPool must still place a WAITING player at pool[0] (pulled is -1, sorts last).
  it("CC-PURE-27 [C-3]: all-zero pool + pulled body with oldest joined_at → waiting stays at pool[0]", () => {
    // Three fresh waiting players (priorityScore 0). Pulled body joined earliest of all.
    const w0 = makePlayer("w0", { skillInt: 5, waitMinutes: 0, gamesPlayed: 0 }); // score 0
    const w1 = makePlayer("w1", { skillInt: 5, waitMinutes: 0, gamesPlayed: 0 }); // score 0
    const w2 = makePlayer("w2", { skillInt: 5, waitMinutes: 0, gamesPlayed: 0 }); // score 0
    // Pulled body has the OLDEST joined_at of the whole pool — under the OLD bug (score 0)
    // the joined_at ASC tiebreaker would float it to pool[0] and make it the anchor.
    const pulled = makePulled("pull1", { skillInt: 5, joinedMinutesAgo: 999 });

    // Feed UNSORTED into scoreAndSortPool (it sorts internally).
    const sorted = scoreAndSortPool([pulled, w0, w1, w2]);

    // C-3 invariant: pulled body (priorityScore -1) must NOT be pool[0].
    expect(sorted[0].isPulled).toBeFalsy();
    expect(sorted[0].priorityScore).toBe(0);
    // And the pulled body must be strictly last (lowest primary score).
    expect(sorted[sorted.length - 1].player_id).toBe("pull1");
    expect(sorted[sorted.length - 1].priorityScore).toBe(-1);
  });

  // CC-PURE-28 [C-3] — end-to-end through runAlgorithm: the same pool yields a proposal whose
  // anchor (pool[0]) is a waiting player; the pulled body appears only as a candidate (or not).
  it("CC-PURE-28 [C-3]: runAlgorithm anchors a waiting player, never the pulled body", () => {
    const w0 = makePlayer("w0", { skillInt: 5, waitMinutes: 0 });
    const w1 = makePlayer("w1", { skillInt: 5, waitMinutes: 0 });
    const w2 = makePlayer("w2", { skillInt: 5, waitMinutes: 0 });
    const pulled = makePulled("pull1", { skillInt: 5, joinedMinutesAgo: 999 });
    // runAlgorithm requires a pre-sorted pool; scoreAndSortPool is the sorter the engine uses.
    const pool = scoreAndSortPool([pulled, w0, w1, w2]);
    const result = runAlgorithm(pool, new Map(), new Map(), []);
    expect(result.proposal).not.toBeNull();
    // The pulled body is at most a candidate; it can never have been the anchor (pool[0]).
    expect(pool[0].isPulled).toBeFalsy();
  });
});
```

> If `runAlgorithm` does not re-sort internally (it does not — it assumes `pool[0]` is the anchor), CC-PURE-28 deliberately routes the pool through `scoreAndSortPool` first, exactly as the engine does, so the C-3 fix is what guarantees the waiting anchor.

---

#### Keep-courts-fed slot-0 — `pulled_player_ids = []` when only a held match would form

The keep-courts-fed rule (slot-0 always yields a *ready* match) is enforced in the **engine** (`matchmaking.ts`), not in the pure core — the pure pipeline has no notion of "slot index" or "ready match." It is therefore **NOT unit-testable in this file**.

| id | scenario | where it lives | how covered |
|---|---|---|---|
| CC-PURE-29 | Slot-0 of an engine run would otherwise form a held (1-pulled) draft because the augmented pool is the only path; keep-courts-fed must suppress the hold and emit a fully-waiting match → `pulled_player_ids = []` (empty, `is_held=false`) | `matchmaking.ts` augmented-pool composition + slot loop (`estimatedWaiting`, C-1; bypassGate ⇒ no held, M-4) | **Engine cluster** — `tests/unit/matchmaking-engine.test.ts`: queue `from('matches')`/`rpc()` responses so slot 0 has only-held available; assert the executed draft has empty `pulled_player_ids`. The **pure** precondition (a waiting-only result exists when no valid ≤1-pulled combo applies) is already covered here by **CC-PURE-25**. |

**Pure-layer guarantee that backs CC-PURE-29:** CC-PURE-25 proves `runAlgorithm` returns a zero-pulled (waiting-only) proposal whenever no valid ≤1-pulled combo exists — so the engine's slot-0 suppression has a correct pure result to fall back to. No additional pure test is needed for the suppression itself.

---

#### Coverage summary (this cluster)

| id | function / target | tag |
|---|---|---|
| CC-PURE-01..06 | `isPullEligible` (eligible / streak cap / boundary / >cap / alreadyHeld / no-skill-window) | **N-4** (06) |
| CC-PURE-07..12 | `isHeldMatchReady` (still-playing / +1 promo / <fallback / >fallback / exact boundary / just-under) | — |
| CC-PURE-13..15 | `pickEarliestFinishing` (earliest wins / deterministic tie / single) | N-3 |
| CC-PURE-16..20 | `runAlgorithm.forcedRepeat` (normal / Tier-3 / fallback / null / RZ-skip) | **C-2** |
| CC-PURE-21..22 | `forcedRepeat=false` on Tier-1/Tier-2 (optional, lower priority) | C-2 |
| CC-PURE-23..26 | augmented-pool ≤1 pulled (fresh 1-pulled / reject 2-pulled / waiting-only fallback / N-3 tiebreak*) | **N-1**, N-3 |
| CC-PURE-27..28 | `scoreAndSortPool` C-3 (sort + e2e anchor) | **C-3** |
| CC-PURE-29 | keep-courts-fed slot-0 `pulled_player_ids=[]` | **NOT pure** → engine cluster; precondition covered by CC-PURE-25 |

**Notes for the build:**
- `*` CC-PURE-26 (N-3 inside composition) and CC-PURE-23/24/25 may move to the **engine cluster** if the ≤1-pulled injection is implemented orchestrator-side (matchmaking.ts) rather than inside `buildCombinationGroup`. Decide this when wiring Phase 4; whichever side owns the injection owns those three cases. The pure **selector** tests (CC-PURE-13/14/15) stay here unconditionally.
- All cases in this cluster are **mock-free** (no Supabase, no `next/server` `after`, no push-server, no service client) — they extend the existing database-free suite. Only CC-PURE-29 requires the engine harness.
- `isPullEligible` arity assertion (CC-PURE-06) is the canary for the **N-4** "no skill window" decision; do not silently delete it if the signature changes.

---

## 2. Engine Producer

### Cluster F — Engine Producer (`tests/unit/matchmaking-engine.test.ts`, extend)

**Target file:** `/Users/miggy-onb/Downloads/badminton-app/tests/unit/matchmaking-engine.test.ts` (extend the existing `runEngineForSession` describe block; add a new sibling describe `runEngineForSession — cross-court held drafts`).

**Code under test (Phase 4):** `runEngineInternal` in `src/app/actions/matchmaking.ts` — after Phase 4 it gains `fetchPullablePlayers(supabase, sessionId)` (one batched call, hoisted next to `fetchRecentRosters` at ~line 420, BEFORE the slot loop), a per-slot augmented-pool re-run gated on `!RedZone && forcedRepeat`, an `executeHeldMatch(supabase, sessionId, proposal, pulledPlayer)` sibling of `executeMatch` that calls `rpc("create_held_cross_court_match", {...})`, and the C-1 `estimatedWaiting -= (PLAYERS_PER_MATCH − pulledCount)` change. `runAlgorithm` now returns `{ proposal, capSaturation, forcedRepeat }`.

**Harness wiring (reuse verbatim — already present at the top of the file):**
- `vi.mock("@/utils/supabase/service")` + `vi.mocked(createServiceClient).mockReturnValue(mock as never)` — every cross-court test drives `runEngineForSession` (service-role path).
- `vi.mock("next/server", { after: cb => cb() })` and `vi.mock("@/lib/notifications/push-server", { pushToPlayers })` — unchanged; needed because the held path still flushes pushes via `after()`.
- `makeMockClient(fromResponses, rpcResponses)` — the from()/rpc() response queues. `mock.rpc` is a single `vi.fn` shared by BOTH `create_match_with_players` and `create_held_cross_court_match`; assert the RPC NAME via `mock.rpc.mock.calls`, e.g. `expect(mock.rpc).toHaveBeenCalledWith("create_held_cross_court_match", expect.objectContaining({ p_pulled_player_id: "px0" }))`. The current `rpc` mock ignores its first arg and returns `rpcResponses[idx]` in call order — queue held-RPC responses in the order they fire.
- `mock.queriedTables` — assert table-access ORDER, including the new `fetchPullablePlayers` query position.

**`fetchPullablePlayers` query shape to mock (per Phase 4a / C-3 / R3-C):** one batched read of `status='playing'` bodies joined to their `in_progress` match (`matches`/`match_players`) PLUS the last-~3-played-matches streak read. For mock purposes the implementer MUST place these from() calls at a fixed point — **immediately after `fetchRecentRosters` and before the slot loop** (it's hoisted, run once per engine run). The case tables below assume `fetchPullablePlayers` issues its query(ies) right after the `fetchRecentRosters` matches/match_players reads. Each case documents the exact ordered queue. **If the implementation interleaves these differently, only the index comments shift — the assertions key on RPC name + count, not absolute indices, so existing non-cross-court tests' sequences stay valid (they never set `forcedRepeat`, so the augmented path is dead code for them, and `fetchPullablePlayers` returning `[]` adds zero downstream queries).**

> Note on producing `forcedRepeat`: per the plan's rejected-finding C-2, `forcedRepeat:true` is set on exactly two `runAlgorithm` return literals — the Tier-3 rotation return (~690) and the successful last-resort fallback return (~747). Engine tests do NOT mock `runAlgorithm`; they drive real input that forces those branches. The cleanest forced-repeat fixture (reused from the existing suite's partnership-cap pattern at ME-new-1, lines 590-612): a 4-player waiting pool where the only diverse-compatible group is the same recent roster AND every alternative is partnership-capped, so Tier-1/Tier-2 swaps fail and Tier-3 rotation fires → `forcedRepeat:true`. Feed `recentRosters` containing all 4 ids so `isDiversityViolation` trips.

#### Case table — DB-coupled engine cases

| id | scenario | setup / mock (from[] queue + rpc[] queue) | assert |
|---|---|---|---|
| **CC-ENG-01** | forced-repeat waiting pool + one eligible pulled body ⇒ held RPC called | toggle ON; courts=[c1]; Promise.all → 4 waiting players (maxWait≥8 → gate released), draftCount=0 (slots=3), override=null; `fetchRecentRosters` matches→[roster of all 4], match_players→that roster; **`fetchPullablePlayers`**: `matches`/`match_players` → one `playing` body `px0` in `in_progress` match `m-live` (started 6 min ago), streak read → 1 game (eligible); slot 0 → `fetchActivePool` v_queue(4)+queue_entries([]), `fetchPartnershipCounts` matches+match_players (caps the only swap alternatives), `buildOverlapMap` → empty. `runAlgorithm` returns `forcedRepeat:true`. **rpc[]:** `[{ data: "held-1", error: null }]`. | `mock.rpc` called once with `("create_held_cross_court_match", expect.objectContaining({ p_pulled_player_id: "px0", p_pulled_from_match_id: "m-live" }))`; NOT called with `create_match_with_players` for that slot. `resolves.toBeUndefined()` (no throw). |
| **CC-ENG-02** | Red Zone present ⇒ held RPC NOT called; seats from waiting via `create_match_with_players` | Same as 01 BUT the waiting pool's anchor `priorityScore ≥ 1000` (set `wait_minutes: 30` on `p0`) → `anchorIsRedZone`. Even though the waiting-only result is a forced repeat, the **Red-Zone short-circuit fires first** (decision 4) → cross-court trigger suppressed. `fetchPullablePlayers` still runs (hoisted) but its result is unused this slot. **rpc[]:** `[{ data: "m-1", error: null }]`. | `mock.rpc` called with `create_match_with_players` (`expect.objectContaining({ p_origin: "auto" })`); `mock.rpc` **never** called with `create_held_cross_court_match`. (Regression guard for decision 4 short-circuit ordering.) |
| **CC-ENG-03** | pullable empty ⇒ waiting-only forced-repeat fallback, no held RPC, no stall | Same forced-repeat waiting setup as 01 BUT `fetchPullablePlayers` → `[]` (no `playing` rows, e.g. all bodies on 2-game streaks or no in_progress match). The augmented pool == waiting pool → `runAlgorithm` still yields a (forced-repeat) proposal with zero pulled ⇒ `executeMatch`. **rpc[]:** `[{ data: "m-1", error: null }]`. | `mock.rpc` called exactly once with `create_match_with_players`; never with `create_held_cross_court_match`. `resolves.toBeUndefined()`. Asserts no stall: a match WAS produced. |
| **CC-ENG-04** | held RPC returns NULL ⇒ graceful slot-skip (no throw, loop continues/breaks cleanly) | Same as 01 but **rpc[]:** `[{ data: null, error: null }]` (Guard 0/1b NULL-return). `executeHeldMatch` must mirror `executeMatch`'s NULL convention → `{ success:false, message:"Slot skipped…" }` → loop breaks like the existing "Slot skipped" path (matchmaking.ts:488). | `await expect(runEngineForSession(...)).resolves.toBeUndefined()` (no throw); `mock.rpc` called once with `create_held_cross_court_match`; no `console.error` for the held slot (it's the expected-skip branch — spy on `console.error` and assert NOT called with a "failed" string). |
| **CC-ENG-05 (M-4)** | `bypassGate=true` ⇒ no held drafts, only all-waiting | Drive via `callNextMatch` happy-no-ondeck path (which calls `runEngineInternal(service, sessionId, true)`) OR a thin wrapper test that reaches `runEngineInternal` with `bypassGate=true`; forced-repeat waiting pool + an eligible pulled body available. With `bypassGate`, the cross-court trigger is suppressed → all-waiting only. **rpc[]:** `[{ data: "m-1", error: null }]`. | `mock.rpc` called with `create_match_with_players` only; **never** `create_held_cross_court_match`. (Regression — tag **M-4**.) Reuse the `callNextMatch` serviceMock layout (existing lines 940-955) and extend with `fetchPullablePlayers` responses returning `[]` is acceptable since they're never consumed for held creation under bypass. |
| **CC-ENG-06 (C-1)** | held draft decrements `estimatedWaiting` by 3 not 4 — pool-diversity cap doesn't stop a slot early | toggle ON; courts=[c1,c2]; **7 waiting players** + one eligible pulled body; slots=3 (draftCount=0); gate released. Slot 0 builds a **held** draft (forced repeat + 1 pulled). After slot 0: with the bug, `estimatedWaiting = 7−4 = 3 < 8` → cap fires, slot 1 skipped. With C-1 fix, `estimatedWaiting = 7−3 = 4`… still `<8`, so to make the assertion discriminating use **8 waiting** + pulled body so held slot-0 leaves `8−3=5` and a SECOND held/ready slot can be attempted (a 4-decrement would leave 4). Queue rpc[] for both slots: `[{data:"held-1"},{data:"m-2"}]` (slot 1 falls back to all-waiting). | After a slot-0 **held** draft, slot 1 is NOT blocked by the pool-diversity cap when `estimatedWaiting` correctly reflects the 3-player consumption. Assert `mock.rpc` called **twice** (slot 0 held, slot 1 produced) rather than once. With a buggy 4-decrement, slot 1 would be cap-blocked → only 1 rpc call (the failing condition). Tag **C-1**. |
| **CC-ENG-07** | per-slot query ORDER stays valid with `fetchPullablePlayers` inserted | CC-ENG-01's mock. | `mock.queriedTables` matches the documented ordering: `["sessions","courts","v_queue_with_wait_time","matches","sessions", /*fetchRecentRosters*/ "matches","match_players", /*fetchPullablePlayers*/ "match_players","matches", /*slot0 fetchActivePool*/ "v_queue_with_wait_time","queue_entries", /*partnerships*/ "matches","match_players", /*overlap step1*/ "match_players", ...]`. Locks the producer's query sequence so future edits to `fetchPullablePlayers` placement are caught. (Adjust the two `fetchPullablePlayers` table names to match the final implementation — this is the canonical ordering the build must satisfy.) |

#### Exact per-slot from()/rpc() response ordering to queue (canonical — keep existing sequences valid)

For a forced-repeat + held-creation slot (CC-ENG-01), the from() queue is:

```
[0] sessions            → { is_auto_matchmaking_on: true }          (toggle)
[1] courts              → [{ id: "c1" }]
[2] v_queue_with_wait_time → 4 waiting (maxWait≥8 → gate released)   (Promise.all[0])
[3] matches (count)     → draftCount=0 → slots=3                      (Promise.all[1])
[4] sessions            → { max_auto_drafts_override: null }          (Promise.all[2])
[5] matches             → fetchRecentRosters recent IDs (all-4 roster)
[6] match_players       → fetchRecentRosters roster rows
[7] match_players (or matches) → fetchPullablePlayers: playing bodies + in_progress match
[8] matches (or match_players) → fetchPullablePlayers: last-~3 streak read
--- slot 0 ---
[9]  v_queue_with_wait_time → fetchActivePool (4 waiting)
[10] queue_entries         → fetchActivePool paused filter → []
[11] matches               → fetchPartnershipCounts step 1 (cap rows)
[12] match_players         → fetchPartnershipCounts step 2
[13] match_players         → buildOverlapMap step 1 (anchor's matches)
[14] matches               → buildOverlapMap step 2 (session filter) — only if [13] non-empty
[15] match_players         → buildOverlapMap step 3 — only if [14] non-empty
--- rpc ---
rpc[0] create_held_cross_court_match → { data: "held-1", error: null }   // one pulled
```

Notes for the queue:
- **`fetchPullablePlayers` adds exactly the two from() calls at [7]/[8].** When it returns `[]` (no playing bodies), those two responses are `{ data: [], error: null }` and NO held path runs — this is why **every existing non-cross-court test is unaffected**: they have no `in_progress` match, so `[7]`/`[8]` resolve empty and the augmented re-run is skipped. Insert `{ data: [], error: null }, { data: [], error: null }` after each existing test's `fetchRecentRosters` response when wiring Phase 4 (or have `fetchPullablePlayers` short-circuit on no playing rows so step [8] isn't issued — match the final impl).
- The augmented-pool re-run does NOT re-issue `fetchActivePool`/`fetchPartnershipCounts`/`buildOverlapMap` — it reuses the slot's already-fetched maps and just re-runs the pure pipeline on `[...waiting, eligiblePulled]`. So a held slot adds **no** extra from() calls beyond `fetchPullablePlayers`; only the RPC name changes.

#### Not unit-testable here (covered elsewhere, per repo convention — E2E out)

- **`create_held_cross_court_match` Guards 0/1/1b/2** (real Postgres `FOR UPDATE ORDER BY player_id`, the non-locking pulled read M-6, the `is_held` GENERATED column R3-2): the mock `rpc` only returns a queued value — it cannot exercise SQL guards. Covered by **integration tests against a real/branch Postgres** and the migration's own guard checks. Unit layer asserts only that the engine *calls* the RPC with the right args and *handles* a NULL return (CC-ENG-04).
- **Streak / `isPullEligible` / `pickEarliestFinishing` correctness**: pure, owned by the `matchmaking-core.test.ts` cluster — not re-tested here. This cluster only asserts the engine *threads* an eligible body into the RPC and suppresses the held path when none is eligible (CC-ENG-03).
- **`recomputeHeldReadiness` / promotion skip-and-defer**: owned by the Promotion/Triggers cluster.

---

## 3. Promotion & Readiness

### Cluster: Promotion + Readiness (`promoteOnDeckMatchInternal` TS-filter promotion + `recomputeHeldReadiness`)

**Target test files**
- Promotion (TS-filter) cases extend the existing `describe("promoteOnDeckMatchInternal", …)` block in `tests/unit/matchmaking-engine.test.ts` (reuse `makeMockClient`/`makeBuilder`, the `MOCK_MATCH*`/`SESSION_ID`/`COURT_ID` fixtures, and the `vi.mock` lines for `next/server` `after`, `@/lib/notifications/push-server`, and the service client already at the top of that file).
- `recomputeHeldReadiness` cases go in a **new sibling** `describe("recomputeHeldReadiness", …)` in the **same** `tests/unit/matchmaking-engine.test.ts` (it takes the service client directly as a param — identical harness shape to `promoteOnDeckMatchInternal`; no new mock infra needed). The function is exported from `@/app/actions/matchmaking` (add to the existing import on line ~59-63).

**Real signatures the assertions key on (verified against source):**
- `promoteOnDeckMatchInternal(supabase, sessionId, courtId): Promise<MatchmakingResult>` — returns `{ success, message?, matchId?, teamA?, teamB?, isMixedLevel?, hasDraftsBlocking? }`.
- `recomputeHeldReadiness(supabase, sessionId): Promise<void>` (new; mirror the void/graceful-skip convention of `runEngineForSession`).
- `clear_on_deck_match_atomic` RPC: `Args { p_match_id: string; p_session_id: string }`, `Returns string[]` — assert via `mock.rpc` calls.
- Match rows carry the new Phase-2 columns: `is_held` (generated, R3-2), `pulled_player_ids: uuid[]`, `pulled_from_match_id: uuid | null`, `held_ready_at: timestamptz | null`.

**Harness wiring notes (shared):**
- `makeMockClient(fromResponses, rpcResponses)` — each `from(table)` pops the next `fromResponses` entry; each `rpc(name,args)` pops the next `rpcResponses` entry (default `{ data: "new-match-id", error: null }`). `mock.queriedTables` records table-access order; assert it to prove which branch ran.
- `makeBuilder` resolves the SAME response whether awaited directly or via `.single()`/`.maybeSingle()`. A 0-row CAS update is modeled as `{ data: null, error: null }` (the `.select(...).single()` resolves null → "already promoted" branch). **Add `"is"` and `"gt"` to the `makeBuilder` chain-method loop** (line ~99-111) — `recomputeHeldReadiness` uses `.is("pulled_from_match_id", null)` filters and `.gt("started_at", …)` for the promotion COUNT; without them the chain throws `TypeError`.
- For `held_ready_at` time assertions, freeze the clock: `vi.useFakeTimers(); vi.setSystemTime(new Date("2026-06-07T12:00:00Z"))` in the case, `vi.useRealTimers()` after — so `Date.now()` and the 3-min fallback (`CROSS_COURT_REST_FALLBACK_MINUTES`) are deterministic. Cases below use a fixed `NOW`.

---

#### A. `promoteOnDeckMatchInternal` — TS-filter promotion (C-4 / R3-A)

The published-pending fetch is **no longer `.limit(1)`** — it pulls the small ordered set (`.eq("is_published",true).order("sort_order").order("created_at")`), then JS picks the first **ready** row: `!m.is_held || (m.held_ready_at && Date.parse(m.held_ready_at) <= Date.now())`. The chosen row is CAS-updated **by id**. All cases freeze `NOW = 2026-06-07T12:00:00Z`.

| id | scenario | setup / mock (`fromResponses`, in order) | assert |
|---|---|---|---|
| **CC-PROM-01** | front-most READY normal draft promoted (baseline, no held in set) | `[0]` matches fetch → `[{id:"m-norm", is_held:false, pulled_player_ids:[], is_mixed_level:false}]`; `[1]` matches CAS update → `{id:"m-norm"}`; `[2]` courts update → null; `[3]` match_players → `MOCK_MATCH_PLAYERS`; `[4]` queue_entries → null; `[5]` profiles → `MOCK_PROFILES` | `success:true`; `matchId:"m-norm"`; `teamA:["Alice","Bob"]`; `queriedTables` starts `["matches","matches","courts","match_players","queue_entries","profiles"]`. The CAS `.update` was called `.eq("id","m-norm")`. |
| **CC-PROM-02** | **held-not-ready at front is SKIPPED; ready normal draft behind it promotes** (C-4/R3-A core) | `[0]` matches fetch → `[{id:"m-held", is_held:true, held_ready_at:null, pulled_player_ids:["b1"]}, {id:"m-ready", is_held:false, pulled_player_ids:[]}]`; `[1]` CAS update → `{id:"m-ready"}`; `[2]` courts; `[3]` match_players → `[]`; `[4]` profiles → `[]` | `success:true`; **`matchId:"m-ready"`** (the held one was skipped, not promoted); CAS `.update` was `.eq("id","m-ready")` (NOT `"m-held"`). |
| **CC-PROM-03** | held with **future** `held_ready_at` skipped; ready behind promotes | `[0]` → `[{id:"m-held", is_held:true, held_ready_at:"2026-06-07T12:05:00Z" /* NOW+5min */, pulled_player_ids:["b1"]}, {id:"m-ready", is_held:false}]`; then promote-`m-ready` sequence as CC-PROM-02 | `matchId:"m-ready"`; held skipped because `Date.parse(held_ready_at) > Date.now()`. |
| **CC-PROM-04** | held with **past/equal** `held_ready_at` IS ready and **is** promoted when front-most | `[0]` → `[{id:"m-held", is_held:true, held_ready_at:"2026-06-07T11:59:00Z" /* NOW-1min */, pulled_player_ids:["b1"]}]`; `[1]` CAS → `{id:"m-held"}`; `[2]` courts; `[3]` match_players → `[]`; `[4]` profiles → `[]` | `success:true`; `matchId:"m-held"`; CAS `.eq("id","m-held")`. Boundary: also covered at exactly `=== NOW` (`held_ready_at:"2026-06-07T12:00:00Z"`) → still ready (`<=`). |
| **CC-PROM-05** | **only held-not-ready exist ⇒ `{success:false}`, court frees, no CAS** (C-4: never idle for a held one) | `[0]` matches fetch → `[{id:"m-held", is_held:true, held_ready_at:null, pulled_player_ids:["b1"]}]` (single held, not ready); `[1]` draft-blocking count check → `{count:0}` | `success:false`; `message` matches `/no on-deck/i`; **`mock.rpc` not called; no `courts` update queried** (court is freed by the caller's normal flow, this fn just declines). `queriedTables` is `["matches","matches"]` (fetch + draft-count check, NO `courts`/`match_players`). |
| **CC-PROM-06** | **CAS-by-id single-winner on simultaneous free** (R3-A) | `[0]` matches fetch → `[{id:"m-ready", is_held:false}]`; `[1]` CAS update → `{data:null, error:null}` (0 rows — peer court already took it) | `success:false`; `message` matches `/already promoted/i`; `queriedTables` is `["matches","matches"]` (no `courts` after the failed CAS). Proves the by-id `.eq("status","pending")` guard bails the loser. |
| **CC-PROM-07** | mixed ordered set: held-not-ready (front) + held-ready (mid) ⇒ the **ready held** promotes, normal-ready behind is NOT reached | `[0]` → `[{id:"m-h1",is_held:true,held_ready_at:null}, {id:"m-h2",is_held:true,held_ready_at:"2026-06-07T11:58:00Z"}, {id:"m-norm",is_held:false}]`; promote-`m-h2` sequence | `matchId:"m-h2"` (first **ready** in order wins — skip `m-h1`, take `m-h2` before reaching `m-norm`); CAS `.eq("id","m-h2")`. |
| **CC-PROM-08** | DB error on fetch still surfaced verbatim (regression guard, unchanged behavior under new filter) | `[0]` matches fetch → `{data:null, error:{message:"connection timeout"}}` | `success:false`; `message` matches `/failed to fetch/i`. (Mirrors existing test at line 228 — confirms TS-filter refactor didn't swallow the error path.) |

**Note (CC-PROM):** the TS-side `.filter(...)` over the fetched array is the unit-testable core; the assertion that the CAS hit the *correct* id (`.eq("id", …)`) is what distinguishes skip-and-defer from the old `.limit(1)` behavior. Capture the id passed to `.update().eq("id", X)` by spying — the existing harness returns `b` from `.eq`, so add a `vi.fn` capture or assert via the response wiring (the CAS response's `{id}` already pins which match the test *configured* as the winner; the stronger check is to make CC-PROM-02's CAS response `{data:null}` for a wrong-id update — but the simplest transplantable form is matching `matchId` in the result, which is derived from the chosen row).

---

#### B. `recomputeHeldReadiness` — health check + readiness stamping

Per-held-pending-match loop order (from Phase 5): **(1) N-2 roster integrity FIRST → (2) R3-B source integrity → (3) C-5 readiness + idempotent stamp**. Each held match the fn iterates is fetched as the initial query (held + not-ready + pending: `.is("held_ready_at", null).eq("status","pending")` with `is_held=true`). All cases freeze `NOW = 2026-06-07T12:00:00Z`.

**Mock-harness wiring for this block:**
- `mock.rpc` carries `clear_on_deck_match_atomic` outcomes; default returns `["w1","w2","w3"]` (the 3 freed waiting members) — assert `mock.rpc` was/wasn't called with `("clear_on_deck_match_atomic", { p_match_id, p_session_id })`.
- The held-cols clear (N-2 downgrade) and the `held_ready_at` stamp are **plain `matches.update`** calls → assert via `queriedTables` containing `"matches"` updates and (where it matters) that `rpc` was NOT called.
- Add `"is"`/`"gt"` to `makeBuilder` (see shared notes).

| id | scenario | setup / mock | assert |
|---|---|---|---|
| **CC-RDY-01 (N-2)** | **roster integrity FIRST — `pulled_player_ids[0]` no longer in `match_players` ⇒ downgrade to normal draft** (clear `pulled_player_ids`+`held_ready_at`), then skip; no readiness, no cancel | `[0]` held-pending fetch → `[{id:"m-h", pulled_player_ids:["b1"], pulled_from_match_id:"src", held_ready_at:null, status:"pending", session_id:SESSION_ID}]`; `[1]` match_players for `m-h` → `[{player_id:"w1"},{player_id:"w2"},{player_id:"w3"}]` (**no `b1`** — swapped out); `[2]` matches update (downgrade) → null | resolves `undefined` (void); the downgrade `matches.update` ran with `pulled_player_ids:[]` and `held_ready_at:null`; **`mock.rpc` NOT called** (downgrade ≠ cancel — keeps the 3-player roster as a normal draft); source-integrity + readiness branches NOT reached (no `gt`/source query after). This is the exact detection Phase 7e's swap auto-downgrade relies on. |
| **CC-RDY-02 (N-2 negative)** | pulled body still present ⇒ no downgrade, proceed to next check | `[0]` fetch → `[{id:"m-h", pulled_player_ids:["b1"], pulled_from_match_id:"src", held_ready_at:null}]`; `[1]` match_players → `[{player_id:"b1"},{player_id:"w1"},{player_id:"w2"},{player_id:"w3"}]` (b1 present); then source-integrity query → src present, in_progress (not free) | no downgrade `update`; no `clear_on_deck_match_atomic`; **no `held_ready_at` stamp** (source still in_progress → body not free → not ready). Proves the happy "still holding" no-op. |
| **CC-RDY-03 (R3-B)** | **source-match integrity — `pulled_from_match_id IS NULL` ⇒ cancel via `clear_on_deck_match_atomic`** (FK set null by L-4 `ON DELETE SET NULL`) | `[0]` fetch → `[{id:"m-h", pulled_player_ids:["b1"], pulled_from_match_id:null, held_ready_at:null, session_id:SESSION_ID}]`; `[1]` match_players → roster incl. `b1` (passes N-2); rpc `clear_on_deck_match_atomic` → `["w1","w2","w3"]` | **`mock.rpc` called with `("clear_on_deck_match_atomic", { p_match_id:"m-h", p_session_id:SESSION_ID })`**; no `held_ready_at` stamp. This is what makes `ON DELETE SET NULL` safe vs. a silent "Holding" lock. |
| **CC-RDY-04 (R3-B)** | source-match referenced but **no longer exists** (purged) ⇒ same cancel path | `[0]` fetch → `[{id:"m-h", pulled_from_match_id:"src-gone", pulled_player_ids:["b1"], held_ready_at:null}]`; `[1]` match_players incl. `b1`; `[2]` source-match lookup `matches.eq("id","src-gone")` → `{data:null}` (missing); rpc clear → `["w1","w2","w3"]` | `mock.rpc` called with `clear_on_deck_match_atomic` for `m-h`; no stamp. |
| **CC-RDY-05 (C-5, not-ready)** | body free (source completed) but **0 promotions since freed AND <3 min elapsed ⇒ NOT ready** (no stamp) | source `completed_at = "2026-06-07T11:58:30Z"` (NOW−90s, <3min). `[0]` fetch → `[{id:"m-h", pulled_from_match_id:"src", pulled_player_ids:["b1"], held_ready_at:null}]`; `[1]` match_players incl b1; `[2]` source lookup → `{id:"src", status:"completed", completed_at:"2026-06-07T11:58:30Z"}`; `[3]` promotions COUNT (`matches` `.in("status",["in_progress","completed","cancelled"]).gt("started_at", src.completed_at)`) → `{count:0}` | **no `held_ready_at` `matches.update`** (`isHeldMatchReady` false: `promotionsSinceFreed=0` and elapsed `90s < 180s` fallback). `mock.rpc` not called. |
| **CC-RDY-06 (C-5, ready via 1 promotion)** | body free + **≥1 promotion since freed ⇒ ready ⇒ stamp `held_ready_at`** (no new column — derived from COUNT of `started_at > completed_at`) | source `completed_at="2026-06-07T11:59:00Z"` (NOW−60s, <3min so timer alone wouldn't fire). `[0]` fetch → held `m-h`; `[1]` match_players incl b1; `[2]` source → `{status:"completed", completed_at:"...11:59:00Z"}`; `[3]` promotions COUNT → `{count:1}` ; `[4]` matches update (stamp) → `{id:"m-h"}` | a `matches.update` ran setting `held_ready_at` to a non-null ISO (== NOW); proves **C-5: `promotionsSinceFreed = COUNT(started_at > completed_at)` with no schema column** and that 1 promotion satisfies readiness independent of the 3-min timer. |
| **CC-RDY-07 (C-5, ready via 3-min fallback)** | body free + **0 promotions BUT ≥3 min elapsed ⇒ ready ⇒ stamp** (`CROSS_COURT_REST_FALLBACK_MINUTES`) | source `completed_at="2026-06-07T11:56:00Z"` (NOW−4min). `[0]`–`[2]` as above with `count` query; `[3]` promotions COUNT → `{count:0}`; `[4]` matches update (stamp) → `{id:"m-h"}` | `held_ready_at` stamped (== NOW) because elapsed `240s ≥ 180s` fallback even with 0 promotions. Boundary: also assert at exactly `completed_at = NOW−3min` (`"11:57:00Z"`, count 0) → ready (`>=`); and `NOW−(3min−1s)` (`"11:57:01Z"`, count 0) → NOT ready. |
| **CC-RDY-08 (idempotent stamp)** | already-stamped held match not re-stamped / not re-processed | held-pending fetch query filters `.is("held_ready_at", null)` → a match with non-null `held_ready_at` is **excluded by the query itself**: `[0]` fetch → `[]` (already-ready match doesn't come back) | resolves void; **no `matches.update`, no `rpc`** — `queriedTables` is just `["matches"]`. Proves the stamp is write-once (idempotent: the `.is("held_ready_at", null)` predicate is the idempotency guard, so re-running on the same now-ready match is a no-op). |
| **CC-RDY-09 (empty / no-op)** | no held drafts pending ⇒ clean no-op | `[0]` held-pending fetch → `[]` | resolves `undefined`; `queriedTables === ["matches"]`; `mock.rpc` not called. (Mirror of the toggle-OFF early-return convention.) |
| **CC-RDY-10 (graceful DB error)** | fetch error ⇒ no throw, no mutation | `[0]` held-pending fetch → `{data:null, error:{message:"Table not found"}}` | `await expect(recomputeHeldReadiness(mock, SESSION_ID)).resolves.toBeUndefined()`; no `update`/`rpc`. (Same graceful-skip contract as `runEngineForSession`'s session-error test, line 438.) |
| **CC-RDY-11 (order — N-2 wins over R3-B)** | roster-gone AND source-null on the same match ⇒ **downgrade (N-2), not cancel (R3-B)** — ordering regression | `[0]` fetch → `[{id:"m-h", pulled_player_ids:["b1"], pulled_from_match_id:null, held_ready_at:null}]`; `[1]` match_players → `[{player_id:"w1"},{player_id:"w2"},{player_id:"w3"}]` (no b1) | downgrade `matches.update` (`pulled_player_ids:[]`) ran; **`clear_on_deck_match_atomic` NOT called** — confirms N-2 runs FIRST and short-circuits before R3-B (a roster-broken draft becomes a salvageable normal draft, it is not cancelled). |

---

#### C. Regression tags explicitly covered

- **C-4 / R3-A** (TS-filter, no timestamp in PostgREST `.or()`): CC-PROM-02, -03, -04, -07 (JS readiness pick over the fetched set, `held_ready_at <= now` boundary), CC-PROM-05 (only-not-ready ⇒ `{success:false}`, no idle), CC-PROM-06 (CAS-by-id single-winner). No `.or(... + nowIso + ...)` string is ever constructed — assert the fetch chain does NOT call `.or` with a timestamp (the harness records no such call).
- **N-2** (roster integrity FIRST): CC-RDY-01, -02 (negative), -11 (ordering vs R3-B).
- **R3-B** (source-match integrity ⇒ cancel via `clear_on_deck_match_atomic`): CC-RDY-03 (null FK), -04 (missing match), -11 (does NOT fire when N-2 applies).
- **C-5** (`promotionsSinceFreed = COUNT(started_at > completed_at)`, no new column + 3-min fallback): CC-RDY-05 (0 promo + <3min ⇒ not ready), -06 (1 promo ⇒ ready), -07 (0 promo + ≥3min ⇒ ready, with boundary).
- **Idempotent stamping:** CC-RDY-08 (the `.is("held_ready_at", null)` query predicate is the write-once guard).

---

#### D. Not unit-testable here (covered elsewhere, per repo convention — E2E out)

- **Real Postgres TOCTOU / FOR UPDATE / generated `is_held` / Guard 0–2 / Guard 1b** of `create_held_cross_court_match` and `clear_on_deck_match_atomic`'s in-transaction row-locking: the mock harness cannot exercise true concurrency or the `cardinality(pulled_player_ids) > 0` generated column. Covered by **manual/integration verification against a real branch DB** (Supabase migration + RPC), per the same convention the repo uses for `create_match_with_players` guards. The unit layer only asserts the **TS caller** invokes the RPC with the right args and handles its NULL/`string[]` return.
- **The `ON DELETE SET NULL` FK firing** (L-4) is a DB-level behavior; the unit layer instead simulates its *effect* (`pulled_from_match_id:null` row, CC-RDY-03) and asserts `recomputeHeldReadiness`'s R3-B response.
- **Cross-trigger sequencing** (recompute runs *before* promote/engine at `endMatchAction`/`cancelMatchAction`/publish/`callNextMatch`) belongs to the **Phase 6 / triggers cluster** (sibling to `publish-engine-trigger.test.ts`), not this one — here we test the two functions in isolation.

---

## 4. Triggers & Lifecycle

### Cluster: Triggers + Lifecycle — `endMatchAction` / `cancelMatchAction` / publish / `callNextMatch`

**Target test files**
- `tests/unit/publish-engine-trigger.test.ts` — extend with the publish-path readiness-ordering cases (PE-series already lives here; add `CC-TRG-PUB-*`).
- `tests/unit/match-lifecycle-cross-court.test.ts` — **NEW** file for `endMatchAction` / `cancelMatchAction` cases (the R3-1 ghost-availability regression, leaver, staleness). Keep `match-origin-tracking.test.ts` untouched; the cross-court lifecycle surface is large enough to warrant its own suite, mirroring that file's `makeBuilder` + table-routed `from()` harness.
- `tests/unit/matchmaking-engine.test.ts` — extend with the `callNextMatch` readiness-ordering case (`CC-TRG-CNM-*`); harness (`makeMockClient` with `queriedTables`) already lives there.

**Mock-harness wiring (applies to all cases below)**
- `recomputeHeldReadiness` is a NEW export of `@/app/actions/matchmaking` (same module as `runEngineForSession`/`promoteOnDeckMatchInternal`). To assert ordering against `runEngineForSession` it MUST be mocked in the same factory:
  ```ts
  vi.mock("@/app/actions/matchmaking", () => ({
    runEngineForSession: vi.fn(),
    recomputeHeldReadiness: vi.fn(),
    promoteOnDeckMatchInternal: vi.fn(), // for publish/lifecycle suites that don't drive the real engine
  }));
  ```
  In the engine suite (`matchmaking-engine.test.ts`) `promoteOnDeckMatchInternal`/`callNextMatch` are the **real** exports under test, so there `recomputeHeldReadiness` is the only thing to add to the partial mock via `vi.importActual` spread, OR `callNextMatch` ordering is asserted through the existing `queriedTables` (a `matches` read for held drafts appears before the `sessions` toggle read). Prefer `invocationCallOrder` where both are mocked.
- Keep the existing module mocks verbatim: `vi.mock("@/utils/supabase/server")`, `vi.mock("@/utils/supabase/service")`, `vi.mock("next/server", () => ({ after: (cb) => cb() }))`, `vi.mock("@/lib/notifications/push-server", ...)`, `vi.mock("@/app/actions/_shared", ...)` (for `getAuthenticatedUser`/`isSessionOrganizer`). For the lifecycle suite also mock `@/lib/broadcast` (`broadcastOrganizerIntervention: vi.fn()`).
- **Call-order assertion idiom** (both fns mocked):
  ```ts
  const recomputeOrder = vi.mocked(recomputeHeldReadiness).mock.invocationCallOrder[0];
  const engineOrder = vi.mocked(runEngineForSession).mock.invocationCallOrder[0];
  expect(recomputeOrder).toBeLessThan(engineOrder);
  ```
  For sites that promote (`endMatchAction`/`cancelMatchAction`/`callNextMatch`), `recomputeHeldReadiness` must also precede `promoteOnDeckMatchInternal` — assert against its `invocationCallOrder` the same way.
- `endMatchAction`/`cancelMatchAction` use the **service client** for every `from()`/`rpc()`. The service mock is a table-routed `from()` (route by table name, NOT a flat positional queue) because both actions issue many ordered reads/writes (`matches` fetch → `match_players` fetch → per-player `queue_entries` select+update → promote → leaderboard rpc). Use the `match-origin-tracking.test.ts` `from(table)` switch style, returning a fresh `makeBuilder` per table, and capture writes via `vi.fn` spies wrapped around `update`/`select` so the R3-1 status assertion can read back the payload.

---

#### Group A — Readiness recompute runs BEFORE engine/promote at every trigger site (Phase 6)

| id | trigger / scenario | setup / mock | assert |
|---|---|---|---|
| CC-TRG-END-01 | `endMatchAction` completion calls `recomputeHeldReadiness` before `runEngineForSession` | service mock: `matches` fetch → in_progress match w/ `court_id`; `match_players` → 4 rows; per-player `queue_entries` select → non-left; `promoteOnDeckMatchInternal` mocked → `{success:true}`. `isSessionOrganizer`→true. | `result.success===true`; `recomputeHeldReadiness` called once with `(db, SESSION_ID)`; `invocationCallOrder` of recompute < `promoteOnDeckMatchInternal` < `runEngineForSession`. |
| CC-TRG-END-02 | `endMatchAction` with **no `court_id`** still recomputes readiness (a freed body can ready an *unrelated* held draft even when this match held no court) | same but `matches` fetch returns `court_id:null` | `recomputeHeldReadiness` called once **before** the early bail on the `court_id` block; `promoteOnDeckMatchInternal`/`runEngineForSession` NOT called (no court). *(Encodes the design: completion is the body-freeing event regardless of court ownership.)* |
| CC-TRG-CAN-01 | `cancelMatchAction` calls `recomputeHeldReadiness` before promote+engine | service mock: `matches` fetch → in_progress w/ court; CAS update `select("id")` → `[{id}]`; `match_players` → rows; `queue_entries` update; `promoteOnDeckMatchInternal` mocked `{success:true}`. `isSessionOrganizer`→true. | recompute called once `(db, SESSION_ID)`; order recompute < promote < `runEngineForSession`. |
| CC-TRG-PUB-01 | `publishMatchAction` (RPC `SUCCESS`) recomputes readiness before engine | extend existing PE-1: server client `matches.select(session_id)`; svc `rpc("publish_match")→"SUCCESS"`, `match_players` roster fetch. | `recomputeHeldReadiness` called `(svc, SESSION_ID)` and `invocationCallOrder` < `runEngineForSession`. |
| CC-TRG-PUB-02 | `publishMatchAction` no-publish (`ALREADY_PUBLISHED`) ⇒ recompute NOT called | extend PE-2 (`rpc→"ALREADY_PUBLISHED"`) | `runEngineForSession` not called (existing) **AND** `recomputeHeldReadiness` not called — recompute is gated on the same success branch as the engine, never on a no-op publish. |
| CC-TRG-PUB-03 | `publishAllDraftMatchesAction` (`published_count>0`) recomputes before engine | extend PE-4 | recompute called `(svc, SESSION_ID)`, order < `runEngineForSession`. |
| CC-TRG-PUB-04 | `publishAllDraftMatchesAction` (`published_count===0`) ⇒ recompute NOT called | extend PE-5 | neither recompute nor engine called. |
| CC-TRG-CNM-01 | `callNextMatch` recomputes readiness before promotion | engine suite: real `callNextMatch`; mock `recomputeHeldReadiness` (spread real module via `importActual`); service mock so first `promoteOnDeckMatchInternal` succeeds (published pending row). `auth.getUser`→user, `isSessionOrganizer`→true. | recompute `invocationCallOrder` < the `matches` pending-fetch that drives promotion; `result.success===true`. |

**Wiring note (Group A):** these are pure call-ordering/gating tests — the *content* of `recomputeHeldReadiness` is covered in the Phase-5 pure/DB cluster, so here it stays a `vi.fn()`. The only new queued responses are those the action itself needs to reach the trigger line (already enumerated per row). For `endMatchAction`, the per-player `queue_entries` loop must each resolve (`maybeSingle()` returns an entry), else the action throws before promote.

---

#### Group B — R3-1 Ghost-availability REGRESSION (tag **R3-1**) — `endMatchAction` re-queue status

This is the headline regression for the cluster: when `endMatchAction` re-queues the finishing roster, a player whose id ∈ a **pending held draft's** `pulled_player_ids` must be set to `status='drafted'`, NOT `'waiting'`. A normal finisher (not in any held draft) still goes `'waiting'`.

**Harness add:** `endMatchAction` will gain a lookup (before/within the re-queue loop) of pending held drafts for the session — i.e. a `from("matches").select("pulled_player_ids").eq("session_id",…).eq("status","pending").gt(...)`-style read returning rows with `pulled_player_ids` arrays (route this in the table switch; add `"gt"`/`"contains"`/`"overlaps"` to the `makeBuilder` method list since the lookup may use `.overlaps("pulled_player_ids", rosterIds)`). Capture the `queue_entries.update(...)` payload per player by spying on `update` and recording `(payload, playerId)` keyed off the trailing `.eq("player_id", id)`.

| id | scenario | setup / mock | assert |
|---|---|---|---|
| CC-TRG-GHOST-01 | finishing pulled body whose id ∈ a pending held draft ⇒ `status='drafted'` | `matches` fetch → in_progress (4 players incl. pulled body `P_pull`); held-draft lookup → `[{pulled_player_ids:[P_pull]}]`; per-player `queue_entries` selects non-left. | the `queue_entries.update` for `P_pull` carries `status:"drafted"` (NOT `"waiting"`); `games_played` still incremented; `joined_at` still stamped. |
| CC-TRG-GHOST-02 | normal finisher (not in any held draft) still ⇒ `status='waiting'` (no regression to the default path) | same as 01 but assert the **other three** roster players | each non-pulled player's update carries `status:"waiting"`. |
| CC-TRG-GHOST-03 | mixed roster: one pulled-body, three normal, single held draft naming only the pulled body | held lookup → one row naming `P_pull` only | exactly ONE update is `"drafted"` (the pulled body); the three others `"waiting"`. Guards against over-broad `.overlaps` matching the wrong ids. |
| CC-TRG-GHOST-04 | NO pending held drafts at all ⇒ all four ⇒ `'waiting'` (held-feature-off / no-draft baseline) | held lookup → `[]` | all four updates `"waiting"`; behaviour identical to pre-feature `endMatchAction`. |
| CC-TRG-GHOST-05 | a held draft exists but for a DIFFERENT body (this match's finishers aren't pulled anywhere) | held lookup → `[{pulled_player_ids:[someOtherId]}]` | all four finishers `"waiting"` (reservation only applies to the named body). |
| CC-TRG-GHOST-06 | `'left'` guard preserved for a pulled body who checked out mid-game | `queue_entries` select for `P_pull` returns null (status `left`) | `P_pull` is skipped entirely — NO update issued (the `.neq("status","left")` guard wins over the drafted-reservation; a body who physically left is never reserved as `'drafted'`). |

**Why this is correct-by-construction (cite in test comment):** per plan Phase 6, leaving the body as `'waiting'` only leaks a reservation (`create_match_with_players` Guard 2 still NULL-returns, no double-book) — but the assertion pins the *intended* `'drafted'` so the engine doesn't waste slots proposing the body. `'drafted'` is later resolved by `promoteOnDeckMatchInternal` (`drafted→playing`) or `clear_on_deck_match_atomic` (`drafted→waiting`).

---

#### Group C — Leaver: pulled body checks out / status='left' ⇒ held draft cancelled-and-rebuilt, NOT cleared-in-place

The plan (Phase 5, M-2) routes a checked-out pulled body through `checkout_player_cleanup_drafts` / `clear_on_deck_match_atomic`. The TS-testable surface is the `recomputeHeldReadiness` branch that detects "pulled body no longer `playing` / no longer in `pulled_from_match_id`" and cancels via `clear_on_deck_match_atomic`. **The in-DB RPC cascade (`checkout_player_cleanup_drafts` deleting the pending held match) is NOT unit-testable** — it's a real-Postgres trigger/RPC; covered by integration/manual per repo convention (E2E out). Unit coverage targets only the TS recompute branch and the lifecycle wiring.

| id | scenario | setup / mock (recompute under test in Phase-5 cluster; lifecycle wiring here) | assert |
|---|---|---|---|
| CC-TRG-LEAVER-01 | pulled body's `queue_entries.status` flips to `'left'` while held draft pending ⇒ recompute cancels via `clear_on_deck_match_atomic` (3 waiting members → `'waiting'`), does NOT clear `pulled_player_ids` in place | (lifecycle wiring) any trigger calls `recomputeHeldReadiness` first; (branch) held match row where `pulled_player_ids[0]` body status='left'/not in `pulled_from_match_id` as in_progress | the recompute path invokes `rpc("clear_on_deck_match_atomic", {p_match_id})` — NOT a `matches.update({pulled_player_ids:[],held_ready_at:null})`. **No 3-player invalid draft is ever produced.** |
| CC-TRG-LEAVER-02 | distinguishes leaver-cancel from swap-downgrade (N-2) | held row where roster integrity is intact but body left | takes the cancel-and-rebuild branch, NOT the N-2 in-place downgrade branch (downgrade is only for roster mismatch where `pulled_player_ids[0]` ∉ `match_players`). |

**Cross-reference:** the roster-integrity (N-2) and source-match (R3-B) recompute branches themselves are exercised in the Phase-5 `recomputeHeldReadiness` cluster; here we only assert the **lifecycle trigger invokes recompute** so the leaver is caught at the next event. The full `checkout_player_cleanup_drafts` deletion is integration-only.

---

#### Group D — Staleness escape: waiting member hits Red Zone while pulled court drags ⇒ hold abandoned, members seated

Like Group C, the *detection* (a waiting member nearing Red Zone) lives inside `recomputeHeldReadiness` and is unit-tested in the Phase-5 cluster against `clear_on_deck_match_atomic`. The cluster-relevant lifecycle assertion is that the abandonment then lets the freed members be **seated now** by the engine.

| id | scenario | setup / mock | assert |
|---|---|---|---|
| CC-TRG-STALE-01 | recompute abandons a stale hold (waiting member near Red Zone) ⇒ members returned to `'waiting'` and engine can seat them | (Phase-5 branch under test) held row where a `drafted` member's wait ≥ staleness threshold (< 25 min Red Zone trigger) → recompute calls `clear_on_deck_match_atomic`; (lifecycle) `runEngineForSession` runs AFTER recompute | recompute invokes `rpc("clear_on_deck_match_atomic", …)`; ordering recompute < `runEngineForSession` so the just-freed members are visible to the immediately-following engine pass (seated now, not idled). |
| CC-TRG-STALE-02 | non-stale hold (member comfortably below threshold) is NOT abandoned | held row, member wait small | NO `clear_on_deck_match_atomic` call; held draft survives the recompute. (Boundary guard against over-eager abandonment.) |

**Boundary note:** the exact staleness threshold (and the Red Zone 25-min seat-now decision-4 short-circuit) is an engine/Phase-5 concern. This cluster only asserts the *consequence* — recompute-before-engine ordering — so a freshly-abandoned hold's members are seated in the same trigger cycle. The Red-Zone "seat most-diverse-available now" path itself is asserted in the engine cluster (`forcedRepeat` + Red-Zone short-circuit ⇒ held RPC NOT called).

---

#### Not unit-testable here (covered elsewhere, per repo convention; E2E out)
- The `create_held_cross_court_match` RPC guards (0/1/1b/2), `FOR UPDATE` locking semantics, and `is_held` GENERATED column — **real Postgres**; integration/manual only.
- `checkout_player_cleanup_drafts` actually deleting the pending held match and freeing the 3 drafted members — real-DB RPC cascade; integration/manual.
- `clear_on_deck_match_atomic`'s internal `drafted→waiting` transition — real-DB; unit layer asserts only that the TS recompute branch *calls* the RPC with `{p_match_id}`.

#### Regression tags covered by this cluster
- **R3-1** (ghost-availability): CC-TRG-GHOST-01..06 — `endMatchAction` re-queues a pulled finisher to `'drafted'`, a normal finisher to `'waiting'`.
- **M-2** (leaver / pulled-body checkout cancel-and-rebuild, never clear-in-place): CC-TRG-LEAVER-01/02.
- **N-2 / R3-B** (recompute-first ordering at every trigger so roster/source-integrity downgrades and source-null cancels fire before promote/engine): CC-TRG-END-01/02, CC-TRG-CAN-01, CC-TRG-PUB-01/03, CC-TRG-CNM-01.
- **M-4-adjacent** (no-op publish ⇒ no recompute): CC-TRG-PUB-02/04.

Relevant source paths for the implementer: `/Users/miggy-onb/Downloads/badminton-app/src/app/actions/match-lifecycle.ts` (`endMatchAction` re-queue loop ~lines 202–231 is the R3-1 edit site; `cancelMatchAction` ~444), `/Users/miggy-onb/Downloads/badminton-app/src/app/actions/match-drafts.ts` (publish actions, `SUCCESS` branches ~350/553), `/Users/miggy-onb/Downloads/badminton-app/src/app/actions/matchmaking.ts` (`callNextMatch` ~113, new `recomputeHeldReadiness` export).

---

## 5. RPC / DB Guards

### Cluster: RPC / DB Guards — `create_held_cross_court_match` + `executeHeldMatch`

> **The riskiest change.** The Postgres function `create_held_cross_court_match` contains the load-bearing logic (Guard 0 split, Guard 1 lock-scope, Guard 1b reservation, the `is_held` GENERATED column, the status mutations). **None of that runs in vitest** — vitest mocks `supabase.rpc(...)` and never executes plpgsql, so guard *behavior* is only assertable against a real Postgres. What **is** unit-testable is the TS sibling `executeHeldMatch` in `src/lib/matchmaking-db.ts`: how it maps the RPC's return (a match id, `NULL`, or a `PostgrestError`) onto `ExecuteMatchResult`, and that it calls the right RPC with the right `p_*` payload. This subsection splits coverage explicitly into **UNIT** (vitest), **INTEGRATION** (pgTAP / a seeded test DB / Supabase branch), and **MANUAL** (documented SQL checklist) — per repo convention **E2E is out**.

**Target test files**
- **UNIT:** extend `/Users/miggy-onb/Downloads/badminton-app/tests/unit/matchmaking-engine.test.ts` — add a `describe("executeHeldMatch", …)` block alongside the existing `executeMatch`/engine suites (same `makeMockClient` harness, same `vi.mock` header for `next/server` `after`, `@/lib/notifications/push-server`, `@/utils/supabase/service`, `@/utils/supabase/server`). `executeHeldMatch` takes the client as a direct param (like `executeMatch`), so **no service-client mock is needed** for these — pass `mock as never` directly.
- **INTEGRATION:** `/Users/miggy-onb/Downloads/badminton-app/supabase/tests/create_held_cross_court_match.test.sql` (pgTAP) **or** a documented manual run. This is where every Postgres guard (Guard 0/1/1b/2, status mutations, `is_held`) is actually exercised.

---

#### UNIT (vitest) — `executeHeldMatch` RPC-result mapping

`executeHeldMatch` is the only TS surface over the new RPC. It mirrors `executeMatch`'s **NULL-return convention** exactly: `{data: id}` ⇒ success; `{data: null, error: null}` ⇒ graceful skip (a DB guard fired — `success:false`, no throw); `{data: null, error: PostgrestError}` ⇒ hard error surfaced. Returns the existing `ExecuteMatchResult` (`{ success, matchId?, message }`).

**Harness wiring:** `makeMockClient([], [<rpc responses>])` — `executeHeldMatch` makes **zero `from()` calls** and exactly **one `rpc()` call**, so the first array is empty and the RPC response goes in the second positional arg (the `rpcResponses` queue). Assert the call shape with `mock.rpc` (it is a `vi.fn`). Verify param names against the **real** signature: the RPC takes `p_session_id`, `p_team_a_ids`, `p_team_b_ids`, `p_pulled_player_id`, `p_pulled_from_match_id`, `p_is_mixed_level`, `p_origin` (no `p_court_id`/`p_started_at`/`p_status` — a held draft is always pending + unpublished + no court). **Confirm the exact `p_*` names against `executeHeldMatch`'s implementation when it lands** and adjust the `objectContaining` matchers; do not invent names.

| id | scenario | rpc response queued | assert |
|---|---|---|---|
| `CC-RPC-U01` | happy path — RPC returns a new held match id | `[{ data: "held-match-1", error: null }]` | `result.success === true`; `result.matchId === "held-match-1"`; `mock.rpc` called **once** with `"create_held_cross_court_match"` |
| `CC-RPC-U02` | **graceful NULL skip** (a Postgres guard — 0/1b/2 — returned NULL) | `[{ data: null, error: null }]` | `result.success === false`; **does NOT throw**; message matches `/skip/i` (mirror `executeMatch`'s "Slot skipped…" wording); `result.matchId` undefined |
| `CC-RPC-U03` | hard DB error surfaced (not masked as skip) | `[{ data: null, error: { message: "deadlock detected" } }]` | `result.success === false`; `result.message` contains `"deadlock detected"` (matches `/failed to create/i` prefix like `executeMatch`) |
| `CC-RPC-U04` | correct RPC name + payload shape | `[{ data: "held-match-1", error: null }]` | `mock.rpc` called with `"create_held_cross_court_match"` and `expect.objectContaining({ p_pulled_player_id: <id>, p_pulled_from_match_id: <srcMatchId>, p_origin: "auto" })`; `p_team_a_ids`/`p_team_b_ids` are 2-element arrays summing to the **3 waiting** members (the pulled body lives in `p_pulled_player_id`, NOT in a team array — or, if the impl puts all 4 into teams, assert the pulled id appears exactly once across both team arrays — pin to whichever the impl chooses) |
| `CC-RPC-U05` | engine-level: forced-repeat + 1 eligible pulled body ⇒ `executeHeldMatch` path reached, held RPC called once *(REGRESSION boundary with engine cluster — keep here only if executeHeldMatch is asserted via the engine entrypoint; otherwise this lives in the engine cluster)* | engine `fromResponses` per the existing `runEngineInternal` sequence + `rpcResponses: [{ data: "held-1", error: null }]` | `mock.rpc` called with `"create_held_cross_court_match"`; `runEngineForSession(SESSION_ID)` resolves (no throw) |

**Concrete UNIT skeleton (transplantable):**

```ts
describe("executeHeldMatch", () => {
  const PULLED_ID = "p-pulled";
  const SRC_MATCH = "00000000-0000-4000-8000-0000000000aa";
  // proposal: 3 waiting (w1,w2,w3) + 1 pulled (p-pulled), teams already snake-drafted
  const heldProposal = {
    teamA: [{ player_id: "w1", display_name: "W1" }, { player_id: PULLED_ID, display_name: "Pulled" }],
    teamB: [{ player_id: "w2", display_name: "W2" }, { player_id: "w3", display_name: "W3" }],
    isMixedLevel: false,
  };

  it("CC-RPC-U01: returns success + matchId on a valid held insert", async () => {
    const mock = makeMockClient([], [{ data: "held-match-1", error: null }]);
    const result = await executeHeldMatch(
      mock as never, SESSION_ID, heldProposal as never, PULLED_ID, SRC_MATCH
    );
    expect(result.success).toBe(true);
    expect(result.matchId).toBe("held-match-1");
    expect(mock.rpc).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledWith("create_held_cross_court_match", expect.any(Object));
  });

  it("CC-RPC-U02: RPC NULL ⇒ graceful skip (no throw, success:false)", async () => {
    const mock = makeMockClient([], [{ data: null, error: null }]);
    const result = await executeHeldMatch(
      mock as never, SESSION_ID, heldProposal as never, PULLED_ID, SRC_MATCH
    );
    expect(result.success).toBe(false);
    expect(result.matchId).toBeUndefined();
    expect(result.message).toMatch(/skip/i);
  });

  it("CC-RPC-U03: RPC hard error is surfaced, not masked as a skip", async () => {
    const mock = makeMockClient([], [{ data: null, error: { message: "deadlock detected" } }]);
    const result = await executeHeldMatch(
      mock as never, SESSION_ID, heldProposal as never, PULLED_ID, SRC_MATCH
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("deadlock detected");
  });

  it("CC-RPC-U04: calls the held RPC with the pulled-body params", async () => {
    const mock = makeMockClient([], [{ data: "held-match-1", error: null }]);
    await executeHeldMatch(mock as never, SESSION_ID, heldProposal as never, PULLED_ID, SRC_MATCH);
    expect(mock.rpc).toHaveBeenCalledWith(
      "create_held_cross_court_match",
      expect.objectContaining({
        p_session_id: SESSION_ID,
        p_pulled_player_id: PULLED_ID,
        p_pulled_from_match_id: SRC_MATCH,
        p_origin: "auto",
      })
    );
  });
});
```

> **NOT unit-testable here, by design:** `executeHeldMatch` cannot distinguish *which* guard returned NULL (Guard 0 vs 1b vs 2 all surface as `{data:null,error:null}`) — that distinction is asserted at the INTEGRATION layer below. The unit test only proves "any NULL ⇒ graceful skip," which is the entire TS contract.

---

#### INTEGRATION (pgTAP / seeded test DB) — the Postgres guards

These require a real Postgres (Supabase local branch or a CI Postgres seeded with a session + 4 players + 1 `in_progress` source match). The function under test is `create_held_cross_court_match`; assert via its return (`is NULL` vs a uuid) and follow-up `SELECT`s on `matches` / `match_players` / `queue_entries`. **E2E is out**, so this is the only automated place the guards are proven; if pgTAP/branch infra is unavailable, fall back to the MANUAL checklist (identical cases, run by hand).

| id | scenario | setup | assert |
|---|---|---|---|
| `CC-RPC-I01` | **Guard 0 split — happy path** | 3 members `status='waiting'`; pulled body `status='playing'` AND a `match_players` row of `p_pulled_from_match_id` whose `matches.status='in_progress'` | returns a **non-NULL** uuid; new `matches` row exists, `is_published=false`, `pulled_player_ids = {pulled}`, `pulled_from_match_id = <src>` |
| `CC-RPC-I02` | **Guard 0 — a "waiting" member isn't waiting** | one of the 3 members is `drafted`/`playing`/`left` instead of `waiting` | returns **NULL**; no `matches` row inserted; the 3 members' statuses unchanged |
| `CC-RPC-I03` | **Guard 0 — pulled body not `playing`** | pulled body is `waiting` (or `paused`) | returns **NULL**; no insert |
| `CC-RPC-I04` | **Guard 0 — pulled body not in the source match** | pulled body is `playing` but in a *different* match than `p_pulled_from_match_id` | returns **NULL** |
| `CC-RPC-I05` | **Guard 0 — source match not `in_progress`** | `p_pulled_from_match_id.status = 'pending'` (or `completed`) | returns **NULL** |
| `CC-RPC-I06` | **Guard 1b reservation (NEW)** — pulled body already held elsewhere | pulled body `= ANY(pulled_player_ids)` of an existing **pending** held draft | returns **NULL**; the existing held draft is untouched. *(REGRESSION: tag **N-1 / "no body in two held drafts"** — this is the hard backstop the relational streak cooldown does NOT cover during the holding window.)* |
| `CC-RPC-I07` | **Guard 2 — a waiting member double-booked** | one of the 3 waiting members is already in another `pending`/`in_progress` `match_players` | returns **NULL**. (Pulled body is **exempt** — it is legitimately in its `in_progress` match; confirm the exemption by also running I01 which has exactly that condition and still succeeds.) |
| `CC-RPC-I08` | **status mutations on success** | I01 setup | post-call: the **3 waiting** members ⇒ `status='drafted'`; the **pulled body stays `status='playing'`** (never mutated); `matches.is_published=false` |
| `CC-RPC-I09` | **`is_held` GENERATED column (R3-2)** | (a) insert a held match with `pulled_player_ids = '{pulled}'`; (b) a normal match with `pulled_player_ids = '{}'` | (a) `is_held = true`; (b) `is_held = false`. Asserts `cardinality(pulled_player_ids) > 0` semantics — **empty array ⇒ false, one element ⇒ true** (not three-valued-logic NULL). *(REGRESSION: tag **R3-2**.)* |
| `CC-RPC-I10` | **all 4 rows in `match_players`** | I01 setup | `match_players` for the new match has **4** rows (3 waiting + pulled), so `checkout_player_cleanup_drafts` / `remove_player_from_queue_organizer` can later find+free it (M-2 dependency) |
| `CC-RPC-I11` | **Guard 1 lock scope (M-6)** — locks ONLY the 3 waiting | **two concurrent txns** (psql session A holding an open txn after the RPC's `FOR UPDATE`, session B issuing `UPDATE queue_entries SET status='completed' WHERE player_id = <pulled>`) | session B's update of the **pulled body's** row is **NOT blocked** (the pulled body is a non-locking read); a concurrent `SELECT … FOR UPDATE` of a **waiting member's** row **IS** blocked. **See note below — lock-scope is only truly assertable at SQL/integration level.** |

**Note on `CC-RPC-I11` (lock-scope, M-6) — hardest to assert, weakest automation:** lock scope is invisible to a single-session test and to vitest entirely. Two viable approaches: (a) pgTAP with two connections is brittle (timing-dependent), so prefer (b) a **documented manual two-psql-session check** — Session A: `BEGIN; CALL/SELECT create_held_cross_court_match(...)` and pause before COMMIT; Session B: `UPDATE queue_entries … WHERE player_id=<pulled>` must **return immediately** (proves pulled row not locked), then `SELECT … FROM queue_entries WHERE player_id=<a waiting member> FOR UPDATE` must **block** until A commits (proves the 3 waiting rows ARE locked). This directly validates the M-6 rationale (don't `FOR UPDATE` the pulled body — it must not block `endMatchAction`'s completion UPDATE). Record the exact two-session script in the migration file's comment block.

---

#### MANUAL SQL checklist (fallback when no pgTAP/branch infra; mirrors INTEGRATION ids)

Run against a seeded local Supabase. For each, `SELECT public.create_held_cross_court_match(...)` then inspect:
1. `CC-RPC-I01` valid split ⇒ returns uuid; `SELECT is_held, is_published, pulled_player_ids, pulled_from_match_id FROM matches WHERE id=<ret>;`
2. `CC-RPC-I02..I05` each Guard-0 violation ⇒ `IS NULL` and `SELECT count(*) FROM matches WHERE pulled_from_match_id=<src>` unchanged.
3. `CC-RPC-I06` Guard 1b ⇒ `IS NULL` while a prior held draft for that body exists.
4. `CC-RPC-I07` Guard 2 ⇒ `IS NULL` for a double-booked **waiting** member; **I01 re-run proves the pulled body is exempt**.
5. `CC-RPC-I08` ⇒ `SELECT player_id,status FROM queue_entries WHERE session_id=… AND player_id = ANY(<all4>);` expect 3×`drafted` + 1×`playing`.
6. `CC-RPC-I09` ⇒ direct `INSERT … RETURNING is_held` for `'{}'` (false) and `'{x}'` (true).
7. `CC-RPC-I11` ⇒ the two-psql-session lock-scope script above.

---

#### Coverage matrix (unit vs integration vs manual)

| concern | UNIT (vitest) | INTEGRATION (pgTAP/DB) | MANUAL (SQL) |
|---|---|---|---|
| `executeHeldMatch` NULL ⇒ graceful skip | ✅ `CC-RPC-U02` | — | — |
| `executeHeldMatch` hard error surfaced | ✅ `CC-RPC-U03` | — | — |
| RPC name + `p_*` payload | ✅ `CC-RPC-U01/U04` | — | — |
| Guard 0 split (waiting×3 + playing pulled in in_progress src) | ❌ (mocked rpc) | ✅ `CC-RPC-I01..I05` | ✅ |
| Guard 1b reservation (N-1) | ❌ | ✅ `CC-RPC-I06` | ✅ |
| Guard 2 double-book (pulled exempt) | ❌ | ✅ `CC-RPC-I07` | ✅ |
| status mutations (3→drafted, pulled stays playing, is_published=false) | ❌ | ✅ `CC-RPC-I08` | ✅ |
| `is_held` GENERATED (R3-2) | ❌ | ✅ `CC-RPC-I09` | ✅ |
| 4 rows in match_players (M-2 dep) | ❌ | ✅ `CC-RPC-I10` | ✅ |
| Guard 1 lock scope (M-6) | ❌ | ⚠️ brittle | ✅ **preferred** (two-psql sessions) |

**Why so much is non-unit:** the harness's `rpc()` is a `vi.fn` returning a queued literal — it never enters plpgsql, so transactional guards, `FOR UPDATE` scope, and the `GENERATED` column are structurally invisible to vitest. The TS contract that *is* unit-tested (`CC-RPC-U01..U04`) is exactly the boundary the engine depends on: **any guard NULL ⇒ a clean slot-skip, never a crash.**

Key source references used: `executeMatch` NULL-return contract and `ExecuteMatchResult` shape at `/Users/miggy-onb/Downloads/badminton-app/src/lib/matchmaking-db.ts:31` and `:322-380`; the `makeMockClient(fromResponses, rpcResponses)` harness and RPC-error precedent (`ME` test, queued `rpcResponses` + `mock.rpc` assertions) at `/Users/miggy-onb/Downloads/badminton-app/tests/unit/matchmaking-engine.test.ts:134-148` and `:505-518`; the Guard 0/1/2 + `FOR UPDATE ORDER BY player_id` + NULL-on-conflict pattern that `create_held_cross_court_match` mirrors at `/Users/miggy-onb/Downloads/badminton-app/supabase/migrations/20260507000000_fix_toctou_matchmaking.sql`. Open verification item for the builder: confirm `executeHeldMatch`'s exact `p_*` parameter names and whether the pulled body is passed as `p_pulled_player_id` alone vs. also inside a team array, then pin `CC-RPC-U04` accordingly.

---

## 6. UI / Component & A11y

### Cluster: UI / Component + A11y — Phase 7 surfaces (held-draft card, 3-state track, pulled-pill, player/TV)

**Realistic test scope (per repo convention).** The repo's unit suite is overwhelmingly pure-logic; only four `.tsx` files use RTL (`match-alert`, `on-deck-alert`, `queue-control-edit-pin`, `queue-sub-tab`), all via `// @vitest-environment happy-dom` + `@testing-library/react` `render`/`screen`. So this cluster splits three ways: **(a)** a new PURE helper `deriveHeldState(match)` gets a full unit suite (the load-bearing logic — color is never the source of truth, this function is); **(b)** component-render assertions are written as **happy-dom RTL** tests modeled exactly on `on-deck-alert.test.tsx` — these are realistic because `SortableCard` already renders today and the held additions are read-only JSX; **(c)** the a11y checklist items that can't be asserted programmatically in happy-dom (contrast ratios, true 44px box metrics, motion timing) are marked **manual/visual** and covered by the `/audit` + design-context review, not unit tests. E2E is out per convention.

**Target test files**
- Pure helper: extend `tests/unit/matchmaking-core.test.ts` **only if** `deriveHeldState` lands in `matchmaking-core.ts`; otherwise new file `tests/unit/derive-held-state.test.ts` (recommended — it consumes an `EnrichedMatch`/`Match` row, not the pure pool primitives, so it belongs beside the view layer). Path used below: **`tests/unit/derive-held-state.test.ts`**.
- Component: new **`tests/unit/held-sortable-card.test.tsx`** (sibling of `match-alert.test.tsx` / `on-deck-alert.test.tsx`).
- Player/TV hidden-until-published: covered by the existing **`tests/unit/use-enriched-matches.test.ts`** query-filter assertion (the `is_published=false` firewall is data-layer, not component) — add one case there rather than a new file.

---

#### (a) PURE — `deriveHeldState(match): 'holding' | 'resting' | 'ready' | null`

Proposed signature (verify at build; derives purely from the row, zero DB, zero `Date.now()` *inside* unless `now` is injected):

```ts
// Returns null for a normal (non-held) draft. For a held draft:
//   'ready'   → held_ready_at stamped AND <= now           (emerald, "tap Publish")
//   'resting' → body freed (source completed/cancelled) but not yet ready (brighter violet)
//   'holding' → body still playing (source in_progress)    (violet, "Court N in play")
export function deriveHeldState(
  match: Pick<Match, "pulled_player_ids" | "held_ready_at"> & {
    pulledFromStatus: MatchStatus | null; // status of pulled_from_match_id row, null if missing
  },
  now: number = Date.now()
): "holding" | "resting" | "ready" | null
```

Note: `now` is an injected param (mirrors the `pickEarliestFinishing`/`isHeldMatchReady` time-injection convention in the plan, so tests are deterministic — never rely on real wall-clock). Real assertions:

```ts
import { describe, it, expect } from "vitest";
import { deriveHeldState } from "@/lib/...";  // path resolved at build

const T0 = Date.parse("2026-06-07T10:00:00Z");

// CC-PURE-01 — normal draft is not held
it("CC-PURE-01: empty pulled_player_ids ⇒ null (normal draft, no held identity)", () => {
  expect(
    deriveHeldState({ pulled_player_ids: [], held_ready_at: null, pulledFromStatus: null }, T0)
  ).toBeNull();
});

// CC-PURE-02 — body still playing ⇒ holding
it("CC-PURE-02: held + source in_progress + no ready stamp ⇒ 'holding'", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: null, pulledFromStatus: "in_progress" },
      T0
    )
  ).toBe("holding");
});

// CC-PURE-03 — body freed but rest not satisfied ⇒ resting
it("CC-PURE-03: held + source completed + no ready stamp ⇒ 'resting'", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: null, pulledFromStatus: "completed" },
      T0
    )
  ).toBe("resting");
});

// CC-PURE-04 — cancelled source also counts as "freed"
it("CC-PURE-04: source cancelled (body free) + no stamp ⇒ 'resting'", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: null, pulledFromStatus: "cancelled" },
      T0
    )
  ).toBe("resting");
});

// CC-PURE-05 — ready stamp in the past ⇒ ready
it("CC-PURE-05: held_ready_at <= now ⇒ 'ready' (regardless of source status)", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: "2026-06-07T09:59:00Z", pulledFromStatus: "completed" },
      T0
    )
  ).toBe("ready");
});

// CC-PURE-06 — BOUNDARY: held_ready_at exactly == now ⇒ ready (<=, not <)
it("CC-PURE-06: held_ready_at === now is inclusive ⇒ 'ready'", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: "2026-06-07T10:00:00Z", pulledFromStatus: "completed" },
      T0
    )
  ).toBe("ready");
});

// CC-PURE-07 — BOUNDARY: stamp 1ms in the future ⇒ NOT ready yet (still resting)
it("CC-PURE-07: held_ready_at > now ⇒ falls back to 'resting' (stamp not yet effective)", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: "2026-06-07T10:00:00.001Z", pulledFromStatus: "completed" },
      T0
    )
  ).toBe("resting");
});

// CC-PURE-08 — ready takes precedence over a still-in_progress source (defensive ordering)
it("CC-PURE-08: ready stamp wins even if pulledFromStatus is stale 'in_progress'", () => {
  expect(
    deriveHeldState(
      { pulled_player_ids: ["p1"], held_ready_at: "2026-06-07T09:00:00Z", pulledFromStatus: "in_progress" },
      T0
    )
  ).toBe("ready");
});
```

| id | scenario | input | assert |
|---|---|---|---|
| CC-PURE-01 | normal draft | `[]`, no stamp | `null` |
| CC-PURE-02 | holding | 1 pulled, src `in_progress`, no stamp | `'holding'` |
| CC-PURE-03 | resting | 1 pulled, src `completed`, no stamp | `'resting'` |
| CC-PURE-04 | resting (cancelled src) | 1 pulled, src `cancelled`, no stamp | `'resting'` |
| CC-PURE-05 | ready (past stamp) | stamp < now | `'ready'` |
| CC-PURE-06 | ready boundary `==` | stamp == now | `'ready'` (inclusive `<=`) |
| CC-PURE-07 | not-ready boundary `+1ms` | stamp = now+1ms | `'resting'` |
| CC-PURE-08 | ready precedence | stamp past, src stale `in_progress` | `'ready'` |

**Note on roster-integrity / downgrade (N-2, 7e):** `deriveHeldState` does NOT re-validate that `pulled_player_ids[0]` is still in the roster — that's `recomputeHeldReadiness`'s job (DB-coupled, server). After a swap-out + recompute, the row arrives here with `pulled_player_ids: []` ⇒ CC-PURE-01 returns `null` ⇒ the card renders as a normal draft. So the swap auto-downgrade's *visual* outcome is covered by CC-PURE-01; the clearing itself is covered in the engine/promotion cluster (`recomputeHeldReadiness` unit), not here. Add an explicit cross-reference case:

```ts
// CC-PURE-09 (M-5 / 7e swap auto-downgrade — VISUAL outcome regression)
it("CC-PURE-09: post-swap recompute cleared pulled_player_ids ⇒ deriveHeldState ⇒ null (card loses violet identity)", () => {
  expect(
    deriveHeldState({ pulled_player_ids: [], held_ready_at: null, pulledFromStatus: "in_progress" }, T0)
  ).toBeNull();
});
```

---

#### (b) COMPONENT — `tests/unit/held-sortable-card.test.tsx` (happy-dom RTL)

**Harness wiring** (copied from `match-alert.test.tsx` / `on-deck-alert.test.tsx`):
- File header: `// @vitest-environment happy-dom`.
- `import { render, screen } from "@testing-library/react";`
- `SortableCard` calls `useSortable` (dnd-kit) → wrap each render in a minimal `<DndContext><SortableContext items={[match.id]}>…</SortableContext></DndContext>` OR (lighter, preferred — matches the "OverlayCard is the pure clone" split) assert against **`OverlayCard`** for the read-only identity/state JSX where dnd hooks aren't needed, and use `SortableCard` only for the Publish-enabled cases. If `useSortable` noise appears, stub `requestAnimationFrame`/`cancelAnimationFrame` as `match-alert.test.tsx` does.
- Fixtures: a `makeEnrichedMatch(overrides)` factory returning a full `EnrichedMatch` (4 players a/a/b/b with `profile`+`win_streak`, `court`, plus the new `pulled_player_ids`/`pulled_from_match_id`/`held_ready_at`/`is_held`). Model the player shape on `match-alert`'s `makeProfile`.
- No Supabase/service-client mocks needed (component is presentational). No `vi.mock` of `next/server` `after` / `push-server` here — those belong to the server-action clusters.
- Assertion style: `screen.getByText(/HELD/i)`, `getByLabelText(...)`, `getByRole("status")`, `getByTestId(...)`. **Critical convention from 7g/Phase 7: assert TEXT, never a Tailwind class** — color-only is banned, so every state assertion checks the visible label string is present (e.g. `getByText("HOLDING")`), not `toHaveClass("text-cc-violet")`.

| id | scenario | setup (match overrides) | assert (text/role/testid — never color-only) |
|---|---|---|---|
| CC-COMP-01 | held identity chip | `pulled_player_ids:["p1"]`, `is_held:true`, src in_progress | `screen.getByText(/HELD/i)` present; chip has an icon sibling (query `getByLabelText(/held/i)` on the chip's `aria-label`) |
| CC-COMP-02 | normal draft has NO held identity | `pulled_player_ids:[]`, `is_held:false` | `screen.queryByText(/HELD/i)` → `null`; renders `Draft #1` (existing behavior unchanged) |
| CC-COMP-03 | HOLDING segment active w/ icon+text | held, src `in_progress`, `held_ready_at:null` | `getByText("HOLDING")` present AND its segment marked active via `aria-current="step"` (or `data-active="true"`); `getByText(/Court 2 in play/i)` sub-label present |
| CC-COMP-04 | RESTING segment active | held, src `completed`, `held_ready_at:null` | `getByText("RESTING")` active; `getByText(/1-match rest/i)` sub-label |
| CC-COMP-05 | READY segment active, emerald + check | held, `held_ready_at:` past ISO | `getByText("READY")` active; `getByText(/tap Publish/i)`; a check/play icon present (assert via `getByLabelText("Ready"`) — icon carries text alt, NOT color) |
| CC-COMP-06 | 3 segments always rendered (progression, not single badge) | any held state | exactly 3 elements with `role="listitem"`/`data-segment` and labels `HOLDING`,`RESTING`,`READY` all in the DOM (the track conveys progression) |
| CC-COMP-07 | pulled-pill court chip `C2` | held, court name "Court 2" on `pulled_from_match` (passed via prop or derived) | `getByText("C2")` present; `getByText(/finishing C2/i)` microcopy; pill has `aria-label` containing "incoming"/"finishing" (icon+text+ring, not color-only) |
| CC-COMP-08 | pulled-pill marks the right player | `pulled_player_ids:["p1"]` where p1 = teamA[0] | the pill/ring decoration is on the `data-testid="player-pill-p1"` row (assert that element has the violet-ring marker class OR an `aria-describedby`/`data-pulled="true"` attr — prefer a `data-pulled` attribute so it's class-independent) |
| CC-COMP-09 | **Publish stays ENABLED in HOLDING** (publish-then-gate, 7d / M-1 regression) | held, src `in_progress` | `getByRole("button",{name:/publish/i})` is NOT disabled (`expect(btn).not.toBeDisabled()`) |
| CC-COMP-10 | **Publish stays ENABLED in RESTING** (M-1 regression) | held, src `completed`, no stamp | publish button `.not.toBeDisabled()` |
| CC-COMP-11 | **Publish stays ENABLED in READY** | held, stamp past | publish button `.not.toBeDisabled()`; it is the natural CTA |
| CC-COMP-12 | track (not button) communicates "won't take a court" | held, HOLDING | the gating message lives in the track sub-label/`role="status"`, asserted by text — NOT by `disabled` on Publish (the inverse of CC-COMP-09) |
| CC-COMP-13 | Clear/Swap actions unchanged | held draft | Clear button present and enabled exactly as a normal draft (`getByRole("button",{name:/clear/i})`) |
| CC-COMP-14 | held card still renders rosters via TeamsGrid | held draft, 4 players | `getByText("Your Team")` + `getByText("Opponents")` (sky/amber teams unchanged) |
| CC-COMP-15 | reciprocal court "whisper" cue | court card variant (if surfaced in this component) | `getByText(/feeds next/i)` present on the linked Court 2 card; if the whisper lives in a different component, mark **manual/visual** instead |
| CC-COMP-16 | no banned left/right stripe | held card root | `getByTestId("held-card-root")` className does NOT contain `border-l-` / `border-r-` > 1px (assert absence of stripe classes — enforces impeccable's hard ban; brittle, mark **component (best-effort)** ) |

Regression tags surfaced above: **M-1** (publish-then-gate, never block publish) → CC-COMP-09/10/11/12; **M-5 / 7e** (swap auto-downgrade visual) → CC-PURE-01/09 + CC-COMP-02; **N-2** roster-integrity downgrade visual outcome → CC-PURE-09.

**Where this is NOT cleanly unit-testable (mark manual/visual):**
- The **pulse** animation on the active HOLDING/RESTING segment and the **one-time emerald entrance** on READY — happy-dom does not run CSS animations or evaluate `@media (prefers-reduced-motion)`. Cover via `/audit` + manual review. The *static-fallback* branch CAN be asserted if the component reads `prefers-reduced-motion` through a JS hook (`useReducedMotion`) and swaps to a static element — then add CC-COMP-17: mock the hook → assert the static dot (`getByTestId("rest-dot-static")`) renders and the pulsing element is absent. If motion is pure CSS `@media`, it is **manual** only.
- The **hover/tap linked-card highlight** (progressive disclosure, 7c) — interaction + cross-component; assert the handler/attribute wiring if cheap (`fireEvent.mouseEnter` → linked card gets `data-linked-active`), else **manual**.

---

#### (c) Player / TV — hidden-until-published

**Not a component test** — the firewall is the `is_published=false` row filter (Phase 2 L-3: RLS + the `use-enriched-matches` query filter, unchanged). Add to **`tests/unit/use-enriched-matches.test.ts`** using its existing `makeMockClient` response-queue harness:

| id | scenario | setup/mock | assert |
|---|---|---|---|
| CC-VIEW-01 | held draft hidden from player/TV until published (7f) | queue a `from("matches").select()` response containing a held row with `is_published:false` AND a published row; player-context query | enriched output excludes the `is_published:false` held row (same as any unpublished draft — held is not special-cased) |
| CC-VIEW-02 | published held row's pulled member shows calm "finishing C2" chip (player view = rounded) | published held row, player-view render | **component-level** in the *player* match-alert/queue surface, not the enriched hook — if that surface renders the chip, add a happy-dom case asserting `getByText(/finishing C2/i)` with rounded geometry; the 3-state machine is **absent** in player view (assert `queryByText("HOLDING")` → `null`). Mark **component**. |

Mock-harness note: reuse `use-enriched-matches.test.ts`'s existing `from()` mock-builder and the `select/eq/order` response queue — only add the new columns (`pulled_player_ids`, `is_held`, `held_ready_at`, `pulled_from_match_id`) to the queued match rows; no new `rpc()` responses, no `vi.mock` of `next/server`/`push-server`/service-client needed for the view layer.

---

#### (c-a11y) Accessibility checklist — per item, marked unit / component / manual

| # | A11y requirement (7g) | How verified | Type |
|---|---|---|---|
| A11Y-01 | Every state conveys via **icon + text**, never color-only | CC-COMP-03/04/05 assert the label TEXT is in the DOM; CC-COMP-05 asserts the icon has an accessible name | **component** |
| A11Y-02 | READY hue-shift is reinforced by distinct icon + label (not hue-dependent) | CC-COMP-05 (`READY` text + check icon `aria-label`) | **component** |
| A11Y-03 | Pulled-pill marked by ring + glyph + court chip, not color | CC-COMP-07/08 (text `C2`, `finishing C2`, `data-pulled` attr) | **component** |
| A11Y-04 | WCAG 4.5:1 contrast on all `cc-violet` chips/labels + emerald READY | `/audit` contrast check against `globals.css` `cc-violet` OKLCH values; cannot compute in happy-dom | **manual** |
| A11Y-05 | 44px touch targets (Publish/Clear/segments) | `min-h-[44px]` class already on Publish/Clear (visible in `sortable-card.tsx`); true box metric not measurable in happy-dom → assert class presence as a proxy (component) + physical check (manual) | **component (proxy) + manual** |
| A11Y-06 | `prefers-reduced-motion` honored on BOTH motion moments (segment pulse + READY entrance) | static-fallback branch via mocked `useReducedMotion` (CC-COMP-17) if JS-driven; pure-CSS `@media` path | **component (if JS hook) / manual (if CSS)** |
| A11Y-07 | Live-region semantics for the state track (organizer hears state changes) | assert the track wrapper has `role="status"`/`aria-live="polite"` (mirrors `on-deck-alert`'s `role="status"`, ODA-9) | **component** |
| A11Y-08 | 3-state track exposes progression to AT (not a flat badge) | CC-COMP-06 asserts 3 labelled segments + active step marked `aria-current="step"` | **component** |

**Convention guardrail for the implementer:** match `on-deck-alert.test.tsx` exactly — use `role="status"` + `aria-label` assertions (ODA-9/ODA-10) for the live state track, `getByText`/`queryByText` for presence/absence, and never assert a `cc-*`/Tailwind color class as the source of truth (color is decorative; text + icon `aria-label` + `data-*` attributes are the contract). Keep stable ids `CC-PURE-0x` / `CC-COMP-0x` / `CC-VIEW-0x` / `A11Y-0x`.

---

---

# Senior-QA Refinement Pass (Round 1 · 2026-06-07)

> Produced by a 5-reviewer senior-QA pass (`/senior-qa`) over the catalog above, grounded in the QA references + the real Vitest harness.
> **Precedence:** where a refinement conflicts with the original `CC-*` case, **the refinement is authoritative** — it was checked against the real unit signatures.
> **⚠️ P0** items correct a case that would FAIL against a correct implementation or give false confidence — do NOT transplant the original as-is.

**P0 count: 14** · total refinements: 56

| P0 id | targets | title |
|---|---|---|
| `QA-PURE-01` | CC-PURE-27, CC-PURE-28 | C-3 cases assert on -1, but scoreAndSortPool recomputes priorityScore and never produces -1 — mis-scoped against the real unit |
| `QA-PURE-02` | CC-PURE-13, CC-PURE-24, CC-PURE-25, CC-PURE-27, CC-PURE-28, NEW | makePulled/makePlayer read the real system clock; cases mix Date.now()-derived times with literal ISO strings — flaky and non-deterministic |
| `QA-PROM-01` | CC-RDY-01, CC-RDY-02, CC-RDY-03, CC-RDY-04, CC-RDY-05, CC-RDY-06, CC-RDY-07, CC-RDY-08, CC-RDY-09, CC-RDY-10, CC-RDY-11 | Add is/gt/contains/overlaps to makeBuilder or every CC-RDY test throws TypeError |
| `QA-PROM-02` | CC-PROM-02, CC-PROM-07 | Skip-and-defer 'correct id promoted' is unobservable with the current harness — capture the CAS .eq('id', …) arg |
| `QA-PROM-03` | CC-RDY-05, CC-RDY-06, CC-RDY-07 | Readiness boundary cases must freeze the clock — exact-3-min fallback is flaky against the real system clock |
| `QA-ENG-01` | CC-ENG-06 | C-1 decrement test: assert the SPECIFIC second RPC that a -=4 would suppress, not just call-count |
| `QA-TRG-01` | CC-TRG-CNM-01 | CNM-01 ordering assertion mixes invocationCallOrder with queriedTables — not comparable |
| `QA-TRG-02` | CC-TRG-GHOST-01, CC-TRG-GHOST-04, NEW | Pin recompute ORDER relative to the GHOST re-queue loop — real correctness ordering, untested |
| `QA-TRG-03` | CC-TRG-GHOST-01, CC-TRG-GHOST-02, CC-TRG-GHOST-03, CC-TRG-GHOST-06 | Per-player update-payload capture is mis-specified against the real endMatchAction builder |
| `QA-RPC-01` | CC-RPC-I01, CC-RPC-I02, CC-RPC-I03, CC-RPC-I04, CC-RPC-I05, CC-RPC-I06, CC-RPC-I07, CC-RPC-I08, CC-RPC-I09, CC-RPC-I10 | Integration layer must target the repo's existing Vitest+real-Postgres harness, NOT greenfield pgTAP |
| `QA-RPC-02` | CC-RPC-I11 | M-6 lock-scope IS achievable as a two-connection vitest test — don't demote it to manual-only |
| `QA-VIEW-01` | CC-VIEW-01 | CC-VIEW-01 tautology: is_published firewall is a Postgres .or() filter, not a JS exclusion — assert the query, not a hand-fed row set |
| `QA-IDS-01` | CC-PURE-01, CC-PURE-02, CC-PURE-03, CC-PURE-04, CC-PURE-05, CC-PURE-06, CC-PURE-07, CC-PURE-08 | Hard id collision: deriveHeldState reuses CC-PURE-01..09 already owned by the Pure-Core cluster (isPullEligible/isHeldMatchReady) |
| `QA-COMP-PUB-01` | CC-COMP-09, CC-COMP-10, CC-COMP-11, CC-COMP-12 | M-1 publish-enabled cases will mis-pass: Publish renders only `if (isDraft)` and OverlayCard has no Publish button — pin is_published:false + use SortableCard + assert presence before .not.toBeDisabled() |

## 1. Pure Core (CC-PURE-*)

_The cluster is well-structured and mostly mock-free-correct, with strong boundary coverage for isHeldMatchReady and a real (not faked) Tier-3/fallback fixture for forcedRepeat. But two load-bearing C-3 cases (CC-PURE-27/28) are mis-scoped against the actual unit: scoreAndSortPool recomputes priorityScore from wait_minutes via computePriorityScore, so it discards the -1 that makePulled sets — the C-3 fix lives in fetchPullablePlayers (DB layer, Phase 4a), not in this pure function, so those assertions FAIL on a correct implementation and pass only against a fiction. Separately, the shared makePulled/makePlayer factories read the real system clock, and several time/ordering cases mix Date.now()-derived times with literal ISO strings — a flakiness and correctness risk. The N-1 reduce-to-1-pulled case (CC-PURE-24) is too weak to prove the 2-pulled combo was actually rejected._

### ⚠️ P0 · `QA-PURE-01` — C-3 cases assert on -1, but scoreAndSortPool recomputes priorityScore and never produces -1 — mis-scoped against the real unit

**Kind:** restructure  ·  **Targets:** `CC-PURE-27`, `CC-PURE-28`

scoreAndSortPool(rawPool: QueueWithWaitTime[]) does `.map(p => ({...p, priorityScore: computePriorityScore(p)}))` — it OVERWRITES priorityScore for every row. computePriorityScore keys only on wait_minutes/games_played; makePulled sets wait_minutes:0, games_played:0, so the pulled body is recomputed to priorityScore:0, NOT -1. The C-3 fix per the plan (Phase 4a) lives in fetchPullablePlayers in the DB layer ('use -1, NOT 0'), which is NOT the function under test here. Consequences: (a) CC-PURE-27's `expect(sorted[sorted.length-1].priorityScore).toBe(-1)` FAILS against a correct impl; (b) worse, with joinedMinutesAgo:999 the recomputed score-0 pulled body has the OLDEST joined_at, so the joined_at-ASC tiebreaker floats it to pool[0] — `expect(sorted[0].isPulled).toBeFalsy()` ALSO FAILS. These tests assert a behavior scoreAndSortPool cannot have. Fix: either (1) move both cases to the engine cluster where fetchPullablePlayers (the actual owner of the -1) is exercised, OR (2) keep them pure but feed a PRE-SCORED pool (pulled already at -1) directly into runAlgorithm — which does NOT re-sort — and assert pool[0] is a waiting player. Do not assert scoreAndSortPool yields -1; it cannot.

```ts
// scoreAndSortPool DISCARDS the -1 (it recomputes). The original assertions FAIL:
const pulled = makePulled("pull1", { skillInt: 5, joinedMinutesAgo: 999 });
expect(pulled.priorityScore).toBe(-1);                 // makePulled body carries -1
const sorted = scoreAndSortPool([pulled, w0, w1, w2]);
// recomputed to 0; oldest joined_at floats it to pool[0]:
// expect(sorted[0].isPulled).toBeFalsy();   // <-- FALSE GUARANTEE, would fail

// Correct PURE C-3 assertion: runAlgorithm does NOT re-sort, so pass a pre-scored pool
// (pulled already at -1, exactly as fetchPullablePlayers would emit) and assert anchor:
const pool = [w0, w1, w2, pulled]; // waiting (>=0) ahead of pulled(-1)
const result = runAlgorithm(pool, new Map(), new Map(), []);
expect(pool[0].isPulled).toBeFalsy();
expect(pool[0].priorityScore).toBeGreaterThanOrEqual(0);
```

### ⚠️ P0 · `QA-PURE-02` — makePulled/makePlayer read the real system clock; cases mix Date.now()-derived times with literal ISO strings — flaky and non-deterministic

**Kind:** fix flakiness  ·  **Targets:** `CC-PURE-13`, `CC-PURE-24`, `CC-PURE-25`, `CC-PURE-27`, `CC-PURE-28`, `NEW`

makePulled defaults currentMatchStartedAt to `new Date().toISOString()` (real clock) and seeds joined_at off `Date.now()`; makePlayer seeds joined_at off `Date.now()`. CC-PURE-13/24 then compare a Date.now()-anchored fixture against HARD-CODED ISO times like '2026-06-07T11:40:00.000Z'. On a real wall clock the 'now' default may be newer or older than the literal fixtures depending on run date, so the relative ordering the test assumes is only accidentally true. Any pure suite that orders/sorts on timestamps MUST run under a frozen clock. Add a file- or describe-scoped fake clock so every Date.now()/new Date() is deterministic, and pass explicit currentMatchStartedAt in time-sensitive cases instead of relying on the 'now' default. This also makes CC-PURE-27/28's joinedMinutesAgo math exact and removes order-dependence.

```ts
import { vi, beforeAll, afterAll } from "vitest";
const FIXED_NOW = new Date("2026-06-07T12:00:00.000Z");
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW); });
afterAll(() => { vi.useRealTimers(); });
// makePulled()'s `new Date().toISOString()` default === FIXED_NOW deterministically,
// and every literal ISO fixture (11:40/11:50/...) is strictly older than 'now',
// so pickEarliestFinishing ordering is reproducible run-to-run.
```

### P1 · `QA-PURE-03` — N-1 'reduce 2-pulled to 1-pulled' only asserts <=1 — passes trivially on a zero-pulled (waiting-only) result, never proving the 2-pulled combo was REJECTED

**Kind:** strengthen  ·  **Targets:** `CC-PURE-24`

The point of CC-PURE-24 is to prove a combo that WANTS two pulled bodies is reduced to a one-pulled combo — not merely avoided. `expect(countPulled(result)).toBeLessThanOrEqual(1)` is satisfied by countPulled===0, i.e. a waiting-only proposal, which is the OPPOSITE outcome (gave up on the salvageable 1-pulled match). With pool [anchor(w0), w1, pullA, pullB], a 4-player match must consume 2 of the 3 non-anchor bodies {w1, pullA, pullB}, so exactly one pulled MUST appear if a match forms. Assert countPulled === 1 (the discriminating value) AND that exactly one of pullA/pullB is present (proving selection, not rejection of both). Optionally assert pullA (started 11:40, earliest) was chosen to also exercise the N-3 tiebreak through composition.

```ts
const result = runAlgorithm([anchor, w1, pullA, pullB], new Map(), new Map(), []);
expect(result.proposal).not.toBeNull();
const four = [...result.proposal!.teamA, ...result.proposal!.teamB];
expect(four.filter(p => p.isPulled).length).toBe(1);          // exactly one — NOT 0, NOT 2
const pulledId = four.find(p => p.isPulled)!.player_id;
expect(["pullA", "pullB"]).toContain(pulledId);
expect(pulledId).toBe("pullA"); // N-3: earliest-finishing wins the single slot on a fit tie
```

### P1 · `QA-PURE-04` — CC-PURE-23 comment claims 'anchor (pool[0]) is the waiting player' but no assertion checks the anchor — only the pulled body's id

**Kind:** strengthen  ·  **Targets:** `CC-PURE-23`

The case asserts countPulled===1 and that the single pulled body's id is 'pull1', but never asserts the C-3 invariant its own comment advertises: that pool[0]/the anchor is a WAITING player and never the pulled body. As written it would still pass if a regression let the pulled body anchor, as long as the final 4 contained exactly one pulled. Add the anchor assertion so this case defends the 'pulled never anchors' contract at the runAlgorithm layer. (pool here is hand-ordered [anchor, w1, w2, pulled]; per QA-PURE-01 do NOT route it through scoreAndSortPool, which would recompute the pulled body's score.)

```ts
const result = runAlgorithm([anchor, w1, w2, pulled], new Map(), new Map(), []);
expect(result.proposal).not.toBeNull();
expect(countPulled(result)).toBe(1);
expect(pool[0].isPulled).toBeFalsy();      // the C-3 invariant this case should guard
expect(pool[0].player_id).toBe("w0");      // a waiting player anchors
expect(result.proposal!.teamA.concat(result.proposal!.teamB)
  .find(p => p.isPulled)!.player_id).toBe("pull1");
```

### P1 · `QA-PURE-05` — N-4 arity canary `isPullEligible.length <= 2` is brittle — Function.length stops at the first defaulted/rest param, so a 3rd skill-window param can slip past it

**Kind:** strengthen  ·  **Targets:** `CC-PURE-06`

Function.prototype.length counts only params BEFORE the first one with a default value or rest. If the real signature is `isPullEligible(player, opts = {})`, then .length === 1 and `<= 2` passes — but it was meant to FAIL if a 3rd skill-window arg is added. The arity check is therefore not a reliable N-4 canary. Keep the strong behavioral half of CC-PURE-06 (extreme low/high skill both eligible) as the PRIMARY guard and broaden it to sweep the full skill range with streak/held held constant, so skill is provably inert. If an arity assertion is retained, pin the EXACT expected value with a decision comment rather than an inequality.

```ts
// Robust N-4 canary: skill is provably inert across its whole domain.
for (const skillInt of [1, 3, 5, 7, 10]) {
  const p = makePulled(`s${skillInt}`, { skillInt });
  expect(isPullEligible(p, pullOpts({ streak: 0 }))).toBe(true);
  expect(isPullEligible(p, pullOpts({ streak: MAX_CONSECUTIVE_GAMES_FOR_PULL }))).toBe(false);
}
// N-4 ADR pin (exact, not <=2): isPullEligible takes (player, opts={}) → Function.length is 1.
expect(isPullEligible.length).toBe(1);
```

### P1 · `QA-PURE-06` — forcedRepeat=false on the Tier-1 swap success return is left 'optional' — leaves a false-positive trigger path unexercised

**Kind:** add case  ·  **Targets:** `CC-PURE-21`, `NEW`

CC-PURE-16..20 cover Tier-0 normal (false), Tier-3 (true), fallback (true), null (false), and Red-Zone-skip fall-through (false), but the Tier-1 diverse-swap success return (~621, forcedRepeat:false) is only optional CC-PURE-21. forcedRepeat is the engine's cross-court trigger; a regression that set it true on a Tier-1 swap success would fire the held-draft path on a perfectly diverse match. Promote CC-PURE-21 to required: anchor + 3 in a recent roster + 1 fresh skill-compatible spare so the diversity violation is resolved by a Tier-1 swap (not rotation), and assert proposal!=null && forcedRepeat===false. (Tier-2 / CC-PURE-22 may stay P2 — the engine suite covers expanded swap — but Tier-1 false is cheap and closes a real false-trigger path.)

```ts
it("CC-PURE-21 [C-2]: Tier-1 diverse swap success → forcedRepeat=false", () => {
  const anchor = makePlayer("anchor", { skillInt: 5, waitMinutes: 10 });
  const g0 = makePlayer("g0", { skillInt: 5, waitMinutes: 9 });
  const g1 = makePlayer("g1", { skillInt: 5, waitMinutes: 8 });
  const g2 = makePlayer("g2", { skillInt: 5, waitMinutes: 7 }); // swap-out target, not Red Zone
  const spare = makePlayer("spare", { skillInt: 5, waitMinutes: 6 }); // fresh, compatible → Tier-1 swaps in
  const recentRosters = [[anchor.player_id, g0.player_id, g1.player_id, g2.player_id]];
  const result = runAlgorithm([anchor, g0, g1, g2, spare], new Map(), new Map(), recentRosters);
  expect(result.proposal).not.toBeNull();
  expect(result.forcedRepeat).toBe(false); // a diverse swap is NOT a forced repeat
});
```

### P1 · `QA-PURE-07` — CC-PURE-17 (Tier-3 forcedRepeat=true) should also pin that the proposal is the SAME 4 (a genuine repeat) so the flag and the behavior must regress together

**Kind:** strengthen  ·  **Targets:** `CC-PURE-17`

CC-PURE-17 asserts proposal!=null && forcedRepeat===true, which is correct, but does not verify the proposal actually contains the repeated roster. A regression that flipped the flag without changing the roster (or rotated to a different 4 while keeping the flag) would not be caught. Since the fixture's 4 players are exactly the recent roster, assert the proposal's 4 ids equal that roster set — a true forced repeat — so flag and behavior are coupled and the C-2 regression bites if either drifts.

```ts
const result = runAlgorithm([anchor, g0, g1, g2], new Map(), new Map(), recentRosters);
expect(result.proposal).not.toBeNull();
expect(result.forcedRepeat).toBe(true);
const ids = [...result.proposal!.teamA, ...result.proposal!.teamB].map(p => p.player_id).sort();
expect(ids).toEqual([anchor.player_id, g0.player_id, g1.player_id, g2.player_id].sort());
```

### P1 · `QA-PURE-08` — pickEarliestFinishing has no defined/tested behavior for empty input or candidates with a null/undefined currentMatchStartedAt

**Kind:** add case  ·  **Targets:** `CC-PURE-15`, `NEW`

currentMatchStartedAt is optional on ScoredPlayer (`currentMatchStartedAt?`). Two unhappy paths are untested: (1) empty array — the signature returns a non-nullable ScoredPlayer, so the [] contract must be pinned (throw is fine; silent undefined is a trap for the orchestrator). (2) a candidate whose currentMatchStartedAt is undefined mixed with ones that have it — Date.parse(undefined) is NaN and NaN comparisons are always false, a classic silent non-deterministic min-selection bug. Add a guard case asserting the earliest KNOWN start wins regardless of input order (no NaN-driven flakiness), and pin the []-input contract.

```ts
it("CC-PURE-15b: empty candidate list → throws (pin the contract; do not silently return undefined)", () => {
  expect(() => pickEarliestFinishing([])).toThrow();
});
it("CC-PURE-15c: candidate missing currentMatchStartedAt never wins via NaN compare", () => {
  const known = makePulled("known", { skillInt: 5, currentMatchStartedAt: "2026-06-07T11:40:00.000Z" });
  const missing = { ...makePulled("missing", { skillInt: 5 }), currentMatchStartedAt: undefined } as ScoredPlayer;
  expect(pickEarliestFinishing([missing, known]).player_id).toBe("known");
  expect(pickEarliestFinishing([known, missing]).player_id).toBe("known");
});
```

### P2 · `QA-PURE-09` — isHeldMatchReady promotion-branch boundary (promotionsSinceFreed 0 vs 1) is only implied, never isolated with the time path neutralized

**Kind:** add case  ·  **Targets:** `CC-PURE-08`, `NEW`

CC-PURE-08 (1 promotion, freedAt(0) → true) and CC-PURE-09 (0 promotions, under fallback → false) together imply the >=1 boundary, but there is no case that holds the times identical and toggles only promotions 0→1 to prove the promotion operand uses >=1 (inclusive), not >1, independent of the fallback timer. Add a 0-promotion twin to CC-PURE-08 (same freedAt(0), promotions:0 → false). Low priority — behavior is implied — but it makes the OR's left operand boundary explicit and symmetric with the strong time-boundary suite (CC-PURE-11/12).

```ts
it("CC-PURE-08b: freed + 0 promotions + elapsed 0 (<< fallback) → false (brackets the >=1 promo boundary)", () => {
  expect(isHeldMatchReady({ pulledFreedAt: freedAt(0), promotionsSinceFreed: 0, now: NOW, restFallbackMs: FALLBACK_MS })).toBe(false);
});
```

### P2 · `QA-PURE-10` — CC-PURE-01..07 ids are REUSED by the Phase-6 UI cluster (deriveHeldState, catalog lines ~881-939) — id collision breaks the 'stable ids' promise

**Kind:** naming  ·  **Targets:** `CC-PURE-01`, `CC-PURE-02`, `CC-PURE-03`, `CC-PURE-04`, `CC-PURE-05`, `CC-PURE-06`, `CC-PURE-07`

The catalog states 'Case ids are stable' and regression cases cross-reference them, but Pure Core's CC-PURE-01..29 collide with a second CC-PURE-01..07+ block in the Phase-6 UI cluster (deriveHeldState in derive-held-state.test.ts). The Phase-8 table assigns the UI cluster CC-COMP-*/CC-VIEW-* ids, so those deriveHeldState cases should be renamed (e.g. CC-COMP-DHS-01..) to keep CC-PURE-* unique to matchmaking-core. No change to matchmaking-core.test.ts itself — the rename belongs to the UI cluster — but the collision must be recorded so two it() blocks named 'CC-PURE-01' do not coexist across the suite and defeat id-based coverage tracking/grep.

## 2. Engine Producer (CC-ENG-*) + 3. Promotion & Readiness (CC-PROM-*, CC-RDY-*)

_This is a strong, plan-grounded test-first catalog: the tagged regressions (C-1 decrement, M-4 bypassGate, C-4/R3-A skip-and-defer, N-2 roster-first, R3-B source-cancel, C-5 COUNT-derived readiness) each have a named case, and it correctly fences real-Postgres guards into integration/manual. However several P0-level wiring gaps would make the cluster fail-open or non-compiling as written: (1) the shared `makeBuilder` lacks `is`/`gt`/`contains`/`overlaps`, so every CC-RDY case throws TypeError before asserting; (2) the headline skip-and-defer assertion "CAS hit the correct id" is NOT capturable by the current harness because `.eq("id", X)` discards X and the positional `from()` queue returns the same response regardless of arg — CC-PROM-02/07 currently prove nothing about WHICH match promoted unless the harness is upgraded; (3) several time-dependent CC-RDY/CC-ENG cases read the real system clock (streak "started 6 min ago", source completed_at relative to NOW) without `vi.useFakeTimers()`, making boundary cases (CC-RDY-07's exact-3-min) flaky; (4) the C-1 discriminating assertion needs an explicit guard that the SECOND rpc is the one a 4-decrement would suppress. Fixing the harness (P0) and strengthening the id-capture and clock-freeze (P0/P1) is required before these tests can actually fail on a regression._

### ⚠️ P0 · `QA-ENG-01` — C-1 decrement test: assert the SPECIFIC second RPC that a -=4 would suppress, not just call-count

**Kind:** strengthen  ·  **Targets:** `CC-ENG-06`

CC-ENG-06 is the load-bearing C-1 regression (held draft must decrement estimatedWaiting by 3, not 4). The brief asks to truly distinguish 'stopped one slot early' from correct. The catalog's assert is 'mock.rpc called twice rather than once', which is on the right track, but as written it does not pin WHICH second call fires nor guard the arithmetic boundary. With 8 waiting + 1 pulled: correct (-3) leaves 8-3=5; since the cap is estimatedWaiting < PLAYERS_PER_MATCH(4)+MIN_FREE_POOL(4)=8, BOTH 5 and the buggy 4 are < 8, so slot 1 is cap-blocked EITHER WAY and the test cannot discriminate. The discriminating threshold is estimatedWaiting >= 8 after slot 0, i.e. you need >= 12 waiting for the -3 vs -4 difference to cross the cap (12-3=9 >=8 -> slot1 runs; 12-4=8... still >=8). Re-derive the fixture so one decrement lands on each side of the < 8 boundary, then assert the second rpc is create_match_with_players for slot 1 AND that the engine did not break early. Otherwise this 'C-1 regression' green-passes with the bug present.

```ts
// Need: afterSlot0_correct >= 8 (cap NOT fired) and afterSlot0_buggy < 8 (cap fires).
// correct = W-3, buggy = W-4. Pick W=11: correct 8 (>=8 ok), buggy 7 (<8 blocked).
// 11 waiting + 1 pulled, courts>=2, slots>=2.
expect(mock.rpc).toHaveBeenCalledTimes(2);
expect(mock.rpc).toHaveBeenNthCalledWith(1, "create_held_cross_court_match", expect.any(Object));
expect(mock.rpc).toHaveBeenNthCalledWith(2, "create_match_with_players", expect.any(Object));
// Comment: with -=4 the cap (estimatedWaiting 7 < 8) fires before slot 1 -> only 1 rpc -> this fails.
```

### ⚠️ P0 · `QA-PROM-01` — Add is/gt/contains/overlaps to makeBuilder or every CC-RDY test throws TypeError

**Kind:** fix mock  ·  **Targets:** `CC-RDY-01`, `CC-RDY-02`, `CC-RDY-03`, `CC-RDY-04`, `CC-RDY-05`, `CC-RDY-06`, `CC-RDY-07`, `CC-RDY-08`, `CC-RDY-09`, `CC-RDY-10`, `CC-RDY-11`

Verified against the real harness (tests/unit/matchmaking-engine.test.ts lines 99-111): makeBuilder's chain-method loop is [select, eq, neq, in, or, order, limit, update, upsert, insert, maybeSingle]. It is MISSING is, gt, contains, overlaps. recomputeHeldReadiness uses .is('held_ready_at', null), .is('pulled_from_match_id', null), and .gt('started_at', completedAt) (the C-5 promotions COUNT); endMatchAction's ghost lookup may use .overlaps/.contains. With the current builder, the FIRST .is(...) call returns undefined (not b), so the next chained method (.eq) is called on undefined -> TypeError, and the test errors out before any assertion runs. The catalog flags this in prose (line 523) but it is a hard precondition for the entire CC-RDY suite, so it must be a P0 harness change, not a footnote. This is also the textbook 'test passes/errors for the wrong reason' trap: an errored test is not a passing guard.

```ts
// In makeBuilder's method loop (extend the array):
for (const method of [
  "select", "eq", "neq", "in", "or", "order", "limit",
  "update", "upsert", "insert", "maybeSingle",
  "is", "gt", "gte", "lt", "lte", "contains", "overlaps", // <-- ADD
]) {
  b[method] = (..._args: unknown[]) => b;
}
```

### ⚠️ P0 · `QA-PROM-02` — Skip-and-defer 'correct id promoted' is unobservable with the current harness — capture the CAS .eq('id', …) arg

**Kind:** strengthen  ·  **Targets:** `CC-PROM-02`, `CC-PROM-07`

These are the core C-4/R3-A regression cases (a not-ready held match at the FRONT is skipped while a ready match BEHIND it is promoted). But the assertion that distinguishes skip-and-defer from the old .limit(1) is 'the CAS .update was .eq("id", "m-ready") NOT "m-held"'. The real harness CANNOT prove this: makeBuilder's .eq returns b and discards its args, and the from() queue is positional — fromResponses[1] (the CAS update) resolves to {id:'m-ready'} regardless of which id the code actually filtered on. So matchId in the result is whatever the TEST hard-coded into the CAS response, NOT what the code chose. A regression that promotes m-held (the not-ready one) would still see CAS response {id:'m-ready'} and PASS. This is a tautological/fail-open assertion. Fix: capture the id argument the code passes to the final .eq('id', X) on the matches.update chain and assert on THAT. The cleanest way is a per-test capturing builder for the update call.

```ts
// Make the CAS update's .eq capture its (col,val) so the test can assert the chosen id.
const casEqCalls: Array<[string, unknown]> = [];
function makeCapturingBuilder(response: MockResponse, sink: Array<[string, unknown]>) {
  const b = makeBuilder(response) as Record<string, unknown>;
  b.eq = (col: string, val: unknown) => { sink.push([col, val]); return b; };
  return b;
}
// Route the matches-update (2nd 'matches' from() call) through the capturing builder,
// then:
expect(casEqCalls).toContainEqual(["id", "m-ready"]);
expect(casEqCalls).not.toContainEqual(["id", "m-held"]);
expect(result.matchId).toBe("m-ready");
```

### ⚠️ P0 · `QA-PROM-03` — Readiness boundary cases must freeze the clock — exact-3-min fallback is flaky against the real system clock

**Kind:** fix flakiness  ·  **Targets:** `CC-RDY-05`, `CC-RDY-06`, `CC-RDY-07`

The block intro (line 524) says to freeze NOW with vi.useFakeTimers()+vi.setSystemTime, but the per-case tables encode completed_at as ABSOLUTE ISO strings ('2026-06-07T11:56:00Z' etc.) and rely on Date.now()===NOW. If a case forgets the fake-timer setup (or it's only in some cases), recomputeHeldReadiness computes elapsed = realNow - completed_at, which on 2026-06-07-and-after is astronomically larger than the 3-min fallback, so CC-RDY-05 ('< 3 min -> NOT ready') would WRONGLY pass as ready and the stamp assertion in CC-RDY-06/07 would compare against the real clock. CC-RDY-07's explicit boundary ('exactly NOW-3min -> ready' AND 'NOW-(3min-1s) -> NOT ready') is impossible to make deterministic without setSystemTime. Make the fake-timer setup a beforeEach/afterEach for the whole describe('recomputeHeldReadiness') block, not a per-case reminder, and assert the stamped held_ready_at EQUALS the frozen NOW iso (not just toBeDefined).

```ts
describe("recomputeHeldReadiness", () => {
  const NOW = new Date("2026-06-07T12:00:00.000Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  // CC-RDY-07 boundary, count:0, completed_at exactly NOW-3min:
  // capture the stamp payload and assert it equals NOW, proving >= is inclusive
  // and that the value is the frozen clock, not the real one.
  // (also add the NOW-(3min-1s) sibling asserting NO update call)
});
```

### P1 · `QA-ENG-02` — Held-RPC-returns-NULL graceful skip: assert the loop CONTINUES/breaks like the real skip path, not just 'no throw'

**Kind:** strengthen  ·  **Targets:** `CC-ENG-04`

The brief specifically calls out asserting 'no throw AND loop continues/breaks correctly' for the NULL-return case. CC-ENG-04 currently asserts resolves.toBeUndefined(), rpc called once with the held name, and console.error NOT called. That proves no-throw and no-error-log, but does NOT prove the engine handled the skip the SAME way executeMatch's NULL convention does (break the fill loop at matchmaking.ts:488 'Slot skipped'). A regression where executeHeldMatch returns success:false but the engine then loops forever, or proceeds to a second bogus slot, would still pass the current assertions. Add a positive assertion on the post-skip control flow: with a single court + single slot, after the held NULL skip the engine must NOT issue a create_match_with_players for the same slot (no silent fallthrough) and must terminate (queriedTables length is bounded). Pair the console.error spy with an assertion that it WAS NOT called with a 'failed'/'error' substring AND that no SECOND rpc of either name fired.

```ts
const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
await expect(runEngineForSession(SESSION_ID)).resolves.toBeUndefined();
expect(mock.rpc).toHaveBeenCalledTimes(1);
expect(mock.rpc).toHaveBeenCalledWith("create_held_cross_court_match", expect.any(Object));
// graceful skip != error, and no silent fallthrough to a normal create for the skipped slot:
expect(mock.rpc).not.toHaveBeenCalledWith("create_match_with_players", expect.any(Object));
expect(errSpy).not.toHaveBeenCalledWith(expect.stringMatching(/fail|error/i));
errSpy.mockRestore();
```

### P1 · `QA-ENG-03` — Query-order lock (CC-ENG-07) will silently rot — pin only the fetchPullablePlayers insertion point, and make existing-test invariance explicit

**Kind:** fix mock  ·  **Targets:** `CC-ENG-07`

CC-ENG-07 hard-codes a ~15-element queriedTables array. The catalog itself admits the two fetchPullablePlayers table names are TBD and that indices 'shift'. A full-array toEqual is brittle: any unrelated future read re-numbers everything and produces a noisy failure that hides real regressions, encouraging blanket snapshot-style updates (the snapshot-as-crutch anti-pattern). The VALUABLE invariant the brief cares about is narrower: fetchPullablePlayers' two reads land immediately after fetchRecentRosters and BEFORE the slot-0 fetchActivePool (v_queue_with_wait_time). Assert that relationship by index arithmetic, not a frozen full array. Separately, add an explicit regression test that an EXISTING non-cross-court engine test's queriedTables is unchanged when fetchPullablePlayers returns [] (the catalog's central claim that the new queries are inert for forcedRepeat:false runs) — that is the real 'wrong order silently breaks ALL engine tests' guard the brief flags.

```ts
const qt = mock.queriedTables;
const rosterIdx = qt.indexOf("match_players"); // first fetchRecentRosters roster read
const pullStart = rosterIdx + 1;
// fetchPullablePlayers occupies exactly 2 slots, before slot-0 fetchActivePool:
const activePoolIdx = qt.indexOf("v_queue_with_wait_time", pullStart + 2);
expect(activePoolIdx).toBe(pullStart + 2);
// And: assert the two pull reads are the documented tables (adjust to impl), e.g.
expect(qt.slice(pullStart, pullStart + 2).sort()).toEqual(["match_players","matches"]);
// Plus a sibling test: an existing forcedRepeat:false run with [] pullable
// yields the SAME queriedTables it had pre-feature (inertness guard).
```

### P1 · `QA-ENG-04` — fetchPullablePlayers streak fixtures use real-clock relative times ('started 6 min ago') — freeze the clock

**Kind:** fix flakiness  ·  **Targets:** `CC-ENG-01`, `CC-ENG-06`

CC-ENG-01 seeds a playing body 'started 6 min ago' and a 1-game streak; the streak detector compares the newer game's started_at against the older game's completed_at within MATCH_REST_GAP_MINUTES (5 min) and isPullEligible keys off MAX_CONSECUTIVE_GAMES_FOR_PULL. If these timestamps are built with Date.now() at test-author intent but the engine recomputes elapsed/streak against the real clock at run time, the 'eligible' classification is clock-relative and can flip across the 5-min rest-gap boundary depending on machine speed/CI lag. Any held-path engine test whose eligibility depends on a minutes-ago window must run under vi.useFakeTimers()+vi.setSystemTime so the 6-min/1-game eligibility is deterministic. This mirrors the existing suite's own avoidance of clock-relative gate math (it uses wait_minutes from the row, not Date math). Make the cross-court describe block freeze the clock in beforeEach.

```ts
describe("runEngineForSession — cross-court held drafts", () => {
  const NOW = new Date("2026-06-07T12:00:00.000Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  // build pulled-body match started_at = NOW - 6*60_000, streak rows relative to NOW
});
```

### P1 · `QA-PROM-04` — Assert the actual update PAYLOAD (held_ready_at value / pulled_player_ids:[]) not just that an update ran

**Kind:** strengthen  ·  **Targets:** `CC-RDY-06`, `CC-RDY-07`, `CC-RDY-01`

CC-RDY-06/07 say 'a matches.update ran setting held_ready_at to a non-null ISO (==NOW)' and CC-RDY-01 says 'downgrade update ran with pulled_player_ids:[] and held_ready_at:null'. But the harness records only table NAME in queriedTables; the payload passed to .update({...}) is discarded (makeBuilder.update returns b, ignoring args). So as written these can only assert 'matches was queried N times', which does NOT distinguish a correct stamp from a no-op update, an empty update, or a downgrade that forgot to null held_ready_at (the exact N-2 bug). Capture the .update() argument via a spy and assert the payload. For CC-RDY-06/07 assert held_ready_at === NOW.toISOString() (proves C-5 stamping uses the frozen clock and the >= boundary); for CC-RDY-01 assert the payload sets BOTH pulled_player_ids:[] AND held_ready_at:null (a downgrade that clears only one field is a latent bug).

```ts
const updates: unknown[] = [];
// capturing builder for the matches table on the update step:
b.update = (payload: unknown) => { updates.push(payload); return b; };
// CC-RDY-06/07:
expect(updates).toContainEqual(expect.objectContaining({ held_ready_at: NOW.toISOString() }));
// CC-RDY-01 (downgrade clears BOTH fields):
expect(updates).toContainEqual(expect.objectContaining({ pulled_player_ids: [], held_ready_at: null }));
```

### P1 · `QA-PROM-05` — Missing negative: CC-PROM-05 'only held-not-ready exist' has no sibling for held-not-ready BEHIND a ready normal at front

**Kind:** add case  ·  **Targets:** `NEW`

CC-PROM-02 covers held-not-ready at FRONT skipped, ready behind promoted. CC-PROM-05 covers ONLY held-not-ready -> success:false. But there is no case proving the inverse ordering is also correct: a READY normal at the front is promoted even though a held-not-ready sits BEHIND it (the JS .find must stop at the first ready, not scan past it or get confused by the held row in the tail). This is the cheap-but-real off-by-one in the TS filter: an implementation that filters out ALL held rows first (instead of 'first ready in order') would still pass CC-PROM-02/05/07 but mis-handle a set where the held-not-ready is last. Add it to lock the 'first ready wins, in sort order' contract end-to-end.

```ts
// CC-PROM-NEW: [{id:'m-norm',is_held:false}, {id:'m-held',is_held:true,held_ready_at:null}]
// fetch -> both; expect matchId 'm-norm' (front ready wins, held-in-tail untouched);
// assert CAS .eq('id','m-norm') captured; held row never CAS'd.
expect(casEqCalls).toContainEqual(["id", "m-norm"]);
expect(casEqCalls).not.toContainEqual(["id", "m-held"]);
```

### P2 · `QA-ENG-05` — Red-Zone short-circuit: also assert fetchPullablePlayers' result was NOT consumed, not just that held RPC wasn't called

**Kind:** add case  ·  **Targets:** `CC-ENG-02`

CC-ENG-02 proves Red Zone -> create_match_with_players and never create_held_cross_court_match (good decision-4 ordering guard). The catalog notes fetchPullablePlayers 'still runs (hoisted) but its result is unused.' That 'unused' claim is the subtle part of the short-circuit and is currently unasserted — a regression could enter the augmented-pool re-run, find no held combo, and fall back to waiting-only, still emitting create_match_with_players and still passing CC-ENG-02 while doing wasteful/wrong work. Strengthen by asserting the augmented re-run did NOT happen: with the Red-Zone anchor, the slot must produce its match WITHOUT a second fetchActivePool/partnership/overlap pass for an augmented pool (no extra from() reads beyond the single slot's normal sequence). This pins 'short-circuit fires BEFORE the trigger', which is the decision-4 invariant the brief highlights.

```ts
// After the Red-Zone slot completes, the per-slot read count should match a
// NORMAL (non-augmented) slot exactly — no augmented re-run reads.
// Assert the slot issued create_match_with_players and the queriedTables tail
// equals the canonical normal-slot sequence (no second pool/partnership/overlap block).
expect(mock.rpc).toHaveBeenCalledWith("create_match_with_players", expect.objectContaining({ p_origin: "auto" }));
expect(mock.rpc).not.toHaveBeenCalledWith("create_held_cross_court_match", expect.any(Object));
```

### P2 · `QA-ENG-06` — M-4 bypassGate test: ensure the pulled body IS eligible, else the test proves nothing

**Kind:** strengthen  ·  **Targets:** `CC-ENG-05`

CC-ENG-05 asserts bypassGate=true -> only create_match_with_players, never the held RPC (M-4). But the note says 'fetchPullablePlayers responses returning [] is acceptable since they're never consumed under bypass.' If the pull list is [], then NO held draft could form regardless of M-4 — the test would pass even if the bypassGate suppression were completely removed (a false-pass / vacuous guard). To actually exercise M-4, the fixture MUST present a forced-repeat waiting pool AND a genuinely ELIGIBLE pulled body (so that WITHOUT the bypass suppression a held RPC WOULD fire), then assert the held RPC did NOT fire BECAUSE of bypassGate. Mirror CC-ENG-01's eligible-pull setup but drive through the bypassGate=true entrypoint.

```ts
// Same eligible-pull fixture as CC-ENG-01 (forced repeat + px0 eligible),
// but reach runEngineInternal with bypassGate=true.
// Guard against vacuous pass: a control assertion that the SAME fixture WITHOUT
// bypass would call the held RPC is covered by CC-ENG-01, so here:
expect(mock.rpc).toHaveBeenCalledWith("create_match_with_players", expect.any(Object));
expect(mock.rpc).not.toHaveBeenCalledWith("create_held_cross_court_match", expect.any(Object));
```

### P2 · `QA-PROM-06` — C-4/R3-A negative guard: assert NO timestamp is ever passed to .or() (the dropped fragile pattern)

**Kind:** add case  ·  **Targets:** `NEW`

The whole point of C-4/R3-A is that the readiness filter moved to JS and the PostgREST .or(...+nowIso+...) string was DROPPED to avoid the whitespace/encoding bug. The catalog's note (line 574) says to 'assert the fetch chain does NOT call .or with a timestamp' but no case actually encodes it. Without a guard, a future 'optimization' could silently re-introduce the inline .or() timestamp and no test would object — the regression the two prior reviews flagged would return undetected. Add a cheap spy on the published-pending fetch builder's .or and assert it was never called with a stringified Date/ISO. This is the canary for the R3-A decision (analogous to the catalog's own N-4 arity canary in the pure cluster).

```ts
const orCalls: unknown[][] = [];
b.or = (...args: unknown[]) => { orCalls.push(args); return b; };
await promoteOnDeckMatchInternal(mock as never, SESSION_ID, COURT_ID);
const sawTimestampInOr = orCalls.some(args =>
  args.some(a => typeof a === "string" && /\d{4}-\d{2}-\d{2}T/.test(a)));
expect(sawTimestampInOr).toBe(false);
```

### P2 · `QA-PROM-07` — Promote a ready held: assert pulled body is moved drafted->playing and 3 waiting drafted->playing (held-specific promotion side-effect)

**Kind:** add case  ·  **Targets:** `CC-PROM-04`

CC-PROM-04 promotes a ready held match (held_ready_at in past) and checks matchId + CAS id. But a held match is structurally different from a normal one: its 4 match_players include a pulled body that is status='drafted' (per R3-1) plus 3 waiting members also 'drafted'. The existing promote queue_entries update uses .neq('status','left'); the catalog (Phase 5) notes promoteOnDeckMatchInternal's drafted->playing handles it. No case asserts that promoting a HELD match correctly transitions all four to playing (the normal-promotion cases use waiting members). Add an assertion that the queue_entries update for the pulled body is reached (it was 'drafted', must become 'playing') so a regression that skips drafted rows on promotion is caught. This is the consumer-side counterpart to the R3-1 producer reservation.

```ts
// CC-PROM-04 held promotion: match_players returns 4 rows incl pulled 'b1' (drafted).
// Assert queue_entries update ran for the held roster (drafted->playing) and
// teamA/teamB resolve all 4 names (none dropped as 'left').
```

### P2 · `QA-RDY-08` — C-5 promotions COUNT must use .gt('started_at', completed_at) — assert the bound, not just the count result

**Kind:** add case  ·  **Targets:** `CC-RDY-06`, `CC-RDY-07`

CC-RDY-06/07 feed the promotions COUNT as a canned {count:1}/{count:0} response, so the test asserts on a number it itself supplied — a tautology w.r.t. the C-5 derivation. The C-5 fix is specifically that promotionsSinceFreed = COUNT(matches WHERE status IN (in_progress,completed,cancelled) AND started_at > completed_at) — i.e. the .gt boundary value is the source's completed_at. A regression that compares against the wrong timestamp (e.g. the held match's created_at, or omits the .in status filter) would still receive the canned count and pass. Capture the args passed to .gt and .in on the COUNT query and assert .gt was called with the source completed_at and .in with the three committed statuses. This turns a 'mock returns what I told it' assertion into a real C-5 guard.

```ts
const gtCalls: Array<[string, unknown]> = [];
const inCalls: Array<[string, unknown]> = [];
b.gt = (c: string, v: unknown) => { gtCalls.push([c, v]); return b; };
b.in = (c: string, v: unknown) => { inCalls.push([c, v]); return b; };
// after recompute:
expect(gtCalls).toContainEqual(["started_at", "2026-06-07T11:59:00.000Z"]); // == source.completed_at
expect(inCalls).toContainEqual(["status", ["in_progress","completed","cancelled"]]);
```

## 4. Triggers & Lifecycle — CC-TRG-* (PUB/CNM/END/CAN/GHOST/LEAVER/STALE)

_The cluster is well-conceived: GHOST (R3-1) covers both sides of the drafted/waiting branch, and the recompute-before-engine ordering is targeted at every trigger. But several assertions are brittle or under-specified against the REAL source: (1) the call-ORDER idiom mixes two incompatible mechanisms (invocationCallOrder of a mocked recompute vs. queriedTables string index) in CNM-01 and the END/CAN promote-ordering; (2) the catalog never pins where recompute sits relative to the GHOST re-queue loop, which is a real correctness ordering question (recompute can abandon a held draft the GHOST loop then re-reserves as 'drafted'); (3) cancelMatchAction calls runEngineForSession UNCONDITIONALLY but promote only inside if(court_id) — the CAN-01 "recompute < promote < engine" assertion silently requires a court_id and a CAS-select row; (4) GHOST per-player update-payload capture is mis-specified for the real builder (the SELECT and UPDATE both chain .eq("player_id"), and makeBuilder returns one shared object). LEAVER/STALE correctly defer DB-cascade to integration but must assert clear_on_deck_match_atomic args precisely and prove they do NOT take the in-place clear path._

### ⚠️ P0 · `QA-TRG-01` — CNM-01 ordering assertion mixes invocationCallOrder with queriedTables — not comparable

**Kind:** fix flakiness  ·  **Targets:** `CC-TRG-CNM-01`

The catalog asserts 'recompute invocationCallOrder < the matches pending-fetch that drives promotion.' In the engine suite recomputeHeldReadiness is mocked (vi.fn, does ZERO from() calls) while promoteOnDeckMatchInternal is the REAL export — its matches read lands in queriedTables, which is a plain string[] with no ordering numbers. invocationCallOrder (a global monotonic counter on vi mocks) and a queriedTables index are different mechanisms and cannot be compared with toBeLessThan. Worse: in callNextMatch the happy path (matchmaking.ts:142) promotes FIRST with no matches-pending fetch in callNextMatch itself — the matches read is buried inside promoteOnDeckMatchInternal. Compare the mocked recompute's invocationCallOrder against the SHARED `from` mock's invocationCallOrder for its first 'matches' call, so both sides are vi-mock call orders.

```ts
// Both recompute (mocked) and the service `from` spy expose invocationCallOrder.
const recomputeOrder = vi.mocked(recomputeHeldReadiness).mock.invocationCallOrder[0];
const firstMatchesFromIdx = mock.from.mock.calls.findIndex(([t]) => t === "matches");
const firstMatchesOrder = mock.from.mock.invocationCallOrder[firstMatchesFromIdx];
expect(recomputeOrder).toBeLessThan(firstMatchesOrder); // recompute ran before any promotion read
expect(result.success).toBe(true);
```

### ⚠️ P0 · `QA-TRG-02` — Pin recompute ORDER relative to the GHOST re-queue loop — real correctness ordering, untested

**Kind:** restructure  ·  **Targets:** `CC-TRG-GHOST-01`, `CC-TRG-GHOST-04`, `NEW`

In match-lifecycle.ts the re-queue loop (step 4, ~line 200-231) runs BEFORE the court block and is where R3-1 sets finishers to 'drafted'/'waiting'. recomputeHeldReadiness can ABANDON a held draft (clear_on_deck_match_atomic) or DOWNGRADE it (N-2). If recompute runs AFTER the GHOST loop has already stamped a finisher 'drafted' for a draft recompute just killed, that finisher is wrongly reserved and never freed. The catalog asserts the drafted/waiting payloads but never pins recompute vs. GHOST-loop order. Add a case proving recompute fires BEFORE the queue_entries writes (so the GHOST loop reads a post-recompute held-draft set), OR document the deliberate design that the GHOST loop reads held drafts independently and recompute's clear happens in the same pass. This is the load-bearing ordering for R3-1 correctness, not just for the engine.

```ts
// CC-TRG-GHOST-07 [R3-1 ordering]: recompute precedes the re-queue writes
const recomputeOrder = vi.mocked(recomputeHeldReadiness).mock.invocationCallOrder[0];
const firstQueueUpdateOrder = updateSpy.mock.invocationCallOrder[0]; // first queue_entries.update
expect(recomputeOrder).toBeLessThan(firstQueueUpdateOrder);
```

### ⚠️ P0 · `QA-TRG-03` — Per-player update-payload capture is mis-specified against the real endMatchAction builder

**Kind:** fix mock  ·  **Targets:** `CC-TRG-GHOST-01`, `CC-TRG-GHOST-02`, `CC-TRG-GHOST-03`, `CC-TRG-GHOST-06`

The real loop (match-lifecycle.ts:205-228) issues, PER PLAYER: a SELECT chain `.from(queue_entries).select(games_played).eq(session_id).eq(player_id).neq(status,left).maybeSingle()` AND a separate UPDATE chain `.from(queue_entries).update(payload).eq(session_id).eq(player_id).neq(status,left)`. The catalog says 'spy on update and record (payload, playerId) keyed off the trailing .eq("player_id", id)'. Two problems: (a) BOTH the select and update chains carry `.eq(player_id)`, so a naive eq-spy attributes the player to the wrong call unless you only record player_id when `update` was invoked on that same builder instance; (b) makeBuilder must hand out a FRESH builder per from() call (the table-routed switch does this) so each player's chain has isolated state. Specify: route `queue_entries` to a builder factory that records the payload from update() and the player_id from the NEXT .eq('player_id', id) on the SAME builder, and ignore builders whose update() was never called (the select-only chains).

```ts
const ghostUpdates: Array<{ playerId?: string; payload: Record<string, unknown> }> = [];
function queueEntriesBuilder(selectResponse: MockResponse) {
  let captured: { playerId?: string; payload?: Record<string, unknown> } = {};
  const b: Record<string, unknown> = {};
  b.then = (r: any, j: any) => Promise.resolve(selectResponse).then(r, j);
  b.maybeSingle = () => Promise.resolve(selectResponse);
  b.select = () => b;
  b.neq = () => b;
  b.eq = (col: string, val: string) => { if (col === "player_id") captured.playerId = val; return b; };
  b.update = (payload: Record<string, unknown>) => { captured.payload = payload; ghostUpdates.push(captured as any); captured = {}; return b; };
  return b;
}
// assert: ghostUpdates.find(u => u.playerId === P_pull)!.payload.status === "drafted"
// assert: ghostUpdates.filter(u => u.payload.status === "waiting").length === 3
```

### P1 · `QA-TRG-04` — CAN-01 'recompute < promote < engine' silently assumes court_id + CAS row; engine is UNCONDITIONAL

**Kind:** strengthen  ·  **Targets:** `CC-TRG-CAN-01`

In cancelMatchAction, promoteOnDeckMatchInternal is inside `if (match.court_id)` (line 531) but runEngineForSession is called UNCONDITIONALLY at line 543. The catalog's chained 'recompute < promote < engine' only holds when the mock supplies court_id AND the CAS update `.select('id')` returns a non-empty row (else it bails at 'already cancelled'). Make the harness requirements explicit, and add a no-court variant asserting recompute < engine while promote is NOT called — mirroring END-02 — so the asymmetry between end (engine gated on court) and cancel (engine unconditional) is locked.

```ts
// CC-TRG-CAN-02: no court → recompute + engine fire, promote does NOT
// matches fetch returns court_id:null; CAS select('id') → [{id}]
expect(promoteOnDeckMatchInternal).not.toHaveBeenCalled();
expect(vi.mocked(recomputeHeldReadiness).mock.invocationCallOrder[0])
  .toBeLessThan(vi.mocked(runEngineForSession).mock.invocationCallOrder[0]);
```

### P1 · `QA-TRG-05` — LEAVER must assert the EXACT clear_on_deck_match_atomic arg AND prove the in-place clear path is NOT taken

**Kind:** strengthen  ·  **Targets:** `CC-TRG-LEAVER-01`, `CC-TRG-LEAVER-02`

LEAVER-01 says recompute 'invokes rpc(clear_on_deck_match_atomic, {p_match_id})' and NOT a matches.update({pulled_player_ids:[],held_ready_at:null}). The assertion must be double-sided to actually catch a regression: (a) positively assert the rpc name + p_match_id payload; (b) negatively assert NO from('matches').update was issued carrying pulled_player_ids — otherwise a buggy in-place clear that ALSO happens to call the rpc would pass. Since recomputeHeldReadiness's body is the Phase-5 cluster's concern, confirm whether LEAVER-01/02 actually drive the REAL recompute here or just assert the trigger calls a mocked recompute. The catalog is ambiguous: the header mocks recomputeHeldReadiness as vi.fn(), so a mocked recompute CANNOT invoke clear_on_deck_match_atomic. Either move LEAVER-01/02's rpc-arg assertions to the Phase-5 recompute cluster, or unmock recompute (importActual) for just these cases.

```ts
// If driving real recompute (importActual spread):
expect(svc.rpc).toHaveBeenCalledWith("clear_on_deck_match_atomic", { p_match_id: HELD_MATCH_ID });
// Negative guard: never an in-place column clear
const inPlaceClear = updateSpy.mock.calls.find(([p]) => p && "pulled_player_ids" in p);
expect(inPlaceClear).toBeUndefined();
```

### P1 · `QA-TRG-06` — Add the HAS_LEFT_PLAYERS / failure publish branch to the no-recompute gating set

**Kind:** add case  ·  **Targets:** `CC-TRG-PUB-02`, `CC-TRG-PUB-04`, `NEW`

PE-3 already exists (publishMatchAction RPC → HAS_LEFT_PLAYERS ⇒ engine NOT called, success:false). The cross-court cluster only mirrors the ALREADY_PUBLISHED no-op (PUB-02) and published_count===0 (PUB-04). The failure branch (HAS_LEFT_PLAYERS, and any error path where success:false) is a distinct gate: recompute must ALSO be skipped there, not just on the benign no-op. Add CC-TRG-PUB-05 extending PE-3 asserting recomputeHeldReadiness NOT called on HAS_LEFT_PLAYERS — this catches a regression where recompute is hung off the wrong place (e.g. before the success check) and runs on every publish attempt.

```ts
// CC-TRG-PUB-05 [extend PE-3]: rpc → HAS_LEFT_PLAYERS
expect(result.success).toBe(false);
expect(runEngineForSession).not.toHaveBeenCalled();
expect(recomputeHeldReadiness).not.toHaveBeenCalled();
```

### P1 · `QA-TRG-07` — GHOST-06 must assert ZERO update for the left body, not merely that it isn't 'drafted'

**Kind:** strengthen  ·  **Targets:** `CC-TRG-GHOST-06`

GHOST-06 (a pulled body that checked out, queue_entries select returns null for status='left') asserts the body 'is skipped entirely — NO update issued'. In the real loop the guard is `if (!entry) return;` after the .neq('status','left').maybeSingle() returns null. The assertion must verify the player NEVER appears in the captured updates array — both as 'drafted' AND as 'waiting'. A weak 'not drafted' assertion would still pass if a bug wrote 'waiting' for a left player (the exact pre-fix ghost-entry bug the .neq guard was added to prevent). Use the QA-TRG-03 capture array.

```ts
// CC-TRG-GHOST-06: left pulled body — no row written at all
expect(ghostUpdates.find(u => u.playerId === P_pull)).toBeUndefined();
// and the other three still get 'waiting'
expect(ghostUpdates.filter(u => u.payload.status === "waiting").length).toBe(3);
```

### P1 · `QA-TRG-08` — GHOST-01 should pin games_played increment + joined_at stamp on the DRAFTED body, not just status

**Kind:** strengthen  ·  **Targets:** `CC-TRG-GHOST-01`

The catalog text for GHOST-01 says 'games_played still incremented; joined_at still stamped' but provides no assertion mechanism. This is the subtle part of R3-1: the drafted body must still get the normal completion bookkeeping (so it isn't under-counted), only its STATUS differs from a normal finisher. Assert the full payload shape on the drafted body: status:'drafted', games_played === prior+1, and joined_at is the fresh `now`. Without this, an implementation that early-returns to set 'drafted' and skips the games_played/joined_at write would pass a status-only assertion but silently corrupt the body's game count.

```ts
const pull = ghostUpdates.find(u => u.playerId === P_pull)!;
expect(pull.payload).toMatchObject({ status: "drafted" });
expect(pull.payload.games_played).toBe(PRIOR_GAMES + 1);
expect(typeof pull.payload.joined_at).toBe("string");
expect(pull.payload.status).not.toBe("waiting");
```

### P1 · `QA-TRG-09` — makeBuilder method list must add gt/contains/overlaps/lt/lte/gte for the held-draft lookup

**Kind:** fix mock  ·  **Targets:** `CC-TRG-GHOST-01`, `CC-TRG-GHOST-03`, `CC-TRG-GHOST-05`

The held-draft lookup the catalog adds to endMatchAction uses `.eq(session_id).eq(status,'pending').gt(...)` and possibly `.overlaps('pulled_player_ids', rosterIds)` or `.contains(...)`. Neither match-origin-tracking.test.ts's makeBuilder NOR publish-engine-trigger.test.ts's makeBuilder includes gt/lt/lte/gte/contains/overlaps in the chained-method list — a chain calling `.gt` or `.overlaps` would throw 'b.gt is not a function' before resolving. The catalog flags adding overlaps/contains/gt but omits lt/lte/gte (a wait-threshold staleness lookup may use them) and is_/filter. Explicitly enumerate the full set the new lifecycle harness needs so the NEW file's makeBuilder is correct from the start.

```ts
for (const m of [
  "select","eq","neq","in","not","or","order","limit",
  "update","insert","upsert","delete",
  "gt","gte","lt","lte","contains","overlaps","is","filter",
]) { b[m] = (..._a: unknown[]) => b; }
```

### P1 · `QA-TRG-10` — STALE cases assert against a mocked recompute that cannot call the RPC — relocate or unmock

**Kind:** strengthen  ·  **Targets:** `CC-TRG-STALE-01`, `CC-TRG-STALE-02`

STALE-01 asserts 'recompute invokes rpc(clear_on_deck_match_atomic, …)' and STALE-02 asserts 'NO clear_on_deck_match_atomic call'. But the cluster header mocks recomputeHeldReadiness as a bare vi.fn(); a mocked recompute issues no rpc, so STALE-01 would trivially fail and STALE-02 trivially pass (tautology — the mock never calls anything). These are recompute-INTERNAL behaviors. The lifecycle cluster should ONLY assert the consequence it owns: ordering (recompute invocationCallOrder < runEngineForSession) so freed members are seatable in the same cycle. Move the clear_on_deck_match_atomic threshold assertions to the Phase-5 recompute cluster (the catalog even says so in the boundary note) — then STALE-01/02 here should drop the rpc assertions and keep only the ordering claim, OR drive the real recompute via importActual for these two.

```ts
// STALE-01 (lifecycle scope): ordering only
expect(vi.mocked(recomputeHeldReadiness).mock.invocationCallOrder[0])
  .toBeLessThan(vi.mocked(runEngineForSession).mock.invocationCallOrder[0]);
// (rpc(clear_on_deck_match_atomic) threshold assertion belongs in the Phase-5 recompute suite)
```

### P2 · `QA-TRG-11` — END-02 'early bail on the court_id block' is a misnomer — code falls through, no early return

**Kind:** strengthen  ·  **Targets:** `CC-TRG-END-02`

endMatchAction has no early bail for court_id:null — the re-queue loop (and the GHOST 'drafted' writes) run unconditionally, then the `if (match.court_id)` block is simply SKIPPED and the function continues to its normal return. The catalog's phrase 'before the early bail on the court_id block' could mislead the implementer into adding a real early-return. Reword the case intent to: recompute runs unconditionally; with court_id:null the court block is skipped so promote/engine are not called, but the re-queue (including any 'drafted' reservation) still executes. Add an assertion that the re-queue writes DID happen even with no court, since 'completion frees the body' is court-independent.

```ts
// END-02: no court → re-queue still ran, promote/engine skipped
expect(ghostUpdates.length).toBeGreaterThan(0); // finishers re-queued
expect(promoteOnDeckMatchInternal).not.toHaveBeenCalled();
expect(runEngineForSession).not.toHaveBeenCalled();
expect(recomputeHeldReadiness).toHaveBeenCalledWith(db, SESSION_ID);
```

### P2 · `QA-TRG-12` — Assert recompute call ARGS positively (db/svc, SESSION_ID) — not just order — and reset between tests

**Kind:** fix flakiness  ·  **Targets:** `CC-TRG-END-01`, `CC-TRG-CAN-01`, `CC-TRG-PUB-01`, `CC-TRG-PUB-03`

Several Group-A cases assert ordering but the 'called once with (db, SESSION_ID)' / '(svc, SESSION_ID)' arg check is only described in prose for some rows and omitted for others (PUB-03 just says 'recompute called (svc, SESSION_ID)'). Make every Group-A case assert BOTH toHaveBeenCalledWith the correct client instance AND toHaveBeenCalledTimes(1) — an implementation that recomputes twice (e.g. once in the action and once inside runEngineForSession's start) would be a real double-work regression that an order-only assertion misses. Also confirm vi.clearAllMocks() in beforeEach (publish-engine-trigger.test.ts has it; the NEW lifecycle file must too) so invocationCallOrder counters don't leak across it() blocks.

```ts
expect(recomputeHeldReadiness).toHaveBeenCalledTimes(1);
expect(recomputeHeldReadiness).toHaveBeenCalledWith(db, SESSION_ID);
// beforeEach(() => vi.clearAllMocks()); // mandatory in the NEW lifecycle suite
```

### P2 · `QA-TRG-13` — Add a cancelMatchAction GHOST/leaver-equivalent note — cancel does NOT re-queue per-player

**Kind:** add case  ·  **Targets:** `NEW`

cancelMatchAction returns players via a SINGLE bulk `.update({status:'waiting'}).in('player_id', playerIds).neq('status','left')` (line 521) — there is NO per-player loop and NO 'drafted' reservation on cancel. The cluster's GHOST cases are all keyed to endMatchAction only, which is correct, but the catalog never states that cancel intentionally has NO R3-1 'drafted' path (a cancelled match's pulled body was never finishing-for-a-held-draft in the same way). Add a one-line guard case or explicit note so a future implementer doesn't mistakenly port the 'drafted' logic into cancelMatchAction's bulk update. If a held draft DID name a player on a cancelled match, recompute (which fires before engine) is the mechanism that reconciles it — assert cancel's bulk update writes only 'waiting'.

```ts
// CC-TRG-CAN-03: cancel re-queues all non-left members to 'waiting' in ONE bulk update (no 'drafted')
const bulk = updateSpy.mock.calls.find(([p]) => p && p.status);
expect(bulk[0]).toMatchObject({ status: "waiting" });
expect(bulk[0].status).not.toBe("drafted");
```

## 5. RPC / DB Guards — CC-RPC-* (executeHeldMatch unit + create_held_cross_court_match integration/manual)

_The unit/integration/manual split is fundamentally honest — Guard 0/1/1b lock semantics and the is_held GENERATED column genuinely cannot run under vitest's mocked rpc(), and the catalog correctly keeps them out of the unit layer and never fakes a guard to assert on the fake. However, the cluster's two biggest claims are wrong *for this repo*: (1) it routes integration to pgTAP `.test.sql` in a nonexistent `supabase/tests/` dir, when the repo already has a mature Vitest+real-Postgres integration harness (`tests/integration/` with `withTx`, `serviceClient().rpc`, `makeMatch`/`makeMatchViaRpc`, `truncateTracked`) that can exercise every CC-RPC-I* case directly; and (2) it declares M-6 lock-scope "invisible to vitest entirely / manual-only", when the repo's `pg.Pool(max:3)` supports a real two-connection `lock_timeout` test. The unit cases (CC-RPC-U01..U04) are correct against the real executeMatch contract (NULL⇒"Slot skipped", error⇒"Failed to create match") but U01 is tautological and U05 duplicates CC-ENG-01._

### ⚠️ P0 · `QA-RPC-01` — Integration layer must target the repo's existing Vitest+real-Postgres harness, NOT greenfield pgTAP

**Kind:** restructure  ·  **Targets:** `CC-RPC-I01`, `CC-RPC-I02`, `CC-RPC-I03`, `CC-RPC-I04`, `CC-RPC-I05`, `CC-RPC-I06`, `CC-RPC-I07`, `CC-RPC-I08`, `CC-RPC-I09`, `CC-RPC-I10`

The catalog's primary integration target — `supabase/tests/create_held_cross_court_match.test.sql` (pgTAP) — does not match repo reality and would send the builder to stand up brand-new, untested pgTAP infra (raising the real risk the guards never get an automated test at all). There is NO `supabase/tests/` dir and no pgTAP anywhere. The repo ALREADY has a first-class real-DB integration suite the riskiest RPC should join: package.json has `test:integration` (vitest.integration.config.ts) + `test:integration:reset` (`supabase db reset`); tests/integration/ contains rpc-behaviors.test.ts, concurrency.test.ts, engine-trigger-realdb.test.ts; helpers expose `serviceClient().rpc(...)`, a raw pg.Pool via `withTx(async db => …)` that can `SET LOCAL request.jwt.claim.sub`, `truncateTracked()` for afterEach isolation, and factories `makeMatch({status:'in_progress'})` + `makeMatchViaRpc(...)`. Re-anchor CC-RPC-I01..I10 to a NEW tests/integration/cross-court-held-rpc.test.ts that calls the real create_held_cross_court_match and asserts via follow-up serviceClient().from('matches'|'match_players'|'queue_entries') reads. Keep the MANUAL SQL checklist only as the documented fallback when the local Supabase branch is down — not as the primary plan.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry, makeCourt, makeMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
const faker = new Faker({ locale: [en] }); faker.seed(8207);
afterEach(() => truncateTracked());

// CC-RPC-I01 — Guard 0 split happy path, as a real-DB vitest test (NOT pgTAP)
it("CC-RPC-I01: 3 waiting + 1 playing pulled in in_progress src → non-null id, is_held=true", async () => {
  const org = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: org.id });
  const [w1, w2, w3, pulled, a, b, c] = await Promise.all(
    Array.from({ length: 7 }, () => makeProfile({ faker }))
  );
  for (const p of [w1, w2, w3]) await makeQueueEntry({ sessionId: session.id, playerId: p.id }); // waiting
  const src = await makeMatch({ sessionId: session.id, status: "in_progress",
    teamA: [pulled.id, a.id], teamB: [b.id, c.id] });
  await serviceClient().from("queue_entries")
    .update({ status: "playing" }).eq("session_id", session.id).eq("player_id", pulled.id);

  const { data: heldId, error } = await serviceClient().rpc("create_held_cross_court_match", {
    p_session_id: session.id,
    p_team_a_ids: [w1.id, pulled.id], p_team_b_ids: [w2.id, w3.id],
    p_pulled_player_id: pulled.id, p_pulled_from_match_id: src.id,
    p_is_mixed_level: false, p_origin: "auto",
  });
  expect(error).toBeNull();
  expect(heldId).toBeTruthy();
  const { data: row } = await serviceClient().from("matches")
    .select("is_held,is_published,pulled_player_ids,pulled_from_match_id").eq("id", heldId!).single();
  expect(row).toMatchObject({ is_held: true, is_published: false,
    pulled_player_ids: [pulled.id], pulled_from_match_id: src.id });
});
```

### ⚠️ P0 · `QA-RPC-02` — M-6 lock-scope IS achievable as a two-connection vitest test — don't demote it to manual-only

**Kind:** fix flakiness  ·  **Targets:** `CC-RPC-I11`

The catalog over-claims that lock scope is 'invisible to vitest entirely' and 'only truly assertable at SQL/integration level' via two manual psql sessions. The repo's withTx already owns a pg.Pool({ max: 3 }) against DATABASE_URL — two concurrent pool.connect() clients are available, so the M-6 assertion is automatable in the integration suite (not E2E, not manual-only). The cheapest REAL verification: open txn A, run the RPC (or just SELECT … FOR UPDATE over the 3 waiting rows) and hold it; on connection B set a short lock_timeout and (a) UPDATE the PULLED body's queue_entries row — must SUCCEED immediately (proves the pulled row is a non-locking read, the whole point of M-6 so endMatchAction never blocks), and (b) SELECT … FOR UPDATE a WAITING member's row — must throw 55P03 lock_not_available (proves the 3 waiting rows ARE locked). This is deterministic via lock_timeout rather than sleep-based timing, so it is not the 'brittle' pgTAP-two-connection case the catalog feared. Keep the manual two-psql script in the migration comment as documentation, but the primary M-6 case should be this automated lock_timeout test. CAVEAT to the build: a savepoint-only withTx won't hold a true row lock across two pooled clients cleanly — use two RAW pool.connect() clients with explicit BEGIN/ROLLBACK, NOT the savepoint helper, and ROLLBACK both in a finally.

```ts
import pg from "pg";
it("CC-RPC-I11 [M-6]: locks only the 3 waiting rows; pulled row is non-locking", async () => {
  // …seed session + 3 waiting (w1,w2,w3) + 1 playing pulled + in_progress src as in I01…
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await a.query(
      "SELECT id FROM queue_entries WHERE session_id=$1 AND player_id = ANY($2) ORDER BY player_id FOR UPDATE",
      [sessionId, [w1.id, w2.id, w3.id]]
    );
    await b.query("SET lock_timeout = '300ms'");
    // (a) pulled body row must NOT be locked — update returns immediately
    await expect(
      b.query("UPDATE queue_entries SET status='completed' WHERE player_id=$1", [pulled.id])
    ).resolves.toBeTruthy();
    // (b) a waiting member's row IS locked — FOR UPDATE times out (55P03)
    await expect(
      b.query("SELECT 1 FROM queue_entries WHERE player_id=$1 FOR UPDATE", [w1.id])
    ).rejects.toMatchObject({ code: "55P03" });
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    a.release(); b.release(); await pool.end();
  }
});
```

### P1 · `QA-RPC-03` — CC-RPC-U01 payload assertion is tautological (expect.any(Object)) — assert the contract, not 'an object was passed'

**Kind:** strengthen  ·  **Targets:** `CC-RPC-U01`

CC-RPC-U01 asserts mock.rpc was called with ('create_held_cross_court_match', expect.any(Object)). expect.any(Object) passes for ANY second argument, so this half of the assertion can never catch a wrong/missing payload — it only proves the RPC NAME. The success/matchId half is meaningful, but the call-shape half is dead weight here and is fully (and better) covered by CC-RPC-U04. Either (a) drop the toHaveBeenCalledWith line from U01 entirely (keeping just the success+matchId+toHaveBeenCalledTimes(1) assertions and deferring shape to U04), or (b) tighten it to the real return-mapping contract. Mirrors the existing executeMatch unit-style precedent where expect.any(Object) is acceptable only as a name-check companion to a separate objectContaining assertion (engine test lines 513/515-518), never as the sole shape check.

```ts
// CC-RPC-U01 — keep it focused on the success-mapping contract; let U04 own the payload shape.
it("CC-RPC-U01: returns success + matchId on a valid held insert", async () => {
  const mock = makeMockClient([], [{ data: "held-match-1", error: null }]);
  const result = await executeHeldMatch(mock as never, SESSION_ID, heldProposal as never, PULLED_ID, SRC_MATCH);
  expect(result.success).toBe(true);
  expect(result.matchId).toBe("held-match-1");
  expect(result.message).toMatch(/created/i); // mirrors executeMatch's success message contract
  expect(mock.rpc).toHaveBeenCalledTimes(1);
  // name-only check; payload shape is asserted in CC-RPC-U04 (no expect.any(Object) crutch)
  expect(mock.rpc.mock.calls[0][0]).toBe("create_held_cross_court_match");
});
```

### P1 · `QA-RPC-04` — Add a unit case: NULL skip must NOT log via console.error (mirror executeMatch's console.warn) — locks the 'guard NULL is expected' contract

**Kind:** add case  ·  **Targets:** `CC-RPC-U02`, `NEW`

Verified against source: executeMatch's NULL-skip path logs with console.warn (matchmaking-db.ts:360), and its hard-error path returns without logging. The whole engine design (and CC-ENG-04) depends on a guard-NULL being an EXPECTED graceful skip, not an error. CC-RPC-U02 asserts success:false + /skip/ message but does NOT pin the logging channel, so a regression where executeHeldMatch logs the expected skip via console.error (polluting error monitoring / failing a future 'no console.error' CI gate) would pass U02 silently. Add a sibling assertion/case that spies console.error and asserts it was NOT called on the NULL path (and optionally that console.warn WAS — but warn is non-load-bearing, so the must-have is the negative console.error). This is the unit-layer guarantee that CC-ENG-04's 'no console.error for the held slot' note actually rests on.

```ts
it("CC-RPC-U02b: NULL skip is logged as warn, never console.error (expected guard skip)", async () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const mock = makeMockClient([], [{ data: null, error: null }]);
  const result = await executeHeldMatch(mock as never, SESSION_ID, heldProposal as never, PULLED_ID, SRC_MATCH);
  expect(result.success).toBe(false);
  expect(result.message).toMatch(/skip/i);
  // A fired DB guard is an EXPECTED outcome — it must not surface as an error.
  expect(errSpy).not.toHaveBeenCalled();
  errSpy.mockRestore();
});
```

### P1 · `QA-RPC-05` — CC-RPC-U05 is a duplicate of CC-ENG-01 — remove it from this cluster, don't double-own the engine path

**Kind:** dedupe  ·  **Targets:** `CC-RPC-U05`, `CC-ENG-01`

CC-RPC-U05 ('engine-level: forced-repeat + 1 eligible pulled ⇒ executeHeldMatch reached, held RPC called once') is, by its own setup ('engine fromResponses per the existing runEngineInternal sequence'), exactly CC-ENG-01 in the Engine Producer cluster. The catalog even hedges 'keep here only if executeHeldMatch is asserted via the engine entrypoint; otherwise this lives in the engine cluster.' Two clusters asserting the same engine->held-RPC wiring with the same heavy fromResponses queue means double maintenance and a drift risk (one queue updated, the other not). Resolve the hedge: DELETE CC-RPC-U05 and let CC-ENG-01 be the single owner of the engine->executeHeldMatch path. This cluster should unit-test executeHeldMatch in ISOLATION (U01-U04, called directly with `mock as never`) — which is its unique value and is NOT covered elsewhere (executeMatch itself is never directly unit-tested in the repo; it's only hit through the engine). Note that distinction explicitly so the builder doesn't 'simplify' by routing U01-U04 through the engine too.

### P1 · `QA-RPC-06` — Integration happy/guard cases must assert the NEGATIVE/atomicity, not just the return value

**Kind:** strengthen  ·  **Targets:** `CC-RPC-I01`, `CC-RPC-I02`, `CC-RPC-I06`

Several integration cases assert only the RPC return and miss the transactional guarantees that are the actual reason this is the riskiest change. (1) CC-RPC-I01 asserts the new match row but does NOT assert the 3 waiting members flipped to 'drafted' and the pulled body is still 'playing' in the SAME successful call — it defers that to I08, but I01 is the canonical happy path and should prove the full atomic effect set (insert + 3 status flips + pulled untouched) in one transaction so a partial-commit regression is caught at the happy path, not only in a separate case. (2) CC-RPC-I02 ('a waiting member isn't waiting' ⇒ NULL) should ALSO assert NO match row was inserted AND no status changed on the other two waiting members (proves the guard fails BEFORE any write — true rollback, not a half-applied transaction). (3) CC-RPC-I06 (Guard 1b) asserts 'existing held draft untouched' but should additionally assert the count of held matches for that body stayed at 1 (no orphan partial insert from the rejected call). These convert 'returns NULL' into 'returns NULL atomically with zero side effects'.

```ts
// CC-RPC-I02 strengthened: guard fails BEFORE any write (transactional rollback proof)
it("CC-RPC-I02 [Guard 0]: a non-waiting member → NULL AND zero side effects", async () => {
  // …seed as I01 but set w3 to status 'drafted' before the call…
  await serviceClient().from("queue_entries").update({ status: "drafted" })
    .eq("session_id", session.id).eq("player_id", w3.id);
  const before = await serviceClient().from("matches")
    .select("id", { count: "exact", head: true }).eq("session_id", session.id);
  const { data: ret } = await serviceClient().rpc("create_held_cross_court_match", { /* …same args… */ });
  expect(ret).toBeNull();
  const after = await serviceClient().from("matches")
    .select("id", { count: "exact", head: true }).eq("session_id", session.id);
  expect(after.count).toBe(before.count); // no held row inserted
  const { data: rows } = await serviceClient().from("queue_entries")
    .select("player_id,status").in("player_id", [w1.id, w2.id]);
  expect(rows!.every(r => r.status === "waiting")).toBe(true);
});
```

### P1 · `QA-RPC-07` — Add a no-false-positive companion: two DISTINCT bodies CAN be held from the same source match

**Kind:** add case  ·  **Targets:** `CC-RPC-I06`, `CC-RPC-I11`, `NEW`

Guard 1b (I06) proves the SAME body can't be in two held drafts. But the inverse risk — that an over-broad lock or reservation check wrongly blocks holding a SECOND, distinct body from the same in_progress source court — is untested. The spec explicitly allows several held drafts each pulling one body from different courts, and M-6's whole rationale is to keep the pull validation a non-locking read so it doesn't serialize. Without this case, an implementation that (e.g.) reserved the source match id, or FOR UPDATE'd by pulled_from_match_id, would pass every existing case yet break the feature's core promise. Add an integration case: source match m-live has two playing bodies px0 and px1; hold px0 (succeeds), then hold px1 from the same m-live with a different set of 3 waiting members ⇒ must ALSO succeed (non-null id, two distinct held drafts coexist). This is the positive counterpart that makes I06 a real boundary rather than a one-sided check.

```ts
it("CC-RPC-I06b: two distinct playing bodies from the SAME source match can both be held", async () => {
  // …in_progress src match m-live with px0 & px1 both playing; 6 distinct waiting members…
  const r0 = await serviceClient().rpc("create_held_cross_court_match", {
    p_session_id: session.id, p_team_a_ids: [w1.id, px0.id], p_team_b_ids: [w2.id, w3.id],
    p_pulled_player_id: px0.id, p_pulled_from_match_id: src.id, p_is_mixed_level: false, p_origin: "auto" });
  const r1 = await serviceClient().rpc("create_held_cross_court_match", {
    p_session_id: session.id, p_team_a_ids: [w4.id, px1.id], p_team_b_ids: [w5.id, w6.id],
    p_pulled_player_id: px1.id, p_pulled_from_match_id: src.id, p_is_mixed_level: false, p_origin: "auto" });
  expect(r0.data).toBeTruthy();
  expect(r1.data).toBeTruthy(); // NOT blocked — distinct bodies, same court is allowed
  expect(r0.data).not.toBe(r1.data);
});
```

### P2 · `QA-RPC-08` — is_held GENERATED column: add the cardinality>1 and STORED/non-writable edges that R3-2 exists to defend

**Kind:** add case  ·  **Targets:** `CC-RPC-I09`, `NEW`

CC-RPC-I09 correctly proves '{}' ⇒ false and '{x}' ⇒ true, which covers the headline R3-2 decision (cardinality(...) > 0 over array_length(...) IS NOT NULL). But since pulled_player_ids is NOT NULL DEFAULT '{}', a literal NULL can't be inserted — so the truly discriminating extra assertions are: (a) a two-element array (cardinality 2 ⇒ still true) to prove the predicate is cardinality-based and not '= 1', and (b) that the column is STORED/non-updatable (attempting to UPDATE is_held directly errors), since a future migration that made it a plain boolean would silently pass I09. Cheap to add to the same case; makes I09 a real truth table rather than a 2-point check. Low priority because the headline behavior is already covered.

```ts
it("CC-RPC-I09b [R3-2]: is_held is cardinality-based and STORED (not directly writable)", async () => {
  const two = await makeMatch({ sessionId: session.id, status: "pending" });
  await serviceClient().from("matches").update({ pulled_player_ids: [a.id, b.id] }).eq("id", two.id);
  const { data } = await serviceClient().from("matches").select("is_held").eq("id", two.id).single();
  expect(data!.is_held).toBe(true); // cardinality 2 → true (not a '= 1' check)
  const { error } = await serviceClient().from("matches").update({ is_held: false as never }).eq("id", two.id);
  expect(error).not.toBeNull();
});
```

### P2 · `QA-RPC-09` — Fix mis-tagged regression label on CC-RPC-I06 (Guard 1b reservation rail, not N-1)

**Kind:** naming  ·  **Targets:** `CC-RPC-I06`

CC-RPC-I06 tags itself 'N-1 / no body in two held drafts'. In the plan, N-1 is specifically the augmented-pool '<=1 pulled body per combo' rule enforced in buildCombinationGroup (a pure/engine concern, covered by CC-PURE-23..25). Guard 1b ('reject if the pulled body is already named in another pending held draft') is the DB-level reservation safety rail from the spec's 'Safety rails' line, not N-1. Conflating them means a reader grepping 'N-1' lands on a DB guard that isn't the N-1 mechanism, and a future N-1 refactor might wrongly assume I06 covers it. Re-label I06 as the Guard-1b reservation regression and cross-reference the spec's 'no body in two held drafts' rail, with an explicit note that it is the *backstop* for N-1's holding-window gap (which the catalog text already half-says). Pure consistency, no behavioral change.

## 6. UI / Component & A11y (CC-COMP-*, CC-VIEW-*, deriveHeldState pure cases)

_Harness reality confirmed: RTL + happy-dom ARE configured (deps present, four .tsx suites exist, default env is `node` with per-file `// @vitest-environment happy-dom` override), so the component cases are realistic — not fictional. The cluster's strongest point is the deriveHeldState pure suite and the "assert text, never color class" convention. But three P0 issues let real bugs through or test mocks instead of code: (1) CC-VIEW-01 is a tautology — the `is_published` firewall lives entirely in the Postgres `.or()` query string, not in any JS row-filter, so asserting "enriched output excludes the unpublished row" only proves the mock queue, not the code; (2) the deriveHeldState pure cases reuse ids `CC-PURE-01..09`, a hard collision with the Pure-Core cluster's `CC-PURE-01..29` (two unrelated functions, same ids); (3) the CC-COMP-09/10/11 Publish-enabled (M-1) regression cases will silently mis-pass unless the fixture pins `is_published:false` and uses SortableCard (OverlayCard has no Publish button, and SortableCard renders Publish only `if (isDraft)`). Plus weak color-class proxy assertions in CC-COMP-08/16 that the spec's own "never color-only" rule forbids._

### ⚠️ P0 · `QA-COMP-PUB-01` — M-1 publish-enabled cases will mis-pass: Publish renders only `if (isDraft)` and OverlayCard has no Publish button — pin is_published:false + use SortableCard + assert presence before .not.toBeDisabled()

**Kind:** fix flakiness  ·  **Targets:** `CC-COMP-09`, `CC-COMP-10`, `CC-COMP-11`, `CC-COMP-12`

Verified in src/components/organizer/sortable-card.tsx: the Publish button is rendered ONLY inside the `isDraft` branch and OverlayCard has NO Publish button at all (only Clear). Two real traps: (a) the catalog's (b)-harness note says 'prefer OverlayCard for read-only JSX, use SortableCard only for Publish-enabled cases' — fine, but CC-COMP-09/10/11/12 MUST therefore render SortableCard wrapped in DndContext/SortableContext, never OverlayCard; (b) if the held fixture forgets is_published:false (isDraft false), Publish is absent and getByRole('button',{name:/publish/i}) throws 'Unable to find' — a confusing failure that does NOT exercise the M-1 regression, or worse a green run if someone swaps to queryByRole + optional-chaining. The regression these guard against is a future dev adding `|| isHolding` to `disabled={isPublishing || isPickingMode}`. To make the test actually FAIL on that regression: pin is_held:true + is_published:false, FIRST assert the button is in the DOM, THEN assert not disabled.

```ts
// @vitest-environment happy-dom  // MANDATORY header — default env is `node`; RTL render() throws without it.
function renderHeldCard(over = {}) {
  const match = makeEnrichedMatch({ is_held: true, is_published: false, pulled_player_ids: ["p1"], ...over });
  return render(
    <DndContext><SortableContext items={[match.id]}>
      <SortableCard match={match} isDraft={!match.is_published} isPublishing={false}
        isPickingMode={false} isClearing={false} isOptimisticPublished={false}
        onPublish={() => {}} onClear={() => {}} /* ...required props */ />
    </SortableContext></DndContext>
  );
}

it("CC-COMP-09 [M-1]: Publish is rendered AND enabled while HOLDING (publish-then-gate)", () => {
  renderHeldCard({ pulledFromStatus: "in_progress", held_ready_at: null });
  const btn = screen.getByRole("button", { name: /publish/i });
  expect(btn).toBeInTheDocument();      // guards the fixture: button MUST exist (isDraft true)
  expect(btn).not.toBeDisabled();       // the actual M-1 regression assertion
});
```

### ⚠️ P0 · `QA-IDS-01` — Hard id collision: deriveHeldState reuses CC-PURE-01..09 already owned by the Pure-Core cluster (isPullEligible/isHeldMatchReady)

**Kind:** naming  ·  **Targets:** `CC-PURE-01`, `CC-PURE-02`, `CC-PURE-03`, `CC-PURE-04`, `CC-PURE-05`, `CC-PURE-06`, `CC-PURE-07`, `CC-PURE-08`

Section 1 (Pure Core) defines CC-PURE-01..29 (CC-PURE-01 = isPullEligible eligible; CC-PURE-07 = isHeldMatchReady still-playing; CC-PURE-09 = isHeldMatchReady <fallback). Section 6 then RE-USES CC-PURE-01..09 for a completely different function (deriveHeldState), including a second 'CC-PURE-09' (post-swap downgrade). The catalog says ids are stable and cross-references them (e.g. 'CC-PURE-25 backs CC-PURE-29', 'CC-PURE-01/09 cover the swap downgrade'). With the collision those references are ambiguous and a transplant into a shared file would overwrite tests. Renamespace the deriveHeldState pure cases to a distinct prefix — CC-DHS-01..09 (derive-held-state) — and update the A11Y/regression cross-refs (A11Y rows, the M-5/7e and N-2 mappings) accordingly. This also keeps the recommended separate file tests/unit/derive-held-state.test.ts self-consistent.

```ts
// Renamespace, e.g.:
//   CC-PURE-01 (deriveHeldState null)        -> CC-DHS-01
//   CC-PURE-02 (holding)                     -> CC-DHS-02
//   ...
//   CC-PURE-09 (post-swap downgrade → null)  -> CC-DHS-09
// Then fix the cross-refs in the regression-tag line and the A11Y table that currently
// point at 'CC-PURE-01/09' for the swap auto-downgrade visual outcome.
```

### ⚠️ P0 · `QA-VIEW-01` — CC-VIEW-01 tautology: is_published firewall is a Postgres .or() filter, not a JS exclusion — assert the query, not a hand-fed row set

**Kind:** fix mock  ·  **Targets:** `CC-VIEW-01`

Confirmed against src/hooks/use-enriched-matches.ts: when includeDrafts is false the hook calls `.or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)")` and maps WHATEVER rows the builder returns — it does NO client-side is_published filtering. In the existing makeMockClient harness the `.or()` string is inert: the queued response is returned verbatim. So 'queue a held is_published:false row + a published row, assert enriched output excludes the unpublished one' cannot pass for the right reason — if it passes, it's because YOU chose not to put the row in the response queue (testing the mock), and if the implementer hand-feeds both rows it would WRONGLY include the unpublished held row. This is precisely the 'never fake a DB guard and assert on the fake' trap. The honest unit assertion mirrors existing EM-1: prove the firewall FILTER STRING is constructed for the player context. Move the actual exclusion to the RPC/RLS integration checklist.

```ts
// CC-VIEW-01 (corrected): assert the player/TV firewall is expressed in the query,
// exactly as existing EM-1 does. Do NOT assert on a hand-fed row array.
it("CC-VIEW-01: player/TV context builds the is_published firewall filter (held rows are NOT special-cased)", async () => {
  const orSpy = vi.fn().mockReturnThis();
  const builder = makeMatchesBuilder({ orSpy }); // reuse EM-1's builder shape
  // includeDrafts:false → player/TV view
  renderEnriched({ includeDrafts: false });
  await act(async () => {});
  // The firewall is the .or() string — a held draft (is_published:false) is excluded by
  // the SAME clause as any unpublished draft, so no held-specific branch should appear.
  expect(orSpy).toHaveBeenCalledWith(
    "status.eq.in_progress,and(status.eq.pending,is_published.eq.true)"
  );
});
// NOTE for the build: the row-level exclusion of an is_published:false held draft is a
// Postgres/RLS guarantee — keep it as an INTEGRATION/manual checklist item, not a unit assert.
```

### P1 · `QA-COMP-ACTIVE` — 'active segment' assertion is non-deterministic to author: CC-COMP-03/06 allow aria-current="step" OR data-active — pick ONE contract so the test is real

**Kind:** restructure  ·  **Targets:** `CC-COMP-03`, `CC-COMP-04`, `CC-COMP-05`, `CC-COMP-06`

CC-COMP-03 ('marked active via aria-current="step" (or data-active="true")') and CC-COMP-06 leave the active-marker mechanism as an OR. An OR across two different attributes means the test author guesses, and the implementer can satisfy whichever — so the test never actually pins which segment is active; a bug that lights the wrong segment (RESTING active during HOLDING) could pass if the assertion only checks 'some segment has aria-current'. For A11Y-08 (progression exposed to AT) the contract should be aria-current="step" on the ONE active segment (standard AT semantics), and the test must assert the active one is the EXPECTED label AND that the other two are NOT current. Drop data-active as a fallback (or make it the sole contract) — but commit to one.

```ts
it("CC-COMP-03 [A11Y-08]: HOLDING is the active step; RESTING/READY are not current", () => {
  renderHeldCard({ pulledFromStatus: "in_progress", held_ready_at: null });
  // exactly one current step, and it is HOLDING
  const current = screen.getByText("HOLDING").closest('[aria-current="step"]');
  expect(current).not.toBeNull();
  expect(screen.getByText("RESTING").closest('[aria-current="step"]')).toBeNull();
  expect(screen.getByText("READY").closest('[aria-current="step"]')).toBeNull();
  expect(screen.getByText(/Court 2 in play/i)).toBeInTheDocument();
});
```

### P1 · `QA-COMP-COLOR-08` — CC-COMP-08 offers a color-class escape hatch the spec bans — mandate the class-independent data-pulled/aria contract, drop the 'violet-ring marker class' option

**Kind:** strengthen  ·  **Targets:** `CC-COMP-08`

CC-COMP-08 currently reads 'assert that element has the violet-ring marker class OR an aria-describedby/data-pulled attr'. The class branch IS the color-only proxy that 7g and the cluster guardrail explicitly forbid ('never assert a cc-*/Tailwind color class as the source of truth'). An OR that permits the banned form means a lazy implementer satisfies it with toHaveClass('ring-cc-violet') and the a11y contract (A11Y-03) is never actually verified. Remove the OR; require the structural attribute (data-pulled="true") on the correct player's pill. This is the only assertion that proves 'the right player is marked' independent of hue.

```ts
it("CC-COMP-08 [A11Y-03]: the pulled member's pill carries a class-independent data-pulled marker", () => {
  renderHeldCard({ pulled_player_ids: ["p1"] }); // p1 === teamA[0]
  const p1Pill = screen.getByTestId("player-pill-p1");
  expect(p1Pill).toHaveAttribute("data-pulled", "true");
  // negative: a non-pulled teammate must NOT carry the marker (proves it targets the right row)
  expect(screen.getByTestId("player-pill-o1")).not.toHaveAttribute("data-pulled", "true");
  // Do NOT also assert toHaveClass('ring-cc-violet') — color is decorative per 7g.
});
```

### P1 · `QA-COMP-MOTION-17` — prefers-reduced-motion: promote CC-COMP-17 from 'optional' to a real unit case IF motion is JS-driven (useReducedMotion); keep contrast/pulse-timing honestly manual

**Kind:** add case  ·  **Targets:** `CC-COMP-17`, `NEW`

A11Y-06 (reduced-motion on both motion moments) is the one a11y item that is unit-testable in happy-dom — but ONLY if the component reads the preference via a JS hook (useReducedMotion) and swaps to a static element, because happy-dom does not evaluate @media (prefers-reduced-motion) or run CSS animations. The catalog already notes this but leaves CC-COMP-17 optional/ambiguous. Make it a concrete P1 with a vi.mock of the hook so the static-fallback branch is deterministically asserted (no real matchMedia dependency, which happy-dom stubs incompletely). Keep contrast (A11Y-04) and true pulse timing as manual — correctly out of unit scope; do not let anyone 'assert' contrast in happy-dom. If the implementation uses pure-CSS @media instead of a hook, CC-COMP-17 cannot be a unit test — mark it manual and say so explicitly so it isn't silently dropped.

```ts
// Only valid if the component branches on a JS hook. Mock it deterministically —
// do NOT rely on window.matchMedia in happy-dom.
vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));

it("CC-COMP-17 [A11Y-06]: prefers-reduced-motion → static dot renders, pulsing element absent", () => {
  renderHeldCard({ pulledFromStatus: "completed", held_ready_at: null }); // RESTING (pulsing state)
  expect(screen.getByTestId("rest-dot-static")).toBeInTheDocument();
  expect(screen.queryByTestId("rest-dot-pulse")).not.toBeInTheDocument();
});
// If motion is pure-CSS @media: delete this case and record A11Y-06 as MANUAL (/audit), not unit.
```

### P1 · `QA-DHS-EXHAUST` — deriveHeldState state-mapping not exhaustive: add held + held_ready_at set but pulled_player_ids:[] (stale-stamp), and >1 pulled-id, edges

**Kind:** add case  ·  **Targets:** `CC-PURE-01`, `NEW`

The deriveHeldState suite covers null/holding/resting/ready/boundaries well, but the precedence ordering (CC-PURE-08: ready wins over stale in_progress) implies the function checks held_ready_at BEFORE the empty-ids guard. That ordering is untested for the dangerous combo: pulled_player_ids:[] (downgraded) BUT held_ready_at still set (a leftover stamp the downgrade forgot to clear, or arrives mid-recompute). The contract must be: empty pulled_player_ids ⇒ null REGARDLESS of any leftover held_ready_at (it's a normal draft, no violet identity). Without this case, an implementation that checks held_ready_at first would wrongly return 'ready' for a roster that has no held member — re-painting a downgraded draft violet. Also add a pulledFromStatus:null + non-empty ids case (source-match purged, R3-B-adjacent) to pin the holding/resting fallback when status is unknown.

```ts
// CC-DHS-10: empty ids must win over a leftover stamp (downgrade safety — N-2/M-5 mirror)
it("CC-DHS-10: pulled_player_ids:[] with a stale held_ready_at ⇒ still null (no violet re-paint)", () => {
  expect(
    deriveHeldState({ pulled_player_ids: [], held_ready_at: "2026-06-07T09:00:00Z", pulledFromStatus: "completed" }, T0)
  ).toBeNull();
});

// CC-DHS-11: held + source row missing (pulledFromStatus:null) + no stamp ⇒ defined fallback,
// not a crash. Pin whichever the spec intends (likely 'holding' — body presumed still out).
it("CC-DHS-11: held + pulledFromStatus null + no stamp ⇒ 'holding' (source unknown, not yet freed)", () => {
  expect(
    deriveHeldState({ pulled_player_ids: ["p1"], held_ready_at: null, pulledFromStatus: null }, T0)
  ).toBe("holding");
});
```

### P1 · `QA-FIXTURE-TYPING` — Fixtures reference held columns that do NOT exist on Match yet — flag the TDD-red typing gap so the suite compiles via a typed extension, not `as any`

**Kind:** fix mock  ·  **Targets:** `CC-PURE-01`, `CC-COMP-01`, `CC-VIEW-01`

Confirmed in src/types/database.ts: the Match type has NO pulled_player_ids / held_ready_at / is_held / pulled_from_match_id columns (and there is no pulledFromStatus field — it's a derived join the component receives). Every fixture in this cluster (makeEnrichedMatch overrides, the deriveHeldState input, the use-enriched-matches queued rows) will fail `tsc --noEmit` until Phase 1/2 adds those columns. That's expected for red-first TDD, but the catalog should state the explicit ordering: the DB-type extension (database.ts) is a PREREQUISITE commit before these tests can type-check — otherwise authors will reach for `as any`/`@ts-expect-error` and silently lose type safety on the exact new fields under test. Also: deriveHeldState's input is Pick<Match,...> & { pulledFromStatus } — make clear pulledFromStatus is a derived/joined value the caller computes, NOT a Match column, so no one adds it to the table.

```ts
// Build ordering note to embed in the cluster preamble:
// 1) Add held columns to Match in src/types/database.ts (pulled_player_ids: string[];
//    held_ready_at: string | null; is_held: boolean; pulled_from_match_id: string | null;)
// 2) THEN these fixtures type-check with no `as any`.
// deriveHeldState input is `Pick<Match,'pulled_player_ids'|'held_ready_at'> & { pulledFromStatus: MatchStatus | null }`
// — pulledFromStatus is DERIVED from the joined pulled_from_match row, not a column.
```

### P2 · `QA-COMP-16-DROP` — CC-COMP-16 (no border-l-/border-r- stripe) is a brittle class-coupled negative with low signal — demote to manual/visual (/audit), don't keep as a unit case

**Kind:** dedupe  ·  **Targets:** `CC-COMP-16`

CC-COMP-16 asserts the held-card root className does NOT contain border-l-/border-r- classes to enforce impeccable's 'no left/right stripe' ban. This is exactly the color/class-coupled assertion the cluster guardrail warns against, inverted — it couples the test to Tailwind class naming, breaks on any cosmetic refactor (e.g. a switch to ring- or a CSS-module), and the catalog itself flags it 'brittle, best-effort'. A class-substring negative provides near-zero regression protection (a designer could reintroduce a stripe via box-shadow and pass). Move it to the /audit + design-context visual review where the stripe ban actually belongs, and drop it from the unit suite to avoid a maintenance-cost case that tests styling, not behavior.

```ts
// Remove CC-COMP-16 from held-sortable-card.test.tsx.
// Record in the manual/visual checklist instead:
//   [ ] Held card uses no left/right border stripe (impeccable hard ban) — verify in /audit.
```

### P2 · `QA-VIEW-02-MARK` — CC-VIEW-02 is mis-filed under the data-layer view cluster: it's a player-surface COMPONENT case and 'rounded geometry' is not unit-assertable — split it and drop the geometry claim

**Kind:** restructure  ·  **Targets:** `CC-VIEW-02`

CC-VIEW-02 lives in the use-enriched-matches (data-layer) section but its own text says it's 'component-level in the player match-alert/queue surface'. It also asserts 'rounded geometry' for the player-view chip — geometry/border-radius is CSS, not assertable in happy-dom (same class as contrast/box-metrics → manual). Split it: (a) the unit-real part is 'the 3-state machine is ABSENT in player view' (queryByText('HOLDING') → null) — assert that in the player surface's happy-dom test; (b) the 'finishing C2' microcopy presence is a getByText assertion in that same player component test; (c) 'rounded geometry' → manual/visual. As written under the data-layer cluster it can't be authored at all (the enriched hook renders nothing).

```ts
// In the PLAYER surface component test (happy-dom), not use-enriched-matches:
it("CC-VIEW-02: published held draft — player sees calm 'finishing C2' chip, NO organizer 3-state track", () => {
  renderPlayerMatchSurface({ pulled_player_ids: ["p1"], is_published: true, pulledFromCourtName: "Court 2" });
  expect(screen.getByText(/finishing C2/i)).toBeInTheDocument();
  // organizer-only machine must be absent in player view
  expect(screen.queryByText("HOLDING")).toBeNull();
  expect(screen.queryByText("RESTING")).toBeNull();
  // 'rounded geometry' → MANUAL/visual (border-radius not assertable in happy-dom)
});
```
