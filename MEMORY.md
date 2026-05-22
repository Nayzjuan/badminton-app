# MEMORY.md — Badminton App Architectural Index

<!-- LLM-optimized: dense, structured, no prose padding. Read this before writing any code. -->
<!-- Short-term memory: session tracker + handoff doc. Long-term truth: APP_MANIFEST.md -->

---

## SESSION STATE (Last Updated: 2026-05-22 — Fix Player Record feature)

### Fix Player Record — Historical Match Roster Correction (2026-05-22) — COMPLETE

Allows the organizer to correct a completed match's player roster (wrong player recorded, or injury substitution). Two modes: **Team Flip** (both players already in the match — swap teams) and **Full Replacement** (in_player from another session match takes out_player's slot).

**New files created:**

- `supabase/migrations/20260522000000_fix_record_swap_player.sql`
  - Helper `_fix_record_partnership_delta()` — upserts both A→B + B→A directions on increment; `GREATEST(0,…)` floor on decrement. Does not touch `sessions_together` on decrement.
  - Main `fix_record_swap_player()` RPC — `SECURITY DEFINER`, `FOR UPDATE` locks on `matches` + `match_players` rows for concurrency safety. Team-flip path swaps `team` columns and re-applies partnership deltas. Full-replacement path DELETEs out_player, INSERTs in_player, adjusts `queue_entries.games_played` ±1. Both paths: recompute `is_mixed_level`, mark `origin = 'modified'` if was `'auto'`, call `refresh_alltime_leaderboard()`. GRANTs to service_role.
- `src/app/actions/fix-player-record.ts` — server action with 5-layer guard (UUID validation → auth → organizer check → match status → in_player eligibility). Eligibility: is team flip (already in match) OR has ≥1 completed match in same session. Maps RPC exception strings to typed `FixRecordErrorCode`.
- `src/hooks/use-session-completed-players.ts` — fetches distinct players with ≥1 completed match in session, excluding the target match's players. Returns per-player session stats (GP, W, L) for the picker UI.
- `src/hooks/use-fix-record.ts` — state machine (`selecting_out → selecting_in → confirming → submitting`). `useTransition` for server action. `isTeamFlip` derived from `match.players`. Error stays in `confirming` state so user can re-read + retry. `goBack()` resets both `outPlayer` and `inPlayer` back to `selecting_out`.
- `src/components/organizer/fix-record-sheet.tsx` — self-contained Sheet with amber trigger button (ArrowLeftRight icon + "Fix" label). Step 1: 4 players grouped by team. Step 2: Section A "SWITCH WITHIN THIS MATCH" (3 same-match candidates) + Section B "FROM OTHER SESSION MATCHES" (session players with `3G · 2W 1L` stats). Confirmation strip slides up on selection, stays mounted during `submitting` step (spinner visible). "Select player" breadcrumb is tappable back button while in Step 2 (disabled during submit). Amber `var(--cc-amber)` accent throughout.

**Modified files:**

- `src/components/organizer/match-history-panel.tsx` — added `import { FixRecordSheet }` + `<FixRecordSheet match={match} sessionId={sessionId} onCorrected={() => {}} />` alongside existing `<EditMatchDialog>`. `onCorrected` is a no-op because `useMatchHistory` realtime subscription auto-refetches when the RPC updates `matches.is_mixed_level` or `matches.origin`.
- `src/types/database.ts` — added `fix_record_swap_player` to `Functions` section.
- `src/hooks/use-session-completed-players.ts` — `as unknown as` cast for `!inner` join inference workaround (pre-existing Supabase SDK pattern for un-typed FK relationships).

**Bugs caught during code review (fixed before final verdict):**
1. `goBack()` was setting `selecting_in` instead of `selecting_out` — fixed.
2. `isConfirming` excluded `"submitting"` — sheet went blank during server action — fixed by including `"submitting"` in both `isStep2` and `isConfirming`.
3. `goBack` was exported but never wired — fixed by making the Step 1 breadcrumb crumb a `<button>` that calls `goBack`.

**Validation:** `npx tsc --noEmit` clean · `npm run lint` clean (changed files only) · `npm run build` clean (all 19 pages) · Code review: LGTM.

**⚠️ Migration not yet applied to Supabase production.** Run `fix_record_swap_player` migration before using the feature in a live session.

---

## SESSION STATE (Last Updated: 2026-05-20 — marketing site visual enhancements)

### Marketing Site — Visual Enhancements (2026-05-20) — COMPLETE

**Features section ("What It Does"):**
- Feature 01 card: emerald gradient wash background, LIVE ENGINE badge with pulsing dot, court grid overlay pattern, key phrases in Smart Matchmaking subtext bolded in `text-ink`.
- Feature 02/03 cards: brighter number badges.
- All cards: hover lift effects (`feature-lift-lg` / `feature-lift-sm`), staggered scroll-reveal via IntersectionObserver.

**How It Works section — fully redesigned step card visuals:**
- Step 1: inline SVG QR code with animated scan line + corner brackets.
- Step 2: HTML organizer queue mockup (player rows + Generate Match button).
- Step 3: live scoreboard mockup (Court 1, score 21–15, game progress bars).
- Progressive green background tint per step (0.1 → 0.22 → 0.38 opacity).
- All cards use the same scroll-reveal system via `data-reveal-section` attribute.

**CSS additions (`marketing-site/global.css`):**
- `.feature-card` scroll-reveal (opacity + transform with stagger via `--i`).
- `.qr-scanline` keyframe animation.
- Hover lift utility classes: `feature-lift-lg`, `feature-lift-sm`.

**JS:** Generic IntersectionObserver script handles any section with `data-reveal-section` attribute.

**Next steps:** Consider applying the same scroll-reveal + visual-preview treatment to remaining page sections (Testimonials, Pricing, FAQ, Footer CTA) for consistency.

---

## SESSION STATE (Last Updated: 2026-05-20 — UI fixes, score validation, E2E teardown)

### Wait-time Monitor + Score Validation Fixes (2026-05-20) — COMPLETE

**Wait-time monitor (`src/components/organizer/wait-time-monitor.tsx`):**
- `on_deck` players now appear in the monitor alongside `waiting` players. Previously they vanished the moment an organizer assigned them to a manual match, making it impossible to confirm a long-waiting player was finally served.
- `on_deck` rows render with teal styling + "On Deck" badge + "ASSIGNED" sub-label. Bottleneck count + red alert only count `waiting` players. Remove button hidden for `on_deck` rows.
- Summary line: "X waiting, Y on deck" split.

**Score validation (no-draw rule + schema consolidation):**
- `src/lib/schemas/match.ts` (`scoreSchema`): Added `.refine(data => data.teamAScore !== data.teamBScore)` — server-side draw block on all submission paths.
- `src/app/actions/match-lifecycle.ts`: Replaced hardcoded duplicate inline schema (`.max(30)`) with import of canonical `scoreSchema` from `match.ts`. The hardcoded 30 was wrong — `MAX_BADMINTON_SCORE = 31` in constants.ts.
- `src/hooks/use-score-form.ts`: Added `a === b` draw check (client-side, player + organizer modal).
- `src/hooks/use-edit-match.ts`: Added `a === b` draw check (organizer score-edit path).
- `src/components/organizer/score-modal.tsx`: Added `aVal !== bVal` to `canSubmit`; removed dead Draw branch from live-winner preview.
- `tests/unit/use-score-form.test.ts`: Fixed stale boundary tests (31→32 for "exceeds max"); added SF-8 draw-rejection suite (3 tests); relabelled skipped test to SF-9.

**Validation:** `npx tsc --noEmit` clean · 355/356 tests pass (1 pre-existing skip) · Code review: Minor issues (all fixed inline — dead branch removed, duplicate SF-8 label fixed, edit-match draw guard added).

---

### E2E Teardown — repairSandboxState (2026-05-20) — COMPLETE

**Root cause:** If a Playwright test crashes mid-run, `softResetSandboxSession`/`afterAll` never fires, leaving the sandbox with stuck `playing`/`drafted`/`on_deck` players and orphaned `in_progress`/`pending` matches.

**Fix (`tests/helpers/teardown.ts`):**
- Added exported `repairSandboxState()` — cancels stuck `in_progress`/`pending` matches, returns stuck `playing`/`drafted`/`on_deck` queue entries to `waiting`, frees `in_use` courts. Status-updates only, never deletes — permanent sandbox players survive intact.
- Wired as **Step 0** of `softResetSandboxSession()` so every test `beforeEach` self-heals from any prior crash state.

**Commit:** `bf0fab1`

---

### Production DB — v_queue_full_with_wait_time Applied (2026-05-20) — COMPLETE

Migration `20260520000000_add_v_queue_full_with_wait_time.sql` existed in the repo but was never applied to production. The live `use-organizer-queue.ts` was already reading from it (post ON DECK visibility feature on main), causing the organizer queue panel to show empty for ALL sessions. Applied via Supabase MCP. Also repaired 2 stuck sandbox matches and 6 stuck players at the same time.

---

### Migration Duplicate Fix (2026-05-20) — COMPLETE (PR #9)

**Root cause:** `20260509000000_swap_player_draft_aware.sql` and `20260509000000_wrapped_awards_threshold_tweaks.sql` shared the same version timestamp. Supabase integration test startup failed with `duplicate key value violates unique constraint "schema_migrations_pkey"`. The wrapped_awards content was already correctly renamed to `20260509000001` — deleted the stale `20260509000000_wrapped_awards_threshold_tweaks.sql` duplicate. **Commit:** `de41adb`

---

### Consecutive Same-Partner Bug Fix (2026-05-20) — COMPLETE

**Problem reported:** Players were getting the same partner in consecutive games despite the anti-repeat lookback.

**Root cause (verified):** `snakeDraft` and `rotatedDraft` in `src/lib/matchmaking-core.ts` tried splits in skill-balance order and returned the *first* one where both team pair counts were `< cap` (hard cap = 2). They never checked whether a *fresher* split existed where both pairs had `count = 0` (never been partners before). `isDiversityViolation` does not prevent same-partner repeats — it only blocks when ≥3 of 4 players appeared in the same recent match. Overlap scoring is anchor-centric, so when neither recently-paired player was the anchor, their mutual history was invisible to candidate scoring.

**Fix:** Added two-pass approach to both `snakeDraft` and `rotatedDraft`:
- **Pass 1**: Try splits (in skill-balance / rotation order) where BOTH team pairs have `count === 0`. Avoids repeating partnerships even when they're below the hard cap.
- **Pass 2**: Fall back to original behavior — any split where both pairs are `< cap`.

**Files changed:**
- `src/lib/matchmaking-core.ts` — `snakeDraft` (lines ~125–140): two-pass loop; `rotatedDraft` (lines ~340–360): two-pass loop
- `tests/unit/matchmaking-core.test.ts` — updated 1 existing test whose assertion expected Split 0 but new code correctly prefers fresh Split 2; added `"snakeDraft — fresh-pair preference"` describe block (4 new tests)

**Validation:** `npx tsc --noEmit` clean · 323/324 tests pass (1 pre-existing skip) · lint errors are all pre-existing in unrelated files · Code review: LGTM

---

## SESSION STATE (Last Updated: 2026-05-19 — Security Audit Pass)

### Security Audit + Patch (2026-05-19) — ALL COMPLETE

**Goal:** Fix 3 input-validation security findings from a principal security engineer audit.

**Files changed (not yet committed):**
- `src/lib/schemas/auth.ts` — added `skillLevelSchema` (Zod v4 `.refine()` against `SKILL_LEVELS` source of truth)
- `src/lib/schemas/sessions.ts` — **new file**: `scoringFormatSchema` validates `ScoringFormat` enum at runtime using `satisfies` const array
- `src/app/actions/auth.ts` — replaced unsafe `as SkillLevel` cast with `skillLevelSchema.safeParse()` in `signInAnonymously`
- `src/app/actions/sessions.ts` — added `scoringFormatSchema.safeParse()` before `createSession` DB insert; uses validated `scoring` var
- `src/app/actions/match-lifecycle.ts` — added `scoreSchema` (Zod v4, 0–30 int range); applied in `endMatchAction` (extracts `safeA`/`safeB`) and `updateMatchDetails` (same pattern, score-edit path only)

