-- ============================================================================
-- M2 remainder: (a) initplan-hoist bare auth.* calls in RLS policies, and
-- (b) trim zero-subscriber tables from the realtime publication.
--
-- (a) Wrapping `auth.uid()` / `auth.role()` in a scalar sub-select
--     `(select auth.uid())` lets the planner hoist the STABLE call to an
--     InitPlan evaluated ONCE per statement instead of once per row. On the
--     tables realtime broadcasts row-by-row (match_players, matches,
--     queue_entries) this removes a per-row function call under every RLS
--     check. Semantically identical — auth.uid()/auth.role() are STABLE
--     within a statement — so every policy's USING/WITH CHECK is reproduced
--     verbatim with only the auth.* call wrapped. (Supabase advisor
--     "auth_rls_initplan".)
--
-- (b) session_organizers + match_games have ZERO client realtime subscribers
--     (verified against src/ — subscribed tables are only courts,
--     queue_entries, matches, match_players, profiles, sessions), so their
--     presence in supabase_realtime is pure WAL-decode waste. Drop them.
-- ============================================================================

-- ── (a) InitPlan wraps ──────────────────────────────────────────────────────
ALTER POLICY club_members_select ON public.club_members
  USING (((player_id = (select auth.uid())) OR is_club_member(club_id)));

ALTER POLICY courts_delete ON public.courts
  USING ((session_id IN ( SELECT session_organizers.session_id
     FROM session_organizers
    WHERE (session_organizers.user_id = (select auth.uid())))));

ALTER POLICY courts_insert ON public.courts
  WITH CHECK ((session_id IN ( SELECT session_organizers.session_id
     FROM session_organizers
    WHERE (session_organizers.user_id = (select auth.uid())))));

ALTER POLICY courts_update ON public.courts
  USING ((session_id IN ( SELECT session_organizers.session_id
     FROM session_organizers
    WHERE (session_organizers.user_id = (select auth.uid())))));

ALTER POLICY identity_migrations_select_own ON public.identity_migrations
  USING ((((select auth.uid()) = old_id) OR ((select auth.uid()) = new_id)));

ALTER POLICY match_events_select_organizer ON public.match_events
  USING (((EXISTS ( SELECT 1
     FROM session_organizers so
    WHERE ((so.session_id = match_events.session_id) AND (so.user_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
     FROM sessions s
    WHERE ((s.id = match_events.session_id) AND (s.created_by = (select auth.uid())))))));

ALTER POLICY matches_insert ON public.matches
  WITH CHECK ((session_id IN ( SELECT session_organizers.session_id
     FROM session_organizers
    WHERE (session_organizers.user_id = (select auth.uid())))));

ALTER POLICY matches_update ON public.matches
  USING ((session_id IN ( SELECT session_organizers.session_id
     FROM session_organizers
    WHERE (session_organizers.user_id = (select auth.uid())))));

ALTER POLICY "Players can read own partnership data" ON public.player_partnerships
  USING ((player_id = (select auth.uid())));

ALTER POLICY "Players can read own rivalry data" ON public.player_rivalries
  USING ((player_id = (select auth.uid())));

ALTER POLICY profiles_insert ON public.profiles
  WITH CHECK ((id = (select auth.uid())));

ALTER POLICY profiles_update_own ON public.profiles
  USING ((id = (select auth.uid())))
  WITH CHECK ((id = (select auth.uid())));

ALTER POLICY push_subscriptions_delete_own ON public.push_subscriptions
  USING ((user_id = (select auth.uid())));

ALTER POLICY push_subscriptions_insert_own ON public.push_subscriptions
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY push_subscriptions_select_own ON public.push_subscriptions
  USING ((user_id = (select auth.uid())));

ALTER POLICY push_subscriptions_update_own ON public.push_subscriptions
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY queue_delete_own ON public.queue_entries
  USING ((player_id = (select auth.uid())));

ALTER POLICY queue_insert ON public.queue_entries
  WITH CHECK ((player_id = (select auth.uid())));

ALTER POLICY queue_update_own ON public.queue_entries
  USING ((player_id = (select auth.uid())));

ALTER POLICY "Organizers can read wrapped stats for their sessions" ON public.session_wrapped_stats
  USING ((EXISTS ( SELECT 1
     FROM session_organizers so
    WHERE ((so.session_id = session_wrapped_stats.session_id) AND (so.user_id = (select auth.uid()))))));

ALTER POLICY "Players can dismiss their own wrapped intro" ON public.session_wrapped_stats
  USING ((player_id = (select auth.uid())))
  WITH CHECK ((player_id = (select auth.uid())));

ALTER POLICY "Players can read own wrapped stats" ON public.session_wrapped_stats
  USING ((player_id = (select auth.uid())));

ALTER POLICY "Service role insert" ON public.session_wrapped_stats
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role update" ON public.session_wrapped_stats
  USING (((select auth.role()) = 'service_role'::text));

ALTER POLICY sessions_insert ON public.sessions
  WITH CHECK ((created_by = (select auth.uid())));

-- ── (b) Realtime publication trim (zero-subscriber tables) ──────────────────
-- Guarded for the same reason as 20260701000006: these tables were only ever
-- publication members on production (added via the Supabase dashboard), so an
-- unguarded DROP raises 42704 on any database built from migrations alone and
-- aborts the whole replay. Dropping something already absent is the desired
-- end state either way, so skipping is correct rather than merely tolerable.
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
