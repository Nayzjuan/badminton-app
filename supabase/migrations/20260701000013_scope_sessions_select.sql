-- ============================================================
-- Club-scope sessions_select — close the last USING(true) leak
-- ============================================================
-- sessions_select was left `USING (true)` for `authenticated` when
-- 20260701000008_club_scoped_rls.sql tightened every other queue/match/
-- court/organizer table — any authenticated (including anonymous-auth)
-- caller could read every session row (name, scoring config, club_id,
-- timestamps, ...) across every club via a direct PostgREST
-- `select * from sessions`, bypassing the app-layer club_id filtering
-- that organizer/page.tsx, play/page.tsx, and leaderboard/page.tsx all
-- already apply on top.
--
-- organizer_passcode itself is already protected independently via
-- column-level REVOKE (20260701000009_column_lockdown_pin_organizer_passcode.sql)
-- for both anon and authenticated — this migration is about the row-level
-- (bulk cross-club enumeration) gap, not that column.
--
-- Fix: mirror the is_session_organizer(id) OR is_club_member(club_id)
-- pattern used everywhere else in 20260701000008. Organizers bypass
-- unconditionally (same as sessions_update); everyone else must be an
-- active member of the session's own club.
--
-- Two call sites are genuine "public share link" reads (a caller who
-- already has the specific sessionId, not browsing) and are switched to
-- the service-role client instead of relying on this policy — see
-- src/app/leaderboard/[sessionId]/page.tsx (mirrors the TV board /
-- Wrapped share page precedent). src/app/leaderboard/page.tsx's
-- browse-all query is club-scoped in app code in the same change so it
-- keeps working under this tightened policy instead of being widened.
-- ============================================================

DROP POLICY IF EXISTS sessions_select ON sessions;
CREATE POLICY sessions_select ON sessions
  FOR SELECT
  TO authenticated
  USING (
    is_session_organizer(id)
    OR is_club_member(club_id)
  );
