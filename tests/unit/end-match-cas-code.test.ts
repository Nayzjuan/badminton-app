// ============================================================
// endMatchAction — the code returned when the CAS finds 0 rows
// ============================================================
// The status pre-check and the compare-and-swap catch the SAME race one step
// apart: the pre-check sees a settled row, the CAS sees a row that settled
// between the read and the UPDATE. The pre-check has always discriminated
// completed from cancelled. The CAS branch used to hardcode `already_scored`,
// which is the one input that makes `settledMatchToast` lie: it tells the
// organizer "the score they entered was kept" for a match that was cancelled,
// has no score, and has to be re-run.
//
// Nothing downstream can recover from that — the copy is chosen purely from the
// code — so it has to be right here.
//
// EMC-1 a concurrent CANCEL yields match_cancelled
// EMC-2 a concurrent COMPLETE yields already_scored
// EMC-3 an unreadable status falls back to already_scored, never to the
//       "no score was recorded" copy
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

type MockResponse = { data?: unknown; error?: { message: string } | null };

/** Awaitable chainable builder. Filters are recorded, never applied. */
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

/**
 * The `matches` table is read three times on this path and each read needs a
 * different answer, so it is served from a queue rather than one fixture:
 *
 *   1. the pre-check fetch  → an in_progress row, so the pre-check PASSES and
 *                             execution actually reaches the CAS
 *   2. the CAS update       → [] , i.e. 0 rows affected: the race is lost
 *   3. the status re-read   → what the other caller left behind — the whole
 *                             point of the test
 */
function setup(settledStatus: string | null) {
  const matchesResponses: MockResponse[] = [
    {
      data: { id: MATCH_ID, session_id: SESSION_ID, court_id: null, status: "in_progress" },
      error: null,
    },
    { data: [], error: null },
    { data: settledStatus === null ? null : { status: settledStatus }, error: null },
  ];
  let matchesCall = 0;

  const from = vi.fn((table: string) => {
    switch (table) {
      case "matches": {
        const response = matchesResponses[matchesCall] ?? { data: null, error: null };
        matchesCall += 1;
        return makeBuilder(response);
      }
      // created_by === the caller, so the organizer gate passes on the fast path
      // and session_organizers/club_members are never consulted.
      case "sessions":
        return makeBuilder({ data: { created_by: USER_ID, club_id: "club-1" }, error: null });
      default:
        return makeBuilder({ data: null, error: null });
    }
  });

  vi.mocked(createServiceClient).mockReturnValue({ from, rpc: vi.fn() } as never);
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: vi.fn(),
  } as never);

  return { matchesCallCount: () => matchesCall };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EMC: the CAS-miss code reflects what actually happened", () => {
  it("EMC-1: a concurrent cancel yields match_cancelled, not already_scored", async () => {
    const { matchesCallCount } = setup("cancelled");

    const result = await endMatchAction(MATCH_ID, 21, 15);

    expect(result.success).toBe(false);
    expect(result.code).toBe("match_cancelled");
    // Never claim a score survived — that is the sentence that makes an
    // organizer skip re-running a game that was never recorded.
    expect(result.message).not.toMatch(/scored/i);
    // The re-read happened; the code was not guessed from the pre-check row.
    expect(matchesCallCount()).toBe(3);
  });

  it("EMC-2: a concurrent complete yields already_scored", async () => {
    setup("completed");

    const result = await endMatchAction(MATCH_ID, 21, 15);

    expect(result.success).toBe(false);
    expect(result.code).toBe("already_scored");
  });

  it("EMC-3: an unreadable status falls back to already_scored", async () => {
    setup(null);

    const result = await endMatchAction(MATCH_ID, 21, 15);

    // Asymmetric on purpose. The cancel copy states that no score was recorded;
    // an organizer reading that re-runs the game, and re-running one that was in
    // fact scored is exactly how a second row for the same match gets created —
    // the defect this whole change set exists for.
    expect(result.success).toBe(false);
    expect(result.code).toBe("already_scored");
  });
});
