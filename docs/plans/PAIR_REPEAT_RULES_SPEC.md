# Pair-repeat rules — "no immediate rematch" + shared-games preference

Status: **SPEC — approved decisions recorded, not yet implemented.** Delete this file
when the feature ships (CLAUDE.md writing rule 7); the shipped behaviour moves into
`MATCHMAKING.md` and `APP_MANIFEST.md` §3.1.

---

## 1. Goal

The same two players should not share a court more than twice in a session, and above
all should not share a court in back-to-back games. "Share a court" means **either side**:
partners and opponents both count.

## 2. Evidence (10/31 Saturday Session, Chillax, 37 players)

Measured from production on 2026-11-01; queries in §12.

- 18 engine-made games (auto or held) were a pair's 3rd or 4th shared game.
- **11 of the 18** were the very next game for both players. Four players leave a court
  together, rest the same 18 minutes, come back with equal waits and similar priority, and
  the engine picks them together again.
- **13 of the 18** were role flips: the pair had partnered, then faced each other, or the
  other way round. No current rule sees a flip:
  - the last-game partner ban only stops re-partnering;
  - `CONSECUTIVE_OPPONENT_PENALTY` only charges prior *opponents*, and only as a tie-break;
  - `isBackToBackRepeat` only fires when 3 of the 4 players overlap;
  - partner and opponent counts are capped separately (2 each), so a pair can share a court
    4 times.
- Which rule would have blocked each of the 18: hard opponent cap 5, no-immediate-rematch
  11, max-2-shared-games 18, no-immediate-rematch + hard opponent cap 15.

That table shows what each rule would have *blocked*, not what the engine would have drafted
instead. §9 is how we measure the substitute.

**Feasibility, measured on the seven cached replay fixtures.** At each real match start, the
check asked whether the rested pool contained any four with no immediate-rematch pair. It
ignored skill, so it is optimistic. No such four existed at 47 of 243 match starts. Waiving
the 18-minute rest filter made 44 of those 47 feasible. The cause is structural: R1 means a
legal four needs four players from four different last games, while the rest filter removes
the most recent finishers. That is why A10 exists.

## 3. Decisions

### 3.1 Made by the owner

| # | Decision |
|---|---|
| D1 | A pair is an immediate rematch if they shared **either** player's last game. |
| D2 | A pending draft or an in-progress game **counts** as a player's last game. |
| D3 | The 2-shared-games limit is a **strong preference**, not a hard cap. |
| D4 | No immediate rematch is **never overridden** — not by Red Zone, not by the last-resort fallback. |
| D5 | **Manual games count** toward both rules. |

### 3.2 Adopted defaults — confirmed by the owner

These follow the recommendations from the audit conversation, plus A10, which came out of
the independent review. The owner approved all of them as written. If one is changed later,
only the section cited changes.

| # | Default | Where |
|---|---|---|
| A1 | When rule R1 leaves no legal four (even after A10), the engine produces **no draft** and shows the organizer a new notice explaining why. The 25-minute hard-wait guarantee can be exceeded in that case until the organizer acts. | §5.4 |
| A2 | Rules R1 and R2 apply to **held cross-court drafts**. The pulled player's live game is their last game. | §5.3, §6.5 |
| A3 | Organizer actions are **never blocked**. The manual match builder gains warnings for both rules (v1). Live-swap and draft-swap warnings are a follow-up (§11). | §7 |
| A4 | A draft the organizer **cleared** does not count as a shared game. | §4 |
| A5 | Both rules ship behind **separate kill switches**, default on. | §8 |
| A6 | Replay pass/fail thresholds are the numbers in §9.4. | §9.4 |
| A7 | Replay set = the six current defaults **plus 10/31**. | §9.2 |
| A8 | R2's replacement may bench a longer-waiting non-Red-Zone player. It may also seat players **at most 1 game further ahead in total** (summed across the three non-anchor seats) than the served four, to avoid a 3rd meeting. Red Zone players are never benched. | §6.3 |
| A9 | A waiting-only four that contains a pair's 3rd shared game is a reason to try a cross-court pull. | §6.5 |
| **A10** | **New.** If R1 leaves no legal four and the 18-minute rest filter was applied, retry **once** on the full waiting pool with the rest filter waived, still anchored on the same longest-waiting player. R1 is still enforced on the retry. Cost: a player can be drafted with less than 18 minutes' rest, as already happens today when fewer than 4 players are rested. | §5.6 |

## 4. Definitions

