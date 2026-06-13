-- ============================================================
-- Migration: harden handle_new_user() for OAuth / metadata-less inserts
-- ============================================================
-- The auto-create trigger fires AFTER INSERT on auth.users for EVERY new user,
-- including OAuth (Google) sign-ins — and it runs BEFORE our /auth/callback can
-- derive a real name. The old body COALESCEd a missing display_name to the
-- literal 'Player', so the SECOND metadata-less sign-in would mint a second
-- 'Player' and violate the partial UNIQUE index idx_profiles_unique_active_name
-- (added in 20260608000001), failing the sign-in opaquely.
--
-- Fix: when no vetted display_name is supplied in metadata (the OAuth path),
-- insert a UNIQUE placeholder stub flagged needs_rename=true. Flagged rows are
-- EXCLUDED from the partial unique index, so placeholders can never collide.
-- /auth/callback then derives the real (unique) name and clears the flag, or —
-- on a collision — records collided_name and the /rename gate resolves it.
--
-- The anonymous / standard path (signInAnonymously, which always supplies a
-- pre-vetted display_name in raw_user_meta_data) is UNCHANGED.
--
-- Depends on 20260608000000 (needs_rename / collided_name / flagged_at columns).
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_meta_name text := NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), '');
BEGIN
  IF v_meta_name IS NOT NULL THEN
    -- Standard path: caller supplied a vetted, uniqueness-checked display_name
    -- (signInAnonymously). Insert a normal, non-flagged profile (unchanged).
    INSERT INTO public.profiles (id, display_name, skill_level)
    VALUES (
      NEW.id,
      v_meta_name,
      COALESCE(NEW.raw_user_meta_data->>'skill_level', 'beginner')::skill_level
    )
    ON CONFLICT (id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          skill_level  = EXCLUDED.skill_level,
          updated_at   = NOW();
  ELSE
    -- OAuth / metadata-less path: no vetted name yet. Insert a UNIQUE stub
    -- flagged needs_rename=true (→ excluded from the partial unique index, so it
    -- can never raise 23505). collided_name stays NULL — the marker that this is
    -- an UNRESOLVED OAuth stub for /auth/callback to derive against. The callback
    -- either assigns a unique derived name (clearing the flag) or sets
    -- collided_name so the /rename gate finishes the job.
    INSERT INTO public.profiles (id, display_name, skill_level, needs_rename, collided_name, flagged_at)
    VALUES (
      NEW.id,
      'Player_' || left(NEW.id::text, 8),
      COALESCE(NEW.raw_user_meta_data->>'skill_level', 'beginner')::skill_level,
      true,
      NULL,
      NOW()
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;
