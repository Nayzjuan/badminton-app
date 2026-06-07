-- ============================================================
-- Migration: Cross-Court Diversity Drafting — held drafts
-- ============================================================
-- See CROSS_COURT_DRAFTING_PLAN.md. The engine may pre-build an on-deck
-- "held" draft: 3 waiting players + 1 player still PLAYING on another court
-- (the "pulled body"), to force match diversity. A held draft only becomes
-- promotable once the pulled body finishes its game and rests one match.
--
-- This migration adds:
--   1. Four columns on `matches` to represent a held draft + its readiness.
--   2. A partial index for the readiness recompute / promotion paths.
--   3. create_held_cross_court_match — a sibling of create_match_with_players
--      that tolerates exactly ONE status='playing' body, leaving the strict
--      "all waiting" invariant of create_match_with_players untouched.
-- ============================================================

-- ── 1. Columns on `matches` ──────────────────────────────────────────────────
ALTER TABLE public.matches
  -- The pulled (still-playing) bodies. Empty '{}' = a normal draft; exactly one
  -- element = a held cross-court draft. This is the UI/promotion flag source.
  ADD COLUMN IF NOT EXISTS pulled_player_ids uuid[] NOT NULL DEFAULT '{}',
  -- The live (in_progress) match the pulled body is finishing. ON DELETE SET NULL
  -- so a held draft self-downgrades rather than erroring if the source match is
  -- ever purged (R3-B: recomputeHeldReadiness cancels a held draft whose source
  -- became null/missing, so this can never silently lock the draft in "Holding").
  ADD COLUMN IF NOT EXISTS pulled_from_match_id uuid
    REFERENCES public.matches(id) ON DELETE SET NULL,
  -- Stamped (not live-computed) when readiness is first achieved. Once stamped,
  -- the promotion path may promote the held draft.
  ADD COLUMN IF NOT EXISTS held_ready_at timestamptz,
  -- Robust/indexable "is this a held draft?" flag. cardinality(...) > 0 avoids the
  -- three-valued logic of array_length(...,1) IS NOT NULL on an empty array (R3-2).
  ADD COLUMN IF NOT EXISTS is_held boolean
    GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0) STORED;

-- ── 2. Index for held-draft scans (readiness recompute + promotion filter) ───
CREATE INDEX IF NOT EXISTS idx_matches_held_pending
  ON public.matches (session_id)
  WHERE is_held = true AND status = 'pending';

