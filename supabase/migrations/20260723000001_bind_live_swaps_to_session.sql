-- ============================================================
-- Bind the live-match swap RPCs to the session they were authorized for
-- ============================================================
-- TENANCY_AUDIT_2026-07-21.md #10, the SQL half. The companion migration
-- 20260723000000 removes anon/authenticated EXECUTE and is the fix for the live
-- UNAUTHENTICATED hole; this file closes the separate AUTHENTICATED one — an
-- organizer of session A rewriting a live match in session B — and is what makes
-- the TypeScript organizer gate's promise true at the database.
--
-- Neither file substitutes for the other, and the asymmetry is worth stating:
-- three of the four functions take p_session_id as a REQUIRED parameter, so they
-- are genuinely bound the moment this migration lands. swap_teams_in_active_match
-- takes it with DEFAULT NULL, so any caller that simply omits the key still gets
-- the old unbound behaviour. For THAT function the real boundary until the
-- follow-up NULL-rejecting migration lands is 20260723000000 restricting callers
-- to service_role, plus the TypeScript pre-check. Apply both.
--
-- ── THE DEFECT: AUTHORIZE ON A, OPERATE ON B ──────────────
-- Every live-swap server action gates on isSessionOrganizer(user.id, sessionId)
-- and then calls an RPC keyed on a SEPARATELY client-supplied match id. Neither
-- layer ever checked that the match belongs to that session. Verified against
-- the deployed function bodies: none of the four compares matches.session_id to
-- p_session_id. p_session_id only ever drove the queue_entries writes and the
-- record_match_event stamp, and swap_teams_in_active_match did not take one at
-- all — it read session_id back OUT of the match purely to label the audit row,
-- which means the audit trail faithfully recorded the victim's session while the
-- authorization had been performed against the attacker's.
--
-- So an organizer of any session could rewrite the live roster of a match in
-- another club's session by passing that match's id. This is finding #4 again —
-- the same defect the same audit found on match-event READS — but on WRITES.
--
-- The correct in-repo model already existed at 20260717172535, whose
-- reorder_on_deck_matches carries `AND m.session_id = p_session_id`. These four
-- predate it and were never brought in line.
--
-- ── NULL SEMANTICS ARE LOAD-BEARING HERE, NOT COSMETIC ────
-- Adding `AND session_id = p_session_id` means a mismatched pair finds NO ROW,
-- which leaves the status variables NULL. The existing guards were written as
-- `v_active_status != 'in_progress'`, and NULL != 'in_progress' is NULL, not
-- true — plpgsql treats a NULL IF condition as false, so the guard FALLS THROUGH.
--
-- In undo_swap_active_from_ondeck that is the difference between a fix and a new
-- bug: its guard `RETURN`s instead of raising, and every statement after it
-- addresses rows by the client-supplied match ids directly. A cross-session undo
-- would sail past a NULL guard and the INSERTs would succeed, because the target
-- match genuinely exists — just in someone else's session. Every status check
-- below is therefore rewritten to `IS DISTINCT FROM`, which is true when the
-- value is NULL.
--
-- The same rewrite retires a second latent bug in the two-match functions. They
-- lock in id order to avoid deadlock, so which of the two SELECTs ran last —
-- and therefore what `NOT FOUND` refers to — depends on how the uuids happen to
-- compare. `IS DISTINCT FROM` on the variable itself is order-independent.
--
-- ── swap_teams_in_active_match NEEDS A SIGNATURE CHANGE ───
-- It has no p_session_id to bind to. The new parameter is appended with
-- `DEFAULT NULL`, and the binding is enforced only when a value is supplied.
--
-- ⚠⚠ APPLY THIS MIGRATION BEFORE THE CODE DEPLOYS. ⚠⚠
--
-- `DEFAULT NULL` makes ONE of the two orders safe, not both. PostgREST resolves
-- an RPC by the set of argument NAMES in the request body:
--
--   migration first, code not yet deployed  → the old code sends only the keys
--       it knows about (5 at the swapTeams site, 6 at the team_swap undo site),
--       every REQUIRED parameter is covered, p_session_id defaults, the call
--       succeeds, and the binding is simply not enforced for that window. SAFE.
--       (PostgREST accepts a subset of the parameter names; what it cannot
--       tolerate is a key that names NO parameter — that is the other case.)
--   code first, migration not yet applied   → new code sends p_session_id to a
--       function that has no such parameter → no candidate matches → PGRST202
--       "Could not find the function … in the schema cache". Every team flip and
--       every team_swap undo FAILS until the migration lands. NOT SAFE.
--
-- So the parameter being optional buys tolerance for a late deploy, not for a
-- late migration. Migrations here are applied BY HAND while Vercel deploys on
-- merge, so this ordering has to be carried out deliberately — see the PR body
-- and MEMORY.md. A REQUIRED parameter would have broken BOTH directions, which
-- is why it is still spelled `DEFAULT NULL`.
--
-- Adding a second overload instead is not an option: PostgREST answers PGRST203
-- ("could not choose the best candidate function") as soon as two candidates
-- match, which is how the ambiguity surfaced during PR2.
--
-- FOLLOW-UP, once this migration and its deploy are both live: make p_session_id
-- reject NULL. Until then the enforcement rests on the caller always passing it,
-- which src/app/actions/live-match-swap.ts now does at every site, and on the
-- TypeScript guard in that file, which fails the request before the RPC is
-- reached. Tracked in TENANCY_AUDIT_2026-07-21.md #10.
--
-- ⚠ DROP + CREATE RESETS THE ACL. Postgres cannot add a parameter via CREATE OR
-- REPLACE, so swap_teams_in_active_match is dropped and recreated — and a
-- CREATE FUNCTION on Supabase is born carrying anon=X and authenticated=X from
-- ALTER DEFAULT PRIVILEGES. Recreating it silently re-opens exactly the hole
-- 20260723000000 just closed. The revoke is therefore re-issued below, and
-- asserted. The other three use CREATE OR REPLACE, which preserves proacl; their
-- revokes are re-issued anyway, so all four of THESE functions end up locked
-- down by this file alone.
--
-- That is a statement about these four, not about the other twelve — and this
-- file will not even commit without 20260723000000, because assertion 5a below
-- sweeps EVERY volatile SECDEF non-trigger function in public for anon /
-- authenticated EXECUTE and raises. Run out of order, this migration aborts and
-- rolls back; it does not half-apply. Recovery is "apply 20260723000000, re-run
-- this one".
--
-- ⚠ RE-RUNNABILITY. The DROP names both shapes — the 7-arg pre-migration one and
-- the 8-arg one this file creates — so re-running it against a database that
-- already has the new function replaces it instead of failing 42723. That
-- matters here specifically because migrations in this project are applied by
-- hand and prod's stamps drift from the repo filenames.
--
-- Intended order: 20260723000000 → 20260723000001 → merge/deploy.
-- ============================================================


