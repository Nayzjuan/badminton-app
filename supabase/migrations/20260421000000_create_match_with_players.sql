-- ============================================================
-- Migration: create_match_with_players RPC
-- ============================================================
-- Wraps all three write steps of executeMatch (matchmaking.ts)
-- in a single Postgres transaction, eliminating partial-failure
-- corruption scenarios:
--
--   1. Ghost match with 0 players (crash between Write 1 and Write 2)
--   2. Duplicate queue entries (Write 3 had no error check — players
--      stayed "waiting" and the engine could re-match them on the
--      very next tick, creating a second match for the same people)
--
-- Steps (atomic):
--   a. INSERT into matches → captures match UUID
--   b. INSERT into match_players for team A
--   c. INSERT into match_players for team B
--   d. UPDATE queue_entries → "on_deck" (pending) or "playing" (in_progress)
--   e. UPDATE courts → "in_use"  (only when not on-deck and court_id given)
--
-- Returns the new match UUID so the caller can surface it to the UI.
--
-- Called from: src/app/actions/matchmaking.ts → executeMatch()
-- Auth note:   The organizer is authenticated; SECURITY DEFINER lets
--              the function bypass RLS (same pattern as swap_player_in_match).
-- ============================================================

CREATE OR REPLACE FUNCTION create_match_with_players(
  p_session_id      UUID,
  p_court_id        UUID,      -- null for on-deck (pending) matches
  p_status          TEXT,      -- 'pending' | 'in_progress'
  p_is_mixed_level  BOOLEAN,
  p_started_at      TIMESTAMPTZ, -- null for on-deck matches
  p_is_on_deck      BOOLEAN,
  p_team_a_ids      UUID[],
  p_team_b_ids      UUID[]
)
RETURNS UUID              -- UUID of the newly created match
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_id     UUID;
  v_queue_status TEXT;
BEGIN
  -- Step a: Create the match row
  INSERT INTO matches (session_id, court_id, status, is_mixed_level, started_at)
  VALUES (p_session_id, p_court_id, p_status, p_is_mixed_level, p_started_at)
  RETURNING id INTO v_match_id;

  -- Step b: Insert team A players
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';

  -- Step c: Insert team B players
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  -- Step d: Update queue statuses for all 4 players
  v_queue_status := CASE WHEN p_is_on_deck THEN 'on_deck' ELSE 'playing' END;

  UPDATE queue_entries
  SET    status = v_queue_status
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(p_team_a_ids || p_team_b_ids);

  -- Step e: Mark court as in_use (only for live, court-assigned matches)
  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts
    SET    status = 'in_use'
    WHERE  id = p_court_id;
  END IF;

  RETURN v_match_id;
END;
$$;

-- Grant execute to authenticated (organizer session) and service_role
GRANT EXECUTE ON FUNCTION create_match_with_players(
  UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ, BOOLEAN, UUID[], UUID[]
) TO authenticated, service_role;
