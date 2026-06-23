-- ============================================================
-- Lock down auto_publish_match to service-role only
-- ============================================================
-- auto_publish_match deliberately has NO organizer/auth gate — it is only ever
-- called by the trusted service-role engine (recomputeHeldReadiness). By Supabase
-- default a public-schema function is EXECUTE-able by anon + authenticated, which
-- would let any signed-in (or anonymous) caller force-publish a held draft to On
-- Deck via PostgREST, bypassing organizer review. The left/conflict guards still
-- prevent publishing a tainted roster, but an un-reviewed publish is undesirable.
--
-- Revoke the blanket grants and grant EXECUTE to service_role explicitly so only
-- the engine (service-role client) can invoke it. (publish_match keeps its public
-- grant because it self-checks the organizer via p_user_id.)
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.auto_publish_match(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_publish_match(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.auto_publish_match(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.auto_publish_match(uuid, uuid) TO service_role;