All of these derive from the per-slot `SessionMatchSnapshot` (`fetchSessionMatchSnapshot`).
That snapshot covers every match in `COMMITTED_MATCH_STATUSES` (`pending`, `in_progress`,
`completed`), whatever its `created_method`. So:

- manual games already count (D5);
- drafts and live games count (D2);
- cancelled matches don't, and cleared drafts don't either, because
  `clear_on_deck_match_atomic` deletes the row (A4).

No new query is needed.

- **Last roster of P.** The other three players in P's most recently *created* committed
  match: `lastRosterOf(P, lastOpponents, lastPartners)` minus P, from `deriveLastSides`.
  A malformed roster yields an empty set, meaning no constraint (existing fail-open contract).
- **Immediate-rematch pair.** Players A and B, where B is in A's last roster **or** A is in
  B's last roster (D1). The "or" matters: if A has waited since playing with B, while B has
  played again with someone else, A still sees B as their last game.
- **Shared-game count of A and B.** `partnershipCounts(A,B) + opponentCounts(A,B)` from
  `derivePairCounts`: the number of committed matches both are in, either side.
- **Over-cap pair.** A pair whose shared-game count is already `≥ MAX_SHARED_GAMES` (2).
  Seating them together would be their 3rd or later shared game.
- **Over-cap count of a four.** How many of its 6 pairs are over-cap pairs.

**Where D2 actually applies.** Queue status follows the roster
(`supabase/migrations/20260920000000_queue_status_follows_roster.sql`): a player in an
unpublished draft is `drafted`, in a published one `on_deck`, and on court `playing`.
`fetchActivePool` only reads `waiting`, so a waiting player never has a pending or live
match. D2 therefore matters for **pulled bodies**, whose newest match is their live game.

**Known limitation (accepted).** `swap_player_in_match` can move a waiting player P into a
pending draft D that was created *before* P's latest game G2. When D is played,
`deriveLastSides` still ranks G2 as P's last game, because it orders by creation time. R1
then guards against G2's players instead of D's. This needs an organizer swap into an old
draft; R1 itself never creates the situation. Fixing it means ordering last games by
`started_at`, which is out of scope (§11).

## 5. Rule R1 — no immediate rematch (hard)

### 5.1 Contract

**No engine-produced four may contain an immediate-rematch pair.** This holds on every path:
the normal ladder, Tier 1/2/3, the balance swap, the Red Zone fall-through, the last-resort
fallback, the freshness refresh, the R2 replacement and cross-court held drafts. Red Zone,
hard-cap and last-resort get no exemption (D4). In practice a legal four is four players
from four different last games.

### 5.2 New pure helpers (`src/lib/matchmaking-core.ts`)

- `isImmediateRematchPair(aId, bId, lastOpponents, lastPartners): boolean`, per §4.
- `hasImmediateRematch(playerIds, lastOpponents, lastPartners): boolean`, true if any pair
  among the ids qualifies.

Every enforcement point calls these two functions and nothing else, so there is one
definition and the paths cannot drift apart.

### 5.3 Enforcement points (all gated on `flags.noImmediateRematch`, §8)

1. **Candidate pre-filter in `runAlgorithm`.** Add a step *after* the existing
   partnership-cap filter that drops any candidate who is an immediate-rematch pair with the
   anchor.
   - Compute `capWasActive` from the partnership filter **before** this step, so the R1
     drop is not mistaken for a cap drop.
2. **`buildCombinationGroup`.** Skip any triple that contains an immediate-rematch pair among
   its three members. Run this check **whether or not `previewing` is active**: the
   non-previewing early return (`if (!previewing) return combo`) must come *after* it.
   Pass in the last-sides maps and the flag explicitly; they must not depend on
   `splitPreview` being set.
3. **Tier 1 swap, Tier 2 expanded swap, balance-preserving swap (Fix B).** Reject any
   candidate whose resulting four fails `hasImmediateRematch`.
4. **Tier 3 `rotatedDraft` and the Red Zone fall-through.** These re-seat the group from
   step 2, which is already clean. No change, but the final guard in point 8 covers them.
5. **Last-resort fallback.** Replace "top 3 scored candidates" with: **the first triple
   `i<j<k` in score order**, after `limitPulledToOne`, whose three members are pairwise
   clean. This is an enumeration, not a greedy pick: a clash between candidates 1 and 3
   must not hide a clean 2-3-4. The anchor is already clean after point 1. If no triple
   qualifies, no match.
