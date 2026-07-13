// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useLeaderboard Hook
// ============================================================
// Tests the core data-fetching, derived state, and handler
// logic of useLeaderboard without a real Supabase connection.
//
//   LB-1  initial scopeTab="session" when initialSessionId provided
//   LB-2  session leaderboard fetched on mount, rows set
//   LB-3  myRow is the current user's row from sessionRows
//   LB-4  myRow is null when currentUserId not in rows
//   LB-5  handleSessionPick → activeSessionId and activeSessionName updated
//   LB-6  handleClearSession → activeSessionId reset to null
//   LB-7  handleRefresh re-fetches session leaderboard (call count increases)
//   LB-8  error state set when getSessionLeaderboard returns error
//
// Strategy: mock @/app/actions/leaderboard, @/utils/supabase/client,
// and @/lib/realtime so the hook runs entirely in-memory.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useLeaderboard, MIN_SESSION_GP, MIN_ALLTIME_GP } from "@/hooks/use-leaderboard";
import type { LeaderboardRow } from "@/types/leaderboard";
import type { LeaderboardSessionOption } from "@/hooks/use-leaderboard";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-abc";
const SESSION_NAME = "Tuesday Night Session";
const USER_ID = "player-me";

function makeRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    player_id: "player-other",
    display_name: "Other Player",
    rank: 2,
    wins: 3,
    losses: 2,
    games_played: 5,
    win_pct: 60.0,
    win_streak: 1,
    points_for: 80,
    points_against: 70,
    point_diff: 10,
    rank_movement: null,
    vip_tag: null,
    vip_theme: null,
    ...overrides,
  };
}

const myRow = makeRow({ player_id: USER_ID, display_name: "Me", rank: 1 });
const otherRow = makeRow({ player_id: "player-other", display_name: "Other", rank: 2 });

// ── Mock: leaderboard server actions ─────────────────────────

import {
  getSessionLeaderboard,
  getAllTimeLeaderboard,
  getPlayerStats,
} from "@/app/actions/leaderboard";

vi.mock("@/app/actions/leaderboard", () => ({
  getSessionLeaderboard: vi.fn(),
  getAllTimeLeaderboard: vi.fn(),
  getMonthlyLeaderboard: vi.fn().mockResolvedValue({ success: true, rows: [] }),
  getLeaderboardMonths: vi.fn().mockResolvedValue({ success: true, months: [] }),
  getPlayerStats: vi.fn(),
  getPlayerMonthlyStats: vi.fn().mockResolvedValue({ success: true, row: null }),
}));

// ── Mock: Supabase browser client ─────────────────────────────
// The hook passes the client to subscribeToMatches; a plain object is enough.

const mockSupabase = {};

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => mockSupabase,
}));

// ── Mock: realtime subscription ───────────────────────────────

let realtimeCallback: (() => void) | null = null;

vi.mock("@/lib/realtime", () => ({
  subscribeToMatches: (_c: unknown, _s: string, cb: () => void) => {
    realtimeCallback = cb;
    return () => {
      realtimeCallback = null;
    };
  },
}));

// ── Mock: next/navigation ─────────────────────────────────────
// useLeaderboard now calls useVisibilityRefresh (→ useRouter) for the
// foreground re-sync, and useClubSlug (→ usePathname). Same mock shape as
// use-queue.test.ts.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/leaderboard",
}));

// ── Helpers ───────────────────────────────────────────────────

const mockGetSessionLeaderboard = getSessionLeaderboard as ReturnType<typeof vi.fn>;
const mockGetAllTimeLeaderboard = getAllTimeLeaderboard as ReturnType<typeof vi.fn>;
const mockGetPlayerStats = getPlayerStats as ReturnType<typeof vi.fn>;

function setupDefaultMocks(rows: LeaderboardRow[] = [myRow, otherRow]) {
  mockGetSessionLeaderboard.mockResolvedValue({ success: true, rows });
  mockGetAllTimeLeaderboard.mockResolvedValue({ success: true, rows: [] });
  mockGetPlayerStats.mockResolvedValue({ success: true, row: null });
}

