// ============================================================
// Unit tests: closeSession must not strand an open session when
// Wrapped pre-compute hangs or throws.
// ============================================================
// 08/15/2026 prod: refresh_cross_session_stats / compute_session_wrapped
// never returned via PostgREST. closeSession awaited them before flipping
// is_active, so the platform killed the action and Saturday stayed open.
// These cases pin: timeout, throw, and a fast RPC error all still close.
//
//   CST-1  hung RPCs (withTimeout loses) → session still flipped
//   CST-2  rpc THROWS → session still flipped, wrappedReady false
//   CST-3  compute succeeds → wrappedReady true
//   CST-4  57014 → no retry, still closes
//   CST-5  ledger refresh fails, compute succeeds → rows written, NOT ready
//   CST-6  all three RPCs share ONE phase budget, not one each
//   CST-7  a fast failure retries, and the retry's success counts
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }));
vi.mock("@/app/actions/match-drafts", () => ({ clearAllUnpublishedDrafts: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
  isSessionActive: vi.fn(),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcastSessionClosed: vi.fn().mockResolvedValue(true),
  broadcastAutoMatchmakingToggled: vi.fn(),
  broadcastAutoPublishToggled: vi.fn(),
  broadcastDraftCapPhase: vi.fn(),
}));
vi.mock("@/lib/with-timeout", () => ({ withTimeout: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isSessionOrganizer } from "@/app/actions/_shared";
import { broadcastSessionClosed } from "@/lib/broadcast";
import { withTimeout } from "@/lib/with-timeout";
import { closeSession } from "@/app/actions/sessions";

const SESSION_ID = "3367d4c6-6838-4cf7-8abe-5f5c3143dd1e";
const ORG_ID = "00000000-0000-4000-8000-00000000000a";

const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

type RpcError = { message: string; code?: string } | null;

function makeServiceClient(opts: {
  rpc: (name: string) => Promise<{ error: RpcError }>;
  onSessionFlip?: () => void;
}) {
  return {
    rpc: vi.fn((name: string) => opts.rpc(name)),
    from: vi.fn((table: string) => {
      if (table === "sessions") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: SESSION_ID, is_active: true },
                  error: null,
                }),
            }),
          }),
          update: () => ({
            eq: () => {
              opts.onSessionFlip?.();
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "courts") {
        return {
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      return {
        update: () => ({
          eq: () => ({
            in: () => Promise.resolve({ error: null, count: 0 }),
          }),
        }),
      };
    }),
  };
}

function makeServerClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy.mockClear();
  errorSpy.mockClear();
  vi.mocked(createServerSupabaseClient).mockResolvedValue(makeServerClient(ORG_ID) as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  vi.mocked(broadcastSessionClosed).mockResolvedValue(true);
});