6. **`findFresherFour`.** Skip any four that fails `hasImmediateRematch`. Takes the flag in
   its `args`.
7. **`buildCrossCourtProposal`.** The inner `runAlgorithm` on the exact four enforces R1
   through points 1 and 2, provided the flags are passed through. Add `flags` to its `args`
   and forward them. Also add an explicit `hasImmediateRematch` skip next to the existing
   `isBackToBackRepeat` skip.
8. **Final guard.** In `runEngineInternal`, immediately before `executeMatch` and
   `executeHeldMatch`, when R1 is on, check the proposal with one condition and one exit:
   - if `hasImmediateRematch` is true, log an error, skip the slot and `break`;
   - this should be unreachable, and it exists so that a future path that forgets the rule
     fails closed instead of committing;
   - the replay simulator applies the same guard under the same flag.

### 5.4 When no legal four exists

**Attribution.** `runAlgorithm` reports R1 as the cause only when R1 actually caused the
miss. When R1 is on and the result is null:

- re-run the same call with R1 off, the same way `markLastPartnerBlock` re-seats without
  the ban;
- `rematchBlocked = true` only if that re-run returns a proposal.

This stops skill exhaustion from being reported as a rematch block. After the first round,
nearly every anchor has a last-game co-player waiting, so "some candidate was filtered" says
nothing on its own.

**Result.**
- `capSaturation = capWasActive || rematchBlocked || lastPartnerBlocked`.
- Add `rematchBlocked?: true` to `AlgorithmResult`. `composeEngineProposal` (§6.4) passes it
  through. **Every R1-specific behaviour keys on this field, not on the reason string:** the
  rest-filter retry (§5.6), the Call Next message, and the §7 warning exception.
- New reason value `"immediate_rematch"`. When several fired, report the **first** of
  `immediate_rematch`, `session_cap`, `consecutive`. `immediate_rematch` goes first because
  the attribution re-run proves R1 was the deciding cause, whereas `capWasActive`
  (`pool.length - 1 > candidates.length` in `runAlgorithm`) is true whenever any waiting
  player is capped with the anchor, whether or not that cap caused the miss.
- Extend the reason union in two places: `AlgorithmResult.capSaturationReason` and
  `CapSaturationPayload.reason` in `src/lib/broadcast.ts`.

**`CapSaturationNotice`** (`src/components/organizer/sortable-card.tsx`) gets a third copy
branch:
- heading: "Immediate rematch blocked";
- Red Zone body: "{name} has been waiting over {CRITICAL_WAIT_MINUTES} min, but every
  available group would put someone back with a player from their last game. Manual
  assignment needed.";
- general body: "Could not form a match for {name} — every remaining group would repeat
  someone's last game. Assign manually or wait for a court to finish.";
- `aria-label`: "Immediate-rematch notice".

**Call Next Match.**
- `runEngineInternal` returns `{ rematchBlocked: boolean }` instead of `void`. It is true
  only when **slot 0** produced no match and its final result (after the §5.6 retry) had
  `rematchBlocked`. A later slot's miss never sets it: a run whose slot 0 committed a match
  must not report "no legal match". Both existing callers (`callNextMatch`,
  `runEngineForSession`) are internal; only `callNextMatch` reads the value.
- In `callNextMatch`, when promotion still fails and `rematchBlocked` is true, return: "No legal match right now — every available group would repeat someone's last
  game. Assign manually or wait for a court to finish."
- Every other case keeps today's "Not enough players in the queue to form a match."
- The court stays empty. That is the accepted cost of D4 and A1.

While R1 is on, the existing `"consecutive"` reason (last-game partner ban) cannot fire,
because last-game partners are never in the same four. Keep the code: it is live when R1's
kill switch is off.

### 5.5 Knock-on effects to implement, not just accept

- **`isBackToBackRepeat`** fires when one player would replay at least 3 people from their
  last game. R1 bans even one, so no engine four can trip it while R1 is on, and
  `runAlgorithmWithFreshness` then only triggers on `forcedRepeat`. Keep the code for the
  flag-off path.
- **The cross-court trigger.** `countConsecutiveOpponentRepeats` is always 0 for an
  R1-clean four, so the `baseStaleness > 0` half of `wantsFresherFour` stops firing, and held
  drafts would only arm on `forcedRepeat`. A9 restores a trigger (§6.5). Without A9, held
  drafts become rare.

### 5.6 Rest-filter retry (A10)

