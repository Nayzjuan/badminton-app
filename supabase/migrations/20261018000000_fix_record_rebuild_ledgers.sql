-- ============================================================
-- fix_record_swap_player: stop partnership deltas; rebuild ledgers
-- ============================================================
-- WHY
--
-- `_fix_record_partnership_delta` still does
--   ON CONFLICT (player_id, partner_id)
-- but `player_partnerships` has been PRIMARY KEY (club_id, player_id, partner_id)
-- since 20260630000002. Every Fix that reaches a partnership +1 path raises
-- 42P10 and rolls back — verified on production 2026-10-18. The INSERT also
-- omits club_id (NOT NULL), so a naive conflict-target patch would fail next.
--
-- Session close already treats `refresh_cross_session_stats` as the absolute
-- source of truth for partnerships AND rivalries (20260812100000). Fix kept
-- a second, drifted delta path and intentionally skipped rivalries.
--
-- WHAT
--
-- 1. Rewrite fix_record_swap_player: keep roster / queue / is_mixed_level /
--    audit events; drop all _fix_record_partnership_delta calls; end with
--    refresh_cross_session_stats then refresh_alltime_leaderboard.
-- 2. Drop the broken helper so nothing can call it again.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fix_record_swap_player(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID,
  p_actor_id      UUID DEFAULT NULL,
  p_actor_name    TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_match_status  TEXT;
  v_out_team      TEXT;
  v_in_team       TEXT;
  v_is_team_flip  BOOLEAN;
  v_distinct_lvl  INT;
BEGIN
  IF p_out_player_id = p_in_player_id THEN
    RAISE EXCEPTION 'Cannot swap a player with themselves';
  END IF;

  SELECT status
  INTO   v_match_status
  FROM   matches
  WHERE  id = p_match_id
  FOR UPDATE;

  IF v_match_status IS NULL THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;
  IF v_match_status != 'completed' THEN
    RAISE EXCEPTION 'MATCH_NOT_COMPLETED';
  END IF;

  SELECT team INTO v_out_team
  FROM   match_players
  WHERE  match_id = p_match_id AND player_id = p_out_player_id
  FOR UPDATE;

  IF v_out_team IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
  END IF;

  SELECT team INTO v_in_team
  FROM   match_players
  WHERE  match_id = p_match_id AND player_id = p_in_player_id
  FOR UPDATE;

  v_is_team_flip := (v_in_team IS NOT NULL);

  IF v_is_team_flip THEN
    -- Team flip: swap team columns only. games_played unchanged.
    UPDATE match_players
    SET    team = v_out_team
    WHERE  match_id = p_match_id AND player_id = p_in_player_id;

    UPDATE match_players
    SET    team = v_in_team
    WHERE  match_id = p_match_id AND player_id = p_out_player_id;
  ELSE
    -- Full replacement: out leaves, in takes the same team slot.
    DELETE FROM match_players
    WHERE  match_id = p_match_id AND player_id = p_out_player_id;

    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_match_id, p_in_player_id, v_out_team);

    UPDATE queue_entries
    SET    games_played = GREATEST(0, games_played - 1)
    WHERE  session_id = p_session_id AND player_id = p_out_player_id;

    UPDATE queue_entries
    SET    games_played = games_played + 1
    WHERE  session_id = p_session_id AND player_id = p_in_player_id;
  END IF;

  -- Recompute mixed-level from the post-correction roster.
  SELECT COUNT(DISTINCT pr.skill_level) INTO v_distinct_lvl
  FROM   match_players mp
  JOIN   profiles pr ON pr.id = mp.player_id
  WHERE  mp.match_id = p_match_id;

  UPDATE matches
  SET    is_mixed_level = (v_distinct_lvl > 1)
  WHERE  id = p_match_id;

  -- Audit
  IF v_is_team_flip THEN
    PERFORM record_match_event(
      p_match_id, p_session_id, 'team_flip', 'post_completion',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(
        jsonb_build_object(
          'player_id', p_out_player_id,
          'player_name', _player_name(p_out_player_id),
          'from_team', v_out_team,
          'to_team', v_in_team
        ),
        jsonb_build_object(
          'player_id', p_in_player_id,
          'player_name', _player_name(p_in_player_id),
          'from_team', v_in_team,
          'to_team', v_out_team
        )
      )
    );
  ELSE
    PERFORM record_match_event(
      p_match_id, p_session_id, 'roster_swap', 'post_completion',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_out_player_id,
        'out_player_name', _player_name(p_out_player_id),
        'in_player_id', p_in_player_id,
        'in_player_name', _player_name(p_in_player_id),
        'team', v_out_team
      ))
    );
  END IF;

  -- Absolute rebuild of partnerships + rivalries from match history (club-scoped).
  PERFORM refresh_cross_session_stats(p_session_id);
  PERFORM refresh_alltime_leaderboard();
END;
$$;

GRANT EXECUTE ON FUNCTION public.fix_record_swap_player(UUID, UUID, UUID, UUID, UUID, TEXT)
  TO service_role;

-- Broken since club-scoped PK; Fix no longer calls it.
DROP FUNCTION IF EXISTS public._fix_record_partnership_delta(UUID, UUID, INT, BOOLEAN, UUID);
