// @vitest-environment happy-dom
// ============================================================
// Unit Tests — usePlayerMatch Hook
// ============================================================
// Tests the core data-fetching and state-computation logic of
// usePlayerMatch without a real Supabase connection.
//
//   U-1  Loading state on mount
//   U-2  No assignment → currentMatch is null
//   U-3  Assigned to in_progress match → currentMatch populated
//   U-4  Assigned to pending match → onDeckPosition computed
//   U-5  Realtime event triggers re-fetch
//   U-6  refresh() callable from outside
//
// Strategy: mock @/utils/supabase/client and @/lib/realtime so
// the hook runs against an in-memory client that returns fixtures.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePlayerMatch } from "@/hooks/use-player-match";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-111";
const PLAYER_ID = "player-me";
const MATCH_ID = "match-aaa";
const COURT_ID = "court-1";

const mockMatch = {
  id: MATCH_ID,
  session_id: SESSION_ID,
  court_id: COURT_ID,
  status: "in_progress",
  is_published: true,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00Z",
  team_a_score: 21,
  team_b_score: 15,
  is_mixed_level: false,
  origin: "auto",
  is_on_deck: false,
  started_at: "2026-01-01T00:05:00Z",
  completed_at: null,
};

const mockCourt = {
  id: COURT_ID,
  session_id: SESSION_ID,
  name: "Court 1",
  status: "in_use",
};

// Full Profile rows (all columns) so a future field access fails loudly rather
// than silently returning undefined.
const profileBase = {
  pin: null,
  vip_tag: null,
  vip_theme: null,
  needs_rename: false,
  collided_name: null,
  flagged_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const mockProfiles = [
  { id: PLAYER_ID, display_name: "Me", skill_level: "intermediate", ...profileBase },
  { id: "player-t1", display_name: "Teammate", skill_level: "intermediate", ...profileBase },
  { id: "player-o1", display_name: "Opp1", skill_level: "advanced", ...profileBase },
  { id: "player-o2", display_name: "Opp2", skill_level: "beginner", ...profileBase },
];

// ── Mock Supabase Client ──────────────────────────────────────

let mockResponses: Record<string, unknown[]> = {};
let mockResponseQueue: Record<string, unknown[][]> = {};

function nextResponse(table: string): unknown[] {
  const queue = mockResponseQueue[table];
  if (queue && queue.length > 0) {
    return queue.shift()!;
  }
  return mockResponses[table] ?? [];
}

function buildMockClient() {
  return {
    from: (table: string) => ({
      select: (_cols: string) => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          in: () => chain,
          or: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => {
            const rows = nextResponse(table);
            return { data: rows[0] ?? null, error: null };
          },
          single: async () => {
            const rows = nextResponse(table);
            return { data: rows[0] ?? null, error: null };
          },
          then: (onFulfilled: (value: unknown) => unknown) => {
            return Promise.resolve({
              data: nextResponse(table),
              error: null,
            }).then(onFulfilled);
          },
        };
        return chain;
      },
    }),
  };
}

// ── Mock Modules ──────────────────────────────────────────────

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => buildMockClient(),
}));

let matchCallback: (() => void) | null = null;
let playerCallback: (() => void) | null = null; // eslint-disable-line @typescript-eslint/no-unused-vars

vi.mock("@/lib/realtime", () => ({
  subscribeToMatches: (_client: unknown, _sessionId: string, cb: () => void) => {
    matchCallback = cb;
    return () => {
      matchCallback = null;
    };
  },
  subscribeToMatchPlayers: (_client: unknown, _sessionId: string, cb: () => void) => {
    playerCallback = cb;
    return () => {
      playerCallback = null;
    };
  },
}));

// ── Tests ─────────────────────────────────────────────────────

