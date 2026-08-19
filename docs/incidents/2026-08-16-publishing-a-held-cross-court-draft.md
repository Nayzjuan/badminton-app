# 3.41 Publishing a held cross-court draft — refused while it held, wrongly allowed while it rested; no code meant "not yet" (2026-08-16)

> Extracted from `APP_MANIFEST.md` §3.41 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `supabase/migrations/20260816000000_publish_never_touches_an_unready_held_draft.sql` **(new —
hand-applied to prod 2026-08-16, stamp `20260816024129`)**, `src/app/actions/match-drafts.ts`, `src/app/actions/matchmaking.ts`,
`src/lib/cross-court/derive-held-state.ts`, `src/lib/constants.ts`,
`src/components/organizer/{sortable-card,on-deck-panel}.tsx`,
`tests/unit/{publish-held-guard,held-draft-ui,derive-held-state}.test.*`,
`tests/integration/publish-match.test.ts`.

Reported after a live session: *"cross-court matches generated for people who are still playing but I
couldn't approve any of them"*, and *"Publish All allows it on deck, but I couldn't make it work."*

**The report is accurate, and it is four separate defects — three of them sharing one symptom.** ⚠️ This
said "four … that happen to share one symptom" until 2026-08-16; defect 2 (the draft-cap notice) does
not. Its symptom is a panel that cannot say why *generation* stopped, and it was found while tracing the
other three, not reported. Defects **1, 3 and 4** are the publish path; defect 2 rides along because it
shares the session and the fix. Production trace, session `3367d4c6` ("08/15 Saturday
Session", `auto_publish=false`, `max_auto_drafts_override=1`): **12 held drafts created, 10
cleared by hand, 2 ever reached a court.**
That is the feature's first live-session evidence of any kind — §3.1's cross-court block had said "still
not observed in a live session", and what the first observation shows is that it does not work.

🪤 **"2 ever reached a court" is the number; do not let a heading round it to zero.** This section was
titled "could never be published" until 2026-08-16, and PR #68's squash body on `main` (`61e942b`) still
says the session "**published zero**" and that the publish path "**refused every one**". Both are false:
`matches` rows `2c1b0edc…` and `4cf0a097…` in session `3367d4c6` are `is_held`,
`created_method='held'`, **`is_published`**, promoted, and `completed`. A class title survives paraphrase
into a **count** — within a day "could never be published" had become "could publish **none** of them" in
§3.1, where it is not a characterisation but arithmetic, and disagreed with the other sites stating the
figure. The list is `git grep -n "2 ever reached a court\|10 cleared by hand\|10 of 12" --
APP_MANIFEST.md MEMORY.md` — and note it misses §3.1's "got **2** of them onto a court", so treat a
phrase grep as a starting set, never as proof of completeness. ⚠️ **No tally of those sites belongs in
this sentence**, which learned it twice: it originally said "four" (exact for these two files at the
time), and the 2026-08-16 "correction" to "six" was wrong for the command it printed, which carried no
pathspec and so swept the whole tree (nine hits at the time, including the migration and two test
files), while the six it did describe included the correction's own new line. A count that changes when
you write it down is not a fact about the document. A squash message cannot be amended, so `61e942b`'s
body is permanent and wrong; these documents are the correctable record.

⚠️ **And do not replace the absolute with an ordering, which is what the first correction did.** It read
"each of those two has `held_ready_at` stamped, **so** both published only after the hold had already
resolved". `held_ready_at` is a *state* column: non-null now proves the hold eventually resolved, never
that the publish came after it. **Production records no publish time at all** — `matches` has no
`published_at`. Its four `timestamptz` columns are `created_at`, `started_at`, `completed_at` and
`held_ready_at` itself, plus the `is_published` boolean; publication is recorded as a flag, with no
instant attached. (This list read three and silently dropped `held_ready_at` until
2026-08-16 — omitting from an "only X, Y, Z" the very column the sentence before it is about, which
is how a reader re-derives the ordering this paragraph exists to kill.)
`match_events` for this session holds only `created` / `cancelled` / `team_flip` / `roster_swap` /
`score_edit`, and `queue_status_events`, the table that would have caught the roster's `drafted→on_deck`
flip, is **empty** (migration `queue_status_audit`, stamped `20260815133945` — hours after the session's
last match completed at `08:01:06Z`; the session itself has `ended_at IS NULL` and was never closed).
🔴 **Sharper, measured 2026-08-16 while reviewing this paragraph: `MatchEventType` *does* define a
`"published"` kind — "draft → published", in `src/lib/match-provenance.ts` — and nothing wrote it.
0 such rows in the whole production database across all 1071 events, including for the 2 held drafts
that did reach a court.** So "prod has no publish record" was not a missing-column argument: the ledger
event existed and was unwired, which means no query over `match_events` can tell "never published" from
"published, unrecorded" **for anything up to this merge** — the writer landed the same day (below), and
it is forward-only, so every sentence in this paragraph stays true of the 08/15 rows forever. ⚠️ The *gap* is not a discovery, and this paragraph said "found" until
2026-08-16: it is booked as `DEFERRED — published event (L2)` in `MEMORY.md` and again in
`src/lib/match-event-log.ts`'s header. What is new is the count and that consequence — L2 prices the gap
at "the timeline just won't show the publish step" and does not anticipate it. The writer plumbing is all
there — `logMatchEvent` accepts `"published"`, `modificationDelta` scores it 0 (this called that function
`eventDelta` until 2026-08-16, a symbol the repo does not contain), the timeline labels it "Published to
players" — so what is missing is the call. Deleting the kind instead is *silently* lossy, measured with
`npx tsc --noEmit`: three errors, **none** at the writer signature, whose `Extract<MatchEventType, …>`
narrows to the survivors without complaint. The comment heading the held-draft block in
`tests/integration/publish-match.test.ts` asserted prod had "no event type" for publish; that was
false in the safer-sounding direction, and it was not caught in draft — it shipped in `f08e662` and
sat on this PR until the next review. Was booked as STANDING TO-DO **A0**; ✅ **the call is now wired —
see *Wiring the `published` event* below.** Worse, the
RESTING window that defect 4 below turns on is measured, and in it the opposite ordering is possible:
`2c1b0edc…` rested **88 s** between its source match completing and its stamp, `4cf0a097…` **237 s**,
and in that window the pre-fix `publish_match` *passes* — `derive-held-state.ts` says so in as many
words ("RESTING … it CAN succeed, and that is worse"). So the honest claim is the count plus defect 1's
mechanism (a HOLDING draft's publish is `CONFLICT` by construction), **not** a sequence. Fixing
"false" with "unprovable" is not a fix.

1. **`publish_match` returned `CONFLICT`, 100% of the time, by construction.** Its conflict predicate counts
   any OTHER pending/`in_progress` match holding one of this roster's players. A held draft's pulled body
   sits in an `in_progress` match for the entire hold — that is *what a hold is*. The organizer-facing copy
   for `CONFLICT` reads "a player is already assigned to another active match. Clear this draft and let the
   engine regenerate." Structurally true and exactly the wrong advice: nothing was broken, the hold had
   simply not resolved. **There was no return code that meant "not yet"**, so the caller could not
   distinguish *wait* from *throw this away* — and 10 of 12 organizer clears is what that reads like in the
   data.
2. **The draft-cap notice could not explain why generation stopped.** `DraftCapNotice` computed its ceiling
   from `getDynamicDraftCap(waitingCount)` alone and never read `max_auto_drafts_override`, while
   `runEngineInternal` caps at `min(override, dynamicCap)`. With the override at 1 — the live session's
   setting — the engine stopped after one draft and the panel, still waiting for three, said nothing at all.
   The notice was a strict under-reporter: it could only ever fire when the dynamic cap was *also* hit.
3. **`recomputeHeldReadiness` was event-driven on the wrong event.** Its only two callers were in
   `match-lifecycle.ts` (match end / cancel). The RESTING→READY stamp requires
   `CROSS_COURT_REST_FALLBACK_MINUTES` of rest to have elapsed — which is **never true at the instant the
   source match ends**. So the one event that fired the recompute was the one event that could not stamp,
   and nothing fired again until some *other* match ended. Two holds in the trace sat unresolved ~10 minutes.
4. **`publish_all_drafts` had no held exclusion at all**, and its two failure modes are opposite. While the
   body is on court the hold hits the same conflict check and is **skipped silently** — the action reported
   every skip as "(left players)" and still returned `success: true`. In the RESTING window (source game
   over, stamp not yet written) it **passes** the conflict check and publishes: four queue rows flip to
   `on_deck`, an `ON_DECK_WARNING` push fires, and `promoteOnDeckMatchInternal` still refuses the match —
   its JS filter over the published pending set takes a held row only once `held_ready_at` is both stamped
   **and due** (`<= now`), so publishing cannot satisfy it. A card parked on deck that no court will take.
   That is "Publish All let it through but it never worked", verbatim.

**One rule, one predicate, plus an independent SQL mirror: a held draft is not publishable until
`held_ready_at` is stamped.** `isHeldAwaitingReadiness(row)` (`= row.is_held === true && row.held_ready_at
=== null`) is the single definition — the card's Publish button, the on-deck review-queue count, the
engine's draft-mode cap count, the heartbeat gate, `promoteOnDeckMatchInternal`'s blocking-drafts count and
both publish actions' snapshot filters all *call* it rather than re-spelling it. Do not maintain a count of
the call sites in prose (this sentence said "five" and there were eight): `grep -rn
"isHeldAwaitingReadiness" src/` is the list, and `matchmaking-db.ts`'s unready-hold count is the one
deliberate inline spelling, which says why at the call site. `publish_match` / `publish_all_drafts` enforce
the same rule independently in SQL — ⚠️ the same *partition*, not the same characters:
`NOT (is_held IS TRUE AND held_ready_at IS NULL)` is three-valued logic, `=== true` is not. The two halves are
deliberately redundant: the RPCs are the real gate (the JS fallbacks only run pre-deploy), and the UI half
exists so the organizer never sees a button whose only outcome is a refusal.

- **`publish_match` gains a `HELD_NOT_READY` code**, checked *after* `ALREADY_PUBLISHED` and *before* the
  left-player and conflict predicates, so the specific cause wins over the generic one. A **new** code, not
  a repurposed one — callers switch on the string and must be able to say "wait". The copy names the
  mechanism and the exit: *"waiting on a player who's still on court. It unlocks by itself when that game
  ends; clear it if you'd rather not wait."* ⚖️ **The order has one accepted cost**: a held draft that has
  *also* lost a player is told to wait rather than to clear. It is self-correcting — once `held_ready_at`
  stamps, the next publish reports `HAS_LEFT_PLAYERS` correctly, and the 15-minute hold-age cancel bounds
  it regardless — and Clear is offered throughout. The alternative restores the original bug for the common
  case (every ordinary hold gets clear-advice again) to improve a rare compound one.
- **`publish_all_drafts` excludes unready holds from `v_all_draft_ids` entirely**, rather than letting them
  fall into `v_skipped_ids`. They are not eligible, so they are not attempts, so they must not inflate
  `skipped_count` — the number the client renders as "clear and regenerate". Same **motive** as
  `20260624000000_clear_drafts_exclude_held` (keep a held draft out of a bulk operation's candidate set
  rather than handling it inside the loop), but deliberately **not** the same predicate: that one excludes
  *every* held draft (`is_held IS NOT TRUE`), since a bulk clear must never touch a hold; this one excludes
  only the **unready** ones, since a stamped hold is an ordinary publishable draft. Aligning the two
  spellings would make a READY hold permanently unpublishable via Publish All. With held drafts no longer
  candidates, the skip causes an organizer can act on are a departed player and a genuine double-booking,
  so the skip copy was corrected from the unconditional "(left players)" to name both. (The loop's third
  skip arm — the row stopped being a `pending` unpublished draft between the snapshot and the `FOR UPDATE`
  — is a concurrency race, not an organizer-actionable state, and is rare enough to leave under the same
  copy.)
- **Publishing stays BLOCKED, not deferred.** Promotion requires the stamp anyway, so an early publish buys
  nothing and costs a premature player-facing ping. Clear stays available — it is the one action that is
  always legitimate on a hold the organizer no longer wants, and it is also how the three reserved players
  are freed.
- **Held-draft heartbeat** (`runEngineInternal`): `recomputeHeldReadiness` now also runs from the engine,
  gated on `pendingRows.some(isHeldAwaitingReadiness)` so a session with no live hold pays nothing. Queue
  joins, publishes and clears all reach the engine, making it much the denser trigger. Re-entrancy is safe
  — `endMatchAction` already calls it, so a match end now runs it twice; the stamp is idempotent
  (`.is("held_ready_at", null)`) and the second pass is the useful one, landing *after* that end's
  promotion and so seeing the incremented `promotionsSinceFreed`. The pending set is **re-read** after the
  recompute rather than counted from the pre-recompute snapshot, because the recompute can stamp, cancel or
  downgrade a row — all three change the count below it. Still not a timer: it sits below the `courtCount`
  early-return and inside the `is_auto_matchmaking_on` gate, so `CROSS_COURT_MAX_HOLD_MINUTES` remains a
  bound on *attention*. See the corrected bullet in §3.1.
- **`CROSS_COURT_MAX_UNREADY_HOLDS = 2`**, enforced in `hasFeedableCapacity` at creation time. The trace's
  12 holds against 2 promotions is the shape this bounds: reaching again while two holds are already
  unresolved parks six more players against a mechanism that has not yet demonstrated it can release three.
- **The panel now computes the engine's cap**, `min(override, dynamicCap)`, and counts the same review
  queue the engine does — held drafts excluded while unready, included once stamped. An unready hold still
  **renders**; it just does not fill a slot. Counting it would have produced the worst possible notice:
  "2/2 draft slots filled — publish the drafts below to resume", pointing at a card whose Publish button
  had just been removed.

**Tests.** `derive-held-state.test.ts` CC-DHS-06…08 pin the predicate itself, including that a null
`is_held` falls to *not held* (fail-open, same direction as `hasFeedableCapacity`'s CCT-FEED-7). The column
is `GENERATED` and never null in the DB, and `database.ts` declares it `boolean` — but that declaration is
an assertion, not a validation: nothing checks a PostgREST payload against it at runtime (types are erased
and `supabase-js` casts). CC-DHS-08 needs a cast to reach the case *because* the type says it cannot happen; that is
the point of the case, not an argument against it.
`publish-held-guard.test.ts` (PUB-HELD-1…10) covers the two JS fallbacks through a table-addressed service
mock, and asserts guard **order** structurally rather than by message: PUB-HELD-2 checks `svc.from` was
called exactly once and no update was issued, so the refusal cannot be coming from a later probe.
PUB-HELD-8 pins the asymmetry that makes the two-list restructure correct — `match_players` is queried for
the *publishable* ids while the conflict probe still excludes **every** draft including the held one,
because narrowing that exclusion set would turn a held draft into an "other active match" and let it taint
its neighbours. `held-draft-ui.test.tsx` (UI-HELD-1…4, UI-CAP-1…6) pins both components, including that the
suppression is *explained* — a button that vanishes with no reason reads as a bug.

`tests/integration/publish-match.test.ts` Suite **PUB-HELD-DB-1…4** is the half no unit test can reach: the
conflict predicate needs a genuinely `in_progress` source match holding the body, and the `publish_all_drafts`
candidate filter is SQL. (The `-DB` suffix is load-bearing — the unit suite already owns `PUB-HELD-*`, and
these are different tests of the other half.) It builds the fixture through `create_held_cross_court_match`
rather than a raw insert, so `is_held` and the drafted/playing queue statuses come out exactly as the
engine writes them. **Injection-verified**: restoring the pre-fix function bodies locally failed exactly
PUB-HELD-DB-1 (`expected 'Cannot publish — a player is already …' to match /still on court/i` — the field
bug reproduced verbatim), PUB-HELD-DB-3 and PUB-HELD-DB-4 (`skipped_count` 1, not 0), while PUB-HELD-DB-2
stayed green — which is what proves PUB-HELD-DB-2 is a real control (the guard lifts) and not a tautology.
ACLs were re-verified as `{postgres, service_role}` after restore.

✅ **Migration `20260816000000` — APPLIED AND VERIFIED ON PRODUCTION 2026-08-16, stamp `20260816024129`.**
Applied *before* the merge, while both open sessions held 0 live matches and 0 held drafts. Post-apply on
prod: both functions still `SECURITY DEFINER`, both ACLs still exactly `postgres=X/postgres |
service_role=X/postgres` (no PUBLIC, anon or authenticated), and the return ordering re-verified
positionally as `HELD_NOT_READY` < `HAS_LEFT_PLAYERS` < `CONFLICT`. Pre-apply both prod bodies were
confirmed clean pre-fix baselines, so the new version is a strict superset. Full fingerprints in repo
`MEMORY.md`'s migration queue. ⚠️ Both functions are `CREATE OR REPLACE` with unchanged signatures
specifically to preserve the narrowed EXECUTE grants from `20260721180000` / `20260722000004` — do **not**
convert either to DROP+CREATE, which silently resets the ACL to `EXECUTE TO PUBLIC`.

🪤 **Why this paragraph is worth re-reading before you trust it.** While the migration was unapplied, the
TypeScript half degraded safely — the UI stopped offering Publish on an unready hold and the action's
snapshot filter excluded it, so the organizer could not reach the old `CONFLICT` path by the ordinary route,
*but the RPCs themselves stayed unguarded* against a stale client or a direct call. That safe degradation is
exactly what makes "did the migration actually land?" an easy question to stop asking. It landed. If you are
reverting, revert the **code** and leave the SQL: the guard is a strict narrowing and a no-op for any client
that already refuses to publish an unready hold.

✅ **The `cancelMatchAction` reservation gap — CLOSED 2026-08-16 (was ⚠️ "pre-existing, not fixed here").**
No migration: it is TypeScript only, so it is correct in production the day it merges — unlike
`20260816000000`, which had to be hand-applied first and was.

`cancelMatchAction` flipped **every** roster player to `waiting` in one bulk UPDATE. That is right for the
ordinary cancel and wrong at both ends of a live hold, so the restore is now a three-way partition —
`partitionCancelRestore` in `src/lib/cancel-restore.ts` owns the rule, the action only feeds it reads:

1. **The reservation mirror.** A pulled body whose held draft is still `pending` comes back `drafted`, not
   `waiting` — the same re-reservation `endMatchAction`'s R3-1 performs. This half is required precisely
   *because* the hold survives: `recomputeHeldReadiness` counts `cancelled` alongside `completed` as the
   event that frees the body, so a cancelled source moves the draft Holding→Resting rather than tearing it
   down. And recompute cannot repair the status afterwards: **no path in it ever writes `'drafted'`**. Its
   only `queue_entries` writes are the ones its RPCs perform — `clear_on_deck_match_atomic` → `'waiting'`
   and `auto_publish_match` → `'on_deck'` — and neither restores a lost reservation. (In auto-publish mode
   the second one would eventually rewrite a wrongly-`'waiting'` body to `'on_deck'`, which is not a repair:
   by then the engine has already had the body in the pool.) It also runs *after* the restore, not before.
2. **The physical-truth skip.** A roster member who holds an `in_progress` match in this session is not
   written at all. That is the rule migration `20260812000000` put inside `clear_on_deck_match_atomic`;
   `cancelMatchAction` never calls that RPC, so it needed its own copy. Reachable by cancelling the **held
   draft itself** — three drafted members plus one body mid-game on another court. The UI declines to send
   that today (`active-courts.tsx` filters to `in_progress`, `court-card.tsx` renders Clear for a pending
   row), but every export of a `"use server"` file is a public endpoint, so the UI is not the gate.

Both arms depend on the CAS at `match-lifecycle.ts` having **already** flipped this match out of
`pending`/`in_progress`: that is what lets one predicate set cover both cases, since the cancelled match can
then be neither "the `in_progress` match" of (2) nor "the pending held draft" of (1). Do not reintroduce a
`match.status` branch — that variable holds the *pre*-CAS status (correct for the audit `phase`, wrong here).
`requeue_finished_players` is deliberately **not** reused despite its `p_drafted_ids` argument looking made
for this: it unconditionally does `games_played + 1, joined_at = now()`, and a cancel must cost neither.

🪤 **The claim this replaces was overstated in its consequence** and the correction matters, because the
overstatement points at the wrong failure. The freed body could not actually be "drafted elsewhere, leaving
the hold permanently in CONFLICT" — `create_match_with_players`' Guard 2 counts `pending` **and**
`in_progress`, and the held draft's own `match_players` row is pending, so the RPC returns NULL. What
actually happens is worse and quieter: the body re-enters `fetchActivePool`, the engine spends a slot
seating them, the RPC returns NULL, `executeMatch` fails and the **slot loop breaks — the tick produces
zero matches**. Same chain migration `20260812000000`'s header describes for the unseating bug.

Coverage: `CC-CAN-HELD-01` / `CC-CAN-HELD-02` (`tests/integration/cross-court-realdb.test.ts`, both off the
existing `seedHeldDraft` fixture) and `CC-CAN-01..07` (`tests/unit/cancel-restore.test.ts`). **Negative-control
verified**, each half separately: deleting the drafted branch fails only `CC-CAN-HELD-01`
(`expected 'waiting' to be 'drafted'` — the bug verbatim); deleting the physical-truth skip fails only
`CC-CAN-HELD-02` (`expected 'waiting' to be 'playing'`). Both assert **pool admission**, not just the status
string, since it is `fetchActivePool` membership that drives the stall. `CC-CAN-05` is the arm no fixture can
reach — a player both playing and held-reserved must be *skipped*, never drafted — and it is exactly the
precedence a later refactor would invert. `F-cancel-2` now also pins `joined_at` as unchanged, which is the
column that made the RPC reuse tempting and wrong.

⚠️ What makes `CC-CAN-05` unreachable is a **conjunction of two guards in two migrations**, and citing only
the first is the mistake this paragraph exists to prevent. `create_match_with_players`' Guard 2
(`20260507000000`) covers an *ordinary* roster member. It does **not** cover the pulled body, because
`create_held_cross_court_match`'s own Guard 2 (`20260607000000`) deliberately **exempts** it ("the pulled body
is exempt — it IS in its `in_progress` match") — that exemption is the whole point of the held RPC. The guard
actually blocking the overlap is that RPC's **Guard 1b**, the reservation check that refuses a body already
named by another `pending` held draft (see the **Held RPC** bullet under §3.1 → *Cross-Court Diversity
Drafting (held drafts)*). A reader sent to `create_match_with_players`
finds no held-draft logic there, concludes the precedence is dead code, and deletes it — which is the exact
outcome `CC-CAN-05` was written to prevent. Lose *either* guard and the arm goes live.

⚠️ **Accepted, not fixed:** between the held-draft read and the `drafted` write, a concurrent
`clear_on_deck_match_atomic` can delete the draft and strand that player at `drafted` — invisible to
`fetchActivePool`, with no orphaned-`drafted` reconciler anywhere in `src/`. The identical window already
exists in R3-1, so this is parity rather than new risk; close it only if observed, and only with an RPC that
*replaces* the TS block rather than twinning it behind a fallback.

⚠️ **Same class, still open one file over:** `match-drafts.ts`'s `clearOnDeckMatch` PGRST202 fallback
reproduces the exact unguarded `update({ status: "waiting" }).in("player_id", …).neq("status", "left")` that
`20260812000000` removed from the RPC. On any environment where `clear_on_deck_match_atomic` is missing, the
Clear button on a held draft unseats a live body. Out of scope here — named so "we fixed the class" doesn't
stop the next reader looking.

#### Wiring the `published` event — CLOSED 2026-08-16 (was STANDING TO-DO **A0**)

**Files:** `src/lib/match-event-log.ts`, `src/app/actions/match-drafts.ts`, `src/app/actions/matchmaking.ts`,
`tests/unit/published-event.test.ts` **(new)**, `tests/unit/{publish-engine-trigger,publish-held-guard}.test.ts`.
**No migration** — `match_events` already accepts the kind and `record_match_event` already writes it, so this
is TypeScript only and is correct in production the day it merges. Contrast `20260816000000` above, which had
to be hand-applied first: this one cannot be half-shipped.

`logPublishedEvents` (in `match-event-log.ts`) owns the write; the five transitions call it and pass a
`reason`. It is deliberately one helper rather than five inline `logMatchEvent` calls, because the payload it
assembles is the part a per-site copy would drift on:

| site | reason | actor |
| --- | --- | --- |
| `publishMatchAction`, RPC `SUCCESS` | `publish_single` | organizer |
| `publishMatchFallback` (PGRST202) | `publish_single` | organizer |
| `publishAllDraftMatchesAction`, RPC path | `publish_all` | organizer |
| `publishAllDraftsFallback` (PGRST202) | `publish_all` | organizer |
| `recomputeHeldReadiness` → `auto_publish_match` `SUCCESS` | `auto_publish_held` | **engine** |

The RPC and its fallback share a `reason` on purpose: the transition is identical, and *which one ran* is a
property of the environment's migration state, not of the match. The fifth site is the one the brief did not
name and the one this whole section is about — it is the cross-court auto-publish path, so wiring only the two
organizer entry points would have left held drafts exactly as unrecorded as before.

- **`actor_type` is `engine`, not `system`, for the fifth site.** `logMatchEvent` derives the actor from the
  presence of an `actorId`, which yields `system` when there is none; that default is right for *an automatic
  consequence* and wrong here, because this is the matchmaker itself acting. The new `actorType` override
  exists for that one case. `engine` is not a new actor kind — `create_match_with_players` already writes it
  for every engine-made `created` event (`CASE WHEN p_origin = 'manual' THEN 'organizer' ELSE 'engine' END`,
  `20260617000000_match_provenance_audit`). Note the pair it contrasts is organizer/engine; that RPC never
  emits `system` at all.
- **`phase` is `"draft"`**, per the codebase convention that any `pending` match is a draft — spelled out at
  the `cancelled` call site inside `removePlayerFromQueue` (`src/app/actions/queue.ts`), which is where the
  rule is written down. The match is `pending` on *both* sides of this transition — publishing flips `is_published`,
  never `status` — so there is no phase to move to. The published/on-deck distinction lives in the payload.
- **The payload distinguishes the held path without needing a separate event kind.** It carries
  `created_method`, `is_held` and `held_ready_at` alongside the roster snapshot. `held_ready_at` (when the hold
  unlocked) against the event's own `created_at` (when it was published) is the interval the 08/15 post-mortem
  had no way to measure — the paragraph above spends five sentences establishing that prod records no publish
  time *at all*, and this is the column that ends that. All three are read *after* the write, which is safe
  for two different reasons and it matters which: `created_method` is immutable after insert, but the held
  pair is **not** — `recomputeHeldReadiness` downgrades a held draft whose pulled body left the roster by
  clearing `pulled_player_ids` (which drives the GENERATED `is_held`) and `held_ready_at`. Its *candidate
  query* filters `.is("held_ready_at", null)` while a held draft cannot publish until `held_ready_at` is
  stamped (`20260816000000`), so the two normally never see the same row — not because the columns are frozen.
  Be exact about the strength of that: the filter is on the SELECT, not on the downgrade's UPDATE, so it is a
  read-then-write and two overlapping recompute runs could still clobber a row published in between. The cost
  is one payload carrying a stale held triple. An earlier draft of this bullet claimed all three columns were
  simply stable, and its replacement said *by construction* — the weaker, true reason is the one that tells a
  later reader which line to keep. `is_published` is deliberately **absent** — post-write it is `true` for
  every row, so recording it would record nothing.
- **`ALREADY_PUBLISHED` writes nothing**, and it is the trap worth naming: it returns `success: true`. An
  "on success, log it" reading of the code stamps a second review onto a match nobody re-published. The two
  **fallback** paths have the same hazard without the error code: their UPDATE carries `.eq("is_published",
  false)`, so a concurrent publisher between the precondition read and the write makes it a silent no-op. Both
  therefore log off the UPDATE's own `.select("id")` RETURNING rather than off "no error" — `publishMatchFallback`
  was missing that `.select` and would have credited this organizer with the other one's transition; the review
  gate caught it. The batch RPC path drives its events from the *same re-read* that drives the on-deck push, so
  the ledger and the notification can never disagree about who was published — including on that re-read's
  known leak, which is *anything* a concurrent publisher flipped between this run's snapshot and the re-read,
  whichever of the three arms skipped it. The RPC returns counts, not ids, so nothing short of a new signature
  separates them; the residue is a duplicate row a few seconds after a real one, never a missing one. The
  opposite direction exists too and is equally benign: the snapshot excludes unready holds, so a hold stamped
  ready between the snapshot and the RPC is published by the RPC and gets neither the push (pre-existing) nor
  an event — under-recording, which is the bias the paragraph below already licenses.
- **Best-effort, matching every other call site**: the sequence is computed outside the row lock, the
  modification delta is 0 (already pinned by `MP-CNT-03`), and both the returned-`error` and the thrown-
  exception paths are swallowed with a `console.error`. Publishing is the user-facing mutation and it has
  already committed; failing the action here would report a false negative about a match that *is* published.
  ⚖️ **Accepted cost:** the audit is `await`ed inline, so it adds two serial round trips (`getActorContext`,
  then the batched provenance + roster read) to the publish response. The neighbouring *clear* path
  parallelizes its equivalent pair, but there the roster fetch is at the call site; here it lives inside
  `logPublishedEvents`, so matching that shape would mean threading a promise through the helper's signature.
  Awaiting is what every existing writer in `match-event-log.ts` does, and one consistent seam beats two round
  trips — revisit only if publish latency is ever measured as a problem, not on principle.

⚠️ **What a row does and does not prove, going forward.** A *present* `published` row is now proof the match
was published, which is the half that did not exist before. A *missing* one is still not proof of the
opposite, and never will be for the 08/15 corpus: there is nothing to backfill from — no `published_at`, and
`queue_status_events` was empty for that session. The ambiguity is closed for matches published from this
merge onward and permanently open behind it. Do not let a later reader collapse that into "the ledger records
publishes" and then reason backwards over old data.

⚠️ **A match *born* published is deliberately not logged.** `create_match_with_players` takes
`p_is_published`, and it has exactly **two** callers: `match-lifecycle.ts` (a literal `true` — a manual
on-deck match) and `matchmaking-db.ts` (`p_is_published: autoPublish`). Read that second one carefully: the
flag `executeMatch` receives is `effectiveAutoPublish = autoPublish || (bypassGate && i === 0)`
([`matchmaking.ts:827`](src/app/actions/matchmaking.ts:827)), **not** the session's `auto_publish` — so
`callNextMatch`'s slot 0 is born published in a *draft-mode* session too, for the reason spelled out at that
assignment (promotion only considers `is_published=true`; without it the primary button composes a match it
can never seat — verified live 08/06). Neither caller is a draft→published transition: the row was never a
draft an organizer released, and the `created` event already carries the fact. Adding a `published` row there
would make the two kinds mean different things at different call sites, which is precisely the drift that
makes an audit ledger unreadable.

🪤 **This one paragraph shipped two different false claims, and the second survived the fix for the first.**
Round 1 of the review gate caught "*three* callers", listing `swap-player.ts` as a re-creation forwarding the
original's `is_published` — both halves wrong, since that file calls the unrelated `swap_player_in_match`,
which swaps a roster slot in place, only *reads* `p_is_published` to choose the incoming player's queue
status, and creates no match. Round 2 then caught the rewrite's own gloss of `matchmaking-db.ts` as
"auto_publish sessions", which the `effectiveAutoPublish` line above falsifies — and which the code documents
*twice*, in the file the sentence is about. Two lessons, both already in this repo's ledger and both re-earned
here: **enumerate with a grep before writing a count, and check the RPC name, not just the argument name** (a
shared parameter is not a shared writer); and **a correction inherits the burden of proof it is enforcing** —
rewriting a sentence to fix one unverified claim is the single likeliest place to author the next one.

Coverage: `PUB-EVT-1..14` in `tests/unit/published-event.test.ts` — one per site, plus the negatives
(`ALREADY_PUBLISHED`, all six refusal codes, a `published_count > 0` the re-read cannot confirm, a refused
auto-publish, a fallback UPDATE that flipped no row) and the two best-effort arms. They assert at the
**`record_match_event` RPC boundary**, not at the `logPublishedEvents` seam, because "the helper was called"
is exactly the assertion that would have passed throughout the years the ledger was empty.
**Negative-control verified**: `git stash`-ing the two action files turns 8 of the 19 cases red — every
positive one — while the negatives stay green, which is the correct signature.

🪤 That control **cannot validate a negative test**, and `PUB-EVT-14` is the case that shows it. Stashing
removes the writer altogether, so every "writes nothing" assertion is satisfied trivially and stays green —
including the one guarding the `.select("id")` gate, which is the whole point of that test. It is pinned
instead by a *targeted* mutation: ungating the fallback log (`if (true)`) reddens `PUB-EVT-14` alone,
18 passed / 1 failed. **Match the mutation to the assertion** — deleting a feature only proves the tests that
assert the feature happened.

🪤 Two neighbouring suites (`publish-engine-trigger`, `publish-held-guard`) needed their `_shared` mock
completed with `getActorContext` and `@/lib/match-event-log` stubbed. The stub is not convenience: several of
their cases assert an exact `svc.from()` **call count** to pin query ordering, and the audit issues its own
reads. Any future work that adds a query to a publish path will trip those counts the same way.

---

