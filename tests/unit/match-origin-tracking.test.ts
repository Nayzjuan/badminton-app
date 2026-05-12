// ============================================================
// Unit Tests: Match Origin Tracking
// ============================================================
//
// Verifies the two creation paths stamp the correct origin:
//
//   createManualMatchAction
//     → inserts matches row with origin: "manual"
//
//   create_match_with_players RPC (engine path)
//     → covered in matchmaking-engine.test.ts; p_origin: "auto"
//        assertion is co-located there (see "handles RPC failure" test).
//
// Sticky-rule coverage (auto→modified, manual→manual) lives in the
// Postgres RPCs (swap_player_in_match, swap_match_players).  Those
// code paths are tested by the Scenario A E2E spec which exercises
// live swaps against a real DB.  The logic is also proven in the
// migration SQL via WHERE origin = 'auto' guard — the unit layer
// here focuses on what TypeScript code is responsible for: stamping
// the correct value at insert time.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoist mocks before any imports ────────────────────────────
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { createManualMatchAction } from "@/app/actions/match";

// ─────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────

type MockResponse = {
  data?: unknown;
  error?: { message: string } | null;
};

/**
 * Generic chainable builder — awaitable, supports .single().
 * All query chain methods return `this` so the full chain resolves.
 */
function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);
  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);
  b["single"] = () => Promise.resolve(response);
  for (const method of [
    "select",
    "eq",
    "neq",
    "in",
    "or",
    "order",
    "limit",
    "update",
    "delete",
    "insert",
  ]) {
    b[method] = (..._args: unknown[]) => b;
  }
  return b;
}

/**
 * Argument-capturing builder for `.insert()` calls.
 * Useful when a test needs to assert what payload was passed to insert.
 */
function makeCapturingBuilder(response: MockResponse) {
  const insertCalls: unknown[] = [];
  const b: Record<string, unknown> = {};
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);
  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);
  b["single"] = () => Promise.resolve(response);
  for (const method of [
    "select",
    "eq",
    "neq",
    "in",
    "or",
    "order",
    "limit",
    "update",
    "delete",
    "insert",
  ]) {
    b[method] = (..._args: unknown[]) => b;
  }
  // Override insert to capture arguments for assertions
  b["insert"] = (args: unknown) => {
    insertCalls.push(args);
    return b;
  };
  return { builder: b, insertCalls };
}

// ── Test fixture UUIDs ─────────────────────────────────────────
const SESSION_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000020";
const PLAYER_IDS = [
  "00000000-0000-4000-8000-000000000031",
  "00000000-0000-4000-8000-000000000032",
  "00000000-0000-4000-8000-000000000033",
  "00000000-0000-4000-8000-000000000034",
];
const TEAM_A = [PLAYER_IDS[0], PLAYER_IDS[1]];
const TEAM_B = [PLAYER_IDS[2], PLAYER_IDS[3]];

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// createManualMatchAction — origin: "manual"
// ─────────────────────────────────────────────────────────────

