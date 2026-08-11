#!/usr/bin/env python3
"""Regenerate supabase/migrations/20260811000000_one_time_milestone_awards.sql.

Run from anywhere:  python3 scripts/gen-one-time-milestone-awards-migration.py

The body of compute_session_wrapped is ~49 KB. NEVER hand-edit it -- edit the
substitutions below and re-run this, so the migration stays a mechanical,
reviewable delta against the 20260810000000 production capture.
See APP_MANIFEST.md 3.7.1.

Anchor-validated: every substitution must match exactly once, or we abort rather
than emit a corrupted 49 KB function body.
"""
import sys, pathlib

MIG = pathlib.Path(__file__).resolve().parent.parent / "supabase" / "migrations"
SRC = MIG / "20260810000000_declare_compute_session_wrapped.sql"
OUT = MIG / "20260811000000_one_time_milestone_awards.sql"

text = SRC.read_text()

# Keep only the function statement + grants (drop the baseline's header comment).
start = text.index("CREATE OR REPLACE FUNCTION public.compute_session_wrapped(p_session_id uuid)")
body = text[start:]

subs = []
pairs = []

def sub(search, replace, label):
    global body
    # The exactly-once check below is NOT sufficient on its own. For the seven
    # gate edits the needle is a SUBSTRING of its own replacement, so running
    # this generator against an ALREADY-MIGRATED body (e.g. someone repoints
    # SRC at the generated file, or at a fresh dump of production) would find
    # the needle exactly once -- inside the gate that is already there -- and
    # happily gate it a second time. Silent double-gating, not an abort.
    # So refuse outright if the finished text is already present.
    already = body.count(replace)
    if already:
        sys.exit(
            f"ABORT: anchor {label!r} looks ALREADY APPLIED -- its replacement text is "
            f"present {already}x in SRC. Is SRC pointed at a migrated body? "
            f"This generator's baseline must be the PRE-migration function."
        )
    n = body.count(search)
    if n != 1:
        sys.exit(f"ABORT: anchor {label!r} matched {n} times (expected 1)")
    body = body.replace(search, replace)
    subs.append(label)
    pairs.append((label, search, replace))

# ── 1. Serialize award computation per club ──
# _prior_awards is an unlocked snapshot, so two concurrent computes for two
# sessions of the SAME club would each build their ledger before the other
# commits and both grant the same one-time award -- re-creating the very
# duplicate this migration removes. Reachable two ways: two simultaneous
# closeSession calls, or a close racing fixPlayerRecord's fire-and-forget
# after() recompute. refresh_alltime_leaderboard() does NOT serialize them --
# it uses pg_try_advisory_xact_lock and returns EARLY on contention.
#
# Lock ordering is safe: this is taken before the refresh's own advisory lock
# and released at transaction end, and no path takes them in the reverse order.
# NULL club_id can't lock (hashtextextended is strict) -- guarded so the intent
# is explicit rather than relying on PERFORM swallowing a NULL.
#
# hashtextextended(..., 0), not hashtext(...), matching the house pattern in
# 20260702000000/20260702000008. Advisory locks live in ONE global bigint space
# that also holds hashtext('leaderboard_refresh') (20260717171328); hashtext
# only fills 32 of those bits. The distinct 'wrapped_awards:' prefix likewise
# keeps this off the club-member guards' key, which is the bare club id.
#
# One precondition worth stating: the lock only serializes the LEDGER READ
# because `CREATE TEMP TABLE _prior_awards AS SELECT` is a separate statement
# run after it, so under READ COMMITTED it takes a fresh snapshot that includes
# whatever the other transaction just committed. Under REPEATABLE READ or
# SERIALIZABLE the snapshot would predate the lock and "never twice" would break
# silently. closeSession/fixPlayerRecord call this through PostgREST at the
# default isolation level; do not call it inside a higher-isolation transaction.
sub(
    "  SELECT club_id INTO v_club_id FROM sessions WHERE id=p_session_id;",
    "  SELECT club_id INTO v_club_id FROM sessions WHERE id=p_session_id;\n"
    "  IF v_club_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('wrapped_awards:'||v_club_id::text, 0)); END IF;",
    "per-club advisory lock",
)

