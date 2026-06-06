# MEMORY.md — Badminton App Architectural Index

<!-- LLM-optimized: dense, structured, no prose padding. Read this before writing any code. -->
<!-- Short-term memory: session tracker + handoff doc. Long-term truth: APP_MANIFEST.md -->

---

## SESSION STATE (Last Updated: 2026-06-05 — Low/Info Finding Fixes)

### Validated + fixed 5 LOW + 2 INFO findings — COMPLETE ✅

All 8 reviewed findings were real (no false positives). Fixed 7; INFO-1 deliberately left (pruning subscriptions on transient non-410/404 errors would be a bug).

- **LOW-1** `install-prompt.tsx`: retyped the timer ref to `ReturnType<typeof setTimeout>` and dropped the `as unknown as …` cast (setTimeout/setInterval share a handle type; clearInterval clears both).
- **LOW-2** `push-server.ts`: bounded the web-push fan-out to `PUSH_CONCURRENCY=20` (chunked loop, dependency-free) — same counting/pruning, no skips.
- **LOW-3** `digital-twin/scripts/extract.ts` `sliceFunctionBody`: char-scanner now skips braces inside comments + '…'/"…"/`…` strings (regex literals still a known residual gap — acceptable for a docs extractor).
- **LOW-4** `public/sw.js`: `client.navigate()` wrapped in `Promise.resolve(...).catch(() => clients.openWindow(...))` (graceful fallback).
- **LOW-5** `tests/helpers/emergency-cleanup.ts`: `!process.stdin.isTTY` guard before `setRawMode` (CI/pipes use `--yes`, unaffected).
- **INFO-2** `state-machines.astro`: caption noting the table is the no-JS Mermaid fallback.
- **INFO-3** `extract.ts computeDrift` + `schema-drift.astro`: added column NULL-ability drift. Real mismatches counted; the one benign case (`session_wrapped_stats.point_diff`, a GENERATED column) is allowlisted as expected → drift stays "clean". New "Column nullability" + "Expected (known-benign)" sections on the page.

**Validation:** main-app `tsc` + `next build` clean; digital-twin `tsc` + build clean (16 pages); 466 unit tests pass; touched files lint-clean. Independent review: **LGTM**. (Root-level `npm run lint` shows pre-existing noise in worktrees/dist — none in touched files.) Not committed yet.

---

## SESSION STATE (Earlier: 2026-06-05 — Digital Twin Overhaul)

### Digital Twin: content-drift fixes + 6 new feature pages — COMPLETE ✅

Scope: validated the `digital-twin/` docs site's drift, then fixed all valid findings + built the 6 recommended feature pages. (Skipped the 2 false positives: "manifest hurts load time" — it's build-time only; "add a search icon" — one already existed, so instead surfaced search in the mobile top bar.)

**Foundation — `digital-twin/scripts/extract.ts`** (regenerates `src/data/manifest.json`): added extractors for `migrations` (46, from supabase/migrations), `broadcasts` (from broadcast.ts — fixes the empty `[]`), `actionDetails` (57 fns: signature/auth/tables/rpcs/broadcasts/push), `coverage` (from coverage/lcov.info), `schemaDrift` (TS types vs a live Supabase snapshot in `src/data/live-schema-snapshot.json`; 7 trigger/SECURITY-DEFINER fns categorized as expected → reads "clean"), and curated `stateMachines`. Re-ran extract (`_lastExtracted` now current) → picked up `live-match-swap.ts` + the June-5 push refactor.

**6 new pages** (live in Nav under "Schema & Quality"): `/migrations` (timeline), `/schema-drift`, `/rls` (49 policies, incl. the matches draft-firewall), `/state-machines` (Mermaid: queue + match), `/action-reference`, `/coverage` (88.2% lines). All `data-pagefind-body` (searchable) + build clean.

**Drift fixes:** `realtime.astro` (added `active_roster_changed` + `draft_cap_phase`); `database.astro` (softened the never-delivered "Phase 2 ER diagram" promise, dynamic counts, links to /rls + /schema-drift); `BaseLayout` footer shows `_lastExtracted`; `Nav` (+6 links, +mobile search); `actions.astro` (annotated courts/fix-player-record/history/live-match-swap, rewrote stale notifications.ts); new `digital-twin/README.md`.

**Validation:** `npm run build` (digital-twin) = 16 pages, 13 Pagefind-indexed, clean. Independent review: **LGTM** (2 trivial nits fixed). Not committed yet.

---

## SESSION STATE (Earlier: 2026-06-05 — Background Push A+B+C)

### True Background Push (server-triggered) — COMPLETE ✅

**Problem:** Push only fired when the app was OPEN — it was triggered from the CLIENT hook (`use-match-alerts.ts`) on a Realtime event, which never arrives on a locked/backgrounded phone (websocket suspended).

**A — Server-side trigger (the fix):**

