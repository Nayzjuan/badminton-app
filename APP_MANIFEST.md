# APP_MANIFEST.md — Badminton Queue & Matchmaking App

### The Living Document · Principal Tech Lead Reference

---

## ⚠️ AI INSTRUCTIONS: ALWAYS KEEP THIS UPDATED

> **Any AI assistant working in this codebase MUST update this document whenever:**
>
> - A feature is added, changed, or removed
> - A database table, column, or enum is altered
> - A new Server Action, RPC, or route is created
> - A design rule or UX convention changes
> - A constant in `src/lib/constants.ts` is modified
> - A new test file is added
>
> **Update the relevant section in-place. Do not append a changelog at the bottom. This document reflects the current state of the system at all times.**

---

## 1. Core Architecture & Tech Stack

| Layer              | Tool                                | Notes                                                                                                                                                                                       |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework          | **Next.js 16 App Router**           | Breaking changes vs. earlier versions — read `node_modules/next/dist/docs/` before using any Next API. Server Components by default; add `"use client"` only at the boundary that needs it. |
| Database           | **Supabase** (Postgres + Realtime)  | Anonymous auth flow. Service-role client bypasses RLS — use only inside Server Actions.                                                                                                     |
| Auth               | `@supabase/ssr`                     | Cookie: `sb-{projectRef}-auth-token`, chunked at 3180 chars as `.0`, `.1`, etc.                                                                                                             |
| Input Validation   | **Zod**                             | Auth schemas in `src/lib/schemas/auth.ts`. UUID guards in `src/lib/validate.ts`.                                                                                                            |
| UI Primitives      | **Shadcn UI**                       | Radix-based: Dialog, AlertDialog, Sheet, DropdownMenu, etc.                                                                                                                                 |
| Styling            | **Tailwind CSS v4**                 | CSS-variable token system in `globals.css`. No `tailwind.config.js` — config is inline via `@theme`.                                                                                        |
| Drag & Drop        | **dnd-kit**                         | Strict isolation rules — see §6 Architectural Patterns.                                                                                                                                     |
| Toasts             | **Sonner**                          | Wired to Space Grotesk via `--font-sans` token so toasts match the app font.                                                                                                                |
| Font               | **Space Grotesk** (via `next/font`) | OpenType features: `cv01` (single-story a), `cv02` (single-story g).                                                                                                                        |
| Push Notifications | **Web Push / VAPID**                | `src/lib/notifications/push-client.ts` + `src/app/actions/notifications.ts`. VAPID keys required in env.                                                                                    |
| PWA                | **Serwist** (service worker)        | `src/components/serwist-register.tsx`. Offline fallback at `/offline`.                                                                                                                      |
| Unit Tests         | **Vitest ^4.1.4**                   | Pure-logic only in `tests/unit/`. No DB, no network.                                                                                                                                        |
| E2E Tests          | **Playwright ^1.59.1**              | Zero-local — runs against live Vercel deployment. Bypass header: `x-vercel-protection-bypass`.                                                                                              |
| Package Manager    | **npm**                             |                                                                                                                                                                                             |
| Deployment         | **Vercel**                          |                                                                                                                                                                                             |

### Supabase Client Variants

```ts
// RLS-respecting — use for auth lookups and player-facing reads
createBrowserSupabaseClient(); // client components
createServerSupabaseClient(); // server components / actions

// Bypasses RLS — use only for cross-user mutations in server actions
createServiceClient(); // uses service role key
```

**Rule:** `supabase` (RLS client) is used only for `getUser()` and `isSessionOrganizer()` checks. All `.from(...)` reads and writes inside mutations use `db` (service client).

### Broadcast System

`src/lib/broadcast.ts` — Server-side REST broadcast helpers (no WebSocket opened from the server). Sends ephemeral messages to topic `"realtime:session-events:{sessionId}"`. Event types:

- `organizer_intervention` — `{ type: "on_deck_cleared" | "match_cancelled", affectedPlayerIds }` → triggers player-side toast via `useOrganizerBroadcast`.
- `session_closed` — redirects all connected players to `/wrapped/{sessionId}/{playerId}`.
- `auto_matchmaking_toggled` — `{ isOn: boolean }` → syncs auto-matchmaking state to all co-organizers (bypasses the sessions RLS SELECT policy that would silently drop postgres_changes for non-creator organizers).
- `auto_publish_toggled` — `{ isOn: boolean }` → syncs auto-publish mode state to all co-organizers (same RLS-bypass rationale). Handled in `use-organizer-session.ts`; `auto_publish` is also excluded from the postgres_changes apply so it never double-syncs.
- `cap_saturation` — `{ affectedPlayerIds, reason }` → fires when `MAX_PARTNERSHIP_REPEATS` blocks every possible team split. Surfaces a `CapSaturationNotice` banner in the on-deck panel so the organizer knows to intervene manually.
- `draft_cap_phase` — `{ phase: "clearing" | "generating" | "done", cap }` → drives the synchronized dashboard lockout overlay during a cap-change reset.

### Realtime Subscription Auth (JWT-before-join)

Supabase Realtime binds a channel's `postgres_changes` RLS row-filter to the socket's JWT **at channel-join time** — a later `setAuth()` does **not** re-bind an already-joined channel. `@supabase/ssr` hydrates a persisted cookie session asynchronously (the `INITIAL_SESSION` auth event), which fires _after_ hook effects synchronously call `.subscribe()`. So without care, channels join under the `anon` Postgres role; under the club-scoped RLS on `sessions` / `queue_entries` / `matches` / `match_players` / `courts` (`is_session_club_member` / `is_session_organizer`), `anon` matches zero rows and **no realtime events are ever delivered** — e.g. a drafted player's "Match Forming" card never flips to on-deck until a manual refresh (was e2e scenario-j J-B/J-C).

**Fix (`src/utils/supabase/client.ts` + `src/lib/realtime.ts`):**

- `createBrowserSupabaseClient()` eagerly runs `getSession() → realtime.setAuth(access_token)` on first call and exposes the resulting promise via **`whenRealtimeAuthReady()`**; it also re-`setAuth`s on every later auth transition (SIGNED_IN / TOKEN_REFRESHED / INITIAL_SESSION).
- Every `postgres_changes` subscribe helper — `subscribeToTable` (courts/queue/matches), `subscribeToMatchPlayers`, `subscribeToProfiles` — and the organizer `session-settings` channel in `use-organizer-session.ts` **defer `.subscribe()` behind `whenRealtimeAuthReady()`**, guaranteeing the JWT is set before join. Cleanup uses a `cancelled` flag + null-guarded `removeChannel`, so an unmount before the deferred join leaks nothing (StrictMode-safe).
- The Broadcast channel (`subscribeToOrganizerBroadcast`) is intentionally **not** deferred — broadcast delivery has no `postgres_changes` RLS and needs no JWT-before-join.

### Shared Server Action Helpers

**File:** `src/app/actions/_shared.ts`

Two helpers used by all organizer-gated server actions to avoid reimplementing the same auth/organizer checks:

- **`getAuthenticatedUser()`** — thin wrapper around `auth.getUser()`; all server actions that need auth call this instead of instantiating their own server client.
- **`isSessionOrganizer(userId, sessionId)`** — two-path organizer check: fast-path via `sessions.created_by` equality, then fallback lookup in `session_organizers`; used by all organizer-gated actions.

`getAuthenticatedUser` uses the user-context server client (`createServerSupabaseClient`) because `auth.getUser()` is always user-scoped. `isSessionOrganizer` uses the service-role client (`createServiceClient`) so the primary organizer is never blocked by read-side RLS on `sessions` or `session_organizers`.

---

## 2. Database Schema & State

### Tables

#### `profiles`

Mirrors `auth.users` 1:1 — the UUID is the `auth.users.id`.

| Column         | Type               | Notes                                                                           |
| -------------- | ------------------ | ------------------------------------------------------------------------------- |
| `id`           | `uuid` PK          | = `auth.users.id` — never auto-generate                                         |
| `display_name` | `text`             | Player name shown everywhere                                                    |
| `skill_level`  | `skill_level` enum | See enum table below                                                            |
| `pin`          | `text \| null`     | 4-digit reconnect PIN                                                           |
| `vip_tag`      | `text \| null`     | Short label shown as badge (e.g. "MVP"). Set via Supabase dashboard only.       |
| `vip_theme`    | `text \| null`     | Key into `VIP_THEMES` in `src/lib/vip-config.ts`. Controls neon/holo rendering. |
| `needs_rename`  | `boolean`          | Duplicate-name flag — must rename at next login/join (§3.8b). Default `false`.   |
| `collided_name` | `text \| null`     | The name this profile was flagged on (R1 source of truth). `null` when not flagged. |
| `flagged_at`    | `timestamptz \| null` | When the duplicate flag was set.                                              |
| `created_at`   | `timestamptz`      |                                                                                 |
| `updated_at`   | `timestamptz`      |                                                                                 |

Partial UNIQUE index `idx_profiles_unique_active_name` on `lower(btrim(regexp_replace(display_name,E'[ \t]+',' ','g'))) WHERE needs_rename = false` enforces global name uniqueness for non-flagged profiles (§3.8b). Audit table **`player_renames`** (`id, player_id, old_name, new_name, reason, actor_user_id, session_id, created_at`) is an append-only log of every name change.

**Trigger:** `on_auth_user_created` → `handle_new_user()` — auto-creates a profile row from `raw_user_meta_data.display_name` and `raw_user_meta_data.skill_level` when a new auth user is inserted.

#### `sessions`

| Column                     | Type                  | Notes                                                                          |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `id`                       | `uuid` PK             |                                                                                |
| `name`                     | `text`                | Display name of the session                                                    |
| `created_by`               | `uuid → profiles.id`  | Primary organizer                                                              |
| `organizer_passcode`       | `text \| null`        | Passcode for additional organizers to elevate via `elevate_to_organizer()` RPC |
| `scoring`                  | `scoring_format` enum | `single` \| `best_of_3` \| `best_of_5`                                         |
| `is_active`                | `bool`                | `false` when session is closed                                                 |
| `is_auto_matchmaking_on`   | `bool`                | Engine toggle — auto-fills on-deck when `true`                                 |
| `max_auto_drafts_override` | `int \| null`         | Organizer cap on the auto-draft queue. `null` = dynamic (3/5/6 by pool size); 1–5 = ceiling. In auto-publish mode this caps the published On-Deck queue instead. |
| `auto_publish`             | `bool`                | **Auto-publish mode** (migration `20260623000000`). `false` (default) = engine writes drafts (`is_published=false`) for organizer review. `true` = engine writes matches straight to On Deck (`is_published=true`), skipping the publish gate. |
| `court_time_limit_minutes` | `int \| null`         | Per-court time cap; `null` = unlimited                                         |
| `created_at`               | `timestamptz`         |                                                                                |
| `ended_at`                 | `timestamptz \| null` | Set when session is closed                                                     |

**Trigger:** `on_session_created` → `handle_new_session()` — auto-inserts a `session_organizers` row for `created_by`.

#### `session_organizers`

Append-only access-control table. Never DELETE or UPDATE rows — presence of a row = permission granted.

| Column       | Type                 |
| ------------ | -------------------- |
| `id`         | `uuid` PK            |
| `session_id` | `uuid → sessions.id` |
| `user_id`    | `uuid → profiles.id` |
| `granted_at` | `timestamptz`        |

#### `courts`

| Column       | Type                 | Notes                               |
| ------------ | -------------------- | ----------------------------------- |
| `id`         | `uuid` PK            |                                     |
| `session_id` | `uuid → sessions.id` |                                     |
| `name`       | `text`               | e.g. "Court 1"                      |
| `status`     | `court_status` enum  | `available` \| `in_use` \| `closed` |
| `created_at` | `timestamptz`        |                                     |

#### `queue_entries`

| Column         | Type                 | Notes                                                                  |
| -------------- | -------------------- | ---------------------------------------------------------------------- |
| `id`           | `uuid` PK            |                                                                        |
| `session_id`   | `uuid → sessions.id` |                                                                        |
| `player_id`    | `uuid → profiles.id` |                                                                        |
| `joined_at`    | `timestamptz`        | Queue join time — used as tiebreaker                                   |
| `games_played` | `int`                | Incremented on match completion; NOT on cancellation                   |
| `status`       | `queue_status` enum  | See enum below                                                         |
| `position`     | `int \| null`        | Display position; nullable                                             |
| `is_paused`    | `bool`               | Soft-pause: player visible in queue list but excluded from matchmaking |
| `created_at`   | `timestamptz`        |                                                                        |

#### `matches`

| Column           | Type                       | Notes                                                                                                          |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`             | `uuid` PK                  |                                                                                                                |
| `session_id`     | `uuid → sessions.id`       |                                                                                                                |
| `court_id`       | `uuid → courts.id \| null` | **`null` = on-deck (pending) match not yet assigned**                                                          |
| `status`         | `match_status` enum        | See enum below                                                                                                 |
| `team_a_score`   | `int \| null`              | Populated on completion                                                                                        |
| `team_b_score`   | `int \| null`              | Populated on completion                                                                                        |
| `is_mixed_level` | `bool`                     | `true` when skill variance > `SKILL_VARIANCE_TARGET`                                                           |
| `sort_order`     | `int \| null`              | On-deck display order                                                                                          |
| `origin`         | `match_origin` enum        | `auto` \| `manual` \| `modified` — sticky: `manual` is never demoted                                           |
| `is_published`   | `bool`                     | `false` = draft (hidden from players/TV). Auto-engine matches start as drafts. Manual matches start published. |
| `created_at`     | `timestamptz`              |                                                                                                                |
| `started_at`     | `timestamptz \| null`      | Set when promoted to active court                                                                              |
| `completed_at`   | `timestamptz \| null`      | Set on end/cancel                                                                                              |

#### `match_players`

Junction table — 4 rows per match (2 per team).

| Column      | Type                 |
| ----------- | -------------------- |
| `id`        | `uuid` PK            |
| `match_id`  | `uuid → matches.id`  |
| `player_id` | `uuid → profiles.id` |
| `team`      | `"a"` \| `"b"`       |

#### `match_games`

Multi-set scoring sub-records (used with `best_of_3` / `best_of_5`).

| Column         | Type                |
| -------------- | ------------------- |
| `id`           | `uuid` PK           |
| `match_id`     | `uuid → matches.id` |
| `game_number`  | `int`               |
| `team_a_score` | `int`               |
| `team_b_score` | `int`               |
| `completed_at` | `timestamptz`       |

#### `session_wrapped_stats`

Computed once per session per player via `compute_session_wrapped()` RPC.

| Column               | Type                  | Notes                                                              |
| -------------------- | --------------------- | ------------------------------------------------------------------ |
| `id`                 | `uuid` PK             |                                                                    |
| `session_id`         | `uuid → sessions.id`  |                                                                    |
| `player_id`          | `uuid → profiles.id`  |                                                                    |
| `computed_at`        | `timestamptz`         |                                                                    |
| `games_played`       | `int`                 |                                                                    |
| `wins`               | `int`                 |                                                                    |
| `losses`             | `int`                 |                                                                    |
| `points_for`         | `int`                 |                                                                    |
| `points_against`     | `int`                 |                                                                    |
| `point_diff`         | `int`                 | **GENERATED ALWAYS** as `points_for - points_against`              |
| `win_pct`            | `numeric`             | Stored as string-numeric (e.g. `"60.00"`)                          |
| `win_streak`         | `int`                 |                                                                    |
| `session_rank`       | `int \| null`         | Rank within the session                                            |
| `earned_awards`      | `text[]`              | Array of award slug strings                                        |
| `award_data`         | `jsonb`               | Nested metadata per award (e.g. nemesis player name, streak count) |
| `intro_dismissed_at` | `timestamptz \| null` | When the "Wrapped" intro overlay was dismissed (cross-device)      |

#### `identity_migrations`

Append-only audit log. Records every old → new UUID reconnect (anonymous re-auth).

| Column         | Type          |
| -------------- | ------------- |
| `id`           | `uuid` PK     |
| `old_id`       | `uuid`        |
| `new_id`       | `uuid`        |
| `display_name` | `text`        |
| `migrated_at`  | `timestamptz` |

#### `push_subscriptions`

| Column       | Type                 | Notes                                   |
| ------------ | -------------------- | --------------------------------------- |
| `id`         | `uuid` PK            |                                         |
| `user_id`    | `uuid → profiles.id` |                                         |
| `endpoint`   | `text`               | Browser push endpoint URL               |
| `p256dh`     | `text`               | ECDH public key (base64) — **required** |
| `auth_key`   | `text`               | HMAC auth key (base64) — **required**   |
| `user_agent` | `text \| null`       |                                         |
| `created_at` | `timestamptz`        |                                         |
| `updated_at` | `timestamptz`        |                                         |

All three of `endpoint`, `p256dh`, and `auth_key` must be non-empty or the Web Push call fails silently.

---

### Enums

| Enum             | Values                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `skill_level`    | `beginner` → `lower_intermediate` → `intermediate` → `upper_intermediate` → `lower_advanced` → `advanced` (mapped to ints 1–6) |
| `court_status`   | `available` \| `in_use` \| `closed`                                                                                            |
| `queue_status`   | `waiting` \| `drafted` \| `on_deck` \| `playing` \| `left`  (`drafted` = in an unpublished engine draft, still visible to organizer; excluded from matchmaking engine pool) |
| `match_status`   | `pending` (on-deck) \| `in_progress` (active court) \| `completed` \| `cancelled`                                              |
| `match_origin`   | `auto` \| `manual` \| `modified`                                                                                               |
| `scoring_format` | `single` \| `best_of_3` \| `best_of_5`                                                                                         |

---

### Views

| View                           | Purpose                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v_queue_with_wait_time`       | Queue entries joined with profiles; computes `wait_minutes`, `is_bottleneck`, `skill_level_int`. **Filters to `status = 'waiting'` only** — this is the engine's input view and must never include non-waiting rows. |
| `v_queue_full_with_wait_time`  | Same as above but includes `status IN ('waiting', 'drafted', 'on_deck')`. Used by the **organizer queue panel** and **player waitlist** (drafted excluded on player side). Adds `status_priority` column (on_deck=0, drafted=1, waiting=2) for PostgREST ordering. Migration: `20260520000000`. |
| `v_match_history`              | Matches + players + scores with team arrays and `game_scores` JSON                                                                                                                                                  |
| `v_recent_pairings`            | Recent co-player pairs per player; **no longer used by `buildOverlapMap`** (replaced by 3-step manual join with team-aware weighting in `matchmaking.ts`; view still exists in DB but is not queried by the engine) |
| `v_session_leaderboard`        | Per-session GP, W, L, Win%, PF, PA, +/-                                                                                                                                                                             |
| `v_alltime_leaderboard_mat`    | Materialized all-time leaderboard (same columns, no session filter)                                                                                                                                                 |

---

### Postgres Functions (RPCs)

| Function                                                | Purpose                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elevate_to_organizer(p_session_id, p_passcode)`        | Passcode-gated organizer promotion → inserts `session_organizers` row                                                                                                                                                                                                                                                                |
| `rejoin_queue(p_session_id)`                            | Player self-rejoin after leaving                                                                                                                                                                                                                                                                                                     |
| `skill_level_to_int(lvl)`                               | Enum → numeric (1–6)                                                                                                                                                                                                                                                                                                                 |
| `get_player_streaks(p_session_id?)`                     | Win-streak per player for current session or all-time                                                                                                                                                                                                                                                                                |
| `get_alltime_snapshot_before(p_cutoff)`                 | All-time stats as of a timestamp                                                                                                                                                                                                                                                                                                     |
| `get_monthly_leaderboard(p_year, p_month)`              | **Monthly board** (migration `20260626000000`). Live aggregation of one Manila-month slice of completed matches off base tables. `SECURITY INVOKER`, public-read. Boundary anchored in `Asia/Manila` via `make_timestamptz`; sargable `completed_at` range on `idx_matches_completed_at`.                                              |
| `get_leaderboard_months()`                              | Months for the monthly picker — distinct Manila-months with completed matches + the current month (always present), newest first. `SECURITY INVOKER`, public-read.                                                                                                                                                                    |
| `refresh_alltime_leaderboard()`                         | Refreshes the materialized view                                                                                                                                                                                                                                                                                                      |
| `swap_player_in_match(...)`                             | Atomic bench→on-deck swap; recomputes `is_mixed_level`                                                                                                                                                                                                                                                                               |
| `swap_match_players(...)`                               | Cross-match atomic swap between two on-deck matches                                                                                                                                                                                                                                                                                  |
| `create_match_with_players(...)`                        | Atomic match + match_players insert; `RETURNS uuid`. Returns **`NULL`** (not an error) when a TOCTOU guard detects a concurrent commit — `{ data: null, error: null }` from Supabase JS = graceful slot-skip. RPC evolution: `20260421000000` → `20260506000000` (Draft Mode `p_is_published`) → `20260507000000` (3 TOCTOU guards). |
| `compute_session_wrapped(p_session_id)`                 | Computes and upserts all `session_wrapped_stats` for a session                                                                                                                                                                                                                                                                       |
| `get_h2h_record(p_team_a, p_team_b, p_session_id)`      | Head-to-head wins for exact 2v2 team pairing (all-time + tonight)                                                                                                                                                                                                                                                                    |
| `toggle_auto_matchmaking(p_session_id)`                 | Atomic toggle; returns new boolean value                                                                                                                                                                                                                                                                                             |
| `auto_publish_match(p_match_id, p_session_id)`          | **Auto-publish mode** (migration `20260623000001`). `publish_match` minus the organizer gate — service-role-only (grants revoked from anon/authenticated, `20260623000002`). Used by `recomputeHeldReadiness` to publish a held draft the instant it becomes ready. Keeps the `HAS_LEFT_PLAYERS`/`CONFLICT` guards; sets `is_published=true` and transitions roster `drafted`/`waiting` → `on_deck`. Returns `SUCCESS` \| `HAS_LEFT_PLAYERS` \| `CONFLICT` \| `NOT_PENDING` \| `ALREADY_PUBLISHED` \| `NOT_FOUND`. |
| `migrate_player_identity(p_old_user_id, p_new_user_id)` | Reconnect identity migration; returns `true` if old user is primary organizer                                                                                                                                                                                                                                                        |
| `lookup_active_session(p_session_id)`                   | Safe public lookup for QR-code join (`/play/join`) — no RLS exposure                                                                                                                                                                                                                                                                 |
| `swap_player_in_active_match(...)`                      | Replaces one player in an `in_progress` match with a queue player; recomputes `is_mixed_level`, marks `origin='modified'`                                                                                                                                                                                                            |
| `swap_teams_in_active_match(...)`                       | Swaps team assignments of two players within the same `in_progress` match; no queue changes                                                                                                                                                                                                                                          |
| `swap_active_from_ondeck(...)`                          | Atomic 3-way: pull on-deck player into active match + fill vacated on-deck slot from queue; returns original teams as OUT params for undo                                                                                                                                                                                            |
| `undo_swap_active_from_ondeck(...)`                     | Reverses `swap_active_from_ondeck` atomically; silently no-ops if either match has advanced past its expected state                                                                                                                                                                                                                  |

---

## 3. Feature Inventory & Logic Rules

### 3.1 Matchmaking Engine

**Files:** `src/lib/matchmaking-core.ts` (pure functions), `src/app/actions/matchmaking.ts` (async/DB)

The engine is a **pure on-deck filler** — it never places players directly onto courts. Court assignment only happens via `promoteOnDeckMatchInternal` when a court frees.

#### Priority Scoring (`computePriorityScore`) — 3-Tier System

Three tiers, evaluated top-down (Hard Cap checked first):

```
Tier 3 — Hard Cap   (score ≥ 2000):
  Condition: wait ≥ HARD_WAIT_CAP_MINUTES (25)
         AND games_played < HARD_CAP_GAMES_CEILING (5)
  Score: HARD_CAP_SCORE_FLOOR + (wait − 25) × 10       [progressive — no ties]

