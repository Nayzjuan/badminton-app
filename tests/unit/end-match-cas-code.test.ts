// ============================================================
// endMatchAction — the code returned when complete is refused
// ============================================================
// The status pre-check and the complete_match_with_score RPC catch the
// SAME race one step apart: the pre-check sees a settled row, the RPC
// sees a row that settled between the read and the CAS. The pre-check
// has always discriminated completed from cancelled. The RPC returns
// already_settled + status so the JS mapper can keep those copies apart.
//
// EMC-1 a concurrent CANCEL yields match_cancelled
// EMC-2 a concurrent COMPLETE yields already_scored
// EMC-3 a settled row with no status falls back to already_scored
// EMC-4 a missing RPC (PGRST202) fails closed — no score is written
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { endMatchAction } from "@/app/actions/match-lifecycle";

const SESSION_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000020";
const MATCH_ID = "00000000-0000-4000-8000-000000000040";

type MockResponse = { data?: unknown; error?: { message: string; code?: string } | null };

function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);
  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);
  b["single"] = () => Promise.resolve(response);
  b["maybeSingle"] = () => Promise.resolve(response);
  for (const method of ["select", "eq", "neq", "in", "or", "order", "limit", "gte", "update"]) {
    b[method] = () => b;
  }
  return b;
}

function setup(opts: {
  settledStatus?: string | null;
  rpcError?: { message: string; code?: string } | null;
}) {
  let matchesCall = 0;
  const from = vi.fn((table: string) => {
    switch (table) {
      case "matches": {
        matchesCall += 1;
        return makeBuilder({
          data: { id: MATCH_ID, session_id: SESSION_ID, court_id: null, status: "in_progress" },
          error: null,
        });
      }
      case "sessions":
        return makeBuilder({ data: { created_by: USER_ID, club_id: "club-1" }, error: null });
      default:
        return makeBuilder({ data: null, error: null });
    }
  });

  const rpc = vi.fn().mockResolvedValue(
    opts.rpcError
      ? { data: null, error: opts.rpcError }
      : {
          data: {
            success: false,
            error: "already_settled",
            status: opts.settledStatus === undefined ? "completed" : opts.settledStatus,
          },
          error: null,
        }
  );

  vi.mocked(createServiceClient).mockReturnValue({ from, rpc } as never);
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: vi.fn(),
  } as never);

  return { matchesCallCount: () => matchesCall, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EMC: the complete-RPC refusal code reflects what actually happened", () => {
  it("EMC-1: a concurrent cancel yields match_cancelled, not already_scored", async () => {
    const { matchesCallCount, rpc } = setup({ settledStatus: "cancelled" });

    const result = await endMatchAction(MATCH_ID, 21, 15);

    expect(result.success).toBe(false);
    expect(result.code).toBe("match_cancelled");
    expect(result.message).not.toMatch(/scored/i);
    expect(matchesCallCount()).toBe(1);
    expect(rpc).toHaveBeenCalledWith(
      "complete_match_with_score",
      expect.objectContaining({
        p_match_id: MATCH_ID,
        p_actor_type: "organizer",
        p_via: "organizer_end",
      })
    );
  });

  it("EMC-2: a concurrent complete yields already_scored", async () => {
    setup({ settledStatus: "completed" });

    const result = await endMatchAction(MATCH_ID, 21, 15);

    expect(result.success).toBe(false);
    expect(result.code).toBe("already_scored");
  });

  it("EMC-3: an unreadable status falls back to already_scored", async () => {
    setup({ settledStatus: null });

    const result = await endMatchAction(MATCH_ID, 21, 15);

    expect(result.success).toBe(false);
    expect(result.code).toBe("already_scored");
  });

  it("EMC-4: a missing RPC fails closed and does not write a score", async () => {
    const { rpc } = setup({
      rpcError: { message: "Could not find the function", code: "PGRST202" },
    });

    const result = await endMatchAction(MATCH_ID, 21, 15);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not installed/i);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_match_with_score", expect.any(Object));
  });
});
