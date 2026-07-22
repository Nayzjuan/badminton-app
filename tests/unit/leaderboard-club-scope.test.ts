// ============================================================
// Leaderboard club scoping — the TypeScript half of PR2
// ============================================================
// TENANCY_AUDIT_2026-07-21.md #6: `v_alltime_leaderboard_mat` is a MATERIALIZED
// view, so it can never carry RLS — its GRANT was the whole access control, and
// `anon` held SELECT. 20260722010001 revokes the browser roles and the reads
// move to the service client, which means Postgres is no longer scoping them.
// The scoping now lives in `src/app/actions/leaderboard.ts`, in plain
// TypeScript, and this file is what holds it to that.
//
// Everything here would pass just as happily against the pre-fix code if it
// only asserted "rows come back" — so each test asserts on the DENIAL and, for
// the allowed path, on the exact club filter handed to the query.
//
//   LB-AUTH   the four fail-closed gates on both entry points
//   LB-SCOPE  the club filter that replaces RLS
//   LB-MERGE  cross-club row folding (the matview is keyed player+club)
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({ getClubBySlug: vi.fn(), getMyActiveClubIds: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { getClubBySlug, getMyActiveClubIds } from "@/lib/clubs";
import { getAllTimeLeaderboard, getPlayerStats } from "@/app/actions/leaderboard";
import type {
  AllTimeLeaderboardEntry,
  GetAllTimeLeaderboardResult,
  GetPlayerStatsResult,
  LeaderboardRow,
} from "@/types/leaderboard";

const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };
const PLAYER = "00000000-0000-4000-8000-000000000a99";
const CLUB_A = "00000000-0000-4000-8000-0000000000a1";
const CLUB_B = "00000000-0000-4000-8000-0000000000b2";
const CLUB_FOREIGN = "00000000-0000-4000-8000-0000000000f3";

// MIN_ALLTIME_GP is module-private; mirrored here so a change to it fails these
// tests loudly rather than silently altering what they prove.
const MIN_ALLTIME_GP = 10;

/**
 * One matview row, internally consistent (point_diff and win_pct are derived,
 * never passed in) so that an assertion on the merged output is testing
 * mergeAllTimeEntries' arithmetic rather than echoing a fixture.
 */
function entry(
  playerId: string,
  gamesPlayed: number,
  overrides: { wins?: number; points_for?: number; points_against?: number } = {}
): AllTimeLeaderboardEntry {
  const wins = overrides.wins ?? Math.floor(gamesPlayed / 2);
  const pointsFor = overrides.points_for ?? gamesPlayed * 21;
  const pointsAgainst = overrides.points_against ?? gamesPlayed * 15;
  return {
    player_id: playerId,
    display_name: `Player ${playerId.slice(-4)}`,
    games_played: gamesPlayed,
    wins,
    losses: gamesPlayed - wins,
    points_for: pointsFor,
    points_against: pointsAgainst,
    point_diff: pointsFor - pointsAgainst,
    win_pct: gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 1000) / 10 : 0,
  };
}

/** Records every filter the action applies, so a test can assert on scope. */
type Recorded = { table: string; ops: string[] };

/**
 * Service client over the matview. `rows` is what the matview returns; the two
 * snapshot/streak RPCs answer empty (the Δ column and flames are not under
 * test here). Every .in()/.eq() is recorded.
 */
function serviceClient(rows: AllTimeLeaderboardEntry[], recorded: Recorded[]) {
  const from = vi.fn((table: string) => {
    const log: Recorded = { table, ops: [] };
    recorded.push(log);
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["select", "order", "limit", "gte", "lte"]) b[m] = self;
    b["eq"] = (col: string, val: unknown) => {
      log.ops.push(`eq:${col}=${val}`);
      return b;
    };
    b["in"] = (col: string, vals: unknown[]) => {
      log.ops.push(`in:${col}=[${vals.join(",")}]`);
      return b;
    };
    b["then"] = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(res, rej);
    return b;
  });
  return {
    from,
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
}

