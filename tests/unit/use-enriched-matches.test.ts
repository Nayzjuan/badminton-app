// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useEnrichedMatches Hook
// ============================================================
// Tests the 4-phase fetch pipeline, both includeDrafts query
// strategies, the race-condition guard, court enrichment, and
// the onProfilesLoaded callback — all without a real Supabase
// connection.
//
//   EM-1  includeDrafts=false — builds correct .or() filter
//   EM-2  includeDrafts=true  — uses .in("status", [...])
//   EM-3  empty matches → activeMatches=[]
//   EM-4  matches enriched with players and profiles
//   EM-5  missing profile gets createUnknownProfile placeholder
//   EM-6  race-condition guard — only newest fetch result applied
//   EM-7  courtsRef used to resolve court for match
//   EM-8  onProfilesLoaded callback invoked with correct profileMap
//
// Runs in the default node environment — this hook has no DOM
// dependencies (no effects, no event listeners).
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { useEnrichedMatches } from "@/hooks/use-enriched-matches";
import type { Match, MatchPlayer, Profile, Court } from "@/types/database";

// ── Constants ─────────────────────────────────────────────────

const SESSION_ID = "sess-em-222";
const MATCH_ID_1 = "match-em-aaa";
const MATCH_ID_2 = "match-em-bbb";
const PLAYER_A1 = "player-a1";
const PLAYER_B1 = "player-b1";
const COURT_ID = "court-em-1";

// ── Fixtures ──────────────────────────────────────────────────

function makeMatch(
  id: string,
  status: Match["status"] = "pending",
  courtId: string | null = null
): Match {
  return {
    id,
    session_id: SESSION_ID,
    court_id: courtId,
    status,
    team_a_score: null,
    team_b_score: null,
    is_mixed_level: false,
    sort_order: 0,
    origin: "auto",
    is_published: true,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  };
}

function makeMatchPlayer(matchId: string, playerId: string, team: "a" | "b"): MatchPlayer {
  return {
    id: `mp-${matchId}-${playerId}`,
    match_id: matchId,
    player_id: playerId,
    team,
  };
}

