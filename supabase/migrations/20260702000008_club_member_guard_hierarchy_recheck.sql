-- ============================================================
-- Migration: club member guard — re-check actor↔target hierarchy under the lock
-- ============================================================
-- Closes a TOCTOU in removeMember / changeMemberRole: the app layer validates
-- canManageTarget(actorRole, target.role) on a non-atomic read, then calls the
-- owner-guard RPC, which only re-verified OWNER-COUNT under the advisory lock —
-- never the hierarchy. A concurrent promotion of the target between the read
-- and the RPC let e.g. an admin remove a just-promoted admin.
--
-- Adds an OPTIONAL p_expected_role: the app passes the role it validated
-- against; under the SAME advisory xact lock the RPC compares the target's
-- CURRENT role and aborts with reason 'role_changed' if it differs. NULL (the
-- default — e.g. self-leave via leaveClub, which does no hierarchy check) skips
-- it, so the existing 2-arg / 3-arg calls keep working.
--
-- NOTE: coupled with the app change in src/app/actions/clubs.ts + the RPC types
-- in src/types/database.ts — apply this migration together with that code (the
-- branch's standard deploy: migrations first). Not applied to prod yet.
-- ============================================================

DROP FUNCTION IF EXISTS public.club_member_deactivate(uuid, uuid);
CREATE FUNCTION public.club_member_deactivate(
  p_club_id       uuid,
  p_member_id     uuid,
  p_expected_role text DEFAULT NULL
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

  -- Re-check the app-layer hierarchy decision under the lock: if the target's
  -- role changed since the caller validated canManageTarget, abort.
  IF p_expected_role IS NOT NULL AND v_role <> p_expected_role THEN
    RETURN jsonb_build_object('success', false, 'reason', 'role_changed');
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

REVOKE ALL ON FUNCTION public.club_member_deactivate(uuid, uuid, text) FROM PUBLIC;
-- Default privileges grant EXECUTE to anon/authenticated on CREATE, and REVOKE
-- FROM PUBLIC alone does not remove those role grants (see ...000001). Revoke
-- explicitly so only service_role (app-layer-authorized) can call it.
REVOKE EXECUTE ON FUNCTION public.club_member_deactivate(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_member_deactivate(uuid, uuid, text) TO service_role;


DROP FUNCTION IF EXISTS public.club_member_set_role(uuid, uuid, text);
CREATE FUNCTION public.club_member_set_role(
  p_club_id       uuid,
  p_member_id     uuid,
  p_new_role      text,
  p_expected_role text DEFAULT NULL
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

  IF p_expected_role IS NOT NULL AND v_role <> p_expected_role THEN
    RETURN jsonb_build_object('success', false, 'reason', 'role_changed');
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

REVOKE ALL ON FUNCTION public.club_member_set_role(uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.club_member_set_role(uuid, uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_member_set_role(uuid, uuid, text, text) TO service_role;
