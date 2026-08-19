# APP_MANIFEST.md — Badminton Queue & Matchmaking App

### The Living Document · Principal Tech Lead Reference

---

## ⚠️ HOW TO USE AND UPDATE THIS FILE

> **Read it through `DOC_INDEX.md`, never end-to-end.** This file is ~340 KB. Reading it whole
> costs more context than the code it describes, and the harness truncates it silently.
>
> **Update the relevant section in place when** a feature is added/changed/removed; a table,
> column or enum is altered; a Server Action, RPC or route is created; a design rule changes;
> or a constant in `src/lib/constants.ts` moves.
>
> **What belongs here:** how the app works **right now**, in the present tense.
>
> **What does not:**
>
> - **Dated headings.** A `### 3.x Something (2026-08-15)` is a defect in this file. A dated
>   write-up — how a bug was found, what was tried, what a review round said — goes in
>   `docs/incidents/YYYY-MM-DD-slug.md`. Thirty-one of them were moved out on 2026-08-19.
> - **A changelog at the bottom.** Six sections had been appended below §11, after this very
>   rule was written. If you are adding to the end of this file, you are in the wrong file.
> - **Counts stated in prose.** Write the command that produces the number, not the number.
>   `grep -c` in a sentence is a claim that goes stale the next commit; the command does not.
> - **Line numbers.** Cite a symbol, a file, or a section — never `file.ts:412`.
>
> **When you correct a claim here, verify the new claim to the same standard you are enforcing.**
> The most-repeated defect in this repo is prose that explains *why*, rewritten by paraphrase
> until it is false while the code it describes stayed correct.

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
| `compute_session_wrapped(p_session_id)`                 | Computes and upserts all `session_wrapped_stats` for a session. Redefined by `20260704000000` (deuce_magnet threshold 20-20 → 30-30 — scoring is sudden-death to 31, so 30-30 is the real drama point) and `20260704000001` (awards one-time `first_to_100` via an atomic `club_milestones` claim; only the claim-winner ever gets the slug). Declared in full by `20260810000000`; `20260811000000` then made the six all-time-threshold awards one-time via a `_prior_awards` ledger (§3.7.1); `20260820000000` bounded every cross-session read to the session's own end (§3.7.2); `20260821000000` dropped hidden sessions from the prior-session set (§3.7.3). |
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
- `refresh_cross_session_stats(p_session_id UUID)` RPC — **rebuilds** both ledger tables for the club that owns `p_session_id`, from that club's complete match history, then prunes ledger rows no match backs. `p_session_id` is now only a pointer to the club. Called in `closeSession()` before `compute_session_wrapped`. Non-fatal to the **close**: failure logs a warning and `is_active` still flips. It is *not* non-fatal to Wrapped — see the stale-ledger note below.

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

  ⚠️ Consequence for `compute_session_wrapped`: since `20260820000000`, `rivalry_with_tonight` derives every figure as `ledger - since + tonight`, where *since* is scanned from `matches` and covers this session **and everything after it** (§3.7.2). The stored ledger must therefore already include the session being computed — more strictly than before, not less: *since* counts tonight from `matches` regardless, so a ledger that has not yet absorbed tonight is subtracted below truth rather than merely left short. That is exactly why the refresh RPC runs first in `closeSession()`. There is no in-flight compensation if the ledger is stale — the two RPCs take **different** advisory keys (`cross_session_stats:` vs `wrapped_awards:`), so the `await` between them is the only ordering, and a refresh that times out is not retried. What `closeSession()` does instead is **withhold the signal**: if compute succeeded but the refresh did not, it logs and forces `wrappedReady = false`. The `session_wrapped_stats` rows are still written — a missing row makes the intro replay on every future visit, and `fixPlayerRecord` is the only other compute call site, so nothing recomputes on its own — but `useSessionClosedWatcher` routes players to the club lobby rather than to a Wrapped whose cross-session awards silently omit the session that just ended. Pinned by CST-5.
