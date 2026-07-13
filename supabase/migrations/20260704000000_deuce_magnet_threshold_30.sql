-- ============================================================
-- Deuce Magnet threshold fix: 20-20 → 30-30
-- ============================================================
-- Scoring in this app is sudden-death up to MAX_BADMINTON_SCORE=31
-- (games are NOT capped at the traditional 21/win-by-2), so a 20-20
-- tie is a routine mid-game state, not drama. The real tension point
-- is 30-30 (sudden death: next point wins, hard cap at 31).
--
-- compute_session_wrapped() checked `team_a_score>=20 AND
-- team_b_score>=20` for the deuce_magnet award. This migration
-- redefines the function with that threshold raised to 30, leaving
-- every other award computation untouched.
--
-- Implementation note: rather than hand-retyping the ~12KB function
-- body (risk of a transcription error in an otherwise-correct
-- function), this fetches the live definition and applies a scoped
-- text substitution on the exact `team_a_score>=20 AND
-- team_b_score>=20` pattern (verified to occur in exactly the two
-- deuce_magnet sites, nowhere else in the function) before
-- re-executing it as CREATE OR REPLACE.
-- ============================================================

DO $$
DECLARE
  v_def text;
  v_search text := 'team_a_score>=20 AND m.team_b_score>=20';
  v_occurrences int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'compute_session_wrapped' AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'compute_session_wrapped() not found — aborting to avoid a silent no-op.';
  END IF;

  -- Plain substring count (avoids regex-escaping pitfalls): occurrences =
  -- (length before) minus (length after stripping every match), divided by
  -- match length.
  v_occurrences := (length(v_def) - length(replace(v_def, v_search, ''))) / length(v_search);

  IF v_occurrences <> 2 THEN
    RAISE EXCEPTION 'Expected exactly 2 occurrences of the deuce 20-20 pattern, found %. Aborting — function shape has changed, re-verify before reapplying.',
      v_occurrences;
  END IF;

  v_def := replace(v_def, v_search, 'team_a_score>=30 AND m.team_b_score>=30');

  EXECUTE v_def;
END $$;
