# Integration Testing Plan — Badminton Queue App

> **Status:** Approved, ready for Phase 1 execution.
> **Last updated:** 2026-05-09
> **Owner:** Principal QA / @miggy
> **Scope:** Server Actions, Matchmaking Engine, Database interactions. Vitest, no Playwright.

---

## Executive Summary

A Vitest-based integration testing harness that exercises Server Actions and the Matchmaking Engine against a **local** Supabase instance (`supabase start`). Tests run against a real Postgres 17 with our actual migrations, so RLS policies, RPC behaviour, and PG17 quirks (the `array_append` pattern, `NULLIF` in division, etc.) are all exercised end-to-end. No production data is ever touched.

Built in three phases: foundation → top-3 critical pathways → coverage expansion. Phase 1 must merge before any feature tests are written. Phase 2 PR-blocks once stable.

---

## 1. Tooling & Setup

### Packages

| Package               | Purpose                 | Notes                                                                  |
| --------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `vitest`              | Test runner             | Native ESM + TS, no config gymnastics                                  |
| `@vitest/ui`          | Optional dashboard      | Local dev only, never in CI                                            |
| `@vitest/coverage-v8` | Coverage via c8         | Built-in, no extra runtime cost                                        |
| `vite-tsconfig-paths` | Resolve `@/...` imports | Required for Server Actions to import `@/lib/...`, `@/utils/...`       |
| `dotenv`              | Load `.env.test`        | Keeps test env separate from `.env.local`                              |
| `@faker-js/faker`     | Deterministic test data | Seeded RNG per test for reproducibility                                |
| `pg`                  | Direct Postgres client  | Used by `withTx` savepoint helper and seed factories that need raw SQL |

**Explicitly NOT installing:** `@testing-library/*`, `jsdom`, `happy-dom`, Playwright. Server Action tests are pure async function calls — no DOM required.

### Configuration files

- **`vitest.config.ts`**:
  - `test.environment: 'node'`
  - `test.setupFiles: ['./tests/integration/setup.ts']`
  - `test.globalSetup: ['./tests/integration/global-setup.ts']`
  - `test.testTimeout: 30000`
  - `test.pool: 'forks'`, `test.poolOptions.forks.singleFork: true` — serial by default; parallelism is opt-in per suite once schema isolation is in place
  - Path aliases via `vite-tsconfig-paths`
  - Coverage: `provider: 'v8'`, output to `coverage/integration/`

- **`.env.test.example`** (committed):
  ```
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
  NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase status>
  SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
  ```
- **`.env.test`** — `.gitignore`d. Contributors copy from `.example` and fill in keys printed by `supabase status`.

### Server Action invocation

Server Actions are async functions exported from `"use server"` files. Tests import and call them directly:

```ts
import { closeSession } from "@/app/actions/sessions";
const result = await closeSession(sessionId);
```

The `"use server"` directive is a Next.js compile-time hint — at runtime they're plain Node functions. No Next.js test harness needed.

### Auth mocking — DECIDED: stub the server client (Option B)

A `tests/integration/helpers/mock-auth.ts` helper:

```ts
// usage in a test:
const restore = mockAuthAs(userId); // sets the active mock identity
await closeSession(sessionId);
restore(); // cleans up after
```

Implementation: `vi.mock('@/utils/supabase/server', ...)` returns a Supabase client backed by the **service role key** but with an injected `auth.getUser()` that returns the mocked `userId`. This means RLS policies that check `auth.uid()` see the mocked user, but the underlying client can bypass RLS for setup queries when needed.

**Single drift-detector:** `tests/integration/auth.real.test.ts` performs one full real auth flow (`supabase.auth.signInAnonymously()` → call action → assert). If this passes, the mock is structurally compatible with the real client. Run on every CI build.

**Rationale:** Real auth roundtrips add ~150ms per test. We have ~50 tests planned for Phase 2 — that's an extra 7s per CI run with no added value beyond the single drift-detector.

---

## 2. Database Strategy (CRITICAL)

