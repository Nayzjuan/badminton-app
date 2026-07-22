-- ============================================================
-- Declare the realtime publication's full membership in migrations
-- ============================================================
-- ROOT CAUSE, not a band-aid for the 42704.
--
-- `supabase_realtime` was populated through the Supabase dashboard, so which
-- tables stream postgres_changes has never been expressed in this migration
-- set. Two consequences, both live until now:
--
--   1. 20260701000006 and 20260717174914 issued unguarded
--      `ALTER PUBLICATION ... DROP TABLE`. Those succeed against production
--      (member) and raise 42704 on a database built from migrations alone
--      (not a member), aborting the replay. Every Supabase preview branch
--      replays from zero, so branch creation failed and the Vitest Integration
--      job died during DB setup — on every PR and on main. Those two files are
--      now guarded, which stops the crash.
--
--   2. Stopping the crash is not enough. `courts`, `matches`, `match_players`
--      and `queue_entries` are publication members in production but are added
--      by NO migration, so a from-scratch database would come up with realtime
--      silently missing for the four tables the app actually subscribes to.
--      Integration tests would pass against a database that does not behave
--      like production — worse than a failing build, because it looks green.
--
-- This migration closes that gap: it states the intended membership outright,
-- so `supabase db reset`, a preview branch, and production all converge on the
-- same publication. Migrations become the single source of truth.
--
-- Written to be idempotent and CONVERGENT — safe to re-run, and a no-op
-- against production, which already matches. It deliberately does not touch a
-- table that is already a member: re-adding would mean DROP + ADD, and on a
-- live database that briefly removes the table from replication for no reason.
-- Column lists for profiles/sessions are therefore left to 20260701000006,
-- which sets them; the check here is membership only.
--
-- NOTE the asymmetry between the two groups below. profiles and sessions are
-- added with an EXPLICIT column list because each carries an authentication
-- secret (profiles.pin, sessions.organizer_passcode) that must never reach the
-- WAL-fed realtime stream — see 20260701000006. A consequence worth knowing:
-- because their lists are explicit, a NEW column on either table is NOT
-- replicated until it is added to the list on purpose. That is the safe
-- default for tables holding secrets, and it is why the four tables below,
-- which hold none, stay on all-columns.
-- ============================================================

-- ── Tables that must be members, all columns ────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['courts', 'matches', 'match_players', 'queue_entries'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_rel pr
        JOIN pg_publication p ON p.oid = pr.prpubid
        JOIN pg_class c       ON c.oid = pr.prrelid
        JOIN pg_namespace n   ON n.oid = c.relnamespace
       WHERE p.pubname = 'supabase_realtime'
         AND n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ── Tables that must be members, secret columns withheld ────
-- Only fires if 20260701000006 somehow did not run (e.g. a future squash that
-- drops it). Same column lists as that migration — keep the two in step.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c       ON c.oid = pr.prrelid
      JOIN pg_namespace n   ON n.oid = c.relnamespace
     WHERE p.pubname = 'supabase_realtime'
       AND n.nspname = 'public' AND c.relname = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles
      (id, display_name, skill_level, created_at, updated_at, vip_tag, vip_theme, needs_rename, collided_name, flagged_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c       ON c.oid = pr.prrelid
      JOIN pg_namespace n   ON n.oid = c.relnamespace
     WHERE p.pubname = 'supabase_realtime'
       AND n.nspname = 'public' AND c.relname = 'sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions
      (id, name, created_by, scoring, is_active, created_at, ended_at, is_auto_matchmaking_on, court_time_limit_minutes, max_auto_drafts_override, auto_publish, club_id);
  END IF;
END $$;

-- ── Tables that must NOT be members ─────────────────────────
-- Zero subscribers; trimmed by 20260717174914. Restated so the end state is
-- declared in one place rather than inferred from a chain of edits.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_organizers', 'match_games'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_rel pr
        JOIN pg_publication p ON p.oid = pr.prpubid
        JOIN pg_class c       ON c.oid = pr.prrelid
        JOIN pg_namespace n   ON n.oid = c.relnamespace
       WHERE p.pubname = 'supabase_realtime'
         AND n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ── Fail loudly if the end state is still wrong ─────────────
-- Without this the migration could silently no-op (e.g. a table renamed, or a
-- future edit reordering the guards) and leave a preview database that looks
-- healthy but does not stream what production streams. A replay that cannot
-- reproduce production should stop here rather than hand over a green build.
DO $$
DECLARE
  v_missing text;
  v_extra   text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
    FROM unnest(ARRAY['courts','matches','match_players','queue_entries','profiles','sessions']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_publication_rel pr
       JOIN pg_publication p ON p.oid = pr.prpubid
       JOIN pg_class c       ON c.oid = pr.prrelid
       JOIN pg_namespace n   ON n.oid = c.relnamespace
      WHERE p.pubname = 'supabase_realtime'
        AND n.nspname = 'public' AND c.relname = t
   );

  SELECT string_agg(t, ', ' ORDER BY t) INTO v_extra
    FROM unnest(ARRAY['session_organizers','match_games']) AS t
   WHERE EXISTS (
     SELECT 1 FROM pg_publication_rel pr
       JOIN pg_publication p ON p.oid = pr.prpubid
       JOIN pg_class c       ON c.oid = pr.prrelid
       JOIN pg_namespace n   ON n.oid = c.relnamespace
      WHERE p.pubname = 'supabase_realtime'
        AND n.nspname = 'public' AND c.relname = t
   );

  IF v_missing IS NOT NULL OR v_extra IS NOT NULL THEN
    RAISE EXCEPTION
      'supabase_realtime membership is wrong after reconciliation (missing: %, unexpected: %)',
      coalesce(v_missing, 'none'), coalesce(v_extra, 'none');
  END IF;
END $$;
