-- ============================================================
-- migrate_player_identity — repoint club_invites old -> new on
-- reconnect (non-fatal, mirrors the club_members block added in
-- 20260630000003).
-- ============================================================
-- club_invites.created_by and club_invites.consumed_by both FK-
-- reference profiles(id). This table was added later in the
-- multi-tenant Phase 3 work and was never retrofitted into this
-- function, so the final unconditional
--   DELETE FROM profiles WHERE id = p_old_user_id
-- was violating club_invites_consumed_by_fkey (and would equally
-- violate club_invites_created_by_fkey) for any reconnecting player
-- who had ever created or consumed a club invite — a live, user-
-- facing regression blocking the RETURNING/PIN reconnect flow.
--
-- Unlike club_members/rivalries/partnerships, club_invites has no
-- uniqueness constraint keyed on (created_by | consumed_by), so a
-- blind two-column UPDATE is safe here — no merge/dedupe needed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.migrate_player_identity(p_old_user_id uuid, p_new_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
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
    needs_rename, collided_name, flagged_at
  )
  SELECT
    p_new_user_id, display_name, skill_level, pin,
    vip_tag, vip_theme,
    v_old_needs_rename, collided_name, flagged_at
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

  -- NEW (multi-tenant): re-point club memberships old -> new.
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

  -- C7: re-point player_rivalries old -> new (both directions, counter-merge).
  BEGIN
    -- Guard: a direct old<->new rivalry would become a self-row (player_id =
    -- rival_id) once repointed, violating player_rivalries_check. Drop it —
    -- old and new are about to be the same identity, so this row is moot.
    DELETE FROM player_rivalries
    WHERE (player_id = p_old_user_id AND rival_id = p_new_user_id)
       OR (player_id = p_new_user_id AND rival_id = p_old_user_id);

    -- Side 1: rows where the migrating player is player_id.
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

    -- Side 2: rows where the migrating player is rival_id.
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

  -- C7: re-point player_partnerships old -> new (both directions, counter-merge).
  BEGIN
    -- Guard: a direct old<->new partnership would become a self-row
    -- (player_id = partner_id) once repointed, violating
    -- player_partnerships_check. Drop it for the same reason as above.
    DELETE FROM player_partnerships
    WHERE (player_id = p_old_user_id AND partner_id = p_new_user_id)
       OR (player_id = p_new_user_id AND partner_id = p_old_user_id);

    -- Side 1: rows where the migrating player is player_id.
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

    -- Side 2: rows where the migrating player is partner_id.
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

  -- NEW (multi-tenant): re-point club invite authorship/consumption old -> new.
  BEGIN
    UPDATE club_invites SET created_by  = p_new_user_id WHERE created_by  = p_old_user_id;
    UPDATE club_invites SET consumed_by = p_new_user_id WHERE consumed_by = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'migrate_player_identity: club_invites migration failed (non-fatal): %', SQLERRM;
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