describe("usePlayerMatch — Unit Suite", () => {
  beforeEach(() => {
    mockResponses = {};
    mockResponseQueue = {};
    matchCallback = null;
    playerCallback = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── U-1 ────────────────────────────────────────────────────
  it("U-1: starts in loading state", () => {
    mockResponses.match_players = [];

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    expect(result.current.loading).toBe(true);
    expect(result.current.currentMatch).toBeNull();
  });

  // ── U-2 ────────────────────────────────────────────────────
  it("U-2: no assignment → currentMatch is null after fetch", async () => {
    mockResponses.match_players = [];

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentMatch).toBeNull();
  });

  // ── U-3 ────────────────────────────────────────────────────
  it("U-3: assigned to in_progress match → currentMatch populated", async () => {
    mockResponseQueue.match_players = [
      // 1st query: my assignments
      [{ match_id: MATCH_ID, team: "a", matches: { session_id: SESSION_ID } }],
      // 2nd query: all players in match
      [
        { player_id: PLAYER_ID, team: "a" },
        { player_id: "player-t1", team: "a" },
        { player_id: "player-o1", team: "b" },
        { player_id: "player-o2", team: "b" },
      ],
    ];
    mockResponses.matches = [mockMatch];
    mockResponses.courts = [mockCourt];
    mockResponses.profiles = mockProfiles;

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const cm = result.current.currentMatch;
    expect(cm).not.toBeNull();
    expect(cm?.match.id).toBe(MATCH_ID);
    expect(cm?.match.status).toBe("in_progress");
    expect(cm?.court?.id).toBe(COURT_ID);
    expect(cm?.myTeam).toBe("a");
    expect(cm?.teammates.length).toBe(1);
    expect(cm?.opponents.length).toBe(2);
    expect(cm?.onDeckPosition).toBeNull(); // in_progress → no position
  });

  // ── U-4 ────────────────────────────────────────────────────
  it("U-4: assigned to pending match → onDeckPosition computed", async () => {
    const pendingMatch = { ...mockMatch, status: "pending" };
    mockResponseQueue.match_players = [
      [{ match_id: MATCH_ID, team: "b", matches: { session_id: SESSION_ID } }],
      [
        { player_id: PLAYER_ID, team: "b" },
        { player_id: "player-t1", team: "b" },
        { player_id: "player-o1", team: "a" },
        { player_id: "player-o2", team: "a" },
      ],
    ];
    mockResponses.matches = [pendingMatch];
    mockResponses.courts = [];
    mockResponses.profiles = mockProfiles;

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const cm = result.current.currentMatch;
    expect(cm).not.toBeNull();
    expect(cm?.match.status).toBe("pending");
    expect(cm?.onDeckPosition).toBe(1);
    expect(cm?.totalOnDeck).toBe(1);
  });

  // ── U-5 ────────────────────────────────────────────────────
  it("U-5: realtime event triggers re-fetch", async () => {
    mockResponseQueue.match_players = [
      [{ match_id: MATCH_ID, team: "a", matches: { session_id: SESSION_ID } }],
      [
        { player_id: PLAYER_ID, team: "a" },
        { player_id: "player-t1", team: "a" },
        { player_id: "player-o1", team: "b" },
        { player_id: "player-o2", team: "b" },
      ],
    ];
    mockResponses.matches = [mockMatch];
    mockResponses.courts = [mockCourt];
    mockResponses.profiles = mockProfiles;

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentMatch).not.toBeNull();

    // Simulate a realtime event that clears the assignment
    mockResponseQueue.match_players = [[], []];
    matchCallback?.();

    await waitFor(() => expect(result.current.currentMatch).toBeNull());
  });

  // ── U-new-1 ─────────────────────────────────────────────────
  it("U-new-1: player assigned to a completed match → currentMatch null (no active match found, line 100 path)", async () => {
    // Player has a match_players assignment but the match is "completed"
    // → it doesn't pass the .or("status.eq.in_progress,...") filter
    // → matches returns [] → setCurrentMatch(null) early return (line 100)
    mockResponseQueue.match_players = [
      // First query: assignments exist
      [{ match_id: MATCH_ID, team: "a", matches: { session_id: SESSION_ID } }],
    ];
    // matches query returns empty (completed match not in active filter)
    mockResponses.matches = [];

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentMatch).toBeNull();
  });

  // ── U-new-2 ─────────────────────────────────────────────────
  it("U-new-2: match_players roster query returns null → currentMatch null without crashing (lines 154-156)", async () => {
    // Player has an active match assignment, but the second match_players query
    // (fetching all 4 players in the match) returns null — simulating a DB error.
    // Guard at lines 154-156: `if (!allPlayers) { setCurrentMatch(null); setLoading(false); return; }`
    //
    // The mock queue accepts null entries: queue.shift() returns null →
    // data: null → allPlayers = null → guard fires.
    mockResponseQueue.match_players = [
      [{ match_id: MATCH_ID, team: "a", matches: { session_id: SESSION_ID } }],
      null as unknown as unknown[], // second call: data=null → triggers the null guard
    ];
    mockResponses.matches = [mockMatch];
    mockResponses.courts = [];

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentMatch).toBeNull();
  });

  // ── U-6 ────────────────────────────────────────────────────
  it("U-6: refresh() is callable and re-fetches", async () => {
    mockResponseQueue.match_players = [
      [{ match_id: MATCH_ID, team: "a", matches: { session_id: SESSION_ID } }],
      [
        { player_id: PLAYER_ID, team: "a" },
        { player_id: "player-t1", team: "a" },
        { player_id: "player-o1", team: "b" },
        { player_id: "player-o2", team: "b" },
      ],
    ];
    mockResponses.matches = [mockMatch];
    mockResponses.courts = [mockCourt];
    mockResponses.profiles = mockProfiles;

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Clear assignment and refresh manually
    mockResponseQueue.match_players = [[], []];
    await result.current.refresh();

    await waitFor(() => expect(result.current.currentMatch).toBeNull());
  });
});