describe("closeSession — Wrapped hang must not block close", () => {
  it("CST-1: hung RPCs still flip is_active (withTimeout loses the race)", async () => {
    let flipped = false;
    const rpc = vi.fn((_name: string) => new Promise<{ error: RpcError }>(() => {}));
    vi.mocked(withTimeout).mockResolvedValue(null);
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        rpc,
        onSessionFlip: () => {
          flipped = true;
        },
      }) as never
    );

    const result = await closeSession(SESSION_ID);

    expect(result.success).toBe(true);
    expect(result.wrappedReady).toBe(false);
    expect(flipped).toBe(true);
    expect(broadcastSessionClosed).toHaveBeenCalledWith(SESSION_ID, false);
    expect(rpc.mock.calls.filter((c) => c[0] === "compute_session_wrapped")).toHaveLength(1);
    // The phase budget, not a per-call one: the first call gets all of it, and
    // nothing may ever be handed more than the phase has left. CST-6 pins the
    // decrement — here withTimeout resolves instantly, so no time is consumed.
    //
    // A RANGE, not toBe(5_000): the budget is `endsAt - Date.now()`, so exact
    // equality is really asserting that zero wall-clock elapsed between
    // startPhaseBudget and the first call. That holds on an idle machine and
    // fails on a busy one — observed as "expected 4996 to be 5000". The
    // property being tested is that the first call gets the WHOLE phase, and
    // the floor still catches every way of breaking it: splitting the budget
    // across the three calls yields ~1_667, and lowering the constant is
    // caught outright.
    const firstBudget = vi.mocked(withTimeout).mock.calls[0][1];
    expect(
      firstBudget,
      "the first Wrapped RPC was handed less than the full phase budget — it is " +
        "being divided per-call instead of shared"
    ).toBeGreaterThan(4_500);
    expect(firstBudget).toBeLessThanOrEqual(5_000);
    expect(vi.mocked(withTimeout).mock.calls.every((c) => c[1] > 0 && c[1] <= 5_000)).toBe(true);
  });

  it("CST-2: an RPC throw still closes the session", async () => {
    let flipped = false;
    vi.mocked(withTimeout).mockImplementation(async (promise) => promise);
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        rpc: () => Promise.reject(new Error("fetch failed")),
        onSessionFlip: () => {
          flipped = true;
        },
      }) as never
    );

    const result = await closeSession(SESSION_ID);

    expect(result.success).toBe(true);
    expect(result.wrappedReady).toBe(false);
    expect(flipped).toBe(true);
  });

  it("CST-3: successful compute reports wrappedReady", async () => {
    vi.mocked(withTimeout).mockImplementation(async (promise) => promise);
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        rpc: () => Promise.resolve({ error: null }),
      }) as never
    );

    const result = await closeSession(SESSION_ID);

    expect(result.success).toBe(true);
    expect(result.wrappedReady).toBe(true);
    expect(broadcastSessionClosed).toHaveBeenCalledWith(SESSION_ID, true);
  });

  // 0a (refresh_cross_session_stats) and 0b (compute_session_wrapped) take
  // DIFFERENT advisory locks, so nothing serialises them but the await. If 0a
  // loses, 0b snapshots cross-session awards from the pre-refresh ledger —
  // awards that omit the session being closed. The rows must still be written
  // (a missing session_wrapped_stats row replays the intro forever), but this
  // close must not claim they are ready.
  it("CST-5: a failed ledger refresh withholds wrappedReady even when compute succeeds", async () => {
    let flipped = false;
    vi.mocked(withTimeout).mockImplementation(async (promise) => promise);
    const rpc = vi.fn((name: string) => {
      if (name === "refresh_cross_session_stats") {
        return Promise.resolve({
          error: { message: "canceling statement due to statement timeout", code: "57014" },
        });
      }
      return Promise.resolve({ error: null });
    });
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        rpc,
        onSessionFlip: () => {
          flipped = true;
        },
      }) as never
    );

    const result = await closeSession(SESSION_ID);

    expect(result.success).toBe(true);
    expect(flipped).toBe(true);
    // The Wrapped rows WERE written — we do not skip 0b.
    expect(rpc.mock.calls.filter((c) => c[0] === "compute_session_wrapped")).toHaveLength(1);
    // …but the watcher must route to the lobby, not to a stale Wrapped.
    expect(result.wrappedReady).toBe(false);
    expect(broadcastSessionClosed).toHaveBeenCalledWith(SESSION_ID, false);
  });

  it("CST-4: statement-timeout (57014) does not retry, still closes", async () => {
    vi.mocked(withTimeout).mockImplementation(async (promise) => promise);
    const rpc = vi.fn((name: string) => {
      if (name === "compute_session_wrapped") {
        return Promise.resolve({
          error: { message: "canceling statement due to statement timeout", code: "57014" },
        });
      }
      return Promise.resolve({ error: null });
    });
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ rpc }) as never);

    const result = await closeSession(SESSION_ID);

    expect(result.success).toBe(true);
    expect(result.wrappedReady).toBe(false);
    expect(rpc.mock.calls.filter((c) => c[0] === "compute_session_wrapped")).toHaveLength(1);
  });

  // A per-call ceiling multiplies: ledger + compute + retry at 3 s each plus
  // the 600 ms backoff is 9.6 s, past the ~10 s serverless budget the ceiling
  // exists to protect — every call looks obedient while the phase overruns.
  // One deadline is the invariant that actually holds. Here the ledger burns
  // the whole phase, so compute must get ZERO, not a fresh allowance.
  it("CST-6: the Wrapped RPCs share one phase budget, they do not each get a fresh one", async () => {
    let clock = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const budgets: number[] = [];
      vi.mocked(withTimeout).mockImplementation(async (_promise, ms) => {
        budgets.push(ms);
        clock += ms; // this call consumed its entire allowance and timed out
        return null;
      });
      let flipped = false;
      const rpc = vi.fn((_name: string) => new Promise<{ error: RpcError }>(() => {}));
      vi.mocked(createServiceClient).mockReturnValue(
        makeServiceClient({
          rpc,
          onSessionFlip: () => {
            flipped = true;
          },
        }) as never
      );

      const result = await closeSession(SESSION_ID);

      expect(budgets).toEqual([5_000]);
      // compute was FIRED — postgres landing the rows late beats never — but
      // it was not awaited, because there was no budget left to await it with.
      expect(rpc.mock.calls.filter((c) => c[0] === "compute_session_wrapped")).toHaveLength(1);
      expect(result.success).toBe(true);
      expect(result.wrappedReady).toBe(false);
      expect(flipped).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The one CloseRpcOutcome transition nothing asserted: a fast, non-timeout
  // failure is the only outcome that earns a retry, and the retry's success
  // has to be what decides wrappedReady.
  it("CST-7: a fast failure retries once and the retry's success reports wrappedReady", async () => {
    // Leave a sliver of phase budget so the retry is still affordable and the
    // real backoff sleep is Math.min(600, sliver) rather than a 600 ms stall.
    const t0 = 1_700_000_000_000;
    let call = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (call++ === 0 ? t0 : t0 + 4_950));
    try {
      vi.mocked(withTimeout).mockImplementation(async (promise) => promise);
      let computes = 0;
      const rpc = vi.fn((name: string) => {
        if (name === "compute_session_wrapped" && computes++ === 0) {
          return Promise.resolve({ error: { message: "deadlock detected", code: "40P01" } });
        }
        return Promise.resolve({ error: null });
      });
      vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ rpc }) as never);

      const result = await closeSession(SESSION_ID);

      expect(rpc.mock.calls.filter((c) => c[0] === "compute_session_wrapped")).toHaveLength(2);
      expect(result.success).toBe(true);
      expect(result.wrappedReady).toBe(true);
      expect(broadcastSessionClosed).toHaveBeenCalledWith(SESSION_ID, true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
