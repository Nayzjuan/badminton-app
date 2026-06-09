-- ============================================================
-- Migration: Duplicate-name resolution — schema + RPCs
-- ============================================================
-- Adds the "forced rename on next login" infrastructure (Scope A,
-- lazy/reactive). See the design brief / MEMORY.md.
--
-- This migration is ADDITIVE and non-destructive — safe to apply at
-- any time, independent of the one-shot data-fix runbook. It adds:
--   1. Flag columns on `profiles` (needs_rename / collided_name / flagged_at).
--   2. A partial lookup index for the gate.
--   3. The `player_renames` audit table (FK-free — never blocks a rename).
--   4. rename_player_identity() — atomic name change + flag clear + audit.
--   5. migrate_player_identity() hardened to copy ALL profile columns
--      (fixes the pre-existing silent loss of vip_tag/vip_theme on every
--      reconnect, and carries the new flag columns).
--
-- The partial UNIQUE index (the real cross-instance authority for R2)
-- is in a SEPARATE migration (…000001) because it cannot build while
-- the intentionally-retained duplicate rows still share a name — it is
-- applied only AFTER the data-fix runbook flags the non-canonical rows.
-- ============================================================

-- ── 1. Flag columns on `profiles` ───────────────────────────────────────────
ALTER TABLE public.profiles
  -- true = this profile is a flagged duplicate that must be renamed before the
  -- player can proceed past login / join. Default false = clean profile.
  ADD COLUMN IF NOT EXISTS needs_rename boolean NOT NULL DEFAULT false,
  -- The exact display_name this profile collided on, persisted so R1 ("cannot
  -- reuse the duplicated name") survives even if the canonical sibling is later
  -- merged/renamed away (which would otherwise let R2 alone accept the old name).
  ADD COLUMN IF NOT EXISTS collided_name text,
  -- When the flag was set (audit / staleness).
  ADD COLUMN IF NOT EXISTS flagged_at timestamptz;

-- ── 2. Partial lookup index for the gate ────────────────────────────────────
-- The gate reads needs_rename on nearly every authenticated request; a partial
-- index keeps that lookup cheap and the index tiny (only flagged rows indexed).
CREATE INDEX IF NOT EXISTS idx_profiles_needs_rename
  ON public.profiles (id)
  WHERE needs_rename;

-- ── 3. Audit table ──────────────────────────────────────────────────────────
-- FK-FREE on player_id by design: a rename (or a future profile delete/merge)
-- must NEVER be blocked or cascade-deleted by the audit trail.
CREATE TABLE IF NOT EXISTS public.player_renames (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL,
  old_name      text,
  new_name      text NOT NULL,
  reason        text NOT NULL DEFAULT 'duplicate_flag'
                  CHECK (reason IN ('duplicate_flag', 'organizer_manual', 'self_reconnect', 'data_fix_merge')),
  actor_user_id uuid,          -- who triggered it (player themselves, or an organizer)
  session_id    uuid,          -- contextual session, if any
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 4. rename_player_identity ───────────────────────────────────────────────
-- Atomic, single-transaction rename for a flagged profile:
--   • R1 re-check (server-side defense-in-depth) against collided_name.
--   • UPDATE display_name + clear the flag.
--   • Audit insert.
-- Uniqueness (R2) is enforced solely by the partial UNIQUE index; a 23505 is
-- caught and returned as a structured 'name_taken' result so the caller can
-- show the friendly "just missed it" state. The whole body is one tx, so a
-- 23505 rolls back the audit insert too (nothing half-written).
--
-- SECURITY DEFINER + pinned search_path; granted to service_role ONLY so it
-- can never be invoked directly by a client (the server action derives the
-- user id from the authenticated session → no IDOR).
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
  v_old_name  text;
  v_collided  text;
BEGIN
  SELECT display_name, collided_name
  INTO   v_old_name, v_collided
  FROM   profiles
  WHERE  id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  -- R1: cannot reuse the specific name this profile was flagged on. Checked
  -- against the persisted collided_name using the SAME normalization key as the
  -- unique index (ASCII space/tab collapse → btrim → lower).
  IF v_collided IS NOT NULL
     AND lower(btrim(regexp_replace(p_new_name, E'[ \t]+', ' ', 'g')))
       = lower(btrim(regexp_replace(v_collided,  E'[ \t]+', ' ', 'g'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'reused_dup_name');
  END IF;

  -- R2 authority: the partial UNIQUE index raises 23505 if the normalized name
  -- collides with any non-flagged profile. Setting needs_rename=false here moves
  -- this row INTO the unique index in the same statement, so the check is atomic.
  UPDATE profiles
  SET    display_name  = p_new_name,
         needs_rename  = false,
         collided_name = NULL
  WHERE  id = p_user_id;

  INSERT INTO player_renames (player_id, old_name, new_name, reason, actor_user_id)
  VALUES (p_user_id, v_old_name, p_new_name, 'duplicate_flag', p_user_id);

  RETURN jsonb_build_object('success', true, 'new_name', p_new_name);

EXCEPTION
  WHEN unique_violation THEN
    -- Lost a race (or app-side check was stale). Caller re-prompts.
    RETURN jsonb_build_object('success', false, 'error', 'name_taken');
END;
$$;

REVOKE ALL ON FUNCTION public.rename_player_identity(uuid, text) FROM public, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.rename_player_identity(uuid, text) TO service_role;

-- ── 5. migrate_player_identity — copy ALL profile columns ────────────────────
-- The ONLY change vs 20260430000000 is Step 2's INSERT/SELECT column list,
-- which previously copied just (id, display_name, skill_level, pin) and thus
-- SILENTLY DROPPED vip_tag / vip_theme on every reconnect (a live bug), and
-- would drop the new flag columns too. Now copies every non-id, non-timestamp
-- profile column. created_at/updated_at are intentionally left to defaults
-- (unchanged from prior behaviour). The schema-drift test guards future columns.
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
  IF p_old_user_id = p_new_user_id THEN
    RAISE EXCEPTION
      'migrate_player_identity: p_old_user_id and p_new_user_id must be different (both = %)',
      p_old_user_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM sessions
    WHERE created_by = p_old_user_id AND is_active = true
  ) INTO v_is_active_organizer;

  -- Step 1: Remove trigger-created profile for new user.
  DELETE FROM profiles WHERE id = p_new_user_id;

  -- Step 1.5: Audit old → new mapping (before the old profile is touched).
  INSERT INTO identity_migrations (old_id, new_id, display_name)
  SELECT p_old_user_id, p_new_user_id, display_name
  FROM   profiles
  WHERE  id = p_old_user_id;

  -- Step 2: Re-create the profile under the new id, copying ALL carried columns.
  -- ⚠ SCHEMA-DRIFT: if you add a column to `profiles`, add it here too (the
  -- migrate-copies-all-columns test in tests/unit/migrate-identity-columns.test.ts
  -- will fail until you do). created_at/updated_at are intentionally omitted.
  INSERT INTO profiles (
    id, display_name, skill_level, pin,
    vip_tag, vip_theme,
    needs_rename, collided_name, flagged_at
  )
  SELECT
    p_new_user_id, display_name, skill_level, pin,
    vip_tag, vip_theme,
    needs_rename, collided_name, flagged_at
  FROM profiles
  WHERE id = p_old_user_id;

  -- Step 3: queue_entries.
  UPDATE queue_entries SET player_id = p_new_user_id WHERE player_id = p_old_user_id;

  -- Step 4: match_players.
  UPDATE match_players SET player_id = p_new_user_id WHERE player_id = p_old_user_id;

  -- Step 4.5: sessions.created_by (skipped for active organizers).
  IF NOT v_is_active_organizer THEN
    UPDATE sessions SET created_by = p_new_user_id WHERE created_by = p_old_user_id;
  END IF;

  -- Step 4.6: session_wrapped_stats (non-fatal).
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

  -- Step 4.7: session_organizers (non-fatal).
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

  -- Step 5: Delete old profile (skipped for active organizers).
  IF NOT v_is_active_organizer THEN
    DELETE FROM profiles WHERE id = p_old_user_id;
  END IF;

  RETURN v_is_active_organizer;
END;
$$;

GRANT EXECUTE ON FUNCTION migrate_player_identity(uuid, uuid) TO service_role;
