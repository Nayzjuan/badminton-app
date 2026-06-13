# Implementation Plan — Anticipatory Cross-Court Diversity Drafting

> **Status: DESIGN PLAN — pending build. No code written yet.**
> Authored 2026-06-07 from a full design interview; revised 2026-06-07 (open questions resolved), then through **three adversarial, code-grounded review passes** — valid findings folded into the phases (tagged `C-#`/`M-#`/`L-#`/`N-#`/`R3-#`); three false positives documented at the bottom and intentionally NOT applied. **Phase 7 (UI) additionally hardened by a UX/UI design pass via `/impeccable` + `/ui-ux-pro-max`, aligned to the project's `.impeccable.md` design context.** **Test-first: ~85 cases authored up front in the companion `CROSS_COURT_TEST_CATALOG.md` (indexed by Phase 8), then hardened by a `/senior-qa` refinement pass (56 refinements, 14 P0) — so the build runs red→green on tests that actually catch their bugs.** Review before implementation.

## The feature, in one line

When the **waiting** pool would force the same group to repeat back-to-back, the engine
reaches into a live court, pulls **one** fresh body, and pre-builds a **held** on-deck draft
that only becomes promotable after that pulled player finishes their current game **and rests
one match**. Maximizes diversity *before* any repeat, without idling courts or starving waiters.
Across the several draft slots the engine already generates, several held drafts can each pull
one body from a different court.

## Locked design decisions (the spec)

| # | Decision | Resolved as |
|---|---|---|
| 1 | Mechanism | Pre-build & **hold** a draft mixing waiting + playing (anticipatory; body finishes its game naturally) |
| 2 | Trigger | Aggressive — fire when waiting-only would return a **forced repeat** / unresolvable diversity violation |
| 3 | Selection | **Best-fit wins** — waiting & playing are equal candidates for the held 4; reuse the existing pure algorithm on an augmented pool |
| 4 | Wait guard | Holding allowed below Red Zone (25 min). A Red-Zone player is **seated now, most-diverse-available** — never held/delayed |
| 5 | Pull count | **1 per match**, distributed across many matches; no artificial global cap |
| 6 | Rest gap | **Readiness-gated**: promotable only when pulled player is free **and** (≥1 promotion since freed **or** ~3-min rest timer). "2nd in line" emerges, never hard-coded |
| 7 | Promotion | **Skip-and-defer** — promote the oldest *ready* match; never idle a court for a held one |
| 8 | Control | Rides the existing **draft review** flow, flagged "Diverse · waiting on Court X → player" |
| 9 | Activation | **Always on**, no toggle |

Safety rails: keep-courts-fed (≥1 ready match always), reservation (no double-draft / no body in two held drafts), staleness escape (abandon hold if waiting members near Red Zone), leaver handling.

---

## The central obstacle (found during planning)

`create_match_with_players`'s **Guard 0** requires *all four* proposed players to be `status='waiting'`.
A pulled body is `status='playing'`, so that RPC would reject it. **Resolution: a separate
`create_held_cross_court_match` RPC** that admits exactly one `playing` body — leaving the strict
"all waiting" invariant (relied on by manual matches, swaps, and the ready-match path) completely
untouched. This is also the single **riskiest change** and carries the most guards (see below).

---

## Phase 1 — Constants (`src/lib/constants.ts`)

| Constant | Value | Purpose |
|---|---|---|
| `CROSS_COURT_REST_FALLBACK_MINUTES` | 3 | Rest-timer fallback when 0 intervening promotions |
| `MAX_CONSECUTIVE_GAMES_FOR_PULL` | 2 | Exclude players already on a 2+ consecutive-game streak. **Pulled games count toward the streak (R3-C)** — so this doubles as the *relational* pull-cooldown, robust to game-length variance. The earlier time-based `CROSS_COURT_PULL_COOLDOWN_MINUTES` is **dropped**: a long game could outlast a clock window, making a still-playing body "eligible" again. Guard 1b remains the hard "no body in two held drafts" guarantee during the holding window; the streak covers the post-play window. |
| `MATCH_REST_GAP_MINUTES` | 5 | Max gap between a player's games to still count as "back-to-back" (streak detection — Phase 4a) |
| `RED_ZONE_OVERLAP_PENALTY` | 150 | Diversity weight for Red-Zone candidates (would replace the literal `×100` in `scoreCandidates`). **Must stay well below ~300** so urgency strictly wins — math-verified: at ×1000 a Red-Zone player with ≥2 overlaps would lose their seat to a fresh player. **(L-1: this constant is OPTIONAL** — the existing hard-coded `×100` already satisfies decision 4; introduce the tunable constant only if you actually want to A/B it, otherwise keep `×100` inline and skip this row.**)** |

