# UX Critique Synthesis — Chillax Badminton App
> Comprehensive code-level UX audit across all surfaces, both light and dark mode.
> Methodology: full source file review of every component across all 10+ routes.

---

## Design Health Score (Nielsen's 10 Heuristics)

| # | Heuristic | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Visibility of System Status | 3/4 | Excellent pulsing dots + real-time alerts; TV board doesn't show session-ended state prominently |
| 2 | Match System / Real World | 4/4 | Consistent badminton language throughout (On Deck, Court, Rally); shuttlecock emoji on-brand |
| 3 | User Control & Freedom | 3/4 | Good: AlertDialogs on destructive actions, undo toasts on swaps. Missing: no undo for queue join/leave |
| 4 | Consistency & Standards | 2/4 | **FAIL**: 4 different "current user" highlight colors across surfaces; blue in Waitlist not in brand palette; magenta active tab in dark mode |
| 5 | Error Prevention | 3/4 | AlertDialog on Close Session; inline validation on score inputs. Missing: no safeguard against double-tap on "End Session" |
| 6 | Recognition Rather Than Recall | 4/4 | Icons paired with labels; session names always visible; player skill levels always shown |
| 7 | Flexibility & Efficiency | 2/4 | No keyboard shortcuts; no bulk actions for organizer; no quick re-queue after match ends |
| 8 | Aesthetic & Minimalist Design | 2/4 | **FAIL**: magenta active tab, blue waitlist highlight, missing dark mode on 4 player surfaces, AI-aesthetic scattered accents |
| 9 | Error Recovery | 3/4 | Error messages are plain English and non-technical; CourtTimePopover error is inline (correct) |
| 10 | Help & Documentation | 2/4 | PIN concept unexplained; "Auto Off" has no tooltip; "Mixed Level" badge unexplained |
| **Total** | | **28/40** | **Good — targeted fixes will push it to Excellent** |

---

## Anti-Patterns Verdict

**Partial fail — one critical AI slop tell + several consistency breaks.**

### 🚨 Critical Tell: Magenta Active Tab in Dark Mode
```tsx
// player-dashboard.tsx line 244
dark:text-[hsl(300_100%_70%)] dark:border-[hsl(300_100%_60%)]
```
`hsl(300deg 100% 70%)` is saturated hot pink / magenta. This has zero relationship to the brand's deep navy + amber + emerald palette. It looks like an arbitrary AI-generated color appended to a dark mode rule without any design rationale. It is the single clearest AI slop signal in the codebase and will immediately undermine user trust in the product's "smart and premium" brand claim.

### Scattered Blue Accent (4th accent color)
`WaitlistTab` uses `bg-blue-600`, `bg-blue-50/60`, `text-blue-900` for the "current player" highlight. The rest of the app uses: amber (pending/primary CTA), emerald (success/join), indigo (current user on leaderboard). Blue is a 5th accent that fits none of these. It reads as "I needed to distinguish this row and grabbed a random blue."

### TV Board Color Language Break
`SectionLabel` for "Active Courts" uses `bg-blue-500` dot + `bg-blue-100 text-blue-700` badge. The rest of the app uses **emerald** for in-progress states. The TV board viewer sees blue = in-progress but the player sees emerald = in-progress. Color language is broken across surfaces.

---

## Executive Summary

- **Health Score: 28/40 — Good (targeted fixes needed)**
- Issues: **3 P0, 6 P1, 8 P2, 5 P3**
- The strongest design work is in `MatchAlert`, `WrappedIntro`, and `QueueStatus` — these set the bar the rest of the app should match.
- The weakest areas are **dark mode coverage on player surfaces** and **color system consistency**.

---

## Detailed Findings by Severity

---

### P0 — Blocking

---

#### [P0] Magenta active tab in dark mode completely breaks brand identity

- **Location:** `src/components/player/player-dashboard.tsx` line 244
- **Category:** Anti-Pattern / Theming
- **Code:**
  ```tsx
  dark:text-[hsl(300_100%_70%)] dark:border-[hsl(300_100%_60%)]
  ```