describe("createManualMatchAction — match origin", () => {
  /**
   * Build a mock client that routes each from() call to the correct
   * response.  The matches builder is argument-capturing so we can
   * assert the exact insert payload.
   */
  function makeMockForManualMatch(matchInsertResponse: MockResponse) {
    const { builder: matchBuilder, insertCalls: matchInsertCalls } =
      makeCapturingBuilder(matchInsertResponse);

    const from = vi.fn((table: string) => {
      switch (table) {
        // isSessionOrganizer: sessions fast path → created_by matches USER_ID
        case "sessions":
          return makeBuilder({ data: { created_by: USER_ID }, error: null });

        // createManualMatchAction: validate players are in queue
        case "queue_entries":
          return makeBuilder({
            data: PLAYER_IDS.map((id) => ({ player_id: id })),
            error: null,
          });

        // createManualMatchAction: match row insert — we want to inspect this
        case "matches":
          return matchBuilder;

        // createManualMatchAction: match_players insert
        case "match_players":
          return makeBuilder({ data: [], error: null });

        default:
          return makeBuilder({ data: null, error: null });
      }
    });

    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: USER_ID } },
          error: null,
        }),
      },
      from,
    };

    // Step 3 of createManualMatchAction now uses getServiceClient() to bypass
    // RLS on the queue_entries update. Wire up a no-op service client so these
    // origin-focused tests don't crash on the service client call.
    const svcFrom = vi.fn(() => makeBuilder({ data: null, error: null }));
    vi.mocked(createServiceClient).mockReturnValue({ from: svcFrom } as never);

    return { mockClient, matchInsertCalls };
  }

  it("inserts the match row with origin: 'manual'", async () => {
    const { mockClient, matchInsertCalls } = makeMockForManualMatch({
      data: {
        id: "match-abc",
        session_id: SESSION_ID,
        status: "pending",
        origin: "manual",
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(mockClient as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    expect(matchInsertCalls).toHaveLength(1);
    expect(matchInsertCalls[0]).toEqual(expect.objectContaining({ origin: "manual" }));
  });

  it("does NOT insert with origin: 'auto' or origin: 'modified'", async () => {
    const { mockClient, matchInsertCalls } = makeMockForManualMatch({
      data: { id: "match-abc", session_id: SESSION_ID, status: "pending", origin: "manual" },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(mockClient as never);

    await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(matchInsertCalls).toHaveLength(1);
    const payload = matchInsertCalls[0] as Record<string, unknown>;
    expect(payload.origin).toBe("manual");
    expect(payload.origin).not.toBe("auto");
    expect(payload.origin).not.toBe("modified");
  });

  it("returns early without touching matches when a player is not in the queue", async () => {
    // queue_entries only returns 3 of the 4 players → missingPlayers guard fires
    const from = vi.fn((table: string) => {
      if (table === "sessions") {
        return makeBuilder({ data: { created_by: USER_ID }, error: null });
      }
      if (table === "queue_entries") {
        // Only 3 players found — one is missing
        return makeBuilder({
          data: PLAYER_IDS.slice(0, 3).map((id) => ({ player_id: id })),
          error: null,
        });
      }
      return makeBuilder({ data: null, error: null });
    });

    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from,
    };
    vi.mocked(createClient).mockResolvedValue(mockClient as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not in this session/i);
    // matches table was never written
    const matchesCalls = (from.mock.calls as string[][]).filter(([t]) => t === "matches");
    expect(matchesCalls).toHaveLength(0);
  });

  it("returns failure when the match insert fails (DB error)", async () => {
    const from = vi.fn((table: string) => {
      if (table === "sessions") {
        return makeBuilder({ data: { created_by: USER_ID }, error: null });
      }
      if (table === "queue_entries") {
        return makeBuilder({
          data: PLAYER_IDS.map((id) => ({ player_id: id })),
          error: null,
        });
      }
      if (table === "matches") {
        // Insert fails
        return makeBuilder({ data: null, error: { message: "insert failed" } });
      }
      return makeBuilder({ data: null, error: null });
    });

    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from,
    };
    vi.mocked(createClient).mockResolvedValue(mockClient as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toContain("insert failed");
  });

  it("returns failure when the caller is not authenticated", async () => {
    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
      from: vi.fn(),
    };
    vi.mocked(createClient).mockResolvedValue(mockClient as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authenticated/i);
    // No DB tables queried after the auth check
    expect(mockClient.from).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// createManualMatchAction — queue status side-effect (regression)
// ─────────────────────────────────────────────────────────────
// This describe block was added after a production incident where
// Jackie B and Carlo were simultaneously 'waiting' in the queue
// and assigned to an active match.
//
// Root cause: step 3 used the user-scoped Supabase client for the
// queue_entries update. RLS only allows players to write their own
// row, so the bulk update silently no-oped for players the organizer
// doesn't own.
//
// Fix: step 3 must use getServiceClient() (bypasses RLS), matching
// the same pattern as endMatchAction and cancelMatchAction.
//
// These tests verify two things:
//   1. The on_deck update is made via the SERVICE client, not the
//      user client — so it can never be silently RLS-blocked.
//   2. The update targets ALL 4 player IDs (all of teamA + teamB).
// ─────────────────────────────────────────────────────────────

describe("createManualMatchAction — queue status side-effect", () => {
  /**
   * Build a spy-capable service client mock that captures every
   * queue_entries update call so we can assert the right payload
   * was sent through the right client.
   */
  function makeServiceClientMock() {
    const updateCalls: Array<{
      filter: Record<string, unknown>;
      payload: Record<string, unknown>;
    }> = [];

    // The service client builder records every .update() payload and
    // the subsequent filter chain so the test can assert on both.
    function makeServiceBuilder(tableName: string) {
      const filterState: Record<string, unknown> = {};
      let pendingPayload: Record<string, unknown> = {};

      const b: Record<string, unknown> = {};
      b["then"] = (
        onFulfilled: (v: MockResponse) => unknown,
        onRejected: (e: unknown) => unknown
      ) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      b["catch"] = (onRejected: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).catch(onRejected);
      b["single"] = () => Promise.resolve({ data: null, error: null });

      b["update"] = (payload: Record<string, unknown>) => {
        pendingPayload = payload;
        return b;
      };
      b["eq"] = (col: string, val: unknown) => {
        filterState[col] = val;
        return b;
      };
      b["in"] = (col: string, vals: unknown) => {
        filterState[col] = vals;
        // Flush the captured call when .in() resolves the chain
        // (it's always the last filter in the queue update).
        if (tableName === "queue_entries" && pendingPayload.status) {
          updateCalls.push({ filter: { ...filterState }, payload: { ...pendingPayload } });
        }
        return b;
      };
      b["neq"] = (..._args: unknown[]) => b;
      b["select"] = (..._args: unknown[]) => b;
      b["insert"] = (..._args: unknown[]) => b;
      b["delete"] = (..._args: unknown[]) => b;
      b["order"] = (..._args: unknown[]) => b;
      b["limit"] = (..._args: unknown[]) => b;
      return b;
    }

    const svcFrom = vi.fn((table: string) => makeServiceBuilder(table));
    const svcClient = { from: svcFrom };

    return { svcClient, updateCalls };
  }

  function makeUserClientForQueueTest() {
    const from = vi.fn((table: string) => {
      switch (table) {
        case "sessions":
          return makeBuilder({ data: { created_by: USER_ID }, error: null });
        case "queue_entries":
          return makeBuilder({
            data: PLAYER_IDS.map((id) => ({ player_id: id })),
            error: null,
          });
        case "matches":
          return makeBuilder({
            data: { id: "match-xyz", session_id: SESSION_ID, status: "pending", origin: "manual" },
            error: null,
          });
        case "match_players":
          return makeBuilder({ data: [], error: null });
        default:
          return makeBuilder({ data: null, error: null });
      }
    });

    return {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from,
    };
  }

  it("uses the SERVICE client (not the user client) for the on_deck queue update", async () => {
    // This test would have FAILED before the fix — the old code only
    // called createClient() and never touched createServiceClient().
    const { svcClient, updateCalls } = makeServiceClientMock();
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createClient).mockResolvedValue(makeUserClientForQueueTest() as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    // The service client's queue_entries.update() must have been called at least once.
    expect(svcClient.from).toHaveBeenCalledWith("queue_entries");
    // And it must have carried the on_deck status payload.
    const onDeckCall = updateCalls.find((c) => c.payload.status === "on_deck");
    expect(onDeckCall).toBeDefined();
  });

  it("sets ALL 4 player IDs to on_deck — not a subset", async () => {
    // Before the fix, RLS silently blocked the update for players the
    // organizer doesn't own, leaving 1–3 of 4 players still 'waiting'.
    // This test asserts the payload always includes every player.
    const { svcClient, updateCalls } = makeServiceClientMock();
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createClient).mockResolvedValue(makeUserClientForQueueTest() as never);

    await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    const onDeckCall = updateCalls.find((c) => c.payload.status === "on_deck");
    expect(onDeckCall).toBeDefined();

    // The .in() filter must target all 4 player IDs.
    const targetedIds = onDeckCall!.filter["player_id"] as string[];
    expect(targetedIds).toHaveLength(4);
    expect(targetedIds).toEqual(expect.arrayContaining([...TEAM_A, ...TEAM_B]));
  });

  it("does NOT call the service client when match creation fails", async () => {
    // If step 1 (match insert) fails, step 3 must never run — no partial state.
    const { svcClient } = makeServiceClientMock();
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const from = vi.fn((table: string) => {
      if (table === "sessions") return makeBuilder({ data: { created_by: USER_ID }, error: null });
      if (table === "queue_entries")
        return makeBuilder({ data: PLAYER_IDS.map((id) => ({ player_id: id })), error: null });
      if (table === "matches")
        return makeBuilder({ data: null, error: { message: "insert failed" } });
      return makeBuilder({ data: null, error: null });
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from,
    } as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    // Service client queue update must NOT have been called — match never existed.
    expect(svcClient.from).not.toHaveBeenCalledWith("queue_entries");
  });
});
