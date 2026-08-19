#!/usr/bin/env python3
"""
Generate supabase/migrations/20260820000000_wrapped_reads_the_ledger_as_of_this_session.sql

Why a generator and not a hand-written migration
------------------------------------------------
compute_session_wrapped's body is ~49 KB on one logical line per CTE. Editing it
by hand is how 20260718150312 ended up rewriting a fragment it could not see.
This script starts from the body the repo already declares in
20260811000000_one_time_milestone_awards.sql -- which was verified byte-for-byte
equal to production's pg_proc.prosrc (md5 e3689008fe20a015421a0c69afc49375 over
'\n' + body + '\n') -- and applies ANCHORED substitutions. Every anchor must
match exactly once or the script aborts and writes nothing.

Re-verify the baseline before trusting a regeneration:

    select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='compute_session_wrapped';

Run:  python3 scripts/gen-wrapped-as-of-migration.py
"""

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "supabase/migrations/20260811000000_one_time_milestone_awards.sql"
OUT = ROOT / "supabase/migrations/20260820000000_wrapped_reads_the_ledger_as_of_this_session.sql"

# md5 of ('\n' + body + '\n'), i.e. exactly what pg_proc.prosrc holds.
BASELINE_MD5 = "e3689008fe20a015421a0c69afc49375"


def extract_body(sql: str) -> str:
    i = sql.index("AS $function$\n") + len("AS $function$\n")
    j = sql.index("\n$function$", i)
    return sql[i : j + 1]


def sub_once(body: str, old: str, new: str, label: str) -> str:
    n = body.count(old)
    if n != 1:
        sys.exit(f"ABORT: anchor '{label}' matched {n} times, expected exactly 1")
    return body.replace(old, new)


# ── the substitutions ───────────────────────────────────────────────────────

# 1. A boundary for "since this session started".
DECL_OLD = (
    "v_first_match_id uuid:=NULL; v_last_match_id uuid:=NULL; "
    "v_club_id uuid:=NULL; v_milestone_holder uuid:=NULL;"
)
DECL_NEW = DECL_OLD + " v_session_start timestamptz:=NULL;"

LOOKUP_OLD = "  SELECT club_id INTO v_club_id FROM sessions WHERE id=p_session_id;"
LOOKUP_NEW = (
    "  SELECT club_id,created_at INTO v_club_id,v_session_start "
    "FROM sessions WHERE id=p_session_id;"
)

# 2. The hub CTE. Three scans are inserted ahead of it:
#
#    since_matches       every completed club match from this session onward.
#                        Predicates copied from refresh_cross_session_stats'
#                        `completed` CTE (is_hidden=false, status, both scores
#                        NOT NULL) because the quantity being subtracted has to
#                        be measured the same way the ledger measured it.
#                        The session_id arm keeps tonight in the window even if
#                        completed_at is NULL, so tonight is always removed
#                        exactly once -- that is what preserves today's numbers
#                        on the normal path.
#    since_vs_rival      that window, aggregated per (player, opponent).
#    since_with_partner  that window, aggregated per (player, teammate).
#    tonight_with_partner  this session only, per (player, teammate).
#
# rivalry_with_tonight keeps its exact output column list, so the ~90-branch
# award ladder below it is untouched. What changes is what the columns MEAN:
# `pre_*` is now genuinely before this session, and wins_vs / losses_vs /
# sessions_faced are as of the END of this session rather than as of now.
RWT_OLD = (
    "  rivalry_with_tonight AS (SELECT pr.player_id,pr.rival_id,pr.wins_vs,pr.losses_vs,"
    "pr.sessions_faced,(pr.wins_vs-COALESCE(tvr.tonight_wins,0)) AS pre_wins_vs,"
    "(pr.losses_vs-COALESCE(tvr.tonight_losses,0)) AS pre_losses_vs,"
    "COALESCE(tvr.tonight_wins,0) AS tonight_wins,COALESCE(tvr.tonight_losses,0) AS tonight_losses "
    "FROM player_rivalries pr LEFT JOIN tonight_vs_rival tvr ON tvr.player_id=pr.player_id "
    "AND tvr.rival_id=pr.rival_id WHERE pr.club_id=v_club_id "
    "AND pr.player_id IN(SELECT player_id FROM _wrapped_stats)),"
)

