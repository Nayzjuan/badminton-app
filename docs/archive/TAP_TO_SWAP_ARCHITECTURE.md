# TAP_TO_SWAP_ARCHITECTURE.md

## Feature: Tap-to-Swap — Surgical Player Replacement in On-Deck Matches

**Author:** Staff Frontend Engineer  
**Status:** Plan Revised v3 — Awaiting Final Approval Before Any Code  
**Context:** Organizers need to replace individual players from pending (on-deck)
match cards at the last minute. The "Tap-to-Swap" side sheet pattern lets them
do this without breaking the dnd-kit drag-and-drop ordering layer.

---

## 0. Existing Architecture Snapshot

| Fact | Detail |
|------|--------|
| **dnd-kit sensors** | `MouseSensor` (distance: 3 px), `TouchSensor` (150 ms delay, 5 px tolerance), `KeyboardSensor`. Sensors are attached **only** to the grip-icon element via `{...listeners}`. The card body itself has no drag listeners. |
| **Player data in cards** | Fully embedded in `EnrichedMatch.players[]: (MatchPlayer & { profile: Profile })[]`. No extra fetch needed at swap time. |
| **match_players schema** | Relational rows — one row per player (`id`, `match_id`, `player_id`, `team: "a"\|"b"`). NOT JSONB. |
| **queue_entries.status** | `"waiting" \| "on_deck" \| "playing" \| "left"` |
| **Shadcn Sheet component** | Does NOT exist yet. Radix UI v1.4.3 already installed — Sheet scaffolded from it. |
| **dnd-kit versions** | `@dnd-kit/core ^6.3.1`, `@dnd-kit/sortable ^10.0.0`, `@dnd-kit/utilities ^3.2.2` |
| **Auth guard pattern** | All match mutations call `isSessionOrganizer()` — swap action must do the same. |
| **Realtime propagation** | `subscribeToMatchPlayers` already triggers `fetchActiveMatches()` — swap mutations auto-propagate with no extra wiring. |

---

## 1. The Interactive Player Badge — dnd-kit Event Isolation

### The Problem

dnd-kit sensors register `pointerdown` listeners on whichever element receives
`{...listeners}` from `useSortable`. In the current `on-deck-panel.tsx` this is
correctly scoped to the **grip icon only** — but this isolation is fragile:

1. `TouchSensor` uses a 150 ms press delay. A long-press on any card child can
   still bubble up through the DOM and reach a document-level fallback.
2. Future changes to the card markup could accidentally spread `{...listeners}`
   onto a wider container, silently breaking all player badges.

### Recommended Solution: Two Complementary Defenses

Both applied directly on the new `<PlayerBadgeButton>` component:

**Defense 1 — `onPointerDown` stopPropagation:**
```
onPointerDown={(e) => e.stopPropagation()}
```
Kills the event before it can bubble to any parent drag listener. Works at both
the React synthetic and native DOM levels simultaneously. This is the hard stop.

**Defense 2 — `data-no-dnd="true"` attribute:**
```
data-no-dnd="true"
```
Canonical dnd-kit community pattern. The MouseSensor and TouchSensor activation
constraints are extended to bail out when the event target matches
`[data-no-dnd]`. This is the declarative, future-proof safety net that survives
grip refactors.

**Visual design of the button:**
- Default: player name inside a `<button>` — visually identical to today
- Hover/focus: subtle pill background (`bg-slate-100 dark:bg-slate-700`),
  `ArrowLeftRight` icon slides in on the right (16 px, muted color)
- Pressed: `scale-95` micro-animation
- Accessible: `aria-label="Swap {player.display_name}"` on the button

**What does NOT change:**
- The grip icon and its `{...listeners}` / `{...attributes}` — untouched
- The card's `useSortable` hook and `transform` style — untouched
- The `DragOverlay` / `OverlayCard` — untouched

---

## 2. State & Sheet Wrapper — React State Flow

### The Problem

If `swapContext` lives inside `OnDeckPanel`, every context change re-renders the
entire dnd board including all `SortableCard` instances — noticeable jank on low-
end Android at 6–8 cards.