-- ============================================================
-- 1. swap_player_in_active_match — bind the match to the session
-- ============================================================
CREATE OR REPLACE FUNCTION public.swap_player_in_active_match(
    p_match_id uuid,
    p_out_player_id uuid,
    p_in_player_id uuid,
    p_session_id uuid,
    p_team text,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text,
    p_is_undo boolean DEFAULT false,
    p_reverses_event_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_match_status match_status;
    v_in_status    queue_status;
BEGIN
    -- session_id is the id the caller was authorized against. A match in any
    -- other session must be invisible here, not merely unauthorized.
    SELECT status INTO v_match_status
    FROM matches
    WHERE id = p_match_id AND session_id = p_session_id
    FOR UPDATE;
    IF v_match_status IS DISTINCT FROM 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id
    ) THEN
        RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
    END IF;

    SELECT status INTO v_in_status FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_in_player_id FOR UPDATE;
    IF NOT FOUND OR v_in_status != 'waiting' THEN
        RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
    END IF;

    DELETE FROM match_players WHERE match_id = p_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_match_id, p_in_player_id, p_team);
    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_in_player_id;

    UPDATE matches
    SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1
          FROM match_players mp JOIN profiles pr ON pr.id = mp.player_id
          WHERE mp.match_id = p_match_id)
    WHERE id = p_match_id;

    PERFORM record_match_event(
      p_match_id, p_session_id,
      CASE WHEN p_is_undo THEN 'undo' ELSE 'roster_swap' END,
      'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_out_player_id, 'out_player_name', _player_name(p_out_player_id),
        'in_player_id', p_in_player_id,   'in_player_name', _player_name(p_in_player_id),
        'team', p_team)),
      NULL, NULL, p_reverses_event_id
    );
END;
$function$;

grant  execute on function public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) to service_role;
revoke execute on function public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid) from public, anon, authenticated;


-- ============================================================
-- 2. swap_active_from_ondeck — bind BOTH matches to the session
-- ============================================================
CREATE OR REPLACE FUNCTION public.swap_active_from_ondeck(
    p_active_match_id uuid,
    p_out_player_id uuid,
    p_ondeck_player_id uuid,
    p_ondeck_match_id uuid,
    p_fill_player_id uuid,
    p_session_id uuid,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text,
    OUT o_out_team text,
    OUT o_ondeck_team text)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_active_status  match_status;
    v_ondeck_status  match_status;
    v_fill_status    queue_status;
    v_corr           uuid := gen_random_uuid();