RWT_NEW = (
    "  since_matches AS (SELECT m.id AS match_id,m.session_id,mp.player_id,mp.team,"
    "CASE WHEN mp.team='a' AND m.team_a_score>m.team_b_score THEN true "
    "WHEN mp.team='b' AND m.team_b_score>m.team_a_score THEN true ELSE false END AS won "
    "FROM matches m JOIN sessions s ON s.id=m.session_id "
    "JOIN match_players mp ON mp.match_id=m.id "
    "WHERE s.club_id=v_club_id AND s.is_hidden=false AND m.status='completed' "
    "AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL "
    "AND (m.session_id=p_session_id OR m.completed_at>=v_session_start)),\n"
    "  since_vs_rival AS (SELECT p.player_id,opp.player_id AS rival_id,"
    "SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS since_wins,"
    "SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int AS since_losses,"
    "COUNT(DISTINCT p.session_id)::int AS since_sessions "
    "FROM since_matches p JOIN match_players opp ON opp.match_id=p.match_id "
    "AND opp.team!=p.team GROUP BY p.player_id,opp.player_id),\n"
    "  since_with_partner AS (SELECT p.player_id,tm.player_id AS partner_id,"
    "COUNT(*)::int AS since_games,SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS since_wins,"
    "COUNT(DISTINCT p.session_id)::int AS since_sessions "
    "FROM since_matches p JOIN match_players tm ON tm.match_id=p.match_id "
    "AND tm.team=p.team AND tm.player_id<>p.player_id GROUP BY p.player_id,tm.player_id),\n"
    "  tonight_with_partner AS (SELECT p.player_id,tm.player_id AS partner_id,"
    "COUNT(*)::int AS tonight_games,SUM(CASE WHEN p.won THEN 1 ELSE 0 END)::int AS tonight_wins "
    "FROM tonight_matches p JOIN match_players tm ON tm.match_id=p.match_id "
    "AND tm.team=p.team AND tm.player_id<>p.player_id GROUP BY p.player_id,tm.player_id),\n"
    "  rivalry_with_tonight AS (SELECT pr.player_id,pr.rival_id,"
    "(pr.wins_vs-COALESCE(svr.since_wins,0)+COALESCE(tvr.tonight_wins,0)) AS wins_vs,"
    "(pr.losses_vs-COALESCE(svr.since_losses,0)+COALESCE(tvr.tonight_losses,0)) AS losses_vs,"
    "(pr.sessions_faced-COALESCE(svr.since_sessions,0)"
    "+CASE WHEN tvr.player_id IS NULL THEN 0 ELSE 1 END) AS sessions_faced,"
    "(pr.wins_vs-COALESCE(svr.since_wins,0)) AS pre_wins_vs,"
    "(pr.losses_vs-COALESCE(svr.since_losses,0)) AS pre_losses_vs,"
    "COALESCE(tvr.tonight_wins,0) AS tonight_wins,COALESCE(tvr.tonight_losses,0) AS tonight_losses "
    "FROM player_rivalries pr "
    "LEFT JOIN since_vs_rival svr ON svr.player_id=pr.player_id AND svr.rival_id=pr.rival_id "
    "LEFT JOIN tonight_vs_rival tvr ON tvr.player_id=pr.player_id AND tvr.rival_id=pr.rival_id "
    "WHERE pr.club_id=v_club_id "
    "AND pr.player_id IN(SELECT player_id FROM _wrapped_stats)),"
)

# 3+4. The two nemesis/kryptonite lookups re-read the raw ledger. Point them at
# the bounded hub instead -- it is already club-scoped and already restricted to
# _wrapped_stats players, so the club predicate goes with the table.
SNA_OLD = (
    "  session_nemesis_alltime AS (SELECT ws.player_id,COALESCE(pr.wins_vs,0) AS cs_sn_my_alltime_wins,"
    "COALESCE(pr.losses_vs,0) AS cs_sn_alltime_losses,COALESCE(pr.sessions_faced,0) AS cs_sn_alltime_sessions "
    "FROM _wrapped_stats ws LEFT JOIN player_rivalries pr ON pr.player_id=ws.player_id "
    "AND pr.rival_id=ws.nemesis_id AND pr.club_id=v_club_id),"
)
SNA_NEW = (
    "  session_nemesis_alltime AS (SELECT ws.player_id,COALESCE(rwt.wins_vs,0) AS cs_sn_my_alltime_wins,"
    "COALESCE(rwt.losses_vs,0) AS cs_sn_alltime_losses,COALESCE(rwt.sessions_faced,0) AS cs_sn_alltime_sessions "
    "FROM _wrapped_stats ws LEFT JOIN rivalry_with_tonight rwt ON rwt.player_id=ws.player_id "
    "AND rwt.rival_id=ws.nemesis_id),"
)

