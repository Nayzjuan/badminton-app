// ============================================================
// Unit Tests: fixPlayerRecord — Historical Roster Correction
// ============================================================
//
// Covers the server action at src/app/actions/fix-player-record.ts.
//
// The action implements 5 sequential guard layers:
//   1. UUID validation — all 4 IDs (matchId, out, in, session)
//   2. Self-swap guard — outPlayerId === inPlayerId
//   3. Auth guard — requires authenticated user
//   4. Organizer guard — caller must be session organizer
//   5. Match status — must be "completed"
//   6. in_player eligibility — either team flip OR has a completed
//      match elsewhere in the session
//
// Then writes via the fix_record_swap_player Postgres RPC and maps
// DB-level exception strings to typed FixRecordErrorCodes.
//
// Mock strategy:
//   createServerSupabaseClient → auth.getUser() (for getAuthenticatedUser)
//   createServiceClient        → all DB reads + rpc() call
//   Both mocks return the same client instance for isSessionOrganizer
//   AND the action's internal `db` client.
//
// Test IDs: FRA = Fix Record Action
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { fixPlayerRecord } from "@/app/actions/fix-player-record";

// ── Fixture UUIDs ──────────────────────────────────────────────
// All pass isValidUUID — format: 00000000-0000-4000-8000-XXXXXXXXXXXX

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000002";
const OUT_PLAYER = "00000000-0000-4000-8000-000000000003";
const IN_PLAYER = "00000000-0000-4000-8000-000000000004";
const USER_ID = "00000000-0000-4000-8000-000000000005";
const OTHER_MATCH = "00000000-0000-4000-8000-000000000006";

// ── Mock builder ───────────────────────────────────────────────
// Minimal chainable Supabase query builder.

type MockResponse = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
};

function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);
  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);
  b["maybeSingle"] = () => Promise.resolve(response);
  b["single"] = () => Promise.resolve(response);
  for (const m of [
    "select",
    "eq",
    "neq",
    "in",
    "or",
    "order",
    "limit",
    "update",
    "insert",
    "upsert",
    "delete",
  ]) {
    b[m] = (..._args: unknown[]) => b;
  }
  return b;
}

// ── Mock client builders ───────────────────────────────────────

/**
 * Auth client — wraps auth.getUser() response.
 * Pass null as userId to simulate unauthenticated.
 */
function makeAuthClient(userId: string | null) {
  return {
    from: vi.fn(), // not used by getAuthenticatedUser
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
  };
}

/**
 * Service client factory used by both isSessionOrganizer and the
 * action's internal `db`. Routes from() calls by table name with
 * sequential tracking for tables that are called multiple times.
 *
 * from("sessions") is called TWICE in the happy path:
 *   call 0 — isSessionOrganizer fast-path (reads created_by)
 *   call 1 — post-RPC is_active check for Session Wrapped recompute
 *
 * rpc() is called by name:
 *   "fix_record_swap_player"  — cfg.rpc (defaults to success)
 *   "compute_session_wrapped" — cfg.rpcWrapped (defaults to success,
 *                               only invoked when sessionActive = false)
 *
 * @param cfg.organizer     - sessions.created_by; null = not found
 * @param cfg.sessionActive - true (active, skip recompute) | false (closed, run recompute) |
 *                            null (row not found, skip recompute). Default: true.
 * @param cfg.match         - response for from("matches")
 * @param cfg.matchPlayers  - response(s) for from("match_players")
 * @param cfg.rpc           - response for fix_record_swap_player RPC
 * @param cfg.rpcWrapped    - response for compute_session_wrapped RPC
 */
