-- ============================================================
-- Pin search_path on 20 functions (Task #56, part 1)
-- ============================================================
-- Supabase advisor flags these 20 functions with
-- function_search_path_mutable: they have no SET search_path,
-- so a caller able to manipulate their session's search_path
-- (e.g. via a schema named to shadow a table/function these
-- functions reference unqualified) could redirect what
-- "profiles", "sessions", etc. resolve to inside the function
-- body. Every SECURITY DEFINER function in this class is a
-- real risk; a few of these are SECURITY INVOKER (lower
-- severity, still worth closing since the fix is free).
--
-- Fix: ALTER FUNCTION ... SET search_path = public, pg_temp
-- for each. This does NOT touch function bodies at all (no
-- CREATE OR REPLACE, no risk of logic drift) — it only pins
-- the search_path configuration parameter for the duration of
-- each function's execution, exactly like the pattern already
-- used in get_session_leaderboard_public
-- (20260702000003_harden_security_definer_views.sql).
-- ============================================================

ALTER FUNCTION public._fix_record_partnership_delta(uuid, uuid, integer, boolean, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.clear_all_unpublished_drafts(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.compute_session_wrapped(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.elevate_to_organizer(uuid, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_alltime_snapshot_before(timestamp with time zone, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_h2h_record(uuid[], uuid[], uuid, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_player_streaks(uuid, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_session() SET search_path = public, pg_temp;
ALTER FUNCTION public.is_club_member(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_match_club_member(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_session_club_member(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_session_organizer(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.migrate_player_identity(uuid, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_alltime_leaderboard() SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_cross_session_stats(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.rejoin_queue(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.skill_level_to_int(skill_level) SET search_path = public, pg_temp;
ALTER FUNCTION public.toggle_auto_matchmaking(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_push_subscription_updated_at() SET search_path = public, pg_temp;
