-- ============================================================
-- Declare the table GRANTs that production has and migrations never did
-- ============================================================
-- Fourth and final instalment of the root cause behind 20260722000000-2: the
-- migration set did not describe the database.
--
-- Production's tables each carry a baseline grant to anon / authenticated /
-- service_role, applied by the Supabase platform when the objects were created
-- and recorded in no migration. The security migrations then carve pieces back
-- OUT of that baseline — `revoke select on profiles from anon, authenticated`
-- (20260701000010), `revoke update on queue_entries` (20260721190000),
-- `revoke insert on sessions` (20260721160000), and so on. Read production's
-- ACLs and you can see the subtraction: profiles anon is `awdDxtm`, i.e. the
-- full set minus SELECT.
--
-- On a database built from migrations alone the baseline never arrives, so
-- there is nothing to subtract from and every role — INCLUDING service_role —
-- lands with only REFERENCES/TRIGGER/TRUNCATE. That is why the integration
-- suite, once the replay was finally unblocked, failed on its very first
-- fixture with:
--
--     permission denied for table profiles      (from a SERVICE-ROLE client)
--
-- WHY THIS RESTATES THE FINAL STATE RATHER THAN THE BASELINE.
-- The tempting fix is `GRANT ALL ... TO anon, authenticated, service_role`, but
-- this migration necessarily runs AFTER the revokes above, so that would hand
-- anon back exactly the privileges the lockdown migrations were written to take
-- away — re-opening `profiles.pin` and `sessions.organizer_passcode` to the
-- browser key. Every statement below is therefore production's EXACT
-- post-revoke privilege set per table and per role, generated from
-- pg_class.relacl via aclexplode() rather than derived by hand.
--
-- A GRANT of privileges already held is a no-op, so this is a strict no-op
-- against production. Column-level grants (the `grant select (col)` re-grants
-- in 20260701000009/10) are untouched: column privileges are independent of
-- table privileges, and nothing here grants SELECT where those apply.
--
-- Verified against production, not assumed: inside a transaction the grants
-- were stripped to simulate a fresh database, this migration was replayed, and
-- the resulting ACLs were compared against a pre-drop snapshot — zero
-- differences — then rolled back.
-- ============================================================

