# Database Reset Plan: Total Hard Wipe

> **Status: DRAFT — Awaiting explicit approval before any execution**
>
> No SQL has been executed. This document is purely analytical.

---

## Current State (Live Row Counts)

| Table | Rows |
|---|---|
| `auth.users` | **379** |
| `public.profiles` | **379** |
| `public.sessions` | 4 |
| `public.courts` | 12 |
| `public.queue_entries` | 132 |
| `public.matches` | 101 |
| `public.match_players` | 404 |
| `public.match_games` | 0 |
| `public.session_organizers` | 17 |
| `public.session_wrapped_stats` | 0 |
| `public.push_subscriptions` | 4 |

---

## 1. Foreign Key Hierarchy (Dependency Map)

This is the complete FK graph, audited live from the database.

```
auth.users  ←─────────────────────────────────┐
    │                                           │
    │ ON DELETE CASCADE                         │
    ▼                                           │
public.profiles ──────────── ON DELETE NO ACTION ──► public.sessions
    │                                                      │
    │ ON DELETE CASCADE (all below)                        │ ON DELETE CASCADE (all below)
    ├──► queue_entries                                     ├──► courts
    ├──► match_players                                     ├──► matches ──► match_players (CASCADE)
    ├──► session_organizers                                │              └──► match_games  (CASCADE)
    ├──► session_wrapped_stats                             ├──► queue_entries
    └──► push_subscriptions                                ├──► session_organizers
                                                           └──► session_wrapped_stats
```

### The One Critical Constraint

`sessions.created_by → profiles.id` is **`ON DELETE NO ACTION`**.

This means: you **cannot** delete a `profiles` row while that player has sessions in the table. If you try to delete `auth.users` first (cascading to `profiles`), it will fail with a foreign key violation on `sessions.created_by`.

**Solution:** Wipe sessions (and all their dependents) *before* touching profiles or auth.users.

### The profiles → auth.users Relationship

The `profiles.id` column references `auth.users.id` with **`ON DELETE CASCADE`** (confirmed by the exact 1:1 row count match: 379 profiles = 379 auth users). Deleting from `auth.users` would automatically cascade to `profiles` — but only safely *after* sessions are already gone (see above).

---

## 2. The Reset SQL Script

### Strategy: TRUNCATE CASCADE the public schema first, then DELETE auth.users

`TRUNCATE ... CASCADE` in PostgreSQL truncates the named tables *and* all tables that reference them via foreign keys, regardless of the `ON DELETE` rule. It's the fastest, safest way to clear all public data in one shot. Then `DELETE FROM auth.users` wipes the Supabase auth layer.

```sql
-- ============================================================
-- TOTAL HARD RESET — Chillax Badminton
-- Drafted: 2026-04-24
-- ============================================================
-- WARNING: This is irreversible. Every user, session, match,
-- and queue entry will be permanently deleted.
-- Run ONLY in the Supabase Dashboard SQL Editor.
-- ============================================================

-- ── Step 1: Wipe all public tables ───────────────────────────
-- TRUNCATE CASCADE handles every FK dependency automatically.
-- Order: leaf tables first, then parents. CASCADE fills any gaps.
--
-- sessions must be truncated BEFORE profiles because of the
-- NO ACTION FK on sessions.created_by → profiles.id.
TRUNCATE TABLE
  public.match_games,
  public.match_players,
  public.matches,
  public.queue_entries,
  public.session_wrapped_stats,
  public.session_organizers,
  public.courts,
  public.sessions,
  public.push_subscriptions,
  public.profiles
CASCADE;

-- ── Step 2: Wipe Supabase auth users ─────────────────────────
-- At this point, public.profiles is already empty, so the
-- auth.users → profiles cascade has nothing left to do.
-- This requires the postgres (superuser) role.
DELETE FROM auth.users;

-- ── Verify (run after execution) ─────────────────────────────
SELECT 'profiles'              AS tbl, COUNT(*) AS rows FROM public.profiles
UNION ALL SELECT 'sessions',              COUNT(*) FROM public.sessions
UNION ALL SELECT 'courts',               COUNT(*) FROM public.courts
UNION ALL SELECT 'queue_entries',        COUNT(*) FROM public.queue_entries
UNION ALL SELECT 'matches',             COUNT(*) FROM public.matches
UNION ALL SELECT 'match_players',       COUNT(*) FROM public.match_players
UNION ALL SELECT 'session_organizers',  COUNT(*) FROM public.session_organizers
UNION ALL SELECT 'push_subscriptions',  COUNT(*) FROM public.push_subscriptions
UNION ALL SELECT 'auth.users',          COUNT(*) FROM auth.users
ORDER BY tbl;
-- Every row in the result should be 0.
```

---

## 3. Execution Steps

### Why the SQL Editor, not Supabase MCP or the JS client

`DELETE FROM auth.users` requires the **`postgres` superuser role**. The Supabase service-role key (used by the app and MCP tools) is a JWT-based role that does not have permission to delete from `auth.users` directly — it will silently return 0 rows or throw a permission error.

The only safe way to run this is via the Supabase Dashboard SQL Editor, which executes as the `postgres` role.

### Step-by-Step

1. **Open** the Supabase Dashboard → your project → **SQL Editor**
2. **Paste** the full script above (both steps) into a single query window
3. **Read it once more** — this cannot be undone
4. Click **Run**
5. Check the verification SELECT at the bottom — every count should be **0**

### What happens automatically

| Table | How it's cleared |
|---|---|
| `match_games` | Explicit TRUNCATE |
| `match_players` | Explicit TRUNCATE |
| `matches` | Explicit TRUNCATE |
| `queue_entries` | Explicit TRUNCATE |
| `session_wrapped_stats` | Explicit TRUNCATE |
| `session_organizers` | Explicit TRUNCATE |
| `courts` | Explicit TRUNCATE |
| `sessions` | Explicit TRUNCATE |
| `push_subscriptions` | Explicit TRUNCATE |
| `profiles` | Explicit TRUNCATE |
| `auth.users` | Explicit DELETE |

Nothing is left to chance — every table is named explicitly.

---

## 4. What This Does NOT Touch

- **Database schema** — all tables, views, functions, RLS policies, and migrations remain intact. The app will work immediately after the reset; users just need to re-register.
- **Supabase Storage** — any uploaded files (icons, etc.) are unaffected.
- **Vercel environment variables** — unaffected.
- **Supabase project settings** — unaffected.

---

## 5. Post-Reset State

After execution the database is in a clean "day zero" state:

- All tables empty
- Schema fully intact (all migrations applied)
- App immediately usable — new users can register, organizers can create sessions
- No stale sessions, ghost matches, or dev-seeded test players

---

*This plan was authored as a pre-execution draft. No SQL has been run. Awaiting explicit approval to proceed.*
