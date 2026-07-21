// ============================================================
// Tenancy guards — account-takeover chain fixes (PR1)
// ============================================================
// Covers the three server-side gates that together close the chain a
// tenancy audit found: self-provision an organizer session → read/reset any
// member's PIN → reconnect-migrate their account.
//
//   #1 isPlayerInSessionScope — the target of a PIN/skill action must belong
//      to the session (its queue) or its club, not just "the caller organizes
//      some session".
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
import { isPlayerInSessionScope } from "@/app/actions/_shared";
import { createSession, joinAsCoOrganizer } from "@/app/actions/sessions";

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
function serviceClient(responses: Resp[]) {
  let i = 0;
  return { from: vi.fn(() => builder(responses[i++] ?? { data: null, error: null })) };
}

function authedAs(user: { id: string } | null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) } };
}

beforeEach(() => vi.clearAllMocks());

// ── #1 target-scope helper ────────────────────────────────────
describe("TG-SCOPE: isPlayerInSessionScope", () => {
  it("TG-SCOPE-1: false when the session does not exist", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      serviceClient([{ data: null }]) as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(false);
  });

  it("TG-SCOPE-2: true when the target is in the session queue", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      serviceClient([
        { data: { club_id: CLUB_ID } }, // session lookup
        { data: { id: "q1" } }, // queue_entries hit
        { data: null }, // club_members miss
      ]) as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(true);
  });

  it("TG-SCOPE-3: true when the target is an active club member", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      serviceClient([
        { data: { club_id: CLUB_ID } },
        { data: null }, // not in queue
        { data: { id: "m1" } }, // is a club member
      ]) as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(true);
  });

  it("TG-SCOPE-4: false when the target is neither queued nor a member (the attack)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      serviceClient([
        { data: { club_id: CLUB_ID } },
        { data: null },
        { data: null },
      ]) as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await isPlayerInSessionScope(TARGET_ID, SESSION_ID)).toBe(false);
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
  it("TG-RATE-1: locks out after too many recent failed attempts, before any lookup", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    // First service from() call is the user-failure count → over the limit.
    const svc = serviceClient([{ count: 99 }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await joinAsCoOrganizer("SMASH0001");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/too many attempts/i);
    // Only the count query ran — the passcode lookup was never reached.
    expect(svc.from).toHaveBeenCalledTimes(1);
    expect(svc.from).toHaveBeenCalledWith("co_organizer_join_attempts");
  });

  it("TG-RATE-2: a wrong passcode under the limit is recorded as a failed attempt", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    // count under limit → lookup runs → no matching session → records failure.
    const svc = serviceClient([
      { count: 0 }, // user-failure count
      { data: null }, // sessions lookup: no match
      { data: null }, // insert attempt row (recordAttempt)
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await joinAsCoOrganizer("WRONG9999");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/invalid passcode/i);
    // count → sessions → insert(attempt)
    const tables = svc.from.mock.calls.map((c: unknown[]) => c[0]);
    expect(tables).toEqual([
      "co_organizer_join_attempts",
      "sessions",
      "co_organizer_join_attempts",
    ]);
  });
});