-- ── 3. create_held_cross_court_match ─────────────────────────────────────────
-- Mirrors the TOCTOU pattern of create_match_with_players (20260507000000) with
-- cross-court adaptations:
--   • Guard 0 is SPLIT: the 3 waiting members must be 'waiting'; the pulled body
--     must be 'playing' AND a member of the in_progress source match.
--   • Guard 1 (FOR UPDATE) locks ONLY the 3 waiting members — never the pulled
--     body's row (M-6): it is mid-game and endMatchAction will update it when its
--     match finishes; locking it would needlessly block that completion, and the
--     lock buys no consistency the RPC needs (the "still playing" check reads the
--     `matches`/`match_players`/`queue_entries` rows non-blockingly).
--   • Guard 1b (NEW): reservation — reject if the pulled body is already named in
--     another pending held draft (no body in two held drafts).
--   • The 3 waiting members are reserved as 'drafted'; the pulled body's status is
--     NEVER mutated — it stays 'playing' and finishes its game naturally.
-- Returns NULL on any guard (graceful slot-skip in executeHeldMatch).
CREATE OR REPLACE FUNCTION public.create_held_cross_court_match(
  p_session_id           uuid,
  p_is_mixed_level       boolean,
  p_team_a_ids           uuid[],
  p_team_b_ids           uuid[],
  p_pulled_player_id     uuid,
  p_pulled_from_match_id uuid,
  p_origin               public.match_origin DEFAULT 'auto'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_match_id      UUID;
  v_all_ids       UUID[];
  v_waiting_ids   UUID[];
  v_waiting_count INT;
  v_pulled_ok     INT;
  v_held_conflict INT;
  v_conflict      INT;
BEGIN
  v_all_ids := p_team_a_ids || p_team_b_ids;

  -- The 3 waiting members = all four minus the pulled body.
  SELECT ARRAY(SELECT unnest(v_all_ids) EXCEPT SELECT p_pulled_player_id)
  INTO   v_waiting_ids;

  -- Defensive: exactly one pulled body, exactly three waiting members.
  IF p_pulled_player_id = ANY(v_waiting_ids)
     OR array_length(v_waiting_ids, 1) IS DISTINCT FROM 3 THEN
    RETURN NULL;
  END IF;

  SET LOCAL lock_timeout = '3s';

  -- ── Guard 0a: the 3 waiting members must all be 'waiting' ──────────────────
  SELECT COUNT(*)::INT INTO v_waiting_count
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_waiting_ids)
    AND  status     = 'waiting';

  IF v_waiting_count != array_length(v_waiting_ids, 1) THEN
    RETURN NULL;
  END IF;

  -- ── Guard 0b: the pulled body must be 'playing' AND a member of the
  --    in_progress source match (non-locking read — M-6) ─────────────────────
  SELECT COUNT(*)::INT INTO v_pulled_ok
  FROM   match_players mp
  JOIN   matches       m ON m.id = mp.match_id
  JOIN   queue_entries q ON q.player_id = mp.player_id AND q.session_id = m.session_id
  WHERE  mp.player_id = p_pulled_player_id
    AND  mp.match_id  = p_pulled_from_match_id
    AND  m.session_id = p_session_id
    AND  m.status     = 'in_progress'
    AND  q.status     = 'playing';

  IF v_pulled_ok = 0 THEN
    RETURN NULL;
  END IF;

  -- ── Guard 1b: reservation — pulled body not already in another held draft ──
  SELECT COUNT(*)::INT INTO v_held_conflict
  FROM   matches
  WHERE  session_id = p_session_id
    AND  status     = 'pending'
    AND  p_pulled_player_id = ANY(pulled_player_ids);

  IF v_held_conflict > 0 THEN
    RETURN NULL;
  END IF;

  -- ── Guard 1: Row-level lock — ONLY the 3 waiting members (M-6) ─────────────
  PERFORM 1
  FROM   queue_entries
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_waiting_ids)
  ORDER BY player_id
  FOR UPDATE;

  -- ── Guard 2: the 3 waiting members not already in a pending/in_progress
  --    match (the pulled body is exempt — it IS in its in_progress match) ─────
  SELECT COUNT(*)::INT INTO v_conflict
  FROM   match_players mp
  JOIN   matches       m ON m.id = mp.match_id
  WHERE  mp.player_id = ANY(v_waiting_ids)
    AND  m.session_id = p_session_id
    AND  m.status     IN ('pending', 'in_progress');

  IF v_conflict > 0 THEN
    RETURN NULL;
  END IF;

  -- ── Create the held draft: pending, unpublished, no court ──────────────────
  -- is_published=false → inherits the matches_select_draft_firewall RLS policy,
  -- so players/TV never see it until the organizer publishes (L-3).
  INSERT INTO matches (
    session_id, court_id, status, is_mixed_level, started_at,
    origin, is_published, pulled_player_ids, pulled_from_match_id, held_ready_at
  )
  VALUES (
    p_session_id, NULL, 'pending'::match_status, p_is_mixed_level, NULL,
    p_origin, false, ARRAY[p_pulled_player_id], p_pulled_from_match_id, NULL
  )
  RETURNING id INTO v_match_id;

  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_a_ids), 'a';

  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_match_id, unnest(p_team_b_ids), 'b';

  -- ── Reserve the 3 waiting members as 'drafted'. The pulled body's status is
  --    NEVER touched — it stays 'playing' and finishes its game naturally. ────
  UPDATE queue_entries
  SET    status = 'drafted'::queue_status
  WHERE  session_id = p_session_id
    AND  player_id  = ANY(v_waiting_ids);

  RETURN v_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_held_cross_court_match(
  uuid, boolean, uuid[], uuid[], uuid, uuid, public.match_origin
) TO authenticated, service_role;
