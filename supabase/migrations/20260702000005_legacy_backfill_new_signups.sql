-- ============================================================
-- 2026-07-02 EMERGENCY STOPGAP — persisted for tracking (already applied to
-- prod via SQL during a live session). Idempotent & safe to re-run.
-- ------------------------------------------------------------
-- Context: production serves the pre-multi-tenant `main` branch, whose signup
-- path has NO club-enrollment step. New accounts therefore had no Legacy-club
-- `club_members` row, and the club-scoped `sessions_select` RLS
-- (is_session_organizer(id) OR is_club_member(club_id)) hid every session from
-- them ("logged in but cannot see the session").
--
-- This backfills a Legacy-club membership for every profile missing one.
-- Companion: 20260702000006 (auto-enroll trigger) prevents recurrence.
--
-- Disposition on multi-tenant deploy: KEEP. Harmless — genuine onboarding is
-- handled by ensureClubMembership() going forward. See memory
-- prod-db-code-drift-stopgaps.
-- ============================================================

INSERT INTO public.club_members (club_id, player_id, role, is_active)
SELECT '00000000-0000-0000-0000-000000000001', p.id, 'member', true
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.club_members cm
  WHERE cm.player_id = p.id
    AND cm.club_id = '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT DO NOTHING;
