// ============================================================
// History server actions — ownership gate + read shaping
// ============================================================
// Covers src/app/actions/history.ts (getMatchHistory, getAllSessionsHistory).
//
// WHY THIS FILE EXISTS
// --------------------
// Both actions read `v_match_history` through the SERVICE-ROLE client, because
// 20260702000003_harden_security_definer_views.sql stripped the view's
// anon/authenticated grant. Service role bypasses RLS entirely, so there is no
// database backstop under these two functions at all. And the RLS that WOULD
// apply to the underlying tables does not help either: club-scoped RLS on
// matches/match_players (20260701000008_club_scoped_rls.sql) restricts by club
// MEMBERSHIP, not by player identity — every CHILLAX member can see every other
// CHILLAX member's rows.
//
// The single line standing between a fellow club member and another player's
// full cross-club match history is therefore:
//
//     if (playerId !== user.id) return { success: false, error: "Not authorized." };
//
// A suite that only proved "the happy path returns rows" would stay green with
// that line deleted. So the gate tests below assert two things every time: the
// exact refusal object, AND that `createServiceClient` was never even
// constructed — i.e. the gate ran BEFORE any lookup, which is the guard-ORDER
// half that a "rejects a stranger" test normally cannot see.
//
// The rest pins the read shaping that the UI depends on: the query bindings
// (column→value PAIRING, not merely "an eq() happened"), the optional
// sessionId/limit branches, the empty/null short-circuits, the newest-first
// de-duplicated session-id collection, and the club-name resolution including
// the null club_id case.
//
// TESTS
// -----
// getMatchHistory
//   HI-1            all-time read is bound to player_id, newest-first, uncapped
//   HI-2  (negative) an anonymous caller is refused before the service client exists
//   HI-3  (negative) a fellow club member passing another id is refused, view untouched
//   HI-4  (negative) the gate is exact string equality — case/whitespace variants refused
//   HI-5            a provided sessionId narrows the query, player_id still bound
//   HI-6  (negative) an empty-string sessionId is all-time, not a zero-row filter
//   HI-7            a provided limit is applied exactly once
//   HI-8  (negative) limit 0 is falsy and must NOT become limit(0)
//   HI-9  (negative) a view error returns generic copy and leaks no database text
//   HI-10           a null payload with no error yields matches: [] not undefined
//
// getAllSessionsHistory
//   HI-19 (negative) the all-sessions view read is bound to player_id, only
//   HI-20           full shape — matches, session metas with club names, wrapped ids
//   HI-21           session ids are de-duplicated and stay newest-first
//   HI-22 (negative) the Wrapped lookup is bound to BOTH player_id and the id list
//   HI-23           a null Wrapped payload yields [] without losing matches/sessions
//   HI-24           zero matches short-circuits — no sessions/wrapped/clubs query
//   HI-25           a null matches payload short-circuits too, instead of crashing
//   HI-26 (negative) a view error stops everything downstream
//   HI-27           a null sessions payload yields [] and skips the clubs lookup
//   HI-28 (negative) all-null club_ids issues no clubs query at all
//   HI-29           club ids are de-duplicated and null-filtered before the lookup
//   HI-30           an unresolvable club_id yields club_name null, never undefined
//   HI-31 (negative) sessions read on the RLS-scoped user client; clubs/wrapped/view
//                    on the service client
//   HI-32 (negative) an anonymous caller is refused before the service client exists
//   HI-33 (negative) a mismatched playerId is refused before ANY query runs
//   HI-34           a null clubs payload yields club_name null, instead of crashing
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { getMatchHistory, getAllSessionsHistory } from "@/app/actions/history";
import type { MatchHistory } from "@/types/database";

// ── ids ───────────────────────────────────────────────────────
// CALLER.id is deliberately lower-case hex: HI-4 upper-cases it to prove the
// gate does not normalise.
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };
const OTHER_ID = "00000000-0000-4000-8000-00000000face";

