-- ============================================================
-- Multi-Tenant Phase 0 — Migration 4: migrate_player_identity + club_members
-- ============================================================
-- On reconnect, migrate_player_identity moves a player's data from the old
-- auth UUID to the new one. After club_members exists, it must also re-point
-- club_members.player_id, or a reconnected player loses every club membership
-- and appears as a stranger (MULTI_TENANT_PLAN.md §6.7).
--
-- This re-creates the function identically to the current production version
-- and inserts ONE new non-fatal block (mirrors the session_organizers block).
--
-- DEFERRED (pre-existing gap, correction C7): this RPC still does NOT re-point
-- player_rivalries / player_partnerships. That gap predates multi-tenancy (the
-- ledgers were never migrated on reconnect). A correct fix needs counter-merge
-- semantics in BOTH directions (player_id AND rival_id/partner_id) plus a drift
-- test, so it is intentionally left to its own migration rather than bundled
-- into this build-only foundation. Tracked in MULTI_TENANT_PLAN.md §4.5.
--
-- Idempotent (CREATE OR REPLACE). BUILD ONLY — not applied to production yet.
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

  -- Capture old profile's needs_rename before we modify anything.
  SELECT needs_rename INTO v_old_needs_rename
  FROM profiles WHERE id = p_old_user_id;

  -- Delete the placeholder profile the trigger created for the new auth user.
  DELETE FROM profiles WHERE id = p_new_user_id;

  -- Temporarily exclude the old profile from the unique-name partial index
  -- (idx_profiles_unique_active_name covers WHERE needs_rename = false) so we
  -- can INSERT the new profile with the same display_name without a conflict.
  -- The value is restored at the end (organizer path) or the row is deleted
  -- (non-organizer path), so no permanent state change occurs here.
  IF NOT v_old_needs_rename THEN
    UPDATE profiles SET needs_rename = true WHERE id = p_old_user_id;
  END IF;

  INSERT INTO identity_migrations (old_id, new_id, display_name)
  SELECT p_old_user_id, p_new_user_id, display_name
  FROM   profiles
  WHERE  id = p_old_user_id;

  -- Insert the new profile using the original needs_rename value (not the
  -- temporarily-set true), so the player's rename state is preserved correctly.
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

  -- NEW (multi-tenant): re-point club memberships old -> new. If the new
  -- identity is already a member of a club the old identity belonged to, keep
  -- the existing row and drop the duplicate old one (avoids the
  -- UNIQUE(club_id, player_id) clash). Non-fatal, mirroring the blocks above.
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

  IF NOT v_is_active_organizer THEN
    DELETE FROM profiles WHERE id = p_old_user_id;
  ELSE
    -- Organizer path: old profile is kept so the organizer dashboard on their
    -- other device stays valid. Restore the needs_rename flag we temporarily
    -- flipped above so the organizer's profile re-enters the unique index.
    IF NOT v_old_needs_rename THEN
      UPDATE profiles SET needs_rename = false WHERE id = p_old_user_id;
    END IF;
  END IF;

  RETURN v_is_active_organizer;
END;
$function$;
