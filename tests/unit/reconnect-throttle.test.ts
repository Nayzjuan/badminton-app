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
// NOTE ON NON-VACUITY. Every test here must FAIL against unthrottled code.
// The obvious "under the limit, the lookup still runs" assertion does not —
// code with no limiter at all also runs the lookup. So the ordering tests
// below assert the gate fires BEFORE the oracle is consulted, which is the
// property that actually distinguishes the two.
//
// IDs: RC-LOCK (lockout arms) · RC-FAIL (fail-closed) · RC-PASS (under limit)
//      RC-FLIP (a correct PIN clears the pessimistic failure)
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

/** Every rpc()/from() call in invocation order, so tests can assert sequencing. */
let callLog: string[] = [];

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

/**
 * Service client with a scripted gate verdict.
 * `profilesResp` is what the credential lookup returns; every other table
 * resolves empty so the phase-1/2/3 scans fall through harmlessly.
 */
function serviceWith(gate: Resp, profilesResp: Resp = { data: [], error: null }) {
  const svc = {
    rpc: vi.fn((name: string) => {
      callLog.push(`rpc:${name}`);
      return builder(name === "reconnect_record_and_check" ? gate : { data: null, error: null });
    }),
    from: vi.fn((table: string) => {
      callLog.push(`from:${table}`);
      return builder(table === "profiles" ? profilesResp : { data: null, error: null });
    }),
    auth: {
      admin: {
        // Google-linked → reconnectPlayer bails out right after the attempt is
        // flipped, giving the tests a clean exit without mocking the whole
        // identity-migration path.
        getUserById: vi.fn(async () => ({
          data: { user: { identities: [{ provider: "google" }] } },
        })),
        deleteUser: vi.fn(),
      },
    },
  };
  return svc;
}

function install(svc: ReturnType<typeof serviceWith>) {
  vi.mocked(createServiceClient).mockReturnValue(
    svc as unknown as ReturnType<typeof createServiceClient>
  );
}

const NAME = "Alice";
const PIN = "4821";
const OPEN = {
  data: {
    attempt_id: "a1",
    over_subject_limit: false,
    over_ip_limit: false,
    over_global_limit: false,
  },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  callLog = [];
});

describe("RC-LOCK: reconnect lockout", () => {
  it("RC-LOCK-1: locks out on the name arm BEFORE any profile lookup", async () => {
    const svc = serviceWith({
      data: {
        attempt_id: null,
        over_subject_limit: true,
        over_ip_limit: false,
        over_global_limit: false,
      },
      error: null,
    });
    install(svc);

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
      data: {
        attempt_id: null,
        over_subject_limit: false,
        over_ip_limit: true,
        over_global_limit: false,
      },
      error: null,
    });
    install(svc);

    const r = await reconnectPlayer(NAME, PIN);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("RC-LOCK-3: locks out on the scope-wide arm (horizontal spray)", async () => {
    // One PIN tried against every name: each name costs a single attempt, so
    // neither the per-name nor the per-IP arm ever fires. Only the global
    // ceiling catches it.
    const svc = serviceWith({
      data: {
        attempt_id: null,
        over_subject_limit: false,
        over_ip_limit: false,
        over_global_limit: true,
      },
      error: null,
    });
    install(svc);

    const r = await reconnectPlayer("SomeoneElse", PIN);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("RC-LOCK-4: the lockout message does not reveal whether the name exists", async () => {
    const svc = serviceWith({
      data: {
        attempt_id: null,
        over_subject_limit: true,
        over_ip_limit: false,
        over_global_limit: false,
      },
      error: null,
    });
    install(svc);
    const r = await reconnectPlayer("DefinitelyNotARealPlayer", PIN);
    expect(r.error).toMatch(/too many attempts/i);
    expect(r.error).not.toMatch(/no match|not found|check your name/i);
  });

  it("RC-LOCK-5: a blocked attempt is not itself recorded", async () => {
    // The limiter must not feed its own window. If a rejected attempt still
    // logged a failure, an attacker could hold a NAMED victim out of their own
    // account forever at one request per window — and for an anonymous-auth
    // player, reconnect IS the account; there is no email reset behind it.
    // Enforced in SQL (20260721220000: count first, insert only when under),
    // so what the action must guarantee is that it makes exactly ONE gate call
    // and never retries around a block.
    const svc = serviceWith({
      data: {
        attempt_id: null,
        over_subject_limit: true,
        over_ip_limit: false,
        over_global_limit: false,
      },
      error: null,
    });
    install(svc);

    await reconnectPlayer(NAME, PIN);

    const gateCalls = svc.rpc.mock.calls.filter((c) => c[0] === "reconnect_record_and_check");
    expect(gateCalls).toHaveLength(1);
    // …and it must not "clean up" by flipping the blocked attempt to succeeded,
    // which would hand the attacker a free window reset.
    expect(svc.rpc.mock.calls.map((c) => c[0])).not.toContain("auth_attempt_mark_succeeded");
  });
});

describe("RC-FAIL: the limiter fails closed", () => {
  it("RC-FAIL-1: an RPC error denies the reconnect rather than allowing it", async () => {
    const svc = serviceWith({ data: null, error: { message: "boom" } });
    install(svc);

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
    install(svc);
    const r = await reconnectPlayer(NAME, PIN);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });
});

describe("RC-PASS: under the limit", () => {
  it("RC-PASS-1: the gate runs BEFORE the credential lookup, not alongside it", async () => {
    // This is the ordering assertion that unthrottled code cannot satisfy:
    // with no limiter there is no rpc entry at all, and a limiter bolted on
    // AFTER the lookup would still have answered the attacker's question.
    const svc = serviceWith(OPEN);
    install(svc);

    const r = await reconnectPlayer(NAME, PIN);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no match found/i);

    const gateAt = callLog.indexOf("rpc:reconnect_record_and_check");
    const lookupAt = callLog.indexOf("from:profiles");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(lookupAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(lookupAt);
  });

  it("RC-PASS-2: a wrong PIN leaves the pessimistic failure standing", async () => {
    const svc = serviceWith(OPEN);
    install(svc);

    await reconnectPlayer(NAME, PIN);

    // Not flipped → this attempt counts against the window. Without this the
    // limiter would record attempts it never charges anyone for.
    expect(svc.rpc.mock.calls.map((c) => c[0])).not.toContain("auth_attempt_mark_succeeded");
  });
});

describe("RC-FLIP: a correct PIN clears the pessimistic failure", () => {
  it("RC-FLIP-1: a successful credential match flips the attempt to succeeded", async () => {
    // The success path was previously untested, which mattered: if the flip
    // silently never happened, ten legitimate reconnects in fifteen minutes
    // would lock a player out of their own account. The Google-linked bail-out
    // gives a deterministic exit just past the flip.
    const svc = serviceWith(OPEN, { data: [{ id: "old-user" }], error: null });
    install(svc);

    const r = await reconnectPlayer(NAME, PIN);

    expect(r.useGoogleSignIn).toBe(true);
    expect(svc.rpc).toHaveBeenCalledWith("auth_attempt_mark_succeeded", {
      p_attempt_id: "a1",
    });
    // …and the flip happens only after the lookup confirmed the credentials.
    const lookupAt = callLog.indexOf("from:profiles");
    const flipAt = callLog.indexOf("rpc:auth_attempt_mark_succeeded");
    expect(lookupAt).toBeLessThan(flipAt);
  });
});
