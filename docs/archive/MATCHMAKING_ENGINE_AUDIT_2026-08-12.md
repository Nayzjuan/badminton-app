# Matchmaking Engine Audit — 2026-08-12

**Scope:** `src/lib/matchmaking-core.ts` (pure algorithm) · `src/lib/matchmaking-db.ts` (data layer) · `src/app/actions/matchmaking.ts` (orchestration) · trigger call-sites across `queue.ts`, `match-lifecycle.ts`, `match-drafts.ts`, `sessions.ts`.
**Method:** 4 independent code readers → synthesis → 3 adversarial verifiers checking every claim against source. **Result: 54/55 claims confirmed, 0 wrong, 1 imprecise (trigger list, corrected below).** This document describes what the code actually does, not what the docs say.

---

## 1. The engine in one paragraph

The matchmaking engine is the app's automatic match suggester. It watches the waiting queue and assembles groups of four into proposed doubles matches. It **never puts anyone on a court itself** — it only fills the "on deck" line with drafts. A separate promotion step moves the front of that line onto a court when a match ends, is cancelled, or the organizer presses **Call Next**. Think of it as a maître d' who writes seating plans but never walks anyone to a table.

## 2. When it runs

The engine re-runs after nearly every state change: a player **joins, leaves, checks out, or unpauses**; a match **ends or is cancelled**; a draft is **published or cleared**; **auto-matchmaking is toggled on**; the **draft-cap override** changes; or **auto-publish** is enabled. Each run self-checks before doing anything:

- Auto-matchmaking must be **ON**.
- No other run already in flight for this session (plus DB-level guards for cross-server races).
- At least one court open.
- The session's match history must load. **If it can't be read, the engine stops rather than matching blind** — with no history every repeat would look fresh, so it fails closed instead of producing duplicates.

All of these fail silently by design (console logs only); most triggers fire the engine in the background after the response is sent.

## 3. The hierarchy — how a match gets set up

Ordered from strongest rule to weakest. **ABSOLUTE** rules are never waived; **SOFT** rules are preferences that degrade gracefully.

| # | Rule | Strength |
|---|------|----------|
| 1 | **Permission gates.** Toggle ON, no run in flight, a court open — else nothing happens. | ABSOLUTE |
| 2 | **History must load.** Failed or over-200-match history stops the run (fail-closed). | ABSOLUTE |
| 3 | **Draft capacity.** Max 3 outstanding drafts; 5 at 25+ waiting; 6 at 30+. The organizer override can only *lower* it. | ABSOLUTE per run |
| 4 | **Small-pool patience.** ≤4 waiting with a game in progress → wait up to 8 min for finishers to rejoin. A 2nd draft in one pass needs ≥8 waiting. **Call Next bypasses both.** | SOFT |
| 5 | **Eligibility.** Only `waiting` players — paused and checked-out are invisible, no exceptions. Returning players need **18 min rest**, waived entirely when fewer than 4 rested players remain. | ABSOLUTE / SOFT |
| 6 | **Anchor priority.** Everyone is scored in three tiers (below); the top scorer is the *anchor* and the match is built around them. | — |
| 7 | **Partner cap of 2.** No pair ever teams up a 3rd time in a session. Anyone at the cap with the anchor is removed from consideration entirely. **The one rule never waived on any path.** | ABSOLUTE |
| 8 | **Skill window.** All four within ±1 level, widening to ±2 (Red Zone anchors up to ±4). Dropped completely only when every window fails AND the anchor has waited 15+ min — and even then rule 7 holds. | ABSOLUTE per attempt |
| 9 | **Candidate preference.** Prefer fewest games played, least recent overlap with the anchor, longest wait. Rankings, not rules. | SOFT |
| 10 | **Diversity.** Reject a four where 3+ shared a single recent match (lookback scales 2→7 with pool size). Repair ladder: swap weakest member → wider swap → accept a forced repeat with rotated teams. | SOFT |
| 11 | **Team split.** Snake draft: most skill-balanced splits first, preferring fresh partnerships and un-repeated opponents (opponent cap of 2 is **soft**). Lopsided teams only when every balanced split is partner-capped — flagged, and a repair swap is tried first. | Balance > freshness |
| 12 | **Cross-court pull.** If the waiting pool can only produce a repeat, borrow exactly ONE player still on court (never on a 2-game streak) into a "held" draft that becomes court-eligible only after their game ends + a short rest. Never for the first slot or Red Zone anchors. | Conditional |
| 13 | **Draft → publish → court.** Engine output is always a court-less draft. Organizer publishes (or auto-publish skips review). Only the promotion step assigns a court, atomically, so two freeing courts can't grab the same match. | ABSOLUTE separation |

