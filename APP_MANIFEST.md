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

**Tenancy (#7, migration `20260723100000`).** The topic is a **private** channel. Before that migration it was public, and public topics skip authorization entirely — Realtime never consults `realtime.messages` for them. Anyone with the publishable anon key and a session UUID could both **read** every organizer event for a club they don't belong to (including the `actorName` / `anchorPlayerName` display names) and, worse, **write**: a hand-rolled `channel.send({ type: "broadcast", event: "session_closed" })` from a browser console redirected every player in that session to Wrapped, and a forged `draft_cap_phase: "clearing"` froze every organizer behind the lockout overlay. The join is now gated by `session_events_broadcast_read` on `realtime.messages`, whose predicate is `session_access_level(<topic session id>) IS NOT NULL` — deliberately the *same* predicate as `courts_select` / `queue_select`, so the audience is unchanged from the set that can already read the board, and deliberately **not** `= 'organizer'`, because players subscribe to this topic too. There is **no INSERT policy**, by design: the server emits with the service-role key (which bypasses RLS), so no browser can send at all. Never add one — and note `pg_policies` reports a `for all` policy as `cmd='ALL'`, which confers INSERT just the same. Both halves are pinned by **Suite RB** ([tests/integration/realtime-broadcast-rls.test.ts](tests/integration/realtime-broadcast-rls.test.ts), §3.35), which runs the real policy against real rows; the client-side tests (`RPB-*`, `[R-1]`) only ever covered the positive path. Display names **stay** in the payloads — the audit's third fix clause ("send only ids") was declined 2026-07-24 (in `4bc5cfc` itself) and finally recorded in the audit 2026-08-13, because the join predicate puts every recipient inside `profiles_select`'s reach for the anchor name outright and for the two `actorName`s with exactly one narrow exception that is itself the feature; see §3.36.

- `organizer_intervention` — `{ type: "on_deck_cleared" | "match_cancelled" | "active_roster_changed", affectedPlayerIds, actorId?, actorName? }` → player-side toast via `useOrganizerBroadcast` (players filter by their own id). `clearOnDeckMatch` + `cancelMatchAction` attach the acting organizer (PR #19): `useOrganizerSession.onIntervention` then toasts co-organizers ("{actor} cleared an on-deck match"), skipping the actor's own client (`actorId === currentUserId`) and any actor-less broadcast (batch cap-reset clears + roster swaps, which repaint in place and need no notice).
- `session_closed` — redirects all connected players to `/wrapped/{sessionId}/{playerId}`.
- `auto_matchmaking_toggled` — `{ isOn: boolean }` → syncs auto-matchmaking state to all co-organizers (bypasses the sessions RLS SELECT policy that would silently drop postgres_changes for non-creator organizers).
- `auto_publish_toggled` — `{ isOn: boolean }` → syncs auto-publish mode state to all co-organizers (same RLS-bypass rationale). Handled in `use-organizer-session.ts`; `auto_publish` is also excluded from the postgres_changes apply so it never double-syncs.
- `cap_saturation` — `{ type: "general" | "red_zone", anchorPlayerId, anchorPlayerName }` → fires when the partner-repeat cap (not player shortage) blocks every possible team split for the anchor player; `red_zone` once the anchor has waited ≥ `CRITICAL_WAIT_MINUTES` — tested with `isRedZonePlayer(anchor)`, **not** a `priorityScore ≥ RED_ZONE_SCORE_FLOOR` comparison, which is not the same condition (§3.34). Handled in `use-organizer-session.ts` → surfaces the `CapSaturationNotice` banner in the on-deck panel so the organizer knows to intervene manually.
- `draft_cap_phase` — `{ phase: "clearing" | "generating" | "done", override }` (`override: number | null`, null = Dynamic) → drives the synchronized dashboard lockout overlay during a cap-change reset; `done` is also emitted on failure so co-organizer screens never stay locked.
- `queue_notice` — `{ kind: "player_left", playerId, playerName, cancelledDraft, actorId?, actorName? }` → centered dismissible card on every organizer / co-organizer dashboard with Match Control open. Emitted by `checkoutPlayer` (no actor — every board sees it) and `removePlayerFromQueue` (actor attached; the acting dashboard suppresses). Player-side `useOrganizerBroadcast` does not handle this event. Pause reminders are **not** broadcast — they are computed locally from `queue_entries.paused_at`.

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
| `paused_at`    | `timestamptz \| null`| When the organizer paused this row. Null when not paused.              |
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
| `v_recent_pairings`            | Recent co-player pairs per player; **not used by the engine** (superseded first by a 3-step manual join, then by `deriveOverlapMap` over the per-slot session match snapshot; view still exists in DB but is not queried by the engine) |
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
| `compute_session_wrapped(p_session_id)`                 | Computes and upserts all `session_wrapped_stats` for a session. Redefined by `20260704000000` (deuce_magnet threshold 20-20 → 30-30 — scoring is sudden-death to 31, so 30-30 is the real drama point) and `20260704000001` (awards one-time `first_to_100` via an atomic `club_milestones` claim; only the claim-winner ever gets the slug). Declared in full by `20260810000000`; `20260811000000` then made the six all-time-threshold awards one-time via a `_prior_awards` ledger (§3.7.1). |
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

Tier 2 — Red Zone   (score USUALLY 1000–1999 — but see the warning below):
  Condition: wait ≥ CRITICAL_WAIT_MINUTES (20)
  Score: 1000 + waitMinutes − (gamesPlayed × GAME_PENALTY_MINUTES)
  ⚠️ 1000 is an ADDEND, not a floor. Whenever gamesPlayed × 8 > waitMinutes
     the score lands BELOW 1000 (wait 22 / 3 games → 998) even though the
     player IS in the Red Zone. Downstream consumers MUST use
     isRedZonePlayer(), never a priorityScore ≥ RED_ZONE_SCORE_FLOOR test.
     Two cohorts land here: wait ∈ [20,25) with heavy game debt, and
     wait ≥ 25 with games ≥ 5 (excluded from Tier 3 by HARD_CAP_GAMES_CEILING,
     so they fall THROUGH into Tier 2 — wait 30 / 5 games → 990). See §3.34.

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
  (Red Zone = isRedZonePlayer(c) — wait ≥ 20 OR score ≥ 1000, and never a pulled body.
   The score arm still catches the Hard Cap tier, since 2000 ≫ 1000.)
  gamesAhead = max(0, games_played − poolMinGames)   [fresh-first rule, 2026-07]
```

Sorted ascending (lowest score = highest priority). Red Zone overlap penalty is capped at 100× so a Red Zone player with 1 recent overlap still beats a Normal player with 0.

**Fresh-first rule (early-session diversity):** `poolMinGames` = min `games_played` across the WAITING pool (pulled bodies excluded — their mid-game count reads one low). Each candidate is penalised one overlap-unit-equivalent per game above that minimum, so the freshest waiting cohort fills rosters first whenever the skill window allows. Pulled bodies are exempt from the term entirely (their ordering stays governed by `priorityScore = -1`, C-3). Zero effect when all games are equal (e.g. t=0) — behaviour is bit-identical to before. Red Zone urgency still wins (100× variant).

#### Group Assembly (`buildCombinationGroup`) — N-choose-3 Combination Search

Replaced the former greedy algorithm. Iterates all C(n,3) triples of scored candidates looking for one where all 3 + the anchor form a valid group (`isGroupValid`). Worst case: C(30,3) = 4,060 iterations.

**Two modes, and the gate between them is load-bearing** (2026-08-12, see §3.32):

- **Baseline** (no `lastOpponents`, or an empty one): returns the **first** valid triple and breaks immediately — pre-sorted candidates mean the first valid combo IS optimal.
- **Split preview** (`lastOpponents` non-empty): cost is `fairness + CONSECUTIVE_OPPONENT_PENALTY × repeats`, so first-valid is no longer optimal and the search becomes a **branch-and-bound argmin**. Bounded by `SPLIT_PREVIEW_BUDGET` (4,096 — sized to cover C(30,3); exhaustion is logged under `DEBUG_MATCHMAKING` and degrades to best-so-far, never below baseline).

⚠️ The two are **not** equivalent at zero penalty: lexicographic-first is not score-sum-minimal (`(0,1,5)` precedes `(0,2,3)` but may cost more). The `previewing` boolean — which requires a **non-empty** map — is what guarantees the baseline path is byte-identical to the pre-2026-08-12 engine. Do not relax it into a null check.

⚠️ A triple whose every team split is partnership-capped (`snakeDraft` → `null`) is scored at `MAX_CONSECUTIVE_OPPONENT_REPEATS + 1` — strictly **worse** than any real split, not 0. (The `+1` matters: at exactly `MAX` an unseatable four ties a seatable four carrying 4 repeats, and the argmin's strict `<` then keeps the earlier, unseatable one.) Scoring it 0 made "unseatable" the best possible preview, so the argmin preferred fours the seater could not seat; `runAlgorithm`'s `if (!draft) continue` then abandoned the whole skill window and the court seated **nobody** with `capSaturation: false`. Regression-tested by `CCO-11/12`, with `CCO-13` pinning that this stays a tie-break and never outranks games-owed.

#### Partnership Cap Enforcement

`derivePairCounts(snapshot)` — **pure** projection in `matchmaking-db.ts`, computed from the per-slot session match snapshot (see _Session match snapshot_ below). Aggregates all same-team pairings across all committed match statuses (`completed`, `in_progress`, **and `pending` — including unpublished drafts**) for this session into a `Map<pairKey, count>`. Derived once per `runAlgorithm` invocation (hoisted above anchor selection) at **zero DB cost**. The cap applies the moment a draft is created — not only after publish — so two concurrent draft generations cannot both claim the same pair under separate matches.

_(The old async `fetchPartnershipCounts(supabase, sessionId)` still exists, but the engine no longer calls it — it is now the organizer repeat-pairing badge's helper alone. See `src/app/actions/repeat-pairing.ts`.)_

**Universal pre-filter** (runs before any skill/diversity/rotation logic): After scoring candidates, any candidate whose `pairKey(anchor, candidate)` count is already at `MAX_PARTNERSHIP_REPEATS` is removed from the pool entirely. This happens before group assembly, before skill expansion, and before the last-resort fallback — there are no waivers.

`pairKey(a, b)` — pure helper in `matchmaking-core.ts`. Returns a canonical symmetric key `"lesser-uuid:greater-uuid"` so `pairKey(a,b) === pairKey(b,a)`.

#### Team Draft (`snakeDraft` / `rotatedDraft`)

Sort all 4 players DESC by skill, then apply a **two-pass approach** for partner freshness:

- **Pass 1 (prefer fresh)**: Try splits in skill-balance order where **both team pairs have `count = 0`** (never been partners). This prevents back-to-back same-partner games even when the pair is still below the hard cap.
- **Pass 2 (fallback)**: Try splits in skill-balance order where both pairs are `< MAX_PARTNERSHIP_REPEATS`. Original behaviour; reached only when no fully-fresh split exists.

Split order (most → least skill-balanced): `[0,3] vs [1,2]` → `[0,2] vs [1,3]` → `[0,1] vs [2,3]`.

- **snakeDraft** (normal): **balance-gated four-pass** (2026-07-30; lopsided seating **banned** 2026-08-17). Splits are partitioned by team-skill gap: **balanced** = gap ≤ minGap + `SKILL_VARIANCE_MAX`. The four-pass freshness search runs over the **balanced pool only** — lopsided splits (high+high vs low+low, the INT+INT vs BEG+BEG incident) are never returned. When every balanced split is partnership-capped, snakeDraft still seats the four mixed and flags **`usedCapOverride: true`** so the caller can try a different body first. Preview and Tier-1/2 swaps treat that flag like today's `null` (must not prefer an over-cap four). Last-resort and the main path after Fix B accept it (keep the four). The tolerance keeps the fresh-pair preference alive between near-equal splits (6/5/4/3: Split 2's gap 2 is still acceptable) and consequently balance also outranks opponent-cap freshness. `null` is no longer the stall-break for a real four.
- **Balance-preserving swap** (`runAlgorithm` main path): when snakeDraft flags `usedCapOverride`, the engine tries replacing each trio member (lowest-priority first, never a Red-Zone member — mirrors the diversity-swap guard) with another eligible scored candidate (skill window, ≤1 pulled body, no diversity violation) and takes the first swap whose draft is under the cap. If no such alternative exists, the mixed over-cap draft is accepted rather than stalling — never a lopsided split.
- **rotatedDraft** (forced repeat): cycles through 3 split configs based on `repeatCount % 3`, then **drops lopsided splits from the cycle**. A 2-high+2-low four therefore rotates between the two mixed pairings, not top-vs-bottom. A 4/3/3/2 four (e2e [H-2]) still allows Split 1 because gap 2 is balanced. Returns **`null`** when every remaining balanced split is partnership-capped so Tier-3 can still expand the skill window — this function does not cap-override.

#### Anti-Repeat / Diversity Logic

##### Session match snapshot — the single read behind every diversity input (2026-08-04)

All three diversity inputs — recent rosters, the partnership/opponent caps, and the overlap map — are **derived from one snapshot**, not fetched separately. `fetchSessionMatchSnapshot(db, sessionId)` in `matchmaking-db.ts` is issued once **per engine slot**, concurrently with `fetchActivePool`:

1. `matches` → committed match IDs for this session (`COMMITTED_MATCH_STATUSES`), ordered `created_at DESC, id DESC`.
2. `match_players` → the roster rows for those IDs. **Skipped entirely** when step 1 is empty.

Ordering lives in SQL, never in JS. The `id DESC` tiebreak is load-bearing rather than decorative: one draft burst writes a single `created_at` for every row it commits, so ties are the norm and `created_at DESC` alone leaves "the 5 most recent matches" non-deterministic.

**Fails closed.** `SESSION_MATCH_SNAPSHOT_CEILING` (200; prod's busiest session ever is 56) bounds the read. A query error, or a session past the ceiling, returns `{ ok: false }` and the engine **stops the burst** — with empty history every repeat would read as a fresh pairing, so falling through would emit exactly the duplicate rosters the caps exist to prevent.

**Cost:** per slot 8 queries at depth 8 → **3 at depth 2**; counting the commit RPC, 9 requests → 4. The deepest possible burst is 6 slots (`MAX_AUTO_DRAFTS_XLARGE`), so a full regeneration drops 54 → 24.

The three derivations below are **pure** and cost no further round trips:

- `deriveOverlapMap(snapshot, anchorId)` — anchor-specific, derived per engine slot. **Does not use `v_recent_pairings`.** Teammate/opponent overlap weights are **equal** (`OVERLAP_WEIGHT_TEAMMATE = OVERLAP_WEIGHT_OPPONENT = 2`, raised from 2/1 in the 2026-07 diversity pass so re-facing is avoided as hard as re-partnering — the primary round-2 opponent lever). Walks the anchor's most recent `ANTI_REPEAT_LOOKBACK` matches within the snapshot and weights each co-appearance: **teammate = opponent = 2×**. Includes `pending` matches, so it sees live pairings and not just finished games.
  - _Latent bug this replaced:_ the old `buildOverlapMap` fetched the anchor's `match_players` rows **globally** — every session they had ever played — under an unordered `.limit(200)`, then intersected with the current session. A heavy regular past 200 lifetime rows could have this session's own matches truncated away by unrelated ones, and the engine would read a genuine repeat as fresh.
- `deriveRecentRosters(snapshot)` — the last `ROSTER_LOOKBACK_COUNT` (10) match rosters as arrays of player IDs. Because the snapshot is re-read **per slot** inside `runEngineInternal`'s fill loop (2026-07 intra-burst fix), `isDiversityViolation` sees sibling drafts committed by earlier slots of the same burst. Includes `completed`, `in_progress`, and `pending`.
- `isDiversityViolation(playerIds, recentRosters)` — flags true if ≥3 of the proposed 4 players appeared together in any single recent match roster.
- `getEffectiveLookback(eligiblePoolSize)` — scales lookback window to pool size (≤5 → 2, ≤9 → 3, ≤15 → 4, 16+ → **7**) to prevent small-tier starvation. The 16+ tier was increased from 5 to 7 now that `deriveRecentRosters` yields 10 matches (sufficient headroom).
- `derivePairCounts(snapshot)` — returns **`{ partnershipCounts, opponentCounts }`** (both maps built in one pass over the snapshot). `opponentCounts` = cross-net (opponent) pair counts, used by snakeDraft/rotatedDraft as a soft preference.
- `deriveLastOpponents(snapshot)` — who each player faced **across the net in their LAST match only** (2026-08-12, §3.32). Whole-pool, not anchor-relative, which is the entire point: **79.3% of back-to-back opponent repeats are between two NON-anchor co-players**, which `deriveOverlapMap` structurally cannot see at any weight. Newest-first (first write wins, relying on the snapshot's `created_at DESC, id DESC` contract) with **no lookback window** — a player's last match counts however long ago it was. A malformed roster (not exactly two teams of two) marks its players **seen with an empty set** rather than being skipped, so an older match can never leak in as someone's "last". Bounded by `SESSION_MATCH_SNAPSHOT_CEILING`, so O(≤200 × 4) with a per-player early-out.

⚠️ **Test-authoring trap.** The engine unit suite's mock client is a FIFO queue keyed on `from()` order, and the snapshot **short-circuits on an empty `matches` response** — so a fixture whose history is `{ data: [] }` never issues the `match_players` read and shifts every later response by one. Supply a non-empty `matches` fixture only together with the `match_players` response that follows it. `ME-new-1` was silently vacuous for exactly this reason after the merge (its seeded history landed on a slot nothing read, and its only assertion was negative). It was vacuous a **second** time for an unrelated reason: its 3-player fixture tripped `pool.length < PLAYERS_PER_MATCH` at `matchmaking.ts:503`, which returns before `derivePairCounts`/`runAlgorithm` — so `capSaturation` could never be reached and `queriedTables`/`rpc`-not-called passed on the abort path instead. It now uses 4 players whose every anchor pairing sits at the cap, and asserts `broadcastCapSaturation` was **called** (positive assertions cannot go vacuous), which is why `@/lib/broadcast` is mocked in that suite. That mock is for determinism, **not** credential safety: `vitest.config.ts` loads no dotenv and Vite surfaces only `VITE_`-prefixed vars, so `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are unset under `vitest run` (probed on 4.1.5) and `postBroadcast` would hit its missing-env guard. See `tests/unit/matchmaking-snapshot.test.ts` (29 tests) and `ENG-SNAP-1/2`.

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
| `RED_ZONE_SCORE_FLOOR`         | 1000  | Tier-2 **addend**, not a floor. `score ≥ 1000` ⇒ Red Zone, but **not** the converse — heavy game debt pushes a genuine Red Zone player below it. Never use it as the Red Zone test; call `isRedZonePlayer()` (§3.34)                                                                                                                                                                                                                                                                                                             |
| `BOTTLENECK_THRESHOLD_MINUTES` | 20    | Wait-time monitor flag threshold                                                                                                                                                                                                                                                                                                                   |
| `ANTI_REPEAT_LOOKBACK`         | 5     | Recent matches used by `deriveOverlapMap` for familiarity weighting (count-based)                                                                                                                                                                                                                                                                  |
| `OVERLAP_WEIGHT_TEAMMATE`      | 2     | `deriveOverlapMap` weight per same-team co-appearance with the anchor in recent matches.                                                                                                                                                                                                                                                            |
| `OVERLAP_WEIGHT_OPPONENT`      | 2     | `deriveOverlapMap` weight per cross-net co-appearance (raised 1→2 in the 2026-07 diversity pass — re-facing avoided as hard as re-partnering). Fires on a single prior meeting, so it is the primary round-2 opponent-freshness lever (`MAX_OPPONENT_REPEATS` only bites round 3+).                                                                     |
| `ROSTER_LOOKBACK_COUNT`        | 10    | Recent match rosters yielded by `deriveRecentRosters` for diversity-violation checks (larger than `ANTI_REPEAT_LOOKBACK` so `getEffectiveLookback` can scale up for large sessions)                                                                                                                                                                 |
| `MIN_REST_MINUTES`             | 18    | Minimum wait minutes before a returning player (games_played > 0) can be drafted again. Prevents 0-min back-to-back. Falls back to unfiltered pool if fewer than `PLAYERS_PER_MATCH` survive the filter.                                                                                                                                           |
| `GAMES_AHEAD_PENALTY`          | 10,000 | Fresh-first rule: scoreCandidates penalty per game a candidate is above the waiting-pool minimum (= 1 overlap unit). Pulled bodies exempt.                                                                       |
| `GAMES_AHEAD_PENALTY_RED_ZONE` | 100   | Red Zone variant of the fresh-first penalty (capped small, like the overlap cap, so urgency always outranks freshness).                                                                                             |
| `CONSECUTIVE_OPPONENT_PENALTY` | 3     | Per-player cost of facing someone you faced in your **last** match (§3.32). Cross-net only — a just-faced pair drafted as teammates is free. Sub-quantum by construction: 4 × 3 = 12 for a real split (5 × 3 = 15 inside `buildCombinationGroup`'s argmin, which adds an unsplittable sentinel), i.e. ≥667× below `GAMES_AHEAD_PENALTY`, so it can only break ties **within** a fairness tier. |
| `MAX_CONSECUTIVE_OPPONENT_REPEATS` | 4 (`PLAYERS_PER_MATCH`) | Structural max of `countConsecutiveOpponentRepeats` — the term is charged once per seat. Anchors the sub-quantum proof, and is the score given to an **unseatable** four so the argmin cannot prefer one. A future per-PAIR term would make this 8. |
| `SPLIT_PREVIEW_BUDGET`         | 4,096 | Ceiling on split previews per `buildCombinationGroup` call. Sized from C(30,3) = 4,060, the documented session ceiling (a preview is ~1.4 µs, so the worst case is ~5.7 ms, paid at most once per slot). Exhaustion is **correct but degraded** — returns best-so-far, never worse than baseline — and logs under `DEBUG_MATCHMAKING`. The prior value of 600 was a silent cliff: C(17,3) = 680 blew it on the first anchor. |
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
4. Per slot: re-read the session match snapshot, concurrently with fetchActivePool
     (sees sibling drafts from earlier slots of this burst; completed + in_progress + pending).
     !ok → BREAK the burst. Never fall through to empty history.
5. For each slot in [0, slotsAvailable):
   a. Pool diversity cap (slots 1+): skip if estimatedWaiting < PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK
   b. runAlgorithm(anchor):
        i.  derivePairCounts(snapshot) — pure, once per runAlgorithm (not per candidate)
        ii. deriveOverlapMap(snapshot, anchor) — pure, team-aware, per-tick
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

**Files:** `src/lib/matchmaking-core.ts` (pure: `isPullEligible`, `isHeldMatchReady`, `pickEarliestFinishing`, `forcedRepeat` on `AlgorithmResult`, ≤1-pulled guard in `buildCombinationGroup`, **`wantsFresherFour`, `pullImprovesFreshness`, `buildCrossCourtProposal`**), `src/lib/matchmaking-db.ts` (`fetchPullablePlayers`, **`hasFeedableCapacity`**, `executeHeldMatch`), `src/app/actions/matchmaking.ts` (engine reach + `recomputeHeldReadiness` + promotion TS-filter), `src/lib/cross-court/derive-held-state.ts`, `src/components/organizer/sortable-card.tsx` (`HeldBadge`). Plan: `CROSS_COURT_DRAFTING_PLAN.md`.

When the four the waiting pool can form is **stale** — someone would face a player they just played — the engine reaches into a live court for ONE still-playing "pulled body" and pre-builds a **held draft** (3 waiting + 1 playing) that is fresher. It runs entirely under auto-matchmaking; the organizer does nothing.

> **This feature shipped DEAD and was repaired 2026-08-12 — but that repair only fixed GENERATION. See §3.41:** the first live session (2026-08-15) created 12 held drafts and got **2** of them onto a court; the other 10 were cleared by hand — which is what defect 1's `CONFLICT` copy tells an organizer to do, though prod records no publish *attempt*, so read that as the likely reading of the data and not as a traced cause. That path predated held drafts entirely. Read this block as the history of the three *generation* blockers, not as an all-clear for the feature. ⚠️ Until 2026-08-16 this line said "could publish **none** of them" — false (prod session `3367d4c6` has two published, promoted, completed held rows), and false in the direction of the §3.41 heading it was paraphrasing, which then read "could never be published". Both are fixed. The heading's first replacement ("could not be published until its hold resolved") was itself false of defect 4, which publishes a RESTING hold and lets promotion refuse it; §3.41 now names **both** halves — refused while holding, wrongly allowed while resting. Three phrasings, two of them wrong, for one section: a title that generalises over several defects will misstate at least one, so the surviving one enumerates instead. ⚖️ It still names only the publish symptom — §3.41 deliberately bundles **defect 2**, the draft-cap notice, which is a *generation-visibility* bug sharing the session but not the symptom. (Ordinal, not "a fourth defect": §3.41 numbers them, and its defect 4 is a publish one.) Accepted: a heading that covered all four would name none of them usefully.
>
> It produced **0 held drafts across 945 production matches**. Three independent blockers, each individually sufficient to prevent every reach — and every downstream helper was green the whole time, because nothing tested whether the engine ever *decides* to reach. The three, and the shape of the repair, are recorded below because each one is a trap worth not re-entering.
>
> 1. **The slot gate was `i > 0`** — "not the first draft of this run". 91% of production engine runs commit exactly one draft, so the branch was unreachable by construction. It was a *proxy* for "a freeing court still has something to promote"; that invariant is now asked directly.
> 2. **The trigger was `forcedRepeat` alone** — the engine having already failed to compose a legal four. That fires on ~4% of matches (22/550 replayed) and gets **rarer as the engine improves**, so the better the pool selection got, the deader this feature became.
> 3. **The selection would not pick a pulled body on the pool that matters.** The old producer appended bodies at `priorityScore:-1` and asked `runAlgorithm` to choose. `scoreCandidates` scores every candidate `-priorityScore + overlap×10 000 + gamesAhead×10 000` and `isPulled` exempts the **games-ahead term only**, so a body scores `+1 + overlap_b×10 000` against a waiter's `-P_w + overlap_w×10 000 + gamesAhead_w×10 000`. Both of those asymmetric terms favour the *body* — its games-ahead is forced to 0 while a waiter one game above the pool minimum pays 10 000, and its overlap is normally 0 where a waiter who recently shared a court with the anchor pays 20 000 (`OVERLAP_WEIGHT_* = 2`). But the body's score is **not what decides**. On the previewing path `buildCombinationGroup` is an argmin over whole **triples** of `fairness + 3 × repeats`, where `repeats` is a property of the assembled four (via `snakeDraft`), not of any candidate. The body displaces the third-cheapest waiter `w3` iff `s_body − s_w3 < 3 × (r_waiting − r_body)`, i.e. iff `s_w3 > 1 − 3·Δrepeats`; with repeats running 0–4 plus the unsplittable sentinel 5, `Δrepeats` spans `[−5, 5]` and that threshold slides **±15 around +1**. "Three waiters cheaper than the body" is therefore neither necessary nor sufficient. What is true: **when the repeats term is a wash**, the body loses whenever three waiters are simultaneously (i) at the pool's game minimum, (ii) overlap-free with the anchor, and (iii) above `priorityScore -1` — the ordinary mid-session pool, precisely the pool cross-court exists to improve; and when it is *not* a wash, the outcome turns on a property of the four that `priorityScore:-1` cannot express at all. Either way the score is not a control surface. `CCT-BUILD-1` is a worked instance of the wash (waits 14/12/10/8, one game each, no anchor overlap): the waiting-only four costs `-6 + 3×1 = -3`, the best four containing the body costs `-3 + 3×0 = -3` — a **dead tie** resolved for the incumbent by the strict `<`, pull silently dropped. Note *why* it ties: the fairness gap (3) exactly cancels the repeat saving (3×1). Where the body reliably won was an *illegal* waiting four, which is flagged `forcedRepeat` and rejected downstream. A deadlock: the case it could fire was the case it refused. ⚠️ This paragraph has been wrong **three** times, each time by reaching for a universal — "trails by 11–15 unbridgeable points", "pinned at +1 and overlap only widens the gap", "loses exactly when three waiters beat +1". Re-derive from `matchmaking-core.ts`; never paraphrase the sentence above. *(Scope: blockers 1 and 2 are what produced the 0/945. This third one is what would have kept the feature near-useless after fixing them — it is not independently evidenced by that zero.)*

- **Trigger** (`runEngineInternal` slot loop): `wantsFresherFour(forcedRepeat, baseStaleness)` — a forced repeat **or** any consecutive-opponent staleness in the waiting-only four (`countConsecutiveOpponentRepeats`, the metric P2 optimises and the one players actually complain about). Then `!bypassGate && !anchorBlocksReach(...) && await hasFeedableCapacity(...)`, in that order: three cheap CPU predicates short-circuit the round trip so it is only spent on the path that wants a pull.
- **Courts-stay-fed gate** (`hasFeedableCapacity`): a held draft seats **nobody** at creation, so it is only safe while pending **feedable** matches outnumber pending **held** ones. This is **capacity, not existence** — a held draft is `is_held`, so it never consumes the spare it was authorised against, and an existence check would let one pending match authorise every slot in the run (12 waiting at cap 3 → 1 promotable + 2 held holding 6 players; two courts free, one promotes, one **idles**). Fails **closed** on a read error: a staler match is a cheaper loss than an idle court.
- **Selection** (`buildCrossCourtProposal`): the pull is **forced** into every candidate four rather than competed for — anchor + 2 of the next 7 waiters + 1 body, each scored by `runAlgorithm`. Accepted only on a **strict** staleness drop (`pullImprovesFreshness`); the forced-repeat path keeps its original weaker acceptance, since a four that cannot be served has no staleness floor to beat.
  - **Only the anchor's fairness is structural.** `pool[0]` is in *every* candidate four, and a body stays `priorityScore:-1` so it can never out-anchor anyone (C-3). ⚠️ But `pool[0]` is the **highest-priority** player, *not* the longest waiter — `scoreAndSortPool` sorts by `priorityScore`, which subtracts `games_played × GAME_PENALTY_MINUTES`. A wait-19 / 3-games player (score −5) sorts *below* a wait-16 / 0-games player (score 16). This doc asserted the opposite until 2026-08-12; it is the same score-encodes-a-tier fallacy §3.34 exists to eradicate. **Do not re-derive a wait guarantee from the sort order.**
  - **The two seat slots are therefore not structurally fair, and the inner search cannot make them so** — with exactly 4 players `buildCombinationGroup` has no choice to make, so no fairness term participates in it at all. Fairness among seat pairs is imposed by an explicit **lexicographic ranking** in the search loop and nowhere else: minimise `gamesAhead` (the two seats' combined `games_played` above the *seat pool's* minimum) **first**, then `staleness`. That ordering mirrors `scoreCandidates`, where `GAMES_AHEAD_PENALTY` (10 000) dominates `CONSECUTIVE_OPPONENT_PENALTY` (3). Before this, the loop argmin'd on staleness alone and would seat two 4-game players over two 1-game players to save a single repeat — inverting the fresh-first invariant the rest of the engine enforces. The early return now needs `staleness === 0 && gamesAhead === 0`; staleness 0 alone is no longer sufficient, because a later pair can tie it at a fairer games tier. `CCT-BUILD-7` / `CCT-BUILD-8`.
- **Diversity is judged on the OUTER lookback.** The inner `runAlgorithm` calls each see a pool of exactly 4, and `getEffectiveLookback(4)` is **2** — far shorter than the 4–7 the real waiting pool earns. Left alone the reach would enforce a *weaker* anti-repeat rule than the plain draft it replaces, which is backwards for a freshness feature. `buildCrossCourtProposal` therefore re-takes the `isDiversityViolation` / `isRejectedRoster` verdict itself, against `recentRosters.slice(0, getEffectiveLookback(pool.length))`. That key is never *looser* than the outer engine's: `runAlgorithm` keys on `eligible.length + 1`, where `eligible` is the pool minus the anchor, minus everyone outside the skill window, minus everyone partner-capped — so `eligible.length + 1 ≤ pool.length` always, and `getEffectiveLookback` is monotonically non-decreasing. The reach may refuse a four the plain draft would have taken; it can never wave through one the plain draft would have rejected.
- **The anchor is never held while urgent** (`anchorBlocksReach`). Dropping `i > 0` changed who the anchor is — it was the 5th-highest-priority waiter, it is now the **highest-priority** one. A held draft marks its 3 waiting members `drafted`, removing them from `fetchActivePool`, so the Red-Zone and Hard-Wait escalations can no longer reach them. The guard refuses the reach when the anchor is in the Red Zone **or** within `CROSS_COURT_REST_FALLBACK_MINUTES` of `CRITICAL_WAIT_MINUTES` (≥17 min). ⚠️ **This covers the anchor only** — see the sorting note above; clearing `pool[0]` does *not* clear the two seated waiters.
  - **Hold-age cancel** (`heldDraftExpired` + `CROSS_COURT_MAX_HOLD_MINUTES = 15`, enforced in `recomputeHeldReadiness`): if a held draft is still waiting on its source court after 15 minutes, it is cancelled via `clear_on_deck_match_atomic` and all three parked players re-enter the pool.
    - ⚠️ **Best-effort, evaluated on an event — not a timer.** `recomputeHeldReadiness` has three callers: the two in `match-lifecycle.ts` (a match ending or being cancelled, both inside `if (match.court_id)`, so a match with no court does not even count as attention) and the **held-draft heartbeat** in `runEngineInternal`, added 2026-08-16. The engine one is much the denser — queue joins, publishes and clears all reach it — but it sits below the `courtCount` early-return and inside the `is_auto_matchmaking_on` gate, and it is itself gated on `pendingRows.some(isHeldAwaitingReadiness)` so a session with no live hold pays nothing for it. On a quiet session, or one with the engine off or every court closed, a hold still outlives the cap indefinitely. The constant is an upper bound on *attention*, not on elapsed time — widened by the heartbeat, not removed. Do not quote it as a hard bound or as a Red-Zone guarantee. ⚠️ This bullet asserted "never invoked from the engine loop; its only callers are in `match-lifecycle.ts`" until 2026-08-16 — the sentence outlived the code by one commit, which is §3.34's defect class exactly. Re-derive the caller list from `grep -rn "recomputeHeldReadiness" src/`, do not paraphrase this one.
    - ⚠️ **This required a migration** (`20260812000000_clear_on_deck_never_unseats_a_playing_body`). The hold-age cancel is the first *routine* caller of `clear_on_deck_match_atomic` on a draft whose pulled body is **still mid-game**, and step 5 of that RPC restored the whole roster to `waiting` under only a `status != 'left'` guard — flipping a player who is physically on court. Exactly the hazard `20260624000000` had already fixed for the *bulk* clear. Symptom if unfixed: the body reads `wait_minutes ≈ 15–20` with `joined_at` untouched, sorts near the top of `fetchActivePool`, and every subsequent engine tick composes a four containing them → `create_match_with_players` Guard 2 sees their `in_progress` match → NULL → the slot loop breaks → **zero matches produced until their real game ends**, while they appear in the queue and on a court simultaneously. The fix tests *physical* truth rather than the status string — `NOT EXISTS (an in_progress match for this player in this session)` — which leaves ordinary drafts and the R3-B purged-source path behaving exactly as before. Leaving the body `playing` is not a leak: once the draft row is gone, `endMatchAction`'s R3-1 overlap query finds nothing and `requeue_finished_players` returns them to `waiting` normally, *with* the `games_played` increment and `joined_at` stamp the flip would have skipped. Covered by integration `J-1`/`J-1b`/`J-2`/`J-3` — not unit-testable, since `heldDraftExpired` returns the same boolean either way and the whole defect is in the SQL. (`J-1b` is the complementary permutation: the same held shape but with the source match already `completed`, where **all four** must restore — it pins that the guard tests *physical* truth and not "is this a held draft", which a guard keyed on `is_held` or `pulled_player_ids` would have got wrong by stranding the freed body.) **Applied to prod 2026-08-12** under stamp `20260812092029` (stamps differ from repo filenames here — migrations are applied by hand), via `CREATE OR REPLACE` specifically: `20260723000000` narrowed this function's ACL to `service_role`, and a DROP+CREATE would silently reset it to `EXECUTE TO PUBLIC`. Post-apply the ACL was re-verified as `{postgres, service_role}`. Suite J is injection-verified — restoring the pre-fix body locally failed **exactly `J-1`** (`expected 'waiting' to be 'playing'`) while `J-2`/`J-3` stayed green, which is what proves the `NOT EXISTS` clause is a no-op on the ordinary-draft and `left`-guard paths rather than a behaviour change smuggled in beside the fix. Calibrated against production's soonest-court-free distribution (p50 4.7 / p90 12.7 / p99 18.1) so it sits above p90 and clips only the genuine tail. It fires *only* while the body is still playing (`pulledFreedAt === null`) — a freed draft is minutes from promotion and cancelling it would waste the reach — and a malformed `created_at` never cancels. `CC-HOLD-1`…`CC-HOLD-6`.
    - **Rejected alternative:** extending the 17-minute margin to the seats. Strictly more correct, but on `fetchActivePool`'s rested branch every player with ≥1 game is at `wait ≥ 18 ≥ 17`, so all three waiters would have to be zero-games players — plausibly returning a feature whose whole history is *0 held drafts in 945 matches* to never firing. The replay harness structurally cannot count held drafts, so that cost is unmeasurable up front. The hold-age cancel bounds the *harm* to all three parked players without narrowing *which* reaches are allowed.
    - ⚠️ **What it does not promise:** it bounds the HOLD, not the total wait. A seat that entered the hold at 12 minutes can still be released at 27. Do not describe it as a Red-Zone guarantee.
  - *Accepted residual.* `anchorBlocksReach` bounds the anchor's wait when the hold is **created**, not how long the hold lasts: `isHeldMatchReady` returns false until `pulledFreedAt` is set, so the fallback timer only starts once the source game frees the body. Hold duration is bounded by the hold-age cancel above — on the best-effort, event-driven terms stated there, not by a timer. Modelled over 94 allowed reaches, the anchor's wait at release is p50 13.5 / p90 18.5, crossing `CRITICAL_WAIT_MINUTES` in 5.3% of holds and `HARD_WAIT_CAP_MINUTES` in 2.1% — ⚠️ but that model measures **1 of the 3** held waiters (the guarded one), so it understates the true residual.
  - ⚠️ On the `MIN_REST_MINUTES = 18` branch of `fetchActivePool` every anchor with `games_played ≥ 1` waits ≥18 ≥17, so the reach is refused **by construction**; the escape is a zero-games anchor (3.8% of production auto-matches). The score arm of the guard is presently *subsumed* by the wait arm (measured: 66 refusals by score, 136 by wait, union 136) and is kept only as a guard against constant drift.
- Held drafts decrement `estimatedWaiting` by **3** not 4 (C-1) — they consume 3 waiting players, not a full four.
- **Held RPC** `create_held_cross_court_match` (migration `20260607000000`): sibling of `create_match_with_players` that admits exactly one `status='playing'` body. Guard 0 split; Guard 1 locks **only the 3 waiting** rows (M-6); Guard 1b reservation (no body in two held drafts); 3 waiting → `drafted`, pulled body's status untouched. NULL = graceful slot-skip.
- **Readiness** (`recomputeHeldReadiness`, before promote on end/cancel): roster-integrity downgrade (N-2), source-null cancel via `clear_on_deck_match_atomic` (R3-B), **hold-age cancel** (`heldDraftExpired`, above), stamp `held_ready_at` once source completed AND (≥1 promotion since freed OR `CROSS_COURT_REST_FALLBACK_MINUTES` timer — C-5, no counter column).
- **Promotion** (`promoteOnDeckMatchInternal`): fetch published pending, pick the front-most **ready** in JS — not-ready held matches skipped so a ready one behind still promotes (skip-and-defer; C-4/R3-A). Never idles a court.
- **Ghost-availability** (`endMatchAction`): a finishing pulled body of a pending held draft is re-queued as `drafted`, not `waiting` (R3-1) — reservation by construction.

New `matches` columns: `pulled_player_ids uuid[]`, `pulled_from_match_id uuid` (FK `ON DELETE SET NULL`), `held_ready_at timestamptz`, `is_held boolean GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0) STORED`. New constants: `CROSS_COURT_REST_FALLBACK_MINUTES=3`, `MAX_CONSECUTIVE_GAMES_FOR_PULL=2`, `MATCH_REST_GAP_MINUTES=5`, `CROSS_COURT_MAX_HOLD_MINUTES=15`, `CROSS_COURT_SEAT_CANDIDATES=7`. New token: `cc-violet`. **Deferred items** (UI 3-state track, swap auto-downgrade trigger, publish/callNextMatch recompute, staleness escape, RPC `search_path`) tracked in `MEMORY.md`.

**Proven end-to-end against a real database (Suite XC, 2026-08-12).** The unit suite pins each predicate and the replay harness structurally cannot see the feature at all (`scripts/replay/simulate.ts`, simplification 3), so until now nothing proved the whole chain fires. `tests/integration/cross-court-realdb.test.ts` drives the real engine through the real server action (`endMatchAction` → `runEngineForSession`) against local Supabase: **XC-1** asserts a held draft row actually lands (`is_held`, `created_method='held'`, `pulled_from_match_id`, roster = anchor + 2 waiters + 1 still-playing body, the three seated `'drafted'` and the body left `'playing'`); **XC-2** ages a hold past `CROSS_COURT_MAX_HOLD_MINUTES` and asserts the cancel releases the three waiters *without* unseating the body (the `20260812000000` invariant); **XC-3** is the age-gate control. XC-1 cannot pass spuriously — `is_held` is generated from `pulled_player_ids`, whose only writer is `create_held_cross_court_match`, reachable only from this branch. ⚠️ This ended "Still not observed in a **live session**; this is DB-level proof, not field proof" until 2026-08-16 — **now observed**: session `3367d4c6` on 2026-08-15 generated 12 held drafts, of which 2 reached a court (§3.41). Generation is field-proven; the field evidence for the rest of the lifecycle is a failure report, and the fix for it shipped the next day. 🪤 The pointer at the head of this block (added `6b44fed`, same day) was written for an adjacent reason — that the block read as a whole-feature all-clear the 08/15 session contradicts — and the sentence directly asserting the contradicted claim, at the block's other end, was not re-read in that edit. Annotating a block's opening is not correcting it: **grep the claim, then fix every assertion of it, not only the warning you just added about it.**

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
| Special / Milestone     | century_club ‡, the_veteran ‡, night_cap, early_bird, skill_slayer, double_trouble, **first_to_100** ‡ (one-time club-wide: only the historically FIRST player in the club to reach 100 all-time games; claimed atomically via `club_milestones`, `20260704000001`)                                                                                                                                                                                                                              |
| **Cross-session (NEW)** | **momentum** (ended last session on streak ≥3, won first tonight), **consistent_dominator** (70%+ in 2 of 3 sessions), **bounced_back** (sub-50% → 50%+), **nemesis_slayer** (beat all-time nemesis), **settled_the_score** (flipped negative H2H), **the_dynasty** ‡ (5+ wins, 70%+ all-time vs same rival), **serial_rivals** ‡ (3+ sessions vs same rival), **soulmates** ‡ (20+ games with same partner across sessions), **winning_formula** ‡ (60%+ win rate with same partner, 6+ games) |

(★ = enhanced with cross-session context in award_data · ‡ = **one-time per player**, earned in the first session where it holds and never again — see §3.7.1. Six awards carry ‡; the gate is keyed on `(player, slug)`, so the four partner/rival ones cannot be re-earned with a different partner or rival.)

**RPC mechanics — what the migration changed:**

- `PERFORM refresh_alltime_leaderboard()` runs at the top so `century_club` (≥100 all-time games) and `the_veteran` (top-3 all-time games among players active tonight) read fresh data. Both are **one-time** since `20260811000000` (§3.7.1) — the refresh still matters, because the ledger only suppresses a *repeat*, and the first grant must fire on the right night.
- `_wrapped_stats` temp table extended with ~25 new computed columns: `won_last`, `lost_first_two`, `wins_after_first_two`, `last3_total`, `distinct_win_streaks_2plus`, `avg_winning_margin`, `avg_loss_margin`, `wins_by_8_or_more`, `wins_by_5_to_7`, `avg_pa_per_game`, `mixed_wins`, `played_first_match`, `played_last_match`, `max_rematch_count`, `redemption_count`, `unique_partners`, `max_same_partner_count`, `top_partner_id` / `top_partner_name`, `friendly_fire_overlap`, `own_worst_enemy_id` / `own_worst_enemy_name`, `skill_slayer_wins`, `alltime_games`, `is_alltime_top3`, `has_streak_partner`.
- New supporting CTEs: `match_opponent_pairs` + `opp_pair_summary` (rematch / redemption), `partner_counts` + `partner_aggregates` + `top_partner_per_player` + `partner_summary`, `partners` / `opponents` + `friendly_fire_counts`, `own_worst_enemy_pairs` + `own_worst_enemy_summary`, `player_skills` + `match_opponent_skill` + `skill_slayer_counts`, `alltime_top3`.
- Tier replacement: `clean_sweep` removes `sunset_surge` from the player's award array (won 3-of-3 last is a strict superset of won 2+-of-3 last).
- Tier replacement: `the_warmup_act` removes `participation_trophy` before adding itself — a player who qualifies for warmup_act (0 wins, ≥3 games, avg loss margin ≥6) was otherwise receiving both awards simultaneously (migration `20260509`).
- `sniper` was rebanded from "≥5 pt margin" to "5–7 pt margin" so it does not overlap with the new `heartless` (≥8 pt margin) award.
- **Threshold tweaks (migration `20260509000000`):** `the_closer` requires `games_played >= 3` (was 2); `friendly_fire` requires `friendly_fire_overlap >= 2` (was 1, fired for ~80% of players in small sessions).
- **Deuce threshold tweak (migration `20260704000000`):** `deuce_magnet` now requires games reaching **30-30** (was 20-20) — scoring is sudden-death up to `MAX_BADMINTON_SCORE=31` with no win-by-2, so 20-20 is a routine mid-game state; 30-30 is the real next-point-wins moment. Applied as a verified scoped text substitution on the live `compute_session_wrapped` body (aborts unless the 20-20 pattern occurs exactly twice). Subtitle in `wrapped-awards.ts` updated to say 30-30.
- **First to 100 (migration `20260704000001`):** `first_to_100` (legendary) — one-time, club-scoped honor for the FIRST player in a club to ever reach 100 all-time games; exactly one holder per club, forever (vs `century_club`, which every player earns once, on their own crossing). Backed by the new `club_milestones` table (§2 — append-only, deny-all RLS, service-role only). The **claim** runs in the RPC only when a player *crosses* 100 tonight (`alltime_games-games_played<100`): SELECT existing holder → atomic `INSERT ... ON CONFLICT (club_id,milestone) DO NOTHING RETURNING` — race-safe across concurrent session closes, idempotent across recomputes. Ledger milestone key is `first_to_100_games`; award slug is `first_to_100`. Migration backfilled the true historical first crossing per club from cumulative completed-match history. Since `20260811000000` the **award** is gated on the ledger rather than on that crossing arithmetic — see §3.7.1.
- **One-time milestone awards (migration `20260811000000`) — see §3.7.1.** Six awards whose conditions are scoped to a player's **all-time** record rather than to tonight (`century_club`, `the_veteran`, `serial_rivals`, `the_dynasty`, `soulmates`, `winning_formula`) are now earned in the **first** session where they hold and never again. Before this they re-fired every session, because a condition about your all-time record is still true the next time you turn up.

**Archetype Cards**: Players receive a personality archetype (e.g. "The Grinder", "The Sniper") based on their session stats pattern.

**Cross-session persistence** (migrations `20260510000000–02`):

- `player_rivalries` table — directional all-time H2H ledger `(player_id, rival_id)`: `wins_vs`, `losses_vs`, `sessions_faced`. Updated at session close.
- `player_partnerships` table — directional all-time partnership ledger `(player_id, partner_id)`: `games_together`, `wins_together`, `losses_together`, `sessions_together`. Updated at session close.
- `session_wrapped_stats.carry_forward jsonb` — per-player payload written at close: `{ ended_on_win_streak, session_win_pct, session_id }`. Read by the next session's RPC for momentum/streak signals. `ended_on_win_streak` is the actual streak the player was on at session end (gaps-and-islands counting backward from last match), NOT the session peak.
- `refresh_cross_session_stats(p_session_id UUID)` RPC — **rebuilds** both ledger tables for the club that owns `p_session_id`, from that club's complete match history, then prunes ledger rows no match backs. `p_session_id` is now only a pointer to the club. Called in `closeSession()` before `compute_session_wrapped`. Non-fatal: failure logs a warning but does not block the close.

  ✅ **Absolute and genuinely idempotent since 2026-08-12** ([20260812100000](supabase/migrations/20260812100000_refresh_cross_session_stats_absolute_rebuild.sql), applied to prod). `ON CONFLICT … DO UPDATE SET wins_vs = EXCLUDED.wins_vs` — assign, not add — and the `last_session_id` guard is gone. Idempotent in every column that carries meaning; `updated_at` is rewritten on each call (last bullet). Five consequences worth knowing:
  - **Self-healing.** Every close repairs whatever earlier closes left behind, including sessions that were never closed at all. A late score entry, a `fix_record_swap_player` correction or a re-finished match all land at the next close instead of being lost.
  - **Hidden sessions are excluded** (`s.is_hidden = false`). They used to be kept out for free — the function only ever looked at the session being closed. A club-wide scan has to say so explicitly, for the reason [20260804000000](supabase/migrations/20260804000000_exclude_hidden_sessions_from_alltime_leaderboard.sql) gives for `v_alltime_leaderboard_mat`: these ledgers *cache* a cross-session aggregate, so an E2E sandbox match that lands in them stays.
  - **Per-club advisory xact lock** on `'cross_session_stats:'||club_id`, so two concurrent closes in one club serialize. Distinct from `compute_session_wrapped`'s `'wrapped_awards:'||club_id`. They cannot deadlock — but *not* because each takes one lock: `compute_session_wrapped` takes two, adding `hashtext('leaderboard_refresh')` inside `refresh_alltime_leaderboard()`. Safety comes from this function taking exactly one **advisory** lock and taking it *before it touches any row* (so nothing can hold a ledger row lock while waiting on this key, and it cannot be a link in a wait cycle), that leaderboard lock being a non-blocking `pg_try_advisory_xact_lock`, and `closeSession()` invoking the two RPCs in separate round-trips. Re-check if that try-lock ever becomes blocking.
  - **Cost: a measured floor of ~330 ms, and the prunes dominate. ⚠️ This body has never run through a real `closeSession()`** — 0 sessions have closed since the apply, last close 2026-08-06 — so every production invocation so far has been manual and the first live close is still the real measurement. Measured directly against this body 2026-08-12: rivalry truth CTE 23.7 ms, rivalry prune 173.5 ms, partnership prune 128.6 ms — a **partial** sum omitting the partnership CTE and both upserts. Do *not* complete it from `pg_stat_statements`: the 47-call PostgREST entry there (8.5 / 109 / **604 ms**) is entirely the *old* one-session body, and is already attributed to it at line 1790 of this document. Each prune is a correlated `NOT EXISTS` re-evaluated **once per stored ledger row** (3504 / 2400 loops, two index probes each), so its cost is ledger rows × per-player match rows; both factors grow with match history, making the prune *superlinear in history*. Roster² is the eventual ceiling, not today's driver — 192 players would be 36 672 dense rivalry rows against 3504 actual (9.6%), because rows are still match-bound. A few hundred ms against an 8 s budget on a non-fatal step is fine; when it stops being fine, point each prune at its own truth CTE instead of re-deriving from base tables. Do not go back to blind adds.
  - **Every close rewrites every ledger row.** `updated_at = now()` has no `WHERE` on the conflict action, so all ~5 900 rows get a new row version even when nothing semantic moved — a real autovacuum cost, and the reason any "did this change anything" check must compare semantic columns and exclude `updated_at` by construction.

  Pinned by **Suite XS** ([tests/integration/cross-session-ledger.test.ts](tests/integration/cross-session-ledger.test.ts)). Three of its four tests were run against the restored additive function and fail there; XS-3 (hidden sessions) passes under both and guards the new predicate.

  ⛔ **What it used to do** — kept because the failure mode is subtle and the data below is the evidence for the repair. It was *one-shot per session, which is not the same as idempotent* (this line said "idempotent via `last_session_id` guard" until 2026-08-11 — too generous): `IF EXISTS (… WHERE last_session_id = p_session_id) THEN RETURN` over a purely incremental body, so the first call for a session won and nothing ever re-converged on truth. And **the guard decayed**: `last_session_id` is overwritten every time a pair meets again, so once every pair from a session had played a later one, nothing pointed at it and a re-run silently double-counted. `Chillax Thursday 4/23` (`d820efea-d3ff-4ca3-9c0a-6a76de6090dc`, 20 completed matches) was exactly that case on prod — re-running it now moves no semantic value (not a *physical* no-op; `updated_at` is still rewritten, see above).

  Measured on prod 2026-08-11 (all repaired 2026-08-12, see below): **1204 of 3504 expected `player_rivalries` rows missing, 370 more stored too low** (1162 / 370 after the JVL repair). The under-count dominates, but it is **not** strictly one-directional:
  - **6 rivalry rows are stored above history on a W or L component** — three pairs. Two invert cleanly, total intact (`Bianca v`↔`Howell` 2W-1L stored / 1W-2L true; `Glenn`↔`JV Cutiepatootie`). The third is *both* inverted and short: `Jackie B`↔`Miggy` is stored 3W-0L against a true 2W-4L, so those two rows sit in the 370-too-low bucket **and** the component-high bucket at once.
  - **4 partnership rows are above history on a W/L component** too (`Maya`↔`Howell` stored 0W-2L / true 1W-1L; `Bianca v`↔`Jackie B` stored 2W-0L / true 1W-2L), plus **2 partnership orphans** with no history at all (`Says`↔`Emman`, `games_together=0, sessions_together=1`). `games_together` and `sessions_together` are never over-counted — but that is a *sums* test, and the sums are exactly what hid this: a totals-only check returns 0 over-counts on both tables. **Compare components.** (All of these predate 2026-08-11, so none came from the JVL repair.)

  🚨 **Therefore a rebuild is *not* award-neutral.** Not even the milestone slugs are uniformly safe. What actually confers safety is **not reading the ledgers at all** — `century_club`, `first_to_100` and `the_veteran` source `v_alltime_leaderboard_mat` + `club_milestones`, so a ledger rebuild cannot touch them (note `the_veteran` is `is_alltime_top3 AND alltime_games >= 20`, a *relative* rank, so it is non-monotone for other reasons — see below). The other **four** do read the ledgers — `serial_rivals`, `soulmates`, `winning_formula`, and `the_dynasty` (via `dynasty_victim` ← `rivalry_with_tonight` ← `player_rivalries`) — and of those only `serial_rivals` is genuinely add-only safe; `the_dynasty` and `winning_formula` are demonstrably revocable and `soulmates` is structurally exposed (see the recompute note below). Ratio- and identity-based awards are **not** protected: a rebuild takes `the_dynasty` qualifiers 10 → 18 but **revokes it from 1** (`Barts` v `Veejay Banda` is stored 6-2 = 0.750 and is truly 6-3 = 0.667, and no other rival qualifies him), and it moves the nemesis target for **77 players** (47 swap rival, 29 gain a nemesis they did not have, 1 loses one). Be precise about *which* awards that touches, because the ranking is not what it looks like: `alltime_nemesis` is `DISTINCT ON(player_id) … WHERE losses_vs > wins_vs ORDER BY player_id, (losses_vs - wins_vs) DESC, losses_vs DESC, rival_id` — **max net deficit, not most losses and not top `wins_vs`** — and it drives `nemesis_slayer`; `settled_the_score` shares that primary key on the pre-tonight split (`score_settled`: `… WHERE pre_losses_vs > pre_wins_vs AND wins_vs >= losses_vs AND tonight_wins > 0 ORDER BY player_id, (pre_losses_vs - pre_wins_vs) DESC, rival_id` — no `losses_vs` tiebreak, and two extra tonight-gates), and it moves too: **160 (session, player) targets shift, 45 of them losing the award**. **`my_nemesis` is not affected at all**: it gates on `nemesis_id` from the `h2h_losses` CTE over `player_match_results`, i.e. *tonight's* matches only, so a ledger rebuild changes its displayed all-time numbers but never who it names. Fix these rows before any rebuild, and do not describe the repair as monotone. See `MEMORY.md` → "CROSS-SESSION STATS WERE UNDER-COUNTED CLUB-WIDE".

  ✅ **The rebuild was EXECUTED on prod 2026-08-12**, with the award consequences above disclosed and accepted first. `player_rivalries` 2342 → **3504** rows, `player_partnerships` 1610 → **2400**, both at drift 0 against match history, the 2 orphans gone. Award qualifiers moved as predicted: `the_dynasty` 10 → 18 (9 gained, **1 lost — Barts**), `serial_rivals` 34 → 47 (0 lost), `winning_formula` 6 → 11 (7 gained, **2 lost — Lei and Aim**, whose top partnership went 6 games @ 66.7% → 7 @ 57.1%; a *pure raise* in games can drop a ratio below its gate), `soulmates` 0 → 0. Pre-rebuild state is preserved in `public.player_rivalries_prerebuild_20260812` / `public.player_partnerships_prerebuild_20260812` (both revoked from `anon`/`authenticated`), so it is reversible. Applying `20260812100000` afterwards (prod stamp `20260812144342`) and invoking it on `Chillax Thursday 4/23` changed **0 rows on every semantic column** — including `last_session_id` and `last_faced_at` — which independently confirms the shipped function's truth definition matches the one the manual repair used. It was *not* a physical no-op: the upsert rewrote `updated_at` on all 5 904 rows, which is why that column is excluded from the comparison by construction rather than by observation.

  ⚠️ Consequence for `compute_session_wrapped`: `rivalry_with_tonight` reads `sessions_faced` **straight from `player_rivalries`** and only decomposes `wins_vs`/`losses_vs` into pre/tonight — it does **not** add tonight to the session count. So the stored ledger must already include the session being computed, which is exactly why the RPC runs first in `closeSession()`. There is no in-flight compensation if the ledger is stale.
- `compute_session_wrapped` extended with section 2b: `_cross_session_stats` temp table (14 CTEs joining `player_rivalries`, `player_partnerships`, and prior `session_wrapped_stats`). All columns use `cs_` prefix to avoid collision with `_wrapped_stats` columns. FOR loop joins both temp tables.

**Delivery pipeline**: Organizer closes session → `refresh_cross_session_stats` RPC (non-fatal) → `compute_session_wrapped` RPC (with 600ms retry) → `session_closed` broadcast fires → all connected players redirect to `/wrapped/{sessionId}/{playerId}` automatically.

🚨 **Recomputing an old session is NOT safe today — a stored wrap is a snapshot of the rules as they were, and the current RPC cannot always reproduce it.** **Five** independent causes, all measured on prod 2026-08-11:

1. **Tightened definitions.** `20260704000000` raised the `deuce_magnet` threshold from 20-20 to 30-30. Wraps written before that date were computed under the looser rule, so they hold grants the live code will not re-issue — on `Saturday 05/23`, **39 of 40 wraps** carry `deuce_magnet` but only 4 of that session's 56 matches now qualify, and the award needs 3 per player. A recompute strips it from all 39.
2. **The rivalry ledger is incomplete** (described above) — the genuinely rivalry-derived awards (`redemption_arc`, `settled_the_score`, `nemesis_slayer`, `the_dynasty`, all reaching `player_rivalries` through `rivalry_with_tonight`) shuffle when rows are missing or short.
3. **The rivalry ledger has no as-of date, which is a *separate* defect from being incomplete.** `rivalry_with_tonight` is `(pr.wins_vs - COALESCE(tvr.tonight_wins,0)) AS pre_wins_vs` over the **present-day cumulative** row — it subtracts *tonight* and nothing else. So replaying a May night today treats every June-to-August head-to-head result as "pre-tonight history", and `score_settled`'s `pre_losses_vs > pre_wins_vs` test is evaluated against a rivalry that had not happened yet. Measured by rebuilding the ledger twice from `match_players`, both **complete**, differing only in whether post-05/23 sessions are included: net grant delta `redemption_arc +4 · serial_rivals +4 · settled_the_score +3 · the_dynasty +3 · nemesis_slayer +2`, every other slug 0. ⚠️ **The delete-then-recompute form of the upstream fix proposed above does not close this one.** Both ledgers in that A/B were *complete* — which is exactly what a per-session rebuild produces — and 16 grants still moved. Completeness does not confer as-of-ness. Closing this needs `rivalry_with_tonight` to be **date-bounded**, which per-session ledger rows would enable but do not by themselves deliver. Together causes 2+3 account for **5** of the 05/23 losses and all 14 ledger-mediated gains.
4. **"Prior session" is defined by `computed_at`, with no chronological cutoff.** `bounced_back` and `consistent_dominator` gate on `cs_prior_last_win_pct` / `cs_prior_dominant_sessions` from `prior_sessions` (which reads `prior_sessions_ranked`), and `momentum` on `prior_carry` — all over `session_wrapped_stats`. Be careful with the mechanism here — the intuitive "recomputing re-stamps `computed_at` and so redefines which session is prior" is **wrong for the session being recomputed**: the CTE is `WHERE session_id != p_session_id`, so a session is excluded from its own prior set and re-stamping its own rows cannot move its own gates. What actually moves them is that the window is `ROW_NUMBER() OVER(PARTITION BY player_id ORDER BY computed_at DESC)` with `rn<=2` and **no upper bound on the date** — so "prior" silently means "**that player's** two most recently *computed* nights", not "the two nights before this one". (`momentum` reaches the same place by different SQL: `prior_carry` is `DISTINCT ON(player_id) … ORDER BY computed_at DESC` with no `rn` window at all, i.e. effectively `rn=1`.) It is per player, not a single club-wide pair: across 05/23's 40 players those top-2 windows span **16 distinct sessions** (most common `07/25` for 8 players; many players who stopped attending still have May priors). Measured: **25 of 40** players' `cs_prior_last_win_pct` differs between the two readings, and **7** have a "prior" session that did not exist when the wrap was written. Note `cs_prior_dominant_sessions` counts `win_pct>=70` only *within* that top-2 window, so it maxes out at 2. Note also that — unlike `_prior_awards` — this CTE has **no `is_hidden` filter**, so a hidden session's wrap can serve as someone's "prior"; latent only, as 0 of the 26 sessions with wraps are hidden today. (The re-stamp is a real hazard, just a cross-session one: recomputing an old wrap re-stamps it to the head of the ordering used by *every other session's* computation — for the players who appear in that wrap, which is the only partition it can reach.)
5. **Present-day non-ledger inputs.** `skill_slayer` joins today's `player_skills` (`opp_avg_skill >= ps.skill_int + 2`), and `the_veteran` / `century_club` / `first_to_100` read `v_alltime_leaderboard_mat`, refreshed at the top of the function — so an April night replayed against August ratings and August totals legitimately answers differently. §3.7.1 states the same thing for the milestone slugs.

Measured diff for a full recompute of 05/23 inside a rolled-back transaction: 40 players, **39 lose at least one award, 13 gain one**. Full slug diff (quote it whole — a truncated version of this list is what produced a wrong cause-attribution three review rounds running):

```
LOSS  deuce_magnet ×39 · bounced_back ×3 · consistent_dominator ×2 ·
      settled_the_score ×2 · nemesis_slayer ×1 · redemption_arc ×1 · the_dynasty ×1
GAIN  redemption_arc ×7 · settled_the_score ×4 · bounced_back ×3 ·
      nemesis_slayer ×3 · momentum ×2 · consistent_dominator ×1 · skill_slayer ×1
```

⚠️ **Milestone awards are not "safe" here either — do not read `_prior_awards` as a shield against revocation.** It is built with `sws.session_id <> p_session_id`, so it suppresses *duplication* on other sessions and does nothing to stop a recompute from dropping a badge off the wrap that granted it. This task proved it: recomputing 05/23 before the JVL backfill **deleted her `serial_rivals`**, and `serial_rivals` is one of the seven ledger-gated slugs. §3.7.1 states this correctly.

🚨 **And a *pure raise* can revoke a milestone too — do not assume the rebuild direction is safe.** It is tempting to argue "no row stores `sessions_faced` above history, so raising the ledger can only help". That inference is wrong. Of the seven slugs in the `_prior_awards` list, only two are gated *purely* on raw counts drawn from the rivalry/partnership ledgers — `serial_rivals` (`cs_max_sessions_faced >= 3`) and `soulmates` (`cs_alltime_games_together >= 20 AND cs_alltime_sessions_together >= 2`) — and **`winning_formula` gates on a ratio**: `cs_alltime_games_together >= 6 AND cs_alltime_partner_win_rate >= 60 AND cs_alltime_sessions_together >= 2`, over the top partner from the **`partnership_alltime`** CTE (`DISTINCT ON(pp.player_id) … ORDER BY pp.player_id, pp.games_together DESC, …`). Raising `games_together` without raising `wins_together` *lowers* the win rate. Measured on prod: **`Lei` and `Aim` each hold exactly one `winning_formula` grant**, both on a top partnership stored **6g-4w (66.7%)** whose true history is **7g-4w (57.1%)** — a rebuild that only ever adds a game revokes the badge, and with a single grant apiece `_prior_awards` shields nothing. Club-wide the award goes **6 qualifiers → 11 with 2 losers**, and because that CTE ranks by `games_together`, a rebuild also re-points many players' top partner outright — which is why `soulmates` is *structurally* exposed too despite being a count gate (a re-point can drop `sessions_together` below 2). It has **0 grants and 0 qualifiers** on prod today, so it is a latent hazard rather than a live one. Fix both causes before recomputing any historical session, and note that "Fix Player Record" triggers exactly this path.

**PG17 compatibility note:** All `v_awards` appends use `array_append(v_awards, 'X'::text)` rather than `v_awards || 'X'`. Postgres 17's stricter type coercion treats `text[] || 'unqualified-string'` as ambiguous and tries to parse the literal as an array, raising "malformed array literal". Always use `array_append` for plpgsql append patterns.

#### 3.7.1 One-time milestone awards (migrations `20260811000000` + `20260811000001`)

**The bug.** Most Wrapped awards describe *tonight* — you were undefeated tonight, you were MVP tonight — so re-earning them is the point. Six did not: their conditions are about a player's **all-time record**, so they are still true the next time that player turns up. Exactly one of the six is robust rather than merely sticky: `century_club`, which reads `alltime_games` and so is the only one that touches neither `player_rivalries` nor `player_partnerships` — it cannot be zeroed by an identity merge. It is *not* strictly monotone, though: `alltime_games` comes from `v_alltime_leaderboard_mat`, which counts completed `match_players` rows filtered by `is_hidden = false`, so hiding a session or a `fix_record_swap_player` that removes a player from a completed match both subtract from it. (No practical exposure today — the five holders sit at 133/118/111/105/104 games, none near the boundary.) Three can lapse by design (`the_veteran` — top-3 is relative; `the_dynasty` — a 70% rate can fall back; `winning_formula` — your top partner can change) but in practice held night after night. The last two, `serial_rivals` and `soulmates`, are monotone **only given intact source data**: they read `player_rivalries` / `player_partnerships`, whose running totals an identity merge can zero, making an already-granted award stop evaluating. (Earlier drafts of this section called `century_club`, `serial_rivals` and `soulmates` strictly monotone. Production falsifies all three — see the fragility note below.) `century_club` was literally `IF v_player.alltime_games>=100 THEN`, with no gate of any kind. Once a player passed 100 games, every single session they attended handed them "Welcome to the 100 club" again. Production had awarded it **18 times to 5 people** (one player held it 7 times, 07/04 through 08/06). Five more had the same shape:

| Award             | Condition                                    | Grants / players (before repair) |
| ----------------- | -------------------------------------------- | -------------------------------- |
| `serial_rivals`   | `cs_max_sessions_faced>=3`                     | 132 / 34                         |
| `the_veteran`     | `is_alltime_top3 AND alltime_games>=20`        | 55 / 5                           |
| `the_dynasty`     | `cs_dynasty_victim_id IS NOT NULL`             | 36 / 13                          |
| `century_club`    | `alltime_games>=100`                           | 18 / 5                           |
| `winning_formula` | all-time partner games ≥6 and win rate ≥60%    | 10 / 6                           |
| `soulmates`       | all-time partner games ≥20, sessions ≥2        | 0 (threshold never met)          |

This is **not** the `first_to_100` bug — that 2026-07-18 repair was sound and still holds (exactly one holder per club, one `club_milestones` row). The award people were seeing is its unguarded neighbour, `century_club`.

**The fix — a `_prior_awards` ledger.** The RPC builds one more `ON COMMIT DROP` temp table: the set of `(player_id, slug)` these six (plus `first_to_100`) already carry on **any other** wrap of the same club. Each site then appends `AND NOT EXISTS(SELECT 1 FROM _prior_awards …)`. Two properties are load-bearing — do not "simplify" either:

- **It matches in BOTH directions, and it excludes `p_session_id`.** The two halves do different jobs, and dropping either one reintroduces a bug.
  - Excluding `p_session_id` is what makes the RPC **recompute-safe**: re-running it on an already-computed session cannot see that session's own grant, so it re-grants rather than revokes. `fixPlayerRecord` ([src/app/actions/fix-player-record.ts:205](src/app/actions/fix-player-record.ts:205)) re-runs this RPC on closed sessions unconditionally, so this is normal usage, not a corner case.
  - Matching **any other** session — rather than only earlier ones — is what makes it **idempotent**. Every gated condition is evaluated against *present-day* all-time data (the loop reads `v_alltime_leaderboard_mat`, refreshed at the top of the function, with **no session cutoff**), so `alltime_games>=100` is just as true of a session the player played *before* they crossed 100. A backward-only bound therefore re-grants the award on every earlier session that is ever recomputed. This was caught in review and measured on production: a backward-only rule would have re-duplicated 217 `serial_rivals`, 111 `the_dynasty`, 81 `century_club`, 63 `winning_formula`, 20 `the_veteran` and 15 `first_to_100` grants — the last of which the *old* code was not vulnerable to. Ordering is deliberately **not** part of this predicate; which wrap counts as "first" is settled once by the repair migration, not re-derived on every call.
- **Excludes `is_hidden` sessions**, matching `v_alltime_leaderboard_mat` (`20260804000000`), which is where `alltime_games` comes from. Same universe in, same universe out — and an E2E sandbox wrap can never burn a real player's one-time award.

**The ledger is a snapshot, so the RPC now serializes per club.** `_prior_awards` is built by reading committed rows; two computes running concurrently for two sessions of the *same club* would each build their ledger before the other commits, both see "no prior grant", and both grant — re-creating the exact duplicate this change removes. That is reachable two ways: two simultaneous `closeSession` calls, or a close racing `fixPlayerRecord`'s fire-and-forget `after()` recompute. `refresh_alltime_leaderboard()` does **not** incidentally serialize them — it takes `pg_try_advisory_xact_lock` and returns *early* on contention. So the function now takes `pg_advisory_xact_lock(hashtextextended('wrapped_awards:' || club_id, 0))` immediately after resolving `v_club_id`, before the refresh. Transaction-scoped, released on commit or rollback; ordering is safe because no path takes the refresh lock first. A NULL `club_id` is skipped explicitly rather than relying on `PERFORM` swallowing a NULL. `hashtextextended`, not `hashtext`, matching `20260702000000` / `20260702000008` — advisory locks share one global `bigint` space that also holds `hashtext('leaderboard_refresh')` (`20260717171328`), and `hashtext` fills only 32 of those bits; the `wrapped_awards:` prefix likewise keeps this off the club-member guards' key, which is the bare club id.

**What contention costs, now that the lock blocks.** `pg_advisory_xact_lock` waits rather than returning, so a genuine same-club race no longer produces two grants — it produces one wait. Production's `authenticator` role (the login role PostgREST connects as, before `SET ROLE service_role`) carries `lock_timeout=8s` and `statement_timeout=8s`; `service_role` sets neither of its own, and PostgreSQL applies role settings at **login**, not on `SET ROLE`, so those 8s values are what a service-role RPC actually runs under. (Stated as inference from `pg_db_role_setting` plus documented `SET ROLE` semantics — it could not be measured on a live PostgREST connection from a read-only channel.) The practical ceiling: if a second compute for the same club waits more than 8s, it is cancelled instead of serialized. `closeSession` retries once at +600 ms and then reports `wrappedReady = false`, so the Wrapped screen shows empty stats until a recompute; `fixPlayerRecord`'s fire-and-forget `after()` only logs. Both outcomes are strictly better than the old behaviour — the old code didn't wait, it double-granted — but this is a real behaviour change and not merely a no-op hardening. Compute takes well under a second in practice, so an 8s wait implies something already pathological.

One precondition of that lock is worth knowing: it serializes the ledger *read* only because `CREATE TEMP TABLE _prior_awards AS SELECT` is a separate statement executed **after** it, so under `READ COMMITTED` it takes a fresh snapshot that already includes the other transaction's commit. Under `REPEATABLE READ` or `SERIALIZABLE` the snapshot would predate the lock and "never twice" would break silently. `closeSession` / `fixPlayerRecord` call the RPC through PostgREST at the default isolation level — do not wrap it in a higher-isolation transaction.

**The gate is per player, not per pairing — deliberately.** `soulmates`, `winning_formula`, `the_dynasty` and `serial_rivals` are all *about* a specific partner or rival, but the ledger key is `(player_id, slug)`. A player who later builds a 20-game partnership with someone new does **not** earn `soulmates` a second time. That is the product decision (all six were chosen to be one-time), not an oversight; making them per-pairing would mean widening the ledger key and re-running the repair.

**Second defect, fixed in the same pass.** `first_to_100`'s *award* was gated on the same live crossing arithmetic that guards the *claim*. `alltime_games` is read fresh, so recomputing the crossing session evaluated `alltime_games-games_played<100` against **today's** total, found it false, and silently dropped the award — one organizer record-fix on the 07/04 session would have deleted the club's only First to 100. The award now follows the ledger; only the claim still requires a genuine crossing, so no recompute can mint a new holder. Side benefit: when the self-healing reconstruction (`20260718150312`) seeds a holder who is *not* the player being processed, that holder now collects the badge next time they play instead of never.

**Deliberately unchanged:** every session-scoped award (they *should* recur), and the cross-session awards that already require something to happen tonight — `nemesis_slayer`, `settled_the_score`, `momentum`, `bounced_back`, `consistent_dominator`, `redemption_arc`.

**The retroactive repair (`20260811000001`).** The RPC only rewrites a session's rows when that session is recomputed, so the fix alone leaves every duplicate visible on the Wrapped pages people have already seen — which is the actual reported symptom. **Apply it after `20260811000000`**, never before: against the old function the data stays correct for about one session. (Applied in that order on 2026-08-11; see the migration log at the end of this file.)

It runs in three steps inside an explicit `begin; … commit;`. (1) A precondition `DO` block aborts if any single wrap carries the same milestone slug twice — step (2) revokes by slug, so that case would drop both copies; the RPC cannot produce it and production has none, but a hand-edited row would now fail loudly instead of silently mangling an array. (2) Keeps each `(club, player, award)`'s **earliest** grant — by `sessions.created_at`, tiebroken on `sessions.id`, deliberately *not* `computed_at` (07/04's wrap was computed on 07/05 — and it is not the only late one; `Thursday 05/07` was computed 05/08 — so `computed_at` would crown a repaired computation as "first") — and revokes the rest from `earned_awards` (order-preserving, via `WITH ORDINALITY`) and `award_data` (`- slugs`), capturing any wrap it empties into a temp table via `RETURNING`. (3) Restores the "every wrap carries ≥1 award" invariant on exactly those wraps — scoped to the temp table, not to every empty wrap in the database. Generic and idempotent.

⚠️ **That is the repo file, which is the reviewed artifact and what a `psql` apply should use. It is not quite the form that ran.** With no `psql` on the host, the file's `begin; … commit;` was a hazard — a runner that has already opened a transaction would treat the nested `begin` as a no-op and let the `commit` close *its* transaction early. So on 2026-08-11 it was applied as a single `DO` block instead: same steps, same ordering, same fallback payload, with the temp table collapsed to a `uuid[]` local and the post-conditions moved *inside* the block so a bad result rolls the entire repair back. Atomicity then does not depend on how the runner batches statements. Equivalent, not identical — noted so a future diff of prod against this file is not read as drift.

Ordering lives *only* here. The RPC does not re-derive it; this migration decides which single wrap becomes the canonical holder, and the new predicate then agrees with that choice for *every* session, not merely the ones already carrying a grant: recomputing any non-holding session suppresses the award outright, and recomputing the holding session re-evaluates the award's own condition — which the holder always still passes for `century_club`, and may or may not for the other five.

State that guarantee precisely, because the obvious stronger version is false: what is invariant is that **at most one wrap per (club, player) ever carries the award, and no recompute can add a second**. It is *not* true that the holding wrap always keeps it. For the non-monotone conditions — `the_veteran` (top-3 is relative), `the_dynasty` (a 70% rate can fall back under), `winning_formula` (your top partner can change) — a recompute of the holding session can legitimately find the condition no longer met and drop the badge. That behaviour is inherited unchanged from the old function; this migration neither introduces nor fixes it, and the awards were made one-time knowing it.

Be precise about what a lapse costs, because the intuitive reading is too pessimistic in one direction and too optimistic in the other. The badge is **not permanently destroyed**: `_prior_awards` is rebuilt from whatever wraps currently carry the slug, so once the only grant is dropped there is no ledger row left to gate on, and a later session where the condition holds again *will* grant it. What is lost is the **original wrap** — the badge does not return to the night it was earned, and it re-lands on whatever future session re-satisfies the condition, so the earned-on date moves. Concretely and reproducibly: recomputing the `the_veteran` holding session `Thursday 05/07` inside a rolled-back transaction takes milestone grants 64 → 63 and drops Alvin DG (rank 6 today) from the holder set. He would re-earn it the next night he re-enters the top 3 — but on that night's wrap, not on 05/07's.

**Which grants are actually fragile, measured not guessed.** Every one of the 17 sessions holding a milestone was recomputed inside a rolled-back transaction, each restored from a snapshot before the next so no iteration contaminated the next one's ledger. Result: **6 of the 64 grants would be dropped by a record-fix on their own session, and 0 would be added anywhere** — the "no recompute can add a second" invariant holds across the whole board.

| session | grant lost on recompute |
|---|---|
| Thursday 05/07 | Alvin DG — `the_veteran` |
| Thursday 05/21 | Miggy — `the_veteran` |
| Saturday 05/23 | JVL — `serial_rivals` · Lexie B — `the_dynasty` |
| 07/09 Thursday | Kevin DC — `the_dynasty` |
| 07/23 Thursday | Bea Trix — `the_dynasty` |

Five of the six are ordinary lapses — the condition genuinely no longer holds, and the badge can be re-earned later. **JVL's is different: hers is historical damage, not a lapse.** She was an identity-merge target on **2026-06-10**, and at that time `migrate_player_identity` re-pointed `match_players` but *not* `player_rivalries` / `player_partnerships`. That gap was closed three weeks later by [20260701000015](supabase/migrations/20260701000015_migrate_identity_rivalries_partnerships.sql) — live on prod, 4 `UPDATE player_rivalries` and 4 `UPDATE player_partnerships` in the function today — but it was closed *after* her merge, so nothing repaired the rows it had already orphaned. Result: 22 `match_players` rows and **zero** rivalry rows on either her new id or her old one (so a "backfill" here means recomputing from `match_players`, not re-pointing anything). `cs_max_sessions_faced` therefore comes out **0** — the outer projection is `COALESCE(msr.cs_max_sessions_faced,0)`, so this is a zero rather than a NULL comparison — and `0 >= 3` fails. She is the only one of the 24 wrap-players with zeroed rivalry data who holds a pairwise milestone (27 have zeroed partnership data; none of those hold one). *(Both figures are pre-repair; 21 and 24 after it.)*

Be precise about the cost, because "unrecoverable" is too strong. `refresh_cross_session_stats` upserts `player_rivalries` on **every** session close ([src/app/actions/sessions.ts:1032](src/app/actions/sessions.ts:1032)), so her rivalry rows repopulate the next time she plays a session that closes; `serial_rivals` then needs `sessions_faced >= 3` against one rival, i.e. three future nights against the same person. What is genuinely unrecoverable is her **accumulated history** — the pre-merge `sessions_faced` that earned the badge in the first place. Before the dedup none of this was visible, because the award re-fired every night and healed itself; it no longer does. Nothing here was caused by the repair, but a "Fix Player Record" on 05/23 now silently deletes a badge from a Wrapped page she has already seen.

✅ **REPAIRED on prod 2026-08-11.** Her ledger rows were rebuilt directly from `match_players` history — **42 `player_rivalries` + 32 `player_partnerships` rows**, both directions of every pair, written as absolute values (not deltas) in a single statement so re-running is a no-op. Verified: her stored rows now equal history exactly (0 discrepancies), and her `MAX(sessions_faced)` is **3** — she faced both Carl G and Miggy across three sessions, most recently on 05/23 itself, which is what earned the badge. The hazard was proven and then closed with a control and a treatment, each inside a rolled-back transaction: recomputing 05/23 *before* the backfill dropped `serial_rivals`; *after* it, the award survives. Her existing wrap was **not** recomputed and is byte-for-byte unchanged — the backfill only makes a future recompute safe. (It also makes her newly eligible for `redemption_arc` and `settled_the_score`, both rivalry-derived and impossible to earn against an empty ledger; those would only materialise if someone actually recomputes.)

⚠️ She was the authorized scope, but **she is not the whole problem** — 24 players with completed history had zero rivalry rows (21 after her repair), only 6 of them merges, and **43.7% of expected `player_rivalries` rows are still wrong** (1162 missing + 370 too low of 3504), plus the 10 inverted rows (6 rivalry + 4 partnership) and two orphans noted above. Root cause and the open decision: the `refresh_cross_session_stats` note in the cross-session persistence section above. Predicted by a full dry-run inside a rolled-back transaction and then **confirmed by the real 2026-08-11 apply, which matched it exactly**: **252 grants → 64, 188 revoked across 128 wraps, 48 duplicate groups → 0, 0 wraps emptied, 0 empty wraps left.** Post-apply integrity across all 638 wraps: every slug has `grants == distinct players`, and there are **0 orphaned `award_data` keys**, which is what proves the `award_data - slugs` removal stayed in step with `earned_awards`.

The behaviour — not just the row counts — was then demonstrated on production with two real recomputes, each inside a rolled-back transaction. Recomputing a **non-holding** session (08/06) did **not** re-grant `century_club` to its former repeat-holder, which is precisely the path that used to re-fire; recomputing the **holding** session (07/04) did **not** revoke it, and left `first_to_100` at one holder, confirming both recompute-safety and the second defect's fix. Row counts alone would not have distinguished a working gate from a lucky one.

**"Recompute-safe" means the seven gated slugs, and nothing wider.** Recomputing an old session is still not a no-op for the rest of the board, because several non-milestone awards are themselves cross-session — they read present-day state, so replaying an April night against August data legitimately produces a different answer. Measured on 07/25 inside a rolled-back transaction: zero milestone changes and zero stat changes, but four players' non-milestone badges shift (`+bounced_back`, `−settled_the_score`, `+redemption_arc`, and one player both gaining and losing). Pre-existing, unrelated to this migration, and named here only because both migration headers use the phrase "recompute-safe" and it should not be read as a whole-wrap guarantee.

**Authoring note.** `20260811000000` replaces the function **in full**, per the instruction in `20260810000000` — not another blind text substitution. It is generated by [scripts/gen-one-time-milestone-awards-migration.py](scripts/gen-one-time-milestone-awards-migration.py) from that baseline via **10** anchor-validated edits (advisory lock · ledger · `first_to_100` restructure · 7 gates), each of which must match exactly once or the generator aborts rather than emit a corrupted 49 KB body. **Never hand-edit the body** — edit the substitutions and re-run. (One-way door, now that it has shipped: the baseline is the *pre-migration* body, so an 11th edit needs a fresh `SRC` capture dumped from production first. See the `--verify-sql` warning below.)

The same script emitted its own pre-apply production check (read the warning two paragraphs down before reaching for it today): `--verify-sql <path>` writes a read-only `DO` block that rebuilds the body **on the server** from prod's own `prosrc` by replaying those same substitutions, asserts every anchor still matches exactly once *there*, compares `md5(prosrc)` against the repo file, `CREATE`s the result into `pg_temp` to prove it compiles, and then `RAISE EXCEPTION`s so the whole thing rolls back. Nothing is mutated and no 49 KB body has to be shipped to the server to test it. Generated rather than hand-written so the check can never drift from the migration it checks. Its last meaningful run was the pre-apply one: **10/10 anchors matched, `md5(prosrc)` = `e3689008fe20a015421a0c69afc49375`, compiles clean** — which proved prod had not drifted from the `20260810000000` capture. It cannot report that again; see below.

⚠️ **`--verify-sql` was a pre-apply instrument and it is single-use.** Its anchors describe the *pre-migration* body, so now that the apply has landed, anchor 3 matches production zero times and a re-run aborts with `ANCHOR 3 … matched 0 times in production, expected 1`. That is what "already applied" looks like on this script, not drift — but it reads exactly like drift, so don't reach for it as a routine health check. To confirm the live body today, compare the hash directly: `select md5(prosrc), length(prosrc) from pg_proc where proname = 'compute_session_wrapped'` must return `e3689008fe20a015421a0c69afc49375` / `49438`. `--apply-sql` is the one that stayed safe to re-run — its md5 short-circuit precedes the anchor replays, so a repeat run is a no-op rather than an abort. And a future 11th edit needs a **fresh `SRC` baseline dumped from prod**; editing the existing substitution list and re-running cannot work.

🚨 **`<path>` is an OUTPUT destination for both flags, not an input.** `--verify-sql <path>` and `--apply-sql <path>` *write* their generated SQL to `<path>`; neither reads it. Passing the migration's own path — which reads naturally as "verify this file" — overwrites the 55 KB migration with a ~12 KB `DO` block. That happened on 2026-08-11, recoverable only because a bare re-run rebuilds the migration deterministically from `SRC`. **Now refused in code:** `flag_dest()` aborts if `<path>` is the migration or `SRC` — checked two ways, because `resolve()` canonicalizes symlinks and relative forms but cannot see a **hardlink** (measured: a hardlink clobbered the file), so `(st_dev, st_ino)` covers that once the file exists — and also if `<path>` is missing, is itself a flag (`--verify-sql --apply-sql /tmp/x` used to drop a file literally named `--apply-sql` into the cwd), or names a non-existent directory. Two related behaviours were fixed in the same pass — flag mode no longer rewrites the migration as a side effect (that unconditional write was the other half of the accident: it wrote the correct file, then the flag destroyed it), so the flags are now genuinely read-only with respect to the repo. Still write to a scratch path: `python3 scripts/gen-…py --apply-sql /tmp/apply.sql`.

`--apply-sql <path>` is that check's mutating twin, and is how `20260811000000` actually reached production. It shares the same anchor assertions and the same md5 gate, then — only once the server-side reconstruction is proven byte-identical to the repo file — issues the real `CREATE OR REPLACE`, re-asserts the stored `md5` afterwards, and fails loudly if the ACL is anything but `postgres` + `service_role`. Any failed check raises *before* the DDL, so a bad run applies nothing; and it short-circuits when the body is already at the target md5, so it is idempotent. This exists because the host has no `psql`, no Supabase CLI and no DB URL: the only channel is the MCP, and the alternative was reproducing 49 KB of plpgsql character-perfect by hand, where a silent slip still compiles. Reconstructing from prod's own `prosrc` makes byte-correctness a **proven precondition** rather than a hope. Post-apply, the live body is `e3689008fe20a015421a0c69afc49375` — byte-identical to the repo file.

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
- **Reconnect rescues `left` (2026-08-15):** `reconnectPlayer`'s post-migration reconcile block used to lift only `playing/drafted/on_deck`→`waiting`. A player reconnecting to a **still-active** session (`targetSessionId` is only set from an active session) while their queue entry read `left` — from an earlier checkout, an organizer removal, or a mid-session re-registration — stayed invisible in Match Control (which renders only `waiting/drafted/on_deck/playing`). There is no organizer "re-add" control, so the reconcile now restores a `left` entry to `waiting` with a fresh `joined_at` (tail of queue, no line-jump). `migrate_player_identity` itself never sets `left` — it preserves status via a plain `UPDATE queue_entries SET player_id`.

#### Queue-status audit (`queue_status_events`, 2026-08-15)

`queue_entries.status` is mutated from many paths (engine, `checkoutPlayer`, `remove_player_from_queue_organizer`, `closeSession`, `endMatchAction`, join/rejoin, `migrate_player_identity`, manual matches), and used to have **no history** — so "why did `<player>` disappear from Match Control?" (their status became `left`) was undiagnosable after the fact. A DB-level append-only audit closes that: table `queue_status_events` + trigger `trg_log_queue_status_change` (`AFTER UPDATE OF status … WHEN OLD.status IS DISTINCT FROM NEW.status`). DB-level so it catches every path regardless of code; the trigger body is exception-wrapped so a logging failure can never roll back the actual status update. Captures `old_status/new_status/changed_at` plus best-effort `actor_uid` (request-JWT `sub`; **NULL for every service-role caller** — the engine and all server actions — so it's a hint, correlate `changed_at` with server logs). **Privileges (corrected 2026-08-18):** `20260815000000_queue_status_audit.sql` created the table with RLS on and no policies, and its comment claimed that made it "service-role reads only". It did not — RLS and the table ACL are independent gates and the ACL is checked first, and that migration granted nothing to anybody, so what actually shipped was the environment's `ALTER DEFAULT PRIVILEGES`. Production's default is `arwdDxtm`, so **anon and authenticated held full DML on the audit trail** with RLS-and-no-policies as the only defence; a from-scratch replay's default is `Dxtm`, so there the trail was written correctly and could not be read by anyone. `20260818120000_lock_queue_status_events_grants.sql` states the intent instead of inheriting it — `REVOKE ALL` from PUBLIC, anon, authenticated **and service_role** (the role must be named, because the intent is narrower than the default), then `GRANT SELECT, DELETE TO service_role` only: SELECT to read the trail during an incident, DELETE for retention and E2E teardown, with INSERT/UPDATE/TRUNCATE withheld so the SECURITY DEFINER trigger stays the only writer. Pinned by QSA-7/QSA-10 (§3.44 A). ✅ **Applied to production 2026-08-19 as stamp `20260819011750`** — measured before/after ACLs in §3.44 A.

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

**File:** `src/components/organizer/queue-control.tsx`, queue entry `is_paused` + `paused_at` columns

Organizer can soft-pause any player in the queue. Paused players:

- Remain visible in the queue list (position preserved)
- Are excluded from matchmaking candidate pool
- Can be un-paused at any time (single click)
- Displayed with a distinct visual indicator (muted / dimmed row + pause badge). After 15 / 30 / 45 … minutes the badge reads "Paused 15m" (amber) then "Paused 30m" (red), and a centered organizer notice fires at each bucket (see §3.42)

`togglePlayerPause` writes `paused_at = now()` on pause and `null` on resume. Does not affect `games_played`. Does not change `queue_status`.

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

**Files:** `src/app/actions/queue.ts` (`checkoutPlayer`, `removePlayerFromQueue`), `src/components/player/player-dashboard.tsx`, `src/components/player/my-status-tab.tsx`, `src/components/organizer/queue-control.tsx`

Two paths to exit a session, and they are **different server actions with different authority** — not one action with an optional player argument:

**Player self-checkout**: Player opens the leave dialog from their dashboard. Calls `checkoutPlayer(sessionId)` — note the signature takes **only** a session id; the player is always `auth.getUser()` server-side, so this action can never move anyone else's row. It sets `queue_entries.status = "left"` **only if the player is leaveable** — see §3.39. A player who is `on_deck` or `playing` is refused. On success it broadcasts `queue_notice` so every open Match Control sees a centered "{Name} left the queue" card (§3.42).

**Organizer-initiated removal**: Organizer confirms the remove action in the queue control table (`queue-control.tsx` → `onRemoveFromQueue` → `use-organizer-queue`), wrapped in an `AlertDialog` to prevent accidental removals. This calls **`removePlayerFromQueue(sessionId, playerId)`**, which gates on `isSessionOrganizer` and then delegates to the `remove_player_from_queue_organizer` RPC (migration `20260512200002`): one transaction that locks the queue row, pulls the player from any **pending** roster, cancels matches that fall under-strength, returns their survivors to `waiting`, and sets `status = "left"`. It then broadcasts `match_cancelled` to the remaining players and logs a `cancelled` match event for the matches that were genuinely torn down.

⚠️ **The organizer cannot remove an active player in one step either — and that is deliberate.** Three limits stack, and they agree:

- `v_queue_full_with_wait_time` is `WHERE qe.status IN ('waiting','drafted','on_deck')` — a **`playing` player is not listed in the queue panel at all** (the organizer still sees them on the
  active-match / court board — this limit is about the queue table, which is where the remove control lives).
- In `queue-control.tsx` the checkout dialog renders behind `{!isLocked && …}` where `isLocked = status === "on_deck" || status === "drafted"`; `wait-time-monitor.tsx` hides it for `on_deck` too, and `queue-skill-groups.tsx` lists `waiting` only. So the **only** removable status in the UI is `waiting`.
- The RPC itself only sweeps `m.status = 'pending'`; an `in_progress` match is never touched, so calling it on a playing player would strand exactly the ghost this design exists to prevent.

The real escape hatch for an active player is **two steps**: the organizer cancels the on-deck match (or ends the in-progress one) — which returns its roster to `waiting` — and *then* checks the player out. Both the server refusal string and the leave-dialog copy say "ask an organizer to remove you"; that is accurate, but the organizer's first move is tearing the match down, not clicking remove.

**Post-checkout state:**

- `queue_entries.status` → `"left"`.
- Matchmaking engine excludes `left` players from all candidate pools.
- If the player was assigned to an **unpublished draft** match, `checkoutPlayer` clears it via the `checkout_player_cleanup_drafts` RPC — atomically removing them from the draft's `match_players` and cancelling the draft if it drops below 4. (A manual, non-atomic fallback loop runs only on an environment where that RPC is not yet deployed.) BUG-002 in `publishMatchAction` (`src/app/actions/match-drafts.ts`) remains the backstop: it refuses to publish a draft containing a `left` player.
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

**Organizer actions:** Remove from queue (AlertDialog-confirmed, `waiting` players only — the control is hidden for `on_deck`). Calls **`removePlayerFromQueue(sessionId, playerId)`**, *not* `checkoutPlayer` — the latter takes only a session id and can only ever act on the caller (§3.19).

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
- Session partnership cap (`derivePairCounts` over the per-slot snapshot) — reads `match_players` directly, auto-correct

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
| `live-match-swap.ts` | `allMatchesInSession(db, sessionId, matchIds)` pre-check on all five call sites, returning `MATCH_NOT_ACTIVE` — deliberately indistinguishable from "does not exist", so there is no existence oracle. The helper itself lives in `src/lib/match-session-binding.ts`, **not** in the `"use server"` module: every export of a `"use server"` file is a public HTTP endpoint, and a security predicate must not be one. |

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
| Unit tests | `tests/unit/match-history-filter.test.ts` | 29 MHF-* Vitest tests covering all edge cases (null id, leave-triggered cancel, dup names incl. case/whitespace variants, swapped-out player, empty history) |
| Filter UI | `src/components/organizer/match-history-player-filter.tsx` | Controlled searchable list — `<input>` + `<ul>` of `<button aria-pressed>` (swap-sheet pattern, NOT a combobox) |
| Panel integration | `src/components/organizer/match-history-panel.tsx` | Adds `selected` state, `playerOptions` + `visibleMatches` memos, reconcile effect, active-filter chip, highlight rings, safety-net empty state, legend |

**Filtering mechanics:**
- `filterMatchesByPlayer(matches, id)` — null id returns the same array reference (identity, zero re-renders); otherwise filters by roster membership.
- `derivePlayerOptions(matches)` — deduplicates by `player_id`, alpha-sorts by `display_name`, attaches a `player_id.slice(-4)` disambiguator when two players share the same display name. The collision key is `normalizeName()` (`src/lib/normalize-name.ts`, the app's single source of truth for name identity, parity-locked to the SQL index expression) — **not** the raw string. `idx_profiles_unique_active_name` already blocks case/whitespace variants for ordinary profiles, so the case this actually catches is a `needs_rename = true` profile, which is exempt from that index precisely so a duplicate identity can sit unresolved. Those two rows differ only by case or collapsed whitespace, render identically in the picker, and would both come back with a null disambiguator under a raw-string key.
- `resolvePartnerIds(match, id)` — returns teammate `player_id`s (same team, different id) for the selected player in a single match.
- `selectionStillValid(matches, id)` — checks raw `matches` roster (NOT derived `playerOptions`). Used to detect stale selections after identity merges or score reverts.

**Selection lifecycle:**
- Pinned `selected: { id: string; display_name: string } | null` state — name captured at select time so the active-filter chip stays correct even if the player's profile vanishes from `playerOptions` on a realtime refetch.
- **Conservative reconcile:** if `selectionStillValid` returns false (player gone from all rosters), the filter chip stays visible with a safety-net empty state — never auto-cleared. The organizer dismisses via ✕. This is intentional for score-revert via `FixRecordSheet` which temporarily removes a match from history.
- **Two cancel paths handled correctly:** organizer-cancel retains all `match_players` rows (player appears in filtered history). Leave-triggered cancel deletes the leaver's row first — they do NOT appear in the match's roster.

**Highlight encoding (when a filter is active).** The two card branches use *different* ring treatments — that is deliberate, and the numbers below are measured, not asserted:

| Branch | Selected (`●`) | Partner (`○`) |
|---|---|---|
| Completed (`match-history-panel.tsx` ~:433/:478) | `bg-cc-accent-dim outline outline-1 outline-cc-accent text-cc-accent-text font-bold` | `outline outline-1 outline-dashed outline-cc-accent font-medium` |
| Cancelled (~:277/:312) | `bg-cc-accent-dim outline outline-2 outline-cc-accent text-cc-accent-text` | `outline outline-2 outline-dashed outline-cc-accent` |

- Cancelled uses `outline-2` because that whole player area sits inside an `opacity-60` wrapper — the compositing eats the ring, so it needs the extra width. Measured light-mode ring-vs-panel contrast under that wrapper: **1.91:1** with the current full-opacity accent vs **1.36:1** if the completed branch's style were reused. The heavier ring is doing real work.
- **The `opacity-60` wrapper caps the cancelled ring at ≈2.1:1 in light mode no matter what colour is used** (darkening the accent to `L=0.40` only reaches 2.07). Reaching 3:1 there would require raising the wrapper opacity or lifting the highlighted name out of the dimmed subtree — a visual-design change to a deliberately de-emphasised card, so it is **accepted, not fixed**. Dark mode is unaffected (**7.21:1**).
- The completed branch previously used `outline-cc-accent/55`, which measured **1.80:1** in light mode — an effectively invisible ring. Dropping the `/55` (2026-08-10) takes it to **5.23:1** light / **6.65:1**+ dark, with no change to hue, width or layout.
- WCAG 1.4.11 is not the binding constraint in either branch — the ring is never the sole encoding. Selected also carries `text-cc-accent-text` + `font-bold` + the dim fill + the "Showing {name}" chip; partner also carries a literal `partner` caption underneath. The rings are a scanning aid, and the light-mode fix above is about them actually being visible.
- The active-filter chip's own `outline-cc-accent/55` ring (~:171) is intentionally left soft — its meaning is carried by its text.
- Legend renders below the cards when filter is active: `◍ solid = selected · ◌ dashed = partner`.

**Two behaviours worth knowing (both intentional):**
- **The filter resets on tab switch.** `organizer-dashboard.tsx:952` mounts the panel as `{activeTab === "history" && <MatchHistoryPanel …/>}`, so leaving the History tab unmounts it and `selected` is lost with it. Every sibling tab is mounted the same way; hoisting this one panel's state to the dashboard would break that pattern and would also resurrect a stale filter after a long detour. Leaving the tab is treated as ending the enquiry.
- **Escape is two-stage, innermost-first.** It clears the search query if one is typed, and only clears the selection once the query is empty. Because `handleSelect` empties the query on selection, the steady post-selection state needs a **single** Escape to un-pick the player; the "two presses" case exists only while the organizer is mid-typing.

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

**Transitions:** `useFlipList` is a dependency-free WAAPI FLIP hook (framer-motion is NOT installed) — measures `offsetTop` (scroll-safe, unlike `getBoundingClientRect().top`), silent on first commit, `prefers-reduced-motion` checked in the hook because the global CSS reduced-motion block cannot reach WAAPI animations. Wired into `WaitlistTab` rows (reorders glide, joiners fade in). Player-dashboard tabpanels animate `tab-in` — **opacity-only, load-bearing:** any transform (even a retained `translateY(0)` via fill-mode) turns the tabpanel into a containing block for absolute/fixed descendants, and the status panel hosts MatchAlert's `absolute inset-0` overlay which must keep resolving against `<main>`. (Round 1 left the organizer queue panel and LiveCourtsTab cards unanimated; Round 3 below wired both. The hook's gated-commit handling was corrected in §3.29.)

**Tests (12 new):** Q-AUTH-1..3 + fetchSeq/error-handling upgrades (`use-queue.test.ts`) · EM-AUTH-1..2 (`use-enriched-matches.test.ts`) · TG-DUP-1..2 (`tenancy-guards.test.ts` — refusal asserted before any INSERT reaches the builder) · FLIP-1..5 (`use-flip-list.test.tsx`, happy-dom, prototype-stubbed `offsetTop`/`animate`; asserts the FLIP deltas and the reduced-motion/first-commit silences — extended to FLIP-8 in §3.29). Test-harness note: files that `vi.mock` `@/utils/supabase/client` must spread `importOriginal` so the real `hasAuthSession` runs against the mock client's `auth` stub.

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

**Test-infrastructure findings from the same production verification.** (1) `match_events.match_id` is **`ON DELETE SET NULL`**, so deleting a match nulls the pointer and preserves the audit row forever. E2E teardown deleted matches but not events, depositing ~36 rows per full-suite run into a production table — 171 had accumulated since 2026-07-02. `tests/helpers/teardown.ts`, `emergency-cleanup.ts` and `validate-cleanup.mts` now all delete/count `match_events` **by `session_id`**, never through the match ids: orphaned rows have a null `match_id` and are invisible to a matches-based query, which is exactly why the leak went unseen by a validator that reported "fully clean" throughout. `tests/integration/helpers/truncate.ts` carried the identical leak against the local integration DB and was fixed the same way. `emergency-cleanup.ts` also now spares `E2E_OrganizerBot` (it previously deleted it, unlike `teardown.ts`) — removing that account invalidates the saved Playwright storage state and breaks every sign-in until `npm run test:setup` re-creates it. (2) `useFlipList` is called in `waitlist-tab.tsx` *above* the `if (loading)` early return; roughly 60% of runs consequently emitted four 240 ms ENTER animations instead of a 320 ms MOVE despite stable row identity. Cosmetic, not a regression from #45/#46/#48. Recorded at the time as a `test.fixme` with the measurement and a fix direction — **the diagnosis was right about the call site and wrong about the remedy; fixed in the hook instead, §3.29. The fixme is now an enabled test.**

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

**Shipped and prod-verified 2026-08-04.** PR [#51](https://github.com/nayzjuan/badminton-app/pull/51) squash-merged to `main` as `e8e76bd`; Vercel production deploy `dpl_Bnqy3QVqKnEE8XCJZNHv3iftcgTi` READY. **[R-5] now passes against production**, which closes both this section's delivery proof and §3.27's — the whole resilience spec ran 5 passed / 1 skipped at the time, the skip being the cosmetic `useFlipList` residual (since fixed and un-skipped — §3.29).

**The first production run of [R-5] failed, and the failure was in the test, not the product.** The spec polled `capFrames.length > 0`, then immediately snapshotted `capFrames.join("\n")` and asserted it contained `"done"`. But `clearing` is emitted *before* the engine runs and `done` only *after* it returns, so the poll resolves on `clearing` alone and the snapshot is taken mid-cycle — the assertion raced the engine rather than detecting a defect. The received frame proved the product side was working end to end: topic `session-events:c858fa1e-…`, `"event":"draft_cap_phase"`, `"actorName":"E2E_OrganizerBot"`, a well-formed `opId`, `"phase":"clearing"`, `ttlMs: 45000` — a server-emitted broadcast, delivered to a second browser. The fix is a second `expect.poll` that waits for `"done"` *in the joined buffer* before snapshotting. The two polls are deliberately kept separate: the first distinguishes "no broadcast ever left the server" from the second's "the cycle started but never terminated", and each carries the diagnostic that fits its own failure.

**Production data was proven untouched.** A full 22-table content snapshot (`scripts/prod-snapshot.ts`, hashing canonicalized per-row JSON — row counts alone cannot see an UPDATE) was taken *before* the merge and diffed after the run: zero row-count change anywhere, and only three content drifts, each row-level-verified as sandbox-scoped — the `🤖 E2E SANDBOX` session's `max_auto_drafts_override` (since reset to `null`), the `E2E_OrganizerBot` profile's `updated_at`, and the `leaderboard_refresh_state` singleton. The other 19 tables were byte-identical, including all 200 profiles, 924 matches and 3 687 match_players.

---

### 3.29 `useFlipList` — a gated commit was wiping the FLIP baseline (2026-08-04)

**Files:** `src/hooks/use-flip-list.ts` · `tests/unit/use-flip-list.test.tsx` (FLIP-6/7/8) · `tests/e2e/scenario-r-resilience.spec.ts` (the `test.fixme` from §3.27, now enabled).

**The bug.** The layout effect was keyed `[orderKey, animateEnter]` and wrote `prevTops` / `hasMeasured` on **every** run — including runs where the host component had rendered none of the list's rows. Every caller gates its list (`if (loading) return <skeleton/>` in `WaitlistTab` and `LiveCourtsTab`, the By-Skill lens in `QueueControl`), and the gate is a *separate prop* from the data. In `useSessionData`, `fetchWaitlist` is one embedded query while `fetchActiveMatches` is up to four sequential round trips, so `setWaitlist` lands several commits before `setLoading(false)`. That intermediate commit changes the order key with **zero** elements registered, wiping every First position; the commit that finally paints the rows changes no key at all, so the keyed effect never re-ran and never measured them. The next genuine reorder therefore found an empty `prevTops` and took the `prevTop === undefined` branch for every surviving row — playing the 240 ms ENTER fade instead of the 320 ms translateY MOVE.

**Why it read as intermittent.** ~60% in the harness, ~never for a human. `activeTab` defaults to `"status"` with no URL or localStorage override, so a real user opens the Waitlist long after `setLoading(false)` and gets the correct move; Playwright clicks the tab the instant the tablist renders, which is *during* the load. The 40% of green runs were simply the races where the tab mounted after loading finished. The organizer By-Skill lens hits the same defect with **no** timing dependency at all — any queue change viewed under that lens breaks the next List-lens reorder — and `LiveCourtsTab` (`animateEnter: false`) degrades worse still: the wiped baseline makes the enter branch `return`, so cards **teleport silently**, which is the exact behaviour PR #46 shipped to remove.

**The fix, three lines of behaviour.** (1) A commit with zero registered elements and a **non-empty** order key is a *gate*, not a state — skip it entirely rather than overwriting the bookkeeping. `orderKey === ""` is the genuinely-empty list (every caller `join`s an array) and must still be recorded, or a list that empties out keeps stale tops. (2) `hasMeasured` is armed only once rows have actually been measured (`nextTops.size > 0`). (3) The dependency array is **gone**, with `prevOrderKey` tracked in a ref instead: "the order key changed" and "the rows are on screen" are different events, and only the latter can be observed by re-measuring every commit. `orderChanged` still gates the animation, so the documented contract — a stat ticking up in place does not animate — is unchanged. Re-measuring every commit also fixes a latent third defect: any non-reordering layout shift between two order changes (a badge appearing, a font landing) used to leave a stale First and produce a wrong `dy`.

**Accepted trade-off, stated in the hook:** the *first* row added to a genuinely empty list gets no enter fade, because from inside the hook a zero-row commit and a gated commit are indistinguishable. Staying silent there is much cheaper than fading an entire list in on every slow page load — which is the noise `hasMeasured` exists to prevent, and which the old code did on precisely the loads it was meant to protect. Note the scope: `hasMeasured` is never reset, so this costs *only* the first row-holding commit a hook instance ever makes (all of that commit's rows, not one) — which is the mount silence the hook wanted anyway. A list that had rows, emptied, and refilled **does** fade the new ones.

**Contract this now depends on:** `orderKey` must be a bare join over exactly the rows the caller renders, so that `orderKey === ""` means "genuinely empty" and nothing else. All four call sites already do this (`waitlist-tab.tsx`, `live-courts-tab.tsx`, `queue-control.tsx`, `queue-skill-groups.tsx`). Prefixing the key (`` `skill:${ids.join(",")}` ``) or joining a superset of the rendered rows would make an empty list produce a non-empty key and silently re-open the bug — stated in the hook's JSDoc.

**Intended new behaviour, not a regression.** Because `prevTops` now survives a gate, `QueueControl`'s List lens plays a burst of MOVEs (plus enter fades for genuine newcomers) when you switch **back** from the By-Skill lens after the queue changed underneath. Previously that reveal was silent — and the *next* reorder was then broken, which is the whole bug. The animation on the lens toggle is the correct behaviour, but it is visible and new; it is not a bug report.

**Rejected fix direction.** The `test.fixme` comment proposed moving the `useFlipList` call below `WaitlistTab`'s early return. That is illegal: it is the component's only hook, so the loading render would have 0 hooks and the loaded render 1 — "Rendered more hooks than during the previous render", plus a `react-hooks/rules-of-hooks` error. The call-site-shaped alternative (split each component into a gate wrapper + an inner list) is correct but must be repeated at four sites and is easy to regress. Fixing the hook covers all four at once.

**Proof.** FLIP-6 (a reorder following a skeleton commit still plays a MOVE, asserting the exact `translateY(60px)` deltas *and* that no emitted first keyframe carries `opacity`), FLIP-7 (a skeleton-only mount does not arm the enter branch), FLIP-8 (a non-reordering layout shift is silent but still refreshes First, caught by the next reorder's delta being 60 rather than 80). All three **fail against the pre-fix hook and pass after**, with FLIP-1…5 green either way — so they discriminate rather than merely pass. The E2E is confirmation only; it now also asserts `isRow` on the 320 ms filter (`Element.animate` is global, so an unrelated 320 ms translateY elsewhere on the page would otherwise satisfy it) and asserts that **no** surviving row played a 240 ms enter, which catches a partial regression that a `moves.length > 0` check alone would miss.

**Trap for anyone re-running this.** Do not make the E2E green by toggling tabs or otherwise remounting `WaitlistTab` before the removal — that remounts the hook with data already present, sidesteps the gated commit entirely, and would leave the production bug in place.

---

### 3.30 Closure fallback + the draft firewall extended to rosters (2026-08-10)

Two changes that look unrelated and are not: both exist because a **broadcast/realtime channel is the only thing telling a player something happened**, and both close a case where that channel legitimately says nothing.

**Files:** `src/app/actions/sessions.ts` (`getPlayerSessionStatus`) · `src/hooks/use-organizer-broadcast.ts` · `src/hooks/use-player-match.ts` · `supabase/migrations/20260810000001_extend_draft_firewall_to_match_players.sql` · `supabase/migrations/20260810000000_declare_compute_session_wrapped.sql` · `tests/unit/use-organizer-broadcast-closure.test.ts` · `tests/unit/use-player-match.test.ts` (U-HELD-1) · `tests/integration/rls-edge-cases.test.ts`

#### A. `session_closed` has a fallback now (closes `PENDING_WORK_2026-07-23.md` §2.3)

**The gap.** The `session-events` broadcast is the *only* mechanism that moves a player to Wrapped — `useSessionData` fetches `courts` and `queue_entries`, never the session row. `session_closed` is fire-and-forget with **no replay**, so a player whose channel was down for the one second it was emitted sits on a dead dashboard forever. Since the channel went private (`20260723100000`) there is a second way in: an *authorization*-refused join.

**The fix, in three parts.**
1. **`getPlayerSessionStatus(sessionId)`** — auth-gated server action, service-role read of **`is_active` only**. It never returns the row, which carries `organizer_passcode`. Service role rather than a client read because the failure mode it must survive is exactly the one where the client's own RLS predicate has stopped holding: `sessions_select` is `is_session_organizer(id) OR is_club_member(club_id)`, so an admin soft-removing a member mid-session makes the predicate fail **and** `session_access_level` go NULL, refusing the channel join at the same instant. That player is stranded on both paths; only an RLS-bypassing read can answer them.
2. **`onStatus` is wired** (it was deliberately declined in PR4a — see §2.1 of the pending-work doc — and only became wireable once the action existed). It carries **no user-visible signal**: transient `CHANNEL_ERROR`/`TIMED_OUT` is normal on gym wifi and Realtime reconnects itself, so a "live updates are down" toast would misfire constantly. It drives the closure re-check instead. Every transition in **either** direction means the channel either never joined or dropped and re-joined, and any such gap is a message that can never arrive on its own.
3. **A slow poll + a visibilitychange listener.** `SESSION_STATUS_POLL_MS = 120_000`, floored by `SESSION_STATUS_MIN_GAP_MS = 10_000` so a flapping channel cannot turn `onStatus` into a request storm. The visibility listener is separate from `useVisibilityRefresh` on purpose — that hook also calls `router.refresh()`, which the dashboard already does; this one asks the single question, at the realistic recovery moment (phone unlock after the socket was killed with the screen off).

**The invariant that matters: `isActive: null` is NOT `false`.** A missing row, an RLS error, a service-client construction failure and a transport throw all resolve to "unknown", and the caller **holds** the dashboard. Only a definite `success && !isActive` navigates. Reporting "closed" on a transient error would eject a player from a live session — precisely the failure the original note warned against, and worse than the gap being fixed.

**Deliberately not covered: a de-authed client.** The action's `getUser()` gate and the `TO authenticated` channel policy fail *together*, so this is a fallback for a dead **channel**, not a dead **session**. Auth loss has its own recovery path (§3.26) and a `sessions` read is not the place to re-solve it.

**Disclosure, stated honestly.** An authenticated caller holding a session UUID learns whether it is active. `lookup_active_session` already exposes almost the same bit to **anon** for the QR-join path, with one real delta: it carries `AND s.is_active = true`, so it collapses "closed session" and "no such session" into one empty answer, while this action distinguishes them. One bit, to an authenticated caller, about a UUID they already hold — accepted, not nil.

#### B. The draft firewall now covers `match_players` and `match_games` (tenancy audit finding #11)

**The asymmetry.** `matches` carries the firewall (`matches_select_draft_firewall`, RESTRICTIVE): a member sees a row only when `status <> 'pending' OR is_published`. `match_players_select` was just `has_match_access(match_id)` → `session_access_level(session_id) IS NOT NULL`, which never asks the draft question. So any club member could read — and was **pushed, live** — the full named roster of an unpublished draft over a plain PostgREST GET, and those rows hand out the very `match_id` the hidden `matches` row withheld. That defeats draft mode's entire review window.

**The fix.** Fold the CASE into the helper rather than into the policies, so both dependents inherit it and their quals stay byte-identical:

```
CASE public.session_access_level(session_id)
  WHEN 'organizer' THEN true
  WHEN 'member'    THEN (status <> 'pending' OR is_published)
  ELSE false
END
```

Blast radius is exactly two policies — `match_players_select` (TO `authenticated`) and `match_games_select` (TO `public`). No RPC body references the helper. The migration re-asserts grants unchanged and carries a 4-check `DO $$` block (helper carries the firewall · still `SECURITY DEFINER` with a pinned `search_path` · still exactly 2 dependents · both policies present with unchanged roles), each with an explicit row-count guard — a bare `SELECT … INTO` leaves NULL on zero rows and `IF NULL <> 'x'` is **not taken**, so without the guards an assertion against a *dropped* policy would silently pass.

**The client half — a third subscription, and it is load-bearing.** `create_held_cross_court_match` inserts the match as `status='pending', is_published=false` and flips three `queue_entries` rows to `'drafted'` in the same transaction. Now that the firewall has landed (applied to prod 2026-08-10), that draft's `matches` row **and** its `match_players` rows are both hidden from the very player it reserves — so the `queue_entries` flip is the *only* event that still reaches them. `use-player-match.ts` therefore subscribes to `queue_entries` alongside `matches` and `match_players` (`channelPrefix: "player-match"`). It was harmless before the migration and is **required now**; **do not remove it as redundant.** Pinned by U-HELD-1.

> ✅ **Both migrations in this section were APPLIED to production on 2026-08-10** — stamps `20260810151122` (`…000000`, a proven strict no-op: function md5 `ec5c724c…` unchanged) and `20260810151355` (`…000001`). **Finding #11 is CLOSED.** The apply was gated behind the code deploy (merge `23ced21`) reaching Vercel READY, the migration's 4-check `DO $$` block passed, and the helper was verified functionally through real `authenticated`/`anon` roles inside a rolled-back transaction — a plain member is now denied exactly the `pending`-and-unpublished case and nothing else. Zero existing rows lost visibility (every prod match is `completed` or `cancelled`), so the change is forward-looking. Revert **only** via `supabase/rollbacks/20260810000001_rollback_has_match_access.sql` — never `DROP FUNCTION`, which cascades to both roster SELECT policies and blanks every roster read as a 0-row *success*. Evidence: `TENANCY_AUDIT_2026-07-21.md` §2 #11.

#### C. `compute_session_wrapped` is finally declared in the repo

`20260810000000` is a verbatim `pg_get_functiondef` capture of production's definition (44 897 chars, md5 `ec5c724c4fd8705449d0fd014d57b82d`). The repo had **never** held the function's full body: `20260423100000` created a much smaller early version and every change since has been an in-place text substitution against whatever prod happened to contain. It is convergent and a strict no-op against prod today; its value is giving future edits a diffable baseline instead of another blind substitution. `pg_get_functiondef` and **not** `prosrc` — `prosrc` drops the `SECURITY DEFINER` marker and the `SET search_path` in `proconfig`, so replaying a `prosrc` capture would silently de-harden the function. Note it does **not** by itself make a from-scratch replay work; that still aborts earlier, at `20260718150312_harden_first_to_100_claim.sql`.

#### D. The six all-time milestone awards become one-time (2026-08-11)

`20260811000000_one_time_milestone_awards.sql` — first consumer of the baseline above, and the first change to this function that is a real full-body replacement instead of a blind text substitution. `20260811000001_repair_duplicate_milestone_awards.sql` — strips the 188 historical duplicates the RPC fix cannot reach on its own. Full rationale, the two load-bearing properties of the ledger lookup, the per-club advisory lock that keeps concurrent computes from both granting, and the second (`first_to_100` recompute) defect fixed alongside: **§3.7.1**.

> ✅ **Both APPLIED to production 2026-08-11**, in order — `…000000` (stamp `20260810173410`) then `…000001` (stamp `20260810173605`) — emptying the by-hand queue. The repair rewrote **128** player-visible wraps: 252 milestone grants → **64**, duplicates → **0**, and every slug now has exactly one grant per player. Verified live afterwards, including two real recomputes inside rolled-back transactions: recomputing a **non-holding** session no longer re-grants the award, and recomputing the **holding** session does not revoke it. Because there is no `psql`/CLI on the host, both were applied through the Supabase MCP in equivalent-but-not-identical forms — see the "How the two `20260811*` were actually applied" note in `MEMORY.md` before re-running either.

---

### 3.31 Session close — three delivery paths, one destination decision (2026-08-11)

The complaint was "the Session Wrapped doesn't fire right away when I close the session, and players get stuck." Two different bugs wearing one costume, plus a third that only *looked* like slowness.

**Files:** `src/hooks/use-session-closed-watcher.ts` **(new)** · `src/lib/with-timeout.ts` **(new)** · `src/utils/supabase/client.ts` · `src/lib/broadcast.ts` · `src/lib/realtime.ts` (`subscribeToSessionRow`) · `src/app/actions/sessions.ts` (`closeSession`, `getPlayerSessionStatus`, `renotifySessionClosed`) · `src/app/actions/_shared.ts` (`isSessionActive`) · `src/app/actions/{queue,matchmaking,match-lifecycle}.ts` · `src/app/actions/wrapped.ts` · `src/components/wrapped/wrapped-shell.tsx` · `src/hooks/use-organizer-{broadcast,dashboard,data,session}.ts` · `src/components/organizer/organizer-dashboard.tsx` · `src/app/c/[clubSlug]/(full)/play/[sessionId]/page.tsx` · `tests/unit/use-organizer-{broadcast-closure,dashboard}.test.ts`

> **No migrations.** Every change here is application code. `sessions` was already in the `supabase_realtime` publication with `is_active` and `id` in the narrowed column list, and `sessions_select` already admits every club member — so the new row subscription needed nothing from the database.

#### A. The socket recycle was bricking realtime (the real "nothing fired" bug)

`onAuthStateChange` recycled the Realtime socket on an anon→real transition with `disconnect(); connect();`. Both look symmetric; they are not. `RealtimeClient.disconnect()` is **async** and sets `isDisconnecting()` for its duration, and `connect()` early-returns on `isConnecting() || isDisconnecting() || isConnected()`. Called back to back, `connect()` did **nothing** — and the socket was left closed with `closeWasClean = true`, the exact flag phoenix uses to suppress all three of its recovery paths (the `onConnClose` reconnect timer, the `visibilitychange` rescue, the `pageshow` rescue). The tab ended up with no socket and nothing that would ever open one. `recycleRealtimeSocket()` awaits the teardown, guards against overlapping recycles with `recycleInFlight`, and re-arms once at 500 ms. The old comment claiming "worst case equals the status quo" is retracted in place — it was false, and this was strictly worse than the anon-bound channels it meant to fix.

`whenRealtimeAuthReady()` is now **bounded** (3 s). Every subscribe helper builds its channel *inside* that promise's `.then()`, so a `getSession()` that never settles meant no channel was ever constructed — no `.subscribe()`, no status callback, nothing logged, and indistinguishable from a healthy idle connection. Joining as `anon` after 3 s is bad; joining *never*, invisibly, is worse. `realtimeAuthSettled` skips the race once hydration lands, so the timer costs only a cold start.

#### B. One watcher, three independent paths — `useSessionClosedWatcher`

The closure logic moved out of `useOrganizerBroadcast` into a hook both the player dashboard and the organizer board mount. It listens on three paths that **fail independently**:

1. **Broadcast** (`session_closed`) — the fast path. Now retried once inside `postBroadcast`, the only sender that opts in: it is the one event with no cheap alternative, and the receiver latches on `navigatedRef`, so a duplicate delivery is a no-op.
2. **`subscribeToSessionRow`** — postgres_changes `UPDATE` on `sessions` filtered `id=eq.<id>`. A *committed row change*, so any tab holding a live join gets it even when the broadcast POST never happened.
3. **Status poll** — `SESSION_STATUS_POLL_MS = 20_000`, floored by `SESSION_STATUS_MIN_GAP_MS = 5_000`, plus `visibilitychange` and channel-status re-checks. Covers the tab with no working socket at all.

⚠️ **Do not wire path 2's `onStatus` into `useOrganizerSession.handleChannelStatus`.** That counter asserts an exact `REALTIME_CHANNEL_COUNT = 5` of postgres_changes channels; a sixth pegs the board's "live" indicator to disconnected forever.

**Every path converges on one destination decision**, because sending a player to Wrapped is only right if a recap exists for *them*. `compute_session_wrapped` builds `_wrapped_stats` from `matches … status='completed'`, so anyone who never finished one gets **no row** — walk-ins, late arrivals, the organizer who only ran the board. `getPlayerSessionStatus` therefore returns `hasWrapped` alongside `isActive` (scoped to `user.id`, never a caller-supplied id, so it cannot probe whether someone else attended), and `resolveDestination` reads it only when `!isActive`, matching the field's documented contract. No recap → the club lobby.

**The redirect/probe race, and why `Promise.all`.** The toast delay and the destination probe run **concurrently** and the push waits on both — not the probe *inside* the timer, and not the timer *after* the probe. A probe slower than the delay would otherwise navigate late or, worse, resolve first and fire twice. Pinned by OBC-10e.

**`isActive: null` is not `false`** (unchanged from §3.30 and still the invariant that matters): unknown holds the dashboard. Only a definite `success && !isActive` navigates.

#### C. Latency — measured, and the client was the bigger half

`pg_stat_statements` on prod, 123-day window: `compute_session_wrapped` **68 ms min / 237 ms mean / 827 ms max**, `refresh_cross_session_stats` **8.5 / 109 / 604 ms**. Player-visible total ≈1.2–1.5 s typical. The honest finding: **the client's own deliberate `WRAPPED_REDIRECT_DELAY_MS` of 800 ms was larger than the ~346 ms of server pre-work.** It is now **250 ms**.

**Deliberate deviation from the audit's prescription — recorded because it will look like an oversight later.** The audit called for flipping `is_active` and broadcasting *first*, with both RPCs moved into `after()`. Implemented instead: **compute stays before the flip; the cleanups moved to after the broadcast.** Three reasons. (a) `after()` buys ~346 ms mean. (b) It breaks the invariant that Wrapped rows exist at broadcast time — `broadcastSessionClosed(sessionId, wrappedReady)` is only meaningful because `wrappedReady` is *known* at emit time. (c) An `after()` failure can never be reported to the organizer. The reordering that actually mattered was the cleanups: they cancel every match, mark every queue entry `left` and close every court — **~30 postgres_changes events fanned to ~40 phones**, previously arriving while the session still read ACTIVE and nothing had said why. **That is the "I got kicked out of the queue" report**, and it explains it better than server latency does. The failure mode improves too: before, cleanups could apply while the flip failed (a half-torn-down session nobody was told about); now the session closes and stale rows are unreachable anyway.

`compute_session_wrapped` also stops retrying on **`57014`** (statement timeout) and **`55P03`** (lock_not_available). Both mean the 8 s budget went to the per-club advisory lock; an immediate retry queues behind the same holder for another 8 s plus a 600 ms sleep and fails identically, with the organizer holding the spinner throughout.

#### D. The organizer's own board, and an undelivered broadcast

`closeSession` now returns `delivered` (the Realtime API accepted the POST) and `alreadyClosed` (an explicit flag, not a message match, so re-wording the copy cannot turn a double-submit back into a red toast — the organizer's UI treats it as success). `delivered: false` surfaces a warning toast with a **Re-send** action calling `renotifySessionClosed` — the escape hatch for the one failure the flow cannot self-heal, where the session is closed but no phone was told and the only other remedy is walking the gym.

Three UI fixes that only appear together: `AlertDialogAction` **is** Radix's `Dialog.Close`, so without `e.preventDefault()` the dialog dismissed on the same click that started the request and "Closing session…" painted once onto a node already fading out — which is most of what "it didn't fire" *looked* like. That in turn requires `{(!isClosed || closing) && …}` on the controlled dialogs, because `isClosed` now derives from `liveSession` and the organizer hears their own close echo mid-flight. And `activeTab` is now **derived** (`effectiveTab`) rather than initial-state-only, because the tab set drops 5→2 on a live close and a stored `courts` would leave the strip with nothing selected beside a panel of live court controls.

Both destination probes in `handleCloseSession` are **bounded and caught** (`withTimeout`, 1.2 s). The session is already committed closed when they run, so they only choose between two destinations — but unguarded, a rejection escapes to the outer catch and reports **failure for a close that succeeded**, and a hang means `finally` never runs: `closing` latches true, no push fires, `suppressCloseWatcher(false)` is never reached, and all three watcher paths stay dead with nothing left to recover the board.

#### E. Post-close writes are refused — with production receipts

`isSessionActive(sessionId)` (in `_shared.ts`) gates `joinQueueAction`, `callNextMatch`, `createManualMatchAction` and `toggleAutoMatchmaking`. Not hypothetical: prod carries two queue entries created **46.7 s** and **2.2 s** after their session's `ended_at`, both from the player dashboard's Join Queue button, both by non-organizers whose boards had not learned the session was over. A late entry is not harmless — `closeSession` has already marked every entry `left` and computed Wrapped, so the row is invisible to the recap and permanently stuck `waiting`.

Enforced in the actions rather than in the database on purpose: a CHECK or trigger would reject with a Postgres error string every action would then pattern-match to say anything human, **and would fire on `closeSession`'s own teardown UPDATEs**. It **fails OPEN** — an unreadable session row returns `true`, because a transient read failure must never block a legitimate write mid-session.

#### F. The sticky empty-Wrapped redirect

`dismissWrappedIntro` now uses `{ count: "exact" }` and reports `dismissed`. `success: true, dismissed: false` is the silent failure it exists to surface: no `session_wrapped_stats` row for this pair, so the dismissal has nowhere to land and the intro replays forever. The club play page closes the other half — `if (!wrappedStats) redirect(clubBase(clubSlug))` **before** the `intro_dismissed_at` check, because `maybeSingle()` yields null for a rowless viewer and the page used to fall through to Wrapped and render `EMPTY_STATS`. This branch now runs far more often, since the watcher calls `router.refresh()` on close; without it the server redirect unmounts the dashboard and **cancels the client's carefully-probed push**. `src/app/play/[sessionId]/page.tsx` is a pure redirect shim, so the club page is the only site.

> **`intro_dismissed_at` is NOT a bug.** It has exactly one writer (`dismissWrappedIntro` ← `WrappedShell.handleDone`) and is NULL for everyone at close time. It is a correct re-entry guard. Do not "fix" it.

**Out of scope by explicit decision:** the **TV board**. A gym screen stays on its last frame until someone reloads it. Chosen deliberately, not missed.

**Coverage:** `use-organizer-broadcast-closure.test.ts` 40 cases (OBC-1…14) · `use-organizer-dashboard.test.ts` 50 cases (adds OD-10b, OD-22a–k, OD-23a–b). Suite **1057 passing / 1 skipped across 58 files**.

**End-to-end, against production** — `tests/e2e/scenario-r-resilience.spec.ts` **[R-2a]** (a viewer with no completed match lands on the club lobby) and **[R-2b]** (a viewer with one lands on their Wrapped page). The single [R-2] they replace asserted the *superseded* contract — always Wrapped — and would have failed correctly; Playwright is not in CI, so nothing caught it at merge time. Assume nothing about E2E coverage after a behaviour change of this kind.

Three properties of that test worth preserving. (a) **The toast identifies nothing about the delivery path** — `leaveClosedSession` emits the same one on all three; what makes it a fast-path test is suppressing the 20 s poll and bounding elapsed time. (b) **A probe run serially before the thing you are timing poisons it**: the toast probe's own 15 s timeout used to guarantee `elapsed >= 15_000` on a miss, failing with "the redirect was slow" when the redirect was fine. They race in one `Promise.all` now. (c) **These assert the composite destination, not `resolveDestination`**: §3.31 F's `router.refresh()` fires before the push and the RSC's identical per-viewer branch normally wins, so a client probe that always answered "Wrapped" would still pass R-2a. That branch is unit-covered; what only E2E can prove is that a real close over a real socket puts a real browser on the right page.

**Shipped:** PR #55 → main `6592864` → Vercel production `dpl_Du2Sj1D3ac4yArWXbohHiiFTLTyN` READY, zero runtime errors. Full scenario-R run against prod: **7/7**. The [R-2a]/[R-2b] rewrite followed as PR #56 → main `1688e95` → `dpl_EX5zdnYWyPh37V6SfEBtAbSVBANe` READY (test + docs only, no `src/` change).

---

### 3.32 Consecutive-opponent freshness — the engine now previews the split before choosing the four (2026-08-12)

**Files:** `src/lib/matchmaking-db.ts` (`deriveLastOpponents`), `src/lib/matchmaking-core.ts` (`countConsecutiveOpponentRepeats`, `selectSplit`, `TeamSplit`/`LastOpponents`/`SplitPreviewContext`, argmin in `buildCombinationGroup`, `runAlgorithm` param 7), `src/lib/constants.ts` (`CONSECUTIVE_OPPONENT_PENALTY`, `MAX_CONSECUTIVE_OPPONENT_REPEATS`, `SPLIT_PREVIEW_BUDGET`), `src/app/actions/matchmaking.ts`, `scripts/replay/simulate.ts`.

**The complaint this closes.** Players were not objecting to *seeing* the same opponents over a night — they were objecting to facing them in **back-to-back** games. The engine had no notion of "last match" at all: `MAX_OPPONENT_REPEATS` is a whole-session count with no recency gradient, and `deriveOverlapMap` is anchor-relative. Measured on five real sessions, **79.3% of back-to-back opponent repeats are between two NON-anchor co-players** — invisible to the anchor-relative map at any weight, which is why re-tuning `OVERLAP_WEIGHT_OPPONENT` was a dead end.

**The mechanism.** Rematch avoidance is applied at two points, both strictly *inside* an existing fairness tier:

1. **Split choice** (`selectSplit`, shared by `snakeDraft` and `rotatedDraft`). The 4-pass partnership-freshness ladder is unchanged; within **each rung** the split with the fewest consecutive-opponent repeats now wins, ties keeping the earliest (most balanced) split. Only **cross-net** pairs count — two players who just faced each other and are now drafted as **teammates** cost nothing, which is where most of the gain comes from.
2. **Group choice** (`buildCombinationGroup`). The four is chosen by argmin over `fairness + 3 × repeats` rather than first-valid. See §3.1 for the `previewing` gate and the unseatable-four rule.

⚠️ **Never hoist the repeat count above the partnership predicates in `selectSplit`.** Promoting it out of the rung was tried and regressed partner variety in 5 of 5 sessions. Opponent freshness is a tie-break *within* a partnership-freshness rung, never a rung promotion (pinned by `CCO-7`).

**Why the penalty is 3.** `GAMES_AHEAD_PENALTY` is 10,000 per game owed — "the quantum". Any new term must be provably sub-quantum so it can only reorder candidates already tied on fairness. Max magnitude here is `MAX_CONSECUTIVE_OPPONENT_REPEATS × CONSECUTIVE_OPPONENT_PENALTY` = 4 × 3 = **12**, i.e. 833× below the quantum; the reach is ~12 summed priority-minutes ≈ 4 minutes per displaced seat, and at `MIN_REST_MINUTES = 18` a 4-minute gap is routine. A sweep of {2,3,4,5} put 3 in the middle of the winning plateau; past 5 the engine starts pulling materially lower-priority players in to dodge a repeat, desynchronising the rotation (near-identical foursomes jump 4 → 24 on 07/25). Treat the exact value as noise-level tuning and *"any positive sub-quantum value helps"* as the robust finding.

**Measured** by `scripts/replay-sessions.ts` over five real production sessions, A/B'd against `REPLAY_NO_LAST_OPPONENTS=true` (which feeds an empty map and must reproduce the baseline exactly — the control for porting bugs):

| Metric                        | Engine before | Engine after | Organizer's own night |
| ----------------------------- | ------------- | ------------ | --------------------- |
| Back-to-back opponent repeats | 244/550 (44.4%) | **186/550 (33.8%)** | 170/479 (35.5%) |
| Near-identical foursomes      | 32            | **28**       | 0                     |
| Opponent pairs over soft cap  | 52            | **36**       | 33                    |
| Partnerships over hard cap    | 0             | **0**        | 0                     |

The engine now beats the organizer's hand-run rate. **Repeats improve in 5 of 5 sessions; partner variety improves in 2, is unchanged in 3, and regresses in 0.**

⚠️ **Per-session regressions worth naming rather than burying** — the flat aggregates hide a redistribution:

- **07/30**: near-identical foursomes **8 → 12**, and consecutive-*partner* repeats **2 → 4**.
- **07/25**: games-played spread widens **4–7 → 3–7** (one player ends a game further behind).
- The aggregate consecutive-partner figure is flat at 4 only because 06/25 improves 2 → 0 while 07/30 worsens 2 → 4.

**Replay caveats** (all stated in `scripts/replay/simulate.ts`): the draft queue is collapsed to the bypassGate path at 100% court occupancy, nobody leaves early or pauses, there is no cross-court augmentation, and rejection memory is empty. Compare **rates**, never absolute counts.

**Wiring note — parameter order is a trap.** `lastOpponents` is `runAlgorithm` **param 7**, deliberately *after* `rejectedRosters` (param 6). An earlier draft of this feature branched before rejection memory landed and put it at 6; that merges textually, compiles clean, passes type-check — and **silently drops rejection memory**. If you add another optional param, append it.

### 3.33 FRESH chips — the green half of the manual-match picker (2026-08-12)

**Files:** `src/lib/repeat-pairing.ts` (`deriveFreshCandidates`, `eligibleCandidates`, `freshMarkersAreInformative`) · `src/lib/repeat-pairing-copy.ts` (`freshTitle`, `freshLabel`, `LegendFamilies`, `markerLegend`'s 5th param, **and the `pairHeadline` opponent fix**) · `src/hooks/use-repeat-pairing.ts` (`fresh`, `legendFamilies`) · `src/components/organizer/repeat-marker.tsx` (`FreshMarker`, `FreshContext`) · wired into `queue-control.tsx` + `queue-skill-groups.tsx` · `--cc-fresh` in `globals.css`.

Extends §3.25. Two things ship together because they are the same defect seen from two sides: the manual-match screen only ever spoke about what was *wrong*, and one of the things it said was untrue.

**The false headline (the fix that matters most).** `pairHeadline` told the organizer that an opponent repeat means "auto-matchmaking won't match them again". That is **false**. The two caps are not the same kind of thing:

- **Teammate is HARD.** `selectSplit` requires `bothPairsUnderCap` in every one of its four passes, so `snakeDraft` returns `null` rather than exceed `MAX_PARTNERSHIP_REPEATS` — and *every* call site passes that cap, including the last-resort fallback (`matchmaking-core.ts:1447`). "Won't pair them again" is literally true; the organizer overriding it knows they are overriding the engine.
- **Opponent is SOFT.** `crossNetOk` appears only in passes 1a/2a; passes 1b/2b drop it explicitly so the engine cannot stall on a small session. It is a ranking preference, never a block.

The opponent line now reads "auto-matchmaking avoids this, but won't refuse it". An organizer who trusted the old wording would read every legitimate engine rematch as a bug — and this is a screen they open *because* they already distrust the drafts.

**Why a green chip and not just fewer amber ones.** An unmarked row is ambiguous: a marker only fires at `count >= cap`, so "no chip" mixes *never played* with *played once*. That is precisely the distinction the organizer is hand-building a match to act on, and the amber family structurally cannot express it.

**ZERO in BOTH maps — the one deliberate divergence from the engine.** `deriveFreshCandidates` takes the next pick's referents (partner slot + both opposing slots, same targeting as `deriveCandidateMarkers`) and keeps only candidates at count `0` in the teammate map **and** the opponent map, whatever role the pick would actually create. The amber marker mirrors the engine because it *predicts what the engine will refuse*; the green chip answers a human question — "have these people shared a court tonight" — and its own copy ("no games with Alice, Bob and Carol yet tonight") is a plain lie under role-specific checking. Strictness only ever withholds a chip; it can never over-promise. Zero also buys a free property: a pair that has never met cannot have met *last game*, so a FRESH pick is automatically clear of §3.32's consecutive-opponent penalty.

**The discrimination gate — a different gate, on purpose.** `freshMarkersAreInformative(freshCount, poolCount)` renders the family only when `0 < fresh < pool`. Both silent ends carry no information: a chip on every row (early session) and a chip on none. It is **not** `hasCleanAlternative`, the avoidability gate that governs the warnings — that gate asks whether the organizer could have done better, which is the question a *warning* must justify itself against; a FRESH chip is the answer, not the accusation. It is likewise **not** suppressed by `capSaturationActive`: that notice tells the organizer to override by hand, so hiding the only positive signal at that exact moment inverts the point. Deliberately all-or-nothing rather than a ratio floor — any threshold would be a number invented with no evidence, while the two degenerate ends are provably information-free, and the lopsided case self-corrects as the referent set grows from 1 to 3 by the fourth pick.

**One basis for the ratio.** `eligibleCandidates(slots, candidateIds)` exists so the numerator and denominator are measured after the same exclusion. Measuring fresh post-exclusion against a pool that still holds the selected players turns a correctly-silent all-fresh bench into a wall of green — the exact failure the gate was written to prevent.

**Episode snapshot, shared.** `fresh` rides the same frozen counts as the amber family (chips that move under the organizer's finger mid-build are worse than chips one match stale) but sits outside `gateOpen`. `markerContext` — the referent line — now renders when *either* family has something to show, and travels to both lenses inside a single `FreshContext` object so a set can never be rendered against a stale referent.

**Copy + colour.** `--cc-fresh` is a new token (hue 150 green). Not `cc-accent`: teal already means SELECTED on this exact screen, and two cyan-family chips in one row read as two states of one thing. Against the `cc-bg-2` card it measures **4.97:1 light / 9.78:1 dark**, clearing AA for the chip's 9px text and sitting slightly *above* the existing `cc-amber` baseline (4.35 / 8.72) in both modes. Per the house rule the meaning is on the **label** too — the chip always carries the word "Fresh" — so it survives greyscale and red-green deficiency. The legend adapts to `LegendFamilies` and swaps its icon (`Sparkles`, `cc-fresh`) on a fresh-only screen, because an amber glyph labelling a non-warning is its own small lie. The combined legend repeats the fresh clause **word for word** rather than shortening it to "…no games with them yet": the nearest plural antecedent for "them" is *Marked players*, and that reading is false.

**Mutual exclusivity** is structural — `>= cap` versus `=== 0` over a superset of the same referents — and belt-and-braces at both render sites (`!marker && …`).

**Tests:** `repeat-pairing.test.ts` RP-F1–F15 · `repeat-pairing-copy.test.ts` RPC-F1–F5 / L4–L7 / H2b (pins both headlines together so a later pass cannot "harmonise" them back to the false one) · `use-repeat-pairing.test.tsx` RPH-F1–F5, C3 · `queue-control-repeat-pairing.test.tsx` **QRP-X1–X9** (both lenses by name, mutual exclusivity across every row, legend adaptation, both silent ends, and the episode-snapshot freeze).

---

### 3.34 `isRedZonePlayer` — the score threshold was never the Red Zone condition (2026-08-12)

**Files:** `src/lib/matchmaking-core.ts` (new exported `isRedZonePlayer`, + 4 call sites) · `src/app/actions/matchmaking.ts` (broadcast type) · `src/lib/constants.ts` (`RED_ZONE_SCORE_FLOOR` doc) · tests `RZ-1`–`RZ-6`, `RZ-SC1`–`RZ-SC3`, `RA-2b`, `RA-3b`, `ME-new-1b` (12) · `MATCHMAKING.md` (staleness banner — it stated the bug as fact) · `digital-twin/src/data/manifest.json` (regenerated; it carried the old JSDoc verbatim).

**The bug in one line.** `RED_ZONE_SCORE_FLOOR` is an **addend inside Tier 2's formula, not a floor under it** — `1000 + wait − games × 8`. Five call sites read it as a floor and tested `priorityScore >= RED_ZONE_SCORE_FLOOR` as if that were the Red Zone condition. It isn't: whenever `games × 8 > wait` a player who genuinely satisfies `wait >= CRITICAL_WAIT_MINUTES` scores **below** 1000 and every one of those five sites silently treated them as a Normal-queue player. **Wait 22 min, 3 games → `1000 + 22 − 24` = 998.**

**Measured, not theorised.** A read-only reconstruction of 318 auto-created production matches found **20** whose anchor had a reconstructed wait ≥ 20 min and a reconstructed `priorityScore` below 1000 — i.e. 20 matches built while the engine had quietly demoted an anchor it was supposed to be protecting.

**Two distinct cohorts land below the floor** (the second is easy to miss):

1. **`wait ∈ [20, 25)` with game debt** — the headline case above. Ordinary mid-session state for anyone playing densely.
2. **`wait ≥ 25` with `games ≥ 5`** — `HARD_CAP_GAMES_CEILING = 5` excludes them from Tier 3, so they *fall through* into Tier 2 and score below 1000 there. **Wait 30 / 5 games → 990.** This cohort is the worst-affected: they have waited the longest of anyone and are simultaneously denied both overrides.

**The fix — one predicate, not five copies of a workaround.** `anchorBlocksReach` (§3.1, cross-court) had already worked around this locally by OR-ing in an explicit wait test. That shape is right; copy-pasting it five more times is not. So the two-armed test is now a single exported function:

```ts
export function isRedZonePlayer(p): boolean {
  if (p.isPulled) return false;
  return (p.wait_minutes ?? 0) >= CRITICAL_WAIT_MINUTES || p.priorityScore >= RED_ZONE_SCORE_FLOOR;
}
```

The wait arm is the definition. The **score arm is not redundant**: it is what still catches the Hard Cap tier (2000 ≫ 1000) and any future tier that scores above the floor for a reason other than raw wait. The `isPulled` arm is the one addition beyond a literal reading of the tier condition — a cross-court-pulled body is mid-game, so its "wait" is not queue starvation and the `buildCrossCourtProposal` **call site** in `matchmaking.ts` deliberately scores it `-1` (the function itself does not — `PullableBody` carries no `priorityScore` field, so the two hardcodes sit in different files, which is the split `RZ-5` guards); without this arm a long-waiting player pulled off a court would newly acquire Red Zone protections the feature never granted them.

**What each of the 6 call sites was actually getting wrong** — note they are *not* all the same kind of site, which is why one blanket rationale cannot cover them:

| Site | What the Red Zone flag buys | Effect of the bug |
|---|---|---|
| `scoreCandidates` — the `isRedZone` local | **two** terms, not one: overlap penalty `×100` instead of `×10,000` **and** the fresh-first `GAMES_AHEAD_PENALTY` `×100` instead of `×10,000` | scoring — urgency **and** anti-starvation |
| `runAlgorithm` — the `anchorIsRedZone` local feeding `skillWindows` | tries ±3 and ±4 as well as ±1/±2 | scoring — urgency |
| diversity-swap guard — `isRedZonePlayer(swapTarget)` | "never bench a Red-Zone player" | **fairness protection** |
| balance-swap guard — `isRedZonePlayer(group[i])` | same | **fairness protection** |
| `cap_saturation` broadcast — `matchmaking.ts`, `broadcastCapSaturation` payload | payload `type: "red_zone"` | **documented contract** |
| `anchorBlocksReach` (pre-existing) | refuses a cross-court hold | already correct |

⚠️ Deliberately **no line numbers** in that table. The first version carried them and four of the five were stale within the same working session — grep the symbol names instead.

**The same fallacy lived in three dev scripts.** (The round-5 commit `e516af4` scoped the fix to "the two dev tools for sanity-checking the engine" and undercounted by one; this is the correction.) `simulate-engine.ts` and `simulate-31p-3court.ts` now import `isRedZonePlayer` directly. `simulate-scenarios.ts` could not — it is a standalone *parametric* simulator with its own `SimConfig` thresholds, so importing the production predicate would silently ignore its own `cfg.critWait`. It is what *validated the hard-cap proposal*, and its header still frames `HARD_WAIT_CAP = 25` as NEW and `CRITICAL_WAIT = 20` as "was 25". ⚠️ Do not "correct" that header from git history: `git log --diff-filter=A` dates the file to 2026-08-10, two months **after** `2d2144c` landed those constants, but the file existed untracked — `2d2144c` itself added the "Validated across 3 scenarios" line above, which cites it by path. It got a local `zoneOf(...)` instead, deriving the tier from the same inputs the scorer branches on. That file also carried the mirror-image of the bug in the *other* tier: `pl.score === 2000` for hard cap, which matches a player at *exactly* the cap and misses everyone past it, since the hard-cap arm returns `2000 + Math.round((wait − hardCap) × 10)`. Both are fixed; the ⚠️ on `zoneOf` states the rule so the next reader does not re-derive a band test. (`simulate-engine.ts`'s `scoreZone` still band-tests, which is deliberate and documented in place — it colours the printed *score* for the console table, and is not a tier decision.)

**⚠️ The behavioural tradeoff — this is not a pure bug fix.** The predicate changes no score, but for the newly-detected cohort it changes which penalty constant `scoreCandidates` applies: `GAMES_AHEAD_PENALTY` **10,000 → `GAMES_AHEAD_PENALTY_RED_ZONE` 100**. A wait-22 / 3-games candidate moves from `candidateScore` **29,002** (effectively unseatable) to **−698**, which now sorts it **ahead of** a fresh 0-game / 19-minute waiter at `−19`. (Those three numbers assume **no anchor overlap** and `poolMinGames = 0`; `candidateScore` is `−priorityScore + overlap × k_overlap + gamesAhead × k_games`, and only the two `k`s move — `RZ-SC2` isolates the overlap term separately at `−998 + 100`.) That is bounded and deliberate, but say it plainly rather than let it be discovered: *within* Tier 2 the effective per-game weight is `8 + 100 = 108` against 1 per minute of wait, so fresh-first still dominates among Red-Zone players; the only inversion is **across the 20-minute line**, and the starved 0-game waiter crosses that line at 20 minutes and reaches Tier 3 at 25. Pinning an under-20 waiter behind a 22-minute waiter is what "Red Zone" is *supposed* to mean — but it is a seating-order change the bug report did not ask for, and if the organizer ever reports that dense-play regulars started jumping fresh players, this paragraph is the cause and `RZ-SC1` is the test that encodes it.

**A documented rationale that argued for the bug — preserved, then scoped.** The tier diagram used to call the under-reporting *intentional*: players well above the fair-share games target "benefit less from Red Zone urgency because their wait is self-caused by dense play rather than queue starvation". That argument was not deleted, because it is not stupid — but it is recorded in place as insufficient for three reasons. It can only ever speak to the two **urgency** sites; it says nothing about a fairness floor ("never bench a Red-Zone player" is not an urgency boost), and nothing at all about what a broadcast payload means. And it **double-counts**: the game penalty is already subtracted inside Tier 2's own formula, so game debt has been priced in once before the threshold prices it in again. The note ends with the constructive version: if that argument is ever revived, revive it as an explicit `games_played` test at the two scoring sites — never as a score threshold that silently also strips fairness protections.

**The contract violation this repaired.** `broadcast.ts` defines `CapSaturationPayload.type === "red_zone"` as "anchor has waited ≥ `CRITICAL_WAIT_MINUTES`", and the UI copy in `sortable-card.tsx` says "waiting over 20 min". The implementation used a score test, so a wait-22 / 3-games anchor was broadcast as `"general"` — the payload disagreed with its own doc comment *and* with the string on screen.

**Why not clamp instead.** The alternative was `RED_ZONE_SCORE_FLOOR + Math.max(0, wait − gamePenalty)`. Rejected: it collapses **every** below-floor Red-Zone player to exactly 1000, destroying the intra-tier ordering that the rest of the engine relies on to rank Red-Zone players against each other — the fix would have introduced a fairness bug to close a detection bug. The predicate changes no score at all.

**Tests (12).** _Predicate:_ `RZ-1` pins the divergence itself (a wait-22 / 3-games player is Red Zone **and** `priorityScore >= RED_ZONE_SCORE_FLOOR` is `false` — so the test fails if anyone ever "fixes" this by clamping); `RZ-2` the fall-through cohort (wait 30 / 5 games → 990); `RZ-3` the 19/20 boundary at games ∈ {0,3,5,9}; `RZ-4` the score arm alone; `RZ-5` pulled bodies; `RZ-6` the `?? 0` branch. _Call sites:_ `RZ-SC1` proves the below-floor cohort now gets the capped **games-ahead** penalty (`−998 + 300`, sorting it ahead of a fresh 0-game / 19-min waiter at `−19` — this is the behavioural tradeoff spelled out above, pinned so it cannot change silently); `RZ-SC2` isolates the **overlap** term (`poolMinGames` omitted → `−998 + 100`); `RZ-SC3` covers the wait-30 / 5-games fall-through cohort at both terms. `RA-2b` covers the widened skill window, `RA-3b` the swap-target protection. `ME-new-1b` is the end-to-end regression: it clones the cap-saturation fixture with a wait-22 / 3-games anchor, **guards its own premise** (asserts the score is exactly 998, below the floor, past `CRITICAL_WAIT_MINUTES`, and still the pool's highest) and then asserts the broadcast is `"red_zone"`. `makePlayer` derives `priorityScore` through `computePriorityScore`, so none of these can pass on a hand-set score.

**Two structural facts the call-site tests had to route around** — both cost a failed attempt each, so they are recorded rather than rediscovered:

1. **`FALLBACK_WAIT_MINUTES` (15) is BELOW `CRITICAL_WAIT_MINUTES` (20)**, so every Red Zone anchor is already past `runAlgorithm`'s last-resort fallback. The fallback seats the four regardless of skill window, which means `proposal !== null` proves **nothing** about whether the ±3 window was reached. What differs is _how_: the fallback returns `forcedRepeat: true` and the legitimate ±3 path leaves it unset. `RA-2b`'s decisive assertion is therefore `expect(result.forcedRepeat).toBeFalsy()`.
2. **The Tier-1 diversity swap cannot clear a violation whose overlapping trio is anchor + `group[0]` + `group[1]`.** The swap only ever replaces `group[2]`, so it can only break an overlap that *includes* `group[2]`. It follows that the obvious fixture — put the proposed four itself into `activeRosters` — is unusable: the surviving trio is still at `overlap >= 3`, the swap fails whether or not the guard fires, and the test proves nothing. (A violating roster of {anchor, `group[0]`, `group[2]`} *would* be clearable; it is just fiddlier to construct.) So the swap guard is tested on the **rejection** path instead, where `isRejectedRoster` is an exact set match that any one substitution clears. `RA-3b` runs there, and gives all five players 5 games so `poolMinGames = 5` zeroes every `gamesAhead` term — otherwise it would accidentally re-test `RZ-SC1` instead of the guard.

**Verified by bug injection, not just by green.** Reverting the predicate to a score-only test failed exactly `RZ-1`, `RZ-2`, `RZ-3`, `RZ-SC1`, `RZ-SC2`, `RZ-SC3`, `RA-2b`, `RA-3b`, `ME-new-1b` — nine, and nothing else; removing the `isPulled` arm failed exactly `RZ-5`. Every restoration confirmed byte-identical by sha256. `RA-2b` and `RA-3b` each **passed** under injection on their first drafts (worthless as regressions) — that is how the two facts above were found.

### 3.35 The broadcast policy is now tested for what it REFUSES (2026-08-13)

**Files:** `tests/integration/realtime-broadcast-rls.test.ts` (new, Suite RB, 8 tests). No production code changed — this closes a **coverage** gap, not a defect.

**The gap.** Tenancy audit finding #7 (§ Broadcast System, migration `20260723100000`) shipped 2026-07-24 (PR #41, `4bc5cfc`; the migration filename carries its 07-23 authoring date), and everything written for it tested the *client* side: `realtime-private-broadcast.test.ts` (RPB-1…7) mocks supabase-js and asserts the app **declares** `private: true` and builds the right topic string, and `[R-1]` proves a second organizer **receives** the event. Both are positive paths. Nothing asserted the half the finding was actually about — that a signed-in stranger is **refused**. A policy that had been dropped, or narrowed to `using (extension = 'broadcast')`, would have left every one of those tests green while the topic leaked club-wide again.

**Why this is testable in SQL at all.** Realtime Authorization is not a bespoke check. To decide a channel join, Realtime opens a transaction, sets the caller's role and JWT claims, sets `realtime.topic` to the topic being joined, and asks Postgres whether the caller can `SELECT` from `realtime.messages` — and, for the write half, whether an `INSERT` survives. Suite RB reproduces exactly that against local Supabase, so it runs the real policy, the real `realtime_topic_session_id()` and the real `session_access_level()` over real rows. The two things it does **not** cover are stated in its header: the WebSocket layer (that is `[R-1]`'s job) and the project-wide "Allow public access" toggle, which has no SQL surface.

**Every test is killed by a mutant.** Four mutated policy sets were applied to the local stack and the suite re-run against each:

| Mutation | Tests that fail |
|---|---|
| **M1** replace the predicate with `using (extension = 'broadcast')`, still `for select to authenticated` — private but unscoped | RB-3 RB-4 RB-5 RB-7 |
| **M2** add `for all to authenticated using (true) with check (true)` — the forgery hole | RB-3 RB-4 RB-5 RB-7 RB-8 |
| **M3** drop the policy entirely — fail-closed | RB-1 RB-2 RB-4 RB-5 |
| **M4** add `for select to anon using (extension = 'broadcast')` | RB-6 |

M2 kills the four reads as well because a permissive `ALL` policy is OR-ed into `SELECT`. M3 kills RB-4 and RB-5 through their **positive** halves — RB-4's own-club control and RB-5's before-deactivation read — not their negative ones.

⚠️ **RB-6 is a pin, not a discriminator against M1–M3** — `anon` is refused under all three, so only M4 can kill it. It earns its place anyway: `20260723100000` warns that adding an anon arm silently requires putting back the `anon` EXECUTE grant on `realtime_topic_session_id()` that the same migration deliberately revokes. The `to authenticated` on M2 is load-bearing: without it the policy applies to `PUBLIC`, which includes `anon`, and RB-6 would fail too — making the table above wrong. The verbatim DDL lives in the test file header; re-derive the table if you change a mutant.

**Two facts worth keeping.** (1) The forgery half (RB-8) is closed by the **empty policy set**, not by a missing GRANT — `anon` and `authenticated` both hold `INSERT` on `realtime.messages`. ⚠️ SQLSTATE `42501` alone cannot tell those apart: it is `ERRCODE_INSUFFICIENT_PRIVILEGE`, raised identically for a missing table GRANT and for an RLS deny. RB-8 therefore asserts all three — `has_table_privilege` is true, the insert failed, and the message names row-level security — so a migration that swapped one closure for the other could not pass silently. (2) The policy predicate on production hashes byte-identically to the local one it was tested against (`md5(pg_get_expr(polqual, …))` = `b71440dd…`, single SELECT policy, no INSERT/ALL policy on either), which is what lets a local suite speak for prod.

---

### 3.36 Why display names stay in broadcast payloads (2026-08-13)

**Files:** none — this is a recorded decision, not a change. Tenancy audit #7 prescribed three fixes; two shipped in PR #41 (`4bc5cfc`, merged 2026-07-24; the migration `20260723100000` is *named* for its 07-23 authoring date, and was hand-applied to prod as stamp `20260724050234`), and the third — *"stop putting display names in payloads — send only ids and let each client resolve names it is authorized to read"* — is **declined**. It was declined at the time, too: `PENDING_WORK_2026-07-23.md` §2.4 records the reversal, and `git log -S` puts that text in `4bc5cfc` itself — the same commit that shipped the other two. What never happened was amending the audit, so for three weeks the only durable trace was a prescribed remedy with no disposition and code that visibly ignored it. §3.36 and the audit's own status box close that.

**The three names.** `cap_saturation.anchorPlayerName`, `organizer_intervention.actorName`, `draft_cap_phase.actorName`. Nothing else in `src/lib/broadcast.ts` carries a name; `affectedPlayerIds` is already ids-only.

**Who can hear them now.** The join predicate is `session_access_level(<topic session id>) IS NOT NULL`, i.e. session creator, a `session_organizers` row, a club `owner`/`admin`, or an **active** `club_members` row. That is the whole audience — the clause was written when the topic was public and an anon socket with a session UUID could harvest the feed.

**Why ids buy nothing.** `profiles_select` is `id = auth.uid() OR can_read_profile(id)`, and `can_read_profile` has five arms ([20260723200000](supabase/migrations/20260723200000_scope_profiles_select_to_shared_scope.sql)). Arm 2 — *target is queued in a session I can reach* — covers `anchorPlayerName` outright: the anchor is by construction a queued player of that same session (`const anchor = pool[0]` → `broadcastCapSaturation`, [matchmaking.ts:584-593](src/app/actions/matchmaking.ts:584)), and the recipient can reach the session or they could not have joined. So every recipient of a `cap_saturation` payload can already `SELECT` that display name; sending the id instead would just make them fetch it. Incremental disclosure: **zero**, and it does not decay — checkout **UPDATEs** the row to `status='left'` ([queue.ts:198](src/app/actions/queue.ts:198), `remove_player_from_queue_organizer`), it does not delete it, and arm 2 has no status filter, so coverage survives the anchor leaving. ⚠️ `20260723200000`'s own header comment says *"`queue_entries` rows are DELETEd on checkout"* — **that is false**; `queue_delete_own` / `queue_delete_organizer` are DELETE *policies* on the table, and no production code path issues a DELETE against it (the only DELETE **against `queue_entries`** in `src/` is dev-only `clearSessionData` in `src/app/actions/dev.ts` — `checkoutPlayer` does hold a DELETE at [queue.ts:249](src/app/actions/queue.ts:249), but against `match_players`; the only other **non-test** one is the hand-run `supabase/data-fixes/20260608_duplicate_name_data_fix.sql`, which is not an application path — `tests/` deletes freely, thirteen sites across six files, which is exactly how the arm-3 integration test manufactures its state). A draft of this section imported that claim as fact; do not re-import it.

The two `actorName`s name the acting organizer and are covered by arm 4 (`session_organizers`), arm 5 (`sessions.created_by`), arm 1 (*shares any active club with the target* — a `club_members` self-join on `me.club_id = them.club_id`, **not** a test against this session's club), arm 3 (*target played a match in a session I can reach*, which catches any club owner/admin who has ever played in front of this recipient) or arm 2 (*target is queued in one* — arm 2 carries **no status filter**, so an organizer who is also sitting in their own session's queue is covered). ⚠️ **One shape escapes all five, and it is a property of the RECIPIENT:** anyone who can reach the session but shares no active club **at all** with the actor has no arm 1, so an actor who is a club owner/admin with no `session_organizers` row, no reachable match played, no reachable queue entry **and no session of their own creation that this recipient can reach** (arm 5) is unresolvable to them. (Not holding a row in *this* session's club is the usual route there, but not sufficient — an overlap in any other club restores arm 1.) Today the recipient class that lands there in practice is the *delegated* (QR-invite) organizer — the case `can_read_profile`'s non-club arms exist for. A non-member session **creator** would also qualify, but cannot be minted any more: since audit #2 was fixed, `createSession` demands an explicit `clubId` + `isClubAdmin` ([sessions.ts:140-146](src/app/actions/sessions.ts:140)) and `getClubRole` filters `is_active` ([clubs.ts:161](src/lib/clubs.ts:161)), so creators hold an active membership *at creation time* and arm 1 covers them. Membership is revocable afterwards (`leaveClub` / `removeMember` → `club_member_deactivate`), so a post-fix creator can lose arm 1 as well — and when they do they **join the delegated organizer in the uncovered class**. 🪤 **Arm 5 does not rescue them.** `profiles_select` is `id = auth.uid() OR can_read_profile(id)`, so `p_profile_id` binds to the row **being read** — the actor. Every arm is a predicate on the **actor**, qualified only by what the **recipient** can reach; arm 5 fires when the *actor* created a reachable session and says nothing about the recipient having created one. The draft before this one read that arm backwards and had it covering creators-as-recipients. The conclusion is unaffected: either way the recipient is a co-organizer of the very session being acted on. Attributing "who just cleared my board" is what the field is **for**. Enumerate all five arms when re-checking this: an argument that *is* an exhaustive case split stops being one the moment an arm is skipped — this paragraph has now been corrected **three** times on exactly that, first for omitting arm 3, then arm 2, and then arm 5, which fell out of the escape-shape split while the very same paragraph was busy (mis)spending arm 5 on the creator question.

**Why implementing it would regress.** [use-organizer-session.ts:300](src/hooks/use-organizer-session.ts:300) renders `copy(payload.actorName ?? "A co-organizer")`. Id-only makes every attribution anonymous unless a client-side lookup is wired into the toast path — a path that [broadcast.ts](src/lib/broadcast.ts)'s header records as having **no** polling fallback (only the two toggle events have one, and it lives in `use-organizer-session.ts`) — and that lookup returns nothing in exactly the one uncovered case above, so the toast falls back to "A co-organizer" regardless. Strictly worse UX, no confidentiality gained.

**Re-open if** the join predicate is ever widened beyond `session_access_level(...) IS NOT NULL`, or a payload starts carrying a name that is not the anchor or the actor. Full reasoning in the status box under §2 #7 of `TENANCY_AUDIT_2026-07-21.md`.

---

### 3.37 The tenancy audit is fully dispositioned — and why the labels mattered (2026-08-13)

**Files:** `TENANCY_AUDIT_2026-07-21.md` only — a documentation pass, no behaviour change.

**The problem was not an open hole; it was that a closed one still read as open.** Chasing #7's missing disposition surfaced the same defect across the whole document. Every finding had been dispositioned — ten fixed, several of them weeks earlier, and #9 formally accepted — but the `### #n` headings still carried their as-found severities, so the file said `🔴 CRITICAL · EXPLOITABLE TODAY` (#1), `🟠 HIGH · EXPLOITABLE TODAY` (#2, #3) and `🟠 HIGH (privacy) · EXPLOITABLE TODAY, unauthenticated` (#6) about work that was shipped, applied and verified. Ten headings carried an as-found severity with no disposition; five of them read the literal `EXPLOITABLE TODAY` — #1, #2, #3, #6 and #11's duplicate (`🟡 MEDIUM-LOW · EXPLOITABLE TODAY, within-club`) — the rest variants: `🔴 CRITICAL · UNAUTHENTICATED WRITE TODAY` (#10), `🟠 HIGH · club boundary void TODAY, cross-club at 2nd club` (#5), `🟡 MEDIUM · cross-session TODAY` (#4), `🟡 MEDIUM · TODAY` (#7) — and #8's `🟡 MEDIUM · mostly latent until 2nd club`, which names no date but still read as unresolved. For nine findings (#1–#8, #10) it was the only heading they had; #11 had one too, on its older duplicate entry, while its authoritative copy was already stamped. Only #9's `⚪ LOW · negligible` was harmless. Two concrete costs, both incurred:

1. **It caused a wrong conclusion.** While deriving §3.36, an analysis read #2's un-updated heading as evidence that a non-member could still self-provision organizer rights, and built an escape-case argument on top of it. The code said otherwise. The rule now recorded in `MEMORY.md`: **an audit finding with no status box is not evidence that the hole is open — read the code.**
2. **A stale banner outlived its fix.** #11 appears twice; the older copy's box still announced `🟠 STATUS 2026-08-10 — FIX WRITTEN, NOT YET APPLIED. STILL OPEN ON PRODUCTION.` three days after the migration was applied and verified. A reader landing there first would have re-done applied work, or worse, treated a live prod policy as absent.

**What was done.** A dated **closing banner** at the top of §1 marks the historical verdict paragraphs — the 2026-07-21 verdict and the 2026-07-23 update — as such, tabulates all eleven findings with their disposition, and names the evidence re-checked for each. Every heading now carries a disposition with the original severity kept in parentheses — `✅ CLOSED (was 🟠 HIGH)` for the ten that were fixed, and `⚖️ ACCEPTED 2026-07-24 — no fix possible (was ⚪ LOW · negligible)` for #9, which is a decision rather than a fix and must not be counted as one. Keeping the as-found severity matters: it is real history, and it is what makes the size of the fix legible. **Six** findings — #1, #2, #3, #7, #8 and #10 — gained status boxes they never had (#7's is the clause-3 declination derived in §3.36); the roadmap in §4 is marked done item by item, with item 6 relabelled an accepted *decision* rather than a shipped fix; the duplicate #11's whole body is folded into a `<details>` and labelled `⛔ SUPERSEDED`. §1's two remaining live-reading paragraphs — the 2026-07-23 "#10 changed the headline" update and the PIN-chain lead — are additionally stamped historical in place: the banner **as first drafted** disclaimed only the 2026-07-21 verdict paragraph, and a scoped disclaimer is not a document-wide one. It now names both, and the per-paragraph stamps stay as the local record. **Four** further paragraphs still described live exposures or live rankings in the present tense, and were corrected in place rather than deleted — two inside long-closed #6 (`refresh_alltime_leaderboard`'s "free DoS lever", which pointed at a "PR5 sweep" that never existed — it was swept up by #10; and the "second-most-impactful … live today" ranking), one in §3 "WHAT IS SOLID" (the `v_alltime_leaderboard_mat` anon-SELECT note, closed by `20260722165729`), and one in §4's urgency framing.

**Everything in the banner was re-measured, not copied from the PR log** — the whole point being that a claim of closure is worth exactly as much as its evidence. Code side: the third gate in all four `profile.ts` actions, the `session_id_snapshot` filter, both shims' participation gates, the five `allMatchesInSession` call sites. Prod side (read-only, `usxftpexoimletqmrggb`): the three leaderboard RPCs and the matview are `false` for anon *and* authenticated; all 16 mutating RPCs are `false` for anon and `true` for `service_role`; `swap_teams_in_active_match` carries both `SESSION_ID_REQUIRED` and `AND session_id = p_session_id`; and eight migration stamps are present in the prescribed order.

**Four corrections worth keeping — a selection, not a total.** *Every* review round on this pass found a fresh false claim inside the previous round's own corrections; these four are the instructive ones, and the count is not a tally of how many there were. The first draft of the banner claimed *"zero volatile SECDEF functions hold anon EXECUTE"* — false: `handle_new_user` and `handle_new_session` are volatile and anon-executable. The true invariant is the narrower one the regression test actually pins, **no volatile _non-trigger_ SECDEF function**, because PostgREST will not dispatch a `RETURNS trigger` function. The second draft said #3's `crypto.getRandomValues` clause was only partly met; `randInt` ([sessions.ts:49-53](src/app/actions/sessions.ts:49)) *is* `crypto.getRandomValues`. The third is the sharpest, because it is this very defect eating its own audit: #1's status box asserted that `profile.ts`'s header comment miscounts the gates when it says *"the `sessionId` parameter is required … so **both** gates can be verified"*. It does not — `sessionId` is consumed by exactly two of the three gates, and `git show 607df4e^` shows the line previously read *"so **the organizer gate** can be verified"*, widened to "both" at the very commit that added gate 3. The fourth was inherited rather than authored — and then **over-corrected three times, which is the instructive part**. Closing out the audit's non-code items, the pass copied the recorded leaked-password rationale — *"every `auth.users` row signs in via Google OAuth **and walk-in players are anonymous+PIN**, so no email+password credential exists for HIBP to check"* — into the audit banner, measured it, and stamped the whole thing false. (Quote it whole: an earlier draft dropped the walk-in clause, which is the clause that carries 202 of the 226 rows.) That stamp was itself wrong. The measurement asked `encrypted_password IS NOT NULL`, which counts the **empty string** — the placeholder held by 190 of the 226 rows, 184 of them anonymous walk-ins — so walk-ins came back as credential holders. `coalesce(encrypted_password,'') <> ''` returns exactly **one** row in the whole database: the Playwright E2E organizer bot (60-char `$2a$`), which is also the sole `email` identity beside 21 `google`. The other 225 rows hold NULL (35) or `''` (190). The replacement claim was worse: it asserted walk-in passwords are machine-generated, when walk-ins have **no password at all** ([auth.ts:187](src/app/actions/auth.ts:187) calls `signInAnonymously`) and the 4-digit PIN they do hold is **user-chosen** ([login-form.tsx:451](src/components/login-form.tsx:451), [auth.ts:43](src/app/actions/auth.ts:43)) — `generatePin()` has one call site and it is the OAuth provisioning path. What actually needed correcting is **one word of the second clause**: *no* email+password credential exists → exactly one does, and it is a test fixture. (The first clause is loose too — 21 rows hold a `google` identity, 1 the `email` identity, 202 are anonymous, and the remaining **2 non-anonymous** rows carry no identity row at all — but "OAuth or anonymous+PIN" is what it means, and the conclusion it supports is sound. 🪤 **204** rows carry no `auth.identities` row, not 2: anonymous sign-in creates none. A draft of *this very parenthetical* wrote "2 have no identity row at all" — off by 202, and the **third** bad correction inside this one item, caught only because a review round re-ran the query instead of reading the sentence.) No human user of this app has a password, so the **decision** stands on both of its reasons. All four are the repo's recurring "justification prose rots while the code stays correct" failure mode — the fourth three times over, because each correction was written exactly the way the claim it corrected had been: from a plausible shape rather than the source line. **A correction inherits the burden of proof it is enforcing**, and a count inside a sentence about unmeasured counts is not exempt.

**Exactly one finding is closed as a decision rather than a fix:** #9 (`match_players` DELETE metadata) is **⚖️ ACCEPTED** — realtime bypasses RLS on DELETE by design, so no policy can fix it, and it is stamped that way rather than folded into the ✅ count. **A declined *clause* is a different category and must not be conflated with it:** two findings are **✅ FIXED with their third clause declined**, labelled so on both the heading and the §1 table row. #3's clause 3 (scope the passcode lookup to a club) — the passcode is the *only* credential a delegated co-organizer holds, so there is no club context to scope to; the leak it would have closed is handled by a uniform `INVALID` reply plus the lockout. #7's clause 3 (send only ids, not display names) — derived in §3.36: the join predicate guarantees every recipient can already read those names through `can_read_profile` arm 2, so it buys zero incremental disclosure while anonymising the co-organizer toast.

### 3.38 Two unbound write paths + eight unordered guards across seven sites — auditing the *shape* instead of the symptom (2026-08-13) — ✅ SHIPPED + DEPLOYED (PR #64 → `main` `8f4cb78`)

🪤 This heading read **"six unordered guards"** until the merge. It counted (c) + (d) — `closeSession` plus the five the class sweep found — and silently dropped **(a)**'s own reordering (`swapMatchPlayers`, guard 2 hoisted above guard 3), which was written up one section above it. The complete count is **eight instances across seven sites**: `clearOnDeckMatch`, `endMatchInternal`, `updateMatchDetails`, `cancelMatchAction`, `closeSession`, `swapPlayerInMatch`, `swapMatchPlayers` — seven functions, with `endMatchInternal` reached from two entry points (`endMatch` and `submitMatchScore`), which is the eighth. `TENANCY_AUDIT_2026-07-21.md` §2 #12 and the commit subject both carried the right number the whole time; **only the heading that summarised them was wrong**, which is how a count drifts — the summary is written from a subset and never re-derived from the list underneath it.

**Files:** [`src/app/actions/swap-player.ts`](src/app/actions/swap-player.ts), [`src/app/actions/matchmaking.ts`](src/app/actions/matchmaking.ts), [`src/app/actions/sessions.ts`](src/app/actions/sessions.ts), [`src/app/actions/match-lifecycle.ts`](src/app/actions/match-lifecycle.ts), [`src/app/actions/match-drafts.ts`](src/app/actions/match-drafts.ts), `tests/integration/manual-and-swap.test.ts` (M-14, M-14b, M-14c), `tests/integration/matchmaking.test.ts` (Test 8b), `tests/integration/close-session.test.ts` (Test 1b), `tests/integration/preauth-oracles.test.ts` (**new — Suite PA**, PA-1…PA-5), `tests/unit/matchmaking-engine.test.ts` (mock re-index). Recorded as audit finding **#12**. **TypeScript only — no migration.** *(The branch also carries `tests/integration/rls-edge-cases.test.ts` and the bulk of the `MEMORY.md` / `TENANCY_AUDIT_2026-07-21.md` changes — those belong to §3.36/§3.37, not to this finding. They ship in the same PR because the audit-closing pass was never committed separately.)*

**How they were found, which is the whole point.** §3.37 closed the tenancy audit. Closing it did *not* close the defect class it kept describing. Findings #4 (reads), #10 (live-swap writes) and #1 (`profile.ts`) are all the same bug — **authorize on A, operate on B**: gate with `isSessionOrganizer(user.id, sessionId)` on a client-supplied `sessionId`, then operate on a *separately* client-supplied row id that is never bound to it, through `createServiceClient()` so RLS cannot catch the miss. Each was found by chasing a symptom. This pass instead enumerated all **40** `isSessionOrganizer(` call sites, classified each `sessionId` as derived-from-the-row or supplied-by-the-caller, and read every supplied-id site. Two were unguarded. *(40 — `grep -rn "isSessionOrganizer(" src` returns 42 lines, minus the declaration at `_shared.ts:75` and a comment at `profile.ts:10`. The first draft of this paragraph said 41; a count inside a sentence about counting call sites is not allowed to be approximate.)*

**(a) `swapMatchPlayers` — the draft-path sibling the live-swap binding missed.** Migration `20260723000001` bound the four *live*-swap RPCs; the draft-path cross-match swap was bound nowhere. The RPC `swap_match_players(...)` takes **no session argument at all**, and reads each match's `session_id` back only to stamp `record_match_event` — never comparing the two, so the audit trail would faithfully record the victim's session while authorization happened against the attacker's. The TS layer had the information and dropped it: the existence guard already `SELECT`ed `id, status, session_id` for both matches and **discarded `session_id`**, which is exactly why the hole read as covered on every prior skim. New **guard 3b** rejects unless both matches carry `session_id === sessionId`, reusing the already-fetched rows (no extra round-trip), and guard 4's `match_players` lookup is narrowed to `.in("match_id", matchIds)`.

**The guard order changed too, and that is a second fix.** The organizer gate now runs **before** any match lookup. Guards that answer questions about a specific match id — does it exist, is it pending, is it yours — must sit behind authorization, or any authenticated caller who organizes nothing can use them as a probe. The original patch slotted the new binding in *above* the organizer gate, which would have turned it into a cross-tenant membership oracle; a review caught it. **A "wrong session" rejection reports `MATCH_STARTED` with the not-found wording**, never a distinct code, so it stays indistinguishable from "does not exist" — the precedent [`live-match-swap.ts:123-126`](src/app/actions/live-match-swap.ts:123) states outright. The detail is logged server-side instead, where it is useful and not disclosed. ⚠️ "Not-found wording" means the **API** response, not a screen: [`use-swap-state.ts:227`](src/hooks/use-swap-state.ts:227) branches on `errorCode` and renders its own hardcoded "Match has already started — swap cancelled." toast, discarding `message` entirely. The indistinguishability holds where it has to (a hand-crafted request), and the UI is more opaque still.

⚠️ **Sharing one `errorCode` is necessary but not sufficient — the guards also have to run in the right ORDER.** The final sequence is **3 (exists) → 3b (session) → 3c (pending)**, and a second review round is why. The first version of this fix left the existing status check ahead of the new binding, so a cross-session id whose match was **not** pending answered `"A match has already started — the swap was cancelled."` while a nonexistent id answered `"One or both matches could not be found."` — two responses, distinguishable, i.e. the existence oracle 3b exists to prevent, reinstated through the back door. Only ids already proven to be in `sessionId` may reach the status check; the distinct "already started" wording then discloses nothing the caller cannot see on their own board. This is precisely what [`live-match-swap.ts`](src/app/actions/live-match-swap.ts:127) does — session bound at `:127`, immediately after the organizer gate at `:120` and **before** any status read. Pinned by `M-14b`, which asserts on **`message`** (`errorCode` is `MATCH_STARTED` in every branch reachable from a foreign match id — guard 3b rejects before either `PLAYER_NOT_IN_MATCH` return — and so cannot detect the regression) and carries a positive control proving the two wordings really do differ. Proven by execution: reverting to `3c → 3b` makes `M-14b` the only failing test in the suite.

**(b) `callNextMatch` — an unbound `courtId`.** `(sessionId, courtId)` arrive as two independent client-supplied arguments and only the first was gated. `promoteOnDeckMatchInternal` stamps `matches.court_id = courtId` and flips that court to `in_use` with no session predicate. An organizer of session A could take another session's court out of service and leave their own match pointing at a foreign court. [`courts.ts:98`](src/app/actions/courts.ts:98) already guarded its own writes this way; this path was simply never given the same treatment.

Fixed with **two** court-ownership gates (`id = courtId AND session_id = sessionId`, reject on no row) plus `.eq("session_id", sessionId)` on the UPDATE:

1. [`matchmaking.ts:183`](src/app/actions/matchmaking.ts:183) — in `callNextMatch`, before it does anything else. (The statement start, so every cite of this gate in the repo — here, the audit, `matchmaking-engine.test.ts:1118` — lands on one number. 🪤 The `.from()` at `:184` was **not wrong**: `matchmaking.ts:817` cites the range `:183-192`, which contains it. Three files had simply each picked their own convention, and an earlier draft of this parenthetical called that a disagreement with the code. Inconsistency is worth fixing; do not upgrade it to an error to justify fixing it.)
2. [`matchmaking.ts:822`](src/app/actions/matchmaking.ts:822) — at the **top of `promoteOnDeckMatchInternal` itself**, before any lookup. `callNextMatch` invokes the helper twice (`:195`, then `:225` after the engine runs), so this gate is read once per attempt.

⚠️ **The second gate is the one that closes (b), and a review round shipped without it.** The first version had only gate 1 plus the UPDATE predicate, and described the predicate as what stopped the cross-session write. It cannot be: the CAS at [`:937`](src/app/actions/matchmaking.ts:937) commits the match row `in_progress` with `court_id = courtId` **before** the courts UPDATE at `:1001` runs. Without gate 2 a foreign court id would still land in `matches.court_id`, the caller would still receive `success: true`, and only the `courts.status` flip would have been blocked — the visible half stopped, the persistent half not. **A guard placed after the write it defends is not a guard**, and the natural place to put a `.eq()` is wherever the write already lives, which is exactly why this is worth writing down.

⚠️ **That trailing predicate is redundant but *not* vacuous, and the distinction is load-bearing.** All three **in-repo** callers pass a court that does belong to the session — `callNextMatch` now validates it, and `endMatch`/`cancelMatch` read `court_id` and `session_id` off the same `matches` row. ⚠️ **"Every caller" is not "every entry point."** `matchmaking.ts` is a `"use server"` module and `promoteOnDeckMatchInternal` (and `recomputeHeldReadiness`) are **exported**, so the build does mint each an action id via `registerServerReference`. Neither is **dispatchable**, though: their ids are absent from `.next/server/server-reference-manifest.json`'s `node` map — of this module's four exports only `callNextMatch` is in it — because no *client* component imports them (both are reached only from `match-lifecycle.ts`, server code). A hand-crafted POST dies at the `serverModuleMap[actionId]` lookup in `next/dist/server/app-render/action-handler.js:932-934`, **before any argument is deserialized**. ⚠️ That is a **build-derived** property, not a gate: it flips the first time a client component imports either helper, and neither has an auth check of its own. **Gate 2 above is the defence for that day** — a real ownership check inside the helper, not merely a predicate on one of its writes.
>
> 🪤 **This paragraph shipped false in two review rounds before it shipped true**, which is worth more than the finding itself. Round three added it claiming the helpers "fail closed only because argument 1 is a Supabase client instance that cannot be serialized" — confident, plausible, and wrong; the request never reaches argument binding. Round four caught it by *reading the built manifest* instead of reasoning about the signature. The mechanism named in a security comment has to be the mechanism that actually holds, or the comment is worse than none: the next reader deletes the client parameter, believes they have only done a tidy-up, and the "gate" that was never there stops being not-there in a new way. But `matches.court_id` is a **single-column** FK (`court_id uuid REFERENCES courts(id)`, `initial_schema:223`); there is no composite `(id, session_id)` constraint, so the invariant is code-maintained only — and a row written through the hole being closed here would violate it. The UPDATE therefore checks its rowcount and logs a 0-row result rather than swallowing it: silently no-opping would leave the match `in_progress` with `court_id` set while the court row stayed `available`, i.e. a board showing a free court under a live match, with `success: true` returned and nothing logged.

**(c) `closeSession` — the same ordering defect, in a file the sweep never opened.** 🔵 LOW, and worth recording precisely *because* it is not an unbound write. The organizer gate was present and did block the close; it just ran **below** the session fetch. So an authenticated caller holding a session UUID received three distinguishable replies — `"Session not found."`, `"Session is already closed."` **with `alreadyClosed: true`**, and `"Not authorized. Organizer access required."` — a session-UUID existence-and-status oracle across tenants, in an action whose own comment block reasons carefully about the gate's *presence* and says nothing about its *position*. Fixed by moving the gate above the session fetch — above *every* lookup keyed on `sessionId`. 🪤 The service client is still constructed **first**, deliberately, and this line said the opposite for two review rounds: `isSessionOrganizer` calls `createServiceClient()` itself, unguarded, so gating ahead of it would throw past this action's documented `{ success, message }` shape and leave the `try/catch` that exists for exactly that case unreachable — the reasoning is written out at [`sessions.ts:1048`](src/app/actions/sessions.ts:1048). It therefore does **not** match [`renotifySessionClosed`](src/app/actions/sessions.ts:1242), which gates at `:1253` and calls `createServiceClient()` at `:1260`. What the two share is gate-before-**lookup**, not gate-before-**client**; an earlier draft conflated them and named the sibling as proof of the very thing it disproves. **A doc that describes a rejected alternative as the shipped fix is worse than no doc — the next reader closes the gap by reintroducing the bug.** The now-unused `created_by` was dropped from the `SELECT`; 🪤 its comment claimed it was fetched *"for the organizer check below"*, which was false at HEAD — `isSessionOrganizer` does its own lookup and never received it.

⚠️ **Three things about (c) generalise, and they are the reason it is in this section rather than filed as a nit.**

1. **The rule was already written down in this very file, and not applied here.** The comment above [`applyDraftCapOverride`](src/app/actions/sessions.ts:598)'s `Promise.all` says it verbatim: `isSessionOrganizer` returns false for both "not yours" and "does not exist", *so a distinct message would turn this into a session-UUID existence oracle*. `renotifySessionClosed` obeys it. `closeSession` — older, and the one that actually destroys state — did not. **A convention recorded in a comment is not a convention enforced.**
2. **The shape audit that found (a) and (b) structurally could not find (c).** It asks, per call site, *which id does the write use?* Ordering is invisible to that question, so all seven `sessions.ts` call sites passed it — correctly, on their own terms. **Unbound writes and unordered guards are two different sweeps**, and finishing the first says nothing about the second.
3. 🪤 **The review gate found it two days before this branch, and the finding was filed instead of fixed.** An earlier draft of this list credited "the branch's own review agent", which reads as a win for the gate; it is the opposite. `git log -S` places the sentence *"`closeSession` returns `alreadyClosed` **before** the organizer check (pre-existing; leaks one bit)"* in commit `6592864` (**2026-08-11**, PR #55), and it is still sitting under the heading **"Booked minors (review-agent 'Minor issues' pass, per CLAUDE.md gate rule 3)"** — `MEMORY.md:1147` as measured at the merge base `c9f2337`. 🪤 That cite is pinned to a commit, not to "HEAD", because **this very commit moves it** — and the first attempt to fix this sentence named the new line number, which its own two added lines then invalidated before the edit finished. Cite the heading (stable) plus the revision the number was read at; a line cite into a file the same change is editing is false on arrival. The gate ran, the agent saw it, the verdict was recorded — and nothing happened for two days. **The gate did not fail; the follow-through did.** CLAUDE.md gate rule 3 permits a "Minor issues" pass *provided the issues are documented in `MEMORY.md`*; that clause buys a **deferral, not a closure**, and a deferral carrying no owner and no trigger is indistinguishable from a drop. **A booked minor with no owner is not a disposition.** The entry has been stamped in place rather than deleted — it is the evidence.

**(d) Five more pre-authorization oracles — sweeping the CLASS instead of shipping (c) alone.** 🔵 LOW each. (c) was on the verge of being written up as *"the same ordering defect, in a file the sweep never opened"* — a sentence that concedes the sweep was scoped to a symptom, which is the exact failure §3.38 exists to document. So the class got its own sweep: every action file scanned for a **service-client row fetch whose failure branch returns above the authorization gate**. Five real sites; no sixth. Three near-misses were eliminated by reading rather than by grep — [`sessions.ts:380-388`](src/app/actions/sessions.ts:380) belongs to `joinAsCoOrganizer`, where the caller is *supposed* to be a stranger (the passcode lookup's failure branch returns `INVALID` above every gate, which is the sweep's shape exactly, and is deliberately kept); `publishMatchAction` reads through `createServerSupabaseClient()`, so RLS **is** the backstop; [`fix-player-record.ts:77`](src/app/actions/fix-player-record.ts:77) is pure input validation over the caller's own arguments.

| Site | File | What any authenticated caller could read off the reply |
| --- | --- | --- |
| `endMatchInternal` | `match-lifecycle.ts` | `"Match not found."` — **and** `Match is already ${status}.`, because the status check also sat above the gate |
| `updateMatchDetails` | `match-lifecycle.ts` | `"Match not found."` |
| `cancelMatchAction` | `match-lifecycle.ts` | `"Match not found."` |
| `clearOnDeckMatch` | `match-drafts.ts` | `` `Match not found: ${raw PostgREST error text}` `` |
| `swapPlayerInMatch` | `swap-player.ts` | a **three-way** split: not-found / already-started / not-authorized |

All five read through `createServiceClient()`, so RLS is no backstop and the probe answers for **any match UUID in any club**. The fix is one shape in **four** of the five: collapse missing-row and not-authorized into **one condition and one return** — `if (!match || !(await isSessionOrganizer(user.id, match.session_id)))` — move every status check below the gate, and `console.error` the PostgREST text server-side instead of returning it. The model was already in the repo at [`live-match-swap.ts:453-460`](src/app/actions/live-match-swap.ts:453), which answers a bare `{ success: false }` to both.

⚖️ **Accepted cost, stated so it is not rediscovered as a bug.** Collapsing missing-row and not-authorized into one condition means a *transient* fetch failure — a PostgREST blip, a dropped connection — now also answers `"Not authorized. Organizer access required."`, to a legitimate organizer. That is the price of the guarantee: any reply that distinguishes "the fetch failed" from "the row is not yours" is the oracle again, since an attacker chooses when to probe and a defender cannot. The real cause is not lost — it is `console.error`-ed server-side with the PostgREST text. If this ever needs softening, the only safe direction is a *retry*, never a distinguishable message.

`endMatchInternal` is the deliberate exception, and why the shape does not fit there is worth knowing. It is reached two ways, and one of them — `submitMatchScore` — has *already* proved the caller is a player in this match, so that caller already knows the row existed; `"Match not found."` discloses nothing to them and is the genuinely useful answer. Its missing-row branch therefore stays separate and reads `participantVerified ? { message: "Match not found." } : DENIED`. The anti-drift property is bought a different way there: a single shared `DENIED` object that **every** pre-authorization rejection in the function returns, so there is no second copy of the string to drift.

**The stated rule, so the next reader does not have to re-derive it:** a missing row carries no `session_id` and therefore **cannot be authorized at all**, so "no such row" and "not your row" *must* answer identically — otherwise the difference between them **is** the answer. Writing it as one condition and one return is deliberate: two adjacent `if` blocks returning the same string are one careless edit away from drifting apart, and nothing would fail.

⚠️ **Four things here are worth more than the five fixes.**

1. 🪤 **`swapPlayerInMatch` broke a rule written down 92 lines above it, in its own file.** [`swap-player.ts:62-67`](src/app/actions/swap-player.ts:62) records exactly this rule for the sibling `swapMatchPlayers`; the guard site that violated it is at [`:159`](src/app/actions/swap-player.ts:159) — which now holds the fix, not the defect. This is (c)'s point 1 recurring inside the same file in the same pass: **a rule written down in a file is not a rule applied in that file.**
2. 🪤 **`updateMatchDetails` carried a careful, correct, and entirely irrelevant ordering argument.** Its header reasons at length about score-validation-vs-gate ordering — and therefore *reads* as a clean bill of health for the function, while the match fetch above the gate leaked to every caller. **Reasoning carefully about a guard's PRESENCE says nothing about its POSITION.** The paragraph is kept and annotated with a ⚠️ saying so, not deleted: a load-bearing justification that turned out to be scoped too narrowly is more useful annotated than removed.
3. 🪤 **The user-visible message is not the contract — find the second channel before rewording anything.** Unifying the swap replies was only safe because [`use-swap-state.ts:175`](src/hooks/use-swap-state.ts:175)/`:227`/`:280` and [`swap-sheet.tsx:220`](src/components/organizer/swap-sheet.tsx:220) branch on `result.errorCode === "MATCH_STARTED"`, which is preserved verbatim. Every consumer of all four changed strings was grepped first. **No test asserted any of them** — which is itself the finding: five state-revealing replies that nothing pinned.
4. 🪤 **Two of the four merged sites shipped as two adjacent `if`s anyway — in the same change that states the rule.** `cancelMatchAction` and `clearOnDeckMatch` were first written with the missing-row check and the organizer check as separate blocks returning the *same literal string*: precisely the two-copies-one-edit-apart configuration the paragraph above argues against, sitting in the diff that argues against it. The branch's own review gate caught it, not the author. **Writing a rule into the write-up is not applying it in the diff** — grep the diff for the literal and count the `return`s.

✅ **Pinned by the new Suite PA** — [`tests/integration/preauth-oracles.test.ts`](tests/integration/preauth-oracles.test.ts), five tests, one per site. Each probes the three inputs that actually separate the two orderings — a **foreign** match, a **state-revealing** match, and a syntactically valid but **nonexistent** UUID — plus a cross-tenant caller who genuinely organizes a *different* session, plus a positive control proving the true organizer still receives the distinguishing reply. 🪤 The mocked identity is a single module-level global (`authState.currentUserId` in `helpers/mock-auth.ts`), so the probes must run **sequentially**; the first draft batched them through `Promise.all`, which interleaves the writes and quietly runs every in-flight probe as whichever caller set the global last — the suite would then have passed because all four probes were the same caller and trivially agreed.

🪤 **A negative assertion is worth nothing unless the thing it forbids could otherwise have happened — and `PA-2`'s was vacuous twice, for two different reasons.** `PA-2` reads the row back after the strangers' rejected edits to prove nothing landed. Draft 1 had *every* caller send the same 21-15, and put the read-back **after** the owner's own successful 21-15 — so it could not tell "the stranger was rejected" from "the owner overwrote what the stranger wrote"; the review gate caught that. Draft 2 moved the read-back above the positive control and gave the strangers 99-0 — but 99 exceeds `MAX_BADMINTON_SCORE`, so `scoreSchema` would have refused that write **with no gate at all**, and the assertion still could not fail. The shipped version uses three distinct *valid* pairs (seed 21-15, strangers 25-23, owner 30-28) and was **proven falsifiable by perturbation**: weaken the gate, relax only the message assertions, and the read-back reports `expected 25 to be 21`. The out-of-bounds probe was kept as its own assertion, where it pins something real — that score validation still runs *below* the gate, so a stranger gets `DENIED` and not `Score cannot exceed 31.` (perturbing the gate makes that line report exactly that). **Ask of every "and it did not happen" assertion: what, mechanically, would have had to happen for this line to fail?**

**Why the RPC was left alone, deliberately.** `swap_match_players` is **service_role-only** — re-measured on prod 2026-08-13, `EXECUTE` is `false` for both `anon` and `authenticated` (#10's revokes covered it), so the server action is the entire boundary and a TS-layer fix is complete for the real attack surface. A body-only `CREATE OR REPLACE` adding `v_session_a IS DISTINCT FROM v_session_b` would be **strictly weaker than guard 3b** — it would not catch two matches that both belong to the victim. Adding `p_session_id` would need `DROP` + re-`GRANT` (#10's trap: that strips `service_role`) and a hand-apply on prod. ⚠️ **This reasoning expires if that grant ever changes.**

**Every guard here was proven by execution, not inspection.** For each: back up the file, patch the guard out (or reorder it), re-run the regression test, observe the cross-tenant operation **actually succeed**, then restore and confirm no marker survived.

| Pin | File | Perturbation | Result |
| --- | --- | --- | --- |
| `M-14` | `manual-and-swap` | guard 3b deleted | cross-session swap succeeded |
| `M-14b` | `manual-and-swap` | 3c moved above 3b | only M-14b failed |
| `M-14c` | `manual-and-swap` | guard 2 moved below guard 3 | **only M-14c failed — M-14 and M-14b stayed green** |
| `Test 8b` | `matchmaking` | court gate deleted | cross-session court seizure succeeded |
| `Test 1b` | `close-session` | organizer gate moved below the session fetch | **only Test 1b failed — the file's other 7 tests stayed green** |
| `PA-1` | `preauth-oracles` | status check hoisted above the organizer-OR-player gate | failed on the **status** leak, not on the missing row |
| `PA-2` | `preauth-oracles` | merged condition split back into two returns | failed |
| `PA-3` | `preauth-oracles` | missing-row branch restored to `"Match not found."` | failed |
| `PA-4` | `preauth-oracles` | missing-row branch restored to `` `Match not found: ${err}` `` | failed |
| `PA-5` | `preauth-oracles` | three-way oracle restored in full | failed |

The five `PA-*` perturbations were applied **together and from a script** (`perturb.py`, exact-string replacement that asserts each pattern occurs exactly once, so a silently-missed edit cannot masquerade as a passing guard), and the **whole integration suite** was re-run against the perturbed tree — `Test Files 1 failed | 24 passed`, `Tests 5 failed | 278 passed`, the five failures being exactly `PA-1`…`PA-5`. The three source files were then restored **from a pre-perturbation copy and re-hashed byte-for-byte** — `shasum -a 256 -c` equality, not "looks right" — and the suite re-run green. 🪤 This repo has already been bitten by a review agent leaving unreverted worktree mutations behind; a perturbation run is self-inflicted mutation of exactly that kind, and deserves the same proof of restoration.

⚠️ **The M-14c and Test 1b rows are the ones worth reading.** M-14 and M-14b are both driven by an *organizer*, so they can only pin ordering among guards 3/3b/3c. Moving the organizer gate itself back below the existence check reopens the same oracle one guard earlier — and for *any authenticated user*, not just an organizer of something — and neither existing pin could see it. **A guard-ordering test written from one seat is blind to holes that open in a lower seat.**

⚠️ **Test 1b makes the sharper version of that point.** `close-session.test.ts` already contained a test named `"rejects non-organizer callers"` — and it stayed green through the perturbation that reopened the oracle, because it only ever probes an existing **active** session, the single input on which both orderings answer identically. **A test that asserts a guard rejects is not a test that the guard rejects *first*.** There are **eight** ordering pins here — `M-14b`, `M-14c`, `Test 1b`, `PA-1`…`PA-5`; `M-14` and `Test 8b` are *binding* pins, not ordering ones — and every one was proven by a perturbation that left every pre-existing authorization test in its file green. Test 8b, M-14b, M-14c, Test 1b and all five `PA-*` each also assert a positive control, so none can pass by rejecting everything.

⚠️ **The five (d) sites turn that observation from an anecdote into a rule, and the measurement is blunter than the anecdote was.** All five pre-fix orderings were restored **simultaneously** and the **entire** integration suite re-run: **24 files / 278 tests green, only the five `PA-*` red.** Not one pre-existing test in the repo could see five authorization gates reordered at once.

🪤 **The first draft of this paragraph said "every one of those five already had a *rejects non-organizer* test — six for six." Measured, it is four of six.** `updateMatchDetails` (`N-3`), `clearOnDeckMatch` (`N-8`), `cancelMatchAction` (`G-3b` + `F-cancel-3`) and `closeSession` (`"rejects non-organizer callers"`) each had one, and all four stayed green — the same blindness, four times, for the same structural reason: they probe only an existing row in the expected status, the one input on which both orderings agree. The other two had none at all: `endMatchAction`'s sole authorization test is *unauthenticated* (`score-submission.test.ts:220`; the `submitMatchScore` "not a player in this match" test returns at `match-lifecycle.ts:83`, before `endMatchInternal` is reached), and `swapPlayerInMatch` has no authorization test whatsoever — `M-8`/`M-9`/`M-10` are organizer-driven *state* guards. That is worse than the tidy claim, not better: two of the five leaks sat under actions with no authorization coverage there to be blind. **A count asserted inside a lesson about unverified counts is not exempt from being counted.** The generalisation survives intact and is now load-bearing: **an authorization test that does not probe a nonexistent id and a state-revealing id is not testing the ordering**, and its greenness is no evidence about the ordering at all.

🪤 **`tests/unit/matchmaking-engine.test.ts` uses positional mocks** — `makeMockClient([...])` answers the *N*th `from()` call with the *N*th entry, defaulting to `{data: null, error: null}` once the list runs out. Each court gate inserts a slot and shifts every index below it. **A `null` at a gate's slot is a REJECTION, not a neutral no-op**, so a mis-indexed mock makes the action return early and every downstream assertion pass vacuously. Final tally: **12** direct-`promoteOnDeckMatchInternal` fixtures took a `[0] courts` slot, **8** `callNextMatch` fixtures took a `[3] courts` slot for gate 2, **4** of those also needed a *second* gate-2 row for the `:225` retry, and **6** `queriedTables` equality assertions gained a leading `"courts"`. The one `callNextMatch` test that needs no court slot at all asserts the post-close guard fires with `queriedTables === ["sessions","session_organizers"]`.

🪤 **Two of those fixtures were passing for the wrong reason, and the reason generalises.** `if (!ownedCourt)` accepts anything truthy, so a stray `{ data: [] }` sitting at a gate's slot *satisfies* the gate — the test goes green while every slot beneath it is off by one. Both were found by **dumping** `serviceMock.queriedTables` at runtime and diffing it against the fixture labels, not by reading. Truthiness is not correctness, and **a green test is not evidence that a positional fixture is aligned**.

🪤 **The slot-layout header above those tests has now been wrong three times, each time by renumbering instead of re-deriving.** The version at HEAD was already stale by neglect (it omitted `session_organizers` and the left-guard's `queue_entries`, and put the CAS before `match_players`); the first pass at this change shifted it `+1` and shipped a *newly* wrong list; and adding gate 2 invalidated every line cite in it a third time, because inserting the gate at `:823` moves every `.from(` below it. It is now re-read off `matchmaking.ts` with a line cite per slot, plus an explicit note that **a cite into a file the same commit edits invalidates itself**. Mechanically renumbering a comment is not maintaining it.

🪤🪤 **And then this same change did exactly that again, 550 lines below the paragraph you just read.** `ENG-SNAP-1`'s eight fixture labels were bumped `+2` — `[0][1][2]` followed by `[5][6][7][8][9]`, with `[8]` and `[9]` past the end of an eight-element array — while **no entry was inserted**. They were *correct at HEAD*; this branch made them false. Causally impossible on inspection, too: `ENG-SNAP-1` drives `runEngineForSession`, which has no court gate, so nothing in it could have shifted. The suite could not catch it (labels are comments — all 61 tests pass either way) and neither could three rounds of careful reading; the review agent caught it.

✅ **The durable fix is to stop treating this as a reading problem** — the invariant is mechanical, so verify it mechanically. **When a convention is mechanical, verify it mechanically**, and when a file has drifted three times by the same mechanism, the fourth defence should not be another careful read.

🪤 **But the first two attempts at mechanising it were themselves wrong, and that is the more useful half.** The invariant is **not** "label *k* = array index *k*". `makeMockClient([...])` answers the *N*th `from()` call with the *N*th **runtime slot**, and a spread advances that counter by its own length — `...preamble(x)` occupies **10** slots, `...PULLABLE` **7**. Index and slot coincide only in arrays containing no spread, which is precisely why the wrong invariant still produced plausible-looking totals. Two parser bugs rode along: the labels are **trailing** comments (they sit *after* the comma), so a naive comma-splitter attributes each label to the **following** element; and a comment after the final comma is a **phantom element** that inflates the measured length (`preamble` measured 11, `PULLABLE` 8).

✅ **Corrected auditor** — tracks runtime slots, resolves spread widths, and understands `// [11..17]` range labels. Across the **two** files that call `makeMockClient`: `matchmaking-engine.test.ts` reports **HEAD 49 arrays / 197 labeled slots / 0 mislabeled** and **working tree 50 arrays / 244 labeled slots / 0 mislabeled**; `queue-actions.test.ts` reports **9 arrays / 0 labels**, so it has nothing to verify. (The tree reads 0 rather than 5 because the five `ENG-SNAP-1` labels had already been fixed by hand before this run.)

🪤 **A resolver that silently assumes a width is the same bug one level up.** Six names are spread into arrays in the engine file and **four cannot be measured reliably** — `cappedPool` is declared **twice** (L635 and L839), so a by-name lookup picks an arbitrary one, and `padding`/`readyRoster`/`waitingFour` are arrow bodies whose first `[` need not be the returned array (`waitingFour` measures as **0**, certainly wrong). Those four turn out not to be load-bearing — and that was **checked, not assumed**: a direct scan confirms **zero labeled arrays contain any of the four**, at HEAD and in the working tree. Only `PULLABLE` and `preamble` appear inside labeled arrays, and each is declared exactly once. The auditor now prints `UNRESOLVED` for an unmeasurable spread rather than defaulting it to one slot, which is the mistake its own first version made.

**The new 0-row branch got its own test, because otherwise it had none.** Every pre-existing courts-update mock returns `{ data: null, error: null }` with no `count`, so `courtCount` is `undefined` and the `courtCount === 0` arm was unreachable from the suite — a branch added by this change that nothing exercised. `"a 0-row courts update is logged, not swallowed, and does not fail the promotion"` pins all three halves of the decision: the action still returns `success: true` with its `matchId` (the CAS above has already committed, so failing here would promote a match and report nothing), and `console.error` carries the court and session ids. Proven non-vacuous the same way as the guards themselves — with `courtCount === 0` patched out of the condition the test fails on the `console.error` assertion, and it passes again on restore.

🪤 **Round 4 of the review gate found two more rotted cites — and fixing them rotted a third set, inside the same round.** This section documents a defect class; the section itself kept producing instances of it.

1. **A cite that pointed at the `if`, not the `return`.** The `submitMatchScore` "not a player in this match" cite read `match-lifecycle.ts:82` — which is `if (!mySlot) {`; the return is `:83`. It sits inside the paragraph that says *a count asserted inside a lesson about unverified counts is not exempt from being counted*, and the return-not-the-`if` rule is stated in so many words at [`swap-player.ts:84`](src/app/actions/swap-player.ts:84). **Proximity to the rule predicts nothing.**
2. **A near-miss elimination whose reasoning was right and whose evidence pointed at the wrong line.** The (d) sweep is defined as *a service-client row fetch whose failure branch returns above the authorization gate*. The anchor given for the `joinAsCoOrganizer` near-miss, `sessions.ts:418`, is the `session_organizers` **INSERT**-failure branch — neither a fetch nor pre-authorization, so it could not have been a near-miss for this sweep at all. The line in that function that *does* have the sweep's shape is the passcode lookup at [`:380-385`](src/app/actions/sessions.ts:380), returning `INVALID` at `:388`, and it is deliberately kept: the caller there is *supposed* to be a stranger. The elimination stands; only its evidence was wrong. **An anchor is a claim, and it is checked separately from the sentence it anchors** — a correct conclusion resting on the wrong line reads as verified and is not.
3. **Fixing the file header re-staled the four `swapMatchPlayers` return cites a FOURTH time** — the exact failure `swap-player.ts:84` predicts, this time caused by a correction. The header read "three pre-write guards" over a list of four **and never mentioned guard 1b at all**, which this very branch had added: *adding a guard without recounting the header is how a stale count became a wrong one.* Correcting it moved every line below, so `:319/:326/:334/:440` became `:333/:340/:348/:454`, `:145` became `:159`, `54-59` became `62-67`, "86 lines" became 92, and `M-14b`'s `:406/:434` became `:420/:448`. **The order is: make every edit to the file, THEN read the numbers, THEN write them down — and "every edit" includes the one you are making to fix a different comment.**

Two smaller inaccuracies from the same round, both introduced by this branch and both now fixed: `SwapErrorCode`'s inline comment described `MATCH_STARTED` as only `match.status !== "pending"` after guard 1b started returning it for missing/unauthorized as well (its sibling comment on `SwapMatchPlayersErrorCode` *was* widened — **one of two parallel comments updated is a comment that now disagrees with itself**), and the errorCode-less-return list said "every errorCode-less return" when the success return is errorCode-less too (harmless — `if (result.success)` at `use-swap-state.ts:214` takes it first — but the sentence was wider than the fact).

🪤 **Round 8: not a false claim written, but a *true rule invalidated* by an edit elsewhere.** Round 7 unified two line cites onto the statement-start line (`:183`/`:822`) across three files. Sixteen lines below one of them, the 🪤 at [`matchmaking-engine.test.ts:1135`](tests/unit/matchmaking-engine.test.ts:1135) still said *"every cite above is the line of the `.from(` call itself"* and prescribed a `grep` that now returns `:184`/`:823` — so the block instructed the next reader to "correct" four cites that were right, in three files, **inside the very change that had standardised them**; and it contradicted itself in passing (`:822` in the slot list, `:823` in its own note). **Changing a convention means grepping for the RULE that describes it, not only for the cites that follow it.** A convention has two kinds of dependant: the cites — greppable, because they *are* the number you changed — and the prose that defines them, which that grep cannot see and which is the more damaging of the two, because prose reaches the next reader as an *instruction*. Two rules fall out: when a rule has an exception, **put the exception in the rule** (a rule stated without it is a trap a diligent reader springs), and anchor such prose to **document sections, not line numbers**.

🪤 **Round 7: the round-6 fix wrote a fresh instance of the class it was fixing.** Round 6 removed the conjunction *"and the same order `closeSession` uses"* — which welds two independent axes, gate-before-**lookup** and gate-before-**client**, into one claim — from three documents. The correction, written in that same edit, put the identical conjunction into a **fourth** location, in code, at [`swap-player.ts:158`](src/app/actions/swap-player.ts:158), where it is false for a *different* reason: `swapPlayerInMatch` **cannot** gate before its lookup, because the gate's argument is `match.session_id` and the row is what supplies it. **Fixing every flagged instance of a class is not fixing the class.** Grep for the *phrase* afterwards, and re-read your own replacement text as if a reviewer wrote it — a correction is not exempt from the rule it is enforcing. Corollary for cites: **a precision rule applied at one site must be swept to its siblings.** Correcting `:1258` (a `let supabase: ReturnType<…>` declaration) to `:1260` (the actual `createServiceClient()` call) left the identical slip live at `:1055` vs `:1057` for the sibling function named in the same paragraph.

🪤 **Round 5: the note warning that line numbers rot carried two rotted numbers of its own.** The 🪤 at [`swap-player.ts:84`](src/app/actions/swap-player.ts:84) reconstructs the history of its own cites so the next reader can see the pattern. It said they had been "11 too low", then "10 too low". The real shifts were **+15** and **+14** — and neither figure had ever been checked against anything; both were re-typed from memory *inside the paragraph that forbids exactly that*. They are now re-derived and, more importantly, **corroborated against a second, independent record**: `M-14b`'s own 🪤 in `manual-and-swap.test.ts` — together with the cite it annotates, which carries the current pair — tracks a *different* pair of lines in the same file through the same two edits (`:391/:419` → `:406/:434` → `:420/:448`), giving +15 and +14. 🪤 Be precise about what kind of corroboration that is: **both records are new on this same branch**, so this is two independent derivations agreeing, not an older source vouching for a newer one. It is real evidence and it is not a provenance claim; an earlier draft of this very sentence called it *"written down at the time by a different hand"*, which is neither. **A delta with no second witness does not belong in a comment at all** — not the count, not the direction, not the magnitude. A retrospective figure is a measurement, and a measurement you cannot point at is a guess wearing a number.

The same round caught a scope error in the neighbouring sentence: "every errorCode-less FAILURE return … all four of them" reads file-wide, and is only true of `swapMatchPlayers`. `swapPlayerInMatch` has three more, which are harmless because they never reach that `else` — they land on `swap-sheet.tsx:234` (`setInlineError`) and on `handleUndoSwap`'s hardcoded toast at `use-swap-state.ts:282-283`, which drops `message` entirely. The claim is now scoped to the function it is true of and the other consumers are named. **A sentence wider than the fact it rests on is wrong even when nothing it protects is broken** — the next reader inherits the width, not the fact.

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
| `--cc-fresh`       | `oklch(0.52 0.15 150)`        | `oklch(0.78 0.16 150)`        | "No shared history yet" chip  |
| `--cc-fresh-dim`   | `oklch(0.52 0.15 150 / 0.12)` | `oklch(0.78 0.16 150 / 0.14)` | Its tinted background         |
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
`disabled:opacity-50 disabled:cursor-not-allowed` on every interactive element. One deliberate exception — **now unreachable in practice, see §3.39**: no caller passes `onLeaveQueue` to `MatchAlert` any more, so the control it gated no longer renders; the pattern is retained here because it is the house rule for any future time-sensitive control. MatchAlert's Leave Queue button uses `aria-disabled` + a click guard instead of `disabled` — a truly disabled control drops out of the focus order, so the "Leaving…" label change would never be announced; `aria-disabled` keeps focus on it while `aria-live="polite"` reads the change (visual opacity/cursor classes applied conditionally).

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
| `matchmaking-core.test.ts`      | `computePriorityScore`, `scoreCandidates`, `buildCombinationGroup`, `snakeDraft`, `rotatedDraft`, `isDiversityViolation`, `countConsecutiveOpponentRepeats` — regression suite (173) |
| `matchmaking-engine.test.ts`    | Full engine flow integration (mocked DB), anti-repeat, Red Zone, partner cap, **CC-REACH cross-court reachability**                          |
| `cross-court-trigger.test.ts`   | **The decision to reach across courts** — `hasFeedableCapacity` (incl. stacking), `wantsFresherFour`/`pullImprovesFreshness`, `anchorBlocksReach` (CCT-ANCH, both sides of the boundary), `buildCrossCourtProposal` (incl. the deadlock and the outer-lookback regression) |
| `early-diversity.test.ts`       | Early-session diversity (ED-SC / ED-OPP / ED-RN) — `scoreCandidates` fresh-first `GAMES_AHEAD_PENALTY`, opponent-vs-teammate overlap weighting (`OVERLAP_WEIGHT_OPPONENT` / `_TEAMMATE`), `deriveReuseNotice` equity thresholds |
| `session-notifications.test.ts` | Pure copy/selector logic for the organizer notice centre (§3.43): leave vs checkout copy, pending-correction unread, catch-up non-interrupt, unique-insert no-broadcast, centre cap. **No DB — the real-DB contract of the same-named integration file is a separate suite (SN-1…SN-12)** |
| `session-simulation.test.ts`    | Multi-round session simulations — 30-player load, diversity saturation                                                                      |
| `queue-actions.test.ts`         | Queue join/leave/rejoin guards, ghost re-queue prevention                                                                                   |
| `match-origin-tracking.test.ts` | `origin` enum transitions — `auto` → `modified`, stickiness of `manual`                                                                     |
| `migration-test-coverage.test.ts` | **Suite MTC — the tripwire for zero coverage** (§3.44). Static analysis over `supabase/migrations/**` and `tests/**`: every table, view and function a migration creates must be *named* by at least one non-comment test line (MTC-1); the exemption lists may only shrink (MTC-2); the extractor and the comment stripper are themselves discriminated (MTC-3). Asserts mention, never behaviour — index and trigger names are deliberately out of scope |

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
| `cross-court-realdb.test.ts`| XC   | **The cross-court reach, end-to-end against a real DB** (§3.1): `endMatchAction` → `runEngineForSession` commits a HELD draft (XC-1); the hold-age cancel releases the 3 waiters without unseating the still-playing body (XC-2); a fresh hold survives the same event (XC-3); **and a held draft rests, ripens on its own and actually publishes** (XC-4) — the lifecycle half that §3.41 shipped dead, generation-only, for four days |
| `cross-session-ledger.test.ts`| XS | **The rivalry/partnership ledgers rebuild, they do not accumulate**: re-running the refresh for an older session leaves every semantic column unchanged, even once the guard has decayed (XS-1); a session that was never closed is folded in by the next close (XS-2); hidden sessions never reach the ledgers (XS-3); a row no match backs is pruned (XS-4). XS-1/2/4 fail against the pre-`20260812100000` function |
| `draft-cap-override.test.ts`| DCINT| `applyDraftCapOverride` persistence, reset-to-Dynamic → NULL, `clear_all_unpublished_drafts` re-queue                            |
| `drafted-status.test.ts`   | —     | Drafted queue status transitions                                                                                                 |
| `engine-trigger-realdb.test.ts`| ET | Which lifecycle events actually run the engine against a real DB                                                                 |
| `health.test.ts`           | —     | Integration harness smoke test (env, service client, truncation)                                                                 |
| `live-match-swap.test.ts`  | LMS   | `swap_player_in_active_match`: replace + queue update, and its rejection guards                                                  |
| `manual-and-swap.test.ts`  | M     | `createManualMatchAction` origin/auth/rejection; swap origin sticky rules (`auto→modified→manual`)                              |
| `match-update.test.ts`     | —     | Score edit and match revert flows                                                                                                |
| `matchmaking.test.ts`      | —     | Engine integration against real DB                                                                                               |
| `performance.test.ts`      | —     | Engine timing benchmarks                                                                                                        |
| `player-checkout.test.ts`  | Q     | `checkoutPlayer`: happy path, unauthenticated rejection, UUID validation, **checkout while on_deck/playing is REFUSED** (Q-4/Q-5, §3.39 — these assert a rejection, not a success), draft cleanup, idempotency |
| `player-pause.test.ts`     | P     | `togglePlayerPause`: pause/unpause, `games_played`+`joined_at` invariant, non-organizer rejection, UUID validation              |
| `organizer-alerts.test.ts` | OA    | Pause-bucket math, badge copy, center-alert enqueue/dismiss (§3.42)                                                              |
| `session-notifications.test.ts` | SN | **Real-DB, and distinct from the same-named unit file in the Unit table above** (§3.43). Organizer-only list, and anon refused (SN-1); a seated player's request lands a row (SN-2); the partial unique holds one pending per match *and releases on resolve* (SN-3); a player never in the match is refused (SN-4); resolve rewrites the score and stamps the notice (SN-5); resolving twice reports `alreadyResolved` and does **not** rewrite again (SN-6); a foreign organizer cannot resolve (SN-7); RLS shows a player only their own rows (SN-8); **`authenticated` holds no INSERT — the park-a-pending-row DoS the migration comment describes is refused by the GRANT, not by app code** (SN-9); resolve refuses once the match is no longer completed (SN-10); the pause-bucket unique collapses repeat reminders (SN-11); **SN-12 pins the RPC's own lock** — `resolve_score_correction` is `SECURITY DEFINER` with `EXECUTE` revoked from `anon`/`authenticated`, which is what stops a signed-in player rewriting a score directly and skipping SN-7's organizer gate. No TypeScript is involved in that refusal |
| `queue-status-audit.test.ts` | QSA  | **The two objects that answer "why can't I see this player in Match Control?"** (§3.44) — the view decides who is visible *now*, the audit says who changed it *afterwards*. `checkoutPlayer` and a direct service-client write both log (QSA-1/2); a same-value or non-status write logs nothing (QSA-3); **the best-effort promise is self-injected** — a forced constraint failure leaves the checkout succeeding and the trail empty (QSA-4); `actor_uid` is the JWT `sub`, NULL for service-role (QSA-5); a full `waiting→…→left` life leaves a *contiguous* trail (QSA-6); anon/authenticated cannot read it, and RLS still refuses even when the GRANT is handed to them mid-transaction (QSA-7); the view's visibility set and `status_priority` (QSA-8); `security_invoker` keeps it shut despite anon's blanket view grant (QSA-9); **service_role has SELECT+DELETE but NOT INSERT/UPDATE/TRUNCATE, so no API caller can forge a transition** (QSA-10); the trigger function is `SECURITY DEFINER` with a pinned `search_path`, which is why the trail kept filling while nothing could read it (QSA-11). Eight measured mutants, one discriminator table in the header — including **M19, which caught a real bug in the migration this suite was written to pin** (see §3.44 A) |
| `publish-match.test.ts`    | —     | `publishMatchAction` BUG-001 (ON_DECK_WARNING timing) and BUG-002 (stale-player guard)                                          |
| `queue-join.test.ts`       | —     | `joinQueueAction` inherited-games floor, re-join paths                                                                          |
| `realtime-broadcast-rls.test.ts`| RB | **The broadcast topic's RLS actually refuses outsiders** (§3.35): a plain member and the organizer may read (RB-1/2); a stranger, a member of a *different* club, a deactivated member, an `anon` caller and a malformed topic are all refused (RB-3…7); nobody may INSERT, not even the organizer (RB-8). Every one is killed by at least one mutated policy — table in the file header |
| `rls-edge-cases.test.ts`   | E     | Cross-session auth isolation, unauthenticated access blocks                                                                     |
| `rpc-behaviors.test.ts`    | —     | `create_match_with_players` TOCTOU guards, NULL return contract                                                                 |
| `schema-parity.test.ts`    | G     | DB schema matches `src/types/database.ts`; the function-`EXECUTE` invariants described below; and **a whole-schema sweep that every relation in `public` is SELECT-able by `service_role`** — the gate that was missing on the day `queue_status_events` shipped with no privileges stated at all (§3.44) |
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
      notifications.ts # sendPlayerNotification (Web Push) + session inbox / score-correction actions
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
      organizer-center-alert.tsx # Large centered dismissible leave / pause / score-correction card
      organizer-notice-inbox.tsx # Header bell + session notice list (center-then-inbox)
      paused-badge.tsx           # Match Control pause chip — "Paused" / "Paused 15m" / "Paused 30m"
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
      queue-status.tsx           # Queue position + wait time display
      live-courts-tab.tsx        # Live courts view for players
      waitlist-tab.tsx           # Waitlist tab showing all waiting players
      match-history.tsx          # Player's in-session match history (+ score-correction request)
      score-correction-request.tsx # Propose Team A/B scores; one pending request per match
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
    use-organizer-alerts.ts      # Inbox hydrate + centered interrupts (leave, checkout, pause, score)
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
    organizer-alerts.ts          # Pure pause-bucket math + center-alert queue helpers
    session-notifications.ts     # Inbox copy, unread rules, upsert, interrupt, center-queue cap
    session-notice-write.ts      # server-only emit / close-pending (not public Server Actions)
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
    cross-court-trigger.test.ts  # Cross-court: gate, trigger, forced-pull selection (§3.1)
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
3. **The diversity derivations are pure, but live in `matchmaking-db.ts`** — `deriveRecentRosters` / `derivePairCounts` / `deriveOverlapMap` take no client and hit no DB, yet they sit next to `fetchSessionMatchSnapshot` rather than in `matchmaking-core.ts`, because the snapshot shape is theirs. The one async helper left, `fetchSessionMatchSnapshot`, **fails closed** — never paper over `{ ok: false }` with an empty snapshot.
4. **`recentRosters` derived per slot; `overlapMap` per anchor** — both come off the same snapshot at no extra DB cost. The snapshot is re-read per slot so sibling drafts from earlier slots of the same burst are visible; `overlapMap` is anchor-specific and must be derived per-tick.
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
28. **A sub-quantum penalty cannot overturn a fairness _tier_** — `CONSECUTIVE_OPPONENT_PENALTY` is bounded at `4 × 3 = 12` for a real split (`5 × 3 = 15` once `buildCombinationGroup`'s unsplittable sentinel is included — quote 15 when reasoning about that argmin), below the games-ahead quantum (10 000) and below one anchor-overlap unit (10 000), so it cannot reorder across either. It is *not* smaller than every fairness gap: inside one tier the remaining separator is wait time, and 12 summed priority-minutes reorders waiters ~4 min apart routinely — which is the term's whole purpose. See the scoped proof on the constant itself (`constants.ts`), not a paraphrase of it. The consequence for feature design: any feature that tries to win a *selection* on freshness by pricing a term into the score is fragile. Cross-court drafting appended pulled bodies at `priorityScore:-1` and asked `runAlgorithm` to prefer them. The arithmetic — "trails by a lot" is the wrong intuition, and so is "always loses": `scoreCandidates` exempts a pulled body from the games-ahead term **only**, so it scores `+1 + overlap×10 000` while a waiter scores `-priorityScore + overlap×10 000 + gamesAhead×10 000`. Both exempted-vs-not terms favour the **body** (its games-ahead is forced to 0; its overlap is usually 0 where a recently-co-courted waiter pays 20 000). And the selection is not even a per-candidate comparison: `buildCombinationGroup` argmins over whole **triples** on `fairness + 3 × repeats`, so what wins depends on the assembled four, not on any candidate's score. On the pool this feature targets the margin comes out a **dead tie**, not a chasm, and the argmin's strict `<` keeps the incumbent. The general lesson: if a candidate must be chosen for a sub-quantum reason, **force it into the group and judge the result** (`buildCrossCourtProposal`) — do not price it into the sort, because a score cannot express a property of the group. Full derivation on `buildCrossCourtProposal`; it has been mis-stated three times, so read it rather than paraphrasing.
29. **A green helper suite proves nothing about reachability** — every cross-court helper had coverage while the feature produced 0 held drafts, because no test asserted the engine ever took the branch. When a trigger lives inside a server action, extract the predicate so it can be tested (`wantsFresherFour`), and assert the branch is taken end-to-end (`CC-REACH-1`). Related trap: `getEffectiveLookback` scales with pool size, so calling `runAlgorithm` with a hand-built 4-player pool silently collapses the diversity window to 2 — re-check diversity against the caller's real pool.
30. **ESLint flat config does NOT read `.gitignore`** — anything generated must be listed in `globalIgnores` in `eslint.config.mjs` or eslint lints it. Left unlisted, build output + `.astro` type caches + `coverage/` + a stale `.claude/worktrees` checkout produced 47 of 62 errors and ~2,700 of 2,744 warnings — noise that hid the real findings. The test for adding a path: **if git does not track it, a fix there cannot survive the next build.** `.agents/**` is the one entry that breaks that rule and is justified separately (vendored third-party skill, 0 errors / 95 warnings). Keep the globs anchored per sub-project (`digital-twin/dist/**`, not `**/dist/**`) so a future hand-written `dist` is not silently skipped. **Related:** the root `tsconfig.json` `exclude`s `digital-twin` and `marketing-site`, so `npx tsc --noEmit` does **not** typecheck them — run `npx tsc --noEmit -p tsconfig.json` inside the sub-project separately.
31. **The organizer's "New" draft chip detects its edge during RENDER, not in an effect** — `organizer-dashboard.tsx` compares `prevDraftCount` to `draftMatches.length` in the render body (React's sanctioned adjust-state-on-changed-value pattern) and sets a `draftNotice` object; the toast effect keys on **that object's identity**, not on the count. This is deliberate and load-bearing in two ways. (a) The previous version keyed the effect on `[draftMatches.length]`, so its cleanup ran before *every* re-run and cleared the 3 s reset timer without resetting the flag — two drafts arriving as two realtime INSERTs stranded the chip lit permanently. (b) A fresh object per edge is what re-arms the toast on a rapid 0→n→0→n, which a count comparison would miss when both edges have the same count. Do not "simplify" this to a memoized value or a count check.
32. **`RED_ZONE_SCORE_FLOOR` is an ADDEND, not a floor — never test `priorityScore >= RED_ZONE_SCORE_FLOOR`** — Tier 2 returns `1000 + wait − games × 8`, so any Red-Zone player with `games × 8 > wait` scores *below* 1000 (wait 22 / 3 games → 998; and wait 30 / 5 games → 990, because `HARD_CAP_GAMES_CEILING` drops them out of Tier 3 into Tier 2). Call **`isRedZonePlayer()`**. This one is a repeat offender: five separate call sites believed the equivalence, the constant's own doc comment asserted it, and it under-reported the Red Zone on 20 of 318 sampled production matches (§3.34). The same trap generalises — a score that *encodes* a tier is not a test *for* that tier the moment any other term can move it.

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

> **STATUS: ✅ SHIPPED.** Merged to `main` as `f3aae17` (2026-07-02) and deployed; the schema was
> already live on prod (Phase 0 + Legacy backfill). The platform-owner model followed on 2026-07-05
> (`1bd4769`, deployed + prod-verified). The full design lives in `MULTI_TENANT_PLAN.md`
> + `MULTI_TENANT_PHASE2_PLAN.md`; this is the architecture summary.
>
> ⚠️ This block read *"NOT merged to main, app NOT deployed"* until 2026-08-12 — six weeks after it
> shipped. A status line in a long-lived architecture doc goes stale silently, because nothing that
> reads the section depends on it being right. Prefer stating the merge commit over the branch state.

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
> - `/organizer/[id]` → a **local** `isSessionOrganizerLocal(user.id, sessionId, session)` in the page — same predicate
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
- **`profiles.pin` exposure via bulk `.select("*")`.** At the time of this audit `profiles_select` was
  `qual: true`, so RLS could not close this — it is closed at the column layer instead. (That row policy
  was later narrowed to a shared-club/shared-session predicate by `20260723200000`; see §11.8. It does
  not affect `pin`, which was never gated by the row policy. The "unauthenticated on purpose" half of
  the original rationale was also wrong: there is no `anon` SELECT policy on `profiles`, and the
  leaderboard/Wrapped profile reads go through `createServiceClient` — `buildVipMap`
  (`src/app/actions/leaderboard.ts:182`) is the single RLS-bound one, and it is authenticated.)
  `PUBLIC_PROFILE_COLUMNS` (`src/types/database.ts`) is an
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
**CLOSED 2026-08-04 as WON'T DO** (user decision): the toggle is Pro-plan-gated and the org is on Free, and no
email+password credential exists to check anyway (Google OAuth + anonymous/PIN only). The advisor WARN is
accepted noise; re-open only on a Pro upgrade or if password sign-up is ever added.

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
| 3 | target **played a match** in a session the caller can reach | ⚠️ **The motive previously written in this cell was false.** It said checkout DELETEs the queue row, citing `queue_delete_own` / `queue_delete_organizer` — those are DELETE *policies* (permissions), not code paths. Checkout **UPDATEs** the row to `status='left'` ([queue.ts:166](src/app/actions/queue.ts:166)), so it survives, and arm 2 carries **no status filter** — meaning arm 2 already covers players who left. Measured on prod 2026-08-13, per-session (the arms are per-session, so "has *some* queue row" is the wrong test): of **638** (player, session) pairs holding a completed match, **0** lack a `queue_entries` row in that same session — 192 distinct players, no exceptions. So arm 3 adds no visibility today. Keep it as **fail-safe depth, not because any known path needs it**: no application or hand-run path in this repo produces the arm-3-only state. ⚠️ An earlier draft of this cell claimed two paths did, and both were checked and neither does — `clearSessionData` deletes `match_players` and `matches` *before* `queue_entries` ([dev.ts:465-477](src/app/actions/dev.ts:465)), so arm 3 dies first rather than surviving; and the hand-run duplicate-merge fix reassigns `match_players` to the **winner** and then **moves the loser's `queue_entries` row to the winner too** (guarded by `NOT EXISTS` on a same-session winner row, [20260608:113-116](supabase/data-fixes/20260608_duplicate_name_data_fix.sql)) before deleting what is left and the loser's profile outright — so the winner ends up holding a queue row in every session where they gained match rows, which is precisely what forecloses the arm-3-only state. The only thing that reaches this state is the integration test, which manufactures it with a service-role DELETE. The real case for arm 3 is simply that it is the one arm that would survive a queue row being removed on its own. `useMatchHistory` / `useSessionCompletedPlayers` read these profiles |
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

---

### 3.39 A player can no longer self-leave from a live match — the refusal, and the TOCTOU window under it (2026-08-15)

**Files:** `src/app/actions/queue.ts` (`checkoutPlayer`), `src/components/player/player-dashboard.tsx`,
`src/components/player/my-status-tab.tsx`, `tests/integration/player-checkout.test.ts`.
Supersedes the self-checkout half of §3.19.

**The incident.** Self-checkout used to mark the caller `left` from *any* status and clean up only
**unpublished** drafts. A player who was `on_deck` (published, waiting for a court) or `playing` therefore
kept their seat in a live roster while being gone from the queue — a ghost. When that on-deck match was
pulled to a court it broke the live queue. The cleanup path was never wrong; it simply had no jurisdiction
over a *published* match, and nothing else refused the request.

**The rule.** `checkoutPlayer` now refuses when the caller's queue status is `on_deck` or `playing`.
`waiting` and `drafted` still leave freely — a drafted player's match is tentative, and the
`checkout_player_cleanup_drafts` RPC tears it down cleanly.

⚠️ **Do not read this as "the organizer can just remove them instead."** No single action removes an
`on_deck`/`playing` player — not the organizer's either. Two UI limits make the organizer's remove control
`waiting`-only, and a third limit means the RPC behind it could not repair the damage anyway: it sweeps
only `pending` matches (all three enumerated in §3.19). Getting an active player out is deliberately **two steps**: tear the match down first so
its roster returns to `waiting`, then check them out. (One exception to "returns to `waiting`": a finishing
player who is the pulled body of a held cross-court draft is re-reserved as `drafted`, not `waiting`
(`match-lifecycle.ts`, R3-1) — and `drafted` is `isLocked` in the organizer UI too, so that draft has to be
cleared as well.) The capability was not moved to another actor — it was
**gated behind repairing the match**, which is the thing that was actually missing.

**Two gates, because one is not enough.** The status read and the write are separate round-trips, and the
engine can promote a `waiting` player to `on_deck` in between — publishing a roster containing someone who
is about to vanish. So the write itself is guarded:

```ts
.update({ status: "left" })
.eq("session_id", sessionId).eq("player_id", user.id)
.in("status", ["waiting", "drafted", "left"])
.select("id")
```

If the promotion won the race, the `.in(...)` predicate no longer matches and **0 rows** come back; the
action returns the same refusal. Two details are load-bearing:

- **`"left"` stays in the allowed set** so a double-checkout still updates its own row and succeeds — Q-8's
  idempotency is a real behaviour, not an accident of ordering.
- **A null pre-read is excluded from the 0-rows guard.** A caller who was never in this session also updates
  0 rows, but that is a harmless no-op, not a lost race. Only "read as leaveable, wrote nothing" is a race.

**Client.** The leave dialog's copy branches on `hasActiveMatch` and the confirm button is
`disabled={checkingOut || hasActiveMatch}` — the client blocks the *tap*, the server remains authoritative
(the two derive from different sources: `hasActiveMatch` from the current match's status, the server from
the queue row). `handleCheckout` now surfaces `result.error` as a toast instead of failing silently. In
`my-status-tab`, the **Match Forming card's** "Leave Queue" button now renders only for
`status === "drafted"` — that card is the one a drafted *or* on-deck player sees, and only the drafted half
may still leave. The **paused** branch now carries the same gate (see the follow-up below — the claim that
once stood here, that paused is itself a leaveable state, was false). The waiting branch keeps its Leave
button unconditionally, because `waiting` really is always leaveable.
The `MatchAlert` court-call overlay is deliberately no longer passed `onLeaveQueue` — the prop is optional
and gates two buttons, so dropping it removes both, and by the time that overlay fires the player is on deck.

**Tests.** Suite Q `Q-4`/`Q-5` were **inverted, not added** — they previously asserted the superseded
contract (`expect(entry?.status).toBe("left")` while on deck) and would have stayed green against the bug
forever. Both now assert `result.success === false`, that the queue status and match status are unchanged, **and
that the message is the refusal** — `expect(result!.error).toMatch(/on deck|in a match/i)`. That last
assertion is the one doing the work: `success === false` plus unchanged rows is *also* what a broken
`mockAuthAs` or a rejected UUID produces, so without pinning the message the test would stay green for
reasons having nothing to do with the guard.

**Follow-up (same day, `cbf57df`) — three defects the review gate found in the above.**

1. **The guard had its own false-success hole.** The pre-read discarded its error, and a null `currentEntry`
   is indistinguishable from "not in this session". So on a transient read failure the `on_deck`/`playing`
   check never fired, the UPDATE matched 0 rows (an `on_deck` status is outside its `.in()` set), and the
   0-rows guard was skipped *precisely because* it requires a non-null `currentEntry` — the exclusion
   described two paragraphs above. The action returned `success` and the client navigated away while the
   player sat in a live roster. That is the very failure this section exists to describe, reachable through
   the fix for it. The read now fails closed.
2. **The paused branch rendered an ungated Leave button**, and it returns *before* the drafted/on-deck
   branch, so the gate at that branch never saw a paused player. `is_paused` is orthogonal to status:
   `togglePlayerPause` (`queue.ts:83`) has no status guard, and the organizer's pause control
   (`queue-control.tsx:942`) — unlike its checkout control at `:969` — is not hidden for locked rows, so an
   on-deck player can be paused and land there. The server refused correctly, so this was UX-only: a dead
   button contradicting the rule applied 34 lines below it.
3. **`handleCheckout` used `try/finally`**, which cleared `checkingOut` on the *success* path too, flipping
   the button out of "Leaving…" while `router.push` was still in flight (`origin/main` never reset it). The
   `finally` also silenced `react-hooks/set-state-in-effect` across the **entire component** — that, not the
   `prevHasActiveMatchRef` tab-switch effect the directive sits on, is what had orphaned that disable into
   an unused directive. (Mechanism: the compiler-backed `react-hooks` rules cannot lower a `TryStatement`
   with no `catch` handler, so they bail on the enclosing component.) Measured both ways: `finally` → 1
   warning, `catch` → 0. Now `try/catch`, which keeps throw-safety, removes the flicker, and makes the
   disable load-bearing again — it also toasts on a throw, which the `finally` never did.

🪤 Two of the three are the repo's standing defect class rather than new logic bugs: a doc/comment asserting
something the code does not do. The parenthetical corrected above ("paused … both are leaveable states") is
what made #2 invisible, and it shipped in the same commit as the fix it contradicted.

---

### 3.40 Losing the score race gracefully, and un-breaking the repeat score edit (2026-08-15)

**Files:** `src/app/actions/_shared.ts`, `src/app/actions/match-lifecycle.ts`, `src/lib/constants.ts`,
`src/lib/settled-match-toast.ts` **(new)**,
`src/hooks/{use-edit-match,use-score-form,use-score-input,use-organizer-matches,use-organizer-data,use-match-history}.ts`,
`src/components/player/{score-input-card,player-dashboard}.tsx`,
`src/components/organizer/{edit-match-dialog,score-modal,active-courts,match-history-panel,queue-control}.tsx`,
`tests/unit/{edit-match-dialog-repeat,score-race-transition,queue-control-duplicate-confirm}.test.tsx`,
`tests/unit/{duplicate-roster-confirm,settled-match-toast,end-match-cas-code}.test.ts`, and mock/assertion updates in
`tests/unit/{match-origin-tracking,use-score-form,use-match-history,queue-control-repeat-pairing}.test.*`
+ `tests/integration/score-submission.test.ts`. **TypeScript only — no migration.**

Reported as two defects: *"2 scores for the same match … caused by the organizer and the player inputting
the scores"*, and *"when one match is edited, they couldn't be edited or fixed again"*.

⚠️ **The reported cause of the first one is not what the data shows, and the distinction changes what the
fix is worth.** The duplicate in the 2026-08-15 session is **two `matches` rows**, not two scores on one row:

| | `0dfedb8a…` | `88168066…` |
|---|---|---|
| court | Court 9 | Court **12** |
| created → completed | 05:22:42 → 05:31:20 (**8m 38s**) | 05:33:11 → 05:33:39 (**19s**) |
| score | 30–31 | 31–25, edited to 31–15 at 05:37:45 |
| `created_method` / `created` actor | manual / **Miggy** | manual / **Miggy** |

Same four players (Leo + Arvin vs Von + Michelle), both rows created by the **organizer**, ten minutes
apart, on different courts. No player was involved in creating either. A 19-second match is not a match
that was played — it is a row created *after the fact* to record a result, which is an established
workflow here, not an anomaly: **48 completed matches** across the database have a sub-minute
`completed_at - started_at` (5 of today's 55, 43 of the earlier 896).

So the compare-and-swap in `endMatchInternal` was never the thing that failed. It already prevents two
scores landing on one row (`.eq("status","in_progress")` on the UPDATE plus a `.select("id")` row count),
and nothing in the ledger contradicts it. **What was broken was everything that happens after the CAS
refuses.** That is worth fixing on its own terms — a race between an organizer and four players all
reaching for the score of a game that just ended is real and routine — but it should not be recorded as
the fix for what happened on 2026-08-15.

**The loser of the race had nowhere to go.** `submitMatchScore` returned `{success:false, message:"Match is
already completed."}`, the player's card painted it red next to a live "Submit Final Score" button, and
every retry hit the same wall. The organizer's side was worse than cosmetic: `useOrganizerMatches.endMatch`
returned `{error}` *without refetching*, so the board still showed an occupied court for a match that had
already moved to history — an invitation to record it a second way, which is precisely the shape of the
duplicate above.

**A `code`, because prose is not a branch condition.** `MatchActionResult` gains an optional
`code?: MatchActionCode` (`"already_scored" | "match_cancelled" | "not_completed"`). Only outcomes needing
something other than "render the text in red" carry one; every existing consumer that ignores `code` keeps
its exact previous behaviour, which is why the field is optional rather than a new required discriminant.
`endMatchInternal` tags **both** places the race surfaces — the pre-check on the fetched row *and* the
0-rows CAS branch below it, which is the true concurrency window (the pre-check passed, then the other
caller's UPDATE landed first).

🪤 **And both places have to DISCRIMINATE, not just tag.** The pre-check always did
(`match.status === "completed" ? "already_scored" : "match_cancelled"`); the CAS branch first shipped
hardcoding `already_scored`, so a concurrent *cancel* in that window produced *"the score they entered
was kept"* for a match that has no score and must be re-run. That is precisely the sentence
`settledMatchToast` was extracted to prevent — and `settled-match-toast.test.ts` was green throughout,
because the pure function was never the thing that was wrong. **A correct mapping tested in isolation
proves nothing about the caller that chooses its input.** The branch now re-reads `status`. Only
`"cancelled"` takes the cancel arm; the cancel copy states that no score was recorded, an organizer
reading that re-runs the game, and re-running one that was in fact scored is how a second row for the same
match gets created — the defect at the top of this section. So everything else falls back to
`already_scored`: a read error, a deleted row, and `"pending"` — a fourth status that passes the pre-check
(which rejects only `completed`/`cancelled`) and then misses the CAS. `pending` is not reachable from
either UI today and its copy would be wrong if it were; it lands on the arm that does not invent a re-run.

**`useScoreForm` now has three outcomes, not two.** `{}` is a win, `{error}` is an actionable failure that
keeps the form armed, and `{settled}` is "someone else scored it" — terminal, like a success. `settled` is
checked **before** `error` so a handler that fills in both still lands on the terminal state. The player
card renders `settled` in neutral slate with an `Info` icon rather than red, and drops the form entirely;
the organizer's `ScoreModal` closes and raises the toast `settledMatchToast` picks for the code —
`Already Scored` or `Match Cancelled`, never one shared string, which is the distinction this whole
section turns on — and `endMatch` now refetches **on the failure path too** so the board is correct
before the modal disappears.

🪤 **`ScoreModal` was silently discarding the field.** It wrapped its `onSubmit` prop in
`async (a,b) => ({ error: (await onSubmit(a,b)).error })` — a lambda that re-wraps the result and keeps only
`error`. Threading `settled` from the action to `active-courts.tsx` and never touching that lambda would
have type-checked and done nothing. It is now `useScoreForm(onSubmit)` and the prop is typed
`Promise<ScoreSubmitOutcome>`. **A projection lambda in the middle of a chain is a silent filter; widening a
return type does not widen the code that narrowed it.**

**The score edit is no longer a one-shot — and the auto-close was the reason it was.** Both paths of
`useEditMatch` used to end with a detached `setTimeout(() => setOpen(false), DIALOG_CLOSE_DELAY_MS)`:
untracked, never cleared, bypassing `handleOpenChange`. Two consequences, one cause:

- It fired against whatever the dialog had become — a reopened dialog, or an unmounted one.
- `isError` was never reset on reopen, so a stale red could colour the next open's first message.

🪤 **A third consequence was hypothesised and then disproven, and the disproof is worth keeping.** The
appealing story was that closing a Radix modal from a *timer* rather than a dismissal gesture strands
`document.body.style.pointerEvents: none`, which would make **every** control on the page unclickable and
would match the report's plural — *"they couldn't be edited"* — far better than a per-card failure does. It
does not happen. `DismissableLayer` restores the style in an **unmount cleanup**
(`@radix-ui/react-dismissable-layer`, the `disableOutsidePointerEvents` effect), and a timer-driven close
unmounts the layer exactly like a gesture-driven one, running the same cleanup. Nothing about the trigger is
special. An earlier draft of this section carried the hypothesis as a finding and described a
`useReleaseStrandedBodyLock` escape hatch in `dialog.tsx`; **no such hook exists and `dialog.tsx` is
unchanged by this work** — the story survived into prose because it explained the symptom so neatly.

A score edit now **does not close the dialog at all**. Correcting a score is inherently repeatable (fix the
digit, notice the teams are swapped, fix that too); the button becomes **"Save Again"**, a line of copy says
so, and a `DialogClose`-wrapped **"Done"** button gives a real dismissal gesture. The revert path still
auto-closes — it moves the match back to a court, so the history card hosting the dialog disappears anyway
— but its timer is held in a ref, cancelled on unmount and before every new action, and routed through
`handleOpenChange`.

⚠️ **Honest limit: the browser-level failure was never reproduced, and the root cause is unconfirmed.**
Three things are established. The **server** had no idempotency guard on the score-edit path — it was a
bare `.update({scores}).eq("id", matchId)` — so a second edit would have been accepted. The **ledger**
has no per-`event_type` uniqueness, so a repeat `score_edit` inserts cleanly. And **production proves both
empirically**: two matches have in fact received two `score_edit` events — `c516b3de…` 52 s apart on
2026-07-25, `d79d8ddb…` 101 min apart on 2026-07-30 — out of 17 matches that were edited at all.

**Repeat editing is therefore intermittent, not blocked.** That is the load-bearing finding: it rules out
every hard-block explanation (server guard, DB constraint, dead code path) and leaves only a
timing-dependent client fault, which is what the three changes above target. They are not a confirmed
root-cause fix, and this paragraph exists so the next reader does not upgrade them into one. The only
real test is a live session — watch whether any match receives a second `score_edit`.

**The edit path is now status-guarded, but deliberately not idempotency-guarded.** `updateMatchDetails`'s
score-only branch adds `.eq("status","completed")` + `.select("id")`. The Edit control only exists on a
completed history card, so 0 rows means a concurrent "Revert to Active Court" put the match back on a
court, and stamping a final score onto a live game would corrupt it silently; the organizer gets
`not_completed` and re-reads the board. It does **not** guard against repeating the same edit — that is the
behaviour being restored, and every pass appends its own `score_edit` event. The `revertToActive` branch is
untouched by this CAS.

**The duplicate-roster soft confirm on `createManualMatchAction` — the one change aimed at what actually
happened.** Everything above hardens the race; this is the part that addresses the 2026-08-15 rows. Before
creating a manual match, the action asks whether these same four already have a **completed** match in this
session inside the last `DUPLICATE_ROSTER_WINDOW_MINUTES` (30, in `constants.ts`). If they do, it returns
`{success:false, code:"duplicate_roster", message}` and the organizer is asked to confirm; re-sending with
`confirmDuplicate = true` skips the probe entirely and creates the match.

Three properties are deliberate and each one is load-bearing:

- **A confirm, not a block.** Rematches between the same four are ordinary badminton, and the 48 sub-minute
  rows show retroactive hand-entry is a workflow the organizer relies on. A hard rule would make a
  legitimate game unrecordable with no way through, which is worse than the duplicate it prevents.
- **Roster identity is the SET of participants, not the teams.** A rematch with the sides swapped is the
  same four people; comparing team-by-team would miss exactly the case an organizer is most likely to
  re-enter differently.
- **It is a distinct `code`, not an `error`.** A soft refusal that arrives as an error string gets rendered
  red by every existing caller, and red has no "yes, do it anyway" affordance. `code:"duplicate_roster"` is
  what lets `queue-control.tsx` open a confirm instead — and the client carries the exact roster from the
  refusal into the confirm rather than re-deriving it from the current selection, so the create that goes
  through is structurally the lineup the organizer was asked about.

The probe sits **behind** the organizer gate and runs only when `confirmDuplicate` is false, so a
non-organizer is refused before any match row is read (no `code` on that path — an auth failure must never
render a "Create anyway" button). Wording degrades by age: *just finished*, *1 minute ago*, *N minutes ago*.

**Tests.** `edit-match-dialog-repeat.test.tsx` (EM-1…EM-6, happy-dom + RTL) pins the new contract: the
dialog stays open after a save, a second save from the same open dialog **reaches the server**, close-and-
reopen still allows another edit, reopening re-seeds from refreshed props, a failed save stays open and
retryable, and a stale error does not bleed into the next open (asserted via the success message's
`text-emerald-600` class, not its text). `score-race-transition.test.tsx` (SR-1…SR-4) pins the player side:
`already_scored` and `match_cancelled` each resolve the card and **remove the submit button**, while an
ordinary failure still renders red and leaves the form armed — the control that stops SR-1/SR-2 passing for
the trivial reason that every failure hides the form.

`duplicate-roster-confirm.test.ts` (DRC-1…DRC-6, 16 cases) drives the server probe through a
table-addressed service mock: it fires on the same four with the teams swapped across the net, scans every
match in the window rather than only the newest, stays silent when just three of the four are shared and
when the session is empty, records the window bound it asks for, proves `confirmDuplicate` both creates
the refused match and skips the probe entirely (no `matches` read), and — DRC-6 — is unreachable by a
non-organizer, asserted by checking the `matches` table was never read rather than by trusting the message. `queue-control-duplicate-confirm.test.tsx`
(QDC-1…QDC-6, 10 cases) pins the client half: a `duplicateMessage` opens a prompt and an `error` never
does, Cancel keeps the selection so the organizer can correct it, and **QDC-4a changes the selection while
the prompt is open and asserts the re-send is unaffected** — the property that stops the confirm from
silently creating a different match than the one it described. `settled-match-toast.test.ts` (SMT-1…SMT-4)
holds `already_scored` and `match_cancelled` apart, since collapsing them tells an organizer their score
was kept when the match was in fact cancelled.

`end-match-cas-code.test.ts` (EMC-1…EMC-3) is the other half of that pair, and the reason the pair is
needed: SMT tests the mapping, EMC tests the **producer that picks which input the mapping gets**. It
drives `endMatchAction` to the 0-rows CAS branch (a queued `matches` mock answers the pre-check fetch with
an `in_progress` row, the UPDATE with `[]`, then the re-read with whatever the winner left) and asserts a
concurrent cancel yields `match_cancelled` with a message that never says *scored*, a concurrent complete
yields `already_scored`, and an unreadable status falls back to `already_scored`. EMC-1 also asserts the
`matches` table was read three times — without it the test passes on a branch that guessed the code from
the pre-check row instead of re-reading.

---

### 3.41 Publishing a held cross-court draft — refused while it held, wrongly allowed while it rested; no code meant "not yet" (2026-08-16)

**Files:** `supabase/migrations/20260816000000_publish_never_touches_an_unready_held_draft.sql` **(new —
hand-applied to prod 2026-08-16, stamp `20260816024129`)**, `src/app/actions/match-drafts.ts`, `src/app/actions/matchmaking.ts`,
`src/lib/cross-court/derive-held-state.ts`, `src/lib/constants.ts`,
`src/components/organizer/{sortable-card,on-deck-panel}.tsx`,
`tests/unit/{publish-held-guard,held-draft-ui,derive-held-state}.test.*`,
`tests/integration/publish-match.test.ts`.

Reported after a live session: *"cross-court matches generated for people who are still playing but I
couldn't approve any of them"*, and *"Publish All allows it on deck, but I couldn't make it work."*

**The report is accurate, and it is four separate defects — three of them sharing one symptom.** ⚠️ This
said "four … that happen to share one symptom" until 2026-08-16; defect 2 (the draft-cap notice) does
not. Its symptom is a panel that cannot say why *generation* stopped, and it was found while tracing the
other three, not reported. Defects **1, 3 and 4** are the publish path; defect 2 rides along because it
shares the session and the fix. Production trace, session `3367d4c6` ("08/15 Saturday
Session", `auto_publish=false`, `max_auto_drafts_override=1`): **12 held drafts created, 10
cleared by hand, 2 ever reached a court.**
That is the feature's first live-session evidence of any kind — §3.1's cross-court block had said "still
not observed in a live session", and what the first observation shows is that it does not work.

🪤 **"2 ever reached a court" is the number; do not let a heading round it to zero.** This section was
titled "could never be published" until 2026-08-16, and PR #68's squash body on `main` (`61e942b`) still
says the session "**published zero**" and that the publish path "**refused every one**". Both are false:
`matches` rows `2c1b0edc…` and `4cf0a097…` in session `3367d4c6` are `is_held`,
`created_method='held'`, **`is_published`**, promoted, and `completed`. A class title survives paraphrase
into a **count** — within a day "could never be published" had become "could publish **none** of them" in
§3.1, where it is not a characterisation but arithmetic, and disagreed with the other sites stating the
figure. The list is `git grep -n "2 ever reached a court\|10 cleared by hand\|10 of 12" --
APP_MANIFEST.md MEMORY.md` — and note it misses §3.1's "got **2** of them onto a court", so treat a
phrase grep as a starting set, never as proof of completeness. ⚠️ **No tally of those sites belongs in
this sentence**, which learned it twice: it originally said "four" (exact for these two files at the
time), and the 2026-08-16 "correction" to "six" was wrong for the command it printed, which carried no
pathspec and so swept the whole tree (nine hits at the time, including the migration and two test
files), while the six it did describe included the correction's own new line. A count that changes when
you write it down is not a fact about the document. A squash message cannot be amended, so `61e942b`'s
body is permanent and wrong; these documents are the correctable record.

⚠️ **And do not replace the absolute with an ordering, which is what the first correction did.** It read
"each of those two has `held_ready_at` stamped, **so** both published only after the hold had already
resolved". `held_ready_at` is a *state* column: non-null now proves the hold eventually resolved, never
that the publish came after it. **Production records no publish time at all** — `matches` has no
`published_at`. Its four `timestamptz` columns are `created_at`, `started_at`, `completed_at` and
`held_ready_at` itself, plus the `is_published` boolean; publication is recorded as a flag, with no
instant attached. (This list read three and silently dropped `held_ready_at` until
2026-08-16 — omitting from an "only X, Y, Z" the very column the sentence before it is about, which
is how a reader re-derives the ordering this paragraph exists to kill.)
`match_events` for this session holds only `created` / `cancelled` / `team_flip` / `roster_swap` /
`score_edit`, and `queue_status_events`, the table that would have caught the roster's `drafted→on_deck`
flip, is **empty** (migration `queue_status_audit`, stamped `20260815133945` — hours after the session's
last match completed at `08:01:06Z`; the session itself has `ended_at IS NULL` and was never closed).
🔴 **Sharper, measured 2026-08-16 while reviewing this paragraph: `MatchEventType` *does* define a
`"published"` kind — "draft → published", in `src/lib/match-provenance.ts` — and nothing wrote it.
0 such rows in the whole production database across all 1071 events, including for the 2 held drafts
that did reach a court.** So "prod has no publish record" was not a missing-column argument: the ledger
event existed and was unwired, which means no query over `match_events` can tell "never published" from
"published, unrecorded" **for anything up to this merge** — the writer landed the same day (below), and
it is forward-only, so every sentence in this paragraph stays true of the 08/15 rows forever. ⚠️ The *gap* is not a discovery, and this paragraph said "found" until
2026-08-16: it is booked as `DEFERRED — published event (L2)` in `MEMORY.md` and again in
`src/lib/match-event-log.ts`'s header. What is new is the count and that consequence — L2 prices the gap
at "the timeline just won't show the publish step" and does not anticipate it. The writer plumbing is all
there — `logMatchEvent` accepts `"published"`, `modificationDelta` scores it 0 (this called that function
`eventDelta` until 2026-08-16, a symbol the repo does not contain), the timeline labels it "Published to
players" — so what is missing is the call. Deleting the kind instead is *silently* lossy, measured with
`npx tsc --noEmit`: three errors, **none** at the writer signature, whose `Extract<MatchEventType, …>`
narrows to the survivors without complaint. The comment heading the held-draft block in
`tests/integration/publish-match.test.ts` asserted prod had "no event type" for publish; that was
false in the safer-sounding direction, and it was not caught in draft — it shipped in `f08e662` and
sat on this PR until the next review. Was booked as STANDING TO-DO **A0**; ✅ **the call is now wired —
see *Wiring the `published` event* below.** Worse, the
RESTING window that defect 4 below turns on is measured, and in it the opposite ordering is possible:
`2c1b0edc…` rested **88 s** between its source match completing and its stamp, `4cf0a097…` **237 s**,
and in that window the pre-fix `publish_match` *passes* — `derive-held-state.ts` says so in as many
words ("RESTING … it CAN succeed, and that is worse"). So the honest claim is the count plus defect 1's
mechanism (a HOLDING draft's publish is `CONFLICT` by construction), **not** a sequence. Fixing
"false" with "unprovable" is not a fix.

1. **`publish_match` returned `CONFLICT`, 100% of the time, by construction.** Its conflict predicate counts
   any OTHER pending/`in_progress` match holding one of this roster's players. A held draft's pulled body
   sits in an `in_progress` match for the entire hold — that is *what a hold is*. The organizer-facing copy
   for `CONFLICT` reads "a player is already assigned to another active match. Clear this draft and let the
   engine regenerate." Structurally true and exactly the wrong advice: nothing was broken, the hold had
   simply not resolved. **There was no return code that meant "not yet"**, so the caller could not
   distinguish *wait* from *throw this away* — and 10 of 12 organizer clears is what that reads like in the
   data.
2. **The draft-cap notice could not explain why generation stopped.** `DraftCapNotice` computed its ceiling
   from `getDynamicDraftCap(waitingCount)` alone and never read `max_auto_drafts_override`, while
   `runEngineInternal` caps at `min(override, dynamicCap)`. With the override at 1 — the live session's
   setting — the engine stopped after one draft and the panel, still waiting for three, said nothing at all.
   The notice was a strict under-reporter: it could only ever fire when the dynamic cap was *also* hit.
3. **`recomputeHeldReadiness` was event-driven on the wrong event.** Its only two callers were in
   `match-lifecycle.ts` (match end / cancel). The RESTING→READY stamp requires
   `CROSS_COURT_REST_FALLBACK_MINUTES` of rest to have elapsed — which is **never true at the instant the
   source match ends**. So the one event that fired the recompute was the one event that could not stamp,
   and nothing fired again until some *other* match ended. Two holds in the trace sat unresolved ~10 minutes.
4. **`publish_all_drafts` had no held exclusion at all**, and its two failure modes are opposite. While the
   body is on court the hold hits the same conflict check and is **skipped silently** — the action reported
   every skip as "(left players)" and still returned `success: true`. In the RESTING window (source game
   over, stamp not yet written) it **passes** the conflict check and publishes: four queue rows flip to
   `on_deck`, an `ON_DECK_WARNING` push fires, and `promoteOnDeckMatchInternal` still refuses the match —
   its JS filter over the published pending set takes a held row only once `held_ready_at` is both stamped
   **and due** (`<= now`), so publishing cannot satisfy it. A card parked on deck that no court will take.
   That is "Publish All let it through but it never worked", verbatim.

**One rule, one predicate, plus an independent SQL mirror: a held draft is not publishable until
`held_ready_at` is stamped.** `isHeldAwaitingReadiness(row)` (`= row.is_held === true && row.held_ready_at
=== null`) is the single definition — the card's Publish button, the on-deck review-queue count, the
engine's draft-mode cap count, the heartbeat gate, `promoteOnDeckMatchInternal`'s blocking-drafts count and
both publish actions' snapshot filters all *call* it rather than re-spelling it. Do not maintain a count of
the call sites in prose (this sentence said "five" and there were eight): `grep -rn
"isHeldAwaitingReadiness" src/` is the list, and `matchmaking-db.ts`'s unready-hold count is the one
deliberate inline spelling, which says why at the call site. `publish_match` / `publish_all_drafts` enforce
the same rule independently in SQL — ⚠️ the same *partition*, not the same characters:
`NOT (is_held IS TRUE AND held_ready_at IS NULL)` is three-valued logic, `=== true` is not. The two halves are
deliberately redundant: the RPCs are the real gate (the JS fallbacks only run pre-deploy), and the UI half
exists so the organizer never sees a button whose only outcome is a refusal.

- **`publish_match` gains a `HELD_NOT_READY` code**, checked *after* `ALREADY_PUBLISHED` and *before* the
  left-player and conflict predicates, so the specific cause wins over the generic one. A **new** code, not
  a repurposed one — callers switch on the string and must be able to say "wait". The copy names the
  mechanism and the exit: *"waiting on a player who's still on court. It unlocks by itself when that game
  ends; clear it if you'd rather not wait."* ⚖️ **The order has one accepted cost**: a held draft that has
  *also* lost a player is told to wait rather than to clear. It is self-correcting — once `held_ready_at`
  stamps, the next publish reports `HAS_LEFT_PLAYERS` correctly, and the 15-minute hold-age cancel bounds
  it regardless — and Clear is offered throughout. The alternative restores the original bug for the common
  case (every ordinary hold gets clear-advice again) to improve a rare compound one.
- **`publish_all_drafts` excludes unready holds from `v_all_draft_ids` entirely**, rather than letting them
  fall into `v_skipped_ids`. They are not eligible, so they are not attempts, so they must not inflate
  `skipped_count` — the number the client renders as "clear and regenerate". Same **motive** as
  `20260624000000_clear_drafts_exclude_held` (keep a held draft out of a bulk operation's candidate set
  rather than handling it inside the loop), but deliberately **not** the same predicate: that one excludes
  *every* held draft (`is_held IS NOT TRUE`), since a bulk clear must never touch a hold; this one excludes
  only the **unready** ones, since a stamped hold is an ordinary publishable draft. Aligning the two
  spellings would make a READY hold permanently unpublishable via Publish All. With held drafts no longer
  candidates, the skip causes an organizer can act on are a departed player and a genuine double-booking,
  so the skip copy was corrected from the unconditional "(left players)" to name both. (The loop's third
  skip arm — the row stopped being a `pending` unpublished draft between the snapshot and the `FOR UPDATE`
  — is a concurrency race, not an organizer-actionable state, and is rare enough to leave under the same
  copy.)
- **Publishing stays BLOCKED, not deferred.** Promotion requires the stamp anyway, so an early publish buys
  nothing and costs a premature player-facing ping. Clear stays available — it is the one action that is
  always legitimate on a hold the organizer no longer wants, and it is also how the three reserved players
  are freed.
- **Held-draft heartbeat** (`runEngineInternal`): `recomputeHeldReadiness` now also runs from the engine,
  gated on `pendingRows.some(isHeldAwaitingReadiness)` so a session with no live hold pays nothing. Queue
  joins, publishes and clears all reach the engine, making it much the denser trigger. Re-entrancy is safe
  — `endMatchAction` already calls it, so a match end now runs it twice; the stamp is idempotent
  (`.is("held_ready_at", null)`) and the second pass is the useful one, landing *after* that end's
  promotion and so seeing the incremented `promotionsSinceFreed`. The pending set is **re-read** after the
  recompute rather than counted from the pre-recompute snapshot, because the recompute can stamp, cancel or
  downgrade a row — all three change the count below it. Still not a timer: it sits below the `courtCount`
  early-return and inside the `is_auto_matchmaking_on` gate, so `CROSS_COURT_MAX_HOLD_MINUTES` remains a
  bound on *attention*. See the corrected bullet in §3.1.
- **`CROSS_COURT_MAX_UNREADY_HOLDS = 2`**, enforced in `hasFeedableCapacity` at creation time. The trace's
  12 holds against 2 promotions is the shape this bounds: reaching again while two holds are already
  unresolved parks six more players against a mechanism that has not yet demonstrated it can release three.
- **The panel now computes the engine's cap**, `min(override, dynamicCap)`, and counts the same review
  queue the engine does — held drafts excluded while unready, included once stamped. An unready hold still
  **renders**; it just does not fill a slot. Counting it would have produced the worst possible notice:
  "2/2 draft slots filled — publish the drafts below to resume", pointing at a card whose Publish button
  had just been removed.

**Tests.** `derive-held-state.test.ts` CC-DHS-06…08 pin the predicate itself, including that a null
`is_held` falls to *not held* (fail-open, same direction as `hasFeedableCapacity`'s CCT-FEED-7). The column
is `GENERATED` and never null in the DB, and `database.ts` declares it `boolean` — but that declaration is
an assertion, not a validation: nothing checks a PostgREST payload against it at runtime (types are erased
and `supabase-js` casts). CC-DHS-08 needs a cast to reach the case *because* the type says it cannot happen; that is
the point of the case, not an argument against it.
`publish-held-guard.test.ts` (PUB-HELD-1…10) covers the two JS fallbacks through a table-addressed service
mock, and asserts guard **order** structurally rather than by message: PUB-HELD-2 checks `svc.from` was
called exactly once and no update was issued, so the refusal cannot be coming from a later probe.
PUB-HELD-8 pins the asymmetry that makes the two-list restructure correct — `match_players` is queried for
the *publishable* ids while the conflict probe still excludes **every** draft including the held one,
because narrowing that exclusion set would turn a held draft into an "other active match" and let it taint
its neighbours. `held-draft-ui.test.tsx` (UI-HELD-1…4, UI-CAP-1…6) pins both components, including that the
suppression is *explained* — a button that vanishes with no reason reads as a bug.

`tests/integration/publish-match.test.ts` Suite **PUB-HELD-DB-1…4** is the half no unit test can reach: the
conflict predicate needs a genuinely `in_progress` source match holding the body, and the `publish_all_drafts`
candidate filter is SQL. (The `-DB` suffix is load-bearing — the unit suite already owns `PUB-HELD-*`, and
these are different tests of the other half.) It builds the fixture through `create_held_cross_court_match`
rather than a raw insert, so `is_held` and the drafted/playing queue statuses come out exactly as the
engine writes them. **Injection-verified**: restoring the pre-fix function bodies locally failed exactly
PUB-HELD-DB-1 (`expected 'Cannot publish — a player is already …' to match /still on court/i` — the field
bug reproduced verbatim), PUB-HELD-DB-3 and PUB-HELD-DB-4 (`skipped_count` 1, not 0), while PUB-HELD-DB-2
stayed green — which is what proves PUB-HELD-DB-2 is a real control (the guard lifts) and not a tautology.
ACLs were re-verified as `{postgres, service_role}` after restore.

✅ **Migration `20260816000000` — APPLIED AND VERIFIED ON PRODUCTION 2026-08-16, stamp `20260816024129`.**
Applied *before* the merge, while both open sessions held 0 live matches and 0 held drafts. Post-apply on
prod: both functions still `SECURITY DEFINER`, both ACLs still exactly `postgres=X/postgres |
service_role=X/postgres` (no PUBLIC, anon or authenticated), and the return ordering re-verified
positionally as `HELD_NOT_READY` < `HAS_LEFT_PLAYERS` < `CONFLICT`. Pre-apply both prod bodies were
confirmed clean pre-fix baselines, so the new version is a strict superset. Full fingerprints in repo
`MEMORY.md`'s migration queue. ⚠️ Both functions are `CREATE OR REPLACE` with unchanged signatures
specifically to preserve the narrowed EXECUTE grants from `20260721180000` / `20260722000004` — do **not**
convert either to DROP+CREATE, which silently resets the ACL to `EXECUTE TO PUBLIC`.

🪤 **Why this paragraph is worth re-reading before you trust it.** While the migration was unapplied, the
TypeScript half degraded safely — the UI stopped offering Publish on an unready hold and the action's
snapshot filter excluded it, so the organizer could not reach the old `CONFLICT` path by the ordinary route,
*but the RPCs themselves stayed unguarded* against a stale client or a direct call. That safe degradation is
exactly what makes "did the migration actually land?" an easy question to stop asking. It landed. If you are
reverting, revert the **code** and leave the SQL: the guard is a strict narrowing and a no-op for any client
that already refuses to publish an unready hold.

✅ **The `cancelMatchAction` reservation gap — CLOSED 2026-08-16 (was ⚠️ "pre-existing, not fixed here").**
No migration: it is TypeScript only, so it is correct in production the day it merges — unlike
`20260816000000`, which had to be hand-applied first and was.

`cancelMatchAction` flipped **every** roster player to `waiting` in one bulk UPDATE. That is right for the
ordinary cancel and wrong at both ends of a live hold, so the restore is now a three-way partition —
`partitionCancelRestore` in `src/lib/cancel-restore.ts` owns the rule, the action only feeds it reads:

1. **The reservation mirror.** A pulled body whose held draft is still `pending` comes back `drafted`, not
   `waiting` — the same re-reservation `endMatchAction`'s R3-1 performs. This half is required precisely
   *because* the hold survives: `recomputeHeldReadiness` counts `cancelled` alongside `completed` as the
   event that frees the body, so a cancelled source moves the draft Holding→Resting rather than tearing it
   down. And recompute cannot repair the status afterwards: **no path in it ever writes `'drafted'`**. Its
   only `queue_entries` writes are the ones its RPCs perform — `clear_on_deck_match_atomic` → `'waiting'`
   and `auto_publish_match` → `'on_deck'` — and neither restores a lost reservation. (In auto-publish mode
   the second one would eventually rewrite a wrongly-`'waiting'` body to `'on_deck'`, which is not a repair:
   by then the engine has already had the body in the pool.) It also runs *after* the restore, not before.
2. **The physical-truth skip.** A roster member who holds an `in_progress` match in this session is not
   written at all. That is the rule migration `20260812000000` put inside `clear_on_deck_match_atomic`;
   `cancelMatchAction` never calls that RPC, so it needed its own copy. Reachable by cancelling the **held
   draft itself** — three drafted members plus one body mid-game on another court. The UI declines to send
   that today (`active-courts.tsx` filters to `in_progress`, `court-card.tsx` renders Clear for a pending
   row), but every export of a `"use server"` file is a public endpoint, so the UI is not the gate.

Both arms depend on the CAS at `match-lifecycle.ts` having **already** flipped this match out of
`pending`/`in_progress`: that is what lets one predicate set cover both cases, since the cancelled match can
then be neither "the `in_progress` match" of (2) nor "the pending held draft" of (1). Do not reintroduce a
`match.status` branch — that variable holds the *pre*-CAS status (correct for the audit `phase`, wrong here).
`requeue_finished_players` is deliberately **not** reused despite its `p_drafted_ids` argument looking made
for this: it unconditionally does `games_played + 1, joined_at = now()`, and a cancel must cost neither.

🪤 **The claim this replaces was overstated in its consequence** and the correction matters, because the
overstatement points at the wrong failure. The freed body could not actually be "drafted elsewhere, leaving
the hold permanently in CONFLICT" — `create_match_with_players`' Guard 2 counts `pending` **and**
`in_progress`, and the held draft's own `match_players` row is pending, so the RPC returns NULL. What
actually happens is worse and quieter: the body re-enters `fetchActivePool`, the engine spends a slot
seating them, the RPC returns NULL, `executeMatch` fails and the **slot loop breaks — the tick produces
zero matches**. Same chain migration `20260812000000`'s header describes for the unseating bug.

Coverage: `CC-CAN-HELD-01` / `CC-CAN-HELD-02` (`tests/integration/cross-court-realdb.test.ts`, both off the
existing `seedHeldDraft` fixture) and `CC-CAN-01..07` (`tests/unit/cancel-restore.test.ts`). **Negative-control
verified**, each half separately: deleting the drafted branch fails only `CC-CAN-HELD-01`
(`expected 'waiting' to be 'drafted'` — the bug verbatim); deleting the physical-truth skip fails only
`CC-CAN-HELD-02` (`expected 'waiting' to be 'playing'`). Both assert **pool admission**, not just the status
string, since it is `fetchActivePool` membership that drives the stall. `CC-CAN-05` is the arm no fixture can
reach — a player both playing and held-reserved must be *skipped*, never drafted — and it is exactly the
precedence a later refactor would invert. `F-cancel-2` now also pins `joined_at` as unchanged, which is the
column that made the RPC reuse tempting and wrong.

⚠️ What makes `CC-CAN-05` unreachable is a **conjunction of two guards in two migrations**, and citing only
the first is the mistake this paragraph exists to prevent. `create_match_with_players`' Guard 2
(`20260507000000`) covers an *ordinary* roster member. It does **not** cover the pulled body, because
`create_held_cross_court_match`'s own Guard 2 (`20260607000000`) deliberately **exempts** it ("the pulled body
is exempt — it IS in its `in_progress` match") — that exemption is the whole point of the held RPC. The guard
actually blocking the overlap is that RPC's **Guard 1b**, the reservation check that refuses a body already
named by another `pending` held draft (see the **Held RPC** bullet under §3.1 → *Cross-Court Diversity
Drafting (held drafts)*). A reader sent to `create_match_with_players`
finds no held-draft logic there, concludes the precedence is dead code, and deletes it — which is the exact
outcome `CC-CAN-05` was written to prevent. Lose *either* guard and the arm goes live.

⚠️ **Accepted, not fixed:** between the held-draft read and the `drafted` write, a concurrent
`clear_on_deck_match_atomic` can delete the draft and strand that player at `drafted` — invisible to
`fetchActivePool`, with no orphaned-`drafted` reconciler anywhere in `src/`. The identical window already
exists in R3-1, so this is parity rather than new risk; close it only if observed, and only with an RPC that
*replaces* the TS block rather than twinning it behind a fallback.

⚠️ **Same class, still open one file over:** `match-drafts.ts`'s `clearOnDeckMatch` PGRST202 fallback
reproduces the exact unguarded `update({ status: "waiting" }).in("player_id", …).neq("status", "left")` that
`20260812000000` removed from the RPC. On any environment where `clear_on_deck_match_atomic` is missing, the
Clear button on a held draft unseats a live body. Out of scope here — named so "we fixed the class" doesn't
stop the next reader looking.

#### Wiring the `published` event — CLOSED 2026-08-16 (was STANDING TO-DO **A0**)

**Files:** `src/lib/match-event-log.ts`, `src/app/actions/match-drafts.ts`, `src/app/actions/matchmaking.ts`,
`tests/unit/published-event.test.ts` **(new)**, `tests/unit/{publish-engine-trigger,publish-held-guard}.test.ts`.
**No migration** — `match_events` already accepts the kind and `record_match_event` already writes it, so this
is TypeScript only and is correct in production the day it merges. Contrast `20260816000000` above, which had
to be hand-applied first: this one cannot be half-shipped.

`logPublishedEvents` (in `match-event-log.ts`) owns the write; the five transitions call it and pass a
`reason`. It is deliberately one helper rather than five inline `logMatchEvent` calls, because the payload it
assembles is the part a per-site copy would drift on:

| site | reason | actor |
| --- | --- | --- |
| `publishMatchAction`, RPC `SUCCESS` | `publish_single` | organizer |
| `publishMatchFallback` (PGRST202) | `publish_single` | organizer |
| `publishAllDraftMatchesAction`, RPC path | `publish_all` | organizer |
| `publishAllDraftsFallback` (PGRST202) | `publish_all` | organizer |
| `recomputeHeldReadiness` → `auto_publish_match` `SUCCESS` | `auto_publish_held` | **engine** |

The RPC and its fallback share a `reason` on purpose: the transition is identical, and *which one ran* is a
property of the environment's migration state, not of the match. The fifth site is the one the brief did not
name and the one this whole section is about — it is the cross-court auto-publish path, so wiring only the two
organizer entry points would have left held drafts exactly as unrecorded as before.

- **`actor_type` is `engine`, not `system`, for the fifth site.** `logMatchEvent` derives the actor from the
  presence of an `actorId`, which yields `system` when there is none; that default is right for *an automatic
  consequence* and wrong here, because this is the matchmaker itself acting. The new `actorType` override
  exists for that one case. `engine` is not a new actor kind — `create_match_with_players` already writes it
  for every engine-made `created` event (`CASE WHEN p_origin = 'manual' THEN 'organizer' ELSE 'engine' END`,
  `20260617000000_match_provenance_audit`). Note the pair it contrasts is organizer/engine; that RPC never
  emits `system` at all.
- **`phase` is `"draft"`**, per the codebase convention that any `pending` match is a draft — spelled out at
  the `cancelled` call site inside `removePlayerFromQueue` (`src/app/actions/queue.ts`), which is where the
  rule is written down. The match is `pending` on *both* sides of this transition — publishing flips `is_published`,
  never `status` — so there is no phase to move to. The published/on-deck distinction lives in the payload.
- **The payload distinguishes the held path without needing a separate event kind.** It carries
  `created_method`, `is_held` and `held_ready_at` alongside the roster snapshot. `held_ready_at` (when the hold
  unlocked) against the event's own `created_at` (when it was published) is the interval the 08/15 post-mortem
  had no way to measure — the paragraph above spends five sentences establishing that prod records no publish
  time *at all*, and this is the column that ends that. All three are read *after* the write, which is safe
  for two different reasons and it matters which: `created_method` is immutable after insert, but the held
  pair is **not** — `recomputeHeldReadiness` downgrades a held draft whose pulled body left the roster by
  clearing `pulled_player_ids` (which drives the GENERATED `is_held`) and `held_ready_at`. Its *candidate
  query* filters `.is("held_ready_at", null)` while a held draft cannot publish until `held_ready_at` is
  stamped (`20260816000000`), so the two normally never see the same row — not because the columns are frozen.
  Be exact about the strength of that: the filter is on the SELECT, not on the downgrade's UPDATE, so it is a
  read-then-write and two overlapping recompute runs could still clobber a row published in between. The cost
  is one payload carrying a stale held triple. An earlier draft of this bullet claimed all three columns were
  simply stable, and its replacement said *by construction* — the weaker, true reason is the one that tells a
  later reader which line to keep. `is_published` is deliberately **absent** — post-write it is `true` for
  every row, so recording it would record nothing.
- **`ALREADY_PUBLISHED` writes nothing**, and it is the trap worth naming: it returns `success: true`. An
  "on success, log it" reading of the code stamps a second review onto a match nobody re-published. The two
  **fallback** paths have the same hazard without the error code: their UPDATE carries `.eq("is_published",
  false)`, so a concurrent publisher between the precondition read and the write makes it a silent no-op. Both
  therefore log off the UPDATE's own `.select("id")` RETURNING rather than off "no error" — `publishMatchFallback`
  was missing that `.select` and would have credited this organizer with the other one's transition; the review
  gate caught it. The batch RPC path drives its events from the *same re-read* that drives the on-deck push, so
  the ledger and the notification can never disagree about who was published — including on that re-read's
  known leak, which is *anything* a concurrent publisher flipped between this run's snapshot and the re-read,
  whichever of the three arms skipped it. The RPC returns counts, not ids, so nothing short of a new signature
  separates them; the residue is a duplicate row a few seconds after a real one, never a missing one. The
  opposite direction exists too and is equally benign: the snapshot excludes unready holds, so a hold stamped
  ready between the snapshot and the RPC is published by the RPC and gets neither the push (pre-existing) nor
  an event — under-recording, which is the bias the paragraph below already licenses.
- **Best-effort, matching every other call site**: the sequence is computed outside the row lock, the
  modification delta is 0 (already pinned by `MP-CNT-03`), and both the returned-`error` and the thrown-
  exception paths are swallowed with a `console.error`. Publishing is the user-facing mutation and it has
  already committed; failing the action here would report a false negative about a match that *is* published.
  ⚖️ **Accepted cost:** the audit is `await`ed inline, so it adds two serial round trips (`getActorContext`,
  then the batched provenance + roster read) to the publish response. The neighbouring *clear* path
  parallelizes its equivalent pair, but there the roster fetch is at the call site; here it lives inside
  `logPublishedEvents`, so matching that shape would mean threading a promise through the helper's signature.
  Awaiting is what every existing writer in `match-event-log.ts` does, and one consistent seam beats two round
  trips — revisit only if publish latency is ever measured as a problem, not on principle.

⚠️ **What a row does and does not prove, going forward.** A *present* `published` row is now proof the match
was published, which is the half that did not exist before. A *missing* one is still not proof of the
opposite, and never will be for the 08/15 corpus: there is nothing to backfill from — no `published_at`, and
`queue_status_events` was empty for that session. The ambiguity is closed for matches published from this
merge onward and permanently open behind it. Do not let a later reader collapse that into "the ledger records
publishes" and then reason backwards over old data.

⚠️ **A match *born* published is deliberately not logged.** `create_match_with_players` takes
`p_is_published`, and it has exactly **two** callers: `match-lifecycle.ts` (a literal `true` — a manual
on-deck match) and `matchmaking-db.ts` (`p_is_published: autoPublish`). Read that second one carefully: the
flag `executeMatch` receives is `effectiveAutoPublish = autoPublish || (bypassGate && i === 0)`
([`matchmaking.ts:827`](src/app/actions/matchmaking.ts:827)), **not** the session's `auto_publish` — so
`callNextMatch`'s slot 0 is born published in a *draft-mode* session too, for the reason spelled out at that
assignment (promotion only considers `is_published=true`; without it the primary button composes a match it
can never seat — verified live 08/06). Neither caller is a draft→published transition: the row was never a
draft an organizer released, and the `created` event already carries the fact. Adding a `published` row there
would make the two kinds mean different things at different call sites, which is precisely the drift that
makes an audit ledger unreadable.

🪤 **This one paragraph shipped two different false claims, and the second survived the fix for the first.**
Round 1 of the review gate caught "*three* callers", listing `swap-player.ts` as a re-creation forwarding the
original's `is_published` — both halves wrong, since that file calls the unrelated `swap_player_in_match`,
which swaps a roster slot in place, only *reads* `p_is_published` to choose the incoming player's queue
status, and creates no match. Round 2 then caught the rewrite's own gloss of `matchmaking-db.ts` as
"auto_publish sessions", which the `effectiveAutoPublish` line above falsifies — and which the code documents
*twice*, in the file the sentence is about. Two lessons, both already in this repo's ledger and both re-earned
here: **enumerate with a grep before writing a count, and check the RPC name, not just the argument name** (a
shared parameter is not a shared writer); and **a correction inherits the burden of proof it is enforcing** —
rewriting a sentence to fix one unverified claim is the single likeliest place to author the next one.

Coverage: `PUB-EVT-1..14` in `tests/unit/published-event.test.ts` — one per site, plus the negatives
(`ALREADY_PUBLISHED`, all six refusal codes, a `published_count > 0` the re-read cannot confirm, a refused
auto-publish, a fallback UPDATE that flipped no row) and the two best-effort arms. They assert at the
**`record_match_event` RPC boundary**, not at the `logPublishedEvents` seam, because "the helper was called"
is exactly the assertion that would have passed throughout the years the ledger was empty.
**Negative-control verified**: `git stash`-ing the two action files turns 8 of the 19 cases red — every
positive one — while the negatives stay green, which is the correct signature.

🪤 That control **cannot validate a negative test**, and `PUB-EVT-14` is the case that shows it. Stashing
removes the writer altogether, so every "writes nothing" assertion is satisfied trivially and stays green —
including the one guarding the `.select("id")` gate, which is the whole point of that test. It is pinned
instead by a *targeted* mutation: ungating the fallback log (`if (true)`) reddens `PUB-EVT-14` alone,
18 passed / 1 failed. **Match the mutation to the assertion** — deleting a feature only proves the tests that
assert the feature happened.

🪤 Two neighbouring suites (`publish-engine-trigger`, `publish-held-guard`) needed their `_shared` mock
completed with `getActorContext` and `@/lib/match-event-log` stubbed. The stub is not convenience: several of
their cases assert an exact `svc.from()` **call count** to pin query ordering, and the audit issues its own
reads. Any future work that adds a query to a publish path will trip those counts the same way.

---

### 3.42 Organizer notices — leave-queue + 15-minute pause reminder (2026-08-16)

**Files:** `src/lib/organizer-alerts.ts`, `src/hooks/use-organizer-alerts.ts`, `src/components/organizer/{organizer-center-alert,paused-badge}.tsx`, `src/lib/broadcast.ts` (`queue_notice`), `src/lib/realtime.ts`, `src/hooks/use-organizer-{session,data}.ts`, `src/app/actions/queue.ts`, `src/lib/constants.ts` (`PAUSE_REMIND_MINUTES`), migration `20260817000000_queue_leave_notices`.

A leaver **vanishes** from Match Control (`v_queue_full_with_wait_time` excludes `left`). The notice is what tells organizers who disappeared.

**Leave.** `checkoutPlayer` and `removePlayerFromQueue` emit `queue_notice` on the existing private `session-events:{id}` channel. Self-leave has no `actorId` — every open organizer dashboard shows a centered dismissible card. An organizer kick attaches `actorId`; that organizer's own client suppresses (they just confirmed the dialog). Copy: "{Name} left the queue", plus a line only when an **unpublished** draft was cancelled (a published on-deck teardown does not use that line). Already-left / not-in-session checkouts are silent.

**Pause reminder.** `queue_entries.paused_at` is stamped on pause and cleared on resume, self-leave, organizer remove, and rejoin. Each open dashboard computes `floor(minutes / 15)` locally (15s tick + queue refetch) and enqueues the same centered card at 15 / 30 / 45 …. An in-memory Set of `${playerId}:${bucket}` prevents a dismissed bucket from coming back. Resume clears that player's keys. The Match Control badge upgrades from "Paused" to "Paused 15m" (amber) / "Paused 30m" (red).

**Held-draft restore.** `checkout_player_cleanup_drafts` already restored only `status = 'drafted'` (hotfix `20260511210001`). The 20260817 replace keeps that contract and documents why: a held draft's pulled body stays `playing` and must not be written to `waiting`. The TypeScript fallback now mirrors the restore (it previously cancelled the draft and left the other three `drafted`).

**Not done:** Web Push to organizers; a persistent "left" list in Match Control. The on-deck / playing leave refusal is unchanged (§3.39). Inbox + player score-correction requests are §3.43.

### 3.43 Organizer notice inbox + player score correction (2026-08-16)

**Files:** migration `20260818000000_session_notifications`, `src/types/database.ts`, `src/app/actions/notifications.ts`, `src/lib/session-notifications.ts`, `src/hooks/use-organizer-alerts.ts`, `src/components/organizer/{organizer-notice-inbox,organizer-center-alert,edit-match-dialog}.tsx`, `src/components/player/{match-history,score-correction-request}.tsx`, `src/app/actions/{queue,match-lifecycle}.ts`.

**Inbox.** `session_notifications` is the durable log. Kinds: `player_left`, `player_checked_out`, `player_paused_long`, `score_correction`. Status: `unread` / `read` / `resolved` / `superseded`. Hydrate on Match Control load (`fetchSeq`). Live updates reuse `queue_notice` on private `session-events:{id}` (full row upsert). No sixth Realtime table channel — `realtimeConnected` stays at 5. A 45s visible-tab poll plus visibility refresh catch missed broadcasts.

**Center then inbox.** A new unread/pending row interrupts with the existing centered card (cap 5). Dismiss files it into the bell. Informational dismiss → `read` (badge drops). Score-correction dismiss stays pending — looking is not handling. Actor suppress is **only** for `player_checked_out` when `actorId` is this organizer.

**Uniques.** One pending score correction per `match_id`. One pause row per `(session_id, subject_player_id, payload.bucket)`. Unique violation → no second broadcast. Leave-after-rejoin is a new row. Q-8 already-left / not-in-session does not insert. Insert failure after a successful leave still broadcasts so the board is never silent.

**Pause catch-up.** `recordPauseReminder` re-reads `is_paused` / `paused_at` and recomputes the bucket server-side. A bucket that was already due when the tab hydrated inserts as `read` with `interrupt: false`. Only a bucket that crosses while the tab is open interrupts.

**Score correction.** Session history only (not all-time). Player form labels Team A/B with names and submits `team_a_score` / `team_b_score`. Organizer Review opens the existing Edit Match dialog, pre-filled with the proposal. `resolve_score_correction` is `SECURITY DEFINER`, `GRANT service_role` only, `FOR UPDATE`, CAS on `matches.status = 'completed'`. Resolve against a reverted match fails and **leaves the notice pending**. History pencil save closes pending as `resolved`; revert closes as `superseded`. Closed session: no new requests / pause inserts; bell is read-only.

**Writes.** Gated Server Actions (`list` / `markRead` / `recordPauseReminder` / `request` / `resolve`) use the service client after `isSessionOrganizer` (the primary organizer has no `session_organizers` row). `emitOrganizerNotice` and `closePendingScoreCorrections` live in `src/lib/session-notice-write.ts` (`import "server-only"`) so they are not public POST endpoints. Authenticated clients have SELECT on their own correction rows only — no INSERT grant (the pending-correction unique would otherwise be poisonable). `resolve_score_correction` is `REVOKE`d from `PUBLIC`, `anon`, and `authenticated` by name (default privileges would otherwise leave EXECUTE on the RPC). Do not `DROP` the RPC.

**Not done:** Web Push. Migration `20260818000000` is **applied on prod** (stamp `20260816065517`).

---

### 3.44 The audit trail nobody could read, and the four ways a test can be green without being a test (2026-08-18)

Three migrations in four days shipped a queryable object that **no test referenced even once**, and nothing anywhere went red. That is not three oversights; it is the absence of a gate. This section records the defect it hid, the five gates now in place, and — because it is the part that keeps being relearned — what each gate deliberately does *not* claim.

#### A. One missing GRANT, two opposite defects — and neither is the one the comment described

`20260815000000` created the audit table, enabled RLS on it, added no policy, and left a comment saying that reading it was fine because "only the service role (which bypasses RLS) can read it." Every clause of that sentence is true. The conclusion does not follow, and the table that shipped was not the table it describes.

**Bypassing RLS is not a substitute for a table privilege.** They are independent gates and the ACL is checked first. Since the migration granted nobody anything, what the table actually got was whatever `ALTER DEFAULT PRIVILEGES` happened to be in force — and **the two environments disagree**:

```
pg_default_acl, FOR ROLE postgres IN SCHEMA public, defaclobjtype 'r'
  production : anon=arwdDxtm  authenticated=arwdDxtm  service_role=arwdDxtm
  local      : anon=Dxtm      authenticated=Dxtm      service_role=Dxtm
```

Migrations run as `postgres`. So one grant-less `CREATE TABLE` produced two *opposite* defects from the same source line:

- **On a from-scratch replay** (`supabase db reset`, i.e. CI and every developer) the table has no `SELECT` for anyone. The trigger is `SECURITY DEFINER`, so the trail filled correctly from the first day and *every read of it answered `permission denied`* — before RLS, the control the comment believed in, was ever consulted. An audit trail nothing can query is not an audit trail.
- **On production** the same line handed `anon` and `authenticated` the full set — `SELECT, INSERT, UPDATE, DELETE, TRUNCATE`. Only RLS-with-zero-policies stands between an anonymous caller and rewriting the audit trail. That is a real defence and it does hold today; it is also **one `CREATE POLICY` away from not holding**, on a table whose entire purpose is to be trustworthy after the fact. Defence in depth was claimed in the comment; exactly one layer shipped.

**Neither environment matched the comment, and neither was going to complain.** The local half is loud but only to people running the suite; the production half is silent by construction, because nothing legitimate ever tries the writes that are wrongly permitted.

`20260818120000` states the privileges instead of inheriting them: `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, then `GRANT SELECT, DELETE TO service_role`. `SELECT` is the documented purpose; `DELETE` is retention — the highest-frequency mutation the app makes, and the table grows unbounded without it (§D). `INSERT`, `UPDATE` and `TRUNCATE` stay withheld: the only legitimate writer is the trigger, which needs no grant, so withholding them means no API caller — including one holding a leaked service key — can forge a transition, rewrite one, or drop the trail in a single statement. QSA-10 pins all of them, and asserts `42501` specifically rather than "some error", so it cannot pass for the wrong reason. The sibling written three days later, `20260818000000_session_notifications`, already did exactly this; the pattern existed and was simply not applied.

**The first draft of that fix reproduced the defect it was fixing, and the test agreed with it.** It revoked from `PUBLIC, anon, authenticated` — copying the sibling's role list verbatim — and left `service_role` out. A `REVOKE` only touches the roles it names, and a subsequent `GRANT SELECT, DELETE` is a no-op against a role that already holds `arwdDxtm`. So on production, the environment the fix exists for, the "withheld" `INSERT`/`UPDATE` would still have been held; only the `anon`/`authenticated` half would have landed. The sibling gets away with three roles because it ends `GRANT ALL … TO service_role` — it *wants* the default, so inheriting it is harmless. **Naming the role is required precisely when the intent is narrower than the default**, which is exactly when it is easiest to copy a precedent that had no such intent.

QSA-10 asserted `ins: false, upd: false` and stayed green through all of it, because the *local* default ACL (`Dxtm`) already withholds those. The case was agreeing with the environment, not with the migration — defect class B (impl-pinning) wearing the costume of a security test, inside the suite written to catch defect class E. What broke the tie is `TRUNCATE`: the inherited default grants it in **both** environments, so only an explicit `REVOKE` naming `service_role` takes it away. Measured, not argued — before the fix `has_table_privilege('service_role', …, 'TRUNCATE')` was `true` locally and the ACL read `service_role=rdDxtm`; after, `false` and `service_role=rd`. Mutant M19 in the suite header is that exact regression, and it kills QSA-10 alone. The generalisable rule: **an assertion that a privilege is absent proves nothing unless the environment would otherwise grant it** — pick the privilege the default hands out, not the one you care about.

✅ **APPLIED TO PRODUCTION 2026-08-19, stamp `20260819011750`** (repo file `20260818120000`; migrations here are applied by hand and the stamps drift). The over-permissive state was confirmed live immediately before the apply, not inferred from the default:

```
before  relacl = {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
                  authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
after   relacl = {postgres=arwdDxtm/postgres, service_role=rd/postgres}
```

So on production `anon` really did hold `SELECT, INSERT, UPDATE, DELETE, TRUNCATE` on a 29-row audit trail, with RLS-and-zero-policies as the only thing in front of it — and the end state now matches local byte for byte. Post-apply verification: `has_table_privilege('service_role', …)` is `SELECT`/`DELETE` true, `INSERT`/`UPDATE`/`TRUNCATE` false; `anon` and `authenticated` hold nothing at all; all 29 rows intact; `log_queue_status_change` still `SECURITY DEFINER`, owner `postgres`, `search_path=public, pg_temp`, trigger present — and `postgres` retains `INSERT`, which is what keeps the writer working after the REVOKE. No application code touches the table (only the type in `src/types/database.ts`), so nothing depended on the privileges that were removed. ⚠️ Verify a migration by **stamp**, never by build — the TypeScript is indifferent to whether it landed.

An `aclexplode` sweep of the whole schema confirmed this is the only relation in the local unreadable state, so the *defect* is isolated — but the *mechanism* is general, and §7 had already predicted it in prose — twice. The "Forward hazard" note states the rule (`grant select` on tables, `grant execute` on functions, after any `revoke`), and the "Landing order matters" paragraph immediately after it says a migration dated after `20260722000004` skips the whole-schema assertions entirely, so "the test file is the only thing that still catches it." For functions that was true. For tables it was **false**: `schema-parity.test.ts` checked `has_function_privilege` across the schema and `has_table_privilege` only against a hardcoded three-item denylist. A migration dated after `20260722000003_declare_table_grants` skips that migration's whole-schema `DO` block entirely, and `20260815000000` does. (`20260722000004` is the sibling that did the same for function `EXECUTE` — it is the one whose pattern the *function* half of `schema-parity` inherited, which is exactly why the function half was general and the table half was not.) **The prose describing the gate had drifted ahead of the gate** — the repo's most-repeated defect, found this time inside the section that documents it.

#### B. Five gates, and what each one refuses to claim

| Gate | Catches | Explicitly does **not** claim |
| ---- | ------- | ----------------------------- |
| `schema-parity` relation sweep | any relation in `public` the service role cannot `SELECT` — the local half of §A | that the grants are *correct* — only that reads are possible. There is deliberately no `relacl IS NOT NULL` filter: a NULL ACL is the owner-only default, i.e. the very "arrived with no grants" case |
| Suite MTC (`migration-test-coverage`) | a migrated table/view/function that no test **mentions** | coverage. It asserts the name appears on a non-comment line of a file that actually asserts — `*.test.ts(x)` or `*.spec.ts` only. Helpers, fixtures and factories are excluded on purpose: the first draft counted every `.ts` under `tests/`, which let a table be "covered" by its own line in `helpers/truncate.ts` — the routine first step for creating a table would have satisfied the gate meant to catch it. Narrowing the corpus immediately exposed three tables named nowhere else (`club_invites`, `co_organizer_join_attempts`, `match_games`), now grandfathered. Even so it is a tripwire for zero, nothing more, and the file says so |
| QSA-4 | the best-effort audit trigger silently doing nothing | it *proves* the swallow by forcing a constraint violation and asserting the checkout still succeeds with an empty trail — the only way to tell a broken `EXCEPTION WHEN OTHERS THEN NULL` from a quiet one |
| SN-12, QSA-11 | a `SECURITY DEFINER` object whose lock is only enforced by the TypeScript that happens to call it | that the wrapper is safe. They assert `prosecdef`, the pinned `search_path`, and that `anon`/`authenticated` hold no `EXECUTE` |
| CI type-check + lint | a documented gate that no machine ran | anything new — and **not** that the branch is protected. `npx tsc --noEmit` and `npm run lint` were mandatory in `CLAUDE.md` and executed by nothing; both now run in CI, *before* the tests, so a type error reports as a type error. They block a merge only once branch protection requires the job, and the required-check **context** changed. A GitHub Actions context is the job's `name:` — not the YAML key and not the workflow name — so the string that matters went `Vitest` → `Types, Lint, Vitest` (the key went `vitest` → `checks`, the workflow `Unit Tests` → `Static Checks + Unit Tests`; neither appears in Settings → Branches). A rule still requiring `Vitest` is pinned to a context that never reports. 🚨 And **there is no rule to re-point today**: the repo is private on a free plan, where branch protection and rulesets are unavailable — measured 2026-08-19, `gh api …/branches/main/protection` and `…/rulesets` both answer `403 "Upgrade to GitHub Pro or make this repository public"`. So nothing blocks a merge here at all, and nothing can until the repo goes public or the plan changes. The context note is what makes the eventual rule land on the right string, not a claim that one exists. **So the enforcement moved to where it can exist:** `.husky/pre-push` runs the same three checks in the same order (~17s: tsc 2s, lint 9s, unit 5s) and refuses the push on failure. Integration is excluded (needs a local Supabase; an env problem must not block a push) and E2E is excluded (it targets **production** — a git hook must never touch it). A local hook is weaker than a server-side gate: `--no-verify` skips it and it binds only this machine. It is what is available |

#### C. XC-4 — the lifecycle half

§3.41 fixed the publish path after 12 held drafts were generated in production and **none could be published**. The existing XC-1…3 covered generation and cancellation. XC-4 now runs the other half against a real DB: a draft is held, the three-minute rest elapses, `recomputeHeldReadiness` ripens it *on its own*, and `publish_match` accepts it. The lesson §3.41 banked — "un-shipped-dead at generation ≠ shipped alive" — only becomes enforceable once a test follows a row from birth to death.

#### D. Isolation debt this exposed

`truncateTracked()` did not wipe `queue_status_events`. Like `match_events`, it has no foreign key to `queue_entries` (`session_id` / `player_id` are plain `uuid` columns), so deleting the queue rows cannot cascade it — and its trigger fires on every status change *any* suite makes, so it grew for the entire run. Adding the wipe is what first surfaced the missing grant, as `permission denied` in an unrelated suite's teardown.

**A failed teardown is not a local failure.** When the wipe aborted, the `profiles` delete after it never ran, the deterministic faker names collided with the survivors on `idx_profiles_unique_active_name`, and the *next* run's first test failed inside `makeProfile` with a message about auth users. The visible error was three layers away from the cause.

**The same hole existed in the E2E path, which runs against production.** `tests/helpers/teardown.ts` already deletes `match_events` explicitly, with a comment recording the 171 sandbox rows that accumulated in a production table between 2026-07-02 and 2026-08-03 — roughly 36 per full-suite run — precisely because nothing cascades it. `queue_status_events` has the identical shape and a trigger that fires on *every* status transition the harness makes, including the ones `repairSandboxState` writes when it drives `playing`/`drafted`/`on_deck` back to `waiting`. Both cleanup paths (`resetSandboxSession`, `softResetSandboxSession`) now delete it scoped by `session_id`, and `validate-cleanup.mts` counts it — without that count the validator reports "fully clean" over a table that only grows. Production held 29 rows at the time of writing, all from the 2026-08-16 manual close of the 08/15 session and none from E2E, so this was fixed **before** it leaked rather than after. Unlike the integration-side wipe, this needs no migration first: production already has the privileges the delete requires (that is the §A production half, restated from the other side).

**Isolation debt this creates, stated so it is not a surprise.** `truncateTracked()` now hard-couples **24 of the 27** integration files to `20260818120000`: on a local database where it has not been applied, their `afterEach` throws `permission denied` and every one of them fails, not just this suite. The three that do not call `truncateTracked`/`truncateAll` — `auth.real.test.ts`, `draft-cap-override.test.ts` and `schema-parity.test.ts` — stay green on a stale DB, so a green run of *those alone* is not evidence the migration is applied. Failing loud, at the first run, with the table named is the correct direction; but a stale local DB must be re-reset before the full suite will pass.