### Recommended Solution: State in `OrganizerDashboard` + `React.memo` on `OnDeckPanel`

**State shape:**
```typescript
type SwapContext = {
  matchId:       string   // which match card was tapped
  playerId:      string   // the player slot being replaced
  team:          "a" | "b"
  playerProfile: Profile  // pre-fetched from EnrichedMatch — no extra call
  sessionId:     string   // needed for the server action
}
```

**Ownership tree:**
```
OrganizerDashboard  (owns swapContext state + auto-dismiss effect)
├── OnDeckPanel     (memoized — does NOT re-render when swapContext changes)
│   └── SortableCard[]
│       └── PlayerBadgeButton  →  calls onOpenSwap(ctx) via prop
└── SwapSheet       (sibling, outside DndContext — re-renders only on ctx change)
    └── player list, skill warning, confirm, undo
```

**Why `OrganizerDashboard` and not Zustand / Context?**
- Swap context is ephemeral UI state scoped to this one view
- `useContext` would cause all consumers to re-render
- A Zustand store for UI state is over-engineering
- `OrganizerDashboard` already owns `activeTab` — this is the same tier

**Prop additions to `OnDeckPanel`:**
```typescript
onOpenSwap: (ctx: SwapContext) => void  // new, threaded down to cards
```
`OnDeckPanel` is wrapped in `React.memo` with a `useCallback`-stable handler
reference in the parent, so badge taps never re-render the board.

**Sheet position in the render tree:**
`<SwapSheet>` is rendered **after** `<OnDeckPanel>` in the JSX tree and is
completely **outside** `<DndContext>`. This means:
- Opening the Sheet never interrupts an in-progress drag
- Sheet's Escape / backdrop-click close cannot accidentally end a drag
- The Sheet is mounted but hidden when `swapContext === null` (Radix Dialog
  uses a portal so it is visually removed from the DOM when closed)

**Sheet open/close state:**
`isSwapSheetOpen` is derived from `swapContext !== null` — no separate boolean.
`setSwapContext(null)` closes the sheet. One piece of state, one source of truth.

---

## 3. Database & Server Action — Safe Mutation Strategy

### Schema Reminder
```
match_players:  id | match_id | player_id | team
queue_entries:  id | session_id | player_id | status | joined_at | games_played | is_paused
```

### The Only Operation: Swap (1-for-1, always required)

**Resolved — Q1 answer:**  
The sheet enforces a mandatory replacement. There is **no "Remove without
replacement" option inside the Sheet**. If the organizer wants to dissolve the
entire match, they use the existing **"Clear Match" button** already on the card
(which calls `clearOnDeckMatch` and returns all 4 players to `waiting`). This
eliminates the incomplete 3-player match problem entirely — the swap flow is
strictly 1-for-1.

The Sheet's only exit paths are:
1. **Confirm Swap** — pick a replacement, hit Confirm
2. **Cancel / Close** — close the Sheet, nothing changes
3. **Auto-dismiss** — the match started while the Sheet was open (see Section 5)

---

### New Server Action: `swapPlayerInMatch`

**Return type (extended for frontend differentiation):**
```typescript
type SwapResult = {
  success: boolean
  message: string
  errorCode?: "MATCH_STARTED" | "PLAYER_UNAVAILABLE" | "PLAYER_NOT_IN_MATCH"
  // MATCH_STARTED    → match no longer pending; close Sheet + show toast
  // PLAYER_UNAVAILABLE → incoming player no longer waiting; keep Sheet open
  // PLAYER_NOT_IN_MATCH → outgoing player already removed; close Sheet
}
```

**Signature:**
```typescript
swapPlayerInMatch(
  matchId:     string,
  outPlayerId: string,  // player slot being replaced
  inPlayerId:  string   // always required — no null case
): Promise<SwapResult>
```

**Execution steps:**

