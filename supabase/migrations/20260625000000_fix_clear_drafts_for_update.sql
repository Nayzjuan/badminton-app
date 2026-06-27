-- ============================================================
-- Fix clear_all_unpublished_drafts: FOR UPDATE + aggregate is illegal
-- ============================================================
-- Postgres rejects `SELECT array_agg(id) ... FOR UPDATE` at parse time:
--   ERROR 0A000: FOR UPDATE is not allowed with aggregate functions
--
-- This has been latent since the function was introduced (20260602000000) —
-- the cap-change clear path rarely fires and the integration tests that
-- exercise it don't run in the default suite, so it stayed hidden. The
-- auto-publish toggle's ON-flip (which also clears drafts) surfaced it.
--
-- Fix: lock the rows in a plain (non-aggregate) subquery with FOR UPDATE,
-- then aggregate the ids from the locked set. Same locking guarantee, valid SQL.
-- Keeps the is_held exclusion from 20260624000000.
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
  -- Lock the target rows in a subquery (FOR UPDATE cannot sit on an aggregate
  -- query), then aggregate their ids.
  SELECT array_agg(locked.id) INTO v_match_ids
  FROM (
    SELECT id
    FROM matches
    WHERE session_id = p_session_id
      AND status     = 'pending'
      AND is_published = false
      AND is_held IS NOT TRUE        -- never sweep up held cross-court drafts
    FOR UPDATE
  ) AS locked;

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
