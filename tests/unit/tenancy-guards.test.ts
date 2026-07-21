// ============================================================
// Tenancy guards — account-takeover chain fixes (PR1)
// ============================================================
// Covers the three server-side gates that together close the chain a
// tenancy audit found: self-provision an organizer session → read/reset any
// member's PIN → reconnect-migrate their account.
//
//   #1 isPlayerInSessionScope — the target of a PIN/skill action must be in
//      THIS session's queue, not just "the caller organizes some session".
//      Deliberately NOT "or a member of the session's club": CHILLAX is the
//      only club and everyone is in it, so a club arm would make the guard a
//      no-op for every profile in the database.
//   #2 createSession — clubId is mandatory and admin-verified; the old
//      omit-clubId → silent CHILLAX fallback (no admin check) is gone.
//   #3 joinAsCoOrganizer — rate-limited by user_id/IP before the passcode
//      lookup runs.
//
// IDs: TG-SCOPE · TG-CREATE · TG-RATE
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({ isClubAdmin: vi.fn() }));
// profile.ts's own gates: keep the REAL isPlayerInSessionScope (that is what we
// are testing) but stub the auth + organizer checks so we reach it.
vi.mock("@/app/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/actions/_shared")>();
  return {
    ...actual,
    getAuthenticatedUser: vi.fn(),
    isSessionOrganizer: vi.fn(),
  };
});
// createSession pulls these in transitively; stub so the module loads.
vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }));
vi.mock("@/app/actions/match-drafts", () => ({ clearAllUnpublishedDrafts: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({
  broadcastSessionClosed: vi.fn(),
  broadcastAutoMatchmakingToggled: vi.fn(),
  broadcastAutoPublishToggled: vi.fn(),
  broadcastDraftCapPhase: vi.fn(),
}));
// next/headers throws outside a request scope; return a header bag with no IP.
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({ get: () => null }),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isClubAdmin } from "@/lib/clubs";
import {
  isPlayerInSessionScope,
  getAuthenticatedUser,
  isSessionOrganizer,
} from "@/app/actions/_shared";
import { createSession, joinAsCoOrganizer } from "@/app/actions/sessions";
import {
  getPlayerPin,
  resetPlayerPin,
  updatePlayerPin,
  updatePlayerSkill,
} from "@/app/actions/profile";

const SESSION_ID = "00000000-0000-4000-8000-000000000010";
const CLUB_ID = "00000000-0000-4000-8000-0000000000c1";
const TARGET_ID = "00000000-0000-4000-8000-000000000a99";
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };

type Resp = { data?: unknown; error?: unknown; count?: number };

/** Chainable builder that resolves (await / .maybeSingle / .single) to `resp`. */
function builder(resp: Resp) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of [
    "select",
    "eq",
    "neq",
    "in",
    "or",
    "gte",
    "lte",
    "order",
    "limit",
    "update",
    "insert",
    "upsert",
  ])
    b[m] = self;
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

/** Service client whose from() hands back `responses` in call order. */
function serviceClient(responses: Resp[], rpcResp?: Resp) {
  let i = 0;
  return {
    from: vi.fn(() => builder(responses[i++] ?? { data: null, error: null })),
    // The rate limiter is one atomic RPC (insert + count in a single txn).
    rpc: vi.fn(() => builder(rpcResp ?? { data: null, error: null })),
  };
}

function authedAs(user: { id: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) } };
}

beforeEach(() => vi.clearAllMocks());

// ── #1 target-scope helper ────────────────────────────────────
describe("TG-SCOPE: isPlayerInSessionScope", () => {
  it("TG-SCOPE-1: true when the target has a queue row for THIS session", async () => {
    const svc = serviceClient([{ data: { id: "q1" } }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(true);
    expect(svc.from).toHaveBeenCalledWith("queue_entries");
  });

  it("TG-SCOPE-2: false when the target has no queue row (the attack)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      serviceClient([{ data: null }]) as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(false);
  });

  it("TG-SCOPE-3: club membership alone does NOT put a target in scope", async () => {
    // The security property that dropping the club arm buys. With CHILLAX the
    // only club and all ~183 profiles members of it, a club arm would return
    // true for essentially every profile — so an organizer (including one who
    // joined by passcode) could still read the PIN of someone who never
    // attended their session. Only the queue lookup runs now, and it misses.
    const svc = serviceClient([{ data: null }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(false);
    const tables = svc.from.mock.calls.map((c: unknown[]) => c[0]);
    expect(tables).not.toContain("club_members");
  });
});

// ── #2 createSession requires a verified club ─────────────────
describe("TG-CREATE: createSession club gate", () => {
  beforeEach(() => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
  });

  it("TG-CREATE-1: rejects a missing clubId (no silent CHILLAX fallback)", async () => {
    const r = await createSession({ name: "Attack", scoring: "single" });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/club is required/i);
    expect(vi.mocked(isClubAdmin)).not.toHaveBeenCalled();
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled();
  });

  it("TG-CREATE-2: rejects a non-admin of the named club", async () => {
    vi.mocked(isClubAdmin).mockResolvedValue(false);
    const r = await createSession({ name: "x", scoring: "single", clubId: CLUB_ID });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/owners and admins/i);
    expect(vi.mocked(isClubAdmin)).toHaveBeenCalledWith(CALLER.id, CLUB_ID);
  });

  it("TG-CREATE-3: rejects an invalid clubId before any admin check", async () => {
    const r = await createSession({ name: "x", scoring: "single", clubId: "not-a-uuid" });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/invalid club/i);
    expect(vi.mocked(isClubAdmin)).not.toHaveBeenCalled();
  });
});