**Findings fixed:**
- F2 (P1): No server-side score bounds → exploitable via crafted POST. Now gated by `scoreSchema`.
- F3 (P2): `skillLevel` was an unsafe TypeScript cast, any string could persist to DB. Now Zod-validated.
- F4 (P2): `ScoringFormat` unvalidated at runtime. Now Zod-validated before insert.

**Skipped (by user request):**
- F1 (P0): `profile.ts` PIN/skill actions only gate on `verifyAuthenticated()`, not `isSessionOrganizer()`. Intentionally deferred — current design allows easy organizer access.

**Status:** All committed and merged to main.

---

### Security Headers (2026-05-19) — COMPLETE

**Goal:** External security scanner flagged 7 issues. Verified each against the codebase; implemented all real fixes.

**Verdict per issue:**

| # | Issue | Status |
|---|-------|--------|
| 1 | Missing CSP (HIGH) | Fixed — added to `next.config.ts` |
| 2 | Missing X-Frame-Options (MEDIUM) | Fixed — added to `next.config.ts` |
| 3 | Missing X-Content-Type-Options (MEDIUM) | Fixed — added to `next.config.ts` |
| 4 | Missing Referrer-Policy (MEDIUM) | Fixed — added to `next.config.ts` |
| 5 | Missing Permissions-Policy (LOW) | Fixed — added to `next.config.ts` |
| 6 | Password Autocomplete (LOW) | **False positive** — all PIN inputs already have `autoComplete="off"` (login-form.tsx:208, organizer-entry.tsx:479,531) |
| 7 | No Rate Limiting (MEDIUM) | **Accepted risk** — Vercel edge protects DDoS; PIN reconnect brute-force has minimal blast radius (queue slot only, not account access) |

**CSP notes:**
- `script-src` and `style-src` use `unsafe-inline` (required by Next.js App Router hydration — no way around this without nonce middleware)
- `connect-src` allows `*.supabase.co` + `wss://*.supabase.co` for Realtime
- `frame-ancestors 'none'` (modern) + `X-Frame-Options: DENY` (legacy compat) for clickjacking
- Google Fonts: NOT needed in CSP — `next/font/google` self-hosts fonts at build time in `/_next/static/media/`, no runtime requests to `fonts.gstatic.com`
- `worker-src 'self' blob:` covers the hand-crafted service worker at `public/sw.js`

**Commit:** `8e4c6e0` feat(security): add HTTP security headers to all routes

---

### What Was Accomplished This Session — Full Architecture Audit + 6-Phase Remediation (2026-05-19)

---

### Uncommitted-Work Cleanup + Push (2026-05-19) — COMPLETE

**Goal:** User asked to "push everything" from a working tree with 38 modified files + 31 untracked. Two of the untracked files were production data backups — those needed gitignore treatment, not commits.

**Commits landed (cc2c1a6 → 9d0519c, all on origin/main):**

- `cc2c1a6` **chore(gitignore):** ignore local tool artifacts and root-level db backups
- `43d35a9` **chore: snapshot in-progress local work** — 58 files, +9227/-1228
- `9d0519c` **style: apply prettier formatting to settings.json and e2e scenarios K-O**

---

### QA Improvements Pass (2026-05-19) — ALL COMPLETE

**Goal:** Pull latest `main`, run a 3-pillar architecture audit (magic strings, JSDoc quality, layer bleeding), then fix every violation in severity order (P0 → P1 → P2).

**Audit scope:** 108-file merge from main. Spawned 4 parallel audit agents covering hooks, server actions, organizer/player components, and lib/wrapped/TV layer.

**Phase 1 — P0 Blockers (all fixed):**
- `dev.ts`: Added `NODE_ENV === "production"` hard-block to `requireAuth()` — any authenticated player could previously call `clearSessionData` and wipe live match history
- `use-organizer-courts.ts`: Replaced raw `.insert/.update/.delete` mutations with server actions (`addCourtAction`, `updateCourtStatusAction`, `removeCourtAction`) — also added `.eq("session_id", sessionId)` scope guard to prevent cross-session authorization bypass
- `court-card.tsx`: Renamed `CardState "in_progress"` → `"active_match"` to avoid confusion with `CourtStatus "in_use"` (the DB value)
- `edit-match-dialog.tsx` + new `use-edit-match.ts`: Extracted server action call into hook; dialog is now a pure layout renderer
- `score-input-card.tsx` + new `use-score-input.ts`: Same extraction pattern

**Phase 2 — P1 Hooks (all fixed):**
- 5 bare ref assignments (`fetchRef.current = fn` outside `useEffect`) → wrapped in `useEffect([dep])` in `use-match-history`, `use-organizer-courts`, `use-organizer-matches`, `use-organizer-queue`, `use-swap-state`
- `use-swap-state`: Two bare assignments → `useEffect`; `any[]` on `executeMatchSwapRef` → typed `MatchSwapArgs`; magic `"MATCH_STARTED"/"PLAYER_NOT_IN_MATCH"` → typed `SwapErrorCode`/`SwapMatchPlayersErrorCode`; moved `handleUndoMatchSwap` before `executeMatchSwap` to eliminate forward reference flagged by React Compiler
- `use-organizer-dashboard.ts`: `alert(result.message)` → `toast.error(...)`
- `use-organizer-data.ts`: `useMemo`-as-ref antipattern → `useRef`; added `useEffect`/`useRef` imports

**Phase 3 — P1 Actions + Lib (all fixed):**
- `queue.ts`: `JoinQueueResult` was missing `success: boolean` (broke action contract); all 4 result types `interface` → `type`; all return sites updated
- `sessions.ts`: 5 `interface` → `type`; `match-lifecycle.ts`: 1; `dev.ts`: 2
- `utils.ts`: Added `: string` return type to `cn()`
- `constants.ts`: Added `COMMITTED_MATCH_STATUSES: MatchStatus[]`
- `matchmaking-db.ts`: Replaced 3 inline `["completed","in_progress","pending"]` arrays with the constant; removed 3 dead `team == null` null guards; removed residual `row.team != null` redundant guard
- `database.ts`: `p_status: string` → `p_status: MatchStatus` for `create_match_with_players` RPC
- `wrapped-match-recap.tsx`: Fixed bug — `lost = !won && !draw` when scores are null showed "Lost" badge for unscored matches; now `lost = hasScores && !won && !draw`

**Phase 4 — P1 Components: tv-board (all fixed):**
- Created `src/hooks/use-tv-board.ts`: extracted Supabase client, subscriptions, 15s polling, and status filtering from `TvBoard`
- `tv-board.tsx`: Now pure layout renderer using `useTvBoard`; `TvBoardProps` + `TvPlayerInfo` `interface` → `type`; removed bogus `react-hooks/purity` eslint-disable comment
- Bonus: `use-session-data.ts` 3 bare ref assignments → `useEffect`

**Phase 5 — P2 Constants extraction (all fixed):**
- Added 15 new constants to `constants.ts`: `DIALOG_CLOSE_DELAY_MS`, `DIALOG_FOCUS_DELAY_MS`, `TOAST_DISMISS_MS`, `ERROR_AUTO_DISMISS_MS`, `COURT_ALERT_CRITICAL_OFFSET_MINUTES`, `COURT_ALERT_RECOMPUTE_INTERVAL_MS`, `MAX_BADMINTON_SCORE`, `RED_ZONE_SKILL_VARIANCE_MAX`, `DND_ACTIVATION_DISTANCE_PX`, `DND_TOUCH_DELAY_MS`, `DND_TOUCH_TOLERANCE_PX`, `APPROACHING_QUEUE_THRESHOLD`, `ON_DECK_ALERT_THRESHOLD`, `DASHBOARD_GRID_SIZE_PX`
- All magic numbers/strings replaced in: `court-card`, `score-modal`, `active-courts`, `reconnect-modal`, `on-deck-panel`, `my-status-tab`, `organizer-dashboard`, `sortable-card`, `matchmaking-core`, `use-score-form`, `use-edit-match`
- `matchmaking-core.ts:423`: `Math.abs(diff) > 0.001` preserved (wait_minutes is float — epsilon intentional; corrected misleading comment)
- `active-courts.tsx`: `interface Toast` → `type Toast`

**Phase 6 — P2 JSDoc (all fixed):**
- Added `/** */` JSDoc on all 11 exported hooks: `useEnrichedMatches`, `useLeaderboard`, `useMatchHistory`, `useOrganizerCourts`, `useOrganizerMatches`, `useOrganizerQueue`, `useOrganizerSession`, `useOrganizerDashboard`, `useScoreForm`, `useSwapState`, `useOrganizerData`
- Added `/** */` JSDoc on 9 server actions: `togglePlayerPause`, `checkoutPlayer`, `joinQueueAction`, `removePlayerFromQueue`, `submitMatchScore`, `updateMatchDetails`, `cancelMatchAction`, `reorderOnDeckMatches`, `runEngineInternal`
- Each JSDoc explains WHY (behavioral contracts, edge cases, design rationale) not WHAT

**New files created:**
- `src/app/actions/courts.ts` — server actions for court CRUD with auth + session-scope guards
- `src/hooks/use-edit-match.ts` — state machine for EditMatchDialog
- `src/hooks/use-score-input.ts` — wraps useScoreForm + submitMatchScore
- `src/hooks/use-tv-board.ts` — data layer extracted from TvBoard

**Validation (final):**
- `npx tsc --noEmit` → clean (0 errors)
- `npm run lint` → 22 errors (1 fewer than pre-audit baseline of 23; all remaining errors are pre-existing in untouched files)

**Known notes for next session:**
- `react-hooks/set-state-in-effect` suppress comments were added to 6 hook files where React Compiler false-positively flags async function calls in `useEffect`. These are intentional patterns (initial fetch on mount); the pattern is valid and equivalent to the original bare-assignment code.
- `use-session-data.ts` `PlayerMatchInfo` and `UsePlayerMatchResult` still use `interface` — these are component prop shapes, not DB row types, so this is acceptable.

---

### What Was Accomplished Previous Session — Code Quality Chunk B — ALL 6 COMMITS COMPLETE

**Goal:** Apply 9 code-quality fixes surfaced by external audit of `src/hooks/`, `src/app/actions/`, and `src/middleware.ts`. (B-8 was already fixed; B-9 deferred to future session.)

**Commits landed (all on top of Chunk A — e789b21):**

| SHA | Commit | What changed |
|-----|--------|-------------|
| 73d8f87 | B-1: getAuthenticatedUser + createUnknownProfile | Added `getAuthenticatedUser()` to `_shared.ts`; added `createUnknownProfile(id)` to `lib/utils.ts`; replaced inline auth patterns in `match.ts`, `swap-player.ts`, `dev.ts`; replaced inline unknown-profile objects in `use-organizer-data.ts` + `use-session-data.ts` |
| 6b7c0d3 | B-2: static import + getServiceClient removal | `use-match-alerts.ts`: dynamic import → static `import { sendPlayerNotification }`; `match.ts`: removed `getServiceClient()` wrapper, replaced 5 call sites with `createServiceClient()` directly |
| 74fd2a2 | B-3: leaveQueue → checkoutPlayer | `use-queue.ts`: `leaveQueue` delegates to `checkoutPlayer(sessionId)` server action; previously bypassed draft-cleanup RPC (`checkout_player_cleanup_drafts`) |
| d186c87 | B-4: isSessionOrganizer consolidation | `sessions.ts` (4 functions) + `matchmaking.ts` (`callNextMatch`): replaced inline 2-path organizer checks (fetch session → check `created_by` → fallback to `session_organizers` query) with single `isSessionOrganizer(user.id, sessionId)` call |
| 81988fe | B-5: useEnrichedMatches extraction | New `src/hooks/use-enriched-matches.ts` shared hook; `use-organizer-data.ts` + `use-session-data.ts` remove duplicated 4-query enrichment logic; `includeDrafts: boolean` controls draft firewall; `onProfilesLoaded` callback keeps organizer profiles Map in sync |
| e79a772 | B-6: useAction factory + useMemo derived state | `use-organizer-data.ts`: `useAction` factory at module scope replaces 4 identical action wrappers (`cancelMatch`, `clearOnDeckMatch`, `removeFromQueue`, `pausePlayer`); 4 derived-state slices memoized with `useMemo` |