# ── 2. Build the prior-grant ledger (needs _wrapped_stats; must precede the loop) ──
LEDGER = """  -- ── One-time milestone ledger ──────────────────────────────
  -- Six of the awards below are MILESTONES, not per-night achievements: they
  -- describe the player's ALL-TIME record rather than tonight, so the condition
  -- is still true the next time they turn up and, without this table, the award
  -- re-fires every session. That is how century_club ("Welcome to the 100 club")
  -- came to be handed to 5 players 18 times, and serial_rivals to 34 players 132
  -- times. Each of the six is now earned in the FIRST session where it holds and
  -- never again.
  --
  -- Two properties of this lookup are load-bearing:
  --   • It matches ANY OTHER session of the club -- not just earlier ones -- and
  --     it excludes p_session_id. Both halves matter, for opposite reasons.
  --     Excluding p_session_id is what makes the RPC RECOMPUTE-SAFE: re-running
  --     it on an already-computed session (fixPlayerRecord does exactly that,
  --     unconditionally, on any closed session) cannot see that session's own
  --     grant, so it re-grants the award instead of revoking it.
  --     Matching in BOTH directions is what makes it IDEMPOTENT. Every gated
  --     condition is evaluated against PRESENT-DAY all-time data -- the loop
  --     reads v_alltime_leaderboard_mat, refreshed at the top of this function,
  --     with no session cutoff -- so "alltime_games>=100" is just as true of a
  --     session the player played BEFORE they crossed 100. A backward-only
  --     lookup would therefore re-grant the award on every earlier session that
  --     ever got recomputed, recreating the exact duplicate this table exists
  --     to prevent. Measured on production: a backward-only bound would
  --     re-duplicate 217 serial_rivals, 111 the_dynasty, 81 century_club, 63
  --     winning_formula, 20 the_veteran and 15 first_to_100 grants -- the last
  --     of which the OLD code was not even vulnerable to, so a backward-only
  --     rule would have been a fresh regression. Ordering is NOT part of this
  --     predicate -- "first earning" is decided by which wrap holds the grant,
  --     not by recomputing a chronology on every call.
  --   • It excludes hidden sessions, matching v_alltime_leaderboard_mat, which
  --     is the source of alltime_games. Same universe in, same universe out --
  --     and an E2E sandbox wrap can never burn a real player's one-time award.
  --
  -- Net effect, stated precisely: the award lives on AT MOST one wrap per
  -- (club, player), and no session can ever add a second. Recomputing the
  -- holding session re-evaluates the live condition -- which is why the award
  -- can still DISAPPEAR there, for the three non-monotone ones: the_veteran
  -- (top-3 is relative, others overtake you), the_dynasty (a 70% win rate
  -- against a rival can fall back under) and winning_formula (your top partner
  -- can change). That is unchanged from the old function and is not what this
  -- migration is about; the guarantee added here is strictly "never twice".
  --
  -- Also deliberate: the gate is per PLAYER, not per (player, rival/partner).
  -- soulmates / winning_formula / the_dynasty / serial_rivals therefore cannot
  -- be re-earned with a DIFFERENT partner or rival. That was the product call
  -- (all six were chosen to be one-time); it is not an oversight.
  CREATE TEMP TABLE _prior_awards ON COMMIT DROP AS
  SELECT DISTINCT sws.player_id,a.slug FROM session_wrapped_stats sws JOIN sessions s2 ON s2.id=sws.session_id CROSS JOIN LATERAL unnest(sws.earned_awards) AS a(slug) WHERE s2.club_id=v_club_id AND s2.is_hidden=false AND sws.session_id<>p_session_id AND sws.player_id IN(SELECT player_id FROM _wrapped_stats) AND a.slug IN('century_club','first_to_100','the_veteran','serial_rivals','the_dynasty','soulmates','winning_formula');
"""
sub(
    "  CREATE TEMP TABLE _cross_session_stats ON COMMIT DROP AS\n",
    LEDGER + "  CREATE TEMP TABLE _cross_session_stats ON COMMIT DROP AS\n",
    "insert _prior_awards ledger",
)