- **Impact:** Hot pink/magenta is not in the design system. It violates every palette rule in globals.css. Any user who switches to dark mode on their phone will see neon pink tab indicators that conflict with the navy + amber + emerald palette. Brand-destroying.
- **Fix:**
  ```tsx
  // Active tab dark mode: use amber (the dark mode primary)
  dark:text-primary dark:border-primary
  // Or: use a white underline (matches organizer dashboard style)
  dark:text-white dark:border-white
  ```

---

#### [P0] Player dashboard `My Status` sub-tabs have zero dark mode support

- **Location:** `src/components/player/player-dashboard.tsx` lines 396–419 (QueueSubTab, sub-tab pill switcher)
- **Category:** Theming
- **Impact:** In dark mode, the Queue/History pill switcher renders as a pure white rectangle (`bg-slate-100`, `bg-white`, `text-slate-900`, `text-slate-500`) on the dark navy background. The active tab becomes an opaque white pill floating on dark. Visually incoherent and illegible.
- **Fix:**
  ```tsx
  // Pill container
  "flex rounded-xl bg-slate-100 dark:bg-muted p-1"

  // Active tab
  "bg-white dark:bg-background text-slate-900 dark:text-foreground shadow-sm"

  // Inactive tab
  "text-slate-500 dark:text-muted-foreground hover:text-slate-700 dark:hover:text-foreground"
  ```

---

#### [P0] WaitlistTab has no dark mode — white card on dark navy background

- **Location:** `src/components/player/waitlist-tab.tsx`
- **Category:** Theming
- **Impact:** The entire waitlist renders as a `bg-white` card with `divide-slate-100` dividers and hardcoded `bg-blue-50/60` / `bg-blue-600` row highlights. In dark mode the white card appears as a solid white block. Player names are `text-slate-900` which will be invisible on any dark parent.
- **Fix:** Systematic token substitution throughout:
  ```tsx
  // Card container
  "rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card overflow-hidden divide-y divide-slate-100 dark:divide-border"

  // "Me" row
  isMe ? "bg-blue-50/60 dark:bg-amber-950/20"   // align with leaderboard hero card

  // "Me" position badge
  isMe ? "bg-blue-600 dark:bg-amber-500 text-white"

  // Player name
  isMe ? "font-bold text-blue-900 dark:text-amber-200"
  // Note: change blue → amber to align "you" accent with the rest of the app

  // "You" label
  "text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-amber-400"
  ```

---

### P1 — Major

---

#### [P1] `ScoreInputCard` (player-side score submission) has no dark mode

- **Location:** `src/components/player/player-dashboard.tsx` lines 517–607 (ScoreInputCard function)
- **Category:** Theming
- **Impact:** The player score input card uses `bg-white shadow-sm`, `bg-slate-50`, `border-slate-200`, `bg-slate-100/70`, `text-slate-900`, `text-slate-500` throughout. In dark mode it will render as a harsh white card on the dark navy background — a severe visual disruption right at the most critical player interaction point (submitting their match score).
- **Fix:**
  ```tsx
  // Card wrapper
  "rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm"

  // Header row
  "border-b border-slate-100 dark:border-border bg-slate-50 dark:bg-muted px-4 py-3"

  // Score inputs
  "border border-slate-200 dark:border-border bg-white dark:bg-background
   text-slate-900 dark:text-foreground focus:ring-emerald-400 dark:focus:ring-emerald-500"

  // Submit button (already correct: bg-slate-900 text-white)
  // ✓ No change needed — solid slate is fine in both modes
  ```

---

#### [P1] TV Board uses blue for "Active Courts" — breaks the emerald = in-progress color language

- **Location:** `src/app/tv/[sessionId]/tv-board.tsx` — `SectionLabel` call for "Active Courts" (line 116–120)
- **Category:** Consistency / Theming
- **Impact:** The player's Live Courts Tab uses `bg-emerald-500` pulsing dot for in-progress matches. The TV board uses `bg-blue-500` for the same concept. A player watching the TV board while checking their phone will see two different colors for "match in progress." The color language is contradicted by the TV display — the one surface visible to everyone in the room.
- **Fix:**
  ```tsx
  // TV Board "Active Courts" section label
  dotColor="bg-emerald-500 animate-pulse"
  badgeClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
  ```

