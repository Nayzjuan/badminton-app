-- ============================================================
-- refresh_cross_session_stats: guard-and-add -> absolute rebuild
-- ============================================================
-- WHAT WAS WRONG
--
-- The RPC that maintains the two all-time ledgers (player_rivalries,
-- player_partnerships) ACCUMULATED. It read one session's completed matches and
-- added them onto whatever was already stored:
--
--     on conflict (...) do update set wins_vs = player_rivalries.wins_vs + excluded.wins_vs
--
-- guarded by "if any ledger row already has last_session_id = p_session_id,
-- return". 20260510000000's header already retracted the claim that this is
-- idempotence: last_session_id is OVERWRITTEN whenever a pair meets again, so
-- the guard decays -- once every pair from an old session has played a newer
-- one, nothing points at that session any more and a re-run adds it twice.
--
-- The deeper problem is that an additive ledger has no way back. A miss is
-- permanent. Step 0a of closeSession is non-fatal by design (a failure there is
-- logged and the close continues), a session can be abandoned without ever being
-- closed, and in either case nothing downstream ever notices the gap.
--
-- Measured on production 2026-08-12, before the repair:
--
--     player_rivalries     stored 2342 rows, truth 3504
--     player_partnerships  stored 1610 rows, truth 2400
--
-- Mostly under-count, but not monotone: 6 rivalry and 4 partnership rows were
-- HIGH on one component and low on the other, and 2 partnership rows had no
-- surviving match backing at all. MEMORY.md owns the full breakdown and the
-- award deltas -- read it there rather than restating them here.
--
-- The one-off repair (absolute upsert + prune, backups in
-- player_{rivalries,partnerships}_prerebuild_20260812) was applied by hand to
-- production on 2026-08-12 and left both ledgers at drift 0. THIS migration is
-- the upstream half: without it the same drift starts accumulating again on the
-- very next session close.
--
-- WHY ABSOLUTE, AND NOT "SUBTRACT THIS SESSION, THEN RE-ADD IT"
--
-- To subtract a session's contribution you have to trust that the running total
-- already contains it exactly once. That assumption is the thing that was false.
-- An absolute rebuild needs no such trust and is self-healing: every close
-- repairs whatever drift earlier closes left behind, including contributions
-- from sessions that were never closed at all.
--
-- COST
--
-- Measured on production 2026-08-12 (876 completed matches, 192 players with
-- completed history, 7008 rivalry join rows, 3504 / 2400 stored ledger rows).
-- Three statements, each timed on its own with EXPLAIN ANALYZE:
--
--     rivalry truth CTE       23.7 ms      120 buffer hits
--     rivalry prune          173.5 ms  114 311 buffer hits
--     partnership prune      128.6 ms   82 172 buffer hits
--
-- That is ~330 ms, but it is a PARTIAL sum: it omits the partnership truth CTE
-- and both upserts. It is still the best figure available FOR THIS BODY, because
-- those three statements were run against this body directly. Treat it as a
-- measured floor, not the per-close total.
--
-- Do NOT reach for pg_stat_statements to complete it. That view's 47-call
-- PostgREST entry (min 8.5, mean 109, max 604 ms) is entirely the OLD
-- one-session body: ZERO sessions have closed since this migration was applied,
-- and the last close was 2026-08-06, six days before it. APP_MANIFEST.md already
-- attributes that same accumulating row to the pre-migration function, so
-- quoting it here would have the one document give two different owners to one
-- number. The 5-call manual entry (max 633 ms) does contain at least one
-- invocation of this body -- the post-apply run is the only thing that could
-- stamp all 5904 ledger rows with a single updated_at -- but the max cannot be
-- pinned to that call.
--
-- THIS FUNCTION HAS NEVER RUN THROUGH closeSession(). Expect several hundred ms;
-- take the first real close as the actual measurement.
--
-- Within the call, the PRUNES are the expensive part, and they are not the
-- club-history term: each is a correlated `not exists` re-evaluated once per
-- STORED ledger row (3504 and 2400 loops respectively), every evaluation doing
-- two idx_match_players_player probes. Cost is therefore roughly ledger rows x
-- per-player match rows. BOTH of those factors grow with match history, so the
-- prune is SUPERLINEAR in history -- quoting a linear-in-history figure would
-- point a future reader at the wrong term. Roster-squared is the eventual
-- ceiling, not today's driver: 192 players would be 36 672 dense rivalry rows
-- against 3504 actual (9.6% density), because rows are still match-bound
-- (876 matches x 8 ordered pair-instances = the 7008 join rows above).
--
-- A few hundred ms on every close is fine today: step 0a is non-fatal, budget is
-- 8 s. The cheap fix when it stops being fine is to have each prune reference
-- its own truth CTE (`not exists (select 1 from rivalry_truth t where ...)`)
-- instead of re-deriving the condition from base tables -- one pass over an
-- already-computed relation rather than a probe per ledger row. That is a
-- rewrite of these two statements only; do NOT go back to blind adds.
--
-- One more thing this costs: the upsert sets `updated_at = now()` with no WHERE
-- on the conflict action, so every close writes a new row version for every
-- ledger row in the club even when nothing semantic changed. That is a real
-- autovacuum cost, and it is why a "did this invocation change anything" check
-- has to compare the semantic columns and exclude updated_at by construction.
--
-- HIDDEN SESSIONS
--
-- Newly relevant here. While the function processed one session at a time, an
-- E2E sandbox session only reached the ledgers if something closed it. A
-- club-wide scan would sweep every sandbox match in permanently -- and these
-- ledgers are CACHED cross-session aggregate state, which is exactly the
-- argument 20260804000000 made for excluding is_hidden from
-- v_alltime_leaderboard_mat. So the scan carries the same predicate. This
-- changes nothing on production today: 2 hidden sessions, 0 completed matches
-- between them (checked 2026-08-12).
--
-- It does create one coupling that did not exist before. compute_session_wrapped's
-- `tonight_matches` CTE filters on session_id alone, with no is_hidden test, and
-- `rivalry_with_tonight` computes pre_wins_vs = pr.wins_vs - tonight_wins. Close a
-- HIDDEN session with completed matches and those two disagree: the ledger has
-- excluded tonight, the subtraction still removes it, and pre_wins_vs goes
-- negative -- which score_settled and cross_session_redemption both gate on.
-- Not reachable today: the only hidden session is the E2E sandbox, and the spec
-- that ends it does so with a direct `is_active=false` update, never through
-- closeSession(). If anything ever closes a hidden session for real, either give
-- tonight_matches the same predicate or drop this one.
--
-- PRUNING
--
-- Ledger rows with no surviving match backing are deleted. That is how the 2
-- orphan partnership rows went; without it, nothing could ever retract a row
-- that a later data correction invalidated (an identity merge, a deleted match,
-- a swap fix).
--
-- CONCURRENCY
--
-- Takes a per-club advisory xact lock so two concurrent closes in the same club
-- serialize instead of rebuilding from overlapping snapshots. The key is
-- distinct from compute_session_wrapped's ('wrapped_awards:'||club_id).
--
-- No deadlock against that RPC, but NOT because each takes only one lock --
-- compute_session_wrapped takes two: 'wrapped_awards:'||club_id, and then
-- hashtext('leaderboard_refresh') inside refresh_alltime_leaderboard()
-- (20260717171328). The reasons it is safe are that this function takes exactly
-- ONE ADVISORY lock and takes it before it touches any row, so nothing can hold
-- a ledger row lock while waiting on this key and it cannot be a link in a wait
-- cycle; that the leaderboard lock is pg_try_advisory_xact_lock, which
-- returns early instead of waiting; and that closeSession invokes the two RPCs
-- in separate round-trips, so neither transaction is holding a lock while it
-- waits on the other's. If that try-lock is ever made blocking, re-check this.
--
-- Idempotent DDL. Signature and grants unchanged.
--
-- ⚠ COMMENTS INSIDE THE FUNCTION BODY ARE ASCII-ONLY ON PURPOSE. The `── x ──`
-- section rules this file uses in the header are fine there (the header is not
-- stored), but the two that were originally inside the body came back from
-- apply_migration stripped to plain `-- player_rivalries`, leaving prosrc 253
-- bytes shorter than the file. Repo/prod drift in comments only, but it defeats
-- the md5 check that 20260810000000 relies on to prove a body matches. The two
-- lines are now written the way prod stores them, and the body is byte-identical
-- to prod: 6412 bytes, md5 2cdfc65fd399c295f26425b388aa0bb8 (verified
-- 2026-08-12 against btrim(prosrc, E'\n')).
-- ============================================================

