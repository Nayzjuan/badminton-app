-- ============================================================
-- Harden SECURITY DEFINER views (Task #55)
-- ============================================================
-- Supabase advisor flags 5 views for the SECURITY DEFINER lint
-- (0010_security_definer_view): they execute with the view
-- owner's privileges, bypassing RLS on their base tables
-- entirely, regardless of who queries them.
--
-- 3 of the 5 (v_recent_pairings, v_queue_with_wait_time,
-- v_queue_full_with_wait_time) have zero legitimate consumers
-- that need the RLS bypass — every current caller is either
-- service-role (always bypasses RLS anyway: matchmaking-db.ts,
-- matchmaking.ts's runEngineInternal) or an RLS-scoped browser
-- client that's already gated to an authenticated session
-- organizer / club member by the calling route before it ever
-- runs (use-organizer-queue.ts, behind the (full) layout's
-- requireClubMembership()). v_recent_pairings has zero call
-- sites at all today. Flipped to security_invoker so RLS on
-- their base tables (queue_entries, matches, match_players)
-- applies normally — closes the "unfiltered direct-PostgREST
-- dump" vector with zero functional risk.
--
-- The other 2 (v_match_history, v_session_leaderboard) CANNOT
-- simply flip to security_invoker: the public leaderboard
-- share-link page (/leaderboard/[sessionId]) depends on their
-- RLS bypass to serve genuinely logged-out visitors (no auth
-- session at all — base-table RLS evaluates to false/NULL for
-- them, since signInAnonymously() is only called on explicit
-- registration, never automatically on page load). But leaving
-- them as bare SECURITY DEFINER views also means anyone can
-- query them directly via PostgREST with NO session_id filter
-- and dump every club's complete match history in one request —
-- the real severity behind the advisor's lint.
--
-- Fix: keep the views' own definitions untouched (their internal
-- SELECT still needs the bypass), but REVOKE direct anon/
-- authenticated SELECT on both, and add
-- get_session_leaderboard_public(p_session_id) — a SECURITY
-- DEFINER RPC requiring a specific session id (cannot be omitted
-- or wildcarded) — mirroring the existing get_h2h_record /
-- compute_session_wrapped pattern already used elsewhere in this
-- schema ("SECURITY DEFINER function with a mandatory scoping
-- param" instead of an open SECURITY DEFINER view). v_match_history
-- itself has no direct RLS-scoped consumer (history.ts/wrapped.ts
-- are both service-role) so it needs no replacement function,
-- only the grant revoke.
-- ============================================================

-- ---- Safe to invoker: no consumer needs the RLS bypass ----

-- v_recent_pairings was created through the Supabase dashboard and is created
-- by no migration, so this bare ALTER raised 42P01 on any database built from
-- migrations alone and aborted the replay (see 20260722000001, which creates
-- the view and applies this same setting). Skipping here is safe precisely
-- because that migration re-applies security_invoker after creating it — the
-- end state is identical either way. Guarded rather than reordered so no
-- migration has to be inserted BEFORE ones already applied to production.
DO $$
BEGIN
  IF to_regclass('public.v_recent_pairings') IS NOT NULL THEN
    ALTER VIEW public.v_recent_pairings SET (security_invoker = true);
  END IF;
END $$;
ALTER VIEW public.v_queue_with_wait_time SET (security_invoker = true);
ALTER VIEW public.v_queue_full_with_wait_time SET (security_invoker = true);

-- ---- Close the direct-dump vector on the 2 public-facing views ----

REVOKE SELECT ON public.v_match_history FROM anon, authenticated;
REVOKE SELECT ON public.v_session_leaderboard FROM anon, authenticated;

-- ---- Controlled replacement for the public leaderboard share link ----
-- Identical aggregation to v_session_leaderboard's own definition,
-- with p_session_id required and pushed into the WHERE clause
-- instead of relying on the caller to supply an .eq() filter.

CREATE OR REPLACE FUNCTION public.get_session_leaderboard_public(p_session_id uuid)
RETURNS TABLE (
  player_id uuid,
  session_id uuid,
  club_id uuid,
  display_name text,
  games_played integer,
  wins integer,
  losses integer,
  points_for integer,
  points_against integer,
  point_diff integer,
  win_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH match_results AS (
    SELECT
      mh.player_id,
      mh.session_id,
      mh.club_id,
      CASE
        WHEN (mh.team = 'a'::bpchar AND mh.team_a_score > mh.team_b_score)
          OR (mh.team = 'b'::bpchar AND mh.team_b_score > mh.team_a_score)
        THEN 1 ELSE 0
      END AS won,
      CASE WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_a_score, 0) ELSE COALESCE(mh.team_b_score, 0) END AS pts_for,
      CASE WHEN mh.team = 'a'::bpchar THEN COALESCE(mh.team_b_score, 0) ELSE COALESCE(mh.team_a_score, 0) END AS pts_against
    FROM v_match_history mh
    WHERE mh.match_status = 'completed'::match_status
      AND mh.session_id = p_session_id
  )
  SELECT
    mr.player_id,
    mr.session_id,
    mr.club_id,
    p.display_name,
    (count(*))::integer AS games_played,
    (sum(mr.won))::integer AS wins,
    ((count(*) - sum(mr.won)))::integer AS losses,
    (sum(mr.pts_for))::integer AS points_for,
    (sum(mr.pts_against))::integer AS points_against,
    ((sum(mr.pts_for) - sum(mr.pts_against)))::integer AS point_diff,
    round(((sum(mr.won))::numeric / (nullif(count(*), 0))::numeric) * 100, 1) AS win_pct
  FROM match_results mr
  JOIN profiles p ON p.id = mr.player_id
  GROUP BY mr.player_id, mr.session_id, mr.club_id, p.display_name;
$$;

REVOKE ALL ON FUNCTION public.get_session_leaderboard_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_session_leaderboard_public(uuid) TO anon, authenticated, service_role;
