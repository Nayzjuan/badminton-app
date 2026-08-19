# Plan: Organizer Player-Specific Session History

> ## ✅ SHIPPED 2026-07-02 — this document is now HISTORICAL
>
> **Do not treat anything below as pending work.** The whole plan was built and
> merged on 2026-07-02: `src/lib/match-history-filter.ts`,
> `src/components/organizer/match-history-player-filter.tsx`, the
> `match-history-panel.tsx` integration and `tests/unit/match-history-filter.test.ts`
> are all live on `main`. The header below survived unedited from the pre-approval
> draft, which is why a later pending-work sweep re-inventoried a finished feature
> as unstarted. **The living description is [APP_MANIFEST.md §3.24](../../APP_MANIFEST.md)** —
> read that, not this. This file is kept only for the design rationale and the
> adversarial-review trail.
>
> **Deltas applied after this plan was written** (all 2026-08-10, all in §3.24):
> - Collision detection keys on `normalizeName()` rather than the raw `display_name`
>   this document specified — the repo already had a parity-locked normalizer, and
>   the real-world collision is a `needs_rename` profile with a case/whitespace variant.
> - The completed-branch highlight ring dropped its `/55` opacity: measured at
>   **1.80:1** against the card in light mode, it was effectively invisible. Now **5.23:1**.
> - The cancelled branch's ring is capped at ≈2.1:1 in light mode by its `opacity-60`
>   wrapper regardless of colour. Measured, documented and **accepted**; not fixed.
> - Escape's two-stage behaviour and the tab-switch state reset are documented
>   precisely in §3.24 — both are intentional, neither was spelled out here.
>
> **Original status line (superseded):** ~~Awaiting approval. No application code has been written. This document is the sole deliverable.~~
> **Scope:** Add an **organizer-only** filter inside the existing Match History tab that narrows the list to a single player's matches, with a 1-click return to global history.
> **Provenance:** Grounded in a 5-subsystem codebase scan (UI, hooks, access control, DB schema, design system) **and** a 3-reviewer adversarial pass that corrected several first-draft claims against the live code. Corrections are marked ⓡ where they changed a conclusion.

---

## 0. Context, Goal & Guardrails

**Problem.** Organizers view a global Match History per session via the **History** tab. As a session grows (often 30–100+ completed games), locating one player's matches means scrolling the entire list. There is no way to focus on a single player.

**Goal.** Inside the existing Match History panel, let the Organizer pick a player and instantly see only that player's matches, with their team clearly highlighted, and clear the filter in one click.

**Hard constraint — Organizer only.** Regular players must never see this UI. This is guaranteed *structurally* (component-tree exclusion), not by a runtime flag (see §3.3).

**Non-goals (out of scope for this iteration):**
- No new database tables, columns, RPCs, views, or migrations.
- No new server action or network round-trip — filtering is 100% client-side over already-fetched data.
- No cross-session "career" history (the existing player-facing `getMatchHistory` action covers that elsewhere; this feature is scoped to **the current session** inside the organizer panel).
- No pagination/virtualization. ⓡ *Note (not a hand-wave): the new option-list derivation is `O(total roster rows)` recomputed per realtime refetch via `useMemo([matches])` — linear and cheap at the stated ceiling (~40 players × ~100 games). The pre-existing **un-virtualized full render of every card** remains the dominant cost and is unchanged by this feature; filtering only ever reduces the number of rendered cards.*

**Verified anchor facts (file:line):**

| Fact | Source |
|---|---|
| History tab mounts `<MatchHistoryPanel sessionId={session.id} />` | [organizer-dashboard.tsx:892](src/components/organizer/organizer-dashboard.tsx) |
| Panel reads `const { matches, loading } = useMatchHistory(sessionId)` | [match-history-panel.tsx:28](src/components/organizer/match-history-panel.tsx) |
| `CompletedMatch = Match & { players: (MatchPlayer & { profile: Profile })[]; courtName: string \| null }` | [use-match-history.ts:14](src/hooks/use-match-history.ts) |
| Team panels are **inline JSX** inside `matches.map(...)` — there is **no** standalone `MatchCard` component | [match-history-panel.tsx:115-342](src/components/organizer/match-history-panel.tsx) |
| History query includes cancelled: `.in("status", ["completed","cancelled"])` | [use-match-history.ts:39](src/hooks/use-match-history.ts) |
| Roster carries `player_id` + `team` client-side; teams partitioned via `match.players.filter(p => p.team === 'a'/'b')` | [match-history-panel.tsx](src/components/organizer/match-history-panel.tsx) |
| Organizer components live only in `src/components/organizer/*`; `PlayerDashboard` imports nothing from there | [player-dashboard.tsx](src/components/player/player-dashboard.tsx) |

