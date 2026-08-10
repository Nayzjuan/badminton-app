# Integration Tests — Badminton Queue App

Vitest-based integration tests that exercise Server Actions and the Matchmaking Engine against a **local** Supabase instance (`supabase start`). Tests run against real Postgres 17 with our actual migrations — RLS policies, RPC behaviour, and all quirks are exercised end-to-end.

No Playwright. No DOM. Server Actions are pure async functions.

---

## Quick Start

### 1. Start local Supabase

```bash
supabase start
```

Keep it running. Once started, it stays up until you explicitly stop it with `supabase stop`.

### 2. Copy the env template

```bash
cp tests/integration/env.example tests/integration/.env
```

### 3. Fill in keys from `supabase status`

```bash
supabase status
```

Copy the **anon key** and **service_role key** into `tests/integration/.env`. The `DATABASE_URL` uses the default Postgres port (`54322`) and password (`postgres`) — only change it if you customised your Supabase CLI config.

### 4. Run integration tests

```bash
npm run test:integration          # full suite
npm run test:integration:reset    # supabase db reset first (matches CI exactly)
```

---

## Debugging a Single Test

Run one specific test file:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/matchmaking.test.ts
```

Run one specific test by name pattern (`-t` matches against the test description):

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/matchmaking.test.ts \
  -t "partnership cap"
```

Watch mode for active development (re-runs on file save):

```bash
npm run test:integration:watch
```

Enable verbose engine logging (helps diagnose why the matchmaking engine chose a group):

```bash
DEBUG_MATCHMAKING=true npx vitest run --config vitest.integration.config.ts \
  tests/integration/matchmaking.test.ts -t "partnership cap"
```

---

## Architecture

### Test Suites

| Suite                | File                       | What it covers                                                                                     |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| **Health**           | `health.test.ts`           | Harness smoke — connectivity, factory round-trip, cleanup                                          |
| **Auth drift**       | `auth.real.test.ts`        | One real auth roundtrip to keep the mock honest                                                    |
| **Matchmaking**      | `matchmaking.test.ts`      | Engine: draft mode, partnership cap, mixed-skill, Red Zone, draft cap, TOCTOU, `hasDraftsBlocking` |
| **Close Session**    | `close-session.test.ts`    | `closeSession` + Wrapped pipeline: auth, idempotency, state transitions, cross-session stats       |
| **Publish Match**    | `publish-match.test.ts`    | Draft publish, queue transitions, RLS firewall, `publishAll`, `hasDraftsBlocking`                  |
| **Concurrency**      | `concurrency.test.ts`      | Concurrent publish idempotency, engine in-process serialization, CAS double-promote guard          |
| **RLS Edge Cases**   | `rls-edge-cases.test.ts`   | Anon read/write blocked, cross-session organizer isolation                                         |
| **Score Submission** | `score-submission.test.ts` | `endMatchAction` cascade: completed → re-queued → court freed → leaderboard                        |
| **Schema Parity**    | `schema-parity.test.ts`    | All 8 key RPCs, 2 tables, 2 columns, 1 materialized view confirmed via `pg_catalog`                |
| **Performance**      | `performance.test.ts`      | `closeSession` on 12-player/30-match session < 7s                                                  |

### Environment

| File                            | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `tests/integration/env.example` | Committed template — copy to `.env` and fill in     |
| `tests/integration/.env`        | Gitignored. Contains local Supabase keys            |
| `vitest.integration.config.ts`  | Separate Vitest config (does not affect unit tests) |

### Infrastructure Files

| File                   | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `global-setup.ts`      | Runs once: checks Supabase is running, applies migrations   |
| `setup.ts`             | Runs per-worker: loads env, installs auth mock              |
| `helpers/mock-auth.ts` | `mockAuthAs(userId)` — controls which user an action "sees" |
| `helpers/withTx.ts`    | Layer A isolation — pg savepoint transactions               |
| `helpers/truncate.ts`  | Layer B isolation — targeted DELETE after each test         |
| `factories/index.ts`   | All seed helpers (see Factories Reference below)            |

---

## Auth Mocking

Server Actions call `supabase.auth.getUser()` to identify the caller. The mock in `setup.ts` (Option B) replaces `@/utils/supabase/server` with a service-role client whose `auth.getUser()` is controlled by `mockAuthAs()`.