function makeServiceClient(cfg: {
  organizer?: string | null;
  sessionActive?: boolean | null; // true=active, false=closed, null=not found; default true
  match?: MockResponse;
  matchPlayers?: MockResponse | MockResponse[];
  rpc?: MockResponse;
  rpcWrapped?: MockResponse;
}) {
  const sessionsCalls = { count: 0 };
  const matchPlayersCalls = { count: 0 };
  // null → session row not found; false → closed; true/undefined → active
  const sessionAfterRpc: MockResponse =
    cfg.sessionActive === null
      ? { data: null, error: null }
      : { data: { is_active: cfg.sessionActive !== false }, error: null };

  const from = vi.fn((table: string) => {
    if (table === "sessions") {
      const idx = sessionsCalls.count++;
      if (idx === 0) {
        // isSessionOrganizer fast-path — reads created_by
        const createdBy = cfg.organizer === undefined ? USER_ID : cfg.organizer;
        return makeBuilder(
          createdBy ? { data: { created_by: createdBy }, error: null } : { data: null, error: null }
        );
      }
      // Post-RPC is_active check for Session Wrapped recompute
      return makeBuilder(sessionAfterRpc);
    }

    if (table === "session_organizers") {
      // Only reached when sessions fast-path fails. Return no membership.
      return makeBuilder({ data: null, error: null });
    }

    if (table === "matches") {
      return makeBuilder(cfg.match ?? { data: null, error: null });
    }

    if (table === "match_players") {
      const responses = Array.isArray(cfg.matchPlayers)
        ? cfg.matchPlayers
        : [cfg.matchPlayers ?? { data: null, error: null }];
      const idx = matchPlayersCalls.count++;
      return makeBuilder(responses[idx] ?? { data: null, error: null });
    }

    return makeBuilder({ data: null, error: null });
  });

  const rpc = vi.fn((name: string, _args: unknown) => {
    if (name === "compute_session_wrapped") {
      return Promise.resolve(cfg.rpcWrapped ?? { data: null, error: null });
    }
    // fix_record_swap_player (and any other RPC)
    return Promise.resolve(cfg.rpc ?? { data: null, error: null });
  });

  return { from, rpc };
}

/** Wires both Supabase client mocks and calls fixPlayerRecord. */
async function runAction(
  opts: Parameters<typeof makeServiceClient>[0] & { userId?: string | null }
) {
  const { userId = USER_ID, ...svcOpts } = opts;
  vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(userId) as never);
  vi.mocked(createServiceClient).mockReturnValue(makeServiceClient(svcOpts) as never);
  return fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);
}

/** Completed match row returned by from("matches"). */
const COMPLETED_MATCH_ROW = {
  id: MATCH_ID,
  status: "completed",
  session_id: SESSION_ID,
};

/**
 * Full happy-path config: organizer fast-path, completed match,
 * in_player NOT currently in this match, but has a completed match
 * elsewhere in the session (→ full replacement eligible).
 */
const HAPPY_PATH_FULL_REPLACE: Parameters<typeof makeServiceClient>[0] = {
  organizer: USER_ID,
  match: { data: COMPLETED_MATCH_ROW, error: null },
  matchPlayers: [
    { data: null, error: null }, // team-flip check: not in match
    { data: [{ match_id: OTHER_MATCH }], error: null }, // eligibility: has another completed match
  ],
  rpc: { data: null, error: null },
};

