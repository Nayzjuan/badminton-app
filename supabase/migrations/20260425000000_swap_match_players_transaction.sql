-- ============================================================
-- Migration: swap_match_players RPC
-- ============================================================
-- Swaps two players between (or within) on-deck matches atomically.
--
-- Handles two cases inside one function:
--   A. Same match (p_a_match_id = p_b_match_id):
--      Only team assignments change — match_id stays the same.
--   B. Cross match (p_a_match_id != p_b_match_id):
--      Player A moves to match B (on B's team).
--      Player B moves to match A (on A's team).
--
-- In both cases queue_entries.status is UNCHANGED —
-- both players remain "on_deck" since they are still in some match.
-- is_mixed_level is recomputed for all affected matches post-swap.
--
-- Concurrent safety:
--   FOR UPDATE row-locks on matches + match_players rows serialize
--   concurrent organizer swaps involving the same players.
--
-- Called from: src/app/actions/swap-player.ts swapMatchPlayers()
-- ============================================================

CREATE OR REPLACE FUNCTION swap_match_players(
  p_a_match_id  UUID,
  p_a_player_id UUID,
  p_b_match_id  UUID,
  p_b_player_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_a_match_status TEXT;
  v_b_match_status TEXT;
  v_a_team         TEXT;
  v_b_team         TEXT;
  v_a_distinct     INT;
  v_b_distinct     INT;
BEGIN
  -- Basic sanity: cannot swap a player with themselves
  IF p_a_player_id = p_b_player_id THEN
    RAISE EXCEPTION 'Cannot swap a player with themselves';
  END IF;

  -- Lock match A (serializes concurrent mutations on this match)
  SELECT status INTO v_a_match_status
  FROM matches
  WHERE id = p_a_match_id
  FOR UPDATE;

  -- Lock match B only when it is a different match
  IF p_a_match_id != p_b_match_id THEN
    SELECT status INTO v_b_match_status
    FROM matches
    WHERE id = p_b_match_id
    FOR UPDATE;
  ELSE
    v_b_match_status := v_a_match_status;
  END IF;

  -- Guard: both matches must still be pending (on-deck).
  -- Defense-in-depth: server action already checks this, but the
  -- database enforces it within the transaction lock.
  IF v_a_match_status IS NULL OR v_a_match_status != 'pending' OR
     v_b_match_status IS NULL OR v_b_match_status != 'pending' THEN
    RAISE EXCEPTION 'MATCH_STARTED';
  END IF;

  -- Capture team assignments with row-level locks
  SELECT team INTO v_a_team
  FROM match_players
  WHERE match_id = p_a_match_id AND player_id = p_a_player_id
  FOR UPDATE;

  SELECT team INTO v_b_team
  FROM match_players
  WHERE match_id = p_b_match_id AND player_id = p_b_player_id
  FOR UPDATE;

  -- Guard: both players must still be in their respective matches
  IF v_a_team IS NULL OR v_b_team IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
  END IF;

  -- ── Atomic swap ───────────────────────────────────────────────
  -- DELETE both rows first to avoid any unique-constraint conflicts
  -- on (match_id, player_id), then INSERT with swapped assignments.
  DELETE FROM match_players
  WHERE (match_id = p_a_match_id AND player_id = p_a_player_id)
     OR (match_id = p_b_match_id AND player_id = p_b_player_id);

  -- Player A goes where B was; Player B goes where A was
  INSERT INTO match_players (match_id, player_id, team)
  VALUES
    (p_b_match_id, p_a_player_id, v_b_team),
    (p_a_match_id, p_b_player_id, v_a_team);

  -- ── Recompute is_mixed_level ─────────────────────────────────
  -- Match A
  SELECT COUNT(DISTINCT p.skill_level) INTO v_a_distinct
  FROM  match_players mp
  JOIN  profiles p ON p.id = mp.player_id
  WHERE mp.match_id = p_a_match_id;

  UPDATE matches
  SET    is_mixed_level = (v_a_distinct > 1)
  WHERE  id = p_a_match_id;

  -- Match B (skip if same as match A — already updated above)
  IF p_a_match_id != p_b_match_id THEN
    SELECT COUNT(DISTINCT p.skill_level) INTO v_b_distinct
    FROM  match_players mp
    JOIN  profiles p ON p.id = mp.player_id
    WHERE mp.match_id = p_b_match_id;

    UPDATE matches
    SET    is_mixed_level = (v_b_distinct > 1)
    WHERE  id = p_b_match_id;
  END IF;
END;
$$;

-- Grant execute to service_role (used by the server action's admin client)
GRANT EXECUTE ON FUNCTION swap_match_players(UUID, UUID, UUID, UUID)
  TO service_role;
