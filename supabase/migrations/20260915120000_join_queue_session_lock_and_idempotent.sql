-- ============================================================
-- join_queue: session lock + retry-idempotent actions
-- ============================================================
-- Same signature as 20260511210000: join_queue(uuid, uuid) RETURNS jsonb.
--
-- Close-versus-join previously raced: join_queue never locked or checked the
-- session row, so a waiting entry could land after closeSession had already
-- marked everyone left and computed Wrapped.
--
-- Retry previously mutated live rows: a second tap on waiting refreshed
-- joined_at (line-jump), and drafted / on_deck / playing were rejected so a
-- QR finalizer retry looked like a failure.
--
-- This replacement:
--   1. SELECT ... FOR UPDATE on the session row; refuse when missing,
--      is_active is not true, or ended_at is set.
--   2. Returns action = inserted | reactivated | unchanged.
--      waiting / drafted / on_deck / playing → unchanged (status, games,
--      joined_at, pause preserved).
--      left → reactivated to waiting with the inherited-games floor,
--      joined_at refresh, and pause cleared.
--      no row → inserted with the inherited-games floor.
--
-- Grants stay restricted: service_role only (see 20260511210001 /
-- 20260721180000). CREATE OR REPLACE does not reset ACLs; the REVOKE/GRANT
-- below is belt-and-suspenders.
--
-- ROLLBACK: restore the 20260511210000 body (reject drafted/on_deck/playing,
-- refresh waiting.joined_at, no session lock) from that migration file, then
-- re-apply the grant lockdown in 20260511210001 / 20260721180000.

CREATE OR REPLACE FUNCTION public.join_queue(
  p_session_id uuid,
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_active     BOOLEAN;
  v_ended_at      TIMESTAMPTZ;
  v_existing      queue_entries%ROWTYPE;
  v_floor         INTEGER;
  v_inherited     INTEGER;
BEGIN
  SELECT s.is_active, s.ended_at
    INTO v_is_active, v_ended_at
    FROM sessions s
   WHERE s.id = p_session_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Session not found');
  END IF;

  IF v_is_active IS NOT TRUE OR v_ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This session has ended.');
  END IF;

  SELECT *
    INTO v_existing
    FROM queue_entries
   WHERE session_id = p_session_id
     AND player_id  = p_player_id
     FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status IN ('waiting', 'drafted', 'on_deck', 'playing') THEN
      RETURN jsonb_build_object(
        'success', true,
        'action', 'unchanged',
        'games_played', v_existing.games_played
      );
    END IF;

    SELECT MIN(games_played) INTO v_floor
      FROM queue_entries
     WHERE session_id = p_session_id
       AND status IN ('waiting', 'drafted', 'on_deck', 'playing');

    v_inherited := GREATEST(v_existing.games_played, COALESCE(v_floor, 0));

    UPDATE queue_entries
       SET status       = 'waiting',
           games_played = v_inherited,
           joined_at    = NOW(),
           is_paused    = false,
           paused_at    = NULL
     WHERE id = v_existing.id;

    RETURN jsonb_build_object(
      'success', true,
      'action', 'reactivated',
      'games_played', v_inherited
    );
  END IF;

  SELECT MIN(games_played) INTO v_floor
    FROM queue_entries
   WHERE session_id = p_session_id
     AND status IN ('waiting', 'drafted', 'on_deck', 'playing');

  INSERT INTO queue_entries (session_id, player_id, status, games_played, joined_at)
  VALUES (p_session_id, p_player_id, 'waiting', COALESCE(v_floor, 0), NOW());

  RETURN jsonb_build_object(
    'success', true,
    'action', 'inserted',
    'games_played', COALESCE(v_floor, 0)
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT *
      INTO v_existing
      FROM queue_entries
     WHERE session_id = p_session_id
       AND player_id  = p_player_id;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'action', 'unchanged',
        'games_played', v_existing.games_played
      );
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'Failed to join queue');
END;
$$;

REVOKE ALL ON FUNCTION public.join_queue(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_queue(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_queue(uuid, uuid) TO service_role;
