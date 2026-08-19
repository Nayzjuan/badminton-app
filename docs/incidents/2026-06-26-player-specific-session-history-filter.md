# 3.24 Player-Specific Session History Filter (2026-06-26)

> Extracted from `APP_MANIFEST.md` §3.24 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `src/lib/match-history-filter.ts` (pure helpers), `src/components/organizer/match-history-player-filter.tsx` (filter UI), `src/components/organizer/match-history-panel.tsx` (wired in).

**Purpose:** Organizer-only type-to-filter search inside the existing Match History tab. Lets the organizer narrow the history view to a single player's matches for quick review. **Zero new DB tables, migrations, or server actions** — 100% client-side filtering over the already-fetched `CompletedMatch[]` from `useMatchHistory`.

**Architecture:**

| Layer | File | Responsibility |
|---|---|---|
| Pure logic | `src/lib/match-history-filter.ts` | 4 exported pure helpers: `filterMatchesByPlayer`, `derivePlayerOptions`, `resolvePartnerIds`, `selectionStillValid` |
| Unit tests | `tests/unit/match-history-filter.test.ts` | 29 MHF-* Vitest tests covering all edge cases (null id, leave-triggered cancel, dup names incl. case/whitespace variants, swapped-out player, empty history) |
| Filter UI | `src/components/organizer/match-history-player-filter.tsx` | Controlled searchable list — `<input>` + `<ul>` of `<button aria-pressed>` (swap-sheet pattern, NOT a combobox) |
| Panel integration | `src/components/organizer/match-history-panel.tsx` | Adds `selected` state, `playerOptions` + `visibleMatches` memos, reconcile effect, active-filter chip, highlight rings, safety-net empty state, legend |

**Filtering mechanics:**
- `filterMatchesByPlayer(matches, id)` — null id returns the same array reference (identity, zero re-renders); otherwise filters by roster membership.
- `derivePlayerOptions(matches)` — deduplicates by `player_id`, alpha-sorts by `display_name`, attaches a `player_id.slice(-4)` disambiguator when two players share the same display name. The collision key is `normalizeName()` (`src/lib/normalize-name.ts`, the app's single source of truth for name identity, parity-locked to the SQL index expression) — **not** the raw string. `idx_profiles_unique_active_name` already blocks case/whitespace variants for ordinary profiles, so the case this actually catches is a `needs_rename = true` profile, which is exempt from that index precisely so a duplicate identity can sit unresolved. Those two rows differ only by case or collapsed whitespace, render identically in the picker, and would both come back with a null disambiguator under a raw-string key.
- `resolvePartnerIds(match, id)` — returns teammate `player_id`s (same team, different id) for the selected player in a single match.
- `selectionStillValid(matches, id)` — checks raw `matches` roster (NOT derived `playerOptions`). Used to detect stale selections after identity merges or score reverts.

**Selection lifecycle:**
- Pinned `selected: { id: string; display_name: string } | null` state — name captured at select time so the active-filter chip stays correct even if the player's profile vanishes from `playerOptions` on a realtime refetch.
- **Conservative reconcile:** if `selectionStillValid` returns false (player gone from all rosters), the filter chip stays visible with a safety-net empty state — never auto-cleared. The organizer dismisses via ✕. This is intentional for score-revert via `FixRecordSheet` which temporarily removes a match from history.
- **Two cancel paths handled correctly:** organizer-cancel retains all `match_players` rows (player appears in filtered history). Leave-triggered cancel deletes the leaver's row first — they do NOT appear in the match's roster.

**Highlight encoding (when a filter is active).** The two card branches use *different* ring treatments — that is deliberate, and the numbers below are measured, not asserted:

| Branch | Selected (`●`) | Partner (`○`) |
|---|---|---|
| Completed (`match-history-panel.tsx` ~:433/:478) | `bg-cc-accent-dim outline outline-1 outline-cc-accent text-cc-accent-text font-bold` | `outline outline-1 outline-dashed outline-cc-accent font-medium` |
| Cancelled (~:277/:312) | `bg-cc-accent-dim outline outline-2 outline-cc-accent text-cc-accent-text` | `outline outline-2 outline-dashed outline-cc-accent` |

- Cancelled uses `outline-2` because that whole player area sits inside an `opacity-60` wrapper — the compositing eats the ring, so it needs the extra width. Measured light-mode ring-vs-panel contrast under that wrapper: **1.91:1** with the current full-opacity accent vs **1.36:1** if the completed branch's style were reused. The heavier ring is doing real work.
- **The `opacity-60` wrapper caps the cancelled ring at ≈2.1:1 in light mode no matter what colour is used** (darkening the accent to `L=0.40` only reaches 2.07). Reaching 3:1 there would require raising the wrapper opacity or lifting the highlighted name out of the dimmed subtree — a visual-design change to a deliberately de-emphasised card, so it is **accepted, not fixed**. Dark mode is unaffected (**7.21:1**).
- The completed branch previously used `outline-cc-accent/55`, which measured **1.80:1** in light mode — an effectively invisible ring. Dropping the `/55` (2026-08-10) takes it to **5.23:1** light / **6.65:1**+ dark, with no change to hue, width or layout.
- WCAG 1.4.11 is not the binding constraint in either branch — the ring is never the sole encoding. Selected also carries `text-cc-accent-text` + `font-bold` + the dim fill + the "Showing {name}" chip; partner also carries a literal `partner` caption underneath. The rings are a scanning aid, and the light-mode fix above is about them actually being visible.
- The active-filter chip's own `outline-cc-accent/55` ring (~:171) is intentionally left soft — its meaning is carried by its text.
- Legend renders below the cards when filter is active: `◍ solid = selected · ◌ dashed = partner`.

**Two behaviours worth knowing (both intentional):**
- **The filter resets on tab switch.** `organizer-dashboard.tsx:952` mounts the panel as `{activeTab === "history" && <MatchHistoryPanel …/>}`, so leaving the History tab unmounts it and `selected` is lost with it. Every sibling tab is mounted the same way; hoisting this one panel's state to the dashboard would break that pattern and would also resurrect a stale filter after a long detour. Leaving the tab is treated as ending the enquiry.
- **Escape is two-stage, innermost-first.** It clears the search query if one is typed, and only clears the selection once the query is empty. Because `handleSelect` empties the query on selection, the steady post-selection state needs a **single** Escape to un-pick the player; the "two presses" case exists only while the organizer is mid-typing.

**Access control:** `MatchHistoryPlayerFilter` is rendered only inside `MatchHistoryPanel` which lives in the `src/components/organizer/` subtree. Player-facing components (`PlayerDashboard`, `match-history.tsx`) do not import anything from this subtree — organizer-only by structural exclusion, no runtime checks needed.

