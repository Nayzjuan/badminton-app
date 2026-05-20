-- ============================================================
-- Migration: Add v_queue_full_with_wait_time
-- ============================================================
-- Why:
--   v_queue_with_wait_time intentionally filters to status='waiting'
--   so the matchmaking engine only sees eligible candidates. However,
--   the organizer and player queue lists need to show on_deck and
--   drafted players too, with their wait timers still running.
--
--   This new view is the organizer/player display layer. The original
--   view is unchanged — the engine keeps its waiting-only contract.
--
-- Status inclusion:
--   - waiting  : in pool, eligible
--   - drafted  : reserved in an unpublished draft (organizer view only)
--   - on_deck  : published match, player alerted
--   - playing  : excluded — gone from queue once on a court
--   - left     : excluded
--
-- Sort order:
--   on_deck first (committed), then drafted (tentative), then waiting,
--   within each tier ordered by games_played ASC, joined_at ASC.
--   status_priority column is exposed so PostgREST callers can order
--   without needing to express a CASE in the query string.
-- ============================================================

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
  END AS status_priority
FROM public.queue_entries qe
JOIN public.profiles p ON p.id = qe.player_id
WHERE qe.status IN ('waiting', 'drafted', 'on_deck')
ORDER BY
  CASE qe.status WHEN 'on_deck' THEN 0 WHEN 'drafted' THEN 1 ELSE 2 END,
  qe.games_played,
  qe.joined_at;

GRANT SELECT ON public.v_queue_full_with_wait_time TO authenticated, service_role;