/** Caller's own client — only auth.getUser() and buildVipMap's profiles read. */
function authedAs(user: { id: string } | null) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
    from: vi.fn(() => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      for (const m of ["select", "in", "eq"]) b[m] = self;
      b["then"] = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(res);
      return b;
    }),
  };
}

function mockClients(user: { id: string } | null, rows: AllTimeLeaderboardEntry[] = []) {
  const recorded: Recorded[] = [];
  const svc = serviceClient(rows, recorded);
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    authedAs(user) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  vi.mocked(createServiceClient).mockReturnValue(
    svc as unknown as ReturnType<typeof createServiceClient>
  );
  return { svc, recorded };
}

/** The club filter the matview query actually ran with. */
function clubFilter(recorded: Recorded[]): string | undefined {
  return recorded
    .find((r) => r.table === "v_alltime_leaderboard_mat")
    ?.ops.find((op) => op.startsWith("in:club_id="));
}

// Both results are discriminated unions. Narrowing through a throwing helper
// keeps the failure message useful — an unexpected error branch reports the
// message rather than "cannot read property of undefined" ten lines later.
function rowsOf(r: GetAllTimeLeaderboardResult): LeaderboardRow[] {
  if (!r.success) throw new Error(`expected a board, got error: ${r.error}`);
  return r.rows;
}

function heroOf(r: GetPlayerStatsResult): LeaderboardRow | null {
  if (!r.success) throw new Error(`expected a hero card, got error: ${r.error}`);
  return r.row;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but NOT implementations, so a stub set in
  // one test would otherwise leak into the next and could hand it a green it did
  // not earn. Re-arm both club lookups to their DENYING values: any test that
  // forgets to stub them reads as "no clubs / unknown slug" and fails loudly,
  // rather than inheriting the previous test's membership.
  vi.mocked(getMyActiveClubIds).mockResolvedValue([]);
  vi.mocked(getClubBySlug).mockResolvedValue(null);
});

