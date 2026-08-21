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
// Must resolve a promise: the actions call runEngineForSession(...).catch(...)
// inside after(), so a bare vi.fn() returning undefined throws.
vi.mock("@/app/actions/matchmaking", () => ({
  runEngineForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/match-drafts", () => ({ clearAllUnpublishedDrafts: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({
  broadcastSessionClosed: vi.fn(),
  broadcastAutoMatchmakingToggled: vi.fn(),
  broadcastAutoPublishToggled: vi.fn(),
  broadcastDraftCapPhase: vi.fn(),
  broadcastQueueNotice: vi.fn().mockResolvedValue(undefined),
}));
// next/headers throws outside a request scope; return a header bag with no IP.
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({ get: () => null }),
}));
// queue.ts schedules post-response work with after(), which also requires a
// request scope. Run the callback inline so the action completes under test.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));

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
import { checkoutPlayer } from "@/app/actions/queue";

const SESSION_ID = "00000000-0000-4000-8000-000000000010";
const CLUB_ID = "00000000-0000-4000-8000-0000000000c1";
const TARGET_ID = "00000000-0000-4000-8000-000000000a99";
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };

type Resp = { data?: unknown; error?: unknown; count?: number };

/** One recorded table access: the table name plus the filters applied to it. */
type Recorded = { table: string; ops: string[] };

/**
 * Chainable builder that resolves (await / .maybeSingle / .single) to `resp`
 * AND records every filter it is given as `op:column=value`.
 *
 * Recording the arguments is the entire point. The previous builder assigned a
 * bare `() => b` to eq/in/neq/…, so it captured the table name and nothing
 * else. Under that mock isPlayerInSessionScope could have its two filters
 * SWAPPED (`.eq("session_id", targetUserId).eq("player_id", sessionId)`) or
 * have `.eq("session_id", …)` DELETED OUTRIGHT — the account-takeover
 * primitive this file's header describes, where the guard starts returning
 * true for anyone who has ever queued in ANY session — and all 17 tests here,
 * plus the whole unit suite, stayed green. Both mutants are now caught by
 * TG-SCOPE-4, which asserts the column-to-value PAIRING; asserting merely that
 * two eq() calls happened does not catch the swap, because the swap makes two
 * eq() calls too.
 */
