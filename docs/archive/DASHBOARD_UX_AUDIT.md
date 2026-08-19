# Organizer Dashboard — UX Audit

> **Audit Date:** 2026-04-17
> **Method:** Static code analysis (9 source files)
> **Auditor:** Lead UI/UX Design + Staff Frontend Engineering review

---

## Files Audited

| File | Role |
|------|------|
| `src/components/organizer/organizer-dashboard.tsx` | Shell, header, tab nav |
| `src/components/organizer/active-courts.tsx` | Court cards, VS graphic |
| `src/components/organizer/on-deck-panel.tsx` | On-deck match cards + empty state |
| `src/components/organizer/score-input-modal.tsx` | Score entry dialog |
| `src/components/organizer/queue-control.tsx` | Player queue table, manual match creation |
| `src/components/organizer/wait-time-monitor.tsx` | Wait time card list |
| `src/components/organizer/match-history-panel.tsx` | Completed match history |
| `src/components/ui/skill-badge.tsx` | Skill level badge shared component |
| `src/app/globals.css` | Design tokens |

---

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2/4 | Missing tablist/tab ARIA roles; header touch targets 20–28px (WCAG min 44px) |
| 2 | Performance | 3/4 | Mostly optimized; neon text-shadow glow on every dark-mode court card is wasteful |
| 3 | Theming | 2/4 | Hard-coded `#1D3A6F`, `#FAFAF7`, arbitrary HSL values; violet in score modal not in token system; skill badge has no dark mode |
| 4 | Responsive Design | 2/4 | Queue table `min-w-[640px]` forces horizontal scroll on tablets; critical stats hidden on mobile |
| 5 | Anti-Patterns | 2/4 | Gradient on "Call Next Match" button (explicit AI slop); neon glow; violet accent breaks palette |
| **Total** | | **11/20** | **Acceptable — significant work needed** |

---

## Anti-Patterns Verdict

**Partial fail.** Two clear AI-aesthetic tells:

1. `bg-gradient-to-r from-emerald-500 to-emerald-600` on the primary "Call Next Match" button — gradient CTAs are the #1 AI slop signal
2. `dark:[text-shadow:0_0_10px_hsl(80_100%_60%/0.7)]` neon glow on player names — conflicts directly with the "grounded gym environment" philosophy stated in the design tokens comment

The rest of the design is deliberate and purposeful. Fix these two and the aesthetic holds up well.

---

## Executive Summary

- **Score: 11/20 — Acceptable (significant work needed)**
- **Issues:** 3 P0, 5 P1, 7 P2, 4 P3
- **Critical issues:**
  1. All header action buttons below 44px touch target (P0 — courtside iPad use case)
  2. Tab nav missing tablist/tab ARIA roles — keyboard users cannot navigate between tabs (P0)
  3. Gradient on primary CTA — breaks visual credibility (P0 anti-pattern)
  4. Score modal uses violet accent not in the design system (P1)
  5. Skill badge has no dark mode variant — washed out on dark backgrounds (P1)

---

## Detailed Findings by Severity

### P0 — Blocking

---

**[P0] Header buttons below WCAG touch target minimum**
- **Location:** `organizer-dashboard.tsx` — all header action buttons
- **Category:** Responsive / Accessibility
- **Impact:** The dashboard is primarily used courtside on an iPad. Buttons are frequently missed under game pressure.
- **Measurements:**
  - Back button: `py-0.5 px-1` ≈ **20×24px** (WCAG minimum: 44×44px)
  - Session name/switcher button: `px-2 py-1` ≈ **24px** height
  - Auto-matchmaking toggle: `px-3 py-1` ≈ **24px** height
  - TV View: `px-3 py-1.5` ≈ **28px** height
  - End Session: `px-3 py-1.5` ≈ **28px** height