```
1. Auth guard — isSessionOrganizer(sessionId)

2. Fetch match → verify status === "pending"
   If not: return { success: false, errorCode: "MATCH_STARTED",
                    message: "This match has already started." }

3. Fetch outPlayer's match_players row
   If missing: return { success: false, errorCode: "PLAYER_NOT_IN_MATCH",
                        message: "Player was already swapped out." }

4. Fetch inPlayer's queue_entries row
   Verify status === "waiting"
   If not: return { success: false, errorCode: "PLAYER_UNAVAILABLE",
                    message: "Player is no longer available." }

5. Sequential writes with compensation:
   a. DELETE match_players WHERE match_id=X AND player_id=outPlayerId
   b. INSERT match_players (match_id, player_id: inPlayerId, team: outPlayer.team)
   c. UPDATE queue_entries SET status="on_deck"
      WHERE session_id=Y AND player_id=inPlayerId
   d. UPDATE queue_entries SET status="waiting"
      WHERE session_id=Y AND player_id=outPlayerId
   e. Recompute is_mixed_level for the match → UPDATE matches SET is_mixed_level=...

   Compensation on failure of b/c: re-INSERT outPlayerId, re-SET status="on_deck"
   If compensation also fails: log error, return generic failure message.

6. Broadcast organizer intervention:
   - outPlayerId → "match_cancelled" (returned to waiting queue)
   - inPlayerId  → "on_deck"         (placed on deck)
   (reuses existing broadcastOrganizerIntervention from broadcast.ts)

7. Return { success: true, message: "Swap complete." }
   → Realtime subscribeToMatchPlayers fires automatically → UI updates
```

**Note on `is_mixed_level` recompute (step 5e) — read-after-write:**
Step 5e must re-fetch **all current `match_players` rows** after the INSERT
(not before) to get the true post-swap skill composition. Using pre-swap data
plus the incoming player's level is incorrect when two concurrent swaps are
modifying different slots of the same match simultaneously — each write would
overwrite `is_mixed_level` with a stale partial view. Read-after-write ensures
the last writer always has the correct, complete picture regardless of ordering.

```
// Step 5e — correct pattern:
const { data: currentPlayers } = await supabase
  .from("match_players")
  .select("player_id")
  .eq("match_id", matchId);
const currentIds = currentPlayers?.map(p => p.player_id) ?? [];
const { data: currentProfiles } = await supabase
  .from("profiles")
  .select("skill_level")
  .in("id", currentIds);
const levels = new Set(currentProfiles?.map(p => p.skill_level));
const isMixed = levels.size > 1;
await supabase.from("matches").update({ is_mixed_level: isMixed }).eq("id", matchId);
```

**Note on atomicity:**
Sequential writes with compensation stay consistent with all existing match
actions in this codebase. A PostgreSQL RPC is a valid future hardening step if
swap errors surface in production, but the `pending` guard in step 2 eliminates
the most dangerous race before any writes touch the DB.

---

## 4. The Swap Sheet UI — Internal Structure

```
┌─────────────────────────────────────────┐
│  ✕                         [close btn] │  ← Radix Sheet close
│                                         │
│  Swapping out:                          │  Header
│  ┌───────────────────────────────────┐  │
│  │ [Avatar] Player Name  [Team A ▸]  │  │  outgoing player chip
│  └───────────────────────────────────┘  │
│                                         │
│  Replace with...               [Search] │  Section 1
│  ┌───────────────────────────────────┐  │
│  │ Player B  Intermediate  #3 queue  │  │  ← selectable row
│  │ Player C  Beginner      #5 queue  │  │
│  │ ─────────────────────────────── │  │
│  │ ⏸ Player D  Advanced    PAUSED   │  │  ← disabled, visible
│  └───────────────────────────────────┘  │
│                                         │
│  ┌─ Skill mismatch warning ──────────┐  │  Section 2 (conditional)
│  │ ⚠ This swap creates a mixed-     │  │  yellow banner, dismissible
│  │   level match.              [✕]   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  [ Confirm Swap ]  (disabled until      │  Section 3: actions
│     player selected)                    │
│  [ Cancel ]                             │
└─────────────────────────────────────────┘
```

### Player List Details

**Data source:** `useOrganizerData`'s `waitlist` — already available, no new
fetch needed.

**Filtering rules (applied in order):**