// Suffixes chosen so LEXICOGRAPHIC order (S_MID, S_OLD, S_NEW) differs from
// newest-first ARRIVAL order (S_NEW, S_MID, S_OLD) — otherwise HI-21 could not
// tell "preserved arrival order" from "sorted".
const S_NEW = "00000000-0000-4000-8000-000000000003";
const S_MID = "00000000-0000-4000-8000-000000000001";
const S_OLD = "00000000-0000-4000-8000-000000000002";

const C1 = "00000000-0000-4000-8000-0000000000c1";
const C_MISSING = "00000000-0000-4000-8000-0000000000cf";

// ── recording query harness ───────────────────────────────────
// Copied in spirit from tests/unit/tenancy-session-binding.test.ts: a builder
// that records WHICH columns a read was constrained by. A self-returning stub
// cannot see a missing (or swapped) filter, and a missing filter is the entire
// class of defect this file is guarding.

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };
/** One response for every table, or a per-table map. */
type RespSource = Resp | Record<string, Resp>;

/**
 * A bare `{data, error}` answers for every table. A map answers per table and
 * defaults anything it does not name to "no rows, no error" — the denying
 * default, so a test that forgets to stub a step fails closed rather than
 * inheriting the previous fixture's rows.
 */
function respFor(src: RespSource, table: string): Resp {
  const isMap = !("data" in src) && !("error" in src);
  return isMap ? ((src as Record<string, Resp>)[table] ?? { data: null, error: null }) : src;
}