---

#### [P1] "Leave" button in player header is ~20×22px — catastrophically undersized for a destructive action

- **Location:** `src/components/player/player-dashboard.tsx` lines 194–200
- **Category:** Responsive / Accessibility
- **Code:**
  ```tsx
  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-red-400..."
  ```
  `py-1` = 4px top+bottom, `px-2` = 8px left+right. Actual height: ≈22px. WCAG 2.5.5 minimum: 44px.
- **Impact:** This button launches a destructive action (leaving the session). Courtside, on a phone, with sweaty hands, the chance of a mispress on a 22px red button next to two other 28px buttons is extremely high. The error is compounded because once you tap "Leave" accidentally and confirm in the dialog, your queue position is lost.
- **Fix:**
  ```tsx
  className="flex items-center gap-1 rounded-lg px-3 py-2.5 min-h-[44px] text-xs font-medium text-red-400..."
  ```

---

#### [P1] PIN visibility toggle is 18px tall — inaccessible on any touch device

- **Location:** `src/components/player/player-dashboard.tsx` lines 158–168
- **Category:** Accessibility / Responsive
- **Code:** `"flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] ..."`
  `py-0.5` = 2px top+bottom. Actual height: ~18px.
- **Impact:** Players who are older or have lower dexterity cannot reliably tap this. The PIN is how players reconnect if they lose their session — hiding it well is fine, but the toggle must be tappable.
- **Fix:**
  ```tsx
  "flex items-center gap-1 rounded-full bg-slate-100 dark:bg-muted
   px-3 py-2 min-h-[36px] text-[10px] font-mono text-slate-500 dark:text-muted-foreground
   hover:bg-slate-200 dark:hover:bg-muted/80 transition-colors"
  ```
  (36px is acceptable for an incidental control; 44px preferred but constrained by header density.)

---

#### [P1] "You" highlight color is inconsistent across every surface that shows the current user

- **Location:** Multiple components
- **Category:** Consistency
- **Impact:** A user who checks themselves across different tabs sees four different highlight colors:
  | Surface | "You" Color |
  |---------|------------|
  | Player Leaderboard hero card | Indigo (`border-indigo-200`, `bg-indigo-50/70`) |
  | Leaderboard row | Indigo (`bg-indigo-50/50 dark:bg-amber-950/15`) |
  | Waitlist tab | Blue (`bg-blue-50/60`, `bg-blue-600`) |
  | MatchAlert (on-deck) | Amber (`bg-amber-100`, `text-amber-900`) |
  | MatchAlert (in-progress) | Emerald (`bg-emerald-50`, `text-emerald-900`) |
  The MatchAlert uses contextual colors (amber/emerald) for state — that's correct. But the leaderboard using indigo and the waitlist using blue for the same "this is you" concept is a design system failure.
