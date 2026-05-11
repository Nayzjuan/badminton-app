-- ============================================================
-- Migration: Draft Mode — Bug Fixes (BUG-001, BUG-004)
-- ============================================================
--
-- BUG-001 (P0): create_match_with_players unconditionally sets
--   queue_entries.status = 'on_deck' for all 4 players, even for
--   engine drafts (is_published=false). This triggers useMatchAlerts
--   ON_DECK_WARNING audio + push notification before the organizer
--   has published the match — defeating the entire Draft Mode contract.
--
--   Fix: add p_is_published parameter. Queue update is skipped when
--   creating a draft (p_is_on_deck=true AND p_is_published=false).
--   Players remain 'waiting' until publishMatchAction promotes them.
--
-- BUG-001 (swap path): swap_player_in_match step c always sets the
--   incoming player to 'on_deck', including when the target match is
--   an unpublished draft.
--
--   Fix: add p_is_published parameter (DEFAULT true for backwards
--   compat). Step c is skipped when p_is_published=false.
--
-- BUG-004 (P0 risk): Draft visibility was enforced only at the
--   application layer (3 query firewalls in TypeScript). A player with
--   DevTools access or a stale client bundle could query matches
--   directly and see draft rows.
--
--   Fix: RESTRICTIVE RLS policy on matches SELECT. Pending rows with
--   is_published=false are invisible to non-organizers regardless of
--   which code path queries the table.
--
-- BUG-002 and BUG-003 are TypeScript-only fixes (no schema changes).
-- ============================================================


-- ── BUG-001 Fix A: create_match_with_players ─────────────────
-- Adds p_is_published (DEFAULT false) so the caller controls whether
-- the draft queue-update is suppressed.
--
-- Behaviour matrix for Step d:
--   p_is_on_deck=false               → UPDATE to 'playing'  (direct court match)
--   p_is_on_deck=true, published=true → UPDATE to 'on_deck' (published on-deck)
--   p_is_on_deck=true, published=false → (no-op)           (draft — alert suppressed)
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
  v_match_id UUID;
BEGIN
  -- Step a: Create the match row — now writes is_published explicitly
  INSERT INTO matches (session_id, court_id, status, is_mixed_level, started_at, origin, is_published)
  VALUES (p_session_id, p_court_id, p_status::match_status, p_is_mixed_level, p_started_at, p_origin, p_is_published)
  RETURNING id INTO v_match_id;

  -- Step b: Insert team A players
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';

  -- Step c: Insert team B players
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  -- Step d: Update queue statuses.
  --   Direct court match  → always 'playing'
  --   Published on-deck   → 'on_deck'  (alert fires — organizer approved)
  --   Draft (unpublished) → no update  (players stay 'waiting'; alert suppressed)
  IF NOT p_is_on_deck THEN
    UPDATE queue_entries
    SET    status = 'playing'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(p_team_a_ids || p_team_b_ids);
  ELSIF p_is_published THEN
    UPDATE queue_entries
    SET    status = 'on_deck'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = ANY(p_team_a_ids || p_team_b_ids);
  END IF;

  -- Step e: Mark court as in_use (only for live, court-assigned matches)
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


-- ── BUG-001 Fix B: swap_player_in_match ──────────────────────
-- Adds p_is_published (DEFAULT true — preserves existing behaviour
-- for all published-match swaps that don't pass this argument).
-- Step c is skipped for draft swaps so the incoming player stays
-- 'waiting' and the ON_DECK_WARNING alert is not triggered.
--
-- Drop the old 5-arg overload first. PostgreSQL does NOT replace a
-- function when the parameter list changes — it creates a new
-- overloaded version alongside the old one. Any caller using
-- positional args would silently hit the unpatched 5-arg version.
DROP FUNCTION IF EXISTS public.swap_player_in_match(uuid, uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.swap_player_in_match(
  p_match_id       uuid,
  p_out_player_id  uuid,
  p_in_player_id   uuid,
  p_session_id     uuid,
  p_team           text,
  p_is_published   boolean DEFAULT true
)
RETURNS void
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

  -- Step c: Mark incoming player as on_deck — only for published matches.
  --   Draft swaps leave the incoming player in 'waiting' so no alert fires.
  --   publishMatchAction will promote all 4 players to 'on_deck' atomically.
  IF p_is_published THEN
    UPDATE queue_entries
    SET    status = 'on_deck'::queue_status
    WHERE  session_id = p_session_id
      AND  player_id  = p_in_player_id;
  END IF;

  -- Step d: Return outgoing player to the waiting queue (always)
  UPDATE queue_entries
  SET    status = 'waiting'::queue_status
  WHERE  session_id = p_session_id
    AND  player_id  = p_out_player_id;

  -- Step e: Recompute is_mixed_level from the current post-swap roster
  SELECT COUNT(DISTINCT p.skill_level) INTO v_distinct_levels
  FROM   match_players mp
  JOIN   profiles p ON p.id = mp.player_id
  WHERE  mp.match_id = p_match_id;

  UPDATE matches
  SET    is_mixed_level = (v_distinct_levels > 1)
  WHERE  id = p_match_id;

  -- Step f: Promote origin auto → modified (sticky rule)
  UPDATE matches
  SET    origin = 'modified'::public.match_origin
  WHERE  id     = p_match_id
    AND  origin = 'auto'::public.match_origin;
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_player_in_match(
  uuid, uuid, uuid, uuid, text, boolean
) TO authenticated, service_role;


-- ── BUG-004 Fix: Restrictive RLS on matches SELECT ───────────
-- RESTRICTIVE policies are ANDed with all permissive policies —
-- every RESTRICTIVE policy must pass for a row to be visible.
-- This means even if an existing permissive policy allows a player
-- to SELECT all matches in their session, this policy will still
-- block pending rows where is_published=false.
--
-- Organizers are exempt so the Drafts panel continues to work.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE  tablename  = 'matches'
      AND  policyname = 'matches_select_draft_firewall'
  ) THEN
    CREATE POLICY "matches_select_draft_firewall"
      ON  public.matches
      AS  RESTRICTIVE
      FOR SELECT
      USING (
        status::text != 'pending'
        OR  is_published = true
        OR  is_session_organizer(session_id)
      );
  END IF;
END;
$$;