function makeProfile(id: string, displayName = "Player"): Profile {
  return {
    id,
    display_name: displayName,
    skill_level: "intermediate",
    pin: null,
    vip_tag: null,
    vip_theme: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeCourt(id: string, name = "Court 1"): Court {
  return {
    id,
    session_id: SESSION_ID,
    name,
    status: "available",
    created_at: new Date().toISOString(),
  };
}

// ── Mock Supabase client builder ──────────────────────────────
// Tracks query operations so tests can assert which filters were
// applied.  Each table returns configurable row arrays.

type TableResponses = {
  matches?: Match[];
  match_players?: MatchPlayer[];
  profiles?: Profile[];
};

type QueryLog = {
  table: string;
  ops: string[];
};

function buildMockClient(responses: TableResponses, queryLogs: QueryLog[]) {
  return {
    from: (table: string) => {
      const log: QueryLog = { table, ops: [] };
      queryLogs.push(log);

      const chain: Record<string, unknown> = {
        select: (_cols: string) => chain,
        eq: (_col: string, _val: unknown) => {
          log.ops.push(`eq:${_col}=${_val}`);
          return chain;
        },
        in: (_col: string, vals: unknown[]) => {
          log.ops.push(`in:${_col}=[${(vals as unknown[]).join(",")}]`);
          return chain;
        },
        or: (filter: string) => {
          log.ops.push(`or:${filter}`);
          return chain;
        },
        order: (_col: string) => chain,
        then: (onFulfilled: (v: unknown) => unknown) => {
          const rows =
            table === "matches"
              ? (responses.matches ?? [])
              : table === "match_players"
                ? (responses.match_players ?? [])
                : table === "profiles"
                  ? (responses.profiles ?? [])
                  : [];
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
      };
      return chain;
    },
  };
}

// ── Helper to render the hook with inline courtsRef ───────────

function renderWithCourts(
  courts: Court[],
  options: Parameters<typeof useEnrichedMatches>[3],
  responses: TableResponses,
  queryLogs: QueryLog[]
) {
  const client = buildMockClient(responses, queryLogs);

  return renderHook(() => {
    const courtsRef = useRef<Court[]>(courts);
    return useEnrichedMatches(
      client as unknown as Parameters<typeof useEnrichedMatches>[0],
      SESSION_ID,
      courtsRef,
      options
    );
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("useEnrichedMatches — Unit Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── EM-1 ───────────────────────────────────────────────────
  it("EM-1: includeDrafts=false — builds correct .or() filter", async () => {
    const logs: QueryLog[] = [];
    const { result } = renderWithCourts([], { includeDrafts: false }, { matches: [] }, logs);

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    const matchLog = logs.find((l) => l.table === "matches");
    expect(matchLog).toBeDefined();
    const orOp = matchLog!.ops.find((op) => op.startsWith("or:"));
    expect(orOp).toBeDefined();
    expect(orOp).toContain("status.eq.in_progress");
    expect(orOp).toContain("status.eq.pending");
    expect(orOp).toContain("is_published.eq.true");
  });

  // ── EM-2 ───────────────────────────────────────────────────
  it("EM-2: includeDrafts=true — uses .in('status', ['pending','in_progress'])", async () => {
    const logs: QueryLog[] = [];
    const { result } = renderWithCourts([], { includeDrafts: true }, { matches: [] }, logs);

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    const matchLog = logs.find((l) => l.table === "matches");
    expect(matchLog).toBeDefined();
    const inOp = matchLog!.ops.find((op) => op.startsWith("in:status="));
    expect(inOp).toBeDefined();
    expect(inOp).toContain("pending");
    expect(inOp).toContain("in_progress");
  });

  // ── EM-3 ───────────────────────────────────────────────────
  it("EM-3: empty matches → activeMatches=[]", async () => {
    const logs: QueryLog[] = [];
    const { result } = renderWithCourts([], { includeDrafts: true }, { matches: [] }, logs);

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    expect(result.current.activeMatches).toEqual([]);
  });

  // ── EM-4 ───────────────────────────────────────────────────
  it("EM-4: matches enriched with players and profiles", async () => {
    const match = makeMatch(MATCH_ID_1, "in_progress");
    const mp1 = makeMatchPlayer(MATCH_ID_1, PLAYER_A1, "a");
    const mp2 = makeMatchPlayer(MATCH_ID_1, PLAYER_B1, "b");
    const profile1 = makeProfile(PLAYER_A1, "Alice");
    const profile2 = makeProfile(PLAYER_B1, "Bob");

    const logs: QueryLog[] = [];
    const { result } = renderWithCourts(
      [],
      { includeDrafts: true },
      { matches: [match], match_players: [mp1, mp2], profiles: [profile1, profile2] },
      logs
    );

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    expect(result.current.activeMatches).toHaveLength(1);
    const enriched = result.current.activeMatches[0];
    expect(enriched.id).toBe(MATCH_ID_1);
    expect(enriched.players).toHaveLength(2);

    const alice = enriched.players.find((p) => p.player_id === PLAYER_A1);
    expect(alice?.profile.display_name).toBe("Alice");

    const bob = enriched.players.find((p) => p.player_id === PLAYER_B1);
    expect(bob?.profile.display_name).toBe("Bob");
  });

  // ── EM-5 ───────────────────────────────────────────────────
  it("EM-5: missing profile gets createUnknownProfile placeholder (display_name='Unknown')", async () => {
    const match = makeMatch(MATCH_ID_1, "in_progress");
    const mp = makeMatchPlayer(MATCH_ID_1, "ghost-player", "a");

    const logs: QueryLog[] = [];
    // Profiles array is empty — no profile for "ghost-player".
    const { result } = renderWithCourts(
      [],
      { includeDrafts: true },
      { matches: [match], match_players: [mp], profiles: [] },
      logs
    );

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    expect(result.current.activeMatches).toHaveLength(1);
    const player = result.current.activeMatches[0].players[0];
    expect(player.player_id).toBe("ghost-player");
    expect(player.profile.display_name).toBe("Unknown");
    expect(player.profile.id).toBe("ghost-player");
  });

  // ── EM-6 ───────────────────────────────────────────────────
  it("EM-6: race-condition guard — second fetch started before first returns; only second result applied", async () => {
    // We need to simulate a slow first fetch and a fast second fetch.
    // Build two independent clients: the first delays resolution, the
    // second resolves immediately.

    let resolveFirst!: (val: unknown) => void;
    const firstMatchPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    let callCount = 0;
    const racingClient = {
      from: (_table: string) => {
        callCount++;
        const isFirstCall = callCount <= 1;
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          or: () => chain,
          order: () => chain,
          then: (onFulfilled: (v: unknown) => unknown) => {
            if (isFirstCall && _table === "matches") {
              // First matches fetch is delayed.
              return firstMatchPromise
                .then(() => ({ data: [makeMatch(MATCH_ID_1, "in_progress")], error: null }))
                .then(onFulfilled);
            }
            // All other calls (second fetch, match_players, profiles) resolve immediately.
            const rows =
              _table === "matches"
                ? [makeMatch(MATCH_ID_2, "pending")]
                : _table === "match_players"
                  ? []
                  : _table === "profiles"
                    ? []
                    : [];
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
          },
        };
        return chain;
      },
    };

    const { result } = renderHook(() => {
      const courtsRef = useRef<Court[]>([]);
      return useEnrichedMatches(
        racingClient as unknown as Parameters<typeof useEnrichedMatches>[0],
        SESSION_ID,
        courtsRef,
        { includeDrafts: true }
      );
    });

    // Start first fetch (will hang until resolveFirst is called).
    // We intentionally do NOT await here — we want it to remain in-flight
    // so the second fetch can start before it resolves.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const firstFetch = act(async () => {
      await result.current.fetchActiveMatches();
    });

    // Start second fetch immediately (resolves with MATCH_ID_2).
    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    // Now release the first fetch — its result should be discarded.
    resolveFirst(undefined);
    await firstFetch;

    // Only the second fetch's result should be present.
    expect(result.current.activeMatches).toHaveLength(1);
    expect(result.current.activeMatches[0].id).toBe(MATCH_ID_2);
  });

  // ── EM-7 ───────────────────────────────────────────────────
  it("EM-7: courtsRef used to resolve court for match", async () => {
    const court = makeCourt(COURT_ID, "Court Alpha");
    const match = makeMatch(MATCH_ID_1, "in_progress", COURT_ID);
    const mp = makeMatchPlayer(MATCH_ID_1, PLAYER_A1, "a");
    const profile = makeProfile(PLAYER_A1, "Alice");

    const logs: QueryLog[] = [];
    const { result } = renderWithCourts(
      [court],
      { includeDrafts: true },
      { matches: [match], match_players: [mp], profiles: [profile] },
      logs
    );

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    expect(result.current.activeMatches).toHaveLength(1);
    const enriched = result.current.activeMatches[0];
    expect(enriched.court).not.toBeNull();
    expect(enriched.court?.id).toBe(COURT_ID);
    expect(enriched.court?.name).toBe("Court Alpha");
  });

  // ── EM-8 ───────────────────────────────────────────────────
  it("EM-8: onProfilesLoaded callback invoked with correct profileMap", async () => {
    const match = makeMatch(MATCH_ID_1, "in_progress");
    const mp1 = makeMatchPlayer(MATCH_ID_1, PLAYER_A1, "a");
    const mp2 = makeMatchPlayer(MATCH_ID_1, PLAYER_B1, "b");
    const profile1 = makeProfile(PLAYER_A1, "Alice");
    const profile2 = makeProfile(PLAYER_B1, "Bob");

    const onProfilesLoaded = vi.fn();
    const logs: QueryLog[] = [];

    const { result } = renderWithCourts(
      [],
      { includeDrafts: true, onProfilesLoaded },
      { matches: [match], match_players: [mp1, mp2], profiles: [profile1, profile2] },
      logs
    );

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    expect(onProfilesLoaded).toHaveBeenCalledOnce();
    const profileMap: Map<string, Profile> = onProfilesLoaded.mock.calls[0][0];
    expect(profileMap).toBeInstanceOf(Map);
    expect(profileMap.size).toBe(2);
    expect(profileMap.get(PLAYER_A1)?.display_name).toBe("Alice");
    expect(profileMap.get(PLAYER_B1)?.display_name).toBe("Bob");
  });

  // ── EM-new-1 ────────────────────────────────────────────────
  it("EM-new-1: match with no match_players → profiles query is skipped, match enriched with empty players array (lines 99-107 false-branch)", async () => {
    // When a match has no match_players rows, playerIds.length === 0.
    // Phase 3 guard: `if (playerIds.length > 0)` is false → profiles query is skipped.
    // Match is still enriched with players: [].
    const match = makeMatch(MATCH_ID_1, "in_progress");

    const logs: QueryLog[] = [];
    const { result } = renderWithCourts(
      [],
      { includeDrafts: true },
      { matches: [match], match_players: [], profiles: [] },
      logs
    );

    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    expect(result.current.activeMatches).toHaveLength(1);
    expect(result.current.activeMatches[0].players).toHaveLength(0);

    // Profiles query should NOT have been issued (no playerIds)
    const profileLog = logs.find((l) => l.table === "profiles");
    expect(profileLog).toBeUndefined();
  });

  // ── EM-new-2 ────────────────────────────────────────────────
  it("EM-new-2: race guard on matches query — first fetch superseded before reaching match_players", async () => {
    // Verifies the race guard immediately after the matches query
    // (`if (mySeq !== seqRef.current) return` — line 82 in use-enriched-matches.ts):
    // the first fetch is still waiting on the matches promise when a second fetch
    // completes fully and increments seqRef. When the first fetch is released it
    // finds seqRef changed and discards its stale result.
    //
    // Note: this does NOT exercise the race guard at line 96 (after match_players)
    // or line 104 (inside the profiles block). Those guards require the first fetch
    // to hang specifically between match_players/profiles — a two-phase hang that
    // a future test could add using a table-scoped mock.
    //
    // Observable: only fetch 2's result is applied; no crash.

    let resolveFirst!: (v: undefined) => void;
    const firstMatchPromise = new Promise<undefined>((res) => {
      resolveFirst = res;
    });

    let callCount = 0;

    const racingClient = {
      from: (_table: string) => {
        const isFirstMatchCall = _table === "matches" && callCount++ === 0;
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          or: () => chain,
          order: () => chain,
          then: (onFulfilled: (v: unknown) => unknown) => {
            if (isFirstMatchCall) {
              // First matches fetch hangs until released.
              return firstMatchPromise
                .then(() => ({ data: [makeMatch(MATCH_ID_1, "in_progress")], error: null }))
                .then(onFulfilled);
            }
            // Everything else resolves immediately.
            const rows =
              _table === "matches"
                ? [makeMatch(MATCH_ID_2, "pending")]
                : _table === "match_players"
                  ? [makeMatchPlayer(MATCH_ID_2, PLAYER_A1, "a")]
                  : _table === "profiles"
                    ? [makeProfile(PLAYER_A1, "Alice")]
                    : [];
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
          },
        };
        return chain;
      },
    };

    const { result } = renderHook(() => {
      const courtsRef = useRef<Court[]>([]);
      return useEnrichedMatches(
        racingClient as unknown as Parameters<typeof useEnrichedMatches>[0],
        SESSION_ID,
        courtsRef,
        { includeDrafts: true }
      );
    });

    // Start first fetch (hangs on matches query).
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const firstFetch = act(async () => {
      await result.current.fetchActiveMatches();
    });

    // Second fetch completes fully (match_players + profiles).
    await act(async () => {
      await result.current.fetchActiveMatches();
    });

    // Release first fetch — but seqRef.current is now 2; fetch 1's seqRef is 1.
    resolveFirst(undefined);
    await firstFetch;

    // Only fetch 2's result should be present.
    expect(result.current.activeMatches).toHaveLength(1);
    expect(result.current.activeMatches[0].id).toBe(MATCH_ID_2);
  });
});
