# Multi-Tenant SaaS Migration Plan

> ## ✅ SHIPPED — this document is HISTORICAL (corrected 2026-08-19)
>
> **The line below said "NO CODE HAS BEEN WRITTEN" for six weeks after the feature shipped.**
> Multi-tenant clubs merged to `main` as `f3aae17` and deployed on **2026-07-02**; the
> platform-owner model followed on **2026-07-05** (`1bd4769`). The club UI was re-skinned in
> `6735be4`. This file is kept for the design rationale only — the living description is
> `APP_MANIFEST.md` §11 and the write-ups in `docs/incidents/2026-07-0*`.
>
> **Status:** ~~Architectural design document — NO CODE HAS BEEN WRITTEN.~~ Superseded by the
> shipped implementation.
> **Author:** Generated via codebase investigation, June 2026.
> **Revision:** v2 (2026-06-30) — audit corrected against the **live database** (Supabase project `usxftpexoimletqmrggb`) and current code. See "v2 Revision Log" below for what changed and why.
> **Scope:** Transitioning from a single-organizer/single-group model to a multi-club SaaS model.
> **Infrastructure constraint:** Vercel Hobby (Free) tier — all architectural choices must stay within free-tier limits.

---

## v2 Revision Log

The v1 audit contained two load-bearing factual errors and several completeness gaps. All claims below were re-verified against `pg_class`, `pg_policies`, `pg_proc`, `pg_constraint`, the Supabase advisor API, and the application source. Corrections folded into this revision:

| # | v1 claim | Reality (verified) | Sections fixed |
|---|----------|--------------------|----------------|
| C1 | "RLS is NOT enabled on any core table" | **RLS is enabled on all 15 public tables.** Real policies (`is_session_organizer()`, `created_by=auth.uid()`). The actual gap is wide-open `SELECT USING(true)` + anonymous sign-ins, not absent RLS. Supabase advisor returns **zero** `rls_disabled_in_public` lints. | §1.1, §5.2 |
| C2 | Organizer view "currently at `/play/[sessionId]`", must be split out | **Already a separate route** `/organizer/[sessionId]`; `/play/[sessionId]` renders only `PlayerDashboard`. No de-branching needed — only relocation. | §3.1, new §3.4 |
| C3 | §6 enumerates everything that breaks | Missed **every cross-session aggregator**: Monthly Leaderboard, `get_player_streaks`, `get_alltime_snapshot_before`, all-time `get_h2h_record`, `match_events`, and the `v_match_history` base view. | §4.4, §6.12–§6.17, §9 |
| C4 | Constraint swap and RPC change listed separately | Dropping the rivalry/partnership key without updating `refresh_cross_session_stats` **throws at the next `closeSession()`**. Must be one atomic step. | §6.6, §8 Phase 0 |
| C5 | Rivalry/partnership "unique constraints" | They are **PRIMARY KEYs** `(player_id, rival_id)` / `(player_id, partner_id)`. Replacing a PK is more involved (but feasible — no inbound FKs). | §4.3, §6.6 |
| C6 | `isSessionOrganizer()` is one TS helper | There are **two**: the TS helper (`_shared.ts`) **and** a SQL `is_session_organizer()` SECURITY DEFINER function baked into ~15 RLS policies. Both need the club-admin check. | §3.4, §7.5 |
| C7 | `migrate_player_identity` needs a `club_members` step | True — **and** note it currently does **not** re-point `player_rivalries`/`player_partnerships` either (pre-existing gap). | §4.5, §6.7 |

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

### 1.1 The Honest RLS Baseline (corrected)

**Verified finding:** Row Level Security **is enabled on every table in the `public` schema** (all 15 base tables). The Supabase security advisor returns **zero** `rls_disabled_in_public` lints. v1's claim that "RLS is not enabled on core tables" was wrong.

The real isolation gap is narrower and different: **read policies are deliberately wide open, and anonymous sign-in is allowed.** That is what lets data cross session/club boundaries today — not an absence of RLS.

| Table | RLS | Representative policies (verified) |
|-------|-----|------------------------------------|
| `sessions` | ✅ on | `SELECT USING (true)` · INSERT `created_by = auth.uid()` · UPDATE `is_session_organizer(id)` |
| `matches` | ✅ on | `SELECT` draft firewall `(status<>'pending' OR is_published OR is_session_organizer(session_id))` · write paths gated on `session_organizers` |
| `queue_entries` | ✅ on | `SELECT USING (true)` · INSERT/UPDATE/DELETE own (`player_id=auth.uid()`) or organizer |
| `match_players` | ✅ on | `SELECT USING (true)` · UPDATE/DELETE via `is_session_organizer(match→session)` |
| `courts` | ✅ on | `SELECT USING (true)` · write via `session_organizers` |
| `profiles` | ✅ on | `SELECT USING (true)` · UPDATE own or `is_any_session_organizer()` |
| `match_events`, `match_games`, `session_organizers`, `session_wrapped_stats`, `push_subscriptions`, `player_rivalries`, `player_partnerships`, `identity_migrations`, `player_renames` | ✅ on | various (some `rls_enabled_no_policy` = deny-all to non-service-role) |