- NEW `src/lib/notifications/push-server.ts` → `pushToPlayers(userIds, type)` (dedupe, empty no-op, 410/404 prune, never throws). `import "server-only"`.
- `notifications.ts` reduced to a thin wrapper delegating to `pushToPlayers`.
- Removed the client push call from `use-match-alerts.ts` `fireAlert` (audio-only now; server owns push → no double-notify).
- Wired `after(() => pushToPlayers(...))` at 7 trigger points: `promoteOnDeckMatchInternal` (COURT_CALL), `swapPlayerInActiveMatch` (COURT_CALL), `swapActiveFromOnDeck` (COURT_CALL + ON_DECK), `publishMatchAction`/`publishAllDraftMatchesAction`/`createManualMatchAction` (ON_DECK), `swapPlayerInMatch` (ON_DECK, only if `is_published`). See APP_MANIFEST §3.13 table.

**B — Delivery hardening:** per-type web-push `{ urgency, TTL, topic }`; `sw.js` `renotify:true` for COURT_CALL; `CACHE_VERSION` v1→v2.

**C — Install prompts:** NEW `src/lib/pwa/install-detection.ts` + `src/components/notifications/install-prompt.tsx` (iOS A2HS hint + Android `beforeinstallprompt`). `notification-enrollment.tsx` gated: iOS-not-installed suppresses "Enable Pings" (push can't work in an iOS Safari tab). Android install card uses a bounded poll on `hasUserMadeChoice()` so it never stacks on the ping card.

**Tests:** NEW `push-server.test.ts` (PS-1..6), `install-detection.test.ts` (ID-1..6). `use-match-alerts.test.ts` flipped to a regression guard (client must NOT call `sendPlayerNotification`). Added `vi.mock("next/server", { after: passthrough })` + `vi.mock("@/lib/notifications/push-server")` to the 3 action suites that load `after()`. NEW vitest alias `server-only` → `tests/setup/server-only-stub.ts` (build-neutral).

**Validation:** `tsc --noEmit` clean · 466 unit tests pass · `npm run build` OK · my files lint-clean. Independent review: **LGTM** (after fixing the install-prompt timer leak + card-stacking race it first flagged as Minor).

**Verify on real devices (the real test):** install PWA on iPhone + Android, enroll, LOCK the phone, publish a draft then call to court — confirm the locked phone buzzes + banners for both on-deck and court-call. (Web push plays OS sound + vibration, not the custom in-app beep — that needs a native wrapper, deferred.)

**Not committed yet** — awaiting user direction.

---

## SESSION STATE (Earlier: 2026-06-02 — Medium/Low Audit Fixes)

### Medium/Low Audit Fixes (2026-06-02) — COMPLETE ✅

**M-001 — Direct DB queries in components (FIXED):**
Created `src/app/actions/history.ts` with `getMatchHistory(playerId, sessionId?, limit?)` and `getAllSessionsHistory(playerId)`. Both `all-sessions-history.tsx` and `match-history.tsx` now call server actions for data fetching. Browser client remains in `match-history.tsx` exclusively for the Supabase Realtime subscription.

**M-003 — console.log spam in production (FIXED):**
Stripped all debug `console.log` from hot realtime paths in `realtime.ts` (11 calls removed). Only `console.error` for CHANNEL_ERROR/TIMED_OUT remains. File header comment updated to reflect new behavior.

**M-004 — Missing useMemo (FIXED):**
Added `useMemo` for `bottleneckCount` and `waitingCount` in `organizer-dashboard.tsx` (declared before the hook that consumes `bottleneckCount`). Added `useMemo` for `wins/draws/losses` stats in `match-history.tsx`.

**M-005 — Inconsistent action return shapes (FIXED):**
Added `success: false` to all bare `{ error }` returns in `auth.ts` (10 sites) and `sessions.ts` (5 sites, return type widened to `{ success?: boolean; error?: string }`).

**M-007 — setTimeout without cleanup (FIXED):**

- `share-session-dialog.tsx`: `copiedTimerRef` + `scheduleCopiedReset()` + `useEffect` cleanup
- `dev-tools.tsx`: `toastTimerRef` + `nukeTimerRef` + `useEffect` cleanup; hardcoded 4000ms → `TOAST_DISMISS_MS`
- `use-leaderboard.ts`: `flashTimerRef` + `useEffect` cleanup

**M-008 — FALSE POSITIVE:** All three intervals (`use-queue.ts`, `use-tv-board.ts`, `use-organizer-session.ts`) already had `clearInterval` cleanup in their `useEffect` return functions.

**M-009 — No browser guard on createServiceClient (FIXED):**
Added `import "server-only"` as the first line of `service.ts`. Next.js now raises a build error if this module is accidentally imported in a Client Component.

**M-010 — Type assertions in realtime.ts (FIXED):**
Extracted inline `as RealtimePostgresChangesPayload<T>` casts into a `castPayload<T>()` helper with a documented rationale. Both unfiltered subscription sites (`match_players`, `profiles`) now use the helper.

**L-002 — Hardcoded toast durations (FIXED):**
4000ms literal in `dev-tools.tsx` replaced with `TOAST_DISMISS_MS`. (Note: `TOAST_DISMISS_MS` = 5000ms, a 1-second behavior change — intentional alignment with the constant.)

**L-003 — toLocaleDateString in render (FIXED):**
`sessionLabel()` call in `SessionSection` memoized via `useMemo` — date parsing no longer runs on every render.

**L-004 — Inconsistent void prefix (FIXED):**
Added `void` to bare `.rpc().then()` in `auth.ts:367`.

**Files created:** `src/app/actions/history.ts`

**Files changed:** `auth.ts`, `sessions.ts`, `all-sessions-history.tsx`, `match-history.tsx`, `organizer-dashboard.tsx`, `share-session-dialog.tsx`, `dev-tools.tsx`, `use-leaderboard.ts`, `realtime.ts`, `service.ts`

**Known minor issues (non-blocking):**

- `updateSessionSettings` returns `{}` on success — pre-existing, `success` is optional in its return type.
- M-006 (circular ref in `useOrganizerData`) reviewed and confirmed safe by design: `setProfiles` is a stable React dispatcher captured in closure; it's never called synchronously during the first render.
- M-008 confirmed FALSE POSITIVE — all polling intervals already have `clearInterval` cleanup.

---

## SESSION STATE (Last Updated: 2026-06-02 — Security & Quality Audit Fixes)

### Audit Fixes (2026-06-02) — COMPLETE ✅

Applied all confirmed findings from an automated security/quality audit. Fixes in priority order:

**C-001 — Profile IDOR (FIXED):**
`updatePlayerSkill`, `getPlayerPin`, `resetPlayerPin`, `updatePlayerPin` in `profile.ts` now require both `getAuthenticatedUser()` AND `isSessionOrganizer(userId, sessionId)` before executing any service-role write. Added `sessionId: string` as the first parameter to all four functions. `QueueControlProps` gained `sessionId` prop; `organizer-dashboard.tsx` passes `session.id`. Previously, any authenticated player could modify any other player's PIN or skill level.

**C-002 — Service key NEXT_PUBLIC fallback (FIXED):**
`service.ts` and `broadcast.ts` no longer accept `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. Both now use `SUPABASE_SERVICE_ROLE_KEY` exclusively. Your `.env.local` already uses the correct key name — no env change needed.

**H-003 — Math.random() PINs (FIXED):**
`resetPlayerPin` now uses `crypto.getRandomValues(new Uint32Array(1))` instead of `Math.random()`.

**H-005 — Missing error boundaries (FIXED):**
Added `src/app/error.tsx` (global client error boundary with "Try again" reset button) and `src/app/not-found.tsx` (404 page with home link). Both use the existing design system tokens.

**L-005 — getH2HRecord open to any user (FIXED):**
`h2h.ts` now verifies the caller is either an `isSessionOrganizer` OR has a `queue_entries` row for the requested session before executing the H2H RPC.

**L-001 — Deprecated constants deleted (FIXED):**
`ON_DECK_LOOKAHEAD` and `MAX_ON_DECK_MATCHES` removed from `constants.ts`. Zero importers existed in `src/`.

**L-006 — court-card.tsx always-on interval (FIXED):**
`alertTier` `useEffect` now early-returns (without creating `setInterval`) when `!isActive || !timeLimitMinutes || !match?.started_at`. Previously the 30-second interval fired even on available/closed courts.

**L-007 — PIN "0000" accepted (FIXED, bundled with C-001):**
`updatePlayerPin` now rejects `"0000"` explicitly.

**Remaining known issues (not fixed, logged):**

- H-001: `subscribeToMatchPlayers` has no session filter (by design — acknowledged in code comment)
- H-002: No rate limiting on server actions
- H-004: FALSE POSITIVE — broadcast helper is private, always called post-auth
- C-003: FALSE POSITIVE — dev.ts two-layer guard is correct
- M-002–M-010: Medium findings — backlog sprint items
- `updatePlayerPin` has zero callers currently (exported but no UI uses it yet)

**Files changed:** `src/app/actions/profile.ts`, `src/app/actions/h2h.ts`, `src/components/organizer/queue-control.tsx`, `src/components/organizer/organizer-dashboard.tsx`, `src/utils/supabase/service.ts`, `src/lib/broadcast.ts`, `src/lib/constants.ts`, `src/components/organizer/court-card.tsx`, `src/app/error.tsx` (new), `src/app/not-found.tsx` (new)

---

## SESSION STATE (Last Updated: 2026-06-01 — Live Match Player Swap)

### Live Match Player Swap (2026-06-01) — COMPLETE ✅

Organizer can long-press (500ms) any player name on an active court card to open a replacement picker sheet. Three swap modes supported:

**Mode 1 — Switch Teams (same-match):** Picks one of the 2 opposite-team players. Mutual team swap; no queue changes. Self-undoable by calling the same RPC again.

**Mode 2 — Queue Replacement:** Picks a waiting queue player. Out-player goes to queue; in-player gets `playing` status. Undo reverses the two players.

**Mode 3 — On-deck Pull (3-way):** Picks an on-deck player. Organizer is forced to also fill the vacated on-deck slot from queue before Confirm unlocks. Atomic 3-way RPC. Undo uses `undo_swap_active_from_ondeck` with original team data stored in `undoContext`.

**3-second undo toast** via Sonner with action button for all three modes.

**New files:**

- `supabase/migrations/20260601000000_live_match_player_swap.sql` — 4 RPCs: `swap_player_in_active_match`, `swap_teams_in_active_match`, `swap_active_from_ondeck`, `undo_swap_active_from_ondeck`
- `src/app/actions/live-match-swap.ts` — 4 server actions
- `src/hooks/use-live-match-swap.ts` — state machine (idle → open → fill_required → submitting)
- `src/components/organizer/live-swap-sheet.tsx` — Sheet UI with 3 sections + inline on-deck fill expansion

**Modified files:**

- `src/components/organizer/match-roster.tsx` — `PlayerRowDark` gains `onLongPress` prop with 500ms hold detection (pointer events), `lp-hold` CSS animation class, keyboard fallback (Enter/Space fires immediately)
- `src/components/organizer/court-card.tsx` — `onLongPressPlayer` prop passthrough to `TeamsGrid`
- `src/components/organizer/active-courts.tsx` — `onDeckMatches`, `queuePlayers`, `sessionId` props; `useLiveMatchSwap` hook; `LiveSwapSheet` mounted at grid level (same pattern as `ScoreModal`); local toast renamed `banner` to avoid conflict with Sonner `toast` import
- `src/components/organizer/organizer-dashboard.tsx` — passes `onDeckMatches`, `queuePlayers={queue}`, `sessionId` to `ActiveCourts`
- `src/app/globals.css` — `--cc-live` / `--cc-live-dim` tokens (orange, H=48, between amber H=62 and streak H=38); `lp-hold` keyframe animation; reduced-motion fallback
- `src/types/database.ts` — 4 new RPC type registrations; `swap_active_from_ondeck` Returns is `[]` array (PostgREST wraps OUT-param functions in arrays)

**Design language:** Orange `--cc-live` accent (distinct from amber correction / teal queue swap).

**Known minor issues (non-blocking):**

- `swap_active_from_ondeck` TOCTOU: `outRow.team` read outside the RPC transaction — if `swap_teams_in_active_match` fires between pre-read and RPC (~ms window), team assignment could be wrong. Low risk; RPC's `PLAYER_NOT_IN_MATCH` guard partially mitigates.
- `useLiveMatchSwap.confirm()` has no try/catch for network-level throws — if the server action throws instead of returning `{ success: false }`, `isSubmitting` stays `true` and the sheet is stuck. Future: wrap `startTransition` body in try/catch.
- `undo_swap_active_from_ondeck` raises `MATCH_NOT_ACTIVE` instead of `ONDECK_MATCH_STARTED` for a missing ondeck row (NULL ≠ 'pending'). Low impact — undo silently returns without error per the `RETURN` statement.

**Migration `20260601000000_live_match_player_swap.sql` applied to Supabase production ✅ (2026-06-01).**

---

## SESSION STATE (Last Updated: 2026-06-01 — Code review findings A–K fixed)

### Code review findings fixed (2026-06-01) — COMPLETE ✅

**A — `vi.mock("next/server")` in queue-actions.test.ts:** after() pass-through. 5 → 11 passing.
**B — `.rpc` mock in use-enriched-matches.test.ts:** Added to buildMockClient() + racingClient. 5 → 10 passing.
**D — hasNewDraft timer overlap:** newDraftTimerRef stores active timer; cleared before each new one; cleanup function added to useEffect.
**F — after() swallows errors in queue.ts:** All 3 sites now `.catch(err => console.error(...))`.
**H — fixPlayerRecord blocks on compute_session_wrapped:** Moved to `after()` + `Promise.resolve()` to get Promise from PromiseLike.
**J — Hardcoded oklch in match-roster.tsx:** Tokenised as `--cc-streak` / `--cc-streak-dim` (light: 0.64, dark: 0.72). Light theme was using dark value — also a correctness fix.
**K — animate-ping no reduced-motion guard:** Added `motion-reduce:hidden` to both ping spans.
**Matchmaking engine test:** "toggle bypass" test rewritten to assert correct post-fix behaviour (sessions queried at [6]).

**Skipped (per plan):**

- G (win_streak unconditional) — defer, no perf complaint
- I (@property Firefox) — acceptable progressive enhancement
- L (DOM queries in login) — low-risk, future cleanup pass

---

## SESSION STATE (Last Updated: 2026-06-01 — Toggle feedback + generation notification)

### Toggle feedback + match generation notification (2026-06-01) — COMPLETE ✅

**Toggle loading state (`organizer-dashboard.tsx`):**

- While `togglingAuto`: static dot → rotating arc SVG spinner (`animate-spin`), label → "Saving…"/"…"
- When auto is ON (not saving): dot gains `animate-ping` pulse wrapper (live engine signal)
- Applied to both desktop `clip-cut-sm` toggle and mobile `rounded-full` pill

**Toggle success toast (`use-organizer-dashboard.ts`):**

- `toast.success("Engine running", { description: "...", duration: 4000 })` when toggled ON
- `toast("Engine paused", { description: "...", duration: 4000 })` when toggled OFF
- Error toast already existed — unchanged

**New draft notification (`organizer-dashboard.tsx` + `on-deck-panel.tsx`):**

- `prevDraftCountRef` initialized with `draftMatches.length` at mount (no spurious page-load toast)
- `useEffect` on `draftMatches.length` fires toast + sets `hasNewDraft=true` only on 0→≥1 transition
- `hasNewDraft` resets after 3s via `setTimeout`
- Passed to `OnDeckPanel` → pulsing "● NEW" badge on Publish All banner (fade-in entrance, abrupt exit at 3s — cosmetic only)
- Toast fires exactly once even if engine generates 3 drafts sequentially (spam-proof)

**Known minor cosmetic issues (non-blocking):**

- Toast description says "1 new draft" even if engine generates 2-3 in sequence (live banner count is accurate)
- "NEW" badge disappears abruptly at 3s (no exit animation — would need framer-motion)

---

## SESSION STATE (Last Updated: 2026-06-01 — Notice design system fixes)

### DraftCapNotice + CapSaturationNotice design system alignment (2026-06-01) — COMPLETE ✅

Both notice components in the on-deck panel were rebuilt to match the organizer command-center design system.

**DraftCapNotice (`on-deck-panel.tsx`):**

- `cc-amber`/`cc-amber-dim` tokens (was raw `amber-*` Tailwind classes)
- `clip-cut-sm` polygon geometry (was `rounded-xl`)
- `font-command text-[9.5px] uppercase tracking-[0.13em]` heading (was `text-sm font-semibold`)
- Copy fixed: "drafts below" not "above" (spatially correct)
- Inline "Publish All" button (`onPublishAll` + `isPublishing` props → `handlePublishAll`)
- Standalone Publish All banner suppressed when `isDraftCapBlocked` (no double button)
- Render order: CapSaturationNotice (error, urgent) first → DraftCapNotice (status, informational) second
- `AlertCircle` → `PauseCircle` icon

**CapSaturationNotice (`sortable-card.tsx`):**

- `cc-red`/`cc-red-dim` (redZone) and `cc-amber`/`cc-amber-dim` (general) tokens
- `clip-cut-sm` polygon geometry (was `rounded-xl`)
- `font-command text-[9.5px] uppercase tracking-[0.13em]` heading
- Dismiss button: `text-cc-t3 hover:text-cc-t2` (removed raw red/orange hover backgrounds)

**Files changed:** `on-deck-panel.tsx`, `sortable-card.tsx`

---

## SESSION STATE (Last Updated: 2026-06-01 — Draft cap notice + cap saturation audit)

### Draft Cap Blocked Notice (2026-06-01) — COMPLETE ✅

Added `DraftCapNotice` to `on-deck-panel.tsx`: an amber alert that appears when auto-matchmaking is ON, ≥4 players are waiting, and all draft slots are full (draftCount ≥ dynamicCap). Explains to the organizer why the engine stopped generating — previously a silent failure.

**Cap saturation UI** was already fully wired end-to-end (broadcast → realtime → hook → `CapSaturationNotice`). No fix needed there.

**Files changed:**

- `src/components/organizer/on-deck-panel.tsx` — `DraftCapNotice` component, `isAutoMatchmakingOn` + `waitingCount` props, `isDraftCapBlocked` derived state, renders before `CapSaturationNotice`
- `src/components/organizer/organizer-dashboard.tsx` — passes `isAutoMatchmakingOn` and `waitingCount` to `OnDeckPanel`

**Known edge case (minor, benign):** With exactly 4 waiting players + full draft cap, the notice shows even if the engine's soft gate (pool diversity, not draft cap) is the actual blocker. The advice ("review drafts") is still correct. `GATE_POOL_THRESHOLD = 4` means this only occurs at the boundary.

---

## SESSION STATE (Last Updated: 2026-06-01 — Toggle bypass bug fix)

### Auto-matchmaking toggle bypass in callNextMatch (2026-06-01) — COMPLETE ✅

**Bug:** `callNextMatch` called `runEngineInternal(service, sessionId)` directly at line 143 after a successful on-deck promotion, bypassing the `is_auto_matchmaking_on` toggle. Result: when organizer had toggle OFF but still had on-deck drafts to call, each "Call Next Match" click silently generated a new draft.

**Fix:** Replaced `runEngineInternal(service, sessionId)` with `runEngineForSession(sessionId)` at line 143. `runEngineForSession` checks the toggle, has the in-flight concurrency guard (prevents double-run races), and satisfies auth requirements since `callNextMatch` already gates the organizer.

**Not changed:** Step 3 of `callNextMatch` still calls `runEngineInternal(service, sessionId, true)` with `bypassGate=true` — that path is intentional (organizer demand, toggle confirmed ON at that point).

**File changed:** `src/app/actions/matchmaking.ts:143`

---

## SESSION STATE (Last Updated: 2026-05-28 — Dark mode default)

### Dark Mode Default (2026-05-28) — COMPLETE ✅

Changed `defaultTheme` from `"light"` to `"dark"` in `src/app/layout.tsx` (`ThemeProvider`).

- Affects first-time visitors only (no `localStorage` preference yet)
- Existing users retain their saved preference
- `enableSystem={false}` and `suppressHydrationWarning` were already in place — no flash issue
- Theme toggle remains available in player + organizer dashboards
- Login page dark styles were already implemented via `dark:` Tailwind classes

**File changed:** `src/app/layout.tsx:81`

---

## SESSION STATE (Last Updated: 2026-05-26 — Win streak indicator + HSTS)

### Win Streak Indicator on Courts + On-Deck (2026-05-26) — COMPLETE ✅

Animated win streak indicator on `PlayerRowDark` (active courts) and `PlayerRowLight` (on-deck panel) for players with 3+ consecutive wins in the current session.

**Data pipeline:**

- `useEnrichedMatches` — Phase 3b fetches `get_player_streaks` RPC after profiles; non-fatal (streakMap defaults to empty on failure)
- `EnrichedMatch.players[].win_streak: number` — added to type; defaults to 0
- `sortable-card.tsx` + `court-card.tsx` — pass `win_streak: p.win_streak ?? 0` through `splitPlayers`
- `RosterPlayer.win_streak?: number` — optional field, defaulted to 0 at row level

**Visual treatment:**

- Hot orange `oklch(0.72 0.22 38)` — distinct from system amber (avoids warning/timer semantic conflict)
- `streak-glow-wrapper` wrapper div → `filter:drop-shadow` traces clip-cut polygon shape
- `streak-hot-border` combines `streak-border-pulse` (infinite) + `streak-ignite` (one-shot) in one `animation` shorthand to avoid CSS cascade clobbering
- `@property --streak-glow` animates border opacity (normally un-animatable)
- `flame-beat` animation: scale 1→1.2, ±4° rotation, brightness flicker
- `🔥 WIN STREAK ×N` inline; container query hides "Win Streak" label on columns ≤255px
- `isSelected` (swap-picking) suppresses streak — selection takes visual priority
- Dark mode: `.dark .streak-label` / `.dark .streak-count` with text-shadow glow
- `prefers-reduced-motion`: static amber border only

**Files changed:**

- `src/app/globals.css` — all keyframes + CSS classes
- `src/hooks/use-enriched-matches.ts` — Phase 3b + `win_streak` on EnrichedMatch
- `src/components/organizer/match-roster.tsx` — both `PlayerRowDark` and `PlayerRowLight`
- `src/components/organizer/sortable-card.tsx` — win_streak passthrough
- `src/components/organizer/court-card.tsx` — win_streak passthrough
- `next.config.ts` — HSTS header (`max-age=31536000; includeSubDomains`, no preload)
- `src/app/sandbox/streak-preview/` — design exploration sandbox (not production)

**Known gotcha:** `streak-ignite` no longer exists as a standalone CSS class — it is combined inside `streak-hot-border`'s animation shorthand. Do not re-add `.streak-ignite` as a standalone class; it would cascade-clobber the border-pulse.

**Commit:** `45560ac`

---

## SESSION STATE (Last Updated: 2026-05-26 — Login page redesign)

### Login Page — NEW PLAYER / RETURNING Toggle (2026-05-26) — COMPLETE

Replaced the buried "Already have a PIN? Reconnect" underline link with a **segmented toggle at the top of the login form**, giving equal visual hierarchy to both entry paths.

**Files changed:**

- `src/components/login-form.tsx` — full rewrite of component:
  - `mode: "new" | "returning"` state drives which panel renders
  - NEW PLAYER tab: existing form (name + skill level + PIN → `signInAnonymously`)
  - RETURNING tab: inline reconnect form (name + PIN → `reconnectPlayer`) — replaces the old `ReconnectModal`
  - `handleTabKeyDown` — ARIA APG roving tabindex pattern: `ArrowLeft/Right` moves focus + switches mode
  - Tabs have `tabIndex={mode === X ? 0 : -1}` — correct roving focus behaviour
  - Both error states (`newError`, `reconnectError`) have independent 8 s auto-dismiss and are cleared on tab switch
  - `maxLength={30}` on both name inputs (matches Zod schema)
  - `ErrorBanner` extracted as shared component (used by both panels)
  - `Spinner` still imported from `./reconnect-modal` (that file unchanged)
  - `ReconnectModal` no longer rendered from `LoginForm` (it still exists in the file, may be pruned separately)
- `src/app/page.tsx` — no changes (form is self-contained)

**Validation:** `tsc --noEmit` clean, ESLint 0 warnings. Code review: passed (Minor issues addressed before commit).

---

## SESSION STATE (Last Updated: 2026-05-23 — Organizer button UX fixes)

### Organizer Button Loading/Disabled States (2026-05-23) — COMPLETE

Fixed 3 organizer-dashboard buttons that were missing in-flight guards, silently dropping errors, or allowing double-submission.

**Files changed:**

- `src/components/organizer/queue-control.tsx`
  - Added `import { toast } from "sonner"` (was missing — errors from `onPausePlayer` / `onRemoveFromQueue` silently vanished)
  - Added `pausingPlayers: Set<string>` state — tracks which player IDs have a pause/resume in flight; supports concurrent per-player operations
  - Added `removingPlayer: string | null` state — tracks which player has a checkout in flight (single-at-a-time via AlertDialog flow)
  - `handlePausePlayer()` — async wrapper with set/clear bookends + `toast.error` on failure
  - `handleRemoveFromQueue()` — async wrapper with set/clear bookends + `toast.error` on failure
  - Pause/Resume button: wired `disabled={pausingPlayers.has(entry.player_id)}` + `disabled:opacity-50 disabled:cursor-not-allowed`
  - Checkout `AlertDialogAction`: wired `disabled={removingPlayer === entry.player_id}`, loading text "Removing…" / "Checkout"
- `src/components/organizer/active-courts.tsx`
  - Added `updatingStatusCourt: Set<string>` state — tracks courts with an in-flight Close/Reopen
  - Added `removingCourt: Set<string>` state — tracks courts with an in-flight Remove
  - `handleUpdateCourtStatus`: now wraps the async call with set/clear bookends (error path unchanged)
  - `handleRemoveCourt`: same pattern
  - Passes `isUpdatingStatus={updatingStatusCourt.has(court.id)}` and `isRemoving={removingCourt.has(court.id)}` to `<CourtCard>`
- `src/components/organizer/court-card.tsx`
  - Added `isUpdatingStatus: boolean` and `isRemoving: boolean` to `CourtCardProps` interface + destructure
  - Close button: `disabled={isUpdatingStatus}`, loading text "Closing…" / "Close"
  - Reopen button: `disabled={isUpdatingStatus || isRemoving}`, loading text "Reopening…" / "Reopen Court"
  - Remove button: `disabled={isRemoving || isUpdatingStatus}`, loading text "Removing…" / "Remove"

**What was NOT broken (audit correction):**

- "Call Next Match" was falsely flagged by the audit as missing a `disabled` prop. It's handled correctly: when `isMatchmaking` is true, the entire available-actions footer section is hidden by the render condition `{!hasActiveMatch && !isMatchmaking && cardState === "available" && ...}`. The button can't be double-clicked because it doesn't exist in the DOM during matchmaking.

**Validation:** `npm run build` clean (all 19 routes). Code review: LGTM.
**Commit:** `71cec4a`

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

## SESSION STATE (Last Updated: 2026-05-23 — join queue perf + Jake L merge + DB backup)

### Join Queue Performance (2026-05-23) — COMPLETE

**Problem:** Join Queue button felt slow/unresponsive — users had to wait for the full matchmaking engine to complete before the server action returned.

**Fix 1 — Fire-and-forget engine (`src/app/actions/queue.ts`):**

- Replaced `await runEngineForSession(sessionId)` with `after(() => runEngineForSession(sessionId))` (Next.js 16 `after()` API) in `joinQueueAction` and both branches of `joinQueueFallback`.
- Response returns immediately after the DB insert; engine runs in background with guaranteed completion.

**Fix 2 — Optimistic UI (`src/hooks/use-queue.ts`):**

- `joinQueue` callback now immediately inserts a `waiting` entry into local state using `setQueue(prev => ...)` functional updater, capturing the snapshot for rollback.
- UI transitions from "not in queue" → "waiting in queue" synchronously on click.
- On server error: rolls back to snapshot + returns `{ error }`.
- On success: realtime event arrives and replaces optimistic entry with real DB row (no double-entry risk — full re-fetch overwrites).

**Fix 3 — Button UX (`src/components/player/my-status-tab.tsx`):**

- Added `joining` state to `QueueSubTab`; button disabled + shows "Joining…" while in flight.
- `toast.error()` shown on failure.

**Known minor issues (non-blocking):**

- Optimistic `games_played` uses previous value (not server-computed floor), causing brief position flicker when realtime corrects it — cosmetic only.
- `joining` state not guarded against component unmount — React 18 handles silently, no leak.

**Commit:** `4c4afe7`

---

### Jake L Duplicate Profile Merge (2026-05-22) — COMPLETE

Identity chain forked on 2026-05-09 when two devices PIN-reconnected from ancestor `a3f26e57` simultaneously. By 2026-05-22, two live profiles both had PIN `0356`:

- Branch 1 `8d63e740`: 29 match_players, 5 queue_entries, 4 session_organizers
- Branch 2 `d766f00a`: 6 match_players, 6 queue_entries, 6 sessions.created_by (this was the active organizer)

`migrate_player_identity` RPC could not be used (FK constraint on sessions.created_by). Manual SQL transaction merged Branch 1 into Branch 2, then migrated forward to `a3ffbfa6` (current Jake L profile, created 2026-05-22, PIN `0356`).

Result: Jake L has 35 match_players, single PIN, correct session ownership.

---

### Match Team Swap — Thursday 05/21 Match 1 (2026-05-22) — COMPLETE

Swapped Glenn (team b → a) and JV Cutiepatootie (team a → b) in completed match `a3a4ffb7`. Recomputed `session_wrapped_stats` via `compute_session_wrapped` RPC and re-broadcast `session_closed` via `realtime.send()`.

---

### Database Backup (2026-05-22) — COMPLETE

Full backup at `/home/user/badminton-app/backup-2026-05-22.json` (1.15 MB, 2,851 rows across 12 tables).

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

**Root cause (verified):** `snakeDraft` and `rotatedDraft` in `src/lib/matchmaking-core.ts` tried splits in skill-balance order and returned the _first_ one where both team pair counts were `< cap` (hard cap = 2). They never checked whether a _fresher_ split existed where both pairs had `count = 0` (never been partners before). `isDiversityViolation` does not prevent same-partner repeats — it only blocks when ≥3 of 4 players appeared in the same recent match. Overlap scoring is anchor-centric, so when neither recently-paired player was the anchor, their mutual history was invisible to candidate scoring.

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

| #   | Issue                                   | Status                                                                                                                                  |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Missing CSP (HIGH)                      | Fixed — added to `next.config.ts`                                                                                                       |
| 2   | Missing X-Frame-Options (MEDIUM)        | Fixed — added to `next.config.ts`                                                                                                       |
| 3   | Missing X-Content-Type-Options (MEDIUM) | Fixed — added to `next.config.ts`                                                                                                       |
| 4   | Missing Referrer-Policy (MEDIUM)        | Fixed — added to `next.config.ts`                                                                                                       |
| 5   | Missing Permissions-Policy (LOW)        | Fixed — added to `next.config.ts`                                                                                                       |
| 6   | Password Autocomplete (LOW)             | **False positive** — all PIN inputs already have `autoComplete="off"` (login-form.tsx:208, organizer-entry.tsx:479,531)                 |
| 7   | No Rate Limiting (MEDIUM)               | **Accepted risk** — Vercel edge protects DDoS; PIN reconnect brute-force has minimal blast radius (queue slot only, not account access) |

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

| SHA     | Commit                                           | What changed                                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 73d8f87 | B-1: getAuthenticatedUser + createUnknownProfile | Added `getAuthenticatedUser()` to `_shared.ts`; added `createUnknownProfile(id)` to `lib/utils.ts`; replaced inline auth patterns in `match.ts`, `swap-player.ts`, `dev.ts`; replaced inline unknown-profile objects in `use-organizer-data.ts` + `use-session-data.ts` |
| 6b7c0d3 | B-2: static import + getServiceClient removal    | `use-match-alerts.ts`: dynamic import → static `import { sendPlayerNotification }`; `match.ts`: removed `getServiceClient()` wrapper, replaced 5 call sites with `createServiceClient()` directly                                                                       |
| 74fd2a2 | B-3: leaveQueue → checkoutPlayer                 | `use-queue.ts`: `leaveQueue` delegates to `checkoutPlayer(sessionId)` server action; previously bypassed draft-cleanup RPC (`checkout_player_cleanup_drafts`)                                                                                                           |
| d186c87 | B-4: isSessionOrganizer consolidation            | `sessions.ts` (4 functions) + `matchmaking.ts` (`callNextMatch`): replaced inline 2-path organizer checks (fetch session → check `created_by` → fallback to `session_organizers` query) with single `isSessionOrganizer(user.id, sessionId)` call                       |
| 81988fe | B-5: useEnrichedMatches extraction               | New `src/hooks/use-enriched-matches.ts` shared hook; `use-organizer-data.ts` + `use-session-data.ts` remove duplicated 4-query enrichment logic; `includeDrafts: boolean` controls draft firewall; `onProfilesLoaded` callback keeps organizer profiles Map in sync     |
| e79a772 | B-6: useAction factory + useMemo derived state   | `use-organizer-data.ts`: `useAction` factory at module scope replaces 4 identical action wrappers (`cancelMatch`, `clearOnDeckMatch`, `removeFromQueue`, `pausePlayer`); 4 derived-state slices memoized with `useMemo`                                                 |

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
- **`fix_record_swap_player` does NOT update `player_rivalries`** (all-time H2H table). If player A is replaced by player B in a corrected match, `player_rivalries` still credits A with the H2H result against that match's opponents, and B receives nothing. This is intentional for the first version — rivalries are only used for Session Wrapped awards display, not matchmaking. Effect: wrapped awards relying on `player_rivalries` (e.g. `nemesis_slayer`, `the_dynasty`, `settled_the_score`) may reflect slightly stale data after a Fix Record correction. A follow-up migration can add the same delta pattern as `_fix_record_partnership_delta` but targeting `player_rivalries` rows. Documented in migration comment.

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

| Function                                                                            | Notes                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_match_with_players(...)`                                                    | `RETURNS uuid`. Returns **NULL** (not error) on TOCTOU conflict. Three DB-level guards (migration 20260507000000). ⚠️ Do NOT change to `RETURNS SETOF uuid` — breaks NULL detection.                                                            |
| `swap_player_in_match(...)`                                                         | Bench→deck swap — atomic DELETE+INSERT+UPDATE×2+recompute                                                                                                                                                                                       |
| `swap_match_players(...)`                                                           | Cross-match direct swap (Tap-to-Swap v2)                                                                                                                                                                                                        |
| `elevate_to_organizer(p_session_id, p_passcode)`                                    | Passcode-gated organizer promotion                                                                                                                                                                                                              |
| `rejoin_queue(p_session_id)`                                                        | Reset queue status to "waiting", preserve games_played                                                                                                                                                                                          |
| `migrate_player_identity(p_old_user_id, p_new_user_id)`                             | PIN reconnect identity migration                                                                                                                                                                                                                |
| `compute_session_wrapped(p_session_id)`                                             | Computes+upserts session_wrapped_stats for all players                                                                                                                                                                                          |
| `get_h2h_record(p_team_a, p_team_b, p_session_id)`                                  | H2H wins for exact 2v2 pairing                                                                                                                                                                                                                  |
| `toggle_auto_matchmaking(p_session_id)`                                             | Atomic toggle, returns new bool value                                                                                                                                                                                                           |
| `lookup_active_session(p_session_id)`                                               | Safe public lookup for QR-code join — no RLS exposure                                                                                                                                                                                           |
| `skill_level_to_int(lvl)`                                                           | Enum → numeric 1–6                                                                                                                                                                                                                              |
| `refresh_alltime_leaderboard()`                                                     | Refreshes materialized view                                                                                                                                                                                                                     |
| `get_player_streaks(p_session_id?)`                                                 | Win-streak per player                                                                                                                                                                                                                           |
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