- **WCAG:** 2.5.5 Target Size (Level AA)
- **Fix:**
  ```
  Back button:     py-2 px-3 min-h-[44px]
  All header CTAs: min-h-[44px] flex items-center  (add to existing classes)
  Auto-matchmaking toggle: py-2 (was py-1)
  TV View / End Session:   py-2.5 (was py-1.5)
  ```

---

**[P0] Tab navigation missing ARIA tablist/tab roles**
- **Location:** `organizer-dashboard.tsx` lines 311–333 — the `<nav>` and `<button>` elements
- **Category:** Accessibility
- **Impact:** Screen reader users cannot identify the nav as a tab interface. Tab state not announced. `aria-selected` missing — VoiceOver reads all tabs as generic buttons.
- **WCAG:** 4.1.2 Name, Role, Value
- **Fix:**
  ```tsx
  // <nav> → add role="tablist" aria-label="Dashboard sections"
  // Each <button> → add role="tab" aria-selected={activeTab === tab.key} aria-controls={`tabpanel-${tab.key}`}
  // Each tab content div → add role="tabpanel" id={`tabpanel-${tab.key}`} aria-labelledby={`tab-${tab.key}`}
  ```

---

**[P0] Gradient on primary CTA ("Call Next Match")**
- **Location:** `active-courts.tsx` — "Call Next Match" button
- **Category:** Anti-Pattern
- **Impact:** `bg-gradient-to-r from-emerald-500 to-emerald-600` is the most common AI slop signal. Undermines visual credibility.
- **Fix:**
  ```
  Remove:  bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 transition-all hover:shadow-md
  Replace: bg-emerald-600 hover:bg-emerald-700 transition-colors
  ```

---

### P1 — Major

---

**[P1] Hard-coded hex colors `#1D3A6F` and `#FAFAF7`**
- **Location:** `organizer-dashboard.tsx` — header bg (light mode), active tab bg, body bg
- **Category:** Theming
- **Impact:** These values appear 4× each. A theme change or brand update requires touching each manually. The values are not connected to the CSS variable system in `globals.css`.
- **Fix:** Add CSS variables:
  ```css
  /* In globals.css :root */
  --organizer-header: 217 45% 27%;   /* #1D3A6F equivalent */
  --organizer-surface: 60 23% 97%;   /* #FAFAF7 equivalent */
  ```
  Then use `bg-[hsl(var(--organizer-header))]` or extract to a Tailwind config key. At minimum, create a JS constant:
  ```ts
  // At top of organizer-dashboard.tsx
  const HEADER_BG = "bg-[#1D3A6F] dark:bg-[hsl(217_30%_11%)]";
  const SURFACE_BG = "bg-[#FAFAF7] dark:bg-background";
  ```

---

**[P1] Skill badge has no dark mode variants**
- **Location:** `src/components/ui/skill-badge.tsx`
- **Category:** Theming
- **Impact:** `bg-emerald-100 text-emerald-800`, `bg-blue-100 text-blue-800`, `bg-purple-100 text-purple-800` are light-mode tints that render washed out on dark navy backgrounds. Every player row, queue table, and match history card is affected.
- **Fix:**
  ```tsx
  // Beginner
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
  // Intermediate
  "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
  // Advanced
  "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
  ```

---

**[P1] Score modal uses violet accent not in the design system**
- **Location:** `score-input-modal.tsx`
- **Category:** Theming / Anti-Pattern
- **Impact:** Violet (`bg-violet-600`, `bg-violet-50`, `text-violet-900`, `border-violet-200`) has no precedent in the token system. The app uses navy, amber, emerald, and red. This introduces a 5th accent that confuses the color language. Users may not understand "violet = Team A" vs "emerald = Team B" without prior context.
- **Fix:** Replace Team A violet with the app's primary navy/indigo:
  ```
  Team A label:  text-[10px] font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-400
  Team A input:  bg-indigo-50 border-indigo-200 text-indigo-900 focus:border-indigo-500
                 dark:bg-indigo-950/30 dark:border-indigo-800 dark:text-indigo-100
  ```

---

