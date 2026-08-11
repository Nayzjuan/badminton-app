-- ============================================================================
-- Repair: strip the duplicate milestone awards already stored in past wraps
-- ============================================================================
-- Companion to 20260811000000, which stopped the six all-time milestone awards
-- from re-firing every session. That fixes the future; this fixes the past.
-- compute_session_wrapped() only rewrites a session's rows when that session is
-- (re)computed, so without this the duplicates stay visible on every Wrapped
-- page people have already seen -- which is the actual reported symptom.
--
-- APPLY 20260811000000 FIRST. Running this against the OLD function leaves the
-- data correct for about one session: the next close re-adds a duplicate for
-- everyone who plays.
--
-- APPLY THIS FILE STANDALONE (SQL editor / psql), not through a runner that
-- already opens its own transaction: it manages its own begin; ... commit;, and
-- a nested begin; inside `supabase db push` would end the runner's transaction
-- early. See MEMORY.md -- migrations here are applied by hand anyway.
--
-- Rule: for each (club, player, award), keep the EARLIEST grant and revoke the
-- rest. Earliest by sessions.created_at, with sessions.id as the tiebreaker.
--
-- Deliberately NOT ordered by session_wrapped_stats.computed_at: 07/04's wrap
-- was computed on 07/05, and a repaired or backfilled wrap can be computed at
-- any time, so computed_at would crown the wrong session as "first".
--
-- Note the RPC itself does NOT re-derive this ordering -- its _prior_awards
-- ledger just asks "does any OTHER wrap of mine already carry this slug?".
-- Ordering is this migration's concern alone: it decides WHICH single wrap
-- becomes the canonical holder. Once that is settled the new RPC agrees with
-- the choice for EVERY session, not merely for the ones that already carry a
-- grant: recomputing any non-holding session suppresses the award outright,
-- and recomputing the holding session re-checks the award's own condition --
-- which the holder still passes for the three MONOTONE ones (century_club,
-- serial_rivals, soulmates), and may or may not for the other three.
--
-- Say it precisely, because the stronger version is false. The invariant is
-- "at most one wrap per (club, player) carries the award, and no recompute can
-- add a second". It is NOT "the holding wrap keeps it forever": the_veteran
-- (top-3 is relative), the_dynasty (a 70% rate can fall back under) and
-- winning_formula (your top partner can change) are non-monotone, so a
-- recompute of the holding session can find the condition no longer met and
-- drop the badge, which the ledger will not hand back on a later night.
-- Inherited from the old function, not introduced here.
--
-- Hidden sessions are excluded, matching both the RPC and
-- v_alltime_leaderboard_mat. A hidden session's wraps are left untouched
-- entirely rather than being merged into a real player's milestone history.
--
-- Measured against production by a full dry-run inside a rolled-back
-- transaction: 188 grants revoked across 128 wraps -- serial_rivals 98,
-- the_veteran 50, the_dynasty 23, century_club 13, winning_formula 4.
-- first_to_100 and soulmates: 0 (already correct / never earned). 48 duplicate
-- groups -> 0. No wrap is left empty, but step (3) keeps the RPC's "every wrap
-- carries at least one award" invariant true by construction rather than luck.
--
-- Generic (no hardcoded ids) and idempotent: re-running finds rn>1 nowhere,
-- updates nothing, and step (3) then has an empty work list.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- (1) Precondition. Step (2) revokes by SLUG, so it assumes a slug never
-- appears twice WITHIN one wrap's own array -- otherwise `x <> ALL (slugs)`
-- would drop both copies instead of one. compute_session_wrapped() cannot
-- produce that (one array_append site per award, and _prior_awards is
-- DISTINCT), and production has zero such rows, so this is a guard against a
-- future caller or a hand-edited row, not a known case. It aborts the whole
-- migration rather than silently mangling an array.
--
-- `count(*) INTO` always yields a row, so this cannot fall into the classic
-- "SELECT ... INTO left NULL on zero rows, IF not taken" trap.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad from (
    select sws.id, a.slug
    from session_wrapped_stats sws
    join sessions s on s.id = sws.session_id
    cross join lateral unnest(sws.earned_awards) as a(slug)
    where s.is_hidden = false
      and a.slug in (
        'century_club', 'first_to_100', 'the_veteran',
        'serial_rivals', 'the_dynasty', 'soulmates', 'winning_formula'
      )
    group by sws.id, a.slug
    having count(*) > 1
  ) t;

  if v_bad > 0 then
    raise exception
      'ABORT: % (wrap, slug) pair(s) carry the same milestone award twice within one wrap. Step (2) revokes by slug and would drop both copies. Deduplicate those arrays first.', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (2) Revoke every non-earliest grant of the seven milestone awards, and
-- record which wraps that emptied so step (3) can touch exactly those and
-- nothing else.
-- ---------------------------------------------------------------------------
create temp table _emptied_wraps (id uuid primary key) on commit drop;

with grants as (
  select sws.id as wrap_id,
         a.slug,
         row_number() over (
           partition by s.club_id, sws.player_id, a.slug
           order by s.created_at, s.id
         ) as rn
  from session_wrapped_stats sws
  join sessions s on s.id = sws.session_id
  cross join lateral unnest(sws.earned_awards) as a(slug)
  where s.is_hidden = false
    and a.slug in (
      'century_club', 'first_to_100', 'the_veteran',
      'serial_rivals', 'the_dynasty', 'soulmates', 'winning_formula'
    )
),
revoked as (
  select wrap_id, array_agg(slug) as slugs
  from grants
  where rn > 1
  group by wrap_id
),
upd as (
  update session_wrapped_stats sws
  set earned_awards = coalesce(
        (select array_agg(x order by ord)
         from unnest(sws.earned_awards) with ordinality as t(x, ord)
         where x <> all (r.slugs)),
        array[]::text[]
      ),
      award_data = sws.award_data - r.slugs
  from revoked r
  where sws.id = r.wrap_id
  returning sws.id, sws.earned_awards
)
insert into _emptied_wraps (id)
select id from upd
where coalesce(array_length(earned_awards, 1), 0) = 0;

-- ---------------------------------------------------------------------------
-- (3) Restore the RPC's invariant on any wrap step (2) emptied.
-- compute_session_wrapped() falls back to 'just_getting_started' when a player
-- earns nothing, so a stored wrap must never carry an empty award list -- the
-- Wrapped page has no other state to render. The payload below is byte-for-byte
-- what the RPC writes. Scoped to _emptied_wraps rather than to "every empty
-- wrap in the database": an empty wrap this migration did not create is not
-- this migration's to rewrite. Currently a no-op (0 rows in production).
-- ---------------------------------------------------------------------------
update session_wrapped_stats
set earned_awards = array['just_getting_started'],
    award_data = jsonb_build_object(
      'just_getting_started',
      jsonb_build_object(
        'games', games_played,
        'message', 'Come back next session — your story is just beginning.'
      )
    )
where id in (select id from _emptied_wraps);

commit;
