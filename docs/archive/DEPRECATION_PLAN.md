# Deprecation Plan: Remove "Upper Beginner" Skill Level

> **Status: DRAFT — Awaiting product decision + approval before any execution**
>
> No code has been modified. No SQL has been executed. This document is purely analytical.

---

## Table of Contents

1. [Database Audit & Migration Strategy](#1-database-audit--migration-strategy)
2. [Codebase Audit](#2-codebase-audit)
3. [Matchmaking Engine Impact](#3-matchmaking-engine-impact)
4. [Clarifying Questions (Decision Required)](#4-clarifying-questions-decision-required)
5. [Recommended Execution Order](#5-recommended-execution-order)

---

## 1. Database Audit & Migration Strategy

### 1.1 Where is `skill_level` stored?

| Table / Object | Column | Type | Notes |
|---|---|---|---|
| `public.profiles` | `skill_level` | `skill_level` ENUM | **Only table with this column** |
| `public.queue_entries` | _(none)_ | — | The view `v_queue_with_wait_time` JOINs `profiles` to expose `skill_level` — no copy stored here |
| `public.v_queue_with_wait_time` | `skill_level`, `skill_level_int` | view columns | Computed from `profiles.skill_level` at query time |
| `public.skill_level_to_int` | — | Postgres function | Maps enum label → integer 1–7; **must be updated** |

**Conclusion:** The only write target is `profiles.skill_level`. Everything else derives from it.

### 1.2 Is `skill_level` an ENUM or TEXT?

It is a **Postgres custom ENUM type**, confirmed by:
- `src/types/database.ts` line 459: `skill_level: SkillLevel` under `Database.public.Enums`
- The same ENUM casting pattern (`::match_status`, `::queue_status`, `::court_status`) used throughout migrations applies equally to `skill_level`

### 1.3 The Postgres ENUM Problem

PostgreSQL does **not** allow `ALTER TYPE … DROP VALUE` — it has no such command. Removing a value from an existing ENUM requires a full type replacement:

```sql
CREATE TYPE skill_level_new AS ENUM (
  'beginner',
  'lower_intermediate',
  'intermediate',
  'upper_intermediate',
  'lower_advanced',
  'advanced'
);
```

This is a multi-step atomic process (outlined in §1.5 below).

### 1.4 Data Migration Decision (See §4)

Before any SQL runs, you must answer **Clarifying Question #1**: where do existing `upper_beginner` profiles land after migration? Two options:

| Option A | Downgrade → `beginner` |
|---|---|
| Option B | Upgrade → `lower_intermediate` |

The SQL template below uses a placeholder `'<TARGET_LEVEL>'` — fill it in once you decide.

### 1.5 Exact SQL for the Migration

This would live in a new migration file, e.g. `20260424000000_remove_upper_beginner.sql`.

```sql
-- ============================================================
-- Migration: remove_upper_beginner
-- Permanently removes the "upper_beginner" skill level.
-- Steps:
--   1. Migrate existing upper_beginner profiles to <TARGET_LEVEL>
--   2. Replace the ENUM type with the new 6-value set
--   3. Update the skill_level_to_int() function (renumbered 1-6)
-- ============================================================

-- ── Step 1: Migrate existing rows ────────────────────────────
-- Replace '<TARGET_LEVEL>' with 'beginner' OR 'lower_intermediate'
-- depending on the product decision from §4, Q1.
UPDATE public.profiles
SET skill_level = '<TARGET_LEVEL>'::text::skill_level
WHERE skill_level = 'upper_beginner';

-- ── Step 2: Swap the ENUM type ────────────────────────────────
-- 2a. Create the new enum (without upper_beginner)
CREATE TYPE skill_level_new AS ENUM (
  'beginner',
  'lower_intermediate',
  'intermediate',
  'upper_intermediate',
  'lower_advanced',
  'advanced'
);

-- 2b. Alter the profiles column to use the new enum
--     (all rows are already migrated off upper_beginner at this point)
ALTER TABLE public.profiles
  ALTER COLUMN skill_level TYPE skill_level_new
  USING skill_level::text::skill_level_new;

-- 2c. Drop the old enum; rename the new one
DROP TYPE public.skill_level;
ALTER TYPE public.skill_level_new RENAME TO skill_level;

-- ── Step 3: Replace skill_level_to_int() ─────────────────────
-- Renumbered 1–6 (upper_beginner slot removed; all levels ≥ 3
-- shift down by 1 to close the gap).
CREATE OR REPLACE FUNCTION public.skill_level_to_int(lvl skill_level)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT CASE lvl
    WHEN 'beginner'           THEN 1
    WHEN 'lower_intermediate' THEN 2
    WHEN 'intermediate'       THEN 3
    WHEN 'upper_intermediate' THEN 4
    WHEN 'lower_advanced'     THEN 5
    WHEN 'advanced'           THEN 6
  END;
$$;
```

> **Why `::text::skill_level_new` cast?**  
> Postgres won't cast directly between two custom ENUM types. Routing through `::text` is the standard pattern used throughout this codebase's existing migrations.

---

## 2. Codebase Audit

### 2.1 All `upper_beginner` References

| File | Line(s) | What changes |
|---|---|---|
| `src/types/database.ts` | 18, 28 | Remove from `SkillLevel` union; remove from `SKILL_LEVELS` array; renumber remaining entries |
| `src/components/ui/skill-badge.tsx` | 7, 25–27 | Remove `upper_beginner` key from `LEVEL_CONFIG` record |
| `src/app/actions/dev.ts` | 253, 265 | Update two seeded players (Mariah, Bianca) to a valid level |
| `src/components/login-form.tsx` | _(driven by SKILL_LEVELS array)_ | **Auto-fixed** — the dropdown is built from `SKILL_LEVELS`; no direct reference |

No Zod schemas found for skill levels. No other files contain the string `upper_beginner`.

### 2.2 `src/types/database.ts` — Required Changes

**`SkillLevel` union (line 17–24):** remove `"upper_beginner"`:
```ts
// BEFORE
export type SkillLevel =
  | "beginner"
  | "upper_beginner"      // ← remove
  | "lower_intermediate"
  | "intermediate"
  | "upper_intermediate"
  | "lower_advanced"
  | "advanced";

// AFTER
export type SkillLevel =
  | "beginner"
  | "lower_intermediate"
  | "intermediate"
  | "upper_intermediate"
  | "lower_advanced"
  | "advanced";
```

**`SKILL_LEVELS` array (lines 26–34):** remove the entry AND renumber all entries at or above the removed slot:
```ts
// BEFORE
{ value: "beginner",           label: "Beginner",           numeric: 1 },
{ value: "upper_beginner",     label: "Upper Beginner",     numeric: 2 },  // ← remove
{ value: "lower_intermediate", label: "Lower Intermediate", numeric: 3 },
{ value: "intermediate",       label: "Intermediate",       numeric: 4 },
{ value: "upper_intermediate", label: "Upper Intermediate", numeric: 5 },
{ value: "lower_advanced",     label: "Lower Advanced",     numeric: 6 },
{ value: "advanced",           label: "Advanced",           numeric: 7 },

// AFTER (shift numerics down by 1 for all levels that were ≥ 3)
{ value: "beginner",           label: "Beginner",           numeric: 1 },
{ value: "lower_intermediate", label: "Lower Intermediate", numeric: 2 },
{ value: "intermediate",       label: "Intermediate",       numeric: 3 },
{ value: "upper_intermediate", label: "Upper Intermediate", numeric: 4 },
{ value: "lower_advanced",     label: "Lower Advanced",     numeric: 5 },
{ value: "advanced",           label: "Advanced",           numeric: 6 },
```

> **`skillLevelToInt()` TypeScript function** (lines 37–40) — no direct changes needed. It calls `SKILL_LEVELS.find()`, so it auto-corrects once the array is updated. The fallback `?? 1` (beginner) remains correct.

### 2.3 `src/components/ui/skill-badge.tsx` — Required Changes

Remove the `upper_beginner` entry from `LEVEL_CONFIG`.

Because `LEVEL_CONFIG` is typed as `Record<SkillLevel, ...>`, TypeScript's exhaustiveness checker **will fail to compile** if `upper_beginner` remains in the type but is absent from the record — and vice versa. The type change in `database.ts` and this record removal must happen together.

```ts
// BEFORE
const LEVEL_CONFIG: Record<SkillLevel, { label: string; classes: string }> = {
  beginner:           { label: "Beg.",       classes: "bg-emerald-..." },
  upper_beginner:     { label: "Upper Beg.", classes: "bg-emerald-..." },  // ← remove
  lower_intermediate: { ... },
  ...
}

// AFTER — just delete the upper_beginner line
```

### 2.4 `src/app/actions/dev.ts` — Required Changes

Two hardcoded seeded players reference `"upper_beginner"`. Update them to valid levels post-migration:

```ts
// Line 253 — Mariah
{ name: "Mariah", skill: "beginner" }   // or "lower_intermediate" — your call

// Line 265 — Bianca
{ name: "Bianca", skill: "beginner" }   // or "lower_intermediate" — your call
```

This file is development-only and not user-facing; choose whatever is most useful for testing the skill spread.

---

## 3. Matchmaking Engine Impact

### 3.1 How Skill Levels Drive Matchmaking

The engine (in `src/app/actions/matchmaking.ts` + `src/lib/constants.ts`) uses numeric skill levels to filter eligible partners:

```
Preferred window: |player_a.skill_level_int - player_b.skill_level_int| ≤ SKILL_VARIANCE_TARGET (1)
Expanded window:  |delta| ≤ SKILL_VARIANCE_MAX (2)
Red Zone:         |delta| ≤ 3, then 4
Mixed-level flag: maxVariance > SKILL_VARIANCE_MAX (i.e. > 2) → is_mixed_level = true
```

### 3.2 The Gap Problem (Why Renumbering Is Mandatory)

If `upper_beginner` is simply removed without renumbering, the integers become non-contiguous:

| Level | OLD numeric | POST-REMOVAL (no renumber) |
|---|---|---|
| beginner | 1 | 1 |
| ~~upper_beginner~~ | ~~2~~ | _(deleted)_ |
| lower_intermediate | 3 | **3** ← gap of 2 from beginner |
| intermediate | 4 | 4 |
| upper_intermediate | 5 | 5 |
| lower_advanced | 6 | 6 |
| advanced | 7 | 7 |

**Consequence:** A `beginner` (1) and a `lower_intermediate` (3) are now **2 apart** by default — they land in the "expanded" window immediately, skipping the preferred ±1 tier entirely. A `beginner` paired with an `intermediate` (4) would be ±3, triggering a mixed-level match that previously wouldn't. The skill ladder semantics break entirely.

### 3.3 The Fix: Renumber 1–6, Close the Gap

| Level | OLD numeric | NEW numeric |
|---|---|---|
| beginner | 1 | **1** |
| lower_intermediate | 3 | **2** |
| intermediate | 4 | **3** |
| upper_intermediate | 5 | **4** |
| lower_advanced | 6 | **5** |
| advanced | 7 | **6** |

After this renumbering:
- Every adjacent pair is still ±1 apart → preferred window works correctly
- `SKILL_VARIANCE_TARGET = 1` and `SKILL_VARIANCE_MAX = 2` need **no changes**
- The `mixed_level` flag threshold (`> 2`) still works correctly
- Red Zone windows (3, 4) now cover 3–4 levels span instead of up to advanced — same behavior

### 3.4 The Postgres `skill_level_to_int()` Function

This database function is used by the `v_queue_with_wait_time` view to produce `skill_level_int`. It must be updated to return the new 1–6 numerics (see §1.5, Step 3). If the function is not updated, `v_queue_with_wait_time.skill_level_int` will continue returning the old values (3–7 instead of 2–6), and matchmaking will use stale data.

> **Critical ordering:** the SQL migration (Steps 1–3) must be applied to Supabase **before** the TypeScript frontend changes are deployed. If the frontend deploys first, any query touching `v_queue_with_wait_time` will receive `skill_level_int` values that don't match what the new TS code expects.

---

## 4. Clarifying Questions (Decision Required)

### Q1 — DATA MIGRATION: What happens to existing `upper_beginner` players? *(Required)*

This is the most consequential product decision. Before any SQL runs, you must choose one:

| Option | SQL change | Player experience |
|---|---|---|
| **A: Downgrade to `beginner`** | `SET skill_level = 'beginner'` | Players who self-identified as slightly-above-beginner are now lumped with true beginners. May feel like a demotion. Simpler. |
| **B: Upgrade to `lower_intermediate`** | `SET skill_level = 'lower_intermediate'` | Players are bumped up a tier. Better matchmaking experience if they're genuinely past beginner. May surprise some players. |

**Recommendation:** Option B (upgrade to `lower_intermediate`) is safer for game quality. Upper beginner was already defined as "above beginner" — placing them with lower intermediates is a more accurate representation. But this is your call.

### Q2 — DEV SEED: What levels should Mariah and Bianca (seeded test players) become? *(Low stakes)*

These are development-only fixtures. Suggest `"beginner"` and `"lower_intermediate"` respectively so you maintain at least one player at each of the two adjacent levels for testing.

### Q3 — NOTIFICATION: Should existing `upper_beginner` players be notified of their new skill level? *(Optional)*

Do you want to surface a "Your skill level has been updated" banner or email after the migration? Or is this a silent backend change?

---

## 5. Recommended Execution Order

Once you've answered Q1 and approved this plan, execution should proceed in this strict order to avoid a window where the DB and app are out of sync:

```
Step 1 — Supabase migration (SQL)
  1a. UPDATE profiles: migrate upper_beginner rows to <TARGET_LEVEL>
  1b. CREATE TYPE skill_level_new, ALTER TABLE, DROP + RENAME type
  1c. CREATE OR REPLACE FUNCTION skill_level_to_int() (new 1–6 mapping)

Step 2 — TypeScript changes (all in one commit)
  2a. src/types/database.ts — SkillLevel union + SKILL_LEVELS array + numerics
  2b. src/components/ui/skill-badge.tsx — remove upper_beginner from LEVEL_CONFIG
  2c. src/app/actions/dev.ts — update Mariah + Bianca seeded levels

Step 3 — Deploy
  Deploy the TypeScript changes. The DB is already migrated, so no window of inconsistency.

Step 4 — Verify
  - Run `npx tsc --noEmit` — should compile with zero errors (exhaustiveness check passes)
  - Check the registration form: "Upper Beginner" should not appear in the dropdown
  - Check the organizer queue table: no skill badge for "Upper Beg." appears
  - Run the matchmaking engine against a test session containing the migrated players
```

---

*This plan was authored as a pre-execution audit. No code has been changed, no SQL has been executed. Awaiting your answers to §4 and formal approval to proceed.*