create or replace function public.refresh_cross_session_stats(p_session_id uuid)
  returns void
  language plpgsql
  security definer
  -- create or replace resets SET clauses that are not respecified, so this has
  -- to be restated or 20260702000004's search_path pinning is silently undone.
  set search_path = public, pg_temp
as $function$
declare
  v_club_id uuid;
begin
  -- p_session_id is now only a pointer to the club whose ledgers to rebuild.
  select club_id into v_club_id from public.sessions where id = p_session_id;
  if v_club_id is null then
    return;  -- session missing or not club-scoped; nothing to rebuild
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cross_session_stats:' || v_club_id::text, 0));

  -- player_rivalries
  with completed as (
    select
      m.id            as match_id,
      m.session_id,
      m.completed_at,
      mp.player_id,
      mp.team,
      -- A draw counts as a loss for both sides. Carried over verbatim from the
      -- additive version: this is a rebuild of the same quantity, not a
      -- redefinition of it.
      case
        when mp.team = 'a' and m.team_a_score > m.team_b_score then true
        when mp.team = 'b' and m.team_b_score > m.team_a_score then true
        else false
      end             as won
    from public.matches m
    join public.sessions s      on s.id = m.session_id
    join public.match_players mp on mp.match_id = m.id
    where s.club_id = v_club_id
      and s.is_hidden = false
      and m.status = 'completed'
      and m.team_a_score is not null
      and m.team_b_score is not null
  ),
  rivalry_truth as (
    select
      p.player_id,
      opp.player_id                                   as rival_id,
      sum(case when p.won     then 1 else 0 end)::int as wins_vs,
      sum(case when not p.won then 1 else 0 end)::int as losses_vs,
      count(distinct p.session_id)::int               as sessions_faced,
      max(p.completed_at)                             as last_faced_at,
      (array_agg(p.session_id
         order by p.completed_at desc nulls last, p.match_id desc))[1] as last_session_id
    from completed p
    join public.match_players opp
      on opp.match_id = p.match_id
     and opp.team <> p.team
    group by p.player_id, opp.player_id
  )
  insert into public.player_rivalries (
    club_id, player_id, rival_id, wins_vs, losses_vs,
    sessions_faced, last_session_id, last_faced_at, updated_at
  )
  select
    v_club_id, player_id, rival_id, wins_vs, losses_vs,
    sessions_faced, last_session_id, last_faced_at, now()
  from rivalry_truth
  on conflict (club_id, player_id, rival_id) do update set
    -- ASSIGN, do not add. This is the whole fix.
    wins_vs         = excluded.wins_vs,
    losses_vs       = excluded.losses_vs,
    sessions_faced  = excluded.sessions_faced,
    last_session_id = excluded.last_session_id,
    last_faced_at   = excluded.last_faced_at,
    updated_at      = now();

  -- Prune rows the rebuild did not write. The predicate is the exact complement
  -- of rivalry_truth's grouping keys: a pair survives iff it appears on opposite
  -- teams in at least one qualifying match, which is precisely the condition
  -- under which the insert above produced a row for it.
  delete from public.player_rivalries pr
  where pr.club_id = v_club_id
    and not exists (
      select 1
      from public.matches m
      join public.sessions s      on s.id = m.session_id
      join public.match_players a on a.match_id = m.id and a.player_id = pr.player_id
      join public.match_players b on b.match_id = m.id and b.player_id = pr.rival_id
      where s.club_id = v_club_id
        and s.is_hidden = false
        and m.status = 'completed'
        and m.team_a_score is not null
        and m.team_b_score is not null
        and b.team <> a.team
    );

  -- player_partnerships
  with completed as (
    select
      m.id            as match_id,
      m.session_id,
      m.completed_at,
      mp.player_id,
      mp.team,
      case
        when mp.team = 'a' and m.team_a_score > m.team_b_score then true
        when mp.team = 'b' and m.team_b_score > m.team_a_score then true
        else false
      end             as won
    from public.matches m
    join public.sessions s      on s.id = m.session_id
    join public.match_players mp on mp.match_id = m.id
    where s.club_id = v_club_id
      and s.is_hidden = false
      and m.status = 'completed'
      and m.team_a_score is not null
      and m.team_b_score is not null
  ),
  partnership_truth as (
    select
      p.player_id,
      partner.player_id                               as partner_id,
      count(*)::int                                   as games_together,
      sum(case when p.won     then 1 else 0 end)::int as wins_together,
      sum(case when not p.won then 1 else 0 end)::int as losses_together,
      count(distinct p.session_id)::int               as sessions_together,
      max(p.completed_at)                             as last_played_at,
      (array_agg(p.session_id
         order by p.completed_at desc nulls last, p.match_id desc))[1] as last_session_id
    from completed p
    join public.match_players partner
      on partner.match_id  = p.match_id
     and partner.team      = p.team
     and partner.player_id <> p.player_id
    group by p.player_id, partner.player_id
  )
  insert into public.player_partnerships (
    club_id, player_id, partner_id,
    games_together, wins_together, losses_together,
    sessions_together, last_session_id, last_played_at, updated_at
  )
  select
    v_club_id, player_id, partner_id,
    games_together, wins_together, losses_together,
    sessions_together, last_session_id, last_played_at, now()
  from partnership_truth
  on conflict (club_id, player_id, partner_id) do update set
    games_together    = excluded.games_together,
    wins_together     = excluded.wins_together,
    losses_together   = excluded.losses_together,
    sessions_together = excluded.sessions_together,
    last_session_id   = excluded.last_session_id,
    last_played_at    = excluded.last_played_at,
    updated_at        = now();

  delete from public.player_partnerships pp
  where pp.club_id = v_club_id
    and not exists (
      select 1
      from public.matches m
      join public.sessions s      on s.id = m.session_id
      join public.match_players a on a.match_id = m.id and a.player_id = pp.player_id
      join public.match_players b on b.match_id = m.id and b.player_id = pp.partner_id
      where s.club_id = v_club_id
        and s.is_hidden = false
        and m.status = 'completed'
        and m.team_a_score is not null
        and m.team_b_score is not null
        and b.team = a.team
        and b.player_id <> a.player_id
    );

end;
$function$;

comment on function public.refresh_cross_session_stats(uuid) is
  'Rebuilds player_rivalries and player_partnerships for the club owning p_session_id from complete match history (excluding is_hidden sessions), then prunes rows with no match backing. Absolute and idempotent -- replaced the additive, one-shot-guarded version on 2026-08-12.';

-- Privileges are preserved across create or replace; restated so a from-scratch
-- `supabase db reset` lands in the same state. Grant first, then revoke -- a
-- bare `revoke ... from public` also strips service_role when no explicit grant
-- exists (see 20260723000000).
grant  execute on function public.refresh_cross_session_stats(uuid) to service_role;
revoke execute on function public.refresh_cross_session_stats(uuid) from public, anon, authenticated;
