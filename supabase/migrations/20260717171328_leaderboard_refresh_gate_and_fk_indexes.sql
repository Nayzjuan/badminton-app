-- ============================================================================
-- M1: global refresh gate for the all-time leaderboard matview + FK index pack.
--
-- refresh_alltime_leaderboard() is fire-and-forgotten from every score submit
-- and every reconnect. Its 30s debounce lived in Node module scope, which on
-- Vercel serverless is per-worker and barely gated anything: prod showed 1,219
-- REFRESH MATERIALIZED VIEW CONCURRENTLY calls x ~94ms = 115s (the #3 statement
-- by total DB time). Move the gate into Postgres so it is GLOBAL:
--   (1) pg_try_advisory_xact_lock — skip if another worker is already refreshing;
--   (2) a one-row leaderboard_refresh_state.last_refreshed_at — skip if a refresh
--       ran in the last 30s.
-- Bounded staleness (<=30s) is acceptable: the leaderboard UI already polls at
-- 15s and the matview was only ever best-effort-fresh. The JS callers keep their
-- fire-and-forget shape and their cheap shouldRefreshLeaderboard() pre-gate.
--
-- Plus: CREATE INDEX for the FK columns the advisor flagged (queried by the
-- primary-club resolver, identity-migration repoints, and RI delete probes).
-- Tiny tables -> negligible write cost, real read/RI win. All IF NOT EXISTS.
-- ============================================================================

-- ── Global refresh state (single row, deny-all RLS; written only by the
--    SECURITY DEFINER refresh function which bypasses RLS) ───────────────────
CREATE TABLE IF NOT EXISTS public.leaderboard_refresh_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_refreshed_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);
INSERT INTO public.leaderboard_refresh_state (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.leaderboard_refresh_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refresh_alltime_leaderboard()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Skip if another worker is mid-refresh (xact lock auto-releases on return).
  IF NOT pg_try_advisory_xact_lock(hashtext('leaderboard_refresh')::bigint) THEN
    RETURN;
  END IF;
  -- Skip if a refresh already ran within the debounce window.
  IF EXISTS (
    SELECT 1 FROM public.leaderboard_refresh_state
    WHERE last_refreshed_at > now() - interval '30 seconds'
  ) THEN
    RETURN;
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_alltime_leaderboard_mat;
  UPDATE public.leaderboard_refresh_state SET last_refreshed_at = now() WHERE id;
END;
$function$;

-- ── FK / hot-path index pack (advisor unindexed_foreign_keys + resolver) ─────
CREATE INDEX IF NOT EXISTS idx_queue_entries_player_joined
  ON public.queue_entries (player_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_pulled_from
  ON public.matches (pulled_from_match_id) WHERE pulled_from_match_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_created_by
  ON public.sessions (created_by);
CREATE INDEX IF NOT EXISTS idx_clubs_created_by
  ON public.clubs (created_by);
CREATE INDEX IF NOT EXISTS idx_club_invites_created_by
  ON public.club_invites (created_by);
CREATE INDEX IF NOT EXISTS idx_club_invites_consumed_by
  ON public.club_invites (consumed_by) WHERE consumed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_club_members_invited_by
  ON public.club_members (invited_by) WHERE invited_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_club_milestones_player
  ON public.club_milestones (player_id);
-- (match_events.session_id intentionally left unindexed: reads are by
--  match_id_snapshot, and its session_id FK is only touched on rare session
--  deletes. The stale idx on session_id_snapshot is dropped in the next migration.)
