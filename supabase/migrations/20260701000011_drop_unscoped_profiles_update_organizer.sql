-- ============================================================
-- Drop profiles_update_organizer: unscoped cross-club/cross-session
-- privilege escalation via PostgREST
-- ============================================================
-- is_any_session_organizer() checks only "organizer of ANY active session
-- anywhere" with no with_check clause, so any organizer of any session in
-- any club could UPDATE any other user's profile (including overwriting
-- their pin) directly via PostgREST, bypassing app-level authorization.
--
-- All legitimate organizer-assisted profile writes (updatePlayerSkill,
-- getPlayerPin, resetPlayerPin, updatePlayerPin in
-- src/app/actions/profile.ts) already use createServiceClient() (bypasses
-- RLS entirely) gated by isSessionOrganizer(user.id, sessionId) — a proper
-- per-session check performed in application code. Nothing depends on this
-- RLS policy; is_any_session_organizer() has no other callers.

drop policy if exists profiles_update_organizer on public.profiles;
drop function if exists public.is_any_session_organizer();