// ── Tests ─────────────────────────────────────────────────────

describe("useLeaderboard — Unit Suite", () => {
  beforeEach(() => {
    realtimeCallback = null;
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── LB-1 ──────────────────────────────────────────────────
  it("LB-1: scopeTab defaults to 'session' when initialSessionId is provided", () => {
    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    expect(result.current.scopeTab).toBe("session");
    expect(result.current.activeSessionId).toBe(SESSION_ID);
    expect(result.current.activeSessionName).toBe(SESSION_NAME);
  });

  // ── LB-2 ──────────────────────────────────────────────────
  it("LB-2: session leaderboard is fetched on mount and rows are populated", async () => {
    const rows = [myRow, otherRow];
    mockGetSessionLeaderboard.mockResolvedValue({ success: true, rows });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    // Initially loading
    expect(result.current.sessionLoading).toBe(true);

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));

    expect(result.current.sessionRows).toHaveLength(2);
    expect(result.current.sessionRows[0].player_id).toBe(USER_ID);
    expect(mockGetSessionLeaderboard).toHaveBeenCalledWith(SESSION_ID);
  });

  // ── LB-3 ──────────────────────────────────────────────────
  it("LB-3: myRow is the current user's row from sessionRows", async () => {
    mockGetSessionLeaderboard.mockResolvedValue({
      success: true,
      rows: [myRow, otherRow],
    });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));

    expect(result.current.myRow).toBeDefined();
    expect(result.current.myRow?.player_id).toBe(USER_ID);
  });

  // ── LB-4 ──────────────────────────────────────────────────
  it("LB-4: myRow is null/undefined when currentUserId is not in rows", async () => {
    // Return only rows that don't include the current user
    mockGetSessionLeaderboard.mockResolvedValue({
      success: true,
      rows: [otherRow],
    });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));

    // Array.find returns undefined when no match — the hook returns that as myRow
    expect(result.current.myRow).toBeFalsy();
  });

  // ── LB-5 ──────────────────────────────────────────────────
  it("LB-5: handleSessionPick sets activeSessionId and activeSessionName", async () => {
    // Start with no session selected (alltime scope by default)
    // The mock will resolve after pick so rows only arrive after the effect fires
    let resolveSession!: (v: unknown) => void;
    mockGetSessionLeaderboard.mockReturnValue(
      new Promise((res) => {
        resolveSession = res;
      })
    );

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: null,
        initialSessionName: undefined,
        currentUserId: USER_ID,
      })
    );

    expect(result.current.activeSessionId).toBeNull();

    const session: LeaderboardSessionOption = {
      id: "sess-new",
      name: "New Session",
      created_at: "2026-05-01T00:00:00Z",
      is_active: true,
    };

    await act(async () => {
      result.current.handleSessionPick(session);
    });

    // State updates that happen synchronously in the handler are applied by act
    expect(result.current.activeSessionId).toBe("sess-new");
    expect(result.current.activeSessionName).toBe("New Session");
    // Rows were cleared synchronously in handleSessionPick
    expect(result.current.sessionRows).toHaveLength(0);

    // Unblock the pending fetch to avoid unhandled promise warnings
    resolveSession({ success: true, rows: [] });
  });

  // ── LB-6 ──────────────────────────────────────────────────
  it("LB-6: handleClearSession resets activeSessionId to null", async () => {
    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));
    expect(result.current.activeSessionId).toBe(SESSION_ID);

    await act(async () => {
      result.current.handleClearSession();
    });

    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.activeSessionName).toBeUndefined();
    expect(result.current.sessionRows).toHaveLength(0);
  });

  // ── LB-7 ──────────────────────────────────────────────────
  it("LB-7: handleRefresh re-fetches the session leaderboard (call count increases)", async () => {
    mockGetSessionLeaderboard.mockResolvedValue({ success: true, rows: [myRow] });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));

    const callCountAfterMount = mockGetSessionLeaderboard.mock.calls.length;
    expect(callCountAfterMount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      result.current.handleRefresh();
    });

    await waitFor(() =>
      expect(mockGetSessionLeaderboard.mock.calls.length).toBeGreaterThan(callCountAfterMount)
    );
  });

  // ── LB-8 ──────────────────────────────────────────────────
  it("LB-8: error state is set when getSessionLeaderboard returns an error", async () => {
    mockGetSessionLeaderboard.mockResolvedValue({
      success: false,
      error: "Failed to fetch leaderboard",
    });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));

    expect(result.current.error).toBe("Failed to fetch leaderboard");
    expect(result.current.sessionRows).toHaveLength(0);
  });

  // ── LB-new-1 ──────────────────────────────────────────────
  it("LB-new-1: error state set when getAllTimeLeaderboard returns an error (line 180)", async () => {
    // Switch to alltime tab and trigger an error from getAllTimeLeaderboard.
    mockGetAllTimeLeaderboard.mockResolvedValue({
      success: false,
      error: "All-time fetch failed",
    });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: null,
        initialSessionName: undefined,
        currentUserId: USER_ID,
      })
    );

    // Switch to all-time tab to trigger the lazy fetch
    await act(async () => {
      result.current.setScopeTab("alltime");
    });

    await waitFor(() => expect(result.current.alltimeLoading).toBe(false));

    expect(result.current.error).toBe("All-time fetch failed");
    expect(result.current.alltimeRows).toHaveLength(0);
  });

  // ── LB-new-2 ──────────────────────────────────────────────
  it("LB-new-2: handleRefresh on alltime scope tab calls fetchAllTime (line 276)", async () => {
    mockGetAllTimeLeaderboard.mockResolvedValue({ success: true, rows: [otherRow] });

    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: null,
        initialSessionName: undefined,
        currentUserId: USER_ID,
      })
    );

    // Switch to all-time tab
    await act(async () => {
      result.current.setScopeTab("alltime");
    });
    await waitFor(() => expect(result.current.alltimeLoading).toBe(false));

    const callCountBefore = mockGetAllTimeLeaderboard.mock.calls.length;

    await act(async () => {
      result.current.handleRefresh();
    });

    await waitFor(() =>
      expect(mockGetAllTimeLeaderboard.mock.calls.length).toBeGreaterThan(callCountBefore)
    );
  });

  // ── LB-new-3 ──────────────────────────────────────────────
  it("LB-new-3: realtime subscription cleanup fires on unmount (lines 218-219)", async () => {
    // subscribeToMatches returns an unsubscribe fn; realtimeCallback is captured.
    // When the hook unmounts, the cleanup function in the useEffect should call
    // unsubscribe (setting realtimeCallback = null) and clear any pending debounce.

    const { result, unmount } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    await waitFor(() => expect(result.current.sessionLoading).toBe(false));

    // Subscription is active
    expect(realtimeCallback).not.toBeNull();

    // Unmount → cleanup runs → unsubscribe called → realtimeCallback = null
    unmount();

    expect(realtimeCallback).toBeNull();
  });

  // ── LB-bonus: minGP constants ──────────────────────────────
  it("minGP is MIN_SESSION_GP on session tab and MIN_ALLTIME_GP on alltime tab", async () => {
    const { result } = renderHook(() =>
      useLeaderboard({
        initialSessionId: SESSION_ID,
        initialSessionName: SESSION_NAME,
        currentUserId: USER_ID,
      })
    );

    expect(result.current.minGP).toBe(MIN_SESSION_GP);
    expect(MIN_SESSION_GP).toBe(1);

    await act(async () => {
      result.current.setScopeTab("alltime");
    });

    expect(result.current.minGP).toBe(MIN_ALLTIME_GP);
    expect(MIN_ALLTIME_GP).toBe(10);
  });
});
