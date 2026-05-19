# Leaderboard UI/UX Design Specification

> **Phase:** Step 4 of 13 — Design Spec before component implementation.
> `/ui-ux-pro-max` reads this document before writing any component code.
> All Tailwind tokens reference the live theme in `src/app/globals.css`.

---

## 0. Source of Truth — Design Tokens

All colors come from the theme. No hex values. No `bg-white` or `text-black` — always a
tinted semantic token. The app's palette:

### Light Mode Tokens in Use

| Token | HSL | Effective color | Usage |
|---|---|---|---|
| `bg-background` | `0 0% 100%` | white | Page base |
| `bg-card` | `0 0% 100%` | white | Card surfaces |
| `bg-muted` | `210 40% 96.1%` | light slate | Recessed panels |
| `text-foreground` | `222.2 84% 4.9%` | near-black | Body text |
| `text-muted-foreground` | `215.4 16.3% 46.9%` | medium grey | Secondary text |
| `border-border` | `214.3 31.8% 91.4%` | light grey | Dividers |
| `text-primary` | `222.2 47.4% 11.2%` | dark navy | Headings, rank |

### Dark Mode Tokens in Use (Court Nights)

| Token | HSL | Effective color | Usage |
|---|---|---|---|
| `dark:bg-background` | `217 28% 8%` | deep navy | Page base |
| `dark:bg-card` | `217 25% 11%` | lifted navy | Card surfaces |
| `dark:bg-muted` | `217 20% 14%` | recessed navy | Alt rows, panels |
| `dark:text-foreground` | `220 12% 92%` | warm off-white | Body text |
| `dark:text-muted-foreground` | `220 10% 52%` | medium grey | Secondary text |
| `dark:border-border` | `217 18% 22%` | navy border | Dividers |
| `dark:text-primary` | `38 92% 52%` | warm amber | Accent headings |
| `dark:accent` | `82 58% 40%` | lime-green | Active indicators |

### Status Colors (reused from app conventions)

| Semantic | Light | Dark | Usage |
|---|---|---|---|
| Win / Up | `text-emerald-600` | `dark:text-emerald-400` | Wins, rank up arrow |
| Loss / Down | `text-red-500` | `dark:text-red-400` | Losses, rank down arrow |
| Neutral | `text-slate-400` | `dark:text-muted-foreground` | No change, draw |
| Highlight (you) | `bg-indigo-50` | `dark:bg-amber-950/20` | Current user row tint |

---

## 1. Component Architecture & Variants

### The `variant` Prop — Feature Gate Matrix

```
LeaderboardPage
  props: sessionId, sessionName?, currentUserId, variant
```

| Feature | `standalone` | `player-panel` | `organizer-panel` |
|---|---|---|---|
| Page header (back nav + session name) | ✅ | ❌ | ❌ |
| "This Session / All-Time" tab toggle | ✅ | ❌ (session only) | ❌ (session only) |
| Hero Card (personal rank pin) | ✅ if authenticated | ✅ always | ❌ |
| Advanced Stats toggle | ✅ | ❌ | ✅ |
| Row truncation (top 10 only) | ❌ | ✅ | ❌ |
| Rank movement column (↑↓) | ✅ All-Time only | ❌ | ❌ |
| "View full leaderboard →" link | ❌ | ✅ | ✅ |
| Table row count | Unlimited | Top 10 + your row | Unlimited |

---

### 1a. `player-panel` Layout

Embedded inside the Player Dashboard as a 4th tab. Most players are on mobile.

```
┌─────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────┐   │
│  │ ★ YOU          7 GP · 5W–2L · 71.4% · 🔥×3 #4│   │  ← Hero Card
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  # · Player         GP  W–L    Win%                 │  ← Column header
│  ─────────────────────────────────────────────────  │
│  🥇  Ana · 🔥×5      9   8–1   88.9%                │
│  🥈  James           7   6–1   85.7%                │
│  🥉  Carlos          8   6–2   75.0%                │
│  4   Kai             6   4–2   66.7%                │
│  ... (top 10 total)                                 │
│  ─────────────────────────────────────────────────  │
│                       View Full Leaderboard →       │  ← Link at bottom
└─────────────────────────────────────────────────────┘
```

- Container: `px-4 py-4 space-y-3`
- No outer card wrapper — inherits the tab content area's background
- Table container: `rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden`

---

### 1b. `organizer-panel` Layout

Embedded as a 5th tab in the Organizer Dashboard. Organizers are on tablet/desktop.

