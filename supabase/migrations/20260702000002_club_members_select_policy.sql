-- ============================================================
-- club_members: additive SELECT policy (defense-in-depth)
-- ============================================================
-- club_members has had RLS enabled with zero policies since
-- 20260630000000_clubs_foundation.sql ("deny-all, service-role
-- bypasses" — intentional at the time). All current app code paths
-- use createServiceClient() for club_members, so this is not closing
-- an active leak; it's removing a foot-gun where any future
-- RLS-scoped query against this table would silently return zero
-- rows instead of erroring.
--
-- Purely additive: grants read access an RLS-scoped caller doesn't
-- have today. Does not touch INSERT/UPDATE/DELETE — all writes
-- continue to go through service-role RPCs
-- (club_member_atomic_owner_guard et al.), unchanged.
-- ============================================================

CREATE POLICY club_members_select ON public.club_members
  FOR SELECT
  USING (
    player_id = auth.uid()
    OR is_club_member(club_id)
  );
