-- ============================================================
-- Hotfix: 3 issues found in 20260511210000_atomic_server_actions.sql
--
-- 1. Security: revoke authenticated grant from checkout_player_cleanup_drafts
--    and join_queue (caller could spoof p_player_id via REST).
-- 2. Bug: publish_match didn't verify match belongs to p_session_id.
-- 3. Bug: checkout_player_cleanup_drafts used status != 'left' instead of
--    status = 'drafted'.
-- ============================================================

-- ── Issue 1a: revoke authenticated grant ─────────────────────
REVOKE EXECUTE ON FUNCTION checkout_player_cleanup_drafts(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION join_queue(uuid, uuid) FROM authenticated;

-- ── Issue 2 + 3: recreate functions with fixes ───────────────

CREATE OR REPLACE FUNCTION checkout_player_cleanup_drafts(
  p_session_id uuid,
  p_player_id uuid
)
RETURNS TABLE(cancelled_match_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_id uuid;
  v_player_ids uuid[];
BEGIN
  FOR v_match_id IN
    SELECT m.id
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id
      AND m.status = 'pending'
      AND m.is_published = false
      AND mp.player_id = p_player_id
    FOR UPDATE OF m
  LOOP
    SELECT ARRAY_AGG(player_id) INTO v_player_ids
    FROM match_players
    WHERE match_id = v_match_id AND player_id != p_player_id;

    DELETE FROM match_players
    WHERE match_id = v_match_id AND player_id = p_player_id;

    IF (SELECT COUNT(*) FROM match_players WHERE match_id = v_match_id) < 4 THEN
      UPDATE matches
      SET status = 'cancelled', completed_at = now()
      WHERE id = v_match_id;

      IF v_player_ids IS NOT NULL THEN
        UPDATE queue_entries
        SET status = 'waiting'
        WHERE session_id = p_session_id
          AND player_id = ANY(v_player_ids)
          AND status = 'drafted';  -- Issue 3 fix: was != 'left'
      END IF;

      cancelled_match_id := v_match_id;
      RETURN NEXT;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION checkout_player_cleanup_drafts(uuid, uuid) TO service_role;


CREATE OR REPLACE FUNCTION publish_match(
  p_match_id uuid,
  p_session_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_status text;
  v_is_published bool;
  v_left_count int;
  v_conflict_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN 'NOT_ORGANIZER';
  END IF;

  -- Issue 2 fix: added AND session_id = p_session_id
  SELECT status, is_published INTO v_status, v_is_published
  FROM matches
  WHERE id = p_match_id
    AND session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;

  IF v_status != 'pending' THEN
    RETURN 'NOT_PENDING';
  END IF;

  IF v_is_published THEN
    RETURN 'ALREADY_PUBLISHED';
  END IF;

  SELECT COUNT(*) INTO v_left_count
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
  WHERE mp.match_id = p_match_id
    AND qe.status = 'left';

  IF v_left_count > 0 THEN
    RETURN 'HAS_LEFT_PLAYERS';
  END IF;

  SELECT COUNT(*) INTO v_conflict_count
  FROM match_players mp
  JOIN matches m ON m.id = mp.match_id
  WHERE mp.player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND m.session_id = p_session_id
    AND m.id != p_match_id
    AND m.status IN ('pending', 'in_progress');

  IF v_conflict_count > 0 THEN
    RETURN 'CONFLICT';
  END IF;

  UPDATE matches
  SET is_published = true
  WHERE id = p_match_id;

  UPDATE queue_entries
  SET status = 'on_deck'
  WHERE session_id = p_session_id
    AND player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND status = 'drafted';

  RETURN 'SUCCESS';
END;
$$;

GRANT EXECUTE ON FUNCTION publish_match(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION publish_match(uuid, uuid, uuid) TO service_role;


-- join_queue signature unchanged; only the grant was revoked above
-- publish_all_drafts unchanged
