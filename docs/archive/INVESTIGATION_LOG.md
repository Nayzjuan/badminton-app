# Codebase Investigation Log
# Principal QA / Security / Architecture Audit
# Date: 2026-06-01
# Constraint: Observational only — no code changes

---

## Step 1: Codebase Mapping

### Tech Stack
- Next.js 16.2.3 (App Router)
- React 19.2.4
- TypeScript 5.x
- Tailwind CSS 4.x
- Supabase (@supabase/supabase-js 2.103, @supabase/ssr 0.10)
- Zod 4.3.6
- DnD Kit (@dnd-kit)
- Vitest + Playwright

### Source File Counts
- 88 .tsx files (components, pages)
- 65 .ts files (hooks, utils, actions, types)
- 1 .css file (globals)

### Directory Structure
```
src/
  app/actions/     — 16 server action modules (auth, matchmaking, queue, etc.)
  app/             — App Router pages (organizer, player, tv, wrapped, etc.)
  components/      — 50+ React components (organizer, player, ui, wrapped, leaderboard)
  hooks/           — 20 custom React hooks
  lib/             — Utilities, constants, schemas, matchmaking engine, realtime, broadcast
  types/           — TypeScript types + generated Supabase Database type
  utils/supabase/  — Browser, server, service-role, middleware clients
```

---

## Step 2: Deep Scan Findings

---

### 🔴 CRITICAL — Security Defects

#### C-001: Profile actions lack organizer authorization (IDOR)
- **File:** `src/app/actions/profile.ts`
- **Lines:** 47-76, 87-103, 106-123, 126-146
- **Category:** Bug/Defect (Security)
- **Description:** `updatePlayerSkill`, `getPlayerPin`, `resetPlayerPin`, and `updatePlayerPin` only verify that the caller is *authenticated* (`verifyAuthenticated`) but NEVER check that the caller is an *organizer* or has any relationship to the target player. The service-role client is used for all writes, bypassing RLS entirely.
- **Impact:** Any authenticated player can change ANY other player's skill level, read their PIN, or reset their PIN. This is a direct Insecure Direct Object Reference (IDOR) vulnerability.
- **Fix direction:** Add `isSessionOrganizer` check before service-client writes, or scope updates to the caller's own profile only.

