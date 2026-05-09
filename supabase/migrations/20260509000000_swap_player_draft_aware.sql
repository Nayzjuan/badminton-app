-- ============================================================
-- Migration: Make swap_player_in_match draft-aware
-- ============================================================
-- Problem (diagnosed 2026-05-09):
--   The TypeScript action (swap-player.ts) already fetches
--   match.is_published and passes p_is_published to this RPC,
--   but the DB function signature had no such parameter, so
--   PostgREST raised a "function does not exist" error on every
--   swap attempt against a draft match.
--
--   Additionally, step c unconditionally promoted the incoming
--   player to 'on_deck', which fires the ON_DECK_WARNING push
--   alert even for unpublished drafts — alerting players about
--   a match the organizer hasn't approved yet.
--
-- Fix:
--   Add p_is_published BOOLEAN DEFAULT true so existing callers
--   that omit the parameter keep the old 'on_deck' behaviour.
--   Step c is now conditional: skip the queue promotion entirely
--   when the match is an unpublished draft (p_is_published=false),
--   leaving the incoming player's queue_entries.status='waiting'.
--   The player is promoted to 'on_deck' later when the organizer
--   calls publishMatchAction, consistent with the engine's flow.
--
-- Backwards-compatible: the old 5-argument overload is dropped
-- (CREATE OR REPLACE replaces the signature), but the new 6th
-- parameter defaults to true, so any caller that omits it gets
-- the pre-draft behaviour unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION swap_player_in_match(
  p_match_id      UUID,
  p_out_player_id UUID,
  p_in_player_id  UUID,
  p_session_id    UUID,
  p_team          TEXT,
  p_is_published  BOOLEAN DEFAULT true
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_distinct_levels INT;
BEGIN
  -- Step a: Remove outgoing player from this match
  DELETE FROM match_players
  WHERE match_id = p_match_id
    AND player_id = p_out_player_id;

  -- Step b: Insert incoming player on the same team
  INSERT INTO match_players (match_id, player_id, team)
  VALUES (p_match_id, p_in_player_id, p_team);

  -- Step c: Promote incoming player in the queue.
  --   Published match  → 'on_deck'  (alert fires immediately)
  --   Unpublished draft → no update  (player stays 'waiting'; alert
  --                        fires later when organizer publishes)
  IF p_is_published THEN
    UPDATE queue_entries
    SET status = 'on_deck'
    WHERE session_id = p_session_id
      AND player_id  = p_in_player_id;
  END IF;

  -- Step d: Return outgoing player to the waiting queue
  UPDATE queue_entries
  SET status = 'waiting'
  WHERE session_id = p_session_id
    AND player_id  = p_out_player_id;

  -- Step e: Recompute is_mixed_level from the current post-swap roster
  SELECT COUNT(DISTINCT p.skill_level) INTO v_distinct_levels
  FROM  match_players mp
  JOIN  profiles p ON p.id = mp.player_id
  WHERE mp.match_id = p_match_id;

  UPDATE matches
  SET is_mixed_level = (v_distinct_levels > 1)
  WHERE id = p_match_id;
END;
$$;

-- Drop the old 5-argument overload entirely so the pre-fix version (which
-- unconditionally promotes to 'on_deck') cannot be called by any path.
-- IF EXISTS makes this safe on fresh environments that never ran the original
-- migration (e.g., new branches, test DBs spun up with all migrations at once).
DROP FUNCTION IF EXISTS swap_player_in_match(UUID, UUID, UUID, UUID, TEXT);

GRANT EXECUTE ON FUNCTION swap_player_in_match(UUID, UUID, UUID, UUID, TEXT, BOOLEAN)
  TO service_role;
