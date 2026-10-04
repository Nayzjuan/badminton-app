# Plan: Organizer mutation resilience (slow net / disconnects)

## Goal

Courtside organizer mutations must never trap the board in Adding… / Saving… / Clearing… with no escape. A slow or dropped connection must leave the organizer able to dismiss, see an honest status, and keep working. Drafts must remain visible and actionable when the organizer is on Queue.

This is a UI + request-path change. No schema. No new RPC.

## Review status

Independent review ([Review](495d9f56-0e64-4173-82b1-55efa0d5b859)): **do not implement as first drafted.** All BLOCKER and MINOR findings are folded in below. First-draft mistakes that must not be reintroduced:

- `scheduleEngineForSession` is **`export async function`** on `matchmaking.ts` only. Never a sync `void`. Never `_shared` (creates a cycle; fails US-2).
- Wave B required test updates are **named**: XC-1 drain; TAP-1 + `publish-engine-trigger` + `publish-held-guard` mocks.
- Wave C uses **two counts**: `visibleCount` vs `clearableCount`. Confirm N is clearable only.
- After watchdog timeout, **keep the control disabled** until a live refetch shows the write (addCourt / toggle are not idempotent). `withTimeout` is not a cancel.
- D8 is amended for **both** ON flips; auto-publish toast must not imply the deck is already full.
- Queue “Creating…” / live-swap pending are the same chrome class but **out of this ship** (they do not await the engine).

## The one-line truth

Queue joins already return before `runEngineForSession` (`after()` in `queue.ts`). Courtside actions still **await** the engine, so gym Wi‑Fi turns a finished score/clear into a hung spinner. Close-session already has `withTimeout`. Courtside never got either treatment.

## Symptoms this plan covers

| Symptom | Root |
|---|---|
| Add court → Adding… forever, or nothing | No `try/finally`; `result.error` unused; success awaits `fetchCourts()` |
| End match → Saving…; Cancel disabled; refresh required | `endMatchAction` awaits promote + engine + client refetch; ScoreModal disables Cancel |
| Clear draft → Clearing…; drafts still there after Queue tab | `clearOnDeckMatch` awaits engine; Auto ON refills; Courts tab unmount drops local busy/toast |
| Auto OFF, clear some, switch to Queue, drafts remain | Auto OFF does not clear drafts (D4, by design); one-by-one clears are slow; badge is easy to miss |
| One hung tap freezes later mutations until refresh | Next.js server-action queue is FIFO per tab |

## Locked decisions

| # | Decision | Choice | Rejected |
|---|---|---|---|
| R1 | Where the engine runs after a **successful write whose return value does not include new drafts** | `await scheduleEngineForSession(id)` which only schedules `after(() => runEngineForSession(id).catch(log))` | Keep `await runEngineForSession` (this is the hang). Return *before* promote (empty-court flash) |
| R2 | Promote on end / cancel / successful call-next | **Stay on the request path** — court fill is the organizer-visible guarantee | Promote in `after()` |
| R3 | `callNextMatch` empty-deck + Auto ON path | **Keep `await runEngineInternal` then retry promote** — return value *is* the new match | `after()` here would make Call Next lie |
| R4 | `applyDraftCapOverride` `done` emit + inline engine | **No change** | Move `done` or cap engine into `after()` |
| R5 | `recomputeHeldReadiness` | **Stay awaited, before promote.** Best-effort, no retry | `after()` it |
| R6 | Client watchdog | Unlock **chrome that is safe to unlock**. For **non-idempotent** controls (add court, Auto flip): stay disabled until a live refetch shows outcome. Never auto-retry. Toast: may have succeeded — do not tap again | Auto-retry. Treat `withTimeout` as cancel. Re-enable Add/toggle at 12s while the POST is still in FIFO |
| R7 | Watchdog budget | `COURTSIDE_ACTION_WATCHDOG_MS = 12_000`. Soft copy at 5s | Bound the server insert/score RPC |
| R8 | ScoreModal while pending | **Cancel/dismiss stays enabled.** In-flight `endMatch` is not aborted. Dismiss + success → realtime / idle closer | Keep Cancel disabled |
| R9 | Busy state lifetime | Own add/clear/publish/end/call-next/cancel/toggle keys in `useOrganizerDashboard` (survives tab unmount) | Leave Sets inside `OnDeckPanel` / `ActiveCourts` |
| R10 | Clear remaining drafts | **Clear unpublished drafts** → existing `clearAllUnpublishedDrafts` (skips held). Confirm uses **clearable** N. Auto ON refill via `scheduleEngineForSession` in a thin wrapper, not inside the inner function | Per-card only. Clear held too |
| R11 | Draft visibility off Courts | Persistent strip when `visibleCount > 0 && activeTab !== "courts"`. Clear button only if `clearableCount > 0`. Held-only copy: “N held draft(s) waiting on a live court” | One N for both visibility and confirm |
| R12 | Offline / sync | `navigator.onLine === false` → do not fire, toast “You’re offline”. Sync-offline ≠ timeout copy | One banner for both |
| R13 | Add court success path | Unlock Adding… only when the action **result** arrives. On timeout: keep disabled, refetch courts, unlock only when the new court is present **or** refetch shows it is not (then toast failure). Do not hold the button on a successful refetch | Optimistic insert. Re-enable at 12s blindly |
| R14 | D8 (auto-publish “fills immediately”) | Amended for **both** ON flips (`toggleAutoMatchmaking` ON and `toggleAutoPublish` ON): persist + clear stay on the request path; engine is scheduled via `after()`. Change the auto-publish ON toast so it does not read as “deck is already full” (match the auto-mm “will appear” wording). TAP-1 asserts `scheduleEngineForSession` was called, not that the engine finished in-process | Keep awaiting engine on toggle ON |