---

## 1. UX & UI Design (Match History Panel)

### 1.1 Selector component — decision: **type-to-filter searchable list** (the shipped swap-sheet pattern, *not* an ARIA combobox) ⓡ

Three candidates were weighed against the verified constraints (6–40 players, a **full-width, non-responsive, un-virtualized** panel on mobile, and the project's "command center" Impeccable aesthetic):

| Option | Verdict | Why |
|---|---|---|
| **Type-to-filter searchable list** ✅ **chosen** | Best across the whole range | Type 2–3 chars and pick — O(1) effort at 6 *or* 40 players. Implemented as the **already-shipped, accessible** pattern in [swap-sheet.tsx](src/components/organizer/swap-sheet.tsx): a labeled `<input>` + a `<ul>` of `<button aria-pressed>` rows (each row = name + `SkillBadge` + muted game-count). |
| Native `<select>` | Rejected as primary | A 40-name native list is a slow scroll, can't render a `SkillBadge` per option, and reads as the generic-SaaS chrome that clashes with the organizer command center. (Precedent: the low-stakes month picker at [leaderboard-page.tsx:179](src/components/leaderboard/leaderboard-page.tsx).) |
| Avatar/player pills row | Rejected as primary | Most on-brand and best for ~6–12 players, but at ~40 it wraps into many lines and **pushes the actual history below the fold** on the full-width mobile panel. Used instead as the per-row visual style *inside* the chosen list. |

> ⓡ **Why NOT a `role="combobox"`/`listbox`/`aria-activedescendant` widget:** the review confirmed **no combobox pattern exists anywhere in the repo** — [leaderboard-page.tsx](src/components/leaderboard/leaderboard-page.tsx) is a `role="tablist"` (roving `tabIndex`), and [swap-sheet.tsx](src/components/organizer/swap-sheet.tsx) is a plain `<input>` + `<button aria-pressed>` list. Inventing a hand-rolled combobox (with its own focus model + `aria-activedescendant`) would be net-new, untested ARIA surface. We deliberately reuse the **shipped, accessible** input-plus-button-list pattern instead. (The earlier draft's "mirror the tablist" framing and a mixed roving-tabindex/aria-activedescendant focus model were contradictory and have been removed.)

**Layout & behavior (top of the panel, above the first match card):**

```
┌─────────────────────────────────────────────────────────────┐
│  [🔍  Filter by player…                                   ]  │  ← labeled <input> (visually-hidden <label>)
└─────────────────────────────────────────────────────────────┘
   (results render INLINE in normal document flow — not a floating popover)
   ┌───────────────────────────────────────────────┐
   │  ◍ Maria Santos        Adv          12 games   │  <button aria-pressed=false>
   │  ◍ Jun Dela Cruz       Int           9 games   │
   │  ◍ …                                           │
   └───────────────────────────────────────────────┘
```

- **Search semantics:** case-insensitive substring — `display_name.toLowerCase().includes(query.toLowerCase())` exactly as [swap-sheet.tsx:167](src/components/organizer/swap-sheet.tsx) (there is no shared "normalize" helper to reuse; the inline form is copied). ⓡ
- **Inline, not floating.** ⓡ The results render in normal flow (the list expands and pushes cards down), so it cannot be clipped by the panel's overflow or overlap scrolling cards — the failure mode a floating popover would have on the un-virtualized full-width panel. Typing narrows the list, so the number of focusable `<button>` rows (tab stops) is bounded by the query. **Mobile fallback (documented):** swap-sheet itself is a Radix `Sheet` for thumb reach; if preview testing shows the inline list is awkward on small screens, the same picker can be lifted into the existing `Sheet` with zero pattern change. Default to inline; escalate to Sheet only if testing demands it.
- **Sort:** `display_name` ascending (find-by-name). Trailing muted `{n} games` per row (JetBrains Mono numerals).
- **Tokens:** `cc-*` only. Input mirrors swap-sheet (`Search` icon absolute `left-3`, `bg-muted/30`, focus `ring-2 ring-ring`). ⓡ *Use `ring-ring` (swap-sheet's token), not leaderboard's `ring-accent` — the body is lifted from swap-sheet.* Selected/active row uses `bg-cc-accent-dim` + `outline-cc-accent/55`. **No** side-stripe border, **no** gradient text (the two real Impeccable bans).

### 1.2 "This list is filtered" indicator

When a player is selected, render an **active-filter chip row** directly beneath the search input and above the first card, so the filter state lives *inside* the panel and scrolls with the list:

```
●  Showing Maria Santos   ✕            12 of 84 matches
└── chip: bg-cc-accent-dim, outline cc-accent/55 ──┘   └ muted count, mono ┘
```

- Chip copy: **"Showing {name}"** with a leading filter glyph. ⓡ **The chip's name comes from a pinned selection object in state — `{ id, display_name }` captured at select time — NOT re-derived from the option list.** This keeps the chip correct even if the player later vanishes from `playerOptions` on a realtime refetch (see §4.4/§4.5).
- ⓡ The chip is `rounded-full`, which is fine: it satisfies the two actual Impeccable bans — **no side-stripe border** (it uses a full `outline-cc-accent/55`) and **no gradient text** (solid `cc-accent` text). *(The first draft rebutted a non-existent "soft rounded rectangle ban"; that sentence is deleted.)*
- To its right: muted caption **"{filteredCount} of {totalCount} matches"** (`text-cc-t3`, mono numerals).
- No filter active → render neither chip nor caption; the panel is byte-for-byte its current global-history header.

### 1.3 1-click clear → return to global history

- The chip's trailing **✕** (`aria-label="Clear player filter"`) is the primary clear: one click sets the selection to `null`, dissolving the chip + caption and restoring the full list **instantly** (pure state change over already-cached matches; no refetch).
- **Keyboard:** `Escape` while the search input is focused clears the filter in one keystroke.
- **Anti-pattern avoided:** no phantom "All players" option buried in the list — the visible chip-✕ keeps clear co-located with the indicator.

---

## 2. Data Strategy (Client-Side Filtering)

### 2.1 Why client-side is correct

Every match the panel holds already carries its **full roster with `player_id`** (`CompletedMatch.players[].player_id`, [use-match-history.ts:14](src/hooks/use-match-history.ts)). The organizer legitimately has all session player data. Therefore: **no new Supabase trip, no new server action, `useMatchHistory` untouched.** Realtime already refetches on `matches` changes; the memos recompute. Filtering only reduces rendered cards.

### 2.2 Exact predicate logic

Selection state lives in **`MatchHistoryPanel`** as a pinned object (id + name), not a bare id (§1.2/§4.5):

```ts
// selected: { id: string; display_name: string } | null   (state in MatchHistoryPanel)

// (a) Filtered list — a match is included iff the selected player is on its FINAL roster.
const visibleMatches = useMemo(() => {
  if (!selected) return matches;
  return matches.filter((m) => m.players.some((p) => p.player_id === selected.id));
}, [matches, selected]);

// (b) Option list — derived ONLY from players present in history, so every selectable
//     name yields ≥1 result (§4.1). Dedup by player_id; carry a game count.
const playerOptions = useMemo(() => {
  const byId = new Map<string, { player_id: string; display_name: string; skill_level: SkillLevel; count: number }>();
  for (const m of matches) {
    for (const p of m.players) {
      const cur = byId.get(p.player_id);
      if (cur) cur.count += 1;
      else byId.set(p.player_id, {
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
        count: 1,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
}, [matches]);
```

Per visible match, resolve the selected player's team + partner(s) to drive the highlight (§3.2):

```ts
const selfRow   = match.players.find((p) => p.player_id === selected?.id);
const selfTeam  = selfRow?.team ?? null;
const partnerIds = selfTeam
  ? match.players.filter((p) => p.team === selfTeam && p.player_id !== selected!.id).map((p) => p.player_id)
  : [];
```

> **Predicate semantics:** filtering is on **current/final roster membership**. Because a swapped-out player's `match_players` row is deleted (§4.2), "Maria's history" = *matches Maria finished in*. The swap itself is preserved in `match_events` and remains visible in each card's existing `MatchEventTimeline`.

### 2.3 Realtime reconciliation ⓡ

`useMatchHistory` refetches on realtime changes, so `matches` (and thus `playerOptions`) can change while a filter is active — including when an organizer **reverts a completed match's score** (`revert_match_to_active`, wired into the completed-card header via `FixRecordSheet`), which moves that match *out* of the `["completed","cancelled"]` history set. The reconcile logic in `MatchHistoryPanel` must therefore be **conservative — it never silently drops a filter on a normal, reversible action:**

- **`matches` empty or still loading** → do nothing (transient); keep the pinned `selected` and re-render when data returns.
- **Selected player still on ≥1 roster** → no-op.
- **Selected player resolves to no roster row *while other matches exist*** (player voided, all their matches reverted, or `player_id` rewritten by an identity merge — §4.4) → **keep the chip and render the §4.1 safety-net** (`"No matches for {name} …"` + inline **Clear**) rather than auto-clearing. The organizer's intent survives a reversible action; they dismiss via the ✕ when done. The chip stays correct because its name is pinned (§4.5).

ⓡ `selectionStillValid(matches, id)` checks **raw `matches` roster membership** — `matches.some(m => m.players.some(p => p.player_id === id))` — **never** the derived `playerOptions`, so any future filtering of `playerOptions` (e.g. a min-game-count) can't hide a valid selection. The reconcile runs in an effect that **early-returns when `!selected`** and depends on `[matches, selected]`; clearing is user-driven (the ✕), not automatic, so there is no clear→re-derive→clear loop.

---

## 3. UI Component Reusability & Security

### 3.1 Reuse map ⓡ

| Need | Reuse / change | Source |
|---|---|---|
| Match card / team panels | **Card shell reused; inline name `<p>` edited.** There is no `MatchCard` — the team panels are inline JSX in two *separate* branches: the **completed** branch (`teamA/teamB.map()` ≈ lines 291-300 / 318-327) and the **cancelled** branch (≈ lines 171-177 / 188-194). The highlight (§3.2) is threaded into **both** branches; `selected` + `partnerIds` must be in scope inside the `matches.map()` body. | [match-history-panel.tsx](src/components/organizer/match-history-panel.tsx) |
| Search input + filtered button-list + selected-row style | Lifted near-verbatim (the shipped, accessible pattern) | [swap-sheet.tsx](src/components/organizer/swap-sheet.tsx) |
| Per-row skill badge | Reused as-is (`SkillBadge` returns `null` on an unknown level — acceptable; see §4.6) | [skill-badge.tsx](src/components/ui/skill-badge.tsx) |
| `cc-*` tokens, `clip-cut-*`, `font-command` | Reused (all named tokens verified to exist) | [globals.css](src/app/globals.css) |

**One new file only:** `src/components/organizer/match-history-player-filter.tsx` — a controlled, data-less filter:
```ts
type PlayerOption = { player_id: string; display_name: string; skill_level: SkillLevel; count: number };
interface MatchHistoryPlayerFilterProps {
  players: PlayerOption[];
  selectedId: string | null;
  onSelect: (option: { id: string; display_name: string } | null) => void;
}
```

### 3.2 Highlighting selected player + partner (parse teams at a glance)

Background/ring tokens only — never a side-stripe border, never gradient text. Two-tier, same-hue encoding, threaded into **both** the completed and cancelled JSX branches:

- **Selected player** → inline name pill, **solid** ring (`outline-1 outline-cc-accent`, `bg-cc-accent-dim`) + a small `user-check` glyph.
- **Partner(s)** (same `team`, different `player_id`) → same hue, **dashed** ring (`outline-dashed outline-cc-accent`) + a tiny muted `partner` caption (`text-[10px] uppercase tracking-wider text-cc-t3`).
- Opposing team + all `SkillBadge`s keep default styling.
- ⓡ **Cancelled-card legibility:** the cancelled branch wraps players in an `opacity-60` parent, which would also dim the ring and may fail contrast. Apply the ring on an element **outside** the `opacity-60` wrapper (or bump ring weight/opacity specifically for that branch). This is a Phase-4 **explicit contrast check**, not just "does it render."
- ⓡ **Partner = final roster:** if the selected player's partner was swapped mid-match, the highlighted partner is the one who *finished* — consistent with the predicate; the mid-match swap is visible in `MatchEventTimeline`.
- One-line legend beneath the filtered list: `◍ solid = selected · ◌ dashed = partner`.

### 3.3 Access control — structural exclusion (the critical guarantee)

The role boundary is **physical component-tree separation**, not conditional rendering:

- `PlayerDashboard` imports only from `@/components/player`, `@/components/leaderboard`, `@/components/ui`, `@/components/notifications`, `@/components/auth` — **zero** imports from `@/components/organizer/*` ([player-dashboard.tsx](src/components/player/player-dashboard.tsx)).
- `MatchHistoryPanel` (and therefore the new filter) lives in `src/components/organizer/*`, mounted **only** by `OrganizerDashboard` ([organizer-dashboard.tsx:892](src/components/organizer/organizer-dashboard.tsx)).

**The filter UI is organizer-only by construction** — never imported, never passed as a prop, never conditionally rendered in the player subtree. No CSS `hidden` to bypass; the code does not exist in `PlayerDashboard`. **No new access code, server action, or RLS is required** — the feature is read-only over data the organizer already holds; adding a guard would be dead weight.

> **Boundary note (disclosed, not introduced):** `/organizer/[sessionId]` is reachable by any authenticated user (page-level role gate intentionally absent for multi-device anonymous auth; mutations are gated at the DB layer). This feature exposes **no mutation** and only re-renders already-visible read-only history — it neither widens nor narrows that posture.

---

## 4. Edge Cases

### 4.1 Players in the session who haven't played yet (empty state)

**Decision: they do NOT appear in the dropdown.** The option list is derived only from players present in completed/cancelled rosters (§2.2). Consequences:

- Every selectable name returns ≥1 match — **no dead-end selections**.
- **Safety-net empty state:** if `visibleMatches.length === 0` while a filter is active (realtime race, §2.3), show a compact in-panel message — `"No matches for {name} in this session yet."` — with an inline **Clear filter**, never a blank panel.
- ⓡ **Scope boundary (documented, not an accidental gap):** this filter **cannot** answer "has player X played yet?" — a never-played player is simply absent from the picker. That question belongs to the **Queue/roster** surfaces, not Match History. We state this explicitly so the absence reads as an intentional boundary, not a bug. *Rejected alternative:* sourcing the picker from the full session roster (queue/profiles) would require threading extra data into a panel that today takes only `sessionId` and would manufacture dead-end "0 games" selections — net negative for this feature's goal.

### 4.2 Cancelled matches ⓡ (corrected)

Cancelled matches **are** fetched (`.in("status", ["completed","cancelled"])`, [use-match-history.ts:39](src/hooks/use-match-history.ts)) and render with the existing muted (`opacity-60`, no score/timer) treatment. But "rows retained on cancel" is **path-dependent** — the first draft over-claimed it:

- **Organizer "Cancel match" button** ([match-lifecycle.ts:543-586](src/app/actions/match-lifecycle.ts)): updates `status='cancelled'` and only **reads** `match_players` to requeue. **Rows retained → every player on that match appears in their filtered list.** ✅
- **Leave-triggered cancel of an unfilled pending draft** ([20260511210001:44-50](supabase/migrations/20260511210001_atomic_server_actions_hotfix.sql)): the function **`DELETE`s the leaving player's `match_players` row first**, then cancels if the remaining roster < 4. **So the player whose departure triggered the cancel is NOT on the cancelled roster and will NOT appear under that match.** The ≤3 remaining players' rows persist and do filter correctly. This is the user's "player only in cancelled matches" edge case — it has a real exception that **must** be covered by a fixture/test, not asserted away.

### 4.3 Mid-game swaps

A swap **deletes** the out-player's `match_players` row and **inserts** the in-player's ([20260617000000:522-523](supabase/migrations/20260617000000_match_provenance_audit.sql)). The player who **finished** is on the roster and is the one matched by the predicate (correct, intuitive). A player swapped *out* won't appear under that match; the swap is preserved in `match_events` and surfaced by the card's `MatchEventTimeline`. No special handling needed beyond §4.2's note.

### 4.4 `player_id` is mutable mid-session (identity merge / rename) ⓡ NEW

The app has an identity-safety-net subsystem: `migrate_player_identity` runs `UPDATE match_players SET player_id = <new> WHERE player_id = <old>` (identity-safety-net migration), so a roster's `player_id` **changes** when a merge/rename runs. `useMatchHistory` refetches on realtime, so `matches`/`playerOptions` update — but a **bare** selected id (the design we rejected) would still hold the **old** value and silently produce an empty filter. **Mitigation:** we pin `{ id, display_name }` (§2.2) and the §2.3 reconcile surfaces the **kept-chip safety-net** when the pinned `selected.id` no longer resolves to any roster row — the stale selection stays visible (name pinned) and the organizer clears it explicitly. *(Re-mapping old→new id via the `identity_migrations` table is out of scope this iteration.)* Documented so `player_id` is never assumed immutable.

### 4.5 Realtime voids the selected player out of the option set ⓡ NEW

If the selected player is voided/merged out of `matches` entirely, they vanish from `playerOptions` while still being the active filter. Handled by (a) **pinning `{ id, display_name }` at selection time** so the chip still reads correctly, and (b) the §2.3 reconcile **kept-chip safety-net** (the filter is never silently dropped). The chip's name source is therefore explicit and independent of the live option list.

### 4.6 Duplicate display_names ⓡ NEW

The app has a duplicate-name-resolution subsystem; `Profile.collided_name` / `needs_rename` ([database.ts:105-114](src/types/database.ts)) confirm **two distinct `player_id`s can share a `display_name`.** The picker sorts/searches on name, so two "Maria Santos" rows could look identical. **Mitigation:** each row already shows a `SkillBadge` + game count; when two `playerOptions` share a normalized `display_name`, append a subtle disambiguator (short `player_id` suffix, e.g. `· a1b2`, in `text-cc-t3` mono). Filtering is by `player_id`, so selection remains unambiguous even when names collide — only the *visual* needs the suffix.

### 4.7 Singles / no partner & fallback profiles

- **Singles or degenerate roster:** `partnerIds` is empty → highlight the selected player only; the `.filter(...)` handles it with no extra branch.
- ⓡ **Fallback profile:** when a profile lookup misses, the hook substitutes a fallback (`createUnknownProfile`). Options/highlights key off `player_id`, so filtering still works; the row's `SkillBadge` may render `null` for an out-of-enum level ([skill-badge.tsx](src/components/ui/skill-badge.tsx)) — acceptable, but the row must not assume a badge always renders (use the name as the row's required content).

---

## 5. Phased Execution Steps (post-approval checklist)

> Genuinely test-first: write failing tests, then implement to green, then UI, then wiring, then the mandatory gates.

**Phase 1a — Write failing unit tests (red).** ⓡ
- [ ] `tests/unit/match-history-filter.test.ts` (`MHF-*`), authored against the not-yet-existing helper signatures, run via the existing Vitest setup (same as `tests/unit/month.test.ts`). Cases: predicate match / no-match; `null` selection → identity passthrough; **cancelled match included**; **leave-triggered cancel → leaver absent from that match** (§4.2 fixture); swapped-out player excluded (§4.3 fixture); singles → empty partners; option dedup + count + alpha sort; empty history → empty options; **duplicate display_name → two distinct option entries** (§4.6); `selectionStillValid` true when id is on any roster, false when absent-while-other-matches-exist (drives the kept-chip safety-net, **not** a hard clear — §2.3/§4.4).

**Phase 1b — Implement pure helpers (green).**
- [ ] `src/lib/match-history-filter.ts`: `filterMatchesByPlayer(matches, id)`, `derivePlayerOptions(matches)` (with collision disambiguation), `resolvePartnerIds(match, id)`, and a `selectionStillValid(matches, id)` reconcile predicate. Iterate to green.

**Phase 2 — New filter component.**
- [ ] `src/components/organizer/match-history-player-filter.tsx` (controlled; props §3.1). Reuse swap-sheet input + button-list + selected-row style; per-row `SkillBadge` + muted count + collision suffix; `cc-*` tokens, `ring-ring` focus; results **inline in flow**; `<button aria-pressed>` rows; visually-hidden `<label>` on the input; Escape clears.

**Phase 3 — Wire into the panel.**
- [ ] In `MatchHistoryPanel`: add pinned `selected` state; compute `playerOptions` + `visibleMatches` via Phase-1 helpers; add the §2.3 reconcile effect; render filter + active-filter chip (§1.2) + 1-click clear (§1.3); map the card over `visibleMatches`.
- [ ] Thread `selected` + `partnerIds` into **both** the completed and cancelled team-panel branches; add rings/glyphs (ring **outside** the `opacity-60` wrapper on the cancelled branch), legend, and the §4.1 safety-net empty state.
- [ ] Confirm **zero** changes to `useMatchHistory`, and **no** new server action / migration.

**Phase 4 — Validation.**
- [ ] `npx tsc --noEmit` · `npm run lint` · `npm run build` green; `MHF-*` suite green.
- [ ] Preview on the organizer **History** tab: select → list narrows + chip + count; selected/partner rings on completed **and** cancelled cards (**explicit contrast check** on the muted cancelled branch); ✕ and `Escape` clear; type-ahead at a large roster; duplicate-name rows visually distinguishable.
- [ ] **Reversible-action guard (§2.3):** revert a *filtered* player's only completed match via `FixRecordSheet` → the filter is **not** silently dropped; the kept-chip safety-net shows with an inline **Clear**.
- [ ] Confirm `PlayerDashboard` renders no filter UI (structural — no new import path reaches the player subtree).

**Phase 5 — Mandatory Code Review Gate (CLAUDE.md).**
- [ ] Spawn an independent review agent on `git diff HEAD` (correctness, edge cases, type safety, pattern consistency, regressions). Fix every "Needs fixes" and re-review until LGTM / Minor issues.

**Phase 6 — Docs (Autopilot mandate).**
- [ ] Update `APP_MANIFEST.md` (organizer Match History now supports per-player client-side filtering; note the path-dependent cancelled-roster and `player_id`-mutability semantics) and `MEMORY.md` (what shipped + the swapped-out / leave-cancel / identity-merge notes).

---

## Files Touched (summary)

| File | Change | Type |
|---|---|---|
| `src/lib/match-history-filter.ts` | `filterMatchesByPlayer` / `derivePlayerOptions` / `resolvePartnerIds` / `selectionStillValid` | **New (pure)** |
| `tests/unit/match-history-filter.test.ts` | `MHF-*` unit suite (incl. leave-cancel, swap, dup-name, stale-id) | **New** |
| `src/components/organizer/match-history-player-filter.tsx` | Controlled type-to-filter list | **New** |
| `src/components/organizer/match-history-panel.tsx` | Pinned state + memos + reconcile effect + chip + highlight in **both** branches | **Edit** |
| `APP_MANIFEST.md`, `MEMORY.md` | Feature + semantics docs | **Edit** |
| `useMatchHistory`, DB schema, server actions, RLS | **Untouched** | — |

---

## Open Questions for Approval

1. **Selector ✅** — confirm the **type-to-filter searchable list** (swap-sheet pattern), *not* a hand-rolled ARIA combobox and *not* a native select.
2. **Empty state ✅** — confirm the dropdown lists **only players who have played** (no dead-end selections), with the §4.1 scope-boundary note that "has X played yet?" is answered in the Queue/roster surface.
3. **Highlight encoding** — confirm **solid ring = selected / dashed ring = partner** (vs. coloring the whole team panel).
4. **Duplicate-name disambiguator** — confirm a short `player_id` suffix on colliding rows (vs. a different disambiguator).
5. **Scope** — confirm this stays **current-session, read-only, client-side** (no cross-session view, no new server action) for this iteration.
```
