# MEMORY.md — Badminton App Architectural Index
<!-- LLM-optimized: dense, structured, no prose padding. Read this before writing any code. -->

---

## TECH STACK

| Layer | Tool | Notes |
|-------|------|-------|
| Framework | Next.js 16 App Router | Breaking changes vs training data — read `node_modules/next/dist/docs/` before using Next APIs |
| Database | Supabase (Postgres + Realtime) | Anonymous auth; service-role client bypasses RLS |
| Auth | `@supabase/ssr` | Cookie: `sb-{projectRef}-auth-token`, plain JSON, chunked at 3180 chars as `.0`, `.1` |
| UI | Tailwind v4 + Shadcn UI | Radix primitives: Dialog, Sheet, AlertDialog, etc. |
| Drag & Drop | dnd-kit | Strict isolation rules — see DND section |
| Toasts | Sonner | |
| Unit Tests | Vitest ^4.1.4 | Pure logic only (`tests/unit/`) |
| E2E Tests | Playwright ^1.59.1 | Zero-local — runs against live Vercel deployment |
| Package Manager | npm | |
| Deployment | Vercel | Protection bypass via `x-vercel-protection-bypass` header |

---

## DATABASE SCHEMA

### Core Tables

```
profiles           id(uuid PK=auth.users), display_name, skill_level(text), pin, created_at
sessions           id, name, is_active, is_auto_matchmaking_on, ended_at, created_at
courts             id, session_id(FK), name, status(CourtStatus), created_at
queue_entries      id, session_id(FK), player_id(FK→profiles), joined_at, games_played,
                   status(QueueStatus), position(int|null), is_paused, created_at
matches            id, session_id(FK), court_id(FK→courts|null), status(MatchStatus),
                   is_mixed_level(bool), sort_order(int), score_a(int|null), score_b(int|null),
                   started_at, ended_at, created_at
match_players      id, match_id(FK), player_id(FK→profiles), team("a"|"b")
```

### Enums

```
QueueStatus:  "waiting" | "on_deck" | "playing" | "left"
MatchStatus:  "pending" | "in_progress" | "completed" | "cancelled"
CourtStatus:  "available" | "in_use" | "closed"
SkillLevel:   "beginner"|"beginner_intermediate"|"intermediate"|"intermediate_advanced"|
              "advanced"|"advanced_open"|"open"  (mapped to int 1-7)
```

### Views

```
v_queue_with_wait_time      — queue_entries + profiles join; computes wait_minutes, is_bottleneck
v_match_history             — matches + match_players + profiles; includes scores, teams
v_recent_pairings           — recent co-players per player (used by buildOverlapMap)
v_session_leaderboard       — per-session stats: GP, W, L, Win%, PF, PA, +/-
v_alltime_leaderboard_mat   — materialized all-time stats (same columns)
```

### TypeScript Type Convention
All DB row types use `type` aliases (NOT `interface`) — required to satisfy Supabase generic constraints.

---

## DATABASE RULES & GOTCHAS

### Critical Schema Considerations

| Table | Behaviour | Rule |
|-------|-----------|------|
| `profiles` | `id` = `auth.users.uuid` (no auto-increment) | Always use `auth.uid()` as the PK; never insert a synthetic ID |
| `session_organizers` | Append-only — rows are never updated or deleted | Treat as an immutable audit log; do NOT add DELETE/UPDATE operations; presence of a row = permission granted |
| `matches` | `court_id` is nullable (`null` = on-deck / pending, non-null = assigned to a court) | Always null-check `court_id` before referencing the court; don't assume a match has a court |
| `push_subscriptions` | Requires three Web Push fields: `endpoint`, `p256dh`, `auth_key` | All three must be present and non-empty or the push will fail silently; validate at the point of subscription creation, not at send time |

### push_subscriptions — Key Shape
```ts
// Required fields when inserting a new subscription row:
{
  user_id:   string,   // auth.uid()
  endpoint:  string,   // PushSubscription.endpoint
  p256dh:    string,   // btoa(PushSubscription.getKey('p256dh'))
  auth_key:  string,   // btoa(PushSubscription.getKey('auth'))
}
```
`p256dh` and `auth_key` are the ECDH public key and HMAC authentication key from the browser's `PushSubscription` object. They are required by the Web Push Protocol for payload encryption. Missing either key causes the push API to reject the request — the failure is often silent on the client side.