### Decision: **Supabase CLI local dev** — `supabase start`

| Option                    | Verdict       | Why                                                                                                                 |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Supabase CLI local**    | ✅ **Chosen** | Free, ~10s Docker boot (reused across runs), real Postgres 17, all migrations, identical RLS, identical auth schema |
| Supabase branching        | ❌            | Costs per branch-day, network latency, overkill for unit-of-work tests. Reserve for staging integration.            |
| Testcontainers (raw `pg`) | ❌            | Loses Supabase-specific features (RLS, auth, storage). Forces parallel migration runner.                            |
| Mocks / in-memory         | ❌            | Defeats the point. RLS, RPC, FK cascades, PG17 quirks only show up against real Postgres.                           |

### Test isolation — three layers, chosen per test class

**Layer A — Transactional savepoint (default for single-RPC actions)**
A `withTx(fn)` helper wraps the test in `BEGIN; SAVEPOINT t; ... ROLLBACK TO t;` and discards all writes.
_Caveat:_ Only works when the tested code uses one logical connection. Multi-RPC server actions (e.g. `closeSession`) use the Supabase client which manages its own connection pool — savepoints won't catch those writes. Use Layer B for these.

**Layer B — Targeted truncation (for multi-RPC actions)**
An `afterEach` cleans domain tables in dependency order:

```sql
TRUNCATE session_wrapped_stats, player_rivalries, player_partnerships,
         match_players, match_games, matches, queue_entries,
         courts, session_organizers, sessions, profiles
RESTART IDENTITY CASCADE;
```

`auth.users` rows created by tests are removed via `auth.admin.deleteUser()`. **Never** truncate `auth.users` directly — breaks Supabase Auth's internal schema.

**Layer C — Full reset (between suite files in CI)**
`supabase db reset` runs between suite files in CI for a clean slate. ~15s cost per suite, but guarantees no cross-suite pollution. Local dev can opt out via `SKIP_DB_RESET=1`.

### Seeds & factories

`tests/integration/factories/`:

- `makeProfile({ skill, name? })` → inserts profile + auth user, returns `{ id, displayName }`
- `makeSession({ organizer, players? })` → session + queue entries
- `makeCompletedMatch({ session, teamA, teamB, scoreA, scoreB })` → matches + match_players + scores
- `seedSessionWithHistory(N)` → composable helper for multi-session Wrapped scenarios

Faker seeded with a fixed value at the top of each test for reproducible UUIDs and names.

### Migrations & schema parity

`supabase migration up` runs in `globalSetup` to align local schema with `supabase/migrations/`. CI fails fast if a migration errors.

A dedicated `tests/integration/schema-parity.test.ts` calls `pg_get_functiondef` on `compute_session_wrapped` and `refresh_cross_session_stats`, asserts they exist with the expected signature, and (in CI) verifies the deployed Supabase dev function matches the local file. Catches deploy-vs-migration drift before it becomes a 3am debugging session.

---

## 3. The Target Matrix — Top 3 Critical Pathways

Ranked by **blast radius if broken** × **complexity of logic**.

### #1 — Matchmaking Engine (`runEngineInternal` in `src/app/actions/matchmaking.ts`)

**Why critical:** The single most complex business logic in the app. Wrong matches anger users immediately. TOCTOU bugs corrupt match state. Partnership cap, Red Zone wait, draft mode, skill balancing all converge here.

**Test cases:**

- **Happy path:** 8 waiting players → engine returns 2 matches with no partnership repeats.
- **Partnership cap:** Seed `partner_counts` so a pair has reached `MAX_PARTNERSHIP_REPEATS = 2` → engine MUST NOT pair them again. Assert via returned drafts.
- **Mixed-skill flag:** Force a skill spread > threshold → asserts `is_mixed_level = true`.
- **Red Zone wait bypass:** Player waiting > `CRITICAL_WAIT_MINUTES` should be prioritised over partnership-cap fairness.
- **TOCTOU guard 1 (cap saturation):** Insert a competing pending match between candidate selection and `create_match_with_players` call → engine detects via conflict guard, does NOT create overlapping matches.
- **TOCTOU guard 2 (player conflict):** Same player appears in two concurrent draft attempts → engine returns NULL for the second.
- **Draft mode:** Engine creates with `is_published = false`. Queue entries NOT updated until `publishMatchAction` fires.
- **`MAX_AUTO_DRAFTS = 3` cap:** Engine returns early when total pending matches (published + draft) ≥ 3.