### Priority tiers (rule 6 in detail)

| Tier | Who qualifies | Score |
|------|---------------|-------|
| **Hard Cap** (top) | Waited **25+ min** AND played **fewer than 5 games** | 2000 + 10 per extra minute — the longest waiter always leads |
| **Red Zone** | Waited **20+ min** | 1000 + wait − 8 × games played |
| **Normal** | Everyone else | wait − 8 × games played (can go negative) |

The 8-points-per-game deduction is the fairness lever: it lets game count drive ordering when wait times are similar, so fresh players get served before someone queueing for their 5th game.

## 4. How a match reaches a court

```
Engine draft (pending, unpublished, no court)
   → organizer publishes           [or born published in auto-publish mode]
   → published on-deck queue
   → PROMOTION (the only court assigner)
        triggered by: match ends · match cancelled · Call Next
        takes the front-most READY published match atomically
        skips not-yet-ready held drafts; auto-clears any match whose players left
   → in_progress on a court
   → completed (+1 game each, wait clock restarts) or cancelled (no game counted)
```

Player queue status mirrors this: `waiting → drafted (in an unpublished draft) → on-deck → playing → back to waiting`. Drafted players still look "waiting" to themselves — drafts are invisible to players and the TV until published.

## 5. Safety rails

- **Race-proof commits.** Match creation runs through a DB transaction with three guards (pre-flight status check, ordered row locks, active-match conflict check). A clash between simultaneous engine runs returns NULL → the engine skips that slot gracefully. No double-booking is possible at the DB layer.
- **Drafts count immediately.** Unpublished drafts count toward every repeat/partner rule the moment they exist, so two concurrent runs can't both claim the same pair.
- **One snapshot, many uses.** All diversity inputs (recent rosters, partner/opponent counts, overlap map) derive from a single per-slot history read — ordering enforced in SQL, fail-closed on error.
- **Checked-out players stay out.** Every restore path (end, cancel, clear, promote) guards against resurrecting a `left` player into the queue.

## 6. Audit findings — quirks the owner should know

All verified in code; none are bugs in the crash sense, but several are surprising:

1. **The Hard Cap guarantee excludes players with 5+ games.** A 30-minute waiter on their 5th game drops to Red Zone — long-waiting players who've had their fair share have *no absolute* service guarantee (by design, to protect under-served players).
2. **Red Zone perks key off score, not wait.** Downstream checks use `score ≥ 1000`. A 20-minute waiter with heavy game debt can compute below 1000 and silently lose Red Zone treatment (wider skill windows, softer penalties).
3. **The cap-saturation banner can misattribute.** It fires whenever the partner-cap pre-filter removed *anyone*, even when the real reason no match formed was skill-window exhaustion.
4. **One silent repeat path.** When a diversity violation's would-be swap target is themselves Red Zone, the repeat is accepted outright *without* being flagged `forcedRepeat` — so the cross-court escape hatch never fires for it.
5. **A fully partner-capped pool produces no match at all**, even past the 15-minute fallback. Only manual organizer assignment gets around it. (This is the "no waivers" rule working as intended.)
6. **The rest-filter fallback is all-or-nothing.** If fewer than 4 rested players remain, the *entire* unrested pool becomes eligible again — not just enough bodies to reach 4.
7. **Held drafts wake up lazily.** A held draft only becomes promotable when a later match-end/cancel runs the readiness recompute — the engine itself never re-checks.
8. **Opposite failure postures, deliberately.** A failed pool read degrades softly (engine sees "nobody waiting"); a failed history read fails closed (run stops). Same layer, opposite choices — both correct for their blast radius.

