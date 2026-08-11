// @vitest-environment happy-dom
// ============================================================
// Realtime socket recycle on auth recovery
// ============================================================
// postgres_changes RLS filters bind at channel-JOIN time; setAuth cannot
// re-bind an already-joined channel. createBrowserSupabaseClient therefore
// recycles the socket (disconnect + connect → every registered channel
// rejoins with the fresh token) when a session appears after a no-session
// window — and ONLY then. These tests pin the transition logic.
//
// The wiring is a module-level singleton (hasWiredRealtimeAuth), so each
// test resets modules and dynamically imports a fresh copy.
//
// IDs: RAR-1 … RAR-4
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

// disconnect() is async in the real RealtimeClient and the recycle AWAITS it
// before connect() — that ordering is the whole point of the fix, so the mock
// has to be async too or the tests would pass against the broken synchronous
// pair. isConnected() answers the belt-and-braces re-arm timer that fires
// REALTIME_RECONNECT_REARM_MS after a recycle; returning true makes it a no-op
// instead of a TypeError thrown into an empty stack after the test has ended.
const mockRealtime = {
  setAuth: vi.fn(),
  disconnect: vi.fn(async () => {}),
  connect: vi.fn(),
  isConnected: vi.fn(() => true),
};
let authCallback: ((event: string, session: { access_token: string } | null) => void) | null = null;
let mockSession: { access_token: string } | null = null;
let mockChannels: unknown[] = [{}];

const mockClient = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: mockSession } }),
    onAuthStateChange: (cb: typeof authCallback) => {
      authCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  },
  realtime: mockRealtime,
  getChannels: () => mockChannels,
};

vi.mock("@supabase/ssr", () => ({ createBrowserClient: () => mockClient }));

/** Fresh module copy → wire the singleton → settle the eager hydration. */
async function wireFreshClient() {
  const mod = await import("@/utils/supabase/client");
  mod.createBrowserSupabaseClient();
  await mod.whenRealtimeAuthReady();
}

/**
 * Drain the microtask queue. The auth callback fires the recycle with `void`,
 * and the recycle awaits disconnect() before calling connect(), so connect()
 * lands a tick after the synchronous callback returns. A macrotask hop is the
 * cheap way to be sure every pending continuation has run — including the ones
 * that must NOT have run, which is what the negative assertions rely on.
 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("realtime auth recycle — Unit Suite", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authCallback = null;
    mockSession = null;
    mockChannels = [{}];
  });

  it("RAR-1: cold start without a session → first recovery recycles the socket", async () => {
    mockSession = null;
    await wireFreshClient();

    authCallback?.("SIGNED_IN", { access_token: "t1" });
    await settle();

    expect(mockRealtime.setAuth).toHaveBeenCalledWith("t1");
    expect(mockRealtime.disconnect).toHaveBeenCalledTimes(1);
    expect(mockRealtime.connect).toHaveBeenCalledTimes(1);
  });

  it("RAR-2: healthy session → routine TOKEN_REFRESHED never recycles", async () => {
    mockSession = { access_token: "t0" };
    await wireFreshClient();

    authCallback?.("TOKEN_REFRESHED", { access_token: "t1" });
    authCallback?.("TOKEN_REFRESHED", { access_token: "t2" });
    await settle();

    expect(mockRealtime.setAuth).toHaveBeenCalledWith("t2");
    expect(mockRealtime.disconnect).not.toHaveBeenCalled();
    expect(mockRealtime.connect).not.toHaveBeenCalled();
  });

  it("RAR-3: mid-session death (SIGNED_OUT) then recovery recycles exactly once", async () => {
    mockSession = { access_token: "t0" };
    await wireFreshClient();

    authCallback?.("SIGNED_OUT", null);
    authCallback?.("TOKEN_REFRESHED", { access_token: "t1" });
    // Later routine refreshes on the now-healthy session must not recycle.
    authCallback?.("TOKEN_REFRESHED", { access_token: "t2" });
    await settle();

    expect(mockRealtime.disconnect).toHaveBeenCalledTimes(1);
    expect(mockRealtime.connect).toHaveBeenCalledTimes(1);
  });

  it("RAR-4: no channels registered → recovery sets auth but skips the recycle", async () => {
    mockSession = null;
    mockChannels = [];
    await wireFreshClient();

    authCallback?.("SIGNED_IN", { access_token: "t1" });
    await settle();

    expect(mockRealtime.setAuth).toHaveBeenCalledWith("t1");
    expect(mockRealtime.disconnect).not.toHaveBeenCalled();
  });
});
