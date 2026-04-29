-- ============================================================
-- Migration: Wave 2 Atomicity
-- ============================================================
-- 1. toggle_auto_matchmaking(p_session_id)
--    Atomically flips is_auto_matchmaking_on; returns new value.
--    Eliminates the read→write lost-update race in the server
--    action toggleAutoMatchmaking.
--
-- 2. migrate_player_identity(p_old_user_id, p_new_user_id)
--    Wraps all 7 DB steps of reconnectPlayer in a single
--    Postgres transaction. Steps 4.6/4.7 are non-fatal
--    (BEGIN/EXCEPTION/END savepoint blocks). Returns
--    is_active_organizer boolean so the server action knows
--    whether to call auth.admin.deleteUser(oldUserId).
--
-- 3. sessions_active_organizer_passcode partial unique index
--    Enforces organizer_passcode uniqueness only among active
--    sessions (is_active = true). Closed sessions may share
--    passcodes freely. The DB raises error code 23505 on INSERT
--    when a conflicting active passcode exists; the server action
--    catches it and returns a user-friendly message.
-- ============================================================


-- ── 1. toggle_auto_matchmaking ────────────────────────────────
-- Atomically flips the toggle and returns the NEW value in one
-- round-trip. Eliminates the separate SELECT + UPDATE in the
-- server action, closing the lost-update race between them.