- **Fix:** Pick **one** non-state color for neutral "current user" identity (everywhere that isn't a match state). The leaderboard's indigo is the most established — standardize on it, or better, use the amber primary (which is the dark mode primary and feels more on-brand):
  ```tsx
  // Waitlist "me" row: migrate blue → amber to match leaderboard row dark mode
  "bg-amber-50/60 dark:bg-amber-950/20"
  // Position badge
  "bg-amber-500 dark:bg-amber-500 text-white"
  // Name text
  "font-bold text-amber-900 dark:text-amber-200"
  ```

---

#### [P1] Player tab bar missing ARIA tablist/tab roles

- **Location:** `src/components/player/player-dashboard.tsx` lines 233–253
- **Category:** Accessibility
- **Code:**
  ```tsx
  <div className="grid grid-cols-4 border-t ...">
    <button onClick={() => setActiveTab(key)} ...>
  ```
- **Impact:** Screen readers cannot identify these as a tab interface. The `aria-selected` state is never communicated. This is the primary navigation for every player's session experience.
- **WCAG:** 4.1.2 Name, Role, Value
- **Fix:**
  ```tsx
  <div
    role="tablist"
    aria-label="Session navigation"
    className="grid grid-cols-4 border-t ..."
  >
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabpanel-${key}`}
      id={`tab-${key}`}
      ...
    >
  ```
  Each content section also needs:
  ```tsx
  <div role="tabpanel" id={`tabpanel-${key}`} aria-labelledby={`tab-${key}`}>
  ```

---

### P2 — Minor

---

#### [P2] Leaderboard refresh button is 32×32px — below WCAG touch target

- **Location:** `src/components/leaderboard/leaderboard-page.tsx` lines 218–234
- **Category:** Accessibility / Responsive
- **Code:** `"flex items-center justify-center w-8 h-8 rounded-lg ..."`
- **Fix:** `"w-10 h-10"` (40px — acceptable for a secondary action).

---

#### [P2] `LiveCourtsTab` empty state and count badges have no dark mode

- **Location:** `src/components/player/live-courts-tab.tsx`
- **Category:** Theming
- **Issues:**
  - Empty state: `"bg-white"` card — no dark variant
  - Section count badges: `"bg-emerald-50 border border-emerald-200 text-emerald-700"` / `"bg-amber-50 border border-amber-200 text-amber-700"` — no dark variants
- **Fix:**
  ```tsx
  // Empty state card
  "rounded-2xl border border-dashed border-slate-200 dark:border-border bg-white dark:bg-card"

  // In-progress count badge
  "bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400"

  // On-deck count badge
  "bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400"
  ```

---

#### [P2] `QueueSubTab` paused and empty states use hardcoded slate/white — partial dark mode

- **Location:** `src/components/player/player-dashboard.tsx` lines 625–695
- **Category:** Theming
- **Issues:**
  - "Paused" state uses `dark:border-slate-600 dark:bg-slate-800/30` — raw slate values instead of design tokens
  - "Not in queue" empty state: `border-dashed border-slate-200 bg-white` — no dark variants
- **Fix:**
  ```tsx
  // Paused card
  "rounded-2xl border-2 border-slate-300 dark:border-border bg-slate-50 dark:bg-muted/50"

  // Empty state
  "rounded-2xl border border-dashed border-slate-200 dark:border-border bg-white dark:bg-card"
  ```

---

#### [P2] TV Board player names use team-colored text only in dark variant — light mode loses team A/B distinction

- **Location:** `src/app/tv/[sessionId]/tv-board.tsx` — `TvPlayerRow` component
- **Category:** Design / Consistency
- **Code:**
  ```tsx
  className={`...text-xl font-bold ${
    dark ? teamColor : "text-slate-800 dark:text-slate-100"
  }`}
  ```
  `teamColor` is `"text-sky-200"` (Team A) or `"text-amber-200"` (Team B) — these are only applied in dark mode (inside dark court cards). In light mode (on-deck cards), both teams have `text-slate-800`. Team A vs Team B identity relies solely on position (left/right column) — nothing color-based.
- **Fix:** In light mode, give Team A a subtle sky tint and Team B an amber tint for immediate visual differentiation:
  ```tsx
  className={`...text-xl font-bold ${
    dark
      ? teamColor
      : teamColor === "text-sky-200"
        ? "text-sky-800 dark:text-sky-200"
        : "text-amber-800 dark:text-amber-200"
  }`}
  ```

---

#### [P2] TV Board "Active Courts" section header uses blue dot — only emerald is consistent with brand

*(Already covered in P1 above — also affects the header label badge, listed here for completeness.)*

---

#### [P2] The "Auto Off" toggle has no tooltip/aria-description explaining what auto matchmaking does

- **Location:** `src/components/organizer/organizer-dashboard.tsx` — mobile auto toggle (line 407) + desktop equivalent
- **Category:** Help & Documentation
- **Impact:** First-time organizers don't know what enabling/disabling auto matchmaking changes. There's no explainer anywhere in the UI. An organizer on a busy session night could accidentally disable it and wonder why matches stop being called.
- **Fix:** Add `title` + `aria-description`:
  ```tsx
  title="Auto matchmaking: when ON, the engine automatically forms the next match when a court opens"
  ```
  Or add a `?` popover that explains the feature in one sentence, similar to the CourtTimePopover's threshold hint.

---

#### [P2] `QueueSubTab` Loading state is a plain `text-sm text-slate-400` paragraph with no dark mode

- **Location:** `src/components/player/player-dashboard.tsx` line 387
- **Code:** `<div className="py-16 text-center text-sm text-slate-400">Loading...</div>`
- **Fix:** Use token: `text-muted-foreground` (which handles dark mode automatically)

---

#### [P2] WrappedAwardCard uses `rare` rarity with violet (`rgba(139,92,246,...)`) — the only violet in the whole app

- **Location:** `src/components/wrapped/wrapped-award-card.tsx` — `RARITY_STYLES.rare`
- **Category:** Theming (minor — acceptable in the Wrapped context since it's a one-off celebration)
- **Impact:** The Wrapped awards screen is explicitly a dark-always surface (`// No dark: variants — capture div is always dark`), so this violet won't bleed into the main theme. However, if the awards screen ever becomes light-mode-aware, the violet will conflict. Low risk now but worth noting.
- **Fix:** Consider using purple (which is already used for "Advanced" skill level) instead of violet — one less accent hue. Or document the violet as intentionally scoped to the Wrapped overlay only.

