-- ============================================================
-- Migration: Fix removeFromQueue — organizer kick with cleanup (F4, P2)
-- ============================================================
-- Problem:
--   The removeFromQueue hook callback did a direct Supabase client
--   UPDATE (status='left') on queue_entries with no:
--     • Auth check (relied on hook context alone)
--     • match_players cleanup
--
--   If a player was 'on_deck' in a published pending match, they
--   would become 'left' in queue_entries but remain in match_players.
--   The queue panel shows 'left'; the on-deck panel shows them in
--   the match — contradictory state until the match was cleared.
--
-- Fix:
--   New RPC remove_player_from_queue_organizer atomically:
--     1. Locks the queue_entries row (serializes concurrent calls).
--     2. Finds all pending matches (published or draft) the player
--        is in via match_players.
--     3. Removes the player from each match's roster.
--     4. If any match falls below 4 players after removal, cancels
--        it and returns its other players to 'waiting'/'drafted' as
--        appropriate — same logic as checkout_player_cleanup_drafts
--        but extended to cover PUBLISHED pending matches too.
--     5. Sets queue status = 'left'.
--     6. Returns the array of affected match IDs so the caller
--        can broadcast on_deck_cleared to affected players.
--
--   A new server action (removePlayerFromQueue in queue.ts) wraps
--   this RPC with auth + organizer checks, and the hook's
--   removeFromQueue callback is updated to call that action.
-- ============================================================

CREATE OR REPLACE FUNCTION remove_player_from_queue_organizer(
  p_session_id UUID,
  p_player_id  UUID
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_current_status   TEXT;
  v_affected_matches UUID[] := '{}';
  v_match_id         UUID;
  v_is_published     BOOLEAN;
  v_other_player_ids UUID[];
  v_remaining_count  INT;
BEGIN
  -- Lock the queue_entries row so concurrent status changes are serialized.
  -- (E.g. player self-checking out at the same moment the organizer kicks them.)
  SELECT status INTO v_current_status
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = p_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_NOT_IN_SESSION';
  END IF;

  -- Iterate over all pending matches this player is currently assigned to.
  -- Normally at most one, but we handle multiple as a safety net for any
  -- legacy data that might exist from the pre-F1-fix era.
  FOR v_match_id, v_is_published IN
    SELECT m.id, m.is_published
    FROM   match_players mp
    JOIN   matches m ON m.id = mp.match_id
    WHERE  mp.player_id  = p_player_id
      AND  m.session_id  = p_session_id
      AND  m.status      = 'pending'
    FOR UPDATE OF m   -- lock the match row(s) to prevent concurrent transitions
  LOOP
    -- Capture remaining players before removing the leaving player.
    SELECT ARRAY_AGG(player_id) INTO v_other_player_ids
    FROM   match_players
    WHERE  match_id  = v_match_id
      AND  player_id != p_player_id;

    -- Remove the player from the match roster.
    DELETE FROM match_players
    WHERE  match_id  = v_match_id
      AND  player_id = p_player_id;

    -- Count remaining players after the removal.
    SELECT COUNT(*) INTO v_remaining_count
    FROM   match_players
    WHERE  match_id = v_match_id;

    -- If the match is now under-strength, cancel it and restore others.
    IF v_remaining_count < 4 THEN
      UPDATE matches
      SET    status       = 'cancelled',
             completed_at = NOW()
      WHERE  id = v_match_id;

      -- Restore remaining players. Status depends on whether the match
      -- was published:
      --   Published  → other players were 'on_deck'   → back to 'waiting'
      --   Unpublished→ other players were 'drafted'   → back to 'waiting'
      -- IN ('drafted','on_deck') covers both cases without accidentally
      -- touching 'left' players or players who were already 'waiting'
      -- before the cleanup.
      IF v_other_player_ids IS NOT NULL THEN
        UPDATE queue_entries
        SET    status = 'waiting'
        WHERE  session_id = p_session_id
          AND  player_id  = ANY(v_other_player_ids)
          AND  status     IN ('drafted', 'on_deck');
      END IF;
    END IF;

    v_affected_matches := array_append(v_affected_matches, v_match_id);
  END LOOP;

  -- Finally, mark the player as 'left' in the queue.
  -- (Done after match cleanup so their status is consistent throughout.)
  UPDATE queue_entries
  SET    status = 'left'
  WHERE  session_id = p_session_id
    AND  player_id  = p_player_id;

  RETURN v_affected_matches;
END;
$$;

GRANT EXECUTE ON FUNCTION remove_player_from_queue_organizer(UUID, UUID) TO service_role;