**[P1] Auto-matchmaking toggle has no `aria-pressed`**
- **Location:** `organizer-dashboard.tsx` — auto-matchmaking button
- **Category:** Accessibility
- **Impact:** Toggle state (ON/OFF) is conveyed only through color — not announced to screen readers. Organizers using assistive tech cannot tell if auto-matchmaking is on.
- **WCAG:** 4.1.2 Name, Role, Value
- **Fix:**
  ```tsx
  <button aria-pressed={autoMatchmaking} ...>
  ```

---

**[P1] Wait-time monitor "Remove" button critically undersized**
- **Location:** `wait-time-monitor.tsx` — remove player button
- **Category:** Responsive / Accessibility
- **Impact:** `px-2 py-1` ≈ 22×24px. This is a **destructive action** (removing a player from the queue) — it needs a larger target, not a smaller one. Courtside use makes accidental taps likely.
- **WCAG:** 2.5.5 Target Size
- **Fix:**
  ```
  Current:  "text-xs text-muted-foreground hover:text-destructive px-2 py-1 rounded"
  Fix:      "text-xs text-muted-foreground hover:text-destructive px-3 py-2 min-h-[44px] rounded-lg flex items-center"
  ```
  Consider wrapping in an `AlertDialog` for destructive confirmation — matches the queue-control checkout pattern.

---

### P2 — Minor

---

**[P2] Neon glow text effect on player names (dark mode)**
- **Location:** `active-courts.tsx` — `PlayerPill` component
- **Category:** Anti-Pattern / Performance
- **Impact:** `dark:[text-shadow:0_0_10px_hsl(80_100%_60%/0.7)]` is a CSS text-shadow applied on every render. On a court grid with 6+ courts (12+ players), this is 12+ paint layers. Also conflicts with the "grounded gym" dark theme aesthetic.
- **Fix:** Remove the text-shadow. Keep the lime-green color — the color alone creates sufficient contrast on the dark court surface:
  ```
  Remove: dark:[text-shadow:0_0_10px_hsl(80_100%_60%/0.7)]
  Keep:   dark:text-[hsl(80_100%_60%)]
  ```

---

**[P2] Arbitrary HSL values scattered in dark mode classes**
- **Location:** `match-history-panel.tsx`, `active-courts.tsx`, `organizer-dashboard.tsx`
- **Category:** Theming
- **Impact:** `dark:bg-[hsl(35_100%_55%)]/20`, `dark:border-[hsl(180_100%_70%)]`, `dark:text-[hsl(80_100%_60%)]` — magic numbers that won't update if the design tokens change and are difficult to audit.
- **Fix:** Extract recurring HSL values to CSS custom properties in `globals.css`:
  ```css
  .dark {
    --amber-accent-hsl: 35 100% 55%;   /* replaces hsl(35_100%_55%) */
    --court-cyan-hsl:   180 100% 70%;  /* court line color */
    --court-lime-hsl:   80 100% 60%;   /* player name color */
  }
  ```

---

**[P2] Queue table `min-w-[640px]` forces horizontal scroll on tablet portrait**
- **Location:** `queue-control.tsx` — table wrapper
- **Category:** Responsive Design
- **Impact:** An iPad in portrait mode is 768px wide — with padding, the 640px minimum table may cause horizontal overflow. The 8-column layout (checkbox, position, name, skill, wait, GP, pin, actions) is too dense for portrait tablet use.
- **Fix:** On `md` and below, collapse the PIN column (rarely needed live) and combine Wait/GP into one column. Or ensure the wrapper is `overflow-x-auto` with `-webkit-overflow-scrolling: touch`.

---

**[P2] Header stat display hidden on mobile — no fallback indicator**
- **Location:** `organizer-dashboard.tsx` — session stats in header
- **Category:** Responsive Design
- **Impact:** Courts / queue count / active matches are `hidden sm:inline`. On mobile, the organizer has no way to see session stats without switching tabs.
- **Fix:** Add a single compact stat summary visible only on mobile:
  ```tsx
  <span className="text-[10px] text-white/60 sm:hidden">
    {courts.length}c · {queue.length}q · {activeMatches.length}m
  </span>
  ```