**What actually enables cross-tenant reads today:**
1. **`SELECT USING (true)`** on `sessions`, `matches` (non-draft), `queue_entries`, `match_players`, `courts`, `profiles` — any authenticated principal can read every session's data.
2. **Anonymous sign-ins are enabled** (15 `auth_allow_anonymous_sign_ins` advisor lints) — the "authenticated" bar is low.
3. **`createServiceClient()` (service role) bypasses RLS entirely** — every mutation runs through it, by design.
4. **Views/matview are not RLS-protected** (`v_alltime_leaderboard_mat` is flagged `materialized_view_in_api`; the `v_*` views are `security_definer_view`).

**Implication for the migration:** Because service-role bypasses RLS and the SELECT policies are permissive, **application-layer `club_id` filtering is the primary isolation control** — this conclusion is unchanged from v1. What changes (see §5.2) is that hardening RLS later is **not greenfield**: there are already 30+ policies, and tightening reads means **replacing** the existing `USING (true)` SELECT policies, not adding new ones beside them.

### 1.2 Authentication Model

- Anonymous auth (Supabase) via name + 4-digit PIN.
- Optional Google OAuth (linked via `linkIdentity`).
- UUID identity (`auth.users.id` = `profiles.id`) — reconnect migrates the UUID with `migrate_player_identity()`.
- PIN reconnect is a **global name+PIN lookup** — no session or club scope (verified `auth.ts:207-211`).

### 1.3 Current Session Scoping

`session_id` is today's universal isolation key. All child data flows through it:

```
sessions
  └─ courts (session_id)
  └─ queue_entries (session_id + player_id)
  └─ matches (session_id)
       └─ match_players (match_id)
       └─ match_games (match_id)
       └─ match_events (session_id + match_id)        ← audit log (added 2026-06-17)
  └─ session_organizers (session_id + user_id)
  └─ session_wrapped_stats (session_id + player_id)
```

`profiles`, `player_rivalries`, `player_partnerships`, and `v_alltime_leaderboard_mat` are currently **global** — no session scope. So are the **on-the-fly aggregators** in §1.4.

### 1.4 Global State — Tables AND Computed Surfaces (expanded)

v1 listed only the three stored-global objects. The dangerous set is larger: anything that **computes across sessions** leaks across clubs with no error. Full inventory:

| Object | Type | Grain today | Club-scoped? |
|--------|------|-------------|-------------|
| `v_alltime_leaderboard_mat` | Materialized view | one row per `player_id`, global | ❌ |
| `player_rivalries` | Table | PK `(player_id, rival_id)` | ❌ |
| `player_partnerships` | Table | PK `(player_id, partner_id)` | ❌ |
| `v_match_history` | View | one row per (player, match), global | ❌ **base view 3 others derive from** |
| `v_session_leaderboard` | View | per session (built on `v_match_history`) | session-filtered by callers |
| `get_monthly_leaderboard(y,m)` | RPC | all completed matches in a Manila month, **no session/club filter** | ❌ **public** |
| `get_leaderboard_months()` | RPC | distinct months across all matches | ❌ |
| `get_player_streaks(NULL)` | RPC | all-time win streak across all sessions | ❌ |
| `get_alltime_snapshot_before(cutoff)` | RPC | global rank snapshot for movement arrows | ❌ |
| `get_h2h_record(...)` | RPC | `alltime_a/b` counters span all sessions | ❌ |
| `refresh_cross_session_stats(session)` | RPC | the upsert writer for rivalries/partnerships | ❌ |
| `compute_session_wrapped(session)` | RPC | reads rivalries/partnerships + `carry_forward` | ❌ |

`getPlayerStats(playerId, sessionId|null)` reads the matview with `.maybeSingle()` (`leaderboard.ts:503`) — see §6.5.

### 1.5 Public / Anonymous Surfaces

| Surface | Auth Required? | Current Behavior |
|---------|---------------|-----------------|
| `/tv/[sessionId]` | ❌ None | Fully public; service-role `getTvData()` bypasses RLS (verified `tv.ts:47`) |
| `/leaderboard` | ❌ Best-effort | Monthly/all-time boards; never redirects logged-out users → **public global aggregation** |
| `/play/join?session=<id>` | ❌ Optional | QR entry; `lookup_active_session` SECURITY DEFINER RPC returns only `(id, name, is_active)` (verified) |
| `reconnectPlayer()` | ✅ PIN | Global name+PIN search across ALL profiles and ALL sessions |

### 1.6 Vercel Hobby Tier Constraints

| Constraint | Impact |
|-----------|--------|
| **No wildcard SSL on custom domains** | Subdomain-per-club requires Vercel Pro. On Hobby, each subdomain needs a manual CNAME + cert — untenable for SaaS. **Path-based routing is the only viable option.** |
| **Edge CPU cap** | No fixed monthly invocation cap (the old 100k/mo limit was deprecated). Real concern is per-invocation compute (Edge ~50ms CPU) + cold start. Use the **Node.js runtime** for Server Actions that hit Supabase. |
| **Supabase Realtime (free tier)** | **200 concurrent WebSocket connections** — the actual scaling ceiling. ~32 connections per open 30-player session + TV board → ceiling near ~6 concurrent sessions. |

