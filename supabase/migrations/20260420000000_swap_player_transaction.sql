-- ============================================================
-- Migration: swap_player_in_match RPC
-- ============================================================
-- Wraps all four write steps of the Tap-to-Swap feature in a
-- single Postgres transaction, eliminating the partial-state
-- corruption risk that existed with the previous sequential
-- JS compensation approach.
--
-- Steps (atomic):
--   a. DELETE outPlayerId from match_players
--   b. INSERT inPlayerId  into match_players (same team)
--   c. UPDATE inPlayerId  queue_entries → 'on_deck'
--   d. UPDATE outPlayerId queue_entries → 'waiting'
--   e. Recompute matches.is_mixed_level from current player roster
--
-- If the server crashes at any point, Postgres rolls back the
-- entire transaction automatically — no manual compensation needed.
--
-- Called from: src/app/actions/swap-player.ts via db.rpc(...)
-- Auth note:   All pre-write guards (auth, match status, player
--              availability) are still enforced in the server action
--              before this RPC is invoked.
-- ============================================================

CREATE OR REPLACE FUNCTION swap_player_in_match(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID,
  p_team          TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_distinct_levels INT;
BEGIN
  -- Step a: Remove outgoing player from this match
  DELETE FROM match_players
  WHERE match_id = p_match_id
    AND player_id = p_out_player_id;

  -- Step b: Insert incoming player on the same team
  INSERT INTO match_players (match_id, player_id, team)
  VALUES (p_match_id, p_in_player_id, p_team);

  -- Step c: Mark incoming player as on_deck in the queue
  UPDATE queue_entries
  SET status = 'on_deck'
  WHERE session_id = p_session_id
    AND player_id  = p_in_player_id;

  -- Step d: Return outgoing player to the waiting queue
  UPDATE queue_entries
  SET status = 'waiting'
  WHERE session_id = p_session_id
    AND player_id  = p_out_player_id;

  -- Step e: Recompute is_mixed_level from the current post-swap roster
  SELECT COUNT(DISTINCT p.skill_level) INTO v_distinct_levels
  FROM  match_players mp
  JOIN  profiles p ON p.id = mp.player_id
  WHERE mp.match_id = p_match_id;

  UPDATE matches
  SET is_mixed_level = (v_distinct_levels > 1)
  WHERE id = p_match_id;
END;
$$;

-- Grant execute to service_role (used by the server action's admin client)
GRANT EXECUTE ON FUNCTION swap_player_in_match(UUID, UUID, UUID, UUID, TEXT)
  TO service_role;
