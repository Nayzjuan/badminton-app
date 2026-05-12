-- ============================================================
-- Migration: Update swap_player_in_match to set 'drafted' for
--            incoming players swapped into an unpublished draft
-- ============================================================
-- Root cause (introduced by 20260511000000_add_drafted_queue_status):
--
--   The 20260511 migration changed create_match_with_players to set
--   queue_entries.status = 'drafted' for players in unpublished drafts,
--   and updated publishMatchAction to promote 'drafted' → 'on_deck'.
--
--   swap_player_in_match was written before 'drafted' existed. Its
--   Step c still leaves the incoming player as 'waiting' for unpublished
--   drafts (the old "defer until publish" contract). After 20260511,
--   publishMatchAction's .eq("status","drafted") filter no longer
--   catches these 'waiting' swapped-in players, so they are silently
--   skipped and never promoted to 'on_deck'.
--
-- Fix:
--   Step c now sets status = 'drafted' (not 'waiting') for incoming
--   players swapped into an unpublished draft. This is consistent with
--   how create_match_with_players treats originally-drafted players.
--   publishMatchAction's .eq("status","drafted") then correctly
--   catches all four roster members — original + swapped-in alike.
--
-- Step d (outgoing player → 'waiting') is unchanged: the player who
-- leaves the draft is correctly freed back to the waiting pool.
-- ============================================================

CREATE OR REPLACE FUNCTION swap_player_in_match(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID,
  p_team          TEXT,
  p_is_published  BOOLEAN DEFAULT true
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

  -- Step c: Update incoming player's queue status.
  --   Published match     → 'on_deck'  (alert fires immediately)
  --   Unpublished draft   → 'drafted'  (consistent with create_match_with_players;
  --                          publishMatchAction promotes 'drafted' → 'on_deck')
  IF p_is_published THEN
    UPDATE queue_entries
    SET status = 'on_deck'
    WHERE session_id = p_session_id
      AND player_id  = p_in_player_id;
  ELSE
    UPDATE queue_entries
    SET status = 'drafted'
    WHERE session_id = p_session_id
      AND player_id  = p_in_player_id;
  END IF;

  -- Step d: Return outgoing player to the waiting queue (unchanged)
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

GRANT EXECUTE ON FUNCTION swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN)
  TO service_role;