BEGIN
    -- Lock order is by id to avoid deadlocking against a concurrent swap that
    -- touches the same pair from the other side. Both lookups are bound to
    -- p_session_id: a match in another session yields no row, hence a NULL
    -- status, which the IS DISTINCT FROM guards below reject.
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
    END IF;

    -- Checked on the variables, not on NOT FOUND: which SELECT ran last depends
    -- on how the two uuids compare, so NOT FOUND does not reliably describe
    -- either match.
    IF v_active_status IS DISTINCT FROM 'in_progress' THEN RAISE EXCEPTION 'MATCH_NOT_ACTIVE'; END IF;
    IF v_ondeck_status IS DISTINCT FROM 'pending'     THEN RAISE EXCEPTION 'ONDECK_MATCH_STARTED'; END IF;

    SELECT team INTO o_out_team FROM match_players
    WHERE match_id = p_active_match_id AND player_id = p_out_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO o_ondeck_team FROM match_players
    WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT status INTO v_fill_status FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_fill_player_id FOR UPDATE;
    IF NOT FOUND OR v_fill_status != 'waiting' THEN RAISE EXCEPTION 'FILL_PLAYER_UNAVAILABLE'; END IF;

    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_active_match_id, p_ondeck_player_id, o_out_team);

    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_ondeck_match_id, p_fill_player_id, o_ondeck_team);

    UPDATE queue_entries SET status = 'waiting'  WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'playing'  WHERE session_id = p_session_id AND player_id = p_ondeck_player_id;
    UPDATE queue_entries SET status = 'on_deck'  WHERE session_id = p_session_id AND player_id = p_fill_player_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_active_match_id)
    WHERE id = p_active_match_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_ondeck_match_id)
    WHERE id = p_ondeck_match_id;

    PERFORM record_match_event(
      p_active_match_id, p_session_id, 'ondeck_pull', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_out_player_id, 'out_player_name', _player_name(p_out_player_id),
        'in_player_id', p_ondeck_player_id, 'in_player_name', _player_name(p_ondeck_player_id),
        'team', o_out_team)),
      jsonb_build_object('secondary_match_id', p_ondeck_match_id, 'leg', 'active'),
      v_corr, NULL
    );
    PERFORM record_match_event(
      p_ondeck_match_id, p_session_id, 'ondeck_pull', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_ondeck_player_id, 'out_player_name', _player_name(p_ondeck_player_id),
        'in_player_id', p_fill_player_id, 'in_player_name', _player_name(p_fill_player_id),
        'team', o_ondeck_team)),
      jsonb_build_object('secondary_match_id', p_active_match_id, 'leg', 'ondeck'),
      v_corr, NULL
    );
END;
$function$;

grant  execute on function public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) to service_role;
revoke execute on function public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;


-- ============================================================
-- 3. undo_swap_active_from_ondeck — bind BOTH matches to the session
-- ============================================================
-- This is the one where NULL semantics decide whether the fix is a fix: the
-- guard RETURNs rather than raising, and every statement after it addresses rows
-- by the client-supplied match ids. Under the old `!=` spelling a cross-session
-- undo would have fallen straight through it and succeeded.
CREATE OR REPLACE FUNCTION public.undo_swap_active_from_ondeck(
    p_active_match_id uuid,
    p_out_player_id uuid,
    p_ondeck_player_id uuid,
    p_ondeck_match_id uuid,
    p_fill_player_id uuid,
    p_session_id uuid,
    p_out_team text,
    p_ondeck_team text,
    p_actor_id uuid DEFAULT NULL::uuid,
    p_actor_name text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_active_status match_status;
    v_ondeck_status match_status;
    v_corr          uuid := gen_random_uuid();
BEGIN
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches
          WHERE id = p_ondeck_match_id AND session_id = p_session_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches
          WHERE id = p_active_match_id AND session_id = p_session_id FOR UPDATE;
    END IF;

    -- Silent no-op, as before: the undo window can lapse legitimately (the match
    -- ended, the on-deck match was promoted) and that is not an error. A
    -- cross-session pair now lands here too, via the NULL status.
    IF v_active_status IS DISTINCT FROM 'in_progress'
       OR v_ondeck_status IS DISTINCT FROM 'pending' THEN
        RETURN;
    END IF;

    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_active_match_id, p_out_player_id, p_out_team);

    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_fill_player_id;
    INSERT INTO match_players (match_id, player_id, team) VALUES (p_ondeck_match_id, p_ondeck_player_id, p_ondeck_team);

    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'on_deck' WHERE session_id = p_session_id AND player_id = p_ondeck_player_id;
    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_fill_player_id;

    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_active_match_id)
    WHERE id = p_active_match_id;
    UPDATE matches SET is_mixed_level = (
          SELECT COUNT(DISTINCT pr.skill_level) > 1 FROM match_players mp
          JOIN profiles pr ON pr.id = mp.player_id WHERE mp.match_id = p_ondeck_match_id)
    WHERE id = p_ondeck_match_id;

    PERFORM record_match_event(
      p_active_match_id, p_session_id, 'undo', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_ondeck_player_id, 'out_player_name', _player_name(p_ondeck_player_id),
        'in_player_id', p_out_player_id, 'in_player_name', _player_name(p_out_player_id),
        'team', p_out_team)),
      jsonb_build_object('secondary_match_id', p_ondeck_match_id, 'leg', 'active', 'undo_of', 'ondeck_pull'),
      v_corr, NULL
    );
    PERFORM record_match_event(
      p_ondeck_match_id, p_session_id, 'undo', 'active',
      CASE WHEN p_actor_id IS NULL THEN 'system' ELSE 'organizer' END,
      p_actor_id, p_actor_name,
      jsonb_build_array(jsonb_build_object(
        'out_player_id', p_fill_player_id, 'out_player_name', _player_name(p_fill_player_id),
        'in_player_id', p_ondeck_player_id, 'in_player_name', _player_name(p_ondeck_player_id),
        'team', p_ondeck_team)),
      jsonb_build_object('secondary_match_id', p_active_match_id, 'leg', 'ondeck', 'undo_of', 'ondeck_pull'),
      v_corr, NULL
    );