---

## 2. Target Architecture

### 2.1 Tenancy Model

**Chosen model: Shared schema, `club_id` foreign key on all scoped tables.** One Postgres database, one Supabase project; isolation enforced by `club_id` filtering in application code (and tightened RLS later).

**Why not schema-per-tenant?**
- Supabase PostgREST (`.from()`) targets `public` only.
- Migrations across dozens of schemas are operationally complex.
- A shared pool keeps any future cross-club query (e.g. a global "league of clubs") trivial.

### 2.2 Tenant Identity Hierarchy

```
clubs (new)
  └─ club_members (new) — links profiles to clubs with a role
  └─ sessions (add club_id FK)
       └─ courts / queue_entries / matches / match_players / match_games
       └─ match_events (inherits club via session)
       └─ session_wrapped_stats
  └─ player_rivalries (add club_id)
  └─ player_partnerships (add club_id)
```

`profiles` remains **global** — a player can belong to multiple clubs with the same identity.

### 2.3 Club Roles

| Role | Description |
|------|-------------|
| `owner` | Created the club; can invite admins; can delete the club |
| `admin` | Can create sessions; manage members; **implicitly organizer on any session in the club** |
| `member` | Can join sessions within the club; visible in the club roster |

Session-level organizer elevation (`session_organizers` + `elevate_to_organizer()`) stays as-is **within** a club context. See §3.4 for how the two authorities compose.

---

## 3. Routing Strategy

### 3.1 Path-Based Routing (Vercel Hobby Compatible)

> **Correction (C2):** The organizer dashboard is **already a separate route** (`/organizer/[sessionId]`), not a role-branch of `/play/[sessionId]`. `/play/[sessionId]` renders only `PlayerDashboard`. So this is a **relocation** of three existing route trees under `/c/[clubSlug]`, **not** a de-branching exercise.

Current → target mapping:

| Current route | Target route |
|---|---|
| `/play/[sessionId]` (PlayerDashboard) | `/c/[clubSlug]/play/[sessionId]` |
| `/organizer/[sessionId]` (OrganizerDashboard) | `/c/[clubSlug]/organizer/[sessionId]` |
| `/organizer` (landing/list) | **multi-club home `/`** + per-club `/c/[clubSlug]/admin` (see §3.4) |
| `/tv/[sessionId]` | `/c/[clubSlug]/tv/[sessionId]` |
| `/play/join?session=<id>` | `/c/[clubSlug]/join?session=<id>` |
| `/wrapped/[sessionId]/[playerId]` | `/c/[clubSlug]/wrapped/[sessionId]/[playerId]` |
| `/leaderboard` | `/c/[clubSlug]/leaderboard` (club-scoped) |
| — | `/` landing / club selector · `/clubs/new` · `/clubs/join?invite=<token>` |

Internal navigation that already hardcodes these paths must be updated — e.g. `organizer-dashboard.tsx:435` (`router.push('/organizer/${id}')`) and `player-dashboard.tsx:291`.

### 3.2 `clubSlug` Resolution

`clubs.slug` (`text UNIQUE`, lowercase, URL-safe). A `getClubBySlug(slug)` helper (service-role) resolves `[clubSlug]` → `club_id` at the top of every `/c/[clubSlug]` layout, `notFound()` on miss.

### 3.3 Middleware Impact

`src/middleware.ts` only calls `updateSession()` (auth cookie refresh) on every non-static route. **Keep it as-is** — do not add club resolution or membership checks to middleware (it would run on static assets, force Edge DB reads under the 50ms cap, and complicate public routes). Resolve `clubSlug` → `clubId` in the layout Server Component for each `/c/[clubSlug]` route group.

### 3.4 Organizer Access Across Multiple Clubs (new — answers "how does an organizer reach the right session across 2–3 tenants")

**Principle: identity is global; organizing authority is resolved per `(club, session)`.** One `profiles` row, an independent `club_members(club_id, player_id, role)` row per club. The same human can be owner of Club A, admin of Club B, and a plain member of Club C who was handed one session to run. There is **no** global "is organizer" flag.

**Two authorities, both honored:**

| Authority | Source | Scope |
|---|---|---|
| Club admin/owner | `club_members.role IN ('owner','admin')` | Implicitly organizer on **every** session in that club — no `session_organizers` row required |
| Session organizer | `sessions.created_by` or a `session_organizers` row | A single session, even for a plain club member |

**Authorization at the route boundary** for `/c/[clubSlug]/organizer/[sessionId]`:

```
clubId  = getClubBySlug(clubSlug)            // 404 on unknown slug
session = getSession(sessionId)              // 404 if session.club_id !== clubId
                                             //   blocks /c/club-a/organizer/<club-b-session>
canOrganize = isClubAdmin(userId, clubId)               // owner/admin row in club_members
           || isSessionOrganizer(sessionId, userId)     // created_by / session_organizers
if (!canOrganize) → redirect to /c/[clubSlug] lobby (or 403)
```