`fetchActivePool` keeps its signature and return type; its existing callers in
`tests/unit/matchmaking-db.test.ts` and `tests/integration/cross-court-realdb.test.ts` stay
unchanged. Add a sibling `fetchActivePoolDetailed` returning `{ pool, fullPool, restFiltered }`,
and make `fetchActivePool` return `(await fetchActivePoolDetailed(...)).pool`:
- `pool` is today's result;
- `fullPool` is every non-paused waiting player, scored and sorted the same way;
- `restFiltered` is true when the rest filter actually removed someone and `pool` was used.

`runEngineInternal` calls `fetchActivePoolDetailed`. When R1 is on, `composeEngineProposal`
returns no proposal with `rematchBlocked`, and `restFiltered` is true:
- build the retry pool with the **same anchor forced first**:
  `[pool[0], ...fullPool.filter(p => p.player_id !== pool[0].player_id)]`. Re-sorting the full
  pool could promote an unrested player above the blocked anchor (score is wait minus
  games-played weight), which would skip the player the retry exists to serve and leave
  `overlapMap` — derived from `pool[0]` via `deriveOverlapMap` — describing the wrong anchor;
- the snapshot and the derived maps stay the same (valid because the anchor is unchanged);
- R1, the partnership cap and every other rule still apply;
- the retry happens at most once per slot;
- the attribution and notice in §5.4 apply to the retry's result;
- when the retry runs, cross-court (§6.5, `anchorBlocksReach`) and the cap-saturation
  broadcast both use the retry pool and its result.

The replay simulator mirrors this: its rest filter is a reimplementation of
`fetchActivePool`'s. It counts the retries as `restWaivedRetries`.

## 6. Rule R2 — at most 2 shared games per pair (strong preference)

### 6.1 Contract

Prefer a four with **no** over-cap pairs. Accept one only when no qualifying alternative
exists, and then the one with the **fewest**. R2 never overrides R1, the partnership cap,
the skill window, diversity or rejection memory, and never benches a Red Zone player.

### 6.2 Where it runs

R2 is a replacement step after the existing pipeline, like the freshness refresh. It is not
a new filter inside the ladder:

1. `runAlgorithm` (with R1).
2. Freshness refresh, when its flag is on (existing behaviour).
3. **R2:** if the served four's over-cap count is above 0, call
   `findLessRepeatedFour(pool, served, args)`. If it returns a four, serve that instead.

Why a replacement step: putting R2 inside the ladder would let the ±1 window take a
3rd-meeting four before the ±2 window is tried. That makes R2 weaker on exactly the
same-skill clusters where repeats concentrate (Frank and Barts are both Lower Advanced).
R2 is one pass with no loop: it either replaces the four once or leaves it.

### 6.3 `findLessRepeatedFour`

New, in `matchmaking-core.ts`, modelled on `findFresherFour`.

**Candidates:** `pool.slice(1)`, filtered by:
- the partnership cap with the anchor;
- R1 with the anchor, when R1 is on;
- `|skill − anchor skill| ≤ SKILL_VARIANCE_MAX`.

**Enumerate triples. A four qualifies only if all of these hold:**
- the anchor is `pool[0]` (structural);
- at most one pulled body;
- `isGroupValid(four, SKILL_VARIANCE_MAX)`;
- it is not identical to the served four;
- every Red Zone player in the served four is also in this four;
- the triple's summed games-ahead is **at most the served four's plus 1** (A8). Games-ahead
  is computed by `gamesAheadOf` against the same baseline `findFresherFour` uses;
- `isDiversityViolation` and `isRejectedRoster` are false;
- `snakeDraft` returns a split without `usedCapOverride`;
- its over-cap count is **strictly lower** than the served four's;
- **if R1 is on:** `hasImmediateRematch` is false;
- **if R1 is off:** `isBackToBackRepeat` is false, and the split's consecutive-opponent
  staleness is no higher than the served four's. Without this, R2 could undo the freshness
  refresh.

**Rank** the qualifying fours lexicographically by:
1. over-cap count, ascending;
2. the existing cost, `fairness + CONSECUTIVE_OPPONENT_PENALTY × staleness`, ascending.

**Wait fairness:** apart from the games-ahead bound above, there is no wait-slack bound. A
benched player keeps waiting, reaches Red Zone at `CRITICAL_WAIT_MINUTES`, and is then
protected by the Red Zone guard. The replay's cycle-time, Red Zone and games-per-player
thresholds (§9.4) check whether that is good enough.

**Mixed-level served fours:** a replacement that cannot keep a Red Zone player within ±2
does not qualify, so the served four stands.

