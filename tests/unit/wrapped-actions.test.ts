// ============================================================
// Suite WR — wrapped.ts
// ============================================================
// WHY THIS FILE EXISTS
//
// src/app/actions/wrapped.ts had no test of any kind, and it owns a one-way
// door. dismissWrappedIntro stamps intro_dismissed_at, and once stamped both
// the play-page redirect and the wrapped page server component skip the intro
// FOREVER, on every device. There is no un-dismiss. A bug that stamps the
// wrong row, or stamps on a path that should have been a no-op, is not a
// display glitch — it permanently removes a player's recap.
//
// The two properties that carry that weight:
//
//   1. The update is bound to session_id AND player_id AND
//      intro_dismissed_at IS NULL. Lose the player_id binding and one
//      player's "Done" click dismisses the recap for everyone in the
//      session. Lose the IS NULL filter and a re-dismissal overwrites the
//      original timestamp, which is the only record of when they saw it.
//
//   2. `dismissed` reports whether a row was actually stamped. This is the
//      field that makes the no-row case VISIBLE — success: true with
//      dismissed: false means the stamp had nowhere to land and the intro
//      will replay on every future visit. A test that only checked `success`
//      would pass against a version that always returns
//      { success: true, dismissed: true }, which is precisely the silent
//      failure the field was added to surface.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CLAIM
//
// dismissWrappedIntro performs NO authorization. It runs on the user client,
// so RLS on session_wrapped_stats is the entire access control story, and
// none of it is visible from here. WR-1 asserts the client is the USER
// client, not the service client, because swapping in createServiceClient()
// would bypass RLS and make this action stamp any row it is handed — a
// change that would otherwise pass every test in this file unnoticed.
// Whether the RLS policy itself is correct is a database question and
// belongs in an integration suite, not here.
//
// IDs: WR-1 … WR-10
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { dismissWrappedIntro, getWrappedData } from "@/app/actions/wrapped";

const SESSION_ID = "00000000-0000-4000-8000-000000000051";
const PLAYER_ID = "00000000-0000-4000-8000-0000000005a1";
const OTHER_ID = "00000000-0000-4000-8000-0000000005b2";
const CLUB_ID = "00000000-0000-4000-8000-0000000000c1";

// `count` is `number | null` on the wire: PostgREST returns null when the
// request errored or when no count was requested. WR-4 and WR-6 both depend
// on that, so narrowing this to `number` here would make the two tests that
// cover the `?? 0` fallback impossible to write.
type Resp = { data?: unknown; error?: unknown; count?: number | null };
type Recorded = { table: string; ops: string[] };

/**
 * Records every chained call as `method:arg`. The filters ARE the behaviour
 * under test here, so a builder that returned itself without recording would
 * make WR-2's binding assertions unwritable — `.eq("player_id", …)` could be
 * deleted outright and nothing would notice.
 */
