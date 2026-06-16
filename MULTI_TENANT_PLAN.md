# Multi-Tenant SaaS Migration Plan

> **Status:** Architectural design document — NO CODE HAS BEEN WRITTEN.
> **Author:** Generated via codebase investigation, June 2026.
> **Scope:** Transitioning from a single-organizer/single-group model to a multi-club SaaS model.
> **Infrastructure constraint:** Vercel Hobby (Free) tier — all architectural choices must stay within free-tier limits.

---

## Table of Contents

1. [Current Architecture Audit](#1-current-architecture-audit)
2. [Target Architecture](#2-target-architecture)
3. [Routing Strategy](#3-routing-strategy)
4. [Data Model Changes](#4-data-model-changes)
5. [Isolation Strategy](#5-isolation-strategy)
6. [What Will Break](#6-what-will-break)
7. [Known Risks & Mitigations](#7-known-risks--mitigations)
8. [Implementation Sequencing](#8-implementation-sequencing)
9. [Database Migration Checklist](#9-database-migration-checklist)

---

## 1. Current Architecture Audit

### 1.1 The Honest RLS Baseline

**Critical finding:** Row Level Security (RLS) is **NOT enabled** on any of the core application tables.

| Table            | RLS Enabled? | Isolation Today |
|------------------|-------------|-----------------|
| `profiles`       | ❌ No        | Application layer only |
| `sessions`       | ❌ No        | Application layer only |
| `courts`         | ❌ No        | Application layer only |
| `matches`        | ❌ No        | Application layer only (Draft Mode has an inline SELECT policy for `is_published`) |
| `queue_entries`  | ❌ No        | Application layer only |
| `match_players`  | ❌ No        | Application layer only |
| `push_subscriptions` | ✅ Yes  | RLS active |
| `identity_migrations` | ✅ Yes | RLS active |
| `player_rivalries` | ✅ Yes    | RLS active |
| `player_partnerships` | ✅ Yes | RLS active |
| `session_wrapped_stats` | ✅ Yes | RLS active |

**What this means for the migration:** The current application enforces data isolation exclusively through:
- Server Actions that scope every query to `session_id`
- `createServiceClient()` (service-role) bypassing RLS for all mutations — intentional, by design
- `createServerSupabaseClient()` (user-context) used for auth checks only

Adding `club_id` scoping to the database without simultaneously hardening every Server Action creates a **false sense of security** — service-role queries will still reach across club boundaries unless the application code explicitly filters by `club_id`. **Application-layer isolation must be implemented first; RLS is a hardening layer that can be added later.**

### 1.2 Authentication Model

- Anonymous auth (Supabase) via name + 4-digit PIN
- Optional Google OAuth (linked via `linkIdentity`)
- UUID identity (`auth.users.id` = `profiles.id`) — reconnect migrates the UUID with `migrate_player_identity()`
- PIN reconnect is a **global name+PIN lookup** — no session or club scope

### 1.3 Current Session Scoping

`session_id` is today's universal isolation key. All child data flows through it:

```
sessions
  └─ courts (session_id)
  └─ queue_entries (session_id + player_id)
  └─ matches (session_id)
       └─ match_players (match_id)
       └─ match_games (match_id)
  └─ session_organizers (session_id + user_id)
  └─ session_wrapped_stats (session_id + player_id)
```

`profiles`, `player_rivalries`, `player_partnerships`, and `v_alltime_leaderboard_mat` are currently **global** — no session scope.

### 1.4 Global State (Leaderboards, Rivalries, Partnerships)

These accumulate globally across all sessions and have no club boundary today:

| Object | Type | Conflict Target | Club-Scoped? |
|--------|------|----------------|-------------|
| `v_alltime_leaderboard_mat` | Materialized view | — | ❌ Global |
| `player_rivalries` | Table | `(player_id, rival_id)` | ❌ Global |
| `player_partnerships` | Table | `(player_id, partner_id)` | ❌ Global |
| `getPlayerStats()` in leaderboard.ts | Server Action | Queries matview with `.maybeSingle()` | ❌ Global |

**Problem:** After adding `club_id`, the matview will have grain `(club_id, player_id)`, producing **multiple rows per player**. The current `getPlayerStats()` call uses `.maybeSingle()` — it will throw a `PGRST116` error (multiple rows returned) for any player who appears in more than one club.

### 1.5 Public / Anonymous Surfaces

These surfaces currently assume no membership concept:

| Surface | Auth Required? | Current Behavior |
|---------|---------------|-----------------|
| `/tv/[sessionId]` | ❌ None | Fully public; service-role client bypasses all RLS |
| `/play/join?session=<id>` | ❌ Optional | QR-code entry; uses `lookup_active_session` SECURITY DEFINER RPC (returns `id, name, is_active` only — no membership check) |
| `reconnectPlayer()` | ✅ PIN | Global name+PIN search across ALL profiles and ALL sessions |

### 1.6 Vercel Hobby Tier Constraints

| Constraint | Impact |
|-----------|--------|
| **No wildcard SSL on custom domains** | Subdomain-per-club (e.g., `clubname.app.com`) requires Vercel Pro. On Hobby, every subdomain needs its own CNAME + SSL cert added manually. This is operationally untenable for a SaaS product. **Path-based routing is the only viable option.** |
| **Serverless function invocations** | There is no fixed monthly cap on function invocations for Hobby (the 100k/month limit was deprecated). The real concern is **compute duration per invocation** (50ms CPU limit on Edge) and cold-start latency, not invocation count. Use Node.js runtime (not Edge runtime) for Server Actions that hit Supabase. |
| **Supabase Realtime (free tier)** | **200 concurrent WebSocket connections** — this is the actual scaling ceiling before any Vercel limit applies. One open session with 30 players + 1 TV board = ~32 connections. At ~6 concurrent sessions, this ceiling is hit. |

---

## 2. Target Architecture

### 2.1 Tenancy Model

**Chosen model: Shared schema, `club_id` foreign key on all scoped tables.**

This means one Postgres database, one Supabase project, all clubs coexist in the same tables. Data isolation is enforced by `club_id` filtering in application code (and optionally via RLS policies later).

**Why not schema-per-tenant?**
- Supabase does not expose multiple schemas cleanly via PostgREST (the JS client's `.from()` always targets `public`).
- Running migrations across dozens of schemas is operationally complex.
- The player pool for rivalries/partnerships/leaderboards is club-specific — shared schema makes cross-club queries easy if ever needed (e.g., a global leaderboard of leaderboards).

### 2.2 Tenant Identity Hierarchy

```
clubs (new)
  └─ club_members (new) — links profiles to clubs with a role
  └─ sessions (add club_id FK)
       └─ courts / queue_entries / matches / match_players / match_games / session_wrapped_stats
  └─ player_rivalries (add club_id)
  └─ player_partnerships (add club_id)
```

`profiles` remains **global** — a player can belong to multiple clubs with the same identity.

### 2.3 Club Roles

| Role | Description |
|------|-------------|
| `owner` | Created the club; can invite admins; can delete the club |
| `admin` | Can create sessions; can manage members; elevated = organizer on any session in the club |
| `member` | Can join sessions within the club; visible in the club roster |

Session-level organizer elevation (current `session_organizers` table + `elevate_to_organizer()` RPC) stays as-is within a club context.

---

## 3. Routing Strategy

### 3.1 Path-Based Routing (Vercel Hobby Compatible)

All club-scoped routes are nested under `/c/[clubSlug]/`:

```
/c/[clubSlug]/                     → Club lobby (active sessions, join queue)
/c/[clubSlug]/play/[sessionId]     → Player session dashboard
/c/[clubSlug]/organizer/[sessionId]→ Organizer dashboard (replaces current /play/[sessionId] organizer view)
/c/[clubSlug]/tv/[sessionId]       → TV scoreboard
/c/[clubSlug]/join?session=<id>    → QR-code entry (replaces /play/join)
/c/[clubSlug]/leaderboard          → Club all-time leaderboard
/c/[clubSlug]/wrapped/[sessionId]/[playerId] → Session Wrapped
/c/[clubSlug]/admin                → Club admin panel (manage members, sessions)

/                                  → Landing page / club selector
/clubs/new                         → Create a new club
/clubs/join?invite=<token>         → Accept a club invite
```

### 3.2 `clubSlug` Resolution

`clubs` table has a `slug` column (`text UNIQUE`, lowercase, URL-safe, e.g., `"manila-badminton"`). The `[clubSlug]` segment in the URL is resolved to a `club_id` at the top of every Server Component that needs it. A `getClubBySlug(slug)` helper (service-role) performs this lookup and `notFound()` on miss.

### 3.3 Middleware Impact

`src/middleware.ts` currently only calls `updateSession()` (Supabase auth cookie refresh). It runs on every non-static route. **No routing logic should be added to middleware** — Next.js App Router layouts handle club resolution in Server Components. Adding club membership checks to middleware would:
1. Run on every static asset request (wasted CPU).
2. Require reading the DB on the Edge, which is slower and has the 50ms CPU cap.
3. Add complexity for public routes (`/tv/...`, QR-join).

Keep middleware as-is. Resolve `clubSlug` → `clubId` in the layout Server Component for each `/c/[clubSlug]` route group.

---

## 4. Data Model Changes

### 4.1 New Table: `clubs`

```sql
CREATE TABLE clubs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  slug         text NOT NULL UNIQUE,  -- URL-safe identifier, e.g. "manila-badminton"
  created_by   uuid NOT NULL REFERENCES profiles(id),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

**Constraints:**
- `slug` must be lowercase, alphanumeric + hyphens only, 3–50 chars.
- `UNIQUE` on `slug` is globally enforced by the index.
- No soft-delete column initially — deactivate via `is_active = false`.

**Slug lifecycle risk:** A club that changes its slug (e.g., rebranding) will break all existing QR codes, shared links, and bookmarks. Mitigation: implement slug redirect table (`club_slug_redirects`) or simply document that slugs are permanent.

### 4.2 New Table: `club_members`

```sql
CREATE TABLE club_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_by uuid REFERENCES profiles(id),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, player_id)
);
```

**Invite flow:**
- Owner/admin generates an invite token (short-lived JWT or opaque token stored in a `club_invites` table).
- Recipient visits `/clubs/join?invite=<token>` → auto-creates a `club_members` row with `role = 'member'`.
- Token is consumed (one-time use) after successful join.

### 4.3 Modified Tables

#### `sessions` — add `club_id`

```sql
ALTER TABLE sessions
  ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE RESTRICT;
```

**`ON DELETE RESTRICT`** (not CASCADE): deleting a club should fail if it has active sessions — force the operator to archive sessions first.

**`NOT NULL` timing risk:** Adding `club_id NOT NULL` immediately fails on a live table with existing sessions. The safe migration order is:
1. `ALTER TABLE sessions ADD COLUMN club_id uuid REFERENCES clubs(id)` — nullable, no lock escalation.
2. Backfill: create a "Legacy" or "Default" club, set `club_id` for all existing sessions.
3. `ALTER TABLE sessions ALTER COLUMN club_id SET NOT NULL` — only after backfill is verified complete.

#### `player_rivalries` — add `club_id`, fix `ON CONFLICT`

Current conflict target: `(player_id, rival_id)` — global, no club scope.

```sql
ALTER TABLE player_rivalries
  ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE CASCADE;

-- Drop the existing unique constraint (player_id, rival_id)
-- and replace with (club_id, player_id, rival_id)
```

The RPC or application code that upserts rivalries must be updated to include `club_id` in the `ON CONFLICT` target and in every `WHERE` clause.

#### `player_partnerships` — same fix as rivalries

Same treatment: add `club_id`, drop `(player_id, partner_id)` unique constraint, replace with `(club_id, player_id, partner_id)`.

### 4.4 Modified Views & Materialized Views

#### `v_alltime_leaderboard_mat`

Currently: one row per `player_id` across all sessions globally.

After multi-tenancy: must become `(club_id, player_id)` — one row per player per club.

The `refresh_alltime_leaderboard()` RPC refreshes the entire matview on every match end. With club scoping, this still works but the query that populates it must group by `(club_id, player_id)`.

**`getPlayerStats()` breakage:** `src/app/actions/leaderboard.ts` calls `.maybeSingle()` on this matview when fetching a single player's all-time stats. After the matview has `(club_id, player_id)` grain, `.maybeSingle()` will find multiple rows for players in multiple clubs and throw `PGRST116`. This call must be updated to filter by `club_id` before calling `.maybeSingle()`.

### 4.5 Modified RPCs

#### `migrate_player_identity(p_old_user_id, p_new_user_id)`

Currently migrates data across 7 tables on reconnect. After adding `club_members`, this RPC must also re-assign `club_members.player_id` from `p_old_user_id` to `p_new_user_id` within the same atomic transaction.

#### `lookup_active_session(p_session_id)`

Currently returns `(id, name, is_active)` — no club info. After routing is club-scoped, the QR-join flow needs to know which `clubSlug` to route the player to. Options:
1. Add `club_slug` to the RPC return.
2. Accept `p_club_slug` as a parameter and cross-check session ownership.

---

## 5. Isolation Strategy

### 5.1 Phase 1 — Application-Layer Isolation (Required First)

Every Server Action that reads or writes a scoped table must include `club_id` in the query filter. The service-role client bypasses RLS, so this is purely an application-level discipline.

**Pattern:**
```typescript
// Before (single-tenant):
const { data } = await db.from("sessions").select("*").eq("id", sessionId);

// After (multi-tenant):
const { data } = await db
  .from("sessions")
  .select("*")
  .eq("id", sessionId)
  .eq("club_id", clubId);  // ← always include club_id
```

This must be applied to **every** query across all Server Actions. A systematic audit pass (not a search-and-replace — each query needs its context understood) is required.

**Club membership gate:** A new `isClubMember(userId, clubId)` helper (or `isClubAdmin(userId, clubId)`) must be called at the entry point of every organizer-gated and player-gated Server Action.

### 5.2 Phase 2 — RLS as Hardening Layer (Optional, Later)

Once Phase 1 is stable and tested, RLS policies can be added to the core tables as a defense-in-depth layer. RLS alone is not sufficient because `createServiceClient()` bypasses it — but RLS catches mistakes where a non-service-role query accidentally crosses a club boundary.

Example RLS policy for `sessions`:
```sql
CREATE POLICY "Members can read their club sessions"
ON sessions FOR SELECT
USING (
  club_id IN (
    SELECT club_id FROM club_members WHERE player_id = auth.uid()
  )
);
```

**Draft Mode caveat:** The current Draft Mode firewall relies on an inline `is_published = true OR creator_id = auth.uid()` pattern in the `matches` RLS policy comment. If RLS is later enabled on `matches`, this policy must be preserved or the draft visibility model breaks.

### 5.3 Club Membership Check on Key Routes

| Route | Current | After |
|-------|---------|-------|
| `/c/[clubSlug]/play/[sessionId]` | Auth check only; any authenticated user with the UUID can access | `isClubMember(userId, clubId)` — 403 or redirect if not a member |
| `/c/[clubSlug]/organizer/[sessionId]` | `isSessionOrganizer()` check | `isClubMember` + `isSessionOrganizer` (or `isClubAdmin`) |
| `/c/[clubSlug]/tv/[sessionId]` | Fully public | Remains fully public — TV boards are intentionally shareable |
| `/c/[clubSlug]/join` | QR-code; no membership | Must auto-enroll as club member on first QR-join (see §6.2) |

---

## 6. What Will Break

This section catalogs every current feature that requires code changes to function correctly after the multi-tenant data model is introduced.

### 6.1 `/play/[sessionId]` — No Membership Check

**File:** `src/app/play/[sessionId]/page.tsx`

Current code:
```typescript
const { data: session } = await supabase
  .from("sessions")
  .select("*")
  .eq("id", sessionId)
  .single();
if (!session) notFound();
```

**Problem:** Any authenticated user who knows a `sessionId` UUID can access any session from any club. There is no club membership check. After adding `club_id` and the `/c/[clubSlug]/...` routing hierarchy, this page must:
1. Resolve `clubSlug` → `clubId` from the URL.
2. Verify the session belongs to that club.
3. Verify the user is a club member (or handle QR-join enrollment).

### 6.2 QR-Join Auto-Enrollment Gap

**File:** `src/app/play/join/page.tsx`

The QR-code entry flow (`/play/join?session=<id>`) uses `lookup_active_session` (a SECURITY DEFINER RPC) that returns only `(id, name, is_active)` — no club info, no membership check. After the migration:

- The route becomes `/c/[clubSlug]/join?session=<id>`.
- The page must auto-create a `club_members` row (with `role = 'member'`) if the player scans a valid QR code but is not yet a club member.
- This is the **open enrollment path** — QR codes are intentionally public. The design decision: does scanning a club QR code auto-enroll you as a member, or does it require a separate explicit join step?

**Recommended approach:** Auto-enroll as `member` on first valid QR-join. The QR code itself is the invite mechanism for casual clubs. Formal clubs that want invite-only access can disable QR-join at the club settings level.

### 6.3 `reconnectPlayer()` — Global Name+PIN Lookup

**File:** `src/app/actions/auth.ts`

Current behavior: PIN reconnect searches ALL profiles globally by name+PIN, then redirects to the most recent active session (also searched globally across ALL clubs).

**Problems after multi-tenancy:**
1. A player named "Miguel" in Club A could accidentally reconnect as "Miguel" in Club B if both names and PINs match.
2. The redirect to "most recent active session" ignores club context — the player could land in a different club's session.

**Required fix:** The reconnect flow must be scoped to a club. Options:
- Add `club_id` to the reconnect form (hidden field from the `/c/[clubSlug]/join` entry point).
- Search `profiles` filtered by `club_members.club_id` for the current club context.
- On successful reconnect, redirect within the same club context.

### 6.4 `getAllTimeLeaderboard()` — No Club Argument

**File:** `src/app/actions/leaderboard.ts`

`getAllTimeLeaderboard()` takes no arguments and queries the global matview. After adding `club_id`, this function must accept `clubId` and filter accordingly.

### 6.5 `getPlayerStats()` — `.maybeSingle()` Breakage

**File:** `src/app/actions/leaderboard.ts`

After the matview is keyed by `(club_id, player_id)`, `.maybeSingle()` will return a `PGRST116` error for any player in multiple clubs. This call must be updated to filter by `club_id` first.

### 6.6 `player_rivalries` / `player_partnerships` — `ON CONFLICT` Target

**Files:** `supabase/migrations/20260510000000_cross_session_awards.sql`

The current upsert pattern:
```sql
ON CONFLICT (player_id, rival_id) DO UPDATE ...
ON CONFLICT (player_id, partner_id) DO UPDATE ...
```

After adding `club_id`, the conflict targets must become:
```sql
ON CONFLICT (club_id, player_id, rival_id) DO UPDATE ...
ON CONFLICT (club_id, player_id, partner_id) DO UPDATE ...
```

The existing unique constraints must be dropped and replaced. This is a breaking migration.

### 6.7 `migrate_player_identity()` — Missing `club_members`

**File:** `supabase/migrations/20260608000000_duplicate_name_resolution.sql`

The RPC atomically migrates 7 tables' `player_id` references. After adding `club_members`, it must also re-assign `club_members.player_id` from the old UUID to the new UUID. Failure to do so means a reconnected player loses their club membership and appears as a stranger.

### 6.8 TV Board — Fully Public, No Club Gate

**File:** `src/app/tv/[sessionId]/page.tsx`

The TV board is intentionally fully public (no auth). It uses a service-role client (`getTvData(sessionId)`). After routing changes to `/c/[clubSlug]/tv/[sessionId]`, the `sessionId` must be cross-checked against the `clubSlug` to prevent information leakage (e.g., `/c/club-a/tv/<club-b-session-id>` should 404 or redirect).

This is a low-severity risk (session UUIDs are opaque), but it's a correctness gap.

### 6.9 Name Uniqueness Scope

The current partial UNIQUE index `idx_profiles_unique_active_name` enforces **global** name uniqueness across all players in all clubs. After multi-tenancy, the question is:

- Should "Miguel" in Club A block a different "Miguel" in Club B?
- Or should uniqueness be per-club?

**Recommendation:** Keep global uniqueness for now. Player identity is global (one profile, multiple club memberships). This avoids the complexity of per-club name deduplication and keeps the existing duplicate-name resolution logic intact. A player named "Miguel" can only exist once, regardless of club.

### 6.10 `compute_session_wrapped()` — No Club Scope on Rivalries/Partnerships

**File:** The `compute_session_wrapped` RPC (and `src/lib/wrapped-awards.ts`)

Session Wrapped awards include rival-tracking and partnership-tracking based on `player_rivalries` / `player_partnerships`. After adding `club_id` to those tables, the RPC must filter by `club_id` when reading and writing those records, or wrapped stats will bleed across clubs.

### 6.11 Test Factories and E2E Seeds

**File:** `tests/helpers/init-sandbox.ts` (currently broken — E2E sandbox was deleted 2026-06-05)

Any test factory that creates sessions must now also create a `club` and a `club_members` entry. The `NOT NULL` constraint on `sessions.club_id` (once applied) will make all existing seed scripts fail.

---

## 7. Known Risks & Mitigations

### 7.1 Supabase 200-Connection Ceiling

**Risk:** Supabase free tier allows 200 concurrent Realtime WebSocket connections. Each open session page (player or organizer) holds one. A TV board holds one. At 6 concurrent active sessions with 30 players each = 180 connections. Very little headroom.

**Mitigations:**
- Implement connection coalescing: organizer dashboard and player dashboard for the same session should share a single channel subscription, not open separate connections.
- Realtime channel naming must use the existing `channelPrefix` pattern (`"session-events:{sessionId}"`) — no per-component proliferation.
- Monitor active connection count via Supabase dashboard; upgrade to Supabase Pro ($25/mo) when consistently above 150 concurrent.

### 7.2 Matview Refresh Bottleneck

**Risk:** `v_alltime_leaderboard_mat` is refreshed on every match end (`refresh_alltime_leaderboard()` RPC called after `endMatchAction`). With multiple clubs running simultaneous sessions, this becomes a hot spot — every match completion triggers a full matview refresh, which scans and aggregates all historical matches across all clubs.

**Mitigations:**
- Short-term: Add a `CONCURRENTLY` option to the refresh (requires a unique index on the matview) so reads are never blocked.
- Medium-term: Throttle the refresh to at most once per minute (debounce with a flag column on `clubs` or a Redis-equivalent).
- Long-term: Replace the matview with a running-total table maintained by triggers (incremental updates, no full rebuild).

### 7.3 Slug Lifecycle

**Risk:** A club slug is embedded in every QR code ever printed, every link ever shared, every browser bookmark. Renaming a club slug silently breaks all of these.

**Mitigation:** Implement `club_slug_redirects (old_slug, new_slug)` table. The `/c/[clubSlug]` layout resolves via a lookup that checks both `clubs.slug` and `club_slug_redirects.old_slug`. Old slugs permanently redirect to new slugs.

### 7.4 Google OAuth Callback Routing

**Risk:** The OAuth callback route (`/auth/callback`) currently redirects to a `next` parameter (e.g., `/play/session-id`). After routing changes to `/c/[clubSlug]/...`, existing OAuth callback URLs will land on dead routes.

**Mitigation:** Ensure `next` parameter in Google OAuth flow is updated to use club-scoped URLs. Test the full OAuth + QR-join + connect flow in the new routing hierarchy before deploying.

### 7.5 Role Overlap: Club Admin vs Session Organizer

**Risk:** A club admin has elevated access to all sessions within the club. The current `isSessionOrganizer()` helper only checks `sessions.created_by` and `session_organizers` table — it has no concept of "club admin is implicitly an organizer."

**Mitigation:** Add a third check to `isSessionOrganizer()`: if the user is a `club_members` row with `role IN ('owner', 'admin')` for the club that owns the session, treat them as an organizer. This check must use the service-role client (to bypass RLS) and must be added atomically with the other checks.

### 7.6 Per-Club Skill Levels

**Risk:** `skill_level` is currently a global enum on `profiles` — one skill level per player, globally. In a multi-club world, a player might be "intermediate" at one club and "advanced" at another (different competitive contexts).

**Mitigation for now:** Keep skill level global. This is a known simplification. A future `club_members.skill_level` column can override the global value per club without touching the core enum.

### 7.7 Player Offboarding

**Risk:** There is no concept of removing a player from a club. A player who leaves a club still has `club_members` rows, `queue_entries`, and `session_wrapped_stats` in that club's data.

**Mitigation:** Implement `club_members.is_active = false` (soft deactivation) rather than DELETE. Deactivated members: cannot join new sessions, are excluded from the club roster, but their historical data (matches, wrapped stats) is preserved for leaderboard accuracy.

### 7.8 `NOT NULL` Timing Risk for `sessions.club_id`

**Risk:** Applying `sessions.club_id NOT NULL` before backfilling all existing sessions will lock the table and fail if any sessions have `club_id = NULL`.

**Mitigation:** The three-step migration approach described in §4.3 (add nullable → backfill → set NOT NULL) is non-negotiable. A concurrent migration script must verify 0 NULL rows before the `SET NOT NULL` step.

---

## 8. Implementation Sequencing

The migration must be done incrementally. Do not attempt to do all of this in one deployment.

### Phase 0 — Foundation (No Breaking Changes)

These changes add tables/columns without modifying any existing behavior.

1. **Create `clubs` table** — nullable `club_id` on `sessions` (NOT `NOT NULL` yet).
2. **Create `club_members` table** — empty initially.
3. **Create "Legacy" or "Default" club** — one club row to absorb all existing sessions.
4. **Backfill `sessions.club_id`** — set all existing sessions to the default club.
5. **Apply `SET NOT NULL`** on `sessions.club_id` after confirming zero NULLs.
6. **Add `club_id` (nullable) to `player_rivalries` and `player_partnerships`** — do NOT drop the old unique constraints yet.
7. **Backfill `club_id` on rivalries/partnerships** — set all rows to the default club.
8. **Drop old `(player_id, rival_id)` constraint, add `(club_id, player_id, rival_id)` constraint**.
9. **Update `migrate_player_identity()` RPC** — add `club_members` migration step.

**Gate:** All existing functionality must work unchanged after Phase 0. Deploy and verify before proceeding.

### Phase 1 — Club Registration UI

1. **Club creation form** (`/clubs/new`).
2. **Club invite system** (`club_invites` table, `/clubs/join?invite=<token>`).
3. **`getClubBySlug()` helper** — service-role lookup, `notFound()` on miss.
4. **`/c/[clubSlug]` layout** — resolves `clubSlug` to `clubId` and passes via layout context.
5. **Club admin panel** (`/c/[clubSlug]/admin`) — member management, session creation.

### Phase 2 — Route Migration

1. Migrate all routes to `/c/[clubSlug]/...` hierarchy.
2. Add `isClubMember()` and `isClubAdmin()` helpers.
3. Update `isSessionOrganizer()` to check club admin status.
4. Add `clubId` parameter to all Server Actions that scope by club.
5. Update `reconnectPlayer()` to scope name+PIN lookup by club.
6. Update `getAllTimeLeaderboard()` to accept and filter by `clubId`.
7. Fix `getPlayerStats()` — replace `.maybeSingle()` with `.eq("club_id", clubId).single()`.
8. Update QR-join flow — auto-enroll as club member + update `lookup_active_session` RPC to return `club_slug`.
9. Update TV board — cross-check `sessionId` belongs to `clubSlug`.

### Phase 3 — Global State Migration

1. **Rebuild matview** with `(club_id, player_id)` grain.
2. **Update `compute_session_wrapped()`** RPC to filter rivalries/partnerships by `club_id`.
3. **Refresh matview** after rebuilding.
4. **Update Google OAuth callback** `next` parameter to use club-scoped URLs.

### Phase 4 — Hardening (Optional)

1. **Enable RLS** on `sessions`, `courts`, `matches`, `queue_entries`, `match_players`.
2. Write policies that scope reads by `club_members.club_id`.
3. Preserve Draft Mode `is_published` policy.
4. **Add matview refresh debounce** (at most once per minute per club).
5. **Implement `club_slug_redirects`** for rename safety.
6. **Update test factories** to create clubs + memberships.

---

## 9. Database Migration Checklist

Use this checklist when applying migrations to production. Each item must be verified before the next step.

### Schema Changes (ordered)

- [ ] `CREATE TABLE clubs (...)` — apply migration
- [ ] `CREATE TABLE club_invites (...)` — apply migration
- [ ] `CREATE TABLE club_members (...)` — apply migration
- [ ] `ALTER TABLE sessions ADD COLUMN club_id uuid REFERENCES clubs(id)` — nullable initially
- [ ] Create the "Default Club" row (`INSERT INTO clubs (name, slug, created_by) VALUES (...)`)
- [ ] `UPDATE sessions SET club_id = '<default-club-id>'` — backfill all existing rows
- [ ] Verify: `SELECT COUNT(*) FROM sessions WHERE club_id IS NULL` → must return 0
- [ ] `ALTER TABLE sessions ALTER COLUMN club_id SET NOT NULL`
- [ ] `ALTER TABLE player_rivalries ADD COLUMN club_id uuid REFERENCES clubs(id)` — nullable
- [ ] `ALTER TABLE player_partnerships ADD COLUMN club_id uuid REFERENCES clubs(id)` — nullable
- [ ] Backfill rivalries/partnerships `club_id` to the default club
- [ ] Drop constraint `(player_id, rival_id)` on `player_rivalries`; add `(club_id, player_id, rival_id)`
- [ ] Drop constraint `(player_id, partner_id)` on `player_partnerships`; add `(club_id, player_id, partner_id)`
- [ ] Rebuild `v_alltime_leaderboard_mat` with `club_id` column and `(club_id, player_id)` group-by
- [ ] Add `CREATE UNIQUE INDEX` on `v_alltime_leaderboard_mat (club_id, player_id)` (enables `REFRESH CONCURRENTLY`)
- [ ] Call `refresh_alltime_leaderboard()` after matview rebuild

### RPC Changes (ordered)

- [ ] Update `migrate_player_identity(p_old_user_id, p_new_user_id)` — add `club_members` re-assignment step
- [ ] Update `lookup_active_session(p_session_id)` — add `club_slug` to return columns
- [ ] Update `compute_session_wrapped(p_session_id)` — filter rivalries/partnerships by `club_id`
- [ ] Update `refresh_alltime_leaderboard()` — verify it handles multi-club grain correctly

### Application Code Changes (ordered, after schema is stable)

- [ ] `getClubBySlug(slug)` helper — new
- [ ] `isClubMember(userId, clubId)` helper — new
- [ ] `isClubAdmin(userId, clubId)` helper — new
- [ ] `isSessionOrganizer()` — add club admin check
- [ ] `/c/[clubSlug]` layout — resolve `clubSlug` to `clubId`
- [ ] All Server Actions — add `clubId` parameter and filter
- [ ] `reconnectPlayer()` — scope by `clubId`
- [ ] `getAllTimeLeaderboard(clubId)` — add `clubId` parameter
- [ ] `getPlayerStats(playerId, clubId)` — fix `.maybeSingle()` → filter by `club_id` first
- [ ] QR-join page — auto-enroll club member + new route
- [ ] TV board — cross-check `clubSlug` + `sessionId` ownership
- [ ] Google OAuth callback `next` parameter — update to club-scoped URLs
- [ ] Test factories / E2E seeds — add club + member creation

---

## Appendix: Decision Log

| Decision | Rationale |
|----------|-----------|
| Shared schema (not schema-per-tenant) | Supabase PostgREST targets `public` schema only; migrations across many schemas are complex |
| Path-based routing (`/c/[clubSlug]`) | Wildcard SSL not available on Vercel Hobby; subdomain routing requires Pro |
| Application-layer isolation first, RLS second | Core tables have no RLS today; service-role bypasses RLS anyway; code discipline must come first |
| `NOT NULL` applied in 3 steps | Live table with existing data; immediate `NOT NULL` would lock and fail |
| Global player identity (profiles global) | One player, multiple clubs; avoids per-club name deduplication complexity |
| Global name uniqueness preserved | Existing `idx_profiles_unique_active_name` partial index kept; per-club uniqueness deferred |
| `ON DELETE RESTRICT` on `sessions.club_id` | Prevent accidental club deletion leaving orphaned sessions |
| Auto-enroll on QR-join | QR code = implicit invite; maintains zero-friction onboarding for casual clubs |
| Soft-deactivate members (not DELETE) | Historical stats (matches, wrapped) must be preserved for leaderboard integrity |
