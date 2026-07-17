-- ============================================================================
-- M2: consolidate the session/match RLS access checks into single-pass helpers.
--
-- Prod's top DB-time cost is per-row/per-realtime-event RLS: sessions had 14.3M
-- seq scans on a 22-row table. Every session-scoped SELECT policy evaluated
--   is_session_organizer(sid) OR is_session_club_member(sid)
-- which probes `sessions` TWICE (once per helper) across 3 nested non-inlinable
-- SECURITY DEFINER functions.
--
-- Equivalence (proven against all 3,894 (profile,session) pairs in prod, 0
-- mismatches): because owner/admin membership ⊆ any-active membership,
--   (is_session_organizer OR is_session_club_member)  ==  access is non-null
-- and  is_session_organizer  ==  access level = 'organizer'
-- where a single helper resolves the level in ONE sessions probe.
--
-- Also drops 4 duplicate PERMISSIVE policies whose `TO public` twins already
-- cover `authenticated` identically (verified: union of policies is unchanged).
-- ============================================================================

-- ── Workhorse: resolve the caller's access level for a session in one probe ──
CREATE OR REPLACE FUNCTION public.session_access_level(p_session_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN s.created_by = auth.uid()
      OR EXISTS (SELECT 1 FROM session_organizers so
                 WHERE so.session_id = s.id AND so.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM club_members cm
                 WHERE cm.club_id = s.club_id AND cm.player_id = auth.uid()
                   AND cm.is_active = true AND cm.role IN ('owner', 'admin'))
    THEN 'organizer'
    WHEN EXISTS (SELECT 1 FROM club_members cm
                 WHERE cm.club_id = s.club_id AND cm.player_id = auth.uid()
                   AND cm.is_active = true)
    THEN 'member'
    ELSE NULL
  END
  FROM sessions s
  WHERE s.id = p_session_id;
$function$;

CREATE OR REPLACE FUNCTION public.has_match_access(p_match_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.session_access_level(m.session_id) IS NOT NULL
  FROM matches m
  WHERE m.id = p_match_id;
$function$;

GRANT EXECUTE ON FUNCTION public.session_access_level(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_match_access(uuid) TO anon, authenticated, service_role;

-- ── Recreate the SELECT policy quals with the merged helpers (ALTER keeps the
--    role + cmd + permissive/restrictive flags exactly) ───────────────────────
ALTER POLICY courts_select ON public.courts
  USING (public.session_access_level(session_id) IS NOT NULL);

ALTER POLICY queue_select ON public.queue_entries
  USING (public.session_access_level(session_id) IS NOT NULL);

ALTER POLICY session_organizers_select ON public.session_organizers
  USING (public.session_access_level(session_id) IS NOT NULL);

ALTER POLICY matches_select ON public.matches
  USING (
    CASE public.session_access_level(session_id)
      WHEN 'organizer' THEN true
      WHEN 'member' THEN (status <> 'pending'::match_status OR is_published = true)
      ELSE false
    END
  );

ALTER POLICY matches_select_draft_firewall ON public.matches
  USING (
    CASE public.session_access_level(session_id)
      WHEN 'organizer' THEN true
      WHEN 'member' THEN (status <> 'pending'::match_status OR is_published = true)
      ELSE false
    END
  );

ALTER POLICY match_players_select ON public.match_players
  USING (public.has_match_access(match_id));

ALTER POLICY match_games_select ON public.match_games
  USING (public.has_match_access(match_id));

-- ── Drop duplicate PERMISSIVE policies (their TO-public twins subsume them for
--    authenticated; union of policies is unchanged) ────────────────────────────
DROP POLICY queue_entries_select ON public.queue_entries; -- == queue_select (public)
DROP POLICY queue_entries_update ON public.queue_entries; -- ⊆ queue_update_own OR queue_update_organizer
DROP POLICY queue_entries_insert ON public.queue_entries; -- == queue_insert (public)
DROP POLICY profiles_update ON public.profiles;           -- == profiles_update_own (public)
