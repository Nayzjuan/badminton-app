-- ============================================================
-- Migration: Identity Safety Net
-- ============================================================
-- 1. identity_migrations table
--    Permanent audit log: every time a player reconnects and
--    gets a new UUID, the old → new mapping is recorded here.
--    Solves three problems:
--      a) Backup reconciliation: backups capture point-in-time
--         UUIDs; this table lets you find the current UUID for
--         any historical UUID.
--      b) Debugging: "who is this UUID?" is answerable without
--         scanning match_players history.
--      c) Cleanup plans: allowlists can be built by querying
--         this table instead of guessing.
--
-- 2. migrate_player_identity (updated)
--    Adds one step (1.5) to the existing function: INSERT into
--    identity_migrations before the old profile is modified.
--    Fully backward-compatible — same signature, same return type.
--
-- All other steps of migrate_player_identity are reproduced
-- verbatim to avoid any accidental regression.
-- ============================================================


-- ── 1. identity_migrations table ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.identity_migrations (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  old_id        uuid        NOT NULL,
  new_id        uuid        NOT NULL,
  display_name  text        NOT NULL,
  migrated_at   timestamptz NOT NULL DEFAULT now()
);

-- Index both directions so lookups on either old or new ID are fast.
CREATE INDEX IF NOT EXISTS idx_identity_migrations_old_id
  ON public.identity_migrations (old_id);

CREATE INDEX IF NOT EXISTS idx_identity_migrations_new_id
  ON public.identity_migrations (new_id);

-- RLS: service_role inserts (it bypasses RLS).
--      Authenticated users can read their own migration records.
--      No one else can read or write.
ALTER TABLE public.identity_migrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "identity_migrations_select_own"
  ON public.identity_migrations
  FOR SELECT
  USING (auth.uid() = old_id OR auth.uid() = new_id);

-- INSERT is blocked for all non-service roles (service_role bypasses RLS).
-- No UPDATE or DELETE policy — this table is append-only.

GRANT SELECT, INSERT ON public.identity_migrations TO service_role;


-- ── 2. migrate_player_identity (updated) ──────────────────────
-- Identical to the version in 20260429000000_wave2_atomicity.sql
-- except for the new Step 1.5 which audits the migration.

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
  -- Safety guard: identical UUIDs would corrupt the profile in Step 1.
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
  DELETE FROM profiles WHERE id = p_new_user_id;

  -- ── Step 1.5: Audit — record old → new UUID mapping ────────
  -- Runs before Step 2 so we can read display_name from the old
  -- profile while it still exists. Inside the outer transaction,
  -- so it rolls back automatically if any later step fails.
  INSERT INTO identity_migrations (old_id, new_id, display_name)
  SELECT p_old_user_id, p_new_user_id, display_name
  FROM   profiles
  WHERE  id = p_old_user_id;

  -- ── Step 2: Insert new profile with old player's data ──────
  INSERT INTO profiles (id, display_name, skill_level, pin)
  SELECT p_new_user_id, display_name, skill_level, pin
  FROM   profiles
  WHERE  id = p_old_user_id;

  -- ── Step 3: Migrate queue_entries ──────────────────────────
  UPDATE queue_entries
  SET    player_id = p_new_user_id
  WHERE  player_id = p_old_user_id;

  -- ── Step 4: Migrate match_players ──────────────────────────
  UPDATE match_players
  SET    player_id = p_new_user_id
  WHERE  player_id = p_old_user_id;

  -- ── Step 4.5: Migrate sessions.created_by ──────────────────
  IF NOT v_is_active_organizer THEN
    UPDATE sessions
    SET    created_by = p_new_user_id
    WHERE  created_by = p_old_user_id;
  END IF;

  -- ── Step 4.6: Migrate session_wrapped_stats ─────────────────
  -- Non-fatal — savepoint block.
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
    RAISE WARNING
      'migrate_player_identity: session_wrapped_stats migration failed (non-fatal): %',
      SQLERRM;
  END;

  -- ── Step 4.7: Migrate session_organizers ───────────────────
  -- Non-fatal — savepoint block.
  BEGIN
    INSERT INTO session_organizers (session_id, user_id)
    SELECT session_id, p_new_user_id
    FROM   session_organizers
    WHERE  user_id = p_old_user_id;

    DELETE FROM session_organizers WHERE user_id = p_old_user_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING
      'migrate_player_identity: session_organizers migration failed (non-fatal): %',
      SQLERRM;
  END;

  -- ── Step 5: Delete old profile ─────────────────────────────
  IF NOT v_is_active_organizer THEN
    DELETE FROM profiles WHERE id = p_old_user_id;
  END IF;

  RETURN v_is_active_organizer;
END;
$$;

GRANT EXECUTE ON FUNCTION migrate_player_identity(uuid, uuid) TO service_role;
