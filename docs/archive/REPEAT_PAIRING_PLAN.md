# Repeat-Pairing Warning — Plan + Handoff (2026-07-18)

> ## ✅ SHIPPED 2026-07-21 — this document is HISTORICAL
>
> Manual-match repeat warning for the organizer Queue tab. **Everything below is
> done**, including the UI wiring the original handoff left open: `src/lib/repeat-pairing.ts`,
> `repeat-pairing-copy.ts`, `src/app/actions/repeat-pairing.ts` (2 organizer-gated actions),
> `use-pair-counts.ts`, `use-repeat-pairing.ts`, `manual-match-bar.tsx`,
> `repeat-pair-details.tsx`, `repeat-marker.tsx`, wired into `queue-control.tsx`,
> `queue-skill-groups.tsx` and `organizer-dashboard.tsx`. Four bugs found in review
> were fixed before merge. **The living description is [APP_MANIFEST.md §3.25](../../APP_MANIFEST.md)** —
> read that, not this. Kept for the design rationale only.
>
> **Original status line (superseded):** ~~Foundation is BUILT + TESTED (uncommitted in the working tree). UI wiring is the remaining work.~~

---

## Feature
When the organizer hand-builds a match, warn — **before** creation — that a pair have repeatedly been **teammates** or **opponents**. Advisory only: it must **never** block, disable, or reject creation. Includes a click/hover disclosure showing the actual prior matches, and per-row markers in the queue list.

## Locked decisions (user)
1. **Teammate threshold = 2, opponent threshold = 2.** ⚠️ The user originally chose opponent ≥3; that was **reversed after review** — `constants.ts` has `MAX_OPPONENT_REPEATS = 2` ("Lowered 3 → 2, 2026-07 diversity pass"). At ≥3 the opponent warning fires ≈0.15×/session and stays silent on exactly the pairings the engine already refuses. Thresholds are now **imported from the engine constants**, never hard-coded.
2. **Manual Match Bar becomes sticky.**
3. **Per-row markers in the queue list are in scope** — and must ship in **BOTH** renderers.
4. **CTA label stays "Add to On Deck"**, never disabled.
5. **Full scope** (includes the selection-model change + swap affordance).

---

## ✅ BUILT + TESTED (working tree, uncommitted)