### Supabase Type System
- `Relationships: []` is **required** on every table entry in `database.ts` — even tables with no foreign keys (e.g. `push_subscriptions`). The `@supabase/supabase-js v2.49+` generic system enforces this structurally.
- `tsc --noEmit` is the authoritative check — IDE red squiggles can be stale cache. Run `TypeScript: Restart TS Server` in VS Code if they don't match `tsc` output.
- Never use `interface` for DB row types — use `type` aliases only (Supabase generic constraint).

### PostgREST Behavioural Rules
- `UPDATE` that matches 0 rows returns an **empty array**, not `null` or an error. Using `.single()` on such an UPDATE throws "Cannot coerce the result to a single JSON object". Use array + length check for atomic CAS guards.
- `INSERT` with `.select().single()` is safe — inserts always return exactly one row or an error.
- RLS policies are enforced on the `anon` and `authenticated` roles. The service-role client bypasses all RLS — use it only in server actions, never in client components.

---

## CORE ARCHITECTURAL PATTERNS

### 1. State Management — `useOrganizerData`
**File:** `src/hooks/use-organizer-data.ts`

Key patterns:
- **Ref-based callbacks** (`fetchCourtsRef`, `fetchQueueRef`, `fetchActiveMatchesRef`): prevents Realtime subscription teardown cascade. Subscriptions capture the ref, not the function — updating ref doesn't re-trigger `useEffect`.
- **`courtsRef`**: Courts stored in both state and ref. `fetchActiveMatches` reads `courtsRef.current` instead of `courts` state, breaking the dep chain that would rebuild all 5 Realtime channels on every court update.
- **Monotonic sequence counter** (`fetchActiveMatchesSeq`): Each fetch increments a counter; only the highest-seq result is applied. Discards stale concurrent fetches from race conditions.
- **5 Realtime channels**: `queue_entries`, `matches`, `match_players`, `courts`, `sessions`.
- Explicit refresh called before returning from every mutation.

### 2. Drag-and-Drop — dnd-kit Isolation
**Files:** `src/components/organizer/queue-control.tsx` and related

Rules:
- `data-no-dnd` attribute on any interactive element inside a draggable card.
- `onPointerDown: (e) => e.stopPropagation()` on buttons/inputs inside draggable cards.
- These two together prevent dnd-kit from intercepting pointer events on interactive children.
- Never nest a Radix Sheet/Dialog trigger inside a draggable without both guards.

### 3. Server Actions Pattern
**Convention:** All mutations are Server Actions (`"use server"`) in `src/app/actions/`.

**Swap Player** (`src/app/actions/swap-player.ts`):
- 4-guard safety model before any writes:
  1. Match must exist and be `pending`
  2. outPlayer must be `on_deck` in the match
  3. inPlayer must be `waiting` in the queue
  4. Skill compatibility check (unless fallback override)
- Sequential writes with compensation:
  - Step a: DELETE outPlayerId from match_players
  - Step b: INSERT inPlayerId (compensates: re-insert outPlayer on fail)
  - Step c: UPDATE inPlayer → `on_deck` (compensates: undo step a+b on fail)
  - Step d: UPDATE outPlayer → `waiting` (non-fatal)
  - Step e: READ-AFTER-WRITE recompute `is_mixed_level`
- Uses `createServiceClient()` for all writes (bypasses RLS for cross-user mutations)

### 4. Supabase Client Variants

```ts
// Browser (respects RLS, reads cookies)
createBrowserClient(url, anonKey)  // from @supabase/ssr

// Server Components / Actions (respects RLS, reads cookies via next/headers)
createServerClient(url, anonKey, { cookies: cookieStore })

// Admin / Service Role (bypasses RLS — use for cross-user mutations only)
createServiceClient()  // wraps createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false }})
```

---

## MATCHMAKING ENGINE

**Files:** `src/lib/matchmaking-core.ts` (pure), `src/app/actions/matchmaking.ts` (async/DB)