# ── 3. Make first_to_100 survive a recompute ──
# The claim keeps its "crossed 100 tonight" guard -- only a genuine crossing may
# ever create the club's ledger row. What moves is the AWARD: it now follows the
# ledger (are you the holder?) instead of the crossing arithmetic. alltime_games
# is read live, so on a recompute of the crossing session that arithmetic is no
# longer true and the holder silently lost the badge -- reachable in normal use,
# because fixPlayerRecord re-runs this RPC on closed sessions unconditionally.
# Side benefit: when the reconstruction seeds a holder who is NOT the player
# being processed (the self-healing path added by 20260718150312), that holder
# now collects the award the next time they play, instead of only if they
# happened to re-cross 100 -- which they never can.
sub(
    "IF v_player.alltime_games>=100 AND (v_player.alltime_games-v_player.games_played)<100 THEN "
    "SELECT player_id INTO v_milestone_holder FROM club_milestones WHERE club_id=v_club_id "
    "AND milestone='first_to_100_games'; IF v_milestone_holder IS NULL THEN",
    "IF v_player.alltime_games>=100 THEN "
    "SELECT player_id INTO v_milestone_holder FROM club_milestones WHERE club_id=v_club_id "
    "AND milestone='first_to_100_games'; "
    "IF v_milestone_holder IS NULL AND (v_player.alltime_games-v_player.games_played)<100 THEN",
    "first_to_100 award follows the ledger (claim keeps the crossing guard)",
)

# ── 4..10. Gate the seven milestone awards on the ledger ──
for slug in (
    "the_veteran",
    "century_club",
    "first_to_100",
    "the_dynasty",
    "serial_rivals",
    "soulmates",
    "winning_formula",
):
    tail = f"THEN v_awards:=array_append(v_awards,'{slug}'::text);"
    guard = (
        f"AND NOT EXISTS(SELECT 1 FROM _prior_awards pa WHERE pa.player_id=v_player.player_id "
        f"AND pa.slug='{slug}') {tail}"
    )
    sub(tail, guard, f"gate {slug}")

