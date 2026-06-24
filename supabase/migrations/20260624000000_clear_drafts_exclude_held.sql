-- ============================================================
-- clear_all_unpublished_drafts: never clear HELD cross-court drafts
-- ============================================================
-- The bulk draft-clear (used by setCapAndClearDrafts on a cap change AND by
-- toggleAutoPublish on the ON flip) selected ALL pending is_published=false
-- matches and reset their rosters to 'waiting' (WHERE status != 'left').
--
-- Held cross-court drafts are also is_published=false, so they were swept up:
--   • A held draft whose pulled body is STILL PLAYING would flip that player from
--     'playing' to 'waiting' mid-game (status != 'left' is true for 'playing') —
--     corrupting their state and risking a double-booking.
--   • The in-flight cross-court match was silently cancelled.
--
-- Held drafts have their own lifecycle (recomputeHeldReadiness downgrades /
-- cancels / publishes them), so the bulk clear must skip them entirely. Add
-- `AND is_held IS NOT TRUE` to the selection. Everything else is unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION public.clear_all_unpublished_drafts(p_session_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_match_ids  UUID[];
  v_player_ids UUID[];
BEGIN
  SELECT array_agg(id) INTO v_match_ids
  FROM matches
  WHERE session_id = p_session_id
    AND status     = 'pending'
    AND is_published = false
    AND is_held IS NOT TRUE        -- never sweep up held cross-court drafts
  FOR UPDATE;

  IF v_match_ids IS NULL OR array_length(v_match_ids, 1) = 0 THEN
    RETURN ARRAY[]::UUID[];
  END IF;

  SELECT array_agg(qe.player_id) INTO v_player_ids
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id  = mp.player_id
   AND qe.session_id = p_session_id
  WHERE mp.match_id = ANY(v_match_ids)
    AND qe.status  != 'left';

  IF v_player_ids IS NOT NULL AND array_length(v_player_ids, 1) > 0 THEN
    UPDATE queue_entries
    SET status = 'waiting'
    WHERE session_id = p_session_id
      AND player_id  = ANY(v_player_ids)
      AND status    != 'left';
  END IF;

  DELETE FROM match_players WHERE match_id = ANY(v_match_ids);
  DELETE FROM matches WHERE id = ANY(v_match_ids);

  RETURN COALESCE(v_player_ids, ARRAY[]::UUID[]);
END;
$function$;
