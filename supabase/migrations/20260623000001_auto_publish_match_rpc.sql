-- ============================================================
-- auto_publish_match — engine-initiated publish (no organizer)
-- ============================================================
-- Publishes an existing PENDING draft without an organizer actor. Used by the
-- auto-publish engine path for HELD cross-court drafts, which are born
-- is_published=false (hidden) and only become promotable once their pulled body
-- is free. recomputeHeldReadiness calls this the moment it stamps held_ready_at
-- while the session is in auto_publish mode.
--
-- This is publish_match MINUS the organizer gate (the caller is the trusted
-- service-role engine, never a user) but WITH the same safety guards:
--   • HAS_LEFT_PLAYERS — never publish a match containing a player who left
--   • CONFLICT         — never publish if a roster player is already committed
--                        to another active match
-- so a left/conflicted player can never reach On Deck or a court via auto-publish.
--
-- Held-draft rosters sit in 'drafted' at readiness (3 waiting members reserved at
-- creation; the pulled body re-reserved 'drafted' on source completion — R3-1), so
-- the transition covers 'drafted'. 'waiting' is included defensively; 'left' and
-- 'playing' are intentionally never overwritten.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_publish_match(
  p_match_id   uuid,
  p_session_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status         text;
  v_is_published   bool;
  v_left_count     int;
  v_conflict_count int;
BEGIN
  SELECT status, is_published INTO v_status, v_is_published
  FROM matches
  WHERE id = p_match_id AND session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;

  IF v_status != 'pending' THEN
    RETURN 'NOT_PENDING';
  END IF;

  IF v_is_published THEN
    RETURN 'ALREADY_PUBLISHED';
  END IF;

  -- Safety: a player who left must never be auto-published onto On Deck.
  SELECT COUNT(*) INTO v_left_count
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
  WHERE mp.match_id = p_match_id
    AND qe.status = 'left';

  IF v_left_count > 0 THEN
    RETURN 'HAS_LEFT_PLAYERS';
  END IF;

  -- Safety: a roster player already committed elsewhere blocks the publish.
  SELECT COUNT(*) INTO v_conflict_count
  FROM match_players mp
  JOIN matches m ON m.id = mp.match_id
  WHERE mp.player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND m.session_id = p_session_id
    AND m.id != p_match_id
    AND m.status IN ('pending', 'in_progress');

  IF v_conflict_count > 0 THEN
    RETURN 'CONFLICT';
  END IF;

  UPDATE matches
  SET is_published = true
  WHERE id = p_match_id;

  UPDATE queue_entries
  SET status = 'on_deck'
  WHERE session_id = p_session_id
    AND player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND status IN ('drafted', 'waiting');

  RETURN 'SUCCESS';
END;
$function$;