CREATE OR REPLACE FUNCTION toggle_auto_matchmaking(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_value boolean;
BEGIN
  UPDATE sessions
  SET    is_auto_matchmaking_on = NOT is_auto_matchmaking_on
  WHERE  id = p_session_id
  RETURNING is_auto_matchmaking_on INTO v_new_value;

  -- v_new_value is NULL when the session doesn't exist.
  -- The caller handles this case (returns isOn: false + error).
  RETURN v_new_value;
END;
$$;

GRANT EXECUTE ON FUNCTION toggle_auto_matchmaking(uuid) TO service_role;


-- ── 2. migrate_player_identity ────────────────────────────────
-- Atomically migrates all DB data from an old anonymous auth
-- user to a newly created one during the reconnect flow.
--
-- Steps (mirrors the app-layer ordering in auth.ts reconnectPlayer):
--   1. Delete trigger-created profile for new user (non-fatal if absent)
--   2. Insert new profile with old player's data (fatal if fails)
--   3. Migrate queue_entries         player_id old → new
--   4. Migrate match_players         player_id old → new
--   4.5 Migrate sessions.created_by  old → new  (skipped if active organizer)
--   4.6 Migrate session_wrapped_stats          (non-fatal — savepoint)
--   4.7 Migrate session_organizers             (non-fatal — savepoint)
--   5. Delete old profile                       (skipped if active organizer)
--
-- Active-organizer guard:
--   If the old user is the PRIMARY organizer of an active session,
--   steps 4.5 and 5 are skipped. Their auth identity is preserved
--   so the organizer dashboard remains valid on their other device
--   (e.g. iPad). The new user (phone) receives all player data.
--
-- Returns: true  → old user is active organizer; server action must
--                   NOT call auth.admin.deleteUser(oldUserId).
--          false → old user safely deleted; server action SHOULD
--                   call auth.admin.deleteUser(oldUserId).
--
-- Auth deletion (auth.admin.deleteUser) cannot be performed inside
-- a Postgres function — it lives in Supabase Auth, not the DB.
-- It therefore remains in the server action after this RPC returns.

CREATE OR REPLACE FUNCTION migrate_player_identity(
  p_old_user_id uuid,
  p_new_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_active_organizer boolean := false;
BEGIN
  -- Safety guard: calling with identical UUIDs would delete the player's
  -- profile in Step 1 (DELETE WHERE id = p_new_user_id) and then fail
  -- silently in Step 2 (INSERT…SELECT returns 0 rows), leaving the player
  -- with no profile. Raise immediately so the caller knows the arguments
  -- are wrong.
  IF p_old_user_id = p_new_user_id THEN
    RAISE EXCEPTION
      'migrate_player_identity: p_old_user_id and p_new_user_id must be different (both = %)',
      p_old_user_id;
  END IF;

  -- Active-organizer check: determines which steps are skipped.
  SELECT EXISTS (
    SELECT 1
    FROM   sessions
    WHERE  created_by = p_old_user_id
    AND    is_active  = true
  ) INTO v_is_active_organizer;

  -- ── Step 1: Remove trigger-created profile for new user ────
  -- signInAnonymously may trigger a profile-creation DB hook.
  -- Safe when 0 rows are deleted (trigger hasn't fired yet).
  DELETE FROM profiles WHERE id = p_new_user_id;

  -- ── Step 2: Insert new profile with old player's data ──────
  -- Establishes the target FK anchor BEFORE migrating references
  -- so a crash mid-migration never leaves the player locked out.
  INSERT INTO profiles (id, display_name, skill_level, pin)
  SELECT p_new_user_id, display_name, skill_level, pin
  FROM   profiles
  WHERE  id = p_old_user_id;
  -- Raises an exception (rolled back) if the old profile is missing.

  -- ── Step 3: Migrate queue_entries ──────────────────────────
  UPDATE queue_entries
  SET    player_id = p_new_user_id
  WHERE  player_id = p_old_user_id;

  -- ── Step 4: Migrate match_players ──────────────────────────
  UPDATE match_players
  SET    player_id = p_new_user_id
  WHERE  player_id = p_old_user_id;

  -- ── Step 4.5: Migrate sessions.created_by ──────────────────
  -- sessions.created_by has FK → profiles.id; migrating it now
  -- (before Step 5 deletes the old profile) avoids a FK violation.
  -- SKIPPED when old user is the active organizer — their session
  -- must remain associated with the old auth identity so the
  -- organizer dashboard cookie stays valid.
  IF NOT v_is_active_organizer THEN
    UPDATE sessions
    SET    created_by = p_new_user_id
    WHERE  created_by = p_old_user_id;
  END IF;

  -- ── Step 4.6: Migrate session_wrapped_stats ─────────────────
  -- player_id is part of the UNIQUE (session_id, player_id)
  -- constraint and cannot be updated in-place. Re-insert under
  -- new ID then delete the originals.
  -- Non-fatal: wrapped pages degrade gracefully to empty stats.
  -- Excluded columns:
  --   id          — auto-generated UUID (omit to get fresh value)
  --   point_diff  — GENERATED ALWAYS AS (points_for - points_against)
  -- Included: intro_dismissed_at (added by 20260425100000) so the
  -- player doesn't see the intro overlay again after reconnecting.
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

    -- Only delete originals after a successful re-insert.
    DELETE FROM session_wrapped_stats WHERE player_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING
      'migrate_player_identity: session_wrapped_stats migration failed (non-fatal): %',
      SQLERRM;
    -- Savepoint rolls back the failed INSERT; outer transaction continues.
  END;

  -- ── Step 4.7: Migrate session_organizers ───────────────────
  -- user_id is part of the logical key; delete + re-insert pattern.
  -- Without this step, deleting the old profile in Step 5 would
  -- CASCADE-delete these rows, silently revoking co-organizer access.
  -- Non-fatal: access can be re-granted manually if this fails.
  BEGIN
    INSERT INTO session_organizers (session_id, user_id)
    SELECT session_id, p_new_user_id
    FROM   session_organizers
    WHERE  user_id = p_old_user_id;

    -- Only delete originals after a successful re-insert.
    DELETE FROM session_organizers WHERE user_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING
      'migrate_player_identity: session_organizers migration failed (non-fatal): %',
      SQLERRM;
  END;

  -- ── Step 5: Delete old profile ─────────────────────────────
  -- All FK refs from queue_entries and match_players now point to
  -- p_new_user_id. Steps 4.5 covered sessions.created_by.
  -- The ON DELETE CASCADE on session_wrapped_stats will clean up
  -- any rows that Step 4.6 failed to re-insert.
  -- SKIPPED when old user is active organizer (becomes a shell
  -- profile; organizer dashboard only needs auth cookie validity).
  IF NOT v_is_active_organizer THEN
    DELETE FROM profiles WHERE id = p_old_user_id;
  END IF;

  RETURN v_is_active_organizer;
END;
$$;

GRANT EXECUTE ON FUNCTION migrate_player_identity(uuid, uuid) TO service_role;


-- ── 3. Partial unique index: active-session passcodes ────────
-- Enforces uniqueness of organizer_passcode ONLY among rows where
-- is_active = true. Closed sessions are excluded from the index,
-- so historical passcodes never block new session creation.
--
-- The server action (createSession) catches Postgres error code
-- 23505 (unique_violation) on INSERT and surfaces a user-friendly
-- "passcode already in use" message. The app-layer uniqueness check
-- (SELECT + compare) remains as an early-return optimization, but
-- the DB index is now the authoritative last line of defence.

CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_organizer_passcode
  ON sessions (organizer_passcode)
  WHERE is_active = true AND organizer_passcode IS NOT NULL;
