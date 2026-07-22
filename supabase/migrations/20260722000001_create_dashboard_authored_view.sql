-- ============================================================
-- Bring the last dashboard-authored object into migrations
-- ============================================================
-- Companion to 20260722000000. Same root cause: objects created through the
-- Supabase dashboard were never written into the migration set, so the set is
-- not a complete description of the database.
--
-- v_recent_pairings is the only such object left. An audit of every table,
-- view, materialized view and function in production against every
-- CREATE statement in supabase/migrations found no others.
--
-- Its absence broke the replay a second time, one migration further along than
-- the publication failure:
--
--     ERROR: relation "public.v_recent_pairings" does not exist (SQLSTATE 42P01)
--     -- 20260702000003_harden_security_definer_views.sql
--
-- WHY THIS FILE IS DATED AFTER THE MIGRATION THAT USES THE VIEW.
-- The natural fix — create the view in an early-dated file so it exists before
-- 20260702000003 — would insert a migration BEFORE ones already applied to
-- production, which the CLI applies out of order. Not worth the risk to a live
-- deploy pipeline for a view with no runtime consumer. Instead 20260702000003
-- now skips its ALTER when the view is absent, and this migration creates the
-- view AND applies the same security_invoker setting. Both orderings converge
-- on the identical end state; production, a preview branch, and
-- `supabase db reset` all agree.
--
-- Definition captured verbatim from production via pg_get_viewdef().
--
-- NOTE: the view has no runtime consumer. buildOverlapMap (matchmaking-db.ts)
-- does the equivalent join by hand — see MEMORY.md gotcha 7 — and the only
-- other mentions are a row type in database.ts and a comment in the engine
-- test. It is reproduced here because migrations should describe the database
-- as it IS; whether to retire it is a separate decision, and dropping it would
-- mean editing an already-applied migration that references it.
-- ============================================================

CREATE OR REPLACE VIEW public.v_recent_pairings AS
SELECT mp1.player_id AS player_a,
       mp2.player_id AS player_b,
       m.session_id,
       m.completed_at,
       CASE
         WHEN mp1.team = mp2.team THEN 'teammate'::text
         ELSE 'opponent'::text
       END AS relationship
  FROM match_players mp1
  JOIN match_players mp2
    ON mp1.match_id = mp2.match_id AND mp1.player_id <> mp2.player_id
  JOIN matches m ON m.id = mp1.match_id
 WHERE m.status = 'completed'::match_status
 ORDER BY m.completed_at DESC;

-- Matches production, and re-applies what 20260702000003 skips on a fresh
-- database. security_invoker means RLS on the base tables (match_players,
-- matches) applies to the querying role rather than being bypassed.
ALTER VIEW public.v_recent_pairings SET (security_invoker = true);

-- Fail loudly rather than leave a database that looks fine but differs from
-- production in a way only realtime/RLS behaviour would reveal.
DO $$
BEGIN
  IF to_regclass('public.v_recent_pairings') IS NULL THEN
    RAISE EXCEPTION 'v_recent_pairings was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.v_recent_pairings'::regclass
       AND reloptions @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'v_recent_pairings is missing security_invoker=true';
  END IF;
END $$;