## Honest limit

A client `withTimeout` **abandons the result, it does not cancel the POST**. Next’s action queue stays FIFO. Wave A unsticks chrome. Wave B (faster return) is what stops most gym-Wi‑Fi hangs. A TCP stall that never returns still needs a refresh to free the queue — the watchdog copy must say so. Browser Supabase refetches still work while a server action is in flight; a second `endMatchAction` / `addCourtAction` does not.

## Out of scope

- `applyDraftCapOverride` lock / `done` emit (R4)
- Retrying `recomputeHeldReadiness`
- Replacing server actions with route handlers
- Player `ScoreInputCard` redesign (share the helper if cheap)
- Queue **Create match** “Creating…” / `AlertDialogCancel disabled={creating}` and live-swap `isSubmitting` — same trapped-button class on a slow POST, but they do **not** await the engine. Later pass.
- PWA `/offline` page
- New tables, RPCs, or migrations
- Rotating the leaked `service_role` key

## Wave A — stop trapping the organizer (UI only)

### A1. Shared client helper

New: `src/lib/courtside-action.ts`

```
runCourtsideAction(promise, { timeoutMs, onSlow }): Promise<
  { status: "ok"; value } | { status: "error"; error } | { status: "timeout" }
>
```

- Wraps `withTimeout`
- `try/catch` → `{ status: "error" }`
- `onSlow` at 5s
- Does **not** retry
- Unit-test ok / error / timeout / slow callback. Fake timers.

### A2. Wrap courtside mutation sites

| Site | Change |
|---|---|
| `active-courts.tsx` `handleAddCourt` | `try/finally` + toast on `error`. Timeout → toast “may have added — do not tap again”; keep disabled until `fetchCourts` shows the name or proves it missing |
| cancel / clear / status / remove / call-next | timeout + toast; these are closer to idempotent (second clear = not pending) — unlock on timeout after refetch |
| Score submit | timeout → keep modal closable; refetch; settled/idle closer already handles a completed match |
| `on-deck-panel` clear / publish / publish-all | timeout + toast; **revert optimistic publish** on timeout (same as error) |
| `handleToggleAuto` / `handleToggleAutoPublish` | timeout → clear optimistic from **live** session, keep toggle disabled until live value is known, toast do-not-tap-again. **Do not retry** (flip is not idempotent) |
| `use-organizer-courts.ts` | Return `{ error }` without `await fetchCourts()` on the success path (R13). Caller refetches. Realtime still paints |
| `useAction` | `try/catch` → `{ error }`. Timeout stays at chrome layer |

### A3. ScoreModal dismiss

- Cancel not `disabled={isPending}`. Overlay / Escape still close.
- Submit stays disabled while pending (`useScoreForm` latch stays).
- Pending copy: “Saving… you can close this.”

### A4. Tests (Wave A)

- Unit: `runCourtsideAction` ok / throw / timeout / slow.
- Unit: ScoreModal Cancel enabled while pending.
- Unit: add-court toasts `result.error`.
- Existing score-form double-submit latch stays green.

## Wave B — don’t wait on the engine (request path)

