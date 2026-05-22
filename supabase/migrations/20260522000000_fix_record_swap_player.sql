-- ============================================================
-- Migration: fix_record_swap_player RPC
-- ============================================================
-- Corrects the player roster of a COMPLETED match (data correction).
-- Unlike the on-deck swap RPCs, this targets historical matches after
-- the game has already finished and scores have been submitted.
--
-- Handles two cases atomically:
--   TEAM FLIP (in_player already in same match):
--     Both players swap team assignments. Neither player is removed from
--     the match — only their `team` column changes.
--     Use when: Alex was recorded on Team A but should be on Team B.
--
--   FULL REPLACEMENT (in_player from another completed match):
--     out_player is deleted from match_players; in_player is inserted
--     in the same team slot. queue_entries.games_played is adjusted.
--     Use when: Alex was recorded but Esmé actually played (injury sub).
--
-- What auto-corrects (no explicit update needed):
--   • v_session_leaderboard    — live view from match_players ✓
--   • session partnership cap  — fetchPartnershipCounts reads match_players ✓
--
-- What this RPC updates explicitly:
--   • match_players            — the root roster change
--   • queue_entries.games_played — ±1 for full replacement
--   • player_partnerships      — all-time win/loss/games deltas
--   • matches.is_mixed_level   — recomputed after roster change
--   • matches.origin           — 'auto' → 'modified' (same sticky rule as live swaps)
--   • v_alltime_leaderboard_mat — refresh_alltime_leaderboard()
--
-- Note: player_rivalries (all-time H2H) is NOT updated by this RPC.
-- Rivalries are used only for wrapped awards display, not matchmaking.
-- A future migration can add rival delta logic if needed.
--
-- Concurrent safety: FOR UPDATE locks on matches + match_players rows
-- serialize concurrent fix attempts on the same match.
--
-- Called from: src/app/actions/fix-player-record.ts
-- ============================================================