---

#### [P2] Player lobby `/play` empty session state uses `text-muted-foreground text-sm` with two lines — insufficient hierarchy

- **Location:** `src/app/play/page.tsx` lines 75–82
- **Category:** Design
- **Impact:** When there are no active sessions, the player sees a dashed border box with two small muted-foreground lines. No heading, no icon. The player has no idea what action to take (come back later? Contact organizer? Something is broken?).
- **Fix:**
  ```tsx
  <div className="rounded-xl border border-dashed border-border p-8 text-center">
    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
      <span className="text-xl" aria-hidden="true">🏸</span>
    </div>
    <p className="text-sm font-semibold text-foreground">No active sessions yet</p>
    <p className="mt-1 text-xs text-muted-foreground">
      Ask an organizer to start one, or check back in a moment.
    </p>
  </div>
  ```

---

### P3 — Polish

---

#### [P3] `WaitlistTab` loading state uses `text-slate-400` instead of design token

- **Location:** `src/components/player/waitlist-tab.tsx` line 26
- **Code:** `"py-16 text-center text-sm text-slate-400"`
- **Fix:** `text-muted-foreground`

---

#### [P3] `LiveCourtsTab` loading state uses `text-slate-400` instead of design token

- **Location:** `src/components/player/live-courts-tab.tsx` line 29
- **Code:** `"py-16 text-center text-sm text-slate-400"`
- **Fix:** `text-muted-foreground`

---

#### [P3] Session stat separators in organizer header use `text-white/25` — borderline invisible

- **Location:** `src/components/organizer/organizer-dashboard.tsx` — header stat separators
- **Category:** Design
- **Fix:** `text-white/25` → `text-white/40`

---

#### [P3] TV Board skill level uses `violet` but SkillBadge uses `purple` for "Advanced"

- **Location:** `src/app/tv/[sessionId]/tv-board.tsx` line 288 — `TV_SKILL_CONFIG.advanced`
- **Code:** `{ dot: "bg-violet-500", abbr: "Adv" }`
- **Issue:** `SkillBadge` uses `bg-purple-100 text-purple-800` for advanced. The TV board uses its own reimplemented config with `violet` instead of `purple`. These are different Tailwind colors.
- **Fix:** Change `"bg-violet-500"` → `"bg-purple-500"` to align with SkillBadge.

---

#### [P3] `LeaderboardPage` "Change session" back button is `text-xs` with no minimum touch target

