# Architecture Quick Reference

> Durable reference extracted from `MEMORY.md` on 2026-08-19. This is **not** session state —
> it is the standing description of the stack, schema, patterns, engine, test conventions and
> gotchas. `APP_MANIFEST.md` is the long-form version; this is the index you can hold in your
> head. If a statement here disagrees with `src/types/database.ts`, the type file wins.

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
v_recent_pairings           — ⚠️ UNUSED BY ENGINE — still in DB, but deriveOverlapMap now projects the
                              per-slot session match snapshot with team-aware weighting (no DB hop at
                              all). Safe to drop in a future migration.
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
| `fix_record_swap_player(p_match_id, p_out_player_id, p_in_player_id, p_session_id, p_actor_id, p_actor_name)` | Historical roster correction — team flip (swap team columns) or full replacement (DELETE+INSERT). Adjusts `queue_entries.games_played`, `player_partnerships`, `is_mixed_level`, `origin`. ✅ Live on prod (verified 2026-08-11); the two `p_actor_*` params came later, via `20260617000000`. |

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
Topic: `"session-events:{sessionId}"` — no `realtime:` prefix; it must equal the client's channel name
exactly (see §3.27). Event types:

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

`derivePairCounts(snapshot)` — **pure**, derived once per `runAlgorithm` invocation from the per-slot snapshot (zero DB cost). Counts same-team pairings across `completed`, `in_progress`, **and `pending` (including unpublished drafts)**. Cap applies at draft creation, not publish. `MAX_PARTNERSHIP_REPEATS = 2` — no waivers, no Red Zone bypass.

_(The async `fetchPartnershipCounts` still exists but is no longer the engine's — it is the organizer repeat-pairing badge's helper alone, and it fails **soft** there on purpose.)_

`snakeDraft()` / `rotatedDraft()` return **`null`** when cap blocks all splits. All callers must null-guard.

### Anti-Repeat / Diversity Logic

> ⚠️ **Superseded 2026-08-04.** All three helpers below were merged into ONE per-slot
> `fetchSessionMatchSnapshot` + three pure derivations. See the 2026-08-04 entry at the top of this
> file and APP_MANIFEST §"Session match snapshot". Current shape:

- `fetchSessionMatchSnapshot(db, sessionId)` — the only async read. Per slot, concurrent with `fetchActivePool`. 2 queries (`matches` IDs → `match_players` rosters; step 2 skipped when step 1 is empty). Ordering is SQL-side (`created_at DESC, id DESC` — the `id` tiebreak is load-bearing: a burst writes one `created_at` for all its rows). **Fails closed** past `SESSION_MATCH_SNAPSHOT_CEILING` (200) or on error → engine breaks the burst.
- `deriveOverlapMap(snapshot, anchorId)` — pure, per-tick, anchor-specific. **Does NOT use `v_recent_pairings`.** Teammate = opponent = 2× (equalised in the 2026-07 diversity pass; the old 2×/1× note below was correct only pre-2026-07).
- `deriveRecentRosters(snapshot)` — pure. Because the snapshot is re-read **per slot** (not once per run), sibling drafts from earlier slots of the same burst are visible.
- `derivePairCounts(snapshot)` — pure, `{ partnershipCounts, opponentCounts }`.
- `isDiversityViolation(playerIds, recentRosters)` — flags if ≥3 of 4 proposed players appeared in any single recent match.
- `getEffectiveLookback(eligiblePoolSize)` — scales lookback to pool size (≤5→2, ≤9→3, ≤15→4, 16+→**7**).

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
3. PER SLOT: fetchSessionMatchSnapshot, concurrent with fetchActivePool
     (completed + in_progress + pending). !ok → BREAK the burst — never fall through
     to empty history, or every repeat reads as a fresh pairing.
4. For each slot in [0, slotsAvailable):
   a. Pool diversity cap (slots 1+): skip if estimatedWaiting < PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK
   b. runAlgorithm(anchor):
        i.  derivePairCounts(snapshot) — pure, once per runAlgorithm
        ii. deriveOverlapMap(snapshot, anchor) — pure, team-aware, per-tick
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
                       #   promoteOnDeckMatchInternal (diversity reads live in lib/matchmaking-db.ts)
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
5. **The diversity derivations are pure but live in `matchmaking-db.ts`** — `deriveRecentRosters` / `derivePairCounts` / `deriveOverlapMap` take no client, but sit beside `fetchSessionMatchSnapshot` because the snapshot shape is theirs. The snapshot **fails closed**: on `{ ok: false }` the engine breaks the burst. Never substitute an empty snapshot.
6. **Snapshot re-read per slot; `overlapMap` per-anchor** — the per-slot cadence is what makes sibling drafts from earlier slots of the same burst visible; `overlapMap` is per-anchor and must be derived per-tick.
7. **`v_recent_pairings` is dead** — view exists in DB but is not queried. `deriveOverlapMap` projects the snapshot instead.
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
29. **Registration must stay PIN-blind** — `signInAnonymously` may never branch its reply on whether a submitted PIN matches. It is unauthenticated and unthrottled, so any distinguishable message is a free oracle over the 9,000-value space and bypasses the `reconnectPlayer` limiter entirely. Every "name exists" arm returns the same `NAME_TAKEN_MESSAGE`. See APP_MANIFEST §3.8b intro + `tests/unit/registration-pin-oracle.test.ts`.
30. **Never add a GLOBAL rate-limit arm to reconnect** — a scope-wide counter is a platform-wide kill switch on login (reconnect _is_ the account for anonymous-auth players). ~30 enumerable names across ~5 IPs holds it open indefinitely. Denial arms must have a bounded blast radius (per-name, per-IP). The spray counter is advisory/log-only on purpose — migration `20260721230000` exists solely to undo that mistake.
31. **Limiter gates count BEFORE inserting** — recording a _blocked_ attempt makes the window self-feeding, i.e. a permanent lockout of a named victim. Both `*_record_and_check` functions return `attempt_id = NULL` on the over-limit path; callers must return before using it.
32. **`co_organizer_join_attempts` is two-scoped** — despite the name it also logs `scope='reconnect'`. Every count MUST filter `scope`, or one flow burns the other's budget.
33. **DB is AHEAD of `main` on the reconnect limiter (until this branch merges)** — prod's `reconnect_record_and_check` takes `p_spray_alert_at`. Any build from `38080f5`/`c5669e0` (a promoted preview, or a rollback past `7c9c6bc`) sends `p_global_max` → PGRST202 → the fail-closed gate denies **100% of reconnects platform-wide**. Do not roll the app back past `7c9c6bc` without also reverting the DB. Same class as `20260721190000` (revoking a grant out from under live code took Leave Session down).
