// @vitest-environment happy-dom
// ============================================================
// useSessionCompletedPlayers — the history-swap candidate list (CP)
// ============================================================
// This hook feeds step 2 of FixRecordSheet: the organiser is correcting a
// finished match and needs to pick the player who ACTUALLY played. Everything
// dangerous about it is a consequence of that one sentence:
//
//   - The candidate list is the exclusion. The picker's other section
//     ("SWITCH WITHIN THIS MATCH") is derived from data already in hand, so
//     this read exists purely to offer everyone who is NOT in the match being
//     corrected. `.neq("id", excludeMatchId)` is that rule. Bind the neq to
//     the wrong column or the wrong value and the organiser is offered the
//     very players they are trying to swap out — or, worse, the read stops
//     being scoped to this session at all and the picker lists strangers.
//   - The stats are the disambiguator. The row reads "Esmé · 3G · 2W 1L";
//     that string is how a human tells two same-named players apart before
//     committing a correction to a permanent record. Every one of those three
//     numbers is computed in memory here, from a 4-query pipeline, not read
//     from a view — so a win credited to the wrong team is silent.
//   - Three early exits, in order. Steps 2 and 3 are skipped entirely when
//     step 1 comes back empty. That is a deliberate cost decision, and it is
//     only observable by asserting that the later queries were NEVER ISSUED —
//     the returned value is an empty list either way.
//
//   CP-1   happy path — per-player games/wins/losses, sorted, loading settles
//   CP-2   the completed-match read is bound to THIS session, to status
//          completed, and EXCLUDES the match being corrected (column=value)
//   CP-3   (edge, guard order) zero completed matches → no downstream reads
//   CP-4   (edge, guard order) an errored/null matches read → same, and the
//          hook still leaves loading
//   CP-5   (edge, guard order) zero match_players rows → the profiles read is
//          never issued
//   CP-6   (edge) a null profiles read → empty list, loading still settles
//   CP-7   dedup — a player in three completed matches yields ONE row, 3 games
//   CP-8   a win is credited to the player's OWN team, both directions
//   CP-9   (edge) a tie counts as a loss for both sides
//   CP-10  (edge) null scores read as 0–0, so both sides take a loss
//   CP-11  (edge) a player with no profile row is dropped, and only that
//          player — the rest of the list survives (positive control)
//   CP-12  the list is ordered by display_name, not by insertion or id
//   CP-13  the match_players read is scoped by match_id to the completed ids
//   CP-14  the profiles read is scoped by id to the DISTINCT player ids
//   CP-15  loading is true on the first render and false once the read lands
//   CP-16  changing the excluded match re-runs the read against the NEW id
//
// WHAT THIS FILE DOES NOT PROVE
//   - That PostgREST honours the filters. The mock records the filters it is
//     handed and the tests assert the column-to-VALUE pairing; it does not
//     re-implement `.neq` or `!inner`, so "the excluded match's rows are
//     absent" is proven as a QUERY SHAPE, not as a filtered result set. The
//     server-side half is the integration lane's.
//   - Anything about applying a correction. The swap itself — authorisation,
//     the write, the recount — is src/app/actions/fix-player-record.ts,
//     covered by tests/unit/fix-player-record.test.ts and use-fix-record.
//   - That the `?? 0` on each score does any work. It cannot be shown to,
//     from outside: JS coerces null to 0 in a relational comparison, so
//     `null > 5` and `0 > 5` agree, as do `5 > null` and `5 > 0`. Deleting
//     the coalesce changes no output this hook can produce, and CP-10 pins
//     the behaviour it guards (an unscored match = one game, no winner)
//     rather than the operator itself.
//   - Error REPORTING. This hook destructures `data` only and never reads
//     `error`, so a failed read is indistinguishable from an empty session
//     both to the hook and to these tests; CP-4 and CP-6 pin the degradation
//     (empty list, loading released), not a message.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSessionCompletedPlayers } from "@/hooks/use-session-completed-players";

// ── Constants ─────────────────────────────────────────────────

const SESSION_ID = "sess-cp-321";
const TARGET_MATCH = "match-cp-target";
const OTHER_TARGET_MATCH = "match-cp-target-2";
const MATCH_1 = "match-cp-1";
const MATCH_2 = "match-cp-2";
const MATCH_3 = "match-cp-3";

// ── Fixtures ──────────────────────────────────────────────────

type MatchPlayerRow = {
  player_id: string;
  match_id: string;
  team: "a" | "b";
  matches: { team_a_score: number | null; team_b_score: number | null };
};

type ProfileRow = { id: string; display_name: string; skill_level: string };

