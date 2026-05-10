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
npm run test:integration
```

---

## Architecture

### Environment

| File | Purpose |
|------|---------|
| `tests/integration/env.example` | Committed template — copy to `.env` and fill in |
| `tests/integration/.env` | Gitignored. Contains local Supabase keys |
| `vitest.integration.config.ts` | Separate Vitest config (does not affect unit tests) |

### Infrastructure Files

| File | Purpose |
|------|---------|
| `global-setup.ts` | Runs once: checks Supabase is running, applies migrations |
| `setup.ts` | Runs per-worker: loads env, installs auth mock |
| `helpers/mock-auth.ts` | `mockAuthAs(userId)` — controls which user an action "sees" |
| `helpers/withTx.ts` | Layer A isolation — pg savepoint transactions |
| `helpers/truncate.ts` | Layer B isolation — targeted TRUNCATE after each test |
| `factories/index.ts` | `makeProfile`, `makeSession`, `makeQueueEntry` seed helpers |

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
beforeEach(() => { restoreAuth = mockAuthAs(organizerId); });
afterEach(() => restoreAuth());
```

The drift-detector (`auth.real.test.ts`) runs one real auth roundtrip per CI build to verify the mock's shape hasn't drifted from the real client.

---

## Test Isolation

Three layers — pick the lightest one that works:

| Layer | Helper | When to use |
|-------|--------|-------------|
| **A — Savepoint** | `withTx(fn)` | Direct `pg` queries; single-connection tests |
| **B — Truncate** | `truncateTracked()` in `afterEach` | Server Actions (multi-connection) |
| **C — DB reset** | `supabase db reset` in CI between suites | Cross-suite cleanup |

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

### 1. Seed data via factories

```ts
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession } from "./factories";

const faker = new Faker({ locale: [en] });
faker.seed(9999); // fixed per suite — pick any integer
```

### 2. Set up cleanup

```ts
import { truncateTracked } from "./helpers/truncate";

afterEach(async () => {
  await truncateTracked();
});
```

### 3. Mock the calling user

```ts
import { mockAuthAs } from "./helpers/mock-auth";

it("works", async () => {
  const organizer = await makeProfile({ faker });
  const session   = await makeSession({ faker, organizer: organizer.id });

  const restore = mockAuthAs(organizer.id);
  try {
    const result = await someServerAction(session.id);
    expect(result.success).toBe(true);
  } finally {
    restore();
  }
});
```

### 4. Assert DB state via serviceClient

```ts
import { serviceClient } from "./helpers/truncate";

const { data } = await serviceClient()
  .from("profiles")
  .select("*")
  .eq("id", playerId)
  .single();

expect(data?.skill_level).toBe("advanced");
```

---

## Factories Reference

### `makeProfile(options)`

Creates a Supabase auth user + profiles row. Tracked for cleanup automatically.

```ts
const { id, displayName } = await makeProfile({
  faker,
  skill: "advanced",       // SkillLevel — defaults to "intermediate"
  displayName: "Test Bot", // optional override
  pin: "1234",             // optional 4-digit PIN
});
```

### `makeSession(options)`

Creates a session + inserts the organizer into `session_organizers`.

```ts
const { id, name } = await makeSession({
  faker,
  organizer: organizerId, // required — must exist in profiles
  scoring: "single",      // defaults to "single"
  name: "My Test",        // optional — generated if omitted
});
```

### `makeQueueEntry(options)`

Inserts a player into a session's queue.

```ts
const { id } = await makeQueueEntry({
  sessionId: session.id,
  playerId: player.id,
  status: "waiting", // defaults to "waiting"
});
```

---

## Common Issues

### `Cannot reach local Supabase`
Run `supabase start` and wait for it to finish (~10–15s on first run, then instant).

### `Missing tests/integration/.env`
Run: `cp tests/integration/env.example tests/integration/.env` and fill in keys from `supabase status`.

### `Profile insert foreign key error`
The `profiles` table has a FK to `auth.users`. Always use `makeProfile()` (which creates the auth user first) rather than inserting into `profiles` directly.

### `truncateTracked() deletes too much`
It deletes ALL rows in ALL domain tables — by design. If you need partial cleanup, use `serviceClient().from("table").delete().eq(...)` directly.

### Tests interfere with each other
Tests run serially (`singleFork: true`). If you see interference anyway, check that `afterEach` is calling `truncateTracked()` and that the Faker seed is set at the describe-block level (not globally across all suites).
