# 3.40 Losing the score race gracefully, and un-breaking the repeat score edit (2026-08-15)

> Extracted from `APP_MANIFEST.md` §3.40 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `src/app/actions/_shared.ts`, `src/app/actions/match-lifecycle.ts`, `src/lib/constants.ts`,
`src/lib/settled-match-toast.ts` **(new)**,
`src/hooks/{use-edit-match,use-score-form,use-score-input,use-organizer-matches,use-organizer-data,use-match-history}.ts`,
`src/components/player/{score-input-card,player-dashboard}.tsx`,
`src/components/organizer/{edit-match-dialog,score-modal,active-courts,match-history-panel,queue-control}.tsx`,
`tests/unit/{edit-match-dialog-repeat,score-race-transition,queue-control-duplicate-confirm}.test.tsx`,
`tests/unit/{duplicate-roster-confirm,settled-match-toast,end-match-cas-code}.test.ts`, and mock/assertion updates in
`tests/unit/{match-origin-tracking,use-score-form,use-match-history,queue-control-repeat-pairing}.test.*`
+ `tests/integration/score-submission.test.ts`. **TypeScript only — no migration.**

Reported as two defects: *"2 scores for the same match … caused by the organizer and the player inputting
the scores"*, and *"when one match is edited, they couldn't be edited or fixed again"*.

⚠️ **The reported cause of the first one is not what the data shows, and the distinction changes what the
fix is worth.** The duplicate in the 2026-08-15 session is **two `matches` rows**, not two scores on one row:

| | `0dfedb8a…` | `88168066…` |
|---|---|---|
| court | Court 9 | Court **12** |
| created → completed | 05:22:42 → 05:31:20 (**8m 38s**) | 05:33:11 → 05:33:39 (**19s**) |
| score | 30–31 | 31–25, edited to 31–15 at 05:37:45 |
| `created_method` / `created` actor | manual / **Miggy** | manual / **Miggy** |