```ts
import { mockAuthAs } from "./helpers/mock-auth";

it("organizer can close session", async () => {
  const restore = mockAuthAs(organizerId);
  try {
    const result = await closeSession(sessionId);
    expect(result.success).toBe(true);
  } finally {
    restore(); // always call this — use try/finally or afterEach
  }
});
```

Or with `beforeEach`/`afterEach`:

```ts
let restoreAuth: () => void;
beforeEach(() => {
  restoreAuth = mockAuthAs(organizerId);
});
afterEach(() => restoreAuth());
```

**Important:** `createServiceClient()` (used inside some actions for the organizer check) is **not** mocked — it creates a real service-role client. Tests must ensure `session.created_by === mockUserId` (which `makeSession` guarantees when you pass the same `organizer`).

The drift-detector (`auth.real.test.ts`) runs one real auth roundtrip per CI build to verify the mock's shape hasn't drifted from the real client.

---

## Test Isolation

Three layers — pick the lightest one that works:

| Layer             | Helper                                   | When to use                                                  |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------ |
| **A — Savepoint** | `withTx(fn)`                             | Direct `pg` queries; single-connection tests (schema-parity) |
| **B — Truncate**  | `truncateTracked()` in `afterEach`       | Server Actions (multi-connection) — default for most suites  |
| **C — DB reset**  | `supabase db reset` in CI between suites | Full clean slate between CI runs                             |

**Layer B** (truncate) is the default for most tests:

```ts
import { truncateTracked } from "./helpers/truncate";

afterEach(async () => {
  await truncateTracked();
});
```

`makeProfile()` automatically registers created auth users with `trackAuthUser()`, so `truncateTracked()` deletes them too. No manual tracking needed.

---

## Writing a New Test

### 1. Choose a seed number

Each suite uses a fixed Faker seed at the describe-block level. Pick a number that isn't already used:

| Suite            | Seed |
| ---------------- | ---- |
| health           | 1001 |
| matchmaking      | 2001 |
| close-session    | 3001 |
| publish-match    | 4001 |
| concurrency      | 5001 |
| rls-edge-cases   | 6001 |
| score-submission | 7001 |
| performance      | 8001 |

New suites: use the next unused thousand (9001, 10001, …).

```ts
const faker = new Faker({ locale: [en] });
faker.seed(9001); // pick from the table above
```

### 2. Seed data via factories

```ts
import { makeProfile, makeSession, makeCourt } from "./factories";

const organizer = await makeProfile({ faker });
const session = await makeSession({ faker, organizer: organizer.id });
const court = await makeCourt({ sessionId: session.id, name: "Court 1" });
```

### 3. Set up cleanup

```ts
import { truncateTracked } from "./helpers/truncate";

afterEach(async () => {
  await truncateTracked();
});
```

### 4. Mock the calling user

```ts
import { mockAuthAs } from "./helpers/mock-auth";

it("organizer can do X", async () => {
  const restore = mockAuthAs(organizer.id);
  try {
    const result = await someServerAction(session.id);
    expect(result.success).toBe(true);
  } finally {
    restore();
  }
});
```

### 5. Assert DB state via serviceClient

```ts
import { serviceClient } from "./helpers/truncate";

const { data } = await serviceClient().from("profiles").select("*").eq("id", playerId).single();

expect(data?.skill_level).toBe("advanced");
```

---

## Factories Reference

All factories live in `tests/integration/factories/index.ts`.

### `makeProfile(options)`

Creates a Supabase auth user + profiles row. Tracked for cleanup automatically.

```ts
const { id, displayName } = await makeProfile({
  faker,
  skill: "advanced", // SkillLevel — defaults to "intermediate"
  displayName: "Test Bot", // optional override
  pin: "1234", // optional 4-digit PIN
});
```

### `makeSession(options)`

Creates a session + inserts the organizer into `session_organizers`.

```ts
const { id, name } = await makeSession({
  faker,
  organizer: organizerId, // required — must exist in profiles
  scoring: "single", // defaults to "single"
  name: "My Test", // optional — generated if omitted
});
```

### `makeQueueEntry(options)`

Inserts a player into a session's queue.

```ts
const { id } = await makeQueueEntry({
  sessionId: session.id,
  playerId: player.id,
  status: "waiting", // "waiting" | "on_deck" | "playing" | "left" — defaults to "waiting"
});
```

### `makeCourt(options)`

Creates a court for a session. **The matchmaking engine requires at least one non-closed court to run.**