SKA_OLD = (
    "  session_kryptonite_alltime AS (SELECT ws.player_id,COALESCE(pr.wins_vs,0) AS cs_sk_my_alltime_wins,"
    "COALESCE(pr.losses_vs,0) AS cs_sk_alltime_losses,COALESCE(pr.sessions_faced,0) AS cs_sk_alltime_sessions "
    "FROM _wrapped_stats ws LEFT JOIN player_rivalries pr ON pr.player_id=ws.player_id "
    "AND pr.rival_id=ws.kryptonite_victim_id AND pr.club_id=v_club_id),"
)
SKA_NEW = (
    "  session_kryptonite_alltime AS (SELECT ws.player_id,COALESCE(rwt.wins_vs,0) AS cs_sk_my_alltime_wins,"
    "COALESCE(rwt.losses_vs,0) AS cs_sk_alltime_losses,COALESCE(rwt.sessions_faced,0) AS cs_sk_alltime_sessions "
    "FROM _wrapped_stats ws LEFT JOIN rivalry_with_tonight rwt ON rwt.player_id=ws.player_id "
    "AND rwt.rival_id=ws.kryptonite_victim_id),"
)

# 5. The partnership ledger gets the same treatment. DISTINCT ON picks the top
# partner, so its ORDER BY has to rank on the bounded count too -- ranking on
# today's total would name a partner the player had not met yet.
PA_OLD = (
    "  partnership_alltime AS (SELECT DISTINCT ON(pp.player_id) pp.player_id,"
    "pp.partner_id AS cs_top_alltime_partner_id,pp.games_together AS cs_alltime_games_together,"
    "pp.wins_together AS cs_alltime_wins_together,pp.sessions_together AS cs_alltime_sessions_together,"
    "ROUND(pp.wins_together::numeric/NULLIF(pp.games_together,0)*100,1) AS cs_alltime_partner_win_rate "
    "FROM player_partnerships pp WHERE pp.club_id=v_club_id "
    "AND pp.player_id IN(SELECT player_id FROM _wrapped_stats) "
    "ORDER BY pp.player_id,pp.games_together DESC,pp.partner_id),"
)

_G = "(pp.games_together-COALESCE(swp.since_games,0)+COALESCE(twp.tonight_games,0))"
_W = "(pp.wins_together-COALESCE(swp.since_wins,0)+COALESCE(twp.tonight_wins,0))"
_S = (
    "(pp.sessions_together-COALESCE(swp.since_sessions,0)"
    "+CASE WHEN twp.player_id IS NULL THEN 0 ELSE 1 END)"
)

PA_NEW = (
    "  partnership_alltime AS (SELECT DISTINCT ON(pp.player_id) pp.player_id,"
    "pp.partner_id AS cs_top_alltime_partner_id," + _G + " AS cs_alltime_games_together,"
    + _W + " AS cs_alltime_wins_together," + _S + " AS cs_alltime_sessions_together,"
    "ROUND(" + _W + "::numeric/NULLIF(" + _G + ",0)*100,1) AS cs_alltime_partner_win_rate "
    "FROM player_partnerships pp "
    "LEFT JOIN since_with_partner swp ON swp.player_id=pp.player_id AND swp.partner_id=pp.partner_id "
    "LEFT JOIN tonight_with_partner twp ON twp.player_id=pp.player_id AND twp.partner_id=pp.partner_id "
    "WHERE pp.club_id=v_club_id "
    "AND pp.player_id IN(SELECT player_id FROM _wrapped_stats) "
    "ORDER BY pp.player_id," + _G + " DESC,pp.partner_id),"
)

