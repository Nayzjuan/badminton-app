-- ============================================================
-- clear_on_deck_match_atomic: never pull a player off a live court
-- ============================================================
-- Found by the review gate on the cross-court hold-age cancel (§3.1).
--
-- Step 5 restored EVERY match_players row of the cleared draft to 'waiting',
-- guarded only by `status != 'left'`. For an ordinary draft that is correct —
-- all four members are 'drafted', and create_match_with_players' Guard 2 makes
-- it impossible for a pending match to contain a player who is mid-game.
--
-- A HELD cross-court draft breaks that assumption by design: it is
-- (3 waiting + 1 still-playing body), and create_held_cross_court_match
-- deliberately leaves the body's queue_entries row at 'playing'. So clearing a
-- held draft whose body has NOT yet been freed flips a player who is physically
-- on court to 'waiting'.
--
-- This is the same hazard 20260624000000 fixed for the BULK clear
-- (clear_all_unpublished_drafts), quoting: "would flip that player from
-- 'playing' to 'waiting' mid-game … corrupting their state and risking a
-- double-booking." The single-match clear was never audited for it because,
-- until now, no routine path called it on a still-Holding draft:
--   • the auto-publish-blocked cancel runs only after the draft is READY
--     (body already freed);
--   • the R3-B source-integrity cancels require a purged/missing source match.
-- The new hold-age cancel (CROSS_COURT_MAX_HOLD_MINUTES) fires precisely and
-- only while the body is still playing, making this the routine path.
--
-- Concretely, without this fix: body B is set 'waiting' with joined_at
-- untouched, so B reads wait_minutes ≈ 15-20, clears MIN_REST_MINUTES in
-- fetchActivePool and sorts near the top of the pool. The next engine run seats
-- B, create_match_with_players' Guard 2 sees B's in_progress match and returns
-- NULL, executeMatch reports failure and the slot loop breaks — the engine
-- produces ZERO matches every tick until B's real game ends. Meanwhile B shows
-- up in the waiting queue and on a court at the same time.
--
-- Fix: test PHYSICAL truth, not the status string. Exclude any player who
-- actually holds an in_progress match in this session. That is strictly more
-- precise than `status != 'playing'` and keeps every existing caller's
-- behaviour intact:
--   • ordinary draft            — nobody is in_progress   → all restored (unchanged)
--   • hold-age cancel           — body IS in_progress      → body untouched (the fix)
--   • R3-B, source match purged — body has no in_progress  → body restored (unchanged)
--
-- Leaving the body 'playing' is not a leak: once the draft row is gone,
-- endMatchAction's R3-1 overlap query finds no held draft for them, so
-- requeue_finished_players returns them to 'waiting' normally when their game
-- actually ends — incrementing games_played and stamping joined_at, which the
-- flip would have skipped.
--
-- Everything else — the 6-step lock order from 20260512200004, the validation,
-- the return value — is unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION clear_on_deck_match_atomic(
  p_match_id   UUID,
  p_session_id UUID
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_status    TEXT;
  v_player_ids_lock UUID[];  -- IDs captured non-locking (for lock acquisition)
  v_player_ids      UUID[];  -- IDs re-read under lock (authoritative for writes)
BEGIN
  -- ── Step 1: Non-locking read of player IDs ─────────────────────────────────
  SELECT ARRAY_AGG(player_id ORDER BY player_id) INTO v_player_ids_lock
  FROM   match_players
  WHERE  match_id = p_match_id;

  -- ── Step 2: Lock queue_entries rows in player_id order ─────────────────────
  -- ORDER BY player_id prevents intra-deadlock between two concurrent clears
  -- targeting overlapping player sets. Deliberately locks the FULL roster,
  -- including a still-playing body we will not write to: the lock set must stay
  -- a superset of the write set, and shrinking it here would reintroduce the
  -- lock-ordering inversion 20260512200004 exists to prevent.
  IF v_player_ids_lock IS NOT NULL AND array_length(v_player_ids_lock, 1) > 0 THEN
    PERFORM player_id
    FROM    queue_entries
    WHERE   session_id = p_session_id
      AND   player_id  = ANY(v_player_ids_lock)
    ORDER BY player_id
    FOR UPDATE;
  END IF;

  -- ── Step 3: Lock + validate the match row ───────────────────────────────────
  SELECT status INTO v_match_status
  FROM   matches
  WHERE  id         = p_match_id
    AND  session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;

  IF v_match_status != 'pending' THEN
    RAISE EXCEPTION 'MATCH_NOT_PENDING';
  END IF;

  -- ── Step 4: Re-fetch player IDs under lock ──────────────────────────────────
  SELECT ARRAY_AGG(player_id) INTO v_player_ids
  FROM   match_players
  WHERE  match_id = p_match_id;

  -- ── Step 5: Restore players to 'waiting' ─────────────────────────────────────
  --   • joined_at and games_played unchanged — queue position preserved.
  --   • status != 'left' guard: checked-out players are not pulled back.
  --   • NOT EXISTS in_progress: a cross-court pulled body is physically on a
  --     court. Unseating them mid-game corrupts their state and stalls the
  --     engine (see header). Their re-queue is endMatchAction's job.
  IF v_player_ids IS NOT NULL AND array_length(v_player_ids, 1) > 0 THEN
    UPDATE queue_entries qe
    SET    status = 'waiting'
    WHERE  qe.session_id = p_session_id
      AND  qe.player_id  = ANY(v_player_ids)
      AND  qe.status    != 'left'
      AND  NOT EXISTS (
             SELECT 1
             FROM   match_players mp
             JOIN   matches m ON m.id = mp.match_id
             WHERE  mp.player_id = qe.player_id
               AND  m.session_id = p_session_id
               AND  m.status     = 'in_progress'
           );
  END IF;

  -- ── Step 6: Delete the match ─────────────────────────────────────────────────
  DELETE FROM matches WHERE id = p_match_id;

  -- Return the authoritative FULL roster (from step 4) for broadcast — the
  -- caller needs to notify the pulled body that the draft they were reserved
  -- for is gone, even though their queue row was intentionally left alone.
  RETURN COALESCE(v_player_ids, '{}');
END;
$$;

GRANT EXECUTE ON FUNCTION clear_on_deck_match_atomic(UUID, UUID) TO service_role;