// ── LB-AUTH: the gates that replaced the GRANT ────────────────
describe("LB-AUTH: all-time reads fail closed", () => {
  it("LB-AUTH-1: a logged-out caller gets an empty board, not every club's data", async () => {
    // The audit's exact request, one layer up: before the fix this reached the
    // matview with no user at all. Empty and success — the page renders its
    // zero-state rather than an error the user cannot act on.
    const { svc } = mockClients(null, [entry(PLAYER, 40)]);

    const r = await getAllTimeLeaderboard();

    expect(r).toEqual({ success: true, rows: [] });
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("LB-AUTH-2: a caller in no active club reads nothing", async () => {
    const { svc } = mockClients(CALLER, [entry(PLAYER, 40)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([]);

    const r = await getAllTimeLeaderboard();

    expect(r).toEqual({ success: true, rows: [] });
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("LB-AUTH-3: an unknown clubSlug denies instead of falling back to all clubs", async () => {
    // The regression this locks: an unresolvable slug used to fall through to
    // the unscoped board, so a TYPO returned strictly more data than a correct
    // slug — the one input a curious user is most likely to produce by accident.
    const { svc } = mockClients(CALLER, [entry(PLAYER, 40)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A]);
    vi.mocked(getClubBySlug).mockResolvedValue(null);

    const r = await getAllTimeLeaderboard("typo-club");

    expect(r).toEqual({ success: true, rows: [] });
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("LB-AUTH-4: a real club the caller does not belong to is refused", async () => {
    const { svc } = mockClients(CALLER, [entry(PLAYER, 40)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A]);
    vi.mocked(getClubBySlug).mockResolvedValue({
      id: CLUB_FOREIGN,
      slug: "rival-club",
    } as unknown as Awaited<ReturnType<typeof getClubBySlug>>);

    const r = await getAllTimeLeaderboard("rival-club");

    expect(r).toEqual({ success: true, rows: [] });
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("LB-AUTH-5: getPlayerStats(all-time) applies the identical four gates", async () => {
    // The hero card is a second door onto the same matview. It returned the
    // player's row unscoped before the fix, so gating only the board would have
    // left a per-player oracle open.
    for (const setup of [
      () => mockClients(null),
      () => {
        const c = mockClients(CALLER);
        vi.mocked(getMyActiveClubIds).mockResolvedValue([]);
        return c;
      },
      () => {
        const c = mockClients(CALLER);
        vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A]);
        vi.mocked(getClubBySlug).mockResolvedValue(null);
        return c;
      },
      () => {
        const c = mockClients(CALLER);
        vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A]);
        vi.mocked(getClubBySlug).mockResolvedValue({
          id: CLUB_FOREIGN,
          slug: "rival-club",
        } as unknown as Awaited<ReturnType<typeof getClubBySlug>>);
        return c;
      },
    ]) {
      vi.clearAllMocks();
      const { svc } = setup();

      const r = await getPlayerStats(PLAYER, null, "rival-club");

      expect(r).toEqual({ success: true, row: null });
      expect(svc.from).not.toHaveBeenCalled();
    }
  });
});

// ── LB-SCOPE: the filter that replaced RLS ────────────────────
describe("LB-SCOPE: the club filter is what the query actually runs with", () => {
  it("LB-SCOPE-1: no slug scopes to every club the caller belongs to — never all clubs", async () => {
    const { recorded } = mockClients(CALLER, [entry(PLAYER, 40)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    await getAllTimeLeaderboard();

    // The assertion that matters: a club filter EXISTS. Dropping `.in(...)`
    // reopens the dump while every row-shape assertion keeps passing.
    expect(clubFilter(recorded)).toBe(`in:club_id=[${CLUB_A},${CLUB_B}]`);
  });

  it("LB-SCOPE-2: a slug the caller belongs to narrows to exactly that one club", async () => {
    const { recorded } = mockClients(CALLER, [entry(PLAYER, 40)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);
    vi.mocked(getClubBySlug).mockResolvedValue({ id: CLUB_B, slug: "club-b" } as unknown as Awaited<
      ReturnType<typeof getClubBySlug>
    >);

    await getAllTimeLeaderboard("club-b");

    expect(clubFilter(recorded)).toBe(`in:club_id=[${CLUB_B}]`);
  });

  it("LB-SCOPE-3: the per-club RPCs are never called with a null club", async () => {
    // get_alltime_snapshot_before and get_player_streaks aggregate over
    // whatever they are handed, and p_club_id = null means EVERY club in the
    // database. One call per scoped club is the only correct spelling: a null
    // would fold foreign-club matches into the snapshot the Δ column is
    // diffed against and into each player's lifetime streak.
    const { svc } = mockClients(CALLER, [entry(PLAYER, 40)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    await getAllTimeLeaderboard();

    const clubArgs = svc.rpc.mock.calls.map((c) => (c[1] as { p_club_id?: string })?.p_club_id);
    expect(clubArgs.length).toBe(4); // 2 RPCs × 2 clubs
    expect(clubArgs).not.toContain(null);
    expect(clubArgs).not.toContain(undefined);
    expect([...new Set(clubArgs)].sort()).toEqual([CLUB_A, CLUB_B].sort());
    // Pin WHICH two RPCs, not just how many calls: a count of 4 also matches
    // fanning the same RPC out twice, which would silently drop the streaks.
    expect([...new Set(svc.rpc.mock.calls.map((c) => c[0] as string))].sort()).toEqual([
      "get_alltime_snapshot_before",
      "get_player_streaks",
    ]);
  });
});

// ── LB-MERGE: cross-club folding ──────────────────────────────
describe("LB-MERGE: the matview is keyed (player_id, club_id)", () => {
  it("LB-MERGE-1: a player in two scoped clubs appears once, with summed totals", async () => {
    // Before the service-client switch the read was implicitly one club, so
    // duplicate player rows could not occur. They can now.
    const rows = [
      entry(PLAYER, 20, { wins: 15, points_for: 400, points_against: 300 }),
      entry(PLAYER, 10, { wins: 5, points_for: 200, points_against: 250 }),
    ];
    mockClients(CALLER, rows);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    const r = await getAllTimeLeaderboard();

    const board = rowsOf(r);
    expect(board).toHaveLength(1);
    const row = board[0];
    expect(row.games_played).toBe(30);
    expect(row.wins).toBe(20);
    expect(row.losses).toBe(10);
    expect(row.points_for).toBe(600);
    expect(row.points_against).toBe(550);
    // Recomputed from the merged totals, not averaged from the two win_pcts —
    // averaging 75% and 50% gives 62.5, which is wrong for 20/30.
    expect(row.point_diff).toBe(50);
    expect(row.win_pct).toBeCloseTo(66.7, 1);
  });

  it("LB-MERGE-2: MIN_ALLTIME_GP is applied AFTER merging, not per club row", async () => {
    // A player just under the threshold in each of two clubs qualifies on the
    // total. Filtering in SQL per row dropped them from the board while the
    // snapshot — which filters post-merge — still ranked them, so the Δ column
    // shifted under every player below them and painted a spurious ▲1.
    const half = Math.ceil(MIN_ALLTIME_GP / 2); // 5 + 5 = 10, qualifies
    mockClients(CALLER, [entry(PLAYER, half), entry(PLAYER, half)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    const r = await getAllTimeLeaderboard();

    const board = rowsOf(r);
    expect(board).toHaveLength(1);
    expect(board[0].games_played).toBe(MIN_ALLTIME_GP);
  });

  it("LB-MERGE-3: a player below the threshold even after merging is excluded", async () => {
    // The other side of LB-MERGE-2 — post-merge filtering must still filter.
    mockClients(CALLER, [entry(PLAYER, 2), entry(PLAYER, 3)]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    const r = await getAllTimeLeaderboard();

    expect(rowsOf(r)).toEqual([]);
  });

  it("LB-MERGE-4: getPlayerStats folds the same rows into one hero card", async () => {
    // The hero card deliberately has NO threshold — it shows a player their own
    // totals whether or not they qualify — but the NUMBERS must match the board.
    const { recorded } = mockClients(CALLER, [
      entry(PLAYER, 20, { wins: 15, points_for: 400, points_against: 300 }),
      entry(PLAYER, 10, { wins: 5, points_for: 200, points_against: 250 }),
    ]);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    const r = await getPlayerStats(PLAYER, null);

    // The hero card's OWN club filter, asserted here rather than left to
    // LB-SCOPE (which only exercises getAllTimeLeaderboard). Without this,
    // deleting `.in("club_id", scopeClubIds)` from the getPlayerStats query
    // leaves the whole suite green — and that is precisely the per-player
    // cross-club oracle LB-AUTH-5 exists to close.
    expect(clubFilter(recorded)).toBe(`in:club_id=[${CLUB_A},${CLUB_B}]`);

    const hero = heroOf(r);
    expect(hero?.games_played).toBe(30);
    expect(hero?.wins).toBe(20);
    expect(hero?.win_pct).toBeCloseTo(66.7, 1);
  });

  it("LB-MERGE-5: merging does not mutate the rows the caller handed in", async () => {
    // mergeAllTimeEntries accumulates into its map. If it stored the first
    // entry by reference instead of copying it, the accumulation would write
    // through to the query result — harmless today, a heisenbug the moment
    // anything else reads that array.
    const rows = [entry(PLAYER, 20, { wins: 15 }), entry(PLAYER, 10, { wins: 5 })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    mockClients(CALLER, rows);
    vi.mocked(getMyActiveClubIds).mockResolvedValue([CLUB_A, CLUB_B]);

    await getAllTimeLeaderboard();

    expect(rows).toEqual(snapshot);
  });
});