// ── #3 co-organizer join is rate-limited ──────────────────────
describe("TG-RATE: joinAsCoOrganizer rate limit", () => {
  beforeEach(() => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
  });

  it("TG-RATE-1: locks out when over the per-account limit, before any lookup", async () => {
    const svc = serviceClient([], {
      data: { attempt_id: "a1", over_user_limit: true, over_ip_limit: false },
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await joinAsCoOrganizer("SMASH0001");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/too many attempts/i);
    // The passcode lookup must never run when locked out.
    expect(svc.rpc).toHaveBeenCalledWith("cojoin_record_and_check", expect.any(Object));
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("TG-RATE-2: locks out on the IP arm too", async () => {
    const svc = serviceClient([], {
      data: { attempt_id: "a1", over_user_limit: false, over_ip_limit: true },
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    const r = await joinAsCoOrganizer("SMASH0001");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("TG-RATE-3: FAILS CLOSED when the limiter itself errors", async () => {
    // The first cut swallowed a failed attempt-log write and waved the caller
    // through, silently disabling the limiter. An error must deny instead.
    const svc = serviceClient([], { data: null, error: { message: "boom" } });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    const r = await joinAsCoOrganizer("SMASH0001");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/too many attempts/i);
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("TG-RATE-4: under the limit, a wrong passcode reaches the lookup and stays logged as failed", async () => {
    const svc = serviceClient(
      [{ data: null }], // sessions lookup: no match
      { data: { attempt_id: "a1", over_user_limit: false, over_ip_limit: false } }
    );
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await joinAsCoOrganizer("WRONG9999");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/invalid passcode/i);
    // The RPC already logged the attempt pessimistically as a failure, so the
    // wrong guess must NOT be flipped to succeeded.
    const tables = svc.from.mock.calls.map((c: unknown[]) => c[0]);
    expect(tables).toEqual(["sessions"]);
  });
});

// ── #1 WIRING: the guard is actually enforced by all four actions ──────
// Without these, the fix for audit finding #1 is untested: the guard could be
// correct in isolation while every call site was deleted, and the suite would
// still be green.
describe("TG-WIRE: profile actions enforce the scope guard", () => {
  const outOfScope = () =>
    serviceClient([{ data: null }]) as unknown as ReturnType<typeof createServiceClient>;

  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      CALLER as unknown as Awaited<ReturnType<typeof getAuthenticatedUser>>
    );
    // The caller IS a legitimate organizer of the session — that is the whole
    // point: the organizer gate passing must not be sufficient.
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  });

  const cases: [string, () => Promise<{ success: boolean; message: string }>][] = [
    ["getPlayerPin", () => getPlayerPin(SESSION_ID, TARGET_ID)],
    ["resetPlayerPin", () => resetPlayerPin(SESSION_ID, TARGET_ID)],
    ["updatePlayerPin", () => updatePlayerPin(SESSION_ID, TARGET_ID, "4321")],
    ["updatePlayerSkill", () => updatePlayerSkill(SESSION_ID, TARGET_ID, "intermediate")],
  ];

  for (const [name, call] of cases) {
    it(`TG-WIRE-${name}: refuses an out-of-session target even for a real organizer`, async () => {
      const svc = outOfScope();
      vi.mocked(createServiceClient).mockReturnValue(svc);

      const r = await call();

      expect(r.success).toBe(false);
      expect(r.message).toMatch(/not part of this session/i);
      // The profiles table must never be touched once the guard denies —
      // reading the PIN at all is the breach.
      const tables = (
        svc as unknown as { from: { mock: { calls: unknown[][] } } }
      ).from.mock.calls.map((c) => c[0]);
      expect(tables).not.toContain("profiles");
    });
  }
});