### #2 — `closeSession` + Wrapped Pipeline (`sessions.ts` + 3 RPCs)

**Why critical:** Just shipped. Touches `refresh_cross_session_stats`, `compute_session_wrapped`, `refresh_alltime_leaderboard`, broadcasts, queue cancellation, plus the new cross-session ledger tables. A regression here breaks Wrapped pages for every player every session close.

**Test cases:**

- **End-to-end happy path:** Seed a session with 4 players, 6 completed matches. Call `closeSession`. Assert: `session_wrapped_stats` rows for all 4, `player_rivalries` populated, `player_partnerships` populated, `carry_forward` JSONB shape correct, session marked inactive.
- **Idempotency:** Calling `closeSession` on an already-closed session returns `{ success: false, message: "Session is already closed." }` with no side effects.
- **`refresh_cross_session_stats` failure is non-fatal:** Mock the RPC to throw → close still completes, `wrappedReady` reflects only the `compute_session_wrapped` outcome.
- **`compute_session_wrapped` retry:** First call fails, retry succeeds → `wrappedReady = true`.
- **Cross-session arithmetic:** Run two sessions back-to-back. After session 2 closes, assert `player_rivalries.sessions_faced = 2` for shared pairs, `wins_vs/losses_vs` are cumulative, `carry_forward.ended_on_win_streak` reflects the actual end-of-session streak (not peak).
- **New award triggers fire correctly:** Seed two prior sessions where a player had `win_pct >= 70`, plus tonight at 70%+. Assert `consistent_dominator` appears in `earned_awards`. Same pattern for `nemesis_slayer`, `bounced_back`, `momentum`.
- **Authorization:** Non-organizer caller is rejected; co-organizers succeed.

### #3 — Publish + Queue Side Effects (`publishMatchAction` in `match.ts`)

**Why critical:** The 3-layer RLS firewall + draft-mode logic guards data integrity. A bug here either (a) shows draft matches to players prematurely or (b) leaves queue entries inconsistent with match state. Both create immediate user-visible chaos.

**Test cases:**

- **Publish flips `is_published`:** Draft → `true`. All 4 players' `queue_entries.status` transition `waiting → playing` atomically.
- **Idempotency:** Double-publish on same match → second call is a no-op, no duplicate queue updates.
- **Publish All:** 3 drafts → all flip in a single transaction; partial failure rolls back all.
- **RLS firewall:** Anon user rejected. Player-not-organizer rejected. Organizer-of-different-session rejected.
- **Queue entry race:** Player publishes while a swap RPC runs on the same match → swap RPC's `WHERE status IN ('pending', 'in_progress')` predicate catches the conflict; one of the two errors cleanly.
- **`hasDraftsBlocking` propagation:** All pending matches as drafts → `callNextMatchAction` returns `{ hasDraftsBlocking: true }` and refuses to pull.

---

## 4. Phased Implementation Plan

Each phase is a discrete, mergeable PR. Phase 1 is a hard prerequisite for any actual test code.

### Phase 1 — Foundation (1–2 days)

**Goal:** One trivial integration test passing in CI.

**Deliverables:**

- Install Vitest + deps; write `vitest.config.ts`
- `tests/integration/setup.ts` (Supabase client, env loading)
- `tests/integration/global-setup.ts` (assert `supabase start` running, apply migrations)
- `tests/integration/helpers/mock-auth.ts` (auth stub — Option B from §1)
- `tests/integration/helpers/withTx.ts` (savepoint wrapper)
- `tests/integration/helpers/truncate.ts` (targeted cleanup)
- `tests/integration/factories/` skeleton (`makeProfile`, `makeSession`)
- `.env.test.example` and `tests/integration/README.md`
- One smoke test: `health.test.ts` — creates a profile, asserts row visible, rolls back. Must pass locally and in CI.
- CI job: GitHub Actions matrix step — `supabase start` then `vitest run --reporter=verbose`. Pin Node + Supabase CLI versions.