# 6. "Previous session" was defined as ANY OTHER session, ranked by computed_at
# -- when the wrap was CALCULATED, not when the session was PLAYED. Both are
# wrong on a recompute: an old session's "previous" session becomes a later one,
# and re-running Fix Record reorders computed_at without a single match changing.
# Bound the set to sessions that started before this one and rank by the session
# clock. Hidden sessions are deliberately NOT filtered here -- that is a separate
# question about which wraps count, not about which of them came first.
PSR_OLD = (
    "  prior_sessions_ranked AS (SELECT player_id,win_pct,computed_at,"
    "ROW_NUMBER() OVER(PARTITION BY player_id ORDER BY computed_at DESC) AS rn "
    "FROM session_wrapped_stats WHERE session_id!=p_session_id "
    "AND session_id IN(SELECT id FROM sessions WHERE club_id=v_club_id) "
    "AND player_id IN(SELECT player_id FROM _wrapped_stats)),\n"
    "  prior_sessions AS (SELECT player_id,"
    "COUNT(*) FILTER(WHERE win_pct>=70)::int AS cs_prior_dominant_sessions,"
    "(array_agg(win_pct ORDER BY computed_at DESC))[1] AS cs_prior_last_win_pct "
    "FROM prior_sessions_ranked WHERE rn<=2 GROUP BY player_id),"
)

PSR_NEW = (
    "  prior_sessions_ranked AS (SELECT sws.player_id,sws.win_pct,"
    "ROW_NUMBER() OVER(PARTITION BY sws.player_id "
    "ORDER BY ps.created_at DESC,sws.session_id DESC) AS rn "
    "FROM session_wrapped_stats sws JOIN sessions ps ON ps.id=sws.session_id "
    "WHERE sws.session_id!=p_session_id AND ps.club_id=v_club_id "
    "AND ps.created_at<v_session_start "
    "AND sws.player_id IN(SELECT player_id FROM _wrapped_stats)),\n"
    "  prior_sessions AS (SELECT player_id,"
    "COUNT(*) FILTER(WHERE win_pct>=70)::int AS cs_prior_dominant_sessions,"
    "(array_agg(win_pct ORDER BY rn))[1] AS cs_prior_last_win_pct "
    "FROM prior_sessions_ranked WHERE rn<=2 GROUP BY player_id),"
)

# 7. prior_carry carries a streak forward from the session before. Same defect,
# same bound: DISTINCT ON picks one row, so its ORDER BY is the whole selection.
PC_OLD = (
    "  prior_carry AS (SELECT DISTINCT ON(player_id) player_id,"
    "(carry_forward->>'ended_on_win_streak')::int AS cs_prior_win_streak,"
    "(carry_forward->>'session_win_pct')::numeric AS cs_prior_session_win_pct "
    "FROM session_wrapped_stats WHERE session_id!=p_session_id "
    "AND session_id IN(SELECT id FROM sessions WHERE club_id=v_club_id) "
    "AND player_id IN(SELECT player_id FROM _wrapped_stats) "
    "AND carry_forward!='{}'::jsonb ORDER BY player_id,computed_at DESC)"
)

PC_NEW = (
    "  prior_carry AS (SELECT DISTINCT ON(sws.player_id) sws.player_id,"
    "(sws.carry_forward->>'ended_on_win_streak')::int AS cs_prior_win_streak,"
    "(sws.carry_forward->>'session_win_pct')::numeric AS cs_prior_session_win_pct "
    "FROM session_wrapped_stats sws JOIN sessions cs ON cs.id=sws.session_id "
    "WHERE sws.session_id!=p_session_id AND cs.club_id=v_club_id "
    "AND cs.created_at<v_session_start "
    "AND sws.player_id IN(SELECT player_id FROM _wrapped_stats) "
    "AND sws.carry_forward!='{}'::jsonb "
    "ORDER BY sws.player_id,cs.created_at DESC,sws.session_id DESC)"
)

SUBS = [    (DECL_OLD, DECL_NEW, "DECLARE v_session_start"),
    (LOOKUP_OLD, LOOKUP_NEW, "session lookup"),
    (RWT_OLD, RWT_NEW, "rivalry_with_tonight + since scans"),
    (SNA_OLD, SNA_NEW, "session_nemesis_alltime"),
    (SKA_OLD, SKA_NEW, "session_kryptonite_alltime"),
    (PA_OLD, PA_NEW, "partnership_alltime"),
    (PSR_OLD, PSR_NEW, "prior_sessions_ranked + prior_sessions"),
    (PC_OLD, PC_NEW, "prior_carry"),
]

