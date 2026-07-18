-- ============================================================================
-- Review finding #1 (organizer hub counts): the bulk-count refactor fetched
-- SELECT session_id for EVERY completed match across ALL of a club's sessions
-- and counted them in JS. Accurate today (716 total, ≤56/session) but it would
-- silently UNDERCOUNT once a club's lifetime completed-match total exceeds any
-- configured db-max-rows cap (Supabase's historical default is 1000).
--
-- Replace with a GROUP BY count so the payload is one row PER SESSION (bounded
-- by session count, not match count) in a single round trip — keeps the
-- fan-out win AND is cap-safe at any history size.
--
-- SECURITY INVOKER (SQL default) → respects the caller's RLS exactly like the
-- direct .from("matches").select() it replaces (organizer/member visibility).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.count_completed_matches_by_session(p_session_ids uuid[])
 RETURNS TABLE(session_id uuid, cnt bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m.session_id, count(*)::bigint AS cnt
  FROM matches m
  WHERE m.session_id = ANY (p_session_ids)
    AND m.status = 'completed'::match_status
  GROUP BY m.session_id;
$function$;

GRANT EXECUTE ON FUNCTION public.count_completed_matches_by_session(uuid[]) TO anon, authenticated, service_role;
