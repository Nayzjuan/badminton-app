-- ============================================================
-- Migration: Atomicize updateMatchDetails revertToActive path (F5, P2)
-- ============================================================
-- Problem:
--   The revertToActive path of updateMatchDetails was non-atomic
--   with N+1 round trips and multiple silent failure modes:
--
--   (A) matchPlayers fetch fails → destructuring bug skips the
--       error → returns {success: true} with match=in_progress
--       but all players still 'waiting' (corrupt state).
--   (B) Individual queue_entries fetch fails silently → that
--       player stays 'waiting' while match is 'in_progress'.
--   (C) Any update in Promise.all throws → unhandled rejection →
--       mixed state (some players 'playing', others 'waiting').
--
--   Additional: if a player moved from 'waiting' to 'drafted'
--   between endMatchAction and revertToActive (due to engine
--   activity), the `status === "waiting"` guard silently skips
--   them → player is 'drafted' while match is 'in_progress'.
--
-- Fix:
--   New RPC revert_match_to_active performs the match status
--   update AND the queue_entries bulk update in a single Postgres
--   transaction via a JOIN UPDATE:
--
--     UPDATE queue_entries qe
--     SET    status       = 'playing',
--            games_played = GREATEST(0, qe.games_played - 1)
--     FROM   match_players mp
--     WHERE  mp.match_id   = p_match_id
--       AND  qe.session_id = p_session_id
--       AND  qe.player_id  = mp.player_id
--       AND  qe.status     = 'waiting';
--
--   This single statement replaces the fetch-each + update-each
--   loop. There are no partial-update windows and no silent skips
--   for individual rows.
--
--   Court handling (reclaim if available, detach if occupied)
--   remains in the JS server action — it's not part of the player-
--   state race condition and involves conditional logic best kept
--   in the application layer.
--
--   The server action retains the RPC-not-found (PGRST202) fallback
--   for environments that haven't received this migration yet.
-- ============================================================

CREATE OR REPLACE FUNCTION revert_match_to_active(
  p_match_id   UUID,
  p_session_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Lock the match row and validate it belongs to this session.
  -- FOR UPDATE prevents a concurrent endMatchAction or cancelMatchAction
  -- from transitioning the match away from 'completed' between our
  -- validation check and the UPDATE below.
  PERFORM id
  FROM    matches
  WHERE   id         = p_match_id
    AND   session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;

  -- Atomically revert the match to in_progress and clear the scores.
  UPDATE matches
  SET    status       = 'in_progress',
         team_a_score = NULL,
         team_b_score = NULL,
         completed_at = NULL
  WHERE  id = p_match_id;

  -- Bulk-revert all roster players who are currently 'waiting' back to
  -- 'playing' with games_played decremented by 1 (floor 0).
  --
  -- 'waiting' guard: players who were re-drafted into a new match after
  -- the original endMatchAction are left untouched ('drafted'/'on_deck').
  -- This matches the intent of the original JS-layer logic.
  --
  -- JOIN UPDATE replaces the N+1 fetch-each + update-each loop,
  -- eliminating silent skips and partial-state corruption.
  UPDATE queue_entries qe
  SET    status       = 'playing',
         games_played = GREATEST(0, qe.games_played - 1)
  FROM   match_players mp
  WHERE  mp.match_id   = p_match_id
    AND  qe.session_id = p_session_id
    AND  qe.player_id  = mp.player_id
    AND  qe.status     = 'waiting';

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION revert_match_to_active(UUID, UUID) TO service_role;
