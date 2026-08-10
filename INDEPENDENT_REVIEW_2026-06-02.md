# Independent Code Review — 2026-06-02

**Commits reviewed:** `f1c7bc8` → `e4e9fea` → `949f0de` → `5ea0b81` → `1349449` → `83ab665` → `83489dc` → `579aef7`

**Test status:** 454 passing, 1 skipped  
**TypeScript:** `tsc --noEmit` clean  
**Reviewer:** Kimi Code CLI (independent pass, no prior involvement in these commits)

---

## Executive Summary

Two major features landed since the last review:

1. **Draft Cap Override** (`f1c7bc8`) — Organizers can restrict auto-generated drafts to 1–5 (or Dynamic). Changing the cap triggers a two-phase reset: clear all unpublished drafts atomically, then regenerate against the new ceiling. A full-dashboard lockout overlay keeps co-organizers from interacting mid-flight.

2. **Live Match Player Swap** (`e4e9fea`) — Long-press any player on an active court to open a replacement picker. Three atomic swap modes (team swap, queue replacement, on-deck pull) with 3-second undo. Four new Postgres RPCs enforce row-level locking and recompute `is_mixed_level` after every write.

**Overall assessment:** Architecture is sound. Auth gates, atomic DB operations, broadcast sync, and test coverage are all present. Three new medium-severity issues were found (all fixable in <10 lines each). No critical security regressions.

---

## Findings

### 🔶 NEW-M1 — `setTimeout` leak in `active-courts.tsx` local banner

**File:** `src/components/organizer/active-courts.tsx`  
**Lines:** 147–150

```ts
function showToast(t: Toast) {
  setBanner(t);
  setTimeout(() => setBanner(null), TOAST_DISMISS_MS);
}
```

The timeout is never cleared if `ActiveCourts` unmounts before `TOAST_DISMISS_MS` (5 s). React will warn (strict mode) or silently leak a closure over a detached component.

**Fix:** Store the timer in a `useRef` and clear it in `useEffect` cleanup:

```ts
const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
function showToast(t: Toast) {
  if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  setBanner(t);
  bannerTimerRef.current = setTimeout(() => setBanner(null), TOAST_DISMISS_MS);
}
useEffect(() => () => { if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current); }, []);
```

**Severity:** Medium (quality / leak)  
**Effort:** 5 lines

---

### 🔶 NEW-M2 — Loading state not cleaned up when `toggleAutoMatchmaking` throws

**File:** `src/hooks/use-organizer-dashboard.ts`  
**Lines:** 219–248

```ts
const handleToggleAuto = useCallback(async () => {
  setTogglingAuto(true);
  setPendingAuto(!liveAutoMatchmaking);
  const result = await toggleAutoMatchmaking(sessionId); // ← if this throws…
  // …this line is never reached:
  setTogglingAuto(false);
  …
}, …);
```

Server actions are *supposed* to return `{ success, … }` rather than throw, but network-level failures (fetch abort, JSON parse error, Next.js internal error) can still reject. If that happens, `togglingAuto` stays `true` forever and the toggle button remains disabled with a spinner.

The same pattern exists in `handleCloseSession` (line 208) and `joinQueue` (line 250), but `handleCapChange` already uses `try/finally` correctly (line 265–300).

**Fix:** Wrap each async action body in `try/finally`:

```ts
const handleToggleAuto = useCallback(async () => {
  setTogglingAuto(true);
  setPendingAuto(!liveAutoMatchmaking);
  try {
    const result = await toggleAutoMatchmaking(sessionId);
    …
  } finally {
    setTogglingAuto(false);
  }
}, …);
```

**Severity:** Medium (UX deadlock on edge-case failure)  
**Effort:** 3 handlers × 3 lines each

---

### 🔶 NEW-M3 — `handleCloseSession` and `joinQueue` lack `try/finally` for loading states

**File:** `src/hooks/use-organizer-dashboard.ts`  
**Lines:** 208–217, 250–255

Same structural issue as NEW-M2. If `closeSession` or `joinQueueAction` throws:
- `closing` stays `true` → close-dialog action button stays disabled.
- `joiningQueue` stays `true` → join-queue button stays disabled.

**Fix:** Apply `try/finally` to both handlers.

**Severity:** Medium  
**Effort:** 6 lines

---

### 🔹 NEW-L1 — Stale auto-state read before cap update creates a race window

**File:** `src/app/actions/sessions.ts`  
**Lines:** 422–446

```ts
const { data: sessionRow } = await db
  .from("sessions")
  .select("is_auto_matchmaking_on")
  .eq("id", sessionId)
  .single();

// … update cap …

const autoIsOn = sessionRow?.is_auto_matchmaking_on ?? false;
if (!autoIsOn) { … }
```

The auto state is read **before** the cap is persisted. If a co-organizer toggles auto ON in the milliseconds between the SELECT and the decision to clear drafts, the current organizer will skip the clear phase and return `{ success: true, autoIsOn: false }` even though auto is now ON and stale drafts remain.

**Fix:** Flip the order — persist the cap first, then read the now-current auto state:

```ts
await db.from("sessions").update({ max_auto_drafts_override: cap }).eq("id", sessionId);
const { data: sessionRow } = await db
  .from("sessions")
  .select("is_auto_matchmaking_on")
  .eq("id", sessionId)
  .single();
```

**Severity:** Low (narrow race, recoverable by toggling auto off/on)  
**Effort:** 2 lines

