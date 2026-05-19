# Zero-Local E2E Testing Strategy

**Status:** Plan v1 — awaiting approval
**Author:** Staff SDET (Claude)
**Target:** Next.js 16 + Supabase real-time queue app
**Approach:** Zero-Local / Isolated Session — Playwright drives the live Vercel deployment against a dedicated sandbox session in the production Supabase project.

---

## 0. Executive Summary

We will not stand up a local Next.js dev server, a Docker Postgres, or seed-on-startup CI pipelines. Tests run against the **already-deployed Vercel URL** and use a single, well-known **`TEST_SESSION_ID`** in the production database. The Playwright runner uses the **Supabase service role key** out-of-band to wipe and reseed only that session's rows between tests — leaving all real user data untouched.

This trades "perfect environmental purity" for **shipping speed and production-fidelity**: every test exercises the exact bundle that real users hit, the exact RLS policies, the exact realtime channels.

**Hard guardrails that make this safe:**
1. Cleanup queries are scoped by `session_id = TEST_SESSION_ID` — physically impossible to delete production rows.
2. Test player accounts use a recognizable email pattern (`e2e-bot-*@playwright.local`) — easy to audit, easy to exclude from analytics.
3. The sandbox session has `name = "🤖 E2E SANDBOX — DO NOT JOIN"` and lives in a flag-gated organizer account that real users never see.
4. CI fails closed if `TEST_SESSION_ID` is unset or matches a non-sandbox session UUID.

---

## 1. Repository & File Structure

```
badminton-app/
├── playwright.config.ts                    # Single config at repo root (Playwright convention)
├── .env.test                               # Local-only, gitignored — TEST_SESSION_ID, SUPABASE_SERVICE_ROLE_KEY, BASE_URL
├── tests/
│   ├── e2e/
│   │   ├── tap-to-swap.spec.ts             # Scenario A
│   │   ├── match-promotion.spec.ts         # Scenario B
│   │   ├── queue-management.spec.ts        # Scenario C
│   │   ├── score-submission.spec.ts        # Scenario D
│   │   └── pin-reconnect.spec.ts           # Scenario E
│   ├── fixtures/
│   │   ├── test-base.ts                    # Custom Playwright `test` extended with sandboxSession fixture
│   │   ├── personas.ts                     # Pre-defined bot players: ALICE_BEGINNER, BOB_INTERMEDIATE, etc.
│   │   └── selectors.ts                    # Centralized data-testid + ARIA-role selectors (no CSS classes)
│   ├── helpers/
│   │   ├── supabase-admin.ts               # Service-role client + assertion helpers (queryQueue, queryMatch)
│   │   ├── seed.ts                         # seedSession({ courts, players, queueEntries }) builder
│   │   ├── teardown.ts                     # resetSandboxSession() — the idempotency keystone
│   │   ├── auth.ts                         # signInAs(persona) — programmatic anonymous-auth + cookie injection
│   │   └── realtime.ts                     # waitForRealtimeUpdate() — poll-until helpers
│   └── README.md                           # How to run locally + add a new scenario
├── .github/
│   └── workflows/
│       └── e2e.yml                         # Triggered on Vercel "Deployment Ready" webhook
└── src/                                    # (unchanged)
```

### Why this layout

- **`playwright.config.ts` at repo root** — Playwright's CLI discovers it automatically; no `--config` flag needed in CI.
- **`tests/e2e/` separate from any future unit-test folder (`tests/unit/`)** — different runners, different lifecycles.
- **`fixtures/` vs `helpers/`** — fixtures wire Playwright's test context; helpers are pure functions usable from any spec.
- **`selectors.ts` as a single source of truth** — when a designer renames a button, we change one constant, not 12 specs.
- **No mocks, no MSW, no test-only routes in `src/`** — the production code path has zero awareness that tests exist.

---

## 2. Test Creation Methodology — The Setup/Teardown Loop

### 2.1 Lifecycle of a single test

