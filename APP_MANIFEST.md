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

`src/lib/broadcast.ts` — Server-side REST broadcast helpers (no WebSocket opened from the server). Sends ephemeral messages to topic `"realtime:session-events:{sessionId}"`. Four event types:

- `organizer_intervention` — `{ type: "on_deck_cleared" | "match_cancelled", affectedPlayerIds }` → triggers player-side toast via `useOrganizerBroadcast`.
- `session_closed` — redirects all connected players to `/wrapped/{sessionId}/{playerId}`.
- `auto_matchmaking_toggled` — `{ isOn: boolean }` → syncs auto-matchmaking state to all co-organizers (bypasses the sessions RLS SELECT policy that would silently drop postgres_changes for non-creator organizers).
- `cap_saturation` — `{ affectedPlayerIds, reason }` → fires when `MAX_PARTNERSHIP_REPEATS` blocks every possible team split. Surfaces a `CapSaturationNotice` banner in the on-deck panel so the organizer knows to intervene manually.

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
| `created_at`   | `timestamptz`      |                                                                                 |
| `updated_at`   | `timestamptz`      |                                                                                 |

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
| `refresh_alltime_leaderboard()`                         | Refreshes the materialized view                                                                                                                                                                                                                                                                                                      |
| `swap_player_in_match(...)`                             | Atomic bench→on-deck swap; recomputes `is_mixed_level`                                                                                                                                                                                                                                                                               |
| `swap_match_players(...)`                               | Cross-match atomic swap between two on-deck matches                                                                                                                                                                                                                                                                                  |
| `create_match_with_players(...)`                        | Atomic match + match_players insert; `RETURNS uuid`. Returns **`NULL`** (not an error) when a TOCTOU guard detects a concurrent commit — `{ data: null, error: null }` from Supabase JS = graceful slot-skip. RPC evolution: `20260421000000` → `20260506000000` (Draft Mode `p_is_published`) → `20260507000000` (3 TOCTOU guards). |
| `compute_session_wrapped(p_session_id)`                 | Computes and upserts all `session_wrapped_stats` for a session                                                                                                                                                                                                                                                                       |
| `get_h2h_record(p_team_a, p_team_b, p_session_id)`      | Head-to-head wins for exact 2v2 team pairing (all-time + tonight)                                                                                                                                                                                                                                                                    |
| `toggle_auto_matchmaking(p_session_id)`                 | Atomic toggle; returns new boolean value                                                                                                                                                                                                                                                                                             |
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

#### Priority Scoring (`computePriorityScore`)

```
Red Zone (wait ≥ 25 min):   priorityScore = 1000 + waitMinutes   [absolute urgency]
Normal   (wait < 25 min):   priorityScore = max(0, waitMinutes − (gamesPlayed × 12))
```

Floor at 0: game debt holds players back but never drops them below a brand-new joiner.

#### Candidate Scoring (`scoreCandidates`)

