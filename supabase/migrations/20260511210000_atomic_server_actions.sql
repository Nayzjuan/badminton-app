-- ============================================================
-- Migration: Atomic Server Actions
-- Replaces non-atomic read-then-write sequences in checkoutPlayer,
-- joinQueueAction, publishMatchAction, and publishAllDraftMatchesAction
-- with SELECT ... FOR UPDATE RPCs.
-- ============================================================

-- ── 1. checkout_player_cleanup_drafts ─────────────────────────
-- Atomically removes a checked-out player from draft match_players rows
-- and cancels the draft if it falls below 4 players.
-- Returns the IDs of any matches that were cancelled.

CREATE OR REPLACE FUNCTION checkout_player_cleanup_drafts(
  p_session_id uuid,
  p_player_id uuid
)
RETURNS TABLE(cancelled_match_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_id uuid;
  v_player_ids uuid[];
BEGIN
  FOR v_match_id IN
    SELECT m.id
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id
      AND m.status = 'pending'
      AND m.is_published = false
      AND mp.player_id = p_player_id
    FOR UPDATE OF m
  LOOP
    -- Capture remaining player IDs BEFORE deleting
    SELECT ARRAY_AGG(player_id) INTO v_player_ids
    FROM match_players
    WHERE match_id = v_match_id AND player_id != p_player_id;

    -- Remove the checked-out player from the draft
    DELETE FROM match_players
    WHERE match_id = v_match_id AND player_id = p_player_id;

    -- If the draft falls below 4 players, cancel it and return others to waiting
    IF (SELECT COUNT(*) FROM match_players WHERE match_id = v_match_id) < 4 THEN
      UPDATE matches
      SET status = 'cancelled', completed_at = now()
      WHERE id = v_match_id;

      IF v_player_ids IS NOT NULL THEN
        UPDATE queue_entries
        SET status = 'waiting'
        WHERE session_id = p_session_id
          AND player_id = ANY(v_player_ids)
          AND status != 'left';
      END IF;

      cancelled_match_id := v_match_id;
      RETURN NEXT;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION checkout_player_cleanup_drafts(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION checkout_player_cleanup_drafts(uuid, uuid) TO service_role;


-- ── 2. join_queue ─────────────────────────────────────────────
-- Atomic join/re-join with Inherited Games floor calculation.
-- Blocks if the player is currently drafted, on_deck, or playing.
-- Computes MIN(games_played) across active players and applies it.

CREATE OR REPLACE FUNCTION join_queue(
  p_session_id uuid,
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_existing RECORD;
  v_floor int;
  v_inherited_games int;
BEGIN
  -- Block if player is already committed to an active match
  SELECT id, games_played, status INTO v_existing
  FROM queue_entries
  WHERE session_id = p_session_id AND player_id = p_player_id;

  IF FOUND AND v_existing.status IN ('drafted', 'on_deck', 'playing') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You''re currently in a match — wait for it to finish before rejoining the queue.'
    );
  END IF;

  -- Compute session floor (MIN games_played among active players)
  SELECT COALESCE(MIN(games_played), 0) INTO v_floor
  FROM queue_entries
  WHERE session_id = p_session_id
    AND status IN ('waiting', 'drafted', 'on_deck', 'playing');

  IF v_existing IS NOT NULL THEN
    -- Returning player: inherit the floor, never reduce hard-earned games
    v_inherited_games := GREATEST(v_existing.games_played, v_floor);

    UPDATE queue_entries
    SET status = 'waiting',
        games_played = v_inherited_games,
        joined_at = now()
    WHERE id = v_existing.id;

    RETURN jsonb_build_object(
      'success', true,
      'action', 'updated',
      'games_played', v_inherited_games
    );
  ELSE
    -- First-time joiner
    v_inherited_games := v_floor;

    INSERT INTO queue_entries (session_id, player_id, status, games_played, joined_at)
    VALUES (p_session_id, p_player_id, 'waiting', v_inherited_games, now());

    RETURN jsonb_build_object(
      'success', true,
      'action', 'inserted',
      'games_played', v_inherited_games
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION join_queue(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION join_queue(uuid, uuid) TO service_role;


-- ── 3. publish_match ──────────────────────────────────────────
-- Atomic single-match publish with FOR UPDATE serialization.
-- Validates organizer, checks for left players, checks for conflicts
-- with other active matches, then flips is_published and promotes
-- queue status drafted → on_deck in a single transaction.

CREATE OR REPLACE FUNCTION publish_match(
  p_match_id uuid,
  p_session_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_status text;
  v_is_published bool;
  v_left_count int;
  v_conflict_count int;
BEGIN
  -- Organizer check
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN 'NOT_ORGANIZER';
  END IF;

  -- Lock and fetch the match
  SELECT status, is_published INTO v_status, v_is_published
  FROM matches
  WHERE id = p_match_id
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

  -- BUG-002 guard: check for players who have left the session
  SELECT COUNT(*) INTO v_left_count
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
  WHERE mp.match_id = p_match_id
    AND qe.status = 'left';

  IF v_left_count > 0 THEN
    RETURN 'HAS_LEFT_PLAYERS';
  END IF;

  -- Conflict guard: ensure no player is already in another active match
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

  -- Atomic publish
  UPDATE matches
  SET is_published = true
  WHERE id = p_match_id;

  -- Promote drafted players to on_deck
  UPDATE queue_entries
  SET status = 'on_deck'
  WHERE session_id = p_session_id
    AND player_id IN (SELECT player_id FROM match_players WHERE match_id = p_match_id)
    AND status = 'drafted';

  RETURN 'SUCCESS';
END;
$$;

GRANT EXECUTE ON FUNCTION publish_match(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION publish_match(uuid, uuid, uuid) TO service_role;


-- ── 4. publish_all_drafts ─────────────────────────────────────
-- Atomic bulk publish with per-match FOR UPDATE serialization.
-- Iterates every draft in deterministic ID order, validates it
-- (left players, conflicts), publishes the clean ones, and skips
-- the tainted ones. All queue promotions happen in a single UPDATE
-- at the end to minimize lock contention.

CREATE OR REPLACE FUNCTION publish_all_drafts(
  p_session_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_id uuid;
  v_match_status text;
  v_match_is_published bool;
  v_left_count int;
  v_conflict_count int;
  v_published_ids uuid[] := '{}';
  v_skipped_ids uuid[] := '{}';
  v_all_draft_ids uuid[];
BEGIN
  -- Organizer check
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_ORGANIZER');
  END IF;

  -- Collect all draft match IDs in deterministic order (deadlock prevention)
  SELECT ARRAY_AGG(id ORDER BY id) INTO v_all_draft_ids
  FROM matches
  WHERE session_id = p_session_id
    AND status = 'pending'
    AND is_published = false;

  IF v_all_draft_ids IS NULL THEN
    RETURN jsonb_build_object('success', true, 'published_count', 0, 'skipped_count', 0);
  END IF;

  -- Iterate and validate each draft under row lock
  FOREACH v_match_id IN ARRAY v_all_draft_ids
  LOOP
    SELECT status, is_published
    INTO v_match_status, v_match_is_published
    FROM matches
    WHERE id = v_match_id
    FOR UPDATE;

    IF v_match_status != 'pending' OR v_match_is_published THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

    -- Check for left players
    SELECT COUNT(*) INTO v_left_count
    FROM match_players mp
    JOIN queue_entries qe ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
    WHERE mp.match_id = v_match_id AND qe.status = 'left';

    IF v_left_count > 0 THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

    -- Check for conflicts with other active matches (including other drafts)
    SELECT COUNT(*) INTO v_conflict_count
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    WHERE mp.player_id IN (SELECT player_id FROM match_players WHERE match_id = v_match_id)
      AND m.session_id = p_session_id
      AND m.id != v_match_id
      AND m.status IN ('pending', 'in_progress');

    IF v_conflict_count > 0 THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

    -- Publish this draft
    UPDATE matches SET is_published = true WHERE id = v_match_id;
    v_published_ids := array_append(v_published_ids, v_match_id);
  END LOOP;

  -- Promote all players in published drafts to on_deck in one shot
  IF v_published_ids != '{}' THEN
    UPDATE queue_entries
    SET status = 'on_deck'
    WHERE session_id = p_session_id
      AND player_id IN (
        SELECT player_id FROM match_players WHERE match_id = ANY(v_published_ids)
      )
      AND status = 'drafted';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'published_count', COALESCE(array_length(v_published_ids, 1), 0),
    'skipped_count', COALESCE(array_length(v_skipped_ids, 1), 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION publish_all_drafts(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION publish_all_drafts(uuid, uuid) TO service_role;
