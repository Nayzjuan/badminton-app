-- ============================================================
-- Scope profiles_select from USING (true) to a shared-scope predicate
-- ============================================================
-- Tenancy audit 2026-07-21, finding #8. `profiles_select` was
--
--     CREATE POLICY profiles_select ON public.profiles
--       FOR SELECT TO authenticated USING (true)
--
-- so any signed-in user — including a `signInAnonymously()` guest who has
-- never joined a club — could enumerate every display name, skill level and
-- VIP tag in every club on the platform, and the unfiltered `profiles`
-- postgres_changes subscription (src/lib/realtime.ts subscribeToProfiles)
-- streamed every profile UPDATE platform-wide to every connected browser.
--
-- ── THE COMMENT THIS REPLACES WAS WRONG ─────────────────────
-- 20260722000002_declare_rls_baseline.sql recorded USING (true) as
-- "intentional and load-bearing… the public leaderboard and Wrapped share
-- pages read arbitrary profiles while logged out". That rationale does not
-- survive contact with the catalog: `profiles` has NO SELECT policy for
-- `anon` at all, so logged-out reads have never gone through RLS. They go
-- through the service client (PR #38 moved the leaderboard reads there
-- explicitly). Tightening this policy therefore cannot break any logged-out
-- path — it only ever governs authenticated users. The stale comment is
-- corrected in place in that file by the same PR.
--
-- ── THE NEW PREDICATE ───────────────────────────────────────
--   own profile  OR  public.can_read_profile(profiles.id)
--
-- and can_read_profile is the union of five arms, in the order the executor
-- will short-circuit them (cheapest and by far the most common first):
--
--   1. SHARED ACTIVE CLUB. Two active club_members rows on the same club_id.
--      This is the arm that fires for essentially every read in a
--      single-club deployment, and it is two index lookups
--      (idx_club_members_player_id, club_members_club_id_player_id_key).
--
--   2. TARGET IS QUEUED IN A SESSION I CAN REACH.
--   3. TARGET PLAYED A MATCH IN A SESSION I CAN REACH.
--   4. TARGET ORGANIZES A SESSION I CAN REACH (session_organizers).
--   5. TARGET CREATED A SESSION I CAN REACH (sessions.created_by).
--
-- Arms 2–5 are not redundant with arm 1 and not redundant with each other.
-- Each closes a state the app actively supports:
--
--   • WALK-IN PLAYERS. An organizer can add somebody straight to the queue;
--     they hold a queue_entries row and no club_members row until they load
--     the player route and src/app/play/[sessionId]/page.tsx enrolls them
--     (that file documents the case at length). Without arm 2 a walk-in's
--     name renders blank in the queue for every other player in the room.
--
--   • DELEGATED ORGANIZERS. QR-invite delegation writes session_organizers
--     with no club_members row — src/app/organizer/[sessionId]/page.tsx:77
--     exists precisely because of it. session_access_level() grants such a
--     user 'organizer', so arms 2/3 let them see their own roster; arm 1
--     alone would hand them a board full of blanks.
--
--   • PLAYERS WHO HAVE LEFT. queue_entries rows are DELETEd on checkout
--     (queue_delete_own / queue_delete_organizer), but match_players rows
--     survive. useSessionCompletedPlayers and useMatchHistory read exactly
--     those profiles, so arm 3 is what keeps completed-match history and the
--     session leaderboard from losing names mid-session.
--
--   • ORGANIZERS WHO NEVER PLAY (arms 4/5). Without them, visibility inside
--     one session is asymmetric: a delegated organizer can see the whole
--     room (arms 2/3) while the room cannot see them. Arms 4/5 are a
--     widening strictly *within* a session the reader already reaches, so
--     they leak nothing across clubs. Arm 5 is not implied by arm 4 even
--     though handle_new_session() inserts a session_organizers row for every
--     creator: production has one session whose creator has no such row.
--
-- Verified against production (read-only) before writing this: 0 queued
-- non-members, 0 played non-members and 0 membership-less delegated
-- organizers exist there *today*, so arms 2–4 are latent rather than active.
-- They are here so the policy does not start failing the first time one of
-- those supported states occurs.
--
-- ── WHY THIS CANNOT REGRESS A CURRENT READ ──────────────────
-- Every read of `profiles` through an RLS-bound client is one of:
--
--   own profile — 7 server components (/, /welcome, /rename, /play,
--   /c/[clubSlug]/join, /c/[clubSlug]/organizer, /c/[clubSlug]/organizer/
--   [sessionId]) plus two server actions (auth.ts, queue.ts), all
--   `.eq("id", user.id)`
--     → self arm, which the planner reads straight off profiles_pkey.
--   players of a match in the session being viewed (useEnrichedMatches,
--   usePlayerMatch, useMatchHistory, useSessionCompletedPlayers)
--     → arm 3 (and usually arm 1).
--   players in the queue of the session being viewed — useOrganizerQueue reads
--   these twice: through the security_invoker view v_queue_full_with_wait_time,
--   and again directly as `.in("id", queueIds)` on profiles
--   (src/hooks/use-organizer-queue.ts)
--     → arm 2 for both (and usually arm 1).
--   buildVipMap in src/app/actions/leaderboard.ts, which deliberately stays on
--   the caller's client — its header says so and anticipates this migration.
--     → arm 3: every board entry comes from v_alltime_leaderboard_mat, which is
--       built from completed matches, so the ids it is called with have all
--       played in a session the caller can reach.
--
-- Everything else — the rest of the leaderboard, Wrapped, the club roster
-- screens, dup-name checks, the matchmaking engine — runs on the service client
-- and bypasses RLS entirely, so this policy is not in their path at all.
--
-- ── COST, MEASURED ──────────────────────────────────────────
-- EXPLAIN (ANALYZE) against a synthetic dataset ~15x production
-- (1001 profiles / 1000 club_members / 200 sessions / 8000 queue_entries /
-- 12000 matches / 48000 match_players, so ~48 match_players rows per player):
--
--   own profile, `.eq("id", uid)`            Index Scan profiles_pkey   0.05 ms
--   40 profiles by id, shared club (hot)     Index Only Scan + filter   4.18 ms
--   40 profiles by id, no arm matches        Index Only Scan + filter    162 ms
--   unbounded `select count(*)`              Seq Scan, 1001 evals       1746 ms
--
-- The first two are the only shapes the app emits: every RLS-bound read of
-- `profiles` is either `.eq("id", user.id)` or `.in("id", ids)`, which
-- PostgREST renders as `id = ANY(array[...])` — an index qual, so the policy
-- runs on the requested rows only, not on the table. The two slow rows are
-- both denied paths (a caller asking for profiles it cannot see, or trying to
-- enumerate the table); they are slow because all five arms have to be
-- evaluated and fail, which is the correct trade.
--
-- Do not benchmark this with `id IN (SELECT ...)`. That plans as a hash
-- semi-join, and because the RLS qual is not leakproof the planner applies it
-- under a full Seq Scan *before* the join — 1001 helper calls for 40 rows,
-- ~1.9 s. It is a measurement artifact, not a shape any client produces.
--
-- ── DELIBERATELY NOT DONE HERE ──────────────────────────────
-- `subscribeToProfiles` still subscribes without a `filter`. It does not need
-- one: postgres_changes applies the SELECT policy per row at delivery time, so
-- narrowing the policy narrows the stream. A server-side `filter=` cannot
-- express "shared club" anyway. The client is unchanged in this migration's PR.
-- ============================================================

