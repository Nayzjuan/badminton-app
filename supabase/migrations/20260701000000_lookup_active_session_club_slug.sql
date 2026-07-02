-- ============================================================
-- Multi-Tenant Phase 2 — lookup_active_session returns club_slug
-- ============================================================
-- The QR-join flow resolves a session for anonymous visitors via this
-- SECURITY DEFINER RPC (so anon never needs SELECT on sessions, which would
-- expose organizer_passcode / created_by). To route a scanner straight to
-- /c/<slug>/join (or to power the /play/join back-compat redirect shim), the
-- RPC must ALSO return the session's club slug.
--
-- Return-type change requires DROP + CREATE (CREATE OR REPLACE cannot change
-- the RETURNS TABLE shape). DROP also drops the grants, so they are restored.
-- LEFT JOIN keeps the row even if club_id has no matching clubs row — club_slug
-- is then NULL (handle defensively client-side); with Phase 0 applied
-- (sessions.club_id NOT NULL + Legacy club seeded) it is non-null in practice.
--
-- Idempotent (DROP IF EXISTS + CREATE).
--
-- (Applied to prod at some point after this file was first written as
-- "build only" — the original header/commit message were never updated to
-- match. Ground-truth confirmed live via pg_get_functiondef on 2026-07-02:
-- the RETURNS TABLE shape and club_slug join below match prod exactly.)
-- ============================================================

DROP FUNCTION IF EXISTS public.lookup_active_session(uuid);

CREATE FUNCTION public.lookup_active_session(p_session_id uuid)
 RETURNS TABLE(id uuid, name text, is_active boolean, club_slug text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.id, s.name, s.is_active, c.slug
  FROM public.sessions s
  LEFT JOIN public.clubs c ON c.id = s.club_id
  WHERE s.id = p_session_id
    AND s.is_active = true;
$function$;

COMMENT ON FUNCTION public.lookup_active_session(uuid) IS
  'Anon-safe active-session resolver for QR join. Returns (id,name,is_active,club_slug). SECURITY DEFINER so anon never reads sessions directly.';

-- Restore grants (DROP cleared them; new functions also default-grant PUBLIC).
REVOKE ALL ON FUNCTION public.lookup_active_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_active_session(uuid) TO anon, authenticated, service_role;