---

### 🔹 NEW-L2 — Semantically imprecise broadcast event type for live swaps

**File:** `src/app/actions/live-match-swap.ts`  
**Lines:** 152, 216, 313

All three swap actions broadcast `organizer_intervention` with type `"on_deck_cleared"`. This type was originally designed for "an on-deck match was cleared and you were returned to the queue". It is semantically wrong for:
- **Team swap** — nobody left any match; teams were rearranged.
- **Queue replacement** — the incoming player was in the *waiting queue*, not on-deck.

Clients currently treat `on_deck_cleared` as a generic "organizer changed your match status" toast, so the UI behaves correctly. If a future client refactor branches on the type, this will silently misclassify the event.

**Fix:** Add two new event types to `OrganizerInterventionType`:

```ts
export type OrganizerInterventionType =
  | "on_deck_cleared"
  | "match_cancelled"
  | "player_swapped_in"
  | "teams_swapped";
```

**Severity:** Low (correctness / tech debt)  
**Effort:** 4 lines + 2 in `broadcast.ts`

---

### 🔹 NEW-L3 — Redundant type cast in `live-swap-sheet.tsx`

**File:** `src/components/organizer/live-swap-sheet.tsx`  
**Lines:** 360–361

```ts
const mins = Math.round(
  (c as typeof c & { waitMinutes?: number }).waitMinutes ?? 0
);
```

The `queueCandidates` `useMemo` already returns objects that include `waitMinutes` (line 226–232). The cast is unnecessary.

**Fix:** Remove the cast:

```ts
const mins = Math.round(c.waitMinutes ?? 0);
```

**Severity:** Low (code clarity)  
**Effort:** 1 line

---

## Prior Active Issues — Status Check

| ID | Issue | Status in latest commits |
|---|---|---|
| M-002 | Magic status strings (`"waiting"`, `"on_deck"`, etc.) | **Still 186+ occurrences.** No change. |
| M-003 | Console spam in production paths | **Partially fixed.** 4 more client-side `console.log` removed in `949f0de`. Server-side logs in `matchmaking.ts` intentionally retained for Vercel debugging. |
| M-004 | Missing `useMemo` / `useCallback` | **Partially fixed.** `bottleneckCount`/`waitingCount` memoized in `organizer-dashboard.tsx`. `activePlayerIds` memoized in `active-courts.tsx`. Heavy components (`queue-control.tsx`, `active-courts.tsx`) still derive lists inline without memo. |
| M-006 | Circular ref workaround in `useOrganizerData` | **Unchanged.** `fetchQueueRef` no-op init + `onProfilesLoaded` forward-reference still present. Harmless but noted. |
| L-002 | Hardcoded toast durations | **Fixed in `949f0de`.** All 4000ms values replaced with `TOAST_DISMISS_MS`. |

---

## Positive Observations

### Security
- Every new server action (`setCapAndClearDrafts`, all four live-swap actions) follows the three-gate pattern: UUID validation → `getAuthenticatedUser()` → `isSessionOrganizer()`.
- `live-match-swap.ts` uses `createServiceClient()` (server-only) and never touches the user-context client. Good.
- `undoLiveSwap` re-validates organizer status for every undo type, including the `team_swap` path that looks up `session_id` from the match row.

### Database correctness
- Four new RPCs (`swap_player_in_active_match`, `swap_teams_in_active_match`, `swap_active_from_ondeck`, `undo_swap_active_from_ondeck`) all use `FOR UPDATE` row locks.
- `swap_active_from_ondeck` locks both matches in deterministic ID order → deadlock-safe.
- `clear_all_unpublished_drafts` locks draft matches first, then collects player IDs, then updates queue status, then deletes — all in one transaction.
- `is_mixed_level` is recomputed after every swap write, and `origin` is flipped `auto → modified`.

### Real-time sync
- `draft_cap_phase` broadcast (`clearing` / `generating` / `done`) keeps co-organizer dashboards in sync during cap resets.
- `useOrganizerSession` correctly maps `phase === "done"` to `null` so the lockout overlay dismisses.
- `handleCapChange` always emits `"done"` in the failure path (line 276) so screens never stay locked.

### Performance
- `after(() => runEngineForSession())` in `queue.ts` eliminates the main perceived latency on the Join Queue button — the HTTP response returns before matchmaking runs.
- `getDynamicDraftCap` is now a shared pure function consumed by both the engine and the UI (`on-deck-panel.tsx`), eliminating the duplicated tiered ternary.

### Test coverage
- `1349449` + `83ab665` add 1090+ lines of tests: unit tests for cap validation, chip labels, phase state machine, edit-PIN UI, and integration tests for all four swap RPCs plus schema parity.
- All 454 tests pass, 1 skipped.

---

## Recommended Next Steps

1. **Fix NEW-M1** (`active-courts.tsx` setTimeout leak) — 5 lines, zero risk.
2. **Fix NEW-M2 + NEW-M3** (`try/finally` for loading states) — 9 lines, prevents UI deadlock on network errors.
3. **Fix NEW-L1** (stale auto-state read) — 2 lines, eliminates race.
4. **Fix NEW-L2** (broadcast type semantics) — 6 lines, prevents future client-side misclassification.
5. **Fix NEW-L3** (redundant cast) — 1 line.
6. **Continue M-002** (magic strings) — consider a `QUEUE_STATUS` enum map; no rush.

Total estimated effort: **~25 lines across 4 files**.
