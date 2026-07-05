-- ============================================================
-- 2026-07-05: primary-club resolution + retire blanket auto-enroll
-- ============================================================
-- Two coupled changes for the platform-owner / club-scoped-routing model:
--
-- 1) get_primary_club_slug(user): which club a returning player lands in when
--    they open the app cold (no QR) — the club of their MOST RECENTLY ATTENDED
--    session, falling back to their most recently JOINED active club, else NULL
--    (→ the app shows the "join via QR" screen).
--
-- 2) Retire the handle_new_user auto-enroll: it dropped every new signup into
--    the Legacy/CHILLAX club (a single-tenant stopgap). New users must now join
--    a club via its QR/invite; a plain-link registrant has NO club and lands on
--    the join-via-QR screen. Existing members are untouched. The profile-creation
--    half of the trigger is preserved verbatim.
-- ============================================================

-- ── 1) Primary-club resolver ────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_primary_club_slug(p_user_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    -- Club of the most recently-attended session — ordered by when the PLAYER
    -- joined the queue (q.joined_at), which is faithful to "last attended" even
    -- if an older-created session was attended more recently.
    (SELECT c.slug
       FROM public.queue_entries q
       JOIN public.sessions s ON s.id = q.session_id
       JOIN public.clubs c    ON c.id = s.club_id
      WHERE q.player_id = p_user_id AND c.is_active
      ORDER BY q.joined_at DESC
      LIMIT 1),
    -- Fallback: most recently-joined active club.
    (SELECT c.slug
       FROM public.club_members cm
       JOIN public.clubs c ON c.id = cm.club_id
      WHERE cm.player_id = p_user_id AND cm.is_active AND c.is_active
      ORDER BY cm.joined_at DESC
      LIMIT 1)
  );
$$;

REVOKE ALL ON FUNCTION public.get_primary_club_slug(uuid) FROM PUBLIC;
-- Default privileges grant EXECUTE to anon/authenticated on CREATE; revoke
-- explicitly so only the service-role client (server-side) can call it.
REVOKE EXECUTE ON FUNCTION public.get_primary_club_slug(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_primary_club_slug(uuid) TO service_role;

-- ── 2) Retire the auto-enroll (keep profile creation) ───────
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

  -- NOTE: the blanket auto-enroll into the Legacy/CHILLAX club was intentionally
  -- removed on 2026-07-05. New users now join a club via its QR/invite; a
  -- plain-link registrant has no club and is routed to the join-via-QR screen.

  RETURN NEW;
END;
$function$;