Tier 2 — Red Zone   (score nominally 1000–1999):
  Condition: wait ≥ CRITICAL_WAIT_MINUTES (20)
  Score: 1000 + waitMinutes − (gamesPlayed × GAME_PENALTY_MINUTES)
  Note: heavy game debt can push score below 1000; downstream consumers
        re-detect Red Zone via priorityScore ≥ RED_ZONE_SCORE_FLOOR check.

Tier 1 — Normal     (score unbounded below 1000):
  Score: waitMinutes − (gamesPlayed × GAME_PENALTY_MINUTES)   [no floor — can go negative]
```

**Design rationale:**
- Hard Cap guarantees service within `hardCap + maxCourtDuration ≈ 25 + 22 = 47 min` for any player below the session game target. Progressive scoring (`+10 per extra minute`) eliminates flat-score ties, so the longest-waiting cap-eligible player always leads without a separate tiebreaker.
- `HARD_CAP_GAMES_CEILING = 5` (= session target for all tested configs) prevents players who've already received their fair share from using the override to accumulate extra games at the expense of under-served players.
- Red Zone fires 5 min before the Hard Cap (20 vs 25), giving urgency priority over Normal-queue players in advance.
- No floor at 0 — negative scores let game count drive ordering even when everyone has been waiting a similar time.

**Validated across 3 scenarios (scripts/simulate-scenarios.ts):**

| Scenario | Players / Courts / Min | Games range | Max wait |
|---|---|---|---|
| Saturday 06/06 | 31p / 3c / 240m | ±1 ✅ | 43m |
| Small session | 18p / 2c / 240m | ±1 ✅ | 43m |
| Large session | 50p / 5c / 240m | ±1 ✅ | 36m |

The 30 min max-wait target is a physics impossibility with 20–22 min courts (minimum achievable = hardCap + maxCourt = 47m). Actual 36–43m is the best achievable without sacrificing game equity.

#### Candidate Scoring (`scoreCandidates`)

```
Normal candidate:   candidateScore = -priorityScore + overlapCount × 10,000
Red Zone candidate: candidateScore = -priorityScore + overlapCount × 100
  (Red Zone = priorityScore ≥ RED_ZONE_SCORE_FLOOR — includes Hard Cap tier since 2000 ≫ 1000)
```

Sorted ascending (lowest score = highest priority). Red Zone overlap penalty is capped at 100× so a Red Zone player with 1 recent overlap still beats a Normal player with 0.

#### Group Assembly (`buildCombinationGroup`) — N-choose-3 Combination Search

Replaced the former greedy algorithm. Iterates all C(n,3) triples of scored candidates and returns the first triple where all 3 + the anchor form a valid group (`isGroupValid`). Breaks immediately — the first valid combo found IS the optimal one since candidates are pre-sorted by priority. Worst case: C(30,3) = 4,060 iterations.

#### Partnership Cap Enforcement

`fetchPartnershipCounts(supabase, sessionId)` — async DB helper in `matchmaking.ts`. Aggregates all same-team pairings across all match statuses (`completed`, `in_progress`, **and `pending` — including unpublished drafts**) for this session into a `Map<pairKey, count>`. Called once per `runAlgorithm` invocation (hoisted above anchor selection). The cap applies the moment a draft is created — not only after publish — so two concurrent draft generations cannot both claim the same pair under separate matches.

**Universal pre-filter** (runs before any skill/diversity/rotation logic): After scoring candidates, any candidate whose `pairKey(anchor, candidate)` count is already at `MAX_PARTNERSHIP_REPEATS` is removed from the pool entirely. This happens before group assembly, before skill expansion, and before the last-resort fallback — there are no waivers.

`pairKey(a, b)` — pure helper in `matchmaking-core.ts`. Returns a canonical symmetric key `"lesser-uuid:greater-uuid"` so `pairKey(a,b) === pairKey(b,a)`.

#### Team Draft (`snakeDraft` / `rotatedDraft`)

Sort all 4 players DESC by skill, then apply a **two-pass approach** for partner freshness:

- **Pass 1 (prefer fresh)**: Try splits in skill-balance order where **both team pairs have `count = 0`** (never been partners). This prevents back-to-back same-partner games even when the pair is still below the hard cap.
- **Pass 2 (fallback)**: Try splits in skill-balance order where both pairs are `< MAX_PARTNERSHIP_REPEATS`. Original behaviour; reached only when no fully-fresh split exists.

Split order (most → least skill-balanced): `[0,3] vs [1,2]` → `[0,2] vs [1,3]` → `[0,1] vs [2,3]`.

- **snakeDraft** (normal): **four-pass** — 1a: fresh partnerships + no capped cross-net pair; 1b: fresh partnerships (relax opponent cap); 2a: below partnership cap + no capped cross-net; 2b: below partnership cap (last resort). Returns **`null`** only when the partnership cap blocks every split — the opponent cap never causes a stall.
- **rotatedDraft** (forced repeat): cycles through 3 split configs based on `repeatCount % 3` starting from the natural rotation index; same four-pass structure within each rotation attempt. Also returns **`null`** when the partnership cap blocks every split.

#### Anti-Repeat / Diversity Logic

- `buildOverlapMap(anchorId)` — called per-tick (once per anchor per engine slot), anchor-specific. **No longer uses `v_recent_pairings`.** Does a 3-step manual join:
  1. Fetch all `match_players` rows for the anchor (limit 200)
  2. Filter to this session's recent matches (`completed`, `in_progress`, **`pending`** — Fix 2: sees live pairings, not just finished games)
  3. Fetch all co-players + teams → build weighted overlap map: **teammate appearances = 2×, opponent appearances = 1×** (Fix 3: same-side repetition penalised more than cross-side)
- `fetchRecentRosters(sessionId)` — fetches last `ROSTER_LOOKBACK_COUNT` (10) match rosters as arrays of player IDs. Pre-fetched **once per `runEngineInternal` run** and passed down to each `runAlgorithm` call to avoid redundant DB queries per slot. Includes `completed`, `in_progress`, and `pending` matches.
- `isDiversityViolation(playerIds, recentRosters)` — flags true if ≥3 of the proposed 4 players appeared together in any single recent match roster.
- `getEffectiveLookback(eligiblePoolSize)` — scales lookback window to pool size (≤5 → 2, ≤9 → 3, ≤15 → 4, 16+ → **7**) to prevent small-tier starvation. The 16+ tier was increased from 5 to 7 now that `fetchRecentRosters` fetches 10 matches (sufficient headroom).
- `fetchPartnershipCounts(sessionId)` — now returns **`{ partnershipCounts, opponentCounts }`** (both maps built in one pass over the same DB data; zero extra DB calls). `opponentCounts` = cross-net (opponent) pair counts, used by snakeDraft/rotatedDraft as a soft preference.

#### Engine Constants (`src/lib/constants.ts`)

| Constant                       | Value | Meaning                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAYERS_PER_MATCH`            | 4     | Doubles only — fixed                                                                                                                                                                                                                                                                                                                               |
| `SKILL_VARIANCE_TARGET`        | 1     | Preferred max skill gap                                                                                                                                                                                                                                                                                                                            |
| `SKILL_VARIANCE_MAX`           | 2     | Hard max skill gap                                                                                                                                                                                                                                                                                                                                 |
| `FALLBACK_WAIT_MINUTES`        | 15    | Bypass skill windows entirely                                                                                                                                                                                                                                                                                                                      |
| `CRITICAL_WAIT_MINUTES`        | **20**| Red Zone threshold (was 25; lowered so urgency fires sooner, narrowing the window before Hard Cap)                                                                                                                                                                                                                                                |
| `HARD_WAIT_CAP_MINUTES`        | **25**| Hard Wait Cap threshold — fires 5 min after Red Zone; triggers Tier 3 absolute-override scoring for cap-eligible players                                                                                                                                                                                                                           |
| `HARD_CAP_SCORE_FLOOR`         | **2000** | Tier 3 score floor — guaranteed above any Red Zone score (max Red Zone ≈ 1060 ≪ 2000)                                                                                                                                                                                                                                                          |
| `HARD_CAP_GAMES_CEILING`       | **5** | Max games to remain cap-eligible. Players at/above session target (5 games for all standard 4h sessions) cannot use the Tier 3 override                                                                                                                                                                                                           |
| `GAME_PENALTY_MINUTES`         | **8** | Minutes deducted per game played from priority score (calibrated to ~half average game cycle ≈ 20/2 = 10 min)                                                                                                                                                                                                                                      |
| `RED_ZONE_SCORE_FLOOR`         | 1000  | Sentinel — any score ≥ this = Red Zone (used by scoreCandidates + runAlgorithm; note heavy game debt can push a Red Zone formula result below 1000)                                                                                                                                                                                                                                                                                                             |
| `BOTTLENECK_THRESHOLD_MINUTES` | 20    | Wait-time monitor flag threshold                                                                                                                                                                                                                                                                                                                   |
| `ANTI_REPEAT_LOOKBACK`         | 5     | Recent matches used by `buildOverlapMap` for familiarity weighting (count-based)                                                                                                                                                                                                                                                                   |
| `ROSTER_LOOKBACK_COUNT`        | 10    | Recent match rosters fetched by `fetchRecentRosters` for diversity-violation checks (larger than `ANTI_REPEAT_LOOKBACK` so `getEffectiveLookback` can scale up for large sessions)                                                                                                                                                                 |
| `MIN_REST_MINUTES`             | 18    | Minimum wait minutes before a returning player (games_played > 0) can be drafted again. Prevents 0-min back-to-back. Falls back to unfiltered pool if fewer than `PLAYERS_PER_MATCH` survive the filter.                                                                                                                                           |
| `GATE_POOL_THRESHOLD`          | 4     | Pool size that triggers cross-court mixing deferral                                                                                                                                                                                                                                                                                                |
| `GATE_HOLD_MINUTES`            | 8     | Minutes before gate auto-releases                                                                                                                                                                                                                                                                                                                  |
| `MIN_FREE_POOL_FOR_ON_DECK`    | 4     | Minimum waiting players remaining after each on-deck fill (pool diversity cap, applies from 2nd slot onwards)                                                                                                                                                                                                                                      |
| `MAX_AUTO_DRAFTS`              | 3     | **Tiered draft cap — small session** (< 25 waiting players). Counts only `is_published=false` drafts. Published on-deck matches do NOT count — they are already reviewed and should not block fresh draft generation. |
| `MAX_AUTO_DRAFTS_LARGE`        | 5     | Tiered draft cap — medium session (25–29 waiting players).                                                                                                                                                          |
| `MAX_AUTO_DRAFTS_XLARGE`       | 6     | Tiered draft cap — large session (≥ 30 waiting players).                                                                                                                                                           |
| `DRAFT_CAP_LARGE_THRESHOLD`    | 25    | Waiting player count at which the cap upgrades from 3 → 5.                                                                                                                                                         |
| `DRAFT_CAP_XLARGE_THRESHOLD`   | 30    | Waiting player count at which the cap upgrades from 5 → 6.                                                                                                                                                         |
| `MAX_PARTNERSHIP_REPEATS`      | 2     | Max same-team appearances per session pair; no waivers                                                                                                                                                              |
| `MAX_OPPONENT_REPEATS`         | 3     | **Soft** cap on cross-net (opponent) appearances per session pair. Preference only — snakeDraft/rotatedDraft try to avoid it but degrade gracefully (never a stall).                                                |
| `MAX_BADMINTON_SCORE`          | 31    | Maximum valid score per game. Enforced server-side via `scoreSchema` in `src/lib/schemas/match.ts` (canonical) and client-side in `use-score-form.ts` + `use-edit-match.ts`. **Draws (equal scores) rejected at both layers** via `.refine()` on the schema and explicit `a === b` guard in hooks. |

#### Engine Capacity (`runEngineInternal`) — Dynamic Draft Cap

**`getDynamicDraftCap(waitingCount)` — exported from `src/lib/matchmaking-core.ts`** (pure function; lives in `matchmaking-core.ts` rather than `matchmaking.ts` because `"use server"` files require all exports to be `async`).

```
waitingCount   = len(v_queue_with_wait_time WHERE status='waiting')  ← fetched in same Promise.all as draftCount
dynamicCap     = getDynamicDraftCap(waitingCount)   → 3 | 5 | 6
draftCount     = COUNT(*) WHERE status='pending' AND is_published=false   ← unpublished drafts ONLY
slotsAvailable = max(0, dynamicCap − draftCount)
```

Cap tiers:

| Waiting players | Cap (`dynamicCap`) |
| --------------- | ------------------ |
| < 25            | 3                  |
| 25 – 29         | 5                  |
| ≥ 30            | 6                  |

Published on-deck matches do **not** count against the cap — they are already reviewed and calling them to courts should not prevent fresh draft generation.

| Drafts (unpublished) | slotsAvailable (small session, cap=3) |
| -------------------- | ------------------------------------- |
| 0                    | up to 3 (pool diversity cap may reduce) |
| 1                    | up to 2                               |
| 2                    | 1                                     |
| 3+                   | 0 — engine skips                      |

#### Engine Flow

```
1. Promise.all: fetch v_queue_with_wait_time (waitingCount) + COUNT unpublished drafts (draftCount)
2. dynamicCap = getDynamicDraftCap(waitingCount)  [3 | 5 | 6]
   slotsAvailable = max(0, dynamicCap − draftCount)  [skip if ≤ 0]
3. Soft gate check (skipped when bypassGate=true):
     if pool ≤ GATE_POOL_THRESHOLD AND activeCourts > 0
        AND maxWait < GATE_HOLD_MINUTES AND no Red Zone player → defer (return early)
4. Pre-fetch recentRosters once (Fix 2: completed + in_progress + pending)
5. For each slot in [0, slotsAvailable):
   a. Pool diversity cap (slots 1+): skip if estimatedWaiting < PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK
   b. runAlgorithm(anchor):
        i.  fetchPartnershipCounts (once per runAlgorithm — not per candidate)
        ii. buildOverlapMap(anchor) — team-aware, per-tick
        iii.scoreCandidates → buildCombinationGroup → skill window expansion → Tier 1/2/3 swap
        iv. executeMatch → create_match_with_players RPC
              • RPC returns matchId (UUID) on success
              • RPC returns NULL on TOCTOU conflict → graceful slot-skip, engine continues
6. Last-resort fallback: skill window bypassed when anchor wait > FALLBACK_WAIT_MINUTES
7. Cap saturation: broadcastCapSaturation() fires if the partnership cap was the reason
   no match formed → CapSaturationNotice shown in on-deck panel
```

#### DB-Level TOCTOU Guards (`create_match_with_players`, migration `20260507000000`)

**Root cause:** Draft Mode keeps queue_entries status `waiting` for unpublished matches. In serverless (Vercel), concurrent workers could both read the same player as `waiting` and commit them to separate draft matches. The process-level `engineRunningFor` Set is **ineffective across worker instances** — it only serialises within a single Node.js process.

**Fix:** Three guards inside the RPC transaction, executed sequentially within the same Postgres transaction:

| Guard                    | Mechanism                                                                                    | Trigger condition                  | Action                                            |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| **Guard 0** — Pre-flight | `COUNT(*) WHERE status='waiting' AND player_id = ANY(all_ids)`                               | Count < total players              | Return `NULL` immediately, before acquiring locks |
| **Guard 1** — Row lock   | `SELECT … FOR UPDATE ORDER BY player_id` on `queue_entries`; `SET LOCAL lock_timeout = '3s'` | Second concurrent transaction      | Blocks until first commits; then Guard 2 runs     |
| **Guard 2** — Conflict   | `COUNT(*) FROM match_players JOIN matches WHERE status IN ('pending','in_progress')`         | Any player already in active match | Return `NULL`                                     |

**NULL-return convention (critical):**

- RPC `RETURNS uuid` (scalar). Supabase JS: `{ data: null, error: null }` = Guard triggered.
- `executeMatch` separates the two failure modes:
  - `rpcError` → genuine DB error, surface to caller as failure
  - `!matchId` (NULL, no error) → TOCTOU slot-skip, `console.warn`, `{ success: false }` — engine continues to next slot

**⚠️ Scalar-NULL contract:** If the RPC is ever changed to `RETURNS SETOF uuid`, PostgREST wraps `null` as `[]` and the `!matchId` check breaks silently. Do not change the return type without updating `executeMatch`.

---

#### Cross-Court Diversity Drafting (held drafts)

**Files:** `src/lib/matchmaking-core.ts` (pure: `isPullEligible`, `isHeldMatchReady`, `pickEarliestFinishing`, `forcedRepeat` on `AlgorithmResult`, ≤1-pulled guard in `buildCombinationGroup`), `src/lib/matchmaking-db.ts` (`fetchPullablePlayers`, `executeHeldMatch`), `src/app/actions/matchmaking.ts` (engine augmented composition + `recomputeHeldReadiness` + promotion TS-filter), `src/lib/cross-court/derive-held-state.ts`, `src/components/organizer/sortable-card.tsx` (`HeldBadge`). Plan: `CROSS_COURT_DRAFTING_PLAN.md`.

When the waiting pool can only form a **forced repeat** (Tier-3 rotation / last-resort fallback — surfaced via `AlgorithmResult.forcedRepeat`), the engine reaches into a live court for ONE still-playing "pulled body" and pre-builds a **held draft** (3 waiting + 1 playing) to break the repeat.

- **Trigger** (`runEngineInternal` slot loop): fires only when `forcedRepeat && !bypassGate && i > 0 && !anchorIsRedZone`. `fetchPullablePlayers` returns eligible playing bodies (relational cooldown via consecutive-games streak; excludes paused/left/already-held), mapped to `ScoredPlayer` with `priorityScore:-1` so a pulled body **never out-anchors a waiting player (C-3)**. The augmented pool re-runs through `runAlgorithm`; taken only if fresh with **exactly one** pulled body (N-1). Slot 0 stays a ready waiting-only match (keep-courts-fed). Held drafts decrement `estimatedWaiting` by **3** not 4 (C-1).
- **Held RPC** `create_held_cross_court_match` (migration `20260607000000`): sibling of `create_match_with_players` that admits exactly one `status='playing'` body. Guard 0 split; Guard 1 locks **only the 3 waiting** rows (M-6); Guard 1b reservation (no body in two held drafts); 3 waiting → `drafted`, pulled body's status untouched. NULL = graceful slot-skip.
- **Readiness** (`recomputeHeldReadiness`, before promote on end/cancel): roster-integrity downgrade (N-2), source-null cancel via `clear_on_deck_match_atomic` (R3-B), stamp `held_ready_at` once source completed AND (≥1 promotion since freed OR `CROSS_COURT_REST_FALLBACK_MINUTES` timer — C-5, no counter column).
- **Promotion** (`promoteOnDeckMatchInternal`): fetch published pending, pick the front-most **ready** in JS — not-ready held matches skipped so a ready one behind still promotes (skip-and-defer; C-4/R3-A). Never idles a court.
- **Ghost-availability** (`endMatchAction`): a finishing pulled body of a pending held draft is re-queued as `drafted`, not `waiting` (R3-1) — reservation by construction.

New `matches` columns: `pulled_player_ids uuid[]`, `pulled_from_match_id uuid` (FK `ON DELETE SET NULL`), `held_ready_at timestamptz`, `is_held boolean GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0) STORED`. New constants: `CROSS_COURT_REST_FALLBACK_MINUTES=3`, `MAX_CONSECUTIVE_GAMES_FOR_PULL=2`, `MATCH_REST_GAP_MINUTES=5`. New token: `cc-violet`. **Deferred items** (UI 3-state track, swap auto-downgrade trigger, publish/callNextMatch recompute, staleness escape, RPC `search_path`) tracked in `MEMORY.md`.

---

### 3.2 On-Deck Queue

**File:** `src/components/organizer/on-deck-panel.tsx`

- Displays `status = "pending"` matches (no `court_id`).
- Engine auto-generates up to `MAX_AUTO_DRAFTS` (3) total pending matches. Formula: `slotsAvailable = max(0, 3 − totalPending)` where `totalPending` counts ALL pending rows (published + unpublished) atomically.
- Each card shows team A vs team B with skill badges, `is_mixed_level` indicator, and H2H strip.
- **Draft Mode**: All engine-generated matches start as `is_published = false` (drafts, hidden from players and TV). The organizer must explicitly publish (single: `publishMatchAction`) or publish-all (`publishAllDraftMatchesAction`) before players see them. The draft approval banner shows `"N on-deck matches waiting for approval"` and the section label reads `"Drafts — hidden from players"`.
- **Engine trigger on publish**: `publishMatchAction` (both RPC and fallback paths) and `publishAllDraftMatchesAction` (both RPC and fallback) call `runEngineForSession` after a successful publish, immediately refilling the draft review queue. This prevents the organizer from seeing 0 drafts after publishing all — the engine proactively generates the next batch.
- **Swap flow**: Long-press / click a player pill → opens `SwapSheet` → pick a bench player → calls `swapPlayerInMatch` server action.
- **Cross-match swap (Tap-to-Swap v2)**: Click a player in match A, then a player in match B → calls `swapMatchPlayers` RPC (atomic two-match swap). This replaces the original bench-only swap with direct match-player swapping.
- **Clear**: Organizer can discard a single on-deck match via `clearOnDeckMatch`; players return to `waiting`. Broadcast fires so affected players see a toast.
- **Reorder**: On-deck matches can be drag-reordered. `reorderOnDeckMatches` bulk-updates `sort_order` on all affected matches.
- **Cap Saturation Notice**: `CapSaturationNotice` banner appears when the engine's `cap_saturation` broadcast fires, alerting the organizer that `MAX_PARTNERSHIP_REPEATS` has been hit and manual assignment is needed.

---

### 3.3 Active Courts

**File:** `src/components/organizer/active-courts.tsx`