```ts
const { id } = await makeCourt({
  sessionId: session.id,
  name: "Court 1",
  status: "available", // "available" | "in_use" | "closed" — defaults to "available"
});
```

### `makeMatch(options)`

Creates a pending/in-progress match with 4 match_players rows. Use for seeding draft matches and TOCTOU tests.

```ts
const { id } = await makeMatch({
  sessionId: session.id,
  teamA: [p1.id, p2.id], // exactly 2 player UUIDs
  teamB: [p3.id, p4.id], // exactly 2 player UUIDs
  courtId: court.id, // optional — null = on-deck (no court assigned)
  status: "pending", // defaults to "pending"
  isPublished: false, // defaults to false (draft)
  isMixedLevel: false, // defaults to false
});
```

### `makeCompletedMatch(options)`

Creates a completed match with scores. Used to seed session history for partnership-cap, Wrapped pipeline, and cross-session stats tests.

> **Note:** `team_a_score`, `team_b_score`, and `completed_at` are not in `MatchInsert` — the factory does a 2-step insert + update internally. This is normal.

```ts
const { id } = await makeCompletedMatch({
  sessionId: session.id,
  teamA: [p1.id, p2.id],
  teamB: [p3.id, p4.id],
  scoreA: 21, // defaults to 21
  scoreB: 15, // defaults to 15
  courtId: court.id, // optional
});
```

### `enableAutoMatchmaking(sessionId)`

Enables `is_auto_matchmaking_on` on a session. `SessionInsert` doesn't include this field, so it must be set separately after creation. Required for any engine test using `runEngineForSession`.

```ts
await enableAutoMatchmaking(session.id);
```

### `ageQueueEntry(entryId, minutesAgo)`

Back-dates a queue entry's `joined_at`. Used to simulate Red Zone (> 25 min) or last-resort fallback (> 15 min) scenarios without sleeping.

```ts
const { id: entryId } = await makeQueueEntry({ sessionId: session.id, playerId: player.id });
await ageQueueEntry(entryId, 30); // simulate 30 min wait
```

---

## Common Issues

### `Cannot reach local Supabase`

Run `supabase start` and wait for it to finish (~10–15s on first run, then instant). Check the URL in `tests/integration/.env` is `http://127.0.0.1:54321`.

### `Missing tests/integration/.env`

```bash
cp tests/integration/env.example tests/integration/.env
# Then fill in anon key + service_role key from: supabase status
```

### `Profile insert foreign key error`

The `profiles` table has a FK to `auth.users`. Always use `makeProfile()` (which creates the auth user first) rather than inserting into `profiles` directly.

### `makeCompletedMatch` — scores not appearing

The factory does a 2-step insert + update (scores aren't in `MatchInsert`). If the update fails, the match will exist with `null` scores and won't be picked up by `refresh_cross_session_stats` (which filters `WHERE team_a_score IS NOT NULL`). Check for DB errors in the factory call.

### Partnership cap test — engine still pairs the capped players

`fetchSessionMatchSnapshot` reads `completed`, `in_progress`, and `pending` matches in the **current session** (the caps are then derived from it by `derivePairCounts`). The history must be in the same `session_id` as the engine run. Seeding completed matches in a different session ID won't affect the cap.

Also: make sure players are seeded directly into `queue_entries` via `makeQueueEntry` — NOT via `seedPlayers` after `makeCompletedMatch` (which would create duplicate queue entries and trigger a unique constraint).

### `truncateTracked()` deletes too much

It wipes ALL domain tables. If you need partial cleanup, use `serviceClient().from("table").delete().eq(...)` directly in your test.

### Tests interfere with each other

Tests run serially (one file at a time, `fileParallelism: false`). If you see interference, check that:

- `afterEach` calls `truncateTracked()`
- `clearMockAuth()` is called in `afterEach` for any suite that uses `clearMockAuth()` directly
- The Faker seed is set at the module level (not shared across suite files)

### Engine creates 0 matches despite 8 waiting players

Check: (1) `is_auto_matchmaking_on` is `true` — call `enableAutoMatchmaking(session.id)`. (2) At least one court exists with status `"available"` — call `makeCourt(...)`. (3) `MAX_AUTO_DRAFTS` isn't already saturated (3 pending matches = cap).

### Schema-parity tests fail

Your local schema is behind the migrations. Run `supabase db reset` or `supabase db push --local` to re-apply all migrations from scratch.