-- ── Visibility predicate ────────────────────────────────────
-- STABLE (not IMMUTABLE): reads tables and auth.uid().
-- SECURITY DEFINER: club_members / queue_entries / matches / match_players
-- all carry their own RLS, and evaluating them as the caller here would make
-- profile visibility depend transitively on four more policies. It reads no
-- profiles row, so there is no recursion back into the policy below.
--
-- NOT declared STRICT on purpose: a NULL argument must answer false, not NULL.
-- EXISTS never yields NULL, so the whole expression is total.
create or replace function public.can_read_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select
    -- 1. shared active club
    exists (
      select 1
      from public.club_members me
      join public.club_members them on them.club_id = me.club_id
      where me.player_id = (select auth.uid())
        and me.is_active
        and them.player_id = p_profile_id
        and them.is_active
    )
    -- 2. target is queued in a session I can reach.
    -- LOAD-BEARING: the reachability conjunct below is deliberately the same
    -- test the `queue_select` policy applies —
    --   `public.session_access_level(session_id) IS NOT NULL`
    -- (20260717171903_rls_consolidate_access_helpers.sql). Not textually
    -- identical: this one is alias-qualified and adds `qe.player_id =
    -- p_profile_id` to pin the row to the profile being read. Semantically the
    -- reachability half must stay equal. v_queue_full_with_wait_time is
    -- security_invoker and INNER JOINs profiles, so if arm 2 is ever made
    -- narrower than queue_select the organizer's queue starts DROPPING ROWS
    -- rather than rendering "Unknown" — a missing player, not a missing name.
    -- (The direct `.in("id", queueIds)` read in use-organizer-queue.ts is the
    -- milder path: that one degrades to "Unknown".) Change both or neither.
    or exists (
      select 1
      from public.queue_entries qe
      where qe.player_id = p_profile_id
        and public.session_access_level(qe.session_id) is not null
    )
    -- 3. target played a match in a session I can reach
    or exists (
      select 1
      from public.match_players mp
      join public.matches m on m.id = mp.match_id
      where mp.player_id = p_profile_id
        and public.session_access_level(m.session_id) is not null
    )
    -- 4. target organizes a session I can reach
    or exists (
      select 1
      from public.session_organizers so
      where so.user_id = p_profile_id
        and public.session_access_level(so.session_id) is not null
    )
    -- 5. target created a session I can reach
    or exists (
      select 1
      from public.sessions s
      where s.created_by = p_profile_id
        and public.session_access_level(s.id) is not null
    );
$fn$;

