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
-- ============================================================

-- ── Step 1: Migrate existing rows ────────────────────────────
UPDATE public.profiles
SET skill_level = 'beginner'::text::skill_level
WHERE skill_level = 'upper_beginner';

-- ── Step 2: Drop dependents that block the type swap ─────────

-- The view depends on profiles.skill_level (column type).
DROP VIEW IF EXISTS public.v_queue_with_wait_time;

-- The function depends on the skill_level type as its parameter.
DROP FUNCTION IF EXISTS public.skill_level_to_int(skill_level);

-- ── Step 3: Swap the ENUM type ────────────────────────────────

-- 3a. Create the new 6-value enum (upper_beginner removed).
CREATE TYPE skill_level_new AS ENUM (
  'beginner',
  'lower_intermediate',
  'intermediate',
  'upper_intermediate',
  'lower_advanced',
  'advanced'
);

-- 3b. Drop the column default (it references the old type OID and
--     cannot be auto-cast), alter the column, then restore.
ALTER TABLE public.profiles
  ALTER COLUMN skill_level DROP DEFAULT;

ALTER TABLE public.profiles
  ALTER COLUMN skill_level TYPE skill_level_new
  USING skill_level::text::skill_level_new;

-- 3c. Drop the old enum and rename the new one into its place.
DROP TYPE public.skill_level;
ALTER TYPE public.skill_level_new RENAME TO skill_level;

-- 3d. Restore the column default against the final type name.
ALTER TABLE public.profiles
  ALTER COLUMN skill_level SET DEFAULT 'beginner'::skill_level;

-- ── Step 4: Restore skill_level_to_int() ─────────────────────
-- Renumbered 1–6: lower_intermediate through advanced each shift
-- down by 1, closing the gap left by upper_beginner.
-- Preserves ±1 preferred / ±2 max matchmaking window semantics.
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
