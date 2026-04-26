# Test Suite

Two independent layers: **unit tests** (fast, mocked, no network) and **E2E tests** (live Vercel + Supabase).

---

## Unit Tests (Vitest)

Pure functions and Supabase-mocked engine logic. No browser, no network.

```bash
# Run once
npm run test:unit

# Run with coverage report
npm run test:unit:coverage
```

### What's covered

| File | Suite | What it tests |
|------|-------|---------------|
| `tests/unit/matchmaking-core.test.ts` | 70 tests | All 10 pure algorithm functions (scoring, drafts, diversity, lookback) |
| `tests/unit/matchmaking-engine.test.ts` | 19 tests | `promoteOnDeckMatchInternal`, `runEngineForSession`, `callNextMatch` with mocked Supabase |

### Shared helpers

`tests/helpers/admin-db.ts` — exports `adminDb()`, the service-role Supabase client used for DB seeding and assertions in E2E tests.

### Coverage thresholds

Enforced via `vitest.config.ts`. Current baseline for `matchmaking.ts`:
- Statements 55% | Branches 40% | Functions 60% | Lines 55%

Raise these incrementally as new suites are added.

---

## E2E Test Suite — Zero-Local Approach

Tests run against the **live Vercel deployment** using a dedicated sandbox
session in the production Supabase project. No local Next.js server required.

## First-Time Setup

### 1. Create the sandbox session

In the app, create a session named exactly:
```
🤖 E2E SANDBOX — DO NOT JOIN
```
Copy its UUID from the URL bar.

### 2. Configure environment

```bash
cp .env.test.example .env.test
# Edit .env.test and fill in:
#   TEST_BASE_URL        — your Vercel URL
#   TEST_SESSION_ID      — UUID from step 1
#   NEXT_PUBLIC_SUPABASE_URL
#   SUPABASE_SERVICE_ROLE_KEY
```

### 3. Install browsers

```bash
npx playwright install chromium
```

## Running Tests

```bash
# Run all E2E tests
npx playwright test

# Run a single spec
npx playwright test tests/e2e/scenario-a-swap.spec.ts

# Interactive UI mode (great for debugging)
npx playwright test --ui

# Show last HTML report
npx playwright show-report
```

## Architecture

```
tests/
├── unit/                                     # Vitest — no network
│   ├── matchmaking-core.test.ts             # 70 tests — pure algorithm functions
│   └── matchmaking-engine.test.ts           # 19 tests — mocked Supabase engine
├── e2e/                                      # Playwright — live Vercel
│   ├── scenario-a-swap.spec.ts              # Tap-to-Swap happy + negative paths
│   ├── scenario-b-engine-flows.spec.ts      # Auto-matchmaking engine flows
│   ├── scenario-c-tap-to-swap-v2.spec.ts    # In-match tap-to-tap swap
│   ├── scenario-d-session-wrapped-dismiss.spec.ts
│   ├── scenario-e-match-alert-ui.spec.ts
│   ├── scenario-f-court-time-alert.spec.ts
│   ├── scenario-g-h2h-records.spec.ts
│   └── scenario-h-diversity.spec.ts
├── fixtures/
│   └── auth.ts                               # Organizer bot sign-in helpers
└── helpers/
    ├── admin-db.ts                           # Shared service-role Supabase client
    ├── teardown.ts                           # SAFETY-CRITICAL: DB wipe + seed
    └── init-sandbox.ts                       # One-time sandbox session setup
```

### The Setup/Teardown Loop

Every test runs this lifecycle:

1. `beforeEach` → `resetSandboxSession()` wipes all child rows for
   `TEST_SESSION_ID` then `seedSession()` recreates known-good state
2. Test body runs — drives the live Vercel URL
3. No `afterEach` cleanup — the next `beforeEach` handles it

### Safety Guardrails

The `teardown.ts` script has **two hard guards** that must both pass
before any DELETE fires:

1. `TEST_SESSION_ID` must be defined (fatal error if missing)
2. The session's `name` must start with `"🤖 E2E SANDBOX"` —
   physically impossible to wipe a real production session

### Storage State

The organizer bot's browser session is saved to
`.playwright/organizer-storage-state.json` (gitignored) after the first
`beforeAll` sign-in. Subsequent tests reuse it without re-signing in.

If the session expires or the bot account is recreated:
```bash
rm .playwright/organizer-storage-state.json
npx playwright test  # re-signs in automatically
```

## Adding a New Scenario

1. Add a file `tests/e2e/scenario-X-name.spec.ts`
2. Call `resetSandboxSession()` + `seedSession()` in `beforeEach`
3. Use `ORGANIZER_STORAGE_STATE` for authenticated contexts
4. Import `adminDb` from `"../helpers/admin-db"` for DB assertions — do NOT define a local copy
5. Assert both UI state (`expect(page...)`) and DB state via `adminDb()`
6. Wrap long test bodies with `await test.step("phase name", async () => { ... })` for readable HTML reports
7. Follow the 80/20 rule — only test flows that cross a process boundary
   and would be visible to a user within one game session