**Navigation / discovery:**
- `/` becomes a **multi-club home**: every club in the user's `club_members`, each badged with role + active-session count. (Replaces today's `/organizer` landing as the cross-tenant entry.)
- Pick a club → `/c/[clubSlug]` lobby; admins also get `/c/[clubSlug]/admin` (all sessions + "create session").
- A persistent **club switcher** in the header (Slack-workspace / Vercel-team pattern). The `clubSlug` in the URL is the active-tenant selector and the authorization scope.
- Deep links / QR to a specific organizer URL still work — the layout resolves the slug and runs the check above.

**Critical implementation note (C6):** `isSessionOrganizer` exists in **two** places that must both gain the club-admin path:
1. The TS helper `src/app/actions/_shared.ts:71` (used by Server Actions).
2. A SQL `is_session_organizer(session_id)` SECURITY DEFINER function baked into **~15 RLS policies** (`matches`, `queue_entries`, `courts`, `match_players`, `profiles`…). Changing organizer semantics means editing this function once — every policy that calls it updates transitively, so verify all of them after the change.

---

## 4. Data Model Changes

### 4.1 New Table: `clubs`

```sql
CREATE TABLE clubs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  slug         text NOT NULL UNIQUE,  -- URL-safe, e.g. "manila-badminton"
  created_by   uuid NOT NULL REFERENCES profiles(id),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

Constraints: `slug` lowercase, alphanumeric + hyphens, 3–50 chars; globally unique. Deactivate via `is_active=false` (no hard delete initially). **Slug lifecycle risk** → §7.3.

### 4.2 New Table: `club_members`

```sql
CREATE TABLE club_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  is_active  boolean NOT NULL DEFAULT true,   -- soft offboarding (§7.7)
  invited_by uuid REFERENCES profiles(id),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, player_id)
);
```

Invite flow: owner/admin generates a token (`club_invites` table); `/clubs/join?invite=<token>` creates a `member` row; token is one-time. QR auto-enroll → §6.2.

### 4.3 Modified Tables

#### `sessions` — add `club_id`

```sql
ALTER TABLE sessions ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE RESTRICT;
```

`ON DELETE RESTRICT` (not CASCADE): deleting a club with sessions should fail — force archival first. **`NOT NULL` is applied in 3 steps** (add nullable → backfill default club → `SET NOT NULL`); see §8 Phase 0.

#### `player_rivalries` / `player_partnerships` — add `club_id`, replace the PRIMARY KEY (C5)

> These are **PRIMARY KEYs**, not secondary unique constraints: `player_rivalries_pkey (player_id, rival_id)` and `player_partnerships_pkey (player_id, partner_id)`. No inbound FKs reference them, so they can be replaced, but the step is heavier than a `DROP CONSTRAINT` on a plain unique index and must be paired with the RPC body change (§6.6/C4).

```sql
ALTER TABLE player_rivalries  ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE player_partnerships ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE CASCADE;
-- then, atomically with the refresh_cross_session_stats body change:
--   ALTER TABLE ... DROP CONSTRAINT player_rivalries_pkey,
--                   ADD PRIMARY KEY (club_id, player_id, rival_id);   (same for partnerships)
```

#### `match_events` — inherits club via session (new, C3)

`match_events` has `session_id` (FK `ON DELETE SET NULL`) plus `session_id_snapshot`. It does **not** need its own `club_id` for correctness if every read joins through `sessions`, but note: after a session is deleted the live `session_id` is null and only the snapshot survives, so a club-scoped forensic query that filters the live FK silently drops history. Decide per use-case; at minimum, document that `match_events` is club-scoped **transitively** and add it to the RLS review.

### 4.4 Modified Views & Materialized Views

#### `v_match_history` — the base view (new, C3)

`v_match_history` (one row per player-match, global) is the root of the leaderboard dependency chain: `v_session_leaderboard`, `v_alltime_leaderboard_mat`, and `get_player_streaks` all read `FROM v_match_history`. **Add `club_id` here first** (via `matches.session → sessions.club_id`), or each of the three downstream objects must re-join `matches→sessions` independently.

#### `v_session_leaderboard`

Built on `v_match_history`; session-filtered by callers so it does not *leak* today, but it should pass `club_id` through for consistency once the base view carries it.

#### `v_alltime_leaderboard_mat`

Currently one row per `player_id` (verified: `GROUP BY mr.player_id, p.display_name`, `UNIQUE INDEX (player_id)`). After multi-tenancy it must become **`(club_id, player_id)`** — one row per player per club. Keep a unique index on `(club_id, player_id)` to preserve `REFRESH ... CONCURRENTLY`. `getPlayerStats()` breakage → §6.5.

### 4.5 Modified RPCs

#### `migrate_player_identity(p_old_user_id, p_new_user_id)` (C7)

Today re-points `player_id`/`user_id`/`created_by` across `queue_entries`, `match_players`, `sessions`, `session_wrapped_stats`, `session_organizers` (plus recreates `profiles` and writes an `identity_migrations` audit row — "7 steps"). It must additionally re-assign **`club_members.player_id`** old→new in the same transaction (else a reconnected player loses club membership).
**Pre-existing gap to fix while here:** it does **not** currently re-point `player_rivalries`/`player_partnerships` — a reconnecting player already loses rivalry/partnership history. With `club_id` added, fix both at once.

#### `get_monthly_leaderboard`, `get_player_streaks`, `get_alltime_snapshot_before`, `get_h2h_record`, `refresh_cross_session_stats`, `compute_session_wrapped`

All take a `club_id` filter (or derive it via session join). Details and consequences in §6.12–§6.17.

#### `lookup_active_session(p_session_id)`

Returns `(id, name, is_active)` (verified). The QR-join flow needs the club to route to — add `club_slug` to the return (or accept `p_club_slug` and cross-check ownership).

---

## 5. Isolation Strategy

### 5.1 Phase 1 — Application-Layer Isolation (Required First)

Every Server Action that reads or writes a scoped table must include `club_id` in the filter. Service-role bypasses RLS, so this is the primary control.

```typescript
// After (multi-tenant):
const { data } = await db.from("sessions").select("*")
  .eq("id", sessionId)
  .eq("club_id", clubId);   // ← always include club_id