function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["select", "order", "limit", "update", "insert", "upsert"]) b[m] = self;
  for (const m of ["eq", "neq", "in", "gte", "lte"])
    b[m] = (col: string, val: unknown) => {
      ops.push(`${m}:${col}=${String(val)}`);
      return b;
    };
  b["or"] = (expr: string) => {
    ops.push(`or:${expr}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

/**
 * Service client whose from() hands back `responses` in call order.
 * `recorded` accumulates one entry per from()/rpc() call, in the same order.
 */
function serviceClient(responses: Resp[], rpcResp?: Resp) {
  let i = 0;
  const recorded: Recorded[] = [];
  return {
    recorded,
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(responses[i++] ?? { data: null, error: null }, entry.ops);
    }),
    // The rate limiter is one atomic RPC (insert + count in a single txn).
    rpc: vi.fn((fn: string) => {
      const entry: Recorded = { table: `rpc:${fn}`, ops: [] };
      recorded.push(entry);
      return builder(rpcResp ?? { data: null, error: null }, entry.ops);
    }),
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

  it("TG-SCOPE-4 (negative): the queue lookup is bound to BOTH the session and the target, by column", async () => {
    // TG-SCOPE-1/2/3 assert only the returned boolean and the table name, so
    // they cannot see which columns were filtered. Two mutations survive them:
    //   (a) swap the values  — .eq("session_id", targetUserId)
    //                          .eq("player_id", sessionId)
    //   (b) drop the session filter entirely, leaving .eq("player_id", …),
    //       which makes the guard true for any target who has ever queued in
    //       ANY session — the account-takeover primitive itself.
    // Asserting the column=value PAIRING catches both; (b) alone would be
    // caught by a presence check, (a) needs the pairing.
    const svc = serviceClient([{ data: { id: "q1" } }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(true);

    const queueRead = svc.recorded.find((r) => r.table === "queue_entries");
    expect(queueRead, "isPlayerInSessionScope never read queue_entries").toBeDefined();
    expect(queueRead!.ops).toContain(`eq:session_id=${SESSION_ID}`);
    expect(queueRead!.ops).toContain(`eq:player_id=${TARGET_ID}`);
  });

  it("TG-SCOPE-5 (negative): the guard reads queue_entries and nothing else", async () => {
    // A future arm added to this guard — club membership, session_organizers,
    // profiles — re-opens the hole TG-SCOPE-3 documents. Pin the table set so
    // widening the guard has to come here and say so.
    const svc = serviceClient([{ data: null }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(false);
    expect(svc.recorded.map((r) => r.table)).toEqual(["queue_entries"]);
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

// ── #2b createSession duplicate-creation guard ────────────────
// 07/25 incident: two organizers created "the" Saturday session 343 ms apart;
// three players checked into the wrong one and were dumped when it was closed.
// A second ACTIVE session in the same club inside the guard window must be
// refused with a pointer to the existing one — and refused BEFORE any insert.
describe("TG-DUP: createSession duplicate-creation guard", () => {
  beforeEach(() => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    vi.mocked(isClubAdmin).mockResolvedValue(true);
  });

  it("TG-DUP-1: refuses when an active session was just created in the club", async () => {
    const svc = serviceClient([
      // Guard SELECT finds the session the other organizer just created.
      { data: { id: "existing-1", name: "07/25 Saturday Session" } },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await createSession({ name: "Saturday 07/25", scoring: "single", clubId: CLUB_ID });

    expect(r.success).toBe(false);
    // The message names the existing session so the caller can join it…
    expect(r.message).toContain("07/25 Saturday Session");
    // …and the id rides along for a future "open it" affordance.
    expect(r.existingSessionId).toBe("existing-1");
    // Refused on the guard SELECT alone: no passcode check, no INSERT.
    expect(svc.from).toHaveBeenCalledTimes(1);
  });

  it("TG-DUP-2: proceeds to create when nothing recent is active in the club", async () => {
    const svc = serviceClient([
      { data: null }, // guard: no recent active session
      { data: null }, // passcode conflict check: free
      { data: { id: "new-session-1" } }, // insert
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await createSession({
      name: "Thursday",
      scoring: "single",
      clubId: CLUB_ID,
      passcode: "SMASH0001",
    });

    expect(r.success).toBe(true);
    expect(r.sessionId).toBe("new-session-1");
    expect(r.existingSessionId).toBeUndefined();
    expect(svc.from).toHaveBeenCalledTimes(3);
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

// ── Grant-compatibility: writes must use the role that HOLDS the grant ──
// 20260721190000 revokes UPDATE on queue_entries from anon/authenticated. Any
// write still issued on the user-context client fails with 42501 the moment it
// applies. The integration suite cannot catch this — tests/integration/setup.ts
// mocks the server client with a real SERVICE-ROLE client, so those tests
// exercise service_role and stay green regardless. Hence a unit assertion on
// WHICH client performs the write.
describe("TG-GRANT: queue_entries writes use the service client", () => {
  it("TG-GRANT-1: checkoutPlayer updates via the service client, not the user client", async () => {
    const userCtx = {
      ...authedAs(CALLER),
      // Ops are deliberately discarded: this client exists only to prove it is
      // never the one that writes, which `expect(userCtx.from).not.toHaveBeen…`
      // below asserts on the spy, not on recorded columns.
      from: vi.fn(() => builder({ data: null, error: null }, [])),
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      userCtx as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    const svc = serviceClient([{ data: null, error: null }], { data: [], error: null });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await checkoutPlayer(SESSION_ID);
    expect(r.success).toBe(true);

    // The write went through the service role…
    expect(svc.from).toHaveBeenCalledWith("queue_entries");
    // …and NOT through the anon/authenticated client, which no longer holds
    // the UPDATE grant.
    const userTables = userCtx.from.mock.calls.map((c: unknown[]) => c[0]);
    expect(userTables).not.toContain("queue_entries");
  });
});
