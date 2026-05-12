-- ============================================================
-- Anon session lookup for the QR-code join flow
-- ============================================================
-- Background
-- ----------
-- /play/join?session=<id> renders the registration form so a
-- player who scanned a QR code can sign up directly into the
-- target session.  The page used to call
--   supabase.from("sessions").select("id,name,is_active").eq("id", X).single()
-- against the anon-context Supabase client.  The original RLS
-- only granted SELECT to authenticated organizers / participants,
-- so anon visitors saw zero rows and the page redirected to /play
-- → / (root login form), losing the session id and breaking the
-- entire QR-code flow for new users.
--
-- Why a SECURITY DEFINER function (and not an RLS policy)
-- -------------------------------------------------------
-- A blanket `CREATE POLICY ... TO anon USING (is_active = true)`
-- on `public.sessions` would expose EVERY column of every active
-- session to anon — including `organizer_passcode` (the secret an
-- organizer uses to claim the session) and `created_by`.  An
-- attacker could then `GET /rest/v1/sessions?is_active=eq.true`
-- and exfiltrate every passcode at once.  RLS is row-level; it
-- does not restrict columns, and Supabase's default GRANT to anon
-- on a table is `SELECT *`.
--
-- A SECURITY DEFINER function lets us return ONLY the three
-- columns the join page actually needs (id, name, is_active),
-- under whatever filtering the function chooses, without ever
-- granting anon any direct access to the underlying table.
-- ============================================================

-- Make sure RLS stays on (no-op if already enabled).  The default
-- "deny everything" stance is what we keep for the table itself.
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- Drop any prior version so this migration is rerunnable.
DROP FUNCTION IF EXISTS public.lookup_active_session(uuid);

CREATE FUNCTION public.lookup_active_session(p_session_id uuid)
RETURNS TABLE (
  id        uuid,
  name      text,
  is_active boolean
)
LANGUAGE sql
SECURITY DEFINER
-- Lock down search_path so a malicious schema can't shadow `sessions`.
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT s.id, s.name, s.is_active
  FROM public.sessions s
  WHERE s.id = p_session_id
    AND s.is_active = true;
$$;

-- Anon and authenticated roles may both call the lookup.  This
-- explicitly does NOT grant any access to the sessions table.
REVOKE ALL ON FUNCTION public.lookup_active_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_active_session(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.lookup_active_session(uuid) IS
  'QR-code join flow: anonymous visitors call this to look up an active session by id. Returns (id, name, is_active) only — never organizer_passcode, created_by, or other private columns. The function runs as its definer (postgres) and bypasses RLS on `sessions`, so the table itself remains anon-inaccessible.';
