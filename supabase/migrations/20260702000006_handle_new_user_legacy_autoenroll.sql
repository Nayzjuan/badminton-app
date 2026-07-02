-- ============================================================
-- 2026-07-02 EMERGENCY STOPGAP — persisted for tracking (already applied to
-- prod via SQL during a live session). Idempotent (CREATE OR REPLACE).
-- ------------------------------------------------------------
-- Adds Legacy-club auto-enroll to handle_new_user so accounts created under the
-- club-unaware `main` code are enrolled into the Legacy club and pass the
-- club-scoped sessions/queue RLS. The enroll is wrapped in an exception block so
-- it can NEVER fail account/profile creation.
--
-- Disposition on multi-tenant deploy: REVISIT. Once the multi-tenant signup path
-- (ensureClubMembership, club-scoped onboarding) is live, a blanket auto-enroll
-- of every new user into Legacy is likely wrong for a true multi-club world —
-- rework or drop this enroll block then. See memory prod-db-code-drift-stopgaps.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_meta_name text := NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), '');
BEGIN
  IF v_meta_name IS NOT NULL THEN
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

  -- Auto-enroll into the Legacy club so club-scoped session RLS (is_club_member)
  -- lets new players see/join legacy sessions. Never allowed to fail signup.
  BEGIN
    INSERT INTO public.club_members (club_id, player_id, role, is_active)
    VALUES ('00000000-0000-0000-0000-000000000001', NEW.id, 'member', true)
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;