**Exit criteria:** `npm run test:integration` green locally and in CI. No feature tests yet — proves the harness works.

### Phase 2 — Critical Paths (3–5 days)

**Goal:** Cover the Top 3 pathways from §3.

**Deliverables:**

- **Suite A:** `matchmaking.test.ts` — 8 cases on `runEngineInternal`
- **Suite B:** `close-session.test.ts` — 7 cases on `closeSession` + cross-session pipeline
- **Suite C:** `publish-match.test.ts` — 6 cases on publish + queue side effects
- `pretest` hook running `supabase db reset` between suites in CI (skipped locally with `SKIP_DB_RESET=1`)
- File-scoped coverage threshold for `src/app/actions/sessions.ts`, `src/app/actions/matchmaking.ts`, `src/app/actions/match.ts` at **70% line coverage**. No global threshold yet.
- **PR-block once stable** (DECIDED): integration suite is **required** for merge to main once Phase 2 stabilises (defined as: <1 flake in 10 consecutive CI runs over 2 days). Flaky tests are quarantined or fixed before merge — never tolerated.

**Exit criteria:** Three suites pass green. Coverage report shows targeted files ≥ 70%. No flakes in the trailing 10 CI runs.

### Phase 3 — Coverage Expansion + Hardening (5–7 days, post-MVP)

**Goal:** Catch the long tail.

**Deliverables:**

- **Concurrency tests:** `Promise.all` × 5 concurrent `publishMatchAction` on same match → only one succeeds. Same for `runEngineForSession` → engine serialises via `engineRunningSessionIds` set or DB advisory lock.
- **RLS edge cases:** Anon writes to every table; organizer of session A reading session B; player reading another player's `session_wrapped_stats`.
- **PIN reconnect:** `migrate_player_identity` — old user → new user data migration; primary organizer protection.
- **Score submission cascade:** `scoreMatchAction` → match completed → queue updated → `refresh_alltime_leaderboard` queued → leaderboard view reflects new totals.
- **Schema parity test** (per §2): `pg_get_functiondef` matches local migration; deployed Supabase dev function matches local file.
- **Performance smoke:** `closeSession` on a 12-player / 30-match session completes < 5s.
- Tighten action-file coverage thresholds to **85%**; introduce global threshold of **50%** to track creep.
- Complete `tests/integration/README.md` (factory authoring, single-test debugging, common gotchas).

**Exit criteria:** All Phase 3 tests green. CI runs in < 3 min total. README is complete enough that a new contributor can add a test without asking.

---

## Decisions (locked)

| #   | Decision           | Choice                                                                          | Rationale                                                                                           |
| --- | ------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Auth mocking style | **Stub `@/utils/supabase/server` (Option B)**                                   | Per-test speed (~150ms saved each); single `auth.real.test.ts` drift-detector keeps the mock honest |
| 2   | Coverage tool      | **`@vitest/coverage-v8` (c8)**                                                  | Built into Vitest, no extra runtime, sufficient detail                                              |
| 3   | CI provider        | **GitHub Actions**                                                              | Matches existing repo pattern                                                                       |
| 4   | PR-block default   | **Required for merge once Phase 2 stabilises** (<1 flake / 10 runs over 2 days) | Quality gate. Flakes get fixed or quarantined immediately, not tolerated                            |

---

## Out of Scope

- Browser E2E (Playwright) — explicitly excluded by request
- React component unit tests
- Visual regression
- Load / stress testing beyond the Phase 3 single-session perf smoke
- Production-environment integration (Supabase dev branching, live Stripe-style external services)

These can be revisited as separate efforts once the integration suite is established.
