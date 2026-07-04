-- ============================================================
-- C6: club owner/admin = implicit organizer on every session
-- in their own club (no session_organizers row required)
-- ============================================================
-- club_members' table comment already documented this intent
-- ("role owner/admin = implicit organizer on every session in
-- the club" — 20260630000000_clubs_foundation.sql) but the
-- behaviour was never wired into is_session_organizer(). Every
-- RLS policy that gates writes on organizer status (sessions_update,
-- matches, queue_entries, courts, ...) calls is_session_organizer(),
-- so adding the check there fixes all of them in one place — no
-- policy-by-policy changes needed.
--
-- Path C is additive: existing Path A (session creator) and Path B
-- (session_organizers row) are unchanged. A club owner/admin gets
-- organizer rights on every session in their own club; they still
-- need an explicit session_organizers row (or to be the creator) to
-- organize a session in ANY OTHER club, same as before.
-- ============================================================

CREATE OR REPLACE FUNCTION is_session_organizer(p_session_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    -- Path A: caller is the session creator
    SELECT 1
    FROM   sessions
    WHERE  id         = p_session_id
      AND  created_by = auth.uid()
  )
  OR EXISTS (
    -- Path B: caller was elevated as a co-organizer
    SELECT 1
    FROM   session_organizers
    WHERE  session_id = p_session_id
      AND  user_id    = auth.uid()
  )
  OR EXISTS (
    -- Path C: caller is an active owner/admin of the session's own club
    SELECT 1
    FROM   sessions s
    JOIN   club_members cm ON cm.club_id = s.club_id
    WHERE  s.id          = p_session_id
      AND  cm.player_id  = auth.uid()
      AND  cm.is_active  = true
      AND  cm.role       IN ('owner', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION is_session_organizer(UUID)
  TO authenticated, service_role;