---

**[P2] Action button hierarchy unclear in court card footer**
- **Location:** `active-courts.tsx` — court card footer buttons
- **Category:** Responsive / Design
- **Impact:** "Input Score & End" (primary action, slate-900) and "Cancel" (secondary, no background) are visually similar in weight. On a small court card, the primary action doesn't stand out enough under pressure.
- **Fix:**
  ```
  Primary:   Keep bg-slate-900, bump to py-2.5 min-h-[44px]
  Secondary: Add text-red-500 dark:text-red-400 (not just slate-500)
             "Cancel" as danger color distinguishes it from the primary CTA clearly
  ```

---

**[P2] "VS" dashed line is visually heavy (3px)**
- **Location:** `active-courts.tsx` — `BadmintonCourt` component, center divider
- **Category:** Design
- **Impact:** `border-t-[3px] border-dashed border-white/60 dark:border-[hsl(180_100%_70%)]` — a 3px dashed line at 60% opacity dominates the court graphic more than the player names.
- **Fix:**
  ```
  Current: border-t-[3px] border-dashed border-white/60 dark:border-[hsl(180_100%_70%)]
  Fix:     border-t border-dashed border-white/25 dark:border-[hsl(180_100%_70%)]/40
  ```
  1px at 25% opacity lets the VS circle be the focal point.

---

**[P2] `<DevTools>` button visible in production build**
- **Location:** `organizer-dashboard.tsx` — DevTools button in header
- **Category:** Anti-Pattern
- **Impact:** DevTools appears in the header for all organizers in production. It should be gated to development only.
- **Fix:**
  ```tsx
  {process.env.NODE_ENV === "development" && <DevTools ... />}
  ```

---

### P3 — Polish

---

**[P3] Session stat separators use `text-white/25` — barely visible**
- **Location:** `organizer-dashboard.tsx` — stat separators between courts/queue/matches
- **Category:** Theming
- **Impact:** The separators between "3 courts | 12 in queue | 2 active" are at 25% white opacity — functionally invisible on most displays.
- **Fix:** `text-white/25` → `text-white/40`

---

**[P3] Match history "cancelled" rows use `opacity-70` globally**
- **Location:** `match-history-panel.tsx` — cancelled match cards
- **Category:** Design
- **Impact:** Entire card at 70% opacity including the cancel icon and header, making it harder to read the "Cancelled" status label itself.
- **Fix:** Apply opacity only to the score section, not the full card:
  ```tsx
  // Card wrapper: remove opacity-70
  // Score/team section only: add opacity-60
  ```

---

**[P3] `rounded-t-lg` on tabs doesn't visually connect to content area**
- **Location:** `organizer-dashboard.tsx` — tab navigation
- **Category:** Design
- **Impact:** The active tab has `rounded-t-lg` (top corners rounded) suggesting it connects to the content below, but the content area has no matching `rounded-b-lg`. The tab shape is visually orphaned.
- **Fix:** Drop the border-radius. Use an underline indicator — consistent with the player dashboard's `border-b-2` tab pattern:
  ```
  Active: border-b-2 border-[#FAFAF7] text-white font-semibold bg-transparent
  ```

---

**[P3] Empty state on "No matches on deck" uses dot + text, no icon**
- **Location:** `on-deck-panel.tsx` — empty state
- **Category:** Design
- **Impact:** The muted dot indicator is easy to miss. Match history uses a centered icon+heading+subtext pattern which is far more scannable.
- **Fix:** Adopt the match-history pattern:
  ```tsx
  // rounded-full bg-slate-100 dark:bg-muted + icon (Clock or CalendarX, h-5 w-5) + heading + subtext
  ```

---

## Patterns & Systemic Issues