### Helper (US-2)

In `src/app/actions/matchmaking.ts` **only**:

```
export async function scheduleEngineForSession(sessionId: string): Promise<void> {
  after(() =>
    runEngineForSession(sessionId).catch((err) =>
      console.error("[engine] after() unhandled failure:", err)
    )
  );
}
```

Call sites `await scheduleEngineForSession(id)` so the export is a legal server-action shape and the caller’s promise settles as soon as `after()` has queued the work. Do not put this in `_shared`.

### B1. Move these `await runEngineForSession` → `await scheduleEngineForSession`

| File | Symbol |
|---|---|
| `match-lifecycle.ts` | `endMatchInternal` (after promote / free-court) |
| `match-lifecycle.ts` | `cancelMatchAction` (after promote) |
| `match-drafts.ts` | `clearOnDeckMatch` |
| `match-drafts.ts` | `publishMatchAction` SUCCESS |
| `match-drafts.ts` | `publishMatchFallback` |
| `match-drafts.ts` | `publishAllDraftMatchesAction` + fallback (`publishedCount > 0`) |
| `sessions.ts` | `toggleAutoMatchmaking` when ON |
| `sessions.ts` | `toggleAutoPublish` ON after successful clear |
| `matchmaking.ts` | `callNextMatch` **successful promote refill only** |

### B2. Do **not** move

| Site | Why |
|---|---|
| `callNextMatch` empty-deck generate-then-promote (`runEngineInternal`) | R3 |
| `applyDraftCapOverride` engine + `done` | R4 |
| `recomputeHeldReadiness` | R5 |
| `queue.ts` | Already `after()` |

### B3. Required test updates (not “grep later”)

`after()` stub **invokes but does not await**. Tests that assert “action returned ⇒ engine write exists” must `await flushAfterCallbacks()` before the SELECT.

**Required drains**

- `tests/integration/engine-trigger-realdb.test.ts` — ET-1, ET-2; drain ET-3 anyway
- `tests/integration/cross-court-realdb.test.ts` — **XC-1** (held draft is created by the engine, not by `recomputeHeldReadiness`). XC-2/XC-4 stay on readiness/publish writes; drain XC-1 only is required for the new-row assert

**Required mock updates** (these `vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }))` and will throw `scheduleEngineForSession` undefined / `after()` outside request scope):

- `tests/unit/publish-engine-trigger.test.ts` — spy `scheduleEngineForSession`; PE-1/PE-4/PE-6 expect it; PE-2/PE-3/PE-5 expect it not called
- `tests/unit/publish-held-guard.test.ts` — same
- `tests/unit/auto-publish-session-action.test.ts` — TAP-1 expects `scheduleEngineForSession`; D8 wording in comments = scheduled, not in-process finish. Stub `after()` only if the action still calls it directly

`published-event.test.ts` uses `importOriginal` + stub — leave unless it breaks.

Update `tests/integration/setup.ts` comment: courtside refill now matches `queue.ts`; Auto ON + `endMatchAction` races unless drained.

### B4. Manifest

§3.5 engine-trigger table: **split** the `callNextMatch` row.

- After a successful promote: `scheduleEngineForSession` → `runEngineForSession` via `after()` (toggle-gated).
- Empty deck + Auto ON: still `await runEngineInternal` (bypasses toggle check) then retry promote (R3).

Other B1 rows: still “triggers engine”, add “does not block the action return.” Do not invent site counts. Do not append `after()` onto the existing “Calls `runEngineInternal`” sentence.

## Wave C — drafts across tabs

### Counts (do not collapse)

```
visibleCount    = draftMatches.length                    // includes held; drives strip + badge
clearableCount  = drafts that are unpublished && !held  // drives Clear button + confirm N
```

Never use `clearAllUnpublishedDrafts.clearedCount` (that is **player** ids) as N.

### C1. Lift busy sets

Dashboard-owned: `addingCourt`, `clearingMatchIds`, `publishingMatchIds`, `publishingAll`. Pass into `OnDeckPanel` / `ActiveCourts`.

ScoreModal unmounts when leaving Courts. That is fine: the write is on the server; R8 + idle closer + realtime cover dismiss / tab-away.

### C2. Sticky draft strip

Above the tabpanel. Visible iff `visibleCount > 0 && activeTab !== "courts" && !isClosed`.