HEADER = """-- ============================================================
-- Session Wrapped: make the six all-time milestone awards one-time
-- ============================================================
-- Reported symptom: the "100 games" award kept showing up on more than one
-- player, session after session, despite the 2026-07-18 first_to_100 repair.
--
-- That repair was sound and still holds -- first_to_100 has exactly one holder
-- per club, enforced by the club_milestones ledger. The award people were
-- actually seeing is its neighbour, century_club, which had no gate at all:
--
--   IF v_player.alltime_games>=100 THEN ... 'century_club' ...
--
-- alltime_games only ever grew in practice, so that condition stayed true once
-- crossed (it is not *guaranteed* monotone -- see the note below). Every
-- session a 100-game player showed up, they collected "Welcome
-- to the 100 club" again. Production had handed it out 18 times to 5 people
-- (Stelle alone held it 7 times, 07/04 through 08/06).
--
-- Five more have the same shape -- a condition about the player's ALL-TIME
-- record rather than about tonight, so it is still true the next time they turn
-- up, and it re-fired every night they (or the pairing) did:
--
--   the_veteran      is_alltime_top3 AND alltime_games>=20        55 grants /  5 players
--   serial_rivals    cs_max_sessions_faced>=3                    132 grants / 34 players
--   the_dynasty      cs_dynasty_victim_id IS NOT NULL             36 grants / 13 players
--   winning_formula  all-time partner games>=6 AND win rate>=60   10 grants /  6 players
--   soulmates        all-time partner games>=20 AND sessions>=2    0 grants (never met)
--
-- NONE of the six is strictly monotone -- do not assume any of them can only
-- ever become MORE true. century_club is the sturdiest: alone among the six it
-- reads neither player_rivalries nor player_partnerships, so an identity merge
-- cannot zero it. But alltime_games comes from v_alltime_leaderboard_mat, which
-- filters is_hidden = false, so hiding a session -- or a fix_record_swap_player
-- that removes a player from a completed match -- subtracts from it. (No live
-- exposure today: holders sit at 133/118/111/105/104 games.) Three CAN lapse by
-- design -- the_veteran's top-3 is relative, the_dynasty's 70% can fall back
-- under, winning_formula's top partner can change. The remaining two
-- (serial_rivals, soulmates) are monotone only GIVEN INTACT SOURCE DATA: they
-- read player_rivalries / player_partnerships, which store running totals that
-- an identity merge can zero, making a granted award un-evaluate. Not
-- hypothetical -- one player holds serial_rivals today with zero surviving
-- player_rivalries rows, orphaned by a 2026-06-10 merge that predated the
-- migrate_player_identity fix in 20260701000015. (That fix IS live: the
-- function re-points both tables today. It just landed too late for her.)
--
-- All of which matters in one direction only: this migration guarantees the
-- award is never granted TWICE, not that the wrap holding it keeps it through a
-- recompute. That was already true of the old function -- but the old function
-- re-granted every night, so a lapse healed itself. It no longer does.
--
-- All six are now gated on a _prior_awards ledger built from the player's OTHER
-- wraps in the same club: earned once, in the session where the condition first
-- holds, and never again. See the comment on the temp table for why the lookup
-- matches in both directions rather than only backwards -- getting that wrong
-- silently re-creates the duplicates on the next record-fix recompute.
--
-- That ledger is a snapshot of committed rows, so the function now also takes a
-- per-club transaction advisory lock before building it. Without one, two
-- computes for two sessions of the same club can run concurrently, both read
-- "no prior grant", and both grant. refresh_alltime_leaderboard() does NOT
-- serialize them -- it uses pg_try_advisory_xact_lock and returns early.
--
-- first_to_100 itself was correct and stays correct -- one holder per club, via
-- the club_milestones ledger -- but it was FRAGILE, and that is fixed here too.
-- Its award was gated on the same "crossed 100 tonight" arithmetic that guards
-- the claim, and alltime_games is read live, so recomputing the crossing
-- session evaluated that arithmetic against today's total and dropped the
-- award. Not theoretical: fixPlayerRecord re-runs this RPC on closed sessions
-- unconditionally, so a single organizer record-fix on the 07/04 session would
-- have quietly deleted the club's only First to 100. The award now follows the
-- ledger (are you the holder, and have you not already been given it?); only
-- the CLAIM still requires a genuine crossing, so no new holder can be minted
-- by a recompute.
--
-- Deliberately NOT changed: every other award. Session-scoped achievements
-- (undefeated_champion, session_mvp, unstoppable, court_hermit...) are supposed
-- to recur when they are re-earned, and the cross-session awards that require
-- something to happen tonight (nemesis_slayer, settled_the_score, momentum,
-- bounced_back, consistent_dominator, redemption_arc) were already correct.
--
-- This migration REPLACES the function in full rather than text-substituting
-- into it, per the instruction in 20260810000000: production and the repo stay
-- diffable. The body below is that file's verbatim production capture with the
-- edits above applied mechanically, each validated to match exactly once.
-- The historical duplicates already sitting in session_wrapped_stats are
-- stripped by the companion repair, 20260811000001.
--
-- The EXECUTE grants are reproduced unchanged -- postgres and service_role
-- only. anon and authenticated have no EXECUTE and must not gain any here.
-- ============================================================

"""

# --verify-sql / --apply-sql are advertised as read-only checks, so they must not
# rewrite the migration as a side effect. They used to: this write ran
# unconditionally, so every flag invocation silently regenerated OUT. Harmless in
# practice (generation is deterministic) but surprising, and it is half of the
# 2026-08-11 clobber -- that run wrote the correct file here and then destroyed it
# below. In flag mode the body stays in memory; nothing on disk is touched.
FLAG_MODE = "--verify-sql" in sys.argv or "--apply-sql" in sys.argv