**Validation:** `npx tsc --noEmit` exit 0 · `npx vitest run` 174/174 (all passes).

**Independent code review verdict: Minor issues (acceptable pass per CLAUDE.md).**

Minor issues to log (non-blocking, no fixes required now):
1. **Redundant session fetch in `toggleAutoMatchmaking` + `getSessionForOrganizer` (sessions.ts):** Both functions still fetch `sessions.select("created_by")` to guard "Session not found", then call `isSessionOrganizer()` which does the exact same query internally as its fast path — a double round-trip. The "Session not found" vs "Not authorized" error-message distinction is the only functional difference. Pre-existing to B-4 but made visible by the consolidation. Low priority cleanup.
2. **Two `createServerSupabaseClient()` instances in `callNextMatch` (matchmaking.ts):** `userClient` for auth, then separate `supabase` for the `is_auto_matchmaking_on` read. Pre-existing before Chunk B; not a regression. Low priority.
3. **`useAction` factory: `action` + `refreshers` closure not in dep list — footgun for future maintainers.** In practice safe because all current usages list the captured values in the explicit `deps` param. The `eslint-disable` comment acknowledges this. Document the "you must mirror closured values in deps" contract when adding new useAction calls.
4. **`courtsRef` in `useEnrichedMatches` dep array** — `MutableRefObject` identity is stable; including it is harmless but unnecessary. Cosmetic inconsistency.
5. **JSDoc for `isSessionOrganizer` misplaced in `_shared.ts`** — the comment block ends just before `getAuthenticatedUser()` instead of before `isSessionOrganizer()`. Cosmetic.

**Files modified:**
- `src/app/actions/_shared.ts` — `getAuthenticatedUser()`
- `src/lib/utils.ts` — `createUnknownProfile()`
- `src/app/actions/match.ts` — auth refactor, `getServiceClient()` removal
- `src/app/actions/swap-player.ts` — auth refactor
- `src/app/actions/dev.ts` — auth refactor
- `src/app/actions/sessions.ts` — `isSessionOrganizer` consolidation (4 functions)
- `src/app/actions/matchmaking.ts` — `isSessionOrganizer` consolidation, unused import/let cleanup
- `src/hooks/use-match-alerts.ts` — static import
- `src/hooks/use-queue.ts` — `leaveQueue` delegation
- `src/hooks/use-organizer-data.ts` — `useEnrichedMatches`, `createUnknownProfile`, `useAction`, `useMemo`
- `src/hooks/use-session-data.ts` — `useEnrichedMatches`
- `src/hooks/use-enriched-matches.ts` — NEW file

---

### What Was Accomplished This Session (Previous) — New UI Port (organizer + player) — ALL CHUNKS COMPLETE

**Goal:** port `preview-revamp.html` (organizer) + `preview-player.html` (player) designs into the real Next.js app.

**Foundation:**

- `src/app/globals.css` — HSL tokens → OKLCH. Both light + dark modes defined. New utility classes: `.clip-cut` / `.clip-cut-sm` (cut-corner polygon clip-path for organizer command-center cards), `.text-command` / `.bg-command` / `.glow-command` (electric teal `oklch(0.79 0.18 188)`), `.glow-accent`. New keyframes: `status-pulse` (1.4s pulse for status dots), `match-alert-up` (slide-up overlay), `scan-line`. Legacy `--court-cyan-hsl`/`--court-lime-hsl`/`--amber-accent-hsl` preserved for `badminton-court.tsx` + amber pills.
- `src/app/layout.tsx` — Space Grotesk replaced with **Inter** (`--font-inter`, sans default) + **Barlow Condensed** italic (`--font-barlow`, headings) + **JetBrains Mono** (`--font-jetbrains`, stats/metadata) + **Chakra Petch** (`--font-chakra`, organizer command-center). All four variables on `<html>`.

**Player view (rewrites):**

