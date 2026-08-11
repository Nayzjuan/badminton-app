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
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));
// after() (used for fire-and-forget push) runs synchronously in tests.
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => cb(),
}));
// Push delivery is out of scope here — stub it so the after() callback no-ops.
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
// createManualMatchAction now runs isSessionActive() after the organizer gate
// (the post-close write guard). Left real it would read sessions.is_active off
// the table-addressed service mock below, whose "sessions" row answers the
// organizer check and carries no is_active — every case would fail as "This
// session has ended." Only that export is replaced; isSessionOrganizer,
// getAuthenticatedUser and getActorContext stay real.
vi.mock("@/app/actions/_shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/actions/_shared")>()),
  isSessionActive: vi.fn(async () => true),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isSessionActive } from "@/app/actions/_shared";
import { createManualMatchAction } from "@/app/actions/match-lifecycle";

// ─────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────

type MockResponse = {
  data?: unknown;
  error?: { message: string } | null;
};

/**
 * Generic chainable builder — awaitable, supports .single() and .maybeSingle().
 * All query chain methods return `this` so the full chain resolves.
 */
function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);
  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);
  b["single"] = () => Promise.resolve(response);
  b["maybeSingle"] = () => Promise.resolve(response);
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
 * Service client mock that captures rpc() calls so tests can assert
 * on the arguments passed to create_match_with_players.
 *
 * createManualMatchAction now routes match creation through the
 * create_match_with_players RPC (atomic, TOCTOU-safe) rather than
 * a direct from("matches").insert(). The p_origin argument is what
 * we verify to confirm "manual" vs "auto".
 *
 * isSessionOrganizer (called internally) also uses createServiceClient()
 * and calls .maybeSingle() on the sessions table — wire that up too.
 */