HEADER = """\
-- ============================================================
-- compute_session_wrapped: read the ledgers AS OF this session, not as of now
-- ============================================================
-- WHAT IS WRONG
--
-- player_rivalries and player_partnerships are running totals with no time
-- dimension. compute_session_wrapped recovered a "before tonight" figure by
-- subtracting tonight out of them:
--
--     pre_wins_vs = pr.wins_vs - tonight_wins
--
-- That is only correct while the ledger contains nothing AFTER the session
-- being wrapped -- true for the ordinary close, which is why this has never
-- produced a wrong badge on production (28 wrapped sessions, 0 computed out of
-- chronological order, 0 overlapping sessions in the same club; measured
-- 2026-08-20). Re-derive the numbers with:
--
--     with w as (select s.club_id, s.id, s.created_at, min(sws.computed_at) ca
--                from session_wrapped_stats sws join sessions s on s.id=sws.session_id
--                group by 1,2,3)
--     select count(*) filter (where
--              row_number() over (partition by club_id order by created_at, id)
--           <> row_number() over (partition by club_id order by ca, id)) from w;
--
-- It stops being true the moment anything recomputes an OLD session's wrap.
-- src/app/actions/fix-player-record.ts does exactly that: after an organizer
-- corrects a roster it fires compute_session_wrapped on any closed session,
-- however long ago. The ledger by then holds every session since, so
-- "before tonight" silently includes matches from the player's future, and
-- cross_session_redemption / score_settled / dynasty_victim / max_serial_rival
-- all gate on it. The same recompute on the same row can produce a different
-- badge set every time it runs, which is the opposite of the idempotence the
-- caller documents.
--
-- THE SAME DEFECT IN THE MOMENTUM FAMILY
--
-- "Previous session" was defined twice -- prior_sessions_ranked (feeding
-- consistent_dominator and bounced_back) and prior_carry (feeding the carried
-- win streak) -- and both defined it as ANY OTHER session of the club, ranked
-- by session_wrapped_stats.computed_at DESC. That is when the wrap was
-- CALCULATED, not when the session was PLAYED, and it fails the same way:
-- recompute an old session and its "previous" session is a LATER one. It also
-- fails on its own -- re-running Fix Record rewrites computed_at, so the
-- ranking moves without a single match changing. Both are now bounded to
-- sessions that started before this one and ranked by the session clock, with
-- session_id as a deterministic tiebreak.
--
-- This one was caught by the replay harness rather than by reading: with the
-- ledger fix alone, redemption_arc and settled_the_score stopped drifting on a
-- recomputed old session and bounced_back still did.
--
-- WHAT THIS CHANGES
--
-- The subtraction window widens from "this session" to "this session and
-- everything after it", and the tonight-only figures are added back where a
-- number is meant to include tonight. One rule now holds for every
-- cross-session column in a wrap: it is as of the END of the session being
-- wrapped.
--
--     pre_wins_vs = ledger - since        (strictly before this session)
--     wins_vs     = ledger - since + tonight   (through the end of it)
--
-- WHY SUBTRACT RATHER THAN RE-DERIVE FROM matches
--
-- 20260812100000 rejected subtraction when it rebuilt the ledger, and the
-- reason it gave was specific: an ADDITIVE ledger cannot be trusted to contain
-- a session exactly once. That objection died with the additive ledger. Since
-- that migration the ledger is an absolute rebuild from complete match history,
-- so pr.wins_vs is exact by construction and subtracting from it is sound.
--
-- The alternative -- recomputing rivalry and partnership truth from `matches`
-- inside the wrap -- would put a SECOND definition of one quantity in a second
-- file with nothing keeping the two in step. That is this repository's most
-- repeated defect shape, and it would put it on the path of every wrap rather
-- than on the rare one. Subtraction keeps exactly one definition of the totals.
--
-- The since-window carries the ledger's own predicates (is_hidden=false,
-- status='completed', both scores NOT NULL) for the same reason: the quantity
-- being subtracted has to be measured the way the quantity it is subtracted
-- from was measured. That also retires the hazard 20260812100000 flagged in its
-- HIDDEN SESSIONS note -- closing a hidden session with completed matches used
-- to drive pre_wins_vs negative, because the ledger had excluded tonight and
-- the subtraction removed it anyway. The window now excludes it too.
--
-- NO-OP ON THE ORDINARY PATH, BY CONSTRUCTION
--
-- When the session being wrapped is the club's latest, the since-window is
-- exactly tonight, so ledger - since + tonight = ledger and every column holds
-- the value it holds today. tests/integration/cross-session-ledger.test.ts
-- pins both halves: the equivalence, and the out-of-order case that fails
-- without this migration.
--
-- NOT IN SCOPE
--
--   * refresh_cross_session_stats is untouched.
--   * The wrapped rows of hidden sessions still count as prior sessions.
--     refresh_cross_session_stats excludes is_hidden from the LEDGER, but
--     prior_sessions_ranked has always ranked every wrap that exists. That is a
--     question about which sessions count, not about which came first, and
--     changing it would move numbers this migration asserts are unchanged.
--   * No historical wrap is recomputed. The 638 stored rows keep the awards
--     their players have already seen.
--
-- HOW THIS FILE WAS BUILT
--
-- Generated by scripts/gen-wrapped-as-of-migration.py from the body declared in
-- 20260811000000_one_time_milestone_awards.sql, which was verified equal to
-- production's pg_proc.prosrc (md5 e3689008fe20a015421a0c69afc49375 over
-- '\\n' || body || '\\n') on 2026-08-20. Every substitution is anchored and the
-- generator aborts unless each anchor matches exactly once. Regenerate rather
-- than hand-editing.
--
-- APPLY BY HAND. Merging ships TypeScript only; verify with list_migrations.
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_session_wrapped(p_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
"""