- `match-alert.tsx` — full rewrite. Full-screen slide-up overlay, `position: absolute inset-0 z-30` inside the status tabpanel. Two states: amber on-deck ("Heads Up." hero, position-aware copy "X of Y on deck"), navy in_progress (massive COURT N hero, emerald pulse). Optional Mixed Level banner. NEW props: `onLeaveQueue` (renders bottom Leave Queue button with sonner error toast), `scoreSlot?: ReactNode` (renders ScoreInputCard inside the overlay so it isn't occluded). rAF mount animation with proper cleanup.
- `queue-status.tsx` — full rewrite. Full-canvas big-numeral design (88px Barlow Condensed `#3`), inline context, thin amber rule, stats row (waited · games · skill). NEW props: `skillLevel?`, `approaching?` (amber radial glow + amber numeral when position ≤ 2).
- `on-deck-alert.tsx` — simplified to approaching-banner only (small amber/sky pill for waiting players at positions 1–4). MatchAlert owns the pending/in_progress full-screen states.

**Player view (refactors):**

- `player-dashboard.tsx` — `<main className="relative flex-1 overflow-hidden">`. MatchAlert is scoped INSIDE `{activeTab === "status" && (...)}` block (so tabs stay switchable during active match). Passes `scoreSlot={<ScoreInputCard/>}` when in_progress. `MyStatusTab` active-match branch returns `null` (overlay handles everything). `QueueSubTab` rewritten: full-canvas "Ready to play?" empty state, inline Leave Queue button (no more `QueueToggle` component). New props: `skillLevel`, `sessionName`.
- `live-courts-tab.tsx`, `waitlist-tab.tsx`, `match-history.tsx`, organizer files — batch sed semantic-token cleanup (`bg-white dark:bg-card` → `bg-card`, etc.).

**Leaderboard:**

- `stadium-leaderboard.tsx` — NEW. 6-region Stadium layout: header (Barlow 52px italic LEADERBOARD + amber player count + refresh) → YOU strip (amber gradient bar) → asymmetric podium [#2 left][#1 center taller w/ ghost watermark + lightning bolt streak][#3 right] → sort bar (visual only) → 6-col header → tail rows.
- `leaderboard-page.tsx` — when `variant === "player-panel"`, short-circuits to `<StadiumLeaderboard rows={sessionRows} onRefresh={handleRefresh} />`. organizer-panel + standalone variants unchanged.

**Organizer:**

- `active-courts.tsx` — in_progress emerald glow swapped to electric command-teal (`oklch(0.79 0.18 188)`). Background hex `#0D1B2A` → `oklch(0.10 0.014 245)`.

**Code Review Gate (3-cycle):**

1. **Build + typecheck pass** after each chunk.
2. **Initial regression sweep** caught: missing `onLeaveQueue` wiring → fixed.
3. **Independent reviewer Cycle A** flagged 3 blockers: (a) ScoreInputCard occluded behind opaque overlay, (b) hardcoded "9:41" mock chrome leaked from preview HTML, (c) overlay covered ALL tabs making the tab bar dead during active match. All three fixed by adding `scoreSlot` prop + removing chrome + scoping overlay inside the status tabpanel.
4. **Independent reviewer Cycle B (re-review)** verdict: **Minor issues** (acceptable pass per CLAUDE.md). Three blockers confirmed gone; 3 of 4 minor issues fully fixed; one follow-up logged below.

**Files changed:** 19 files, +~1,900 / −~1,150 lines.

**Validation:** `npx tsc --noEmit` exit 0 · `npm run build` exit 0.

### Critique Fix Pass (2026-05-12) — ALL ITEMS COMPLETE

Applied all P0–P3 issues surfaced by `/critique` + user answers:

**P0 fixes:**

- `match-alert.tsx` — "Heads Up." h2 scaled from 28px → `clamp(56px, 16vw, 88px)` Barlow Condensed italic
- `match-alert.tsx` — amber canvas: `bg-amber-400` replaced with explicit `backgroundColor: "oklch(0.78 0.17 62)"` so it's identical in both light/dark modes (no CSS-var ambiguity). All `dark:text-amber-*` variants on amber-tone paths removed — text stays dark amber on bright amber canvas in both modes.
- `player-dashboard.tsx` — removed `className="relative"` from the status tabpanel div (it was stealing the containing block from `main.relative`, making the `absolute inset-0` overlay render 0px tall)

**P1 fixes:**

- `match-alert.tsx` — `SKILL_DOT` 6-level map collapsed to `SKILL_TIER` 3-tier (BEG/INT/ADV with dot + text label). `PlayerRow` renders abbreviation text for quick scanning.
- `player-dashboard.tsx` — `ScoreInputCard` score inputs: `max={99}` → `max={30}`. Added JS guard `if (a > 30 || b > 30) setError("Badminton scores are 0–30.")`.

**P2 fixes:**

- `player-dashboard.tsx` — header right side completely refactored. ThemeToggle + SignOutButton + Leave Session collapsed into a `MoreVertical` overflow menu (`useRef` click-outside handler, controlled `AlertDialog` via `leaveDialogOpen` state — no `AlertDialogTrigger` needed). Status dot stays visible. Header now has 2 elements on the right (status dot + MoreVertical) instead of 5.

**P3 fixes (emoji removal):**

- `match-alert.tsx` — `⚠` text replaced with `<AlertTriangle>` Lucide icon in MixedLevelBanner. `🏸` removed from all detailText strings.
- `player-dashboard.tsx` — `⏸` replaced with `<PauseCircle>` in paused state. `✅` replaced with `<CheckCircle2>`. `📊` replaced with `<BarChart2>`.

**Motion differentiation:**

- in_progress overlay: 380ms `cubic-bezier(0.16, 1, 0.3, 1)` (sharp, snap-to-action)
- pending overlay: 550ms `cubic-bezier(0.22, 1, 0.36, 1)` (breathing, "get ready")

**Leaderboard color fixes:**

- `stadium-leaderboard.tsx` — #3 podium rank: `dark:text-amber-800` → `dark:text-amber-500` (was near-invisible on dark bg)
- PodiumCell losses: `text-muted-foreground` → `text-destructive` (matches tail-row convention)
- PodiumCell win%: `text-muted-foreground` → `text-foreground/70` (more legible)

**Code review gate:** 2-cycle. Cycle 1 caught overlay 0px-tall bug (tabpanel relative stealing containing block). Fixed. Cycle 2: LGTM.

### Light/Dark Mode Audit Pass (2026-05-12) — ALL ITEMS COMPLETE

Fixed all components that had no light mode counterpart or broken light mode colors.

**match-alert.tsx — in_progress overlay (full theme adaptation):**

- Container: `bg-[oklch(0.07_0.012_245)]` → `bg-background` (semantic token, adapts automatically)
- Status badge: hardcoded dark emerald tint → `bg-emerald-50 dark:bg-emerald-500/15 ring-1 ring-emerald-200 dark:ring-emerald-500/30`
- Badge text: `text-emerald-300` → `text-emerald-700 dark:text-emerald-300`
- "Active Court" label: `text-slate-400` → `text-muted-foreground`
- Court name: `text-emerald-400` → `text-primary dark:text-emerald-400`
- Divider: `bg-slate-700/40` → `bg-border`
- TeamsGrid navy labels: `text-slate-300/400` → `text-muted-foreground / text-muted-foreground/60`
- PlayerRow navy names: `text-white/slate-200` → `text-foreground / text-foreground/80`
- MixedLevelBanner navy: dark-only classes → light+dark pairs throughout
- LeaveQueueButton navy: dark-only classes → semantic + dark: overrides

**stadium-leaderboard.tsx — podium cell backgrounds:**

- #1 cell: removed inline `style={{ background: "oklch(0.15...)" }}`, moved to className with `bg-[oklch(0.91_0.014_245)] dark:bg-[oklch(0.15_0.018_245)]`
- isMe (non-first) cell: `oklch(0.78 0.17 62 / 0.06)` inline style → `bg-accent/10` className
- Ghost watermark: 7% → 14% opacity (visible in both modes)
- YOU strip gradient: 12% → 18% opacity (visible in both modes)
- #2 rank color: `text-muted-foreground` → `text-foreground/50 dark:text-muted-foreground` (more contrast in light)
- #3 rank color: previous fix `dark:text-amber-800` → `dark:text-amber-500` preserved

**live-courts-tab.tsx:**

- CourtMatchCard in_progress: `#0D1B2A` hex → `oklch(0.10 0.014 245)` + box-shadow converted from rgba() to oklch()

**preview-player.html:**

- Added ~45 `[data-theme="light"]` overrides for leaderboard (`.lbs-*`), in-progress overlay (`.match-alert.in-progress`, `.alert-*`, `.score-*`), and waitlist (`.wl-*`)

**Code review gate:** 2-cycle. Cycle 1: LGTM with minor issues. Fixed #1 podium dark-mode bg distinction. Remaining minor: LeaveQueueButton navy uses non-semantic slate classes — logged, low priority.

### Waitlist Sporty Revamp (2026-05-12) — COMPLETE

Full visual redesign of `waitlist-tab.tsx` using `/impeccable` + `/ui-ux-pro-max` + `/typeset`.

**Design direction:** Live sports timing screen / tournament bracket row aesthetic.

**Key changes:**

- No card wrapper — raw horizontal dividers like a live standings table
- Zero-padded Barlow Condensed italic rank numbers: `01`, `02`… (hero of each row)
- Rank colour-coded: `#1 = text-accent` (amber), `#2–4 = text-primary` (emerald), rest = muted
- "You" row: full amber canvas `oklch(0.78 0.17 62)` (consistent with on-deck overlay), amber-950 dark text
- `NEXT COURT` zone divider (positions 1–4 = hot zone, first to be called)
- `WAITING` zone divider (tail queue)
- GP shown as large JetBrains Mono numeral (not "X games" label)
- BEG/INT/ADV skill abbreviations (3-tier, same as match-alert)
- `LINEUP` header with live pulsing emerald dot + amber player count in Barlow Condensed italic
- Removed SkillBadge pill component (replaced with text abbreviations for sporty density)
- Full light + dark mode: all colours semantic or OKLCH with explicit values where needed
- HTML prototype (`preview-player.html`) updated with matching CSS + HTML

**Code review:** LGTM (first pass). All TypeScript correct, contrast passes WCAG AA, no regressions.

**.impeccable.md created** at project root with design context: fast · competitive · electric; sporty-futuristic athletic precision; references tournament brackets/F1 timing screens.

### Follow-up items (non-blocking)

- **Stray slate utility classes in `match-history.tsx` + `waitlist-tab.tsx`** — some decorative slate utilities remain (rank-badge `bg-slate-800 dark:bg-slate-600`, draw-state `border-slate-300`, neutral `bg-slate-400 text-white dark:bg-slate-600`). They're semantic (representing "neutral" or "rank-1-4 highlight" states, not theme-aware containers) and have proper `dark:` variants, so they won't break dark mode. Off-token vs. the rest of the cleanup pass — log as polish work.
- **`.clip-cut` utility unused** — defined in globals.css but not applied. The naive apply on `active-courts.tsx` broke the glow (`box-shadow` is clipped by clip-path). Needs a wrapper-with-`filter: drop-shadow` refactor to ship.
- **Stadium leaderboard has no Filter chips / Sort buttons** — preview design includes "THIS SESSION / ALL-TIME / LAST 30" filter chips and SORT | RANK | WIN% | WINS | STREAK buttons. Current implementation has neither (would need new state in `leaderboard-page.tsx`).

### Previous Session — Cross-Session Awards (B+E) ALL PHASES COMPLETE

**Cross-session awards (B+E) — all 4 phases shipped.**

- **Phase 1** — Schema: `player_rivalries` + `player_partnerships` tables (directional, PK composite, `sessions_faced`/`sessions_together` dedup via `last_session_id` guard), `carry_forward jsonb` column on `session_wrapped_stats`, `refresh_cross_session_stats(UUID)` RPC. GRANT SELECT for authenticated. Types in `database.ts`: `PlayerRivalry`, `PlayerPartnership`, `carry_forward` optional in Insert.
- **Phase 2** — `closeSession` wired: `refresh_cross_session_stats` runs before `compute_session_wrapped` (non-fatal, step 0a). Uses service-role client (only client with EXECUTE).
- **Phase 3** — `compute_session_wrapped` expanded: 14-CTE `_cross_session_stats` temp table (all-time nemesis, score settled, dynasty victim, serial rivals, session nemesis/kryptonite alltime, cross-session redemption, partnership alltime, prior sessions rolling-3, carry_forward read). `_ended_streaks` temp table computes actual end-of-session streak (not peak). 9 new awards + 4 enhanced subtitles. `carry_forward` written with correct `ended_on_win_streak`.
- **Phase 4** — 9 new `AWARD_META` entries in `wrapped-awards.ts`. All rarities correct. Subtitle tokens match RPC award_data keys.

**Total awards: 60** (51 session-only + 9 cross-session). New slugs: `momentum`, `consistent_dominator`, `bounced_back`, `nemesis_slayer`, `settled_the_score`, `the_dynasty`, `serial_rivals`, `soulmates`, `winning_formula`.

**Known worktree issue:** All edits initially landed in the `main` repo directory instead of the worktree (`claude/funny-gates-64ff30`). Files were copied manually via `cp` at end of session. Future sessions should edit worktree-path files directly.

### What Was Accomplished (Previous Session — Wrapped Awards)

- **Wrapped RPC threshold tweaks + overlap fix** (migration `20260509000000_wrapped_awards_threshold_tweaks.sql`):
  - `the_closer`: `games_played >= 2` → `>= 3` (prevents 1-of-2 winners from getting the award)
  - `friendly_fire`: `friendly_fire_overlap >= 1` → `>= 2` (was firing for ~80% of players in small sessions)
  - `the_warmup_act` now tier-replaces `participation_trophy` via `array_remove` + `v_award_data - 'participation_trophy'` before adding itself (previously both could coexist for the same player)
  - All 3 fixes verified live via parity SQL against `pg_proc`. `npx tsc --noEmit` clean.
  - Local baseline `20260508000000_expand_wrapped_awards.sql` also updated to reflect final intended state.
- **Code Review Gate root cause & prevention**: Stop hook didn't visibly fire after the previous session's implementation; session concluded without independent review. Added mental checkpoint: before any "task complete" declaration, must confirm "Code Review Gate verdict visible? If no → spawn review agent before summarising."

### What Was Accomplished (Previous Session, 2026-05-08)

- **Session Wrapped award catalogue expanded 27 → 51** (migration `20260508000000_expand_wrapped_awards.sql`):
  - 24 new awards across 6 categories: Performance (`comeback_kid`, `the_closer`, `ice_cold`, `clean_sweep`, `back_to_back`), Margin/Dominance (`blowout_king`, `heartless`, `defensive_wall`, refined `sniper`), Social (`social_butterfly`, `loyal_partner`, `mixed_master`), Rivalry (`the_rematch`, `redemption_arc`, `friendly_fire`), Comedic (`benchwarmer`, `the_warmup_act`, `own_worst_enemy`, `the_veteran`), Special (`century_club`, `night_cap`, `early_bird`, `skill_slayer`, `double_trouble`).
  - Tier replacement: `clean_sweep` removes `sunset_surge` (won 3-of-3 last is strict superset of won 2+-of-3 last).
  - `sniper` rebanded from "≥5 pt margin" to "5–7 pt margin" so it's mutually exclusive with new `heartless` (≥8 pt margin).
  - `compute_session_wrapped` RPC now starts with `PERFORM refresh_alltime_leaderboard()` so `century_club` / `the_veteran` see fresh all-time data.
  - `_wrapped_stats` temp table extended with ~25 new computed columns + 6 new supporting CTEs (`opp_pair_summary`, `partner_summary`, `friendly_fire_counts`, `own_worst_enemy_summary`, `skill_slayer_counts`, `alltime_top3`) + `has_streak_partner` precompute for `double_trouble` (since `partner_counts` CTE goes out of scope after temp table is materialized).
- **Top-6-by-rarity display cap** added via `topAwardsByRarity(slugs, n=6)` in `src/lib/wrapped-awards.ts`. `WrappedShell` switches header copy to "Top 6 of N Awards" when there are more.
- **Earlier this session: Autopilot Memory System** locked in. `CLAUDE.md` rewritten to mandate reading `src/types/database.ts` + `APP_MANIFEST.md` + `MEMORY.md` + `@AGENTS.md` and updating both living docs before exiting any workflow.
- **Earlier this session: Digital Twin project** (`digital-twin/`): Astro 5 + Tailwind v4 (OKLCH) + Mermaid + Pagefind + Shiki. 9 pages, OKLCH design system (emerald `oklch(76% 0.17 155)`, OLED canvas `oklch(7% 0.012 245)`), TypeScript compiler API extraction of schema/constants/actions.

### Bugs Discovered & Fixed (this session, mid-flight)

- **PG17 `text[] || 'literal'` ambiguity**: All 52 `v_awards := v_awards || 'X'` patterns broke in PG17 with "malformed array literal". Fixed by switching every append to `array_append(v_awards, 'X'::text)`.
- **`MAX(uuid)` doesn't exist**: Initial `opp_pair_summary` CTE had `MAX(opp_a) / MAX(opp_b)` aggregates on UUID columns. Removed; `opp_pair_key` (text) is sufficient downstream.
- **CTE scope leak**: `partner_counts` inside the `_wrapped_stats` CTE chain is unavailable from the per-player loop. Resolved by precomputing `has_streak_partner` (bool) as a column on `_wrapped_stats` while `partner_counts` is still in scope.

### Known Bugs / Technical Debt

- `v_recent_pairings` view still exists in DB but is **no longer queried** by the engine — `buildOverlapMap` uses a 3-step manual join instead. The view is unused dead weight; safe to drop in a future migration if desired.
- `ON_DECK_LOOKAHEAD` and `MAX_ON_DECK_MATCHES` still in `constants.ts` but not imported by `matchmaking.ts` — only used by `simulate-engine.ts`. Consider removing when `simulate-engine.ts` is updated.
- Dashboard UX audit (DASHBOARD_UX_AUDIT.md) identifies P0 issues: header buttons below 44px touch target, tab nav missing tablist/tab ARIA roles, gradient on "Call Next Match" button. Not yet fixed in code.
- `score-input-modal.tsx` uses violet accent (`bg-violet-600`, etc.) which is not in the design token system. P1 fix pending.
- Skill badge has no dark mode variant — renders washed out on dark navy. P1 fix pending.
- `match_opponent_pairs` CTE in the Wrapped RPC still SELECTs `opp_a` / `opp_b` columns from `LEAST/GREATEST` even though they're not aggregated downstream. Postgres optimizes these out, but tidy-up could remove them.
- 3 incremental fix migrations were applied to Supabase dev (`expand_wrapped_awards`, `fix_wrapped_awards_uuid_max`, `fix_wrapped_awards_array_append`, `fix_wrapped_awards_double_trouble_scope`). The local migration file `20260508000000_expand_wrapped_awards.sql` is the consolidated final version that also incorporates the `20260509` threshold tweaks. If migrations are ever replayed from scratch, only the consolidated `20260508` version + the `20260509` patch run; intermediate fix names won't reappear.
- **Jake L duplicate profiles (data integrity, 2026-05-14):** Two profiles for the same human (PIN `0356`). `8d63e740…` (May 9, player) owns 29 match_players + 5 queue_entries across real sessions. `ea9f0ae5…` (May 12, organizer) owns all 5 real sessions via `sessions.created_by` but has zero play history. Both are post-migration profiles ending different branches of a chain that split on May 9 03:21 when two devices PIN-reconnected from the same `a3f26e57` ancestor. `migrate_player_identity` is supposed to consolidate but didn't. Fix: run `migrate_player_identity('8d63e740-4715-4fd4-b2d3-e3e59c87b840', 'ea9f0ae5-ccb8-492b-9907-5aeb72178d15')` to merge the player profile into the organizer profile (or vice versa) so Jake L's match history lives under one identity. Hold until tonight's session closes.
- **Hero-card stats not refreshed by leaderboard realtime (2026-05-14):** `LeaderboardHeroCard`'s fallback `myStats` (used for below-`MIN_GP` players) is fetched once per `[currentUserId, scopeTab, activeSessionId]` change and not re-fetched by the new `subscribeToMatches` hook. A player who finishes a game while looking at the leaderboard but is still below threshold sees stale "Play N more games to appear" stats until they switch tabs. Low priority — only affects the very-early-session view.
- **3 pre-existing `react-hooks/set-state-in-effect` lint errors in `leaderboard-page.tsx`** at the initial-load, lazy-load-alltime, and hero-card-stats useEffects. These predate today's realtime work — confirmed by stash-and-relint. Worth a dedicated cleanup pass alongside the same pattern in `use-player-match.ts`, `use-queue.ts`, `theme-toggle.tsx`.

### Build Fix + Organizer Port (2026-05-12) — COMPLETE

**Vercel build was broken** at commit `5a5651f` due to Turbopack requiring all exports from `"use server"` files to be `async`. `isRpcNotFound` was a sync export in `_shared.ts`.

**Fixes applied:**

- `src/lib/rpc-utils.ts` — new file containing `isRpcNotFound` (pure sync util, moved out of "use server" scope)
- `src/app/actions/_shared.ts` — removed `isRpcNotFound` export; updated comment
- `src/app/actions/match.ts` + `queue.ts` — updated imports to use `@/lib/rpc-utils`
- `src/types/database.ts`:
  - Added `"drafted"` to `QueueStatus`
  - Added `is_auto_matchmaking_on` to `SessionInsert` optional fields
  - Registered 7 missing draft-mode RPC function types: `revert_match_to_active`, `clear_on_deck_match_atomic`, `publish_match`, `publish_all_drafts`, `checkout_player_cleanup_drafts`, `join_queue`, `remove_player_from_queue_organizer`

**Organizer dashboard ported** to match `preview-revamp.html` command-center design:

- `organizer-dashboard.tsx`:
  - Auto-matchmaking toggle: emerald → electric teal `oklch(0.79 0.18 188)` (both mobile + desktop)
  - Mobile more-menu dropdown: white/slate → dark `oklch(0.19 0.020 238)` command-center
  - Session switcher dropdown: white/slate → dark command-center; header uses `font-command`
  - Tab nav: `font-command`, uppercase tracking, teal colors for active/hover
- `on-deck-panel.tsx`:
  - All amber replaced with teal for: card borders, card header bg, drag-handle icon, card title, "Mixed Level" badge, time-ago label, "On Deck" section pulse dot, "match ready" badge, Publish/Publish All buttons, draft banner
  - Teal shadow on swap-selection state
- `active-courts.tsx`:
  - "Call Next Match" button: emerald → teal (light solid / dark translucent with border)

**Pushed to `main`:** commits `ee6e4c6` (build fix) + `836df5d` (organizer port). Vercel should deploy cleanly now.

### Leaderboard Live-Refresh + Variant Fix (2026-05-14) — COMPLETE

Two follow-up bugs surfaced live during the May-14 Thursday session.

**Bug 1 — embedded leaderboards stale.** Players who opened the
in-dashboard Leaderboard tab before any matches had completed got stuck
on "No ranked players yet" even after games started finishing. Root cause:
`leaderboard-page.tsx` only fetched on mount — no realtime / polling /
visibility refresh. The previous `use-leaderboard.ts` hook (deleted in
the Stadium refactor) used to subscribe to match changes; that wiring
was lost.

**Fix (commit `125174c`) — `src/components/leaderboard/leaderboard-page.tsx`:**

- New `useEffect` subscribes to `subscribeToMatches(supabase, activeSessionId, refetch, "leaderboard")` — only on session scope, debounced 500 ms so a score-submission cascade collapses to one refetch.
- Ref-based callback (`fetchSessionRef.current = fetchSession` updated in a separate useEffect) keeps the subscription stable across renders. Subscription deps are `[scopeTab, activeSessionId]` only.
- Channel prefix `"leaderboard"` so it doesn't collide with `use-organizer-data.ts`'s undefined-prefix `matches:<sessionId>` channel.
- `fetchSessionSeq` + `fetchAllTimeSeq` monotonic ref counters (CLAUDE.md mandate) drop stale results — critical now that realtime can fire rapid refetches.
- Refresh button added to both empty states (compact player-panel + standalone organizer/lobby) so users stuck on the empty state can recover without switching tabs.

**Bug 2 — lobby `/leaderboard` route trapped on empty.** Screenshot showed the lobby page stuck on "No ranked players yet" with a Refresh button that did nothing. Root cause: `src/app/leaderboard/page.tsx` was passing `variant="player-panel"` — the compact embedded variant. With `sessionId={null}`, `fetchSession` bails on `if (!activeSessionId) return;` and `sessionRows` stays empty forever. The compact variant has no tab switcher and no session picker, so there's no UI affordance to recover.

**Fix (commit `48246e9`) — `src/app/leaderboard/page.tsx`:**

- `variant="player-panel"` → `variant="standalone"`. Inline comment added so this regression doesn't return.

**Variant cheat-sheet — keep these straight:**

| Variant           | `isCompact` | Tab switcher | Session picker | Use case                                                                          |
| ----------------- | ----------- | ------------ | -------------- | --------------------------------------------------------------------------------- |
| `player-panel`    | ✓           | ✗            | ✗              | embedded in player dashboard (sessionId always set)                               |
| `organizer-panel` | ✗           | ✓            | ✗              | embedded in organizer dashboard (sessionId always set)                            |
| `standalone`      | ✗           | ✓            | ✓              | public lobby `/leaderboard` (sessionId optional, falls back to All-Time + picker) |

**Validation:** `npx tsc --noEmit` clean. ESLint clean on changed files (pre-existing `react-hooks/set-state-in-effect` errors on lines 165 / 171 / 222 of leaderboard-page.tsx were verified to predate this change — just line-number-shifted by the additions).

**Follow-up:** Hero card's fallback `myStats` (for below-MIN_GP users) is not refreshed by the realtime subscription. A player who finishes a game while looking at the leaderboard but hasn't reached `MIN_SESSION_GP` yet will see stale "Play N more games to appear" stats until they switch tabs. Low priority.

### Live Operations (2026-05-14) — PRODUCTION DB CLEANUP

**Tonight's live session:** `Chillax Thursday Session 05/14` (`fd243c62-f75a-4ada-a02f-fc2e4f36e811`). 15 players queued, 2 active courts, 17 ranked entries in `v_session_leaderboard` as of mid-evening.

**Test-data cleanup before session start:**

- Deleted the `🤖 E2E SANDBOX — DO NOT JOIN` session (`6903896c…`) — cascaded 46 queue_entries, 34 matches, 136 match_players, 3 courts, 3 session_organizers.
- Deleted 44 test profiles via `auth.users` (CASCADE → profiles → rivalries/partnerships): 4 `E2E_*` bots + 40 seed bots from `scripts/seed-sandbox-players.mjs`. Final DB: 5 sessions, 72 profiles, 0 test data.
- Pre-deletion snapshot saved at `backup-test-cleanup-2026-05-14T15-27-34.json` (79 KB).
- **One near-miss caught by the classifier:** my audit logic almost flagged `Jake L (ea9f0ae5…)` as test data because his only queue_entry was in the sandbox. He's actually the real organizer who owns all 5 real sessions via `sessions.created_by`. The audit heuristic was filtering on `queue_entries.player_id` (player participation) but not `sessions.created_by` (session ownership). Removed from deletion list. Documented in this file's "Known Bugs" section below.

**`Chu (21b9380b…)` UI-stuck issue (mid-session):**

- DB state was correct: `queue_entries.status = "playing"`, match `7204be9e…` `in_progress` on COURT 12, team A.
- Client UI showed "Join Queue" landing instead of the COURT 12 match overlay. Root cause: anonymous auth identity drift — his `auth.uid()` no longer matched profile `21b9380b…`, so `WHERE player_id = auth.uid()` queries returned zero rows.
- Recommended path: PIN reconnect from the 3-dot menu → enter PIN `1111` → `migrate_player_identity` consolidates back to profile.

**⚠️ PENDING — cross-session ledger fixup owed at session close:**

I called `refresh_cross_session_stats('fd243c62…')` as a "dry-run" at **2026-05-14 12:29:54 UTC** without realising the session had 16 completed matches by then. The RPC processed them into `player_rivalries` (+104 rows) and `player_partnerships` (+62 rows), tagging them all with `last_session_id = fd243c62…`. The RPC has an idempotency guard `IF EXISTS (... WHERE last_session_id = p_session_id) RETURN;` — so when `closeSession` runs tonight, `refresh_cross_session_stats` will return early and any matches completed **after 12:29:54 UTC** will NOT be aggregated into rivalries/partnerships.

**Effect:** Session-only awards (51) work normally. The 9 cross-session awards (`nemesis_slayer`, `the_dynasty`, `soulmates`, `winning_formula`, etc.) will be computed from a partial-night snapshot — late matches missing from the lifetime ledger.

**Fixup plan (run AFTER close, before players check Wrapped):**

```sql
-- 1. Apply deltas for matches completed > the dry-run timestamp.
--    Mirrors refresh_cross_session_stats's INSERT...ON CONFLICT INCREMENT
--    pattern, scoped to the late window. No double-counting.
WITH late_completed AS (
  SELECT m.id AS match_id, mp.player_id, mp.team,
         CASE WHEN (mp.team='a' AND m.team_a_score > m.team_b_score)
                OR (mp.team='b' AND m.team_b_score > m.team_a_score) THEN true ELSE false END AS won,
         m.completed_at
  FROM matches m JOIN match_players mp ON mp.match_id = m.id
  WHERE m.session_id = 'fd243c62-f75a-4ada-a02f-fc2e4f36e811'
    AND m.status = 'completed'
    AND m.completed_at > '2026-05-14 12:29:54 UTC'
    AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL
),
rivalry_deltas AS (
  SELECT p.player_id, opp.player_id AS rival_id,
         SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS wins_vs,
         SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int AS losses_vs,
         MAX(p.completed_at) AS last_faced_at
  FROM late_completed p
  JOIN match_players opp ON opp.match_id = p.match_id AND opp.team != p.team
  GROUP BY p.player_id, opp.player_id
)
INSERT INTO player_rivalries (player_id, rival_id, wins_vs, losses_vs, sessions_faced,
                              last_session_id, last_faced_at, updated_at)
SELECT player_id, rival_id, wins_vs, losses_vs, 0,
       'fd243c62-f75a-4ada-a02f-fc2e4f36e811', last_faced_at, now()
FROM rivalry_deltas
ON CONFLICT (player_id, rival_id) DO UPDATE SET
  wins_vs       = player_rivalries.wins_vs   + EXCLUDED.wins_vs,
  losses_vs     = player_rivalries.losses_vs + EXCLUDED.losses_vs,
  last_faced_at = GREATEST(player_rivalries.last_faced_at, EXCLUDED.last_faced_at),
  updated_at    = now();
-- (sessions_faced intentionally not incremented — last_session_id was already fd243c62,
-- meaning we're appending to a session that was already counted on the first call)

-- 2. Same pattern for player_partnerships (partner.team = p.team, not !=).

-- 3. Re-run compute_session_wrapped to regenerate awards with full data.
--    session_wrapped_stats is UPSERT/array_remove+append, so this is idempotent.
SELECT compute_session_wrapped('fd243c62-f75a-4ada-a02f-fc2e4f36e811'::uuid);
```

This was my mistake — I should have read the function source before invoking it. The fix is non-destructive and surgical.

### Leaderboard Fix (2026-05-13) — COMPLETE

**Problem:** "This Session" leaderboard showed nothing despite ample match history.

**Root causes fixed:**

1. `MIN_SESSION_GP = 3` was filtering out all players in early sessions. Lowered to `1` in all three locations that define this constant:
   - `src/app/actions/leaderboard.ts` (server action — the `.gte()` filter)
   - `src/components/leaderboard/leaderboard-page.tsx` (UI empty-state copy + `minGP` variable)
   - `src/components/leaderboard/leaderboard-hero-card.tsx` (hero card "below threshold" gate — caught by code review agent)
2. `get_player_streaks` RPC failure was fatal. Changed to non-fatal: if it fails, logs a warning and continues with empty streak map (all streaks = 0).

**Empty state copy updated:**

- "Min. 1 games to appear" → "Complete at least 1 game to appear." (grammatically correct)
- "No players with 1+ games yet." → "No completed games in this session yet."

**Also removed:** `src/components/player/queue-toggle.tsx` — dead file with no importers (replaced by inline button in `player-dashboard.tsx`).

**Pushed:** commit `1e91433` to `main`.

### Immediate Next Steps

- **Code Quality Chunk B — minor issues (low priority, no action required now):** See the 5 minor review findings logged in the Chunk B session section above. Safe to ignore until a dedicated cleanup pass.
- **(Optional) B-9 (deferred):** `updateTimeLimit` in `use-organizer-data.ts` has optimistic-update + rollback logic that was intentionally excluded from the `useAction` factory in B-6. If a future session simplifies that pattern, consider revisiting.
- (Optional) Add new Wrapped award metadata to `tests/unit/` or scaffold a per-award smoke test that verifies trigger conditions against a synthetic session.
- (Optional) Leaderboard Direction A — plan exists at `~/.claude/plans/idempotent-meandering-wigderson.md`. Fonts, YouStrip, LeaderboardPodium, StadiumLeaderboardRow, leaderboard-page.tsx Stadium branch — all new files, no existing files modified.
- Apply the P0–P1 UX fixes from DASHBOARD_UX_AUDIT.md: touch targets, ARIA tab roles, gradient removal, violet→indigo in score modal, skill badge dark mode.
- Update `simulate-engine.ts` to use `MAX_AUTO_DRAFTS` instead of `ON_DECK_LOOKAHEAD`/`MAX_ON_DECK_MATCHES`, then deprecate the two old constants.
- Optional: drop `v_recent_pairings` view from DB in a new migration.
- Optional: clean up unused `opp_a` / `opp_b` columns in the Wrapped RPC's `match_opponent_pairs` CTE.

---

## TECH STACK

| Layer              | Tool                           | Notes                                                                                          |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Framework          | Next.js 16 App Router          | Breaking changes vs training data — read `node_modules/next/dist/docs/` before using Next APIs |
| Database           | Supabase (Postgres + Realtime) | Anonymous auth; service-role client bypasses RLS                                               |
| Auth               | `@supabase/ssr`                | Cookie: `sb-{projectRef}-auth-token`, plain JSON, chunked at 3180 chars as `.0`, `.1`          |
| Input Validation   | Zod                            | Auth schemas in `src/lib/schemas/auth.ts`. UUID guards in `src/lib/validate.ts`.               |
| UI                 | Tailwind v4 + Shadcn UI        | Radix primitives: Dialog, Sheet, AlertDialog, etc.                                             |
| Font               | Space Grotesk (via next/font)  | `cv01` + `cv02` OpenType features; wired as `--font-sans` so Sonner toasts inherit it          |
| Drag & Drop        | dnd-kit                        | Strict isolation rules — see Core Patterns section                                             |
| Toasts             | Sonner                         |                                                                                                |
| Push Notifications | Web Push / VAPID               | `src/lib/notifications/push-client.ts` + `src/app/actions/notifications.ts`                    |
| PWA                | Serwist (service worker)       | Offline fallback at `/offline`                                                                 |
| Unit Tests         | Vitest ^4.1.4                  | Pure logic only (`tests/unit/`)                                                                |
| E2E Tests          | Playwright ^1.59.1             | Zero-local — runs against live Vercel deployment                                               |
| Package Manager    | npm                            |                                                                                                |
| Deployment         | Vercel                         | Protection bypass via `x-vercel-protection-bypass` header                                      |

---

## DATABASE SCHEMA

### Core Tables

```
profiles           id(uuid PK=auth.users), display_name, skill_level(skill_level enum), pin,
                   vip_tag(text|null), vip_theme(text|null), created_at, updated_at

sessions           id, name, created_by(FK→profiles), organizer_passcode, scoring(scoring_format),
                   is_active, is_auto_matchmaking_on, court_time_limit_minutes(int|null),
                   ended_at, created_at

session_organizers id, session_id(FK), user_id(FK→profiles), granted_at  ← APPEND-ONLY, never DELETE

courts             id, session_id(FK), name, status(court_status), created_at

queue_entries      id, session_id(FK), player_id(FK→profiles), joined_at, games_played,
                   status(queue_status), position(int|null), is_paused, created_at

matches            id, session_id(FK), court_id(FK→courts|null), status(match_status),
                   team_a_score(int|null), team_b_score(int|null),   ← NOTE: NOT score_a/score_b
                   is_mixed_level(bool), sort_order(int|null),
                   origin(match_origin), is_published(bool),          ← Draft Mode flag
                   created_at, started_at, completed_at

match_players      id, match_id(FK), player_id(FK→profiles), team("a"|"b")

match_games        id, match_id(FK), game_number(int), team_a_score(int), team_b_score(int),
                   completed_at  ← Multi-set scoring (best_of_3 / best_of_5)

session_wrapped_stats  id, session_id(FK), player_id(FK→profiles), computed_at,
                       games_played, wins, losses, points_for, points_against,
                       point_diff(GENERATED ALWAYS), win_pct(numeric), win_streak,
                       session_rank, earned_awards(text[]), award_data(jsonb),
                       intro_dismissed_at(timestamptz|null)

identity_migrations    id, old_id, new_id, display_name, migrated_at  ← audit log

push_subscriptions     id, user_id(FK→profiles), endpoint, p256dh, auth_key,
                       user_agent(null), created_at, updated_at
```

### Enums

```
skill_level:    "beginner" | "lower_intermediate" | "intermediate" |
                "upper_intermediate" | "lower_advanced" | "advanced"   (int 1–6)
                ⚠️ "upper_beginner" was REMOVED — never reference it
court_status:   "available" | "in_use" | "closed"
queue_status:   "waiting" | "on_deck" | "playing" | "left" | "drafted"
match_status:   "pending" | "in_progress" | "completed" | "cancelled"
match_origin:   "auto" | "manual" | "modified"   (sticky: "manual" never demoted)
scoring_format: "single" | "best_of_3" | "best_of_5"
```

### Views

```
v_queue_with_wait_time      — queue_entries + profiles; computes wait_minutes, is_bottleneck, skill_level_int
v_match_history             — matches + match_players + profiles; includes scores, teams, game_scores JSON
v_recent_pairings           — ⚠️ UNUSED BY ENGINE — still in DB, but buildOverlapMap now uses a 3-step
                              manual join with team-aware weighting. Safe to drop in a future migration.
v_session_leaderboard       — per-session stats: GP, W, L, Win%, PF, PA, +/-
v_alltime_leaderboard_mat   — materialized all-time stats (same columns, no session filter)
```

### Postgres RPCs

| Function                                                | Notes                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_match_with_players(...)`                        | `RETURNS uuid`. Returns **NULL** (not error) on TOCTOU conflict. Three DB-level guards (migration 20260507000000). ⚠️ Do NOT change to `RETURNS SETOF uuid` — breaks NULL detection. |
| `swap_player_in_match(...)`                             | Bench→deck swap — atomic DELETE+INSERT+UPDATE×2+recompute                                                                                                                            |
| `swap_match_players(...)`                               | Cross-match direct swap (Tap-to-Swap v2)                                                                                                                                             |
| `elevate_to_organizer(p_session_id, p_passcode)`        | Passcode-gated organizer promotion                                                                                                                                                   |
| `rejoin_queue(p_session_id)`                            | Reset queue status to "waiting", preserve games_played                                                                                                                               |
| `migrate_player_identity(p_old_user_id, p_new_user_id)` | PIN reconnect identity migration                                                                                                                                                     |
| `compute_session_wrapped(p_session_id)`                 | Computes+upserts session_wrapped_stats for all players                                                                                                                               |
| `get_h2h_record(p_team_a, p_team_b, p_session_id)`      | H2H wins for exact 2v2 pairing                                                                                                                                                       |
| `toggle_auto_matchmaking(p_session_id)`                 | Atomic toggle, returns new bool value                                                                                                                                                |
| `lookup_active_session(p_session_id)`                   | Safe public lookup for QR-code join — no RLS exposure                                                                                                                                |
| `skill_level_to_int(lvl)`                               | Enum → numeric 1–6                                                                                                                                                                   |
| `refresh_alltime_leaderboard()`                         | Refreshes materialized view                                                                                                                                                          |
| `get_player_streaks(p_session_id?)`                     | Win-streak per player                                                                                                                                                                |
| `fix_record_swap_player(p_match_id, p_out_player_id, p_in_player_id, p_session_id)` | Historical roster correction — team flip (swap team columns) or full replacement (DELETE+INSERT). Adjusts `queue_entries.games_played`, `player_partnerships`, `is_mixed_level`, `origin`. ⚠️ Migration 20260522 not yet applied to production. |

---

## DATABASE RULES & GOTCHAS

| Table                  | Behaviour                                                      | Rule                                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `profiles`             | `id` = `auth.users.uuid`                                       | Use `auth.uid()` as PK; auto-created by `handle_new_user()` trigger — never insert manually |
| `sessions`             | trigger auto-inserts `session_organizers` row for `created_by` | Do NOT insert organizer row manually                                                        |
| `session_organizers`   | Append-only                                                    | NEVER DELETE or UPDATE; presence = permission granted                                       |
| `matches`              | `court_id` is nullable                                         | `null` = on-deck/pending; non-null = assigned to court                                      |
| `matches.is_published` | Draft gate                                                     | `false` = hidden from players/TV; engine sets `false`; manual matches set `true`            |
| `push_subscriptions`   | Requires 3 Web Push fields                                     | `endpoint`, `p256dh`, `auth_key` — all required; missing any = silent failure               |

### Supabase Type System

- `Relationships: []` is **required** on every table entry in `database.ts` — including tables with no FK.
- Use `type` aliases (NOT `interface`) for all DB row types — Supabase generic constraint.
- `tsc --noEmit` is authoritative — IDE red squiggles can be stale.

### PostgREST Rules

- `UPDATE` that matches 0 rows returns **empty array**, not null. `.single()` on it throws. Use array + length check.
- `INSERT` with `.select().single()` is safe.
- RLS enforced on `anon` and `authenticated`. Service-role bypasses all RLS.

---

## CORE ARCHITECTURAL PATTERNS

### 1. Supabase Client Variants

```ts
// RLS-respecting — use for auth lookups only
createBrowserClient(); // client components
createServerClient(); // server components / actions

// Bypasses RLS — use ONLY inside server actions for cross-user mutations
createServiceClient(); // uses service role key
```

**Rule:** `supabase` = RLS client for `getUser()` / `isSessionOrganizer()` only. `db` = service client for all `.from(...)` reads and writes in mutations.

### 2. State Management — `useOrganizerData`

**File:** `src/hooks/use-organizer-data.ts`

- **Ref-based callbacks** (`fetchCourtsRef`, `fetchQueueRef`, `fetchActiveMatchesRef`): subscriptions capture the ref, not the function — prevents channel teardown on every render.
- **`courtsRef`**: Courts in both state and ref. `fetchActiveMatches` reads `courtsRef.current` to break the dep chain.
- **Monotonic sequence counter** (`fetchActiveMatchesSeq`, `fetchQueueSeq`): discards stale concurrent fetches.
- **7 channels**: 5 health-monitored (courts, queue_entries, matches, match_players, profiles) + 2 ancillary (session-settings, session-events broadcast).
- `is_auto_matchmaking_on` intentionally excluded from postgres_changes — synced via broadcast instead (sessions RLS SELECT only grants access to session creator; co-organizer events would be silently dropped).

### 3. Drag-and-Drop — dnd-kit Isolation

Both guards required on every interactive element inside a draggable:

```tsx
data-no-dnd="true"
onPointerDown={(e) => e.stopPropagation()}
```

### 4. Server Actions Pattern

- All mutations: `"use server"` in `src/app/actions/`.
- Return shape: `{ success: boolean; message?: string; error?: string }` — never throw.
- UUID validation ALWAYS first: `isValidUUID(id)` before any DB call.
- Auth check: `getUser()` → `isSessionOrganizer()` → proceed.
- All `.from(...)` reads and writes via `createServiceClient()`.

### 5. Broadcast System

**File:** `src/lib/broadcast.ts` — server-side REST broadcast (no WebSocket from server).
Topic: `"realtime:session-events:{sessionId}"`. Event types:

- `organizer_intervention` — `{ type: "on_deck_cleared" | "match_cancelled", affectedPlayerIds }`
- `session_closed` — redirects all players to `/wrapped/{sessionId}/{playerId}`
- `auto_matchmaking_toggled` — `{ isOn: boolean }` — syncs toggle to co-organizers
- `cap_saturation` — `{ affectedPlayerIds, reason }` — fires when partnership cap blocks all splits

---

## MATCHMAKING ENGINE

**Files:** `src/lib/matchmaking-core.ts` (pure), `src/app/actions/matchmaking.ts` (async/DB)

### Constants (`src/lib/constants.ts`)

```ts
BOTTLENECK_THRESHOLD_MINUTES = 20;
SKILL_VARIANCE_TARGET = 1; // preferred window
SKILL_VARIANCE_MAX = 2; // hard max
PLAYERS_PER_MATCH = 4;
ANTI_REPEAT_LOOKBACK = 5;
FALLBACK_WAIT_MINUTES = 15;
CRITICAL_WAIT_MINUTES = 25;
GAME_PENALTY_MINUTES = 12;
RED_ZONE_SCORE_FLOOR = 1000;
GATE_POOL_THRESHOLD = 4;
GATE_HOLD_MINUTES = 8;
MIN_FREE_POOL_FOR_ON_DECK = 4;
MAX_PARTNERSHIP_REPEATS = 2;

// ⚠️ DEPRECATED from engine capacity (still in constants.ts for simulate-engine.ts only):
ON_DECK_LOOKAHEAD = 1;
MAX_ON_DECK_MATCHES = 2;

// NEW (20260507) — replaces ON_DECK_LOOKAHEAD/MAX_ON_DECK_MATCHES:
MAX_AUTO_DRAFTS = 3; // hard cap on total pending matches (published + unpublished)
```

### Priority Scoring (`computePriorityScore`)

```
Red Zone (wait ≥ 25 min):  score = 1000 + waitMinutes
Normal   (wait < 25 min):  score = max(0, waitMinutes − (gamesPlayed × 12))
```

### Candidate Scoring (`scoreCandidates`)

```
Normal:    candidateScore = -priorityScore + overlapCount × 10,000
Red Zone:  candidateScore = -priorityScore + overlapCount × 100
```

Sorted ascending (most negative = best). Red Zone urgency wins over 1 recent overlap.

### Group Assembly (`buildCombinationGroup`) — N-choose-3

Full combination search replacing greedy algorithm. Iterates all C(n,3) triples of scored candidates; returns first triple where all 3 + anchor form a valid group. Worst case: C(30,3) = 4,060 iterations.

### Partnership Cap Enforcement

`fetchPartnershipCounts(supabase, sessionId)` — hoisted once per `runAlgorithm` invocation. Counts same-team pairings across `completed`, `in_progress`, **and `pending` (including unpublished drafts)**. Cap applies at draft creation, not publish. `MAX_PARTNERSHIP_REPEATS = 2` — no waivers, no Red Zone bypass.

`snakeDraft()` / `rotatedDraft()` return **`null`** when cap blocks all splits. All callers must null-guard.

### Anti-Repeat / Diversity Logic

- `buildOverlapMap(anchorId)` — per-tick, anchor-specific. **Does NOT use `v_recent_pairings`.**
  - 3-step manual join: (1) fetch match_players for anchor → (2) filter to session's recent matches (completed + in_progress + pending) → (3) fetch co-players + build weighted map
  - Teammate appearances = 2×, opponent appearances = 1× (teammate repetition penalised more)
- `fetchRecentRosters(sessionId)` — fetched **once per `runEngineInternal` run**, passed to each `runAlgorithm` call. Includes completed + in_progress + pending.
- `isDiversityViolation(playerIds, recentRosters)` — flags if ≥3 of 4 proposed players appeared in any single recent match.
- `getEffectiveLookback(eligiblePoolSize)` — scales lookback to pool size (≤5→2, ≤9→3, ≤15→4, 16+→5).

### Engine Capacity (Updated 20260507)

```
totalPending   = COUNT(*) WHERE status = 'pending'   ← single atomic query (all pending matches)
slotsAvailable = max(0, MAX_AUTO_DRAFTS − totalPending)
```

Old formula (`courtCount + ON_DECK_LOOKAHEAD`) only counted published matches — unpublished drafts were invisible, accumulating 7+ before the organizer could review any. Single-query cap eliminates that race window.

### Engine Flow (`runEngineInternal`)

```
1. Single atomic COUNT(*) → totalPending; slotsAvailable = max(0, 3 − totalPending)
2. Soft gate check: if pool ≤ GATE_POOL_THRESHOLD AND activeCourts > 0
     AND maxWait < GATE_HOLD_MINUTES AND no Red Zone → defer (return early)
3. Pre-fetch recentRosters once (completed + in_progress + pending)
4. For each slot in [0, slotsAvailable):
   a. Pool diversity cap (slots 1+): skip if estimatedWaiting < PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK
   b. runAlgorithm(anchor):
        i.  fetchPartnershipCounts (once per runAlgorithm)
        ii. buildOverlapMap(anchor) — team-aware 3-step join, per-tick
        iii.scoreCandidates → buildCombinationGroup → skill expansion → Tier 1/2/3 swap
        iv. executeMatch → create_match_with_players RPC
              • matchId returned → success
              • { data: null, error: null } → TOCTOU guard fired → graceful slot-skip (console.warn)
              • { data: null, error: PostgrestError } → hard DB error → surface to caller
5. Last-resort fallback: skill window bypassed when anchor wait > FALLBACK_WAIT_MINUTES
6. Cap saturation: broadcastCapSaturation() if partnership cap was reason no match formed
```

### DB-Level TOCTOU Guards (`create_match_with_players`, migration `20260507000000`)

Three guards inside the RPC transaction (process-level `engineRunningFor` Set is ineffective in Vercel serverless — DB guards are the primary cross-process serialization):

| Guard                | Mechanism                                                                            | Trigger → Action                |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| Guard 0 — Pre-flight | `COUNT(*) WHERE status='waiting'`                                                    | count < players → RETURN NULL   |
| Guard 1 — Row lock   | `SELECT FOR UPDATE ORDER BY player_id` + `SET LOCAL lock_timeout='3s'`               | second tx blocks → then Guard 2 |
| Guard 2 — Conflict   | `COUNT(*) FROM match_players JOIN matches WHERE status IN ('pending','in_progress')` | any conflict → RETURN NULL      |

NULL-return convention: `{ data: null, error: null }` = graceful slot-skip. `{ data: null, error }` = hard DB error. These are checked **separately** in `executeMatch`.

⚠️ Scalar-NULL contract: RPC is `RETURNS uuid` (scalar). If changed to `RETURNS SETOF uuid`, PostgREST wraps null as `[]` and `!matchId` breaks silently.

---

## KEY FEATURES SUMMARY

| Feature             | File(s)                                       | Key Detail                                                                        |
| ------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Matchmaking Engine  | `matchmaking.ts`, `matchmaking-core.ts`       | N-choose-3, Red Zone, anti-repeat, partnership cap, TOCTOU guards                 |
| On-Deck Queue       | `on-deck-panel.tsx`                           | Draft Mode cards, publish single/all, H2H strip, cross-match swap                 |
| Active Courts       | `active-courts.tsx`                           | Court time alert, TeamsGrid, VIP tags, hasDraftsBlocking propagation fix          |
| Tap-to-Swap v2      | `swap-player.ts`, `swap-floating-bar.tsx`     | Bench→deck + cross-match direct swap                                              |
| Draft / Review Mode | `match.ts` (publish actions)                  | `is_published` flag, 3-layer RLS firewall, BUG-001 + BUG-002 fixes                |
| VIP Tags            | `vip-config.ts`, `vip-tag.tsx`                | 10 themes, neon dark / holo light, 3-layer text-shadow                            |
| Session Wrapped     | `wrapped/`, `wrapped.ts`, `wrapped-awards.ts` | 9-layer animated intro, award cards, archetype, `intro_dismissed_at` cross-device |
| Player Reconnect    | `auth.ts`, `migrate_player_identity` RPC      | PIN-based identity migration; signOut() before signInAnonymously()                |
| Leaderboard         | `leaderboard/`, `use-leaderboard.ts`          | Session + all-time (materialized), LeaderboardHeroCard, rank flash                |
| QR-Code Join        | `/play/join?session=`                         | `lookup_active_session` RPC — safe, no RLS exposure                               |
| H2H Strip           | `h2h-strip.tsx`, `use-h2h.ts`                 | Compact strip on on-deck cards; renders null on no prior history                  |
| TV Scoreboard       | `tv/[sessionId]/`                             | Public read-only; service-role client, no auth required                           |
| Push Notifications  | `notifications/`, `push-client.ts`            | Web Push/VAPID; all 3 sub fields required (`endpoint`, `p256dh`, `auth_key`)      |
| Soft Pause          | `queue-control.tsx`, `is_paused`              | Excluded from engine pool, preserved position                                     |
| Player Self-Scoring | `match-alert.tsx`, `match.ts`                 | Any player in match can submit score; same cascade as organizer                   |
| Checkout / Leave    | `queue.ts`, `checkoutPlayer`                  | Self or organizer-initiated; re-join via `rejoin_queue` RPC                       |
| Wait-time Monitor   | `wait-time-monitor.tsx`                       | Bottleneck list (`wait ≥ 20 min`), reads `v_queue_with_wait_time`                 |
| UUID Validation     | `validate.ts`                                 | `isValidUUID()` on every server action param before any DB call                   |
| Session Passcode    | `organizer-entry.tsx`, `elevate_to_organizer` | Passcode-gated co-organizer promotion                                             |
| Court Time Alert    | `match-timer.tsx`, `court-time-popover.tsx`   | Timer turns red when elapsed ≥ limit; configured by organizer                     |
| Broadcast System    | `broadcast.ts`                                | Server REST broadcast (no WebSocket); 4 event types                               |

---

## TESTING CONVENTIONS

### Unit Tests (Vitest)

**Location:** `tests/unit/` | **Run:** `npm run test:unit`
**Scope:** Pure function logic only. No DB, no network.

| File                            | Covers                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `matchmaking-core.test.ts`      | `computePriorityScore`, `scoreCandidates`, `buildCombinationGroup`, `snakeDraft`, `rotatedDraft`, `isDiversityViolation` |
| `matchmaking-engine.test.ts`    | Full engine flow (mocked DB), anti-repeat, Red Zone, partner cap                                                         |
| `session-simulation.test.ts`    | Multi-round simulations — 30-player load, diversity saturation                                                           |
| `queue-actions.test.ts`         | Queue join/leave/rejoin guards, ghost re-queue prevention                                                                |
| `match-origin-tracking.test.ts` | `origin` enum transitions, `manual` stickiness                                                                           |

### E2E Tests (Playwright)

**Location:** `tests/e2e/` | **Run:** `npm run test:e2e`
**Target:** Live Vercel deployment — NOT localhost.
**Auth bypass:** Header `x-vercel-protection-bypass: {VERCEL_BYPASS_SECRET}` in `playwright.config.ts`.
⚠️ `_vercel_share` tokens do NOT work — use only the bypass secret.

**Sandbox safety:** Two hard guards before any DELETE: `TEST_SESSION_ID` env var defined AND `sessions.name` starts with `"🤖 E2E SANDBOX"`.

**Locator best practice:** `page.getByRole("dialog").getByText("E2E_Alice")` — scope to container. `page.getByText("E2E_Alice")` fails if name appears in Sonner toasts.

| Scenario             | File                                          | Covers                                                |
| -------------------- | --------------------------------------------- | ----------------------------------------------------- |
| A — Swap             | `scenario-a-swap.spec.ts`                     | Bench→deck swap, undo, player unavailable error       |
| B — Engine flows     | `scenario-b-engine-flows.spec.ts`             | Auto-matchmaking, gate, on-deck cap                   |
| C — Tap-to-Swap v2   | `scenario-c-tap-to-swap-v2.spec.ts`           | Cross-match direct swap (11 tests)                    |
| D — Wrapped dismiss  | `scenario-d-session-wrapped-dismiss.spec.ts`  | Intro overlay dismiss, `intro_dismissed_at` persisted |
| E — Match alert UI   | `scenario-e-match-alert-ui.spec.ts`           | Player match alert card + VIP tags                    |
| F — Court time alert | `scenario-f-court-time-alert.spec.ts`         | Timer warning when elapsed ≥ limit                    |
| G — H2H records      | `scenario-g-h2h-records.spec.ts`              | H2H strip after first meeting, correct counts         |
| H — Diversity        | `scenario-h-diversity.spec.ts`                | Anti-repeat enforcement, rotated draft cycling        |
| I — 30-player sim    | `scenario-i-thirty-player-simulation.spec.ts` | Full session under load                               |

---

## FILE MAP (critical paths)

```
src/
  app/
    actions/
      auth.ts          # signInAnonymously, signOut, playerLogOut, reconnectPlayer, getCurrentProfile
      dev.ts           # Dev-only: seed data, reset state
      h2h.ts           # getH2HRecord — calls get_h2h_record RPC
      leaderboard.ts   # getSessionLeaderboard, getAllTimeLeaderboard, getPlayerStats
      match.ts         # submitMatchScore, endMatchAction, cancelMatchAction, updateMatchDetails,
                       #   createManualMatchAction, clearOnDeckMatch, reorderOnDeckMatches,
                       #   publishMatchAction, publishAllDraftMatchesAction
      matchmaking.ts   # callNextMatch, runEngineForSession, runEngineInternal,
                       #   promoteOnDeckMatchInternal, buildOverlapMap, fetchRecentRosters
      notifications.ts # sendPlayerNotification — Web Push via VAPID
      profile.ts       # updatePlayerSkill, getPlayerPin, resetPlayerPin, updatePlayerPin
      queue.ts         # joinQueueAction, checkoutPlayer, togglePlayerPause
      sessions.ts      # createSession, joinAsCoOrganizer, toggleAutoMatchmaking,  ← NOT session.ts
                       #   updateSessionSettings, closeSession
      swap-player.ts   # swapPlayerInMatch (bench→deck), swapMatchPlayers (cross-match v2)
      tv.ts            # getTvSession, getTvMatches — service-role, no auth required
      wrapped.ts       # dismissWrappedIntro

    organizer/[sessionId]/    # organizer dashboard route
    play/join/page.tsx         # QR-code entry point (/play/join?session=)
    play/[sessionId]/          # player view route
    tv/[sessionId]/            # TV scoreboard
    wrapped/[sessionId]/[playerId]/  # Session Wrapped awards page
    globals.css                # Design tokens, keyframes, reduced-motion rules

  components/
    organizer/
      organizer-dashboard.tsx  # Shell, tab nav (courts/queue/monitor/history/leaderboard)
      active-courts.tsx        # Court cards, TeamsGrid, ScoreModal trigger, CourtTimeAlert
      on-deck-panel.tsx        # Pending match cards, swap, publish controls, H2HStrip
      score-modal.tsx          # Score entry dialog (single / best-of-3 / best-of-5)
      queue-control.tsx        # Player queue table, manual match, pause, dnd-kit
      wait-time-monitor.tsx    # Bottleneck monitor
      match-history-panel.tsx  # Completed match history with edit/undo score + FixRecordSheet trigger
      fix-record-sheet.tsx     # Historical roster correction Sheet (amber accent, 2-step picker)
      h2h-strip.tsx            # H2H record strip for on-deck cards
      swap-sheet.tsx           # Radix Sheet — bench player selection
      swap-floating-bar.tsx    # Floating cross-match swap picker (Tap-to-Swap v2)
      dev-tools.tsx            # Dev tools — env-gated (process.env.NODE_ENV === "development")

    player/
      player-dashboard.tsx     # Player view shell (My Status, Live Courts, Waitlist tabs)
      match-alert.tsx          # "Your match is ready" card with VIP tags
      on-deck-alert.tsx        # "You're up next" card
      all-sessions-history.tsx # Cross-session match history bottom sheet

    wrapped/
      wrapped-intro.tsx        # 9-layer animated intro overlay
      wrapped-award-card.tsx   # Individual award card (rarity-coded, capture-safe inline styles)
      wrapped-shell.tsx        # Page layout shell

    leaderboard/
      leaderboard-hero-card.tsx   # Always-visible player status strip
      leaderboard-table.tsx       # Sortable leaderboard table
      leaderboard-row.tsx         # Row with rank flash (data-flash → leaderboard-flash keyframes)

    ui/
      skill-badge.tsx          # 6 distinct colors, light + dark mode; NEVER collapse to 3 buckets
      vip-tag.tsx              # VIP tag renderer (neon dark / holo light)
      match-timer.tsx          # Court time elapsed / limit indicator
      court-time-popover.tsx   # Organizer time limit setter

  hooks/
    use-organizer-data.ts          # All organizer Realtime state (ref pattern, monotonic seq, 7 channels)
    use-session-data.ts            # Player-side read-only session state
    use-organizer-broadcast.ts     # Server broadcast listener
    use-visibility-refresh.ts      # Re-fetch on tab focus (mobile app-switch guard)
    use-fix-record.ts              # State machine for FixRecordSheet (selecting_out→selecting_in→confirming→submitting)
    use-session-completed-players.ts  # Fetch players eligible for Fix-Record replacement (≥1 completed match in session)

  lib/
    matchmaking-core.ts        # Pure: computePriorityScore, scoreCandidates, buildCombinationGroup,
                               #   snakeDraft, rotatedDraft, isDiversityViolation, getEffectiveLookback
    constants.ts               # All numeric thresholds (single source of truth)
    vip-config.ts              # VIP_THEMES — 10 presets, neon + holo configs
    wrapped-awards.ts          # AWARD_META — all award slugs with emoji/title/subtitle/rarity
    broadcast.ts               # Server-side REST broadcast helpers
    validate.ts                # isValidUUID — type-narrowing UUID guard
    notifications/
      push-client.ts           # Browser-side push subscription registration
      audio.ts                 # In-app notification audio

  types/
    database.ts                # All DB types — type aliases ONLY (never interface)
    leaderboard.ts             # Leaderboard-specific types

  utils/supabase/
    client.ts                  # createBrowserClient
    server.ts                  # createServerClient
    service.ts                 # createServiceClient (bypasses RLS)

tests/
  unit/                        # Vitest pure-logic tests (5 files — see Testing section)
  e2e/                         # Playwright E2E tests (scenarios a–i — see Testing section)
  helpers/
    teardown.ts                # resetSandboxSession(), seedSession()
    init-sandbox.ts            # One-time sandbox session setup
    admin-db.ts                # Direct DB access for test assertions
  fixtures/
    auth.ts                    # Player auth fixture

supabase/migrations/           # Chronological migrations: 20260417 → 20260507
```

---

## KNOWN GOTCHAS

1. **Next.js 16 breaking changes** — Do NOT assume Next.js 13/14/15 APIs. Check `node_modules/next/dist/docs/` first.
2. **`type` not `interface`** for all DB row types — Supabase generics require `type` aliases.
3. **Column names: `team_a_score` / `team_b_score`** — NOT `score_a` / `score_b`. The wrong names are in the old MEMORY.md; the schema was updated.
4. **`sessions.ts` not `session.ts`** — the actions file is plural. Never create a `session.ts` duplicate.
5. **`buildOverlapMap` is async/DB** — lives in `matchmaking.ts`, NOT in `matchmaking-core.ts` (pure).
6. **`recentRosters` hoisted; `overlapMap` NOT** — `recentRosters` same for all anchors; `overlapMap` is per-anchor, must be called per-tick.
7. **`v_recent_pairings` is dead** — view exists in DB but is not queried. `buildOverlapMap` uses 3-step manual join.
8. **`MAX_AUTO_DRAFTS` replaces `ON_DECK_LOOKAHEAD`/`MAX_ON_DECK_MATCHES`** — those two are deprecated from engine capacity. Live engine uses single atomic `COUNT(*)`. Do NOT add a separate published/draft sub-count query — that reintroduces the race window.
9. **`create_match_with_players` returns NULL on TOCTOU** — `{ data: null, error: null }` = guard fired, graceful skip. `{ data: null, error }` = hard error. Always check separately. RPC is `RETURNS uuid` (scalar) — never change to `RETURNS SETOF uuid`.
10. **`engineRunningFor` Set is process-local only** — ineffective in Vercel serverless. DB TOCTOU guards are the primary cross-process serialization.
11. **Draft mode blocks `callNextMatch`** — if all pending matches are drafts, returns `hasDraftsBlocking: true`. Organizer must publish before "Call Next Match" works.
12. **`snakeDraft` / `rotatedDraft` return `null`** — when partnership cap blocks all splits. All callers must null-guard.
13. **`session_organizers` is append-only** — never DELETE or UPDATE. Presence = permission.
14. **`auth.users` trigger** — `handle_new_user()` auto-creates profile row. Never also insert manually (PK conflict).
15. **`sessions` trigger** — `handle_new_session()` auto-inserts `session_organizers` row for `created_by`. Never also insert manually.
16. **Ghost re-queue prevention** — match end/cancel checks `queue_entries.status` before re-queuing. `left` players are NOT re-queued even if in `match_players`.
17. **UUID validation before all DB calls** — `isValidUUID()` guard on every UUID param in every server action. Malformed IDs return early.
18. **`signOut()` before `signInAnonymously()`** — always. Skipping causes stale session conflict in identity migration.
19. **Skill level has 6 values** — `upper_beginner` was REMOVED. Never reference it.
20. **`is_auto_matchmaking_on` excluded from postgres_changes** — synced only via `auto_matchmaking_toggled` broadcast.
21. **On-deck match actions live in `match.ts`** — `clearOnDeckMatch`, `reorderOnDeckMatches`, `publishMatchAction`, `publishAllDraftMatchesAction` are in `match.ts`. Only engine logic is in `matchmaking.ts`.
22. **Service client for all mutations** — primary organizer (`sessions.created_by`) has no `session_organizers` row — write-side RLS silently returns 0 rows for them if RLS client used.
23. **`cancelMatchAction` auto-promotes** — cancelling a match auto-promotes oldest on-deck match and runs engine.
24. **Cookie chunking** — `@supabase/ssr` chunks auth tokens at 3180 encoded chars — handle `.0`, `.1` suffixes.
25. **DevTools in production** — `DevTools` component must be wrapped: `{process.env.NODE_ENV === "development" && <DevTools ... />}`.
26. **`publishMatchAction` BUG-001** — promotes players `waiting → on_deck` at publish time, not engine generation time. BUG-002 — checks for `left` players before writing; returns error if found (stale player guard).
27. **Vercel bypass** — `_vercel_share` tokens do NOT work for Playwright. Only `x-vercel-protection-bypass` header works.
28. **dnd-kit** — `data-no-dnd` + `onPointerDown stopPropagation` BOTH required on interactive children of draggable containers.
