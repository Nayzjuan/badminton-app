-- Exclude hidden sessions from the club-wide all-time leaderboard.
--
-- 20260721101500_sessions_is_hidden.sql introduced `sessions.is_hidden` as a
-- listing flag and said so explicitly: "hiding is a listing concern, not an
-- access-control one." That is true for the pages that enumerate sessions, but
-- it left a gap in the leaderboard chain.
--
-- v_match_history joins `sessions` only to project `club_id` — there is no
-- is_hidden predicate anywhere downstream — so every completed match in the
-- E2E sandbox session flows into v_alltime_leaderboard_mat for the sandbox's
-- club. endMatchAction() then calls refresh_alltime_leaderboard(), which
-- rebuilds the matview across all clubs, baking the bot rows in. E2E teardown
-- deletes the matches but never refreshes, so the bot rows outlive the run as
-- phantoms on a real club's all-time board until some real match happens to
-- trigger the next refresh.
--
-- The fix is deliberately scoped to the ALL-TIME matview only:
--
--   • v_match_history and v_session_leaderboard are left untouched. They are
--     consumed session-scoped (Wrapped, the in-session leaderboard tab, a
--     player's own match history), where a hidden session's own results are
--     legitimate and the E2E specs assert on them.
--   • v_alltime_leaderboard_mat is the cross-session, club-wide board. Nothing
--     from an infrastructure session belongs there.
--
-- The two RPCs that getAllTimeLeaderboard() calls alongside the matview —
-- get_alltime_snapshot_before() (feeds the rank-movement Δ) and
-- get_player_streaks() (feeds the streak flame) — are deliberately NOT filtered
-- here. Both aggregate v_match_history live at request time, so a sandbox match
-- can only influence them while it exists; teardown deletes the matches and
-- both self-heal on the next request with no refresh step. The matview is the
-- only surface that CACHES the aggregation, which is precisely why it is the
-- only one that can strand phantom bot rows on a real club's board, and so the
-- only one that needs a predicate. Filtering the RPCs too would be harmless but
-- would imply the leak lived there as well, which it does not.
--
-- A materialized view's definition cannot be replaced in place, so this drops
-- and recreates it, then restores the unique index (required by the CONCURRENTLY
-- refresh in refresh_alltime_leaderboard()) and the service_role grant.
--
-- The revokes at the bottom are NOT optional. Creating any relation in `public`
-- applies this project's ALTER DEFAULT PRIVILEGES, which hand anon and
-- authenticated full table privileges — silently undoing
-- 20260722010001_lock_leaderboard_reads_to_service_role.sql. That restriction
-- exists because all-time leaderboard reads go through server actions and a
-- matview cannot carry RLS, so without the revokes this recreate would expose
-- every club's board to any anonymous caller. Verified against pg_class.relacl
-- after applying: {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}.
-- Any future migration that recreates this matview must repeat them.
--
-- Two deliberate deviations from 20260722010001, which is the sibling this
-- block is modelled on — both are intentional, do not "harmonise" them away:
--
--   • That migration revokes `from public, anon, authenticated`; the grantee
--     list here now matches it. PUBLIC holds nothing on a freshly created
--     matview (CREATE grants no default PUBLIC privilege on relations, and
--     production's relacl above confirms no PUBLIC entry), so adding it is a
--     no-op against the state this migration already produced — it is here so
--     a from-scratch replay and any copy-paste of this block are closed by
--     construction rather than by luck. The revokes are ordered AFTER the
--     service_role grant on purpose: `REVOKE ... FROM PUBLIC` strips only the
--     PUBLIC entry and leaves explicit role grants intact, which is exactly
--     why service_role must hold its privilege explicitly and never inherit
--     one from PUBLIC.
--   • That migration grants service_role `select`; this one grants `all`, and
--     that is what production actually has (service_role=arwdDxtm above).
--     Narrowing it here would put the repo out of step with the live ACL for
--     no gain — service_role is the trusted server-side role and needs
--     MAINTAIN to run the CONCURRENTLY refresh in refresh_alltime_leaderboard().

drop materialized view if exists public.v_alltime_leaderboard_mat;

create materialized view public.v_alltime_leaderboard_mat as
with match_results as (
  select
    mh.player_id,
    mh.club_id,
    case
      when ((mh.team = 'a'::bpchar) and (mh.team_a_score > mh.team_b_score))
        or ((mh.team = 'b'::bpchar) and (mh.team_b_score > mh.team_a_score))
      then 1
      else 0
    end as won,
    case when mh.team = 'a'::bpchar
      then coalesce(mh.team_a_score, 0)
      else coalesce(mh.team_b_score, 0)
    end as pts_for,
    case when mh.team = 'a'::bpchar
      then coalesce(mh.team_b_score, 0)
      else coalesce(mh.team_a_score, 0)
    end as pts_against
  from public.v_match_history mh
  -- The only change from the previous definition: infrastructure sessions
  -- (the E2E sandbox) never reach a real club's all-time board.
  join public.sessions s on s.id = mh.session_id
  where mh.match_status = 'completed'::match_status
    and s.is_hidden = false
)
select
  mr.player_id,
  mr.club_id,
  p.display_name,
  (count(*))::integer as games_played,
  (sum(mr.won))::integer as wins,
  ((count(*) - sum(mr.won)))::integer as losses,
  (sum(mr.pts_for))::integer as points_for,
  (sum(mr.pts_against))::integer as points_against,
  ((sum(mr.pts_for) - sum(mr.pts_against)))::integer as point_diff,
  round((((sum(mr.won))::numeric / (nullif(count(*), 0))::numeric) * (100)::numeric), 1) as win_pct
from match_results mr
join public.profiles p on p.id = mr.player_id
group by mr.club_id, mr.player_id, p.display_name;

-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index idx_alltime_leaderboard_club_player
  on public.v_alltime_leaderboard_mat using btree (club_id, player_id);

-- service_role must hold this explicitly — never by inheritance from PUBLIC,
-- which the revoke below removes.
grant all on public.v_alltime_leaderboard_mat to service_role;

-- Undo the default privileges the CREATE above just handed out. See the header.
revoke all on public.v_alltime_leaderboard_mat from public, anon, authenticated;