```
Normal candidate:   candidateScore = -priorityScore + overlapCount × 10,000
Red Zone candidate: candidateScore = -priorityScore + overlapCount × 100
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

- **snakeDraft** (normal): two-pass as above. Returns **`null`** if every split would put either team pair at or above `MAX_PARTNERSHIP_REPEATS` — callers must null-guard.
- **rotatedDraft** (forced repeat): cycles through 3 split configs based on `repeatCount % 3` starting from the natural rotation index; same two-pass freshness preference within each rotation attempt. Also returns **`null`** when cap enforcement prevents every split.

#### Anti-Repeat / Diversity Logic

- `buildOverlapMap(anchorId)` — called per-tick (once per anchor per engine slot), anchor-specific. **No longer uses `v_recent_pairings`.** Does a 3-step manual join:
  1. Fetch all `match_players` rows for the anchor (limit 200)
  2. Filter to this session's recent matches (`completed`, `in_progress`, **`pending`** — Fix 2: sees live pairings, not just finished games)
  3. Fetch all co-players + teams → build weighted overlap map: **teammate appearances = 2×, opponent appearances = 1×** (Fix 3: same-side repetition penalised more than cross-side)
- `fetchRecentRosters(sessionId)` — fetches last `ANTI_REPEAT_LOOKBACK` match rosters as arrays of player IDs. Pre-fetched **once per `runEngineInternal` run** and passed down to each `runAlgorithm` call to avoid redundant DB queries per slot. Includes `completed`, `in_progress`, and `pending` matches.
- `isDiversityViolation(playerIds, recentRosters)` — flags true if ≥3 of the proposed 4 players appeared together in any single recent match roster.
- `getEffectiveLookback(eligiblePoolSize)` — scales lookback window to pool size (≤5 → 2, ≤9 → 3, ≤15 → 4, 16+ → 5) to prevent small-tier starvation.

#### Engine Constants (`src/lib/constants.ts`)

| Constant                       | Value | Meaning                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAYERS_PER_MATCH`            | 4     | Doubles only — fixed                                                                                                                                                                                                                                                                                                                               |
| `SKILL_VARIANCE_TARGET`        | 1     | Preferred max skill gap                                                                                                                                                                                                                                                                                                                            |
| `SKILL_VARIANCE_MAX`           | 2     | Hard max skill gap                                                                                                                                                                                                                                                                                                                                 |
| `FALLBACK_WAIT_MINUTES`        | 15    | Bypass skill windows entirely                                                                                                                                                                                                                                                                                                                      |
| `CRITICAL_WAIT_MINUTES`        | 25    | Red Zone threshold                                                                                                                                                                                                                                                                                                                                 |
| `GAME_PENALTY_MINUTES`         | 12    | Minutes deducted per game played from priority score                                                                                                                                                                                                                                                                                               |
| `RED_ZONE_SCORE_FLOOR`         | 1000  | Sentinel — any score ≥ this = Red Zone                                                                                                                                                                                                                                                                                                             |
| `BOTTLENECK_THRESHOLD_MINUTES` | 20    | Wait-time monitor flag threshold                                                                                                                                                                                                                                                                                                                   |
| `ANTI_REPEAT_LOOKBACK`         | 5     | Recent matches checked for diversity                                                                                                                                                                                                                                                                                                               |
| `GATE_POOL_THRESHOLD`          | 4     | Pool size that triggers cross-court mixing deferral                                                                                                                                                                                                                                                                                                |
| `GATE_HOLD_MINUTES`            | 8     | Minutes before gate auto-releases                                                                                                                                                                                                                                                                                                                  |
| `ON_DECK_LOOKAHEAD`            | 1     | _Deprecated from engine capacity_ — still in `constants.ts`, referenced only by `simulate-engine.ts`. The live engine uses `MAX_AUTO_DRAFTS` instead.                                                                                                                                                                                              |
| `MAX_ON_DECK_MATCHES`          | 2     | _Deprecated from engine capacity_ — still in `constants.ts`, no longer imported by `matchmaking.ts`. Superseded by `MAX_AUTO_DRAFTS`.                                                                                                                                                                                                              |
| `MIN_FREE_POOL_FOR_ON_DECK`    | 4     | Minimum waiting players remaining after each on-deck fill (pool diversity cap, applies from 2nd slot onwards)                                                                                                                                                                                                                                      |
| `MAX_AUTO_DRAFTS`              | 3     | **Tiered draft cap — small session** (< 25 waiting players). Counts only `is_published=false` drafts. Published on-deck matches do NOT count — they are already reviewed and should not block fresh draft generation. |
| `MAX_AUTO_DRAFTS_LARGE`        | 5     | Tiered draft cap — medium session (25–29 waiting players).                                                                                                                                                          |
| `MAX_AUTO_DRAFTS_XLARGE`       | 6     | Tiered draft cap — large session (≥ 30 waiting players).                                                                                                                                                           |
| `DRAFT_CAP_LARGE_THRESHOLD`    | 25    | Waiting player count at which the cap upgrades from 3 → 5.                                                                                                                                                         |
| `DRAFT_CAP_XLARGE_THRESHOLD`   | 30    | Waiting player count at which the cap upgrades from 5 → 6.                                                                                                                                                         |
| `MAX_PARTNERSHIP_REPEATS`      | 2     | Max same-team appearances per session pair; no waivers                                                                                                                                                              |
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

---

### 3.9 Leaderboard

**Files:** `src/components/leaderboard/`, `src/hooks/use-leaderboard.ts`, `src/app/actions/leaderboard.ts`, `src/types/leaderboard.ts`

Two leaderboard modes:

- **Session leaderboard**: reads `v_session_leaderboard` — live stats for the current session. Shown on the organizer dashboard leaderboard tab and at `/leaderboard/[sessionId]`.
- **All-time leaderboard**: reads `v_alltime_leaderboard_mat` (materialized view). Refreshed via `refresh_alltime_leaderboard()` RPC after each session. Accessible at `/leaderboard`.

**LeaderboardHeroCard**: Always-visible player status strip showing the authenticated user's rank, GP, Win%, and rank delta — renders above the leaderboard table on both session and all-time views.

Rank-change flash animation: `data-flash="true"` triggers `leaderboard-flash` keyframes (amber glow → transparent over 800ms).

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