function makeCapturingServiceClient(rpcResponse: MockResponse) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return Promise.resolve(rpcResponse);
  });

  // Route from() calls by table name:
  //   "sessions"      → isSessionOrganizer ownership check → { created_by: USER_ID }
  //   "queue_entries" → player-in-queue validation → all PLAYER_IDS found
  //   "profiles"      → skill-level fetch for is_mixed_level → all same level
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
    if (table === "profiles") {
      return makeBuilder({
        data: PLAYER_IDS.map((id) => ({ id, skill_level: "intermediate" })),
        error: null,
      });
    }
    return makeBuilder({ data: null, error: null });
  });

  return { svcClient: { from, rpc }, rpcCalls };
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
   * Build mock clients for the refactored createManualMatchAction.
   *
   * The action now uses the atomic create_match_with_players RPC via
   * getServiceClient() rather than a direct from("matches").insert().
   * isSessionOrganizer() also uses createServiceClient() internally.
   *
   * Both calls to createServiceClient() return the same mock (vi.mocked
   * mockReturnValue applies to all calls), so the service mock handles:
   *   1. isSessionOrganizer: from("sessions").maybeSingle()
   *   2. Player validation: from("queue_entries").in()
   *   3. Mixed-level check: from("profiles").in()
   *   4. Match creation:   rpc("create_match_with_players", { p_origin: "manual", ... })
   *
   * The user client (createServerSupabaseClient) handles: auth.getUser() only.
   */
  function makeMockForManualMatch(rpcResponse: MockResponse) {
    const { svcClient, rpcCalls } = makeCapturingServiceClient(rpcResponse);
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: USER_ID } },
          error: null,
        }),
      },
      from: vi.fn(), // user client's from() is not called by createManualMatchAction
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mockClient as never);

    return { mockClient, rpcCalls };
  }

  it("inserts the match row with origin: 'manual'", async () => {
    const { rpcCalls } = makeMockForManualMatch({
      data: "match-abc",
      error: null,
    });

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("create_match_with_players");
    expect(rpcCalls[0].args).toMatchObject({ p_origin: "manual" });
  });

  it("does NOT insert with origin: 'auto' or origin: 'modified'", async () => {
    const { rpcCalls } = makeMockForManualMatch({ data: "match-abc", error: null });

    await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0].args;
    expect(args.p_origin).toBe("manual");
    expect(args.p_origin).not.toBe("auto");
    expect(args.p_origin).not.toBe("modified");
  });

  it("returns early without touching the RPC when a player is not in the queue", async () => {
    // queue_entries only returns 3 of the 4 players → missingPlayers guard fires
    const { svcClient, rpcCalls } = makeCapturingServiceClient({ data: "match-abc", error: null });
    // Override queue_entries to return only 3 players
    vi.mocked(svcClient.from).mockImplementation((table: string) => {
      if (table === "sessions") {
        return makeBuilder({ data: { created_by: USER_ID }, error: null }) as never;
      }
      if (table === "queue_entries") {
        return makeBuilder({
          data: PLAYER_IDS.slice(0, 3).map((id) => ({ player_id: id })),
          error: null,
        }) as never;
      }
      return makeBuilder({ data: null, error: null }) as never;
    });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from: vi.fn(),
    } as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not in this session/i);
    // RPC was never called — guard fired before match creation
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns failure when the RPC returns an error", async () => {
    const { rpcCalls } = makeMockForManualMatch({
      data: null,
      error: { message: "insert failed" },
    });

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toContain("insert failed");
    expect(rpcCalls).toHaveLength(1);
  });

  it("returns failure when the caller is not authenticated", async () => {
    const mockClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
      from: vi.fn(),
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mockClient as never);

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
  // NOTE: The original tests verified that the queue update used the SERVICE
  // client to bypass RLS (the Jackie B / Carlo incident fix). That guard is now
  // enforced at a deeper level: the entire match creation — including queue
  // promotion — is handled atomically inside create_match_with_players RPC,
  // which runs as the service role within Postgres. There is no separate
  // "queue_entries.update" step in TypeScript anymore.
  //
  // These tests have been updated to verify the invariants that the
  // refactored action still guarantees:
  //   1. The action calls the RPC via the service client (not the user client).
  //   2. The RPC payload includes all 4 player IDs split into teamA / teamB.
  //   3. When the RPC fails, success=false and the action does not retry.

  it("uses the SERVICE client (RPC) for match creation — not direct table inserts", async () => {
    const { svcClient, rpcCalls } = makeCapturingServiceClient({ data: "match-xyz", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from: vi.fn(),
    } as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    // RPC must have been called via the service client
    expect(svcClient.rpc).toHaveBeenCalledWith("create_match_with_players", expect.any(Object));
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({ p_is_published: true });
  });

  it("sets ALL 4 player IDs in the RPC payload — not a subset", async () => {
    const { svcClient, rpcCalls } = makeCapturingServiceClient({ data: "match-xyz", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from: vi.fn(),
    } as never);

    await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0].args;
    // All 4 player IDs must appear across both team arrays
    const allIds = [...(args.p_team_a_ids as string[]), ...(args.p_team_b_ids as string[])];
    expect(allIds).toHaveLength(4);
    expect(allIds).toEqual(expect.arrayContaining([...TEAM_A, ...TEAM_B]));
  });

  it("does NOT call the RPC when the player-validation guard fires", async () => {
    // missingPlayers guard fires before the RPC — partial state impossible.
    const { svcClient, rpcCalls } = makeCapturingServiceClient({ data: "match-xyz", error: null });
    vi.mocked(svcClient.from).mockImplementation((table: string) => {
      if (table === "sessions")
        return makeBuilder({ data: { created_by: USER_ID }, error: null }) as never;
      if (table === "queue_entries")
        // Only 3 of 4 players found
        return makeBuilder({
          data: PLAYER_IDS.slice(0, 3).map((id) => ({ player_id: id })),
          error: null,
        }) as never;
      return makeBuilder({ data: null, error: null }) as never;
    });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from: vi.fn(),
    } as never);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("does NOT call the RPC once the session is closed (post-close write guard)", async () => {
    const { svcClient, rpcCalls } = makeCapturingServiceClient({ data: "match-xyz", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      },
      from: vi.fn(),
    } as never);
    vi.mocked(isSessionActive).mockResolvedValueOnce(false);

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/session has ended/i);
    expect(rpcCalls).toHaveLength(0);
  });
});
