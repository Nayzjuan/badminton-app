-- ============================================================
-- migrate_player_identity: reconnect must not 23503 / 23505
-- ============================================================
-- reconnectPlayer looks up name+PIN, then calls this RPC. The only user-facing
-- string for an RPC error is "Failed to migrate account. Please try again."
-- That path is therefore a correct-PIN failure, not a wrong-PIN one.
--
-- Three defects in the live 20260913 body:
--
--   1. CREATE OR REPLACE omitted SECURITY DEFINER, resetting the function to
--      INVOKER. identity_migrations has no INSERT policy; an invoker that is
--      not service_role dies on the audit INSERT (20260721180000 documented
--      this exact margin).
--   2. clubs.created_by, club_members.invited_by, and club_invites
--      created_by/consumed_by are no-CASCADE FKs to profiles(id). Their
--      UPDATEs lived in EXCEPTION savepoints, so a swallowed failure still
--      fatal-failed on DELETE old (23503). Same class as 20260701000017.
--   3. The active-organizer path kept the old profile and restored
--      needs_rename=false while the new row already held the same name with
--      needs_rename=false — 23505 against idx_profiles_unique_active_name
--      whenever that index is live. A later reconnect also 23505s if that
--      tombstone is still sitting in profiles (Stelle, 2026-08-16).
--
-- Hand-apply on production (usxftpexoimletqmrggb). Do not edit 20260913.
-- ============================================================

CREATE OR REPLACE FUNCTION public.migrate_player_identity(p_old_user_id uuid, p_new_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
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

  -- Leftover organizer tombstones share name+PIN with needs_rename=false
  -- (Stelle's 2026-08-16 reconnect is the known case). Flag them before
  -- INSERT so idx_profiles_unique_active_name cannot 23505 against the copy.
  UPDATE profiles SET needs_rename = true
  WHERE id <> p_old_user_id
    AND id <> p_new_user_id
    AND needs_rename = false
    AND pin IS NOT DISTINCT FROM (SELECT pin FROM profiles WHERE id = p_old_user_id)
    AND lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g')))
      = (SELECT lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g')))
         FROM profiles WHERE id = p_old_user_id);

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
    UPDATE club_milestones SET player_id = p_new_user_id WHERE player_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: club_milestones migration failed (non-fatal): %', SQLERRM;
  END;

  -- No-CASCADE FKs. These used to sit in EXCEPTION savepoints; a swallowed
  -- failure then fatal-failed on DELETE old with 23503, which reconnectPlayer
  -- surfaces as "Failed to migrate account. Please try again."
  UPDATE clubs SET created_by = p_new_user_id WHERE created_by = p_old_user_id;
  UPDATE club_members SET invited_by = p_new_user_id WHERE invited_by = p_old_user_id;
  UPDATE club_invites SET created_by = p_new_user_id WHERE created_by = p_old_user_id;
  UPDATE club_invites SET consumed_by = p_new_user_id WHERE consumed_by = p_old_user_id;

  IF NOT v_is_active_organizer THEN
    DELETE FROM profiles WHERE id = p_old_user_id;
  END IF;
  -- Active-organizer tombstone keeps needs_rename = true (set before the
  -- INSERT copy) so idx_profiles_unique_active_name cannot collide with the
  -- new row. Restoring false here was 23505 whenever that index is live.

  RETURN v_is_active_organizer;
END;
$function$;

REVOKE ALL ON FUNCTION public.migrate_player_identity(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_player_identity(uuid, uuid) TO service_role;