### Priority Scoring (`computePriorityScore`)
```
Normal queue:  score = waitMinutes - (gamesPlayed × GAME_PENALTY_MINUTES=12)
Red Zone:      score = 1000 + waitMinutes  (triggers when waitMinutes >= CRITICAL_WAIT_MINUTES=25)
```

### Constants (all in `src/lib/constants.ts`)
```ts
BOTTLENECK_THRESHOLD_MINUTES = 20
SKILL_VARIANCE_TARGET = 1       // preferred window
SKILL_VARIANCE_MAX = 2          // hard max
PLAYERS_PER_MATCH = 4
ANTI_REPEAT_LOOKBACK = 5        // recent matches checked for anti-repeat
FALLBACK_WAIT_MINUTES = 15      // bypass skill windows entirely
CRITICAL_WAIT_MINUTES = 25      // Red Zone threshold
GAME_PENALTY_MINUTES = 12
RED_ZONE_SCORE_FLOOR = 1000     // sentinel: priorityScore >= this = Red Zone
```

### Candidate Scoring (`scoreCandidates`)
```
candidateScore = -priorityScore + (overlapCount × penalty)
Red Zone overlap penalty:    100×   (was 10,000× — bug fixed in commit 3d70a2e)
Normal overlap penalty:   10,000×
```
Sorted ascending (most negative = best). Red Zone urgency wins over 1 overlap.

### Group Assembly (`buildCombinationGroup`) — N-choose-3
Replaced greedy "lock best candidate first" with **full N-choose-3 combination search**:
- Iterates all C(n,3) triples of scored candidates (max ~C(30,3)=4,060)
- Returns first triple where all 3 candidates + anchor form a valid group (`isGroupValid`)
- `isGroupValid`: all pairwise skill differences ≤ `maxVariance`
- Early exit on first valid combo
- **Why:** Greedy trapped when highest-priority candidate had extreme skill — valid groups of 3 existed but were never found

### Anti-Repeat / Diversity Logic
- `buildOverlapMap(anchorId)`: queries `v_recent_pairings` — anchor-specific, called **per-tick** (NOT hoisted — each anchor has different overlap)
- `fetchRecentRosters()`: queries completed matches (last ANTI_REPEAT_LOOKBACK) — **hoisted once per `runEngineInternal` loop** (same data for all anchors in one run)
- `isDiversityViolation`: uses `Set(playerIds)` built once; each roster filters via `.has()`

### Engine Flow (`runEngineInternal`)
```
1. Pre-fetch recentRosters (once)
2. Find available courts
3. For each empty court (fill loop):
   a. buildOverlapMap(anchor)       ← per-tick, anchor-specific
   b. scoreCandidates(pool, map)
   c. buildCombinationGroup(anchor, scored, maxVariance)
   d. isGroupValid → createOneOnDeckMatch(group, recentRosters)
4. Last-resort fallback: skill validation intentionally skipped
```

### Debug Logging
All `console.log`/`console.warn` gated on `process.env.DEBUG_MATCHMAKING === "true"`.

---

## TESTING CONVENTIONS

### Unit Tests (Vitest)
**Location:** `tests/unit/`
**Run:** `npm run test:unit`
**Purpose:** Pure function logic only. No DB, no network.
**Key file:** `tests/unit/matchmaking.test.ts` — regression suite for matchmaking fixes:
- Test 1: Red Zone urgency vs overlap (scoreCandidates, 100× cap)
- Test 2: N-choose-3 finds valid group when greedy would trap (buildCombinationGroup)
- Test 3: Happy-path sanity check

### E2E Tests (Playwright)
**Location:** `tests/e2e/`
**Run:** `npm run test:e2e`
**Key:** Zero-local — tests run against live Vercel deployment URL, NOT localhost.

**Vercel Authentication Bypass:**
- Header: `x-vercel-protection-bypass: {VERCEL_BYPASS_SECRET}`
- Set in `.env.test` as `VERCEL_BYPASS_SECRET=...`
- `playwright.config.ts` injects this header on every request
- ⚠️ `_vercel_share` tokens do NOT work for automation — use only the bypass secret

