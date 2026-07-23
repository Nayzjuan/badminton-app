-- ============================================================
-- Declare the RLS baseline that production has and migrations never captured
-- ============================================================
-- Third and largest instalment of the same root cause behind 20260722000000
-- (realtime publication) and 20260722000001 (v_recent_pairings): a great deal
-- of this database was built through the Supabase dashboard and never written
-- into the migration set, so the set does not describe the database.
--
-- For RLS the divergence is severe. Audited every policy and every
-- relrowsecurity flag in production against every CREATE POLICY / ENABLE ROW
-- LEVEL SECURITY in supabase/migrations:
--
--   * 7 tables have RLS ENABLED in production and enabled by NO migration:
--     courts, matches, match_players, match_games, queue_entries, profiles,
--     session_organizers. On a database built from migrations they come up
--     with row security OFF — every row readable and writable by anyone
--     holding the anon key, since a table with RLS disabled ignores policies
--     entirely.
--   * 35 of the 46 policies in production are created by NO migration.
--
-- The practical consequence is worse than a failing build. Once the replay was
-- unblocked, the integration suite would have run against a database whose
-- security posture bears no resemblance to production — passing tests that
-- prove nothing about the RLS actually deployed. tests/integration exists
-- specifically to exercise real role and policy behaviour (see
-- tenancy-guards), so this is the one suite where that gap matters most.
--
-- This migration states the baseline outright. It is CONVERGENT and a strict
-- NO-OP against production:
--   * ENABLE ROW LEVEL SECURITY is idempotent — re-enabling an enabled table
--     does nothing.
--   * Every policy is created only when absent. Existing policies are left
--     exactly as they are. Production is the source of truth for their
--     definitions, so this migration deliberately does NOT drop and recreate
--     them — that would rewrite live security rules to fix a drift that does
--     not exist, and a transcription slip would silently weaken production.
--
-- Definitions captured verbatim from production via pg_policies (qual,
-- with_check, cmd, roles, permissive) and rendered by Postgres itself rather
-- than transcribed by hand. Fidelity was then verified against production:
-- inside a transaction the 35 policies were dropped, this migration was
-- replayed, and the resulting pg_policies rows were compared column by column
-- with a snapshot taken beforehand — zero differences — then rolled back.
--
-- These are the CURRENT definitions, i.e. after the initplan wrapping applied
-- by 20260717174914. That migration's ALTERs are now guarded to skip a policy
-- that does not exist, so on a fresh database the policy simply arrives here
-- already in its final form. Both orderings converge.
-- ============================================================

-- ── Row security flags ──────────────────────────────────────
-- Idempotent by definition; listed explicitly so the intent is declared rather
-- than inherited from whoever last clicked through the dashboard.
ALTER TABLE public.courts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_players      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_games        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_organizers ENABLE ROW LEVEL SECURITY;

-- ── Policies present in production, created by no migration ──
-- Each entry creates its policy only when absent, so this whole block is a
-- no-op on production and does the real work only on a fresh database.
DO $$
DECLARE
  v_created int := 0;