**Result flags.** A replacement returns a fresh object, the same way `findFresherFour`'s
caller does:
- `forcedRepeat` absent;
- `backToBackRepeat` recomputed on the new four;
- `capSaturation: false`;
- `lessRepeatedRefresh: true`.

So cross-court always reads the flags of the four actually served.

**Logging.** After a commit, with R2 on, if the served four's `sharedOverCapPairs > 0`, emit
`console.warn("[matchmaking] shared-games preference: no alternative — serving N over-cap pair(s)")`.
§9.5 checks production against this line.

### 6.4 One composition function

Add `composeEngineProposal(pool, inputs, flags)` to `matchmaking-core.ts`. It runs steps 1–3
of §6.2 and returns `FreshnessResult` plus:
- `sharedOverCapPairs: number` — the over-cap count of the four actually served (0 when R2
  is off);
- `rematchBlocked?: true` — passed through from `runAlgorithm` (§5.4);
- `lessRepeatedRefresh?: true`.

Both `runEngineInternal` and `scripts/replay/simulate.ts` must call it, so the replay
exercises the same composition as production. Today both call `runAlgorithm` /
`runAlgorithmWithFreshness` directly and would drift apart. PR 1 introduces it as a
behaviour-preserving wrapper of steps 1–2 (§10).

### 6.5 Cross-court (A2, A9)

`baseOverCap` is the over-cap count of the waiting-only four after step 3. **When R2 is
off, `baseOverCap`, every candidate's `overCap`, and `sharedOverCapPairs` are all 0** — not
computed and compared. Otherwise the "never worse" rule below would still skip pulls with an
over-cap pair and change cross-court output with both flags off.

- **Trigger:** `wantsFresherFour(forcedRepeat, baseStaleness, baseOverCap)` returns true
  when it does today **or** when `baseOverCap > 0`.
- **Acceptance:** `pullImprovesFreshness(forcedRepeat, baseStaleness, staleness, baseOverCap, overCap)`
  passes when it does today **or** when `overCap < baseOverCap`.
- **Never worse:** a candidate with `overCap > baseOverCap` is skipped.
- **Ranking** in `buildCrossCourtProposal`: games-ahead first, then over-cap count, then
  staleness.
- **Early return:** add `overCap === 0` to the condition that stops the search early
  (today `staleness === 0 && gamesAhead === 0`). With R1 on, staleness is always 0, so
  without this the search would stop at the first passing four.
- Keep the existing staleness semantics unchanged. Update `wantsFresherFour`,
  `pullImprovesFreshness` and their unit tests for the new arguments.

### 6.6 Constant

`MAX_SHARED_GAMES = 2` in `src/lib/constants.ts`, with a doc comment explaining that it
counts either side and is a soft preference. It is independent of the existing caps, which
keep their current behaviour:
- `MAX_PARTNERSHIP_REPEATS` (2) is hard for pairs that include the anchor (pre-filter).
  Other pairs can exceed it through `snakeDraft`'s cap override, accepted by `runAlgorithm`
  when the balance swap finds no alternative, and by the last-resort fallback.
- `MAX_OPPONENT_REPEATS` (2) is soft.

## 7. Organizer surfaces (A3)

The manual match builder already warns about repeat pairings: `src/lib/repeat-pairing.ts`,
`src/app/actions/repeat-pairing.ts`, `use-pair-counts.ts`, `use-repeat-pairing.ts`.
Extend it:

- Two new relations alongside teammate and opponent:
  - **"last game"**: the pair is an immediate-rematch pair;
  - **"shared ≥2"**: the pair is an over-cap pair.
- The server action that returns pair counts also returns the **session-wide** last-sides
  maps, derived from the same snapshot with `deriveLastSides`. They must be session-wide,
  not per selected player: the "either" rule needs bench players' last rosters, and counts
  are frozen when selection goes from 0 to 1. No new table, no new realtime channel; the
  5-channel health check must not change.
- Thresholds are imported from constants, never hard-coded.
- Wording goes in `repeat-pairing-copy.ts`. Follow the existing a11y contract: the marker
  uses icon plus label (never hue alone), and an `sr-only` text node.
- **Strictly advisory.** Creation is never blocked or disabled.
- The existing avoidability gate (`hasCleanAlternative`) applies to the new relations.
- **Exception to the `capSaturation` suppression:** when `capSaturation.reason` is
  `"immediate_rematch"` (first in precedence, §5.4, so it is set whenever R1 caused the
  miss), show the "last game" warnings anyway. That notice tells the
  organizer to assign by hand, which is exactly when they need them.