Same four players (Leo + Arvin vs Von + Michelle), both rows created by the **organizer**, ten minutes
apart, on different courts. No player was involved in creating either. A 19-second match is not a match
that was played — it is a row created *after the fact* to record a result, which is an established
workflow here, not an anomaly: **48 completed matches** across the database have a sub-minute
`completed_at - started_at` (5 of today's 55, 43 of the earlier 896).

So the compare-and-swap in `endMatchInternal` was never the thing that failed. It already prevents two
scores landing on one row (`.eq("status","in_progress")` on the UPDATE plus a `.select("id")` row count),
and nothing in the ledger contradicts it. **What was broken was everything that happens after the CAS
refuses.** That is worth fixing on its own terms — a race between an organizer and four players all
reaching for the score of a game that just ended is real and routine — but it should not be recorded as
the fix for what happened on 2026-08-15.

**The loser of the race had nowhere to go.** `submitMatchScore` returned `{success:false, message:"Match is
already completed."}`, the player's card painted it red next to a live "Submit Final Score" button, and
every retry hit the same wall. The organizer's side was worse than cosmetic: `useOrganizerMatches.endMatch`
returned `{error}` *without refetching*, so the board still showed an occupied court for a match that had
already moved to history — an invitation to record it a second way, which is precisely the shape of the
duplicate above.

**A `code`, because prose is not a branch condition.** `MatchActionResult` gains an optional
`code?: MatchActionCode` (`"already_scored" | "match_cancelled" | "not_completed"`). Only outcomes needing
something other than "render the text in red" carry one; every existing consumer that ignores `code` keeps
its exact previous behaviour, which is why the field is optional rather than a new required discriminant.
`endMatchInternal` tags **both** places the race surfaces — the pre-check on the fetched row *and* the
0-rows CAS branch below it, which is the true concurrency window (the pre-check passed, then the other
caller's UPDATE landed first).

🪤 **And both places have to DISCRIMINATE, not just tag.** The pre-check always did
(`match.status === "completed" ? "already_scored" : "match_cancelled"`); the CAS branch first shipped
hardcoding `already_scored`, so a concurrent *cancel* in that window produced *"the score they entered
was kept"* for a match that has no score and must be re-run. That is precisely the sentence
`settledMatchToast` was extracted to prevent — and `settled-match-toast.test.ts` was green throughout,
because the pure function was never the thing that was wrong. **A correct mapping tested in isolation
proves nothing about the caller that chooses its input.** The branch now re-reads `status`. Only
`"cancelled"` takes the cancel arm; the cancel copy states that no score was recorded, an organizer
reading that re-runs the game, and re-running one that was in fact scored is how a second row for the same
match gets created — the defect at the top of this section. So everything else falls back to
`already_scored`: a read error, a deleted row, and `"pending"` — a fourth status that passes the pre-check
(which rejects only `completed`/`cancelled`) and then misses the CAS. `pending` is not reachable from
either UI today and its copy would be wrong if it were; it lands on the arm that does not invent a re-run.

**`useScoreForm` now has three outcomes, not two.** `{}` is a win, `{error}` is an actionable failure that
keeps the form armed, and `{settled}` is "someone else scored it" — terminal, like a success. `settled` is
checked **before** `error` so a handler that fills in both still lands on the terminal state. The player
card renders `settled` in neutral slate with an `Info` icon rather than red, and drops the form entirely;
the organizer's `ScoreModal` closes and raises the toast `settledMatchToast` picks for the code —
`Already Scored` or `Match Cancelled`, never one shared string, which is the distinction this whole
section turns on — and `endMatch` now refetches **on the failure path too** so the board is correct
before the modal disappears.

🪤 **`ScoreModal` was silently discarding the field.** It wrapped its `onSubmit` prop in
`async (a,b) => ({ error: (await onSubmit(a,b)).error })` — a lambda that re-wraps the result and keeps only
`error`. Threading `settled` from the action to `active-courts.tsx` and never touching that lambda would
have type-checked and done nothing. It is now `useScoreForm(onSubmit)` and the prop is typed
`Promise<ScoreSubmitOutcome>`. **A projection lambda in the middle of a chain is a silent filter; widening a
return type does not widen the code that narrowed it.**

**The score edit is no longer a one-shot — and the auto-close was the reason it was.** Both paths of
`useEditMatch` used to end with a detached `setTimeout(() => setOpen(false), DIALOG_CLOSE_DELAY_MS)`:
untracked, never cleared, bypassing `handleOpenChange`. Two consequences, one cause:

- It fired against whatever the dialog had become — a reopened dialog, or an unmounted one.
- `isError` was never reset on reopen, so a stale red could colour the next open's first message.

🪤 **A third consequence was hypothesised and then disproven, and the disproof is worth keeping.** The
appealing story was that closing a Radix modal from a *timer* rather than a dismissal gesture strands
`document.body.style.pointerEvents: none`, which would make **every** control on the page unclickable and
would match the report's plural — *"they couldn't be edited"* — far better than a per-card failure does. It
does not happen. `DismissableLayer` restores the style in an **unmount cleanup**
(`@radix-ui/react-dismissable-layer`, the `disableOutsidePointerEvents` effect), and a timer-driven close
unmounts the layer exactly like a gesture-driven one, running the same cleanup. Nothing about the trigger is
special. An earlier draft of this section carried the hypothesis as a finding and described a
`useReleaseStrandedBodyLock` escape hatch in `dialog.tsx`; **no such hook exists and `dialog.tsx` is
unchanged by this work** — the story survived into prose because it explained the symptom so neatly.

A score edit now **does not close the dialog at all**. Correcting a score is inherently repeatable (fix the
digit, notice the teams are swapped, fix that too); the button becomes **"Save Again"**, a line of copy says
so, and a `DialogClose`-wrapped **"Done"** button gives a real dismissal gesture. The revert path still
auto-closes — it moves the match back to a court, so the history card hosting the dialog disappears anyway
— but its timer is held in a ref, cancelled on unmount and before every new action, and routed through
`handleOpenChange`.

⚠️ **Honest limit: the browser-level failure was never reproduced, and the root cause is unconfirmed.**
Three things are established. The **server** had no idempotency guard on the score-edit path — it was a
bare `.update({scores}).eq("id", matchId)` — so a second edit would have been accepted. The **ledger**
has no per-`event_type` uniqueness, so a repeat `score_edit` inserts cleanly. And **production proves both
empirically**: two matches have in fact received two `score_edit` events — `c516b3de…` 52 s apart on
2026-07-25, `d79d8ddb…` 101 min apart on 2026-07-30 — out of 17 matches that were edited at all.

**Repeat editing is therefore intermittent, not blocked.** That is the load-bearing finding: it rules out
every hard-block explanation (server guard, DB constraint, dead code path) and leaves only a
timing-dependent client fault, which is what the three changes above target. They are not a confirmed
root-cause fix, and this paragraph exists so the next reader does not upgrade them into one. The only
real test is a live session — watch whether any match receives a second `score_edit`.

**The edit path is now status-guarded, but deliberately not idempotency-guarded.** `updateMatchDetails`'s
score-only branch adds `.eq("status","completed")` + `.select("id")`. The Edit control only exists on a
completed history card, so 0 rows means a concurrent "Revert to Active Court" put the match back on a
court, and stamping a final score onto a live game would corrupt it silently; the organizer gets
`not_completed` and re-reads the board. It does **not** guard against repeating the same edit — that is the
behaviour being restored, and every pass appends its own `score_edit` event. The `revertToActive` branch is
untouched by this CAS.

**The duplicate-roster soft confirm on `createManualMatchAction` — the one change aimed at what actually
happened.** Everything above hardens the race; this is the part that addresses the 2026-08-15 rows. Before
creating a manual match, the action asks whether these same four already have a **completed** match in this
session inside the last `DUPLICATE_ROSTER_WINDOW_MINUTES` (30, in `constants.ts`). If they do, it returns
`{success:false, code:"duplicate_roster", message}` and the organizer is asked to confirm; re-sending with
`confirmDuplicate = true` skips the probe entirely and creates the match.

Three properties are deliberate and each one is load-bearing:

- **A confirm, not a block.** Rematches between the same four are ordinary badminton, and the 48 sub-minute
  rows show retroactive hand-entry is a workflow the organizer relies on. A hard rule would make a
  legitimate game unrecordable with no way through, which is worse than the duplicate it prevents.
- **Roster identity is the SET of participants, not the teams.** A rematch with the sides swapped is the
  same four people; comparing team-by-team would miss exactly the case an organizer is most likely to
  re-enter differently.
- **It is a distinct `code`, not an `error`.** A soft refusal that arrives as an error string gets rendered
  red by every existing caller, and red has no "yes, do it anyway" affordance. `code:"duplicate_roster"` is
  what lets `queue-control.tsx` open a confirm instead — and the client carries the exact roster from the
  refusal into the confirm rather than re-deriving it from the current selection, so the create that goes
  through is structurally the lineup the organizer was asked about.

The probe sits **behind** the organizer gate and runs only when `confirmDuplicate` is false, so a
non-organizer is refused before any match row is read (no `code` on that path — an auth failure must never
render a "Create anyway" button). Wording degrades by age: *just finished*, *1 minute ago*, *N minutes ago*.

**Tests.** `edit-match-dialog-repeat.test.tsx` (EM-1…EM-6, happy-dom + RTL) pins the new contract: the
dialog stays open after a save, a second save from the same open dialog **reaches the server**, close-and-
reopen still allows another edit, reopening re-seeds from refreshed props, a failed save stays open and
retryable, and a stale error does not bleed into the next open (asserted via the success message's
`text-emerald-600` class, not its text). `score-race-transition.test.tsx` (SR-1…SR-4) pins the player side:
`already_scored` and `match_cancelled` each resolve the card and **remove the submit button**, while an
ordinary failure still renders red and leaves the form armed — the control that stops SR-1/SR-2 passing for
the trivial reason that every failure hides the form.

`duplicate-roster-confirm.test.ts` (DRC-1…DRC-6, 16 cases) drives the server probe through a
table-addressed service mock: it fires on the same four with the teams swapped across the net, scans every
match in the window rather than only the newest, stays silent when just three of the four are shared and
when the session is empty, records the window bound it asks for, proves `confirmDuplicate` both creates
the refused match and skips the probe entirely (no `matches` read), and — DRC-6 — is unreachable by a
non-organizer, asserted by checking the `matches` table was never read rather than by trusting the message. `queue-control-duplicate-confirm.test.tsx`
(QDC-1…QDC-6, 10 cases) pins the client half: a `duplicateMessage` opens a prompt and an `error` never
does, Cancel keeps the selection so the organizer can correct it, and **QDC-4a changes the selection while
the prompt is open and asserts the re-send is unaffected** — the property that stops the confirm from
silently creating a different match than the one it described. `settled-match-toast.test.ts` (SMT-1…SMT-4)
holds `already_scored` and `match_cancelled` apart, since collapsing them tells an organizer their score
was kept when the match was in fact cancelled.

`end-match-cas-code.test.ts` (EMC-1…EMC-3) is the other half of that pair, and the reason the pair is
needed: SMT tests the mapping, EMC tests the **producer that picks which input the mapping gets**. It
drives `endMatchAction` to the 0-rows CAS branch (a queued `matches` mock answers the pre-check fetch with
an `in_progress` row, the UPDATE with `[]`, then the re-read with whatever the winner left) and asserts a
concurrent cancel yields `match_cancelled` with a message that never says *scored*, a concurrent complete
yields `already_scored`, and an unreadable status falls back to `already_scored`. EMC-1 also asserts the
`matches` table was read three times — without it the test passes on a branch that guessed the code from
the pre-check row instead of re-reading.

---

