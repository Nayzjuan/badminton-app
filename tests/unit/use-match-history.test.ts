// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useMatchHistory Hook
// ============================================================
//
//   MH-1  Loading starts true, false after initial fetch
//   MH-2  Empty result when no completed/cancelled matches
//   MH-3  Enriches matches with player profiles
//   MH-4  Falls back to createUnknownProfile for missing profiles
//   MH-5  Enriches matches with court names
//   MH-6  courtName is null when match has no court_id
//   MH-7  Realtime subscription triggers re-fetch
//   MH-8  refresh() callable and re-fetches
//   MH-9  Fetches both completed AND cancelled matches
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "@testing-library/react";
import { useMatchHistory } from "@/hooks/use-match-history";

// ── Mocks ─────────────────────────────────────────────────────

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/realtime", () => ({
  subscribeToMatches: vi.fn(() => vi.fn()), // returns unsubscribe fn
}));

import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-abc";
const MATCH_ID = "match-1";
const COURT_ID = "court-x";
const PLAYER_ID = "player-known";
const UNKNOWN_ID = "player-unknown";

const completedMatch = {
  id: MATCH_ID,
  session_id: SESSION_ID,
  court_id: COURT_ID,
  status: "completed",
  team_a_score: 21,
  team_b_score: 18,
  is_mixed_level: false,
  sort_order: null,
  origin: "auto",
  is_published: true,
  created_at: "2026-01-01T10:00:00Z",
  started_at: "2026-01-01T10:05:00Z",
  completed_at: "2026-01-01T10:20:00Z",
};