#### C-002: Service role key may be bundled into client JS
- **File:** `src/utils/supabase/service.ts`
- **Lines:** 27-29
- **Category:** Bug/Defect (Security)
- **Description:** `createServiceClient()` falls back to `process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. Any environment variable prefixed with `NEXT_PUBLIC_` is bundled into the client-side JavaScript bundle by Next.js.
- **Impact:** If a developer accidentally sets `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SERVICE_ROLE_KEY`, the service-role key (which bypasses ALL RLS) is leaked to every browser.
- **Fix direction:** Remove the fallback entirely; fail hard if only the NEXT_PUBLIC variant is present, and log a security warning.

#### C-003: Dev tools bypass weak in staging environments
- **File:** `src/app/actions/dev.ts`
- **Lines:** 125-137
- **Category:** Bug/Defect (Security)
- **Description:** The `requireAuth()` guard uses `process.env.NODE_ENV === "production"` as Layer 1. Staging environments built with `next start` report `NODE_ENV=production`, but an engineer may still have `DEV_TOOLS_ENABLED=true` in the staging `.env`. Layer 2 (auth check) is present but Layer 1 gives a false sense of security.
- **Impact:** A staging environment running `next start` with `DEV_TOOLS_ENABLED=true` exposes `seedTestData`, `seedNamedPlayers`, and `clearSessionData` to any authenticated user.
- **Fix direction:** Replace NODE_ENV check with an explicit `ALLOW_DEV_TOOLS` allowlist or require an additional signed token.

---

### 🟠 HIGH — Security / Reliability

#### H-001: match_players realtime subscription is globally unscoped
- **File:** `src/lib/realtime.ts`
- **Lines:** 149-170
- **Category:** Bug/Defect (Performance + Data Exposure)
- **Description:** `subscribeToMatchPlayers` subscribes to ALL changes on the `match_players` table with no `session_id` filter (the table lacks that column). Every connected client receives real-time events for match player changes across *all* sessions.
- **Impact:** Unnecessary network traffic scales linearly with active sessions. In a multi-tenant deployment, clients receive postgres_change events for sessions they are not part of. While the client re-fetches scoped data, the broadcast itself leaks the *existence* and *timing* of match changes in other sessions.
- **Fix direction:** Add a `match_id` allowlist filter if possible, or document this as an accepted trade-off with a plan to shard realtime channels.

#### H-002: No rate limiting on server actions
- **File:** `src/app/actions/*.ts` (all 16 action modules)
- **Category:** Bug/Defect (Security / Operational)
- **Description:** None of the server actions implement IP-based or user-based rate limiting. `joinQueueAction`, `toggleAutoMatchmaking`, `callNextMatch`, `createManualMatchAction`, and `sendPlayerNotification` are all callable without throttling.
- **Impact:** A single client can spam actions to cause denial-of-service (engine churn, broadcast storms, notification abuse). Supabase connection pools can be exhausted.
- **Fix direction:** Implement Next.js middleware rate limiting or add a per-action Redis-backed rate limiter.

#### H-003: `Math.random()` used for PIN generation
- **File:** `src/app/actions/profile.ts`
- **Line:** 114
- **Category:** Bug/Defect (Security)
- **Description:** `resetPlayerPin` uses `Math.floor(1000 + Math.random() * 9000)` to generate a 4-digit PIN. `Math.random()` is NOT cryptographically secure and is predictable.
- **Impact:** An attacker who can observe a few generated PINs may predict future PINs, enabling account takeover via the reconnect flow.
- **Fix direction:** Use `crypto.getRandomValues()` or Node.js `crypto.randomInt()` for PIN generation.

#### H-004: Broadcast REST helper lacks caller authorization
- **File:** `src/lib/broadcast.ts`
- **Lines:** 37-68
- **Category:** Bug/Defect (Security)
- **Description:** `postBroadcast()` is an exported helper that emits to any session channel using the service-role key. It does not verify that the caller is authorized to broadcast to the given `sessionId`. While current callers (server actions) do perform auth checks *before* calling broadcast, the helper itself is defenseless.
- **Impact:** If any future code path imports and calls `broadcastCapSaturation` or `broadcastSessionClosed` without prior auth, it becomes an unauthorized broadcast vector.
- **Fix direction:** Add a required `callerUserId` parameter and an `isSessionOrganizer` check inside `postBroadcast`.

#### H-005: No error boundaries anywhere in the app
- **File:** Entire `src/app/` tree
- **Category:** Bug/Defect (Reliability)
- **Description:** There are zero `error.tsx`, `loading.tsx`, or `not-found.tsx` files in the App Router. Any unhandled exception in any server component or client component will propagate unhandled and crash the page.
- **Impact:** Poor user experience; a single bad data fetch or runtime error can render an entire route unusable. No graceful degradation.
- **Fix direction:** Add root-level `error.tsx` and `not-found.tsx`, and route-level `loading.tsx` for data-heavy pages.

---

### 🟡 MEDIUM — Code Smells / Architecture / Performance

#### M-001: Components directly query the database (bypassing server actions)
- **Files:** `src/components/player/all-sessions-history.tsx`, `src/components/player/match-history.tsx`
- **Lines:** ~267, ~31 respectively
- **Category:** Improvement (Architecture)
- **Description:** These components create a `createBrowserSupabaseClient()` and issue `.from("v_match_history")` queries directly. This bypasses the server action layer used by every other data fetch in the app.
- **Impact:** Inconsistent caching strategy, no server-side rendering for history data, harder to mock in tests, and duplicated query logic. RLS is the only guard.
- **Fix direction:** Extract these queries into dedicated server actions (e.g., `getMatchHistory`, `getAllSessionsHistory`) and call them via `useEffect` + `useCallback`.

#### M-002: Magic status strings scattered across the codebase
- **Files:** ~20+ files across `src/app/actions/`, `src/hooks/`, `src/components/`, `src/lib/`
- **Category:** Improvement (Maintainability)
- **Description:** Raw string literals `"waiting"`, `"on_deck"`, `"playing"`, `"left"`, `"pending"`, `"in_progress"`, `"completed"`, `"cancelled"` are used inline in 76+ locations. The `MatchStatus` type exists but there's no canonical constant object.
- **Impact:** Refactoring a status name requires finding and updating 76+ locations. Typos are not caught at compile time (the type narrows, but a typo like `"wating"` is a valid `string` until it's narrowed).
- **Fix direction:** Export a `QUEUE_STATUS` and `MATCH_STATUS` constant map from `src/lib/constants.ts` and enforce lint rules against raw status strings.

#### M-003: console.log/console.error left in production paths
- **Files:** `src/lib/realtime.ts`, `src/lib/broadcast.ts`, `src/hooks/use-organizer-session.ts`, `src/app/actions/matchmaking.ts`, `src/app/actions/leaderboard.ts`, and many others
- **Category:** Improvement (Operational)
- **Description:** Over 138 console.log/error/warn statements exist across source files. Many are inside production code paths (realtime events, engine runs, score submissions, broadcast failures).
- **Impact:** Production browser consoles and server logs are spammed with debug noise. Some logs may leak internal state or player IDs.
- **Fix direction:** Replace with a structured logger that respects log levels, or wrap console calls behind a `process.env.DEBUG_*` gate.

#### M-004: Missing useMemo/useCallback in heavy components
- **Files:** `src/components/organizer/organizer-dashboard.tsx`, `src/components/organizer/queue-control.tsx`, `src/components/organizer/active-courts.tsx`, `src/components/player/player-dashboard.tsx`, and 15+ others
- **Category:** Improvement (Performance)
- **Description:** Many components derive values (filtered arrays, mapped objects, tab configs) inline in the render body without `useMemo`. Event handlers are declared as inline arrow functions instead of `useCallback`.
- **Impact:** Unnecessary re-renders of child components when parent state changes. In the organizer dashboard with 50+ players, this causes visible jank.
- **Fix direction:** Memoize derived data and stable callbacks in components that render lists or pass callbacks to memoized children.

#### M-005: Inconsistent server action return shapes
- **Files:** `src/app/actions/*.ts`
- **Category:** Improvement (Architecture)
- **Description:** Error return shapes vary: some return `{ error: string }`, others return `{ success: false, message: string }`, others return `{ success: false, error?: string }`. The `_shared.ts` defines `MatchActionResult` but many actions ignore it.
- **Impact:** Client-side error handling is brittle — callers must know which shape each action returns. Type guards are ad-hoc.
- **Fix direction:** Standardize on `MatchActionResult` or a unified `ActionResult<T>` discriminated union.

#### M-006: `useOrganizerData` has a subtle circular dependency via refs
- **File:** `src/hooks/use-organizer-data.ts`
- **Lines:** 148-160, 169, 232-237
- **Category:** Improvement (Architecture)
- **Description:** `onProfilesLoaded` closes over `setProfiles` before it is declared (line 216), relying on React dispatcher stability. `fetchQueueRef` is initialized to a no-op and wired later via `useEffect`. Comments acknowledge this is a workaround.
- **Impact:** While currently safe (React dispatchers are stable), this pattern is fragile. Future refactors may break the closure assumption.
- **Fix direction:** Restructure hook composition to avoid the forward-reference pattern, or use a small event bus / reducer pattern.

#### M-007: Missing cleanup for some setTimeout calls
- **Files:** `src/components/organizer/share-session-dialog.tsx` (lines 45, 55), `src/components/organizer/dev-tools.tsx` (line 39), `src/hooks/use-leaderboard.ts` (line 155)
- **Category:** Bug/Defect (Reliability)
- **Description:** These `setTimeout` calls do not store the timer ID or clear it on unmount. If the component unmounts before the timeout fires, React will warn about setting state on an unmounted component.
- **Impact:** Console warnings in development; potential memory leaks if components mount/unmount rapidly.
- **Fix direction:** Store timer IDs in refs and clear them in `useEffect` cleanup.

#### M-008: Polling intervals are not synchronized
- **Files:** `src/hooks/use-queue.ts` (15s), `src/hooks/use-tv-board.ts` (15s), `src/hooks/use-organizer-session.ts` (health check interval)
- **Category:** Improvement (Performance)
- **Description:** Multiple hooks on the same page create independent `setInterval` timers. On a player dashboard, three separate intervals may fire within milliseconds of each other, causing burst load.
- **Impact:** Network request bunching; harder to debug; unnecessary battery drain on mobile.
- **Fix direction:** Consider a shared `useInterval` hook with jitter, or align intervals to a global tick.

#### M-009: `createServiceClient()` throws in client components if accidentally imported
- **File:** `src/utils/supabase/service.ts`
- **Category:** Bug/Defect (Security / Reliability)
- **Description:** There is no runtime guard preventing `createServiceClient` from being imported into a `"use client"` component. If a developer accidentally imports it, the build may succeed but runtime will fail (env vars missing in browser) or worse, the NEXT_PUBLIC fallback may leak the key.
- **Impact:** Developer experience issue with security implications.
- **Fix direction:** Add a `typeof window` guard that throws a descriptive error if called in the browser.

#### M-010: Type assertions bypass safety in realtime subscriptions
- **File:** `src/lib/realtime.ts`
- **Lines:** 159-163, 264-266
- **Category:** Improvement (Type Safety)
- **Description:** `payload as RealtimePostgresChangesPayload<...>` is used for `match_players` and `profiles` subscriptions. The `as` assertion suppresses TypeScript's type checking.
- **Impact:** If the Supabase schema changes, these assertions will silently produce wrong types at runtime.
- **Fix direction:** Use runtime validation (e.g., Zod) or narrow the type through a type predicate instead of `as`.

---

### 🟢 LOW — Polish / Cleanup / Optimization

#### L-001: Deprecated constants still exported
- **File:** `src/lib/constants.ts`
- **Lines:** 75, 82
- **Category:** Improvement (Cleanup)
- **Description:** `ON_DECK_LOOKAHEAD` and `MAX_ON_DECK_MATCHES` are marked `@deprecated` but remain exported. No production imports remain.
- **Impact:** Minor bundle size bloat; confusion for new developers.
- **Fix direction:** Remove the constants and any remaining references.

#### L-002: Hardcoded toast durations inconsistent with constants
- **Files:** `src/components/organizer/organizer-dashboard.tsx`, `src/components/login-form.tsx`, and others
- **Category:** Improvement (Consistency)
- **Description:** Toast durations like `4000`, `8000` are hardcoded inline. `src/lib/constants.ts` exports `TOAST_DISMISS_MS` (5000) and `ERROR_AUTO_DISMISS_MS` (8000), but these are not used everywhere.
- **Impact:** Inconsistent UX; durations drift over time.
- **Fix direction:** Import and use the canonical constants.

#### L-003: `all-sessions-history.tsx` uses `toLocaleDateString` without locale memoization
- **File:** `src/components/player/all-sessions-history.tsx`
- **Lines:** 56-61
- **Category:** Improvement (Performance)
- **Description:** `sessionLabel` calls `new Date(...).toLocaleDateString("en-US", { ... })` inside the render path for every session group on every render.
- **Impact:** `toLocaleDateString` is surprisingly expensive. With 20+ sessions, this causes noticeable layout thrashing.
- **Fix direction:** Memoize formatted dates with `useMemo` or `Intl.DateTimeFormat`.

#### L-004: Missing `await` for fire-and-forget RPCs is inconsistent
- **Files:** `src/app/actions/auth.ts` (line 367), `src/app/actions/match-lifecycle.ts` (line 253)
- **Category:** Improvement (Consistency)
- **Description:** Some fire-and-forget RPCs use `void db.rpc(...).then(...)`, others use `db.rpc(...).then(...)` without `void`. The intent (fire-and-forget) is the same but the syntax varies.
- **Impact:** Minor lint noise; inconsistent pattern makes it harder to grep for all fire-and-forget calls.
- **Fix direction:** Standardize on `void` prefix for all intentionally unawaited promises.

#### L-005: `getH2HRecord` does not validate sessionId belongs to caller
- **File:** `src/app/actions/h2h.ts`
- **Lines:** 16-40
- **Category:** Improvement (Security)
- **Description:** The action checks auth but does not verify the caller is a participant in the session. It is read-only, but a player could query H2H records for arbitrary session IDs.
- **Impact:** Low — read-only data leak of match history for sessions the caller is not in.
- **Fix direction:** Add a session participation check before querying.

#### L-006: Court card alert interval recomputes every 30s even when match ended
- **File:** `src/components/organizer/court-card.tsx`
- **Line:** ~104
- **Category:** Improvement (Performance)
- **Description:** The `setInterval` for court alert tier recomputation runs continuously while the component is mounted, even if the court is `available` or `closed`.
- **Impact:** Unnecessary timer overhead.
- **Fix direction:** Conditionally start/stop the interval based on court status.

#### L-007: Weak PIN regex in `updatePlayerPin`
- **File:** `src/app/actions/profile.ts`
- **Line:** 127
- **Category:** Improvement (Security)
- **Description:** The regex `/^\d{4}$/` accepts PINs like `"0000"` which is a weak PIN.
- **Impact:** Low — 4-digit PINs are inherently weak, but sequential/repeated patterns increase guessability.
- **Fix direction:** Add a denylist for common weak PINs (0000, 1111, 1234, etc.).

---

## Step 3: Summary by Severity

| Severity | Count | Key Themes |
|----------|-------|------------|
| 🔴 Critical | 3 | IDOR in profile actions, service key leak risk, dev tools bypass |
| 🟠 High | 5 | Unscoped realtime, no rate limiting, weak PIN entropy, missing error boundaries, broadcast auth |
| 🟡 Medium | 10 | Direct DB queries, magic strings, console spam, missing memoization, inconsistent APIs, timer leaks, interval desync |
| 🟢 Low | 7 | Deprecated exports, hardcoded durations, locale perf, inconsistent void, H2H auth, court timer, weak PINs |

---

## Step 4: Recommended Prioritization

1. **Immediate (this sprint):** Fix C-001 (profile IDOR), C-002 (service key fallback), H-003 (crypto PIN), H-002 (rate limiting on critical actions).
2. **Next sprint:** Fix H-001 (unscoped realtime), H-005 (error boundaries), M-001 (direct DB queries in components), M-002 (magic strings).
3. **Backlog:** Address M-004 (performance memoization), M-003 (structured logging), M-006 (hook circular refs), L-001 (deprecated cleanup).

