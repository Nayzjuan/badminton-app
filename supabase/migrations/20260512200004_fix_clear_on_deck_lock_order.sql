-- ============================================================
-- Hotfix: Fix lock ordering in clear_on_deck_match_atomic (F2)
-- ============================================================
-- Problem (found by code review):
--   clear_on_deck_match_atomic acquired locks in this order:
--     1. matches   FOR UPDATE  (validation)
--     2. queue_entries UPDATE  (implicit lock during write)
--
--   remove_player_from_queue_organizer acquires locks in this order:
--     1. queue_entries FOR UPDATE  (the player being removed)
--     2. matches   FOR UPDATE OF m (lock each pending match)
--
--   This is a lock-ordering INVERSION. If both RPCs run concurrently
--   on the same (player, match) pair:
--     TX-A holds matches lock, waits for queue_entries lock
--     TX-B holds queue_entries lock, waits for matches lock
--   → Postgres detects and rolls back one — but the JS layer has no
--     retry, so the caller sees a silent error response.
--
-- Global lock order convention (all RPCs in this codebase):
--   queue_entries BEFORE matches
--   (consistent with swap_player_in_match Guards A → C)
--
-- Fix:
--   Restructure clear_on_deck_match_atomic in 6 steps:
--     1. Non-locking read of player IDs from match_players
--     2. Lock queue_entries rows (ORDER BY player_id — consistent
--        ordering prevents intra-deadlock for overlapping player sets)
--     3. Lock + validate the match row (now safe — any concurrent TX
--        that holds the match lock is waiting for queue_entries,
--        not the other way around)
--     4. Re-fetch player IDs under lock (list may have changed between
--        step 1 and now if a concurrent remove completed)
--     5. UPDATE queue_entries (we already hold locks from step 2)
--     6. DELETE match (cascade removes match_players)
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
  v_match_status    TEXT;
  v_player_ids_lock UUID[];  -- IDs captured non-locking (for lock acquisition)
  v_player_ids      UUID[];  -- IDs re-read under lock (authoritative for writes)
BEGIN
  -- ── Step 1: Non-locking read of player IDs ─────────────────────────────────
  -- We need player IDs to know which queue_entries rows to lock BEFORE we lock
  -- the match row. ORDER BY enforces a canonical order for step 2.
  SELECT ARRAY_AGG(player_id ORDER BY player_id) INTO v_player_ids_lock
  FROM   match_players
  WHERE  match_id = p_match_id;

  -- ── Step 2: Lock queue_entries rows in player_id order ─────────────────────
  -- ORDER BY player_id prevents intra-deadlock between two concurrent clear calls
  -- that target overlapping player sets (e.g. F1 legacy data with a player in
  -- two matches simultaneously). Each TX will wait for the same lock in the same
  -- order, so neither can form a cycle.
  IF v_player_ids_lock IS NOT NULL AND array_length(v_player_ids_lock, 1) > 0 THEN
    PERFORM player_id
    FROM    queue_entries
    WHERE   session_id = p_session_id
      AND   player_id  = ANY(v_player_ids_lock)
    ORDER BY player_id
    FOR UPDATE;
  END IF;

  -- ── Step 3: Lock + validate the match row ───────────────────────────────────
  -- By this point we hold all relevant queue_entries locks.
  -- Any concurrent TX that holds the matches lock must be waiting for
  -- one of those queue_entries locks — so acquiring the matches lock here
  -- cannot create a cycle (we hold what they want; they don't hold what we want).
  SELECT status INTO v_match_status
  FROM   matches
  WHERE  id         = p_match_id
    AND  session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Another concurrent clear already deleted this match.
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;

  IF v_match_status != 'pending' THEN
    RAISE EXCEPTION 'MATCH_NOT_PENDING';
  END IF;

  -- ── Step 4: Re-fetch player IDs under lock ──────────────────────────────────
  -- A concurrent remove_player_from_queue_organizer may have removed a player
  -- from match_players between step 1 and now. Use the fresh list for writes.
  SELECT ARRAY_AGG(player_id) INTO v_player_ids
  FROM   match_players
  WHERE  match_id = p_match_id;

  -- ── Step 5: Restore players to 'waiting' ─────────────────────────────────────
  -- We already hold the queue_entries locks from step 2, so this UPDATE is
  -- immediately consistent — no second lock acquisition needed.
  --   • joined_at and games_played unchanged — queue position preserved.
  --   • status != 'left' guard: checked-out players are not pulled back.
  IF v_player_ids IS NOT NULL AND array_length(v_player_ids, 1) > 0 THEN
    UPDATE queue_entries
    SET    status = 'waiting'
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_player_ids)
      AND  status    != 'left';
  END IF;

  -- ── Step 6: Delete the match ─────────────────────────────────────────────────
  -- ON DELETE CASCADE removes all match_players rows in the same transaction.
  DELETE FROM matches WHERE id = p_match_id;

  -- Return the authoritative player list (from step 4) for broadcast.
  RETURN COALESCE(v_player_ids, '{}');
END;
$$;

GRANT EXECUTE ON FUNCTION clear_on_deck_match_atomic(UUID, UUID) TO service_role;