- **Location:** `src/components/leaderboard/leaderboard-page.tsx` lines 311–322
- **Code:** `"flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"`
- **Impact:** The "‹ Change session" text link is ~14px tall with no padding. Difficult to tap on mobile.
- **Fix:** `"flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-2 -my-2"` (negative margin trick to extend tappable area without affecting layout)

---

## Systemic Issues

### 1. Dark Mode Coverage: Player-Specific Components Are Consistently Untreated

The organizer dashboard has comprehensive dark mode coverage. But components that live only in the player experience (`ScoreInputCard`, sub-tab pill switcher, `WaitlistTab` internals, loading states) were left in light-mode-only Tailwind classes. This suggests dark mode was added to organizer components in one focused pass, and player components weren't revisited.

**Recommendation:** Audit every component under `src/components/player/` for missing `dark:` variants. The pattern is consistent: any `bg-white`, `bg-slate-X`, `text-slate-X`, `border-slate-X` without a `dark:` counterpart is a gap.

---

### 2. "Current User" Identity Color Has 4 Different Answers

| Surface | Color Used |
|---------|-----------|
| Leaderboard hero card | Indigo border + indigo bg |
| Leaderboard table row (dark) | Amber tint (`dark:bg-amber-950/15`) |
| Waitlist position badge | Blue-600 |
| Waitlist row background | Blue-50/60 |
| MatchAlert (waiting) | Amber tint |
| MatchAlert (in-progress) | Emerald tint |

The MatchAlert colors are contextually correct (amber = wait, emerald = go). Everything else should converge on **one** identity color. The leaderboard dark mode already uses amber (`dark:bg-amber-950/15`) which aligns with the dark primary. Go all-in on amber as the "you" identity color in dark mode, and indigo in light mode (already established by the hero card).

---

### 3. TV Board Is a Self-Contained Color Universe

