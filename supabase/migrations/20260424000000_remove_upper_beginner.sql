-- ============================================================
-- Migration: remove_upper_beginner
-- Permanently removes the "upper_beginner" skill level.
--
-- Decision: existing upper_beginner profiles → downgraded to beginner
--           (Option A, approved 2026-04-24)
--
-- Steps:
--   1. Migrate existing upper_beginner profiles to beginner
--   2. Drop dependents (view + function) that block the type swap
--   3. Replace the ENUM type with the new 6-value set
--   4. Restore skill_level_to_int() with renumbered 1–6 mapping
--   5. Restore v_queue_with_wait_time against the new type
--
-- IDEMPOTENCY (local dev): Steps 1–3 are wrapped in a DO block
-- that only fires if 'upper_beginner' still exists in the
-- skill_level enum. When the initial_schema migration creates
-- skill_level without 'upper_beginner', these steps are no-ops.
-- Steps 4–5 use CREATE OR REPLACE and are always idempotent.
-- ============================================================

-- ── Steps 1–3: Type swap (only if upper_beginner still exists) ─
DO $$
BEGIN
  -- Check whether 'upper_beginner' still exists in the skill_level enum.
  -- If the base schema already created skill_level without it, skip everything.
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'skill_level'
      AND e.enumlabel = 'upper_beginner'
  ) THEN

    -- Step 1: Migrate existing rows
    UPDATE public.profiles
    SET skill_level = 'beginner'::text::skill_level
    WHERE skill_level = 'upper_beginner';

    -- Step 2: Drop dependents that block the type swap
    DROP VIEW IF EXISTS public.v_queue_with_wait_time;
    DROP FUNCTION IF EXISTS public.skill_level_to_int(skill_level);

    -- Step 3a: Create the new 6-value enum (upper_beginner removed).
    CREATE TYPE skill_level_new AS ENUM (
      'beginner',
      'lower_intermediate',
      'intermediate',
      'upper_intermediate',
      'lower_advanced',
      'advanced'
    );

    -- Step 3b: Drop the column default, alter the column, restore.
    ALTER TABLE public.profiles
      ALTER COLUMN skill_level DROP DEFAULT;

    ALTER TABLE public.profiles
      ALTER COLUMN skill_level TYPE skill_level_new
      USING skill_level::text::skill_level_new;

    -- Step 3c: Drop the old enum and rename the new one.
    DROP TYPE public.skill_level;
    ALTER TYPE skill_level_new RENAME TO skill_level;

    -- Step 3d: Restore the column default.
    ALTER TABLE public.profiles
      ALTER COLUMN skill_level SET DEFAULT 'beginner'::skill_level;

  END IF;
END $$;

-- ── Step 4: Restore skill_level_to_int() ─────────────────────
-- Always runs — CREATE OR REPLACE is idempotent.
-- Renumbered 1–6: lower_intermediate through advanced each shift
-- down by 1, closing the gap left by upper_beginner.
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

-- ── Step 5: Restore v_queue_with_wait_time ────────────────────
-- Always runs — CREATE OR REPLACE is idempotent.
CREATE OR REPLACE VIEW public.v_queue_with_wait_time AS
SELECT
  qe.id,
  qe.session_id,
  qe.player_id,
  qe.joined_at,
  qe.games_played,
  qe.status,
  qe.position,
  qe.is_paused,
  qe.created_at,
  p.display_name,
  p.skill_level,
  public.skill_level_to_int(p.skill_level) AS skill_level_int,
  EXTRACT(EPOCH FROM now() - qe.joined_at) / 60 AS wait_minutes,
  CASE
    WHEN (EXTRACT(EPOCH FROM now() - qe.joined_at) / 60) > 20 THEN true
    ELSE false
  END AS is_bottleneck
FROM public.queue_entries qe
JOIN public.profiles p ON p.id = qe.player_id
WHERE qe.status = 'waiting'::public.queue_status
ORDER BY qe.games_played, qe.joined_at;