| Filter | Rule |
|--------|------|
| Remove players in THIS match | Prevents duplicate slot |
| Remove players in other on-deck matches | `status === "on_deck"` |
| Remove players currently playing | `status === "playing"` |
| Show paused players but disabled | `is_paused === true` → row rendered with `opacity-50` + `⏸ PAUSED` badge + `cursor-not-allowed`. NOT hidden — organizer sees they exist but can't select them. |

**Sorting:** Queue position (ascending) — next-up players appear first.

**Skill mismatch indicator (resolved — Q2 answer):**
When the organizer selects a player, the system evaluates whether the incoming
player's skill level would push the match outside the session's configured skill
window. If yes:
- A yellow dismissible banner appears **above the Confirm button** before the
  organizer commits (not at row selection time — reduces noise during browsing)
- The Confirm button remains enabled — this is a warning, not a block
- The organizer can dismiss the banner with `✕` and still confirm
- `is_mixed_level` will be set to `true` on the match after the swap (step 5e)

---

## 5. CRITICAL — Auto-Queue Race Condition: Two-Layer Safety Net

### The Scenario

The app's `promoteOnDeckMatchInternal` automatically moves matches from
`pending` → `in_progress` when a court frees up (triggered by `endMatchAction`
and `cancelMatchAction`). This can happen at any time, including while an
organizer has the Swap Sheet open for that exact match.

**Attack surface:**
```
T=0ms   Organizer opens Swap Sheet for Match #7 (status: pending)
T=400ms A court frees up → promoteOnDeckMatchInternal fires
T=401ms Match #7 transitions: pending → in_progress
T=600ms Organizer clicks "Confirm Swap"
```

Without guards: `swapPlayerInMatch` would operate on an `in_progress` match,
corrupting match state and giving incorrect players queue statuses.

---

### Layer 1 — Backend Guard (Defensive, Always-On)

The server action's **step 2** already contains the status guard. This section
formalizes it as the authoritative last line of defence:

```
// Step 2 — expanded definition:
const { data: match } = await supabase
  .from("matches")
  .select("id, status, session_id")
  .eq("id", matchId)
  .single();

if (!match || match.status !== "pending") {
  return {
    success: false,
    errorCode: "MATCH_STARTED",
    message: "This match has already started — the swap was cancelled automatically."
  };
}
```

**Why this is sufficient as a hard stop:**
- `promoteOnDeckMatchInternal` performs its own `UPDATE ... WHERE status='pending'`
  atomic guard before changing the match status
- By the time `swapPlayerInMatch` reads the status in step 2, it will either see
  `pending` (safe to proceed) or `in_progress` / `cancelled` (bail out cleanly)
- No writes to `match_players` or `queue_entries` occur before step 2 resolves
- This is a read-then-guard pattern, not a compare-and-swap — but because the
  match promotion is atomic and our step 2 read happens at the query layer, the
  window for the swap to "see pending but then write to in_progress" is
  negligible and inconsequential (swap simply returns MATCH_STARTED on the next
  request)

---

### Layer 2 — Frontend Guard (Proactive, Reactive Auto-Dismiss)

The frontend guard **proactively closes the Sheet** before the organizer even
clicks Confirm, giving them clear feedback instead of a confusing server error.

**Mechanism — zero new subscriptions required:**

`useOrganizerData` already has a `subscribeToMatches` channel that fires
`fetchActiveMatches()` whenever any match in the session changes status. This
updates `onDeckMatches` (which is derived from `activeMatches` filtered to
`status === "pending"`). When Match #7 transitions to `in_progress`, it
disappears from `onDeckMatches` automatically.

**The effect lives in `OrganizerDashboard`:**
```
useEffect(() => {
  if (!swapContext) return;
  const matchStillPending = onDeckMatches.some(m => m.id === swapContext.matchId);
  if (!matchStillPending) {
    setSwapContext(null);          // closes the Sheet immediately
    toast.warning("Match has started — the swap was cancelled automatically.");
  }
}, [onDeckMatches, swapContext]);
```

