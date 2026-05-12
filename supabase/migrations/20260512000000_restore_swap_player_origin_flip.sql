-- ============================================================
-- Migration: Restore Step f — origin auto → modified flip
--            inside swap_player_in_match (REGRESSION FIX)
-- ============================================================
-- Background:
--
--   Migration 20260502000000_match_origin_tracking.sql first added
--   Step f to swap_player_in_match: after a single-player swap,
--   promote matches.origin from 'auto' to 'modified' so the audit
--   trail and the "manual is sticky" rule both stay correct.
--
--   Two later rewrites of swap_player_in_match silently dropped
--   Step f when they re-issued CREATE OR REPLACE FUNCTION:
--     • 20260509000000_swap_player_draft_aware.sql
--     • 20260511000001_swap_player_drafted_status.sql  (latest)
--
--   Effect: every organiser-initiated single-player swap on an
--   engine-generated match left origin='auto' instead of flipping
--   to 'modified'. swap_match_players (the match↔match RPC) was
--   never affected — only swap_player_in_match regressed.
--
--   Discovered 2026-05-12 by integration test M-5 in
--   tests/integration/manual-and-swap.test.ts (the test was
--   .skip'ped with a regression block; this migration restores
--   the contract so the test passes when re-enabled).
--
-- Fix:
--   This file re-issues CREATE OR REPLACE FUNCTION with Steps a–e
--   copied verbatim from 20260511000001_swap_player_drafted_status
--   plus a new Step f at the end. The WHERE origin = 'auto' guard
--   is the sticky-rule: 'manual' and 'modified' are untouched.
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

  -- Step f (RESTORED 2026-05-12): Promote origin auto → modified.
  -- Sticky rule: WHERE origin = 'auto' guards against demoting
  -- 'manual' and 'modified' matches. Only engine-generated matches
  -- ('auto') are bumped to 'modified' on a human swap.
  UPDATE matches
  SET    origin = 'modified'::public.match_origin
  WHERE  id = p_match_id
    AND  origin = 'auto'::public.match_origin;
END;
$$;

GRANT EXECUTE ON FUNCTION swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN)
  TO service_role;
