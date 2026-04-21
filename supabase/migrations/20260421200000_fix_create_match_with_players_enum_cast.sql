-- ============================================================
-- Migration: fix create_match_with_players — explicit enum cast
-- ============================================================
-- Root cause of Bug #2 (Auto-matchmaking dead):
--   The function accepted p_status as TEXT, but matches.status
--   is a custom Postgres enum (match_status). Postgres does NOT
--   implicitly cast TEXT → enum, so the INSERT always failed with:
--     ERROR 42804: column "status" is of type match_status but
--     expression is of type text
--   The error was caught by executeMatch() in matchmaking.ts and
--   returned as { success: false }, but because DEBUG_MATCHMAKING
--   was not "true" in production the log line was never emitted,
--   making the failure completely invisible in Vercel logs.
--
-- Fix: add explicit ::match_status / ::queue_status / ::court_status
--   casts on all enum columns in the function body.
--   Everything else (logic, grants, signature) is unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION create_match_with_players(
  p_session_id      UUID,
  p_court_id        UUID,
  p_status          TEXT,        -- 'pending' | 'in_progress'
  p_is_mixed_level  BOOLEAN,
  p_started_at      TIMESTAMPTZ,
  p_is_on_deck      BOOLEAN,
  p_team_a_ids      UUID[],
  p_team_b_ids      UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_id     UUID;
  v_queue_status TEXT;
BEGIN
  -- Step a: Create the match row — cast TEXT → match_status enum
  INSERT INTO matches (session_id, court_id, status, is_mixed_level, started_at)
  VALUES (p_session_id, p_court_id, p_status::match_status, p_is_mixed_level, p_started_at)
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
  SET    status = v_queue_status::queue_status
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(p_team_a_ids || p_team_b_ids);

  -- Step e: Mark court as in_use (only for live, court-assigned matches)
  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts
    SET    status = 'in_use'::court_status
    WHERE  id = p_court_id;
  END IF;

  RETURN v_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_match_with_players(
  UUID, UUID, TEXT, BOOLEAN, TIMESTAMPTZ, BOOLEAN, UUID[], UUID[]
) TO authenticated, service_role;