**Sandbox Session Safety (teardown.ts):**
- Two hard guards before any DELETE fires:
  1. `TEST_SESSION_ID` env var must be defined
  2. `sessions.name` must start with `"🤖 E2E SANDBOX"` (prevents wiping real data)
- Delete order (FK dependency): `match_players` → `matches` → `queue_entries` → `courts` → bot auth users
- Bot users identified by `display_name LIKE 'E2E_%'`; organizer bot is reused
- `seedSession(preset)` presets: `"all_waiting"` | `"first_match_on_deck"` | `"first_match_in_progress"`

**Locator Best Practices (learned from E2E failures):**
- ❌ `page.getByText("E2E_Alice")` — fails if player name appears in Sonner toast AND player pill
- ✅ `page.getByRole("dialog").getByText("E2E_Alice")` — scope to dialog
- ✅ `page.getByTestId(\`player-pill-${userId}\`)` — data-testid only on pill buttons, never in toasts
- Sonner swap toast format: `` `Swapped ${outName} → ${inName}` `` (NOT "Swap complete")

---

## FILE MAP (critical paths)

```
src/
  app/
    actions/
      matchmaking.ts          # runEngineInternal, runAlgorithm, fetchRecentRosters, buildOverlapMap
      swap-player.ts          # swapPlayer: 4-guard + compensating sequential writes
      session.ts              # session CRUD
    organizer/[sessionId]/    # organizer dashboard route
    player/[sessionId]/       # player view route
    globals.css               # design tokens (CSS variables)
  components/organizer/
    organizer-dashboard.tsx   # shell, header, tab nav
    active-courts.tsx         # court cards, VS graphic, PlayerPill, BadmintonCourt
    on-deck-panel.tsx         # pending match cards
    score-input-modal.tsx     # score entry dialog
    queue-control.tsx         # player queue table, manual match, dnd-kit
    wait-time-monitor.tsx     # bottleneck monitor
    match-history-panel.tsx   # completed match history
  components/ui/
    skill-badge.tsx           # shared skill level badge
  hooks/
    use-organizer-data.ts     # Realtime state — ref pattern, monotonic seq
  lib/
    matchmaking-core.ts       # pure: computePriorityScore, scoreCandidates, buildCombinationGroup, isGroupValid
    constants.ts              # all numeric thresholds (single source of truth)
    supabase/
      client.ts               # createBrowserClient
      server.ts               # createServerClient
      service.ts              # createServiceClient (bypasses RLS)
  types/
    database.ts               # all DB types (type aliases, NOT interfaces)

tests/
  unit/
    matchmaking.test.ts       # Vitest regression suite
  e2e/
    scenario-a-swap.spec.ts   # Playwright E2E: swap player flow
  helpers/
    teardown.ts               # resetSandboxSession(), seedSession()
    init-sandbox.ts           # one-time sandbox session setup

.env.test                     # TEST_SESSION_ID, VERCEL_BYPASS_SECRET, Supabase keys
playwright.config.ts          # baseURL = Vercel URL, bypass header injection
```

---

## KNOWN GOTCHAS

1. **Next.js 16 breaking changes** — Do NOT assume Next.js 13/14/15 APIs. Check `node_modules/next/dist/docs/` first.
2. **`type` not `interface`** for all DB row types — Supabase generics require `type` aliases.
3. **`buildOverlapMap` is async/DB** — stays in `matchmaking.ts`, NOT in `matchmaking-core.ts` (pure).
4. **`recentRosters` hoisted, `overlapMap` NOT** — `recentRosters` is the same for all anchors; `overlapMap` is anchor-specific.
5. **Vercel bypass**: `_vercel_share` tokens don't work for Playwright. Only `x-vercel-protection-bypass` header works.
6. **dnd-kit**: `data-no-dnd` + `onPointerDown stopPropagation` BOTH required on interactive children.
7. **Service client for mutations**: Any cross-user write (swap, matchmaking) must use `createServiceClient()`.
8. **Cookie chunking**: `@supabase/ssr` chunks auth tokens at 3180 encoded chars — handle `.0`, `.1` suffixes.