function mp(
  playerId: string,
  matchId: string,
  team: "a" | "b",
  scoreA: number | null,
  scoreB: number | null
): MatchPlayerRow {
  return {
    player_id: playerId,
    match_id: matchId,
    team,
    matches: { team_a_score: scoreA, team_b_score: scoreB },
  };
}

function profile(id: string, displayName: string, skill = "intermediate"): ProfileRow {
  return { id, display_name: displayName, skill_level: skill };
}

// ── Mock Supabase client ──────────────────────────────────────
// Records table + ordered filters per query so the tests can assert WHICH
// column carried WHICH value: three eq/neq calls with two values swapped make
// exactly the same number of calls, and only the pairing tells them apart.

type TableResult = { data: unknown[] | null; error: { message: string } | null };
type QueryLog = { table: string; ops: string[] };

const EMPTY_OK: TableResult = { data: [], error: null };

let queryLog: QueryLog[] = [];
let responses: Record<string, TableResult> = {};

function logsFor(table: string): QueryLog[] {
  return queryLog.filter((l) => l.table === table);
}

function opsOf(table: string, callIndex = 0): string[] {
  return logsFor(table)[callIndex]?.ops ?? [];
}

function buildMockClient() {
  return {
    from: (table: string) => {
      const log: QueryLog = { table, ops: [] };
      queryLog.push(log);
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          log.ops.push(`select:${cols}`);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          log.ops.push(`eq:${col}=${String(val)}`);
          return chain;
        },
        neq: (col: string, val: unknown) => {
          log.ops.push(`neq:${col}=${String(val)}`);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          log.ops.push(`in:${col}=[${vals.map(String).join(",")}]`);
          return chain;
        },
        then: (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(responses[table] ?? EMPTY_OK).then(onFulfilled),
      };
      return chain;
    },
  };
}

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => buildMockClient(),
}));

// ── Seeds ─────────────────────────────────────────────────────

function setTable(table: string, result: TableResult): void {
  responses[table] = result;
}

/**
 * Two completed matches besides the one being corrected:
 *   MATCH_1  a(11) beats b(7)   — Alice(a) wins, Bob(b) loses
 *   MATCH_2  b(11) beats a(9)   — Alice(a) loses, Carol(b) wins
 */
function seedTwoMatches(): void {
  setTable("matches", { data: [{ id: MATCH_1 }, { id: MATCH_2 }], error: null });
  setTable("match_players", {
    data: [
      mp("p-alice", MATCH_1, "a", 11, 7),
      mp("p-bob", MATCH_1, "b", 11, 7),
      mp("p-alice", MATCH_2, "a", 9, 11),
      mp("p-carol", MATCH_2, "b", 9, 11),
    ],
    error: null,
  });
  setTable("profiles", {
    data: [
      profile("p-alice", "Alice"),
      profile("p-bob", "Bob"),
      profile("p-carol", "Carol", "advanced"),
    ],
    error: null,
  });
}

async function renderLoaded(excludeMatchId = TARGET_MATCH) {
  const rendered = renderHook(
    ({ exclude }: { exclude: string }) => useSessionCompletedPlayers(SESSION_ID, exclude),
    { initialProps: { exclude: excludeMatchId } }
  );
  await waitFor(() =>
    expect(rendered.result.current.loading, "the candidate read never settled").toBe(false)
  );
  return rendered;
}

// ── Tests ─────────────────────────────────────────────────────

