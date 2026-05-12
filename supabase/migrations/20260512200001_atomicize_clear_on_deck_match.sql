-- ============================================================
-- Migration: Atomicize clearOnDeckMatch via new RPC (F2, P1)
-- ============================================================
-- Problem:
--   The clearOnDeckMatch server action has a non-atomic sequence:
--     Step 3: UPDATE queue_entries → 'waiting'  (non-left players)
--     Step 4: DELETE matches WHERE id = matchId  (cascade removes match_players)
--
--   Between steps 3 and 4, an affected player has status='waiting'
--   in queue_entries but is still in match_players for the to-be-
--   deleted pending match. The matchmaking engine's Guard 2 in
--   create_match_with_players would block picking them up during
--   this window, but any direct queue reads would show the player
--   as 'waiting' while the match panel still shows them in a match.
--
-- Fix:
--   New RPC clear_on_deck_match_atomic performs the critical steps
--   (player restore + match deletion) inside a single Postgres
--   transaction, eliminating the window entirely.
--
--   Locking: SELECT ... FOR UPDATE on the match row serializes
--   concurrent calls (e.g. two organizers clear the same match
--   simultaneously) — only the first succeeds; the second sees
--   NOT FOUND after the delete and gets MATCH_NOT_FOUND.
--
-- The server action retains the RPC-not-found (PGRST202) fallback
-- so the old JS-layer behaviour still works on environments that
-- haven't received this migration yet.
-- ============================================================

CREATE OR REPLACE FUNCTION clear_on_deck_match_atomic(
  p_match_id   UUID,
  p_session_id UUID
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_status TEXT;
  v_player_ids   UUID[];
BEGIN
  -- Lock the match row to prevent concurrent clears or a concurrent
  -- startMatchAction from racing between our validation and the delete.
  SELECT status INTO v_match_status
  FROM   matches
  WHERE  id         = p_match_id
    AND  session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;

  IF v_match_status != 'pending' THEN
    RAISE EXCEPTION 'MATCH_NOT_PENDING';
  END IF;

  -- Collect player IDs before any deletion.
  -- On-delete cascade will remove match_players when we delete the match,
  -- so we must capture them first.
  SELECT ARRAY_AGG(player_id) INTO v_player_ids
  FROM   match_players
  WHERE  match_id = p_match_id;

  -- Restore players to 'waiting'.
  --   • joined_at and games_played are intentionally left unchanged —
  --     queue position is preserved as if this match never happened.
  --   • status != 'left' guard: players who checked out while on-deck
  --     are not pulled back into the active queue.
  IF v_player_ids IS NOT NULL AND array_length(v_player_ids, 1) > 0 THEN
    UPDATE queue_entries
    SET    status = 'waiting'
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_player_ids)
      AND  status    != 'left';
  END IF;

  -- Delete the match. ON DELETE CASCADE removes all match_players rows
  -- in the same transaction, so no orphan rows are possible.
  DELETE FROM matches WHERE id = p_match_id;

  -- Return the player ID array so the caller can broadcast on_deck_cleared.
  RETURN COALESCE(v_player_ids, '{}');
END;
$$;

GRANT EXECUTE ON FUNCTION clear_on_deck_match_atomic(UUID, UUID) TO service_role;