The TV board reimplements its own skill level config (with `violet` instead of `purple`), its own "current user" concept (N/A — it's spectator-only), and uses `blue` for in-progress status instead of `emerald`. It was clearly built in isolation from the rest of the design system.

**Recommendation:** Extract skill level config to a shared file (`src/lib/skill-config.ts`) that both `SkillBadge` and `TvBoard` import from. This prevents the drift from recurring. Also align TV's section dot color to `emerald` for in-progress.

---

### 4. Touch Target Failures Are Concentrated in Incidental Controls, Not Primary Actions

The primary actions (QueueToggle's Join/Leave button at `py-5` = 44px+, MatchAlert dismiss at full-width, organizer's Call Next Match) are all correctly sized. The failures are in supporting controls: PIN toggle (18px), Leave button (22px), leaderboard refresh (32px).

This is a much better failure mode than having primary CTAs be too small — but these supporting controls can still cause real frustration, especially the Leave button which triggers a destructive flow.

---

## Positive Findings

### 1. MatchAlert Is the Strongest Design in the Codebase
The dual-state card (amber on-deck, dark navy in-progress) nails the "smart and premium" brief. The CSS grid with explicit col/row placement for the VS badge is technically precise. Fluid court name (`clamp(40px, 15vw, 72px)`) handles any court name without overflow. The pulsing ambient rings in the in-progress state create urgency without being obnoxious. This is the model to aspire to for all other cards.

### 2. WrappedIntro Animation System Is Genuinely Excellent
The 5-layer staged reveal (floating particles → ambient glow → ring burst → word slam → shimmer) uses only `transform` and `opacity` (GPU-only, except the single `color` animation on "WRAPPED" which is acceptable). `prefers-reduced-motion` collapses it all to 0.01ms. The timing script (0.2s icon, 0.7s SESSION, 0.95s WRAPPED, 3.0s tap-unlock) reads like a director's cut sheet. Professional-grade work.

### 3. QueueStatus Information Hierarchy Is Textbook
`#1` at `text-5xl font-extrabold` → "1st in line" at `text-sm` → "of 12 · ~8 min wait" at `text-xs muted`. Position-first, context-second, secondary stats tertiary. No competing elements. This is exactly right for a player checking their spot mid-conversation courtside.

### 4. QueueToggle Button Sizing Is WCAG-Perfect
`py-5 text-lg w-full rounded-2xl` = ~60px height, full width, large text. A physically exhausted post-match player can tap it accurately. This is the model for all primary player CTAs.

### 5. Leaderboard ARIA Is the Best in the Codebase
`role="tablist"`, `role="tab"`, `aria-selected`, `aria-label` on the scope switcher. This is the correct implementation that the player tab bar should follow.

### 6. Design Token Architecture Is Well-Conceived
The dark mode variables in `globals.css` (`--court-cyan-hsl`, `--court-lime-hsl`, `--amber-accent-hsl`) plus the philosophy comment ("feels like a lit sports hall, not a sci-fi terminal") show genuine design intent. The token escape rate is low compared to many codebases — most raw slate/white values that appear are in components that simply weren't revisited during the dark mode pass, not structural token avoidance.

### 7. WrappedAwardCard Rarity System Creates Genuine Hierarchy
The four-tier system (legendary → rare → uncommon → common) with appropriate border/background/glow scaling creates hierarchy without feeling arbitrary. The stagger timing (`200 + index * 90ms`) gives each card a moment to breathe. The inline styles are correctly justified by the html-to-image capture constraint.

---

## Recommended Implementation Order

### Phase 1 — Dark Mode Gap Fixes (1 dev session)
These are surgical and non-breaking:
1. **`player-dashboard.tsx`** — Fix magenta active tab, sub-tab pill switcher, ScoreInputCard, paused/empty states → use `dark:bg-muted`, `dark:bg-card`, `dark:text-foreground`, `dark:border-border`
2. **`waitlist-tab.tsx`** — Full dark mode pass + change blue → amber for "you" identity
3. **`live-courts-tab.tsx`** — Empty state and count badge dark variants
4. All loading states → `text-muted-foreground`

### Phase 2 — Color System Consistency (1 dev session)
5. **`tv-board.tsx`** — Change Active Courts dot from `blue-500` → `emerald-500`; change `violet-500` → `purple-500` for Advanced
6. **`waitlist-tab.tsx`** — Change "you" highlight from blue → amber (aligns with leaderboard dark mode)
7. Extract skill config to shared `src/lib/skill-config.ts`

### Phase 3 — Accessibility (1 dev session)
8. **`player-dashboard.tsx`** — Add `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls` to player tab bar
9. **`player-dashboard.tsx`** — Fix Leave button touch target → `min-h-[44px] px-3 py-2.5`
10. **`player-dashboard.tsx`** — Fix PIN toggle touch target → `min-h-[36px] py-2`
11. **`leaderboard-page.tsx`** — Refresh button `w-8 h-8` → `w-10 h-10`

### Phase 4 — Polish (1 dev session)
12. TV Board light-mode team name differentiation (sky/amber tints)
13. Empty session state on `/play` — add icon + heading
14. Auto matchmaking toggle — add `title` or popover explanation
15. Stat separator opacity `text-white/25` → `text-white/40`

---

## Verification Checklist

After Phase 1–2:
- [ ] Toggle dark mode on `/play/[sessionId]` → all tabs (My Status, Live Courts, Waitlist, Leaderboard) use dark surfaces, no white cards
- [ ] Toggle dark mode → active tab has amber/white underline, not magenta
- [ ] Waitlist "You" row uses amber, not blue, in both light and dark mode
- [ ] TV board "Active Courts" dot is green/emerald, not blue
- [ ] TV board "Advanced" skill dot matches SkillBadge's purple

After Phase 3:
- [ ] VoiceOver on player tab bar: tabs announced as "tab 1 of 4", aria-selected changes on tab switch
- [ ] "Leave" button minimum tap area 44px on a real phone (check with browser devtools mobile emulation)
- [ ] Leaderboard refresh button tap area 40×40px minimum

Re-run `/audit` after each phase to confirm score improvement.
