-- ============================================================
-- Google first-run name confirmation + self-serve rename
-- ============================================================
-- New Google sign-ups get a unique derived display_name claimed immediately
-- (they enter idx_profiles_unique_active_name) AND a needs_name_confirm flag
-- so /rename asks them to keep or change it. Linking an existing account and
-- already-resolved Google profiles stay false (DEFAULT, no backfill).
--
-- This column is NOT needs_rename:
--   • needs_rename forbids keeping collided_name (duplicate resolution).
--   • needs_name_confirm allows keeping the assigned name.
--   • The OAuth stub detector stays (needs_rename AND collided_name IS NULL).
--
-- Also: player_renames.reason gains oauth_confirm / self_chosen, and
-- rename_player_identity infers the reason from the pre-update flags.
-- migrate_player_identity copies the new column (live body, not the 20260608
-- ancestor — reconnect must not drop it).
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS needs_name_confirm boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.needs_name_confirm IS
  'True when a first-time Google sign-in has been assigned a unique derived name that the player has not yet confirmed or changed on /rename.';

CREATE INDEX IF NOT EXISTS idx_profiles_needs_name_confirm
  ON public.profiles (id)
  WHERE needs_name_confirm;

-- Column lockdown (20260701000010) revoked table-wide SELECT and re-granted
-- an explicit list. Without this, authenticated reads that project the new
-- column (/play, /rename, joinQueueAction L2) fail with permission denied.
GRANT SELECT (needs_name_confirm) ON public.profiles TO authenticated, anon;

-- Historical Google-native accounts (google identity, no anonymous identity)
-- must confirm their court name on next visit. Linked PIN accounts have both
-- identities and stay unprompted.
UPDATE public.profiles p
SET needs_name_confirm = true
WHERE p.needs_name_confirm = false
  AND p.needs_rename = false
  AND EXISTS (
    SELECT 1 FROM auth.identities i
    WHERE i.user_id = p.id AND i.provider = 'google'
  )
  AND NOT EXISTS (
    SELECT 1 FROM auth.identities i
    WHERE i.user_id = p.id AND i.provider = 'anonymous'
  );