describe("useSessionCompletedPlayers — the history-swap candidate list", () => {
  beforeEach(() => {
    queryLog = [];
    responses = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── CP-1 ───────────────────────────────────────────────────
  it("CP-1: happy path — per-player games/wins/losses, sorted, loading settles", async () => {
    seedTwoMatches();

    const { result } = await renderLoaded();

    expect(
      result.current.players,
      "the swap picker's candidate list came up empty for a session that has completed matches — the organiser cannot correct a record at all"
    ).toHaveLength(3);
    expect(
      result.current.players,
      "the per-player session record is wrong. That 'Esmé · 3G · 2W 1L' line is how the organiser tells two same-named players apart before writing a permanent correction"
    ).toEqual([
      {
        player_id: "p-alice",
        display_name: "Alice",
        skill_level: "intermediate",
        games_played: 2,
        wins: 1,
        losses: 1,
      },
      {
        player_id: "p-bob",
        display_name: "Bob",
        skill_level: "intermediate",
        games_played: 1,
        wins: 0,
        losses: 1,
      },
      {
        player_id: "p-carol",
        display_name: "Carol",
        skill_level: "advanced",
        games_played: 1,
        wins: 1,
        losses: 0,
      },
    ]);
  });

  // ── CP-2 ───────────────────────────────────────────────────
  it("CP-2: the completed-match read is bound to THIS session, status completed, and EXCLUDES the match being corrected", async () => {
    seedTwoMatches();
    await renderLoaded();

    const ops = opsOf("matches");
    expect(
      ops,
      "the candidate read is no longer scoped to this session — the picker would offer players from other sessions, and a correction bound to one of them writes a foreign player into this session's history"
    ).toContain(`eq:session_id=${SESSION_ID}`);
    expect(
      ops,
      "the candidate read stopped filtering on status=completed — in-progress and pending matches would seed the candidate list with players who have not finished a game"
    ).toContain("eq:status=completed");
    expect(
      ops,
      "the exclusion of the match being corrected is gone or bound to the wrong column/value. That neq IS the feature: without it the picker offers the very players the organiser is trying to swap out, in a list whose whole purpose is 'everyone else'"
    ).toContain(`neq:id=${TARGET_MATCH}`);
  });

  // ── CP-3 (edge, guard order) ───────────────────────────────
  it("CP-3 (edge, guard order): zero completed matches → empty list and NO downstream reads", async () => {
    setTable("matches", EMPTY_OK);
    // Wired to succeed: if either later query runs, it returns rows, so the
    // only thing that can keep them out of the result is the early exit.
    setTable("match_players", { data: [mp("p-ghost", MATCH_1, "a", 11, 5)], error: null });
    setTable("profiles", { data: [profile("p-ghost", "Ghost")], error: null });

    const { result } = await renderLoaded();

    expect(
      result.current.players,
      "a session whose only completed match is the one being corrected produced candidates out of nowhere"
    ).toEqual([]);
    expect(
      logsFor("match_players"),
      "the early exit was skipped: match_players was queried with an EMPTY id list. `.in('match_id', [])` is a round trip that can only return nothing, and it is the exact cost the 3-query strategy exists to avoid"
    ).toHaveLength(0);
    expect(
      logsFor("profiles"),
      "the early exit was skipped: profiles was queried after a session with no completed matches"
    ).toHaveLength(0);
  });

  // ── CP-4 (edge, guard order) ───────────────────────────────
  it("CP-4 (edge, guard order): a null/errored matches read → empty list, no downstream reads, loading released", async () => {
    setTable("matches", { data: null, error: { message: "network down" } });
    setTable("match_players", { data: [mp("p-ghost", MATCH_1, "a", 11, 5)], error: null });
    setTable("profiles", { data: [profile("p-ghost", "Ghost")], error: null });

    const { result } = await renderLoaded();

    expect(result.current.players, "a failed candidate read invented candidates").toEqual([]);
    expect(
      logsFor("match_players"),
      "a failed matches read fell through into step 2 — `completedMatches.map` on a null payload throws, which takes the whole FixRecordSheet down instead of degrading to an empty picker"
    ).toHaveLength(0);
    expect(
      result.current.loading,
      "a failed read left the picker spinning forever with no error and no way out"
    ).toBe(false);
  });

  // ── CP-5 (edge, guard order) ───────────────────────────────
  it("CP-5 (edge, guard order): zero match_players rows → the profiles read is never issued", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", EMPTY_OK);
    setTable("profiles", { data: [profile("p-ghost", "Ghost")], error: null });

    const { result } = await renderLoaded();

    expect(
      result.current.players,
      "candidates appeared with no match_players rows to build them from"
    ).toEqual([]);
    expect(
      logsFor("profiles"),
      "profiles was queried with an empty id list. `.in('id', [])` cannot match anything, so this is a wasted round trip on every open of the sheet in a session with orphaned matches"
    ).toHaveLength(0);
  });

  // ── CP-6 (edge) ────────────────────────────────────────────
  it("CP-6 (edge): a null profiles read → empty list, loading still settles", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", { data: [mp("p-alice", MATCH_1, "a", 11, 5)], error: null });
    setTable("profiles", { data: null, error: { message: "permission denied" } });

    const { result } = await renderLoaded();

    expect(
      result.current.players,
      "a failed profiles read produced candidate rows anyway — every one of them would render with no name for the organiser to recognise"
    ).toEqual([]);
    expect(result.current.loading, "a failed profiles read left the picker spinning").toBe(false);
  });

  // ── CP-7 ───────────────────────────────────────────────────
  it("CP-7: dedup — a player in three completed matches yields ONE row with games_played=3", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }, { id: MATCH_2 }, { id: MATCH_3 }], error: null });
    setTable("match_players", {
      data: [
        mp("p-alice", MATCH_1, "a", 11, 4),
        mp("p-alice", MATCH_2, "b", 11, 8),
        mp("p-alice", MATCH_3, "a", 6, 11),
      ],
      error: null,
    });
    setTable("profiles", { data: [profile("p-alice", "Alice")], error: null });

    const { result } = await renderLoaded();

    expect(
      result.current.players.map((p) => p.player_id),
      "a player who played several matches was listed once per match — the picker shows the same person three times and the organiser cannot tell which entry to tap"
    ).toEqual(["p-alice"]);
    expect(
      result.current.players[0],
      "the per-match rows were not aggregated into one session record"
    ).toMatchObject({ games_played: 3, wins: 1, losses: 2 });
  });

  // ── CP-8 ───────────────────────────────────────────────────
  it("CP-8: a win is credited to the player's OWN team, in both directions", async () => {
    // One match, one lopsided score, one player on each side. If the team is
    // ignored, both players get the same verdict — which this asserts against.
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", {
      data: [mp("p-alice", MATCH_1, "a", 11, 3), mp("p-bob", MATCH_1, "b", 11, 3)],
      error: null,
    });
    setTable("profiles", {
      data: [profile("p-alice", "Alice"), profile("p-bob", "Bob")],
      error: null,
    });

    const { result } = await renderLoaded();

    const alice = result.current.players.find((p) => p.player_id === "p-alice");
    const bob = result.current.players.find((p) => p.player_id === "p-bob");
    expect(
      { wins: alice?.wins, losses: alice?.losses },
      "the winning side's player was not credited with the win — the stat line the organiser uses to identify the right person is wrong"
    ).toEqual({ wins: 1, losses: 0 });
    expect(
      { wins: bob?.wins, losses: bob?.losses },
      "the losing side's player was credited with a win: the score was compared without reference to which team the player was on, so team A's result was applied to everybody"
    ).toEqual({ wins: 0, losses: 1 });
  });

  // ── CP-9 (edge) ────────────────────────────────────────────
  it("CP-9 (edge): a tie counts as a loss for both sides", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", {
      data: [mp("p-alice", MATCH_1, "a", 10, 10), mp("p-bob", MATCH_1, "b", 10, 10)],
      error: null,
    });
    setTable("profiles", {
      data: [profile("p-alice", "Alice"), profile("p-bob", "Bob")],
      error: null,
    });

    const { result } = await renderLoaded();

    expect(
      result.current.players.map((p) => ({ w: p.wins, l: p.losses, g: p.games_played })),
      "an equal score credited a win. `won` is a strict >, so a tie is a loss for both sides; a >= would hand BOTH players a win and the two stat lines would add up to more wins than games played"
    ).toEqual([
      { w: 0, l: 1, g: 1 },
      { w: 0, l: 1, g: 1 },
    ]);
  });

  // ── CP-10 (edge) ───────────────────────────────────────────
  it("CP-10 (edge): null scores read as 0–0, so both sides take a loss", async () => {
    // A completed match with no score recorded (an abandoned or force-closed
    // court) must not crash the picker or invent a winner.
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", {
      data: [mp("p-alice", MATCH_1, "a", null, null), mp("p-bob", MATCH_1, "b", null, null)],
      error: null,
    });
    setTable("profiles", {
      data: [profile("p-alice", "Alice"), profile("p-bob", "Bob")],
      error: null,
    });

    const { result } = await renderLoaded();

    expect(
      result.current.players.map((p) => ({ w: p.wins, l: p.losses, g: p.games_played })),
      "an unscored completed match invented a winner, or stopped counting as a game played — a force-closed court must still appear in the stat line as a played game with no win"
    ).toEqual([
      { w: 0, l: 1, g: 1 },
      { w: 0, l: 1, g: 1 },
    ]);
  });

  // ── CP-11 (edge) ───────────────────────────────────────────
  it("CP-11 (edge): a player with no profile row is dropped, and only that player", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", {
      data: [mp("p-alice", MATCH_1, "a", 11, 5), mp("p-ghost", MATCH_1, "b", 11, 5)],
      error: null,
    });
    // p-ghost has match_players rows but no profile (deleted account / RLS).
    setTable("profiles", { data: [profile("p-alice", "Alice")], error: null });

    const { result } = await renderLoaded();

    expect(
      result.current.players.map((p) => p.player_id),
      "a player whose profile row is missing was not dropped (or took the whole list with it) — an unresolvable id must not render as a nameless, untappable candidate, and must not remove the candidates that DID resolve"
    ).toEqual(["p-alice"]);
    expect(
      result.current.players[0].display_name,
      "the surviving candidate lost its name — the positive control for the drop above failed, so that assertion would pass for the wrong reason"
    ).toBe("Alice");
  });

  // ── CP-12 ──────────────────────────────────────────────────
  it("CP-12: the list is ordered by display_name, not by insertion or player id", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }], error: null });
    setTable("match_players", {
      data: [
        mp("p-1", MATCH_1, "a", 11, 5),
        mp("p-2", MATCH_1, "a", 11, 5),
        mp("p-3", MATCH_1, "b", 11, 5),
      ],
      error: null,
    });
    setTable("profiles", {
      data: [profile("p-1", "Zara"), profile("p-2", "Aimee"), profile("p-3", "Marta")],
      error: null,
    });

    const { result } = await renderLoaded();

    expect(
      result.current.players.map((p) => p.display_name),
      "the candidate list is no longer alphabetical — it falls back to whatever order match_players came back in, which changes between opens of the same sheet and makes the picker impossible to scan"
    ).toEqual(["Aimee", "Marta", "Zara"]);
  });

  // ── CP-13 ──────────────────────────────────────────────────
  it("CP-13: the match_players read is scoped by match_id to the completed match ids", async () => {
    seedTwoMatches();
    await renderLoaded();

    expect(
      opsOf("match_players"),
      "step 2 is no longer keyed on match_id over the ids step 1 returned — bound to the wrong column it reads rows for unrelated matches, and the stat lines stop describing this session"
    ).toContain(`in:match_id=[${MATCH_1},${MATCH_2}]`);
    expect(
      opsOf("match_players").some((o) => o.startsWith("select:") && o.includes("matches!inner")),
      "the !inner join to matches was dropped from step 2 — the score columns the win/loss maths reads come from that embed, so every player would silently score 0–0 and take a loss"
    ).toBe(true);
  });

  // ── CP-14 ──────────────────────────────────────────────────
  it("CP-14: the profiles read is scoped by id to the DISTINCT player ids", async () => {
    setTable("matches", { data: [{ id: MATCH_1 }, { id: MATCH_2 }], error: null });
    setTable("match_players", {
      data: [
        mp("p-alice", MATCH_1, "a", 11, 5),
        mp("p-alice", MATCH_2, "a", 11, 5),
        mp("p-bob", MATCH_2, "b", 11, 5),
      ],
      error: null,
    });
    setTable("profiles", {
      data: [profile("p-alice", "Alice"), profile("p-bob", "Bob")],
      error: null,
    });

    await renderLoaded();

    expect(
      opsOf("profiles"),
      "step 3 is no longer keyed on id over the DEDUPED player ids — a repeated id in the .in() list grows the URL with every match a regular plays, and a wrong column returns the wrong people entirely"
    ).toContain("in:id=[p-alice,p-bob]");
  });

  // ── CP-15 ──────────────────────────────────────────────────
  it("CP-15: loading is true on the first render and false once the read lands", async () => {
    seedTwoMatches();

    const { result } = renderHook(() => useSessionCompletedPlayers(SESSION_ID, TARGET_MATCH));

    expect(
      result.current.loading,
      "the hook did not start in a loading state — the sheet would flash 'no other players' before the read lands"
    ).toBe(true);
    expect(result.current.players, "candidates existed before any read completed").toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.players, "the read landed but the list stayed empty").toHaveLength(3);
  });

  // ── CP-16 ──────────────────────────────────────────────────
  it("CP-16: changing the excluded match re-runs the read against the NEW id", async () => {
    seedTwoMatches();
    const { rerender, result } = await renderLoaded();

    rerender({ exclude: OTHER_TARGET_MATCH });
    await waitFor(() =>
      expect(
        logsFor("matches").some((l) => l.ops.includes(`neq:id=${OTHER_TARGET_MATCH}`)),
        "correcting a different match reused the candidate list built for the previous one — the players of the match now being corrected are still offered as candidates, which is precisely the swap the exclusion exists to prevent"
      ).toBe(true)
    );
    // Its own waitFor, not a bare read: the log entry asserted above is
    // written when the query is ISSUED, so checking `loading` synchronously
    // after it races the re-fetch instead of asserting on its outcome.
    await waitFor(() =>
      expect(
        result.current.loading,
        "the hook stayed loading after the excluded match changed — the sheet spins forever on the second correction of a session"
      ).toBe(false)
    );
    expect(
      result.current.players,
      "the re-fetch settled but produced no candidates for a session that has them"
    ).toHaveLength(3);
  });
});
