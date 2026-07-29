-- ============================================================
-- swap_teams_in_active_match — make p_session_id NULL-rejecting
-- ============================================================
-- The follow-up owed by 20260723000001 (TENANCY_AUDIT_2026-07-21.md #10).
--
-- 20260723000001 added p_session_id to swap_teams_in_active_match with
-- DEFAULT NULL, and bound the match to it only WHEN a value was supplied
-- (`p_session_id IS NULL OR session_id = p_session_id`). The DEFAULT NULL was a
-- deliberate, TEMPORARY compatibility shim: it let the not-yet-deployed old code
-- — which did not send the key — keep working during the apply→deploy window
-- (a REQUIRED parameter would have answered PGRST202 and broken every team flip
-- until the deploy caught up; see that migration's header). The cost of the shim
-- is that ANY caller can still reach the old unbound behaviour by simply omitting
-- the key, so the cross-session binding rests entirely on the caller always
-- passing it.
--
-- That window is now closed:
--   • 20260723000000 + 20260723000001 are applied to prod and verified.
--   • The #40 code that sends p_session_id at every call site is deployed to
--     production (Vercel READY). Both sites confirmed in
--     src/app/actions/live-match-swap.ts:
--        swapTeamsInActiveMatch  → rpc(..., { p_session_id: sessionId })
--        undoLiveSwap/team_swap  → rpc(..., { p_session_id: match.session_id })
--     Nothing in the app omits it any more, so the NULL branch is dead code from
--     the app's side and only a bypass remains reachable over raw PostgREST.
--
-- This migration removes the shim: p_session_id can no longer be NULL, so the
-- session binding is now unconditional at the database and cannot be sidestepped
-- by dropping the key. The parameter keeps its position and DEFAULT NULL SO THAT
-- the argument-name set PostgREST resolves against is unchanged (no signature
-- change, no schema-cache churn, ACL preserved) — the value NULL is simply
-- rejected at the top of the body instead of being tolerated.
--
-- CREATE OR REPLACE, not DROP + CREATE: the signature is identical, so the
-- proacl is preserved and this cannot re-open the anon/authenticated hole the
-- way 20260723000001's DROP + CREATE could. The revoke below is re-issued anyway,
-- belt-and-braces and consistent with the sibling migrations, and asserted.
--
-- Re-runnable: CREATE OR REPLACE on the same 8-arg shape.
-- ============================================================

CREATE OR REPLACE FUNCTION public.swap_teams_in_active_match(
    p_match_id uuid,
    p_player_a_id uuid,
    p_player_b_id uuid,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text,
    p_is_undo boolean DEFAULT false,
    p_reverses_event_id uuid DEFAULT NULL::uuid,
    p_session_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_team_a       TEXT;
    v_team_b       TEXT;
    v_match_status match_status;
    v_session_id   uuid;
BEGIN
    -- The session binding is no longer optional. The DEFAULT NULL survives only
    -- so the resolvable argument-name set is unchanged; a NULL value is a caller
    -- that omitted the key, which is exactly the bypass this migration closes.
    IF p_session_id IS NULL THEN
        RAISE EXCEPTION 'SESSION_ID_REQUIRED';
    END IF;

    -- Bind unconditionally: a match in any other session is invisible here, not
    -- merely unauthorized. v_session_id is read back from the row (it equals
    -- p_session_id now that the pair must match) to stamp record_match_event.
    SELECT status, session_id INTO v_match_status, v_session_id
    FROM matches
    WHERE id = p_match_id
      AND session_id = p_session_id
    FOR UPDATE;
    IF v_match_status IS DISTINCT FROM 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    SELECT team INTO v_team_a FROM match_players
    WHERE match_id = p_match_id AND player_id = p_player_a_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO v_team_b FROM match_players
    WHERE match_id = p_match_id AND player_id = p_player_b_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    UPDATE match_players SET team = v_team_b WHERE match_id = p_match_id AND player_id = p_player_a_id;
    UPDATE match_players SET team = v_team_a WHERE match_id = p_match_id AND player_id = p_player_b_id;

    UPDATE matches
    SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1
          FROM match_players mp JOIN profiles pr ON pr.id = mp.player_id
          WHERE mp.match_id = p_match_id)
    WHERE id = p_match_id;

    PERFORM record_match_event(
      p_match_id, v_session_id,
      CASE WHEN p_is_undo THEN 'undo' ELSE 'team_flip' END,
      'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(
        jsonb_build_object('player_id', p_player_a_id, 'player_name', _player_name(p_player_a_id),
                           'from_team', v_team_a, 'to_team', v_team_b),
        jsonb_build_object('player_id', p_player_b_id, 'player_name', _player_name(p_player_b_id),
                           'from_team', v_team_b, 'to_team', v_team_a)),
      NULL, NULL, p_reverses_event_id
    );
END;
$function$;

-- CREATE OR REPLACE preserves the proacl, so these are belt-and-braces — but the
-- sibling migrations re-issue them and the assertion below fails closed if this
-- function ever regains anon/authenticated EXECUTE, so keep them.
grant  execute on function public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid) to service_role;
revoke execute on function public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid) from public, anon, authenticated;


-- ============================================================
-- Assertions
-- ============================================================
DO $$
DECLARE
  v_problem text;
  v_count   int;
  v_raised  boolean := false;
BEGIN
  -- 1. NULL p_session_id is now rejected before any read or write. All-random
  -- ids so nothing real is touched even if the guard were absent (the guard is
  -- the first statement, so it fires before the SELECT ... FOR UPDATE).
  BEGIN
    PERFORM public.swap_teams_in_active_match(
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
      NULL, NULL, false, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'SESSION_ID_REQUIRED' THEN
      v_raised := true;
    ELSE
      RAISE EXCEPTION 'NULL p_session_id raised the wrong error: %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'NULL p_session_id did NOT raise SESSION_ID_REQUIRED — the shim is still open';
  END IF;

  -- 2. Still exactly one candidate (PostgREST would answer PGRST203 otherwise).
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'swap_teams_in_active_match';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly 1 swap_teams_in_active_match, found % — PostgREST will answer PGRST203', v_count;
  END IF;

  -- 3. Browser roles still cannot EXECUTE any mutating SECDEF function. Same
  -- catalog sweep as the sibling migrations.
  SELECT string_agg(sig, ', ' ORDER BY sig) INTO v_problem
    FROM (
      SELECT p.oid::regprocedure::text AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.prorettype <> 'trigger'::regtype
         AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) s;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION
      'Browser roles can EXECUTE these mutating SECURITY DEFINER functions: %', v_problem;
  END IF;

  -- 4. service_role kept EXECUTE (the revoke did not overreach).
  IF NOT has_function_privilege(
       'service_role',
       'public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid)'::regprocedure::oid,
       'EXECUTE') THEN
    RAISE EXCEPTION 'THE REVOKE TRAP FIRED: service_role lost EXECUTE on swap_teams_in_active_match';
  END IF;
END $$;


NOTIFY pgrst, 'reload schema';