FOOTER = """$function$;

-- Privileges are preserved across CREATE OR REPLACE; restated so a from-scratch
-- replay lands on the same grants production has. Restate the GRANTs BEFORE the
-- REVOKE: `revoke ... from public` also strips EXECUTE from service_role on a
-- database built from scratch (see docs -- revoke-strips-service-role).
grant execute on function public.compute_session_wrapped(uuid) to postgres with grant option;
grant execute on function public.compute_session_wrapped(uuid) to service_role;
revoke execute on function public.compute_session_wrapped(uuid) from public, anon, authenticated;

comment on function public.compute_session_wrapped(uuid) is
  'Computes and stores Session Wrapped stats + awards for one session. Every cross-session figure is as of the END of that session: the running ledgers are read, then everything from this session onward is subtracted back out, so a recompute of an old session (fixPlayerRecord) cannot count the player''s later matches as history. Bounded by 20260820000000.';
"""


def main() -> None:
    base_sql = BASE.read_text(encoding="utf-8")
    body = extract_body(base_sql)

    got = hashlib.md5(("\n" + body).encode("utf-8")).hexdigest()
    if got != BASELINE_MD5:
        sys.exit(
            f"ABORT: baseline body md5 is {got}, expected {BASELINE_MD5}.\n"
            f"  {BASE.name} no longer declares the function this generator was "
            f"written against. Re-verify against pg_proc before regenerating."
        )

    for old, new, label in SUBS:
        body = sub_once(body, old, new, label)

    for banned in ("FROM player_rivalries pr LEFT JOIN tonight_vs_rival",):
        if banned in body:
            sys.exit(f"ABORT: '{banned}' survived the rewrite")

    # Nothing may still read the raw ledgers except the three anchored FROM /
    # JOIN clauses that feed the bounded CTEs.
    reads = body.count("player_rivalries") + body.count("player_partnerships")
    if reads != 2:
        sys.exit(f"ABORT: {reads} ledger reads remain, expected 2")

    added = [ch for ch in (body) if ord(ch) > 127]
    if len(added) != 35:
        sys.exit(
            f"ABORT: body holds {len(added)} non-ASCII characters, expected the "
            f"baseline's 35 -- apply_migration strips non-ASCII from stored "
            f"function bodies, so added text must be ASCII-only"
        )

    OUT.write_text(HEADER + body + FOOTER, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
