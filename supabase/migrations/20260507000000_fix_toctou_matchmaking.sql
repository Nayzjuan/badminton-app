-- ============================================================
-- Migration: Fix TOCTOU race condition in matchmaking engine
-- ============================================================
-- Root cause (diagnosed 2026-05-07):
--   Two concurrent calls to create_match_with_players — from
--   different Vercel workers / Node.js processes — could both read
--   the same player as 'waiting' in the queue and commit them to
--   separate draft matches. Queue entries intentionally stay
--   'waiting' for drafts (BUG-001), so the second concurrent call
--   had no DB-visible signal that the player was already claimed.
--   The process-level engineRunningFor Set guard only serialises
--   within a single process and is ineffective in serverless.
--
-- Fix: three guards added inside the RPC, executed within the same
-- Postgres transaction:
--
--   Guard 0 — Pre-flight status check
--     Counts how many of the proposed players have a 'waiting'
--     queue_entries row in this session. If the count falls short
--     of the total player count (array_length), one or more
--     players have already left, been checked out, or changed
--     status since the engine read the queue. RETURN NULL early,
--     before acquiring any locks.
--
--   Guard 1 — Row-level lock (SELECT … FOR UPDATE)
--     Locks all target queue_entries rows in player_id order.
--     A second concurrent transaction blocks at this point until
--     the first commits — serialising access without a coarse
--     advisory lock on the whole session.
--     Ordering by player_id is required to guarantee consistent
--     lock acquisition order and prevent deadlocks when two
--     concurrent calls have partially overlapping player sets.
--     SET LOCAL lock_timeout = '3s' bounds worst-case wait time
--     so an unrelated operation (checkout, pause) is never
--     blocked indefinitely if the engine transaction stalls.
--
--   Guard 2 — Conflict check
--     After acquiring the locks (i.e., after any competing
--     transaction has committed), query match_players to verify
--     none of the proposed players are already in a pending or
--     in_progress match for this session.
--     If a conflict is found, RETURN NULL.  The TypeScript caller
--     (executeMatch) treats NULL as a graceful slot-skip rather
--     than an error, logs a warning, and returns { success:false }.
--
-- No changes to parameters, return type, or GRANT — fully
-- backwards-compatible replacement of the existing 10-arg overload.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_match_with_players(
  p_session_id      uuid,
  p_court_id        uuid,
  p_status          text,
  p_is_mixed_level  boolean,
  p_started_at      timestamptz,
  p_is_on_deck      boolean,
  p_team_a_ids      uuid[],
  p_team_b_ids      uuid[],
  p_origin          public.match_origin DEFAULT 'auto',
  p_is_published    boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_id      UUID;
  v_all_ids       UUID[];
  v_waiting_count INT;
  v_conflict      INT;
BEGIN
  v_all_ids := p_team_a_ids || p_team_b_ids;

  -- ── Bound lock-acquisition wait time ──────────────────────────────────────
  -- Prevents unrelated queue operations (checkout, pause, score submission)
  -- from blocking indefinitely if this transaction stalls under load.
  -- 3 s is generous for the few INSERTs/UPDATEs that follow; a timed-out
  -- lock raises lock_timeout exception, which rolls back the transaction
  -- and surfaces as an rpcError in the TypeScript caller.
  SET LOCAL lock_timeout = '3s';

  -- ── Guard 0: Pre-flight status check ─────────────────────────────────────
  -- Verify that every proposed player currently has a 'waiting'
  -- queue_entries row in this session.  If the count falls short, at
  -- least one player has left the queue, been checked out, or changed
  -- status since the engine read the snapshot.  Return NULL early so the
  -- engine skips this slot — no lock acquisition needed.
  --
  -- This makes the DB-level guard self-contained: it does not rely solely
  -- on the TypeScript engine's read path to enforce the 'waiting' invariant.
  SELECT COUNT(*)::INT INTO v_waiting_count
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_all_ids)
    AND  status     = 'waiting';

  IF v_waiting_count != array_length(v_all_ids, 1) THEN
    RETURN NULL;
  END IF;

  -- ── Guard 1: Row-level lock ────────────────────────────────────────────
  -- Lock the queue_entries rows for every proposed player in a consistent
  -- (player_id) order so that two concurrent transactions locking
  -- overlapping player sets always acquire locks in the same sequence,
  -- eliminating the possibility of deadlock.
  --
  -- A second concurrent call for any of the same players will block here
  -- until the first transaction commits or rolls back.  Once unblocked,
  -- Guard 2 below will detect the conflict and return NULL.
  PERFORM 1
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_all_ids)
  ORDER BY player_id
  FOR UPDATE;

  -- ── Guard 2: Conflict check ────────────────────────────────────────────
  -- After the lock is held we know no concurrent transaction is mid-flight
  -- for these players.  Now confirm none are already committed to another
  -- active match in this session.
  --
  -- "Active" = pending or in_progress.  Completed / cancelled matches are
  -- irrelevant — a player returning from a finished game is fine to rebook.
  --
  -- Returns NULL on conflict; the TypeScript executeMatch handler logs a
  -- warning and treats this as a natural slot failure (no error surfaced).
  SELECT COUNT(*)::INT INTO v_conflict
  FROM   match_players mp
  JOIN   matches       m  ON m.id = mp.match_id
  WHERE  mp.player_id  = ANY(v_all_ids)
    AND  m.session_id  = p_session_id
    AND  m.status      IN ('pending', 'in_progress');

  IF v_conflict > 0 THEN
    RETURN NULL;
  END IF;

  -- ── Step a: Create the match row ───────────────────────────────────────
  INSERT INTO matches (
    session_id, court_id, status, is_mixed_level,
    started_at, origin, is_published
  )
  VALUES (
    p_session_id, p_court_id, p_status::match_status, p_is_mixed_level,
    p_started_at, p_origin, p_is_published
  )
  RETURNING id INTO v_match_id;

  -- ── Step b: Insert team A players ─────────────────────────────────────
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';

  -- ── Step c: Insert team B players ─────────────────────────────────────
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  -- ── Step d: Update queue statuses ─────────────────────────────────────
  --   Direct court match  → always 'playing'
  --   Published on-deck   → 'on_deck'  (alert fires — organizer approved)
  --   Draft (unpublished) → no update  (players stay 'waiting'; alert suppressed)
  IF NOT p_is_on_deck THEN
    UPDATE queue_entries
    SET    status = 'playing'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_all_ids);
  ELSIF p_is_published THEN
    UPDATE queue_entries
    SET    status = 'on_deck'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(v_all_ids);
  END IF;

  -- ── Step e: Mark court as in_use ──────────────────────────────────────
  IF NOT p_is_on_deck AND p_court_id IS NOT NULL THEN
    UPDATE courts
    SET    status = 'in_use'::court_status
    WHERE  id = p_court_id;
  END IF;

  RETURN v_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_match_with_players(
  uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], public.match_origin, boolean
) TO authenticated, service_role;