## 7. Freshness vs. the partner cap — validated on real 18-player Thursdays

**Question asked:** does the snake draft produce fresh pairings *before* rule 7 (partner cap of 2), or does it wait for the cap to bind?

**Answer: fresh first.** The cap is a backstop, never a trigger. Three freshness layers fire before it:

1. **Candidate scoring** (`matchmaking-core.ts:445-473`) — anyone who recently partnered *or* faced the anchor takes **+10,000 per overlap unit**. Teammate and opponent both weight 2, so one recent game together = +20,000, which buries that candidate. This runs long before the cap matters.
2. **Diversity rejection** — a four where 3+ shared a recent match is thrown out.
3. **Snake draft's 4-pass search** (`matchmaking-core.ts:310-344`) — passes 1a/1b require **both** team pairs at `count === 0` (never partnered this session). Only passes 2a/2b accept `count < cap` (i.e. once before). So the order is genuinely **never-partnered → partnered-once → refuse at twice**.

**Important scope limit:** the snake draft only chooses among **3 possible splits of an already-chosen four**. It cannot go fetch different players — that happened upstream in candidate scoring. So most of the freshness you actually feel comes from step 1, not from the draft itself.

**The one exception:** since the 2026-07-30 lopsided fix, splits are partitioned balanced-vs-lopsided *first*, and the freshness passes run over the balanced pool only. A within-cap repeat on balanced teams beats a fresh-but-lopsided split — the only case where the engine takes a 2nd-time pairing while a fresh option existed.

**Measured on four 18-player Thursday sessions** (07/30, 07/09, 06/25, 05/07):

| Session | Matches | Engine-made | Partnerships | Partner repeats | By the engine |
|---|---|---|---|---|---|
| 07/30 | 21 | 8 | 42 | 1 (match 18) | 1 |
| 07/09 | 22 | 3 | 44 | 0 | 0 |
| 06/25 | 28 | 5 | 56 | 1 (match 26) | 0 — *manual* |
| 05/07 | 21 | 6 | 42 | 0 | 0 |

Across all four sessions the engine produced **exactly one** repeat partnership, and **zero** pairs ever reached the cap. At 18 players there are C(18,2) = 153 possible pairs and a session consumes only ~42–56, so the fresh supply never runs dry — **rule 7 effectively never binds at your session size.**

**Two things this surfaced that are worth knowing:**

- **Opponent repeats are a different story:** 23–35 per session, with some pairs facing each other **4 times**. `MAX_OPPONENT_REPEATS = 2` is a *soft* preference and manual matches ignore it entirely. If anyone says "I keep playing the same people," it's almost certainly across the net, not on their own side.
- **Most Thursday matches are manual, not engine-made** — 13/21, 19/22, 23/28, 15/21. Every guarantee in this document applies only to the `auto` minority; manually created matches bypass the engine's rules completely, including the partner cap.

---

## 8. File map

| Layer | File | Role |
|-------|------|------|
| Pure algorithm | `src/lib/matchmaking-core.ts` | Scoring, group assembly, team split, diversity, draft cap |
| Data layer | `src/lib/matchmaking-db.ts` | Pool fetch, history snapshot + pure derivations, match-commit RPCs |
| Orchestration | `src/app/actions/matchmaking.ts` | Engine loop, gates, cross-court trigger, promotion, Call Next |
| Triggers | `queue.ts` · `match-lifecycle.ts` · `match-drafts.ts` · `sessions.ts` | 17+ call sites re-running the engine after state changes |