```
┌─────────────────────────────────────────────────────────────────┐
│  test.beforeEach()                                              │
│    1. resetSandboxSession(TEST_SESSION_ID)   ← deletes all      │
│       (service-role, scoped DELETE)             child rows      │
│    2. seedSession({ courts: 2, players: [...] })                │
│       returns { sessionId, courtIds, playerIds, organizerId }   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  test body                                                      │
│    1. await page.goto(`${BASE_URL}/organizer/${sessionId}`)     │
│    2. signInAs(ORGANIZER_BOT) via cookie injection              │
│    3. await page.click(...) interactions                        │
│    4. expect(...) assertions on UI + DB                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  test.afterEach()                                               │
│    - NO cleanup. beforeEach handles it for the next test.       │
│    - Optional: on failure, dump session state to artifacts/     │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** cleanup happens in `beforeEach`, not `afterEach`. This means if a test crashes mid-run and leaves dirty state, the *next* test still starts clean. It also means a developer can pause a test (`await page.pause()`), inspect the DB freely, and re-run without manual cleanup.

### 2.2 The `resetSandboxSession()` query — exact SQL

This is the keystone of idempotency. It runs as a single PostgreSQL transaction via the service-role client:

```sql
BEGIN;

-- Hard sanity check: refuse to run if the session isn't the sandbox.
DO $$
BEGIN
  IF (SELECT name FROM sessions WHERE id = $1) NOT LIKE '🤖 E2E SANDBOX%'
  THEN RAISE EXCEPTION 'Refusing to wipe non-sandbox session %', $1;
  END IF;
END $$;

-- Order matters: leaf tables first, then parents, but never the session row itself.
DELETE FROM match_players  WHERE match_id IN (SELECT id FROM matches WHERE session_id = $1);
DELETE FROM matches        WHERE session_id = $1;
DELETE FROM queue_entries  WHERE session_id = $1;
DELETE FROM courts         WHERE session_id = $1;

-- Bot profiles: identified by display_name prefix. Removed so the next
-- test's seed can recreate them with fresh skill levels / PINs.
DELETE FROM auth.users
  WHERE id IN (
    SELECT id FROM profiles WHERE display_name LIKE 'E2E_%'
  );
-- profiles row cascades via the auth.users → profiles.id FK ON DELETE CASCADE.

-- Reset the session itself to a known-good state (in case a previous
-- test toggled is_auto_matchmaking_on or marked it inactive).
UPDATE sessions
   SET is_active = true,
       is_auto_matchmaking_on = false,
       ended_at = null
 WHERE id = $1;