```

A **systematic per-query audit** (not search-and-replace — each query's context must be understood) is required. Add an `isClubMember(userId, clubId)` / `isClubAdmin(userId, clubId)` gate at the entry of every scoped action.

### 5.2 Phase 2 — RLS Tightening as Hardening Layer (corrected, C1)

> **This is NOT greenfield.** RLS is already enabled with 30+ live policies. The work is **replacing the permissive `SELECT USING (true)` policies** with club-scoped ones — **not** adding policies beside them.

**Why "add a policy" fails here:** PostgreSQL combines multiple *permissive* policies for the same command with **OR**. Adding

```sql
CREATE POLICY "club_read" ON sessions FOR SELECT
  USING (club_id IN (SELECT club_id FROM club_members WHERE player_id = auth.uid()));
```

next to the existing `sessions_select USING (true)` yields `true OR club_check = true` — **no effect**. You must `DROP POLICY sessions_select` (and the equivalents on `matches`, `queue_entries`, `match_players`, `courts`, `profiles`) and recreate them club-scoped, or convert them to `RESTRICTIVE` policies.

**Preserve these while tightening:**
- The `matches` **draft firewall** (`status<>'pending' OR is_published OR is_session_organizer(session_id)`). Note there are currently **two** near-duplicate SELECT policies on `matches` (`matches_select` and `matches_select_draft_firewall`) — de-duplicate as part of this pass.
- Public read paths intentionally open: the **TV board** and **QR-join** lookups (keep their SECURITY DEFINER RPC path; do not require membership).

Service-role still bypasses all of this, so §5.1 remains the real boundary; RLS is defense-in-depth against a non-service-role query that forgets `club_id`.

### 5.3 Club Membership Check on Key Routes

| Route | After |
|-------|-------|
| `/c/[clubSlug]/play/[sessionId]` | `isClubMember(userId, clubId)` — redirect/QR-enroll if not a member |
| `/c/[clubSlug]/organizer/[sessionId]` | `isClubAdmin` **or** `isSessionOrganizer` (see §3.4) |
| `/c/[clubSlug]/tv/[sessionId]` | Remains fully public — but cross-check `sessionId` belongs to `clubSlug` (§6.8) |
| `/c/[clubSlug]/join` | Auto-enroll as club member on first QR-join (§6.2) |

---

## 6. What Will Break

Every current feature requiring changes after the multi-tenant model lands. §6.1–§6.11 are corrected v1 items; **§6.12–§6.17 are the cross-session aggregators v1 missed (C3).**

### 6.1 `/play/[sessionId]` — No Membership Check

**File:** `src/app/play/[sessionId]/page.tsx`. Uses the **user-context** client (`createServerSupabaseClient`) to fetch the session (`.eq("id", sessionId).single()`, verified `page.tsx:39-44`) and already runs `enforceRenameGate` (`page.tsx:37`). Any authenticated user who knows a `sessionId` can open any club's session. After the migration: resolve `clubSlug`→`clubId`, verify `session.club_id === clubId`, verify membership (or QR-enroll).

### 6.2 QR-Join Auto-Enrollment Gap

**File:** `src/app/play/join/page.tsx`. Uses `lookup_active_session` (returns `(id, name, is_active)`). New route `/c/[clubSlug]/join?session=<id>` must auto-create a `club_members` row (`role='member'`) on first valid scan. **Recommended:** auto-enroll as `member`; formal clubs can disable QR-join in settings.

### 6.3 `reconnectPlayer()` — Global Name+PIN Lookup

**File:** `src/app/actions/auth.ts`. Name+PIN search is global (verified `auth.ts:207-211`); destination is a 3-phase global active-session scan (`:217-297`). Risks: a "Miguel" in Club A could reconnect as a "Miguel" in Club B (name+PIN collision); redirect ignores club. **Fix:** scope the lookup to the club from the `/c/[clubSlug]/join` entry; redirect within the same club.

### 6.4 `getAllTimeLeaderboard()` — No Club Argument

**File:** `src/app/actions/leaderboard.ts:214`. Zero-arg, queries the global matview (verified). Must accept `clubId` and filter.

### 6.5 `getPlayerStats()` — `.maybeSingle()` Breakage

**File:** `src/app/actions/leaderboard.ts:455-507`. The all-time branch filters only `.eq("player_id", playerId).maybeSingle()` (verified `:503-507`). Once the matview is keyed `(club_id, player_id)`, a player in multiple clubs returns >1 row → **`PGRST116`**. Add `.eq("club_id", clubId)` before `.maybeSingle()`. (Sharp catch — kept verbatim from v1.)

### 6.6 `player_rivalries` / `player_partnerships` — PRIMARY KEY + RPC body (corrected, C4/C5)

**File:** `supabase/migrations/20260510000000_cross_session_awards.sql`. The conflict targets are **PRIMARY KEYs** `(player_id, rival_id)` / `(player_id, partner_id)`, written by the **`refresh_cross_session_stats` RPC** (called from `closeSession()`). Changing the key to `(club_id, player_id, rival_id)` **and** updating the RPC's `INSERT … ON CONFLICT (…)` + idempotency guard must happen **in one migration step** — otherwise the next `closeSession()` throws `no unique or exclusion constraint matching the ON CONFLICT specification`. See §8 Phase 0 (re-sequenced).

### 6.7 `migrate_player_identity()` — Missing `club_members` (and rivalries/partnerships)

**File:** `supabase/migrations/20260608000000_duplicate_name_resolution.sql`. Add a `club_members.player_id` re-assignment step; also close the pre-existing gap that it never re-points `player_rivalries`/`player_partnerships` (C7).

### 6.8 TV Board — Cross-Check Slug ↔ Session

**File:** `src/app/tv/[sessionId]/page.tsx` (+ `tv.ts`). Fully public, service-role `getTvData` (verified). Under `/c/[clubSlug]/tv/[sessionId]`, 404 if `sessionId` doesn't belong to `clubSlug` (low severity — UUIDs are opaque — but a correctness gap).

### 6.9 Name Uniqueness Scope

`idx_profiles_unique_active_name` enforces **global** uniqueness. **Recommendation:** keep global (identity is global; one profile, many memberships). Per-club uniqueness deferred.

### 6.10 `compute_session_wrapped()` — Rivalries/Partnerships **and** `carry_forward` (corrected)

**File:** the `compute_session_wrapped` RPC (+ `src/lib/wrapped-awards.ts`). Must filter rivalries/partnerships by `club_id` **and** scope the `session_wrapped_stats.carry_forward` read (the previous-session momentum payload `{ended_on_win_streak, session_win_pct, session_id}`) — otherwise a player active in two clubs carries momentum from Club A into Club B's wrapped.

### 6.11 Test Factories and E2E Seeds

**File:** `tests/helpers/init-sandbox.ts` (currently broken — sandbox deleted 2026-06-05). Any session-creating factory must also create a `club` + `club_members` row once `sessions.club_id` is `NOT NULL`.

### 6.12 Monthly Leaderboard — `get_monthly_leaderboard` / `get_leaderboard_months` (NEW — headline omission, C3) 🔴

**File:** `supabase/migrations/20260626000000_monthly_leaderboard.sql`; consumed by `getMonthlyLeaderboard`/`getLeaderboardMonths` (`leaderboard.ts:311,374`), rendered at the **public** `/leaderboard`. Verified body joins `matches ⋈ match_players` filtered **only** by `status='completed'` + `completed_at` in the Manila-month range — **no session/club filter**. Unscoped, this **merges every club into one global monthly ranking**, publicly visible. Add `p_club_id` (or a club join) to both RPCs and the `/leaderboard` route.

### 6.13 `get_player_streaks(NULL)` — Global Win Streak (NEW, C3)

**File:** `supabase/migrations/20260417000000_leaderboard_views.sql`; consumed by all-time leaderboard + `use-enriched-matches.ts`. The all-time call (`p_session_id IS NULL`) scans `v_match_history` across all sessions. Unscoped → a player's "12-win streak" can include wins in other clubs. Add a club filter (free once `v_match_history` carries `club_id`, §4.4).

### 6.14 `get_alltime_snapshot_before(cutoff)` — Global Rank Snapshot (NEW, C3)

**File:** `supabase/migrations/20260617000001_drop_match_origin.sql`; consumed at `leaderboard.ts:230` for rank-movement arrows. Re-aggregates pre-cutoff matches grouped by `player_id` only. Even after the matview is club-keyed, this companion RPC stays global → garbage "current vs previous rank" deltas. Must take `club_id` too.

### 6.15 `get_h2h_record(...)` — Global All-Time Counters (NEW, C3)

**File:** `supabase/migrations/20260426100000_h2h_record_function.sql`; consumed by `getH2HRecord` (`h2h.ts`) on draft/match cards. `session_a/b` counters are session-filtered, but `alltime_a/b` span all sessions → "5–2 all-time" can include a different club's matches. Add `club_id` to the all-time legs.

### 6.16 `match_events` — Cross-Session Audit Log (NEW, C3)

See §4.3. Has `session_id`; RLS-enabled; absent from v1 entirely. Decide transitive-vs-explicit club scope; include in the RLS review and any future "club activity feed."

### 6.17 `v_match_history` — The Global Base View (NEW, C3)

See §4.4. The root of the leaderboard/streak chain. If it doesn't carry `club_id`, three downstream objects (`v_session_leaderboard`, `v_alltime_leaderboard_mat`, `get_player_streaks`) each must re-join `matches→sessions`. Scope it **first**.

---

## 7. Known Risks & Mitigations

### 7.1 Supabase 200-Connection Ceiling
Free tier = 200 concurrent Realtime sockets; ~32 per open session+TV → ceiling near ~6 sessions. **Mitigations:** coalesce organizer+player dashboards of the same session onto one channel; keep the `channelPrefix` (`session-events:{sessionId}`) pattern; upgrade to Supabase Pro when consistently >150.

### 7.2 Matview Refresh Bottleneck
`refresh_alltime_leaderboard()` runs on every match end and rebuilds the whole matview across all clubs. **Mitigations:** `REFRESH … CONCURRENTLY` (needs the `(club_id, player_id)` unique index — §4.4); debounce to ≤ once/min; long-term, a trigger-maintained running-total table.

### 7.3 Slug Lifecycle
A slug is embedded in every QR/link/bookmark; renaming breaks them. **Mitigation:** `club_slug_redirects (old_slug, new_slug)`; the `/c/[clubSlug]` resolver checks both.

### 7.4 Google OAuth Callback Routing
`/auth/callback` redirects to a `next` param. Update OAuth `next` to club-scoped URLs; test OAuth + QR-join + reconnect in the new hierarchy before deploy.

### 7.5 Role Overlap: Club Admin vs Session Organizer (corrected, C6)
`isSessionOrganizer()` today checks `sessions.created_by` + `session_organizers` (verified `_shared.ts:71`). Add a third check: club `owner`/`admin` → implicit organizer. **Apply in BOTH places:** the TS helper **and** the SQL `is_session_organizer()` SECURITY DEFINER function used by ~15 RLS policies. Use the service-role client; verify every dependent policy after the change.

### 7.6 Per-Club Skill Levels
`profiles.skill_level` is global. Keep global for now; a future `club_members.skill_level` can override per club without touching the enum.

### 7.7 Player Offboarding
No "leave club" today. **Mitigation:** `club_members.is_active=false` (soft) — deactivated members can't join sessions, drop off the roster, but historical data (matches, wrapped, leaderboard) is preserved.

### 7.8 `NOT NULL` Timing for `sessions.club_id`
Immediate `NOT NULL` on a populated table fails. The 3-step approach (§8 Phase 0) is non-negotiable; verify 0 NULLs before `SET NOT NULL`.

---

## 8. Implementation Sequencing

Incremental — never one deployment.

### Phase 0 — Foundation (No Breaking Changes)

1. `CREATE TABLE clubs`; `club_invites`; `club_members`.
2. Create the **Default Club** row (absorbs existing data).
3. `ALTER TABLE sessions ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE RESTRICT` — nullable.
4. Backfill `sessions.club_id` = default club; verify `COUNT(*) WHERE club_id IS NULL = 0`; then `SET NOT NULL`.
5. `ALTER TABLE player_rivalries/player_partnerships ADD COLUMN club_id` — nullable; backfill to default club.
6. **Atomic step (C4):** in one migration, `DROP` the rivalry/partnership **PRIMARY KEY**, `ADD PRIMARY KEY (club_id, player_id, …)`, **and** `CREATE OR REPLACE refresh_cross_session_stats` with `club_id` in its SELECT/INSERT column lists, `ON CONFLICT (club_id, player_id, …)` targets, and idempotency guard. (Do not split — a partial apply breaks the next `closeSession()`.)
7. Update `migrate_player_identity()` — add `club_members` re-assignment (and rivalries/partnerships, C7).

**Gate:** all existing functionality works unchanged. Deploy + verify before proceeding.

### Phase 1 — Club Registration UI
1. `/clubs/new` creation form. 2. Invite system (`club_invites`, `/clubs/join?invite=`). 3. `getClubBySlug()`. 4. `/c/[clubSlug]` layout (resolve slug→id). 5. **Multi-club home `/`** + `/c/[clubSlug]/admin` (§3.4).

### Phase 2 — Route Migration
1. Relocate `/play`, `/organizer`, `/tv`, `/wrapped`, `/leaderboard`, `/join` under `/c/[clubSlug]/…` (C2 — relocation, not de-branch). Update hardcoded `router.push` paths.
2. `isClubMember()` / `isClubAdmin()` helpers.
3. `isSessionOrganizer()` — add club-admin check in **both** the TS helper and the SQL function (C6).
4. Add `clubId` to all scoped Server Actions.
5. `reconnectPlayer()` — scope by club.
6. `getAllTimeLeaderboard(clubId)`.
7. `getPlayerStats()` — `.eq("club_id", clubId)` before `.maybeSingle()`.
8. QR-join auto-enroll + `lookup_active_session` returns `club_slug`.
9. TV board — cross-check `slug ↔ session`.

### Phase 3 — Global State Migration
1. **Scope `v_match_history` with `club_id` first** (C3 — base view).
2. Rebuild `v_alltime_leaderboard_mat` at `(club_id, player_id)` + unique index; pass `club_id` through `v_session_leaderboard`.
3. Club-scope the aggregator RPCs: `get_monthly_leaderboard`, `get_leaderboard_months`, `get_player_streaks`, `get_alltime_snapshot_before`, `get_h2h_record` (§6.12–§6.15).
4. `compute_session_wrapped()` — filter rivalries/partnerships **and** `carry_forward` by club (§6.10).
5. Refresh matview; update OAuth `next` to club-scoped URLs.

### Phase 4 — Hardening (Optional)
1. **Replace** (not add) permissive `SELECT USING(true)` policies on `sessions`, `courts`, `matches`, `queue_entries`, `match_players`, `profiles` with club-scoped reads; de-dupe the two `matches` SELECT policies; preserve the draft firewall + public TV/QR paths (C1/§5.2).
2. Matview refresh debounce (§7.2). 3. `club_slug_redirects` (§7.3). 4. Update test factories (§6.11).

---

## 9. Database Migration Checklist

### Schema Changes (ordered)
- [ ] `CREATE TABLE clubs` / `club_invites` / `club_members`
- [ ] Insert Default Club row
- [ ] `ALTER TABLE sessions ADD COLUMN club_id uuid REFERENCES clubs(id) ON DELETE RESTRICT` (nullable)
- [ ] Backfill `sessions.club_id`; verify 0 NULLs; `SET NOT NULL`
- [ ] `ALTER TABLE player_rivalries/player_partnerships ADD COLUMN club_id` (nullable); backfill
- [ ] **(atomic)** swap rivalry/partnership PRIMARY KEY → `(club_id, …)` **and** `CREATE OR REPLACE refresh_cross_session_stats` together (C4)
- [ ] **Scope `v_match_history` with `club_id`** (base view — do before downstream) (C3)
- [ ] Rebuild `v_alltime_leaderboard_mat` `(club_id, player_id)` + `CREATE UNIQUE INDEX (club_id, player_id)`
- [ ] Pass `club_id` through `v_session_leaderboard`
- [ ] `refresh_alltime_leaderboard()` after rebuild

### RPC Changes (ordered)
- [ ] `migrate_player_identity` — add `club_members` (+ rivalries/partnerships) re-assignment (C7)
- [ ] `lookup_active_session` — add `club_slug` to return
- [ ] `get_monthly_leaderboard` / `get_leaderboard_months` — add club filter (C3) 🔴
- [ ] `get_player_streaks` — club filter (C3)
- [ ] `get_alltime_snapshot_before` — club filter (C3)
- [ ] `get_h2h_record` — club-scope `alltime_a/b` (C3)
- [ ] `compute_session_wrapped` — filter rivalries/partnerships **and** `carry_forward` by club
- [ ] `is_session_organizer()` (SQL, SECURITY DEFINER) — add club-admin check (C6)

### Application Code Changes (ordered, after schema is stable)
- [ ] `getClubBySlug` / `isClubMember` / `isClubAdmin` helpers — new
- [ ] `isSessionOrganizer()` (TS) — add club-admin check (C6)
- [ ] `/c/[clubSlug]` layout — resolve slug→id; **multi-club home `/`** (§3.4)
- [ ] Relocate `/play` `/organizer` `/tv` `/wrapped` `/leaderboard` `/join`; fix hardcoded `router.push` paths (C2)
- [ ] All scoped Server Actions — add `clubId` filter
- [ ] `reconnectPlayer()` — scope by club
- [ ] `getAllTimeLeaderboard(clubId)` / `getPlayerStats(playerId, clubId)` (`.maybeSingle()` fix)
- [ ] `getMonthlyLeaderboard` / `getLeaderboardMonths` + `/leaderboard` route — pass club (C3) 🔴
- [ ] `getH2HRecord` — pass club
- [ ] QR-join auto-enroll + new route; TV slug↔session cross-check
- [ ] Google OAuth callback `next` → club-scoped URLs
- [ ] Test factories / E2E seeds — add club + member creation

---

## Appendix: Decision Log

| Decision | Rationale |
|----------|-----------|
| Shared schema (not schema-per-tenant) | Supabase PostgREST targets `public` only; cross-schema migrations are complex |
| Path-based routing (`/c/[clubSlug]`) | Wildcard SSL needs Vercel Pro; subdomains untenable on Hobby |
| App-layer isolation primary; RLS tightening second | RLS **is** enabled today but reads are `USING(true)` + anon-allowed, and service-role bypasses RLS — so `club_id` in app code is the real control (C1) |
| Organizer authority resolved per `(club, session)` | One global identity; club admin = implicit organizer; session organizer preserved for one-off elevation (§3.4) |
| `NOT NULL` in 3 steps | Live table; immediate `NOT NULL` locks & fails |
| Rivalry/partnership PK swap paired with RPC body | Conflict target must match an existing constraint or `closeSession()` throws (C4) |
| Scope `v_match_history` before downstream | It's the base view for matview + session board + streaks (C3) |
| Club-scope all on-the-fly aggregators | Monthly board / streaks / snapshot / h2h silently merge clubs otherwise (C3) |
| Global player identity + global name uniqueness | One player, many clubs; avoids per-club dedup |
| `ON DELETE RESTRICT` on `sessions.club_id` | Prevent orphaning sessions on club delete |
| Auto-enroll on QR-join | QR = implicit invite; zero-friction onboarding |
| Soft-deactivate members | Preserve historical stats for leaderboard integrity |
