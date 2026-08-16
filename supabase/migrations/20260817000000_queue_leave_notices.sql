-- ============================================================
-- queue_leave_notices
--
-- 1. checkout_player_cleanup_drafts: keep the hotfix contract
--    (restore remaining players only when status = 'drafted')
--    and document why. A held draft's pulled body stays
--    'playing' / 'on_deck' and must not be written to 'waiting'.
--    CREATE OR REPLACE -- do not DROP (ACL is service_role only).
--
-- 2. queue_entries.paused_at: when the organizer paused the
--    player. NULL when not paused. Backfill currently-paused
--    rows to now() so the 15-minute reminder clock starts at
--    apply time (the real pause start is unrecoverable).
--
-- 3. Recreate v_queue_full_with_wait_time to expose paused_at
--    as a trailing column (CREATE OR REPLACE can add columns
--    only at the end).
-- ============================================================

CREATE OR REPLACE FUNCTION public.checkout_player_cleanup_drafts(
  p_session_id uuid,
  p_player_id uuid
)
RETURNS TABLE(cancelled_match_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_match_id uuid;
  v_player_ids uuid[];
BEGIN
  FOR v_match_id IN
    SELECT m.id
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id
      AND m.status = 'pending'
      AND m.is_published = false
      AND mp.player_id = p_player_id
    FOR UPDATE OF m
  LOOP
    SELECT ARRAY_AGG(player_id) INTO v_player_ids
    FROM match_players
    WHERE match_id = v_match_id AND player_id != p_player_id;

    DELETE FROM match_players
    WHERE match_id = v_match_id AND player_id = p_player_id;

    IF (SELECT COUNT(*) FROM match_players WHERE match_id = v_match_id) < 4 THEN
      UPDATE matches
      SET status = 'cancelled', completed_at = now()
      WHERE id = v_match_id;

      -- drafted-only restore. A held draft seats 3 waiters + 1
      -- still-playing pulled body. Writing 'waiting' onto that
      -- body unseats them mid-game (the defect
      -- partitionCancelRestore / 20260812000000 exist to stop).
      -- status = 'drafted' already excludes playing/on_deck/left;
      -- the NOT IN is belt-and-suspenders so a later status
      -- rename cannot reopen the hole.
      IF v_player_ids IS NOT NULL THEN
        UPDATE queue_entries
        SET status = 'waiting'
        WHERE session_id = p_session_id
          AND player_id = ANY(v_player_ids)
          AND status = 'drafted'
          AND status NOT IN ('playing', 'on_deck');
      END IF;

      cancelled_match_id := v_match_id;
      RETURN NEXT;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

-- ACL must stay exactly postgres + service_role. CREATE OR REPLACE
-- keeps grants; this re-asserts them in case a future DROP sneaks in.
GRANT EXECUTE ON FUNCTION public.checkout_player_cleanup_drafts(uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.checkout_player_cleanup_drafts(uuid, uuid) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.queue_entries
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

UPDATE public.queue_entries
SET paused_at = now()
WHERE is_paused = true
  AND paused_at IS NULL;

CREATE OR REPLACE VIEW public.v_queue_full_with_wait_time AS
SELECT
  qe.id,
  qe.session_id,
  qe.player_id,
  qe.joined_at,
  qe.games_played,
  qe.status,
  qe.position,
  qe.is_paused,
  qe.created_at,
  p.display_name,
  p.skill_level,
  public.skill_level_to_int(p.skill_level) AS skill_level_int,
  EXTRACT(EPOCH FROM now() - qe.joined_at) / 60 AS wait_minutes,
  CASE
    WHEN (EXTRACT(EPOCH FROM now() - qe.joined_at) / 60) > 20 THEN true
    ELSE false
  END AS is_bottleneck,
  CASE qe.status
    WHEN 'on_deck'  THEN 0
    WHEN 'drafted'  THEN 1
    ELSE                 2
  END AS status_priority,
  qe.paused_at
FROM public.queue_entries qe
JOIN public.profiles p ON p.id = qe.player_id
WHERE qe.status IN ('waiting', 'drafted', 'on_deck')
ORDER BY
  CASE qe.status WHEN 'on_deck' THEN 0 WHEN 'drafted' THEN 1 ELSE 2 END,
  qe.games_played,
  qe.joined_at;

-- 20260702000003 set security_invoker; CREATE OR REPLACE can drop it.
ALTER VIEW public.v_queue_full_with_wait_time SET (security_invoker = true);