- Displays `status = "in_progress"` matches (have `court_id`).
- Each court card shows: match timer (vs `court_time_limit_minutes`), team rosters via `TeamsGrid` with team color identity (sky = Team A, amber = Team B), VIP tags inline, origin badge (`auto` / `manual` / `modified`).
- **Court Time Alert**: When `court_time_limit_minutes` is set and elapsed ≥ limit, the timer turns red and a warning indicator appears on the card. Configured via `CourtTimePopover` in the organizer dashboard header.
- **"Call Next Match"**: Promotes the oldest published on-deck match to the court. If no published on-deck match exists and auto-matchmaking is ON, runs the engine inline and retries once. Returns `hasDraftsBlocking = true` when only unpublished drafts exist. **Fixed (20260507):** After the inline engine retry, if `promoteOnDeckMatchInternal` returns `hasDraftsBlocking = true`, that signal is now propagated to the caller instead of returning the generic "not enough players" message — the organizer sees the amber "review drafts" warning.
- **Cancel (two-step)**: Inline confirmation prevents accidental abort. Cancel does NOT increment `games_played`. Auto-promotes from on-deck; runs engine to refill.
- **End Match + Score**: Opens `ScoreModal` → submits scores → increments `games_played` for all 4 players → auto-promotes on-deck → refills engine.
- **Court management**: Add, rename, toggle status (`available` / `closed`), remove (confirmation dialog). Errors from Close, Reopen, and Remove are surfaced via inline card error and toast banner — they no longer fail silently. Handlers: `handleUpdateCourtStatus`, `handleRemoveCourt` in `active-courts.tsx`.

---

### 3.4 Tap-to-Swap (Intra-match & Cross-match)

**File:** `src/app/actions/swap-player.ts`

Two swap modes:

**Bench → On-deck (intra-match)**: Replace one player in an on-deck match with a waiting queue player.

- Guards: match must be `pending`, out-player must still be in `match_players`, in-player must be `waiting`.
- Execution: single atomic Postgres transaction via `swap_player_in_match` RPC (DELETE + INSERT + UPDATE × 2 + recompute `is_mixed_level`).
- Error codes: `MATCH_STARTED` → close sheet; `PLAYER_UNAVAILABLE` → keep sheet open for re-pick; `PLAYER_NOT_IN_MATCH` → close sheet + info toast.

**Cross-match / Tap-to-Swap v2 (between two on-deck matches)**: Direct match-player swap without needing a bench player.

- Triggered by selecting a player in one match card, then a player in another (via `swap-floating-bar.tsx` cross-match picker).
- Uses `swap_match_players` RPC — both matches must still be `pending`.
- Undo is supported — reversal corrects the `matchId` direction explicitly.
- Error codes: `MATCH_STARTED` → both matches started; `PLAYER_NOT_IN_MATCH` → a player already moved.

---

### 3.5 Draft / Review Mode

Draft Mode is a **publish gate** for auto-generated on-deck matches.

| State                                      | `is_published` | Visible to players / TV? | Organizer sees?               |
| ------------------------------------------ | -------------- | ------------------------ | ----------------------------- |
| Draft (auto-engine)                        | `false`        | ❌                       | ✅ (review mode card styling) |
| Published (manual or explicitly published) | `true`         | ✅                       | ✅                            |

- **All engine-generated matches** are inserted with `is_published = false`. Organizer reviews the proposed pairing, optionally swaps players via Tap-to-Swap, then publishes.
- **Manual matches** (organizer UI) also start as `is_published = false` — they go through the same review gate before becoming visible to players.
- **Publish All**: batch-publishes every draft in the on-deck panel.
- `callNextMatch` will not promote an unpublished draft to a court — it returns `hasDraftsBlocking: true` to alert the organizer.

**Engine trigger completeness** — every action that opens a queue slot calls `runEngineForSession`:

| Action | Trigger? | Note |
| --- | --- | --- |
| `joinQueueAction` | ✅ | All 3 branches (RPC / update / insert paths) |
| `togglePlayerPause` (unpause, `isPaused=false`) | ✅ | Unpaused player re-enters pool immediately |
| `togglePlayerPause` (pause, `isPaused=true`) | — | Engine already excludes paused players; no slot opened |
| `checkoutPlayer` | ✅ | Departure may cancel a draft, freeing drafted players |
| `endMatchAction` | ✅ | Court freed — engine refills on-deck |
| `cancelMatchAction` | ✅ | Same court-freed path |
| `clearOnDeckMatch` | ✅ | Draft slot opened — engine refills |
| `publishMatchAction` (RPC `"SUCCESS"` + fallback) | ✅ | Draft moved to on-deck; review slot freed |
| `publishMatchAction` (`"ALREADY_PUBLISHED"`) | — | No slot opened; no trigger |
| `publishAllDraftMatchesAction` (when `publishedCount > 0`) | ✅ | Same rationale as single publish |
| `publishAllDraftMatchesAction` (when `publishedCount === 0`) | — | Nothing published; no trigger |
| `callNextMatch` (after promotion) | ✅ | Calls `runEngineInternal` directly (bypasses toggle check) |

**`publishMatchAction` — two enforced behaviors (BUG-001 & BUG-002 fixes):**

- **BUG-001 (ON_DECK_WARNING timing)**: After setting `is_published = true`, `publishMatchAction` immediately promotes the newly-published match's players from queue status `waiting` → `on_deck`. This ensures the `ON_DECK_WARNING` fires at publish time (when players are first visible to the board), not at engine generation time (when the draft is still hidden). Without this, players would sit at `waiting` status and the warning would never fire for draft-originated matches.

- **BUG-002 (stale-player guard)**: Before writing any changes, `publishMatchAction` checks that none of the `match_players` rows in the draft belong to a player whose current queue status is `left`. If any player has left since the draft was generated, the action returns an error instructing the organizer to clear the match and let the engine regenerate a fresh pairing.

**Swap-in-draft behavior**: `swapPlayerInMatch` (bench swap + Tap-to-Swap v2) passes `p_is_published` from the match record to the `swap_player_in_match` RPC. When the match is an unpublished draft (`is_published = false`), the RPC skips the queue promotion step — the incoming player remains at queue status `waiting` until the organizer publishes the match. This prevents premature `ON_DECK_WARNING` alerts for players in unrevealed drafts.

**Amber Courts-tab badge**: The organizer dashboard shows an amber badge on the **Courts** tab whenever `drafts > 0` (count of on-deck matches with `is_published = false`). This is a persistent visual signal that unpublished draft matches are waiting for review, even when the organizer is on a different tab.

#### Auto-Publish Mode (the publish gate, OFF) — `sessions.auto_publish`

Auto-Publish Mode is the **per-session opposite** of Draft Mode: when ON, the engine skips the manual publish gate entirely and matches go **straight to On Deck**. The whole pipeline downstream of publish is already automatic (`endMatchAction → promoteOnDeckMatchInternal → COURT_CALL`), so this single flag flips the only remaining manual step. Migrations `20260623000000` (column) + `20260623000001` (RPC) + `20260623000002` (grants).

