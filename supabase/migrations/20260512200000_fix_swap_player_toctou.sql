-- ============================================================
-- Migration: Fix TOCTOU race in swap_player_in_match
-- ============================================================
-- Root cause (F1, P0):
--   swap_player_in_match had no database-level guard on the
--   incoming player's availability. Two concurrent swaps could
--   both read the same player as 'waiting' in the JS layer,
--   then both call the RPC and insert the player into two
--   different match_players rows simultaneously — leaving the
--   player in the 'on_deck' state for two matches at once.
--
--   Contrast: create_match_with_players already uses FOR UPDATE
--   + Guard 2 for this purpose. This migration brings
--   swap_player_in_match to the same standard.
--
-- Fix: Add three in-RPC guards executed inside the same
-- Postgres transaction as the writes:
--
--   Guard A — SELECT ... FOR UPDATE on the incoming player's
--     queue_entries row. Serializes concurrent swaps targeting
--     the same player. The second concurrent call blocks until
--     the first commits, then re-checks the (now stale) status.
--
--   Guard B — Post-lock conflict check: the player must not
--     already appear in another pending/in_progress match.
--     Catches the race where Guard A's status was 'waiting' but
--     a concurrent swap already INSERT'd them into a match.
--
--   Guard C — SELECT ... FOR UPDATE on the match row. Prevents
--     a concurrent startMatchAction from transitioning the match
--     to in_progress between the JS-layer status check and the
--     atomic writes.
--
-- Steps a–f are carried over verbatim from the previous version
-- (20260512000000_restore_swap_player_origin_flip.sql).
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
SET search_path = 'public'
AS $$
DECLARE
  v_in_status       TEXT;
  v_match_status    TEXT;
  v_distinct_levels INT;
BEGIN
  -- ── Guard A: Lock + status-check the incoming player's queue row ────────────
  -- FOR UPDATE serializes concurrent swaps targeting the same incoming player.
  -- The second concurrent call blocks here until the first commits, then reads
  -- the updated status (e.g. 'on_deck') and raises PLAYER_UNAVAILABLE.
  SELECT status INTO v_in_status
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = p_in_player_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
  END IF;

  IF v_in_status IS DISTINCT FROM 'waiting' THEN
    RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
  END IF;

  -- ── Guard B: Incoming player must not be in another active match ─────────────
  -- Covers the narrow race where:
  --   1. Both concurrent swaps read status='waiting' (before either locks),
  --   2. Swap-1 completes (inserts player into match A, sets status='on_deck'),
  --   3. Swap-2 acquires the FOR UPDATE lock, sees status='on_deck' → caught by Guard A.
  -- BUT: if the first swap locked and updated atomically, Guard A alone is sufficient.
  -- Guard B is a belt-and-suspenders check for legacy data or future RPC call paths
  -- that bypass Guard A.
  IF EXISTS (
    SELECT 1
    FROM   match_players mp
    JOIN   matches m ON m.id = mp.match_id
    WHERE  mp.player_id  = p_in_player_id
      AND  m.session_id  = p_session_id
      AND  m.id         != p_match_id
      AND  m.status     IN ('pending', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
  END IF;

  -- ── Guard C: Lock + status-check the target match row ───────────────────────
  -- Prevents a concurrent startMatchAction from racing between the JS-layer
  -- status check (Guard 2 in swapPlayerInMatch action) and these writes.
  SELECT status INTO v_match_status
  FROM   matches
  WHERE  id = p_match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_STARTED';
  END IF;

  IF v_match_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'MATCH_STARTED';
  END IF;

  -- ── Step a: Remove outgoing player from this match ──────────────────────────
  DELETE FROM match_players
  WHERE  match_id  = p_match_id
    AND  player_id = p_out_player_id;

  -- ── Step b: Insert incoming player on the same team ─────────────────────────
  INSERT INTO match_players (match_id, player_id, team)
  VALUES (p_match_id, p_in_player_id, p_team);

  -- ── Step c: Update incoming player's queue status ────────────────────────────
  --   Published match     → 'on_deck'  (ON_DECK_WARNING alert fires immediately)
  --   Unpublished draft   → 'drafted'  (publishMatchAction promotes to 'on_deck')
  IF p_is_published THEN
    UPDATE queue_entries
    SET    status = 'on_deck'
    WHERE  session_id = p_session_id
      AND  player_id  = p_in_player_id;
  ELSE
    UPDATE queue_entries
    SET    status = 'drafted'
    WHERE  session_id = p_session_id
      AND  player_id  = p_in_player_id;
  END IF;

  -- ── Step d: Return outgoing player to the waiting queue ──────────────────────
  UPDATE queue_entries
  SET    status = 'waiting'
  WHERE  session_id = p_session_id
    AND  player_id  = p_out_player_id;

  -- ── Step e: Recompute is_mixed_level from the current post-swap roster ───────
  SELECT COUNT(DISTINCT p.skill_level) INTO v_distinct_levels
  FROM   match_players mp
  JOIN   profiles p ON p.id = mp.player_id
  WHERE  mp.match_id = p_match_id;

  UPDATE matches
  SET    is_mixed_level = (v_distinct_levels > 1)
  WHERE  id = p_match_id;

  -- ── Step f: Promote origin auto → modified (sticky rule) ────────────────────
  -- WHERE origin = 'auto' guards against demoting 'manual' and 'modified' matches.
  -- Only engine-generated matches ('auto') are bumped to 'modified' on a human swap.
  UPDATE matches
  SET    origin = 'modified'::public.match_origin
  WHERE  id     = p_match_id
    AND  origin = 'auto'::public.match_origin;
END;
$$;

GRANT EXECUTE ON FUNCTION swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN)
  TO service_role;