BEGIN
  -- courts
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='courts' AND policyname='courts_delete') THEN
    EXECUTE $ddl$CREATE POLICY courts_delete ON public.courts FOR DELETE TO authenticated
      USING ((session_id IN ( SELECT session_organizers.session_id FROM session_organizers
        WHERE (session_organizers.user_id = ( SELECT auth.uid() AS uid)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='courts' AND policyname='courts_insert') THEN
    EXECUTE $ddl$CREATE POLICY courts_insert ON public.courts FOR INSERT TO authenticated
      WITH CHECK ((session_id IN ( SELECT session_organizers.session_id FROM session_organizers
        WHERE (session_organizers.user_id = ( SELECT auth.uid() AS uid)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='courts' AND policyname='courts_update') THEN
    EXECUTE $ddl$CREATE POLICY courts_update ON public.courts FOR UPDATE TO authenticated
      USING ((session_id IN ( SELECT session_organizers.session_id FROM session_organizers
        WHERE (session_organizers.user_id = ( SELECT auth.uid() AS uid)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- identity_migrations
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='identity_migrations' AND policyname='identity_migrations_select_own') THEN
    EXECUTE $ddl$CREATE POLICY identity_migrations_select_own ON public.identity_migrations FOR SELECT TO public
      USING (((( SELECT auth.uid() AS uid) = old_id) OR (( SELECT auth.uid() AS uid) = new_id)))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- match_games
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='match_games' AND policyname='match_games_delete') THEN
    EXECUTE $ddl$CREATE POLICY match_games_delete ON public.match_games FOR DELETE TO public
      USING ((EXISTS ( SELECT 1 FROM matches m
        WHERE ((m.id = match_games.match_id) AND is_session_organizer(m.session_id)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='match_games' AND policyname='match_games_insert') THEN
    EXECUTE $ddl$CREATE POLICY match_games_insert ON public.match_games FOR INSERT TO public
      WITH CHECK ((EXISTS ( SELECT 1 FROM matches m
        WHERE ((m.id = match_games.match_id) AND is_session_organizer(m.session_id)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='match_games' AND policyname='match_games_update') THEN
    EXECUTE $ddl$CREATE POLICY match_games_update ON public.match_games FOR UPDATE TO public
      USING ((EXISTS ( SELECT 1 FROM matches m
        WHERE ((m.id = match_games.match_id) AND is_session_organizer(m.session_id)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- match_players
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='match_players' AND policyname='match_players_delete') THEN
    EXECUTE $ddl$CREATE POLICY match_players_delete ON public.match_players FOR DELETE TO public
      USING ((EXISTS ( SELECT 1 FROM matches m
        WHERE ((m.id = match_players.match_id) AND is_session_organizer(m.session_id)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='match_players' AND policyname='match_players_update') THEN
    EXECUTE $ddl$CREATE POLICY match_players_update ON public.match_players FOR UPDATE TO public
      USING ((EXISTS ( SELECT 1 FROM matches m
        WHERE ((m.id = match_players.match_id) AND is_session_organizer(m.session_id)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- matches
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='matches' AND policyname='matches_delete') THEN
    EXECUTE $ddl$CREATE POLICY matches_delete ON public.matches FOR DELETE TO public
      USING (is_session_organizer(session_id))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='matches' AND policyname='matches_insert') THEN
    EXECUTE $ddl$CREATE POLICY matches_insert ON public.matches FOR INSERT TO authenticated
      WITH CHECK ((session_id IN ( SELECT session_organizers.session_id FROM session_organizers
        WHERE (session_organizers.user_id = ( SELECT auth.uid() AS uid)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='matches' AND policyname='matches_update') THEN
    EXECUTE $ddl$CREATE POLICY matches_update ON public.matches FOR UPDATE TO authenticated
      USING ((session_id IN ( SELECT session_organizers.session_id FROM session_organizers
        WHERE (session_organizers.user_id = ( SELECT auth.uid() AS uid)))))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- player_partnerships / player_rivalries
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_partnerships' AND policyname='Players can read own partnership data') THEN
    EXECUTE $ddl$CREATE POLICY "Players can read own partnership data" ON public.player_partnerships FOR SELECT TO public
      USING ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_rivalries' AND policyname='Players can read own rivalry data') THEN
    EXECUTE $ddl$CREATE POLICY "Players can read own rivalry data" ON public.player_rivalries FOR SELECT TO public
      USING ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- profiles
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles_insert') THEN
    EXECUTE $ddl$CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO authenticated
      WITH CHECK ((id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- NOTE (corrected 2026-07-23): this comment used to claim USING (true) was
  -- "intentional and load-bearing" because the public leaderboard and Wrapped
  -- share pages read arbitrary profiles while logged out. That was wrong:
  -- `profiles` has no SELECT policy for `anon` at all, so no logged-out read
  -- has ever gone through this policy — those pages use the service client.
  -- USING (true) was simply over-broad, and the tenancy audit filed it as
  -- finding #8. 20260723200000 replaces it with a shared-scope predicate;
  -- this branch only still exists so a from-scratch replay reproduces the
  -- historical baseline before that migration tightens it.
  -- `pin` is kept out of responses by the COLUMN grants (20260701000010) and
  -- PUBLIC_PROFILE_COLUMNS, not by this row policy — that part was accurate.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles_select') THEN
    EXECUTE $ddl$CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
      USING (true)$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='profiles' AND policyname='profiles_update_own') THEN
    EXECUTE $ddl$CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO public
      USING ((id = ( SELECT auth.uid() AS uid)))
      WITH CHECK ((id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- push_subscriptions
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_subscriptions' AND policyname='push_subscriptions_delete_own') THEN
    EXECUTE $ddl$CREATE POLICY push_subscriptions_delete_own ON public.push_subscriptions FOR DELETE TO authenticated
      USING ((user_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_subscriptions' AND policyname='push_subscriptions_insert_own') THEN
    EXECUTE $ddl$CREATE POLICY push_subscriptions_insert_own ON public.push_subscriptions FOR INSERT TO authenticated
      WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_subscriptions' AND policyname='push_subscriptions_select_own') THEN
    EXECUTE $ddl$CREATE POLICY push_subscriptions_select_own ON public.push_subscriptions FOR SELECT TO authenticated
      USING ((user_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='push_subscriptions' AND policyname='push_subscriptions_update_own') THEN
    EXECUTE $ddl$CREATE POLICY push_subscriptions_update_own ON public.push_subscriptions FOR UPDATE TO authenticated
      USING ((user_id = ( SELECT auth.uid() AS uid)))
      WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- queue_entries
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='queue_entries' AND policyname='queue_delete_organizer') THEN
    EXECUTE $ddl$CREATE POLICY queue_delete_organizer ON public.queue_entries FOR DELETE TO public
      USING (is_session_organizer(session_id))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='queue_entries' AND policyname='queue_delete_own') THEN
    EXECUTE $ddl$CREATE POLICY queue_delete_own ON public.queue_entries FOR DELETE TO public
      USING ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='queue_entries' AND policyname='queue_insert') THEN
    EXECUTE $ddl$CREATE POLICY queue_insert ON public.queue_entries FOR INSERT TO public
      WITH CHECK ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='queue_entries' AND policyname='queue_update_organizer') THEN
    EXECUTE $ddl$CREATE POLICY queue_update_organizer ON public.queue_entries FOR UPDATE TO public
      USING (is_session_organizer(session_id))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='queue_entries' AND policyname='queue_update_own') THEN
    EXECUTE $ddl$CREATE POLICY queue_update_own ON public.queue_entries FOR UPDATE TO public
      USING ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- session_organizers
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_organizers' AND policyname='session_organizers_delete') THEN
    EXECUTE $ddl$CREATE POLICY session_organizers_delete ON public.session_organizers FOR DELETE TO public
      USING (is_session_organizer(session_id))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_organizers' AND policyname='session_organizers_insert') THEN
    EXECUTE $ddl$CREATE POLICY session_organizers_insert ON public.session_organizers FOR INSERT TO public
      WITH CHECK (is_session_organizer(session_id))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- session_wrapped_stats
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_wrapped_stats' AND policyname='Organizers can read wrapped stats for their sessions') THEN
    EXECUTE $ddl$CREATE POLICY "Organizers can read wrapped stats for their sessions" ON public.session_wrapped_stats FOR SELECT TO public
      USING ((EXISTS ( SELECT 1 FROM session_organizers so
        WHERE ((so.session_id = session_wrapped_stats.session_id) AND (so.user_id = ( SELECT auth.uid() AS uid))))))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_wrapped_stats' AND policyname='Players can dismiss their own wrapped intro') THEN
    EXECUTE $ddl$CREATE POLICY "Players can dismiss their own wrapped intro" ON public.session_wrapped_stats FOR UPDATE TO public
      USING ((player_id = ( SELECT auth.uid() AS uid)))
      WITH CHECK ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_wrapped_stats' AND policyname='Players can read own wrapped stats') THEN
    EXECUTE $ddl$CREATE POLICY "Players can read own wrapped stats" ON public.session_wrapped_stats FOR SELECT TO public
      USING ((player_id = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_wrapped_stats' AND policyname='Service role insert') THEN
    EXECUTE $ddl$CREATE POLICY "Service role insert" ON public.session_wrapped_stats FOR INSERT TO public
      WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='session_wrapped_stats' AND policyname='Service role update') THEN
    EXECUTE $ddl$CREATE POLICY "Service role update" ON public.session_wrapped_stats FOR UPDATE TO public
      USING ((( SELECT auth.role() AS role) = 'service_role'::text))$ddl$;
    v_created := v_created + 1;
  END IF;

  -- sessions
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sessions' AND policyname='sessions_insert') THEN
    EXECUTE $ddl$CREATE POLICY sessions_insert ON public.sessions FOR INSERT TO public
      WITH CHECK ((created_by = ( SELECT auth.uid() AS uid)))$ddl$;
    v_created := v_created + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sessions' AND policyname='sessions_update') THEN
    EXECUTE $ddl$CREATE POLICY sessions_update ON public.sessions FOR UPDATE TO public
      USING (is_session_organizer(id))
      WITH CHECK (is_session_organizer(id))$ddl$;
    v_created := v_created + 1;
  END IF;

  RAISE NOTICE 'rls baseline: created % missing policies', v_created;
END $$;

-- ── Assert the end state ────────────────────────────────────
-- A silent no-op here would hand back a database that looks healthy but
-- enforces different security than production — the exact failure this whole
-- migration exists to prevent. Stop the replay instead.
DO $$
DECLARE
  v_missing_rls text;
  v_missing_pol text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing_rls
    FROM unnest(ARRAY['courts','matches','match_players','match_games','queue_entries',
                      'profiles','session_organizers','sessions','session_wrapped_stats',
                      'identity_migrations','push_subscriptions','player_partnerships',
                      'player_rivalries','club_members']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity
   );

  SELECT string_agg(x.tbl || '.' || x.pol, ', ' ORDER BY x.tbl, x.pol) INTO v_missing_pol
    FROM (VALUES
      ('club_members','club_members_select'),
      ('courts','courts_delete'),('courts','courts_insert'),('courts','courts_select'),('courts','courts_update'),
      ('identity_migrations','identity_migrations_select_own'),
      ('match_events','match_events_select_organizer'),
      ('match_games','match_games_delete'),('match_games','match_games_insert'),
      ('match_games','match_games_select'),('match_games','match_games_update'),
      ('match_players','match_players_delete'),('match_players','match_players_insert'),
      ('match_players','match_players_select'),('match_players','match_players_update'),
      ('matches','matches_delete'),('matches','matches_insert'),('matches','matches_select'),
      ('matches','matches_select_draft_firewall'),('matches','matches_update'),
      ('player_partnerships','Players can read own partnership data'),
      ('player_rivalries','Players can read own rivalry data'),
      ('profiles','profiles_insert'),('profiles','profiles_select'),('profiles','profiles_update_own'),
      ('push_subscriptions','push_subscriptions_delete_own'),('push_subscriptions','push_subscriptions_insert_own'),
      ('push_subscriptions','push_subscriptions_select_own'),('push_subscriptions','push_subscriptions_update_own'),
      ('queue_entries','queue_delete_organizer'),('queue_entries','queue_delete_own'),
      ('queue_entries','queue_insert'),('queue_entries','queue_select'),
      ('queue_entries','queue_update_organizer'),('queue_entries','queue_update_own'),
      ('session_organizers','session_organizers_delete'),('session_organizers','session_organizers_insert'),
      ('session_organizers','session_organizers_select'),
      ('session_wrapped_stats','Organizers can read wrapped stats for their sessions'),
      ('session_wrapped_stats','Players can dismiss their own wrapped intro'),
      ('session_wrapped_stats','Players can read own wrapped stats'),
      ('session_wrapped_stats','Service role insert'),('session_wrapped_stats','Service role update'),
      ('sessions','sessions_insert'),('sessions','sessions_select'),('sessions','sessions_update')
    ) AS x(tbl, pol)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = x.tbl AND p.policyname = x.pol
   );

  IF v_missing_rls IS NOT NULL OR v_missing_pol IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS baseline incomplete — tables without row security: [%]; missing policies: [%]',
      coalesce(v_missing_rls, 'none'), coalesce(v_missing_pol, 'none');
  END IF;
END $$;
