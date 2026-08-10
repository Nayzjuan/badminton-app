# Project: Marketing Site + Digital Twin — Demo Alignment + Polish

## Goal
Make `PlayerPhone.tsx` in the interactive sandbox visually identical to the real player app,
in BOTH the Digital Twin (dt) and the Marketing Site (ms). The DT is the source of truth —
all changes go there first, then propagate to the marketing site.

## Source-of-Truth Architecture

```
digital-twin/src/sandbox/        ← SOURCE — edit here first
  player/PlayerPhone.tsx           ← 268 lines AHEAD of marketing-site
  styles/global.css                ← Has correct fonts (Barlow Condensed, Chakra Petch, JetBrains Mono, etc.)

marketing-site/src/sandbox/      ← TARGET — sync from DT
  player/PlayerPhone.tsx           ← stale (old SkillBadge pills, old card-style alerts)
  styles/global.css                ← partially synced via `npm run sync` (@theme block only)
  scripts/sync-ui.ts               ← syncs ONLY the @theme {} block; does NOT sync fonts/keyframes/utilities

All other sandbox files (reducer, seed, types, useSandbox, components/*, engine/*)
are IDENTICAL between DT and marketing-site — no diff.
```

## Propagation rule after every phase
1. Edit `digital-twin/src/sandbox/player/PlayerPhone.tsx`
2. `cp digital-twin/src/sandbox/player/PlayerPhone.tsx marketing-site/src/sandbox/player/PlayerPhone.tsx`
3. If `digital-twin/src/styles/global.css` changed: `cd marketing-site && npm run sync`
   (syncs only the @theme block)
4. For CSS OUTSIDE @theme (font @import line, keyframe rules, utility classes like .clip-cut-tr):
   manually mirror those additions to `marketing-site/src/styles/global.css` in a separate section below the sync block.

---

## Current State Audit

### Digital Twin PlayerPhone.tsx — what's already done ✅
- `WaitlistTab` updated: sporty scoreboard, LINEUP 40px italic heading, indigo "you" row, BEG/INT/ADV abbrevs, GP stat
- `SKILL_CFG` uses plain `{ dot, abbr }` (no pill badge)
- `YOU_BG/TEXT/RANK` OKLCH constants defined

### Digital Twin PlayerPhone.tsx — what still needs updating ❌
- `MatchAlertCard` (on-deck + in-progress): still card-style, NOT full-screen overlay
- `QueueStatus`: still compact white card, NOT full-canvas 88px numeral
- `TeamsGrid` / `PlayerRow`: still rounded cards with amber/emerald ring, NOT flat dot+skill+name rows
- `LiveCourtsTab`: old simple grid, NOT the CourtMatchCard+match-roster style
- `MatchHistoryTab`: old simple win/loss list, NOT the stats bar + match cards real style
- Tab bar: text-only, wrong labels ("Courts"/"History"), no icons, header says "Badminton Queue"
- My Status sub-tabs: "History" is a top-level tab, not Queue/History segmented toggle inside My Status

### Digital Twin global.css — already has ✅
- Barlow Condensed (italic, 700/800/900), Chakra Petch, JetBrains Mono, Inter, Geist, Geist Mono
- `--font-display: "Barlow Condensed"`, `--font-command: "Chakra Petch"`, `--font-mono: "JetBrains Mono"`
- `status-pulse` keyframe
- `pp-alert-visible` / `pp-alert-hidden` (dead — real match-alert.tsx uses inline style transform)

### Digital Twin global.css — still missing ❌
- `cc-*` CSS tokens (light + dark variants) — needed for LiveCourtsTab CourtMatchCard
- `.clip-cut-tr` clip-path utility
- Note: `pp-alert-visible`/`pp-alert-hidden` are present but unused — remove in Phase 10