DO $$
DECLARE
  r          record;
  v_privs    text;
  v_has_maintain boolean := current_setting('server_version_num')::int >= 170000;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('club_invites',              'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_invites',              'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_invites',              'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_members',              'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_members',              'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_members',              'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_milestones',           'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_milestones',           'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('club_milestones',           'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('clubs',                     'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('clubs',                     'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('clubs',                     'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- Service-role only on purpose: the credential-guessing log has RLS on,
      -- no policies AND no grants for browser roles (20260721140000/180000).
      ('co_organizer_join_attempts','service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('courts',                    'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('courts',                    'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('courts',                    'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('identity_migrations',       'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('identity_migrations',       'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('identity_migrations',       'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('leaderboard_refresh_state', 'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('leaderboard_refresh_state', 'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('leaderboard_refresh_state', 'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_events',              'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_events',              'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_events',              'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_games',               'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_games',               'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_games',               'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_players',             'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_players',             'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('match_players',             'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('matches',                   'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('matches',                   'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('matches',                   'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('player_partnerships',       'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('player_partnerships',       'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('player_partnerships',       'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- Service-role only: rename audit log.
      ('player_renames',            'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('player_rivalries',          'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('player_rivalries',          'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('player_rivalries',          'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- NO SELECT for anon/authenticated: table-wide SELECT was revoked so that
      -- `pin` cannot be read; a column-scoped SELECT re-grant covers the rest
      -- (20260701000010). Granting SELECT here would silently undo that.
      ('profiles',                  'anon',          'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('profiles',                  'authenticated', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('profiles',                  'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('push_subscriptions',        'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('push_subscriptions',        'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('push_subscriptions',        'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- NO UPDATE for anon/authenticated (20260721190000): queue status writes
      -- go through server actions on the service client.
      ('queue_entries',             'anon',          'SELECT, INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('queue_entries',             'authenticated', 'SELECT, INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('queue_entries',             'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- NO INSERT for anon/authenticated (20260721200000): self-granting
      -- organizer rights was an escalation path.
      ('session_organizers',        'anon',          'SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('session_organizers',        'authenticated', 'SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('session_organizers',        'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('session_wrapped_stats',     'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('session_wrapped_stats',     'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('session_wrapped_stats',     'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- NO SELECT (organizer_passcode) and NO INSERT (session forgery) for
      -- anon/authenticated — 20260701000010 and 20260721160000.
      ('sessions',                  'anon',          'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('sessions',                  'authenticated', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('sessions',                  'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_alltime_leaderboard_mat', 'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_alltime_leaderboard_mat', 'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_alltime_leaderboard_mat', 'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      -- NO SELECT for anon/authenticated (20260702000003): direct, unscoped
      -- reads of these views would dump every club's history.
      ('v_match_history',           'anon',          'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_match_history',           'authenticated', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_match_history',           'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_queue_full_with_wait_time','anon',         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_queue_full_with_wait_time','authenticated','SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_queue_full_with_wait_time','service_role', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_queue_with_wait_time',    'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_queue_with_wait_time',    'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_queue_with_wait_time',    'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_recent_pairings',         'anon',          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_recent_pairings',         'authenticated', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_recent_pairings',         'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_session_leaderboard',     'anon',          'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_session_leaderboard',     'authenticated', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
      ('v_session_leaderboard',     'service_role',  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
    ) AS t(tbl, role, privs)
  LOOP
    -- MAINTAIN arrived in Postgres 17. config.toml pins 17 to match production,
    -- but degrade cleanly rather than abort if someone runs an older engine.
    v_privs := r.privs;
    IF NOT v_has_maintain THEN
      v_privs := replace(replace(v_privs, ', MAINTAIN', ''), 'MAINTAIN, ', '');
    END IF;

    EXECUTE format('GRANT %s ON public.%I TO %I', v_privs, r.tbl, r.role);
  END LOOP;
END $$;

-- ── Assert the privileges the app actually depends on ───────
-- Narrow on purpose: this checks the invariants whose absence produced the
-- original failure and whose presence would mean a security regression, rather
-- than restating the whole matrix (which the GRANTs above already declare).
DO $$
DECLARE
  v_problem text;
BEGIN
  -- 1. service_role must be able to read every table. Its absence is what broke
  --    the integration suite: "permission denied for table profiles".
  SELECT string_agg(t.tablename, ', ' ORDER BY t.tablename) INTO v_problem
    FROM pg_tables t
   WHERE t.schemaname = 'public'
     AND NOT has_table_privilege('service_role', format('public.%I', t.tablename), 'SELECT');
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'service_role lacks SELECT on: %', v_problem;
  END IF;

  -- 2. The lockdowns must still hold. If any of these flips true, this
  --    migration has handed the browser key back something a security
  --    migration deliberately took away.
  IF has_table_privilege('anon', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'anon regained table-wide SELECT on profiles (pin exposure)';
  END IF;
  IF has_table_privilege('anon', 'public.sessions', 'SELECT') THEN
    RAISE EXCEPTION 'anon regained table-wide SELECT on sessions (passcode exposure)';
  END IF;
  IF has_table_privilege('anon', 'public.sessions', 'INSERT') THEN
    RAISE EXCEPTION 'anon regained INSERT on sessions (session forgery)';
  END IF;
  IF has_table_privilege('anon', 'public.queue_entries', 'UPDATE') THEN
    RAISE EXCEPTION 'anon regained UPDATE on queue_entries (queue forgery)';
  END IF;
  IF has_table_privilege('anon', 'public.session_organizers', 'INSERT') THEN
    RAISE EXCEPTION 'anon regained INSERT on session_organizers (privilege escalation)';
  END IF;
  IF has_table_privilege('anon', 'public.co_organizer_join_attempts', 'SELECT') THEN
    RAISE EXCEPTION 'anon regained SELECT on the credential-attempt log';
  END IF;
END $$;