## Phase 2 — Schema migration (`supabase/migrations/20260607000000_cross_court_held_drafts.sql`)

New columns on `matches`:
- `pulled_player_ids uuid[] NOT NULL DEFAULT '{}'` — empty = normal draft; one element = held. The UI/promotion flag.
- `pulled_from_match_id uuid REFERENCES matches(id) ON DELETE SET NULL` — the live match the body is finishing (for "waiting on Court X" + free-detection). **(L-4)** `ON DELETE SET NULL` so a held draft self-downgrades instead of erroring if its source match is ever deleted. (Emergency cleanup deletes by `session_id` in one bulk statement, so a default `NO ACTION` FK wouldn't actually block it either — but `SET NULL` is cleaner and removes the subtlety.) **(R3-B:** to keep SET NULL from silently locking a draft in "Holding", `recomputeHeldReadiness` cancels any held draft whose `pulled_from_match_id` became null/missing — see Phase 5.**)**
- `held_ready_at timestamptz` — **stamped** when readiness is first achieved (not live-computed; readiness depends on post-free events).
- `is_held boolean GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0) STORED` — robust/indexable PostgREST filter. **(R3-2:** use `cardinality(...) > 0`, not `array_length(...,1) IS NOT NULL` — same result, but avoids three-valued logic on the empty array. The STORED column is computed in-DB, so there's no driver-serialization concern either way.**)**

New RPC `create_held_cross_court_match(...)` — mirrors the TOCTOU patterns of `20260507000000`:
- Guard 0 (split): 3 members `waiting`; pulled body `playing` AND in `p_pulled_from_match_id` (which is `in_progress`).
- Guard 1 **(M-6 fix):** `FOR UPDATE ORDER BY player_id` over **only the 3 waiting members** (deadlock-free ordering). The pulled body is validated with a **non-locking** read (status='playing' + member of `p_pulled_from_match_id`). Do NOT `FOR UPDATE` the pulled body's `queue_entries` row — it would needlessly block `endMatchAction`'s status UPDATE when that body's game ends, and buys no consistency (the "still playing" check reads the `matches`/`match_players` tables, and the body finishing concurrently is *by design* — it's what makes the held draft eventually ready). Also do NOT instead add a `lock_timeout` to `endMatchAction` — that would turn a brief wait into a hard error on a legitimate completion.
- **Guard 1b (NEW reservation):** reject if the pulled body is already named in another pending held draft (`= ANY(pulled_player_ids)`).
- Guard 2: 3 waiting members not already in a pending/in_progress `match_players` (pulled body exempt — it legitimately is in its in_progress match).
- Insert held match + `match_players`; set the **3 waiting members** to `status='drafted'`; **never mutate the pulled body's status** (it finishes naturally). **Sets `is_published=false`** — so the held draft inherits the existing `matches_select_draft_firewall` RLS policy + the `use-enriched-matches` query filter unchanged; players/TV never see it until published. **(L-3: no RLS change needed** — the firewall keys on `is_published`/organizer, never on the new columns; RLS filters rows, not columns.**)**

Types (`src/types/database.ts`): extend `Match`, `MatchUpdate` (allow `held_ready_at`), add the RPC to `Functions`.

## Phase 3 — Pure algorithm extensions (`src/lib/matchmaking-core.ts`, zero-DB, unit-testable)

- Extend `ScoredPlayer` with `isPulled?`, `currentMatchStartedAt?` — existing math reuses transparently (keys off `player_id`/`skill_level_int`/`priorityScore`).
- Add `forcedRepeat: boolean` to `AlgorithmResult`; set true on Tier-3 rotation + last-resort fallback. **This is the trigger signal.**
- `isPullEligible(player, opts)` — pure predicate over: streak ≥ `MAX_CONSECUTIVE_GAMES_FOR_PULL` ⇒ ineligible, pull cooldown, and already-in-a-held-draft. **(N-4 — NO skill-window check here:** `fetchPullablePlayers` runs *before* the anchor is known (anchor = `pool[0]`, chosen per-slot), so "skill window relative to what?" is undefined. Skill compatibility is left entirely to `runAlgorithm`'s existing progressive `±1/±2` expansion + `isGroupValid`, which filter against the *real* anchor.**)** The streak value is supplied by `fetchPullablePlayers` (Phase 4a), so this stays pure / DB-free.
- `pickEarliestFinishing(candidates)` — court-preference **tiebreak used during composition** (Phase 4): when the augmented pick must choose ONE pulled body and ≥2 tie on skill+diversity fit, prefer the earliest `currentMatchStartedAt` (closest to finishing). **(N-3 — it's a tiebreak, NOT a global pre-sort in `fetchPullablePlayers`** — a pre-sort would override "best-fit wins" (decision 3) by biasing toward earliest-finishing regardless of fit.**)**
- `isHeldMatchReady({pulledFreedAt, promotionsSinceFreed, now, restFallbackMs})` — the readiness predicate.
- `scoreCandidates`: **(L-1 — optional)** the existing literal `overlap * 100` already satisfies decision 4 (Red-Zone seated first, partners ordered by freshness); only swap it for `overlap * RED_ZONE_OVERLAP_PENALTY` if you decide to introduce the tunable constant. If you do, the pinned `scoreCandidates` test expectation must be updated.

## Phase 4 — Engine orchestration (`src/app/actions/matchmaking.ts`, `src/lib/matchmaking-db.ts`)

- `fetchPullablePlayers(supabase, sessionId)` — `status='playing'` bodies + their current `in_progress` match id/`started_at`, minus paused/left/already-held; mapped to `ScoredPlayer{isPulled:true, priorityScore:-1}`. **(C-3 fix — use `-1`, NOT `0`:** `scoreAndSortPool` sorts by `priorityScore` desc then `joined_at` ASC, and early in a session every *waiting* player also scores `0`, so a `0`-scored pulled body with an older `joined_at` could sort to `pool[0]` and wrongly become the **anchor**. `-1` keeps every waiting player strictly ahead in the primary comparator, so a pulled body can never anchor — it only ever competes as a candidate on skill+diversity fit. The earlier "priorityScore:0 never out-anchors" claim was false.**)** **Cooldown (L-2 → R3-C, now relational):** no separate time-based cooldown — pulled games count toward the consecutive-games streak below, so a recently-pulled player is excluded by `MAX_CONSECUTIVE_GAMES_FOR_PULL` (robust to game-length variance). Guard 1b is the hard no-double-pull guarantee during the holding window. **Consecutive-streak (decision 5):** in the SAME batched call, also grab each playing player's last ~3 *played* matches (status `in_progress`+`completed`, ordered by `started_at` desc) and count the leading **back-to-back run** — two games are back-to-back when the newer game's `started_at` is within `MATCH_REST_GAP_MINUTES` of the older game's `completed_at`. Streak ≥ `MAX_CONSECUTIVE_GAMES_FOR_PULL` ⇒ excluded (fed to `isPullEligible`). Cost: **one extra batched query per engine run** (not per player); robust across multiple courts because it's per-player chronological, not roster-position-based. It's a secondary guard (the rest-gap + game-debt already backstop fairness), so "cheap + good-enough" is correct.
- In the slot loop, after `runAlgorithm`:
  1. **Red-Zone short-circuit** (decision 4): if Red Zone, seat from waiting now, skip cross-court.
  2. **Trigger** (decision 2): only when not Red Zone AND `forcedRepeat`, build the augmented pool (waiting + eligible pullable) and re-run the pure pipeline. **≤1 pulled body enforcement (N-1):** the chosen combo may contain at most one `isPulled` member — skip combos with ≥2 pulled inside `buildCombinationGroup` (or inject only the single best-fit pulled candidate into the candidate set). If a valid diverse combo would require ≥2 pulled bodies, reject it and **fall back to the waiting-only result (ready match) ONLY if no valid ≤1-pulled diverse combo exists** — don't give up on a salvageable 1-pulled match. **Tiebreak (N-3):** when ≥2 pulled bodies tie on skill+diversity fit for the single slot, pick via `pickEarliestFinishing`.
  3. Zero pulled ⇒ `executeMatch` (ready). One pulled ⇒ `executeHeldMatch` → new RPC.
- `executeHeldMatch` — sibling of `executeMatch`, same NULL-return graceful-skip convention.
- **Keep-courts-fed:** slot 0 always produces a ready (all-waiting) match (accept mild repeat if needed); held drafts from slot 1+. Guarantees promotion always has something ready.
- **`estimatedWaiting` decrement (C-1 fix):** the slot loop's `estimatedWaiting -= PLAYERS_PER_MATCH` (`matchmaking.ts:503`) over-counts for held drafts — a held draft consumes only **3** waiting players (the pulled body is `playing`, was never in `waitingCount`). Decrement by `PLAYERS_PER_MATCH − pulledCount` (= 3 for a held draft, 4 for a normal one), else the pool-diversity cap (`estimatedWaiting < 8`) trips one slot too early.
- **`bypassGate` ⇒ no held drafts (M-4 hardening, low priority):** when the engine runs with `bypassGate=true` (organizer clicked "Call Next Match"), suppress the cross-court trigger and build only all-waiting matches. A held draft is `is_published=false` so it could never satisfy the immediate promotion anyway, and slot-0-always-ready already prevents any stall — this just keeps the inline run predictable.
- **Soft-gate replacement:** the gate's early `return` (defer) is replaced by a fall-through into the cross-court path when a match is live + pullable bodies exist; defer only when cross-court is impossible AND not timed out AND no Red Zone (no-stall guarantee preserved).

## Phase 5 — Promotion & readiness (`src/app/actions/matchmaking.ts`, `src/app/actions/match-lifecycle.ts`)

- `promoteOnDeckMatchInternal`: promote the front-most **ready** published pending match. **(C-4 → R3-A — TS-filter, no timestamp in the query:** fetch the published pending matches (`is_published=true`, ordered `sort_order` asc then `created_at` asc — a tiny set), then in JS pick the first that's ready: `!m.is_held || (m.held_ready_at && Date.parse(m.held_ready_at) <= Date.now())`. This sidesteps embedding a timestamp in a PostgREST `.or()` logic-tree string entirely — avoiding both the whitespace bug and the URL-encoding fragility two reviews flagged. The earlier inline `.or(... + nowIso + ...)` is dropped.**)** Then **CAS-update the chosen match by id** (`.eq("id",…).eq("status","pending").eq("is_published",true)` → set `court_id`/`status`/`started_at`) so two simultaneously-freeing courts can't both claim it (second affects 0 rows → bail). Held-not-ready matches are skipped; if only those exist the court frees and the engine builds a ready match (never idle).
- `recomputeHeldReadiness(supabase, sessionId)` — the single "held-draft health check." For each held not-ready pending match: **(N-2 — roster integrity FIRST:** if `pulled_player_ids[0]` is no longer in this match's `match_players` (e.g. swapped out), clear `pulled_player_ids`/`held_ready_at` to downgrade it to a normal draft, then skip — this is exactly the detection Phase 7's swap auto-downgrade relies on.**)** **(R3-B — source-match integrity:** if `pulled_from_match_id IS NULL` or its referenced match no longer exists (e.g. purged, FK set to null), the draft can never resolve readiness — cancel it via `clear_on_deck_match_atomic` (returns the 3 members to `waiting`). This is what makes the `ON DELETE SET NULL` (L-4) safe rather than a silent "Holding" lock-up.**)** Then readiness: if `pulled_from_match_id` is completed/cancelled (body free), compute `promotionsSinceFreed`; if `isHeldMatchReady` ⇒ stamp `held_ready_at` (idempotent). **(C-5 — no new column needed:** `promotionsSinceFreed = COUNT(matches WHERE session_id = … AND status IN ('in_progress','completed','cancelled') AND started_at > pulled_from_match.completed_at)` — a "promotion" is exactly a match that got a `started_at` after the body freed, derivable entirely from existing timestamps.**)** Includes the `CROSS_COURT_REST_FALLBACK_MINUTES` (3-min) fallback. **Event-driven, no timer/cron (decision 1):** readiness is recomputed at every lifecycle event (Phase 6); since a held match can only promote when a court frees — itself an event — the fallback firing "at the next event after 3 min" is harmless and needs no background clock.
- Per-player cooldown is the **relational consecutive-games streak (R3-C)**, enforced at pull time via `fetchPullablePlayers`/`isPullEligible` (no time-based window); simultaneous-double-free handled by distinct `pulled_from_match_id` + Guard 1b.
- **Staleness escape** (waiting members near Red Zone) + **leaver handling (waiting member):** clear via existing `clear_on_deck_match_atomic` (returns the 3 waiting members to `waiting`).
- **Pulled body checks out (M-2):** the held match INSERTs **all 4** into `match_players` (incl. the pulled body), so when the pulled player checks out, the existing `checkout_player_cleanup_drafts` RPC already finds the pending+unpublished held match, deletes it, and frees the 3 drafted members back to `waiting` (cancel-and-rebuild) — confirm `remove_player_from_queue_organizer` behaves the same. If a future per-player kick/pause path leaves the body's `match_players` row intact, add a `recomputeHeldReadiness` branch that detects the pulled body is no longer `playing` / no longer in `pulled_from_match_id` and cancels+rebuilds via `clear_on_deck_match_atomic`. **Do NOT clear `pulled_player_ids` in place** — that would leave an invalid 3-player draft.

## Phase 6 — Triggers

Add `recomputeHeldReadiness` before `runEngineForSession`/promote at: `endMatchAction` (completion — where a body frees), `cancelMatchAction`, publish single/all, `callNextMatch`, and engine-run start. No new realtime channels (the `matches` UPDATE propagates).

- **Ghost-availability fix (R3-1) — `endMatchAction`:** when re-queueing the finishing players, set a player to `status='drafted'` (NOT `'waiting'`) if they're named in a pending held draft's `pulled_player_ids`. Otherwise the just-finished pulled body reverts to `'waiting'` and reappears in `fetchActivePool`, so the engine wastes slots proposing them (each blocked by `create_match_with_players` Guard 2's NULL-return — so **no actual double-book**, but it's a reservation leak relying on a backstop instead of being correct-by-construction). Setting `'drafted'` reserves them until the held draft promotes (`drafted→playing`, which `promoteOnDeckMatchInternal`'s `.neq("status","left")` already handles) or is cleared (`drafted→waiting` via `clear_on_deck_match_atomic`). Readiness is unaffected — it keys on `pulled_from_match.completed_at`, not the body's queue status.

## Phase 7 — UI / UX (design-led — from `/impeccable` + `/ui-ux-pro-max` consultation)

**Design context** (`.impeccable.md`, organizer view = command-center / F1-timing aesthetic): use the `cc-*` OKLCH token family only — **never raw Tailwind color utilities**; **clip-cut** polygon geometry (rounded corners are player-view only); `font-command` (Chakra Petch) for status labels, `font-display` (Barlow Condensed) for numerals; tablet-first, 44px touch targets, status scannable in <1s. Honor impeccable's hard bans: **no side-accent stripe** (`border-left/right > 1px`), no gradient text, no glassmorphism-as-decoration.

**Color semantics** — amber (`cc-amber` = on-deck/pending/warning), emerald (live/active), teal (`cc-accent` = command), red (`cc-red`) are all taken. Add **one** new token **`cc-violet`** (indigo-violet ≈ `oklch(0.62 0.19 285)` + a dim surface-tint variant) = the **"held / cross-court / diverse"** identity. READY reuses the existing **emerald** (the go/live green) — the single hue-shift that means "promote me." No third color; restraint is mandatory on this dense dashboard.

**7a. Held-draft card (`SortableCard`)** — reads as a different family without shouting:
- Surface subtly tinted toward `cc-violet` (`color-mix` ~6–8%); identity comes from the tint **+ a clip-cut identity chip** (top-left): icon + `HELD` in `font-command`. **Not** a left stripe (banned).
- Rosters via the existing `TeamsGrid` (sky/amber teams unchanged).
- The **pulled-body pill** is marked distinctly: a violet ring + an "incoming"/court glyph + a court chip **`C2`** (`font-display` numeral), microcopy "finishing C2". Icon + text + ring — never color-only.

**7b. 3-state lifecycle** — a compact **segmented track** (not a single badge/pill; it must convey *progression*). One thin row, three segments, each icon + label:

| State | Token | Icon | Label | Sub |
|---|---|---|---|---|
| HOLDING | `cc-violet` | pause / in-play | `HOLDING` | `Court 2 in play` |
| RESTING | `cc-violet` (brighter) | rest-dot | `RESTING` | `1-match rest` |
| READY | emerald | check / play | `READY` | `tap Publish` |

The active HOLDING/RESTING segment **pulses** (one element; `prefers-reduced-motion` → static dot). The flip to **READY** gets a single one-time emerald entrance (ease-out; reduced-motion → instant) — the one high-impact motion moment, pulling the organizer's eye to "promote me."

**7c. Cross-court relationship cue:** the pulled pill's `C2` chip + status sub-label name the court. Reciprocal **whisper** on the active Court 2 card: a tiny violet corner chip, icon + `feeds next` (`font-command`) — kept quiet. Progressive disclosure: hover/tap a held card highlights its linked court card (and vice-versa) so the link is discoverable, not permanent clutter.

**7d. Actions unchanged (zero added friction):** Publish / Swap / Discard stay exactly as-is. The held card adds only **read-only** indicators (identity chip, 3-state track, pulled-pill marker). Publish stays enabled in every state (publish-then-gate); the **track** — not a disabled button — communicates "won't take a court until READY." When READY, the existing Publish is the natural CTA.

**7e. Swap auto-downgrade (decision 2 / M-5):** if the organizer swaps the pulled player OUT of a held draft, a post-swap `recomputeHeldReadiness` detects the roster-vs-`pulled_player_ids` mismatch and clears the held columns — the draft self-converts to a normal draft (loses the violet identity + track). Never blocks editing. Hook **all** swap paths that touch a pending roster: `swapPlayerInMatch`, `swapMatchPlayers`, `swapActiveFromOnDeck` (+ `undoLiveSwap`'s on-deck branch) — NOT `swapPlayerInActiveMatch`/`swapTeamsInActiveMatch` (in_progress only). No swap-RPC change — just the recompute call.

**7f. Player/TV:** held drafts are `is_published=false` ⇒ hidden until published. Once published, the pulled member's pill shows a calm "finishing C2" chip (player view = **rounded** geometry, per `.impeccable.md`); the 3-state machine is organizer-only — players never see it.

**7g. Accessibility (both skills):** every state = icon + text (never color-only); WCAG 4.5:1 on all chips/labels; 44px targets; `prefers-reduced-motion` honored on both motion moments; the READY hue-shift is reinforced by a distinct icon + label (not hue-dependent).

**New design token:** add `cc-violet` (+ dim tint) to the `@theme` block in `globals.css` (Phase 9 docs note).

## Phase 8 — Tests (TDD; E2E out per repo convention)

**Authored test-first.** The full, transplantable case list lives in the companion **`CROSS_COURT_TEST_CATALOG.md`** (≈85 cases, written 2026-06-07 before implementation while intent was fresh). It is the **TDD checklist**: when building each phase, drop that cluster's cases into the named test file *first*, then implement until green. Every tagged fix (C-1…R3-C) has a named regression case. Reuse the existing harness: `makeMockClient`/`makeBuilder` response-queue, `vi.mock` of `next/server` `after`, `push-server`, the service client, and `@/app/actions/_shared` — per the current suites.

**Senior-QA refinement pass folded in** (`/senior-qa`, 2026-06-07) — the catalog carries **56 prioritized refinements (14 P0)** in its trailing section. **Refinements are authoritative over any conflicting original case** — apply them when transplanting. They include: freeze the clock (`vi.useFakeTimers`+`setSystemTime`) for all timestamp-ordering cases; correct the mis-scoped C-3 cases (CC-PURE-27/28 assert a `-1` that `scoreAndSortPool` discards — verify it at the `fetchPullablePlayers`/engine layer, and prove the C-3 invariant by feeding `runAlgorithm` a pre-scored pool); **extend the mock `makeBuilder` with `is/gt/contains/overlaps`** (the new readiness queries use these PostgREST operators — without them every `CC-RDY-*` test throws `TypeError`); use the repo's **real-Postgres Vitest integration harness, not greenfield pgTAP** for `CC-RPC-I*`; resolve the `deriveHeldState` id collision (it reused `CC-PURE-01..09`); and fix the M-1 publish cases (Publish only renders `if(isDraft)`, so pin `is_published:false` + use `SortableCard`). M-6 lock-scope is achievable as a **two-connection** Vitest test (don't demote to manual).

| Cluster | Target test file(s) | Case ids | Key regressions |
|---|---|---|---|
| 1 · Pure Core | `matchmaking-core.test.ts` (extend) | `CC-PURE-*` (28) | C-3 (pulled never anchors), N-1 (≤1-pulled), N-4 (no skill-window), `forcedRepeat`, keep-courts-fed |
| 2 · Engine Producer | `matchmaking-engine.test.ts` (extend) | `CC-ENG-*` (7) | C-1 (decrement 3 not 4), M-4 (bypassGate ⇒ no held) |
| 3 · Promotion & Readiness | `matchmaking-engine.test.ts` (promote block) | `CC-PROM-*`, `CC-RDY-*` (19) | C-4/R3-A (TS-filter), N-2 (roster integrity), R3-B (source-null cancel), C-5 (COUNT, no column) |
| 4 · Triggers & Lifecycle | `publish-engine-trigger.test.ts` + **new** `match-lifecycle-cross-court.test.ts` | `CC-TRG-{PUB,CNM,END,CAN,GHOST,LEAVER,STALE}-*` | **R3-1 (ghost-availability: finisher → `drafted`)**, leaver-cancel, staleness, recompute-before-engine ordering |
| 5 · RPC / DB Guards | `executeHeldMatch` unit + **integration/manual SQL** (real Postgres guards aren't unit-testable) | `CC-RPC-U*` (unit), `CC-RPC-I*` (integration) | Guard 0 split, M-6 (lock 3 waiting only), Guard 1b reservation, R3-2 (`cardinality>0`) |
| 6 · UI / Component & A11y | **new** `derive-held-state.test.ts` (pure), `held-sortable-card.test.ts`, `use-enriched-matches.test.ts` | `CC-COMP-*`, `CC-VIEW-*`, `CC-PURE-*` (deriveHeldState) | a11y: icon+text not color-only, `prefers-reduced-motion`, 4.5:1; publish-then-gate; player/TV firewall |

**New test files this introduces:** `match-lifecycle-cross-court.test.ts`, `derive-held-state.test.ts`, `held-sortable-card.test.ts` (+ extends `use-enriched-matches.test.ts`). Component cases (`held-sortable-card`) run as RTL assertions **if** RTL is configured; otherwise the catalog marks them manual/visual. The `deriveHeldState(match) → 'holding'|'resting'|'ready'` helper is extracted as a **pure** function precisely so the state logic is unit-tested without rendering.

## Phase 9 — Docs (mandatory)

`APP_MANIFEST.md` §3.1/§3.2/§3.3 + RPC guard table; `MEMORY.md` (feature + migration id + the `scoreCandidates` test change + open questions); `src/types/database.ts` (done in Phase 2); `globals.css` `@theme` block (new `cc-violet` token + dim tint, per Phase 7).

---

## Sequenced rollout (consumer before producer)

1. Phase 1 (constants) → 2. Phase 3 (pure core, full unit tests, zero DB) → 3. Phase 2 (migration + RPC + types) →
4. Phase 5a/5b (skip-and-defer promotion + readiness — safe no-op until producers exist) →
5. Phase 4 (engine producer) → 6. Phase 6 + 5c/5d (triggers, cooldown, staleness, leaver) →
7. Phase 7 (UI) → 8. Full test sweep + docs + **mandatory independent code-review gate**.

Rationale: ship the promotion **readiness filter before** the engine can create held drafts, so there's never a window where a not-ready held draft could be promoted to a court.

Each phase is built **test-first**: transplant that cluster's cases from `CROSS_COURT_TEST_CATALOG.md` into the named test file (red), then implement to green, before moving on.

## Riskiest change

`create_held_cross_court_match` + relaxing the "all waiting" invariant for the pulled body.
Mitigations: separate RPC (strict invariant untouched elsewhere); Guard 1b (no body in two held drafts);
pulled body's status never mutated; TS-layer pre-exclusion in `fetchPullablePlayers`; `FOR UPDATE ORDER BY player_id` over the **3 waiting members only** (M-6 — non-locking read of the pulled body so the RPC never blocks `endMatchAction`).

## Open questions — RESOLVED (2026-06-07)

1. **Rest-timer precision:** ✅ **Event-driven, no timer/cron.** A held match can only promote when a court frees, which is itself an event that re-checks readiness — so the 3-min fallback firing "at the next event" is harmless. No background clock needed.
2. **Swap removes the pulled body:** ✅ **Auto-downgrade.** If the organizer swaps the pulled player out of a held draft, the draft self-converts to a normal draft (clear `pulled_player_ids`/`held_ready_at`) via a post-swap recompute. The organizer is never blocked from editing. *(Review M-5: applies to every swap path that touches a pending roster — `swapPlayerInMatch`, `swapMatchPlayers`, `swapActiveFromOnDeck` — see Phase 7.)*
3. **`is_held` generated column:** ✅ **Approved** — add it for robust/indexable PostgREST filtering.
4. **`RED_ZONE_OVERLAP_PENALTY` value:** ✅ **Not a new decision — it's the knob for decision 4.** Correction: the agent's `1000` is TOO HIGH (math: at ×1000 a Red-Zone player with ≥2 overlaps loses their seat to a fresh player — breaks "urgency wins"). Keep it **modest (~100–150)**, calibrated so a 25-min player is ALWAYS seated next while their partners are ordered by freshness. The current code's ×100 already does this; stronger Red-Zone diversity (if wanted) comes from the swap logic, not this number.
5. **"Consecutive games" source:** ✅ **Resolved — compute in `fetchPullablePlayers`.** Definition: a playing player's streak = the run-length of their most-recent *played* matches (in_progress + completed, by `started_at` desc) that are back-to-back (next `started_at` within ~5 min of prior `completed_at`). Streak ≥ `MAX_CONSECUTIVE_GAMES_FOR_PULL` (2) ⇒ not pullable. Implemented as **one extra batched query per engine run** (grab the playing players' last ~3 played matches, count the run in TS) — robust across multiple courts because it's per-player chronological. Backstopped by the rest-gap + game-debt mechanisms, so "good enough + cheap" is correct. (Add `MATCH_REST_GAP_MINUTES ≈ 5` to constants.)

---

## Plan review — rejected findings (false positives, do NOT apply)

An adversarial, code-grounded plan review (2026-06-07) raised three findings whose *fixes were rejected* — applying them would be wrong or actively harmful. Recorded so they aren't re-raised:

- **C-2 — "`forcedRepeat` cannot be reliably produced":** FALSE. `runAlgorithm` has two concrete, comment-labeled return sites — the Tier-3 rotation return (`matchmaking-core.ts:~690`, whose own log string already says `"(forced repeat)"`) and the *successful* last-resort fallback return (`~747`, inside `if (draft)`). Set `forcedRepeat:true` on exactly those two literals; every other success return (Tier-1 `~621`, Tier-2 `~662`, normal `~718`) is `false`. No overlap-threshold or "all-4-in-recent-roster" heuristic is needed — the plan is implementable as written (Phase 3).
- **M-1 — "block publishing a not-ready held draft":** REJECTED. Publish-then-gate is the intended architecture (decision 8); the promotion readiness-filter (Phase 5) already makes a published-but-unready held draft safe and non-blocking (`.limit(1)` skips it; a ready match behind it still surfaces). Rejecting the publish would contradict "organizer is never blocked." At most an optional info pill — never a hard block.
- **M-3 — "exclude held drafts from `fetchRecentRosters` via `.eq(\"is_held\", false)`":** REJECTED, harmful. Pending drafts feeding `recentRosters`/`overlapMap`/`partnershipCounts` is the **intentional reservation** (`constants.ts:138-141`) that stops the engine re-pairing the held group into a second concurrent draft. The proposed fix would re-introduce the exact back-to-back repeat this whole feature exists to prevent. Held drafts must stay counted, consistent with normal pending drafts. (Cancelled/discarded held drafts drop out automatically — `cancelled` ∉ `COMMITTED_MATCH_STATUSES`.)
