-- ============================================================================
-- Audit finding #11 — the draft-mode firewall covered `matches` but not
-- `match_players`.  TENANCY_AUDIT_2026-07-21.md §2 #11.
--
-- THE HOLE
-- --------
-- `matches` has carried a draft firewall since 20260506000000: a club member
-- may read a match row only once it is no longer a hidden draft.  Since
-- 20260717171903 that rule reads:
--
--     CASE public.session_access_level(session_id)
--       WHEN 'organizer' THEN true
--       WHEN 'member'    THEN (status <> 'pending' OR is_published = true)
--       ELSE false
--     END
--
-- and it is enforced twice, by `matches_select` (PERMISSIVE) and by
-- `matches_select_draft_firewall` (RESTRICTIVE, defense-in-depth).
--
-- `match_players` never asked the draft question at all.  Its policy is just
-- `has_match_access(match_id)`, and that helper only asked whether the caller
-- can see the SESSION:
--
--     SELECT public.session_access_level(m.session_id) IS NOT NULL
--     FROM matches m WHERE m.id = p_match_id;
--
-- So any club member could read the full named roster of an UNPUBLISHED draft
-- over a plain PostgREST GET, and — because postgres_changes re-checks the
-- table's SELECT policy per row rather than the parent's — was PUSHED those
-- rows live as the organizer generated them.  The leaked rows also hand out
-- the `match_id` that the hidden `matches` row withheld.  The organizer's
-- ability to reshuffle or discard a draft before anyone sees it is a product
-- guarantee, not a cosmetic one.
--
-- THE FIX
-- -------
-- Fold the identical firewall into `has_match_access`, so `match_players` and
-- `match_games` inherit exactly the rule `matches` already enforces.  The two
-- policies are left untouched — the semantics change inside the helper, which
-- keeps the three quals from drifting apart again.
--
-- BLAST RADIUS — verified against prod, not assumed
-- -------------------------------------------------
--   • `has_match_access` is referenced by exactly two objects: the policies
--     `match_players_select` and `match_games_select`.  No RPC body, no view,
--     no other policy references it (checked via pg_policies + pg_get_functiondef
--     + pg_get_viewdef across public/auth/storage).
--   • Rows whose member-visibility actually changes today: ZERO.  Every
--     match_players row in prod belongs to a `completed` (3504 rows) or
--     `cancelled` (267) match, and both satisfy `status <> 'pending'`.  There
--     are currently no unpublished pending matches at all.  The change is
--     forward-looking: it closes the window that exists only while an organizer
--     is drafting.
--   • `match_games` is empty in prod, so that policy's blast radius is nil.
--   • Organizers and co-organizers are unaffected — `session_access_level`
--     returns 'organizer' for them and the CASE short-circuits to true.
--   • anon is unaffected — `session_access_level` returns NULL, the old helper
--     evaluated `NULL IS NOT NULL` = false and the new one falls to ELSE false.
--   • A match_players row whose match_id has no `matches` row returns NULL from
--     both the old and new helper (a no-row SELECT), which RLS treats as deny.
--     Unchanged.
--   • `matches.status` and `matches.is_published` are both NOT NULL in prod, so
--     the CASE has no three-valued-logic edge.
--
-- APP-SIDE: WHY NOTHING REGRESSES
-- -------------------------------
-- Both player-facing readers already applied this exact firewall in the app
-- layer immediately after reading match_players, so the RLS filter and the app
-- filter converge on the same outcome:
--   • use-player-match.ts:82 reads the player's assignments, then :123 selects
--     matches with `status.eq.in_progress,and(status.eq.pending,is_published.eq.true)`.
--     A draft-only assignment produced "no active match" before and produces
--     "no assignments" now; both branches end at setCurrentMatch(null), and both
--     hold state when unauthenticated.
--   • use-match-alerts.ts:135 does the same in bootstrap(). Its slow path at
--     :236 only runs for a match transitioning to in_progress, which is never
--     'pending' and so is always visible.
-- The player's "drafted"/Match Forming state is driven by `queue_entries.status`
-- (my-status-tab.tsx:247), never by match_players, so it is untouched.
-- Publishing a draft is a `matches` UPDATE whose NEW row passes matches_select,
-- so the member still receives that event and refetches — at which point the
-- roster is legitimately visible.
-- Organizer surfaces (use-enriched-matches, use-organizer-matches) resolve to
-- 'organizer' and are unaffected.
--
-- APP-SIDE: THE TWO THINGS THAT DO CHANGE
-- ---------------------------------------
--   1. useMatchAlerts stops DOUBLE-firing COURT_CALL for a member.  Today the
--      draft-time match_players INSERT nulls `lastMatchStatus.current`
--      (use-match-alerts.ts:299), so when promoteOnDeckMatchInternal flips the
--      match to in_progress AND the roster's queue_entries to 'playing' in one
--      call (matchmaking.ts:751, :786-791), BOTH handleMatchChange and
--      handleQueueChange fire COURT_CALL.  Suppressing the draft INSERT leaves
--      exactly one.  This is de-duplication, not alert loss — do NOT "fix" it by
--      also resetting those refs from the `matches` subscription, which would
--      restore the double beep.  Server-side Web Push is independent of both.
--   2. The held cross-court reservation badge needed a new live trigger.  A held
--      draft is created as pending+unpublished, so `matches_select` ALREADY hid
--      its `matches` row from the reserved player; its match_players INSERTs were
--      the last event reaching them, and this migration suppresses those too.
--      usePlayerMatch therefore now also subscribes to `queue_entries` (which is
--      not firewalled, and which the same RPC writes in the same transaction).
--      Note the `ready` half of that badge — `held_ready_at`, set by an UPDATE on
--      a still-pending, still-unpublished match — has had no live trigger since
--      the `matches` firewall landed, and still doesn't; it surfaces on refetch.
--
-- NOT FIREWALLED, AND CANNOT BE: Realtime skips RLS on DELETE, and this table is
-- REPLICA IDENTITY DEFAULT, so members keep receiving draft-clear DELETEs
-- carrying only the PK.  That leaks no roster data but it does mean the channel
-- does not go silent for members — do not claim otherwise in the close-out.
--
-- ALSO NARROWED, harmlessly: Postgres applies SELECT policies to the WHERE
-- clause of UPDATE/DELETE, so `match_players_update` / `match_players_delete`
-- (TO public, is_session_organizer) now also carry the firewall.  No impact
-- today — every mutation in src/ runs through createServiceClient() and
-- organizers short-circuit to true — but a future browser-side roster edit on an
-- unpublished draft would affect 0 rows rather than error.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_match_access(p_match_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Mirrors matches_select / matches_select_draft_firewall exactly. If that
  -- rule ever changes, change it in all three places or the firewall reopens
  -- here first — this helper is the one a roster read goes through.
  --
  -- NULL vs false, deliberately: a p_match_id with no `matches` row selects zero
  -- rows, so the function returns NULL, and RLS treats NULL as deny. That is the
  -- pre-existing behaviour and it is the SAFE one. Do NOT wrap this in a
  -- coalesce(..., true) or add a `FROM matches m RIGHT JOIN` to make it total —
  -- an orphaned match_players row would become world-readable.
  SELECT CASE public.session_access_level(m.session_id)
    WHEN 'organizer' THEN true
    WHEN 'member'    THEN (m.status <> 'pending'::match_status OR m.is_published = true)
    ELSE false
  END
  FROM matches m
  WHERE m.id = p_match_id;
$function$;

-- CREATE OR REPLACE preserves existing grants, but re-assert them so a
-- from-scratch rebuild lands identically to prod.
GRANT EXECUTE ON FUNCTION public.has_match_access(uuid) TO anon, authenticated, service_role;

-- ── In-migration assertions ─────────────────────────────────────────────────
-- Fail loudly at apply time rather than silently leaving the hole open. The
-- style follows 20260722000002_declare_rls_baseline.sql.
DO $$
DECLARE
  v_def       text;
  v_dependents int;
  v_qual      text;
  v_roles     text;
  v_seen      int;
BEGIN
  -- 1. The helper really carries the firewall now.
  SELECT pg_get_functiondef('public.has_match_access(uuid)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%is_published%' THEN
    RAISE EXCEPTION 'has_match_access does not carry the draft firewall';
  END IF;
  IF v_def NOT LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'has_match_access lost SECURITY DEFINER';
  END IF;
  IF v_def NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'has_match_access lost its pinned search_path';
  END IF;

  -- 2. Still exactly the two dependent policies the blast-radius analysis
  --    assumed. A third would mean the analysis is stale.
  SELECT count(*) INTO v_dependents
  FROM pg_policies
  WHERE schemaname = 'public' AND coalesce(qual, '') LIKE '%has_match_access%';
  IF v_dependents <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 policies using has_match_access, found %', v_dependents;
  END IF;

  -- 3. The policies themselves are untouched — the semantics moved into the
  --    helper precisely so these quals stay as they are.
  --
  --    ROW-COUNT GUARDS, deliberately: a bare `SELECT ... INTO` leaves the
  --    variable NULL on zero rows, and `IF NULL <> 'x'` is NOT taken — so
  --    without these an assertion on a DROPPED policy would silently pass and
  --    this migration would report success while the firewall was unenforced.
  --    Same for the FOR loop: a zero-row loop body simply never executes.
  v_seen := 0;
  FOR v_qual, v_roles IN
    SELECT coalesce(qual, ''), array_to_string(roles, ',')
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN ('match_players_select', 'match_games_select')
  LOOP
    v_seen := v_seen + 1;
    IF v_qual NOT LIKE '%has_match_access(match_id)%' THEN
      RAISE EXCEPTION 'a roster SELECT policy no longer delegates to has_match_access: %', v_qual;
    END IF;
  END LOOP;
  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'expected match_players_select AND match_games_select to exist, found % of 2', v_seen;
  END IF;

  -- 4. Roles are NOT normalised by this migration and must not drift:
  --    match_players_select is TO authenticated, match_games_select is TO public.
  SELECT array_to_string(roles, ',') INTO v_roles
  FROM pg_policies WHERE schemaname = 'public' AND policyname = 'match_players_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match_players_select does not exist';
  END IF;
  IF v_roles <> 'authenticated' THEN
    RAISE EXCEPTION 'match_players_select roles changed: %', v_roles;
  END IF;
  SELECT array_to_string(roles, ',') INTO v_roles
  FROM pg_policies WHERE schemaname = 'public' AND policyname = 'match_games_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match_games_select does not exist';
  END IF;
  IF v_roles <> 'public' THEN
    RAISE EXCEPTION 'match_games_select roles changed: %', v_roles;
  END IF;

  RAISE NOTICE 'has_match_access: draft firewall extended to match_players + match_games';
END $$;

-- ── Post-apply verification (run manually; not part of the migration) ────────
--
-- 1. The helper now discriminates drafts. Expect member_can_see = false for a
--    pending+unpublished match and true for everything else:
--
--      SELECT m.id, m.status, m.is_published,
--             (m.status <> 'pending'::match_status OR m.is_published) AS member_can_see
--      FROM matches m
--      WHERE m.session_id = '<a live session>'
--      ORDER BY m.created_at DESC;
--
-- 2. Still exactly two dependents, both policies:
--
--      SELECT tablename, policyname FROM pg_policies
--      WHERE schemaname = 'public' AND qual LIKE '%has_match_access%';
--
-- 3. Live check with a real member JWT: during an active draft, a member's
--    PostgREST GET on match_players filtered to a drafted match_id must return
--    [], and must start returning the roster the moment the organizer publishes.