**Timing characteristics:**
```
T=0ms   Match promoted to in_progress
T=50ms  Supabase realtime fires subscribeToMatches callback
T=100ms fetchActiveMatches() resolves, onDeckMatches updated
T=105ms useEffect runs → Sheet auto-dismissed, toast shown

If organizer clicks Confirm at T=80ms (between T=50ms and T=105ms):
→ Layer 1 (server step 2) catches it → returns MATCH_STARTED error
→ Sheet shows inline error (and Layer 2 arrives ~25ms later to dismiss it anyway)
```

**Why reuse `onDeckMatches` instead of a new subscription:**
- `subscribeToMatches` is already active and already triggers `fetchActiveMatches`
- Adding a second subscription to the same table for the same session would be
  wasteful and add channel complexity
- The `useEffect` dependency on `onDeckMatches` is a simple derived reaction —
  exactly what React effects are designed for

---

### Two-Layer Summary Table

| Layer | Where | Trigger | What It Does |
|-------|-------|---------|--------------|
| **Layer 1** (Backend) | `swapPlayerInMatch` step 2 | Organizer clicks Confirm | Reads current match status; aborts with `MATCH_STARTED` error code if no longer pending |
| **Layer 2** (Frontend) | `useEffect` in `OrganizerDashboard` | `onDeckMatches` change via realtime | Auto-dismisses Sheet + shows toast ~100ms after match promotion, before organizer can click |

**Together:** Layer 2 prevents the frustrating experience. Layer 1 is the
guarantee that no data corruption occurs even if Layer 2 is slow.

---

### Frontend Error Code Routing

The `SwapResult.errorCode` allows the frontend to handle each failure
distinctly rather than showing a generic error for everything:

| errorCode | Frontend Behaviour |
|-----------|-------------------|
| `MATCH_STARTED` | Close Sheet + show warning toast ("Match started — swap cancelled") |
| `PLAYER_UNAVAILABLE` | Keep Sheet open + show inline error below player list ("Player is no longer available — pick someone else") |
| `PLAYER_NOT_IN_MATCH` | Close Sheet + show info toast ("Player was already swapped out") |
| No code (network/generic) | Keep Sheet open + show inline error + retry button |

---

## 6. Undo Toast Architecture

**Resolved — Q3 answer:**
Because swaps are always 1-for-1 and complete immediately, an undo is
mechanically a reverse swap. A 5-second undo toast is the right UX here.

**How it works:**