## 8. Kill switches (A5)

- `MATCHMAKING_NO_IMMEDIATE_REMATCH` gates R1, including the final guard (§5.3 point 8) and
  the rest-filter retry (§5.6).
- `MATCHMAKING_SHARED_GAMES_PREFERENCE` gates R2, including every over-cap count in §6.5
  and the §6.3 warning log.
- Parse both exactly like `isFreshnessRefreshEnabled` in `src/lib/matchmaking-slots.ts`:
  unset or empty means on; `false` / `0` / `off` means off.
- Read once per engine run into `PairRuleFlags = { noImmediateRematch: boolean; sharedGamesPreference: boolean }`.
- **Plumbing:**
  - a trailing optional `flags` parameter on `runAlgorithm` (append-only, like its last
    three parameters; the default is both off, so existing callers and tests stay
    byte-identical);
  - a `flags` field in the `args` of `findFresherFour`, `findLessRepeatedFour` and
    `buildCrossCourtProposal`;
  - a parameter of `composeEngineProposal`;
  - `runEngineInternal` passes the same object everywhere, including the cross-court call.
- The replay CLI reads the same env vars, overridable with `--no-rematch on|off` and
  `--shared-pref on|off`.
- **With both switches off, engine output must be byte-identical to today.** A test asserts
  this (§9.1).
- No migration is needed; the whole change is TypeScript.

## 9. Verification

### 9.1 Automated tests (`npm run test:unit`, plus the integration suite where noted)

**Predicates**
- `isImmediateRematchPair` covers: the "either" semantics (asymmetric last rosters); a live
  game as last game (pulled body); a manual match as last game; a malformed roster giving no
  constraint.

**R1 contract**
- For each path in §5.3, one test drives a pool where the only cheap four contains an
  immediate-rematch pair and asserts the served four is clean or the result is null.
- Red Zone anchor whose only candidates are last-game co-players → `proposal: null`,
  `capSaturationReason: "immediate_rematch"`.
- Hard-cap-tier anchor, same setup → null with the same reason.
- Pure skill exhaustion with R1 on → no `"immediate_rematch"` reason (attribution, §5.4).
- Anchor at the partnership cap with some waiting player (`capWasActive` true) **and**
  blocked by R1 → reason `"immediate_rematch"`, `rematchBlocked: true` (precedence, §5.4).
- Last-resort where candidates 1 and 3 clash but 2-3-4 are clean → serves 2-3-4.
- Cross-court: a pulled body is never seated with a waiting player whose **last game
  included that body**, the "either" direction. Body court-mates who are still playing
  never reach the pool, so testing those would prove nothing.

**Transition out of `"immediate_rematch"`** (CLAUDE.md test requirement)
- Engine: the run is blocked with that reason. One more completed match then gives the
  blocked players a new last game, and the next run serves a clean four with
  `capSaturation: false`.
- `CapSaturationNotice`: renders the third branch for both Red Zone and general, and is
  dismissed through `onDismiss`.
- `callNextMatch`: returns the §5.4 message while blocked, and succeeds once a clean four
  exists. When slot 0 commits and a later slot is R1-blocked, it does not return the §5.4
  message.

**Rest-filter retry (A10)**
- R1 blocks on the rested pool, the full pool has a clean four → served, retry counted.
- Retry happens at most once.
- R1 off → no retry.
- An unrested player who would outscore the blocked anchor on the full pool → the retry
  still anchors on the original `pool[0]`.
- `fetchActivePool` returns the same array as before (existing `matchmaking-db` tests
  unchanged).

**R2**
- Served four with an over-cap pair and a qualifying alternative → alternative served, with
  the flags of §6.3.
- An alternative that would bench a Red Zone player, exceed the games-ahead bound, break R1
  or break the partnership cap → not served.
- No alternative → original served; `sharedOverCapPairs` reported and the warning logged.
- R1 off: an alternative that is a back-to-back repeat → not served.
- Cross-court with R2: a pull that lowers the over-cap count is accepted; one that raises it
  is rejected; the early return does not fire on an over-cap four.

**Held draft lifecycle with R1 on** (integration, `tests/integration/`)
- `runEngineInternal` creates a held draft. The source match ends.
  `recomputeHeldReadiness` marks it ready (`held_ready_at` is written by the code under
  test, never by the test). It is published and promoted onto a court.
- The roster stays R1-clean throughout.

