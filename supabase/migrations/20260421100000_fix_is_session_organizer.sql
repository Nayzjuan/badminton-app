-- ============================================================
-- Migration: fix is_session_organizer() — include sessions.created_by
-- ============================================================
-- Root cause of Bug #1: The existing is_session_organizer() function
-- only checks the session_organizers table. The primary organizer
-- (sessions.created_by) is explicitly blocked from ever having a row
-- there (joinAsCoOrganizer returns early if user is the creator),
-- so Postgres RLS silently denies every write they attempt.
--
-- Fix: Replace the function body to check EITHER:
--   a. The calling user is the session creator (sessions.created_by), OR
--   b. The calling user is a co-organizer (session_organizers row).
--
-- This fixes ALL RLS policies that call is_session_organizer() — not
-- just the matches UPDATE policy. No table schema changes required.
-- No session_organizers row is inserted for the primary organizer;
-- the function recognizes them natively via the sessions table.
--
-- Side effect: The explicit block in joinAsCoOrganizer (which prevents
-- the primary organizer from adding themselves as a co-organizer) is
-- preserved and still correct — the function no longer needs a row
-- to grant access, so the audit-table integrity is maintained.
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
  );
$$;

-- Re-grant to ensure both roles can call this helper via RLS evaluation.
-- (SECURITY DEFINER already runs as the function owner, but explicit
-- grants prevent accidental permission gaps on schema reload.)
GRANT EXECUTE ON FUNCTION is_session_organizer(UUID)
  TO authenticated, service_role;
