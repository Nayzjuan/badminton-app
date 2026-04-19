# E2E Test Suite — Zero-Local Approach

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
├── e2e/                          # One file per scenario
│   └── scenario-a-swap.spec.ts  # Tap-to-Swap (Scenario A)
├── fixtures/
│   └── auth.ts                  # Organizer bot sign-in helpers
└── helpers/
    └── teardown.ts              # SAFETY-CRITICAL: DB wipe + seed
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
4. Assert both UI state (`expect(page...)`) and DB state (admin client)
5. Follow the 80/20 rule — only test flows that cross a process boundary
   and would be visible to a user within one game session