1. **Touch target inconsistency:** Queue control rows use `min-h-[44px]` correctly, but the header and wait-time-monitor are systematically undersized. All header buttons were sized for desktop hover states, not courtside iPad taps.

2. **Design token escape rate (~35%):** Every arbitrary HSL value (`hsl(35_100%_55%)`, `hsl(180_100%_70%)`, `hsl(80_100%_60%)`) and hex literal (`#1D3A6F`, `#FAFAF7`) is a future maintenance liability. A theme update would require touching a dozen scattered locations.

3. **Inconsistent empty state anatomy:** Three different patterns across tabs — on-deck (dot+text), queue-control (`p-12 text-center`, no icon), match-history (icon+heading+subtext). Pick one pattern and apply it everywhere.

4. **Slate vs token leakage:** `text-slate-400`, `text-slate-500`, `text-slate-600`, `bg-slate-50`, `border-slate-200` appear throughout `match-history-panel.tsx` and `active-courts.tsx`. These should use `text-muted-foreground`, `bg-muted`, `border-border` so they automatically update in dark mode.

---

## Positive Findings

1. **Queue table ARIA is excellent:** `role="row"`, `aria-selected`, `aria-disabled`, per-button `aria-label` with player names — the highest-quality ARIA implementation in the codebase.

2. **Score display uses `tabular-nums` correctly:** `text-3xl font-black tabular-nums` on scores prevents layout shift when numbers change — exactly right.

3. **Consistent disabled state:** `disabled:opacity-50 disabled:cursor-not-allowed` appears on every interactive element across all components.

4. **Dark mode coverage is deep:** Match history, queue control, and active courts all have thoughtful dark variants — comprehensive, with only a small number of escapees.

5. **Semantic color language is coherent:** Emerald = available/success, Amber = pending/warning, Red = danger/destructive, Slate = neutral — consistent across all tabs and rarely violated.

6. **On-deck panel responsive grid:** `grid-cols-1 → sm:grid-cols-2 → xl:grid-cols-3` matches the court grid exactly — the two panels feel visually coordinated.

7. **AlertDialog for destructive actions:** Checkout (queue control) uses a proper confirmation dialog. This pattern should be extended to the wait-time-monitor remove action.

---

## Recommended Implementation Order

1. **P0 fixes first** — header touch targets, tab ARIA roles, gradient button removal
   - Files: `organizer-dashboard.tsx`, `active-courts.tsx`

2. **P1 theming fixes** — skill badge dark mode, violet→indigo in score modal
   - Files: `skill-badge.tsx`, `score-input-modal.tsx`

3. **P1 a11y** — `aria-pressed` on auto-matchmaking, wait-monitor remove button size
   - Files: `organizer-dashboard.tsx`, `wait-time-monitor.tsx`

4. **P2 polish pass** — neon glow removal, VS line weight, slate→token color audit, DevTools env gate
   - Files: `active-courts.tsx`, `match-history-panel.tsx`, `organizer-dashboard.tsx`

5. **P3 polish** — empty state unification, tab indicator style, stat separator opacity
   - Files: `on-deck-panel.tsx`, `match-history-panel.tsx`, `organizer-dashboard.tsx`

---

## Verification Checklist

After fixes, verify each item:

- [ ] All interactive elements in header ≥ 44×44px (measure with browser DevTools)
- [ ] Tab keyboard navigation: Tab through page → tab buttons focusable → Enter activates tab → content changes
- [ ] VoiceOver / NVDA: Tab panel role announced, `aria-selected` state announced on focus
- [ ] Dark mode: toggle dark mode → skill badges legible and colored on all tabs
- [ ] Score modal: Team A uses indigo (not violet) in both light and dark mode
- [ ] Active courts: "Call Next Match" is solid `bg-emerald-600`, no gradient
- [ ] Player names in dark mode court view: lime-green color without glow
- [ ] Mobile (375px): header shows compact stat summary (`Nc · Nq · Nm`)
- [ ] DevTools button absent in production build (`NODE_ENV === "production"`)
