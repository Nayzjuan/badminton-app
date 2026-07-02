// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useQueue Hook
// ============================================================
// Tests queue fetching, position computation, and action wiring
// without a real Supabase connection or server.
//
//   Q-1   starts in loading=true state
//   Q-2   empty queue after fetch → queue=[], myEntry=null, loading=false
//   Q-3   player in queue → myEntry populated
//   Q-4   myPosition = 1-based rank among "waiting" entries only
//   Q-5   myPosition is null when player status is "on_deck"
//   Q-6   myPosition is null when player status is "drafted"
//   Q-7   realtime event triggers re-fetch and updates queue
//   Q-8   joinQueue calls joinQueueAction with sessionId
//   Q-9   leaveQueue succeeds and returns {}
//   Q-10  leaveQueue propagates error when update returns an error
//
// Strategy: mock @/utils/supabase/client, @/lib/realtime, and
// @/app/actions/queue so the hook runs against fully in-memory stubs.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useQueue } from "@/hooks/use-queue";
import type { QueueEntry } from "@/types/database";

// ── Constants ─────────────────────────────────────────────────

const SESSION_ID = "sess-queue-111";
const PLAYER_ID = "player-me";

// ── Fixture factory ───────────────────────────────────────────

function makeEntry(
  playerId: string,
  status: QueueEntry["status"] = "waiting",
  gamesPlayed = 0
): QueueEntry {
  return {
    id: `qe-${playerId}`,
    session_id: SESSION_ID,
    player_id: playerId,
    status,
    games_played: gamesPlayed,
    joined_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    position: 1,
    is_paused: false,
    created_at: new Date().toISOString(),
  };
}

// ── Mock Supabase client ──────────────────────────────────────

let mockQueueRows: QueueEntry[] = [];

function buildMockClient() {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          in: () => chain,
          or: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (onFulfilled: (v: unknown) => unknown) =>
            Promise.resolve({ data: mockQueueRows, error: null }).then(onFulfilled),
        };
        return chain;
      },
    }),
  };
}

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => buildMockClient(),
}));

// ── Mock realtime ─────────────────────────────────────────────

let queueCallback: (() => void) | null = null;

vi.mock("@/lib/realtime", () => ({
  subscribeToQueue: (_client: unknown, _sessionId: string, cb: () => void) => {
    queueCallback = cb;
    return () => {
      queueCallback = null;
    };
  },
}));

// ── Mock queue actions ────────────────────────────────────────
// leaveQueue delegates to checkoutPlayer (server action) for the atomic
// checkout_player_cleanup_drafts RPC — it does NOT call supabase directly.

const mockJoinQueueAction = vi.fn().mockResolvedValue({});
const mockCheckoutPlayer = vi.fn().mockResolvedValue({});

vi.mock("@/app/actions/queue", () => ({
  joinQueueAction: (...args: unknown[]) => mockJoinQueueAction(...args),
  checkoutPlayer: (...args: unknown[]) => mockCheckoutPlayer(...args),
}));

// useQueue now calls useRouter() (to route flagged duplicates to /rename) and
// usePathname() (to build the /rename ?next= from the current path, not a
// hardcoded /play/[id]).
const mockRouterPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, refresh: vi.fn() }),
  usePathname: () => `/play/test-session`,
}));

// ── Tests ─────────────────────────────────────────────────────

