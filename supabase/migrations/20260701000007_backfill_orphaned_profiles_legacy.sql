-- ============================================================
-- Backfill orphaned profiles into the Legacy club
-- ============================================================
-- The Phase 0 club_members backfill (20260630000001_sessions_club_id.sql)
-- only enrolled profiles that had session/queue activity at migration time.
-- A follow-up integrity check found 3 real profiles with zero club_members
-- rows at all (id/display_name: 340cd4b4... "Tony", b20a2713... "JV Laguer",
-- bec04372... "Luigi") — each with zero queue_entries and zero match_players,
-- so they're safe to enroll as ordinary Legacy members with no history to
-- reconcile.
--
-- This closes a real hazard for the upcoming club-scoped RLS work: any
-- policy keyed on club_members.is_active would otherwise silently lock
-- these 3 players out of everything, including their own data.
--
-- Applied to prod directly via the Supabase MCP on 2026-07-01; this file
-- persists that change to the repo's migration history (idempotent — safe
-- to re-run).
-- ============================================================

INSERT INTO public.club_members (club_id, player_id, role, is_active)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, p.id, 'member', true
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.club_members cm WHERE cm.player_id = p.id AND cm.is_active = true
)
ON CONFLICT (club_id, player_id) DO UPDATE SET is_active = true;
