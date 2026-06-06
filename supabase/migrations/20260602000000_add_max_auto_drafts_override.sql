-- ============================================================
-- Draft Cap Override — per-session max draft limit
-- ============================================================
-- Adds `max_auto_drafts_override` to sessions so organizers
-- can restrict how many auto-generated drafts the engine
-- produces. NULL = use the existing dynamic tiered cap
-- (3 / 5 / 6 based on waiting player count). Values 1–5
-- act as a ceiling: effectiveCap = min(override, dynamicCap).
--
-- Also adds clear_all_unpublished_drafts(p_session_id) — an
-- atomic RPC that removes all is_published=false pending
-- matches for a session and returns their players to
-- 'waiting' status in one transaction.
-- ============================================================

-- ── Column ───────────────────────────────────────────────────

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS max_auto_drafts_override integer
    CONSTRAINT max_auto_drafts_override_range
      CHECK (max_auto_drafts_override BETWEEN 1 AND 5);

-- NULL = dynamic (default behaviour — no override)
COMMENT ON COLUMN sessions.max_auto_drafts_override IS
  'Organizer-set ceiling on auto-draft generation. NULL = use dynamic cap (3/5/6). '
  '1–5 = min(this, dynamicCap) is the effective cap.';

-- ── RPC: clear_all_unpublished_drafts ────────────────────────
-- Atomically clears ALL pending, unpublished draft matches for
-- a session. Players whose queue status is "drafted" are
-- returned to "waiting"; "left" players are skipped.
-- Published on-deck matches (is_published=true) are untouched.
-- Returns the array of player IDs that were returned to queue.

CREATE OR REPLACE FUNCTION clear_all_unpublished_drafts(
  p_session_id UUID
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_ids  UUID[];
  v_player_ids UUID[];
BEGIN
  -- Lock all unpublished draft matches for this session atomically.
  SELECT array_agg(id) INTO v_match_ids
  FROM matches
  WHERE session_id = p_session_id
    AND status     = 'pending'
    AND is_published = false
  FOR UPDATE;

  -- Nothing to clear — return empty array.
  IF v_match_ids IS NULL OR array_length(v_match_ids, 1) = 0 THEN
    RETURN ARRAY[]::UUID[];
  END IF;

  -- Collect the players in those matches (skip 'left' players —
  -- they already self-exited and should not be re-queued).
  SELECT array_agg(qe.player_id) INTO v_player_ids
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id  = mp.player_id
   AND qe.session_id = p_session_id
  WHERE mp.match_id = ANY(v_match_ids)
    AND qe.status  != 'left';

  -- Return affected players to 'waiting'.
  IF v_player_ids IS NOT NULL AND array_length(v_player_ids, 1) > 0 THEN
    UPDATE queue_entries
    SET status = 'waiting'
    WHERE session_id = p_session_id
      AND player_id  = ANY(v_player_ids)
      AND status    != 'left';
  END IF;

  -- Delete the match_players rows first (FK constraint).
  DELETE FROM match_players WHERE match_id = ANY(v_match_ids);

  -- Delete the draft matches themselves.
  DELETE FROM matches WHERE id = ANY(v_match_ids);

  RETURN COALESCE(v_player_ids, ARRAY[]::UUID[]);
END;
$$;

GRANT EXECUTE ON FUNCTION clear_all_unpublished_drafts(UUID) TO service_role;