-- ── Helper: update player_partnerships in both directions ────────────
-- p_delta = +1 to add a game, -1 to remove a game.
-- For decrement: only updates existing rows (won't create a row at 0).
-- For increment: upserts — creates the row if it doesn't exist yet.
-- sessions_together / last_session_id / last_played_at are intentionally
-- left unchanged on decrement to avoid complex cross-session recomputation.
CREATE OR REPLACE FUNCTION _fix_record_partnership_delta(
  p_player_a   UUID,
  p_player_b   UUID,
  p_delta      INT,      -- +1 increment | -1 decrement
  p_won        BOOLEAN,  -- whether this partnership's team won
  p_session_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_delta > 0 THEN
    -- Upsert direction A→B
    INSERT INTO player_partnerships (
      player_id, partner_id,
      games_together, wins_together, losses_together,
      sessions_together, last_session_id, last_played_at, updated_at
    ) VALUES (
      p_player_a, p_player_b,
      1,
      CASE WHEN p_won THEN 1 ELSE 0 END,
      CASE WHEN NOT p_won THEN 1 ELSE 0 END,
      1, p_session_id, now(), now()
    )
    ON CONFLICT (player_id, partner_id) DO UPDATE SET
      games_together  = player_partnerships.games_together + 1,
      wins_together   = player_partnerships.wins_together   + (CASE WHEN p_won THEN 1 ELSE 0 END),
      losses_together = player_partnerships.losses_together + (CASE WHEN NOT p_won THEN 1 ELSE 0 END),
      updated_at      = now();

    -- Upsert direction B→A
    INSERT INTO player_partnerships (
      player_id, partner_id,
      games_together, wins_together, losses_together,
      sessions_together, last_session_id, last_played_at, updated_at
    ) VALUES (
      p_player_b, p_player_a,
      1,
      CASE WHEN p_won THEN 1 ELSE 0 END,
      CASE WHEN NOT p_won THEN 1 ELSE 0 END,
      1, p_session_id, now(), now()
    )
    ON CONFLICT (player_id, partner_id) DO UPDATE SET
      games_together  = player_partnerships.games_together + 1,
      wins_together   = player_partnerships.wins_together   + (CASE WHEN p_won THEN 1 ELSE 0 END),
      losses_together = player_partnerships.losses_together + (CASE WHEN NOT p_won THEN 1 ELSE 0 END),
      updated_at      = now();

  ELSE
    -- Decrement both directions (only update existing rows)
    UPDATE player_partnerships SET
      games_together  = GREATEST(0, games_together - 1),
      wins_together   = GREATEST(0, wins_together   - (CASE WHEN p_won THEN 1 ELSE 0 END)),
      losses_together = GREATEST(0, losses_together - (CASE WHEN NOT p_won THEN 1 ELSE 0 END)),
      updated_at      = now()
    WHERE (player_id = p_player_a AND partner_id = p_player_b)
       OR (player_id = p_player_b AND partner_id = p_player_a);
  END IF;
END;
$$;

-- ── Main RPC ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fix_record_swap_player(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_status  TEXT;
  v_match_score_a INT;
  v_match_score_b INT;
  v_out_team      TEXT;
  v_in_team       TEXT;    -- non-null only when in_player already in match
  v_is_team_flip  BOOLEAN;
  v_winning_team  TEXT;
  v_out_won       BOOLEAN;
  v_in_won        BOOLEAN;
  v_out_teammate  UUID;
  v_in_teammate   UUID;
  v_distinct_lvl  INT;
BEGIN
  -- Sanity: cannot swap with self
  IF p_out_player_id = p_in_player_id THEN
    RAISE EXCEPTION 'Cannot swap a player with themselves';
  END IF;

  -- ── Lock + verify match ─────────────────────────────────────────
  SELECT status, team_a_score, team_b_score
  INTO   v_match_status, v_match_score_a, v_match_score_b
  FROM   matches
  WHERE  id = p_match_id
  FOR UPDATE;

  IF v_match_status IS NULL THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;
  IF v_match_status != 'completed' THEN
    RAISE EXCEPTION 'MATCH_NOT_COMPLETED';
  END IF;

  -- ── Get out_player team (with row lock) ─────────────────────────
  SELECT team INTO v_out_team
  FROM   match_players
  WHERE  match_id = p_match_id AND player_id = p_out_player_id
  FOR UPDATE;

  IF v_out_team IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
  END IF;

  -- ── Detect team flip (in_player already in match) ───────────────
  SELECT team INTO v_in_team
  FROM   match_players
  WHERE  match_id = p_match_id AND player_id = p_in_player_id
  FOR UPDATE;

  v_is_team_flip := (v_in_team IS NOT NULL);

  -- ── Determine winning team ──────────────────────────────────────
  -- Completed matches always have scores, but guard for safety.
  v_winning_team := CASE
    WHEN v_match_score_a IS NOT NULL AND v_match_score_b IS NOT NULL
         AND v_match_score_a > v_match_score_b THEN 'a'
    WHEN v_match_score_a IS NOT NULL AND v_match_score_b IS NOT NULL
         AND v_match_score_b > v_match_score_a THEN 'b'
    ELSE NULL
  END;

  -- ── Find out_player's current teammate ──────────────────────────
  SELECT player_id INTO v_out_teammate
  FROM   match_players
  WHERE  match_id = p_match_id
    AND  team = v_out_team
    AND  player_id != p_out_player_id;

  v_out_won := (v_winning_team IS NOT NULL AND v_winning_team = v_out_team);

  -- ════════════════════════════════════════════════════════════════
  IF v_is_team_flip THEN
  -- ── CASE A: TEAM FLIP ──────────────────────────────────────────
  -- Both players already in the match — just swap team columns.

    -- Find in_player's current teammate
    SELECT player_id INTO v_in_teammate
    FROM   match_players
    WHERE  match_id = p_match_id
      AND  team = v_in_team
      AND  player_id != p_in_player_id;

    v_in_won := (v_winning_team IS NOT NULL AND v_winning_team = v_in_team);

    -- Swap team assignments
    UPDATE match_players SET team = v_out_team
    WHERE  match_id = p_match_id AND player_id = p_in_player_id;

    UPDATE match_players SET team = v_in_team
    WHERE  match_id = p_match_id AND player_id = p_out_player_id;

    -- Partnership deltas:
    --   REMOVE old pairs: (out_player ↔ out_teammate), (in_player ↔ in_teammate)
    --   ADD    new pairs: (out_player ↔ in_teammate),  (in_player ↔ out_teammate)
    IF v_out_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_out_player_id, v_out_teammate, -1, v_out_won, p_session_id);
    END IF;
    IF v_in_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_in_player_id,  v_in_teammate,  -1, v_in_won,  p_session_id);
    END IF;
    -- out_player moves to in_team → wins if in_team won
    IF v_in_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_out_player_id, v_in_teammate,  1, v_in_won,  p_session_id);
    END IF;
    -- in_player moves to out_team → wins if out_team won
    IF v_out_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_in_player_id,  v_out_teammate, 1, v_out_won, p_session_id);
    END IF;

    -- queue_entries.games_played: UNCHANGED (both were in the match)

  ELSE
  -- ── CASE B: FULL REPLACEMENT ───────────────────────────────────
  -- Remove out_player entirely; insert in_player in the same team slot.

    DELETE FROM match_players
    WHERE  match_id = p_match_id AND player_id = p_out_player_id;

    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_match_id, p_in_player_id, v_out_team);

    -- queue_entries.games_played: ±1
    UPDATE queue_entries
    SET    games_played = GREATEST(0, games_played - 1)
    WHERE  session_id = p_session_id AND player_id = p_out_player_id;

    UPDATE queue_entries
    SET    games_played = games_played + 1
    WHERE  session_id = p_session_id AND player_id = p_in_player_id;

    -- Partnership deltas:
    --   REMOVE: out_player ↔ out_teammate
    --   ADD:    in_player  ↔ out_teammate (takes over the same slot)
    IF v_out_teammate IS NOT NULL THEN
      PERFORM _fix_record_partnership_delta(p_out_player_id, v_out_teammate, -1, v_out_won, p_session_id);
      PERFORM _fix_record_partnership_delta(p_in_player_id,  v_out_teammate,  1, v_out_won, p_session_id);
    END IF;

  END IF;
  -- ════════════════════════════════════════════════════════════════

  -- ── Recompute is_mixed_level ────────────────────────────────────
  SELECT COUNT(DISTINCT pr.skill_level) INTO v_distinct_lvl
  FROM   match_players mp
  JOIN   profiles pr ON pr.id = mp.player_id
  WHERE  mp.match_id = p_match_id;

  UPDATE matches SET is_mixed_level = (v_distinct_lvl > 1)
  WHERE  id = p_match_id;

  -- ── Mark as modified (auto → modified only, never demotes manual) ──
  UPDATE matches SET origin = 'modified'
  WHERE  id = p_match_id AND origin = 'auto';

  -- ── Refresh all-time leaderboard materialized view ──────────────
  PERFORM refresh_alltime_leaderboard();

END;
$$;

-- Grant to service_role (used by the server action's admin client)
GRANT EXECUTE ON FUNCTION _fix_record_partnership_delta(UUID, UUID, INT, BOOLEAN, UUID)
  TO service_role;

GRANT EXECUTE ON FUNCTION fix_record_swap_player(UUID, UUID, UUID, UUID)
  TO service_role;