- `compute_session_wrapped` extended with section 2b: `_cross_session_stats` temp table (14 CTEs joining `player_rivalries`, `player_partnerships`, and prior `session_wrapped_stats`). All columns use `cs_` prefix to avoid collision with `_wrapped_stats` columns. FOR loop joins both temp tables.

**Delivery pipeline**: Organizer closes session → `refresh_cross_session_stats` RPC → `compute_session_wrapped` RPC (with 600ms retry) → `session_closed` broadcast fires → all connected players redirect to `/wrapped/{sessionId}/{playerId}` automatically. The broadcast carries a `wrappedReady` flag, and the whole pre-compute step runs under **one shared deadline** (`CLOSE_WRAPPED_PHASE_MS`, `sessions.ts` → `startPhaseBudget`) rather than a ceiling per call, so the ledger refresh, the compute and its retry — plus the backoff between them — cannot sum past the serverless budget the ceiling exists to protect. A call reached with the budget already spent is **fired but not awaited**: postgres landing the rows late beats never landing them. Neither RPC can strand an open session; a false flag redirects to the club lobby instead of to Wrapped. Pinned by CST-6.

🚨 **Recomputing an old session is NOT safe today — a stored wrap is a snapshot of the rules as they were, and the current RPC cannot always reproduce it.** **Five** independent causes, all measured on prod 2026-08-11:

1. **Tightened definitions.** `20260704000000` raised the `deuce_magnet` threshold from 20-20 to 30-30. Wraps written before that date were computed under the looser rule, so they hold grants the live code will not re-issue — on `Saturday 05/23`, **39 of 40 wraps** carry `deuce_magnet` but only 4 of that session's 56 matches now qualify, and the award needs 3 per player. A recompute strips it from all 39.
2. **The rivalry ledger is incomplete** (described above) — the genuinely rivalry-derived awards (`redemption_arc`, `settled_the_score`, `nemesis_slayer`, `the_dynasty`, all reaching `player_rivalries` through `rivalry_with_tonight`) shuffle when rows are missing or short.
3. ✅ **CLOSED by `20260820000000` — the rivalry ledger had no as-of date, a *separate* defect from being incomplete.** `rivalry_with_tonight` is `(pr.wins_vs - COALESCE(tvr.tonight_wins,0)) AS pre_wins_vs` over the **present-day cumulative** row — it subtracts *tonight* and nothing else. So replaying a May night today treats every June-to-August head-to-head result as "pre-tonight history", and `score_settled`'s `pre_losses_vs > pre_wins_vs` test is evaluated against a rivalry that had not happened yet. Measured by rebuilding the ledger twice from `match_players`, both **complete**, differing only in whether post-05/23 sessions are included: net grant delta `redemption_arc +4 · serial_rivals +4 · settled_the_score +3 · the_dynasty +3 · nemesis_slayer +2`, every other slug 0. ⚠️ **The delete-then-recompute form of the upstream fix proposed above does not close this one.** Both ledgers in that A/B were *complete* — which is exactly what a per-session rebuild produces — and 16 grants still moved. Completeness does not confer as-of-ness. Completeness does not confer as-of-ness. What closes it is date-bounding `rivalry_with_tonight` itself, which is what shipped — **not** the per-session ledger rows this document used to point at, and not re-deriving the figures from `matches` (that would put a second definition of one quantity in a second file with nothing keeping the two in step, on the path of every wrap rather than the rare one). Together causes 2+3 accounted for **5** of the 05/23 losses and all 14 ledger-mediated gains. See §3.7.2 for the shipped rule.
4. ✅ **CLOSED by `20260820000000` — "prior session" was defined by `computed_at`, with no chronological cutoff.** `bounced_back` and `consistent_dominator` gate on `cs_prior_last_win_pct` / `cs_prior_dominant_sessions` from `prior_sessions` (which reads `prior_sessions_ranked`), and `momentum` on `prior_carry` — all over `session_wrapped_stats`. Be careful with the mechanism here — the intuitive "recomputing re-stamps `computed_at` and so redefines which session is prior" is **wrong for the session being recomputed**: the CTE is `WHERE session_id != p_session_id`, so a session is excluded from its own prior set and re-stamping its own rows cannot move its own gates. What actually moves them is that the window is `ROW_NUMBER() OVER(PARTITION BY player_id ORDER BY computed_at DESC)` with `rn<=2` and **no upper bound on the date** — so "prior" silently means "**that player's** two most recently *computed* nights", not "the two nights before this one". (`momentum` reaches the same place by different SQL: `prior_carry` is `DISTINCT ON(player_id) … ORDER BY computed_at DESC` with no `rn` window at all, i.e. effectively `rn=1`.) It is per player, not a single club-wide pair: across 05/23's 40 players those top-2 windows span **16 distinct sessions** (most common `07/25` for 8 players; many players who stopped attending still have May priors). Measured: **25 of 40** players' `cs_prior_last_win_pct` differs between the two readings, and **7** have a "prior" session that did not exist when the wrap was written. Note `cs_prior_dominant_sessions` counts `win_pct>=70` only *within* that top-2 window, so it maxes out at 2. Note also that — unlike `_prior_awards` — this CTE has **no `is_hidden` filter**, so a hidden session's wrap can serve as someone's "prior"; latent only, as 0 of the 26 sessions with wraps are hidden today. (The re-stamp was a real hazard, just a cross-session one: recomputing an old wrap re-stamped it to the head of the ordering used by *every other session's* computation — for the players who appear in that wrap, which is the only partition it can reach.) Both CTEs are now bounded to sessions that **started** before the one being wrapped and ranked by `sessions.created_at DESC, session_id DESC`, so `computed_at` no longer orders anything and re-stamping is inert. The missing `is_hidden` filter noted above was closed separately by [20260821000000](supabase/migrations/20260821000000_prior_sessions_exclude_hidden.sql) (§3.7.3), which is why it is a second migration and not a ninth substitution in the first: it is a question about which wraps count, not about which of them came first, and folding it in would have moved numbers `20260820000000` asserts are unchanged.
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

#### 3.7.2 A wrap is as of its own session (migration `20260820000000`)

`player_rivalries` and `player_partnerships` are running totals with **no time dimension** — there is no "as of" column and no way to ask either table what it held in May. `compute_session_wrapped` nonetheless needs a "before tonight" figure, and it used to recover one by subtracting tonight back out of the present-day row:

```
pre_wins_vs = pr.wins_vs - tonight_wins
```

That is correct only while the ledger contains nothing **after** the session being wrapped — true for the ordinary close, and the reason this never produced a wrong badge on production (re-derive the evidence with the query in the migration header; it read 28 wrapped sessions, 0 computed out of chronological order, 0 overlapping sessions in a club, on 2026-08-20). It stops being true the moment anything recomputes an *old* session's wrap, and [fix-player-record.ts](src/app/actions/fix-player-record.ts) does exactly that: after an organizer corrects a roster it fires the RPC on any closed session, however long ago. That is the only caller that ever runs the RPC on a session which is not the club's newest.

**The shipped rule — one sentence, and it covers every cross-session column:** every figure is `ledger - since + tonight`, where *since* is scanned from `matches` and spans **this session and everything after it**. Where a column should exclude tonight, the `+ tonight` is simply omitted (`pre_wins_vs = ledger - since`). Four new CTEs supply the window — `since_matches`, `since_vs_rival`, `since_with_partner`, `tonight_with_partner` — and `since_matches` reuses the exact predicate set of [20260812100000](supabase/migrations/20260812100000_refresh_cross_session_stats_absolute_rebuild.sql) (`club_id`, `is_hidden = false`, `status = 'completed'`, both scores non-null) so the two definitions of "a match that counts" cannot drift apart.

- **Why subtract rather than re-derive from `matches`.** Re-deriving would place a second definition of one quantity in a second file with nothing keeping the two in step — this repo's most-repeated defect — and would put it on the path of *every* wrap to serve the rare one. Subtraction keeps `refresh_cross_session_stats` the single author of what the ledger means.
- **`20260812100000`'s rejection of subtraction does not apply here.** That header rejected subtraction against an **additive** ledger, where you had to trust the running total already contained the session exactly once. The ledger is now an absolute rebuild, so `pr.wins_vs` is exact by construction and the subtraction is arithmetic rather than faith.
- **The ordinary path is a strict no-op.** When the session being wrapped is the club's latest, *since* is exactly tonight, so `ledger - since + tonight = ledger` and every column holds the value it holds today. Nothing about a normal close changed.
- **It also retires a hazard the ledger rebuild introduced.** `20260812100000` warned that its new `is_hidden` predicate could drive `pre_wins_vs` negative if a hidden session were ever closed. *Since* now carries the same predicate as the ledger, so the two agree by construction and the subtraction cannot overshoot.
- **"Previous session" was fixed in the same pass**, because it is the same defect wearing different SQL — see cause 4 above. `prior_sessions_ranked` and `prior_carry` both meant "any other session of the club, most recently **computed** first"; both now mean "sessions that started before this one, most recent **first played**", tie-broken on `session_id`. This one was found by the replay harness rather than by reading: with the ledger fix alone, `redemption_arc` and `settled_the_score` stopped drifting on a recomputed old session and `bounced_back` still did.

**Not in scope, deliberately.** `refresh_cross_session_stats` is untouched. Hidden sessions counting as prior sessions is cause 4's remaining half and ships as its own migration (§3.7.3). No historical wrap is recomputed — the stored rows keep the awards their players have already seen, and the five causes above still mean a recompute of an old session is not guaranteed to reproduce it; this closes two of the five.

**Authoring note.** Generated by [scripts/gen-wrapped-as-of-migration.py](scripts/gen-wrapped-as-of-migration.py) from the body declared in `20260811000000`, verified equal to production's `prosrc` by md5 before generating. Eight anchored substitutions, each of which must match exactly once or the generator aborts; it also asserts that exactly two ledger reads survive and that the non-ASCII count is unchanged (`apply_migration` strips non-ASCII from stored function bodies, so added in-body text must be ASCII). **Never hand-edit the body** — edit the substitutions and re-run.

**Applied to production 2026-08-20**, stamp `20260820000000`, resulting body md5 `d459753ba1501da34691de5c00979a3d` (52094 chars). Because of that non-ASCII strip — this body carries 35, including an em dash inside player-facing award copy — the apply channel is **server-side reconstruction** through `execute_sql`, not `apply_migration`: a DO block reads production's own `pg_proc.prosrc`, replays the anchored `replace()` calls there, asserts each anchor matched exactly once and that the rebuilt md5 equals the target, and only then issues `CREATE OR REPLACE`. Every check raises before the DDL, so a failed run applies nothing and a re-run is a no-op. Emit the script with the generator's `--apply-sql` flag; the shared emitter is [scripts/_wrapped_apply_sql.py](scripts/_wrapped_apply_sql.py). ⚠️ `CREATE OR REPLACE` rewrites `proconfig` wholesale, so the CREATE preamble is derived from the baseline instead of retyped, and `search_path=public, pg_temp` is re-read after each apply — dropping `pg_temp` passes every test, because the body's four TEMP tables resolve regardless of `search_path`.

**Verified before shipping**, offline and at zero production risk: all 142 migrations replayed into a bare `supabase/postgres:17.6.1.143` container, the two-night scenario driven through real `closeSession` + recompute, and the wrap diffed against the one computed that night. Against the pre-migration body three awards appeared that were not true on the night played (`redemption_arc`, `settled_the_score`, `bounced_back`); against this one the recomputed wrap is identical. Suites XS-5 and XS-6 pin both directions.


#### 3.7.3 A hidden session is nobody's previous night (migration `20260821000000`)

Three CTEs in `compute_session_wrapped` read `session_wrapped_stats` to answer "what happened before tonight". `_prior_awards` — the one-time-award ledger from `20260811000000` — has filtered `sessions.is_hidden` since the day it was written. `prior_sessions_ranked` and `prior_carry` did not, so a hidden session's wrap could be somebody's previous night. That is an inconsistency between three readers of one table, not a product rule anyone chose.

It reaches **three** awards over those two CTEs, because `prior_sessions_ranked` feeds two of them. The `prior_sessions` CTE over it emits both `cs_prior_dominant_sessions` (→ `consistent_dominator`) and `(array_agg(win_pct ORDER BY rn))[1] AS cs_prior_last_win_pct` (→ `bounced_back`); `prior_carry` emits `cs_prior_win_streak` (→ `momentum`). A 3-0 infrastructure session is a 100% night and a 3-game streak — everything the first two gates want — and the 0-3 side of that same night is the sub-50% record the third gate wants to see you bounce back from. Read the gates out of the function rather than trusting this list: `select prosrc from pg_proc where proname = 'compute_session_wrapped'`.

- **Why it is a separate migration.** `20260820000000` asserts that the ordinary close is a strict no-op and was verified against a replay that reproduces stored wraps exactly. A filter that removes rows from the prior-session set cannot make that promise in general, so folding it in would have weakened a claim that is worth keeping sharp. Chaining also lets the generator pin the *post*-`20260820000000` body by md5, which is what stops it from silently reverting the as-of bound.
- **Why now, when the manifest had it deliberately open.** Measured on production 2026-08-20: 30 sessions, 28 hold wraps, 2 are hidden, **0 hidden sessions hold a wrap**. On that data the migration cannot change a stored award — it is provably inert, and the assertion is a one-line query anyone can re-run. Once a hidden session does accumulate a wrap, the identical change silently revokes badges from players who can already see them. The window is open now and closes on its own.
- **What is still not in scope.** Which sessions get hidden, and whether hiding one should retroactively drop its wraps. This bounds the read only.

**Authoring note.** Generated by [scripts/gen-prior-sessions-hidden-migration.py](scripts/gen-prior-sessions-hidden-migration.py), chained off the body `20260820000000` declares rather than off the `20260811000000` baseline — generating from the older body would silently revert the as-of bound. Two anchored substitutions; the generator also asserts that four `is_hidden` filters exist afterwards, that both `created_at<v_session_start` bounds survived, and that the non-ASCII count is unchanged. **Apply strictly after `20260820000000`.**

**Applied to production 2026-08-20**, stamp `20260821000000`, resulting body md5 `8553a297ff79a81929ce1b8fb416c49b` (52140 chars), through the same reconstruction channel as §3.7.2 and immediately after it. Verified against production data inside rolled-back transactions rather than on the strength of the local suite: recomputing the newest session changed **0** award rows, and a probe that hid every other session dropped `bounced_back`, `consistent_dominator` and `momentum` to none for that night — which is how the third award came to light, since XS-7 asserts only the other two. Stored rows and grant counts were re-read afterwards and are unchanged, confirming every probe rolled back.

**Pinned by Suite XS-7**, which fails against the pre-migration function (`consistent_dominator` and `momentum` both appear from a hidden night), and **XS-8**, its counterweight: the same two nights with the first left visible must still award both, so a filter that emptied the CTEs instead of bounding them cannot pass. **XS-9 and XS-10** are that same pair for `bounced_back`, and need their own fixture rather than another assertion on XS-7's: that award wants the *opposite* prior night — a win_pct below 50, where `consistent_dominator` wants tonight's at or above 70 — so the teams swap between the two nights and the player under test is the one who lost the first.

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

### 3.23–3.44 Incident write-ups (moved out of this file)

These sections were dated narrative — *how a specific bug was found and fixed on a specific
day* — not a description of how the app works. They now live in `docs/incidents/`, one file
each. **Do not re-inline them.** If a fix changed durable behaviour, that behaviour belongs
in the relevant §3.x feature section above, in the present tense.

| § | Date | Write-up |
|---|---|---|
| 3.23a | 2026-06-17 | [3.23a Match Provenance & Modification Audit](docs/incidents/2026-06-17-match-provenance-modification-audit.md) |
| 3.23 | 2026-06-02 | [3.23 Security Hardening & Quality Improvements](docs/incidents/2026-06-02-security-hardening-quality-improvements.md) |
| 3.24 | 2026-06-26 | [3.24 Player-Specific Session History Filter](docs/incidents/2026-06-26-player-specific-session-history-filter.md) |
| 3.25 | 2026-07-21 | [3.25 Repeat-Pairing Warning — manual match builder](docs/incidents/2026-07-21-repeat-pairing-warning.md) |
| 3.26 | 2026-07-28 | [3.26 Session Resilience + Queue Transitions (2026-07-28 — the 07/25 incident fixes)](docs/incidents/2026-07-28-session-resilience-queue-transitions.md) |
| 3.27 | 2026-08-04 | [3.27 The `realtime:` topic prefix — every private broadcast silently discarded](docs/incidents/2026-08-04-the-realtime-topic-prefix.md) |
| 3.28 | 2026-08-04 | [3.28 `draft_cap_phase` moved server-side — the co-organizer lockout actually works now](docs/incidents/2026-08-04-draft-cap-phase-moved-server-side.md) |
| 3.29 | 2026-08-04 | [3.29 `useFlipList` — a gated commit was wiping the FLIP baseline](docs/incidents/2026-08-04-usefliplist.md) |
| 3.30 | 2026-08-10 | [3.30 Closure fallback + the draft firewall extended to rosters](docs/incidents/2026-08-10-closure-fallback-the-draft-firewall-extended-to-rosters.md) |
| 3.31 | 2026-08-11 | [3.31 Session close — three delivery paths, one destination decision](docs/incidents/2026-08-11-session-close.md) |
| 3.32 | 2026-08-12 | [3.32 Consecutive-opponent freshness — the engine now previews the split before choosing the four](docs/incidents/2026-08-12-consecutive-opponent-freshness.md) |
| 3.33 | 2026-08-12 | [3.33 FRESH chips — the green half of the manual-match picker](docs/incidents/2026-08-12-fresh-chips.md) |
| 3.34 | 2026-08-12 | [3.34 `isRedZonePlayer` — the score threshold was never the Red Zone condition](docs/incidents/2026-08-12-isredzoneplayer.md) |
| 3.35 | 2026-08-13 | [3.35 The broadcast policy is now tested for what it REFUSES](docs/incidents/2026-08-13-the-broadcast-policy-is-now-tested-for-what-it-refuses.md) |
| 3.36 | 2026-08-13 | [3.36 Why display names stay in broadcast payloads](docs/incidents/2026-08-13-why-display-names-stay-in-broadcast-payloads.md) |
| 3.37 | 2026-08-13 | [3.37 The tenancy audit is fully dispositioned — and why the labels mattered](docs/incidents/2026-08-13-the-tenancy-audit-is-fully-dispositioned.md) |
| 3.38 | 2026-08-13 | [3.38 Two unbound write paths + eight unordered guards across seven sites — auditing the *shape* instead of the symptom — ✅ SHIPPED + DEPLOYED (PR #64 → `main` `8f4cb78`)](docs/incidents/2026-08-13-two-unbound-write-paths-eight-unordered-guards-across-seven.md) |


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
| `cross-session-ledger.test.ts`| XS | **The rivalry/partnership ledgers rebuild, they do not accumulate**: re-running the refresh for an older session leaves every semantic column unchanged, even once the guard has decayed (XS-1); a session that was never closed is folded in by the next close (XS-2); hidden sessions never reach the ledgers (XS-3); a row no match backs is pruned (XS-4). XS-1/2/4 fail against the pre-`20260812100000` function. **Also the ledgers' as-of rule** (§3.7.2): recomputing an old session's wrap does not import the future into it (XS-5, fails against the pre-`20260820000000` function), and a genuine cross-session comeback is still awarded on the night it happens (XS-6, the guard that the widened subtraction did not simply delete the feature). **And that a hidden session is nobody's previous night** (§3.7.3): XS-7 fails against the pre-`20260821000000` function, XS-8 is its guard that the filter did not empty both CTEs instead, and XS-9/XS-10 are that same pair for the third award the filter reaches, `bounced_back` |
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

### 11.1–11.8 Multi-tenant incident write-ups (moved out of this file)

Dated write-ups from the multi-tenant rollout. The durable rules they established are in
§11 above and in `src/lib/clubs.ts`.

| § | Date | Write-up |
|---|---|---|
| 11.1 | 2026-07-01 | [11.1 Security audit — club-scoped RLS + credential-leak closure](docs/incidents/2026-07-01-security-audit.md) |
| 11.2 | 2026-07-01 | [11.2 Identity-migration club scoping + OAuth club-scoped sign-in](docs/incidents/2026-07-01-identity-migration-club-scoping-oauth-club-scoped-sign-in.md) |
| 11.3 | 2026-07-01 | [11.3 Leave-club / member-management](docs/incidents/2026-07-01-leave-club-member-management.md) |
| 11.4 | 2026-07-02 | [11.4 Club-scoped Wrapped route](docs/incidents/2026-07-02-club-scoped-wrapped-route.md) |
| 11.5 | 2026-07-02 | [11.5 Hardened SECURITY DEFINER views](docs/incidents/2026-07-02-hardened-security-definer-views.md) |
| 11.6 | 2026-07-02 | [11.6 Task #56 resolved — `search_path` hardening + remaining advisory triage](docs/incidents/2026-07-02-task-56-resolved.md) |
| 11.7 | 2026-07-05 | [11.7 Platform-owner model + club-scoped landing](docs/incidents/2026-07-05-platform-owner-model-club-scoped-landing.md) |
| 11.8 | 2026-07-23 | [11.8 `profiles_select` scoped to shared scope — tenancy audit #8](docs/incidents/2026-07-23-profiles-select-scoped-to-shared-scope.md) |


### 3.39–3.44 (late incident write-ups, formerly appended below §11)

⚠️ These six were appended to the **bottom** of this file, after §11, in violation of its own
rule against a changelog at the end. They are now in `docs/incidents/` with the rest.

| § | Date | Write-up |
|---|---|---|
| 3.39 | 2026-08-15 | [3.39 A player can no longer self-leave from a live match — the refusal, and the TOCTOU window under it](docs/incidents/2026-08-15-a-player-can-no-longer-self-leave-from-a-live-match.md) |
| 3.40 | 2026-08-15 | [3.40 Losing the score race gracefully, and un-breaking the repeat score edit](docs/incidents/2026-08-15-losing-the-score-race-gracefully-and-un-breaking-the-repeat.md) |
| 3.41 | 2026-08-16 | [3.41 Publishing a held cross-court draft — refused while it held, wrongly allowed while it rested; no code meant "not yet"](docs/incidents/2026-08-16-publishing-a-held-cross-court-draft.md) |
| 3.42 | 2026-08-16 | [3.42 Organizer notices — leave-queue + 15-minute pause reminder](docs/incidents/2026-08-16-organizer-notices.md) |
| 3.43 | 2026-08-16 | [3.43 Organizer notice inbox + player score correction](docs/incidents/2026-08-16-organizer-notice-inbox-player-score-correction.md) |
| 3.44 | 2026-08-18 | [3.44 The audit trail nobody could read, and the four ways a test can be green without being a test](docs/incidents/2026-08-18-the-audit-trail-nobody-could-read-and-the-four-ways-a-test-c.md) |

