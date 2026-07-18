-- ============================================================================
-- Harden the first_to_100 claim in compute_session_wrapped()
-- ============================================================================
-- Before: when the club_milestones slot was empty, the crosser being processed
-- simply INSERTed themselves as the holder and won the award. That trusts
-- "empty slot == nobody has ever earned it" — but the slot can be empty because
-- the rightful holder's row was lost (the identity-merge cascade that caused the
-- 2026-07-18 mis-award; see 20260718120000). A LATER crosser then wrongly
-- claimed a "First to 100" that historically wasn't theirs.
--
-- After: an empty slot triggers a reconstruction of the TRUE historical first
-- crosser from match history (cumulative completed games per player; earliest
-- 100th-game crossing wins, match_id tiebreaker — the same rule as the backfill
-- and the repair). We seed the ledger for that true holder (self-healing after
-- any future loss) and award only the player who genuinely is that holder.
--
-- Applied via anchor-validated text substitution on the live function body, so
-- it aborts loudly (rather than corrupting the 44 KB function) if the claim
-- block's shape has changed. Idempotent-ish: re-running finds the new block, not
-- the old anchor, so it aborts with "found 0" — intended (nothing to do).
-- ============================================================================

DO $mig$
DECLARE
  v_def text;
  v_search text := $anc$IF v_milestone_holder IS NULL THEN INSERT INTO club_milestones(club_id,milestone,player_id,session_id) VALUES (v_club_id,'first_to_100_games',v_player.player_id,p_session_id) ON CONFLICT (club_id,milestone) DO NOTHING RETURNING player_id INTO v_milestone_holder; END IF;$anc$;
  v_replace text := $rep$IF v_milestone_holder IS NULL THEN SELECT cr.player_id INTO v_milestone_holder FROM (SELECT cu.player_id, cu.completed_at, cu.match_id FROM (SELECT mp.player_id, m.completed_at, m.id AS match_id, ROW_NUMBER() OVER (PARTITION BY mp.player_id ORDER BY m.completed_at, m.id) AS gn FROM matches m JOIN sessions s ON s.id=m.session_id JOIN match_players mp ON mp.match_id=m.id WHERE m.status='completed' AND m.completed_at IS NOT NULL AND s.club_id=v_club_id) cu WHERE cu.gn=100) cr ORDER BY cr.completed_at ASC, cr.match_id ASC LIMIT 1; IF v_milestone_holder IS NOT NULL THEN INSERT INTO club_milestones(club_id,milestone,player_id,session_id) VALUES (v_club_id,'first_to_100_games',v_milestone_holder,CASE WHEN v_milestone_holder=v_player.player_id THEN p_session_id ELSE NULL END) ON CONFLICT (club_id,milestone) DO NOTHING; SELECT player_id INTO v_milestone_holder FROM club_milestones WHERE club_id=v_club_id AND milestone='first_to_100_games'; END IF; END IF;$rep$;
  v_occ int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname='compute_session_wrapped' AND pronamespace='public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'compute_session_wrapped() not found — aborting.';
  END IF;

  v_occ := (length(v_def) - length(replace(v_def, v_search, ''))) / length(v_search);
  IF v_occ <> 1 THEN
    RAISE EXCEPTION 'first_to_100 claim anchor not found exactly once (found %). Aborting.', v_occ;
  END IF;

  v_def := replace(v_def, v_search, v_replace);
  EXECUTE v_def;
END $mig$;