### Marketing Site global.css — already synced ✅
- `@theme {}` block (synced from DT)
- `status-pulse` ❌ (NOT synced — it's outside @theme, must be manually added)

### Marketing Site global.css — behind / missing ❌
- Font @import: only Barlow Semi Condensed, Geist, Geist Mono — missing Barlow Condensed, Chakra Petch, JetBrains Mono
- `--font-display`, `--font-command`, `--font-mono` not yet in marketing-site @theme (they're in DT's @theme — will sync via `npm run sync`)
- `status-pulse` keyframe (outside @theme — not synced automatically)
- `cc-*` tokens + `.clip-cut-tr` (not yet in DT either — need to add to DT first)

---

## Phases

### Phase 0 — DT global.css: Add missing utilities + clean up dead CSS
In `digital-twin/src/styles/global.css`:
1. Add `cc-*` CSS tokens as a new section (light + dark) — mirrors `src/app/globals.css`
2. Add `.clip-cut-tr` clip-path utility
3. Remove dead `pp-alert-visible` / `pp-alert-hidden` keyframes (not used by real or demo)

Then propagate to marketing-site:
- `npm run sync` (propagates @theme changes if any)
- Manually copy the non-@theme additions (cc-* section, .clip-cut-tr) to marketing-site/src/styles/global.css
- Also sync font @import line: add Barlow Condensed, Chakra Petch, JetBrains Mono to marketing-site's @import
- Copy `status-pulse` keyframe to marketing-site/src/styles/global.css

### Phase 1 — DT PlayerPhone: QueueStatus (waiting state)
Replace `QueueStatus()` in digital-twin PlayerPhone.tsx to match `queue-status.tsx`:
- No card border — full-canvas centered flex-col
- `#N` at **88px** (`font-display font-black`, letterSpacing -0.04em)
- Radial amber glow (`pointer-events-none absolute`, radial-gradient) when `position ≤ 2`
- Context line: "in line · N waiting" (text-sm muted)
- Thin rule: `h-px w-8 bg-slate-200`, my-7
- 3-stat row: `Nmin Waited / N Games / INT Skill` — each `text-lg tabular-nums`
- `OnDeckAlert` pill above numeral when position ≤ 4 (amber for 1-2, sky for 3-4)

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 2 — DT PlayerPhone: Drafted state
Replace drafted branch in `MyStatusTab()` to match `my-status-tab.tsx`:
- "Match Forming" at `text-3xl font-extrabold` (letterSpacing -0.02em), no emoji
- "Hang tight — you've been selected for the next match." body text
- Thin rule `h-px w-8 bg-slate-200`, my-7
- "Match forming" indicator text + "selected from N queued"
- Leave Queue button below

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 3 — DT PlayerPhone: On Deck overlay
Replace `MatchAlertCard` pending branch with full-screen absolute overlay.
Matches `match-alert.tsx` pending state exactly:
- `position: "absolute"; inset: 0; zIndex: 30; display: "flex"; flexDirection: "column"`
- Background: `oklch(0.78 0.17 62)` (amber canvas, same as real app)
- Slide-up: inline style `transform: visible ? "translateY(0)" : "translateY(100%)"`, transition 550ms
- Top-right pulsing dot: `h-2 w-2 rounded-full bg-amber-900/40`, status-pulse animation
- Pill: "You're On Deck" — `rounded-full bg-amber-900/15 ring-1 ring-amber-900/25 px-2.5 py-1`
- Sub-text: "Coming Up Next" (11px bold uppercase, amber-950/80)
- Hero: **"Heads\nUp."** `font-display font-black` at `clamp(56px, 16vw, 88px)`, text-amber-950
- Detail: "Find your team — a court is opening soon" (13px, amber-950/85)
- Divider: `h-px bg-amber-900/25`, mx-6 my-5
- TeamsGrid (see Phase 5)

Note: the phone screen div needs `position: "relative"` for the absolute overlay to scope correctly.
Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 4 — DT PlayerPhone: In Progress overlay
Replace `MatchAlertCard` in_progress branch with full-screen absolute overlay.
Matches `match-alert.tsx` in_progress state:
- `position: "absolute"; inset: 0; zIndex: 30`, `bg-white` (phone screen is light)
- Slide-up: 380ms cubic-bezier(0.16, 1, 0.3, 1)
- Top-right pulsing dot: `h-2 w-2 bg-emerald-500`
- "Match in Progress" pill: `bg-emerald-50 ring-1 ring-emerald-200 px-2.5 py-1`
- Eyebrow: "Active Court" (11px bold uppercase, text-slate-500)
- Hero: **"COURT 1"** `font-display font-black` at `clamp(48px, 14vw, 72px)`, text-emerald-600
- Divider: `h-px bg-slate-200`, mx-6 my-5
- TeamsGrid (see Phase 5)

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 5 — DT PlayerPhone: TeamsGrid + PlayerRow (match-alert version)
Rewrite `TeamsGrid` and `PlayerRow` inside PlayerPhone.tsx to match `match-alert.tsx`:
- `TeamsGrid`: `grid grid-cols-[1fr_auto_1fr] gap-x-3 items-start`, each column = label + stacked PlayerRows
- VS badge: `pt-7 text-[11px] font-bold tracking-[0.1em]` (amber: text-amber-800/80, navy: text-slate-400)
- `PlayerRow`: `flex items-center gap-2 py-1.5` — NO card backgrounds, NO rings
  - skill dot: `h-1.5 w-1.5 shrink-0 rounded-full` (BEG=emerald-400, INT=sky-400, ADV=purple-500)
  - skill label: `font-mono text-[9px] font-bold uppercase tracking-[0.1em]` muted
  - name: `flex-1 truncate text-sm` (bold if isMe)
  - "You" tag: `text-[9px] font-bold uppercase tracking-[0.14em]`, emerald-700 (amber) / emerald-600 (navy)

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 6 — DT PlayerPhone: Live Courts tab
Rewrite `LiveCourtsTab()` to match `live-courts-tab.tsx`:
- Section headers: pulsing dot + "NOW PLAYING" / "ON DECK" + count badge (emerald/amber pill)
- `CourtMatchCard` per match:
  - **in_progress**: dark bg `oklch(0.10 0.014 245)`, emerald glow box-shadow, "COURT N" header (text-white/60), "In Progress" badge, TeamsGrid dark mode
  - **on_deck**: white bg, amber border `amber-100`, "On Deck" header, TeamsGrid light mode
- `TeamsGrid` (match-roster version, in-file — not imported):
  - `grid-cols-[1fr_40px_1fr]`, team labels row, VS badge spans rows 2-3
  - `PlayerRowLight` (on-deck): `clip-cut-tr bg-cc-bg-3 px-3 py-2`, two lines:
    - Line 1: name `font-command text-[12px]`
    - Line 2: skill text in cc-* color `font-command text-[9px]`
  - `PlayerRowDark` (active): same structure, dark cc-* colors
  - `VsBadge`: vertical line (`w-px h-3.5 bg-slate-400`) + "VS" (`text-[8px] font-bold`) + vertical line

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 7 — DT PlayerPhone: Match History (inside My Status sub-tab)
Replace `MatchHistoryTab()` to match real `match-history.tsx` layout:
- Stats bar: `flex items-center justify-between rounded-xl bg-white border px-4 py-3`
  - Trophy icon (inline SVG) + "N matches"
  - W/L/D: `NW / NL` with emerald/red text
- Match cards per history item:
  - Header: match number + "Won"/"Lost" badge (emerald/red)
  - Big score: `text-3xl font-black tabular-nums` (my score vs their score)
  - Partner / Opponents row with labels

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 8 — DT PlayerPhone: Tab bar + Header + My Status sub-tabs
Tab bar:
- 4 tabs with inline SVG icons: My Status (person), Live Courts (grid), Waitlist (list), Leaderboard (trophy)
- Labels: "My Status" · "Live Courts" · "Waitlist" · "Leaderboard"
- Active: `text-emerald-600 border-b-2 border-emerald-600` (matches real app `text-primary border-primary`)
- Replace top-level "History" tab with "Leaderboard" stub

Header:
- `h1` → "Tuesday Session" (mock session name, not "Badminton Queue")
- Keep player name "Alex" + skill indicator + status dot

My Status sub-tabs:
- Add Queue/History segmented toggle: `flex rounded-xl bg-slate-100 p-1`
- Queue sub-tab: shows waiting/drafted/on_deck/in_progress content
- History sub-tab: shows `MatchHistoryTab` content
- Leaderboard tab: stub — "Live rankings · Coming soon" placeholder

Propagate: cp PlayerPhone.tsx → marketing-site.

### Phase 9 — Housekeeping
a. **Dead CSS**: Remove `pp-alert-visible` / `pp-alert-hidden` from both global.css files
   (real match-alert.tsx uses inline style transform, not these classes)
b. **OG image**: Create `marketing-site/public/og.svg` (1200×630, branded)
c. **Stale comment** in `marketing-site/astro.config.mjs`: remove "Phase 3" reference
d. **Stale comment** in `marketing-site/src/sandbox/state/useSandbox.ts` + DT copy: remove "Phase 2" reference

---

## Key Decisions
- **DT is source of truth**: All changes to PlayerPhone.tsx go in DT first, then `cp` to marketing-site.
- **Sync script limitation**: `npm run sync` only copies the `@theme {}` block. Fonts (@import), keyframes, and utility classes (.clip-cut-tr, status-pulse) must be manually mirrored to marketing-site/global.css.
- **cc-* tokens**: Add to DT's global.css in a non-@theme section (Tailwind CSS vars via plain CSS). Also add to marketing-site's global.css manually.
- **Slide-up animation**: Use inline style `transform: translateY`, CSS `transition` property (NOT the pp-alert-* keyframe classes). Matches the real app exactly.
- **LiveCourtsTab TeamsGrid**: Inline the cc-* based player row components in PlayerPhone.tsx rather than importing from match-roster (since match-roster uses lucide + VipTag which marketing-site/DT don't have).
- **Leaderboard tab**: Stub only — real data requires Supabase.
- **No lucide-react in DT/marketing-site**: Use inline SVGs for tab icons.
- **Phone dimensions**: 375×780 scaled at 0.72 — font sizes should match the DT's WaitlistTab scaling approach (~15% smaller than real app values to fit the shell).

## Last Updated
2026-05-20 (full re-audit — DT is source of truth, propagation workflow confirmed)