comment on function public.can_read_profile(uuid) is
  'True when the calling user may read the given profile row: shared active club, or the target participates in (queue/match) or runs (organizer/creator) a session the caller can access. Backs the profiles_select RLS policy. Returns false — never NULL — for an unknown or NULL id.';

-- RLS policies invoke helpers as the CALLING role. `profiles_select` is
-- `TO authenticated` and `profiles` has no anon SELECT policy at all, so
-- `authenticated` is the entire requirement here. That makes this helper
-- deliberately NARROWER than session_access_level() and the other five RLS
-- helpers, which must keep anon EXECUTE because anon-facing policies name them.
--
-- `create function` grants EXECUTE to PUBLIC by default, which would publish
-- /rest/v1/rpc/can_read_profile to unauthenticated callers — and unlike the
-- pure string parser in PR #40's 20260723100000 (not on this branch) this one
-- reads tables, so an anon
-- caller could use it as a membership oracle. Revoke it.
--
-- service_role is granted FIRST, per the from-scratch replay trap documented
-- in 20260722000004: on a proacl-NULL function `revoke ... from public`
-- materialises the default ACL and strips service_role along with PUBLIC.
grant execute on function public.can_read_profile(uuid) to service_role;
revoke execute on function public.can_read_profile(uuid)
  from public, anon, authenticated;
grant execute on function public.can_read_profile(uuid) to authenticated;

-- ── The policy ──────────────────────────────────────────────
-- The self arm stays in the policy rather than inside the helper: it is a
-- bare equality on the primary key, so the planner can use it directly for
-- the `.eq("id", user.id)` reads that dominate the server components, without
-- entering the function at all.
drop policy if exists profiles_select on public.profiles;

create policy profiles_select on public.profiles
  for select
  to authenticated
  using (
    profiles.id = (select auth.uid())
    or public.can_read_profile(profiles.id)
  );

-- ── Assert the end state ────────────────────────────────────
-- Same rationale as 20260722000002: a silent no-op would
-- hand back a database that looks hardened and is not. Stop the replay.
do $$
declare
  v_qual text;
begin
  select pg_get_expr(p.polqual, p.polrelid)
    into v_qual
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'profiles' and p.polname = 'profiles_select';

  if v_qual is null then
    raise exception 'profiles_select is missing from public.profiles';
  end if;

  -- The whole point of the migration: the old predicate was the literal
  -- `true`. If a later baseline re-declaration wins the race, catch it here.
  if btrim(v_qual) = 'true' then
    raise exception 'profiles_select is still USING (true) — finding #8 is not closed';
  end if;

  if v_qual not like '%can_read_profile%' then
    raise exception 'profiles_select does not reference can_read_profile: %', v_qual;
  end if;

  -- SELECT-only, authenticated-only. `polcmd` 'r' = SELECT.
  if not exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'profiles' and p.polname = 'profiles_select'
     and p.polcmd = 'r'
     and (select array_agg(rolname order by rolname) from pg_roles where oid = any(p.polroles))
         = array['authenticated']::name[]
  ) then
    raise exception 'profiles_select must be a SELECT policy scoped to authenticated only';
  end if;

  -- No SELECT policy on profiles may name anon or PUBLIC. If one is ever
  -- added, can_read_profile has no anon EXECUTE and that policy would fail
  -- closed in a way that looks like a data bug. Fail loudly here instead.
  if exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'profiles'
     and p.polcmd in ('r', '*')
     and (
       0 = any(p.polroles)                                                   -- PUBLIC
       or exists (select 1 from pg_roles r where r.oid = any(p.polroles) and r.rolname = 'anon')
     )
  ) then
    raise exception 'an anon/PUBLIC SELECT policy on profiles needs an anon EXECUTE grant on can_read_profile';
  end if;

  -- Grants, both directions.
  if not (
    has_function_privilege('authenticated', 'public.can_read_profile(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.can_read_profile(uuid)', 'execute')
  ) then
    raise exception 'can_read_profile EXECUTE grants are incomplete — profiles_select would fail closed';
  end if;

  if has_function_privilege('anon', 'public.can_read_profile(uuid)', 'execute') then
    raise exception 'can_read_profile is anon-executable — revoke it from public/anon';
  end if;

  -- The hard constraint this migration must not break: session_access_level
  -- is invoked by policies as anon AND as authenticated. The schema-parity
  -- sweep cannot catch a lost grant because it filters provolatile = 'v' and
  -- this function is STABLE.
  if not (
    has_function_privilege('anon', 'public.session_access_level(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.session_access_level(uuid)', 'execute')
  ) then
    raise exception 'session_access_level lost a grant — can_read_profile arms 2/3 would fail closed';
  end if;

  -- Behaviour with no JWT: auth.uid() is NULL during a migration, so every
  -- arm must be false. This also proves the function is total — it must not
  -- raise, and must not return NULL, for an id that matches nothing.
  if public.can_read_profile(gen_random_uuid()) is distinct from false then
    raise exception 'can_read_profile must return false for an unknown id with no JWT';
  end if;

  if public.can_read_profile(null) is distinct from false then
    raise exception 'can_read_profile must return false (not NULL) for a NULL id';
  end if;
end $$;
