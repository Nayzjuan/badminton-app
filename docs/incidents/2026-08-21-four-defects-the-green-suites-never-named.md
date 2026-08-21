# 3.45 Four defects the green suites never named (2026-08-21)

> A **dated incident write-up**, extracted from the branch that fixed it. Present-tense
> behaviour lives in `APP_MANIFEST.md`; this file records what was wrong and how it was found.

**Files:** `src/hooks/use-organizer-alerts.ts`, `src/hooks/use-edit-match.ts`,
`src/hooks/use-session-completed-players.ts`, `src/hooks/use-session-data.ts`,
`src/lib/organizer-alerts.ts` (`prunePauseSeen` docstring only).

## How they were found

Not by review and not by coverage. Every suite involved was already green, and three of the
four files were already at 100% line coverage. They were found by running the audit question
over the *source* instead of the tests — *if this line were deleted, would anything go red?* —
and then applying the deletion. A line no mutation can redden is not covered; it is merely
executed.

## 1. Pause reminders were unreachable in production

`useOrganizerAlerts` marked a due pause bucket as seen **during the render phase**:

```
const prunedSeen = prunePauseSeen(seenPause, queue);
const duePause = collectDuePauseAlerts(queue, nowMs, prunedSeen);
if (duePause.length > 0 || prunedSeen !== seenPause) { setSeenPause(nextSeen); }   // ← render phase
```

A `setState` called during render makes React discard the pass and re-render before commit.
On that second pass every due bucket is already in `seenPause`, so `collectDuePauseAlerts`
returns `[]` — and the empty list is the one that gets **committed**, so the effect that
writes the notice returns at its own length guard. `recordPauseReminder` was never reached:
an organizer was never told a player had been paused past the threshold.

`seenPause` is now a **ref**, and the whole pipeline — prune, due-list, mark, write — lives
in a single effect. Deriving the due list during render is what forced the marking to happen
during render, so moving the derivation is what actually removes the hazard; making the
marking a ref write removes the lint-level one (`react-hooks/set-state-in-effect`) that an
intermediate "mark it in an effect instead" fix runs straight into. `knownPauseKeys` remains
what makes the *write* exactly-once; `seenPause` only stops a bucket being re-offered.

Restoring the render-phase version verbatim reddens `OAL-25`, `OAL-27`, `OAL-28` and
`OAL-30`. Nothing rendered was ever derived from the due list, which is why a whole suite of
card-rendering assertions stayed green while the durable half of the feature did nothing.

## 2. A rejected server action wedged the Edit Match dialog

`handleSaveScore` and `handleRevert` awaited `updateMatchDetails` / `resolveScoreCorrection`
inside `startTransition` with no `try`/`catch`. A **rejection** — a dropped connection, a 500
from the action endpoint, the `"use server"` module-evaluation `ReferenceError` this repo
shipped for four days — unwinds past every `setState` and out of the transition scope.
`isPending` stays true for the life of the dialog. `EditMatchDialog` binds it to `disabled` on
both score inputs and both buttons and renders `"Saving…"` / `"Reverting…"` from it, so the
organizer gets a frozen dialog with a spinner label and no message, indistinguishable from a
slow network and unrecoverable without a reopen.

All three call sites now synthesize the repo's standard refusal, mirroring `use-fix-record.ts`.
Every other negative in the suite handed the hook a well-formed `{ success: false }`, which is
a different code path — that is why 27 tests missed it.

## 3. `use-session-completed-players` had no sequence guard

`fetchPlayers` awaits three sequential round-trips and takes `excludeMatchId` as a dep, so two
runs can be in flight and the one that started first can finish last, committing the previous
match's candidate list over the one being corrected (CLAUDE.md guardrail 2). Today's only
caller keys `<FixRecordSheet>` by `match.id`, which keeps `excludeMatchId` stable for the life
of a mounted instance — so this was **latent, not live**. The `fetchSeq` ref is there so the
next caller does not have to rediscover it.

## 4. `use-session-data` re-checked no sequence after its second await

Both `fetchCourts` and `fetchWaitlist` await `hasAuthSession` *after* their main query, inside
the empty-result branch. A newer run can start and finish while an older one sits in that
probe. Each now re-checks its sequence after the probe as well as after the query.

## The doc claim this corrects

An earlier revision of `APP_MANIFEST.md` recorded the `loading` flag in
`use-session-completed-players` as "over-determined by two sites, so the single-site mutation
is unkillable". That was wrong. `useState(true)` and the `setLoading(true)` at the head of
`fetchPlayers` are two independent properties — the seed on first mount, and the re-arm on
every re-fetch — and each is killed on its own now. The trap that produced the false claim:
React commits the first render before running effects, so reading `result.current.loading`
after `renderHook` observes the effect's write, not the `useState` seed. Only a per-render
recorder (`seen[0]`) can see the seed.