- Always: “N draft(s) — review on Courts” (`N = visibleCount`) + Review
- If `clearableCount > 0`: Clear unpublished (confirm uses `clearableCount`)
- If `clearableCount === 0`: no Clear; “N held draft(s) waiting on a live court”

Existing 0→n toast + amber Courts badge stay (`draftCount` / `visibleCount`).

### C3. Clear unpublished drafts

- Confirm: “Clear {clearableCount} unpublished draft(s)? Players return to the queue. Held drafts stay.”
- Thin `export async function clearUnpublishedDraftsAction(sessionId)` in `match-drafts.ts`: calls `clearAllUnpublishedDrafts`, then `await scheduleEngineForSession` only if the session’s auto-matchmaking is ON. **`clearAllUnpublishedDrafts` stays engine-free** (`applyDraftCapOverride` keeps its own awaited engine).
- Tests: seed the hold via `create_held_cross_court_match` (not a hand-set `is_held` / `held_ready_at`). Auto OFF → unpublished gone, held row remains, `scheduleEngineForSession` not called (or engine no-ops). Auto ON → `flushAfterCallbacks` then refill allowed.

### C4. Tests (Wave C)

- Strip on Queue when `visibleCount > 0`; hidden on Courts; hidden at 0.
- Confirm N = `clearableCount` when mixed held + clearable.
- Busy flag survives tab switch (RTL).

## Wave D — diagnose connectivity

- `online` from `window` `online`/`offline`; initial `navigator.onLine`.
- Offline → do not fire courtside mutations; toast “You’re offline.” Do not set busy.
- Copy:
  - Realtime drop: “Sync offline” (unchanged)
  - 5s: “Still working — slow connection”
  - 12s: “This may have saved. Do not tap again. Refresh if it stays stuck.”
- Dim mutation buttons when `navigator.onLine === false` only — not when merely sync-offline.

## Implementation order

1. Wave A helper + add-court + ScoreModal dismiss
2. Wave A remaining handlers + `useAction` try/catch
3. Wave B helper + B1 sites + **named** test/mocks (ET, XC-1, PE, TAP, held-guard)
4. Wave C lift + strip + clear unpublished (held via real RPC)
5. Wave D
6. Validation: `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`. Integration ET + XC if those files changed.
7. Code review gate after executable code lands.

Do not ship Wave B without ET + XC-1 drains and the three unit-mock updates. Do not ship Wave C Clear without the held-skip test seeded via `create_held_cross_court_match`.

## File map (expected)

| File | Waves |
|---|---|
| `src/lib/courtside-action.ts` | A |
| `src/app/actions/matchmaking.ts` | B |
| `src/app/actions/match-lifecycle.ts` | B |
| `src/app/actions/match-drafts.ts` | B, C |
| `src/app/actions/sessions.ts` | B (toggles + auto-publish toast) |
| `src/hooks/use-organizer-dashboard.ts` | A, C, D |
| `src/hooks/use-organizer-courts.ts` | A |
| `src/hooks/use-organizer-matches.ts` | A |
| `src/hooks/use-organizer-queue.ts` | A |
| `src/components/organizer/active-courts.tsx` | A, C |
| `src/components/organizer/score-modal.tsx` | A |
| `src/components/organizer/on-deck-panel.tsx` | A, C |
| `src/components/organizer/organizer-dashboard.tsx` | C, D |
| `tests/unit/courtside-action.test.ts` | A |
| `tests/unit/publish-engine-trigger.test.ts` | B |
| `tests/unit/publish-held-guard.test.ts` | B |
| `tests/unit/auto-publish-session-action.test.ts` | B |
| `tests/integration/engine-trigger-realdb.test.ts` | B |
| `tests/integration/cross-court-realdb.test.ts` | B (XC-1) |
| `APP_MANIFEST.md` §3.3 / §3.5 | B, C |
| `MEMORY.md` | in-flight pointer |

No `*.sql`.

## Risks

1. **`after()` + Vercel freeze** — already accepted on `queue.ts`. Next event re-runs the engine. No retry loop.
2. **XC-1 / ET flake** — forgot `flushAfterCallbacks`. Wave B blocker.
3. **Toggle / addCourt + timeout + second tap** — stay disabled until live refetch (R6/R13).
4. **Double engine** — `clearUnpublishedDraftsAction` schedules; `applyDraftCapOverride` still calls the inner function and awaits the engine itself.
5. **Held vs clearable N** — confirm uses `clearableCount` only; `clearedCount` is player ids.

## Last updated

2026-10-04 — revised after independent review. Ready to implement.
