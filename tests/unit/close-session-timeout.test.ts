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
    expect(vi.mocked(withTimeout).mock.calls.every((c) => c[1] === 3_000)).toBe(true);
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
});