if not FLAG_MODE:
    OUT.write_text(HEADER + body)
    print(f"wrote {OUT}")
print(f"substitutions applied: {len(subs)}")
for i, label in enumerate(subs, 1):
    print(f"  {i:>2}. {label}")
print("body bytes:", len(body.encode()))

# ── Optional: emit the production verification script ──
# `python3 scripts/gen-...py --verify-sql <path>` writes a read-only DO block that
# rebuilds this exact function body ON THE SERVER, from production's own prosrc,
# by replaying the substitutions above -- then proves (a) production has not
# drifted from the 20260810000000 baseline, (b) every anchor still matches
# exactly once there, (c) the reconstruction is md5-identical to this file, and
# (d) the result compiles, by CREATEing it into pg_temp. It finishes with
# RAISE EXCEPTION so the whole thing rolls back: nothing is ever mutated, and no
# 49 KB body has to be shipped to the server to test it.
#
# Generated rather than hand-written so the check can never drift from the
# migration it is checking.
#
# !! <path> IS AN OUTPUT DESTINATION, NOT AN INPUT. !!
# Both --verify-sql and --apply-sql WRITE their generated SQL to <path>. They do
# NOT read it. Passing the migration's own path -- which reads naturally as
# "verify THIS file" -- would overwrite the 55 KB migration with a ~12 KB DO
# block. Done accidentally on 2026-08-11; recovered only because a bare re-run
# of this generator rebuilds the migration deterministically from SRC.
# flag_dest() below now refuses that outright, so this is a documented rationale
# rather than a live hazard. Write to a scratch path:
#     python3 scripts/gen-...py --apply-sql /tmp/apply.sql
if FLAG_MODE:  # same expression as the OUT-write guard above; keep it one name
    import hashlib

    prosrc = body[body.index("AS $function$") + len("AS $function$") : body.rindex("$function$")]
    want = hashlib.md5(prosrc.encode()).hexdigest()

    for _, s, r in pairs:
        for tag in ("$s$", "$r$", "$body$", "$verify$", "$apply$", "$acl$"):
            if tag in s or tag in r:
                sys.exit(f"ABORT: substitution text contains the dollar-quote tag {tag}")

    steps = []
    for i, (label, s, r) in enumerate(pairs, 1):
        steps.append(
            f"  -- {i}. {label}\n"
            f"  v_needle := $s${s}$s$;\n"
            f"  v_n := (length(v_src) - length(replace(v_src, v_needle, ''))) / length(v_needle);\n"
            f"  IF v_n <> 1 THEN RAISE EXCEPTION 'ANCHOR {i} ({label}) matched % times in production, expected 1', v_n; END IF;\n"
            f"  v_src := replace(v_src, v_needle, $r${r}$r$);\n"
        )

    # The CREATE clause must reproduce production's attributes exactly: VOLATILE
    # and PARALLEL UNSAFE are the defaults and so stay implicit, matching the
    # 20260810000000 capture. CREATE OR REPLACE preserves owner and ACL.
    SIGNATURE = (
        "CREATE OR REPLACE FUNCTION public.compute_session_wrapped(p_session_id uuid) "
        "RETURNS void LANGUAGE plpgsql SECURITY DEFINER "
        "SET search_path TO ''public'', ''pg_temp'' AS "
    )
    EXPECTED_ACL = "postgres=X*/postgres,service_role=X/postgres"

    def flag_dest(flag):
        """Resolve <path> for a flag, refusing to write over the migration itself.

        <path> is an OUTPUT destination. `--apply-sql <the migration>` reads as
        "apply this file" and instead overwrites the 55 KB migration with a 12 KB
        DO block -- done for real on 2026-08-11. Documenting a trap the code can
        cheaply refuse is the weaker fix, so refuse it.

        Identity is checked two ways because neither alone is enough: resolve()
        canonicalizes symlinks and relative forms but cannot see a HARDLINK to
        the migration (measured: it clobbers the file), while (st_dev, st_ino)
        catches the hardlink but only exists once the file does.
        """
        try:
            raw = sys.argv[sys.argv.index(flag) + 1]
        except IndexError:
            sys.exit(f"ABORT: {flag} needs an output path, e.g. {flag} /tmp/out.sql")
        # A following flag is a forgotten path, not a destination -- otherwise
        # `--verify-sql --apply-sql /tmp/x` drops a file named "--apply-sql" in cwd.
        if raw.startswith("--"):
            sys.exit(
                f"ABORT: {flag} needs an output path but got the flag {raw!r}. "
                f"Example: {flag} /tmp/out.sql"
            )
        p = pathlib.Path(raw)

        def _same(a, b):
            if a.resolve() == b.resolve():
                return True
            if a.exists() and b.exists():
                sa, sb = a.stat(), b.stat()
                return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)  # hardlink
            return False

        if _same(p, OUT):
            sys.exit(
                f"ABORT: {flag} <path> is an OUTPUT destination, not an input, and you "
                f"pointed it at the migration itself ({OUT.name}). That would overwrite "
                f"the migration with the generated DO block. Use a scratch path."
            )
        if _same(p, SRC):
            sys.exit(f"ABORT: {flag} <path> would overwrite the SRC baseline ({SRC.name}).")
        # write_text on a missing parent raises a bare FileNotFoundError traceback;
        # abort the same way every other precondition here does.
        if not p.parent.exists():
            sys.exit(f"ABORT: {flag} <path> directory does not exist: {p.parent}")
        return p

