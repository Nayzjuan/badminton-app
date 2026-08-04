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

`src/lib/broadcast.ts` — Server-side REST broadcast helpers (no WebSocket opened from the server). Sends ephemeral messages to topic `"session-events:{sessionId}"`, each marked `private: true`. The topic must match the client's channel name in `subscribeToOrganizerBroadcast()` **exactly** — it carries no `realtime:` prefix. See §3.27 for why the prefixed form silently delivered nothing for months. Event types:

**Tenancy (#7, migration `20260723100000`).** The topic is a **private** channel. Before that migration it was public, and public topics skip authorization entirely — Realtime never consults `realtime.messages` for them. Anyone with the publishable anon key and a session UUID could both **read** every organizer event for a club they don't belong to (including the `actorName` / `anchorPlayerName` display names) and, worse, **write**: a hand-rolled `channel.send({ type: "broadcast", event: "session_closed" })` from a browser console redirected every player in that session to Wrapped, and a forged `draft_cap_phase: "clearing"` froze every organizer behind the lockout overlay. The join is now gated by `session_events_broadcast_read` on `realtime.messages`, whose predicate is `session_access_level(<topic session id>) IS NOT NULL` — deliberately the *same* predicate as `courts_select` / `queue_select`, so the audience is unchanged from the set that can already read the board, and deliberately **not** `= 'organizer'`, because players subscribe to this topic too. There is **no INSERT policy**, by design: the server emits with the service-role key (which bypasses RLS), so no browser can send at all. Never add one.

- `organizer_intervention` — `{ type: "on_deck_cleared" | "match_cancelled" | "active_roster_changed", affectedPlayerIds, actorId?, actorName? }` → player-side toast via `useOrganizerBroadcast` (players filter by their own id). `clearOnDeckMatch` + `cancelMatchAction` attach the acting organizer (PR #19): `useOrganizerSession.onIntervention` then toasts co-organizers ("{actor} cleared an on-deck match"), skipping the actor's own client (`actorId === currentUserId`) and any actor-less broadcast (batch cap-reset clears + roster swaps, which repaint in place and need no notice).
- `session_closed` — redirects all connected players to `/wrapped/{sessionId}/{playerId}`.
- `auto_matchmaking_toggled` — `{ isOn: boolean }` → syncs auto-matchmaking state to all co-organizers (bypasses the sessions RLS SELECT policy that would silently drop postgres_changes for non-creator organizers).
- `auto_publish_toggled` — `{ isOn: boolean }` → syncs auto-publish mode state to all co-organizers (same RLS-bypass rationale). Handled in `use-organizer-session.ts`; `auto_publish` is also excluded from the postgres_changes apply so it never double-syncs.
- `cap_saturation` — `{ type: "general" | "red_zone", anchorPlayerId, anchorPlayerName }` → fires when the partner-repeat cap (not player shortage) blocks every possible team split for the anchor player; `red_zone` once the anchor has crossed `RED_ZONE_SCORE_FLOOR` (waited ≥ `CRITICAL_WAIT_MINUTES`). Handled in `use-organizer-session.ts` → surfaces the `CapSaturationNotice` banner in the on-deck panel so the organizer knows to intervene manually.
- `draft_cap_phase` — `{ phase: "clearing" | "generating" | "done", override }` (`override: number | null`, null = Dynamic) → drives the synchronized dashboard lockout overlay during a cap-change reset; `done` is also emitted on failure so co-organizer screens never stay locked.

### Realtime Subscription Auth (JWT-before-join)

Supabase Realtime binds a channel's `postgres_changes` RLS row-filter to the socket's JWT **at channel-join time** — a later `setAuth()` does **not** re-bind an already-joined channel. `@supabase/ssr` hydrates a persisted cookie session asynchronously (the `INITIAL_SESSION` auth event), which fires _after_ hook effects synchronously call `.subscribe()`. So without care, channels join under the `anon` Postgres role; under the club-scoped RLS on `sessions` / `queue_entries` / `matches` / `match_players` / `courts` (`is_session_club_member` / `is_session_organizer`), `anon` matches zero rows and **no realtime events are ever delivered** — e.g. a drafted player's "Match Forming" card never flips to on-deck until a manual refresh (was e2e scenario-j J-B/J-C).

**Fix (`src/utils/supabase/client.ts` + `src/lib/realtime.ts`):**

- `createBrowserSupabaseClient()` eagerly runs `getSession() → realtime.setAuth(access_token)` on first call and exposes the resulting promise via **`whenRealtimeAuthReady()`**; it also re-`setAuth`s on every later auth transition (SIGNED_IN / TOKEN_REFRESHED / INITIAL_SESSION).
- Every `postgres_changes` subscribe helper — `subscribeToTable` (courts/queue/matches), `subscribeToMatchPlayers`, `subscribeToProfiles` — and the organizer `session-settings` channel in `use-organizer-session.ts` **defer `.subscribe()` behind `whenRealtimeAuthReady()`**, guaranteeing the JWT is set before join. Cleanup uses a `cancelled` flag + null-guarded `removeChannel`, so an unmount before the deferred join leaks nothing (StrictMode-safe).
- The Broadcast channel (`subscribeToOrganizerBroadcast`) **is deferred too**, as of the tenancy #7 fix. This reverses the earlier note that it "needs no JWT-before-join": that was true only while the channel was public. A **private** channel is authorized at join time against the socket's JWT by the `session_events_broadcast_read` policy on `realtime.messages`, and that policy is `TO authenticated` — so a join that races ahead of `setAuth()` is evaluated as `anon` and **refused**, losing every session event for the tab's lifetime. It also routes through `createStatusHandler`, so an authorization refusal is logged as `CHANNEL_ERROR` instead of looking like an idle channel.

### Shared Server Action Helpers

**File:** `src/app/actions/_shared.ts`

Two helpers used by all organizer-gated server actions to avoid reimplementing the same auth/organizer checks:

- **`getAuthenticatedUser()`** — thin wrapper around `auth.getUser()`; all server actions that need auth call this instead of instantiating their own server client.
- **`isSessionOrganizer(userId, sessionId)`** — two-path organizer check: fast-path via `sessions.created_by` equality, then fallback lookup in `session_organizers`; used by all organizer-gated actions.

`getAuthenticatedUser` uses the user-context server client (`createServerSupabaseClient`) because `auth.getUser()` is always user-scoped. `isSessionOrganizer` uses the service-role client (`createServiceClient`) so the primary organizer is never blocked by read-side RLS on `sessions` or `session_organizers`.

---

## 2. Database Schema & State

> **⚠️ Migrations are the source of truth — as of 2026-07-22 they finally are.** Much of this database was originally built by clicking through the Supabase dashboard, and none of that was ever written into `supabase/migrations`. Because production already had those objects, nobody noticed: the migration set only ever ran against a database that already contained what it assumed. A database built from migrations alone — every Supabase **preview branch**, and `supabase db reset` — diverged badly:
>
> | What was missing on a from-scratch DB | Consequence |
> | --- | --- |
> | `courts`, `matches`, `match_players`, `queue_entries` absent from the `supabase_realtime` publication | no realtime on the four tables the app actually subscribes to |
> | `v_recent_pairings` never created | `20260702000003` aborted with `42P01` |
> | **RLS not enabled** on `courts`, `matches`, `match_players`, `match_games`, `queue_entries`, `profiles`, `session_organizers` | row security OFF — a table with RLS disabled ignores policies entirely |
> | **35 of 46 RLS policies** never created | the remaining policies bore no resemblance to production |
>
> The visible symptom was that `Vitest Integration` had been red on `main` and every branch for some time — it was dying during DB setup (`42704`, "relation is not part of the publication"), so the suite had **not been running at all**. The invisible and worse symptom: once the replay was unblocked, that suite would have passed against a database whose security posture did not match production, proving nothing about the RLS actually deployed.
>
> Fixed by `20260722000000` (publication membership), `20260722000001` (`v_recent_pairings`), and `20260722000002` (RLS baseline: the 7 `ENABLE ROW LEVEL SECURITY` flags + the 35 policies). All three are **convergent, idempotent, and strict no-ops against production**, and each ends with an assertion that `RAISE`s rather than handing back a database that merely looks healthy. The unguarded `ALTER PUBLICATION … DROP TABLE`, `ALTER POLICY` and `DROP POLICY` statements in `20260701000006`, `20260717171903` and `20260717174914` are now existence-guarded so the replay cannot abort.
>
> **Rules going forward:** never create a table, view, policy, publication membership, or RLS flag through the dashboard — write a migration. Editing an already-applied migration is legitimate *only* to make it replay-safe (guards), never to change its effect; the CLI stores per-migration `statements`, so `supabase migration repair` reconciles the stored copy if it ever objects. And never insert a migration dated **before** ones already applied to production — the CLI applies it out of order. When a fix seems to need that, guard the earlier statement and declare the end state in a later migration instead.

> **DB Optimization Pass — 2026-07-17 (migrations `20260717165546`→`20260717190000`).** A full audit-driven pass shipped these behavioral/infrastructure changes:
> - **RLS is now consolidated + initplan-hoisted.** SECURITY-DEFINER helpers `session_access_level(session_id)` (returns `'organizer'|'member'|null` in one probe) and `has_match_access(match_id)` back the sessions/matches/match_players/match_games policies; every policy's `auth.uid()`/`auth.role()` is wrapped as `(select auth.uid())` so it evaluates once per statement, not per row. Duplicate PERMISSIVE twins were dropped.
> - **New set-based RPCs** (replace per-row loops): `requeue_finished_players(session, player_ids, drafted_ids)` (atomic `games_played+1` + status, used by endMatch), `reorder_on_deck_matches(session, match_ids)` (one UPDATE…FROM unnest WITH ORDINALITY, used by drag-reorder), `count_completed_matches_by_session(session_ids[])` (GROUP BY counts for the organizer hub — cap-safe), `get_h2h_record` (now pre-filters to matches containing all 4 players).
> - **Leaderboard:** `refresh_alltime_leaderboard()` is globally debounced via `pg_try_advisory_xact_lock` + a `leaderboard_refresh_state` gate (≥30s); `get_session_leaderboard_public` and `get_monthly_leaderboard` now project `vip_tag`/`vip_theme` (no separate `buildVipMap` query on those hot paths — all-time still uses the live map). `v_match_history` no longer bakes an `ORDER BY`.
> - **Realtime:** `supabase_realtime` publication trimmed to `courts, match_players, matches, profiles, queue_entries, sessions` (dropped `session_organizers`, `match_games` — zero subscribers). Subscription refetch bursts are collapsed by a shared 200ms trailing-edge debounce (`src/lib/trailing-debounce.ts`, `REALTIME_REFETCH_DEBOUNCE_MS`); `use-match-history` also gates refetch on status relevance (note: `matches` is REPLICA IDENTITY DEFAULT, so `payload.old.status` is unavailable — the gate keys on `payload.new.status`).
>
> Four structural items were deferred with execution-ready designs (see `MEMORY.md`): engine per-slot diversity 9→3, `compute_session_wrapped` CTE hoist, the page-level realtime channel-owner refactor, and `match_players.session_id` denormalization (the last two need human live-testing).

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
| `is_hidden`                | `bool`                | **Infrastructure sessions** (migration `20260721101500`). `true` keeps a session out of EVERY human-facing list — `/play`, the organizer hub, the dashboard's session switcher, `getMyClubs` / `getClubSessions` (`src/lib/clubs.ts`), the leaderboard page's session list (`src/app/leaderboard/page.tsx`), and — since `20260804000000` — the `v_alltime_leaderboard_mat` definition itself all filter `is_hidden = false`. Set on the `🤖 E2E SANDBOX` row, which lives in CHILLAX (the only club) and previously rendered as an ACTIVE session with its `organizer_passcode` on show. **Not access control** — the row stays readable by id, which is how the e2e suite drives it. The migration MUST `grant select (is_hidden) to authenticated, anon`: `20260701000010` replaced the table-wide SELECT with an explicit column list, and Postgres requires SELECT privilege on any column referenced in a WHERE clause, so an ungranted column breaks those reads outright. |
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

#### `club_milestones`

One-time club-wide "firsts" ledger (migration `20260704000001`). Append-only; RLS enabled with **zero policies** (deny-all) — written/read exclusively inside `compute_session_wrapped()` via service role. `UNIQUE (club_id, milestone)` makes claiming atomic (`INSERT … ON CONFLICT DO NOTHING`), so two near-simultaneous session closes in the same club can never both win. Backfilled at migration time with the true historical first-to-100 crossing per club, reconstructed from completed-match history.

| Column        | Type                         | Notes                                                   |
| ------------- | ---------------------------- | ------------------------------------------------------- |
| `id`          | `uuid` PK                    |                                                         |
| `club_id`     | `uuid → clubs.id`            | `UNIQUE (club_id, milestone)`                           |
| `milestone`   | `text`                       | Currently only `first_to_100_games`                     |
| `player_id`   | `uuid → profiles.id`         |                                                         |
| `session_id`  | `uuid → sessions.id \| null` | ON DELETE SET NULL — milestone survives session pruning |
| `achieved_at` | `timestamptz`                |                                                         |

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
| `v_match_history`              | Matches + players + scores with team arrays and `game_scores` JSON. **Owner-rights view — bypasses base-table RLS; the GRANT is the access control.** Service-role only (§3.8d).                                     |
| `v_recent_pairings`            | Recent co-player pairs per player; **no longer used by `buildOverlapMap`** (replaced by 3-step manual join with team-aware weighting in `matchmaking.ts`; view still exists in DB but is not queried by the engine) |
| `v_session_leaderboard`        | Per-session GP, W, L, Win%, PF, PA, +/-. Owner-rights view, **service-role only** (§3.8d).                                                                                                                           |
| `v_alltime_leaderboard_mat`    | Materialized all-time leaderboard, keyed `(player_id, club_id)`. **A matview cannot carry RLS at all** — service-role only, club-scoped in TypeScript (§3.8d). Since `20260804000000` its definition joins `sessions` and excludes `is_hidden = true`, so E2E-sandbox matches never reach a real club's all-time board. It is the only leaderboard surface that needed the predicate because it is the only one that CACHES the aggregation — `get_alltime_snapshot_before` and `get_player_streaks` read `v_match_history` live and self-heal after teardown. Any migration that recreates this matview must also re-apply the `service_role` grant and the `revoke ... from public, anon, authenticated` (see §3.27 and the migration header). |

---

### Postgres Functions (RPCs)

| Function                                                | Purpose                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elevate_to_organizer(p_session_id, p_passcode)`        | Passcode-gated organizer promotion → inserts `session_organizers` row                                                                                                                                                                                                                                                                |
| `rejoin_queue(p_session_id)`                            | Player self-rejoin after leaving                                                                                                                                                                                                                                                                                                     |
| `skill_level_to_int(lvl)`                               | Enum → numeric (1–6)                                                                                                                                                                                                                                                                                                                 |
| `get_player_streaks(p_session_id?, p_club_id?)`         | Win-streak per player, session-scoped or all-time. **SERVICE ROLE ONLY** as of `20260722010001` — both params default, so `{}` dumped every club (§3.8d).                                                                                                                                                                             |
| `get_session_player_streaks(p_session_id)`              | The browser-callable half (`20260722010000`). Mandatory session id, self-gates on `session_access_level()`. `authenticated` + `service_role`, **never `anon`**. Called by `use-enriched-matches.ts` for the court-board flames.                                                                                                        |
| `get_alltime_snapshot_before(p_cutoff, p_club_id?)`     | All-time stats as of a timestamp. **SERVICE ROLE ONLY** as of `20260722010001` (§3.8d).                                                                                                                                                                                                                                               |
| `get_monthly_leaderboard(p_year, p_month)`              | **Monthly board** (migration `20260626000000`). Live aggregation of one Manila-month slice of completed matches off base tables. `SECURITY INVOKER`, public-read. Boundary anchored in `Asia/Manila` via `make_timestamptz`; sargable `completed_at` range on `idx_matches_completed_at`.                                              |
| `get_leaderboard_months()`                              | Months for the monthly picker — distinct Manila-months with completed matches + the current month (always present), newest first. `SECURITY INVOKER`, public-read.                                                                                                                                                                    |
| `refresh_alltime_leaderboard()`                         | Refreshes the materialized view                                                                                                                                                                                                                                                                                                      |
| `swap_player_in_match(...)`                             | Atomic bench→on-deck swap; recomputes `is_mixed_level`                                                                                                                                                                                                                                                                               |
| `swap_match_players(...)`                               | Cross-match atomic swap between two on-deck matches                                                                                                                                                                                                                                                                                  |
| `create_match_with_players(...)`                        | Atomic match + match_players insert; `RETURNS uuid`. Returns **`NULL`** (not an error) when a TOCTOU guard detects a concurrent commit — `{ data: null, error: null }` from Supabase JS = graceful slot-skip. RPC evolution: `20260421000000` → `20260506000000` (Draft Mode `p_is_published`) → `20260507000000` (3 TOCTOU guards). |
| `compute_session_wrapped(p_session_id)`                 | Computes and upserts all `session_wrapped_stats` for a session. Redefined by `20260704000000` (deuce_magnet threshold 20-20 → 30-30 — scoring is sudden-death to 31, so 30-30 is the real drama point) and `20260704000001` (awards one-time `first_to_100` via an atomic `club_milestones` claim; only the claim-winner ever gets the slug). |
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
Normal candidate:   candidateScore = -priorityScore + overlapCount × 10,000 + gamesAhead × GAMES_AHEAD_PENALTY (10,000)
Red Zone candidate: candidateScore = -priorityScore + overlapCount × 100    + gamesAhead × GAMES_AHEAD_PENALTY_RED_ZONE (100)
  (Red Zone = priorityScore ≥ RED_ZONE_SCORE_FLOOR — includes Hard Cap tier since 2000 ≫ 1000)
  gamesAhead = max(0, games_played − poolMinGames)   [fresh-first rule, 2026-07]
```

Sorted ascending (lowest score = highest priority). Red Zone overlap penalty is capped at 100× so a Red Zone player with 1 recent overlap still beats a Normal player with 0.

**Fresh-first rule (early-session diversity):** `poolMinGames` = min `games_played` across the WAITING pool (pulled bodies excluded — their mid-game count reads one low). Each candidate is penalised one overlap-unit-equivalent per game above that minimum, so the freshest waiting cohort fills rosters first whenever the skill window allows. Pulled bodies are exempt from the term entirely (their ordering stays governed by `priorityScore = -1`, C-3). Zero effect when all games are equal (e.g. t=0) — behaviour is bit-identical to before. Red Zone urgency still wins (100× variant).

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

- **snakeDraft** (normal): **balance-gated four-pass** (2026-07-30 lopsided-teams fix). Splits are first partitioned by team-skill gap: **balanced** = gap ≤ minGap + `SKILL_VARIANCE_MAX`, the rest **lopsided**. The four-pass freshness search (1a: fresh partnerships + no capped cross-net pair; 1b: fresh partnerships, relax opponent cap; 2a: below partnership cap + no capped cross-net; 2b: below partnership cap) runs over the **balanced pool first**; the lopsided pool is only searched when every balanced split is partnership-capped, and such a result carries **`usedLopsidedFallback: true`** (`SnakeDraftResult`). Rationale: freshness used to be the outer gate, so once all cross-tier pairings had been used once the engine "preferred" a fresh high+high vs low+low split (the INT+INT vs BEG+BEG incident) — a within-cap repeat on balanced teams always beats a fresh-but-lopsided match. The tolerance keeps the fresh-pair preference alive between near-equal splits (6/5/4/3: Split 2's gap 2 is still acceptable) and consequently balance now also outranks opponent-cap freshness (a capped cross-net pair can no longer force the top-vs-bottom split). Returns **`null`** only when balanced AND lopsided splits are all partnership-capped.
- **Balance-preserving swap** (`runAlgorithm` main path): when snakeDraft flags `usedLopsidedFallback`, the engine tries replacing each trio member (lowest-priority first, never a Red-Zone member — mirrors the diversity-swap guard) with another eligible scored candidate (skill window, ≤1 pulled body, no diversity violation) and takes the first swap whose draft is balanced. If no balanced alternative exists anywhere in the pool, the lopsided draft is accepted rather than stalling the queue.
- **rotatedDraft** (forced repeat): cycles through 3 split configs based on `repeatCount % 3` starting from the natural rotation index; same four-pass structure within each rotation attempt. Also returns **`null`** when the partnership cap blocks every split. **Known/accepted hole:** as the partner-variety mechanism for forced repeats it still deliberately cycles through the top-vs-bottom split, so a forced repeat of the exact same 2-high+2-low four can still produce high+high vs low+low.

#### Anti-Repeat / Diversity Logic

- `buildOverlapMap(anchorId)` — called per-tick (once per anchor per engine slot), anchor-specific. **No longer uses `v_recent_pairings`.** Teammate/opponent overlap weights are now **equal** (`OVERLAP_WEIGHT_TEAMMATE = OVERLAP_WEIGHT_OPPONENT = 2`, raised from 2/1 in the 2026-07 diversity pass so re-facing is avoided as hard as re-partnering — the primary round-2 opponent lever). Does a 3-step manual join:
  1. Fetch all `match_players` rows for the anchor (limit 200)
  2. Filter to this session's recent matches (`completed`, `in_progress`, **`pending`** — Fix 2: sees live pairings, not just finished games)
  3. Fetch all co-players + teams → build weighted overlap map: **teammate = opponent = 2×** (equal as of 2026-07 — was 2×/1×; re-facing a round-1 opponent now deprioritised as strongly as re-teaming a round-1 partner)
- `fetchRecentRosters(sessionId)` — fetches last `ROSTER_LOOKBACK_COUNT` (10) match rosters as arrays of player IDs. Fetched **per slot** inside `runEngineInternal`'s fill loop (2026-07 intra-burst fix — previously once per run, which left `isDiversityViolation` blind to sibling drafts committed by earlier slots of the same burst). Includes `completed`, `in_progress`, and `pending` matches.
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
| `OVERLAP_WEIGHT_TEAMMATE`      | 2     | `buildOverlapMap` weight per same-team co-appearance with the anchor in recent matches.                                                                                                                                                                                                                                                            |
| `OVERLAP_WEIGHT_OPPONENT`      | 2     | `buildOverlapMap` weight per cross-net co-appearance (raised 1→2 in the 2026-07 diversity pass — re-facing avoided as hard as re-partnering). Fires on a single prior meeting, so it is the primary round-2 opponent-freshness lever (`MAX_OPPONENT_REPEATS` only bites round 3+).                                                                     |
| `ROSTER_LOOKBACK_COUNT`        | 10    | Recent match rosters fetched by `fetchRecentRosters` for diversity-violation checks (larger than `ANTI_REPEAT_LOOKBACK` so `getEffectiveLookback` can scale up for large sessions)                                                                                                                                                                 |
| `MIN_REST_MINUTES`             | 18    | Minimum wait minutes before a returning player (games_played > 0) can be drafted again. Prevents 0-min back-to-back. Falls back to unfiltered pool if fewer than `PLAYERS_PER_MATCH` survive the filter.                                                                                                                                           |
| `GAMES_AHEAD_PENALTY`          | 10,000 | Fresh-first rule: scoreCandidates penalty per game a candidate is above the waiting-pool minimum (= 1 overlap unit). Pulled bodies exempt.                                                                       |
| `GAMES_AHEAD_PENALTY_RED_ZONE` | 100   | Red Zone variant of the fresh-first penalty (capped small, like the overlap cap, so urgency always outranks freshness).                                                                                             |
| `GATE_POOL_THRESHOLD`          | 4     | Pool size that triggers cross-court mixing deferral                                                                                                                                                                                                                                                                                                |
| `GATE_HOLD_MINUTES`            | 8     | Minutes before gate auto-releases                                                                                                                                                                                                                                                                                                                  |
| `MIN_FREE_POOL_FOR_ON_DECK`    | 4     | Minimum waiting players remaining after each on-deck fill (pool diversity cap, applies from 2nd slot onwards)                                                                                                                                                                                                                                      |
| `MAX_AUTO_DRAFTS`              | 3     | **Tiered draft cap — small session** (< 25 waiting players). Counts only `is_published=false` drafts. Published on-deck matches do NOT count — they are already reviewed and should not block fresh draft generation. |
| `MAX_AUTO_DRAFTS_LARGE`        | 5     | Tiered draft cap — medium session (25–29 waiting players).                                                                                                                                                          |
| `MAX_AUTO_DRAFTS_XLARGE`       | 6     | Tiered draft cap — large session (≥ 30 waiting players).                                                                                                                                                           |
| `DRAFT_CAP_LARGE_THRESHOLD`    | 25    | Waiting player count at which the cap upgrades from 3 → 5.                                                                                                                                                         |
| `DRAFT_CAP_XLARGE_THRESHOLD`   | 30    | Waiting player count at which the cap upgrades from 5 → 6.                                                                                                                                                         |
| `MAX_PARTNERSHIP_REPEATS`      | 2     | Max same-team appearances per session pair; no waivers                                                                                                                                                              |
| `MAX_OPPONENT_REPEATS`         | 2     | **Soft** cap on cross-net (opponent) appearances per session pair (lowered 3→2, 2026-07). Preference only — snakeDraft/rotatedDraft try to avoid it but degrade gracefully (never a stall). Bites round 3+ (in round 2 no pair has met >once); round-2 opponent freshness is driven by the equal overlap weight above. |
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
4. Per slot: re-fetch recentRosters (sees sibling drafts from earlier slots of this burst; completed + in_progress + pending)
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
- Engine auto-generates drafts up to the **dynamic draft cap** (`getDynamicDraftCap(waitingCount)` → 3 / 5 / 6 for `<25` / `25–29` / `≥30` waiting; organizer `max_auto_drafts_override` applies as a ceiling). Formula: `slotsAvailable = max(0, effectiveCap − draftCount)` where `draftCount` counts **unpublished** (`is_published=false`) pending rows only — published on-deck matches never block fresh drafts. (Auto-publish mode instead counts published-or-held pending rows; see §3.5.) Full details: "Engine Capacity — Dynamic Draft Cap" in §3.1.
- Each card shows team A vs team B with skill badges, `is_mixed_level` indicator, and H2H strip.
- **Draft Mode**: All engine-generated matches start as `is_published = false` (drafts, hidden from players and TV). The organizer must explicitly publish (single: `publishMatchAction`) or publish-all (`publishAllDraftMatchesAction`) before players see them. The draft approval banner shows `"N on-deck matches waiting for approval"` and the section label reads `"Drafts — hidden from players"`.
- **Engine trigger on publish**: `publishMatchAction` (both RPC and fallback paths) and `publishAllDraftMatchesAction` (both RPC and fallback) call `runEngineForSession` after a successful publish, immediately refilling the draft review queue. This prevents the organizer from seeing 0 drafts after publishing all — the engine proactively generates the next batch.
- **Swap flow**: Long-press / click a player pill → opens `SwapSheet` → pick a bench player → calls `swapPlayerInMatch` server action.
- **Cross-match swap (Tap-to-Swap v2)**: Click a player in match A, then a player in match B → calls `swapMatchPlayers` RPC (atomic two-match swap). This replaces the original bench-only swap with direct match-player swapping.
- **Clear**: Organizer can discard a single on-deck match via `clearOnDeckMatch`; players return to `waiting`. Broadcast fires so affected players see a toast.
- **Reorder**: On-deck matches can be drag-reordered. `reorderOnDeckMatches` bulk-updates `sort_order` on all affected matches. The panel holds a local `orderedMatches` state seeded from props; the prop-sync effect resolves incoming realtime `matches` against local state in three branches — (1) id-set changed → adopt server order; (2) same id-set **and** this client's own reorder is still round-tripping (`pendingReorderRef`) → merge field updates but keep the optimistic order; (3) same id-set, no local reorder pending → adopt the server's `sort_order` (this re-syncs a **co-organizer's** reorder, which arrives as the same id-set in a new order). `handleDragEnd` is async: it sets `pendingReorderRef` before the await, reverts to the pre-drag order on `{error}`, and clears the ref in `finally` (a hung/failed action never freezes re-sync). `isDraggingRef` still suppresses all prop-sync mid-drag.
- **Cap Saturation Notice**: `CapSaturationNotice` banner appears when the engine's `cap_saturation` broadcast fires, alerting the organizer that `MAX_PARTNERSHIP_REPEATS` has been hit and manual assignment is needed.
- **Reuse badge (equity signal, 2026-07)**: draft cards show an amber `N fresher waiting` chip (`ReuseBadge` in `sortable-card.tsx`, fed by `deriveReuseNotice` in `src/lib/derive-reuse-notice.ts` via a new `queue` prop) when the draft seats players with more games than the waiting-pool minimum while an equal-or-larger fresher cohort waits. Purely informational — publish is never blocked. Drafts only; skill-window-blind and held-draft pulled bodies are skipped by design (soft signal).

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
- **Cap re-interpretation (D2):** the same `max_auto_drafts_override` cap means "max published matches to keep On Deck" in auto mode. Because there are no unpublished review drafts, the cap-count query re-counts pending matches that are `is_published = true` **or `is_held = true`** (an extra count query that runs **only** in auto mode). Held-but-not-ready drafts stay hidden from players but DO count against the cap — they auto-publish at readiness, so counting them prevents the engine over-generating and overshooting the cap when several publish at once. UI chip label swaps `MAX` → `DECK`.
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

- `AWARD_META: Record<string, AwardMeta>` — maps every slug to `{ emoji, title, subtitle, rarity }`. **63 total awards** across 12 categories (54 session-only + 9 cross-session added in migrations `20260510000000–02`; `first_to_100` added in `20260704000001`).
- Subtitle templates use `{value}` tokens replaced at render time from `award_data` jsonb.
- `renderSubtitle(meta, awardData)` handles token replacement.
- `sortAwardsByRarity(slugs)` — orders rarest-first for display (legendary → rare → uncommon → common).
- `topAwardsByRarity(slugs, n=6)` — display cap helper used by `WrappedShell` to render at most 6 awards on the player's Wrapped page; the header copy switches to "Top 6 of N Awards" when there are more.

**Award catalogue (63 awards):**

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
| Score-based Flavor      | close_call_survivor, heartbreaker, deuce_magnet (30-30 tie — raised from 20-20 in `20260704000000`; scoring is sudden-death to 31)                                                                                                                                                                                                                                                                                                                                                       |
| Comedic / Personality   | participation_trophy, the_punching_bag, scoreboard_decorator, benchwarmer, the_warmup_act, own_worst_enemy, just_getting_started (fallback)                                                                                                                                                                                                                                                                                                                                             |
| Special / Milestone     | century_club, the_veteran, night_cap, early_bird, skill_slayer, double_trouble, **first_to_100** (one-time club-wide: only the historically FIRST player in the club to reach 100 all-time games; claimed atomically via `club_milestones`, `20260704000001`)                                                                                                                                                                                                                              |
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
- **Deuce threshold tweak (migration `20260704000000`):** `deuce_magnet` now requires games reaching **30-30** (was 20-20) — scoring is sudden-death up to `MAX_BADMINTON_SCORE=31` with no win-by-2, so 20-20 is a routine mid-game state; 30-30 is the real next-point-wins moment. Applied as a verified scoped text substitution on the live `compute_session_wrapped` body (aborts unless the 20-20 pattern occurs exactly twice). Subtitle in `wrapped-awards.ts` updated to say 30-30.
- **First to 100 (migration `20260704000001`):** `first_to_100` (legendary) — one-time, club-scoped honor for the FIRST player in a club to ever reach 100 all-time games; exactly one holder per club, forever (vs `century_club`, which every player earns each session after crossing 100). Backed by the new `club_milestones` table (§2 — append-only, deny-all RLS, service-role only). Claim runs in the RPC only when a player *crosses* 100 tonight (`alltime_games>=100 AND alltime_games-games_played<100`): SELECT existing holder → atomic `INSERT ... ON CONFLICT (club_id,milestone) DO NOTHING RETURNING` — race-safe across concurrent session closes, idempotent across recomputes. Ledger milestone key is `first_to_100_games`; award slug is `first_to_100`. Migration backfilled the true historical first crossing per club from cumulative completed-match history.

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

### 3.8a Credential-guessing rate limits (2026-07-21)

**Why:** `reconnectPlayer(name, pin)` returns an account and then migrates the caller's identity onto it. The PIN space is 9,000 and display names are printed on the public `/tv` and leaderboard pages — so unthrottled it is full account takeover needing **no organizer rights**. `joinAsCoOrganizer` has the same shape over a 100,000-value passcode space.

**Shared log:** `co_organizer_join_attempts` — append-only, service-role only (RLS on, **no policies and no grants**). Two scopes; exactly one key column is set per row:

| scope        | keyed on                                    | caller state                                  |
| ------------ | ------------------------------------------- | --------------------------------------------- |
| `cojoin`     | `user_id`                                   | authenticated                                 |
| `reconnect`  | `subject` (normalized `display_name` under attack) | anonymous — a caller-keyed limit would be worthless, they can mint identities at will |

**Gates:** `cojoin_record_and_check` / `reconnect_record_and_check`. Both are SECURITY DEFINER, service-role only, and **fail closed** — any RPC error or null row denies, because a limiter that fails open is worse than none (it looks like protection). Each **counts first and only records when under the limit**: an over-limit caller is rejected *without* being logged, so the window actually drains. Recording-then-counting made the window self-feeding, which against a named victim is a permanent account lockout — for an anonymous-auth player reconnect *is* the account, with no email reset behind it. Attempts are written pessimistically as failures and flipped via `auth_attempt_mark_succeeded` once credentials verify, so a legitimate join never burns the window.

**Arms** (`reconnect`: 10/name, 60/IP, 15 min · `cojoin`: 10/user, 60/IP, 15 min). Every count is scope-filtered — without that predicate failed *reconnects* burned the *co-organizer* IP budget, letting ~70 anonymous attempts lock co-organizer join for a whole single-NAT venue. The IP arm is deliberately loose because a club is one gym Wi-Fi plus CGNAT; a tight cap would let one person lock out the venue.

> **The scope-wide spray counter is ADVISORY — it logs `spray_suspected` and never denies.** It shipped briefly as a hard 300/15min cap and that was a mistake: a shared counter is a platform-wide kill switch on login. ~30 enumerable names across ~5 IPs at 0.33 rps holds it open indefinitely (blocked attempts aren't recorded, so rows expire one at a time and the attacker just re-fills the gap). Denial stays on the two arms with a bounded blast radius. Distributed spray therefore remains bounded only at 60 failures/IP — a knowingly accepted residual risk; the real root cause is 4-digit PIN entropy.

**Tests:** `tests/unit/reconnect-throttle.test.ts` (RC-LOCK / RC-FAIL / RC-PASS / RC-SPRAY / RC-FLIP) and `tests/unit/tenancy-guards.test.ts` (TG-RATE). RC-PASS-3 asserts the **exact RPC parameter names** — the gate fails closed, so one drifted key is a silent 100% lockout that every mock-based test would otherwise sail past.

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

**Registration change:** `signInAnonymously` enforces global uniqueness. The already-authed path **upserts** (re-creating a missing profile), which — together with `/` falling through to the login form for an authed-but-profileless user — breaks the profileless redirect loop left by a merged-away ghost.

> **The returning-player check is PIN-blind (2026-07-21, security).** It used to be `.ilike(name).eq("pin", pin)` answering "Looks like you've played before!" on a hit vs "Name taken" on a miss. Registration is unauthenticated and deliberately unthrottled, so those two replies were a free oracle over the 9,000-value PIN space — and it bypassed the `reconnectPlayer` limiter (§3.8a) end to end: recover the PIN here for nothing, then spend one reconnect attempt. **Every "name exists" arm now returns the same `NAME_TAKEN_MESSAGE`** (pre-check, both 23505 paths), so a right and a wrong PIN are indistinguishable. Two PIN-blind checks run in order: (1) a name-only lookup across **all** profiles, then (2) `isNameTaken` (normalized key, non-flagged only). Check (1) exists because `isNameTaken` skips flagged profiles to mirror the partial index — without it a **flagged** returning player would register a second account and strand their history behind a ghost. The accepted cost: a name held *only* by a flagged duplicate is unclaimable until that duplicate renames — and clearing a flag is **self-serve only** (`renamePlayer` derives the user from the session; no organizer or admin path exists), so a player who never returns leaves that name blocked until someone touches the DB. Narrow in practice: while the non-flagged holder still exists, `isNameTaken` blocks the name anyway, and the message already tells the registrant to add an initial. Pinned by `tests/unit/registration-pin-oracle.test.ts` (RO-STRUCT / RO-BLIND / RO-FLAG).

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

### 3.8d Leaderboard read lockdown (2026-07-22)

**Files:** `src/app/actions/leaderboard.ts`, `src/hooks/use-enriched-matches.ts`, `src/app/leaderboard/page.tsx`. Migrations `20260722010000` (additive) + `20260722010001` (revokes).

**Why (`TENANCY_AUDIT_2026-07-21.md` #6):** three leaderboard RPCs were `SECURITY DEFINER` with **every scoping parameter defaulted**, so a `POST /rpc/get_player_streaks` with body `{}` — anon key, no login, no club, no session id — returned every player in every club. `get_alltime_snapshot_before` was the same shape; `get_session_leaderboard_public` needed only a session id, which is printed in share URLs. One layer down, `v_alltime_leaderboard_mat` held `anon` SELECT, and a **materialized view cannot carry RLS at all** — the GRANT *is* its access control. `v_match_history` / `v_session_leaderboard` are owner-rights views (`reloptions IS NULL`, no `security_invoker`), so they read their base tables as the owner and bypass RLS the same way.

**The fix, and what it costs.** Revoking `anon` + `authenticated` moves the scoping from Postgres into TypeScript, so `src/app/actions/leaderboard.ts` now owns it explicitly:

| Board                         | Client                              | Scoping                                                                                                    |
| ----------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Session** (incl. share link) | service client                      | the mandatory `p_session_id` — this is the one deliberately public surface (`/leaderboard/[sessionId]`)       |
| **All-time** (+ `getPlayerStats`) | service client, **after** an auth gate | `getMyActiveClubIds(user.id)`; a `clubSlug` not in that set returns zero rows, no slug means "my clubs"      |
| **Monthly**                    | caller's client — **unchanged**      | `get_monthly_leaderboard` / `get_leaderboard_months` are `SECURITY INVOKER` off the base tables, so RLS already scopes them. Revoking them would *delete* working scoping and replace it with hand-written checks. |

Consequences worth knowing: the all-time board is now **authenticated-only** (logged out ⇒ empty, not an error), and because a service-role read spans clubs, cross-club rows are folded by `mergeAllTimeEntries` — the matview is keyed `(player_id, club_id)`, so a player in two clubs previously appeared twice. `buildVipMap` deliberately **stays** on the caller's client: it reads `profiles`, which has real RLS.

**The one browser-reachable replacement.** `use-enriched-matches.ts` fetches win streaks from the browser on every court-board refresh (the flame on each on-deck card). It now calls **`get_session_player_streaks(p_session_id)`** — same window body as `get_player_streaks`, but the parameter has **no DEFAULT** (so the cross-club form has no browser-reachable spelling) and it gates itself on `session_access_level(p_session_id) IS NOT NULL`, returning zero rows rather than another club's board. A distinct name, **not an overload**: PostgREST resolves overloads by argument-name set, and two candidates matching `{p_session_id}` answer `PGRST203`.

**Why two migration files.** Both orderings of a single file are fatal in opposite directions — revokes before the code deploy reproduce the 2026-07-02 `42501` outage verbatim (see `20260702000007`), and the new function after the deploy means `PGRST202` and every streak flame silently reading 0. The split creates a safe order: **apply `…010000` → deploy code → apply `…010001`**.

**Every revoke spells out `from public, anon, authenticated`.** Revoking `PUBLIC` alone is wrong in *both* directions here: on a from-scratch replay `proacl` is NULL so PUBLIC is the only holder and the revoke also strips `service_role` (hence the paired explicit grants — see `20260722000004`); on production Supabase's `ALTER DEFAULT PRIVILEGES` stamped **direct** `anon`/`authenticated` entries at `CREATE FUNCTION` time, which a PUBLIC revoke does not touch at all.

**Tests:** `schema-parity.test.ts` re-derives the grant shape from the catalog on every `db reset` (the migrations' `DO` blocks run once and cannot catch the *next* bad revoke); `rls-edge-cases.test.ts` reproduces the audit through a real anon client and proves the `session_access_level` gate three ways (organizer sees rows → outsider sees none → same outsider sees rows once granted club membership); `use-enriched-matches.test.ts` EM-9/EM-10 pin the RPC name + argument and the degrade-to-zero path.

---

### 3.9 Leaderboard

**Files:** `src/components/leaderboard/`, `src/hooks/use-leaderboard.ts`, `src/app/actions/leaderboard.ts`, `src/types/leaderboard.ts`, `src/lib/month.ts`

Three leaderboard scopes (3-way segmented control `[ Session · Monthly · All-Time ]` on every variant; `useLeaderboard` owns the `scopeTab`):

> **Read access:** as of 2026-07-22 the Session and All-Time reads run on the **service client** and are scoped in `src/app/actions/leaderboard.ts`, not by RLS — see **§3.8d** before touching any of these queries. Monthly still runs on the caller's client and is scoped by RLS.

- **Session leaderboard**: reads `v_session_leaderboard` — live stats for the current session. `MIN_SESSION_GP=1`, confidence `K=3`.
- **Monthly leaderboard** (migration `20260626000000`): live `get_monthly_leaderboard(year, month)` RPC aggregating one **Manila-month** (`Asia/Manila`, UTC+8, `CLUB_TIMEZONE`) slice of completed matches off the base tables. Browsable via a month picker fed by `get_leaderboard_months()` (distinct Manila-months with data + the current month). `MIN_MONTH_GP=8`, confidence `K=6`, **no win-streak, no Δ column**. SECURITY INVOKER (respects the permissive `matches_select` RLS), public-read. Month boundaries computed once as `make_timestamptz(y,m,1,…,'Asia/Manila')` → sargable `completed_at` range on partial index `idx_matches_completed_at`. Default tab on the no-session lobby.
- **All-time leaderboard**: reads `v_alltime_leaderboard_mat` (materialized view). Refreshed via `refresh_alltime_leaderboard()` RPC after each session. `MIN_ALLTIME_GP=10`, confidence `K=10`, shows the rank-movement **Δ** column (vs a 7-days-ago snapshot via `get_alltime_snapshot_before`). **Authenticated-only** and scoped to the caller's own clubs (§3.8d) — logged out returns zero rows, and rows are merged across clubs because the matview is keyed `(player_id, club_id)`.

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
- **In-app court-call auto-focus (client, PR #26):** `player-dashboard.tsx` switches to the My Status tab on the `hasActiveMatch` false→true edge (`prevHasActiveMatchRef`) — the full-screen MatchAlert takeover is scoped to the Status tabpanel, so a player browsing Live Courts / Waitlist / Leaderboard would otherwise only get the header dot + audio beep and could miss the call.
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

### 3.14b Queue — List / By-Skill view toggle

**Files:** `src/components/organizer/queue-control.tsx` (owns state + the toggle), `src/components/organizer/queue-skill-groups.tsx` (the grouped lens)

The Queue & Match Control tab renders one of two lenses over the same queue data, chosen by a `List / By Skill` segmented control at the top of the panel. State is local to `QueueControl` (`view: "list" | "skill"`), **defaults to `"list"`, and is not persisted** (every mount opens on List).

- **List** — the existing flat table (unchanged): all queue rows (waiting + on_deck + drafted), sorted by `status_priority` with paused sinking to the bottom; manual-match select-4, inline skill edit, PIN management, pause, checkout.
- **By Skill** (`QueueSkillGroups`) — **waiting players only** (`status === "waiting"`, so on_deck/drafted are excluded), grouped into skill-tier bands ordered **Advanced → Beginner** (derived from `SKILL_LEVELS` numeric desc). Within each tier, rows are sorted **longest-wait-first**, with paused players sunk to the bottom of their tier. **Empty tiers are hidden.** The top non-paused row per tier is flagged "Longest waiting" (amber wait number); bottleneck rows go red. Tier identity is the `SKILL_META` dot hue; all other chrome uses `cc-*` tokens + clip-cut geometry.

**Shared state, not a fork:** both lenses read the same `selected` set and call the same `QueueControl` handlers (`togglePlayer`, `handleSkillChange`, `handlePausePlayer`, `handleRemoveFromQueue`), so a manual-match selection survives switching views and feeds the same match bar. Checkout is offered on every waiting row in By-Skill (parity with List; locked rows never appear here).

**Responsive:** viewport breakpoints (not container queries). Below `sm` each row is a two-line stack (name + hero wait on top; a 44px-tall tappable skill chip + games below); at/above `sm` it expands to a single row (checkbox · name · skill dropdown · games · wait · actions). Wait time and actions are always visible.

**Accessibility:** the row is a plain `<div onClick>` (mouse convenience) with **no** widget role — the real nested `<input type="checkbox">` is the accessible, keyboard-operable selection control (avoids an ARIA nested-interactive violation and a duplicate tab stop). All tap targets ≥44px; focus rings use `ring-inset` so the clip-cut chamfer doesn't clip them.

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

**Files:** `src/components/organizer/organizer-entry.tsx`, `src/app/c/[clubSlug]/(full)/organizer/page.tsx` (hub), `src/app/organizer/page.tsx` (legacy redirect shim)

Organizers do not need a persistent account. The organizer hub lives at `/c/[clubSlug]/organizer` (member-gated by the `(full)` layout) and lists ALL of that club's sessions, active + past (`sessions.club_id = club.id`, service client — the hub shows each active session's `organizer_passcode`, which the anon client's column grants exclude). It is deliberately NOT filtered by `created_by`/`session_organizers`: anonymous auth means one physical organizer accumulates several user IDs, so an ownership filter would hide their own sessions. Session creation always attaches to the URL club (`soloClubId = club.id`); `openSession` navigates club-aware (club path when a slug is in context) and no-ops on an absent id. Legacy `/organizer` is a redirect shim: `getPrimaryClubSlug(user.id)` → 308 `/c/<slug>/organizer`, no club → `/welcome` (§11.7). `SessionWithStats` is exported from `organizer-entry.tsx` (the consumer) so both routes share it. Additional organizers join via passcode (`elevate_to_organizer` RPC); `organizer-entry.tsx` handles the passcode gate UI.

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

**Freshness (PR #26):** `wait_minutes` / `is_bottleneck` are computed by the view at query time — they only advance when `fetchQueue` runs, which is otherwise purely mutation-driven. `use-organizer-data.ts` therefore re-polls the queue every **45 s while the tab is visible** (`WAIT_TIME_POLL_MS`) so the minutes keep ticking and bottlenecks escalate during quiet stretches with no queue mutations.

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
> Every match id is also bound to the authorized session at **both** layers as of 2026-07-23 — see **§3.22a** before touching these actions or their RPCs.
- `MATCH_NOT_ACTIVE` → match is no longer in_progress, **or does not belong to this session** — close sheet
- `PLAYER_NOT_IN_MATCH` → player already moved — close sheet + info toast
- `PLAYER_UNAVAILABLE` → queue player taken — keep sheet open, re-pick
- `ONDECK_MATCH_STARTED` → on-deck match promoted mid-confirm — close sheet
- `FILL_PLAYER_UNAVAILABLE` → fill player taken — keep fill picker open

**Broadcasts:** `broadcastOrganizerIntervention` fires to all affected players after every swap.

**`ActiveCourts` new props:** `onDeckMatches: EnrichedMatch[]`, `queuePlayers: QueueFullWithWaitTime[]`, `sessionId: string`. Local inline toast renamed `banner` to avoid shadowing Sonner's `toast` import.

**`PlayerRowDark` changes:** `onLongPress` prop adds pointer-event handlers + keyboard fallback (Enter/Space fires immediately). `lp-hold` CSS class applied during the hold for visual feedback. Non-interactive rows restore `hover:bg-cc-border`.

**Migration `20260601000000_live_match_player_swap.sql` applied to Supabase production ✅ (2026-06-01).**

---

### 3.22a RPC execute lockdown + live-swap session binding (2026-07-23)

**Files:** `src/app/actions/live-match-swap.ts`, `src/types/database.ts`. Migrations `20260723000000` (revokes) + `20260723000001` (session binding).

**Why (`TENANCY_AUDIT_2026-07-21.md` #10) — two stacked defects.**

**(a) The mutating RPCs were reachable from the browser.** Every server action here is written `auth → authorize → service-role RPC`, so the function grants were never treated as a boundary. But PostgREST exposes everything in `public` to whichever role holds `EXECUTE`, and Supabase's `ALTER DEFAULT PRIVILEGES` stamps `anon` + `authenticated` EXECUTE at `CREATE FUNCTION` time. Verified against prod with nothing but the anon key and **no `Authorization` header**: `POST /rpc/swap_player_in_active_match` answered `400 P0001 MATCH_NOT_ACTIVE` — the function's own `RAISE`, i.e. execution reached the business logic and failed only because that match wasn't live. A correctly-revoked control answered `401 42501`. The catalog sweep found **16** volatile `SECURITY DEFINER` non-trigger functions in that state: `create_match_with_players`, `create_held_cross_court_match`, `swap_player_in_match`, `swap_player_in_active_match`, `swap_match_players`, `swap_teams_in_active_match`, `swap_active_from_ondeck`, `undo_swap_active_from_ondeck`, `revert_match_to_active`, `clear_on_deck_match_atomic`, `clear_all_unpublished_drafts`, `fix_record_swap_player`, `record_match_event`, `compute_session_wrapped`, `refresh_cross_session_stats`, `refresh_alltime_leaderboard`. SECDEF means RLS never applies, so this was anon executing the *privileged* path — match forgery, live-roster rewrites, draft deletion, audit-event forgery with any actor name, historical-record rewrites, stats poisoning, all with no account.

**(b) The live swaps authorized on `sessionId` but mutated by `matchId`.** Each action gates on `isSessionOrganizer(user.id, sessionId)` and then calls an RPC keyed on a *separately* client-supplied `matchId`. None of the four RPCs compared `matches.session_id` to `p_session_id` — that argument drove only the `queue_entries` writes and the audit stamp. `swap_teams_in_active_match` didn't even take it: it read `session_id` back *out of the match* to label the event, so **the audit trail faithfully recorded the victim's session while the authorization had been performed against the attacker's**. Same authorize-on-A/operate-on-B shape as §3.23a's `getMatchEvents`, but on writes.

**What shipped.**

| Layer | Change |
| --- | --- |
| `20260723000000` | 16 × (`grant execute … to service_role;` **then** `revoke execute … from public, anon, authenticated;`) + `DO`-block assertions + `NOTIFY pgrst`. Grant **first**: on a from-scratch replay `proacl` is NULL, so the revoke materialises `acldefault` and would otherwise strip `service_role` too (see §3.8d and `20260722000004`). |
| `20260723000001` | `AND session_id = p_session_id` on every match lookup in the four live-swap RPCs; `swap_teams_in_active_match` gains `p_session_id uuid DEFAULT NULL`. |
| `live-match-swap.ts` | `allMatchesInSession(db, sessionId, matchIds)` pre-check on all five call sites, returning `MATCH_NOT_ACTIVE` — deliberately indistinguishable from "does not exist", so there is no existence oracle. |

**What deliberately keeps its grants:** `lookup_active_session` (anon — the public join path) and the six RLS helpers `is_club_member` / `session_access_level` / `has_match_access` / `is_session_organizer` / `is_match_club_member` / `is_session_club_member` (anon + authenticated — **RLS policies invoke them as the calling role; revoking them takes the whole app down**). The migration asserts all six for **both** roles before committing; checking only `authenticated` would let an accidental anon revoke through and break the logged-out `/tv` and public-session paths, and the forward-looking schema-parity sweep cannot see them either because it filters `provolatile = 'v'` and these are STABLE. Trigger functions are excluded by `prorettype <> 'trigger'::regtype`: they aren't callable over PostgREST and firing a trigger doesn't re-check EXECUTE, so their grants are inert. Inner `PERFORM record_match_event(...)` calls are unaffected — a call from inside a SECDEF function runs as that function's owner.

**Two non-obvious traps, both load-bearing:**

1. **`!=` had to become `IS DISTINCT FROM`.** With `AND session_id = p_session_id` added, a mismatch yields *no row*, so the status variable is NULL — and `NULL != 'in_progress'` is NULL, which plpgsql treats as false, so the old guard falls **through**. In `undo_swap_active_from_ondeck` that is the difference between a fix and a new bug, because it `RETURN`s instead of raising and every later statement addresses rows by client-supplied match ids. `NOT FOUND` is not a substitute: the two-match functions lock in id order to avoid deadlock, so it refers to whichever `SELECT` ran last.
2. **`DROP` + `CREATE` resets the ACL.** `swap_teams_in_active_match` needed a new parameter, which `CREATE OR REPLACE` cannot do, so it is dropped and recreated — and Supabase's default privileges re-stamp `anon`/`authenticated` on the new function. `20260723000001` therefore **re-issues** its own grant/revoke pair after the `CREATE`. A `DO` block asserts exactly one function of that name survives (two would be `PGRST203`). The `DROP` names **both** shapes, 7-arg and 8-arg, which is what makes the file re-runnable: naming only the pre-migration form leaves the new function in place on a second run and the bare `CREATE` fails `42723`. Migrations here are hand-applied against a prod whose stamps drift from the repo filenames, so a re-run is a realistic event.

**⚠ The rollout sequence is `20260723000000` → `20260723000001` → deploy, and neither step is reversible without breakage.**

**Migration 2 before the deploy.** `p_session_id` is `DEFAULT NULL` and the predicate is `AND (p_session_id IS NULL OR session_id = p_session_id)` — but that only makes *one* of the two orders safe. PostgREST resolves an RPC by the set of argument **names** in the body: a *subset* of the parameter names is accepted as long as every parameter without a default is covered, while a key that names no parameter at all is fatal. So migration-first means the old code sends only the keys it knows about (five at the `swapTeams` site, six at the `team_swap` undo site) and `p_session_id` simply defaults — safe, with the binding merely unenforced for that window — while **code-first means the new code sends `p_session_id` to a function that has no such parameter → no candidate → `PGRST202`, and every team flip and every `team_swap` undo fails until the migration lands**. The optional parameter buys tolerance for a *late deploy*, not for a *late migration*; a required one would have broken both directions. Overloading instead is not viable — two candidates matching the same name set answer `PGRST203`. Every caller passes it today; `undoLiveSwap`'s `team_swap` branch derives it from the match it already read. A follow-up migration should make it NULL-rejecting once this is deployed everywhere — until then `swap_teams_in_active_match` is the one function of the four that a caller can still invoke **unbound** by omitting the key, so for that function the real boundary is the revoke plus the TypeScript pre-check.

**Migration 1 before migration 2.** `20260723000000` acts on `swap_teams_in_active_match`, which `20260723000001` DROPs and re-CREATEs with an extra parameter. Naming a 7-type argument list after the drop raises 42883, and because the file is a single transaction that error rolls back **all 16 revokes** — leaving the unauthenticated hole open behind a signature error that looks unrelated to what the operator was doing. `20260723000000` therefore addresses that one function by oid (a `DO` loop over every overload of the name, with an explicit zero-iteration guard so it cannot become a silent no-op). The backwards order does not in fact get that far — `20260723000001`'s assertion 5a sweeps every volatile SECDEF non-trigger function for anon EXECUTE and aborts if `20260723000000` has not run, so out-of-order means "migration 2 rolls back", not "silent damage" — but the oid loop is there so that the second line of defence is a rollback rather than a corrupted ACL. Go in order regardless.

**Do not read step 1 as order-free.** The app calls all 16 through `createServiceClient`, which keeps EXECUTE — verified there is no browser-side caller, the only `.rpc()` calls outside `src/app/actions/` being `lookup_active_session` (anon, kept), `get_session_player_streaks` (authenticated, kept), `count_completed_matches_by_session`, `get_primary_club_slug`, and the `src/lib/` helpers, which are `server-only` or take a service client as a parameter. That makes `20260723000000` safe to apply **immediately**, ahead of everything, with zero risk to what is running. It does *not* make it deploy-order-free: 2 must precede 3 and 1 must precede 2, so 1 must precede 3. An operator who schedules step 1 after the merge has necessarily pushed step 2 after it too, which is the `PGRST202` window this whole change exists to avoid.

**Tests:** `tests/integration/live-match-swap.test.ts` LMS-14…18 (cross-session forgery per RPC, both-foreign, the realistic **mixed** own/foreign pair, and the silent-by-design undo asserted on *state* rather than the return value — plus a non-colliding variant, because the first undo test was being killed incidentally by a duplicate-key collision); `tests/unit/live-swap-session-binding.test.ts` (32 tests; the refusal cases **all assert the RPC was not called**, because asserting on the returned message alone stays green with the whole guard deleted — both layers refuse the same forgery). That file's LSB-CTX block is table-driven over every id and team field of all three `LiveSwapUndoContext` variants, plus a meta-test that the tables cover every `*Id` field the type declares: the guard is a hand-written per-variant array, and dropping one entry from it is exactly the mutation nothing else would notice. That meta-test is load-bearing on a single line — the fixtures it derives from are pinned to the real union with `as const satisfies { [K in Ctx["type"]]: Extract<Ctx, { type: K }> }`, without which the check is circular (`withField` casts through `unknown`, and the LSB-UNDO cases use their own inline literals, so the fixtures would have no type contact at all and a newly added field would never appear in them). `tests/integration/schema-parity.test.ts` gains a catalog sweep asserting **no** volatile non-trigger SECDEF function is anon/authenticated-reachable, plus a signature pin on the four rewritten RPCs. Validated on a real from-scratch `supabase db reset` replay (236 integration tests green) with an anon curl against the fresh DB returning `42501` on the revoked functions and `200` on `lookup_active_session`; 4 SQL + 12 TS mutants, all killed — including "drop `ctx.sessionId` from the `queue_replacement` id list" and "drop `ctx.fillPlayerId` from the on-deck list".

---

### 3.23a Match Provenance & Modification Audit (2026-06-17)

**Merged to `main` 2026-06-17 (`98e7f6e`); both migrations applied to prod (`match_provenance_audit` + `drop_match_origin` — live, `match_events` accumulating real rows).** Replaces the flat `matches.origin` enum with an auditable 3-layer model so every match's birth + every roster change is known.

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

**Reading the trail is bound to the AUTHORIZED session (PR3, tenancy audit #4).** `getMatchEvents(matchId, sessionId)` gates on `isSessionOrganizer(user.id, sessionId)` and then reads through the service client, which bypasses RLS — so the gate is the only check there is. The read was keyed on `match_id_snapshot` alone: two independent client-supplied arguments, only one of them authorized, which let an organizer of session A pass a match id from session B and pull another club's full trail (actor names, roster snapshots, swap history). It now filters on `session_id_snapshot` as well, so a mismatched pair returns zero rows instead of someone else's audit log. `session_id_snapshot` is `NOT NULL` and, unlike the live FK, survives match deletion, so historical rows are covered — verified on prod: 648 events over 465 matches, zero null snapshots and zero rows where the snapshot disagrees with the live match's `session_id`, i.e. the filter excludes nothing legitimate. `getSessionProvenance` was already session-keyed. **Tests:** `tests/unit/tenancy-session-binding.test.ts` (TB-EVENTS).

**Clear/cancel/leaver audit trail (PR #22 `dad594f`, 2026-07-13):** the three previously-silent delete paths now log a best-effort `cancelled` event via `logMatchEvent` — `clearOnDeckMatch` (actor + roster snapshot + `created_method`/`is_published`, `reason:'on_deck_cleared'`), `clearAllUnpublishedDrafts` (one event per swept draft; TS pre-fetch mirrors the RPC filter exactly: pending + unpublished + not-held; `reason:'batch_clear_unpublished'`), `checkoutPlayer` (one event per `cancelled_match_id` from the cleanup RPC; `actorId:null` → `actor_type='system'`; `payload:{reason:'checkout_below_min', trigger_player_id}`). Delete paths log BEFORE the delete so the FK is valid at insert (`ON DELETE SET NULL` + `match_id_snapshot` preserve the trail); a domain error after the log can leave a false `cancelled` row (narrow, accepted per §14.E-2); the PGRST202 fallback loops are intentionally un-audited. No migration — `event_type` is text, `record_match_event` already live. **Still deferred:** `published` events on the publish paths (zero metric impact). See MEMORY.md + `MATCH_PROVENANCE_AUDIT_PLAN.md`.

**Organizer queue-kick audit (`fix/audit-organizer-remove`, 2026-07-23):** closes the last silent cancel path PR #22 deferred. When an organizer kicks a player via `removePlayerFromQueue` → `remove_player_from_queue_organizer` RPC, any pending match the player was on that then drops below 4 is **soft-cancelled** (`status='cancelled'`, row survives). The action now re-queries the RPC's returned match ids for `status='cancelled'` and logs one best-effort `cancelled` event each — `actorId=organizer` (`actor_type='organizer'`, contrasting checkout's `system`), `phase:'draft'` (the RPC only touches `pending`, never `in_progress`), `payload:{reason:'organizer_removed_player', trigger_player_id, was_published}`. This is why a kicked on-deck match (the "Bri & Veejay vs Stelle & Alvin DG" incident) previously vanished with no trail. Logging runs after the soft-cancel (FK stays valid). Note a repo↔prod drift on the RPC's return array (deployed returns all-affected ids, repo migration returns only-cancelled) — the `status='cancelled'` filter is correct under both; reconcile the migration file in a later pass.

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

### 3.25 Repeat-Pairing Warning — manual match builder (2026-07-21)

**Files:** `src/lib/repeat-pairing.ts` (pure derivers) · `src/lib/repeat-pairing-copy.ts` (all wording) · `src/app/actions/repeat-pairing.ts` (2 organizer-gated actions) · `src/hooks/use-pair-counts.ts` · `src/hooks/use-repeat-pairing.ts` · `src/components/organizer/manual-match-bar.tsx` · `repeat-pair-details.tsx` · `repeat-marker.tsx` · wired into `queue-control.tsx` + `queue-skill-groups.tsx` + `organizer-dashboard.tsx`.

**Purpose:** When the organizer hand-builds a match in the Queue tab, warn — *before* creation — that a pair have already been teammates or opponents at or beyond the engine's own cap. **Strictly advisory: it never blocks, disables, or rejects creation.** Zero new tables and zero new realtime channels.

**Thresholds are imported, never hard-coded:** `DEFAULT_REPEAT_THRESHOLDS = { teammate: MAX_PARTNERSHIP_REPEATS, opponent: MAX_OPPONENT_REPEATS }` (both 2). A UI threshold *above* the engine cap would stay silent on exactly the pairings the engine already refuses.

**Selection is a 4-SLOT model, not a Set.** `Slots = [A1, A2, B1, B2]`. `togglePlayer` frees *that* slot on deselect and fills the *first free* slot otherwise; `handleCreateMatch` splits via `deriveTeams(slots)`. With the old insertion-ordered `Set`, deselecting pick #2 silently promoted a Team-B player into Team A, so both the team preview and the warnings lied. A derived `Set` is still passed to both row renderers, so their prop contract is unchanged.

**Sticky / non-sticky split (`ManualMatchBar` vs `RepeatPairDetails`):** on a 375×667 phone a bar carrying the full warning detail leaves <3 queue rows. The sticky bar holds only the count row + reserved CTA slot + team preview + ONE `line-clamp-1` headline + a `+N more` disclosure button, hard-capped at `max-h-[min(33vh,200px)]` with **no `overflow-y-auto`** (a scroller inside a sticky element is a touch trap). Full per-pair rows, the expanded match lists, and the creation error all render *below* the bar and scroll normally.

**`--cc-header-h`:** the dashboard header is `sticky top-0 z-20`, so a `top-0 z-10` bar is invisible beneath it. `organizer-dashboard.tsx` publishes the header's measured height on the dashboard root via `ResizeObserver` (height genuinely changes: `lg` flips `py-3`→`py-4`, closing a session removes a strip and 3 tabs); the bar uses `sticky top-[var(--cc-header-h,176px)] z-[15]` — above the queue's `z-10` checkbox hit-areas, below the header. Surfaces are opaque `cc-*` (the old bar was `dark:bg-amber-950/30`, 30% translucent, and rows scrolled visibly through it).

**Avoidability gate — the reason this isn't noise.** Everything is suppressed unless `hasCleanAlternative()` says the organizer could plausibly have done better, and entirely while `capSaturation !== null` (that notice already tells them to override manually, so an ungated warning fires hardest when they have no choice — and on an 8-player night, on nearly every match). At a *full* selection there is no "next pick", so the gate frees the last slot into a probe and adds its occupant back to the pool; without that it degenerates to "is the bench non-empty" and the headline vanishes at the exact moment the CTA goes live.

**Counts refresh without a 6th channel.** `useOrganizerSession`'s health check expects exactly `REALTIME_CHANNEL_COUNT` (5) channels — a sixth would permanently break `realtimeConnected`. Instead `useOrganizerMatches` exposes `matchesRevision`, bumped on every `matches`/`match_players` realtime event and after `callNextMatch` / `createManualMatch` / `cancelMatch` / `clearOnDeckMatch` / `swapPlayer` / `swapMatchPlayers`; `usePairCounts(sessionId, matchesRevision)` keys its refetch off it. Counts are **snapshotted when `filledCount` goes 0→1** and held until the selection clears, so engine draft churn can't re-rank the warning mid-tap. The headline is likewise pinned to the FIRST pair that tripped in an episode.

**A11y contract:** the visible headline is plain markup with no live semantics; announcement is a separately, **permanently mounted** `<div role="status" aria-live="polite" class="sr-only">` written on a 500 ms trailing debounce, gated on a `selectionEpoch` bumped only by user-initiated selection changes (a counts refetch never speaks — but the first counts adoption does, or a build that outran the fetch would be inaudible). Row markers are `aria-hidden` icon + `aria-hidden` micro-label + a real `sr-only` text node, rendered **inline right after `display_name` in BOTH renderers** (the List table is `min-w-[640px]` inside `overflow-x-auto`, so a right-aligned marker is off-screen on a phone). Teammate vs opponent is carried on **icon + label** (`TEAM 3RD` / `OPP 3RD`), never hue — and the chip reads `relations[0]`'s own count, since `primaryRelation` is teammate-first while `worstCount` is the max across all relations. A legend line resolves the referent ("Team A, alongside Alice, against Bob and Carol").

**Tokens:** `cc-amber` is the warning. **`cc-accent` is TEAL and already means SELECTED on this screen — never used for the warning**; it marks readiness (4 of 4) only.

**Newly-triggered pulse:** a pair that starts repeating on *this* tap gets a one-shot `cc-repeat-pulse` wash (0.8s amber→transparent, modelled on `leaderboard-flash`) on its detail row, and the collapsed disclosure button flashes too — that button is the only warning surface visible when the details are folded, so without it a tap that adds a third repeat looks identical to one that adds none. The flashed set is **episode-scoped** (a pair that trips, is deselected and trips again does not strobe) and fires on the same two triggers as the live region — a user tap or the one counts adoption — never on engine draft churn, since a flash on a background event just trains the organizer to ignore flashes. The global `prefers-reduced-motion` block collapses it, plus an explicit `motion-reduce:animate-none`.

**Also fixed here:** at the 4-player cap unselected rows were still clickable while `togglePlayer` no-op'd (a dead tap arriving exactly when the warning says "reconsider") — rows in both lenses are now inert and `aria-disabled`, matching the checkbox that was already `disabled`; the CTA slot is reserved (`invisible`, not unmounted) from ≥1 selected so the row can't jump height on the 4th tap; `Clear` gained `min-h-[44px]`.

**Live e2e (`tests/e2e/scenario-p-repeat-pairing.spec.ts`, 3 tests):** runs against a real Vercel deployment + the E2E sandbox session, seeding `diversity_pool_8` plus a clone of its completed match so alice&bob sit at exactly `MAX_PARTNERSHIP_REPEATS`. Covers what only a real deployment can prove: the warning firing from counts `fetchPartnershipCounts` computed against the real DB; the sticky bar pinning at the **real** header height (asserted both via computed `top` and by reading the `--cc-header-h` inline var off the dashboard root, since the 176px fallback sits only ~2px away); creation still succeeding with exactly the previewed teams; and the disclosure's list agreeing with the count. **It caught a real bug the unit suite could not:** `PairMatchRow` filtered on `team === "A"`, but `match_players.team` is the lowercase `Team` enum — both rosters rendered empty. The unit fixture had been written with `"A"`/`"B"` and so agreed with the wrong code.

**Tests:** `tests/unit/repeat-pairing.test.ts` (23, derivers) · `repeat-pairing-copy.test.ts` (20, wording) · `use-repeat-pairing.test.tsx` (25, episode/headline/gate/live-region/pulse) · `queue-control-repeat-pairing.test.tsx` (39, component contract incl. StrictMode convergence, sticky geometry, keyboard selection, and the "never blocks creation" invariant).

### 3.26 Session Resilience + Queue Transitions (2026-07-28 — the 07/25 incident fixes)

**Files:** `src/utils/supabase/client.ts` (`hasAuthSession`) · `src/hooks/use-auth-recovery-refetch.ts` (new) · `src/hooks/use-session-data.ts` · `use-enriched-matches.ts` · `use-queue.ts` · `use-organizer-queue.ts` · `use-leaderboard.ts` · `src/utils/supabase/middleware.ts` · `src/app/actions/sessions.ts` · `src/hooks/use-flip-list.ts` (new) · `src/components/player/waitlist-tab.tsx` · `player-dashboard.tsx` · `globals.css`.

**Why (07/25 Saturday session, first after the tenancy migrations):** refresh-token rotation races killed ~6 players' auth mid-session. A de-authed client is NOT redirected (middleware is pass-through by design for anonymous auth); its fetches silently run as `anon`, and under club-scoped RLS that returns **success-with-0-rows, not an error** — so every "if (data) setState(data)" hook wiped its list and players saw an empty queue ("kicked out") until the token recovered. Two more requests died at Vercel's 25 s middleware kill, and two organizers created duplicate Saturday sessions 343 ms apart, orphaning 3 players when the extra one was closed.

**The auth-loss contract every session-view fetcher now follows:** (1) an *error* preserves stale state (was already mostly true); (2) an *empty success* while the previous result was non-empty AND `hasAuthSession()` is false ALSO preserves stale state — RLS filtering is indistinguishable from genuine emptiness at the PostgREST layer, and only the auth probe can tell them apart; (3) a genuine empty (auth alive) commits, so real "everyone checked out / round finished" states still render; (4) `useAuthRecoveryRefetch(client, refetch)` refires the fetch on `TOKEN_REFRESHED`/`SIGNED_IN`, so a recovered session reconverges without waiting for tab refocus. The auth probe runs only on the rare empty-after-nonempty path, and every fetcher re-checks its `fetchSeq` after the probe's await. Residual: already-joined realtime channels stay anon-bound after recovery (bind-at-join); data converges via the recovery refetch + `useVisibilityRefresh` + the leaderboard's 15 s poll.

**Middleware:** the per-request `getUser()` cookie refresh is wrapped in a 5 s `Promise.race` + catch. Timeout/failure → request passes through with its original cookies (browser client owns recovery); success → `setAll` already rebuilt the response with fresh cookies. Never block a page on the auth endpoint.

**createSession duplicate guard:** refuses a second ACTIVE, non-hidden session in the same club created within 10 minutes; returns the existing session's name in `message` + `existingSessionId` (new `CreateSessionResult` field). Sits AFTER the club-admin gate (no session-name oracle for non-admins). Fail-open on a transient guard-SELECT error, and closing the duplicate un-blocks immediately (only active sessions count). Best-effort SELECT-then-INSERT — a sub-commit-latency tie needs a DB constraint, which time-window uniqueness can't express.

**Transitions:** `useFlipList` is a dependency-free WAAPI FLIP hook (framer-motion is NOT installed) — measures `offsetTop` (scroll-safe, unlike `getBoundingClientRect().top`), silent on first commit, `prefers-reduced-motion` checked in the hook because the global CSS reduced-motion block cannot reach WAAPI animations. Wired into `WaitlistTab` rows (reorders glide, joiners fade in). Player-dashboard tabpanels animate `tab-in` — **opacity-only, load-bearing:** any transform (even a retained `translateY(0)` via fill-mode) turns the tabpanel into a containing block for absolute/fixed descendants, and the status panel hosts MatchAlert's `absolute inset-0` overlay which must keep resolving against `<main>`. Not yet animated: organizer queue panel, LiveCourtsTab cards.

**Tests (12 new):** Q-AUTH-1..3 + fetchSeq/error-handling upgrades (`use-queue.test.ts`) · EM-AUTH-1..2 (`use-enriched-matches.test.ts`) · TG-DUP-1..2 (`tenancy-guards.test.ts` — refusal asserted before any INSERT reaches the builder) · FLIP-1..5 (`use-flip-list.test.tsx`, happy-dom, prototype-stubbed `offsetTop`/`animate`; asserts the FLIP deltas and the reduced-motion/first-commit silences). Test-harness note: files that `vi.mock` `@/utils/supabase/client` must spread `importOriginal` so the real `hasAuthSession` runs against the mock client's `auth` stub.

**Round 3 — realtime rebind + organizer/courts FLIP (branch `fix/transitions-round-3`).** (1) **Realtime socket recycle on auth recovery** (`utils/supabase/client.ts`): postgres_changes RLS binds at channel-JOIN time and `setAuth` cannot re-bind, so channels that joined during a no-session window (cold start racing hydration, or a SIGNED_OUT death) deliver nothing forever. The client now tracks `realtimeHadSession`; on a no-session → session transition with channels registered it recycles the socket (`realtime.disconnect()` + `connect()` → every registered channel rejoins with the fresh token = re-bind). Scoped tightly: routine TOKEN_REFRESHED on a live session NEVER recycles. Worst case equals status quo (recycled channels were already dead; recovery refetches repopulate data). Pinned by RAR-1..4 (`realtime-auth-recycle.test.ts`, vi.resetModules per test — the wiring is a module singleton). (2) `useFlipList` gains `{ animateEnter?: boolean }` — false when items own their entrance (tailwind `animate-in`), so FLIP animates MOVES only and never fights another animation for transform/opacity. (3) FLIP wired into: organizer List-lens `<tr>`s (order key includes `:status` so an on_deck float-to-top re-measures even when the id sequence survives), By-Skill lens `PlayerRow`s (order key includes `:skill_level` — a tier move changes offsets without changing the id sequence; the stable id registration makes it read as a MOVE across tiers), and `LiveCourtsTab` cards (animateEnter:false — `CourtMatchCard` keeps its `animate-in` entrance; keys are section-tagged because a promoted match REMOUNTS in the other section). Registration keys are always the stable row id; volatile attributes belong in the ORDER key only.

**Round 2 — the waiting→on_deck "Heads Up" flash (same branch).** Live-observed residual: a beat of blank page + "Ready to play?" before the Heads Up takeover. Three causes, three fixes: (1) `use-player-match.ts` ignored `error` on all 5–6 chained queries and committed `currentMatch = null` on any blip or anon-window result — now every query error preserves stale state, and an EMPTY result (assignments / active matches / profiles) without an auth session HOLDS instead of committing, incl. on the FIRST fetch; wired into `useAuthRecoveryRefetch`. (2) **Cold-start extension of the auth-loss contract** across `use-queue` / `use-session-data` / `use-enriched-matches` / `use-organizer-queue`: the previously-non-empty precondition is GONE — these are authenticated-only surfaces, so anon-emptiness is *never* authoritative; on a cold start the hold keeps `loading` true → skeleton instead of the join card. The trigger scenario is precise: the player unlocks their phone *because* the on-deck push fired → PWA reload → first fetch races auth hydration. (3) `MyStatusTab` MODE 1 returned `null`, so the overlay's enter slide revealed a blank page — now renders a static aria-hidden "Match Forming" continuity backdrop (no interactive targets; fully covered once the overlay lands). Also: all three `MyStatusTab` Leave Queue buttons gained a shared pending guard + error toast (double-taps fired `checkoutPlayer` twice and errors were dropped); score submit, overlay leave, and checkout dialog were already guarded. Tests: U-AUTH-1..2, U-ERR-1, Q-AUTH-4; U-new-2 rewritten to the new preserve-on-null-roster contract.

---

### 3.27 The `realtime:` topic prefix — every private broadcast silently discarded (2026-08-04)

**File:** `src/lib/broadcast.ts` · pinned by `tests/unit/realtime-private-broadcast.test.ts` RPB-2 and `tests/e2e/scenario-r-resilience.spec.ts` R-1/R-2. (Shipped alongside, but unrelated: the `is_hidden` leaderboard work in §2 — `src/lib/clubs.ts`, `src/app/leaderboard/page.tsx`, and the two `20260804*` migrations.)

**The bug.** All six senders in `broadcast.ts` posted to the topic `` `realtime:session-events:${sessionId}` ``, while every client joins the channel named `session-events:{sessionId}`. The topic strings never matched, so **no browser has ever received a message from this module.** Affected events: `session_closed`, `auto_matchmaking_toggled`, `auto_publish_toggled`, `cap_saturation`, `draft_cap_phase`, `organizer_intervention`. The fix is the removal of that prefix — nothing else changed.

**`draft_cap_phase` was the one event this did NOT revive — it had a second, independent defect, fixed separately in §3.28.** `broadcast.ts` carried no server-only guard, so it was bundled into whatever imported it, and `use-organizer-dashboard.ts` is `"use client"`. Its `clearing`/`generating`/`done` calls therefore ran **in the browser**, where `SUPABASE_SERVICE_ROLE_KEY` is undefined — the client build compiles that read to a runtime `process.env` lookup rather than inlining a literal (confirmed by inspecting the emitted chunk; the key is correctly *not* shipped to the browser), so `postBroadcast` returned at its missing-key guard. Those phases were never sent, and the co-organizer lockout overlay never engaged for anyone. The failure direction was at least safe — the unlock was delivered, the lock was not. See §3.28 for the fix.

**Why it survived months of use, and this is the part worth remembering.** Three independent things each made a dead channel look alive:

1. **The transport lies by design.** Supabase's REST broadcast endpoint (`POST /realtime/v1/api/broadcast`) answers **202 for any topic string whatsoever**. There is no such thing as an unknown topic — a topic nobody joined is a valid topic with zero subscribers. A send to a misspelled channel is byte-for-byte indistinguishable from a delivered one at the call site, and no error surfaces anywhere, ever.
2. **A polling fallback masked the two visible events.** `use-organizer-session.ts` re-fetches every 15 s, so `auto_matchmaking_toggled` and `auto_publish_toggled` *did* reach the UI — just via the poll, a second or two late, which reads as normal latency. Those two happen to be the only events a developer routinely exercises by hand. The other four have no fallback and were simply dead: closing a session never pushed players to Wrapped, and organizer interventions never toasted.
3. **A local repro was misread and became a standing instruction.** An earlier session tested the prefixed topic locally, saw it fail, observed the toggles working in production, and concluded production "normalises the prefix." `MEMORY.md` was then annotated *"Do not 'fix' the prefix on a local repro alone"* — which would have steered the next agent straight back past the bug. That note is now struck through and replaced.

The RLS policy corroborates it independently: `realtime_topic_session_id` (migration `20260723100000`) only parses topics matching `^session-events:<uuid>$`, so the prefixed form could never have been authorized for a subscriber even if one had joined it.

**How it was actually proven**, since a 202 proves nothing. A Node probe against production Realtime with a real authenticated subscriber: prefixed → 202, `delivered: false`; unprefixed → 202, `delivered: true`. Then end-to-end, R-1/R-2 **fail against the deployed app and pass against a local production build whose sole diff is `broadcast.ts`** — the assertions are windowed tighter than the 15 s poll, so the poll cannot account for a pass.

**Standing rule this establishes:** never conclude a broadcast was delivered from a 202, or from UI that has a polling fallback. Delivery is only ever proven by a subscriber that received the message.

**Regression shape.** RPB-2 no longer pins the topic to a literal; it asserts the sent topic equals the name the client passes to `.channel()`, so the two halves cannot drift apart again. That is only sound while RPB-3 keeps the client's literal anchored — otherwise both halves could agree on a wrong value and still pass. Both tests carry that dependency in comments.

**Test-infrastructure findings from the same production verification.** (1) `match_events.match_id` is **`ON DELETE SET NULL`**, so deleting a match nulls the pointer and preserves the audit row forever. E2E teardown deleted matches but not events, depositing ~36 rows per full-suite run into a production table — 171 had accumulated since 2026-07-02. `tests/helpers/teardown.ts`, `emergency-cleanup.ts` and `validate-cleanup.mts` now all delete/count `match_events` **by `session_id`**, never through the match ids: orphaned rows have a null `match_id` and are invisible to a matches-based query, which is exactly why the leak went unseen by a validator that reported "fully clean" throughout. `tests/integration/helpers/truncate.ts` carried the identical leak against the local integration DB and was fixed the same way. `emergency-cleanup.ts` also now spares `E2E_OrganizerBot` (it previously deleted it, unlike `teardown.ts`) — removing that account invalidates the saved Playwright storage state and breaks every sign-in until `npm run test:setup` re-creates it. (2) `useFlipList` is called in `waitlist-tab.tsx` *above* the `if (loading)` early return; roughly 60% of runs consequently emit four 240 ms ENTER animations instead of a 320 ms MOVE despite stable row identity. Cosmetic, not a regression from #45/#46/#48, recorded as a `test.fixme` in `scenario-r-resilience.spec.ts` with the measurement and a fix direction.

---

### 3.28 `draft_cap_phase` moved server-side — the co-organizer lockout actually works now (2026-08-04)

**Files:** `src/lib/broadcast.ts` · `src/app/actions/sessions.ts` (`applyDraftCapOverride`) · `src/hooks/use-organizer-session.ts` · `src/hooks/use-organizer-dashboard.ts` · `src/hooks/use-organizer-data.ts` · `src/components/organizer/organizer-dashboard.tsx` · `src/components/organizer/draft-cap-popover.tsx`.

**The bug (second half of §3.27).** The three-phase emit lived in a `"use client"` hook. `SUPABASE_SERVICE_ROLE_KEY` is never inlined into a client bundle, so every emit hit `postBroadcast`'s missing-key guard, logged `[broadcast] Missing SUPABASE_URL or service role key — skipping broadcast.` and returned **normally**. No error, no request, no lockout — for months.

**What changed.**

1. **`src/lib/broadcast.ts` now starts with `import "server-only"`.** This is the load-bearing part: it converts a future repeat of this mistake from a silent runtime no-op into a **build failure**. Next resolves `server-only` to a throwing module under the client condition, so a `"use client"` file that value-imports this module can no longer be built. `npm run build` is therefore a real gate on this class of bug, not just a typecheck.
2. **`"use server"` was NOT added, and must not be.** It looks like the shorter fix — the client import would become an RPC and the emit would run on the server — but a `"use server"` module publishes *every* export as an ungated, POST-able Server Action endpoint. All six broadcasters take a raw `sessionId` with no auth check, so anyone holding an action id could forge `session_closed` on any session UUID (kicking every player to Wrapped), plus `organizer_intervention`, `cap_saturation` and unbounded `draft_cap_phase` locks. That forgery capability is exactly what migration `20260723100000` closed by shipping **no INSERT policy** on `realtime.messages`. Pinned by `client-bundle-boundaries.test.ts` CB-3, and stated in the module header.
3. **`setCapAndClearDrafts` → `applyDraftCapOverride(sessionId, cap, opId)`** in `src/app/actions/sessions.ts`. The action now owns the whole sequence: validate (uuid → cap bounds → opId) → auth → `isSessionOrganizer` + `getActorContext` → persist via a single `UPDATE … RETURNING is_auto_matchmaking_on` (no read-then-write race) → emit. **Nothing above the authorization line emits**, so a forged or failed call can never leave anyone holding a lock. Auto OFF short-circuits to a lone terminal `done`; auto ON emits `clearing` → clear → `generating` → engine → `done`, with `done` in a `finally` so every failure path still unlocks. Every emit is **awaited**, not void'd — POST N+1 is not issued until N is ingested (so `done` cannot overtake `clearing`), and Vercel freezes the instance once the response is sent, which would kill a trailing void'd fetch.
4. **`opId`, not `actorId`, is the self-correlator.** A REST-originated broadcast has no sending socket, so Realtime fans it back to *every* subscriber including the initiator. The initiating tab records the per-operation UUID it minted (`myOpIds`) and treats an echo carrying one of its own ids as non-locking. `actorId` would be wrong: the same organizer's second tab would be misclassified as "self" and never lock.
5. **Lease, not latch.** Each emit carries `ttlMs` (server: `CAP_PHASE_LOCK_TTL_MS = 45_000`). The receiver clamps it to `[5_000, 120_000]` with a `30_000` default and re-arms it on every *advancing* phase, so a lost terminal `done` self-unlocks (with a toast, only when the tab is visible) instead of bricking a dashboard whose overlay has no dismiss control and no Esc handler. The initiating tab additionally runs a 60 s watchdog — longer than the server lease — in case the action never settles at all.
6. **Ordering guards on the receiver.** A closed-union phase check (`clearing | generating | done`, anything else warns and is ignored — the previous `phase === "done" ? null : phase` mapping let *any* other wire string lock the board permanently); `CAP_PHASE_RANK` so a late `clearing` cannot walk the lock backwards after `generating`; and a 16-entry finished-op ring so a `clearing` that arrives after its own `done` is discarded rather than re-locking for a full lease. **Legacy payloads (no `opId`) are exempt from the ring** — they all collapse onto one `__legacy__` sentinel, so remembering it would make the first legacy `done` swallow every later legacy `clearing`, and during a rolling deploy legacy is the *only* traffic. Correlation-free traffic simply cannot be de-duplicated; the lease is what bounds it.
7. **The overlay names the actor.** `capPhaseActorName` is exposed only when the lock is *remote*, so the organizer who started the reset never sees "Started by <themselves>".
8. **The whole emit-free pre-flight is inside one `try/catch`.** `createServerSupabaseClient()`, the `Promise.all` gate and the cap `UPDATE` can all throw on a transport or env failure, and CLAUDE.md forbids throwing out of a server action — the caller would get a network-shaped rejection instead of a `{success:false}`. One handler is safe here precisely because the span emits nothing, so no path through it can strand a lock; the raw cause is logged server-side and the organizer gets a clean message. (DCA-6b/6c.)
9. **`newOpId()` does not assume a secure context.** `crypto.randomUUID` is secure-context-only, so over plain http — a phone hitting a dev box at `http://192.168.x.x:3000` — it is `undefined`. Calling it threw on the *first* line of `handleCapChange`, before any `setState`, and the popover's `void onChange(cap)` swallowed the rejection: the chip did nothing at all, silently. That is the same failure class this section exists to delete, so it falls back to `crypto.getRandomValues` and hand-assembles a v4 (version + variant nibbles set, because the server validates the id with `isValidUUID`). Pinned by OD-16b, which shadows `randomUUID` with an own `undefined` property — `delete` alone is a no-op, since it lives on `Crypto.prototype`.

**Test shape — and why the old tests were worse than nothing.** The previous integration header advertised cases (notably a `DCINT-12`) that read as proof the broadcast worked, while no such test existed and the emit was dead on arrival. Replaced with tests that fail against the pre-fix code: `draft-cap-action.test.ts` (DCA-1…12c — gate ordering, phase sequencing against `invocationCallOrder`, never-throw), `use-organizer-session-cap-phase.test.ts` (UCS-1…10 — the lease, the clamp, opId correlation, the legacy exemption), `use-organizer-dashboard.test.ts` OD-11…21 (self-echo, remote lock, watchdog, plus a tripwire asserting zero `[broadcast] Missing SUPABASE_URL` warnings — a green run used to emit 19 of them), `client-bundle-boundaries.test.ts` (CB-1…3 — static analysis over `src/`, so the *class* is pinned, not just the one call site), `realtime-private-broadcast.test.ts` RPB-7, and `scenario-r-resilience.spec.ts` **[R-5]**, which is the only assertion that proves actual delivery: a second organizer context that never clicked anything must receive the frame and render the overlay.

**Known limitation — `capOpRef` is a single slot.** Two co-organizers changing the cap in the same instant can interleave: op2's `clearing` overwrites the slot, then op2's `done` unlocks the board while op1 is still generating. If op1 has an advancing phase left it re-adopts the slot and re-locks; if its only remaining phase is `done`, the board simply stays unlocked through op1's engine run. Either way the lease bounds the worst case, and the overlay is advisory (the server is the authority on the cap), so the residue is a flicker rather than a lost edit. A map keyed by `opId` would close it, at the cost of a second eviction policy for ops whose `done` never arrives — not worth it for a window this narrow. Recorded in the code as a comment so it stays a decision rather than an oversight.

**Status:** all 960 unit tests (55 files, 1 skipped), `tsc --noEmit`, scoped `eslint` and `npm run build` pass locally. **Independently reviewed twice, both passes "Minor issues", every actionable item fixed rather than logged.** Pass 1's three items became the secure-context `randomUUID` fallback, the wrapped pre-flight and the OD-11 re-labelling; because that restructured `applyDraftCapOverride` after sign-off, pass 2 audited just the delta — it re-traced the emit-free invariant against every callee above the line (no trigger on `sessions`, no `realtime.send` in any migration, `sessions` not among the 5 postgres_changes channels), proved each new test fails when its fix is reverted with zero collateral, and raised five items now closed: `newOpId` made total, the `capOpRef` qualifier above, an explicit `createServiceClient` call-count assertion in DCA-6b, the OD-16b shadow assertion moved inside its `try`, and the OD-11 comment corrected (`vitest.config.ts` stubs `server-only`, so that guard bites in `next build` only). The single-slot `capOpRef` was documented as accepted.

**Shipped and prod-verified 2026-08-04.** PR [#51](https://github.com/nayzjuan/badminton-app/pull/51) squash-merged to `main` as `e8e76bd`; Vercel production deploy `dpl_Bnqy3QVqKnEE8XCJZNHv3iftcgTi` READY. **[R-5] now passes against production**, which closes both this section's delivery proof and §3.27's — the whole resilience spec runs 5 passed / 1 skipped (the skip is the cosmetic `useFlipList` residual, still `test.fixme`).

**The first production run of [R-5] failed, and the failure was in the test, not the product.** The spec polled `capFrames.length > 0`, then immediately snapshotted `capFrames.join("\n")` and asserted it contained `"done"`. But `clearing` is emitted *before* the engine runs and `done` only *after* it returns, so the poll resolves on `clearing` alone and the snapshot is taken mid-cycle — the assertion raced the engine rather than detecting a defect. The received frame proved the product side was working end to end: topic `session-events:c858fa1e-…`, `"event":"draft_cap_phase"`, `"actorName":"E2E_OrganizerBot"`, a well-formed `opId`, `"phase":"clearing"`, `ttlMs: 45000` — a server-emitted broadcast, delivered to a second browser. The fix is a second `expect.poll` that waits for `"done"` *in the joined buffer* before snapshotting. The two polls are deliberately kept separate: the first distinguishes "no broadcast ever left the server" from the second's "the cycle started but never terminated", and each carries the diagnostic that fits its own failure.

**Production data was proven untouched.** A full 22-table content snapshot (`scripts/prod-snapshot.ts`, hashing canonicalized per-row JSON — row counts alone cannot see an UPDATE) was taken *before* the merge and diffed after the run: zero row-count change anywhere, and only three content drifts, each row-level-verified as sandbox-scoped — the `🤖 E2E SANDBOX` session's `max_auto_drafts_override` (since reset to `null`), the `E2E_OrganizerBot` profile's `updated_at`, and the `leaderboard_refresh_state` singleton. The other 19 tables were byte-identical, including all 200 profiles, 924 matches and 3 687 match_players.

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
Live standings board aesthetic (F1 timing screen). Zero-padded Barlow Condensed italic rank numbers (`01`, `02`…). JetBrains Mono GP stats column. BEG/INT/ADV text abbreviations — no pill badges. "You" row renders on the app-wide amber "you are here" canvas (`YOU_BG = oklch(0.78 0.17 62)`, fixed OKLCH identical in both themes — matches the leaderboard's amber YOU strip and the MatchAlert on-deck canvas; recolored from electric indigo in the 2026-07-13 polish pass to kill an off-palette AI-indigo tell) with dark warm text `oklch(0.24 0.05 62)` (≈6:1); its On Deck badge flips to dark-on-amber (`bg-amber-900/15 text-amber-950 ring-amber-900/25`), while other on-deck rows keep the light amber tint (`bg-amber-50/60 dark:bg-amber-950/20`). Top-4 positions colored `text-primary` (emerald), tail fades to `text-muted-foreground/35`. Dividers only between rows (no zone labels). Updates in real-time via Supabase subscription.

---

### 4.2 Color Semantic Language

| Color                 | Meaning                                       | Never use for anything else |
| --------------------- | --------------------------------------------- | --------------------------- |
| Emerald               | Available / success / confirmed               |                             |
| Amber                 | Pending / warning / mixed-level / on-deck / "you are here" (waitlist you-row `YOU_BG oklch(0.78 0.17 62)`, leaderboard YOU strip, MatchAlert on-deck canvas) |                             |
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
- **Card entrance (player Live Courts):** `CourtMatchCard` only — `animate-in fade-in slide-in-from-bottom-2 duration-300` (tailwindcss-animate). Stable `match.id` keys mean it plays only on true DOM insertion (first load, a genuinely new card, tab-switch remount); realtime refetches move/patch nodes without replaying it.
- **MatchAlert enter/crossfade/exit (`MatchAlertPresence`, `match-alert.tsx`):** none→active = component-owned slide-up (inline `transform` transition — pending 550ms soft expo-out, in_progress 380ms sharp expo-out); `pending ↔ in_progress` = crossfade dissolve where **only the incoming layer animates** (`ma-fade-in` 300ms) stacked over a fully-opaque outgoing layer (fading both dips combined coverage mid-dissolve and bleeds the background through); active→none = `ma-slide-out` 300ms (fade + 8% slide-down) revealing the tab content. Keyframes in `globals.css` use explicit from/to (tailwindcss-animate's from-only `enter`/`exit` left the persistent layer stuck at opacity 0). The outgoing layer unmounts on timers slightly past the CSS (`CROSSFADE_MS` 320 / `EXIT_MS` 340). All inline non-`!important` styles → the reduced-motion block below snaps them.
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
`disabled:opacity-50 disabled:cursor-not-allowed` on every interactive element. One deliberate exception: MatchAlert's Leave Queue button uses `aria-disabled` + a click guard instead of `disabled` — a truly disabled control drops out of the focus order, so the "Leaving…" label change would never be announced; `aria-disabled` keeps focus on it while `aria-live="polite"` reads the change (visual opacity/cursor classes applied conditionally).

**Initial-load skeletons (player tabs, 2026-07-13):**
`my-status-tab.tsx`, `live-courts-tab.tsx`, `waitlist-tab.tsx` render content-shaped skeletons on first load — never bare "Loading…" text. Wrapper: `role="status" aria-busy="true" aria-label="Loading …"`. Blocks: `bg-slate-200 dark:bg-muted animate-pulse` (the explicit slate keeps them visible on the pale light canvas where bare `bg-muted` washed out; plain `bg-muted` is fine where the skeleton sits inside a bordered `bg-card` shell, as in live-courts). Skeletons mirror the real layout (waitlist reproduces the board header + `56px 1fr auto` row grid) so the list doesn't jump when data lands; `loading` flips true→false once per mount, so they render exactly once — no flicker on realtime refetches.

**Full-screen overlay presence (`MatchAlertPresence`, `match-alert.tsx`):**
The match takeover is presence-managed, not conditionally mounted: `player-dashboard.tsx` renders `<MatchAlertPresence active={…|null}>` unconditionally inside the status tabpanel so state changes animate (see §4.7); the committed-key state machine adjusts state during render (guarded, converges, StrictMode-safe). A11y contract: overlay containers are `role="region"` + descriptive `aria-label` — **never** `role="alert"`, which would re-announce the entire roster on every child update; one visually-hidden `role="status"` `aria-live="polite"` span announces each state change exactly once. Focus moves into the overlay on appear (`tabIndex={-1}` root, synchronous focus in an `isActive`-keyed effect) and restores to the previously-focused element on exit. The outgoing crossfade/exit layer is inert (`aria-hidden` + `pointer-events-none`) so its stale controls (e.g. the in_progress ScoreInputCard) can't be touched mid-transition. (E2E note: `getByRole("region", { name: /on deck|match starting/i })` — see scenario-e/j.)

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

**Non-health ancillary:** 6. `session-settings:{sessionId}` — sessions table UPDATE filtered to this session. Handles `court_time_limit_minutes` changes. **Intentionally excludes `is_auto_matchmaking_on`** — sessions RLS SELECT only grants access to the session creator, so co-organizer postgres_changes events are silently dropped. The toggle is synced via broadcast instead. 7. `session-events:{sessionId}` (broadcast) — ephemeral server-to-client messages: `organizer_intervention`, `session_closed`, `auto_matchmaking_toggled`, `auto_publish_toggled`, `cap_saturation`, `draft_cap_phase`. Handled by `useOrganizerBroadcast` (player side) and `useOrganizerSession` (organizer side — toggle/cap sync + the co-organizer "{actor} cleared a match" intervention toast).

**Ref-based callback pattern:** All fetch functions stored in refs (`fetchCourtsRef`, `fetchQueueRef`, etc.). Subscriptions capture the ref, not the function value. This prevents the `useEffect` that wires subscriptions from re-running on every state update — channels stay stable.

**`courtsRef`:** Courts stored in both React state and a ref. `fetchActiveMatches` reads `courtsRef.current` to break the dependency chain that would otherwise rebuild all 5 channels on every court update.

**Monotonic sequence counter (`fetchActiveMatchesSeq`, `fetchQueueSeq`):** Each fetch call increments a counter; only the highest-sequence result is applied. Discards stale concurrent responses from race conditions.

**Page visibility refresh:** `use-visibility-refresh.ts` — triggers a data refresh when the tab regains focus (handles mobile app-switch scenarios where Realtime may have missed events). Wired in `player-dashboard.tsx` (queue/match/session), and (2026-07-13) also in `all-sessions-history.tsx` (the standalone `/play` history has no realtime — `fetchAll` gained a `fetchSeqRef` guard for the now-concurrent fetch path) and hook-level in `use-leaderboard.ts` (refetches the active board + `fetchMyStats`; the 15 s poll + `matches` realtime there only cover a live session / current month, so this is the only freshness path for all-time / past-month boards and the only *immediate* refetch on unlock). Double-firing `router.refresh()` on the player leaderboard tab (dashboard + hook instances) is idempotent + 5 s-throttled.

**Organizer freshness (PR #26, 2026-07-13):** `useOrganizerData` now wires `useVisibilityRefresh` too — re-fetches courts + queue + active matches on tab-wake (5 s-throttled by the hook) **and** on the `realtimeConnected` false→true edge (`prevRealtimeConnectedRef`), since Supabase does not replay postgres_changes missed while the socket was suspended (tablet sleep / tab switch / network blip). Separately, a **45 s visible-tab-only queue poll** (`WAIT_TIME_POLL_MS`) keeps `wait_minutes` / `is_bottleneck` advancing (§3.20).

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
| `early-diversity.test.ts`       | Early-session diversity (ED-SC / ED-OPP / ED-RN) — `scoreCandidates` fresh-first `GAMES_AHEAD_PENALTY`, opponent-vs-teammate overlap weighting (`OVERLAP_WEIGHT_OPPONENT` / `_TEAMMATE`), `deriveReuseNotice` equity thresholds |
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
| E — Match alert UI     | `scenario-e-match-alert-ui.spec.ts`            | MatchAlert overlay: on-deck copy/position, in-progress court heading, VIP tag. Locators use `role="region"` (`/on deck/`, `/match starting/`) per the 2026-07-13 a11y pass |
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

#### The migration set must replay from scratch (2026-07-22)

The integration job had never once been green, because `supabase db reset`
produced a database that did not match production. Much of production was built
through the Supabase dashboard, so the migrations described only part of it.
Each missing layer was hidden behind the one before it and only surfaced once
the previous was fixed:

| Layer                              | Declared by                                    | Symptom while missing                                                         |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Realtime publication membership    | `20260722000000`                               | replay aborted during DB setup                                                 |
| `v_recent_pairings`                | `20260722000001`                               | missing view                                                                   |
| RLS baseline (7 tables, 35 policies)| `20260722000002`                              | policies simply absent                                                         |
| Per-table/per-role grants          | `20260722000003` + `supabase/config.toml` (pg 17) | `permission denied for table profiles` from a **service-role** client       |
| Function `EXECUTE` grants          | `20260722000004`                               | "Too many attempts" on an empty attempt log                                    |

**The function-grant trap is worth knowing.** Several migrations lock a
`SECURITY DEFINER` function down with `revoke execute ... from public, anon,
authenticated`. On a function whose `proacl` is still NULL, Postgres
materialises the default ACL first — `{owner=X/owner, =X/owner}`, where `=X` is
the grant to PUBLIC — and only then removes the named grantees. Nothing in that
sequence mentions `service_role`. Production is unaffected only because its
functions were created while Supabase's `ALTER DEFAULT PRIVILEGES` were in
effect and already carry an explicit `service_role=X`. On a from-scratch
database the revoke of PUBLIC is the *only* thing between `service_role` and
the function, and it takes `EXECUTE` with it.

`joinAsCoOrganizer` is deliberately fail-closed, so a permission error on the
limiter RPC was indistinguishable from a real lockout: legitimate co-organizers
were refused with a rate-limit message against an empty log. `20260722000004`
asserts the invariant at apply time — every function in `public` must be
`EXECUTE`-able by `service_role` (already true of all 56 in production).

That `DO` block runs **once**, when its own migration applies; later migrations
always sort after it, so it cannot catch the next bad revoke. The forward-looking
gate is `tests/integration/schema-parity.test.ts`, which re-derives both halves
of the invariant from the catalog on every `supabase db reset`: `service_role`
can `EXECUTE` every non-trigger function in `public`, and `anon`/`authenticated`
still cannot execute the eight privilege-granting primitives
(`elevate_to_organizer`, `cojoin_record_and_check`, `migrate_player_identity`,
`join_queue`, `remove_player_from_queue_organizer`, `publish_match`,
`publish_all_drafts`, `rejoin_queue`). `rejoin_queue` is in the list precisely
because `20260722000004` is also the migration that *grants* it: of the four
grants it makes, `rejoin_queue` and `cojoin_record_and_check` are the two that
are simultaneously lockdown targets, so they are exactly the shape where a
typo'd `to service_role, anon` would otherwise pass unnoticed. Trigger
functions are excluded on purpose — they are only
invoked by the trigger machinery, so revoking `EXECUTE` on a `SECURITY DEFINER`
trigger function is legitimate hardening the gate must not forbid.

**Comparing ACLs:** `proacl IS NULL` means "default", which is functionally the
same as an explicit grant to everyone, so a string diff of ACLs is all false
positives. Compare *effective executor sets* via
`aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))`. And always pass
`has_table_privilege` / `has_function_privilege` an **OID**, never a name — the
name form resolves through `search_path` and the planner may evaluate it before
the predicate meant to constrain the rows.

**Forward hazard: the next `CREATE TABLE` must grant `service_role` SELECT
itself.** `20260722000003`'s first assertion is a *whole-schema* check — every
`relkind = 'r'` in `public` must be SELECT-able by `service_role` — not a check
over the tables it happens to enumerate. So any table added by a migration whose
timestamp sorts before `20260722000003` aborts the replay unless that migration
carries its own grant. Production never shows this, because Supabase's
`ALTER DEFAULT PRIVILEGES` stamps the grant at creation time; a from-scratch
database has no such default and the table arrives with no grants at all. It is
the same defect as the `is_hidden` column-grant trap one level up: **columns**
need `grant select (col)`, **tables** need `grant … to service_role`, and
**functions** need `grant execute … to service_role` after any
`revoke … from public`.

**Landing order matters, and it is not arbitrary.** These declarations are dated
`20260722000000`–`4`, which puts them at the *end* of the set on purpose: every
assertion they carry is a statement about the finished schema, so anything a
concurrent branch adds must sort before them. Both branches that were open when
this landed already did — `fix/hide-e2e-sandbox-session`'s `20260721101500` and
`security/throttle-reconnect-pin`'s `20260721210000`–`240000` — and each carried
its own grants, which is exactly what the assertions then confirmed. A future
branch that dates a migration *after* `20260722000004` skips the assertions
entirely and reintroduces the drift silently; the test file is the only thing
that still catches it, which is why the gate lives there and not only in the
migration.

#### `after()` in integration tests

Server actions schedule fire-and-forget work with Next's `after()`, which throws
outside a request scope — 29 failures once the suite could run at all.
`tests/integration/setup.ts` stubs it, and the stub **runs** the callback: the
call sites are not all push notifications (the seven in `queue.ts` wrap
`runEngineForSession`), so a no-op silently skips draft regeneration. Running it
is safe for the push sites because `pushToPlayers` swallows its own errors and
returns as soon as `ensureVapid()` throws, which it does wherever VAPID keys are
unset.

Real `after()` work outlives the action that scheduled it, so the in-flight
promise is registered with `tests/integration/helpers/after-queue.ts` and
`truncateTracked()` drains it before deleting rows — otherwise the engine is
still inserting matches while cleanup removes the rows they reference.

**Known limit, worth stating before someone trips over it.** Running the engine
sites inline is safe *today* only because no test pairs an auto-matchmaking-ON
session with a `queue.ts` action: every scheduled engine run hits the
`is_auto_matchmaking_on = false` early return, and the two tests that assert on
the engine mock it. The first test that calls `joinQueueAction` / `checkoutPlayer`
/ `togglePlayerPause(false)` against an auto-ON session gets a real background
engine run racing its assertions, and because `runEngineForSession` holds a
module-level `engineRunningFor` set, a direct `await runEngineForSession(sameId)`
in that test is silently skipped as already in-flight. Such a test must
`await flushAfterCallbacks()` first.

### Test Helpers & Fixtures

- `tests/helpers/teardown.ts` — `resetSandboxSession()`, `softResetSandboxSession()`, `seedSession()`, `repairSandboxState()` — sandbox lifecycle. `repairSandboxState()` is called automatically at the start of `softResetSandboxSession` (Step 0) to heal any stuck state left by a previous crashed test run — cancels orphaned matches, returns stuck players to `waiting`, frees stuck courts.
- `tests/helpers/admin-db.ts` — Service-role client for test assertions
- `tests/fixtures/auth.ts` — Organizer bot sign-in via cookie injection, `ORGANIZER_STORAGE_STATE` path
- `tests/fixtures/seed-sandbox.ts` — **Run with `npx tsx`** — idempotently seeds all 50 E2E_ bot players + 6 courts into the live sandbox session (`TEST_SESSION_ID`). Reads `.env.test` + `.env.local`. Safe to re-run.
- `tests/integration/factories/index.ts` — `makeProfile`, `makeSession`, `makeQueueEntry`, `makeCourt`, `makeMatch` — composable DB factories for integration tests
- `tests/integration/helpers/mock-auth.ts` — `mockAuthAs(userId)` / `clearMockAuth()` — per-test auth identity control
- `tests/integration/helpers/truncate.ts` — `truncateTracked()` — drains pending `after()` work, then deletes all rows and auth users created during a test
- `tests/integration/helpers/after-queue.ts` — `trackAfterCallback()` / `flushAfterCallbacks()` — holds the promises from the stubbed `after()` so cleanup can wait them out. Deliberately standalone: importing `setup.ts` from `truncate.ts` would re-run its `vi.mock` registrations.
- `supabase/seed.sql` — bootstrap auth user + profile at the all-zeros UUID (the one id `truncateTracked()` preserves) and the default club. A seed, **not** a migration: a migration that invented an organizer profile would write fake rows into production.

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
      page.tsx                   # Legacy shim — resolves primary club, 308 → /c/[clubSlug]/organizer (no club → /welcome)
      [sessionId]/page.tsx       # Legacy shim — resolves session's club, 308 → /c/[clubSlug]/organizer/[sessionId]

    c/[clubSlug]/                # Club-namespaced routes (§11) — root layout resolves slug + 404s; (full)/(app) layouts member-gate.
                                 #   Mirrors the flat routes above (play/organizer/tv/wrapped/leaderboard/admin/join).
      (full)/organizer/page.tsx  # Club organizer HUB — lists/creates THIS club's sessions (renders OrganizerEntry, soloClubId=club.id)
      (full)/organizer/[sessionId]/page.tsx # Club organizer dashboard — 404s unless session.club_id===club.id; closed session → club lobby

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
      queue-control.tsx          # Player queue table, manual match creation, pause, dnd-kit; List/By-Skill view toggle
      queue-skill-groups.tsx     # "By Skill" queue lens — waiting players grouped by tier (Adv→Beg), longest-wait-first
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
      sortable-card.tsx          # SortableCard, OverlayCard, CapSaturationNotice, HeldBadge, ReuseBadge — from on-deck-panel.tsx
      edit-match-dialog.tsx      # Score correction + revert-to-active — extracted from match-history-panel.tsx

    player/
      player-dashboard.tsx       # Player view shell (My Status, Live Courts, Waitlist tabs)
      match-alert.tsx            # Full-screen match takeover (pending amber / in_progress navy) + MatchAlertPresence (enter/crossfade/exit orchestration, focus + live-region a11y)
      on-deck-alert.tsx          # "You're up next" on-deck position card
      queue-toggle.tsx           # Join/leave queue button
      queue-status.tsx           # Queue position + wait time display
      live-courts-tab.tsx        # Live courts view for players
      waitlist-tab.tsx           # Waitlist tab showing all waiting players
      match-history.tsx          # Player's in-session match history
      all-sessions-history.tsx   # Cross-session match history on the /play lobby (grouped by session; foreground re-sync + fetchSeq guard)
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
    use-organizer-data.ts        # Composer over 4 sub-hooks + freshness layer (tab-wake/reconnect re-sync, 45s wait-time poll); takes currentUserId (co-organizer toast suppression)
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
    matchmaking-db.ts            # DB-facing engine layer — pool fetch, overlap map, fetchPullablePlayers, executeHeldMatch
    derive-reuse-notice.ts       # Pure: deriveReuseNotice — draft-card "N fresher waiting" equity chip (§3.5 Reuse badge)
    match-provenance.ts          # Pure origin/provenance transitions (auto/manual/held; _modified stickiness)
    match-event-log.ts           # Best-effort match_events writer (creation, publish, swaps, cleared/cancelled)
    cross-court/derive-held-state.ts # Pure held-draft readiness derivation (§3.1 cross-court drafting)
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
    early-diversity.test.ts      # Fresh-first scoring (ED-SC), equal opponent-weight tripwire (ED-OPP), deriveReuseNotice (ED-RN)
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
    scenario-i-fifty-player-simulation.spec.ts # 50-player sim (E2E_ bots, Groups 1-11, concurrent courts)
    scenario-j-drafted-status.spec.ts # "Match Forming" card, drafted→on_deck realtime transition
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

supabase/migrations/             # Chronological Postgres migrations (20260417 → 20260705)

next.config.ts                   # Security headers (CSP/HSTS/XFO, all routes) + permanent /c/legacy → /c/chillax redirect
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
24. **Draft capacity is a DYNAMIC cap, not the flat `MAX_AUTO_DRAFTS`** — `MAX_ON_DECK_MATCHES` / `ON_DECK_LOOKAHEAD` are no longer imported by `matchmaking.ts`. The live engine uses `slotsAvailable = max(0, getDynamicDraftCap(waitingCount) − draftCount)` where the cap is 3 / 5 / 6 by waiting-pool size (organizer `max_auto_drafts_override` is a ceiling), and `draftCount` counts **only `is_published=false`** pending rows in draft mode (published on-deck matches never block fresh drafts). Auto-publish mode instead counts `is_published=true OR is_held=true` pending rows (§3.5). Keep it a single atomic count per mode — do not reintroduce a second racing query.
25. **`create_match_with_players` returns `NULL` on TOCTOU conflict** — `{ data: null, error: null }` from the Supabase JS client means a DB guard fired, not a hard error. Always check `rpcError` and `!matchId` **separately**: `rpcError` = DB error (fail loudly); `!matchId` with no error = graceful slot-skip (log warning, continue). If the RPC is ever changed from `RETURNS uuid` to `RETURNS SETOF uuid`, the `!matchId` detection breaks silently.
26. **`engineRunningFor` Set is process-local only** — it prevents double-runs within a single Node.js process (e.g. two simultaneous queue joins), but is completely ineffective in Vercel serverless where each request may land on a different worker. Cross-process serialization is enforced exclusively by the DB-level TOCTOU guards inside `create_match_with_players` (migration `20260507000000`).
27. **Player "My Status" is driven by two independent realtime hooks that flip on different beats** — `useQueue` (queue_entries → `myEntry.status`) and `usePlayerMatch` (matches/match_players → `hasActiveMatch`). `QueueSubTab` (`my-status-tab.tsx`) bridges both transient windows: `drafted` / `on_deck` → "Match Forming" holding card (assignment: the queue row flips before the match loads — prevents the "kicked out" join-screen flash, PR #20); `playing` with `hasActiveMatch = false` → neutral "Wrapping up…" card (match end: `currentMatch` clears a beat before the row flips back to `waiting`, PR #26). Never re-broaden to "any non-waiting → Match Forming": that made a just-finished player briefly see "you've been selected". A genuinely-playing player never sees either card — the MatchAlert overlay takes over.

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
carries a `club_id`. All pre-existing data was absorbed into a fixed **default club, CHILLAX** (`…0001`; seeded
with slug `legacy`, renamed to `chillax` 2026-07-10 — see the slug-rename note under Routing), and every existing
player was backfilled as a member (`supabase/data-fixes/20260630_legacy_club_membership_backfill.sql`).

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
(no gate): `tv`, `join`. Each session route cross-checks `session.club_id === club.id` (404 on mismatch). The organizer session route additionally bounces a **closed** session (`!session.is_active`) to the club lobby (`clubBase(slug)`, PR #16) — the command center is a live-only control surface, mirroring the player dashboard's own `!is_active` guard.

**ADD-and-redirect migration.** New club routes re-use the existing PlayerDashboard / OrganizerDashboard /
TvBoard / LoginForm. Legacy `/play/[id]` + `/organizer/[id]` became thin resolve-and-redirect shims (308 →
`/c/<slug>/…`) that enroll the requester **only on a real participation signal** (see the gate below — they
originally enrolled anyone, which was tenancy audit #5). Public boards
(`/tv/[id]`, `/leaderboard/[id]`, `/play/join`) stay at root, shareable — **and**, mirroring the TV board,
also get a club-namespaced convenience variant for in-app nav (§11.4 for Wrapped's).

> **The shim auto-enroll is GATED as of PR3 (tenancy audit #5).** It originally enrolled *any* logged-in
> visitor — "same philosophy as QR-join" — which quietly made a bare session UUID a self-service membership
> in someone else's club: guess or be forwarded an id, load the legacy URL, and that club's roster, sessions
> and history opened up. A session id is not a capability; the QR path has a scan, these had nothing.
> Enrollment now requires a real participation signal, and only that one case:
>
> - `/organizer/[id]` → a **local** `isSessionOrganizerLocal(user.id, sessionId)` in the page — same predicate
>   every organizer-only action already gates on (`created_by` OR `session_organizers` OR an active
>   owner/admin of the session's club), so it admits exactly the people who could already act as organizers
>   here. Keeps the case the enroll exists for: `joinAsCoOrganizer` writes `session_organizers` and no
>   `club_members` row. Deliberately **not** the import of the identical `isSessionOrganizer` from
>   `@/app/actions/_shared` — see the RSC publication rule below.
> - `/play/[id]` → an existing `queue_entries` row for `(sessionId, user.id)`, read through the **service**
>   client on purpose. RLS on `queue_entries` is `session_access_level(session_id) IS NOT NULL`, i.e.
>   membership-derived, so the caller's own client cannot see the very row that proves a non-member walk-in
>   belongs there. Keeps the case the enroll exists for: an organizer added them to the queue directly.
>
> Both still redirect either way — the club route's own membership gate stays the single authority on what a
> non-participant may see, rather than a second copy of it here. Every live entry point already satisfies the
> gate: the home-page redirect only fires when the user *has* an active queue entry, the `/play` picker is
> already scoped to their primary club, and PIN reconnect resolves a session they were queued in.
> Enrollment proper belongs to `/c/[clubSlug]/join`, which is reached by QR and writes the queue row itself.
>
> **A failed enroll WRITE short-circuits to `/play`; a failed enroll READ still forwards (2026-07-24).**
> Both shims used to discard `ensureClubMembership`'s `{ ok }` entirely. That was never a strand —
> `requireClubMembership` already does `if (!role) redirect("/play")`, so a non-member ended up in the same
> place one hop later. What the shims gain is being fail-safe on their own instead of leaning on a downstream
> gate, and skipping a redirect plus the club layout's club and role reads.
>
> The distinction matters because `ok: false` covered two different situations. `EnsureClubMembershipResult`
> now carries a `reason`, and the shims branch on it:
>
> - `write_failed` / `club_not_found` → **divert to `/play`.** We know there is no *active* `club_members`
>   row. (After a failed reactivation the row does exist — it is just still `is_active:false`, and every
>   membership gate filters on `is_active`, so the outcome is the same.)
> - `read_failed` → **forward as before.** The membership SELECT errored, which says nothing about whether a
>   row exists. Every club owner/admin following a legacy `/organizer/[id]` link passes through that same
>   read, so diverting on it would turn a transient blip into "not a member" for someone who is one — the
>   thing `getClubRole` explicitly refuses to do. The club layout's query is independent and re-runs.
>
> Both shims test the known-negative reasons **by name** rather than `!ok && reason !== "read_failed"`, so a
> reason added to the union later forwards by default and has to opt in to diverting.
>
> This changes nothing for anyone whose enroll succeeds or is never attempted. It is also **not** applied
> everywhere `ensureClubMembership` is called: `/c/[clubSlug]/join` and the two call sites in
> `src/app/actions/auth.ts` still branch on bare `!ok`, so a `read_failed` on the QR-join path can still
> bounce an existing member. Those are pre-existing and lower-stakes (the join page is reached deliberately,
> not by a stale bookmark), but they carry the behaviour this section just called a regression. The fourth
> caller, `src/app/auth/callback/route.ts`, discards the result entirely and so has no divert to get wrong.
>
> `EnsureClubMembershipResult` is a **discriminated union** (`{ok:true; joined}` | `{ok:false; joined:false;
> reason}`), so "reason is set exactly when ok is false" is compiler-enforced — the shims key off `reason`
> by name, and a stray `{ok:true, reason:"write_failed"}` would divert someone whose enroll had succeeded.
>
> **Tests:** `tests/unit/tenancy-session-binding.test.ts` (TB-PLAY / TB-ORG / TB-IMPORT) — the enroll *is* the
> whole vulnerability, so a test that only asserts the redirect destination passes whether the hole is open
> or shut. TB-PLAY-6 / TB-ORG-9 cover the `write_failed` divert; TB-PLAY-7 / TB-ORG-10 pin the `read_failed`
> forward, which is the case that protects real members from a transient error. The producer side is pinned
> in `tests/unit/ensure-club-membership.test.ts`: EC-1/EC-3/EC-5 assert the exact `reason` rather than a bare
> `{ ok:false, joined:false }`, and EC-7 covers the errored SELECT (no insert, no update, `read_failed`).
>
> **⚠️ Why both gates are local functions: importing a `"use server"` module from an RSC page PUBLISHES it.**
> A `"use server"` module imported by another *action* module is an ordinary function call and registers
> nothing. Imported by something in the **RSC layer** — a `page.tsx`, a Server Component — its exports have to
> become values that could be handed to a client, so Next registers **every export** of that module as a
> dispatchable Server Action endpoint scoped to that route. Adding
> `import { isSessionOrganizer } from "@/app/actions/_shared"` to the organizer shim was measured, by diffing
> `.next/server/server-reference-manifest.json` across two builds, to take the app from **70 to 74** actions:
> `getAuthenticatedUser`, `getActorContext`, `isSessionOrganizer`, `isPlayerInSessionScope`, all newly
> reachable under `app/organizer/[sessionId]/page`. Two are cross-tenant oracles over a caller-supplied uuid
> and one is an unauthenticated uuid → display-name lookup, so a tenancy fix would have widened the very
> surface it exists to narrow. (Latent rather than live even then: action ids are salted with
> `serverReferenceHashSalt: encryptionKey`, regenerated per build unless `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
> is set, which this project does not set — but "hard to address" is not "not exposed".) Hence a local copy in
> each page and **TB-IMPORT**, which fails if either shim imports anything under `app/actions/` — the whole
> directory, extracted from the specifiers rather than matched on the alias, so a relative path, a dynamic
> `import()`, or a hop through a different action module cannot slip past a guard narrower than the rule.
>
> **The rule is "do not publish tenancy predicates", not "never import a `"use server"` module from RSC."**
> The app does the latter on purpose in four places: `getTvData` under `app/tv/[sessionId]/page` and its
> club-namespaced twin, `getWrappedData` under the two Wrapped pages. Those *are* in the manifest, and that is
> fine — they are public reads on deliberately public routes. What must not be published is a
> `(userId, sessionId) → boolean` authorization oracle or a uuid → display-name lookup. When a predicate of
> that kind needs sharing, move it to a `server-only` lib — not a `"use server"` one.

**Club-slug rename `legacy` → `chillax` (2026-07-10, PR #17).** The founding club (CHILLAX, `…0001`) was
originally seeded with the slug `legacy`; the slug was renamed in the prod DB (`UPDATE clubs SET slug='chillax'`)
and a **permanent redirect** in `next.config.ts` (`redirects()`: `/c/legacy/:path*` → `/c/chillax/:path*`,
`permanent: true`) keeps every pre-rename bookmark, live-session QR code, and push deep-link resolving. Realtime
survives a slug rename independently (channels key on session UUID, not slug), so a mid-session rename only affects
hard refreshes of `/c/legacy/...` URLs, which the redirect covers. Stale "Legacy club" code comments were renamed
to "default club (CHILLAX)" in PR #21; the remaining `legacy` identifiers in code denote the pre-club routing layer
(the `/play/[id]` / `/organizer/[id]` shims), not the CHILLAX club.

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
pure membership-scoping, and was first used to fix `/play` and `/organizer`'s session listings (previously
unfiltered — a multi-club user saw every club's session names). **Superseded since:** `/play` now scopes to the
single primary club via `getPrimaryClubSlug` (§11.7), and `/organizer` is a redirect shim whose club-scoped hub
lists/creates only the URL club's sessions (§3.17) — creation is never ambiguous, so the old 0-or-2+-clubs
create-disable is gone. `getMyActiveClubIds` remains in use by `/leaderboard` and the `(full)` layout's club switcher.

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
through both routes against a real prod session (`bcf19499…`, CHILLAX club — slug `legacy` at the time, now
`chillax`; the `/c/legacy/...` URLs below are the literal ones exercised then, and still resolve via the permanent
redirect): intro overlay + real awards feed
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
  user actually has a club, so the two converge with no loop. **`/organizer` (PR #25, 2026-07-13)** is the same
  shape — a pure redirect shim using the same resolver (`getPrimaryClubSlug` → 308 `/c/<slug>/organizer`, no club →
  `/welcome`), with the hub itself moved to `/c/[clubSlug]/(full)/organizer` (member-gated; sessions listed +
  created strictly for the URL club, `soloClubId = club.id`; multi-club organizers switch via the in-club switcher).
  See §3.17.
- **Onboarding:** a QR/invite registrant is enrolled (`ensureClubMembership`) and routed straight to their session
  as before — they never see `/welcome`. The blanket `handle_new_user` auto-enroll into the Legacy/CHILLAX club was
  **retired** (migration `20260705000000`), so a plain-link registrant has no club and lands on `/welcome`. Existing
  members are untouched; `migrate_player_identity` repoints `club_members`, so PIN reconnect preserves membership.
- Non-owner-facing `/clubs` redirects/links were repointed to `/play` throughout (`requireClubMembership`
  non-member bounce, `/play/join` + `/c/[slug]/join` enroll-fail fallbacks, `auth.ts` enroll-fail, the club error
  boundary, and the PWA manifest `start_url`), so a non-owner never round-trips through the owner-only hub.

### 11.8 `profiles_select` scoped to shared scope — tenancy audit #8 (2026-07-23)

The last table in the schema whose SELECT policy had no tenancy dimension at all. `profiles_select` was:

```sql
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (true)
```

so any signed-in user — including a `signInAnonymously()` guest who had never joined a club — could
enumerate every display name, skill level and VIP tag on the platform, and the **unfiltered** `profiles`
postgres_changes subscription (`subscribeToProfiles`, §5) streamed every profile UPDATE platform-wide to
every connected browser. `pin` was already excluded by the column grants (`20260701000010`) and
`PUBLIC_PROFILE_COLUMNS`, so this was a roster leak, not a credential leak.

**The rationale recorded for `USING (true)` was wrong.** `20260722000002` documented it as "intentional and
load-bearing… the public leaderboard and Wrapped share pages read arbitrary profiles while logged out."
`profiles` has **no SELECT policy for `anon` at all**, so no logged-out read has ever passed through this
policy — those pages go through the service client (PR #38 moved the leaderboard reads there explicitly).
The policy only ever governed authenticated users, so tightening it could not break a logged-out path. The
comment is corrected in place; the `USING (true)` branch survives in that file only so a from-scratch replay
reproduces the historical baseline before `20260723200000` tightens it.

**The predicate** (`20260723200000_scope_profiles_select_to_shared_scope.sql`):

```sql
USING ( profiles.id = (select auth.uid()) OR public.can_read_profile(profiles.id) )
```

The self arm stays in the *policy*, not the helper: it is a bare primary-key equality, so the planner uses it
directly for the seven `.eq("id", user.id)` server-component reads (plus the two in `auth.ts` / `queue.ts`)
without entering the function at all.

`can_read_profile(uuid)` is STABLE SECURITY DEFINER (`search_path` pinned), and is the union of five arms in
short-circuit order. **SECURITY DEFINER is required**: `club_members`, `queue_entries`, `matches` and
`match_players` each carry their own RLS, and evaluating them as the caller would make profile visibility
depend transitively on four more policies. It reads no `profiles` row, so there is no recursion.

| # | Arm | The state it keeps working |
| - | --- | --- |
| 1 | shared **active** club | the arm that fires for essentially every read in a single-club deployment; two index lookups |
| 2 | target is **queued** in a session the caller can reach | **walk-ins** — an organizer can queue somebody who holds no `club_members` row until `/play/[sessionId]` enrolls them. Without it a walk-in's name renders blank for the whole room |
| 3 | target **played a match** in a session the caller can reach | **players who left** — checkout DELETEs the queue row (`queue_delete_own` / `queue_delete_organizer`) but `match_players` survives; `useMatchHistory` and `useSessionCompletedPlayers` read exactly those profiles |
| 4 | target **organizes** a session the caller can reach | **QR-delegated organizers** (`session_organizers`, no membership). Without it visibility inside one session is asymmetric: the delegate sees the room, the room cannot see the delegate |
| 5 | target **created** a session the caller can reach | not implied by #4 — production has one session whose creator has **no** `session_organizers` row, so `handle_new_session()` cannot be relied on |

Arms 2–4 are latent in production today (0 queued non-members, 0 played non-members, 0 membership-less
delegated organizers, verified read-only before writing the migration). Arm 5 is **not** latent — that one
session with a creator and no `session_organizers` row is live data. They are present so the policy does not
start failing silently the first time one of those supported states occurs.

**Two consequences worth knowing before changing any of this.**

- **Arm 2 must stay exactly as wide as the `queue_select` policy.**
  `v_queue_full_with_wait_time` is `security_invoker = true` and **INNER JOINs** `profiles`, and it is what
  `useOrganizerQueue` reads. Narrowing arm 2 below `queue_select` therefore makes the organizer's queue
  **drop rows** rather than render "Unknown" — a missing player, not a missing name. The migration carries
  the same warning inline next to the arm.
- **Arms 2–5 all gate on `session_access_level()`, which is membership/organizer-derived**, so a *reader*
  who is queued in or has played in a session but holds no active `club_members` row sees exactly one
  profile: their own. That is not a live regression — `requireClubMembership` bounces non-members to
  `/play`, and `src/app/play/[sessionId]/page.tsx` enrolls a queued walk-in before rendering — but note that
  the walk-in's *own* view depends on that enrol call, whose `ok: false` return is currently not checked.
  `queue_select` has the same shape (no "own row" arm), so such a reader could not read their own queue row
  either, before or after this change.

**Grants.** `service_role` is granted **first**, then `revoke execute … from public, anon, authenticated`,
then `grant execute … to authenticated` — the from-scratch replay trap from `20260722000004` (§7): on a
`proacl`-NULL function the revoke materialises `acldefault()` and strips `service_role` along with PUBLIC.
The helper is deliberately **narrower** than the six RLS helpers: it is not anon-executable, because unlike
the pure string parser in PR #40's `20260723100000` it reads tables, and an anon `/rest/v1/rpc/can_read_profile` would
be a membership oracle. The migration's closing `DO` block asserts the qual is no longer `true`, that it
names `can_read_profile`, that the policy is SELECT-only and `authenticated`-only, that **no** anon/PUBLIC
SELECT policy exists on `profiles` (one would fail closed without an anon grant), the grants in both
directions, that `session_access_level` still holds **both** its anon and authenticated grants, and that
`can_read_profile(gen_random_uuid())` and `can_read_profile(null)` each return exactly `false` — never NULL,
never raising.

**Realtime is unchanged on purpose.** `subscribeToProfiles` still subscribes with no `filter=`. It does not
need one: postgres_changes applies the SELECT policy per row at delivery time, so narrowing the policy
narrows the stream (verified with a live subscription — an outsider receives their own UPDATE and not a
stranger's). A server-side `filter=` cannot express "shared club" anyway.

**Cost, measured** against a synthetic dataset ~15× production (1001 profiles, 200 sessions, 48 000
`match_players`):

| Shape | Plan | Time |
| --- | --- | --- |
| own profile, `.eq("id", uid)` | Index Scan `profiles_pkey` | 0.05 ms |
| 40 profiles by id, shared club (**the hot path**) | Index Only Scan + filter | 4.18 ms |
| 40 profiles by id, no arm matches | Index Only Scan + filter | 162 ms |
| unbounded `select count(*)` | Seq Scan, 1001 evaluations | 1746 ms |

Only the first two are shapes the app emits: every RLS-bound read of `profiles` is `.eq("id", user.id)` or
`.in("id", ids)`, which PostgREST renders as `id = ANY(array[…])` — an index qual, so the policy runs on the
requested rows, not on the table. The two slow rows are both **denied** paths. **Do not benchmark this with
`id IN (SELECT …)`**: that plans as a hash semi-join and, because an RLS qual is not leakproof, the planner
applies it under a full seq scan *before* the join — 1001 helper calls for 40 rows, ~1.9 s. It is a
measurement artifact, not a shape any client produces.

**Tests.** `tests/integration/rls-edge-cases.test.ts` → `describe("profiles_select scope — finding #8")`:
the enumeration itself (`count(*) === 1` for an unrelated user), one case per arm, `is_active` respected,
the anon-RPC revoke, and own-profile. They sign users in **for real** — `makeProfile` now returns the
generated `email` and exports `TEST_USER_PASSWORD` — because `mockAuthAs` only fools the server actions, not
Postgres; RLS is only exercised by a genuine `authenticated` JWT. Every arm test pairs its positive
assertion with a `not.toContain(stranger.id)` control, so a pass cannot be explained by the very bug being
fixed.