const knownProfile = {
  id: PLAYER_ID,
  display_name: "Alice",
  skill_level: "intermediate",
  pin: null,
  vip_tag: null,
  vip_theme: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// ── Mock client factory ────────────────────────────────────────

type FromTable = "matches" | "match_players" | "profiles" | "courts";

function buildMockClient(overrides: Partial<Record<FromTable, unknown>> = {}) {
  const defaults: Record<FromTable, unknown> = {
    matches: [completedMatch],
    match_players: [{ match_id: MATCH_ID, player_id: PLAYER_ID, team: "a", id: "mp-1" }],
    profiles: [knownProfile],
    courts: [{ id: COURT_ID, name: "Court X" }],
    ...overrides,
  };

  return {
    from: (table: string) => {
      const data = defaults[table as FromTable] ?? [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        then: (resolve: (v: { data: unknown; error: null }) => void) =>
          resolve({ data, error: null }),
      };
      return chain;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(subscribeToMatches).mockReturnValue(vi.fn());
});

describe("useMatchHistory", () => {
  describe("MH-1: Loading state", () => {
    it("starts with loading = true and matches = []", () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient() as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      expect(result.current.loading).toBe(true);
      expect(result.current.matches).toEqual([]);
    });

    it("sets loading = false after fetch completes", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient() as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.loading).toBe(false));
    });
  });

  describe("MH-2: Empty result", () => {
    it("returns empty matches array when no history exists", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient({ matches: [] }) as unknown as ReturnType<
          typeof createBrowserSupabaseClient
        >
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.matches).toEqual([]);
    });
  });

  describe("MH-3: Enriches with player profiles", () => {
    it("attaches profile to each match player", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient() as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(1));

      const match = result.current.matches[0];
      expect(match.players).toHaveLength(1);
      expect(match.players[0].profile.display_name).toBe("Alice");
      expect(match.players[0].player_id).toBe(PLAYER_ID);
    });
  });

  describe("MH-4: Unknown profile fallback (regression pin)", () => {
    it("uses createUnknownProfile for players with no DB profile", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient({
          match_players: [{ match_id: MATCH_ID, player_id: UNKNOWN_ID, team: "b", id: "mp-2" }],
          profiles: [], // no profile exists for UNKNOWN_ID
        }) as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(1));

      const player = result.current.matches[0].players[0];
      expect(player.player_id).toBe(UNKNOWN_ID);
      expect(player.profile.display_name).toBe("Unknown");
      expect(player.profile.id).toBe(UNKNOWN_ID);
    });
  });

  describe("MH-5: Court name enrichment", () => {
    it("attaches court name to match", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient() as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(1));
      expect(result.current.matches[0].courtName).toBe("Court X");
    });
  });

  describe("MH-6: Null courtName when no court", () => {
    it("sets courtName to null when match has no court_id", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient({
          matches: [{ ...completedMatch, court_id: null }],
        }) as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(1));
      expect(result.current.matches[0].courtName).toBeNull();
    });
  });

  describe("MH-7: Realtime subscription triggers re-fetch", () => {
    it("wires subscribeToMatches with org-history prefix", async () => {
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient() as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(subscribeToMatches).toHaveBeenCalled());

      const [, sessionArg, , prefixArg] = vi.mocked(subscribeToMatches).mock.calls[0];
      expect(sessionArg).toBe(SESSION_ID);
      expect(prefixArg).toBe("org-history");
    });

    it("calls fetchHistory when realtime fires", async () => {
      // subscribeToMatches passes a typed payload to its callback, but the
      // hook calls it without arguments (the payload is unused). Cast to any
      // so we can capture and invoke it in tests without the full type.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let realtimeCallback: ((...args: any[]) => void) | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(subscribeToMatches).mockImplementation((_: any, __: any, cb: any) => {
        realtimeCallback = cb;
        return vi.fn();
      });

      // Mock returns different data on the 2nd fetch so we can prove the
      // re-fetch actually ran — the previous assertion (≥ fetchCount) was a
      // false positive because both fetches returned the same single match.
      let matchFetchCount = 0;
      const match2 = { ...completedMatch, id: "match-2" };
      vi.mocked(createBrowserSupabaseClient).mockReturnValue({
        from: (table: string) => {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            then: (resolve: (v: { data: unknown; error: null }) => void) => {
              if (table === "matches") {
                matchFetchCount++;
                resolve({
                  data: matchFetchCount === 1 ? [completedMatch] : [completedMatch, match2],
                  error: null,
                });
              } else if (table === "match_players") {
                resolve({
                  data: [{ match_id: MATCH_ID, player_id: PLAYER_ID, team: "a", id: "mp-1" }],
                  error: null,
                });
              } else if (table === "profiles") {
                resolve({ data: [knownProfile], error: null });
              } else {
                resolve({ data: [{ id: COURT_ID, name: "Court X" }], error: null });
              }
            },
          };
          return chain;
        },
      } as unknown as ReturnType<typeof createBrowserSupabaseClient>);

      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(1));

      // Simulate realtime event — second fetch returns 2 matches.
      await act(async () => {
        realtimeCallback?.();
      });

      // If realtime wiring is broken, this stays at 1 and the test fails.
      await waitFor(() => expect(result.current.matches.length).toBe(2));
    });
  });

  describe("MH-8: refresh() callable", () => {
    it("refresh() triggers a new fetch and returns updated matches", async () => {
      let callCount = 0;
      const client = {
        from: (table: string) => {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            then: (resolve: (v: { data: unknown; error: null }) => void) => {
              if (table === "matches") callCount++;
              const data =
                table === "matches"
                  ? callCount > 1
                    ? [
                        completedMatch,
                        { ...completedMatch, id: "match-2", completed_at: "2026-01-02T10:00:00Z" },
                      ]
                    : [completedMatch]
                  : table === "match_players"
                    ? [{ match_id: MATCH_ID, player_id: PLAYER_ID, team: "a", id: "mp-1" }]
                    : table === "profiles"
                      ? [knownProfile]
                      : [{ id: COURT_ID, name: "Court X" }];
              resolve({ data, error: null });
            },
          };
          return chain;
        },
      };
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        client as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );

      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(1));

      await act(async () => result.current.refresh());
      // Second fetch returns 2 matches — toBe(2) proves refresh() actually ran,
      // not just that the first fetch's result is still present.
      await waitFor(() => expect(result.current.matches.length).toBe(2));
    });
  });

  describe("MH-new-1: match with no players (lines 51 false-branch)", () => {
    it("MH-new-1: match has no match_player rows → profiles query skipped, players array empty", async () => {
      // When `playerIds.length === 0`, `if (playerIds.length > 0)` is false →
      // the profiles fetch is skipped. Match is still enriched with players: [].
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient({
          matches: [completedMatch],
          match_players: [], // no players → playerIds = []
          profiles: [],      // should never be queried
        }) as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );

      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.matches).toHaveLength(1);
      expect(result.current.matches[0].players).toHaveLength(0);
    });
  });

  describe("MH-new-2: match with no court_id (lines 59 false-branch)", () => {
    it("MH-new-2: match with null court_id → courts query skipped, courtName is null", async () => {
      // When `courtIds.length === 0` (match has no court), `if (courtIds.length > 0)` is false →
      // courts fetch is skipped. courtName is null for that match.
      const noCourtMatch = { ...completedMatch, court_id: null };

      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient({
          matches: [noCourtMatch],
          match_players: [{ match_id: MATCH_ID, player_id: PLAYER_ID, team: "a", id: "mp-1" }],
          profiles: [knownProfile],
          courts: [], // should not be queried since court_id is null
        }) as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );

      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.matches).toHaveLength(1);
      expect(result.current.matches[0].courtName).toBeNull();
    });
  });

  describe("MH-9: Fetches completed AND cancelled", () => {
    it("includes cancelled matches in history", async () => {
      const cancelledMatch = {
        ...completedMatch,
        id: "match-cancel",
        status: "cancelled",
        completed_at: null,
      };
      vi.mocked(createBrowserSupabaseClient).mockReturnValue(
        buildMockClient({
          matches: [completedMatch, cancelledMatch],
          match_players: [
            { match_id: MATCH_ID, player_id: PLAYER_ID, team: "a", id: "mp-1" },
            { match_id: "match-cancel", player_id: PLAYER_ID, team: "a", id: "mp-2" },
          ],
        }) as unknown as ReturnType<typeof createBrowserSupabaseClient>
      );
      const { result } = renderHook(() => useMatchHistory(SESSION_ID));
      await waitFor(() => expect(result.current.matches.length).toBe(2));

      const statuses = result.current.matches.map((m) => m.status);
      expect(statuses).toContain("completed");
      expect(statuses).toContain("cancelled");
    });
  });
});
