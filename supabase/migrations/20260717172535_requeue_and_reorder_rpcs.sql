-- ============================================================================
-- M3b: set-based RPCs replacing per-row read-modify-write loops.
--
-- requeue_finished_players: endMatchAction did a SELECT-then-UPDATE per finishing
--   player (8 statements/match), and the JS read-modify-write of games_played
--   could lose a concurrent increment. One atomic UPDATE fixes both.
-- reorder_on_deck_matches: reorderOnDeckMatches fired one UPDATE per match; a
--   single UPDATE ... FROM unnest(...) WITH ORDINALITY does it in one statement.
--
-- Both are called server-side via the service client (which already bypasses
-- RLS); SECURITY DEFINER + pinned search_path for consistency. GRANT to
-- service_role only (never invoked by anon/authenticated).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.requeue_finished_players(
  p_session_id uuid,
  p_player_ids uuid[],
  p_drafted_ids uuid[]
) RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE queue_entries
  SET games_played = games_played + 1,
      joined_at    = now(),
      status = CASE WHEN player_id = ANY(p_drafted_ids)
                    THEN 'drafted'::queue_status
                    ELSE 'waiting'::queue_status END
  WHERE session_id = p_session_id
    AND player_id  = ANY(p_player_ids)
    AND status <> 'left';
$function$;

CREATE OR REPLACE FUNCTION public.reorder_on_deck_matches(
  p_session_id uuid,
  p_match_ids uuid[]
) RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE matches m
  SET sort_order = ord.idx - 1  -- 0-based, matching the previous per-row loop
  FROM unnest(p_match_ids) WITH ORDINALITY AS ord(id, idx)
  WHERE m.id = ord.id
    AND m.session_id = p_session_id
    AND m.status = 'pending';
$function$;

REVOKE EXECUTE ON FUNCTION public.requeue_finished_players(uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reorder_on_deck_matches(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_finished_players(uuid, uuid[], uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.reorder_on_deck_matches(uuid, uuid[]) TO service_role;