if "--verify-sql" in sys.argv:
    dest = flag_dest("--verify-sql")
    dest.write_text(
        "-- GENERATED by scripts/gen-one-time-milestone-awards-migration.py --verify-sql\n"
        "-- Read-only: always ends in RAISE EXCEPTION, so the transaction rolls back.\n"
        "DO $verify$\n"
        "DECLARE\n"
        "  v_src text; v_needle text; v_n int;\n"
        f"  v_want text := '{want}';\n"
        "BEGIN\n"
        "  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n"
        "   WHERE n.nspname = 'public' AND p.proname = 'compute_session_wrapped';\n"
        "  IF v_src IS NULL THEN RAISE EXCEPTION 'compute_session_wrapped not found in production'; END IF;\n"
        "  RAISE NOTICE 'production prosrc: % bytes, md5 %', length(v_src), md5(v_src);\n\n"
        + "\n".join(steps)
        + "\n  IF md5(v_src) <> v_want THEN\n"
        "    RAISE EXCEPTION 'RECONSTRUCTION MISMATCH: server rebuilt md5 % (% bytes), repo file is %', md5(v_src), length(v_src), v_want;\n"
        "  END IF;\n\n"
        "  EXECUTE 'CREATE FUNCTION pg_temp.compute_session_wrapped_verify(p_session_id uuid) RETURNS void"
        " LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS $body$'"
        " || v_src || '$body$';\n\n"
        f"  RAISE EXCEPTION 'VERIFY OK -- no drift, {len(pairs)}/{len(pairs)} anchors matched once,"
        " md5 = %, body compiles. Rolling back.', v_want;\n"
        "END\n"
        "$verify$;\n"
    )
    print(f"wrote {dest}")
    print("md5(prosrc) =", want)