**Manual games count** (integration)
- `runEngineInternal` against a session whose history contains a manual match: the engine
  treats that manual match as the players' last game.

**Flags off**
- Existing suites pass unchanged.
- Equivalence tests with both flags off:
  - `composeEngineProposal` with freshness on vs `runAlgorithmWithFreshness`;
  - `composeEngineProposal` with freshness off vs `runAlgorithm`;
  - `wantsFresherFour`, `pullImprovesFreshness` and `buildCrossCourtProposal` with
    R2 off vs today's outputs, including a pull candidate that contains an over-cap pair
    (must not be skipped);
  - no shared-games warning is logged with R2 off;
  - fixtures from the existing session-simulation tests.

**Session invariants** (`tests/unit/session-simulation.test.ts`, with flags on)
- No player shares a court with anyone from their previous game.
- Pairs above `MAX_SHARED_GAMES` only occur when the step-3 search found no alternative.

### 9.2 Replay harness changes (PR 1, before any rule is enabled)

1. **Fixture sanitation**, applied in `loadFixture` **after** reading the cache, so cached
   fixtures are cleaned too.
   - Drop real matches longer than `MAX_REPLAY_MATCH_MINUTES` (90) from court durations and
     from `realMatches`, and recompute `horizonMin` from what remains.
   - After filtering, drop any court left with no durations (the rule `fetchFixture` already
     applies), so `replaySession` never throws "court … has no observed durations". If no
     court remains, skip the session with a logged reason.
   - Log each dropped match by `seq`. Add an optional `matchId` to `PlayedMatch`, filled at
     fetch time, and log it when present.
   - Why: the cached 10/31 fixture contains match seq 55, 1,175 minutes long, left open
     overnight. Its horizon is 1,400 minutes instead of about 247, so today's 10/31 replay is
     meaningless (309 matches, up to 38 games per player).
2. **Add 10/31** (`79f09a78-d5fd-490f-8699-d6e5cb7b0199`) to `DEFAULT_SESSION_IDS` (A7).
3. **New metrics** in `scripts/replay/metrics.ts`, computed for both the REAL and REPLAY
   columns:
   - `consecutiveCoPlayerRepeats`: a player's back-to-back games sharing **at least one**
     co-player, either side;
   - `pairsOverSharedCap`: pairs with more than `MAX_SHARED_GAMES` shared games;
   - `maxSharedGames`.
4. **New diagnostics:** `noMatchByReason` (including `immediate_rematch`),
   `lessRepeatedRefreshes`, `restWaivedRetries`.
5. **Real jitter.** Today `--jitter K` runs one replay with seed K. Change it to run K
   replays with seeds 1..K and report the mean of every metric and diagnostic. Update the
   help text to match.
6. **Saved runs** (`SavedRun`) store per session the metrics **and** the diagnostics, plus
   the flag values (`freshness`, `noImmediateRematch`, `sharedGamesPreference`,
   `draftQueue`, `jitter`). `engineHash` folds in the flag values, so two runs of the same
   code with different flags are not reported as identical.
7. **Comparison output** (`printComparison`) covers every §9.4 row, per session and in
   aggregate.
8. **Simulator** calls `composeEngineProposal` (§6.4) with the CLI's flags. It applies the
   final guard (§5.3 point 8) and the rest-filter retry (§5.6) in draft-queue mode.

### 9.3 Procedure

1. Land PR 1 with both rule flags off.
2. Save the baseline:
   `npx tsx scripts/replay-sessions.ts --draft-queue --jitter 5 --no-rematch off --shared-pref off --save pair-rules-baseline`.
3. Implement R1. Compare with `--no-rematch on --shared-pref off`.
4. Implement R2. Compare with `--no-rematch on --shared-pref on`.
5. Run every comparison with `--draft-queue --jitter 5 --compare pair-rules-baseline`.
6. Paste the comparison tables into the PR.

### 9.4 Pass/fail thresholds (A6)

Means over `--jitter 5`, per session and aggregated over the seven-session set.

| Metric | Threshold |
|---|---|
| `consecutiveCoPlayerRepeats` (replay) | **0** in every session (R1 makes this structural) |
| `pairsOverSharedCap` | ≥ 50% lower in aggregate; no session higher than baseline |
| `stallEpisodes` | ≤ +1 per session; ≤ +20% in aggregate |
| Cycle time | avg ≤ +2 min, p90 ≤ +3 min, max ≤ +10 min per session |
| `redZoneEntries` | ≤ +15% in aggregate |
| `hardCapEntries` | ≤ +1 per session |
| `mixedLevelMatches` | ≤ +2 per session |
| Games per player | minimum not lower by more than 1; sat-out not higher |