COMMIT;
```

**What we do NOT delete:**
- The sandbox `sessions` row itself (would invalidate `TEST_SESSION_ID`).
- The fixed organizer bot account (re-signing in costs ~400 ms per test).
- Any row from any other `session_id` — physically impossible because every DELETE is filtered.

**Performance budget:** this transaction runs in <150 ms on an empty session, ~400 ms on a fully-seeded one. Cheap enough to run before every test.

### 2.3 The `seedSession()` helper

A builder that returns a typed handle for the test body to reference:

```
seedSession({
  courts: 2,
  players: [
    { name: "Alice", skill: "intermediate" },
    { name: "Bob",   skill: "intermediate" },
    { name: "Cara",  skill: "advanced" },
    { name: "Dan",   skill: "advanced" },
  ],
  queue: "all_waiting",        // or "first_match_on_deck", "first_match_in_progress"
})
→ { sessionId, courtIds: [c1, c2], players: { alice, bob, cara, dan }, organizerId }
```

Internally it uses the service-role client to write rows directly — bypassing UI and server actions. This is correct: we are setting up *preconditions*, not testing them.

### 2.4 Authentication — programmatic, never via the UI

Logging in through the form on every test would add 3+ seconds per test and flake on the 4-digit PIN field. Instead:

1. `auth.ts` calls `supabaseAdmin.auth.admin.createUser({ email_confirm: true })` for each persona.
2. `supabaseAdmin.auth.admin.generateLink({ type: 'magiclink' })` produces a session token.
3. The token is injected into Playwright's browser context as a cookie before `page.goto()`.
4. The first request to the Next.js app already carries an authenticated session cookie.

The login form itself gets exactly **one** dedicated test (Scenario E covers the PIN reconnect path) — that's enough to catch regressions without paying the cost on every spec.

---

## 3. Scenario Selection Criteria — The 80/20 Rule

### 3.1 What deserves an E2E test

A feature is E2E-worthy if **all four** are true:

1. **It crosses a process boundary.** UI → server action → database → realtime → another UI. Any flow that's purely client-side belongs in a unit/component test, not E2E.
2. **A regression would be visible to a paying user within one game session.** Score submission failing? E2E. A button shadow being slightly off? Not E2E.
3. **Manual verification takes >2 minutes.** If a human has to set up 4 players, queue them, start a match, then check the result — automate it.
4. **There is no cheaper test that catches the same class of bug.** If a Postgres CHECK constraint already enforces it, don't write an E2E for it.

### 3.2 What we explicitly do NOT test

| Out of scope | Why |
|---|---|
| Pixel-perfect CSS, hover states, focus rings | Brittle; design changes weekly. Use Storybook/Chromatic if visual regression matters. |
| Animations, transitions, exact timing of toasts | Non-deterministic across machines. Test the *outcome* (toast appears + correct text), not the duration. |
| Dark mode rendering | Theme switching is a CSS variable swap; one Playwright snapshot would not catch real bugs. |
| Mobile responsive breakpoints | Use Playwright's `devices['iPhone 13']` only for the *one* mobile-specific flow (player joining via QR). Don't re-run every spec on every viewport. |
| Realtime latency / load testing | Different tool entirely (k6 or Artillery). |
| Form validation messages character-for-character | Test that `required` is enforced; don't assert "Please enter your name." Copy changes faster than tests. |
| Third-party flows (web push, service worker) | Browsers behave differently. Test the server action emits the right payload; trust the platform from there. |
| Anything an organizer can fix in 30 seconds (e.g. typo on a label) | Cost of writing the test exceeds cost of the bug. |

### 3.3 Heuristic for adding new scenarios

Before writing a new spec, ask: *"If this test breaks at 2 AM, will I be glad it woke me up?"* If the answer is no, it doesn't belong in the suite.

Target suite size: **8–12 specs total**, full run under 90 seconds.

---

## 4. The Core Test Scenarios

### Scenario A — Tap-to-Swap Flow

> **The high-stakes test.** The newest feature, with the most concurrent-write surface area.

| | |
|---|---|
| **Objective** | Organizer replaces a paused player on an on-deck match with a waiting player; both queue entries flip status correctly; outgoing player's mobile dashboard updates within 2s via realtime. |
| **Initial State** | • 2 courts (`Court 1` available, `Court 2` in_use)<br>• 5 bot players: `Alice` (intermediate), `Bob` (intermediate), `Cara` (intermediate), `Dan` (intermediate), `Eve` (intermediate)<br>• Alice/Bob/Cara/Dan in an on-deck match (status `pending`); Eve in queue (`waiting`)<br>• Organizer bot signed in to `/organizer/{sessionId}` |
| **Steps** | 1. `page.click('[data-testid="player-pill-alice"]')` on the on-deck card → SwapSheet opens<br>2. `expect(swapSheet).toBeVisible()`<br>3. `page.click('[data-testid="swap-candidate-eve"]')` → confirm button enables<br>4. `page.click('[data-testid="swap-confirm"]')` → sheet closes, sonner toast appears |
| **UI Assertions** | • Toast `"Swap complete"` visible within 1s<br>• "Undo" action button on toast<br>• On-deck card now shows Eve, not Alice<br>• No skill mismatch banner (all 4 players are `intermediate`) |
| **DB Assertions** (via service-role client) | • `match_players` row: Alice removed, Eve inserted (same `team`)<br>• `queue_entries.status` for Eve = `on_deck`<br>• `queue_entries.status` for Alice = `waiting`<br>• `matches.is_mixed_level` = `false` |
| **Negative branch** (separate `test()`) | Open SwapSheet → simulate `MATCH_STARTED` by directly setting `matches.status = 'in_progress'` via service client → click confirm → sheet auto-dismisses, toast says match has started |

---

### Scenario B — Match Promotion (On-Deck → Active Court)

| | |
|---|---|
| **Objective** | When a court frees up (a match completes), the next on-deck match auto-promotes to that court; queue entries flip from `on_deck` → `playing`; on-deck panel re-renders without the promoted card. |
| **Initial State** | • 1 court (`Court 1` in_use with an active match A–B vs C–D, all intermediate)<br>• 4 more players (E, F, G, H) in an on-deck match (`pending`, sort_order 1)<br>• Organizer bot on dashboard, `is_auto_matchmaking_on = true` |
| **Steps** | 1. Organizer clicks `[data-testid="court-1-input-score"]` → ScoreModal opens<br>2. Type `21` and `15`, click submit<br>3. Wait for the realtime ripple (`waitForRealtimeUpdate({ table: 'matches' })`) |
| **UI Assertions** | • Court 1 card now shows E/F vs G/H<br>• On-deck panel is empty (or shows the next pending match if any)<br>• Match history has the completed A–B vs C–D row with score 21–15 |
| **DB Assertions** | • Old match `status` = `completed`, scores persisted<br>• Promoted match `status` = `in_progress`, `court_id` = `Court 1`<br>• `queue_entries`: A,B,C,D status = `waiting` (back in queue, +1 games_played); E,F,G,H status = `playing` |
| **Why critical** | This is the heartbeat of the app. If promotion breaks, the entire flow stalls and the organizer must manually intervene every 15 minutes. |

---

### Scenario C — Queue Management (Cancel Match → Players Return to Waitlist)

| | |
|---|---|
| **Objective** | Organizer cancels an in-progress match (e.g. injury); all 4 players return to `waiting` without a `games_played` increment; the court returns to `available`. |
| **Initial State** | • 1 court in_use, 1 active match with 4 players, each with `games_played = 2`<br>• 2 players in queue (`waiting`)<br>• Organizer on dashboard |
| **Steps** | 1. Click `[data-testid="court-1-cancel"]` → confirmation AlertDialog opens<br>2. Click confirm |
| **UI Assertions** | • Court 1 reverts to "Available" state<br>• The 4 players appear in the queue table<br>• Match appears in history with a `Cancelled` badge, no scores |
| **DB Assertions** | • `matches.status` = `cancelled`<br>• `match_players` rows preserved (for history reference)<br>• All 4 `queue_entries.status` = `waiting`, `games_played` UNCHANGED (still 2)<br>• `courts.status` = `available` |
| **Negative branch** | Cancel a `pending` (on-deck) match — should also work, players return to `waiting`, but no court state change since none was assigned. |

---

### Scenario D — Player Self-Scoring (Mobile Player Submits Score)

> **Critical because this is the only flow where a non-organizer writes to `matches`.** Highest data-integrity stakes.

| | |
|---|---|
| **Objective** | A player on their phone submits a score for their own in-progress match; the organizer dashboard updates within 2s; the match completes and the next on-deck match promotes. |
| **Initial State** | • 1 court in_use, active match with bot players Alice/Bob vs Cara/Dan<br>• 4 more players in an on-deck match<br>• Two browser contexts: organizer on `/organizer/{sid}`, Alice on `/play/{sid}` |
| **Steps** | 1. In Alice's context: click `[data-testid="submit-score"]` on My Status card<br>2. Enter scores 21 / 18, submit<br>3. Switch to organizer context — DO NOT navigate, just `await expect(...)` |
| **UI Assertions (Alice)** | • Score modal closes, "Match complete" confirmation shown<br>• Alice's status returns to "Waiting in queue" |
| **UI Assertions (Organizer)** | • Within 2s of Alice's submit: Court 1 shows the next match (E/F vs G/H)<br>• Match history shows the 21–18 result<br>• No manual refresh of the organizer page |
| **DB Assertions** | • `matches.status` = `completed`, `score_a = 21`, `score_b = 18`<br>• Promoted match `status` = `in_progress`<br>• `games_played` incremented for all 4 original players |
| **Why critical** | Player-side score submission is the most likely place for a duplicate-submission bug or a race with the organizer hitting "Input Score" simultaneously. The newly-deployed `.single()` → array-check fix lives in this exact code path. |

---

### Scenario E — PIN Reconnect After Browser Close

| | |
|---|---|
| **Objective** | A player who closes their browser tab can re-enter their identity using `name + 4-digit PIN` and resume their queue position with no data loss. |
| **Initial State** | • 1 player (`Alice`, PIN `1234`) signed in, in queue position 3<br>• Alice's browser context is then **discarded** (`context.close()`) to simulate closing the tab |
| **Steps** | 1. Open a fresh browser context (no cookies)<br>2. Navigate to `/play`<br>3. Click "Already played here? Reconnect"<br>4. Type `Alice`, `1234`, submit |
| **UI Assertions** | • Redirected to `/play/{sessionId}` automatically<br>• Queue position 3 displayed<br>• `games_played` count unchanged |
| **DB Assertions** | • A new `auth.users` row was NOT created (reconnect found existing profile)<br>• `queue_entries.player_id` still points to Alice's original profile<br>• `profiles.id` unchanged |
| **Why critical** | Anonymous auth + PIN reconnect is the trickiest auth flow in the app. A regression here means players lose their queue position when their phone screen locks — the worst possible courtside experience. |

---

## 5. Configuration & CI

### 5.1 `playwright.config.ts` (high-level shape, not implemented yet)

- `baseURL`: `process.env.BASE_URL` (Vercel production URL)
- `testDir`: `tests/e2e`
- `fullyParallel: false` — all specs share one `TEST_SESSION_ID`, so they must run sequentially. (Future: provision N sandbox sessions and shard.)
- `workers: 1` for the same reason
- `retries: 2` on CI, `0` locally — flake is signal in dev, noise in CI
- `use.trace: 'retain-on-failure'` — full Playwright trace artifacts when something breaks
- One project for desktop Chromium; one project tagged `@mobile` for Scenario E only

### 5.2 GitHub Actions trigger

Run on Vercel's "Deployment Ready" webhook, NOT on every PR push. We want to test the deployed bundle, not a hypothetical local build. The webhook hits a `repository_dispatch` event that runs the workflow with `BASE_URL` set to the freshly-deployed URL.

### 5.3 Required secrets

```
TEST_SESSION_ID                 — UUID of the sandbox session
SUPABASE_SERVICE_ROLE_KEY       — for the admin client
NEXT_PUBLIC_SUPABASE_URL        — to talk to the Supabase project
TEST_ORGANIZER_USER_ID          — UUID of the organizer bot (created once, reused forever)
```

### 5.4 Sandbox session bootstrap (one-time, manual)

Before the first CI run, an organizer manually creates the sandbox session in the dashboard with the literal name `🤖 E2E SANDBOX — DO NOT JOIN`. Its UUID becomes `TEST_SESSION_ID`. This row is sacred: it's the only thing the cleanup script *won't* delete.

---

## 6. What This Strategy Buys Us

| Pain we're solving | How this approach solves it |
|---|---|
| "Works on my machine" | There is no "my machine." Tests run against the same URL real users hit. |
| Flaky local Postgres seeding | No local Postgres. The sandbox session is the seed. |
| Test data polluting analytics | All bot rows are `LIKE 'E2E_%'` — one filter excludes them everywhere. |
| Slow CI (rebuild + spin up) | No build step. Tests start running the moment the Vercel deploy goes live. |
| Realtime tests don't work in jsdom | We use a real browser hitting real WebSockets. |

## 7. What This Strategy Costs

Honest tradeoffs — not glossing over them:

| Cost | Mitigation |
|---|---|
| Tests share one sandbox session → must run serially | Acceptable at our scale (~10 specs, <90s). Revisit if suite grows past 30. |
| Service-role key is a production secret | Rotate quarterly; restrict GitHub Actions to a single repo environment with branch protection. |
| Vercel deploy must succeed before tests run | This is a feature, not a bug — broken builds skip testing entirely. |
| Sandbox session row could be accidentally deleted by an organizer | Add a Supabase RLS policy: `DELETE FROM sessions WHERE name LIKE '🤖%'` returns 403. (One-line migration.) |

---

## 8. Open Questions for Approval

1. **Sandbox location** — same Supabase project as production, or a dedicated `staging` project? (Recommendation: same project; the cleanup guards make it safe and the realism is worth it.)
2. **Bot persona names** — `Alice/Bob/Cara/Dan/Eve` for clarity, or UUID-suffixed `E2E_a47f...` for production hygiene? (Recommendation: human-readable, prefixed with `E2E_` in `display_name`. Easy to grep, easy to ignore.)
3. **CI cadence** — every Vercel deploy, or only on main-branch deploys? (Recommendation: only main. PR previews don't justify the test-time cost.)
4. **Failure response** — should a failed E2E auto-rollback the Vercel deploy via API, or just notify Slack? (Recommendation: notify only for the first month; revisit auto-rollback once we trust the suite's signal.)

---

## 9. Approval Checklist

Before any Playwright code is written, please confirm:

- [ ] Scenarios A–E cover the right ground (any scenarios to add/remove?)
- [ ] The "do not test" list in §3.2 matches your priorities
- [ ] Sandbox session lives in the production Supabase project (vs. staging)
- [ ] We're OK paying the cost of running tests serially
- [ ] One-time sandbox bootstrap (manual organizer-created session) is acceptable
- [ ] CI triggers only on main-branch Vercel deploys

Once approved, I'll generate the Playwright code in this order:
1. `tests/helpers/supabase-admin.ts` + `teardown.ts` (the safety-critical core)
2. `playwright.config.ts` + `tests/fixtures/test-base.ts`
3. Scenario A (Tap-to-Swap) end-to-end as the reference implementation
4. Scenarios B–E following the same pattern
5. GitHub Actions workflow last (after the suite is green locally)
