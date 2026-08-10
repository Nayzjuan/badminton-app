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
import { renderHook, waitFor, act } from "@testing-library/react";
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
// Tables listed here answer the NEXT query with an error instead of rows —
// exercises the preserve-stale-on-error paths.
let mockErrorTables = new Set<string>();
// The auth-loss guard (real hasAuthSession via importOriginal below) probes
// auth.getSession; null = "this client has fallen back to anon".
let mockAuthSession: { access_token: string } | null = { access_token: "test-jwt" };
let authChangeCallback: ((event: string) => void) | null = null;

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
            if (mockErrorTables.has(table)) {
              mockErrorTables.delete(table);
              return Promise.resolve({ data: null, error: { message: "boom" } }).then(onFulfilled);
            }
            return Promise.resolve({
              data: nextResponse(table),
              error: null,
            }).then(onFulfilled);
          },
        };
        return chain;
      },
    }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockAuthSession } }),
      onAuthStateChange: (cb: (event: string) => void) => {
        authChangeCallback = cb;
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authChangeCallback = null;
              },
            },
          },
        };
      },
    },
  };
}

// ── Mock Modules ──────────────────────────────────────────────

// importOriginal keeps the real hasAuthSession (the hook imports it from this
// module) running against the mock client's auth stub.
vi.mock("@/utils/supabase/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/supabase/client")>()),
  createBrowserSupabaseClient: () => buildMockClient(),
}));

let matchCallback: (() => void) | null = null;
let playerCallback: (() => void) | null = null; // eslint-disable-line @typescript-eslint/no-unused-vars
let queueCallback: (() => void) | null = null;
let queuePrefix: string | undefined;

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
  // Third stream — see the comment in use-player-match.ts. A held cross-court
  // draft is pending+unpublished, so the draft firewall hides both its `matches`
  // row and its `match_players` rows from the very player it reserves; the
  // `queue_entries` flip to 'drafted' is the only event that reaches them.
  subscribeToQueue: (
    _client: unknown,
    _sessionId: string,
    cb: () => void,
    channelPrefix?: string
  ) => {
    queueCallback = cb;
    queuePrefix = channelPrefix;
    return () => {
      queueCallback = null;
    };
  },
}));

// ── Tests ─────────────────────────────────────────────────────

describe("usePlayerMatch — Unit Suite", () => {
  beforeEach(() => {
    mockResponses = {};
    mockResponseQueue = {};
    mockErrorTables = new Set();
    mockAuthSession = { access_token: "test-jwt" };
    authChangeCallback = null;
    matchCallback = null;
    playerCallback = null;
    queueCallback = null;
    queuePrefix = undefined;
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

  // ── U-HELD-1 ───────────────────────────────────────────────
  it("U-HELD-1: a queue_entries event re-fetches (the pulled player's only held-draft signal)", async () => {
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

    // The subscription exists at all, and carries a channelPrefix so it cannot
    // collide with the other queue subscribers in the same session.
    expect(queueCallback).toBeTypeOf("function");
    expect(queuePrefix).toBe("player-match");

    // create_held_cross_court_match flips three queue_entries rows to 'drafted'
    // in the same transaction as the (firewalled) match insert. That event —
    // and only that event — must still drive a re-fetch.
    mockResponseQueue.match_players = [[], []];
    queueCallback?.();

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
  it("U-new-2: match_players roster query returns null → state HELD, no crash, no wipe", async () => {
    // Player has an active match assignment, but the second match_players query
    // (fetching all 4 players in the match) returns null — a DB blip.
    //
    // CONTRACT CHANGE (Heads Up flash fix): this used to commit
    // `currentMatch = null`, which tore the alert down over a transient
    // failure. A roster we cannot re-fetch is a blip, not "the match is
    // gone" — the hook now preserves state and leaves `loading` untouched
    // (still true here, since this is the initial load), so the dashboard
    // keeps its skeleton until a retry succeeds.
    mockResponseQueue.match_players = [
      [{ match_id: MATCH_ID, team: "a", matches: { session_id: SESSION_ID } }],
      null as unknown as unknown[], // second call: data=null → preserve-stale path
    ];
    mockResponses.matches = [mockMatch];
    mockResponses.courts = [];

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    // The mount fetch settles on the preserve-stale path — the error log is
    // its completion signal (loading:false would never arrive, by design).
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(result.current.loading).toBe(true);
    expect(result.current.currentMatch).toBeNull();
    errSpy.mockRestore();
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

  // ── U-AUTH: anon-fallback guard (the "Heads Up" flash) ─────
  // An anon-window fetch answers "no assignments" for a player who is
  // actually on deck. Committing it painted "Ready to play?" (cold start)
  // or tore the alert down mid-transition. Empty-without-auth must hold.

  it("U-AUTH-1: cold start — empty assignments without auth keep loading (no join-card flash)", async () => {
    mockResponses.match_players = [];
    mockAuthSession = null;

    const { result } = renderHook(() => usePlayerMatch(SESSION_ID, PLAYER_ID));

    // Drive a full fetch to completion: it must NOT commit the anon
    // emptiness — loading stays true, so the dashboard shows the skeleton
    // instead of the "Ready to play?" join card.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.currentMatch).toBeNull();
  });

  it("U-AUTH-2: mid-session — empty assignments without auth preserve the alert; authed empty clears it", async () => {
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
    await waitFor(() => expect(result.current.currentMatch).not.toBeNull());

    // Auth dies; the next fetch sees no assignments (anon). Hold the alert.
    mockAuthSession = null;
    mockResponseQueue.match_players = [[]];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.currentMatch).not.toBeNull();

    // Recovery: TOKEN_REFRESHED refires the fetch; a genuinely-authed empty
    // (the match is truly over) must still clear the alert.
    mockAuthSession = { access_token: "test-jwt" };
    mockResponseQueue.match_players = [[]];
    act(() => {
      authChangeCallback?.("TOKEN_REFRESHED");
    });
    await waitFor(() => expect(result.current.currentMatch).toBeNull());
  });

  it("U-ERR-1: a query error preserves the current match instead of wiping it", async () => {
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
    await waitFor(() => expect(result.current.currentMatch).not.toBeNull());

    // This chain runs 5–6 queries per realtime event — one blip must not
    // tear the Heads Up takeover down.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockErrorTables.add("match_players");
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.currentMatch).not.toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