END;
$function$;

grant  execute on function public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) to service_role;
revoke execute on function public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) from public, anon, authenticated;


-- ============================================================
-- 4. swap_teams_in_active_match — gains p_session_id (DEFAULT NULL)
-- ============================================================
-- DROP + CREATE: a parameter cannot be added via CREATE OR REPLACE. See the
-- header for why the parameter is optional rather than required, and for why the
-- revoke below is mandatory rather than belt-and-braces.
--
-- BOTH shapes are dropped. The 7-arg one is what exists before this migration;
-- the 8-arg one is what exists after, and naming it too is what makes this file
-- re-runnable — without it a second run leaves the 8-arg function in place and
-- the bare CREATE below fails 42723 ("function already exists with same
-- argument types"). Migrations here are hand-applied against a prod whose
-- stamps drift from the repo filenames, so a re-run is a realistic event.
DROP FUNCTION IF EXISTS public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid);
DROP FUNCTION IF EXISTS public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid);

CREATE FUNCTION public.swap_teams_in_active_match(
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
    -- When p_session_id is supplied the match must belong to it. NULL keeps the
    -- pre-existing behaviour, which is what lets a not-yet-updated deploy keep
    -- working against this function — it does NOT make the reverse order safe
    -- (see the header: code-first is PGRST202). The caller in
    -- src/app/actions/live-match-swap.ts always supplies it, so on the deployed
    -- pair the NULL branch is unreachable from the app; it is a compatibility
    -- shim with a follow-up migration owed to remove it. Note v_session_id is
    -- still read back out of the row — it
    -- stamps record_match_event, and reading it from the match rather than the
    -- parameter keeps the audit row correct even in the NULL case.
    SELECT status, session_id INTO v_match_status, v_session_id
    FROM matches
    WHERE id = p_match_id
      AND (p_session_id IS NULL OR session_id = p_session_id)
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

-- ⚠ NOT OPTIONAL. The DROP above discarded the proacl; the CREATE just minted a
-- fresh one from Supabase's ALTER DEFAULT PRIVILEGES, which hands anon and
-- authenticated EXECUTE. Without these two lines this migration re-opens the
-- unauthenticated hole that 20260723000000 closed.
grant  execute on function public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid) to service_role;
revoke execute on function public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid) from public, anon, authenticated;


-- ============================================================
-- 5. Assertions
-- ============================================================
DO $$
DECLARE
  v_problem text;
  v_count   int;
BEGIN
  -- 5a. The recreated function did not re-open the hole, and neither did the
  -- three CREATE OR REPLACEs. Same catalog sweep as 20260723000000, repeated
  -- here because THIS file is the one that mints a new proacl.
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

  -- 5b. Exactly one swap_teams_in_active_match. Two candidates would make
  -- PostgREST answer PGRST203 and every team flip would fail.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'swap_teams_in_active_match';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly 1 swap_teams_in_active_match, found % — PostgREST will answer PGRST203', v_count;
  END IF;

  -- 5c. All four still exist and are service_role-executable.
  FOREACH v_problem IN ARRAY ARRAY[
    'public.swap_player_in_active_match(uuid, uuid, uuid, uuid, text, uuid, text, boolean, uuid)',
    'public.swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)',
    'public.undo_swap_active_from_ondeck(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, text)',
    'public.swap_teams_in_active_match(uuid, uuid, uuid, uuid, text, boolean, uuid, uuid)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_problem::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'THE REVOKE TRAP FIRED: service_role lost EXECUTE on %', v_problem;
    END IF;
  END LOOP;
END $$;


NOTIFY pgrst, 'reload schema';