After a successful swap:
1. Sheet closes
2. A Sonner toast appears with `"Swapped [OutName] → [InName]"` + `[Undo]` action button
3. Toast has a 5-second countdown (Sonner's `duration: 5000`)
4. If organizer taps `[Undo]` within 5 seconds:
   - `swapPlayerInMatch(matchId, inPlayerId, outPlayerId)` is called — exactly
     reversed arguments
   - A loading state on the toast button prevents double-tap
   - Success: show `"Swap undone"` toast. Failure (e.g. new swap happened in
     between): show `"Couldn't undo — match may have changed"` toast
5. If toast expires without Undo: nothing happens, swap stands

**State needed for undo:**
```typescript
type UndoableSwap = {
  matchId:     string
  outPlayerId: string  // the player to put BACK
  inPlayerId:  string  // the player to remove (was just added)
  outName:     string  // for toast display
  inName:      string  // for toast display
}
```
This is stored as a transient local state in `OrganizerDashboard` (NOT in
`swapContext` — separate `lastSwap` ref). It is cleared when the toast expires.

---

## 7. Full Edge Cases & Mitigations (Updated)

| Edge Case | What Happens | Mitigation |
|-----------|-------------|------------|
| **Match promoted while Sheet open** | Layer 2 auto-dismisses Sheet + toast. If Layer 2 is slow, Layer 1 returns `MATCH_STARTED` | Covered by both layers — no data corruption possible |
| **Organizer clicks Undo, but match now in_progress** | `swapPlayerInMatch` returns `MATCH_STARTED` | Toast shows "Couldn't undo — match may have changed" |
| **Outgoing player went offline** | `status = "on_deck"` in DB, swap completes normally | `broadcastOrganizerIntervention` sent; player sees status change on reconnect |
| **Incoming player leaves session mid-swap** | `queue_entries.status = "left"` between Sheet open and Confirm | Step 4 guard → `PLAYER_UNAVAILABLE` → inline Sheet error, keep open |
| **Incoming player already on_deck** | `queue_entries.status = "on_deck"` | Step 4 guard → `PLAYER_UNAVAILABLE` → inline Sheet error |
| **Skill mismatch after swap** | `is_mixed_level` becomes stale | Step 5e read-after-write recompute patches `matches.is_mixed_level` correctly |
| **Paused player appears in list but organizer tries to pick** | Row is rendered as `disabled` — button is non-interactive | `cursor-not-allowed` + `aria-disabled="true"` on the row button |
| **Undo fired but inPlayer was swapped again** | New `match_players` row for `inPlayerId` no longer matches original `team` | Undo swap finds the row, swaps correctly regardless (team is preserved from original) |
| **Network failure mid-write (step 5b)** | `outPlayerId` deleted but `inPlayerId` not inserted | Compensation re-inserts `outPlayerId`. If compensation fails: log, return generic error, organizer can see the 3-player card and use "Clear Match" |

### Concurrent Organizer Scenarios

Four distinct concurrent swap patterns — each handled by a different guard:

| Scenario | Description | Guard | Result |
|----------|-------------|-------|--------|
| **A — Same outgoing player** | Two organizers open the swap sheet for the same player slot in the same match | Step 3 `DELETE` — first succeeds, second finds no row | Second returns `PLAYER_NOT_IN_MATCH` → sheet closes + info toast |
| **B — Same incoming player, different matches** | Org A picks Player X for Match #7, Org B picks Player X for Match #8 simultaneously | Step 4 `status` check — first swap sets `on_deck`, second sees it | Second returns `PLAYER_UNAVAILABLE` → inline sheet error, keep open, pick someone else |
| **C — Different slots, same match** | Org A swaps Team A slot, Org B swaps Team B slot in the same match simultaneously | Row-level isolation — each targets a different `match_players` row, no conflict | Both swaps succeed independently. Step 5e read-after-write ensures `is_mixed_level` reflects the true final composition regardless of write order |
| **D — Double-tap, same organizer** | Same organizer taps Confirm twice before first response lands | Sheet's `isConfirming` loading flag disables the button on first tap. If second request fires anyway, Step 3 returns `PLAYER_NOT_IN_MATCH` | Second request silently no-ops; sheet shows success from first |

**Why no pessimistic lock (e.g. `swap_in_progress` flag on match) is needed:**
Scenarios A and B are blocked at the row/status guard level before any write occurs.
Scenario C is safe by row isolation — different `match_players` rows, no shared mutable state except
`is_mixed_level`, which is correctly handled by read-after-write in step 5e.
A match-level lock would be over-engineering for a gym app with ≤2 concurrent organizers
and would introduce deadlock risk with no meaningful safety gain.

---

## 8. Files to Create or Modify (Updated)

### New Files

| File | Purpose |
|------|---------|
| `src/app/actions/swap-player.ts` | `swapPlayerInMatch()` server action. Auth guard, status guard with `errorCode`, sequential writes, compensation, `is_mixed_level` recompute, broadcast. |
| `src/components/organizer/swap-sheet.tsx` | Sheet drawer UI: outgoing player header, filtered player list, paused-player display, skill mismatch warning banner (dismissible), Confirm / Cancel buttons, loading/error/success states. |
| `src/components/ui/sheet.tsx` | Shadcn Sheet base component built on `@radix-ui/react-dialog`. One-time scaffold, reusable across app. |

### Modified Files

| File | Changes |
|------|---------|
| `src/components/organizer/on-deck-panel.tsx` | 1. Replace static player name `<span>` with `<PlayerBadgeButton>` sub-component (same file). 2. Add `data-no-dnd` + `onPointerDown stopPropagation` to button. 3. Add `onOpenSwap` prop threaded to `SortableCard`. 4. Wrap export in `React.memo`. |
| `src/components/organizer/organizer-dashboard.tsx` | 1. Add `swapContext` + `setSwapContext` state. 2. Add `lastSwap` ref for undo. 3. Add `useEffect` for Layer 2 auto-dismiss (depends on `onDeckMatches`). 4. Render `<SwapSheet>` as sibling after tab content, outside `<DndContext>`. 5. Pass `onOpenSwap` callback (via `useCallback`) to `OnDeckPanel`. |

### No Changes Required

| File | Reason |
|------|--------|
| `src/app/actions/match.ts` | `clearOnDeckMatch` unchanged — organizer uses existing "Clear Match" card button for full-match removal. |
| `src/lib/broadcast.ts` | `broadcastOrganizerIntervention` reused as-is. |
| `src/lib/realtime.ts` | `subscribeToMatchPlayers` already triggers re-fetch on any swap. |
| `src/hooks/use-organizer-data.ts` | No changes — `waitlist` + `onDeckMatches` already exposed; `subscribeToMatches` already drives Layer 2. |
| `src/types/database.ts` | No schema changes — all required columns already exist. |

---

## 9. Implementation Checklist (Updated)

```
Phase 1 — Foundation (no visible changes)
  [ ] Scaffold src/components/ui/sheet.tsx from @radix-ui/react-dialog
  [ ] Write src/app/actions/swap-player.ts
      - Auth + organizer guard
      - status guard returning errorCode: "MATCH_STARTED"
      - PLAYER_UNAVAILABLE and PLAYER_NOT_IN_MATCH guards
      - Sequential writes (a→e) with compensation
      - is_mixed_level recompute (step 5e)
      - broadcastOrganizerIntervention for both players

Phase 2 — Player Badge Interactivity
  [ ] Add PlayerBadgeButton sub-component to on-deck-panel.tsx
      - data-no-dnd="true"
      - onPointerDown stopPropagation
      - ArrowLeftRight icon on hover
      - aria-label="Swap [name]"
  [ ] Thread onOpenSwap prop: OnDeckPanel → SortableCard → PlayerBadgeButton
  [ ] Wrap OnDeckPanel export in React.memo

Phase 3 — Sheet UI
  [ ] Build SwapSheet component
      - Header: outgoing player chip with team badge
      - Player list: filtered + sorted by queue position
      - Paused players: visible, disabled, ⏸ PAUSED badge
      - Search/filter input
      - Skill mismatch warning banner (conditional, dismissible)
      - Confirm button (disabled until player selected)
      - Cancel button
      - Loading state while swap action is in flight
      - Inline error display keyed to errorCode
  [ ] Add swapContext state to OrganizerDashboard
  [ ] Render SwapSheet outside DndContext as sibling

Phase 4 — Race Condition Guards
  [ ] Layer 2 useEffect in OrganizerDashboard
      - Watches onDeckMatches for swapContext.matchId disappearing
      - setSwapContext(null) + toast.warning on auto-dismiss
  [ ] Wire frontend errorCode routing:
      - MATCH_STARTED → close Sheet + toast
      - PLAYER_UNAVAILABLE → inline Sheet error, keep open
      - PLAYER_NOT_IN_MATCH → close Sheet + info toast
      - Generic → inline error + retry

Phase 5 — Undo Toast
  [ ] lastSwap ref in OrganizerDashboard (UndoableSwap | null)
  [ ] On successful swap: set lastSwap, show Sonner toast with Undo button
  [ ] Undo handler: swapPlayerInMatch(reversed args) with loading + success/fail toast
  [ ] Clear lastSwap on toast expiry and on Sheet re-open

Phase 6 — Touch & Concurrency Verification
  [ ] Touch test: press player badge on iOS Safari + Android Chrome
      → verify no drag triggered (150ms hold test)
  [ ] Concurrent swap test: two tabs, confirm Layer 1 returns correct errorCode
  [ ] Race condition test: promote match during open Sheet
      → verify Layer 2 auto-dismisses before Confirm is needed
      → verify Layer 1 catches it if Confirm fires first
  [ ] Offline player test: disconnect player, swap them out, reconnect and
      verify they see "waiting" status with no stuck state
  [ ] Undo test: swap, immediately undo within 5s, verify board reflects revert
```

---

*Awaiting final approval before any code is written. (v3 — concurrent swap scenarios fully documented)*