function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  b["select"] = self;
  b["update"] = (payload: Record<string, unknown>) => {
    // Record only the KEYS: the value is new Date().toISOString(), which is
    // different on every run and cannot be asserted against.
    ops.push(`update:${Object.keys(payload).sort().join(",")}`);
    return b;
  };
  for (const m of ["eq", "is"])
    b[m] = (col: string, val: unknown) => {
      ops.push(`${m}:${col}=${JSON.stringify(val)}`);
      return b;
    };
  b["order"] = (col: string, opts?: { ascending?: boolean }) => {
    ops.push(`order:${col}=${opts?.ascending ? "asc" : "desc"}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

function recordingClient(responses: Resp[]) {
  let i = 0;
  const recorded: Recorded[] = [];
  return {
    recorded,
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(responses[i++] ?? { data: null, error: null }, entry.ops);
    }),
  };
}

function installUserClient(responses: Resp[]) {
  const c = recordingClient(responses);
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    c as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  return c;
}

function installServiceClient(responses: Resp[]) {
  const c = recordingClient(responses);
  vi.mocked(createServiceClient).mockReturnValue(
    c as unknown as ReturnType<typeof createServiceClient>
  );
  return c;
}

/** A fully-populated stats row, so each test can vary one field at a time. */
function statsRow(overrides: Record<string, unknown> = {}) {
  return {
    games_played: 8,
    wins: 5,
    losses: 3,
    points_for: 168,
    points_against: 140,
    point_diff: 28,
    win_pct: "62.5",
    session_rank: 3,
    earned_awards: ["the_dynasty"],
    award_data: { the_dynasty: { streak: 4 } },
    intro_dismissed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createServiceClient).mockReset();
  vi.mocked(createServerSupabaseClient).mockReset();
});

// ── dismissWrappedIntro ───────────────────────────────────────
describe("Suite WR — dismissWrappedIntro", () => {
  it("WR-1: a stamped row reports dismissed: true, through the USER client", async () => {
    const c = installUserClient([{ error: null, count: 1 }]);

    const res = await dismissWrappedIntro(SESSION_ID, PLAYER_ID);

    expect(res).toEqual({ success: true, dismissed: true });
    expect(c.recorded.map((r) => r.table)).toEqual(["session_wrapped_stats"]);
    expect(
      vi.mocked(createServiceClient),
      "dismissWrappedIntro built a SERVICE client — that bypasses RLS, which is " +
        "the only access control this action has, and would let it stamp any row"
    ).not.toHaveBeenCalled();
  });

  it("WR-2: the update is bound to session_id, player_id, and IS NULL together", async () => {
    const c = installUserClient([{ error: null, count: 1 }]);

    await dismissWrappedIntro(SESSION_ID, PLAYER_ID);

    expect(
      c.recorded[0].ops,
      "the three filters that scope the stamp to exactly one un-dismissed row " +
        "are not all present — dropping player_id dismisses the recap for the " +
        "whole session, dropping the IS NULL overwrites the original timestamp"
    ).toEqual([
      "update:intro_dismissed_at",
      `eq:session_id=${JSON.stringify(SESSION_ID)}`,
      `eq:player_id=${JSON.stringify(PLAYER_ID)}`,
      "is:intro_dismissed_at=null",
    ]);
  });

  it("WR-3 (edge): no matching row is a successful no-op that reports dismissed: false", async () => {
    // The silent failure the `dismissed` field exists to surface: no
    // session_wrapped_stats row for this pair, so the stamp lands nowhere and
    // the intro replays forever. The UI still navigates away, so `success`
    // must stay true — `dismissed` is the only signal.
    const c = installUserClient([{ error: null, count: 0 }]);

    const res = await dismissWrappedIntro(SESSION_ID, PLAYER_ID);

    expect(res.success, "a no-op dismissal must not be reported as an error").toBe(true);
    expect(
      res.dismissed,
      "count 0 reported as dismissed — the caller can no longer distinguish " +
        "'stamped' from 'had nowhere to land'"
    ).toBe(false);
    expect(c.recorded).toHaveLength(1);
  });

  it("WR-4 (edge): a null count is treated as zero, not as a successful stamp", async () => {
    // PostgREST omits the count unless the header asked for it. If the
    // { count: "exact" } option is ever dropped from the update, `count`
    // arrives undefined — and `(count ?? 0) > 0` must read that as "nothing
    // changed" rather than throwing or reporting a stamp that never happened.
    installUserClient([{ error: null, count: undefined }]);

    const res = await dismissWrappedIntro(SESSION_ID, PLAYER_ID);

    expect(res).toEqual({ success: true, dismissed: false });
  });

  it("WR-5 (negative): a malformed id is refused before any client is built", async () => {
    for (const [sid, pid] of [
      ["not-a-uuid", PLAYER_ID],
      [SESSION_ID, "not-a-uuid"],
      ["", ""],
    ]) {
      const res = await dismissWrappedIntro(sid, pid);
      expect(res.success, `dismissWrappedIntro accepted (${sid}, ${pid})`).toBe(false);
      expect(res.error).toBe("Invalid session or player ID.");
    }

    expect(
      vi.mocked(createServerSupabaseClient),
      "a client was built for a malformed id — the UUID guard no longer runs first"
    ).not.toHaveBeenCalled();
  });

  it("WR-6 (negative): a database error is surfaced, not swallowed into a fake success", async () => {
    installUserClient([{ error: { message: "permission denied for table" }, count: null }]);

    const res = await dismissWrappedIntro(SESSION_ID, PLAYER_ID);

    expect(
      res.success,
      "an RLS rejection was reported to the player as a successful dismissal"
    ).toBe(false);
    expect(res.error).toBe("permission denied for table");
    expect(res.dismissed).toBeUndefined();
  });
});

// ── getWrappedData ────────────────────────────────────────────
describe("Suite WR — getWrappedData", () => {
  it("WR-7: a populated stats row maps onto WrappedStats and reports the club for the cross-check", async () => {
    const history = [{ match_id: "m1" }, { match_id: "m2" }];
    const svc = installServiceClient([
      { data: { club_id: CLUB_ID } }, // sessions
      { data: statsRow({ intro_dismissed_at: "2026-08-21T10:00:00.000Z" }) },
      { data: { display_name: "Miggy", skill_level: "advanced" } },
      { data: history },
    ]);

    const res = await getWrappedData(SESSION_ID, PLAYER_ID);

    expect(res.sessionClubId, "the club-namespaced page's session↔club 404 guard reads this").toBe(
      CLUB_ID
    );
    expect(res.profile).toEqual({ display_name: "Miggy" });
    expect(res.stats).toEqual({
      playerName: "Miggy",
      games: 8,
      wins: 5,
      losses: 3,
      pointsFor: 168,
      pointsAgainst: 140,
      pointDiff: 28,
      winPct: 62.5,
      sessionRank: 3,
      earnedAwards: ["the_dynasty"],
      awardData: { the_dynasty: { streak: 4 } },
    });
    expect(res.matchHistory).toEqual(history);
    expect(res.introDismissed, "a stamped row did not report introDismissed").toBe(true);

    // The reads, in the order the Promise.all issues them. Locking the order
    // is what makes the response fixtures above mean what they say.
    expect(svc.recorded.map((r) => r.table)).toEqual([
      "sessions",
      "session_wrapped_stats",
      "profiles",
      "v_match_history",
    ]);
    // Both per-player reads must carry BOTH filters, or one player's recap
    // shows another player's matches.
    expect(svc.recorded[1].ops).toEqual([
      `eq:session_id=${JSON.stringify(SESSION_ID)}`,
      `eq:player_id=${JSON.stringify(PLAYER_ID)}`,
    ]);
    expect(svc.recorded[3].ops).toEqual([
      `eq:session_id=${JSON.stringify(SESSION_ID)}`,
      `eq:player_id=${JSON.stringify(PLAYER_ID)}`,
      "order:completed_at=desc",
    ]);
  });

  it("WR-8 (edge): a null point_diff is recomputed rather than rendered as zero", async () => {
    // point_diff is nullable. Rendering a null as 0 would silently show every
    // pre-backfill player an even record on their recap.
    installServiceClient([
      { data: { club_id: CLUB_ID } },
      { data: statsRow({ point_diff: null, points_for: 100, points_against: 77 }) },
      { data: { display_name: "Miggy", skill_level: "advanced" } },
      { data: [] },
    ]);

    const res = await getWrappedData(SESSION_ID, PLAYER_ID);

    expect(res.stats.pointDiff, "a null point_diff was not recomputed from the point totals").toBe(
      23
    );
  });

  it("WR-9 (edge): a player with no stats row still gets their name, an empty record, and the club id", async () => {
    // compute_session_wrapped never ran, or the player completed no matches.
    // The page must still render — with their real name, zeroes, and a
    // sessionClubId so the club-scoped route does not 404 them by mistake.
    installServiceClient([
      { data: { club_id: CLUB_ID } },
      { data: null }, // no stats row
      { data: { display_name: "Miggy", skill_level: "beginner" } },
      { data: [] },
    ]);

    const res = await getWrappedData(SESSION_ID, PLAYER_ID);

    expect(res.sessionClubId).toBe(CLUB_ID);
    expect(res.stats.playerName, "the fallback dropped the player's name").toBe("Miggy");
    expect(res.stats.games).toBe(0);
    expect(res.stats.earnedAwards).toEqual([]);
    expect(res.introDismissed, "no stats row cannot mean the intro was dismissed").toBe(false);
  });

  it("WR-10 (negative): an unknown player returns the empty shape, and a malformed id never reaches the DB", async () => {
    // An unresolvable profile is the one case that discards the stats row it
    // already read — returning stats for a player whose profile is missing
    // would render a nameless recap.
    installServiceClient([
      { data: { club_id: CLUB_ID } },
      { data: statsRow() },
      { data: null }, // no profile
      { data: [{ match_id: "m1" }] },
    ]);

    const unknown = await getWrappedData(SESSION_ID, OTHER_ID);
    expect(unknown.profile).toBeNull();
    expect(unknown.stats.games, "stats survived a missing profile").toBe(0);
    expect(unknown.matchHistory, "match history survived a missing profile").toEqual([]);
    expect(unknown.sessionClubId, "the club id is still needed for the route's cross-check").toBe(
      CLUB_ID
    );

    // ── The UUID guard, which must precede the client ───────────
    vi.mocked(createServiceClient).mockClear();
    const bad = await getWrappedData("not-a-uuid", PLAYER_ID);
    expect(bad.sessionClubId).toBeNull();
    expect(bad.profile).toBeNull();
    expect(bad.stats.games).toBe(0);
    expect(
      vi.mocked(createServiceClient),
      "a service client was built for a malformed id — the UUID guard no longer runs first"
    ).not.toHaveBeenCalled();
  });
});