# ── Optional: emit the production APPLY script ──
# `python3 scripts/gen-...py --apply-sql <path>` writes the mutating twin of
# --verify-sql. It reuses the SAME anchor checks and the SAME md5 gate, then --
# only if the server-side reconstruction is byte-identical to this file -- issues
# the real CREATE OR REPLACE. Any drift, any anchor that no longer matches
# exactly once, raises before the DDL runs, so a failed check applies nothing.
#
# Why apply this way instead of shipping the 49 KB body: the body would have to
# be reproduced character-perfect by hand, and a single silent slip inside plpgsql
# still compiles. Reconstructing from production's own prosrc and gating on md5
# makes byte-correctness a proven precondition rather than a hope. The
# human-readable equivalent stays in the repo as the reviewed artifact.
#
# Idempotent: if the body is already at the target md5 it reports and returns.
if "--apply-sql" in sys.argv:
    dest = flag_dest("--apply-sql")
    dest.write_text(
        "-- GENERATED by scripts/gen-one-time-milestone-awards-migration.py --apply-sql\n"
        "-- Applies 20260811000000_one_time_milestone_awards.sql by reconstructing its\n"
        "-- function body server-side from production's own prosrc and gating the DDL on\n"
        f"-- md5 = {want}. The readable equivalent is that repo file; this script is\n"
        "-- byte-equivalent to it by construction, and proves so before it writes.\n"
        "DO $apply$\n"
        "DECLARE\n"
        "  v_src text; v_needle text; v_after text; v_n int;\n"
        f"  v_want text := '{want}';\n"
        "BEGIN\n"
        "  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n"
        "   WHERE n.nspname = 'public' AND p.proname = 'compute_session_wrapped';\n"
        "  IF v_src IS NULL THEN RAISE EXCEPTION 'compute_session_wrapped not found in production'; END IF;\n\n"
        "  IF md5(v_src) = v_want THEN\n"
        "    RAISE NOTICE 'ALREADY APPLIED: body is already md5 %. Nothing to do.', v_want;\n"
        "    RETURN;\n"
        "  END IF;\n\n"
        "  -- The reconstruction wraps the body in $body$; if production's own text ever\n"
        "  -- contained that tag the generated DDL would terminate early and mangle it.\n"
        "  IF position('$body$' in v_src) > 0 THEN\n"
        "    RAISE EXCEPTION 'production body contains the dollar-quote tag this script uses';\n"
        "  END IF;\n\n"
        "  RAISE NOTICE 'pre-apply prosrc: % bytes, md5 %', length(v_src), md5(v_src);\n\n"
        + "\n".join(steps)
        + "\n  IF md5(v_src) <> v_want THEN\n"
        "    RAISE EXCEPTION 'RECONSTRUCTION MISMATCH: rebuilt md5 % (% bytes), expected % -- NOTHING APPLIED', md5(v_src), length(v_src), v_want;\n"
        "  END IF;\n\n"
        f"  EXECUTE '{SIGNATURE}$body$' || v_src || '$body$';\n\n"
        "  SELECT p.prosrc INTO v_after FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n"
        "   WHERE n.nspname = 'public' AND p.proname = 'compute_session_wrapped';\n"
        "  IF md5(v_after) <> v_want THEN\n"
        "    RAISE EXCEPTION 'POST-APPLY MISMATCH: stored body is md5 %, expected %', md5(v_after), v_want;\n"
        "  END IF;\n\n"
        f"  RAISE NOTICE 'APPLIED: {len(pairs)}/{len(pairs)} anchors matched once, body now % bytes, md5 %',"
        " length(v_after), v_want;\n"
        "END\n"
        "$apply$;\n\n"
        "-- Reproduced unchanged; CREATE OR REPLACE already preserves the ACL, so these\n"
        "-- are a no-op assertion of intent rather than a widening.\n"
        "grant execute on function public.compute_session_wrapped(uuid) to postgres with grant option;\n"
        "grant execute on function public.compute_session_wrapped(uuid) to service_role;\n\n"
        "-- Fail loudly if anon/authenticated ever appear here.\n"
        "DO $acl$\n"
        "DECLARE v_acl text;\n"
        "BEGIN\n"
        "  SELECT coalesce(array_to_string(p.proacl, ','), '(none)') INTO v_acl\n"
        "    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n"
        "   WHERE n.nspname = 'public' AND p.proname = 'compute_session_wrapped';\n"
        f"  IF v_acl <> '{EXPECTED_ACL}' THEN\n"
        "    RAISE EXCEPTION 'ACL DRIFT after apply: % (expected %)', v_acl, "
        f"'{EXPECTED_ACL}';\n"
        "  END IF;\n"
        "  RAISE NOTICE 'ACL verified unchanged: %', v_acl;\n"
        "END\n"
        "$acl$;\n"
    )
    print(f"wrote {dest}")
    print("md5(prosrc) =", want)