```
┌─────────────────────────────────────────────────────────────────┐
│  [ Show Advanced Stats ▾ ]                 View Public Board ↗  │  ← Controls bar
│                                                                 │
│  # · Player           GP   W–L     Win%   [PF   PA   +/-]      │  ← Header
│  ───────────────────────────────────────────────────────────    │
│  🥇  Ana · 🔥×5        9    8–1    88.9%  [145  72   +73]      │
│  🥈  James             7    6–1    85.7%  [108  61   +47]      │
│  ...  (all qualified players, no truncation)                    │
└─────────────────────────────────────────────────────────────────┘
```

- Container: `px-6 py-4 space-y-3`
- Controls bar: `flex items-center justify-between mb-3`
- Advanced columns visible between `[ ]` only when toggle is ON

---

### 1c. `standalone` Layout

Public page at `/leaderboard/[sessionId]`. Designed for phones, shared links, and TV projection.

```
┌──────────────────────────────────────┐
│  ← Gym Name · Session Name   🌙       │  ← Header (sticky, `bg-[#1D3A6F]` matching organizer)
├──────────────────────────────────────┤
│  [ This Session ]  [ All-Time  ]      │  ← Tab toggle (pill style)
│                                      │
│  ┌─────────────────────────────────┐  │
│  │ ★ YOU  #4 · 71.4% · 7GP · 🔥×3 │  │  ← Hero Card (auth only)
│  └─────────────────────────────────┘  │
│                                      │
│  [Show Advanced Stats ▾]              │  ← Toggle
│                                      │
│  # · Player        GP  W–L   Win%    │  ← Column header
│  ─────────────────────────────────   │
│  🥇  Ana · 🔥×5     9   8–1  88.9%  │
│  ...                                 │
└──────────────────────────────────────┘
```

- Max width: `max-w-2xl mx-auto` — readable on TV when projected (not full-width on large screens)
- Header: `bg-[#1D3A6F] dark:bg-[hsl(217_30%_11%)]` — matches the organizer dashboard header exactly
- Header text: `text-white`

---

## 2. The Hero Card (Pinned Logged-In User)

The Hero Card must be instantly recognizable as "yours." The key visual cues are:
- A **colored border** (2px, not 1px) in a different hue from all other borders
- A **tinted background** that contrasts with regular card/row surfaces
- A **larger rank number** — `text-3xl` vs. `text-sm` for table rows
- A **"★ YOU" label** in a discrete position

### Visual Anatomy

```
┌─ border-2 border-indigo-300 dark:border-amber-500/60 ──────────────────┐
│  bg-indigo-50 dark:bg-amber-950/30  shadow-md                          │
│                                                                         │
│  #4    Miguel Santos      7 GP   5W–2L   71.4%   🔥🔥🔥     ★ YOU     │
│  ↑                                                           ↑          │
│  text-3xl font-black                              text-[10px] font-bold  │
│  text-indigo-700 dark:text-amber-400              uppercase tracking-   │
│                                                   widest text-indigo-400 │
│                                                   dark:text-amber-500   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tailwind Class Recipe

```
Outer wrapper:
  rounded-2xl border-2
  border-indigo-300 dark:border-amber-500/60
  bg-indigo-50 dark:bg-amber-950/30
  shadow-md dark:shadow-amber-900/20
  px-4 py-3

Rank number:
  text-3xl font-black tabular-nums
  text-indigo-700 dark:text-amber-400
  min-w-[2.5rem]

Name:
  text-sm font-bold text-foreground flex-1 min-w-0 truncate

Stats (GP / W-L / Win%):
  text-sm font-semibold tabular-nums text-foreground

Streak (🔥):
  text-sm (inline after name)

"★ YOU" label:
  text-[10px] font-bold uppercase tracking-widest
  text-indigo-500 dark:text-amber-500
  shrink-0 ml-auto
```

### States

| State | Display |
|---|---|
| Qualified (≥ min GP) | Full stats: rank, GP, W-L, Win%, streak |
| Below threshold | `"Play N more game(s) to appear on the leaderboard"` — muted text, no rank shown |
| Not authenticated (public page) | Component not rendered |
| Zero games played | `"You haven't played yet this session"` |

### Below-Threshold State Card

```
Same border/background treatment (so it's still clearly "your" card)
Icon: Trophy from lucide-react, h-5 w-5 text-indigo-400 dark:text-amber-500
Text: "text-sm font-medium text-indigo-700 dark:text-amber-400"
Subtext: "text-xs text-muted-foreground"
```

---

## 3. Leaderboard Table

### 3a. Row Structure (flex, not `<table>`)

Each row is a `div` with `flex items-center` and fixed-width stat columns.
This matches the existing app's list patterns and avoids `<table>` styling complexity.

```
Row container:
  flex items-center min-h-[44px] px-3 border-b border-slate-100
  dark:border-border last:border-b-0
  transition-colors duration-150
  hover:bg-slate-50/80 dark:hover:bg-muted/30

Current-user row (in full table):
  bg-indigo-50/50 dark:bg-amber-950/15 (lighter than Hero Card — not the same)
```

### 3b. Column Widths & Alignment

```
Rank:        w-7   shrink-0   text-center font-black
Player:      flex-1 min-w-0   text-left   (truncate long names)
GP:          w-8   shrink-0   text-right  tabular-nums text-xs
W-L:         w-14  shrink-0   text-right  tabular-nums text-sm font-semibold
Win%:        w-16  shrink-0   text-right  tabular-nums text-sm font-bold
Rank Δ:      w-11  shrink-0   text-right  (all-time tab only)
── advanced ──────────────────────────────────────────
PF:          w-10  shrink-0   text-right  tabular-nums text-xs text-muted-foreground
PA:          w-10  shrink-0   text-right  tabular-nums text-xs text-muted-foreground
+/-:         w-10  shrink-0   text-right  tabular-nums text-xs (colored — see below)
```

On mobile (`< 375px`), GP column is hidden (`hidden sm:block`). W-L shrinks to a compact
`5W-2L` format. Win% remains visible — it's the primary metric.

### 3c. Column Header Row

```
Same flex layout as data rows, but:
  bg-muted/60 dark:bg-muted/40
  text-[10px] font-bold uppercase tracking-wider
  text-muted-foreground
  border-b-2 border-slate-200 dark:border-border  ← thicker separator
  min-h-[36px] (smaller than data rows — not a tap target)
```

### 3d. Rank Medal Treatment

| Rank | Visual | Tailwind |
|---|---|---|
| #1 | `🥇` emoji | `text-base leading-none` inline, no additional styling |
| #2 | `🥈` emoji | `text-base leading-none` |
| #3 | `🥉` emoji | `text-base leading-none` |
| #4+ | Number | `text-sm font-bold tabular-nums text-muted-foreground` |

**Critical:** Do NOT style the medal emojis with extra color, shadow, or ring. Let the
emoji render natively. Adding CSS effects to emojis reads as AI slop immediately.

---

## 4. Gamification Elements

### 4a. 🔥 Win Streak — Rendering Rules

| Streak | Display | Rationale |
|---|---|---|
| 0–2 | Nothing | Not shown — not earned |
| 3 | `🔥🔥🔥` | Three flames — maximum inline emoji before switching to shorthand |
| 4 | `🔥×4` | Shorthand begins at 4 to prevent layout sprawl |
| 5+ | `🔥×N` | N is the streak count |

**Placement:** Inline after the player's display name, separated by a single space.
Rendered as a `<span>` inside the player name cell:

```
<span class="text-xs font-medium text-orange-500 dark:text-orange-400 ml-1 shrink-0">
  🔥×5
</span>
```

The streak span uses `shrink-0` so the flames never truncate before the player name does.
Player name truncates first (`truncate` on the name span). The streak is always fully visible.

**Streak color:** `text-orange-500 dark:text-orange-400`
This is NOT `text-amber-500` (which is the dark mode primary — don't overload that token).
Use `text-orange-500` — a distinct, energetic tone for streaks.

---

### 4b. Rank Movement (All-Time Tab Only)

Displayed in its own column (`w-11`) to the right of Win%.

| State | Display | Classes |
|---|---|---|
| Moved up (+N) | `↑2` | `text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400` |
| Moved down (−N) | `↓1` | `text-xs font-bold tabular-nums text-red-500 dark:text-red-400` |
| No change (0) | `—` | `text-xs text-muted-foreground` |
| New entrant (null) | `NEW` | `text-[10px] font-bold uppercase tracking-wider text-amber-500` |

**No arrow emoji** (🟢🔴) — use plain `↑` / `↓` Unicode characters. Arrow emoji render
inconsistently across Android/iOS and look cheap. The text arrows `↑↓` render as the font
character and look intentional.

**Example rendering:**
```
↑2   (emerald)
↓1   (red)
—    (muted grey)
NEW  (amber, uppercase, tracked)
```

---

### 4c. Point Differential (+/-) in Advanced Stats

When Advanced Stats are shown, the `+/-` column uses directional color:

| Value | Classes |
|---|---|
| Positive (> 0) | `text-emerald-600 dark:text-emerald-400 font-semibold tabular-nums` |
| Negative (< 0) | `text-red-500 dark:text-red-400 font-semibold tabular-nums` |
| Zero | `text-muted-foreground tabular-nums` |

Display format: `+14` / `−7` / `0` — use `+` prefix for positives explicitly.

---

## 5. Advanced Stats Toggle

### Anatomy

```
[ Show Advanced Stats ▾ ]
```

A single button above the table's right edge (aligned `justify-end`):

```
<button
  class="flex items-center gap-1.5 rounded-lg border border-slate-200
         dark:border-border px-3 text-xs font-medium text-muted-foreground
         hover:text-foreground hover:bg-muted/50 transition-colors
         min-h-[36px]"   ← 36px is fine here (not a primary CTA — 44px for critical targets)
>
  <span>Show Advanced Stats</span>
  <ChevronDown class="h-3.5 w-3.5 transition-transform duration-200
                      [open:rotate-180]" />  ← rotate via data-state or conditional class
</button>
```

**When open:** button label changes to "Hide Advanced Stats", chevron rotates 180°.

**Transition:** The 3 extra columns expand/collapse using a horizontal container that
transitions `max-width` from `0` to the column total. No height animation — just
width (avoids reflow jank on mobile).

**Position in layout:**
- `organizer-panel`: top-right of the controls bar
- `standalone`: above the table, right-aligned

**NOT shown in `player-panel`** — the compact view never exposes advanced stats.

---

## 6. Loading Skeleton

When `loading === true`, show pulse skeletons instead of the table:

```
── Hero Card skeleton ──────────────────────────
<div class="h-14 rounded-2xl border-2 border-indigo-200/50 dark:border-amber-900/30
            bg-slate-100 dark:bg-muted animate-pulse" />

── Column header skeleton ──────────────────────
<div class="h-8 rounded-lg bg-slate-100 dark:bg-muted animate-pulse" />

── 5 row skeletons ─────────────────────────────
{[...5].map(() => (
  <div class="h-11 border-b border-slate-100 dark:border-border
              flex items-center px-3 gap-3 animate-pulse">
    <div class="w-7 h-4 rounded bg-slate-200 dark:bg-muted-foreground/20" />
    <div class="flex-1 h-4 rounded bg-slate-200 dark:bg-muted-foreground/20" />
    <div class="w-10 h-4 rounded bg-slate-200 dark:bg-muted-foreground/20" />
    <div class="w-12 h-4 rounded bg-slate-200 dark:bg-muted-foreground/20" />
    <div class="w-14 h-4 rounded bg-slate-200 dark:bg-muted-foreground/20" />
  </div>
))}
```

---

## 7. Empty States

Matches the existing pattern from `match-history.tsx`:

```
<div class="rounded-2xl border border-dashed border-slate-200
            dark:border-border bg-white dark:bg-card px-6 py-12 text-center">
  <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center
              rounded-full bg-slate-100 dark:bg-muted">
    <Trophy class="h-5 w-5 text-slate-400 dark:text-muted-foreground" />
  </div>
  <p class="text-sm font-medium text-slate-600 dark:text-foreground">
    [Primary message]
  </p>
  <p class="mt-1 text-xs text-slate-400 dark:text-muted-foreground">
    [Secondary message]
  </p>
</div>
```

| Condition | Primary | Secondary |
|---|---|---|
| 0 completed matches | "No matches yet" | "Scores will appear here once matches are completed." |
| < min GP qualified players (session) | "Not enough data yet" | "Players need 3+ games to appear on the board." |
| < min GP qualified players (all-time) | "All-time board is building" | "Players need 10+ games to earn a lifetime ranking." |

---

## 8. Live Update Flash (Rank Change Animation)

When `useLeaderboard` re-fetches after a match completes, some rows will change rank.
Briefly flash those rows to signal the update.

**Implementation:** The hook tracks `prevRanks: Map<string, number>` before each refresh.
After the new rows arrive, rows where `newRank !== prevRank` receive a `data-flash="true"`
attribute for 800ms, then it's removed.

**CSS rule:**
```css
/* In globals.css */
[data-flash="true"] {
  @apply bg-amber-50 dark:bg-amber-950/25;
}
```

**Transition:**
```
transition-colors duration-[800ms] ease-out
```

Set `data-flash="true"` on mount of the new data, then `setTimeout(() => remove, 800)`.

**Reduced-motion:** The existing `@media (prefers-reduced-motion: reduce)` rule in
`globals.css` already collapses transitions to `0.01ms` — no extra handling needed.

---

## 9. Session Tab Toggle (Standalone Only)

Pill toggle matching the existing player dashboard sub-tab style:

```
<div class="flex rounded-xl bg-slate-100 dark:bg-muted p-1 self-center mx-auto w-fit">
  <button
    class="px-5 py-1.5 rounded-lg text-sm font-semibold transition-colors
           [active]: bg-white dark:bg-card text-foreground shadow-sm
           [inactive]: text-muted-foreground hover:text-foreground"
  >
    This Session
  </button>
  <button ...>All-Time</button>
</div>
```

Position: below the Hero Card, above the Advanced Stats toggle.

---

## 10. Anti-Pattern Checklist for `/ui-ux-pro-max`

These are explicitly forbidden during implementation:

| Anti-Pattern | Why it fails | Correct alternative |
|---|---|---|
| `bg-white text-black` anywhere | Pure white/black — sterile, no personality | Use `bg-card` / `text-foreground` (tinted by the theme) |
| Gradient text on player names | AI slop signal #1. Scream of a generated UI. | Plain `text-foreground font-bold` |
| Glassmorphism on Hero Card | `backdrop-blur` + `bg-white/10` — 2021 trend, reads as template UI | Use solid tinted bg: `bg-indigo-50 dark:bg-amber-950/30` |
| `<div>` card grid for table rows | Destroys column alignment across rows | Flex rows with fixed-width stat columns (Section 3b) |
| CSS bounce easing on rank updates | Bouncing numbers feel playful-cheap for a sports leaderboard | `ease-out` only. Fast settle. |
| `text-gray-500` anywhere | Inconsistent with theme tokens | `text-muted-foreground` |
| Hard-coded hex colors | Breaks dark mode | CSS token only — see Section 0 |
| Emoji medals with glow/shadow | Cheap visual inflation | Naked emoji, no decoration |
| Pulsing/spinning loading icons | Distracting on a small panel | Pulse skeleton rows only (Section 6) |
| Showing 0-streak players a flame | Misleading gamification | Render nothing below streak < 3 |
| `justify-center` on table data | Stat columns look wrong centered | Right-align all numeric columns (`text-right`) |
| Truncating the streak before the name | 🔥×5 becomes invisible, frustrating | `shrink-0` on streak span, `truncate` on name |

---

## 11. Responsive Breakpoints

| Viewport | Adjustments |
|---|---|
| < 375px (very small phone) | Hide `GP` column. `W–L` shrinks to `5W-2L`. No other changes. |
| 375px – 640px (standard phone) | Default layout as specced above |
| 640px+ (tablet / organizer) | Advanced stats columns fit without horizontal scroll |
| TV / large display (standalone) | `max-w-2xl mx-auto` constrains width for readability |

Advanced stats on mobile: the table container gets `overflow-x-auto` when advanced is ON,
allowing horizontal scroll. Do NOT break columns onto separate lines.

---

## 12. Accessibility Requirements

| Requirement | Implementation |
|---|---|
| All interactive elements ≥ 44px touch target | Rows are `min-h-[44px]`. Advanced toggle is `min-h-[36px]` (not a primary action — acceptable) |
| Color is not the only indicator | Rank movement uses both color AND `↑↓` text characters |
| Reduced motion respected | Existing `globals.css` `@media (prefers-reduced-motion)` rule covers all transitions |
| Screen reader row labels | Each row needs `aria-label="Rank N, [player name], [W-L], [Win%]"` |
| Hero Card identified | `aria-label="Your current rank: #N"` on the Hero Card wrapper |
| Live region for updates | Wrap the table in `aria-live="polite"` so rank changes are announced |

---

## 13. File Map for `/ui-ux-pro-max`

When implementing, create these files in this order:

```
src/hooks/use-leaderboard.ts                          ← Data + state hook
src/components/leaderboard/leaderboard-hero-card.tsx  ← Personal rank card
src/components/leaderboard/leaderboard-row.tsx         ← Single data row
src/components/leaderboard/leaderboard-table.tsx       ← Table + header + rows
src/components/leaderboard/advanced-stats-toggle.tsx   ← Toggle button
src/components/leaderboard/leaderboard-page.tsx        ← Main orchestrator
src/app/leaderboard/[sessionId]/page.tsx               ← Public route
```

Then wire into:
```
src/components/player/player-dashboard.tsx   ← Add 4th tab
src/components/organizer/organizer-dashboard.tsx ← Add 5th tab
```
