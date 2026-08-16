-- ============================================================================
-- publish_match / publish_all_drafts: never publish an UNREADY held draft
-- ============================================================================
-- A cross-court held draft is 3 waiting/drafted players + 1 player who is still
-- PLAYING on another court (the "pulled body"). It is is_published=false by
-- design and becomes promotable only once recomputeHeldReadiness stamps
-- held_ready_at. Both publish RPCs were blind to that, and each produced its own
-- failure in the field (session 3367d4c6, 2026-08-15: 12 held drafts created, 10
-- of them manually cleared by the organizer, only 2 ever reached a court).
--
--   * publish_match — the conflict check counts any OTHER pending/in_progress
--     match holding one of this roster's players. The pulled body sits in an
--     in_progress match for the whole hold, so it returned 'CONFLICT' 100% of the
--     time, and the organizer-facing copy for CONFLICT reads "a player is already
--     assigned to another active match. Clear this draft and let the engine
--     regenerate." Structurally true and completely misleading: nothing was
--     wrong, the hold simply had not resolved yet. There was no code that meant
--     "not yet", so the caller could not tell "wait" from "throw this away".
--
--   * publish_all_drafts — same check, but a skip there is silent: the RPC still
--     returns success and the action reported every skip as "(left players)".
--     Worse, a held draft in the RESTING window (source game over, stamp not yet
--     written) passes the conflict check and DOES publish -- flipping four queue
--     rows to on_deck and firing an ON_DECK_WARNING push -- while
--     promoteOnDeckMatchInternal still refuses it: its JS filter over the
--     published pending set takes a held row only once held_ready_at is both
--     stamped AND due (<= now). The result is a match parked on deck that no
--     court will ever take until an unrelated lifecycle event stamps it. That is
--     the "Publish All let it through but it never worked" report.
--
-- Fix, one rule in both: a held draft is not publishable until held_ready_at is
-- stamped.
--   * publish_match gains a 'HELD_NOT_READY' return code, checked before the
--     left-player and conflict predicates so the specific cause wins over the
--     generic one. New code, not a repurposed one -- callers switch on this
--     string and must be able to say "wait" instead of "clear".
--     The order has one deliberate cost: a held draft that has ALSO lost a
--     player is told to wait rather than to clear. Accepted, because it is
--     self-correcting and the alternative is worse. It resolves either when
--     held_ready_at stamps (the next publish then reports HAS_LEFT_PLAYERS
--     correctly) or when the CROSS_COURT_MAX_HOLD_MINUTES cancel fires, and
--     Clear is offered throughout. Checking left-players first would restore
--     the original bug for the common case -- every ordinary hold would once
--     again get advice to clear -- to improve a rare compound one.
--   * publish_all_drafts excludes unready held drafts from v_all_draft_ids
--     entirely, rather than letting them fall into v_skipped_ids. They are not
--     eligible, so they are not attempts, so they must not inflate skipped_count
--     -- which is the number the client turns into a warning. Same MOTIVE as
--     20260624000000_clear_drafts_exclude_held (a held draft is not a candidate
--     for a bulk operation, so keep it out of the candidate set rather than
--     handling it inside the loop), but deliberately NOT the same predicate:
--     that one excludes every held draft (is_held IS NOT TRUE), because a bulk
--     clear must never touch a hold at all. This one excludes only the UNREADY
--     ones, because a stamped hold is an ordinary publishable draft. Do not
--     "align" the two spellings -- copying is_held IS NOT TRUE to here would
--     make a READY hold permanently unpublishable via Publish All.
--
-- Publishing stays BLOCKED, not deferred: promotion requires the stamp anyway, so
-- an early publish buys nothing and costs a premature player-facing ping. The
-- organizer keeps Clear, which is the one action that is always legitimate on a
-- hold they no longer want.
--
-- Both are CREATE OR REPLACE with no signature change, so the narrowed EXECUTE
-- grants from 20260721180000 / 20260722000004 are preserved. Do NOT convert
-- either to DROP+CREATE: that silently resets the ACL to EXECUTE TO PUBLIC.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.publish_match(p_match_id uuid, p_session_id uuid, p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_is_published bool;
  v_is_held bool;
  v_held_ready_at timestamptz;
  v_left_count int;
  v_conflict_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN 'NOT_ORGANIZER';
  END IF;

  SELECT status, is_published, is_held, held_ready_at
  INTO v_status, v_is_published, v_is_held, v_held_ready_at
  FROM matches
  WHERE id = p_match_id
    AND session_id = p_session_id
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

  -- Held cross-court draft, hold not yet resolved. Checked BEFORE the left and
  -- conflict predicates: while the pulled body is on court the conflict check is
  -- guaranteed to fire, and answering 'CONFLICT' tells the organizer to clear a
  -- draft that is merely waiting.
  IF v_is_held IS TRUE AND v_held_ready_at IS NULL THEN
    RETURN 'HELD_NOT_READY';
  END IF;

  SELECT COUNT(*) INTO v_left_count
  FROM match_players mp
  JOIN queue_entries qe
    ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
  WHERE mp.match_id = p_match_id
    AND qe.status = 'left';

  IF v_left_count > 0 THEN
    RETURN 'HAS_LEFT_PLAYERS';
  END IF;

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

CREATE OR REPLACE FUNCTION public.publish_all_drafts(p_session_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = p_session_id AND created_by = p_user_id
    UNION ALL
    SELECT 1 FROM session_organizers WHERE session_id = p_session_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_ORGANIZER');
  END IF;

  -- Unready held drafts are NOT candidates. Excluded here rather than skipped in
  -- the loop so they never reach skipped_count, which the client renders as a
  -- warning about drafts the organizer has to fix. A held draft that HAS been
  -- stamped ready is an ordinary publishable draft and stays in.
  SELECT ARRAY_AGG(id ORDER BY id) INTO v_all_draft_ids
  FROM matches
  WHERE session_id = p_session_id
    AND status = 'pending'
    AND is_published = false
    AND NOT (is_held IS TRUE AND held_ready_at IS NULL);

  IF v_all_draft_ids IS NULL THEN
    RETURN jsonb_build_object('success', true, 'published_count', 0, 'skipped_count', 0);
  END IF;

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

    SELECT COUNT(*) INTO v_left_count
    FROM match_players mp
    JOIN queue_entries qe ON qe.player_id = mp.player_id AND qe.session_id = p_session_id
    WHERE mp.match_id = v_match_id AND qe.status = 'left';

    IF v_left_count > 0 THEN
      v_skipped_ids := array_append(v_skipped_ids, v_match_id);
      CONTINUE;
    END IF;

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

    UPDATE matches SET is_published = true WHERE id = v_match_id;
    v_published_ids := array_append(v_published_ids, v_match_id);
  END LOOP;

  IF v_published_ids != '{}' THEN
    UPDATE queue_entries
    SET status = 'on_deck'
    WHERE session_id = p_session_id
      AND player_id IN (
        SELECT player_id FROM match_players WHERE match_id = ANY(v_published_ids)
      )
      AND status IN ('drafted', 'waiting');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'published_count', COALESCE(array_length(v_published_ids, 1), 0),
    'skipped_count', COALESCE(array_length(v_skipped_ids, 1), 0)
  );
END;
$function$;