describe("useQueue — Unit Suite", () => {
  beforeEach(() => {
    mockQueueRows = [];
    queueCallback = null;
    mockJoinQueueAction.mockResolvedValue({});
    mockCheckoutPlayer.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Q-1 ────────────────────────────────────────────────────
  it("Q-1: starts in loading=true state", () => {
    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    expect(result.current.loading).toBe(true);
    expect(result.current.queue).toEqual([]);
    expect(result.current.myEntry).toBeNull();
  });

  // ── Q-2 ────────────────────────────────────────────────────
  it("Q-2: empty queue after fetch → queue=[], myEntry=null, loading=false", async () => {
    mockQueueRows = [];

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.queue).toEqual([]);
    expect(result.current.myEntry).toBeNull();
  });

  // ── Q-3 ────────────────────────────────────────────────────
  it("Q-3: player in queue → myEntry populated", async () => {
    const entry = makeEntry(PLAYER_ID, "waiting");
    mockQueueRows = [entry];

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.myEntry).not.toBeNull();
    expect(result.current.myEntry?.player_id).toBe(PLAYER_ID);
  });

  // ── Q-4 ────────────────────────────────────────────────────
  it("Q-4: myPosition = 1-based rank among 'waiting' entries only", async () => {
    // Three waiting entries; PLAYER_ID is the second waiting player (after p1).
    const p1 = makeEntry("player-p1", "waiting", 0);
    const me = makeEntry(PLAYER_ID, "waiting", 0);
    const p2 = makeEntry("player-p2", "waiting", 0);
    // One on_deck entry — must NOT count toward position.
    const ondeck = makeEntry("player-od", "on_deck", 1);

    // The hook preserves array order for position calc; put me at index 1.
    mockQueueRows = [p1, me, p2, ondeck];

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    // p1 is #1 waiting, me is #2 waiting.
    expect(result.current.myPosition).toBe(2);
  });

  // ── Q-5 ────────────────────────────────────────────────────
  it("Q-5: myPosition is null when player status is 'on_deck'", async () => {
    const entry = makeEntry(PLAYER_ID, "on_deck");
    mockQueueRows = [entry];

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.myPosition).toBeNull();
  });

  // ── Q-6 ────────────────────────────────────────────────────
  it("Q-6: myPosition is null when player status is 'drafted'", async () => {
    const entry = makeEntry(PLAYER_ID, "drafted");
    mockQueueRows = [entry];

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.myPosition).toBeNull();
  });

  // ── Q-7 ────────────────────────────────────────────────────
  it("Q-7: realtime event triggers re-fetch and updates queue", async () => {
    // Initial state: player is in queue.
    const entry = makeEntry(PLAYER_ID, "waiting");
    mockQueueRows = [entry];

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.myEntry).not.toBeNull();

    // Simulate queue being cleared server-side then a realtime event arrives.
    mockQueueRows = [];
    act(() => {
      queueCallback?.();
    });

    await waitFor(() => expect(result.current.myEntry).toBeNull());
    expect(result.current.queue).toEqual([]);
  });

  // ── Q-8 ────────────────────────────────────────────────────
  it("Q-8: joinQueue calls joinQueueAction with sessionId", async () => {
    mockQueueRows = [];
    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.joinQueue();
    });

    expect(mockJoinQueueAction).toHaveBeenCalledWith(SESSION_ID);
  });

  // ── Q-9 ────────────────────────────────────────────────────
  // leaveQueue delegates to checkoutPlayer (server action) which runs the
  // atomic checkout_player_cleanup_drafts RPC — no direct supabase call.
  it("Q-9: leaveQueue calls checkoutPlayer and returns {} on success", async () => {
    mockQueueRows = [makeEntry(PLAYER_ID, "waiting")];
    mockCheckoutPlayer.mockResolvedValue({});

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let leaveResult!: { error?: string };
    await act(async () => {
      leaveResult = await result.current.leaveQueue();
    });

    expect(mockCheckoutPlayer).toHaveBeenCalledWith(SESSION_ID);
    expect(leaveResult).toEqual({});
  });

  // ── Q-new-1 ────────────────────────────────────────────────
  it("Q-new-1: fetchQueue with null data (DB error) → queue stays empty, loading false (line 51 false-branch)", async () => {
    // When Supabase returns { data: null } (e.g. RLS block or network error),
    // `if (data) setQueue(data)` is false → queue stays [] → loading set to false.
    mockQueueRows = null as unknown as typeof mockQueueRows;

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    // setQueue was never called — queue stays at the initial empty array
    expect(result.current.queue).toEqual([]);
    expect(result.current.myEntry).toBeNull();
  });

  // ── Q-new-2 ────────────────────────────────────────────────
  it("Q-new-2: realtime subscription is cleaned up on unmount", async () => {
    // Verifies the return cleanup of the useEffect wires and unwires the
    // realtime subscription correctly — queueCallback = null after unmount.
    mockQueueRows = [];

    const { unmount } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(queueCallback).not.toBeNull());

    unmount();

    expect(queueCallback).toBeNull();
  });

  // ── Q-10 ───────────────────────────────────────────────────
  it("Q-10: leaveQueue propagates error when checkoutPlayer returns error", async () => {
    mockQueueRows = [makeEntry(PLAYER_ID, "waiting")];
    mockCheckoutPlayer.mockResolvedValue({ error: "RLS policy violation" });

    const { result } = renderHook(() => useQueue(SESSION_ID, PLAYER_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let leaveResult!: { error?: string };
    await act(async () => {
      leaveResult = await result.current.leaveQueue();
    });

    expect(leaveResult.error).toBe("RLS policy violation");
  });
});