- **Engine output (the critical cluster, `runEngineInternal`):** `runEngineInternal` reads `auto_publish` alongside `max_auto_drafts_override` (one `sessions` fetch). `executeMatch` is called with `autoPublish`, so `create_match_with_players` receives `p_is_published = true` and atomically promotes the roster to `on_deck`. The engine then fires `ON_DECK_WARNING` itself via `after()` (the publish action that normally fires it is bypassed).
- **Cap re-interpretation (D2):** the same `max_auto_drafts_override` cap means "max published matches to keep On Deck" in auto mode. Because there are no unpublished drafts, the cap-count query re-counts `is_published = true` pending matches (an extra count query that runs **only** in auto mode). Held-but-not-ready drafts (`is_published=false`) stay hidden and don't count. UI chip label swaps `MAX` → `DECK`.
- **Held cross-court drafts publish at READINESS, not creation (D12):** held drafts are still born `is_published=false` (the pulled body may be mid-game). When `recomputeHeldReadiness` stamps `held_ready_at` and `auto_publish` is ON, it calls `auto_publish_match` (service-role RPC) to publish that one draft and ping all four players — so a still-playing player is never pinged or shown on-deck early.
- **Ghost-player guard (`promoteOnDeckMatchInternal`):** before promoting, the function skips and clears any ready match whose roster contains a `left` player (auto-published matches reach On Deck without organizer review, so this is the safety net that the manual publish path provided).
- **Toggle (`toggleAutoPublish`):** ON flip — persist `auto_publish=true`, then (only while Auto-Matchmaking is ON) clear unpublished drafts and re-run the engine so it refills On Deck immediately (D3/D8); a confirm dialog warns when drafts will be cleared (D9). OFF flip — persist only; live On-Deck matches are committed and left untouched (D4). The toggle is disabled in the header while Auto-Matchmaking is OFF (D11, the engine can't run). State syncs to co-organizers via the `auto_publish_toggled` broadcast. In auto mode the On-Deck panel hides the drafts section, the divider, and the Publish-All banner.

**Three-layer server firewall (RLS-level enforcement):**

1. `matches` RLS `SELECT` policy: `is_published = true OR creator_id = auth.uid()` — non-organizer users can only query published matches.
2. `match_players` RLS `SELECT` policy: joined through matches, inherits the `is_published` filter — players cannot even discover they are assigned to a draft.
3. Realtime channel: player-side and TV-view subscriptions receive only `is_published = true` rows, so drafts are invisible at the subscription level without requiring client-side filtering.

---

### 3.6 VIP Tags

**File:** `src/lib/vip-config.ts`, `src/components/ui/vip-tag.tsx`

10 preset themes. DB stores only the key string (`vip_theme`). All visual logic is code-side.

| Theme Key        | Label          |
| ---------------- | -------------- |
| `cyber-neon`     | Cyber Neon     |
| `gold-prestige`  | Gold Prestige  |
| `crimson-elite`  | Crimson Elite  |
| `violet-spark`   | Violet Spark   |
| `emerald-legend` | Emerald Legend |
| `solar-flare`    | Solar Flare    |
| `arctic-ice`     | Arctic Ice     |
| `rose-titan`     | Rose Titan     |
| `toxic-lime`     | Toxic Lime     |
| `silver-phantom` | Silver Phantom |

**Rendering rules:**

- **Dark mode** → `neonClass`: colored text + layered CSS `text-shadow` glow (3 layers: close glow, mid glow, wide spread).
- **Light mode** → `holoClass`: gradient background clipped to text (`bg-clip-text`) for a holographic shimmer effect. Animated via `vip-holo-shimmer` keyframes in `globals.css`.
- VIP tags appear inline on player pills in active court cards (`TeamsGrid`) and in match alert cards.
- Set directly in Supabase dashboard — no in-app UI for admins yet.

---

### 3.7 Session Wrapped

**Files:** `src/app/wrapped/[sessionId]/[playerId]/`, `src/components/wrapped/`, `src/app/actions/wrapped.ts`, `src/lib/wrapped-awards.ts`

Post-session awards summary — the "Spotify Wrapped" for a badminton night.

**Computation**: `compute_session_wrapped(p_session_id)` RPC runs server-side, computing all stats and upsert-ing `session_wrapped_stats` rows for every player in the session. Triggered when the organizer closes the session.

**Intro Overlay** (`wrapped-intro.tsx` / `SessionWrappedIntro` component):

- Full-screen dark navy takeover (`#0E1C3A` background) with staged CSS animation sequence:
  1. Overlay fades in (`wi-fade`)
  2. Shuttlecock icon scales in with rotation (`wi-icon`)
  3. Ring burst radiates behind icon (`wi-ring`)
  4. Particles float up left/right (`wi-float-r`, `wi-float-l`)
  5. "SESSION" label slides up (`wi-up`)
  6. "WRAPPED" slams in with amber→white color flash + shimmer (`wi-word`, `wi-shimmer`)
  7. Player name appears (`wi-up`)
  8. Teaser stats fade in (`wi-up`)
  9. CTA button breathes in (`wi-breathe`)
- Dismissible by CTA button or tap anywhere after 3–4 seconds.
- Tracks `intro_dismissed_at` on the `session_wrapped_stats` row — cross-device: once dismissed, stays dismissed on every device.

**Award Cards** (`wrapped-award-card.tsx`):

- Each award rendered with rarity-coded background tint, emoji, title, personalized subtitle.
- Rarity tiers: `common | uncommon | rare | legendary`.
- Inline styles only (no `dark:` Tailwind variants) — compatible with `html-to-image` capture.
- Staggered entrance animations via CSS custom property.

**Award Metadata** (`src/lib/wrapped-awards.ts`):

- `AWARD_META: Record<string, AwardMeta>` — maps every slug to `{ emoji, title, subtitle, rarity }`. **60 total awards** across 8 categories (51 session-only + 9 cross-session added in migrations `20260510000000–02`).
- Subtitle templates use `{value}` tokens replaced at render time from `award_data` jsonb.
- `renderSubtitle(meta, awardData)` handles token replacement.
- `sortAwardsByRarity(slugs)` — orders rarest-first for display (legendary → rare → uncommon → common).
- `topAwardsByRarity(slugs, n=6)` — display cap helper used by `WrappedShell` to render at most 6 awards on the player's Wrapped page; the header copy switches to "Top 6 of N Awards" when there are more.

**Award catalogue (60 awards):**

| Category                | Awards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Performance             | undefeated_champion, dominant_night, solid_outing, glass_half_full, session_mvp, comeback_kid, the_closer, ice_cold, clean_sweep (replaces sunset_surge), back_to_back                                                                                                                                                                                                                                                                                                                  |
| Scoring                 | point_machine, shutout_artist, top_scorer, point_diff_king                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Margin / Dominance      | blowout_king, heartless (≥8 pt), sniper (5–7 pt), defensive_wall                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Streaks (tiered)        | hot_streak → on_fire → unstoppable                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Volume (tiered)         | battle_tested → marathon_night → court_hermit, most_active                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Resilience              | grinds → never_say_die, sunset_surge, fast_starter                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Nemesis / H2H           | my_nemesis ★, kryptonite ★, the_rematch, redemption_arc ★, friendly_fire                                                                                                                                                                                                                                                                                                                                                                                                                |
| Social / Partner        | social_butterfly, loyal_partner ★, mixed_master                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Score-based Flavor      | close_call_survivor, heartbreaker, deuce_magnet                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Comedic / Personality   | participation_trophy, the_punching_bag, scoreboard_decorator, benchwarmer, the_warmup_act, own_worst_enemy, just_getting_started (fallback)                                                                                                                                                                                                                                                                                                                                             |
| Special / Milestone     | century_club, the_veteran, night_cap, early_bird, skill_slayer, double_trouble                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Cross-session (NEW)** | **momentum** (ended last session on streak ≥3, won first tonight), **consistent_dominator** (70%+ in 2 of 3 sessions), **bounced_back** (sub-50% → 50%+), **nemesis_slayer** (beat all-time nemesis), **settled_the_score** (flipped negative H2H), **the_dynasty** (5+ wins, 70%+ all-time vs same rival), **serial_rivals** (3+ sessions vs same rival), **soulmates** (20+ games with same partner across sessions), **winning_formula** (60%+ win rate with same partner, 6+ games) |

(★ = enhanced with cross-session context in award_data)

**RPC mechanics — what the migration changed:**

- `PERFORM refresh_alltime_leaderboard()` runs at the top so `century_club` (≥100 all-time games) and `the_veteran` (top-3 all-time games among players active tonight) read fresh data.
- `_wrapped_stats` temp table extended with ~25 new computed columns: `won_last`, `lost_first_two`, `wins_after_first_two`, `last3_total`, `distinct_win_streaks_2plus`, `avg_winning_margin`, `avg_loss_margin`, `wins_by_8_or_more`, `wins_by_5_to_7`, `avg_pa_per_game`, `mixed_wins`, `played_first_match`, `played_last_match`, `max_rematch_count`, `redemption_count`, `unique_partners`, `max_same_partner_count`, `top_partner_id` / `top_partner_name`, `friendly_fire_overlap`, `own_worst_enemy_id` / `own_worst_enemy_name`, `skill_slayer_wins`, `alltime_games`, `is_alltime_top3`, `has_streak_partner`.
- New supporting CTEs: `match_opponent_pairs` + `opp_pair_summary` (rematch / redemption), `partner_counts` + `partner_aggregates` + `top_partner_per_player` + `partner_summary`, `partners` / `opponents` + `friendly_fire_counts`, `own_worst_enemy_pairs` + `own_worst_enemy_summary`, `player_skills` + `match_opponent_skill` + `skill_slayer_counts`, `alltime_top3`.
- Tier replacement: `clean_sweep` removes `sunset_surge` from the player's award array (won 3-of-3 last is a strict superset of won 2+-of-3 last).
- Tier replacement: `the_warmup_act` removes `participation_trophy` before adding itself — a player who qualifies for warmup_act (0 wins, ≥3 games, avg loss margin ≥6) was otherwise receiving both awards simultaneously (migration `20260509`).
- `sniper` was rebanded from "≥5 pt margin" to "5–7 pt margin" so it does not overlap with the new `heartless` (≥8 pt margin) award.
- **Threshold tweaks (migration `20260509000000`):** `the_closer` requires `games_played >= 3` (was 2); `friendly_fire` requires `friendly_fire_overlap >= 2` (was 1, fired for ~80% of players in small sessions).

**Archetype Cards**: Players receive a personality archetype (e.g. "The Grinder", "The Sniper") based on their session stats pattern.

**Cross-session persistence** (migrations `20260510000000–02`):

- `player_rivalries` table — directional all-time H2H ledger `(player_id, rival_id)`: `wins_vs`, `losses_vs`, `sessions_faced`. Updated at session close.
- `player_partnerships` table — directional all-time partnership ledger `(player_id, partner_id)`: `games_together`, `wins_together`, `losses_together`, `sessions_together`. Updated at session close.
- `session_wrapped_stats.carry_forward jsonb` — per-player payload written at close: `{ ended_on_win_streak, session_win_pct, session_id }`. Read by the next session's RPC for momentum/streak signals. `ended_on_win_streak` is the actual streak the player was on at session end (gaps-and-islands counting backward from last match), NOT the session peak.
- `refresh_cross_session_stats(p_session_id UUID)` RPC — upserts both ledger tables from tonight's completed matches. Called in `closeSession()` before `compute_session_wrapped`. Non-fatal: failure logs a warning but does not block the close. Idempotent via `last_session_id` guard.
- `compute_session_wrapped` extended with section 2b: `_cross_session_stats` temp table (14 CTEs joining `player_rivalries`, `player_partnerships`, and prior `session_wrapped_stats`). All columns use `cs_` prefix to avoid collision with `_wrapped_stats` columns. FOR loop joins both temp tables.

**Delivery pipeline**: Organizer closes session → `refresh_cross_session_stats` RPC (non-fatal) → `compute_session_wrapped` RPC (with 600ms retry) → `session_closed` broadcast fires → all connected players redirect to `/wrapped/{sessionId}/{playerId}` automatically.

**PG17 compatibility note:** All `v_awards` appends use `array_append(v_awards, 'X'::text)` rather than `v_awards || 'X'`. Postgres 17's stricter type coercion treats `text[] || 'unqualified-string'` as ambiguous and tries to parse the literal as an array, raising "malformed array literal". Always use `array_append` for plpgsql append patterns.

---

### 3.8 Player Identity Reconnect

**File:** `src/app/actions/auth.ts`, `migrate_player_identity` RPC

- Players authenticate anonymously — each browser session generates a new `auth.users` UUID.
- A 4-digit PIN stored on `profiles.pin` lets returning players reclaim their identity.
- Reconnect flow: new anon user signs in → enters PIN → `migrate_player_identity(oldId, newId)` RPC migrates all queue entries, match_players, and leaderboard data to the new UUID → old profile is replaced → audit row written to `identity_migrations`.
- RPC returns `true` if the old user is the primary session organizer, preventing deletion of their auth record.
- **Safety net**: After reconnect, the leaderboard auto-refreshes to reflect the merged identity. Organizer session is preserved if the reconnecting player is an organizer.
- **Sign-out guard**: `signInAnonymously` is always preceded by `signOut()` to prevent stale sessions from causing identity conflicts.
- **Column parity (2026-06-08):** `migrate_player_identity` Step 2 now copies **all** profile columns (previously only `id, display_name, skill_level, pin` — which silently dropped `vip_tag`/`vip_theme` on every reconnect, and would drop the new duplicate-name flags). `created_at`/`updated_at` are intentionally left to defaults. Guarded by the schema-drift test `tests/unit/migrate-identity-columns.test.ts`.

---

### 3.8b Duplicate-Name Resolution (forced rename on next login)

**Files:** `src/lib/normalize-name.ts`, `src/lib/dup-name.ts`, `src/lib/rename-gate.ts`, `src/app/actions/rename.ts`, `src/app/actions/auth.ts`, `src/app/actions/queue.ts`, `src/app/rename/page.tsx`, `src/components/player/rename-screen.tsx`. Migrations `20260608000000` (schema + RPCs) and `20260608000001` (unique index). One-shot data fix: `supabase/data-fixes/20260608_duplicate_name_data_fix.sql`.

**Problem:** `display_name` was never globally unique — registration only blocked names *active in a queue*, so two different people (and reconnect-ghost profiles) could share a name, splitting cross-session identity on the leaderboard/history.

**Scope A (lazy/reactive):** fix the true same-person duplicates by **merge**; for genuinely-different people who share a first name, **flag** the non-canonical profiles and force a rename only when they next log in or join. Never-returners stay inert.

**Normalization key (single source of truth):** `normalizeName()` = ASCII space/tab collapse → trim → lower, byte-identical to the SQL `lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g')))`. Used by registration, the rename gate, the RPC's R1 recheck, and the unique index. Pinned to ASCII (not `\s`) to avoid a JS/Postgres NBSP divergence.

**Two rules:** **R1** — a flagged profile cannot reuse the `collided_name` it was flagged on (persisted; checked per-keystroke + server-side). **R2** — the new name must be unique across all non-flagged profiles. R1 is **not** subsumed by R2: a merge can remove the canonical sibling, after which R2 alone would re-accept the old name (infinite-gate loop) — R1 prevents it.

**Three enforcement layers:**

1. **L1 redirect** — `enforceRenameGate(profile, nextPath)` at the top of `/play` and `/play/[sessionId]` routes a flagged profile to `/rename`. Fast path: zero queries for clean profiles. Grandfathers a player who is currently in a live queue/match; skips active organizers. Redirect-only (no cookie mutation → safe in a Server Component render).
2. **L2 action gate** — `joinQueueAction` reads `needs_rename` as its first step and returns `requiresRename` (the client routes to `/rename`). The real mutation boundary.
3. **L3 DB authority** — partial UNIQUE index `idx_profiles_unique_active_name` on the normalized name `WHERE needs_rename = false`. Flagged duplicates are excluded (so they keep their real name until they rename); the instant a rename flips the flag, the new name enters the index. This is the only TOCTOU/cross-instance-safe guard. **Held until the data fix flags duplicates** (it can't build over live collisions).

**`/rename` screen:** `force-dynamic` (flag read fresh per request). Full-screen, non-dismissible. Prefilled with the stem + trailing space; one-tap suffix chips. Validation ladder mirrors the server: shape (Zod) → R1 (per-keystroke, amber guidance) → R2 (debounced async, `fetchSeq`-guarded, red error). a11y: real `<label>`, `aria-invalid`/`aria-busy`/`aria-describedby`, `aria-live` status, focus starts on the heading, every cue is icon + text, `motion-reduce` spinners.

**`rename_player_identity(p_user_id, p_new_name)` RPC:** single transaction — server-side R1 recheck → `UPDATE display_name + needs_rename=false + collided_name=null` (the unique index arbitrates R2; 23505 → `name_taken`) → `player_renames` audit insert. SECURITY DEFINER, pinned `search_path`, granted to `service_role` only (the action derives the user id from the session — no IDOR).

**Registration change:** `signInAnonymously` now enforces global uniqueness (after the returning-player name+PIN→Reconnect check). The already-authed path **upserts** (re-creating a missing profile), which — together with `/` falling through to the login form for an authed-but-profileless user — breaks the profileless redirect loop left by a merged-away ghost.

**Schema:** `profiles.needs_rename boolean NOT NULL DEFAULT false`, `collided_name text`, `flagged_at timestamptz`; partial lookup index `idx_profiles_needs_rename`; audit table `player_renames(id, player_id, old_name, new_name, reason, actor_user_id, session_id, created_at)`.

**Data fix (hand-run, guarded, idempotent):** merge Miggy ghost + Lianne (keep latest PIN), flag the non-canonical Tristan/Bea/Jason (canonical = most completed games, tiebreak earliest), build the unique index, refresh the leaderboard, recompute merge-affected Wrapped.

---

### 3.8c Google OAuth — Sign-in & Account Upgrade

**Files:**
- `src/app/actions/oauth.ts` — `signInWithGoogle` + `linkWithGoogle` server actions
- `src/app/auth/callback/route.ts` — PKCE exchange; `intent=link` branch; `ensureOAuthProfile` for fresh sign-ins
- `src/lib/oauth-provision.ts` — `ensureOAuthProfile` (derive display name → check uniqueness → assign or flag for rename)
- `src/lib/oauth-name.ts` — `deriveDisplayName` / `sanitizeToDisplayName` (Google name → `[a-zA-Z0-9 ]`, 3–30 chars)
- `src/components/auth/google-sign-in-button.tsx` — "Continue with Google" button on the login form
- `src/components/auth/google-link-button.tsx` — compact "Link Google Account" button for the overflow menu
- `src/components/notifications/google-link-card.tsx` — dismissible upgrade card shown to non-linked players

**Feature flag:** `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true"` gates all three components (each returns `null` when the flag is absent). Inlined at build time — must be set in the Vercel dashboard and a new build triggered to activate in production.

**Required env vars (both Vercel + `.env.local`):**
- `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true` — activates the UI and actions.
- `NEXT_PUBLIC_SITE_URL=https://badminton-app-dusky-six.vercel.app` — used by `siteUrl()` in `oauth.ts` to build the `redirectTo` URI; falls back to `http://localhost:3000` if absent (causes localhost redirect in production).

**Sign-in flow (fresh user):**
1. User taps "Continue with Google" → `signInWithGoogle(next?)` → `supabase.auth.signInWithOAuth` → returns provider URL.
2. Client does `window.location.href = result.url` (full-page PKCE redirect to Google).
3. Google redirects to `/auth/callback?next=<path>` → `exchangeCodeForSession` → `ensureOAuthProfile` provisions or collides the profile → redirect to `next`.

**Account upgrade flow (anonymous → Google-linked):**
1. User taps "Link Google Account" (menu or card) → `linkWithGoogle(next?)` → `supabase.auth.linkIdentity` → returns provider URL.
2. Client navigates to provider URL. After consent Google redirects to `/auth/callback?intent=link&next=<path>`.
3. Callback detects `intent=link` → skips profile provisioning (name already set) → redirects to `next`.
4. The user's `auth.uid()` is **unchanged** — all queue entries, match history, and display name are preserved.
5. On next page load `user.identities?.some(i => i.provider === "google")` returns `true` → all upgrade surfaces disappear.

**Prerequisite — Supabase dashboard settings:**
- Google provider enabled (Authentication → Providers → Google) with OAuth client ID + secret.
- Site URL set to the production URL.
- Redirect URL `https://<project>.supabase.co/auth/v1/callback` added in Google Cloud Console.
- "Allow manual linking" toggle **enabled** (Authentication → Providers → scroll to bottom). Without it, `linkIdentity` returns `"Manual Linking is disabled"`.

**Four upgrade surfaces (all flag-gated, all hidden when `hasGoogleLinked`):**

| Surface | Component | Location | Prop |
|---------|-----------|----------|------|
| Login form (top) | `GoogleSignInButton` with `dividerPosition="below"` | `src/components/login-form.tsx` — above tab control, NEW PLAYER panel only | `next="/play"` or `"/play/[id]"` |
| Overflow menu | `GoogleLinkButton` | `src/components/player/player-dashboard.tsx` | `next="/play/[sessionId]"` |
| My Status card | `GoogleLinkCard` (dismissible) | `src/components/player/my-status-tab.tsx` | `next="/play/[sessionId]"` |
| Session picker | `GoogleLinkCard` | `src/app/play/page.tsx` | `next="/play"` |

**`GoogleSignInButton` — `dividerPosition` prop:**
- `"above"` (default): divider renders ABOVE the button (original position — button at bottom of a form).
- `"below"`: divider renders BELOW the button with extra `pt-6 pb-2` breathing room (button at top of a form, divider separates it from the form beneath). The `divider` constant is defined after the `if (!enabled) return null` guard so there is no orphaned JSX when the flag is off.

**`GoogleLinkCard` — `next` prop:**
- Accepts any return path string (e.g. `"/play"`, `"/play/abc-123"`). The previous `sessionId` prop was removed.
- SSR-safe: initial state `"idle"` → `useEffect` reads `localStorage["google-link-card-dismissed"]` → transitions to `"visible"` or stays hidden. Prevents hydration mismatch.

**`hasGoogleLinked` — data flow:**
- `src/app/play/[sessionId]/page.tsx` and `src/app/play/page.tsx` both compute `const hasGoogleLinked = user.identities?.some(i => i.provider === "google") ?? false;` after `auth.getUser()`.
- Threaded as a prop from the server page component down to `PlayerDashboard` → `MyStatusTab`.

**Deferred (Phase 3):** `/auth/callback` has a stub for `error_code=identity_already_exists` — this fires when a Google account is already linked to a *different* anonymous user. The correct resolution is `migrate_player_identity(existingUserId, currentUserId)`, but the wiring is not yet built.

---

### 3.9 Leaderboard

**Files:** `src/components/leaderboard/`, `src/hooks/use-leaderboard.ts`, `src/app/actions/leaderboard.ts`, `src/types/leaderboard.ts`, `src/lib/month.ts`

Three leaderboard scopes (3-way segmented control `[ Session · Monthly · All-Time ]` on every variant; `useLeaderboard` owns the `scopeTab`):

- **Session leaderboard**: reads `v_session_leaderboard` — live stats for the current session. `MIN_SESSION_GP=1`, confidence `K=3`.
- **Monthly leaderboard** (migration `20260626000000`): live `get_monthly_leaderboard(year, month)` RPC aggregating one **Manila-month** (`Asia/Manila`, UTC+8, `CLUB_TIMEZONE`) slice of completed matches off the base tables. Browsable via a month picker fed by `get_leaderboard_months()` (distinct Manila-months with data + the current month). `MIN_MONTH_GP=8`, confidence `K=6`, **no win-streak, no Δ column**. SECURITY INVOKER (respects the permissive `matches_select` RLS), public-read. Month boundaries computed once as `make_timestamptz(y,m,1,…,'Asia/Manila')` → sargable `completed_at` range on partial index `idx_matches_completed_at`. Default tab on the no-session lobby.
- **All-time leaderboard**: reads `v_alltime_leaderboard_mat` (materialized view). Refreshed via `refresh_alltime_leaderboard()` RPC after each session. `MIN_ALLTIME_GP=10`, confidence `K=10`, shows the rank-movement **Δ** column (vs a 7-days-ago snapshot via `get_alltime_snapshot_before`).

Default scope: the live **Session** when one is in context, else **Monthly** (current month). Month math lives in `src/lib/month.ts` (pure: `getCurrentManilaMonth` uses `Intl` + `Asia/Manila`, never the runtime tz). All three boards render through the single `StadiumLeaderboard` component (one unified rounded "stadium" aesthetic — the leaderboard is a deliberate exception to the player/organizer `cc-*` split); `showMovement` drops the Δ column (so Session + Monthly hide it).

**LeaderboardHeroCard**: Always-visible player status strip showing the authenticated user's rank, GP, Win%, and rank delta — renders above the leaderboard table on session, monthly, and all-time views (`getPlayerMonthlyStats` feeds the monthly below-threshold state).

Rank-change flash animation: `data-flash="true"` triggers `leaderboard-flash` keyframes (amber glow → transparent over 800ms).

**Realtime staleness fallback (2026-07-01):** `useLeaderboard`'s `matches` realtime subscription (session/monthly scope) is paired with a `setInterval(refetch, 15_000)` polling fallback, mirroring `use-tv-board.ts`. Needed because anon/non-member viewers of the legacy `/leaderboard` pages have their realtime `postgres_changes` events silently filtered by club-scoped RLS (no error — the event just never arrives) — the poll ensures the board still catches up within 15s.

---

### 3.10 QR-Code Session Join

**Route:** `/play/join?session=[sessionId]`

- Uses `lookup_active_session(p_session_id)` RPC — safe public lookup that does not expose `organizer_passcode` or `created_by`.
- Returns `{ id, name, is_active }` or empty array if session not found / inactive.
- Pre-wires the new player registration to the target session.

---

### 3.11 H2H (Head-to-Head) Strip

**Files:** `src/components/organizer/h2h-strip.tsx`, `src/hooks/use-h2h.ts`, `src/app/actions/h2h.ts`

Compact head-to-head record strip embedded at the bottom of on-deck match cards. Only renders when the exact 2v2 pairing has prior history — first-meeting pairs and fetch errors render `null` (no skeleton, no placeholder) to avoid layout shift.

Shows: `A {n} — B {n} all-time · A {n} — B {n} tonight`

Backed by `get_h2h_record(p_team_a, p_team_b, p_session_id)` RPC with security and degenerate guards.

**Auth model:** `getH2HRecord` verifies the caller is either an organizer OR has a `queue_entries` row for the requested session. Unauthenticated and non-member requests return `null` silently.

---

### 3.12 TV Scoreboard

**Files:** `src/app/tv/[sessionId]/page.tsx`, `src/app/tv/[sessionId]/tv-board.tsx`, `src/app/actions/tv.ts`

Public read-only scoreboard for display on a wall-mounted screen. Uses the service-role client (no user session required). Shows all `in_progress` and `pending` matches with team rosters, skill levels, and mixed-level indicators. Accessible at `/tv/[sessionId]`.

---

### 3.13 Pocket Ping (Push Notifications)

**Files:** `src/lib/notifications/push-server.ts` (core), `src/app/actions/notifications.ts` (thin wrapper), `src/lib/notifications/push-client.ts`, `src/lib/notifications/audio.ts`, `src/components/notifications/notification-enrollment.tsx`, `src/components/notifications/install-prompt.tsx`, `src/lib/pwa/install-detection.ts`, `public/sw.js`

Hybrid notification system — **server-triggered** Web Push + client-side in-app audio. Two independent channels:

- **In-app audio (client):** `use-match-alerts.ts` watches the player's Realtime status transitions and plays `playWarningBeep` / `playCourtCall` from `audio.ts`. Low-latency feedback while the app is OPEN. **It no longer fires push** — that moved server-side.
- **Web Push (server) — the background channel:** `pushToPlayers(userIds, type)` in `push-server.ts` is the single source of truth. Invoked via Next.js `after(() => pushToPlayers(...))` from every server action that transitions a player's queue status, so the push reaches a **backgrounded/locked phone** regardless of whether the app is open.

**Why server-side:** the old design called `sendPlayerNotification` from the client hook on a Realtime event. A locked/backgrounded phone suspends the websocket, so the event — and the push — never fired. Moving the trigger server-side fixes this; removing the client push also prevents double-notification.

**Server trigger points (each fires `after()` on the SUCCESS path only):**

| Action (file → fn) | Player IDs | Type |
|---|---|---|
| `matchmaking.ts` → `promoteOnDeckMatchInternal` (call to court) | match roster | `COURT_CALL` |
| `live-match-swap.ts` → `swapPlayerInActiveMatch` | `inPlayerId` | `COURT_CALL` |
| `live-match-swap.ts` → `swapActiveFromOnDeck` | `onDeckPlayerId` → COURT_CALL; `fillPlayerId` → ON_DECK | both |
| `match-drafts.ts` → `publishMatchAction` | published roster | `ON_DECK_WARNING` |
| `match-drafts.ts` → `publishAllDraftMatchesAction` | rosters that actually published (snapshot drafts → re-query `is_published=true`) | `ON_DECK_WARNING` |
| `match-lifecycle.ts` → `createManualMatchAction` | all 4 | `ON_DECK_WARNING` |
| `swap-player.ts` → `swapPlayerInMatch` (only if `match.is_published`) | `inPlayerId` | `ON_DECK_WARNING` |

Intentionally silent: engine draft creation (players stay `waiting` until published), `swapMatchPlayers` (no status change), `undoLiveSwap` / `revert_match_to_active` (reversals / players already courtside).

**Delivery hardening:** `pushToPlayers` sets web-push options per type — `COURT_CALL` `{ urgency:high, TTL:600, topic:"court-call" }`, `ON_DECK_WARNING` `{ urgency:high, TTL:300, topic:"on-deck" }` (`topic` lets a newer ping replace an undelivered older one). It de-dupes ids, no-ops on empty, prunes 410/404 endpoints, and never throws (safe inside `after()`). `public/sw.js` sets `renotify:true` for `COURT_CALL` (a repeat court call re-buzzes); `CACHE_VERSION` is `v2` (skipWaiting + clients.claim activate it immediately).

**Install prompts (PWA):** `install-detection.ts` (`isIOS`/`isAndroid`/`isStandalone`, SSR-safe) + `install-prompt.tsx`. iOS **requires** an installed PWA for Web Push, so on iOS-not-installed the "Enable Pings" card is suppressed (gate in `notification-enrollment.tsx`) and an Add-to-Home-Screen hint shows instead. Android gets a one-tap install via `beforeinstallprompt`, revealed only after the player resolves the ping prompt (bounded poll on `hasUserMadeChoice()`) so the two bottom cards never overlap.

**Platform reality:** a locked phone plays the **OS notification sound + vibration**, not the in-app custom beep (web-push cannot play a custom sound from the SW). A custom alarm tone would need a native wrapper (deferred).

- **VAPID env vars required**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_MAILTO`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.

---

### 3.14 Step Out / Soft Pause

**File:** `src/components/organizer/queue-control.tsx`, queue entry `is_paused` column

Organizer can soft-pause any player in the queue. Paused players:

- Remain visible in the queue list (position preserved)
- Are excluded from matchmaking candidate pool
- Can be un-paused at any time (single click)
- Displayed with a distinct visual indicator (muted / dimmed row + pause icon)

Does not affect `games_played`. Does not change `queue_status`.

---

### 3.15 Player Self-Scoring

**File:** `src/app/actions/match-lifecycle.ts`, `src/components/player/match-alert.tsx`

Any player assigned to an `in_progress` match can submit the final score from their phone. Submission is guarded: only players in `match_players` for that match can call the action. Triggers the same cascade as organizer score entry (games_played increment, on-deck promotion, engine refill).

---

### 3.16 My Session History

**Files:** `src/components/player/all-sessions-history.tsx`, `src/components/player/match-history.tsx`, `src/app/actions/history.ts`, player dashboard bottom sheet

Persistent stats chip visible on the player lobby showing the player's lifetime totals (GP, W, L, Win%). Tapping opens a bottom sheet with full cross-session match history grouped by session, including a last-match peek for the most recent game.

**Data layer:** `src/app/actions/history.ts` exposes two server actions:
- `getMatchHistory(playerId, sessionId?, limit?)` — reads `v_match_history`, auth-gated, optionally scoped to a session
- `getAllSessionsHistory(playerId)` — reads `v_match_history` + `sessions` in two queries, returns both for client grouping

Both components call server actions for data. `match-history.tsx` retains the browser Supabase client **only** for its Realtime subscription (session-scoped match change events); all data fetching goes through the server action.

---

### 3.17 Stateless Organizer Auth / Session Auto-Discovery

**File:** `src/components/organizer/organizer-entry.tsx`, `src/app/organizer/page.tsx`

Organizers do not need a persistent account. The organizer landing page auto-discovers all sessions where the authenticated user is either `created_by` or in `session_organizers`. Additional organizers join via passcode (`elevate_to_organizer` RPC). The `organizer-entry.tsx` component handles the passcode gate UI.

---

### 3.18 UUID Input Validation (Cross-cutting)

**File:** `src/lib/validate.ts`

Every server action validates all incoming UUIDs **before any database call**:

```ts
import { isValidUUID } from "@/lib/validate";
if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID" };
```

`isValidUUID(s)` is a type-narrowing guard — passes only lowercase hex UUIDs matching `[0-9a-f]{8}-...-[0-9a-f]{12}`. Malformed IDs return a clean error; they never reach PostgREST.

Also: `src/lib/schemas/auth.ts` — Zod schema for `display_name` (3–30 chars, letters/numbers/spaces only, internal spaces collapsed).

---

### 3.19 Checkout / Leave Session

**Files:** `src/app/actions/queue.ts` (`checkoutPlayer`), `src/components/organizer/queue-control.tsx`, `src/components/player/queue-toggle.tsx`

Two paths to exit a session:

**Player self-checkout**: Player taps the leave button from their dashboard. Calls `checkoutPlayer(sessionId)` — sets `queue_entries.status = "left"`. If the player is currently `on_deck` or `playing`, the organizer sees the change immediately via Realtime.

**Organizer-initiated checkout**: Organizer clicks the checkout action in the queue control table. Uses the same `checkoutPlayer` action with the target player's ID via the service-role client (cross-user mutation). Wrapped in `AlertDialog` confirmation to prevent accidental removals.

**Post-checkout state:**

- `queue_entries.status` → `"left"`.
- Matchmaking engine excludes `left` players from all candidate pools.
- If the player was assigned to an unpublished draft match, the draft is not automatically cleared — the organizer must discard it manually (BUG-002 in `publishMatchAction` will block publishing if a draft contains a `left` player).
- **Re-joining**: `rejoin_queue(p_session_id)` RPC resets status to `"waiting"` and preserves `games_played`. Players can re-join at any time while the session is active.

---

### 3.20 Wait-time Monitor (Bottleneck Detection)

**File:** `src/components/organizer/wait-time-monitor.tsx`

Displayed in the **Monitor** tab of the organizer dashboard. Shows all `waiting` AND `on_deck` players sorted by accumulated wait time.

**Purpose:** Surfaces players who have been waiting too long AND confirms long-waiting players are being served after manual assignment.

**Data source:** The organizer queue data (from `v_queue_full_with_wait_time`), filtered in-component to `status === 'waiting' || status === 'on_deck'`.

**Visual treatment:**
- `waiting` players with `is_bottleneck = true` (wait ≥ 20 min): red border, "NEEDS ATTENTION" label.
- `waiting` players approaching threshold (75% of 20 min): amber border.
- `on_deck` players: teal border + "On Deck" badge + "ASSIGNED" label — **never flagged as bottlenecks** (they're already assigned to a match). Remove button is hidden.
- Summary line: "X waiting, Y on deck".

**Organizer actions:** Remove from queue (AlertDialog-confirmed, `waiting` players only). Calls `checkoutPlayer`.

⚠️ `joined_at` is **not reset** when a player moves to `on_deck` — their accumulated wait time continues ticking and is preserved if the match is cancelled and they return to `waiting`.

---

### 3.21 Fix Player Record (Historical Roster Correction)

**Files:** `src/components/organizer/fix-record-sheet.tsx`, `src/app/actions/fix-player-record.ts`, `src/hooks/use-fix-record.ts`, `src/hooks/use-session-completed-players.ts`, migration `20260522000000_fix_record_swap_player.sql`

**Entry point:** Amber "Fix" button (ArrowLeftRight icon) in the header of each completed match card in `match-history-panel.tsx`, alongside the existing `EditMatchDialog`.

**Use cases:** Wrong player recorded (organiser error) or injury substitution (player who finished the game should be credited).

**Two modes (detected automatically by the RPC):**
- **Team Flip:** `in_player` is already in the match — only their `team` columns swap. `queue_entries.games_played` unchanged.
- **Full Replacement:** `in_player` from another completed session match — DELETE out_player, INSERT in_player in the same team slot. `queue_entries.games_played` ±1.

**Eligibility rule for `in_player`:** Must either (a) already be in the target match (team flip) OR (b) have ≥1 completed match in the same session (full replacement). Enforced by both the server action and the RPC.

**State machine (`use-fix-record.ts`):** `selecting_out → selecting_in → confirming → submitting`. `goBack` resets to `selecting_out`. Error stays in `confirming` so user can re-read + retry. `isTeamFlip` is derived client-side from `match.players`.

**Step 2 picker (two sections):**
- `SWITCH WITHIN THIS MATCH` — the other 3 same-match players (team flip candidates)
- `FROM OTHER SESSION MATCHES` — all distinct players with ≥1 completed match in session excluding this match, with `3G · 2W 1L` stats

**What the RPC updates explicitly:**
- `match_players` (team swap or delete+insert)
- `queue_entries.games_played` ±1 (full replacement only)
- `player_partnerships` (delta in both directions, both paths)
- `matches.is_mixed_level` (recomputed from profiles)
- `matches.origin` (`'auto'` → `'modified'` only — sticky rule, never demotes `'manual'`)
- Calls `refresh_alltime_leaderboard()` (materialized view refresh)

**What auto-corrects without explicit update:**
- `v_session_leaderboard` — live view from `match_players`, auto-correct
- Session partnership cap (`fetchPartnershipCounts`) — reads `match_players` directly, auto-correct

**Realtime auto-refresh:** The RPC always updates `matches.is_mixed_level` or `matches.origin`, which fires the `subscribeToMatches` realtime subscription in `useMatchHistory` and triggers a full re-fetch of the match card including updated player names. `onCorrected` callback in the panel is a no-op.

**Amber accent:** Visual signal this is a data-correction operation (vs teal for live swaps). Uses `var(--cc-amber)` and `var(--cc-amber-dim)` from the command-center palette.

⚠️ **Migration `20260522000000_fix_record_swap_player.sql` must be applied to Supabase production** before this feature is usable in live sessions.

---

### 3.22 Live Match Player Swap (Active Court Roster Correction)

**Files:** `src/components/organizer/live-swap-sheet.tsx`, `src/app/actions/live-match-swap.ts`, `src/hooks/use-live-match-swap.ts`, migration `20260601000000_live_match_player_swap.sql`

**Entry point:** Long-press (500ms) on any player name in an active court card (`PlayerRowDark`). The pressed player is the outgoing player — no separate selection step needed.

**Three swap modes (all atomic at the DB level):**

| Mode | Source | Queue changes | RPC |
|---|---|---|---|
| Switch Teams | Same match, opposite team | None — both stay `playing` | `swap_teams_in_active_match` |
| Queue Replacement | Waiting queue | Out → `waiting`, In → `playing` | `swap_player_in_active_match` |
| On-Deck Pull | Pending match player | Out → `waiting`, OnDeck → `playing`, Fill → `on_deck` | `swap_active_from_ondeck` |

**On-deck forced fill:** When an on-deck player is selected, an inline expansion appears. The organizer must select a queue player to fill the vacated on-deck slot before "Confirm Swap" unlocks. Cannot pull from other in-progress courts.

**Undo:** 3-second Sonner toast with action button. `undoLiveSwap` server action reverses all changes atomically. The `swap_active_from_ondeck` RPC returns original team data as OUT params (PostgREST array); stored in `undoContext.outTeam/onDeckTeam` for precise undo.

**Visual design:** Orange `--cc-live` accent (`oklch(0.76 0.20 48)` dark) — distinct from amber (data correction) and teal (queue swap). Long-press shows `lp-hold` CSS animation (orange fill over 500ms). Mixed-level warning (amber banner) shows when the swap would create a mixed-level match.

**Sheet structure:** Shadcn `Sheet` right-drawer (same pattern as `SwapSheet`). 3 labelled sections: "Switch Teams" (opposite-team only) / "On-Deck" (grouped) / "Waiting Queue" (by wait time). Empty state if no candidates exist.

**Guards (server-side):**
- `MATCH_NOT_ACTIVE` → match is no longer in_progress — close sheet
- `PLAYER_NOT_IN_MATCH` → player already moved — close sheet + info toast
- `PLAYER_UNAVAILABLE` → queue player taken — keep sheet open, re-pick
- `ONDECK_MATCH_STARTED` → on-deck match promoted mid-confirm — close sheet
- `FILL_PLAYER_UNAVAILABLE` → fill player taken — keep fill picker open

**Broadcasts:** `broadcastOrganizerIntervention` fires to all affected players after every swap.

**`ActiveCourts` new props:** `onDeckMatches: EnrichedMatch[]`, `queuePlayers: QueueFullWithWaitTime[]`, `sessionId: string`. Local inline toast renamed `banner` to avoid shadowing Sonner's `toast` import.

**`PlayerRowDark` changes:** `onLongPress` prop adds pointer-event handlers + keyboard fallback (Enter/Space fires immediately). `lp-hold` CSS class applied during the hold for visual feedback. Non-interactive rows restore `hover:bg-cc-border`.

**Migration `20260601000000_live_match_player_swap.sql` applied to Supabase production ✅ (2026-06-01).**

---

### 3.23a Match Provenance & Modification Audit (2026-06-17)

**Branch `feat/match-provenance-audit` — built, not yet applied/merged.** Replaces the flat `matches.origin` enum with an auditable 3-layer model so every match's birth + every roster change is known.

**Files:** `src/lib/match-provenance.ts` (pure logic), `src/lib/match-event-log.ts` (best-effort), `src/app/actions/match-events.ts` (reads), `src/components/organizer/match-event-timeline.tsx` (UI), migrations `20260617000000` (additive) + `20260617000001` (origin drop).

**Data model:**

| Layer | Column / table | Meaning |
|---|---|---|
| Birth (immutable) | `matches.created_method` | `auto` \| `manual` \| `held` — never overwritten |
| Rollup | `matches.modification_count` | composition changes net of undos; `provenance_backfilled` marks pre-cutover rows |
| Ultimate label | `matches.final_classification` | GENERATED: `created_method \|\| (count>0 ? '_modified' : '_clean')` → 6 values |
| Full trail | `match_events` (append-only) | one row per organizer ACTION; JSONB movements; snapshotted actor/player names; `correlation_id` ties cross-match legs; `reverses_event_id` for undo; `ON DELETE SET NULL` + snapshots survive deletion |

**How counting works:** the `record_match_event` RPC (called from inside every composition RPC under the match row lock) computes per-match `seq`, inserts the event, and applies the delta (`roster_swap`/`team_flip`/`ondeck_pull`/`player_left` = +1, `undo` = −1, else 0). The old `WHERE origin='auto'` guard is removed — composition changes count on auto/manual/held alike, so `manual_modified` is now real. **Undo correctness:** the two live undo paths re-call the forward RPC with `p_is_undo:true` → records an `undo` (−1), not a second forward (+1), so net counting and partial-undo are correct.

**Cross-match:** the on-deck pull and the cross-match draft swap each write **two correlated rows** (+1 per match). Score edits / reverts / cancels are logged (best-effort, server-action) but never count.

**Origin retirement (B-clean):** migration 1's RPCs are origin-free; the badge (`MatchOriginTag`) + `v_match_history` move to `final_classification`; migration 2 rebuilds the view chain and `DROP COLUMN origin`. The `match_origin` ENUM type is retained (vestigial — `p_origin` params still map to `created_method`).

**Backfill:** birth method is recovered exactly for all existing matches (sticky rule: `origin='modified'` ⇒ born auto; `is_held` ⇒ held), so "% auto vs manual vs held" is accurate retroactively. `manual_modified` is unrecoverable for history (accurate only going forward); legacy modified rows get `modification_count=1` floor.

**⚠ Migrations NOT applied to prod** (apply order: mig1 → deploy app → mig2). Deferred best-effort items: `player_left`/`published` events on leaver/clear/publish paths (zero metric impact — those matches cancel). See MEMORY.md + `MATCH_PROVENANCE_AUDIT_PLAN.md`.

---

### 3.23 Security Hardening & Quality Improvements (2026-06-02)

A systematic audit was applied and all confirmed findings were resolved. Key architectural changes that affect future development:

**Profile actions require organizer gate (`src/app/actions/profile.ts`):**
All four profile mutation actions (`updatePlayerSkill`, `getPlayerPin`, `resetPlayerPin`, `updatePlayerPin`) now require both `getAuthenticatedUser()` AND `isSessionOrganizer(userId, sessionId)` as their first two guards. The `sessionId` parameter is the first argument on all four. Callers must pass the active session ID — `QueueControl` receives it via a `sessionId` prop from `OrganizerDashboard`.

**`createServiceClient` is server-only (`src/utils/supabase/service.ts`):**
`import "server-only"` is the first line. Accidentally importing this module into a Client Component now causes a hard **build error**. The `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` fallback has also been removed — only `SUPABASE_SERVICE_ROLE_KEY` (no `NEXT_PUBLIC_` prefix) is accepted.

**Global App Router error boundaries (`src/app/error.tsx`, `src/app/not-found.tsx`):**
`error.tsx` catches unhandled errors in any route segment with a "Try again" reset button. `not-found.tsx` renders a 404 page with a home link. Both use the existing design system tokens.

**PIN security (`src/app/actions/profile.ts`):**
`resetPlayerPin` uses `crypto.getRandomValues()` instead of `Math.random()`. `updatePlayerPin` rejects `"0000"` explicitly.

**`getH2HRecord` is session-gated (`src/app/actions/h2h.ts`):**
See §3.11 for the updated auth model.

**`src/lib/realtime.ts` — debug logs stripped:**
All `console.log` calls removed from hot subscription paths. Only `console.error` remains (CHANNEL_ERROR / TIMED_OUT). `castPayload<T>()` helper centralises the unavoidable Supabase SDK type assertion for unfiltered subscriptions. File header updated to reflect new debug behavior.

**History data via server actions (`src/app/actions/history.ts`):**
See §3.16 for the updated data layer.

**Action return shape consistency:**
All `{ error }` bare returns in `auth.ts` and `sessions.ts` now include `success: false`. The canonical shape `{ success: boolean, message?: string, error?: string }` from CLAUDE.md is now enforced across all action files.

---

### 3.24 Player-Specific Session History Filter (2026-06-26)

**Files:** `src/lib/match-history-filter.ts` (pure helpers), `src/components/organizer/match-history-player-filter.tsx` (filter UI), `src/components/organizer/match-history-panel.tsx` (wired in).

**Purpose:** Organizer-only type-to-filter search inside the existing Match History tab. Lets the organizer narrow the history view to a single player's matches for quick review. **Zero new DB tables, migrations, or server actions** — 100% client-side filtering over the already-fetched `CompletedMatch[]` from `useMatchHistory`.

**Architecture:**

| Layer | File | Responsibility |
|---|---|---|
| Pure logic | `src/lib/match-history-filter.ts` | 4 exported pure helpers: `filterMatchesByPlayer`, `derivePlayerOptions`, `resolvePartnerIds`, `selectionStillValid` |
| Unit tests | `tests/unit/match-history-filter.test.ts` | 28 MHF-* Vitest tests covering all edge cases (null id, leave-triggered cancel, dup names, swapped-out player, empty history) |
| Filter UI | `src/components/organizer/match-history-player-filter.tsx` | Controlled searchable list — `<input>` + `<ul>` of `<button aria-pressed>` (swap-sheet pattern, NOT a combobox) |
| Panel integration | `src/components/organizer/match-history-panel.tsx` | Adds `selected` state, `playerOptions` + `visibleMatches` memos, reconcile effect, active-filter chip, highlight rings, safety-net empty state, legend |

**Filtering mechanics:**
- `filterMatchesByPlayer(matches, id)` — null id returns the same array reference (identity, zero re-renders); otherwise filters by roster membership.
- `derivePlayerOptions(matches)` — deduplicates by `player_id`, alpha-sorts by `display_name`, attaches a `player_id.slice(-4)` disambiguator when two players share the same display name.
- `resolvePartnerIds(match, id)` — returns teammate `player_id`s (same team, different id) for the selected player in a single match.
- `selectionStillValid(matches, id)` — checks raw `matches` roster (NOT derived `playerOptions`). Used to detect stale selections after identity merges or score reverts.

**Selection lifecycle:**
- Pinned `selected: { id: string; display_name: string } | null` state — name captured at select time so the active-filter chip stays correct even if the player's profile vanishes from `playerOptions` on a realtime refetch.
- **Conservative reconcile:** if `selectionStillValid` returns false (player gone from all rosters), the filter chip stays visible with a safety-net empty state — never auto-cleared. The organizer dismisses via ✕. This is intentional for score-revert via `FixRecordSheet` which temporarily removes a match from history.
- **Two cancel paths handled correctly:** organizer-cancel retains all `match_players` rows (player appears in filtered history). Leave-triggered cancel deletes the leaver's row first — they do NOT appear in the match's roster.

**Highlight encoding (when a filter is active):**
- `●` Selected player: `bg-cc-accent-dim outline outline-1 outline-cc-accent/55` (solid ring, both completed and cancelled branches).
- `○` Partner: `outline outline-1 outline-dashed outline-cc-accent/55` (dashed ring, both branches).
- Cancelled branch: ring uses `outline-2` (heavier) because the player area is inside an `opacity-60` wrapper — thicker ring reads through the dimming.
- Legend renders below the cards when filter is active: `◍ solid = selected · ◌ dashed = partner`.

**Access control:** `MatchHistoryPlayerFilter` is rendered only inside `MatchHistoryPanel` which lives in the `src/components/organizer/` subtree. Player-facing components (`PlayerDashboard`, `match-history.tsx`) do not import anything from this subtree — organizer-only by structural exclusion, no runtime checks needed.

---

## 4. UI/UX Conventions (Impeccable Standards)

### 4.1 Design System — "Court Nights" Theme

**Philosophy:** Electric, competitive, readable from arm's length in a loud gym. Feels like a live sports broadcast / F1 timing screen — not a hospital portal. Two visual contexts co-exist: **player view** (clean, airy, legible) and **organizer command-center** (tactical dark, teal-lit, geometric).

#### Font Stack — 4 typefaces, 4 roles

All loaded via `next/font/google` and exposed as Tailwind utility classes. Inter OpenType features `cv01 cv02 ss01` are enabled globally.

| CSS variable     | Tailwind class | Typeface                            | Role                                              | Scope                                                                                                             |
| ---------------- | -------------- | ----------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--font-sans`    | `font-sans`    | **Inter** 400–900                   | Body text, UI labels, Sonner toasts               | All routes                                                                                                        |
| `--font-display` | `font-display` | **Barlow Condensed** 700–900 italic | Hero numerals, rank numbers, leaderboard headings | All routes                                                                                                        |
| `--font-mono`    | `font-mono`    | **JetBrains Mono** 400–800          | Stats, metadata pills, monospace labels           | All routes                                                                                                        |
| `--font-command` | `font-command` | **Chakra Petch** 400–700            | Organizer tab nav, card labels, badges            | `/organizer/*` only — scoped via `src/app/organizer/layout.tsx` so the preload hint is never sent to player pages |

#### Color Space — OKLCH (perceptually uniform)

All tokens use `oklch(L C H)` — L = lightness 0–1, C = chroma, H = hue angle 0–360. A `@supports not (color: oklch(0 0 0))` block in `globals.css` provides sRGB hex fallbacks for Safari < 15.4 and old Android WebViews (zero cost on modern browsers).

#### Semantic tokens — Light mode (`:root`)

```css
--background:            oklch(0.96 0.006 245)  /* canvas / page floor */
--foreground:            oklch(0.12 0.018 245)  /* primary text */
--card:                  oklch(1 0 0)  /* card surface */
--primary:               oklch(0.55 0.16 155)  /* emerald — in-queue, success */
--primary-foreground:    oklch(1 0 0)  /* text on primary */
--accent:                oklch(0.68 0.17 62)  /* amber — on-deck, urgency */
--accent-foreground:     oklch(0.12 0.018 245)  /* text on accent */
--muted:                 oklch(0.93 0.008 245)  /* subtle surface */
--muted-foreground:      oklch(0.46 0.014 245)  /* secondary text */
--border:                oklch(0.86 0.01 245)  /* dividers, card outlines */
--destructive:           oklch(0.55 0.22 22)  /* danger, cancel */
--command:               oklch(0.55 0.16 188)  /* organizer teal accent */
```

#### Semantic tokens — Dark mode (`.dark`)

```css
--background:            oklch(0.07 0.012 245)  /* canvas / page floor */
--foreground:            oklch(0.96 0.005 245)  /* primary text */
--card:                  oklch(0.1 0.014 245)  /* card surface */
--primary:               oklch(0.76 0.17 155)  /* emerald — in-queue, success */
--accent:                oklch(0.78 0.17 62)  /* amber — on-deck, urgency */
--muted:                 oklch(0.14 0.016 245)  /* subtle surface */
--muted-foreground:      oklch(0.56 0.012 245)  /* secondary text */
--border:                oklch(0.18 0.018 245)  /* dividers, card outlines */
--destructive:           oklch(0.65 0.2 22)  /* danger, cancel */
--command:               oklch(0.79 0.18 188)  /* organizer teal accent */
```

#### Organizer Command-Center Token Namespace (`cc-*`)

All organizer views consume a separate `cc-*` namespace — surfaces, borders, and accents that switch automatically with light/dark via `:root` / `.dark`. Exposed to Tailwind as `bg-cc-bg`, `border-cc-border`, `text-cc-accent-text`, etc.

| Token              | Light                         | Dark                          | Purpose                       |
| ------------------ | ----------------------------- | ----------------------------- | ----------------------------- |
| `--cc-bg`          | `oklch(0.94 0.010 235)`       | `oklch(0.14 0.018 238)`       | Panel base surface            |
| `--cc-bg-2`        | `oklch(0.99 0.005 235)`       | `oklch(0.19 0.020 238)`       | Card surface                  |
| `--cc-bg-3`        | `oklch(0.91 0.014 235)`       | `oklch(0.23 0.022 240)`       | Header / raised section       |
| `--cc-border`      | `oklch(0.80 0.022 235)`       | `oklch(0.30 0.025 240)`       | Standard border               |
| `--cc-border-hi`   | `oklch(0.65 0.030 235)`       | `oklch(0.44 0.032 240)`       | Emphasized border             |
| `--cc-accent`      | `oklch(0.50 0.18 188)`        | `oklch(0.79 0.18 188)`        | Teal text / icon              |
| `--cc-accent-dim`  | `oklch(0.50 0.18 188 / 0.10)` | `oklch(0.79 0.18 188 / 0.14)` | Tinted bg tint                |
| `--cc-accent-glow` | `oklch(0.50 0.18 188 / 0.18)` | `oklch(0.79 0.18 188 / 0.28)` | `drop-shadow()` glow value    |
| `--cc-amber`       | `oklch(0.58 0.18 62)`         | `oklch(0.78 0.17 62)`         | In-progress / mixed-level     |
| `--cc-deck-border` | `oklch(0.50 0.18 188 / 0.40)` | `oklch(0.79 0.18 188 / 0.50)` | Published on-deck card border |
| `--cc-t1/t2/t3`    | dark-text scale               | light-text scale              | Layered text hierarchy        |

**Geometry utilities** (defined in `globals.css`): `.clip-cut` (18px chamfer polygon on TR + BL), `.clip-cut-sm` (10px), `.clip-cut-badge` (6px single top-right corner), `.cc-corner-accent` (top-left teal L-bracket pseudo-element), `.cc-scan` / `.cc-scan-slow` (drift-down teal shimmer pseudo-element, composited `top` animation).

#### Key components added in the revamp

**`StadiumLeaderboard`** (`src/components/leaderboard/stadium-leaderboard.tsx`)
Six-region asymmetric podium layout — readable at arm's length. Regions: (1) Header — Barlow Condensed `clamp(34px,11vw,52px)` italic "LEADERBOARD" + amber player count; (2) YOU strip — amber gradient tint row; (3) Podium — `[#2 left][#1 center+taller with ghost watermark + lightning bolt][#3 right]` using `clamp` rank numerals; (4) Column header grid `34px 1fr 30px 64px 52px 26px`; (5) Tail rows 4-N. Replaces the old `LeaderboardTable` for all three variants (player-panel, organizer-panel, standalone).

**`WaitlistTab` — sporty scoreboard** (`src/components/player/waitlist-tab.tsx`)
Live standings board aesthetic (F1 timing screen). Zero-padded Barlow Condensed italic rank numbers (`01`, `02`…). JetBrains Mono GP stats column. BEG/INT/ADV text abbreviations — no pill badges. "You" row renders on electric indigo canvas `oklch(0.55 0.24 270)` with white text. Top-4 positions colored `text-primary` (emerald), tail fades to `text-muted-foreground/35`. Dividers only between rows (no zone labels). Updates in real-time via Supabase subscription.

---

### 4.2 Color Semantic Language

| Color                 | Meaning                                       | Never use for anything else |
| --------------------- | --------------------------------------------- | --------------------------- |
| Emerald               | Available / success / confirmed               |                             |
| Amber                 | Pending / warning / mixed-level               |                             |
| Red / Destructive     | Danger / cancel / remove                      |                             |
| Slate / Muted         | Neutral / secondary text                      |                             |
| Sky                   | Team A identity (on court cards)              |                             |
| Amber (team)          | Team B identity (on court cards)              |                             |
| Cyan (`--court-cyan`) | Court lines, net, structural accents          |                             |
| Lime (`--court-lime`) | Player name pills in active court (dark mode) |                             |

---

### 4.3 Typography Hierarchy

| Element                                   | Class pattern                                                         | Font             |
| ----------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| Display hero (leaderboard, waitlist rank) | `font-display font-black italic uppercase`                            | Barlow Condensed |
| Section / card headings                   | `font-sans text-base font-semibold`                                   | Inter            |
| Section labels / metadata                 | `font-mono text-[10px] uppercase tracking-[0.20em]`                   | JetBrains Mono   |
| Organizer command labels                  | `font-command text-[11px] uppercase tracking-[0.16em]`                | Chakra Petch     |
| Body / UI labels                          | `text-sm` — minimum 14px, never smaller                               | Inter            |
| Score / stat numbers                      | `font-mono text-3xl font-black tabular-nums`                          | JetBrains Mono   |
| GP / win% stats                           | `font-mono tabular-nums` always — prevents jitter on Realtime updates | JetBrains Mono   |
| Badges / tags                             | `text-xs font-medium`                                                 | Inter            |

---

### 4.4 Spacing Conventions

- Use Tailwind's 4pt scale: `p-1` (4px), `p-2` (8px), `p-3` (12px), `p-4` (16px), `p-6` (24px), `p-8` (32px).
- **Consistent card padding:** `p-4` for standard cards; `p-3` for compact queue rows.
- **Touch targets:** Minimum `min-h-[44px]` on all interactive elements — the dashboard is primarily used courtside on an iPad.
- **Section separation:** `gap-4` between sibling cards; `space-y-3` for vertical list items.

---

### 4.5 The "No Box-in-a-Box" Rule

> **Never nest a card inside another card.**

- Cards (`rounded-lg border bg-card`) are top-level containers. Content inside them uses spacing and dividers, never another bordered card.
- Queue rows, match player slots, and history items are list items — they use `border-b` dividers and hover states, not wrapped card components.
- The only exception: score modal (Dialog) contains input boxes — but those are form inputs, not cards.

---

### 4.6 Anti-Pattern Prohibitions

These are hard bans — never reintroduce:

| Pattern                                                        | Why banned                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Gradient CTAs (`bg-gradient-to-r from-X to-Y` on buttons)      | #1 AI slop signal — breaks visual credibility                                         |
| Neon glow on non-VIP elements                                  | `dark:[text-shadow:...]` on ordinary elements is wasteful; reserved for VIP tags only |
| `border-left: 4px solid` accent stripe on cards/list items     | Overused dashboard pattern — never intentional                                        |
| Gradient text (`bg-clip-text + gradient`) for non-VIP elements | Reserved exclusively for VIP holo effect                                              |
| Glassmorphism (`backdrop-blur` cards)                          | Not in the design language                                                            |
| Pure black / pure white                                        | Always tinted — dark mode text is `hsl(220 12% 92%)`, not `#FFF`                      |
| DevTools in production                                         | `DevTools` component must be wrapped in `process.env.NODE_ENV === "development"`      |

---

### 4.7 Animations & Transitions

- **State changes:** `transition-colors duration-200` — always, on every interactive element.
- **Show/hide:** Fade + slide via Tailwind animation utilities or Radix's built-in transitions. Never instant.
- **Score / leaderboard flash:** `data-flash="true"` attribute → `leaderboard-flash` keyframes (amber glow to transparent, 800ms).
- **Session Wrapped intro:** 9-layer CSS animation sequence — all using `transform` + `opacity` only (except the `wi-word` color flash which is intentional). See `globals.css` for keyframe definitions.
- **VIP shimmer:** `vip-holo-shimmer` keyframes animating `background-position` — light mode only.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` collapses all durations to `0.01ms` globally — zero exceptions.
- **Duration guideline:** Micro-interactions: 150–200ms. State transitions: 200–300ms. Entrance animations: 300–600ms. Nothing exceeds 800ms except the Wrapped sequence.

---

### 4.8 Component Patterns

**Empty states:**
Follow the `match-history-panel.tsx` pattern: centered icon in `rounded-full bg-slate-100 dark:bg-muted` + heading + subtext. Never just "No items."

**Destructive actions:**
Always wrapped in `AlertDialog` with explicit cancel + confirm. The only exception is cancel-match which uses a two-step inline confirmation (to avoid modal on a time-sensitive courtside action).

**Loading states:**
`disabled:opacity-50 disabled:cursor-not-allowed` on every interactive element — no exceptions.

**Skill badge (`src/components/ui/skill-badge.tsx`):**

- Light: `bg-{color}-100 text-{color}-800`
- Dark: `dark:bg-{color}-900/40 dark:text-{color}-300`
- 6 distinct colors: Beginner → emerald, Lower Intermediate → teal, Intermediate → blue, Upper Intermediate → indigo, Lower Advanced → purple, Advanced → rose

**Skill badge — 6 distinct levels required:**
Never collapse to a 3-bucket system. Each of the 6 enum values must render in its own distinct color to avoid amber collision between levels.

---

## 5. Realtime Architecture

**File:** `src/hooks/use-organizer-data.ts`

Seven channels per organizer session — 5 health-monitored + 2 ancillary:

**Health-monitored (contribute to `realtimeConnected` indicator):**

1. `courts` — court status / name changes
2. `queue_entries` — player queue changes (via `v_queue_with_wait_time` view refresh)
3. `matches` — match status changes
4. `match_players` — roster changes (swap, manual assignment)
5. `profiles` — skill override / display name changes (triggers queue + match re-fetch)

**Non-health ancillary:** 6. `session-settings:{sessionId}` — sessions table UPDATE filtered to this session. Handles `court_time_limit_minutes` changes. **Intentionally excludes `is_auto_matchmaking_on`** — sessions RLS SELECT only grants access to the session creator, so co-organizer postgres_changes events are silently dropped. The toggle is synced via broadcast instead. 7. `session-events:{sessionId}` (broadcast) — ephemeral server-to-client messages: `organizer_intervention`, `session_closed`, `auto_matchmaking_toggled`, `cap_saturation`. Handled by `useOrganizerBroadcast` (player side) and inline in `useOrganizerData` (organizer side).

**Ref-based callback pattern:** All fetch functions stored in refs (`fetchCourtsRef`, `fetchQueueRef`, etc.). Subscriptions capture the ref, not the function value. This prevents the `useEffect` that wires subscriptions from re-running on every state update — channels stay stable.

**`courtsRef`:** Courts stored in both React state and a ref. `fetchActiveMatches` reads `courtsRef.current` to break the dependency chain that would otherwise rebuild all 5 channels on every court update.

**Monotonic sequence counter (`fetchActiveMatchesSeq`, `fetchQueueSeq`):** Each fetch call increments a counter; only the highest-sequence result is applied. Discards stale concurrent responses from race conditions.

**Page visibility refresh:** `use-visibility-refresh.ts` — triggers a data refresh when the tab regains focus (handles mobile app-switch scenarios where Realtime may have missed events).

---

## 6. Architectural Patterns & Rules

### Server Action Convention

- All mutations: `"use server"` in `src/app/actions/`.
- Return shape: `{ success: boolean; message: string; error?: string }` — never throw.
- Auth check always first: `getUser()` via RLS client → `isSessionOrganizer()` → then proceed.
- DB reads/writes via `createServiceClient()`.
- **UUID validation always before DB call**: `isValidUUID(id)` guard on every incoming UUID parameter.

### dnd-kit Isolation

Two guards required on every interactive element inside a draggable container:

```tsx
data-no-dnd="true"                          // on the element
onPointerDown={(e) => e.stopPropagation()}   // on the element
```

Missing either guard causes dnd-kit to intercept clicks on buttons, checkboxes, and inputs.

### TypeScript Convention

- **All DB row types must be `type` aliases, never `interface`.** Supabase's generic system requires sealed types.
- Leaderboard-specific types live in `src/types/leaderboard.ts` (separate from `database.ts` to keep the DB file focused).
- Every table/view entry in `Database` type must include `Relationships: []`.
- `tsc --noEmit` is the authoritative type check — IDE errors can lag.

### Service Client Rule

Any cross-user write (swap, matchmaking, match end/cancel, session close) must use `createServiceClient()`. The primary organizer (`sessions.created_by`) has no `session_organizers` row — write-side RLS silently returns 0 rows for them if the RLS client is used.

### PostgREST Gotchas

- `UPDATE` matching 0 rows returns an **empty array**, not null. Using `.single()` on it throws. Use array + length check for atomic CAS guards.
- `INSERT` with `.select().single()` is safe — always returns exactly one row or an error.

### Null-guard on Draft Functions

`snakeDraft()` and `rotatedDraft()` return `null` when `MAX_PARTNERSHIP_REPEATS` cap prevents every possible team split. All callers must null-guard and treat `null` as a slot failure.

---

## 7. Testing

### Unit Tests (Vitest)

- **Location:** `tests/unit/`
- **Run:** `npm run test:unit`
- **Scope:** Pure logic only — no DB, no network.

| File                            | Covers                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `matchmaking-core.test.ts`      | `computePriorityScore`, `scoreCandidates`, `buildCombinationGroup`, `snakeDraft`, `rotatedDraft`, `isDiversityViolation` — regression suite |
| `matchmaking-engine.test.ts`    | Full engine flow integration (mocked DB), anti-repeat, Red Zone, partner cap                                                                |
| `session-simulation.test.ts`    | Multi-round session simulations — 30-player load, diversity saturation                                                                      |
| `queue-actions.test.ts`         | Queue join/leave/rejoin guards, ghost re-queue prevention                                                                                   |
| `match-origin-tracking.test.ts` | `origin` enum transitions — `auto` → `modified`, stickiness of `manual`                                                                     |

### E2E Tests (Playwright)

- **Location:** `tests/e2e/`
- **Run:** `npm run test:e2e`
- **Target:** Live Vercel deployment — **not localhost**.
- **Auth bypass:** Header `x-vercel-protection-bypass: {VERCEL_BYPASS_SECRET}` injected in `playwright.config.ts`.
- **Sandbox safety (teardown.ts):** Two hard guards before any DELETE: `TEST_SESSION_ID` env var must be defined AND `sessions.name` must start with `"🤖 E2E SANDBOX"`.
- **Locator best practice:** Scope to dialog/container — `page.getByRole("dialog").getByText("E2E_Alice")` not `page.getByText("E2E_Alice")` (names can appear in Sonner toasts).

| Scenario               | File                                           | Covers                                                                                                         |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A — Swap               | `scenario-a-swap.spec.ts`                      | Bench→on-deck swap, undo, player unavailable error                                                             |
| B — Engine flows       | `scenario-b-engine-flows.spec.ts`              | Auto-matchmaking ON→draft approval banner; draft NOT appearing for soft gate; Red Zone mixed-level draft       |
| C — Tap-to-Swap v2     | `scenario-c-tap-to-swap-v2.spec.ts`            | Cross-match direct player swap, 11 test cases                                                                  |
| D — Wrapped dismiss    | `scenario-d-session-wrapped-dismiss.spec.ts`   | Intro overlay dismiss, `intro_dismissed_at` persisted                                                          |
| E — Match alert UI     | `scenario-e-match-alert-ui.spec.ts`            | Player match alert card rendering with VIP tags                                                                |
| F — Court time alert   | `scenario-f-court-time-alert.spec.ts`          | Timer warning when court exceeds `court_time_limit_minutes`                                                    |
| G — H2H records        | `scenario-g-h2h-records.spec.ts`               | H2H strip appears after first meeting, counts correctly                                                        |
| H — Diversity          | `scenario-h-diversity.spec.ts`                 | Anti-repeat enforcement, rotated draft cycling                                                                 |
| I — 50-player sim      | `scenario-i-fifty-player-simulation.spec.ts`   | Full session sim with 50 E2E_ bots, Groups 1-11; large-pool queue priority, concurrent courts, games_played    |
| J — Drafted status     | `scenario-j-drafted-status.spec.ts`            | "Match Forming" card, drafted→on_deck Realtime transition                                                      |
| K — Auth/login         | `scenario-k-auth-login.spec.ts`                | Anonymous page access, organizer login, reconnect modal                                                        |
| L — Session mgmt       | `scenario-l-session-management.spec.ts`        | Add court; auto toggle + DB state verified; close session cascades (matches cancelled, queue drained)          |
| M — Player queue       | `scenario-m-player-queue.spec.ts`              | Queue position number, "in line" status UI                                                                     |
| N — Leaderboard        | `scenario-n-leaderboard.spec.ts`               | Tab accessible; data after completed match; DB ordering (2 wins > 1 win via `v_session_leaderboard`)           |
| O — Player scoring     | `scenario-o-player-scoring.spec.ts`            | Score form visible; submit asserts exact scores `completed\|21\|15` and `games_played=1`                       |

### Integration Tests (Vitest — live Supabase)

- **Location:** `tests/integration/`
- **Run:** `npm run test:integration`
- **Scope:** Real DB + real server actions via `createServiceClient()`. Auth mocked via `mockAuthAs(userId)` in `tests/integration/helpers/mock-auth.ts`. Each test file uses `afterEach(() => truncateTracked())` for isolation.

| File                       | Suite | Covers                                                                                                                          |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auth.real.test.ts`        | —     | Supabase auth API integration                                                                                                   |
| `close-session.test.ts`    | B     | `closeSession`: co-org access, idempotency, match cancellation, queue drain, wrapped stats computation                          |
| `concurrency.test.ts`      | D     | 5 concurrent publish calls; 5 concurrent engine runs; concurrent `callNextMatch` — each produces exactly one match              |
| `drafted-status.test.ts`   | —     | Drafted queue status transitions                                                                                                 |
| `manual-and-swap.test.ts`  | M     | `createManualMatchAction` origin/auth/rejection; swap origin sticky rules (`auto→modified→manual`)                              |
| `match-update.test.ts`     | —     | Score edit and match revert flows                                                                                                |
| `matchmaking.test.ts`      | —     | Engine integration against real DB                                                                                               |
| `performance.test.ts`      | —     | Engine timing benchmarks                                                                                                        |
| `player-checkout.test.ts`  | Q     | `checkoutPlayer`: happy path, unauthenticated rejection, UUID validation, checkout while on_deck/playing, draft cleanup, idempotency |
| `player-pause.test.ts`     | P     | `togglePlayerPause`: pause/unpause, `games_played`+`joined_at` invariant, non-organizer rejection, UUID validation              |
| `publish-match.test.ts`    | —     | `publishMatchAction` BUG-001 (ON_DECK_WARNING timing) and BUG-002 (stale-player guard)                                          |
| `queue-join.test.ts`       | —     | `joinQueueAction` inherited-games floor, re-join paths                                                                          |
| `rls-edge-cases.test.ts`   | E     | Cross-session auth isolation, unauthenticated access blocks                                                                     |
| `rpc-behaviors.test.ts`    | —     | `create_match_with_players` TOCTOU guards, NULL return contract                                                                 |
| `schema-parity.test.ts`    | —     | DB schema matches `src/types/database.ts` type definitions                                                                      |
| `score-submission.test.ts` | F     | `endMatchAction` cascade (scores, re-queue, court freed); `cancelMatchAction` (no games_played increment); **server-side score range validation (0–31 int, rejects float/negative/over-31, rejects draws)** |
| `session-lifecycle.test.ts`| K     | `createSession` validation; `joinAsCoOrganizer` passcode auth and idempotency                                                   |

### Test Helpers & Fixtures

- `tests/helpers/teardown.ts` — `resetSandboxSession()`, `softResetSandboxSession()`, `seedSession()`, `repairSandboxState()` — sandbox lifecycle. `repairSandboxState()` is called automatically at the start of `softResetSandboxSession` (Step 0) to heal any stuck state left by a previous crashed test run — cancels orphaned matches, returns stuck players to `waiting`, frees stuck courts.
- `tests/helpers/admin-db.ts` — Service-role client for test assertions
- `tests/fixtures/auth.ts` — Organizer bot sign-in via cookie injection, `ORGANIZER_STORAGE_STATE` path
- `tests/fixtures/seed-sandbox.ts` — **Run with `npx tsx`** — idempotently seeds all 50 E2E_ bot players + 6 courts into the live sandbox session (`TEST_SESSION_ID`). Reads `.env.test` + `.env.local`. Safe to re-run.
- `tests/integration/factories/index.ts` — `makeProfile`, `makeSession`, `makeQueueEntry`, `makeCourt`, `makeMatch` — composable DB factories for integration tests
- `tests/integration/helpers/mock-auth.ts` — `mockAuthAs(userId)` / `clearMockAuth()` — per-test auth identity control
- `tests/integration/helpers/truncate.ts` — `truncateTracked()` — deletes all rows and auth users created during a test

---

## 8. File Map

```
src/
  app/
    actions/
      auth.ts          # signInAnonymously, signOut, playerLogOut, reconnectPlayer, getCurrentProfile
      dev.ts           # Dev-only actions (seed data, reset state)
      h2h.ts           # getH2HRecord — calls get_h2h_record RPC
      leaderboard.ts   # getSessionLeaderboard, getAllTimeLeaderboard, getPlayerStats
      _shared.ts       # getAuthenticatedUser(), isSessionOrganizer() — used by all organizer actions
      match-lifecycle.ts # submitMatchScore, endMatchAction, cancelMatchAction, updateMatchDetails,
                       #   createManualMatchAction
      match-drafts.ts  # clearOnDeckMatch, reorderOnDeckMatches, publishMatchAction,
                       #   publishAllDraftMatchesAction
      matchmaking.ts   # callNextMatch, runEngineForSession, runEngineInternal, promoteOnDeckMatchInternal
      notifications.ts # sendPlayerNotification — Web Push via VAPID
      profile.ts       # updatePlayerSkill, getPlayerPin, resetPlayerPin, updatePlayerPin
      queue.ts         # joinQueueAction, checkoutPlayer, togglePlayerPause
      sessions.ts      # createSession, joinAsCoOrganizer, toggleAutoMatchmaking, updateSessionSettings,
                       #   closeSession
      swap-player.ts   # swapPlayerInMatch (bench→deck), swapMatchPlayers (cross-match v2)
      tv.ts            # getTvSession, getTvMatches — service-role, no auth required
      wrapped.ts       # dismissWrappedIntro

    leaderboard/
      page.tsx                   # All-time leaderboard
      [sessionId]/page.tsx       # Session leaderboard

    organizer/
      page.tsx                   # Organizer landing — session auto-discovery
      [sessionId]/page.tsx       # Organizer dashboard route

    play/
      page.tsx                   # Player lobby — session list
      join/page.tsx              # QR-code entry point (/play/join?session=)
      [sessionId]/page.tsx       # Player view route

    sandbox/                     # Dev-only UI preview pages (env-gated)
      active-courts-grid/page.tsx
      dashboard-cards/page.tsx
      match-origin/page.tsx
      player-alert/page.tsx

    tv/
      [sessionId]/page.tsx       # TV scoreboard (server component initial fetch)
      [sessionId]/tv-board.tsx   # TV scoreboard client component (Realtime updates)

    vip-preview/page.tsx         # Dev-only VIP tag preview
    offline/page.tsx             # PWA offline fallback
    wrapped/
      preview/page.tsx                        # Wrapped preview (dev/sandbox)
      [sessionId]/[playerId]/layout.tsx       # Wrapped layout shell
      [sessionId]/[playerId]/page.tsx         # Wrapped awards page

    globals.css                  # Design tokens, keyframes, reduced-motion
    layout.tsx                   # Root layout — font, theme provider, Serwist
    manifest.ts                  # PWA web app manifest
    page.tsx                     # Root — auto-routes authenticated users to active session
    middleware.ts                # Next.js middleware — auth session refresh

  components/
    organizer/
      organizer-dashboard.tsx    # Shell, tab nav (courts/queue/monitor/history/leaderboard)
      organizer-entry.tsx        # Passcode gate / session picker for additional organizers
      active-courts.tsx          # Court cards, TeamsGrid, ScoreModal trigger, CourtTimeAlert
      on-deck-panel.tsx          # Pending match cards, swap flow, publish controls, H2HStrip
      score-modal.tsx            # Score entry dialog (single / best-of-3 / best-of-5)
      queue-control.tsx          # Player queue table, manual match creation, pause, dnd-kit
      wait-time-monitor.tsx      # Bottleneck monitor (wait ≥ BOTTLENECK_THRESHOLD_MINUTES)
      match-history-panel.tsx    # Completed match history with edit/undo score + Fix Player Record trigger
      fix-record-sheet.tsx       # Historical roster correction Sheet — amber accent, 2-step flow (pick out → pick in)
      h2h-strip.tsx              # Compact head-to-head record strip for on-deck cards
      swap-sheet.tsx             # Radix Sheet — bench player selection for bench→deck swap
      swap-floating-bar.tsx      # Floating cross-match swap picker bar (Tap-to-Swap v2)
      match-roster.tsx           # TeamsGrid component — team identity dots + player pills
      match-origin-tag.tsx       # auto / manual / modified badge
      share-session-dialog.tsx   # QR code + copy link dialog for organizer
      dashboard-cards-preview.tsx # Sandbox preview component
      dev-tools.tsx              # Dev tools panel — env-gated (development only)
      court-card.tsx             # CourtCard — extracted from active-courts.tsx
      sortable-card.tsx          # SortableCard, OverlayCard, CapSaturationNotice — from on-deck-panel.tsx
      edit-match-dialog.tsx      # Score correction + revert-to-active — extracted from match-history-panel.tsx

    player/
      player-dashboard.tsx       # Player view shell (My Status, Live Courts, Waitlist tabs)
      match-alert.tsx            # "Your match is ready" notification card with VIP tags
      on-deck-alert.tsx          # "You're up next" on-deck position card
      queue-toggle.tsx           # Join/leave queue button
      queue-status.tsx           # Queue position + wait time display
      live-courts-tab.tsx        # Live courts view for players
      waitlist-tab.tsx           # Waitlist tab showing all waiting players
      match-history.tsx          # Player's in-session match history
      all-sessions-history.tsx   # Cross-session match history (bottom sheet)
      player-match-alert-preview.tsx # Sandbox preview component
      score-input-card.tsx       # Player score submission card — uses useScoreForm
      my-status-tab.tsx          # MyStatusTab + QueueSubTab — extracted from player-dashboard.tsx

    leaderboard/
      leaderboard-page.tsx       # Leaderboard shell — routes all variants to StadiumLeaderboard
      stadium-leaderboard.tsx    # NEW — asymmetric podium + YOU strip + tail rows (all variants)
      leaderboard-hero-card.tsx  # Always-visible player status strip
      leaderboard-table.tsx      # Legacy sortable table (kept for reference; no longer rendered)
      leaderboard-row.tsx        # Individual leaderboard row with rank flash
      advanced-stats-toggle.tsx  # Show/hide PF/PA/+/- advanced columns

    wrapped/
      wrapped-intro.tsx          # Full-screen 9-layer animated intro overlay
      wrapped-award-card.tsx     # Individual award card (rarity-coded, capture-safe)
      wrapped-shell.tsx          # Thin composer — wraps WrappedStatsCard, WrappedAwardsFeed, WrappedMatchRecap
      wrapped-stats-card.tsx     # Stats summary card — extracted from wrapped-shell.tsx
      wrapped-awards-feed.tsx    # Awards feed section — extracted from wrapped-shell.tsx
      wrapped-match-recap.tsx    # Match recap with inline styles — extracted from wrapped-shell.tsx

    notifications/
      notification-enrollment.tsx # Push notification permission + subscription UI

    ui/
      skill-badge.tsx            # Shared skill level badge (6 distinct colors, light + dark)
      match-timer.tsx            # Court time elapsed / limit indicator
      court-time-popover.tsx     # Organizer time limit setter
      vip-tag.tsx                # VIP tag renderer (neon dark / holo light)
      badminton-court.tsx        # Badminton court SVG graphic
      badge.tsx                  # Shadcn Badge primitive
      theme-toggle.tsx           # Light/dark mode toggle
      alert-dialog.tsx           # Shadcn AlertDialog primitive
      dialog.tsx                 # Shadcn Dialog primitive
      sheet.tsx                  # Shadcn Sheet primitive

    login-form.tsx               # Anonymous auth form (name + skill + 4-digit PIN) with Zod validation
    reconnect-modal.tsx          # PIN reconnect modal — extracted from login-form.tsx
    pwa-nav-bar.tsx              # PWA bottom navigation bar
    session-list.tsx             # Session cards on organizer / player landing pages
    sign-out-button.tsx          # Sign out button
    serwist-register.tsx         # Service worker registration (PWA)
    theme-provider.tsx           # next-themes ThemeProvider wrapper

  hooks/
    use-organizer-data.ts        # Thin composer over 4 sub-hooks — public API unchanged
    use-organizer-courts.ts      # Court state, courtsRef, court CRUD + updateTimeLimit
    use-organizer-queue.ts       # Queue state, profiles, pause/remove, realtime subs
    use-organizer-matches.ts     # Match enrichment, all match + swap actions, realtime subs
    use-organizer-session.ts     # Live session, realtimeConnected, capSaturation, broadcast
    use-enriched-matches.ts      # Shared enrichment hook (organizer + player); includeDrafts param
    use-session-data.ts          # Player-side read-only session state
    use-queue.ts                 # Player's own queue entry + join/leave
    use-player-match.ts          # Player's current match assignment
    use-h2h.ts                   # H2H record fetch + cache
    use-leaderboard.ts           # Leaderboard data fetch + Realtime
    use-match-alerts.ts          # Player match alert state (on-deck + playing)
    use-match-history.ts         # Completed + cancelled match history with realtime refresh
    use-swap-state.ts            # Tap-to-Swap state machine; Layer 2 race guard; bench + direct swap
    use-score-form.ts            # Shared score input state (player + organizer); enforces 0–30 range
    use-organizer-broadcast.ts   # Server broadcast listener (organizer_intervention, session_closed)
    use-visibility-refresh.ts    # Re-fetch on tab focus / app foreground

  lib/
    matchmaking-core.ts          # Pure: computePriorityScore, scoreCandidates, buildCombinationGroup,
                                 #   snakeDraft, rotatedDraft, isDiversityViolation, getEffectiveLookback
    constants.ts                 # All numeric thresholds + SKILL_META (single source of truth for all 6 skill levels)
    vip-config.ts                # VIP_THEMES record — 10 presets, neon + holo configs
    wrapped-awards.ts            # AWARD_META record — all award slugs with emoji/title/subtitle/rarity
    broadcast.ts                 # Server-side REST broadcast helpers (fire-and-forget)
    realtime.ts                  # Supabase channel subscriptions (courts, queue, matches, etc.)
    validate.ts                  # isValidUUID — type-narrowing UUID guard for all server actions
    utils.ts                     # cn(), createUnknownProfile(id) — fallback profile for unknown player IDs
    notifications/
      push-client.ts             # Browser-side push subscription registration
      audio.ts                   # In-app notification audio (louder on Android)
    schemas/
      auth.ts                    # Zod schema for displayName (3–30 chars, letters/numbers/spaces)

  types/
    database.ts                  # All DB types (type aliases only — NOT interfaces)
    leaderboard.ts               # SessionLeaderboardEntry, AllTimeEntry, PlayerStreak types

  utils/supabase/
    client.ts                    # createBrowserSupabaseClient
    server.ts                    # createServerSupabaseClient
    service.ts                   # createServiceClient (service role, bypasses RLS)
    middleware.ts                # Supabase middleware session refresh helper

tests/
  unit/
    matchmaking-core.test.ts     # Pure function regression (priority, scoring, group assembly)
    matchmaking-engine.test.ts   # Full engine flow with mocked DB
    session-simulation.test.ts   # Multi-round simulations (30-player, diversity saturation)
    queue-actions.test.ts        # Queue join/leave/ghost-requeue guards
    match-origin-tracking.test.ts # origin enum transitions and stickiness
    use-score-form.test.ts       # Score validation boundaries (SF-1–8); clearError regression pin
    use-swap-state.test.ts       # Swap state machine (SS-1–10); undo arg reversal pin (SS-7)
    use-match-history.test.ts    # Match history enrichment (MH-1–9); createUnknownProfile fallback
  e2e/
    scenario-a-swap.spec.ts      # Bench→deck swap, undo
    scenario-b-engine-flows.spec.ts # Auto-matchmaking, gate, cap
    scenario-c-tap-to-swap-v2.spec.ts # Cross-match direct swap (11 tests)
    scenario-d-session-wrapped-dismiss.spec.ts # Intro dismiss persistence
    scenario-e-match-alert-ui.spec.ts # Match alert card + VIP tags
    scenario-f-court-time-alert.spec.ts # Court time warning
    scenario-g-h2h-records.spec.ts # H2H strip after first meeting
    scenario-h-diversity.spec.ts # Anti-repeat + rotated draft
    scenario-i-thirty-player-simulation.spec.ts # 30-player load simulation
    scenario-k-auth-login.spec.ts        # Login, reconnect modal
    scenario-l-session-management.spec.ts # Create session, add courts, toggle auto-matchmaking
    scenario-m-player-queue.spec.ts       # Join queue, see position number
    scenario-n-leaderboard.spec.ts        # Leaderboard tab (player + organizer)
    scenario-o-player-scoring.spec.ts     # In-progress score input + submission
  helpers/
    teardown.ts                  # resetSandboxSession(), seedSession()
    init-sandbox.ts              # One-time sandbox session setup
    admin-db.ts                  # Direct DB access for test assertions
  fixtures/
    auth.ts                      # Player auth fixture (anonymous sign-in + queue join)
  README.md                      # Test strategy overview

scripts/
  simulate-engine.ts             # Local engine simulation (no DB) — development/debugging
  reset_database.sql             # Full DB reset script

backups/
  run_backup.py                  # Stdlib-only Supabase backup — run anytime with python3

supabase/migrations/             # Chronological Postgres migrations (20260417 → 20260509)

MEMORY.md                        # Architectural index (dense LLM reference — read before coding)
APP_MANIFEST.md                  # This file — the living document
```

---

## 9. Known Gotchas

1. **Next.js 16 breaking changes** — Do NOT assume Next.js 13/14/15 APIs. Always check `node_modules/next/dist/docs/` first.
2. **`type` not `interface`** for all DB row types — Supabase generics require `type` aliases.
3. **`buildOverlapMap` is async/DB** — lives in `matchmaking.ts`, not in the pure `matchmaking-core.ts`.
4. **`recentRosters` hoisted; `overlapMap` NOT** — `recentRosters` is the same for all anchors in one run. `overlapMap` is anchor-specific and must be called per-tick.
5. **Vercel bypass** — `_vercel_share` tokens do NOT work for Playwright. Only `x-vercel-protection-bypass` header works.
6. **dnd-kit** — `data-no-dnd` attribute + `onPointerDown stopPropagation` BOTH required on interactive children of draggable containers.
7. **Service client for all mutations** — any cross-user write must use `createServiceClient()`. RLS silently returns 0 rows for the primary organizer if you use the RLS client.
8. **`cancelMatchAction` auto-promotes** — cancelling a match auto-promotes the oldest on-deck match and runs the engine. It does not leave the court idle.
9. **Cookie chunking** — `@supabase/ssr` chunks auth tokens at 3180 encoded chars — handle `.0`, `.1` suffixes.
10. **Draft mode blocks `callNextMatch`** — if all pending matches are drafts (`is_published = false`), `callNextMatch` returns `hasDraftsBlocking: true` instead of promoting. Organizer must publish first.
11. **`session_organizers` is append-only** — never DELETE or UPDATE rows. Presence = permission.
12. **`auth.users` trigger** — inserting into `auth.users` auto-creates a `profiles` row via `handle_new_user()`. Do not also insert a profile manually or you'll hit a PK conflict.
13. **`sessions` trigger** — inserting into `sessions` auto-inserts a `session_organizers` row for `created_by` via `handle_new_session()`. Do not also insert an organizer row manually.
14. **`snakeDraft` / `rotatedDraft` return `null`** — when `MAX_PARTNERSHIP_REPEATS` cap blocks every team split. All callers must null-guard; `null` = slot failure, not an error.
15. **Ghost re-queue prevention** — match end/cancel checks `queue_entries.status` before re-queuing. A player with status `left` is NOT re-queued even if they appear in `match_players`.
16. **Active-match re-join guard** — `joinQueueAction` rejects if the player's current queue status is `playing`. Guards against double-queue on rapid re-tap.
17. **UUID validation before all DB calls** — Every server action must call `isValidUUID()` on every UUID parameter before touching Supabase. Malformed UUIDs return early with a clean error.
18. **`signOut()` before `signInAnonymously()`** — reconnectPlayer always signs out first. Skipping this causes a stale session conflict that silently fails the identity migration.
19. **`fix_record_swap_player` does NOT update `player_rivalries`** — The Fix Player Record RPC corrects `match_players`, `player_partnerships`, `queue_entries.games_played`, `matches.is_mixed_level`, and `matches.origin`, but intentionally skips `player_rivalries` (all-time H2H). Rivalries are only used for Session Wrapped awards display, not matchmaking. A correction will show slightly stale H2H data in wrapped awards (e.g. `nemesis_slayer`, `the_dynasty`) for affected players. A future migration can add opponent-delta logic mirroring `_fix_record_partnership_delta`.
20. **Skill level has 6 values** — `upper_beginner` was removed. The enum is: `beginner`, `lower_intermediate`, `intermediate`, `upper_intermediate`, `lower_advanced`, `advanced`. Never reference `upper_beginner` in code or migrations.
21. **`sessions.ts` not `session.ts`** — the actions file is `sessions.ts` (plural). Don't create a `session.ts` duplicate.
22. **`is_auto_matchmaking_on` excluded from postgres_changes** — sessions RLS SELECT only grants access to the row creator. Co-organizers would never receive the UPDATE event. This field is synced exclusively via the `auto_matchmaking_toggled` broadcast. Never try to sync it through the sessions postgres_changes channel.
23. **On-deck match actions are in `match-drafts.ts`, not `matchmaking.ts`** — `clearOnDeckMatch`, `reorderOnDeckMatches`, `publishMatchAction`, and `publishAllDraftMatchesAction` all live in `src/app/actions/match-drafts.ts`. Match lifecycle actions (`submitMatchScore`, `endMatchAction`, `cancelMatchAction`, `updateMatchDetails`, `createManualMatchAction`) live in `src/app/actions/match-lifecycle.ts`. Only the engine logic (`callNextMatch`, `runEngineForSession`) lives in `matchmaking.ts`. The original `match.ts` was split into `match-lifecycle.ts` + `match-drafts.ts` during the Chunks A–D refactoring.
24. **`MAX_AUTO_DRAFTS` replaces the old capacity formula** — `MAX_ON_DECK_MATCHES` and `ON_DECK_LOOKAHEAD` are no longer imported by `matchmaking.ts` (still in `constants.ts` for `simulate-engine.ts`). The live engine uses `slotsAvailable = max(0, MAX_AUTO_DRAFTS − totalPending)` where `totalPending` is a single atomic query counting **all** `pending` matches (published + unpublished). Do not add a separate published/draft count query — that reintroduces the race window.
25. **`create_match_with_players` returns `NULL` on TOCTOU conflict** — `{ data: null, error: null }` from the Supabase JS client means a DB guard fired, not a hard error. Always check `rpcError` and `!matchId` **separately**: `rpcError` = DB error (fail loudly); `!matchId` with no error = graceful slot-skip (log warning, continue). If the RPC is ever changed from `RETURNS uuid` to `RETURNS SETOF uuid`, the `!matchId` detection breaks silently.
26. **`engineRunningFor` Set is process-local only** — it prevents double-runs within a single Node.js process (e.g. two simultaneous queue joins), but is completely ineffective in Vercel serverless where each request may land on a different worker. Cross-process serialization is enforced exclusively by the DB-level TOCTOU guards inside `create_match_with_players` (migration `20260507000000`).

---

## 10. Digital Twin — Interactive Architecture Documentation

**Location:** `digital-twin/` (sibling directory to the main Next.js app)
**URL (dev):** `http://localhost:4321` · **Build:** `cd digital-twin && npm run build`
**Stack:** Astro 5 · Tailwind v4 (CSS-first `@theme {}`) · Mermaid 11 (CDN) · Pagefind · D3 v7 · Shiki

### Purpose

A self-contained, interactive documentation site that visually explains every architectural layer of this codebase. Auto-regenerates `src/data/manifest.json` from live host-app source files via a watched extraction pipeline. Intended as onboarding infrastructure for new contributors and a permanent architectural reference.

### Pages (all live as of 2026-05-09)

| Route         | Phase | What it contains                                                                                                            |
| ------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| `/`           | 1     | Hero, stats, Mermaid system-overview diagram, 7-step onboarding guide, StartHereRail                                        |
| `/database`   | 2     | All 11 tables, 6 enums, 5 views, 14 RPCs with column-level notes                                                            |
| `/actions`    | 3     | 13 action files × exported functions; curated annotations; VS Code deep links                                               |
| `/engine`     | 4     | `runEngineInternal` Mermaid flowchart; interactive priority calculator; partnership-cap visualizer; TOCTOU sequence diagram |
| `/realtime`   | 5     | 7-channel map; ref-callback pattern side-by-side Shiki diff; race-condition demo (vanilla JS)                               |
| `/components` | 6     | D3 force-directed graph (33 nodes, 43 edges, 4 edge types); node inspector side drawer                                      |
| `/flows`      | 7     | 11 Mermaid sequence traces with scrubber + cross-links; Mermaid re-rendered via `window.__mermaid`                          |
| `/glossary`   | 8     | 27 curated gotchas (sourced from this file §9); severity + category filters; Pagefind-indexed                               |
| `/about`      | —     | Plain-English product overview                                                                                              |

### Key Architecture Decisions

**Design system:** OKLCH-first color tokens (`oklch(7% 0.012 245)` base, `oklch(76% 0.17 155)` emerald accent). All colors in `src/styles/global.css` `@theme {}` block. Tailwind v4 CSS-first — no `tailwind.config.js`.

**Data extraction pipeline:**

- `scripts/extract.ts` — TypeScript compiler API (AST-based) reads `src/types/database.ts`, `src/lib/constants.ts`, `src/app/actions/*.ts`. Outputs `src/data/manifest.json` in ~20ms.
- `scripts/watch.ts` — chokidar v4 watches 7 host-app source paths with 200ms debounce.
- Run: `npm run dev:full` (watch + Astro dev) or `npm run watch:extract` standalone.
- `CURATED_GOTCHAS` constant in `extract.ts` provides the 27 gotchas from §9 above into the manifest.

**Pagefind search:** Post-build static index via `pagefind --site dist`. `data-pagefind-body` on main content blocks; `data-pagefind-ignore` on filter controls. Cmd-K palette in `BaseLayout.astro` loads Pagefind lazily via runtime URL construction (`window.location.origin + '/pagefind/pagefind.js'`) to prevent Vite/Rollup from attempting static resolution.

**VS Code deep links:** `vscode://file{HOST_ROOT}/{relPath}` computed at Astro build time via `import.meta.url` + `path.resolve`. Appear in `/actions` card footers and `/components` side drawer. `HOST_ROOT` injected to client via `<script is:inline define:vars={{ HOST_ROOT }}>`.

**D3 component graph (`/components`):** Full D3 v7 force simulation, 4 semantic edge types (renders/prop-drill/realtime/action), zoom-to-fit on simulation end, animated slide-in side drawer.

**Mermaid re-rendering (`/flows`):** `window.__mermaid` exposed by BaseLayout's CDN module script. `/flows` page polls for it (20×80ms), then calls `mermaid.run({ nodes: [el] })` on trace switch. Diagrams defined as template-literal strings in the `TRACES` array.

### Known Dev-Mode Quirk

`<script is:inline define:vars={...}>` followed by a regular `<script>` in the same Astro component can cause Vite module cache invalidation in the dev server if the script tag type is changed mid-session. **Impact:** D3 graph may not render in dev after such changes until `astro dev` is restarted or a cold browser reload is done. **No impact on built output** — `npm run build` always produces the correct static output.

### Build & Dev Commands

```bash
cd digital-twin
npm run dev          # Astro dev server only
npm run dev:full     # Astro dev + file watcher (recommended)
npm run build        # Production build + Pagefind indexing
npm run watch:extract # Re-run extraction on host-app source changes
npx tsx scripts/extract.ts  # One-shot extraction
```

---

## 11. Multi-Tenant (Clubs)

> **STATUS:** Built on branch `feat/multi-tenant` (NOT merged to main, app NOT deployed). The **schema
> is LIVE on prod** (Phase 0 applied + Legacy backfill). The full design lives in `MULTI_TENANT_PLAN.md`
> + `MULTI_TENANT_PHASE2_PLAN.md`; this is the architecture summary.

**Model.** Shared-schema multi-tenancy. New tables `clubs` / `club_members` (role `owner`/`admin`/`member`,
`is_active` soft-offboard) / `club_invites`. Every `sessions` row (and the rivalry/partnership ledgers)
carries a `club_id`. All pre-existing data was absorbed into a fixed **"Legacy" club** (`…0001`), and every
existing player was backfilled as a Legacy member (`supabase/data-fixes/20260630_legacy_club_membership_backfill.sql`).

**Isolation = application layer + RLS on operational tables.** `clubs` and `club_invites` are **RLS
deny-all** (enabled, no policies), so only the service role reads them. `club_members` additionally has a
member-scoped SELECT policy (`club_members_select`: `player_id = auth.uid() OR is_club_member(club_id)`,
added in `20260702000002`) so the browser client can render the club roster/switcher; all writes still go
only through the service-role server actions. Tenant isolation for these tables is enforced in code:
`src/lib/clubs.ts` (server-only read/guard layer —
`getClubBySlug`, `getClubRole`, `requireClubMembership`, `ensureClubMembership`, `resolveSessionClubSlug`,
`getMyActiveClubIds`) + `src/app/actions/clubs.ts` (`createClub`, `createClubInvite`, `acceptClubInvite`).
The *operational* tables that reference a club indirectly (`matches`, `match_players`, `queue_entries`,
`courts`, `session_organizers`, `match_games`) additionally carry real club-scoped RLS as of the 2026-07-01
security audit (see below) — not deny-all, but a genuine `is_session_organizer(...) OR is_<x>_club_member(...)`
check, so a cross-club data leak is closed at the DB layer even if an app-layer guard were ever missed.

**Routing.** All club surfaces live under `/c/[clubSlug]/…` (path builders in `src/lib/club-paths.ts`;
client components self-resolve the slug from the path via `useClubSlug`). Route groups under
`/c/[clubSlug]`: minimal root layout (resolve + 404) · `(app)` = member-gated + chrome (lobby `/c/[slug]`,
`/admin`) · `(full)` = member-gated, no chrome (full-screen `play`/`organizer` dashboards) · **public**
(no gate): `tv`, `join`. Each session route cross-checks `session.club_id === club.id` (404 on mismatch).

**ADD-and-redirect migration.** New club routes re-use the existing PlayerDashboard / OrganizerDashboard /
TvBoard / LoginForm. Legacy `/play/[id]` + `/organizer/[id]` became thin resolve-and-redirect shims (308 →
`/c/<slug>/…`) that **auto-enroll** the requester (same philosophy as QR-join) so no one is stranded behind
the gate. Public boards (`/tv/[id]`, `/leaderboard/[id]`, `/play/join`) stay at root, shareable — **and**,
mirroring the TV board, also get a club-namespaced convenience variant for in-app nav (§11.4 for Wrapped's).

**Onboarding.** QR/`/c/[slug]/join` (+ the `/play/join` back-compat shim → forwards to it): authed users
auto-enroll + queue; fresh scanners register via `signInAnonymously` (a `club_slug` hidden field enrolls
them post-registration). `lookup_active_session` (SECURITY DEFINER, anon-safe) returns `club_slug`.

**Phase 3 — club-scoped leaderboard + Wrapped (DONE, DB live on prod).** The leaderboard now filters by
club. DB layer (additive, backward-compatible): `v_session_leaderboard` + `v_alltime_leaderboard_mat`
gained a `club_id` column (mat view chain, migration `20260701000001`), and the leaderboard RPCs
(`get_alltime_snapshot_before`, `get_player_streaks`, `get_monthly_leaderboard`, `get_leaderboard_months`)
gained an **additive `p_club_id uuid DEFAULT NULL`** (NULL = all-clubs = pre-existing behavior; monthly RPCs
in `20260701000002`). App layer: `src/app/actions/leaderboard.ts` takes an optional `clubSlug` →
`getClubBySlug(slug)?.id` → conditional `.eq("club_id", clubId)` on matview reads + `p_club_id: clubId` on
RPCs; `getPlayerStats`'s all-time branch filters `club_id` **before** `.maybeSingle()` (the matview is now one
row per player per club — an unfiltered `.maybeSingle()` would PGRST116). `useLeaderboard` reads the slug via
`useClubSlug()` (null on root routes) and threads it through (with `clubSlug` in the fetch dep arrays so a club
switch refetches). New member-gated route `c/[clubSlug]/(app)/leaderboard` + a Leaderboard nav link. The
Wrapped/awards engine `compute_session_wrapped` (migration `20260701000003`, File C) club-scopes its two reads
of `v_alltime_leaderboard_mat` (the `alltime_top3` CTE + the `amat` LEFT JOIN → `the_veteran`/`century_club`
inputs) by resolving `v_club_id` from the session. Root/no-slug callers (public boards) pass no slug → all-clubs.

### 11.1 Security audit — club-scoped RLS + credential-leak closure (2026-07-01)

Follow-up audit triggered by the goal of running 2+ real, data-segregated clubs (not just one club in
practice). Found and closed 3 gaps beyond the Phase 3 leaderboard/Wrapped scoping above:

- **Operational-table RLS.** `matches`, `match_players`, `queue_entries`, `courts`, `session_organizers`,
  `match_games` had SELECT policies with no club dimension at all (`qual: true`, or for `matches` an
  organizer/draft-firewall check only) — any authenticated (some: even anonymous) caller could read any
  club's live queue/match/court/organizer data. `supabase/migrations/20260701000008_club_scoped_rls.sql`
  adds 3 `SECURITY DEFINER` SQL helpers mirroring the existing `is_session_organizer` shape —
  `is_club_member(p_club_id)` → `is_session_club_member(p_session_id)` → `is_match_club_member(p_match_id)`
  — and ANDs club membership into every policy, preserving the organizer bypass and the `matches`
  draft-mode PERMISSIVE+RESTRICTIVE firewall (duplicate qual, precedent: `20260506000000_draft_mode_bugfixes.sql`)
  exactly. Verified live via RLS impersonation inside rolled-back transactions: a real club member sees
  full expected data, a non-member sees zero rows across all 6 tables, the session organizer is unaffected.
- **`profiles.pin` exposure via bulk `.select("*")`.** `profiles_select` stays `qual: true` by design
  (leaderboard + Wrapped share page read profiles unauthenticated on purpose), so RLS can't close this —
  it's closed at the column layer instead. `PUBLIC_PROFILE_COLUMNS` (`src/types/database.ts`) is an
  explicit 10-column safe list (no `pin`), used by the 5 client hooks that bulk-fetch other players'
  profiles (`use-enriched-matches.ts`, `use-match-history.ts`, `use-organizer-queue.ts`,
  `use-player-match.ts`, `use-session-data.ts`); results are reconstructed as `{ ...p, pin: null }`. Own-row
  reads and the service-role reconnect lookup are untouched.
- **Realtime broadcast scoping.** `profiles.pin` and `sessions.organizer_passcode` were included in the
  `supabase_realtime` publication's replicated column set, so every UPDATE broadcast the raw secret to all
  subscribers regardless of relevance. `20260701000006_realtime_publication_exclude_secrets.sql` restricts
  each table's publication column list to exclude the secret column.

`getMyActiveClubIds(userId)` (`src/lib/clubs.ts`) was added as a cheaper alternative to `getMyClubs` for
pure membership-scoping, and is now used to fix `/play` and `/organizer`'s session listings (previously
unfiltered — a multi-club user saw every club's session names): both now filter to
`getMyActiveClubIds()`, and `/organizer` disables session creation (pointing to `/clubs` instead) whenever
membership is ambiguous (0 or 2+ clubs) rather than silently defaulting the new session to Legacy.

**Push deep-links are club-scoped.** `pushToPlayers(userIds, type, sessionId?)` (`src/lib/notifications/push-server.ts`)
resolves the session's club via `resolveSessionClubSlug` and deep-links to `/c/<slug>/play/<sessionId>` when
resolvable, falling back to `/clubs` otherwise (never throws — a resolution failure is swallowed). All ~9
call sites across `actions/matchmaking.ts`, `actions/match-drafts.ts`, `actions/match-lifecycle.ts`,
`actions/live-match-swap.ts`, `actions/swap-player.ts`, and `actions/notifications.ts`'s
`sendPlayerNotification` now thread `sessionId` through.

**Deferred:** further E2E spec path updates for `/c/[clubSlug]/...` routes (the 50-player simulation spec's
reconnect-navigation assertion was widened to accept both the flat `/play` path and the club-scoped
`/c/[slug]/play/[sessionId]` redirect target, but the rest of the E2E suite still asserts flat paths only).

### 11.2 Identity-migration club scoping + OAuth club-scoped sign-in (2026-07-01)

Two follow-on gaps from the 11.1 audit, closed the same day:

- **`migrate_player_identity` rivalries/partnerships repoint.** The RPC (called from `reconnectPlayer` when a
  guest profile is merged into a returning player's identity) now repoints `rivalries` and `partnerships` rows
  from the old (guest) profile id to the surviving profile id, mirroring the pre-existing repoint logic already
  applied to `matches`/`match_players`/etc. Previously these two tables were left pointing at the
  now-orphaned guest id, silently losing head-to-head/partner history across a reconnect merge. Migration:
  `migrate_identity_rivalries_partnerships` — confirmed live on prod via `list_migrations`.
- **OAuth sign-in is now club-scoped end-to-end**, mirroring the anonymous sign-in flow's `club_slug` handling:
  - `signInWithGoogle(next?, clubSlug?)` (`src/app/actions/oauth.ts`) appends `&club=${encodeURIComponent(clubSlug)}`
    to the PKCE `redirectTo` URL when a `clubSlug` is provided (e.g. from a `/c/[slug]/join` page).
  - `GoogleSignInButton` (`src/components/auth/google-sign-in-button.tsx`) accepts and threads a `clubSlug` prop
    through to `signInWithGoogle`, alongside its pre-existing `next` prop.
  - `/auth/callback` reads the `club` query param post-consent and enrolls the user via `ensureClubMembership`,
    the same idempotent helper the anonymous flow uses.
  - **Verified live via browser click-through**: triggering the button from `/c/legacy/join` produces a server
    action response of `{"success":true,"url":"...&redirect_to=...%2Fauth%2Fcallback%3Fnext%3D%252Fc%252Flegacy%26club%3Dlegacy..."}`
    — the decoded `redirect_to` is `/auth/callback?next=/c/legacy&club=legacy`, confirming the club is threaded
    through the full PKCE round trip.
- **`isSessionOrganizer` (C6) auto-organizer fallback** (`src/app/actions/_shared.ts`): beyond `created_by` and
  explicit `session_organizers` membership, a user is also treated as the session's organizer if they hold an
  active (`is_active=true`) `club_members` row with `role IN ('owner','admin')` for the session's club. Mirrored
  at the DB level by migration `club_admin_auto_organizer` (confirmed live on prod) so RLS-enforced writes agree
  with the app-layer check.
- **`reconnectPlayer` profile lookup is club-scoped when a `clubSlug` is passed**: joins
  `club_members!club_members_player_id_fkey!inner(club_id)` (explicit constraint name needed because
  `club_members` has two FKs to `profiles`) and filters `club_members.club_id = club.id`, so reconnecting inside
  a specific club only matches that club's members instead of any player display-name/PIN match app-wide.
- **Leaderboard club scoping**: `/leaderboard` (lobby picker) scopes its session list via
  `getMyActiveClubIds(user.id)` (auth is best-effort — never redirects logged-out users, just shows an empty
  picker). `/leaderboard/[sessionId]` (the public share link) intentionally keeps using `createServiceClient()`
  to bypass the club-scoped `sessions_select` RLS policy for a single known-sessionId lookup — the sanctioned
  service-role-for-public-share pattern, same as the TV board and Wrapped share page. Backed by migration
  `scope_sessions_select` (confirmed live on prod).

All of the above was independently reviewed by three separate code-review agent passes (all clean/LGTM) and
personally re-verified by direct file reads against the review reports before being marked done — no
discrepancies found.

### 11.3 Leave-club / member-management (2026-07-01)

**Permission model.** `src/app/actions/clubs.ts` gains `leaveClub`, `removeMember`, `restoreMember`,
`changeMemberRole` (`MemberActionResult = { success: boolean; message?: string }`):
- `removeMember`/`restoreMember`: actor must be `owner` OR `admin`; both reject self-action ("Use the Leave
  club option to remove yourself"); both gate via `canManageTarget(actorRole, targetRole)` — admins may only
  manage plain members, never another admin or the owner. `removeMember` additionally blocks removing the
  club's only owner via the atomic `club_member_deactivate` RPC (see below). `restoreMember` intentionally mirrors `removeMember`'s
  permission shape (an admin-visible "Restore" control on a removed plain member is correct by design, not a
  bug).
- `changeMemberRole`: strictly `owner`-only; the same last-active-owner guard applies to demotions of the
  sole owner.
- `leaveClub`: self-service, any role; blocked with "You're the only owner — promote someone else to owner
  before leaving" when the caller is the club's sole active owner.

**UI.** `src/components/clubs/club-admin-panel.tsx` (admin/owner panel: role `<select>` + remove/restore
per-row, hidden for the actor's own row and for rows the actor can't manage) and
`src/components/clubs/club-list.tsx` (`/clubs` roster: inline Leave with a Yes/No confirm, not a modal).

**Live-verified end-to-end in prod** (fixture club `qa-member-test-club`, three real anonymous PIN accounts —
QA Owner/Admin/Member Test): admin blocked from acting on the owner and on itself; admin remove→restore cycle
on a plain member; owner promote→demote of an admin via `changeMemberRole`; owner's own row shows no manage
controls; owner's self-leave correctly rejected (sole-owner guard); member's genuine self-service leave
succeeds. All fixtures (profiles, `auth.users`, `club_members`, `club_invites`, the test club) deleted after
verification.

**`migrate_player_identity` — two more FK gaps found and fixed via live-testing this feature.** Every time a
new multi-tenant table gets a FK to `profiles.id`, it must be retrofitted into this function's non-fatal
repoint blocks, or the function's final `DELETE FROM profiles WHERE id = p_old_user_id` hard-fails on
reconnect for any player who touched that table. Found two more instances (beyond the pre-existing
`matches`/`match_players`/rivalries/partnerships coverage):
- `club_invites.created_by` / `club_invites.consumed_by` — surfaced when reconnecting as an admin who had
  redeemed a club invite. Fixed by migration `20260701000016_migrate_identity_club_invites.sql`.
- `clubs.created_by` / `club_members.invited_by` — surfaced when reconnecting as the club's original creator
  (`clubs_created_by_fkey` violation). `club_members.invited_by` was found via a full audit (query
  `information_schema.table_constraints`/`key_column_usage`/`constraint_column_usage` filtered to
  `ccu.table_name = 'profiles' AND ccu.column_name = 'id'`, enumerating all 14 FK columns referencing
  `profiles(id)`) rather than triggered live, but is the same bug class. Fixed by migration
  `20260701000017_migrate_identity_clubs_invited_by.sql`.
Both columns are blind two-row `UPDATE ... WHERE col = p_old_user_id` (safe: neither carries a uniqueness
constraint, unlike `club_members.player_id`/rivalries/partnerships which need merge-then-dedupe). Both
migrations applied to prod and live-verified (reconnect succeeds; old profile deleted; FK columns correctly
repointed to the new profile id).

**Two small hardening fixes found by an automated review pass on this feature:**
- `acceptClubInvite` (`src/app/actions/clubs.ts`) now captures and logs the error result of the invite-consume
  `UPDATE` instead of firing-and-forgetting it — purely additive observability, no behavior change (membership
  is already granted earlier in the function, so a consume failure stays non-fatal by design).
- `getMyClubs` (`src/lib/clubs.ts`) had an N+1 query — one `sessions` active-count query per club. Replaced with
  a single batched `sessions.club_id` query grouped in-memory into a `Map<clubId, count>`, run in parallel with
  the `clubs` query. Live-verified with 2 clubs under one profile (one with 0 sessions, one with 2) to prove the
  `Map` groups by `club_id` correctly rather than summing globally — `/clubs` showed no badge on the 0-session
  club and "2 live" on the other.
A third flagged item — `removeMember`'s admin-panel local-state update being "optimistic" — was investigated and
found to be a false positive: `club-admin-panel.tsx`'s `handleRemove` only updates local state inside
`if (result.success)`, strictly after the server action resolves.

**Both follow-ups from this feature's initial ship are now fixed (2026-07-02):**
- **`revalidatePath` scope gap** — `leaveClub` now takes a `clubSlug` param (threaded from `club-list.tsx`'s
  `club.slug`) and revalidates `/c/${clubSlug}` (layout) and `/c/${clubSlug}/admin` in addition to `/clubs`,
  matching the scope already used by `removeMember`/`restoreMember`/`changeMemberRole`.
- **`countActiveOwners` TOCTOU race** — the check-then-act pattern (`countActiveOwners(clubId) <= 1` SELECT,
  then a separate UPDATE) let two concurrent last-owner actions both pass the guard and leave a club with zero
  active owners. Fixed with migration `20260702000000_club_member_atomic_owner_guard.sql`, which adds two
  `SECURITY DEFINER` RPCs: `club_member_deactivate(p_club_id, p_member_id)` and
  `club_member_set_role(p_club_id, p_member_id, p_new_role)`. Both take `pg_advisory_xact_lock(hashtextextended(p_club_id::text, 0))`
  before checking + mutating in one transaction, so any concurrent call touching the same `club_id` fully
  serializes. Both return `jsonb` (`{success, reason}`, reasons: `ok` / `not_found` / `only_owner` /
  `invalid_role` / `no_change`) — matching this schema's existing `jsonb`-returning atomic-RPC convention
  (`join_queue`, `publish_match`, etc.) rather than `RETURNS TABLE`. `leaveClub`, `removeMember`,
  `changeMemberRole` now call these RPCs instead of the old check-then-UPDATE; `restoreMember` is untouched
  (reactivating a member can never reduce the owner count, so it stays an unguarded direct UPDATE). The
  now-fully-dead `countActiveOwners` export was removed from `src/lib/clubs.ts`.
  - **Grant-lockdown gotcha (found live, in prod, via `get_advisors` + a `pg_proc.proacl` ground-truth
    check — NOT caught by the code-review agent, which only read the migration's SQL text):**
    `REVOKE ALL ON FUNCTION ... FROM PUBLIC` + `GRANT EXECUTE ... TO service_role` is **not sufficient** to
    lock a function to `service_role`-only in this project. This Supabase project's schema-level default
    privileges auto-grant `EXECUTE` directly to `anon` and `authenticated` (in addition to `service_role`) on
    every newly created function in `public` — a grant that is independent of, and NOT retracted by,
    `REVOKE ... FROM PUBLIC` (that only revokes the implicit `PUBLIC` pseudo-role grant, not separate named-role
    grants). The original migration left both RPCs callable directly by `anon`/`authenticated` via
    `/rest/v1/rpc/<fn>` for a short window in prod — a real privilege-escalation hole, since these functions
    are `SECURITY DEFINER`, bypass RLS, and do zero actor-authorization checks internally. Fixed immediately
    with a corrective migration, `20260702000001_club_member_atomic_owner_guard_lockdown.sql`:
    `REVOKE EXECUTE ON FUNCTION ... FROM anon, authenticated;` (explicit, named-role revoke) for both
    functions. Re-verified via `pg_proc.proacl`: both now show only `postgres`/`service_role`. **Rule for any
    future service_role-only function in this schema: always follow `REVOKE ALL FROM PUBLIC` with an explicit
    `REVOKE EXECUTE ... FROM anon, authenticated` — the PUBLIC revoke alone is not enough.** (Also: `get_advisors`
    security-lint coverage for this class of issue is incomplete — it didn't flag the pre-existing
    `migrate_player_identity`, which has the same anon/authenticated exposure in its `proacl`; ground-truth
    `pg_proc.proacl` queries are the reliable check, not the advisor alone.)
  - **Functional live-verification (disposable fixtures, zero residue after)**: a 3-member fixture club (2
    owners + 1 plain member) proved all branches — `not_found` (bogus member id), `invalid_role` (bogus role
    string), `no_change` (role set to its current value), a normal deactivate and a normal demote both
    succeeding while ≥2 owners exist, both `club_member_deactivate` and `club_member_set_role` correctly
    returning `only_owner` once only one owner remained, and — after promoting a second owner back — both
    operations succeeding again. Confirms the advisory-lock guard behaves correctly across the full state
    space, not just the happy path.
  - **Pre-existing, out-of-scope finding (not fixed this pass):** `migrate_player_identity` is exposed to
    `anon`/`authenticated` in `pg_proc.proacl` (same class of issue as above) — but it turns out to be
    `SECURITY INVOKER`, not `SECURITY DEFINER` as previously assumed, so the RLS-bypass severity is lower
    (it runs with the caller's own privileges, not the definer's). Worth auditing separately; left untouched
    here since it's out of scope for the owner-guard fix.

### 11.4 Club-scoped Wrapped route (2026-07-02)

**Gap closed.** `MULTI_TENANT_PHASE2_PLAN.md` (step 4 + its redirect-map table) always planned
`/c/[clubSlug]/wrapped/[sessionId]/[playerId]` alongside the TV/Leaderboard club variants, but it was never
built — a dead `clubWrapped()` path builder existed in `src/lib/club-paths.ts` with zero call sites, and every
redirect into Wrapped (session-end, organizer `session_closed` broadcast, offline-reconnect, a misleading code
comment claiming Wrapped "stays root-only like the TV board") pointed at the flat root path only. Root TV does
**not** stay root-only either — it already has both variants — so the comment's premise was false; this was a
real implementation gap, not a documented deviation.

**Fix — dual-path, same pattern as TV/Leaderboard.** New `src/app/actions/wrapped.ts::getWrappedData(sessionId,
playerId)` is a shared server-action data-fetcher (mirrors `getTvData`), always using the service-role client
since Wrapped is a public/shareable recap and the viewer may not be authenticated as the player at all. New
route `src/app/c/[clubSlug]/wrapped/[sessionId]/[playerId]/page.tsx` mirrors the TV club-route structure:
resolves the club via `getClubBySlug` (404 if missing), calls `getWrappedData`, 404s if the profile is missing
or if `sessionClubId !== club.id`. The root `/wrapped/[sessionId]/[playerId]` page now just calls the same
`getWrappedData` instead of inline queries. Every redirect site was updated to prefer the club-scoped path
when a club slug is resolvable, falling back to root otherwise: the club play-page's session-end redirect,
`WrappedShell`'s "Done" button (via `useClubSlug()`, same pathname-derived pattern as `PwaNavBar`),
`useOrganizerBroadcast`'s `session_closed` redirect (via a new `clubSlugRef`, following the hook's existing
`playerIdRef`/`routerRef` ref-stability pattern so the realtime subscription never re-registers on a slug
change), and `reconnectPlayer`'s offline-Wrapped redirect (via `resolveSessionClubSlug`). `PwaNavBar`'s
Wrapped-suppression check widened from `pathname.startsWith("/wrapped/")` to `.includes("/wrapped/")` to also
catch the club-namespaced variant.

**Side-effect bugfix, not just a refactor.** The original root page fetched `session_wrapped_stats` via the
RLS-scoped client; that table's RLS only grants SELECT to the row's own player or a session organizer
(`20260423000000_session_wrapped_stats.sql`), so any third party opening someone else's shared Wrapped link
previously got silently bounced to the empty-stats fallback despite a real stats row existing. `getWrappedData`'s
always-service-role fetch fixes this as a side effect.

**Verified:** `tsc`/`build`/lint clean; independent review verdict **Minor issues, non-blocking** (the stats
RLS behavior change above, called out explicitly so it isn't mistaken for a silent regression; the
`.single()`→`.maybeSingle()` swap confirmed semantically equivalent for the not-found branches). Live-clicked
through both routes against a real prod session (`bcf19499…`, Legacy club): intro overlay + real awards feed
render correctly on both `/wrapped/...` and `/c/legacy/wrapped/...`; nav bar stays suppressed on both; the
"Done" button issues `GET /c/legacy` (confirmed via dev-server request log) on the club route vs `/play` on
root — both then bounce to `/` only because the test session wasn't authenticated (the membership gate doing
its job, not a Wrapped bug). The organizer-broadcast and offline-reconnect redirect sites were verified by
code reading + successful build only, not clicked through live (both require a live session-close/reconnect
event to trigger).

### 11.5 Hardened SECURITY DEFINER views (2026-07-02)

**Gap closed.** Supabase's security advisor flagged 5 views as `SECURITY DEFINER` (owner-privilege,
RLS-bypassing regardless of caller): `v_match_history`, `v_session_leaderboard`, `v_recent_pairings`,
`v_queue_with_wait_time`, `v_queue_full_with_wait_time`. The real risk wasn't the intentionally-public
single-session leaderboard share link — it was that anyone could query these views directly via PostgREST
with **zero filter** and dump every club's complete match history/leaderboard in one request, since RLS on
the underlying base tables never applies to a `SECURITY DEFINER` view.

**Fix — split by actual consumer.** `supabase/migrations/20260702000003_harden_security_definer_views.sql`:
- `v_recent_pairings`, `v_queue_with_wait_time`, `v_queue_full_with_wait_time` → `ALTER VIEW ... SET
  (security_invoker = true)`. Zero risk: every consumer is either a service-role client
  (`matchmaking-db.ts`, `matchmaking.ts::runEngineInternal`) or an RLS-scoped browser client already gated
  by club membership before it ever queries (`use-organizer-queue.ts`, behind `(full)/layout.tsx`'s
  `requireClubMembership()`). `v_recent_pairings` has zero call sites at all today.
- `v_match_history`, `v_session_leaderboard` → kept `SECURITY DEFINER` (the public share-link page needs the
  RLS bypass for genuinely logged-out visitors) but `REVOKE SELECT ... FROM anon, authenticated`, closing
  direct-dump access. Added `get_session_leaderboard_public(p_session_id uuid)` — a new `SECURITY DEFINER`
  RPC with a mandatory scoping param, mirroring the existing `is_club_member`/`is_session_club_member`
  pattern (a parameter can't be omitted the way a `.eq()` filter on a raw view can be).
  `src/app/actions/leaderboard.ts`'s two `v_session_leaderboard` call sites
  (`getSessionLeaderboard`/`getPlayerStats`) now call this RPC instead of `.from(...)`; `get_session_leaderboard_public`'s type added to `src/types/database.ts`'s `Functions` section.

**Side-effect bugfix, caught by re-review, not just a refactor.** `v_match_history` itself needed no
replacement RPC — its only two call sites (`src/app/actions/history.ts`'s `getMatchHistory`/
`getAllSessionsHistory`) were assumed service-role like `wrapped.ts`'s call site, but they actually used the
RLS-scoped `createServerSupabaseClient()`. The grant revoke above broke both in prod immediately (caught by
an independent review pass, not the original build). Fixed by switching both to `createServiceClient()`,
matching `wrapped.ts`'s existing pattern — safe because both functions already gate on `playerId ===
user.id` before querying.

**Verified:** `tsc`/lint/build clean. `get_advisors` (security) re-run post-fix — all 5
`security_definer_view` findings gone. Live-verified `/leaderboard/[sessionId]` still renders full real data
for a genuinely logged-out browser session via the new RPC. Live-verified the dump vector is closed:
`set role anon; select * from v_session_leaderboard` and `set role authenticated; select * from
v_match_history` both now return `permission denied`. Independent review: first pass caught the
`history.ts` regression (Needs fixes); re-review after the fix returned **LGTM**.

**Known follow-up, not yet actioned (needs a scope decision, not a technical blocker):**
`v_alltime_leaderboard_mat` (materialized view) grants full privileges to `anon`/`authenticated` via
`pg_class.relacl` (inherited default privileges, same pattern noted in §11.3) and contains `club_id`-tagged
rows spanning every club. `getAllTimeLeaderboard()` (`leaderboard.ts`) applies `.eq("club_id", clubId)`
client-side only when a `clubSlug` is passed — the legacy root `/leaderboard` route intentionally passes
none, showing an all-clubs combined board by design (pre-multi-tenant behavior, kept for backward compat).
Whether an all-clubs public leaderboard should still exist post-multi-tenant is a product decision, not
purely a security bug — flagged for the user rather than silently changed. Materialized views also can't
carry RLS policies in Postgres, so if the decision is "club-scoped only," the fix mirrors this section's
pattern: revoke direct grants, add a mandatory-`p_club_id` RPC (`get_alltime_snapshot_before` already
exists as the point-in-time-slice sibling and could serve as the exact style template).

### 11.6 Task #56 resolved — `search_path` hardening + remaining advisory triage (2026-07-02)

**Decision (user):** keep `v_alltime_leaderboard_mat`/legacy all-clubs `/leaderboard` behavior as-is — established,
intentional, no fix needed. `rls_enabled_no_policy` on `club_invites`/`clubs`/`player_renames` already accepted as
deny-all-by-design (no action). `auth_leaked_password_protection` (HaveIBeenPwned check) is a Supabase Auth
dashboard toggle, not reachable via migration/SQL — left as a manual to-do for the user, not chased further.

**Fixed — `function_search_path_mutable` (20 functions):** `supabase/migrations/20260702000004_pin_search_path_hardening.sql`,
applied to prod. `ALTER FUNCTION ... SET search_path = public, pg_temp` on all 20 flagged functions (`is_club_member`,
`is_session_club_member`, `is_session_organizer`, `elevate_to_organizer`, `get_h2h_record`,
`compute_session_wrapped`, `migrate_player_identity`, `refresh_alltime_leaderboard`,
`refresh_cross_session_stats`, `get_alltime_snapshot_before`, `get_player_streaks`, `rejoin_queue`,
`toggle_auto_matchmaking`, `handle_new_session`, `set_updated_at`, `skill_level_to_int`,
`clear_all_unpublished_drafts`, `touch_push_subscription_updated_at`, `_fix_record_partnership_delta`,
`is_match_club_member`) — a pure config-parameter pin via `ALTER FUNCTION`, no `CREATE OR REPLACE`, zero risk of
logic drift since function bodies are untouched.

**Verified:** `pg_proc.proconfig` confirms `search_path=public, pg_temp` on all 20 live. `get_advisors` re-run —
`function_search_path_mutable` finding count now 0. Functional smoke: `skill_level_to_int`/`is_club_member`
still execute correctly post-change. Independent review: confirmed zero overloaded function names in `public`
(so no `ALTER FUNCTION` call could have targeted the wrong overload), diffed all 20 signatures 1:1 against
`pg_get_function_identity_arguments` on prod, checked every function body for unqualified cross-schema references
(none found — all `auth.*` calls are schema-qualified, everything else is `pg_catalog`/`public`). Verdict: **LGTM**.

**Task #56 is now fully closed** — every item from the original advisory triage is either fixed, already accepted
by design, or explicitly deferred to the user with a clear reason (dashboard-only setting).

### 11.7 Platform-owner model + club-scoped landing (2026-07-05)

Two privilege tiers, introduced once real onboarding replaced the single-club stopgaps:

- **Platform owner** (`src/lib/platform.ts` `isPlatformOwner`) — sourced from the server-only env var
  `PLATFORM_OWNER_IDS` with a baked-in fallback (the founding owner). Only platform owners may **create or see
  clubs**: `createClub` rejects non-owners server-side, `/clubs` + `/clubs/new` redirect non-owners to `/play`,
  and the club-switcher / `(app)` layout "All clubs" / "New club" links render only for the owner. Non-owners are
  scoped to the club(s) they belong to (cross-club **data** was already walled off by the §11.1 RLS; this adds the
  missing create/manage-capability + UI gate).
- **Primary-club resolution** (`getPrimaryClubSlug` → SECURITY DEFINER RPC `get_primary_club_slug`): the club a
  returning player lands in when they open the app cold (no QR) = their **last-attended session's** club
  (`queue_entries` ordered by `q.joined_at DESC`), else their last-joined active club, else `NULL`. `/play` scopes
  the session picker to this one club (a multi-club player sees the club they last used); `NULL` → the new
  **`/welcome`** join-via-QR screen ("ask your organizer for the QR"). `/welcome` redirects back to `/play` if the
  user actually has a club, so the two converge with no loop.
- **Onboarding:** a QR/invite registrant is enrolled (`ensureClubMembership`) and routed straight to their session
  as before — they never see `/welcome`. The blanket `handle_new_user` auto-enroll into the Legacy/CHILLAX club was
  **retired** (migration `20260705000000`), so a plain-link registrant has no club and lands on `/welcome`. Existing
  members are untouched; `migrate_player_identity` repoints `club_members`, so PIN reconnect preserves membership.
- Non-owner-facing `/clubs` redirects/links were repointed to `/play` throughout (`requireClubMembership`
  non-member bounce, `/play/join` + `/c/[slug]/join` enroll-fail fallbacks, `auth.ts` enroll-fail, the club error
  boundary, and the PWA manifest `start_url`), so a non-owner never round-trips through the owner-only hub.