-- ── Audit reason CHECK ──────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.player_renames'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%reason%'
  LOOP
    EXECUTE format('ALTER TABLE public.player_renames DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.player_renames
  ADD CONSTRAINT player_renames_reason_check
  CHECK (reason IN (
    'duplicate_flag',
    'organizer_manual',
    'self_reconnect',
    'data_fix_merge',
    'oauth_confirm',
    'self_chosen'
  ));

-- ── rename_player_identity — clear both flags, infer reason ──
CREATE OR REPLACE FUNCTION public.rename_player_identity(
  p_user_id  uuid,
  p_new_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_name       text;
  v_collided       text;
  v_needs_rename   boolean;
  v_needs_confirm  boolean;
  v_reason         text;
BEGIN
  SELECT display_name, collided_name, needs_rename, needs_name_confirm
  INTO   v_old_name, v_collided, v_needs_rename, v_needs_confirm
  FROM   profiles
  WHERE  id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  IF v_collided IS NOT NULL
     AND lower(btrim(regexp_replace(p_new_name, E'[ \t]+', ' ', 'g')))
       = lower(btrim(regexp_replace(v_collided,  E'[ \t]+', ' ', 'g'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'reused_dup_name');
  END IF;

  IF v_needs_confirm AND NOT v_needs_rename THEN
    v_reason := 'oauth_confirm';
  ELSIF v_needs_rename THEN
    v_reason := 'duplicate_flag';
  ELSE
    v_reason := 'self_chosen';
  END IF;

  UPDATE profiles
  SET    display_name        = p_new_name,
         needs_rename        = false,
         needs_name_confirm  = false,
         collided_name       = NULL
  WHERE  id = p_user_id;

  INSERT INTO player_renames (player_id, old_name, new_name, reason, actor_user_id)
  VALUES (p_user_id, v_old_name, p_new_name, v_reason, p_user_id);

  RETURN jsonb_build_object('success', true, 'new_name', p_new_name);

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'name_taken');
END;
$$;

REVOKE ALL ON FUNCTION public.rename_player_identity(uuid, text) FROM public, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.rename_player_identity(uuid, text) TO service_role;

-- ── migrate_player_identity — copy needs_name_confirm ────────
-- Body is the live 20260717170135 function plus the new column on the
-- profiles INSERT/SELECT. Do not replace this with the 20260608 ancestor.
CREATE OR REPLACE FUNCTION public.migrate_player_identity(p_old_user_id uuid, p_new_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_active_organizer boolean := false;
  v_old_needs_rename    boolean;
BEGIN
  IF p_old_user_id = p_new_user_id THEN
    RAISE EXCEPTION
      'migrate_player_identity: p_old_user_id and p_new_user_id must be different (both = %)',
      p_old_user_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE created_by = p_old_user_id AND is_active = true
  ) INTO v_is_active_organizer;

  SELECT needs_rename INTO v_old_needs_rename
  FROM profiles WHERE id = p_old_user_id;

  DELETE FROM profiles WHERE id = p_new_user_id;

  IF NOT v_old_needs_rename THEN
    UPDATE profiles SET needs_rename = true WHERE id = p_old_user_id;
  END IF;

  INSERT INTO identity_migrations (old_id, new_id, display_name)
  SELECT p_old_user_id, p_new_user_id, display_name
  FROM   profiles
  WHERE  id = p_old_user_id;

  INSERT INTO profiles (
    id, display_name, skill_level, pin,
    vip_tag, vip_theme,
    needs_rename, collided_name, flagged_at, needs_name_confirm
  )
  SELECT
    p_new_user_id, display_name, skill_level, pin,
    vip_tag, vip_theme,
    v_old_needs_rename, collided_name, flagged_at, needs_name_confirm
  FROM profiles
  WHERE id = p_old_user_id;

  UPDATE queue_entries SET player_id = p_new_user_id WHERE player_id = p_old_user_id;
  UPDATE match_players SET player_id = p_new_user_id WHERE player_id = p_old_user_id;

  IF NOT v_is_active_organizer THEN
    UPDATE sessions SET created_by = p_new_user_id WHERE created_by = p_old_user_id;
  END IF;

  BEGIN
    INSERT INTO session_wrapped_stats (
      session_id,          player_id,
      games_played,        wins,        losses,
      points_for,          points_against,
      win_pct,             win_streak,  session_rank,
      earned_awards,       award_data,  computed_at,
      intro_dismissed_at
    )
    SELECT
      session_id,          p_new_user_id,
      games_played,        wins,        losses,
      points_for,          points_against,
      win_pct,             win_streak,  session_rank,
      earned_awards,       award_data,  computed_at,
      intro_dismissed_at
    FROM session_wrapped_stats
    WHERE player_id = p_old_user_id;
    DELETE FROM session_wrapped_stats WHERE player_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: session_wrapped_stats migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    INSERT INTO session_organizers (session_id, user_id)
    SELECT session_id, p_new_user_id
    FROM   session_organizers
    WHERE  user_id = p_old_user_id;
    DELETE FROM session_organizers WHERE user_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: session_organizers migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    DELETE FROM club_members old_m
    WHERE old_m.player_id = p_old_user_id
      AND EXISTS (
        SELECT 1 FROM club_members new_m
        WHERE new_m.player_id = p_new_user_id
          AND new_m.club_id   = old_m.club_id
      );
    UPDATE club_members SET player_id = p_new_user_id WHERE player_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: club_members migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    DELETE FROM player_rivalries
    WHERE (player_id = p_old_user_id AND rival_id = p_new_user_id)
       OR (player_id = p_new_user_id AND rival_id = p_old_user_id);

    UPDATE player_rivalries new_r
    SET wins_vs         = new_r.wins_vs + old_r.wins_vs,
        losses_vs       = new_r.losses_vs + old_r.losses_vs,
        sessions_faced  = new_r.sessions_faced + old_r.sessions_faced,
        last_session_id = CASE
                             WHEN old_r.last_faced_at IS NULL THEN new_r.last_session_id
                             WHEN new_r.last_faced_at IS NULL THEN old_r.last_session_id
                             WHEN old_r.last_faced_at > new_r.last_faced_at THEN old_r.last_session_id
                             ELSE new_r.last_session_id
                           END,
        last_faced_at   = GREATEST(old_r.last_faced_at, new_r.last_faced_at),
        updated_at      = now()
    FROM player_rivalries old_r
    WHERE old_r.player_id = p_old_user_id
      AND new_r.player_id = p_new_user_id
      AND new_r.club_id   = old_r.club_id
      AND new_r.rival_id  = old_r.rival_id;

    DELETE FROM player_rivalries old_r
    WHERE old_r.player_id = p_old_user_id
      AND EXISTS (
        SELECT 1 FROM player_rivalries new_r
        WHERE new_r.player_id = p_new_user_id
          AND new_r.club_id   = old_r.club_id
          AND new_r.rival_id  = old_r.rival_id
      );

    UPDATE player_rivalries SET player_id = p_new_user_id WHERE player_id = p_old_user_id;

    UPDATE player_rivalries new_r
    SET wins_vs         = new_r.wins_vs + old_r.wins_vs,
        losses_vs       = new_r.losses_vs + old_r.losses_vs,
        sessions_faced  = new_r.sessions_faced + old_r.sessions_faced,
        last_session_id = CASE
                             WHEN old_r.last_faced_at IS NULL THEN new_r.last_session_id
                             WHEN new_r.last_faced_at IS NULL THEN old_r.last_session_id
                             WHEN old_r.last_faced_at > new_r.last_faced_at THEN old_r.last_session_id
                             ELSE new_r.last_session_id
                           END,
        last_faced_at   = GREATEST(old_r.last_faced_at, new_r.last_faced_at),
        updated_at      = now()
    FROM player_rivalries old_r
    WHERE old_r.rival_id  = p_old_user_id
      AND new_r.rival_id  = p_new_user_id
      AND new_r.club_id   = old_r.club_id
      AND new_r.player_id = old_r.player_id;

    DELETE FROM player_rivalries old_r
    WHERE old_r.rival_id = p_old_user_id
      AND EXISTS (
        SELECT 1 FROM player_rivalries new_r
        WHERE new_r.rival_id  = p_new_user_id
          AND new_r.club_id   = old_r.club_id
          AND new_r.player_id = old_r.player_id
      );

    UPDATE player_rivalries SET rival_id = p_new_user_id WHERE rival_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: player_rivalries migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    DELETE FROM player_partnerships
    WHERE (player_id = p_old_user_id AND partner_id = p_new_user_id)
       OR (player_id = p_new_user_id AND partner_id = p_old_user_id);

    UPDATE player_partnerships new_p
    SET games_together    = new_p.games_together + old_p.games_together,
        wins_together     = new_p.wins_together + old_p.wins_together,
        losses_together   = new_p.losses_together + old_p.losses_together,
        sessions_together = new_p.sessions_together + old_p.sessions_together,
        last_session_id   = CASE
                               WHEN old_p.last_played_at IS NULL THEN new_p.last_session_id
                               WHEN new_p.last_played_at IS NULL THEN old_p.last_session_id
                               WHEN old_p.last_played_at > new_p.last_played_at THEN old_p.last_session_id
                               ELSE new_p.last_session_id
                             END,
        last_played_at    = GREATEST(old_p.last_played_at, new_p.last_played_at),
        updated_at        = now()
    FROM player_partnerships old_p
    WHERE old_p.player_id  = p_old_user_id
      AND new_p.player_id  = p_new_user_id
      AND new_p.club_id    = old_p.club_id
      AND new_p.partner_id = old_p.partner_id;

    DELETE FROM player_partnerships old_p
    WHERE old_p.player_id = p_old_user_id
      AND EXISTS (
        SELECT 1 FROM player_partnerships new_p
        WHERE new_p.player_id  = p_new_user_id
          AND new_p.club_id    = old_p.club_id
          AND new_p.partner_id = old_p.partner_id
      );

    UPDATE player_partnerships SET player_id = p_new_user_id WHERE player_id = p_old_user_id;

    UPDATE player_partnerships new_p
    SET games_together    = new_p.games_together + old_p.games_together,
        wins_together     = new_p.wins_together + old_p.wins_together,
        losses_together   = new_p.losses_together + old_p.losses_together,
        sessions_together = new_p.sessions_together + old_p.sessions_together,
        last_session_id   = CASE
                               WHEN old_p.last_played_at IS NULL THEN new_p.last_session_id
                               WHEN new_p.last_played_at IS NULL THEN old_p.last_session_id
                               WHEN old_p.last_played_at > new_p.last_played_at THEN old_p.last_session_id
                               ELSE new_p.last_session_id
                             END,
        last_played_at    = GREATEST(old_p.last_played_at, new_p.last_played_at),
        updated_at        = now()
    FROM player_partnerships old_p
    WHERE old_p.partner_id = p_old_user_id
      AND new_p.partner_id = p_new_user_id
      AND new_p.club_id    = old_p.club_id
      AND new_p.player_id  = old_p.player_id;

    DELETE FROM player_partnerships old_p
    WHERE old_p.partner_id = p_old_user_id
      AND EXISTS (
        SELECT 1 FROM player_partnerships new_p
        WHERE new_p.partner_id = p_new_user_id
          AND new_p.club_id    = old_p.club_id
          AND new_p.player_id  = old_p.player_id
      );

    UPDATE player_partnerships SET partner_id = p_new_user_id WHERE partner_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: player_partnerships migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    UPDATE club_invites SET created_by  = p_new_user_id WHERE created_by  = p_old_user_id;
    UPDATE club_invites SET consumed_by = p_new_user_id WHERE consumed_by = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: club_invites migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    UPDATE clubs SET created_by = p_new_user_id WHERE created_by = p_old_user_id;
    UPDATE club_members SET invited_by = p_new_user_id WHERE invited_by = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: clubs/club_members.invited_by migration failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    UPDATE club_milestones SET player_id = p_new_user_id WHERE player_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: club_milestones migration failed (non-fatal): %', SQLERRM;
  END;

  IF NOT v_is_active_organizer THEN
    DELETE FROM profiles WHERE id = p_old_user_id;
  ELSE
    IF NOT v_old_needs_rename THEN
      UPDATE profiles SET needs_rename = false WHERE id = p_old_user_id;
    END IF;
  END IF;

  RETURN v_is_active_organizer;
END;
$function$;

-- ── merge_guest_play_into_profile ────────────────────────────
-- identity_already_exists: an anonymous guest tried to LINK a Google
-- identity that already belongs to keeper. Do NOT use migrate_player_identity
-- here — that copies the OLD profile onto the NEW id and would overwrite
-- the Google account's display_name with the guest stub.
--
-- This function only repoints play history guest → keeper, then deletes
-- the guest profile. Keeper's name / skill / PIN / flags are untouched.
CREATE OR REPLACE FUNCTION public.merge_guest_play_into_profile(
  p_guest_id  uuid,
  p_keeper_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_guest_is_organizer boolean := false;
BEGIN
  IF p_guest_id = p_keeper_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'same_user');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_guest_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'guest_not_found');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_keeper_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'keeper_not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE created_by = p_guest_id AND is_active = true
  ) INTO v_guest_is_organizer;

  IF v_guest_is_organizer THEN
    RETURN jsonb_build_object('success', false, 'error', 'guest_is_organizer');
  END IF;

  INSERT INTO identity_migrations (old_id, new_id, display_name)
  SELECT p_guest_id, p_keeper_id, display_name
  FROM   profiles
  WHERE  id = p_guest_id;

  -- Same session: keep the keeper's queue row, drop the guest's.
  DELETE FROM queue_entries q
  WHERE q.player_id = p_guest_id
    AND EXISTS (
      SELECT 1 FROM queue_entries k
      WHERE k.player_id = p_keeper_id AND k.session_id = q.session_id
    );
  UPDATE queue_entries SET player_id = p_keeper_id WHERE player_id = p_guest_id;

  DELETE FROM match_players g
  WHERE g.player_id = p_guest_id
    AND EXISTS (
      SELECT 1 FROM match_players k
      WHERE k.player_id = p_keeper_id AND k.match_id = g.match_id
    );
  UPDATE match_players SET player_id = p_keeper_id WHERE player_id = p_guest_id;

  BEGIN
    DELETE FROM session_wrapped_stats g
    WHERE g.player_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM session_wrapped_stats k
        WHERE k.player_id = p_keeper_id AND k.session_id = g.session_id
      );
    UPDATE session_wrapped_stats SET player_id = p_keeper_id WHERE player_id = p_guest_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merge_guest_play_into_profile: session_wrapped_stats failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    DELETE FROM session_organizers g
    WHERE g.user_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM session_organizers k
        WHERE k.user_id = p_keeper_id AND k.session_id = g.session_id
      );
    UPDATE session_organizers SET user_id = p_keeper_id WHERE user_id = p_guest_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merge_guest_play_into_profile: session_organizers failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    DELETE FROM club_members g
    WHERE g.player_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM club_members k
        WHERE k.player_id = p_keeper_id AND k.club_id = g.club_id
      );
    UPDATE club_members SET player_id = p_keeper_id WHERE player_id = p_guest_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merge_guest_play_into_profile: club_members failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    UPDATE club_invites SET created_by  = p_keeper_id WHERE created_by  = p_guest_id;
    UPDATE club_invites SET consumed_by = p_keeper_id WHERE consumed_by = p_guest_id;
    UPDATE clubs SET created_by = p_keeper_id WHERE created_by = p_guest_id;
    UPDATE club_members SET invited_by = p_keeper_id WHERE invited_by = p_guest_id;
    UPDATE club_milestones SET player_id = p_keeper_id WHERE player_id = p_guest_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merge_guest_play_into_profile: club meta failed (non-fatal): %', SQLERRM;
  END;

  -- sessions.created_by has no ON DELETE. Active organizers are refused
  -- above; closed nights the guest ran must still move or DELETE profiles fails.
  UPDATE sessions SET created_by = p_keeper_id WHERE created_by = p_guest_id;

  -- Rivalries / partnerships CASCADE-delete with the guest profile. Merge
  -- them onto the keeper first (same pairing rules as migrate_player_identity)
  -- so play history is not dropped.
  BEGIN
    DELETE FROM player_rivalries
    WHERE (player_id = p_guest_id AND rival_id = p_keeper_id)
       OR (player_id = p_keeper_id AND rival_id = p_guest_id);

    UPDATE player_rivalries new_r
    SET wins_vs         = new_r.wins_vs + old_r.wins_vs,
        losses_vs       = new_r.losses_vs + old_r.losses_vs,
        sessions_faced  = new_r.sessions_faced + old_r.sessions_faced,
        last_session_id = CASE
                             WHEN old_r.last_faced_at IS NULL THEN new_r.last_session_id
                             WHEN new_r.last_faced_at IS NULL THEN old_r.last_session_id
                             WHEN old_r.last_faced_at > new_r.last_faced_at THEN old_r.last_session_id
                             ELSE new_r.last_session_id
                           END,
        last_faced_at   = GREATEST(old_r.last_faced_at, new_r.last_faced_at),
        updated_at      = now()
    FROM player_rivalries old_r
    WHERE old_r.player_id = p_guest_id
      AND new_r.player_id = p_keeper_id
      AND new_r.club_id   = old_r.club_id
      AND new_r.rival_id  = old_r.rival_id;

    DELETE FROM player_rivalries old_r
    WHERE old_r.player_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM player_rivalries new_r
        WHERE new_r.player_id = p_keeper_id
          AND new_r.club_id   = old_r.club_id
          AND new_r.rival_id  = old_r.rival_id
      );

    UPDATE player_rivalries SET player_id = p_keeper_id WHERE player_id = p_guest_id;

    UPDATE player_rivalries new_r
    SET wins_vs         = new_r.wins_vs + old_r.wins_vs,
        losses_vs       = new_r.losses_vs + old_r.losses_vs,
        sessions_faced  = new_r.sessions_faced + old_r.sessions_faced,
        last_session_id = CASE
                             WHEN old_r.last_faced_at IS NULL THEN new_r.last_session_id
                             WHEN new_r.last_faced_at IS NULL THEN old_r.last_session_id
                             WHEN old_r.last_faced_at > new_r.last_faced_at THEN old_r.last_session_id
                             ELSE new_r.last_session_id
                           END,
        last_faced_at   = GREATEST(old_r.last_faced_at, new_r.last_faced_at),
        updated_at      = now()
    FROM player_rivalries old_r
    WHERE old_r.rival_id  = p_guest_id
      AND new_r.rival_id  = p_keeper_id
      AND new_r.club_id   = old_r.club_id
      AND new_r.player_id = old_r.player_id;

    DELETE FROM player_rivalries old_r
    WHERE old_r.rival_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM player_rivalries new_r
        WHERE new_r.rival_id  = p_keeper_id
          AND new_r.club_id   = old_r.club_id
          AND new_r.player_id = old_r.player_id
      );

    UPDATE player_rivalries SET rival_id = p_keeper_id WHERE rival_id = p_guest_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merge_guest_play_into_profile: player_rivalries failed (non-fatal): %', SQLERRM;
  END;

  BEGIN
    DELETE FROM player_partnerships
    WHERE (player_id = p_guest_id AND partner_id = p_keeper_id)
       OR (player_id = p_keeper_id AND partner_id = p_guest_id);

    UPDATE player_partnerships new_p
    SET games_together    = new_p.games_together + old_p.games_together,
        wins_together     = new_p.wins_together + old_p.wins_together,
        losses_together   = new_p.losses_together + old_p.losses_together,
        sessions_together = new_p.sessions_together + old_p.sessions_together,
        last_session_id   = CASE
                               WHEN old_p.last_played_at IS NULL THEN new_p.last_session_id
                               WHEN new_p.last_played_at IS NULL THEN old_p.last_session_id
                               WHEN old_p.last_played_at > new_p.last_played_at THEN old_p.last_session_id
                               ELSE new_p.last_session_id
                             END,
        last_played_at    = GREATEST(old_p.last_played_at, new_p.last_played_at),
        updated_at        = now()
    FROM player_partnerships old_p
    WHERE old_p.player_id  = p_guest_id
      AND new_p.player_id  = p_keeper_id
      AND new_p.club_id    = old_p.club_id
      AND new_p.partner_id = old_p.partner_id;

    DELETE FROM player_partnerships old_p
    WHERE old_p.player_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM player_partnerships new_p
        WHERE new_p.player_id  = p_keeper_id
          AND new_p.club_id    = old_p.club_id
          AND new_p.partner_id = old_p.partner_id
      );

    UPDATE player_partnerships SET player_id = p_keeper_id WHERE player_id = p_guest_id;

    UPDATE player_partnerships new_p
    SET games_together    = new_p.games_together + old_p.games_together,
        wins_together     = new_p.wins_together + old_p.wins_together,
        losses_together   = new_p.losses_together + old_p.losses_together,
        sessions_together = new_p.sessions_together + old_p.sessions_together,
        last_session_id   = CASE
                               WHEN old_p.last_played_at IS NULL THEN new_p.last_session_id
                               WHEN new_p.last_played_at IS NULL THEN old_p.last_session_id
                               WHEN old_p.last_played_at > new_p.last_played_at THEN old_p.last_session_id
                               ELSE new_p.last_session_id
                             END,
        last_played_at    = GREATEST(old_p.last_played_at, new_p.last_played_at),
        updated_at        = now()
    FROM player_partnerships old_p
    WHERE old_p.partner_id = p_guest_id
      AND new_p.partner_id = p_keeper_id
      AND new_p.club_id    = old_p.club_id
      AND new_p.player_id  = old_p.player_id;

    DELETE FROM player_partnerships old_p
    WHERE old_p.partner_id = p_guest_id
      AND EXISTS (
        SELECT 1 FROM player_partnerships new_p
        WHERE new_p.partner_id = p_keeper_id
          AND new_p.club_id    = old_p.club_id
          AND new_p.player_id  = old_p.player_id
      );

    UPDATE player_partnerships SET partner_id = p_keeper_id WHERE partner_id = p_guest_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'merge_guest_play_into_profile: player_partnerships failed (non-fatal): %', SQLERRM;
  END;

  DELETE FROM profiles WHERE id = p_guest_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_guest_play_into_profile(uuid, uuid) FROM public, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.merge_guest_play_into_profile(uuid, uuid) TO service_role;