**Which rows gate which PR.**
- **PR 2 (R1 only, `--shared-pref off`):** every row except `pairsOverSharedCap`, which is
  R2's target. For PR 2 that row only requires "not higher than baseline in aggregate".
- **PR 3 (R1 + R2):** every row as written, compared against the same baseline.

**If any gating threshold fails, stop.** Report the table to the owner. Do not tune constants or
loosen a rule to get through. Known limitation: the replay has no manual games and no held
drafts (`simulate.ts` header), so production nights are more constrained than the replay
and its stall numbers are optimistic.

### 9.5 Production check after the first session

Run the §12 query for that session and check the server logs. Expected results:
- zero engine-made immediate rematches;
- every engine-made over-cap pair has a matching `shared-games preference: no alternative`
  log line (§6.3).

## 10. Delivery

Four PRs, in this order, each with its own validation run (`tsc`, lint, `test:unit`) and
the CLAUDE.md review gate:

1. **Harness and wrapper** (§9.2). Add `PairRuleFlags` with both rules off. Add
   `composeEngineProposal` as a behaviour-preserving wrapper of today's steps 1–2, adopted
   by `runEngineInternal` and the simulator. Land the flags-off equivalence tests. No engine
   behaviour change. Save the baseline.
2. **R1**, with its flag, attribution, `rematchBlocked`, notice copy, Call Next message,
   `fetchActivePoolDetailed` and the rest-filter retry, tests and replay comparison.
3. **R2**, with its flag, cross-court trigger (§6.5), tests and replay comparison.
4. **Manual-builder warnings** (§7).

On ship, update the living documents:
- `MATCHMAKING.md` sections 2, 6 (6c, 6d, 6e2, 6h, 6i), 7, 9, 10 and 11;
- `APP_MANIFEST.md` §3.1: Anti-Repeat / Diversity Logic, Engine Constants, Engine Flow,
  Cross-Court;
- `MEMORY.md`: the new kill-switch env vars.

Then delete this file.

## 11. Out of scope

- Warnings in live-swap and draft-swap surfaces (follow-up branch
  `feat/swap-repeat-warnings`).
- Ordering "last game" by `started_at` instead of creation time (the §4 known limitation).
- Changing `MAX_PARTNERSHIP_REPEATS` or `MAX_OPPONENT_REPEATS`.
- Modelling held drafts or manual games in the replay harness.
- Any time-based (minutes) cooldown. Game-based R1 covered every back-to-back case in the
  10/31 data.

## 12. Audit query

Session id goes in `:sid`. Results include manual games, matching D5.

```sql
-- Engine-made games that were a pair's 3rd+ shared game, or an immediate rematch
WITH am AS (
  SELECT id, created_method, completed_at FROM matches
  WHERE session_id = :sid AND status = 'completed'
),
pg AS (
  SELECT mp.player_id, mp.team, am.id mid, am.created_method, am.completed_at,
         row_number() OVER (PARTITION BY mp.player_id ORDER BY am.completed_at) gnum
  FROM match_players mp JOIN am ON am.id = mp.match_id
),
pairs AS (
  SELECT a.player_id p1, b.player_id p2, a.mid, a.created_method, a.completed_at,
         a.team = b.team partners, a.gnum g1, b.gnum g2
  FROM pg a JOIN pg b ON a.mid = b.mid AND a.player_id < b.player_id
),
seq AS (
  SELECT *, count(*) OVER w - 1 AS prior_shared,
         lag(g1) OVER w2 prev_g1, lag(g2) OVER w2 prev_g2
  FROM pairs
  WINDOW w  AS (PARTITION BY p1, p2 ORDER BY completed_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
         w2 AS (PARTITION BY p1, p2 ORDER BY completed_at)
)
SELECT pa.display_name, pb.display_name, created_method,
       CASE WHEN partners THEN 'partner' ELSE 'opponent' END AS role,
       prior_shared,
       (g1 - prev_g1 = 1 OR g2 - prev_g2 = 1) AS immediate_rematch
FROM seq
JOIN profiles pa ON pa.id = p1
JOIN profiles pb ON pb.id = p2
WHERE created_method IN ('auto', 'held')
  AND (prior_shared >= 2 OR g1 - prev_g1 = 1 OR g2 - prev_g2 = 1)
ORDER BY completed_at;
```