const HAPPY_PATH_TEAM_FLIP: Parameters<typeof makeServiceClient>[0] = {
  organizer: USER_ID,
  match: { data: COMPLETED_MATCH_ROW, error: null },
  matchPlayers: [
    { data: { player_id: IN_PLAYER }, error: null }, // team-flip check: IS in match
    // second match_players call is skipped for team flip
  ],
  rpc: { data: null, error: null },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// FRA-1 … FRA-5  Input Validation
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — input validation", () => {
  it("FRA-1: returns failure for a malformed matchId", async () => {
    const result = await fixPlayerRecord("not-a-uuid", OUT_PLAYER, IN_PLAYER, SESSION_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid/i);
  });

  it("FRA-2: returns failure for a malformed outPlayerId", async () => {
    const result = await fixPlayerRecord(MATCH_ID, "bad-id", IN_PLAYER, SESSION_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid/i);
  });

  it("FRA-3: returns failure for a malformed inPlayerId", async () => {
    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, "bad-id", SESSION_ID);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid/i);
  });

  it("FRA-4: returns failure for a malformed sessionId", async () => {
    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, "bad-id");
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid/i);
  });

  it("FRA-5: returns failure when outPlayerId === inPlayerId (self-swap)", async () => {
    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, OUT_PLAYER, SESSION_ID);
    expect(result.success).toBe(false);
    // Guards fire before auth so no Supabase mocks needed here
    expect(result.message).toMatch(/cannot swap/i);
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-6  Auth Guard
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — auth guard", () => {
  it("FRA-6: returns failure when the request is unauthenticated", async () => {
    const result = await runAction({ userId: null });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authenticated/i);
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-7  Organizer Guard
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — organizer guard", () => {
  it("FRA-7: returns failure when the user is not the session organizer", async () => {
    // sessions.created_by = "other-organizer" → fast-path fails
    // session_organizers falls back to null (no membership row)
    const result = await runAction({ organizer: "other-organizer" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authorized/i);
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-8 … FRA-10  Match Status Guard
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — match status guard", () => {
  it("FRA-8: returns MATCH_NOT_COMPLETED when the match row is not found", async () => {
    const result = await runAction({
      organizer: USER_ID,
      match: { data: null, error: null },
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("MATCH_NOT_COMPLETED");
    expect(result.message).toMatch(/not found/i);
  });

  it("FRA-9: returns MATCH_NOT_COMPLETED when the match is not yet completed", async () => {
    const result = await runAction({
      organizer: USER_ID,
      match: { data: { id: MATCH_ID, status: "in_progress", session_id: SESSION_ID }, error: null },
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("MATCH_NOT_COMPLETED");
    expect(result.message).toMatch(/completed/i);
  });

  it("FRA-10: returns failure when the match belongs to a different session", async () => {
    const result = await runAction({
      organizer: USER_ID,
      match: {
        data: {
          id: MATCH_ID,
          status: "completed",
          session_id: "00000000-0000-4000-8000-000000000099",
        },
        error: null,
      },
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/does not belong/i);
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-11 … FRA-13  in_player Eligibility
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — in_player eligibility", () => {
  it("FRA-11: allows a team flip — in_player already in the match does not require another completed game", async () => {
    const result = await runAction(HAPPY_PATH_TEAM_FLIP);
    // Success means it got past eligibility (RPC was called)
    expect(result.success).toBe(true);
  });

  it("FRA-12: allows full replacement when in_player has a completed match elsewhere in the session", async () => {
    const result = await runAction(HAPPY_PATH_FULL_REPLACE);
    expect(result.success).toBe(true);
  });

  it("FRA-13: returns INELIGIBLE_PLAYER when in_player is not in the match and has no other completed match in session", async () => {
    const result = await runAction({
      organizer: USER_ID,
      match: { data: COMPLETED_MATCH_ROW, error: null },
      matchPlayers: [
        { data: null, error: null }, // team-flip: not in match
        { data: [], error: null }, // eligibility: no completed matches in session
      ],
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INELIGIBLE_PLAYER");
    expect(result.message).toMatch(/at least one other completed match/i);
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-14 … FRA-18  RPC Layer
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — RPC layer", () => {
  it("FRA-14: returns { success: true } when the RPC succeeds", async () => {
    const result = await runAction(HAPPY_PATH_FULL_REPLACE);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/corrected/i);
  });

  it("FRA-15: maps MATCH_NOT_COMPLETED RPC exception to the typed error code", async () => {
    const result = await runAction({
      ...HAPPY_PATH_FULL_REPLACE,
      rpc: { data: null, error: { message: "MATCH_NOT_COMPLETED" } },
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("MATCH_NOT_COMPLETED");
  });

  it("FRA-16: maps PLAYER_NOT_IN_MATCH RPC exception to the typed error code", async () => {
    const result = await runAction({
      ...HAPPY_PATH_FULL_REPLACE,
      rpc: { data: null, error: { message: "PLAYER_NOT_IN_MATCH" } },
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("PLAYER_NOT_IN_MATCH");
  });

  it("FRA-17: returns generic failure for an unmapped RPC error", async () => {
    const result = await runAction({
      ...HAPPY_PATH_FULL_REPLACE,
      rpc: { data: null, error: { message: "deadlock detected" } },
    });
    expect(result.success).toBe(false);
    // No typed errorCode for unknown errors
    expect(result.errorCode).toBeUndefined();
    expect(result.message).toContain("deadlock detected");
  });

  it("FRA-18: calls the RPC with the correct four arguments", async () => {
    const svcMock = makeServiceClient(HAPPY_PATH_FULL_REPLACE);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(USER_ID) as never);
    vi.mocked(createServiceClient).mockReturnValue(svcMock as never);

    await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);

    expect(svcMock.rpc).toHaveBeenCalledWith("fix_record_swap_player", {
      p_match_id: MATCH_ID,
      p_out_player_id: OUT_PLAYER,
      p_in_player_id: IN_PLAYER,
      p_session_id: SESSION_ID,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-19  Guard ordering — no DB calls before UUID check
// ─────────────────────────────────────────────────────────────

describe("fixPlayerRecord — guard ordering", () => {
  it("FRA-19: UUID validation fires before any Supabase client is created", async () => {
    // Bad UUID → must fail before auth is checked (no mock needed)
    const mockAuth = makeAuthClient(USER_ID);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mockAuth as never);

    await fixPlayerRecord("not-a-uuid", OUT_PLAYER, IN_PLAYER, SESSION_ID);

    // auth.getUser() must NOT have been called (UUID guard fires first)
    expect(mockAuth.auth.getUser).not.toHaveBeenCalled();
  });

  it("FRA-20: DB calls are not made when the match is not completed", async () => {
    const svcMock = makeServiceClient({
      organizer: USER_ID,
      match: { data: { id: MATCH_ID, status: "in_progress", session_id: SESSION_ID }, error: null },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(USER_ID) as never);
    vi.mocked(createServiceClient).mockReturnValue(svcMock as never);

    await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);

    // from("match_players") must never have been called — status guard fires first
    const matchPlayersCalls = svcMock.from.mock.calls.filter(([t]) => t === "match_players");
    expect(matchPlayersCalls).toHaveLength(0);
    // RPC must not have been called either
    expect(svcMock.rpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// FRA-21 … FRA-25  Session Wrapped recomputation
// ─────────────────────────────────────────────────────────────
// After a successful fix, compute_session_wrapped is re-run if and
// only if the session is already closed (is_active = false). This
// keeps Session Wrapped stats + awards accurate after data corrections.

describe("fixPlayerRecord — Session Wrapped recomputation", () => {
  it("FRA-21: calls compute_session_wrapped when the session is already closed", async () => {
    const svcMock = makeServiceClient({
      ...HAPPY_PATH_FULL_REPLACE,
      sessionActive: false, // session is closed → Wrapped must be recomputed
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(USER_ID) as never);
    vi.mocked(createServiceClient).mockReturnValue(svcMock as never);

    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);

    expect(result.success).toBe(true);
    expect(svcMock.rpc).toHaveBeenCalledWith("compute_session_wrapped", {
      p_session_id: SESSION_ID,
    });
  });

  it("FRA-22: does NOT call compute_session_wrapped when the session is still active", async () => {
    const svcMock = makeServiceClient({
      ...HAPPY_PATH_FULL_REPLACE,
      sessionActive: true, // session is active → Wrapped not yet distributed, no recompute
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(USER_ID) as never);
    vi.mocked(createServiceClient).mockReturnValue(svcMock as never);

    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);

    expect(result.success).toBe(true);
    const wrappedCalls = svcMock.rpc.mock.calls.filter(([n]) => n === "compute_session_wrapped");
    expect(wrappedCalls).toHaveLength(0);
  });

  it("FRA-23: Wrapped recompute failure is non-fatal — fix still returns success", async () => {
    const svcMock = makeServiceClient({
      ...HAPPY_PATH_FULL_REPLACE,
      sessionActive: false,
      rpcWrapped: { data: null, error: { message: "compute_session_wrapped timed out" } },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(USER_ID) as never);
    vi.mocked(createServiceClient).mockReturnValue(svcMock as never);

    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);

    // The roster correction succeeded — the Wrapped failure is just logged
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/corrected/i);
    // compute_session_wrapped was still attempted
    expect(svcMock.rpc).toHaveBeenCalledWith("compute_session_wrapped", {
      p_session_id: SESSION_ID,
    });
  });

  it("FRA-24: session row not found after RPC — skips recompute and still returns success", async () => {
    // Extremely rare edge case: session was deleted between the organizer check and
    // the post-RPC is_active query. The `if (sessionRow && ...)` guard short-circuits
    // safely — no recompute, no error, fix still reports success.
    const result = await runAction({
      ...HAPPY_PATH_FULL_REPLACE,
      sessionActive: null, // null → from("sessions") call 1 returns { data: null }
    });

    expect(result.success).toBe(true);
  });

  it("FRA-25: team flip on a closed session also triggers compute_session_wrapped", async () => {
    // The post-RPC recompute path is identical for both team-flip and full-replacement.
    // This test confirms the branch doesn't accidentally skip the recompute for team flips.
    const svcMock = makeServiceClient({
      ...HAPPY_PATH_TEAM_FLIP,
      sessionActive: false,
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeAuthClient(USER_ID) as never);
    vi.mocked(createServiceClient).mockReturnValue(svcMock as never);

    const result = await fixPlayerRecord(MATCH_ID, OUT_PLAYER, IN_PLAYER, SESSION_ID);

    expect(result.success).toBe(true);
    expect(svcMock.rpc).toHaveBeenCalledWith("compute_session_wrapped", {
      p_session_id: SESSION_ID,
    });
  });
});