function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  b["select"] = (cols?: string) => {
    ops.push(`select:${cols ?? "*"}`);
    return b;
  };
  b["eq"] = (col: string, val: unknown) => {
    ops.push(`eq:${col}=${String(val)}`);
    return b;
  };
  b["in"] = (col: string, vals: unknown[]) => {
    ops.push(`in:${col}=${vals.map(String).join(",")}`);
    return b;
  };
  b["order"] = (col: string, opts?: { ascending?: boolean }) => {
    ops.push(`order:${col}=${opts?.ascending === false ? "desc" : "asc"}`);
    return b;
  };
  b["limit"] = (n: number) => {
    ops.push(`limit:${n}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

function recordingClient(src: RespSource) {
  const recorded: Recorded[] = [];
  const from = vi.fn((table: string) => {
    const entry: Recorded = { table, ops: [] };
    recorded.push(entry);
    return builder(respFor(src, table), entry.ops);
  });
  return { from, recorded };
}

type Client = ReturnType<typeof recordingClient>;

/**
 * Arm both Supabase factories. `svcSrc` shapes the service-role reads
 * (v_match_history, session_wrapped_stats, clubs); `userSrc` shapes the
 * RLS-scoped user-client reads (sessions).
 *
 * Both are armed even for tests that assert the service client is never
 * constructed — the point of those tests is that an available client goes
 * unused, not that it was unavailable.
 */
function arm(user: { id: string } | null, svcSrc: RespSource = {}, userSrc: RespSource = {}) {
  const svc = recordingClient(svcSrc);
  const userClient = {
    ...recordingClient(userSrc),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
  };
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    userClient as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  vi.mocked(createServiceClient).mockReturnValue(
    svc as unknown as ReturnType<typeof createServiceClient>
  );
  return { svc, userClient };
}

/** The ops recorded for `table`; fails loudly if that read never happened. */
function opsFor(client: Client, table: string): string[] {
  const entry = client.recorded.find((r) => r.table === table);
  expect(entry, `no read of "${table}" was recorded on this client`).toBeDefined();
  return entry!.ops;
}

const tablesOf = (client: Client) => client.recorded.map((r) => r.table);

// ── fixtures ──────────────────────────────────────────────────

function matchRow(sessionId: string, matchId: string, completedAt: string): MatchHistory {
  return {
    player_id: CALLER.id,
    session_id: sessionId,
    match_id: matchId,
    court_id: null,
    court_name: "Court 1",
    team: "a",
    team_a_score: 21,
    team_b_score: 15,
    match_status: "completed",
    completed_at: completedAt,
    created_method: "auto",
    modification_count: 0,
    final_classification: "auto_clean",
    game_scores: null,
    teammates: null,
    opponents: null,
    club_id: C1,
  };
}

type SessionRow = {
  id: string;
  name: string | null;
  created_at: string;
  ended_at: string | null;
  club_id: string | null;
};

function sessionRow(id: string, clubId: string | null, name: string | null = null): SessionRow {
  return {
    id,
    name,
    created_at: "2026-08-01T10:00:00Z",
    ended_at: "2026-08-01T14:00:00Z",
    club_id: clubId,
  };
}

/** Four matches, newest-first, across three sessions (S_NEW appears twice). */
const FOUR_MATCHES: MatchHistory[] = [
  matchRow(S_NEW, "m1", "2026-08-20T12:00:00Z"),
  matchRow(S_NEW, "m2", "2026-08-20T11:00:00Z"),
  matchRow(S_MID, "m3", "2026-08-15T12:00:00Z"),
  matchRow(S_OLD, "m4", "2026-08-01T12:00:00Z"),
];

const THREE_SESSIONS: SessionRow[] = [
  sessionRow(S_NEW, C1, "Thursday"),
  sessionRow(S_MID, C1),
  sessionRow(S_OLD, null, "Legacy"),
];

/** The default happy fixture for getAllSessionsHistory. */
function happyFixture() {
  return arm(
    CALLER,
    {
      v_match_history: { data: FOUR_MATCHES, error: null },
      session_wrapped_stats: { data: [{ session_id: S_MID }], error: null },
      clubs: { data: [{ id: C1, name: "CHILLAX" }], error: null },
    },
    { sessions: { data: THREE_SESSIONS, error: null } }
  );
}

beforeEach(() => vi.clearAllMocks());

// ══ getMatchHistory ═══════════════════════════════════════════

describe("HI: getMatchHistory", () => {
  const TWO_ROWS: MatchHistory[] = [
    matchRow(S_NEW, "m1", "2026-08-20T12:00:00Z"),
    matchRow(S_MID, "m2", "2026-08-15T12:00:00Z"),
  ];
  const twoRowSrc = { v_match_history: { data: TWO_ROWS, error: null } };

  it("HI-1: returns the caller's own history, bound to player_id, newest-first, uncapped", async () => {
    const { svc } = arm(CALLER, twoRowSrc);

    const r = await getMatchHistory(CALLER.id);

    expect(r, "the view rows must reach the caller untouched").toEqual({
      success: true,
      matches: TWO_ROWS,
    });
    expect(
      tablesOf(svc),
      "an extra service-role read was issued for a plain history fetch"
    ).toEqual(["v_match_history"]);

    const ops = opsFor(svc, "v_match_history");
    expect(ops, "the read was not bound to the id the ownership gate authorized").toContain(
      `eq:player_id=${CALLER.id}`
    );
    expect(ops, "history must come back newest-first; the UI groups on that order").toContain(
      "order:completed_at=desc"
    );
    expect(
      ops.some((o) => o.startsWith("eq:session_id")),
      "the all-time query silently scoped itself to a session"
    ).toBe(false);
    expect(
      ops.some((o) => o.startsWith("limit:")),
      "an unrequested row cap was applied to an all-time history read"
    ).toBe(false);
  });

  it("HI-2 (negative): an unauthenticated caller is refused before the service client exists", async () => {
    arm(null, twoRowSrc);

    const r = await getMatchHistory(OTHER_ID);

    // The EXACT string matters: it is what distinguishes this gate from the
    // ownership gate below. Collapsing the two into one `playerId !== user?.id`
    // check would still return success:false, and a bare success check would
    // not notice.
    expect(r).toEqual({ success: false, error: "Not authenticated." });
    expect(
      vi.mocked(createServiceClient),
      "the RLS-bypassing service client was constructed for an anonymous caller"
    ).not.toHaveBeenCalled();
  });

  it("HI-3 (negative): a fellow club member passing someone else's id is refused, view untouched", async () => {
    // The whole point of this file. Club-scoped RLS on matches/match_players
    // restricts by club membership only, and v_match_history has no
    // authenticated grant at all — so this gate is the ONLY thing between a
    // CHILLAX member and another member's full cross-club history.
    const { svc } = arm(CALLER, twoRowSrc);

    const r = await getMatchHistory(OTHER_ID);

    expect(r).toEqual({ success: false, error: "Not authorized." });
    expect(
      vi.mocked(createServiceClient),
      "the service client — which bypasses RLS entirely — was constructed for a caller who does not own this history"
    ).not.toHaveBeenCalled();
    expect(tablesOf(svc), "v_match_history was read for a non-owner").toEqual([]);
  });

  it("HI-4 (negative): the ownership gate is exact string equality — case/whitespace variants refused", async () => {
    // Fail CLOSED on any un-normalised input rather than reasoning about
    // Postgres's case-insensitive uuid casting. If the gate ever starts
    // trimming/lower-casing, the comparison stops matching the value that is
    // then handed to .eq(), and the two can drift apart.
    for (const variant of [CALLER.id.toUpperCase(), ` ${CALLER.id} `]) {
      vi.clearAllMocks();
      const { svc } = arm(CALLER, twoRowSrc);

      const r = await getMatchHistory(variant);

      expect(r, `a non-identical playerId ("${variant}") passed the ownership gate`).toEqual({
        success: false,
        error: "Not authorized.",
      });
      expect(
        vi.mocked(createServiceClient),
        `the service client was constructed for the un-normalized id "${variant}"`
      ).not.toHaveBeenCalled();
      expect(tablesOf(svc)).toEqual([]);
    }
  });

  it("HI-5: a provided sessionId narrows the query, with player_id still bound", async () => {
    const { svc } = arm(CALLER, twoRowSrc);

    const r = await getMatchHistory(CALLER.id, S_NEW);

    expect(r.success).toBe(true);
    const ops = opsFor(svc, "v_match_history");
    // Asserting the column→value PAIRING, not merely "two eq() calls happened":
    // swapping the two bindings also produces exactly two eq() calls, so a
    // count-based assertion is blind to it.
    expect(ops, "the session filter was not bound to the sessionId argument").toContain(
      `eq:session_id=${S_NEW}`
    );
    expect(ops, "the player binding was lost once a session filter was added").toContain(
      `eq:player_id=${CALLER.id}`
    );
  });

  it("HI-6 (negative): an empty-string sessionId means all-time, not a zero-row filter", async () => {
    const { svc } = arm(CALLER, twoRowSrc);

    const r = await getMatchHistory(CALLER.id, "");

    expect(r).toEqual({ success: true, matches: TWO_ROWS });
    expect(
      opsFor(svc, "v_match_history").some((o) => o.startsWith("eq:session_id")),
      "an empty sessionId was pushed into the query as a filter, which matches zero rows and silently shows the player an empty history"
    ).toBe(false);
  });

  it("HI-7: a provided limit is applied to the query, exactly once", async () => {
    const { svc } = arm(CALLER, twoRowSrc);

    const r = await getMatchHistory(CALLER.id, undefined, 5);

    expect(r.success).toBe(true);
    const caps = opsFor(svc, "v_match_history").filter((o) => o.startsWith("limit:"));
    expect(caps, "the requested row cap was dropped, or applied more than once").toEqual([
      "limit:5",
    ]);
  });

  it("HI-8 (negative): limit === 0 is falsy and applies no cap", async () => {
    // match-history.tsx documents the prop as "Cap the number of results
    // returned. Default: unlimited." A forwarded limit(0) returns zero rows
    // from PostgREST, which would render an empty history instead.
    const { svc } = arm(CALLER, twoRowSrc);

    const r = await getMatchHistory(CALLER.id, undefined, 0);

    expect(r, "limit 0 truncated the result set").toEqual({ success: true, matches: TWO_ROWS });
    expect(
      opsFor(svc, "v_match_history").some((o) => o.startsWith("limit:")),
      "limit 0 was forwarded to PostgREST, which returns zero rows; a falsy limit means unlimited"
    ).toBe(false);
  });

  it("HI-9 (negative): a view error returns generic copy and does not leak the database text", async () => {
    arm(CALLER, {
      v_match_history: {
        data: null,
        error: { message: "permission denied for view v_match_history" },
      },
    });

    const r = await getMatchHistory(CALLER.id);

    // Exact object equality asserts three things at once: success is false, the
    // copy is the generic one, and no `matches` key rides along on the failure.
    expect(r, "the raw database error text reached the client").toEqual({
      success: false,
      error: "Failed to load match history.",
    });
  });

  it("HI-10: a null data payload with no error yields matches: [] rather than undefined", async () => {
    arm(CALLER, { v_match_history: { data: null, error: null } });

    const r = await getMatchHistory(CALLER.id);

    expect(
      r,
      "a null payload reached the caller as undefined; match-history.tsx does setHistory(result.matches) and would then crash on .map"
    ).toEqual({ success: true, matches: [] });
  });
});

// ══ getAllSessionsHistory ═════════════════════════════════════

describe("HI: getAllSessionsHistory", () => {
  it("HI-19 (negative): the all-sessions view read is bound to player_id, and to nothing else", async () => {
    // Added after a mutation run: deleting this .eq() from the read turned NO
    // test red, while HI-20's fixture kept passing because the mock returns the
    // same rows either way. Unbound, this service-role select is the very
    // cross-club unfiltered dump that 20260702000003 revoked the view's grant
    // to prevent — every player's history, every club, to any logged-in caller.
    const { svc } = happyFixture();

    const r = await getAllSessionsHistory(CALLER.id);
    expect(r.success).toBe(true);

    // Exactly one equality filter, on exactly the id the ownership gate
    // authorized: this also fails if the binding is swapped onto another column
    // or a second, wider filter is added beside it.
    expect(
      opsFor(svc, "v_match_history").filter((o) => o.startsWith("eq:")),
      "the all-sessions read was not bound to the caller's own id — it returns every player's history in every club"
    ).toEqual([`eq:player_id=${CALLER.id}`]);
  });

  it("HI-20: full shape — matches, session metas with resolved club names, wrapped ids", async () => {
    const { svc, userClient } = happyFixture();

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r.success).toBe(true);
    if (!r.success) return; // narrows the union; unreachable given the assert above
    expect(r.matches, "the view rows must reach the caller untouched").toEqual(FOUR_MATCHES);
    expect(r.sessions, "session metadata was reshaped or a declared key was dropped").toEqual([
      {
        id: S_NEW,
        name: "Thursday",
        created_at: "2026-08-01T10:00:00Z",
        ended_at: "2026-08-01T14:00:00Z",
        club_id: C1,
        club_name: "CHILLAX",
      },
      {
        id: S_MID,
        name: null,
        created_at: "2026-08-01T10:00:00Z",
        ended_at: "2026-08-01T14:00:00Z",
        club_id: C1,
        club_name: "CHILLAX",
      },
      {
        id: S_OLD,
        name: "Legacy",
        created_at: "2026-08-01T10:00:00Z",
        ended_at: "2026-08-01T14:00:00Z",
        club_id: null,
        club_name: null,
      },
    ]);
    expect(r.wrappedSessionIds, "the Wrapped chip lit up for the wrong sessions").toEqual([S_MID]);

    // club_id must stay in the sessions select list: both the clubs lookup and
    // SessionMeta.club_id read it, and per this repo's history a newly-selected
    // sessions column also needs its own column GRANT to be readable at all.
    expect(
      opsFor(userClient, "sessions"),
      "club_id was dropped from the sessions select; club names and SessionMeta.club_id both depend on it"
    ).toContain("select:id, name, created_at, ended_at, club_id");
    expect(
      opsFor(svc, "clubs"),
      "the clubs lookup was not bound to the sessions' club ids"
    ).toContain(`in:id=${C1}`);
  });

  it("HI-21: the session-id list is de-duplicated and preserves newest-first order", async () => {
    // Interleaved arrival: S_NEW, S_MID, S_NEW, S_OLD. Lexicographic order of
    // these ids is S_MID, S_OLD, S_NEW — so a sort() would be visible here.
    const interleaved: MatchHistory[] = [
      matchRow(S_NEW, "m1", "2026-08-20T12:00:00Z"),
      matchRow(S_MID, "m2", "2026-08-15T12:00:00Z"),
      matchRow(S_NEW, "m3", "2026-08-20T09:00:00Z"),
      matchRow(S_OLD, "m4", "2026-08-01T12:00:00Z"),
    ];
    const { svc, userClient } = arm(
      CALLER,
      {
        v_match_history: { data: interleaved, error: null },
        session_wrapped_stats: { data: [], error: null },
      },
      { sessions: { data: [], error: null } }
    );

    const r = await getAllSessionsHistory(CALLER.id);
    expect(r.success).toBe(true);

    // One exact string pins order AND the absence of duplicates.
    expect(
      opsFor(userClient, "sessions"),
      "the session id list was re-ordered or carried a duplicate"
    ).toContain(`in:id=${S_NEW},${S_MID},${S_OLD}`);
    expect(
      opsFor(svc, "session_wrapped_stats"),
      "the Wrapped lookup saw a different session list than the sessions read"
    ).toContain(`in:session_id=${S_NEW},${S_MID},${S_OLD}`);
    // The whole "newest-first" claim rests on this ordering clause.
    expect(
      opsFor(svc, "v_match_history"),
      "matches were not ordered newest-first, so 'first seen' is not 'newest'"
    ).toContain("order:completed_at=desc");
  });

  it("HI-22 (negative): the Wrapped lookup is bound to BOTH player_id and the session-id list", async () => {
    const { svc } = happyFixture();

    const r = await getAllSessionsHistory(CALLER.id);
    expect(r.success).toBe(true);

    const ops = opsFor(svc, "session_wrapped_stats");
    expect(
      ops,
      "the recap lookup was not bound to the player; every OTHER attendee's recap rows come back and light up this player's View Wrapped chips"
    ).toContain(`eq:player_id=${CALLER.id}`);
    expect(ops, "the recap lookup was not restricted to this player's sessions").toContain(
      `in:session_id=${S_NEW},${S_MID},${S_OLD}`
    );
  });

  it("HI-23: a null Wrapped payload yields wrappedSessionIds: [] without losing matches or sessions", async () => {
    const { svc } = arm(
      CALLER,
      {
        v_match_history: { data: FOUR_MATCHES, error: null },
        session_wrapped_stats: { data: null, error: null },
        clubs: { data: [{ id: C1, name: "CHILLAX" }], error: null },
      },
      { sessions: { data: THREE_SESSIONS, error: null } }
    );

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r.success, "a failed recap lookup took the whole history down with it").toBe(true);
    if (!r.success) return;
    expect(r.wrappedSessionIds).toEqual([]);
    expect(r.matches, "matches were lost along with the recap lookup").toEqual(FOUR_MATCHES);
    expect(r.sessions, "session metadata was lost along with the recap lookup").toHaveLength(3);
    expect(tablesOf(svc)).toContain("clubs");
  });

  it("HI-24: zero matches short-circuits — no sessions, Wrapped or clubs query is issued", async () => {
    const { svc, userClient } = arm(CALLER, { v_match_history: { data: [], error: null } });

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r).toEqual({ success: true, matches: [], sessions: [], wrappedSessionIds: [] });
    expect(tablesOf(svc), "a Wrapped or clubs query ran with an empty session-id list").toEqual([
      "v_match_history",
    ]);
    expect(userClient.from, "a sessions query ran with an empty id list").not.toHaveBeenCalled();
  });

  it("HI-25: a null matches payload short-circuits too, instead of crashing", async () => {
    const { svc, userClient } = arm(CALLER, { v_match_history: { data: null, error: null } });

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r, "a null payload did not take the empty-history path").toEqual({
      success: true,
      matches: [],
      sessions: [],
      wrappedSessionIds: [],
    });
    expect(tablesOf(svc)).toEqual(["v_match_history"]);
    expect(userClient.from, "a sessions query ran off a null match list").not.toHaveBeenCalled();
  });

  it("HI-26 (negative): a v_match_history error stops everything downstream", async () => {
    const { svc, userClient } = arm(CALLER, {
      v_match_history: { data: null, error: { message: "boom" } },
    });

    const r = await getAllSessionsHistory(CALLER.id);

    // Exact object: also proves the raw message is not leaked, and that no
    // empty matches/sessions arrays ride along on a failure.
    expect(r, "a failed history read did not surface as a failure").toEqual({
      success: false,
      error: "Failed to load match history.",
    });
    expect(tablesOf(svc)).toEqual(["v_match_history"]);
    expect(
      userClient.from,
      "session metadata was fetched for a history read that failed"
    ).not.toHaveBeenCalled();
  });

  it("HI-27: a null sessions payload yields sessions: [] and skips the clubs lookup", async () => {
    const { svc } = arm(
      CALLER,
      {
        v_match_history: { data: FOUR_MATCHES, error: null },
        session_wrapped_stats: { data: [{ session_id: S_MID }], error: null },
      },
      { sessions: { data: null, error: null } }
    );

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r.success, "a null sessions payload crashed the action").toBe(true);
    if (!r.success) return;
    expect(r.matches).toEqual(FOUR_MATCHES);
    expect(r.sessions).toEqual([]);
    expect(r.wrappedSessionIds).toEqual([S_MID]);
    expect(
      tablesOf(svc),
      "a clubs lookup ran with no session rows to derive club ids from"
    ).toEqual(["v_match_history", "session_wrapped_stats"]);
  });

  it("HI-28 (negative): when every session has a null club_id the clubs lookup does not run", async () => {
    const { svc } = arm(
      CALLER,
      {
        v_match_history: {
          data: [
            matchRow(S_NEW, "m1", "2026-08-20T12:00:00Z"),
            matchRow(S_MID, "m2", "2026-08-15T12:00:00Z"),
          ],
          error: null,
        },
        session_wrapped_stats: { data: [], error: null },
      },
      { sessions: { data: [sessionRow(S_NEW, null), sessionRow(S_MID, null)], error: null } }
    );

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(tablesOf(svc), "a clubs query was issued with a list of nulls").toEqual([
      "v_match_history",
      "session_wrapped_stats",
    ]);
    for (const meta of r.sessions) {
      expect(meta.club_name, "a club-less session was labelled with a club").toBeNull();
      expect(meta.club_id).toBeNull();
    }
  });

  it("HI-29: club ids are de-duplicated and null-filtered before the clubs lookup", async () => {
    const { svc } = happyFixture();

    const r = await getAllSessionsHistory(CALLER.id);
    expect(r.success).toBe(true);
    if (!r.success) return;

    // Exact string: a duplicate renders `in:id=<C1>,<C1>` and a leaked null
    // renders a trailing comma. Both fail this.
    expect(
      opsFor(svc, "clubs"),
      "the clubs lookup carried duplicate ids or a null in its id list"
    ).toContain(`in:id=${C1}`);
    expect(r.sessions.map((s) => s.club_name)).toEqual(["CHILLAX", "CHILLAX", null]);
  });

  it("HI-30: an unresolvable club_id yields club_name null, never undefined or the raw id", async () => {
    const { svc } = arm(
      CALLER,
      {
        v_match_history: { data: [matchRow(S_NEW, "m1", "2026-08-20T12:00:00Z")], error: null },
        session_wrapped_stats: { data: [], error: null },
        clubs: { data: [], error: null },
      },
      { sessions: { data: [sessionRow(S_NEW, C_MISSING)], error: null } }
    );

    const r = await getAllSessionsHistory(CALLER.id);
    expect(r.success).toBe(true);
    if (!r.success) return;

    expect(tablesOf(svc)).toContain("clubs");
    const meta = r.sessions[0];
    expect(meta.club_id, "the club id itself was dropped when it could not be resolved").toBe(
      C_MISSING
    );
    // toBeNull, not toBeFalsy: undefined is the actual regression here.
    expect(
      meta.club_name,
      "an unresolved club rendered as undefined or as the raw uuid instead of null"
    ).toBeNull();
    expect(
      "club_name" in meta,
      "club_name was dropped from the payload crossing the server-action boundary"
    ).toBe(true);
  });

  it("HI-31 (negative): sessions read on the user client; view, Wrapped and clubs on the service client", async () => {
    const { svc, userClient } = happyFixture();

    const r = await getAllSessionsHistory(CALLER.id);
    expect(r.success).toBe(true);

    expect(userClient.from).toHaveBeenCalledWith("sessions");
    expect(
      tablesOf(svc),
      "the sessions read was moved to the service role, which bypasses RLS; the clubs lookup's safety rests on session ownership being established by an RLS-scoped read"
    ).not.toContain("sessions");

    // Conversely: clubs has no RLS policies and v_match_history has no
    // authenticated grant, so an authenticated-client read of either returns
    // nothing in production while every mock in this file stays green.
    for (const t of ["v_match_history", "session_wrapped_stats", "clubs"]) {
      expect(tablesOf(svc), `${t} must be read through the service client`).toContain(t);
      expect(
        tablesOf(userClient),
        `${t} was read on the authenticated client, which holds no grant for it`
      ).not.toContain(t);
    }
  });

  it("HI-32 (negative): an unauthenticated caller is refused before the service client exists", async () => {
    const { userClient } = happyFixture();
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      ...userClient,
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
    } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r).toEqual({ success: false, error: "Not authenticated." });
    expect(
      vi.mocked(createServiceClient),
      "the RLS-bypassing service client was constructed for an anonymous caller"
    ).not.toHaveBeenCalled();
    expect(userClient.from, "a lookup ran for an anonymous caller").not.toHaveBeenCalled();
  });

  it("HI-33 (negative): a mismatched playerId is refused, and no query of any kind runs first", async () => {
    const { svc, userClient } = happyFixture();

    const r = await getAllSessionsHistory(OTHER_ID);

    expect(r).toEqual({ success: false, error: "Not authorized." });
    expect(
      vi.mocked(createServiceClient),
      "the RLS-bypassing service client was constructed for a caller who does not own this history"
    ).not.toHaveBeenCalled();
    expect(tablesOf(svc)).toEqual([]);
    // The guard-ORDER half: this fails if any read is hoisted above the gate.
    expect(userClient.from, "a lookup ran before the ownership gate").not.toHaveBeenCalled();
  });

  it("HI-34: a null clubs payload yields club_name null, instead of crashing", async () => {
    const { svc } = arm(
      CALLER,
      {
        v_match_history: { data: [matchRow(S_NEW, "m1", "2026-08-20T12:00:00Z")], error: null },
        session_wrapped_stats: { data: [], error: null },
        clubs: { data: null, error: null },
      },
      { sessions: { data: [sessionRow(S_NEW, C1, "Thursday")], error: null } }
    );

    const r = await getAllSessionsHistory(CALLER.id);

    expect(r.success, "a null clubs payload crashed the action").toBe(true);
    if (!r.success) return;
    expect(tablesOf(svc)).toContain("clubs");
    expect(
      r.sessions[0].club_name,
      "a failed club lookup rendered as undefined instead of null"
    ).toBeNull();
    expect(r.sessions[0].club_id, "the session's club id was dropped").toBe(C1);
  });
});
