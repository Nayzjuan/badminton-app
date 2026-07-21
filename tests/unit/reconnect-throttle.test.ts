// ============================================================
// reconnectPlayer — PIN-oracle rate limiting
// ============================================================
// reconnectPlayer(name, pin) returns an account and then MIGRATES the caller's
// identity onto it. The PIN space is 9,000 (src/lib/pin.ts) and display names
// are readable to any authenticated user and printed on the public /tv and
// leaderboard share pages — so unthrottled it is a full account-takeover
// primitive requiring NO organizer rights, reaching the same outcome as the
// chain closed in tenancy-guards.test.ts.
//
// The limiter is keyed on the display_name BEING ATTACKED, not on the caller:
// the caller is anonymous here and can mint identities at will, so a
// caller-keyed limit would be worthless.
//
// IDs: RC-LOCK (lockout arms) · RC-FAIL (fail-closed) · RC-PASS (under limit)
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({
  ensureClubMembership: vi.fn(),
  getClubBySlug: vi.fn().mockResolvedValue(null),
  resolveSessionClubSlug: vi.fn(),
}));
// No request scope in unit tests — the IP arm degrades to null.
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue({ get: () => null }) }));

import { createServiceClient } from "@/utils/supabase/service";
import { reconnectPlayer } from "@/app/actions/auth";

type Resp = { data?: unknown; error?: unknown };

/** Chainable builder resolving to `resp` via await / .maybeSingle / .single. */
function builder(resp: Resp) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["select", "eq", "ilike", "in", "order", "limit", "update", "insert"])
    b[m] = self;
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

/** Service client with a scripted rpc() verdict and a from() spy. */
function serviceWith(rpcResp: Resp) {
  return {
    rpc: vi.fn(() => builder(rpcResp)),
    from: vi.fn(() => builder({ data: [], error: null })),
  };
}

const NAME = "Alice";
const PIN = "4821";

beforeEach(() => vi.clearAllMocks());

describe("RC-LOCK: reconnect lockout", () => {
  it("RC-LOCK-1: locks out on the name arm BEFORE any profile lookup", async () => {
    const svc = serviceWith({
      data: { attempt_id: "a1", over_subject_limit: true, over_ip_limit: false },
      error: null,
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await reconnectPlayer(NAME, PIN);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    // The oracle must never be consulted once locked — otherwise the lockout
    // leaks nothing but still answers the attacker's question.
    expect(svc.from).not.toHaveBeenCalled();
    expect(svc.rpc).toHaveBeenCalledWith("reconnect_record_and_check", expect.any(Object));
  });

  it("RC-LOCK-2: locks out on the IP arm too", async () => {
    const svc = serviceWith({
      data: { attempt_id: "a1", over_subject_limit: false, over_ip_limit: true },
      error: null,
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await reconnectPlayer(NAME, PIN);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("RC-LOCK-3: the lockout message does not reveal whether the name exists", async () => {
    const svc = serviceWith({
      data: { attempt_id: "a1", over_subject_limit: true, over_ip_limit: false },
      error: null,
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    const r = await reconnectPlayer("DefinitelyNotARealPlayer", PIN);
    expect(r.error).toMatch(/too many attempts/i);
    expect(r.error).not.toMatch(/no match|not found|check your name/i);
  });
});

describe("RC-FAIL: the limiter fails closed", () => {
  it("RC-FAIL-1: an RPC error denies the reconnect rather than allowing it", async () => {
    const svc = serviceWith({ data: null, error: { message: "boom" } });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await reconnectPlayer(NAME, PIN);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    // Critically: it must not fall through to the oracle when the limiter is
    // broken. A limiter that fails OPEN is worse than none, because it looks
    // like protection.
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("RC-FAIL-2: a null verdict row also denies", async () => {
    const svc = serviceWith({ data: null, error: null });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    const r = await reconnectPlayer(NAME, PIN);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });
});

describe("RC-PASS: under the limit", () => {
  it("RC-PASS-1: a wrong PIN reaches the lookup and stays logged as a failure", async () => {
    const svc = serviceWith({
      data: { attempt_id: "a1", over_subject_limit: false, over_ip_limit: false },
      error: null,
    });
    // profiles lookup returns nothing → wrong credentials
    svc.from = vi.fn(() => builder({ data: [], error: null }));
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await reconnectPlayer(NAME, PIN);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no match found/i);
    // The oracle WAS consulted (we were under the limit)…
    expect(svc.from).toHaveBeenCalledWith("profiles");
    // …and the pessimistic failure was NOT flipped to succeeded.
    const rpcNames = svc.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcNames).not.toContain("auth_attempt_mark_succeeded");
  });
});
