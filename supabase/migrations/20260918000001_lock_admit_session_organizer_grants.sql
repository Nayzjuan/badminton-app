-- ============================================================
-- Lock admit_session_organizer EXECUTE to service_role.
-- ============================================================
-- CREATE FUNCTION under Supabase ALTER DEFAULT PRIVILEGES stamps
-- explicit anon=X and authenticated=X. Revoking PUBLIC leaves those
-- entries. Grant service_role first, then revoke the browser roles.
-- See 20260723000000.
-- ============================================================

grant execute on function public.admit_session_organizer(uuid, uuid) to service_role;
revoke execute on function public.admit_session_organizer(uuid, uuid) from public, anon, authenticated;

DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'admit_session_organizer'
     AND pg_get_function_identity_arguments(p.oid) = 'p_session_id uuid, p_user_id uuid';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'admit_session_organizer(uuid, uuid) not found';
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'admit_session_organizer is still executable by a browser role';
  END IF;

  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'admit_session_organizer lost service_role EXECUTE';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
