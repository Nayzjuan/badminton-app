-- ============================================================
-- Migration: Atomic owner-guard for club member deactivate/role-change
-- ============================================================
-- Problem: leaveClub / removeMember / changeMemberRole each did a
-- countActiveOwners() SELECT, then a separate UPDATE, from the app layer —
-- a classic check-then-act race. Two concurrent last-owner actions (e.g.
-- two admins simultaneously acting on two different owners of a 2-owner
-- club) could both read count=2, both pass the guard, and both commit,
-- leaving the club with zero active owners.
--
-- Fix: two SECURITY DEFINER functions that take a per-club advisory xact
-- lock before checking + mutating. The advisory lock is keyed by club_id,
-- so ANY concurrent call touching the same club (regardless of which
-- member row) fully serializes — the second caller blocks until the
-- first's transaction commits, by which point the owner count it reads
-- already reflects the first call's completed mutation. The FOR UPDATE on
-- the target row is defense-in-depth against any other direct UPDATE
-- racing the same row.
--
-- Returns jsonb (matching this schema's existing atomic-RPC convention —
-- see join_queue, publish_match, etc.) rather than RETURNS TABLE, so
-- supabase-js hands back a plain object with no .single() needed.
--
-- These do NOT re-check actor authorization (admin/owner role, self-action
-- blocks, canManageTarget hierarchy) — that stays in
-- src/app/actions/clubs.ts, same division of labor as every other
-- service-role-only RPC in this schema (e.g. migrate_player_identity):
-- app layer decides "is this actor allowed", DB layer guarantees "is this
-- safe to commit". Locked to service_role only (no authenticated/anon
-- grant) since a direct authenticated caller could otherwise bypass the
-- app-layer authorization entirely.
-- ============================================================

CREATE OR REPLACE FUNCTION public.club_member_deactivate(
  p_club_id   uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_owner_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_club_id::text, 0));

  SELECT role INTO v_role
  FROM club_members
  WHERE id = p_member_id AND club_id = p_club_id AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  IF v_role = 'owner' THEN
    SELECT count(*) INTO v_owner_count
    FROM club_members
    WHERE club_id = p_club_id AND role = 'owner' AND is_active = true;

    IF v_owner_count <= 1 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'only_owner');
    END IF;
  END IF;

  UPDATE club_members
  SET is_active = false
  WHERE id = p_member_id AND club_id = p_club_id;

  RETURN jsonb_build_object('success', true, 'reason', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.club_member_deactivate(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.club_member_deactivate(uuid, uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.club_member_set_role(
  p_club_id   uuid,
  p_member_id uuid,
  p_new_role  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role        text;
  v_owner_count int;
BEGIN
  IF p_new_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_role');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_club_id::text, 0));

  SELECT role INTO v_role
  FROM club_members
  WHERE id = p_member_id AND club_id = p_club_id AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  IF v_role = p_new_role THEN
    RETURN jsonb_build_object('success', true, 'reason', 'no_change');
  END IF;

  IF v_role = 'owner' THEN
    SELECT count(*) INTO v_owner_count
    FROM club_members
    WHERE club_id = p_club_id AND role = 'owner' AND is_active = true;

    IF v_owner_count <= 1 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'only_owner');
    END IF;
  END IF;

  UPDATE club_members
  SET role = p_new_role
  WHERE id = p_member_id AND club_id = p_club_id;

  RETURN jsonb_build_object('success', true, 'reason', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.club_member_set_role(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.club_member_set_role(uuid, uuid, text) TO service_role;