### `src/lib/repeat-pairing.ts` — pure derivers
- **Slot model** `Slots = (string|null)[]` = `[A1, A2, B1, B2]`. Deselect frees *that slot*; the other three keep their teams. (Fixes: with an insertion-ordered `Set`, deselecting pick #2 silently promoted a Team-B player into Team A and rewrote the warnings.)
- `deriveTeams`, `filledCount`, `partnerSlotIndex`, `opposingSlotIndices`, `normalize` (pads short dense arrays to 4 — without this `findIndex` never visits missing slots and reports "full").
- `derivePairWarnings(slots, counts, thresholds)` → teammates first, then count desc, so `[0]` is the headline.
- `deriveCandidateMarkers(slots, candidateIds, counts, thresholds)` → **slot-aware**: the next tap fills the *first free slot*, so after freeing A2 the next pick is a **teammate of A1** even with 3 selected. Returns **ALL** triggered relations (filling a B slot can hit teammate + 2 opponents at once). `candidateIds` **MUST** exclude selected / locked / paused.
- `hasCleanAlternative(...)` → **avoidability gate**.
- `DEFAULT_REPEAT_THRESHOLDS` = `{ teammate: MAX_PARTNERSHIP_REPEATS, opponent: MAX_OPPONENT_REPEATS }`.

### `src/app/actions/repeat-pairing.ts` — two server actions
- `getSessionPairCounts(sessionId)` → `{success, data:{partnerships:[k,n][], opponents:[k,n][]}}`. **Organizer-gated** (payload keys are player UUIDs = the session's co-play graph). Reads via service client (fetchPartnershipCounts is a service-role helper).
- `getPairMatches(sessionId, a, b)` → the matches behind a count. Filters on the **same `COMMITTED_MATCH_STATUSES`** as the counts, so the expanded list can never contradict the number that opened it. Returns `sameTeam`, status, court, scores, roster.

### `tests/unit/repeat-pairing.test.ts` — 23 tests, all passing
Threshold anti-drift · slot gaps · marker matrix per free-slot · **panel/marker disjointness at every selection size** · never-marks-selected · avoidability gate.

**State: 693 unit tests pass · tsc 0 · lint clean · fully additive (nothing wired into UI → zero user-visible risk).**

---

## ⬜ REMAINING — UI wiring (~400 lines, 5 files, ~10 integration points)

1. **`QueueControl` selection model** — `useState<Set<string>>` → `Slots`. Keep exposing a derived `Set` to children so `QueueSkillGroups`' prop contract is unchanged (low blast radius). `togglePlayer`: occupied → free that slot; else fill first free slot. `handleCreateMatch`: `teamA = [slots[0], slots[1]]`, `teamB = [slots[2], slots[3]]` (NOT `Array.from(set).slice`).
2. **Team preview + swap affordance** — always render from ≥1 selected, under the count text, explicit `A:` / `B:` letters (never hue alone), one truncating line. Tapping a name moves it across the net (swap with `partnerSlotIndex`'s mirror / move to a free opposing slot). **This is the remedy** that makes the warning actionable — most teammate flags are fixed by moving one player.
3. **Warning region — sticky/non-sticky SPLIT.** On iPhone SE (375×667) the bar as originally specced leaves <3 rows of the queue. STICKY part = count row + CTA slot + team preview + ONE `line-clamp-1` headline + a "+N repeat pairings" `<button aria-expanded>`; hard-cap `max-height: min(33vh, 200px)`. NON-STICKY part (scrolls normally, below the bar) = full per-pair rows + expanded match lists. **No `overflow-y-auto` inside the bar.**
4. **Sticky bar** — `organizer-dashboard.tsx` header is `sticky top-0 z-20`; a bar at `top-0 z-10` would be **invisible underneath it**. Publish header height via `ResizeObserver` → `--cc-header-h` on the dashboard root; bar uses `sticky top-[var(--cc-header-h)] z-[15]`. Also **retint the bar to opaque `cc-*` surfaces** (its dark state is `dark:bg-amber-950/30`, 30% translucent — content scrolls through it). This is now a prerequisite, not scope creep.
5. **Per-row markers in BOTH renderers** — `queue-control.tsx` table **and** `queue-skill-groups.tsx` (they share `selected`; shipping one lens only reads as a bug). Render **inline right after `display_name`** (the table is `min-w-[640px]` inside `overflow-x-auto`, so a right-aligned marker is off-screen on a phone). Extract one shared `<RepeatMarker>`. Icon must be `aria-hidden` + a real `<span className="sr-only">` text node (`aria-label` is unreliable on `role=generic`). Add a persistent legend line resolving the referent (e.g. "⚇ = played with Alice").
6. **Avoidability gate wiring** — call `hasCleanAlternative` with the selectable waiting pool (not paused / not on_deck / not drafted); render nothing when false. Also suppress while `capSaturation` is active (`use-organizer-data.ts` already has this state).
7. **Live region — TWO nodes.** Visible headline: plain markup, immediate, no live semantics. Announcement: a **permanently mounted** `<div role="status" aria-live="polite" class="sr-only">` (a live region that enters the DOM with its text is usually not announced), written on a 500 ms trailing debounce, only when the coalesced string changes AND the change was user-initiated (gate on a `selectionEpoch` bumped in `togglePlayer`).
8. **Counts hook + episode snapshot** — do **NOT** open a new realtime channel (`use-organizer-matches.ts` already subscribes to `matches` AND `match_players`; bump a revision counter and pass it down). **Snapshot counts when `filledCount` goes 0→1** and hold until the selection clears / a match is created — otherwise engine draft churn resizes the region under the organizer's fingers. Refetch with zero delay after createManualMatch / cancel / swapPlayer.
9. **Disclosure state** — key rows by `pairKey`; track `expandedPairKey`; clear it when that key leaves the derived set (otherwise an open panel renders pair X's history under pair Y's label). Cache fetched matches by `pairKey`. `scrollIntoView({block:"nearest"})` on open.
10. **Copy + tokens** — PRIOR-count everywhere; headline `Alice & Bob have partnered 2× tonight — auto-matchmaking won't pair them again`; marker `Would be a 3rd match with Alice as teammates`. Label opponents **"Opponents"** (H2HStrip already owns "faced"). Use `cc-amber` / `cc-t1..t3` / `cc-bg-2` / `cc-border`; **`cc-accent` is TEAL and already means SELECTED on this screen — never use it for the warning.** Carry teammate-vs-opponent on **icon + label**, not hue. Headline `font-sans text-sm font-semibold` (not `font-command`, which is 9–11px uppercase here).

### Also fix while in there (review findings)
- At `selected.size === 4` unselected rows are **still clickable** but `togglePlayer` no-ops → dead tap, exactly when the warning says "reconsider". Give full rows the paused/locked disabled treatment, or make a tap replace the last pick.
- Reserve the CTA slot from ≥1 selected (`invisible`, not unmounted) so the row height doesn't jump at the 4th tap.
- `Clear` is `text-xs` with no min-height — it becomes the primary recovery action; give it `min-h-[44px]`.
- Headline the FIRST pair that triggered in an episode and don't re-rank (otherwise the top line rewrites twice during one 4-tap build).
- Pulse: scope the pulsed-`pairKey` set to one build episode (clear it where `selected` clears), gate on selection change only, `motion-reduce` respected.
- Drop any nested tinted panel (box-in-a-box) once the bar is opaque — just `border-t` + padding.

---

## Full review record
23 findings (10 must-fix) from a 4-lens adversarial review (logic · UX/a11y · integration · live-session ops). Raw output: workflow `wio1bfoz2`. Every must-fix is either already implemented in the foundation above or listed in REMAINING.
