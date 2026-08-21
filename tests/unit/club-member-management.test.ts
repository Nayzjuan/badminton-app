// ============================================================
// Suite CM — club membership & role management (mocked service client, no DB)
// ============================================================
// WHY THIS FILE EXISTS
//
// Before it, `src/app/actions/clubs.ts` had ZERO tests. Not thin coverage —
// none: no test in the repo referenced createClub, createClubInvite,
// acceptClubInvite, leaveClub, removeMember, restoreMember or changeMemberRole.
// That module decides who can remove a member, who can promote someone to
// owner, and whether a one-time invite can be redeemed twice. It is the most
// security-sensitive untested surface in src/.
//
// The suite is deliberately negative-heavy. Proving an owner CAN remove an
// admin is nearly worthless on its own — every one of these actions fails
// open if a guard is dropped, and a dropped guard still returns
// { success: true }. So each refusal is asserted by its exact message AND by
// the absence of the write, because an action that refuses in its return value
// while still performing the mutation is the exact shape of a security bug.
//
// Two assertions here are about query SHAPE rather than result, and they are
// the ones that catch this repo's most-repeated security defect
// ("authorize on A, operate on B"):
//   - CM-16 asserts the target lookup filters on club_id, so a member row id
//     from another club cannot be operated on.
//   - CM-14 asserts p_expected_role reaches the RPC, so the hierarchy re-check
//     under the row lock (the TOCTOU guard) cannot be silently dropped.
// A mock cannot enforce either — but it can prove the code still asks for them,
// which is what a regression guard is for.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient }));

const { getAuthenticatedUser } = vi.hoisted(() => ({ getAuthenticatedUser: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({ getAuthenticatedUser }));

const { getClubRole, isClubAdmin } = vi.hoisted(() => ({
  getClubRole: vi.fn(),
  isClubAdmin: vi.fn(),
}));
vi.mock("@/lib/clubs", () => ({ getClubRole, isClubAdmin }));

const { isPlatformOwner } = vi.hoisted(() => ({ isPlatformOwner: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isPlatformOwner }));

// isValidUUID and the slug helpers are NOT mocked — they are pure, and the
// invalid-id refusals below are only meaningful against the real validator.

import {
  createClub,
  createClubInvite,
  acceptClubInvite,
  leaveClub,
  removeMember,
  restoreMember,
  changeMemberRole,
} from "@/app/actions/clubs";

// ── Fixtures ────────────────────────────────────────────────
const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CLUB_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ROW_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_PLAYER_ID = "55555555-5555-4555-8555-555555555555";
const SLUG = "chillax";

type Res = { data?: unknown; error?: unknown };

/**
 * Chainable PostgREST stub. Every builder method records itself and returns
 * `this`; the object is thenable so a chain that is awaited without a
 * terminator (`.update(...).eq(...)`) resolves to the same configured result
 * as one ending in `.maybeSingle()`.
 *
 * Results are configured as a QUEUE per table and consumed in call order, so
 * an action that hits the same table twice (acceptClubInvite: read the invite,
 * then consume it) can be given a different result for each hit.
 */
class Chain implements PromiseLike<Res> {
  constructor(
    private readonly result: Res,
    private readonly rec: (method: string, args: unknown[]) => void
  ) {}
  private step(method: string, args: unknown[]): this {
    this.rec(method, args);
    return this;
  }
  select(...a: unknown[]) {
    return this.step("select", a);
  }
  insert(...a: unknown[]) {
    return this.step("insert", a);
  }
  update(...a: unknown[]) {
    return this.step("update", a);
  }
  delete(...a: unknown[]) {
    return this.step("delete", a);
  }
  eq(...a: unknown[]) {
    return this.step("eq", a);
  }
  is(...a: unknown[]) {
    return this.step("is", a);
  }
  in(...a: unknown[]) {
    return this.step("in", a);
  }
  order(...a: unknown[]) {
    return this.step("order", a);
  }
  limit(...a: unknown[]) {
    return this.step("limit", a);
  }
  async maybeSingle(): Promise<Res> {
    return this.result;
  }
  async single(): Promise<Res> {
    return this.result;
  }
  then<A = Res, B = never>(
    onfulfilled?: ((v: Res) => A | PromiseLike<A>) | null,
    onrejected?: ((r: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

type Call = { table: string; method: string; args: unknown[] };

type DbCfg = {
  /** Per-table response queue, consumed in order. Last entry repeats. */
  tables?: Record<string, Res[]>;
  /** Per-RPC-name response. */
  rpc?: Record<string, Res>;
};

function makeDb(cfg: DbCfg) {
  const calls: Call[] = [];
  const rpcSpy = vi.fn(async (name: string, args: unknown) => {
    calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
    return cfg.rpc?.[name] ?? { data: { success: true }, error: null };
  });
  const cursors: Record<string, number> = {};
  const client = {
    from(table: string) {
      const queue = cfg.tables?.[table] ?? [{ data: null, error: null }];
      const i = cursors[table] ?? 0;
      cursors[table] = i + 1;
      const result = queue[Math.min(i, queue.length - 1)];
      return new Chain(result, (method, args) => calls.push({ table, method, args }));
    },
    rpc: rpcSpy,
  };
  return { client, calls, rpcSpy };
}

/** Installs the stub and returns the recorder handles. */
function withDb(cfg: DbCfg) {
  const h = makeDb(cfg);
  createServiceClient.mockReturnValue(h.client as never);
  return h;
}

/** Every write method this module can perform. */
const WRITE_METHODS = new Set(["insert", "update", "delete", "rpc"]);
const writes = (calls: Call[]) => calls.filter((c) => WRITE_METHODS.has(c.method));

/** An active target row as removeMember/changeMemberRole select it. */
const targetRow = (role: string) => ({
  data: { id: MEMBER_ROW_ID, player_id: TARGET_PLAYER_ID, role },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue({ id: ACTOR_ID });
  isPlatformOwner.mockReturnValue(false);
  isClubAdmin.mockResolvedValue(false);
  getClubRole.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────
// createClub — platform-owner privilege
// ─────────────────────────────────────────────────────────────
describe("Suite CM — createClub", () => {
  it("CM-1 (negative): an unauthenticated caller is refused and writes nothing", async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    const { calls } = withDb({});

    const res = await createClub({ name: "New Club" });

    expect(res.success).toBe(false);
    expect(res.message).toBe("Not authenticated.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-2 (negative): a signed-in non-platform-owner cannot create a club", async () => {
    isPlatformOwner.mockReturnValue(false);
    const { calls } = withDb({});

    const res = await createClub({ name: "Rogue Club" });

    expect(res.success).toBe(false);
    expect(res.message).toBe("Only the platform owner can create clubs.");
    // The refusal must also mean no club row exists. A guard that returns
    // success:false *after* inserting would still leak a club.
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-3 (negative): a blank club name is refused before any write", async () => {
    isPlatformOwner.mockReturnValue(true);
    const { calls } = withDb({});

    const res = await createClub({ name: "   " });

    expect(res.success).toBe(false);
    expect(res.message).toBe("Club name is required.");
    expect(writes(calls)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// createClubInvite — the grantable-role cap
// ─────────────────────────────────────────────────────────────
describe("Suite CM — createClubInvite", () => {
  it("CM-4 (negative): a non-admin cannot mint an invite", async () => {
    isClubAdmin.mockResolvedValue(false);
    const { calls } = withDb({});

    const res = await createClubInvite({ clubId: CLUB_ID });

    expect(res.success).toBe(false);
    expect(res.message).toBe("Only club owners and admins can create invites.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-5 (negative): an invite can never grant 'owner' — the role is capped", async () => {
    isClubAdmin.mockResolvedValue(true);
    const { calls } = withDb({ tables: { club_invites: [{ data: null, error: null }] } });

    // 'owner' is not a grantable invite role: ownership transfer is not an
    // invite operation. The cap is silent (no error), so only the persisted
    // row proves it held.
    const res = await createClubInvite({ clubId: CLUB_ID, role: "owner" as never });

    expect(res.success).toBe(true);
    const inserted = calls.find((c) => c.method === "insert");
    expect(inserted, "no invite row was inserted").toBeDefined();
    expect((inserted!.args[0] as { role: string }).role).toBe("member");
  });

  it("CM-6: an explicit 'admin' invite is honoured", async () => {
    isClubAdmin.mockResolvedValue(true);
    const { calls } = withDb({ tables: { club_invites: [{ data: null, error: null }] } });

    const res = await createClubInvite({ clubId: CLUB_ID, role: "admin" });

    expect(res.success).toBe(true);
    const inserted = calls.find((c) => c.method === "insert");
    expect((inserted!.args[0] as { role: string }).role).toBe("admin");
  });

  it("CM-7 (negative): a malformed clubId is refused by the real UUID validator", async () => {
    isClubAdmin.mockResolvedValue(true);
    const { calls } = withDb({});

    const res = await createClubInvite({ clubId: "not-a-uuid" });

    expect(res.success).toBe(false);
    expect(res.message).toBe("Invalid club.");
    expect(writes(calls)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// acceptClubInvite — one-time redemption + the privilege clamp
// ─────────────────────────────────────────────────────────────
describe("Suite CM — acceptClubInvite", () => {
  const validInvite = {
    id: "66666666-6666-4666-8666-666666666666",
    club_id: CLUB_ID,
    role: "member",
    consumed_at: null,
    expires_at: null,
  };

  it("CM-8 (negative): an already-consumed invite is refused with no membership write", async () => {
    const { calls } = withDb({
      tables: {
        club_invites: [
          { data: { ...validInvite, consumed_at: "2026-01-01T00:00:00Z" }, error: null },
        ],
      },
    });

    const res = await acceptClubInvite("tok");

    expect(res.success).toBe(false);
    expect(res.message).toBe("This invite has already been used.");
    expect(calls.filter((c) => c.table === "club_members")).toHaveLength(0);
  });

  it("CM-9 (negative): an expired invite is refused with no membership write", async () => {
    const { calls } = withDb({
      tables: {
        club_invites: [
          {
            data: { ...validInvite, expires_at: new Date(Date.now() - 60_000).toISOString() },
            error: null,
          },
        ],
      },
    });

    const res = await acceptClubInvite("tok");

    expect(res.success).toBe(false);
    expect(res.message).toBe("This invite has expired.");
    expect(calls.filter((c) => c.table === "club_members")).toHaveLength(0);
  });

  it("CM-10 (negative): losing the consume race grants nothing", async () => {
    // The conditional UPDATE ... WHERE consumed_at IS NULL returned zero rows,
    // meaning another tab redeemed the same one-time link first. This is the
    // multi-redeem race: the loser must NOT be seated.
    const { calls } = withDb({
      tables: {
        club_invites: [
          { data: validInvite, error: null },
          { data: [], error: null }, // consume update matched 0 rows
        ],
        clubs: [{ data: { slug: SLUG }, error: null }],
      },
    });

    const res = await acceptClubInvite("tok");

    expect(res.success).toBe(false);
    expect(res.message).toBe("This invite has already been used.");
    expect(calls.filter((c) => c.table === "club_members")).toHaveLength(0);
  });

  it("CM-11 (negative): a transient invite-lookup error is retryable, not 'invalid link'", async () => {
    // A dead-end message for a retryable condition strands a legitimate joiner.
    const { calls } = withDb({
      tables: { club_invites: [{ data: null, error: { message: "timeout" } }] },
    });

    const res = await acceptClubInvite("tok");

    expect(res.success).toBe(false);
    expect(res.message).toBe("Something went wrong. Please try again.");
    expect(res.message).not.toBe("This invite link is not valid.");
    expect(calls.filter((c) => c.table === "club_members")).toHaveLength(0);
  });

  it("CM-12: a 'member' invite cannot reinstate a removed OWNER — the role is clamped down", async () => {
    // The clamp is min(prior, invite). Without it, anyone holding a plain
    // member link could restore a previously-removed owner to full ownership.
    const { calls } = withDb({
      tables: {
        club_invites: [
          { data: validInvite, error: null },
          { data: [{ id: validInvite.id }], error: null },
        ],
        clubs: [{ data: { slug: SLUG }, error: null }],
        club_members: [
          { data: { id: MEMBER_ROW_ID, is_active: false, role: "owner" }, error: null },
          { data: null, error: null },
        ],
      },
    });

    const res = await acceptClubInvite("tok");

    expect(res.success).toBe(true);
    const update = calls.find((c) => c.table === "club_members" && c.method === "update");
    expect(update, "the removed member was never reactivated").toBeDefined();
    expect(update!.args[0]).toMatchObject({ is_active: true, role: "member" });
  });

  it("CM-13: an 'admin' invite does not promote a removed plain member", async () => {
    // The same clamp in the other direction: min('member', 'admin') = 'member'.
    const adminInvite = { ...validInvite, role: "admin" };
    const { calls } = withDb({
      tables: {
        club_invites: [
          { data: adminInvite, error: null },
          { data: [{ id: adminInvite.id }], error: null },
        ],
        clubs: [{ data: { slug: SLUG }, error: null }],
        club_members: [
          { data: { id: MEMBER_ROW_ID, is_active: false, role: "member" }, error: null },
          { data: null, error: null },
        ],
      },
    });

    const res = await acceptClubInvite("tok");

    expect(res.success).toBe(true);
    const update = calls.find((c) => c.table === "club_members" && c.method === "update");
    expect(update!.args[0]).toMatchObject({ is_active: true, role: "member" });
  });
});

// ─────────────────────────────────────────────────────────────
// removeMember — the permission hierarchy
// ─────────────────────────────────────────────────────────────
describe("Suite CM — removeMember", () => {
  it("CM-14 (negative): an unauthenticated caller removes nobody", async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    const { calls } = withDb({});

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Not authenticated.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-15 (negative): a plain member cannot remove anyone", async () => {
    getClubRole.mockResolvedValue("member");
    const { calls } = withDb({ tables: { club_members: [targetRow("member")] } });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Only club owners and admins can remove members.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-16 (negative): an admin cannot remove another admin", async () => {
    getClubRole.mockResolvedValue("admin");
    const { calls, rpcSpy } = withDb({ tables: { club_members: [targetRow("admin")] } });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Admins can only remove plain members.");
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-17 (negative): an admin cannot remove an owner", async () => {
    getClubRole.mockResolvedValue("admin");
    const { rpcSpy } = withDb({ tables: { club_members: [targetRow("owner")] } });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("CM-18 (negative): nobody removes themselves through this action", async () => {
    getClubRole.mockResolvedValue("owner");
    const { rpcSpy } = withDb({
      tables: {
        club_members: [
          { data: { id: MEMBER_ROW_ID, player_id: ACTOR_ID, role: "owner" }, error: null },
        ],
      },
    });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Use the Leave club option to remove yourself.");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("CM-19 (negative): a member row id from another club is not operated on", async () => {
    // The binding that makes this safe is the `.eq('club_id', clubId)` filter on
    // the target lookup — authorize on the club, then read the row THROUGH that
    // club. A mock cannot enforce the filter, so assert the code still applies
    // it: dropping it is this repo's most-repeated security defect.
    getClubRole.mockResolvedValue("owner");
    const { calls } = withDb({ tables: { club_members: [{ data: null, error: null }] } });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("That member is not active in this club.");

    const eqFilters = calls
      .filter((c) => c.table === "club_members" && c.method === "eq")
      .map((c) => c.args[0]);
    expect(eqFilters, "target lookup is not bound to the authorized club").toContain("club_id");
    expect(eqFilters).toContain("id");
    // And the club it is bound to must be the one that was authorized.
    const clubFilter = calls.find(
      (c) => c.table === "club_members" && c.method === "eq" && c.args[0] === "club_id"
    );
    expect(clubFilter!.args[1]).toBe(CLUB_ID);
    expect(clubFilter!.args[1]).not.toBe(OTHER_CLUB_ID);
  });

  it("CM-20: an owner removing an admin re-checks the role under the lock", async () => {
    // p_expected_role is the TOCTOU guard: the hierarchy was checked against a
    // row read before the lock, so the RPC re-checks it while holding one.
    // Dropping the argument silently reopens the race.
    getClubRole.mockResolvedValue("owner");
    const { rpcSpy } = withDb({
      tables: { club_members: [targetRow("admin")] },
      rpc: { club_member_deactivate: { data: { success: true }, error: null } },
    });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(true);
    expect(rpcSpy).toHaveBeenCalledWith(
      "club_member_deactivate",
      expect.objectContaining({
        p_club_id: CLUB_ID,
        p_member_id: MEMBER_ROW_ID,
        p_expected_role: "admin",
      })
    );
  });

  it("CM-21 (negative): the club's only owner cannot be removed", async () => {
    getClubRole.mockResolvedValue("owner");
    withDb({
      tables: { club_members: [targetRow("owner")] },
      rpc: {
        club_member_deactivate: { data: { success: false, reason: "only_owner" }, error: null },
      },
    });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Can't remove the club's only owner.");
  });

  it("CM-22 (negative): a role that changed under the lock reports the race, not a generic failure", async () => {
    getClubRole.mockResolvedValue("owner");
    withDb({
      tables: { club_members: [targetRow("admin")] },
      rpc: {
        club_member_deactivate: { data: { success: false, reason: "role_changed" }, error: null },
      },
    });

    const res = await removeMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("That member's role just changed — refresh and try again.");
  });
});

// ─────────────────────────────────────────────────────────────
// restoreMember — same hierarchy, opposite direction
// ─────────────────────────────────────────────────────────────
describe("Suite CM — restoreMember", () => {
  it("CM-23 (negative): an admin cannot restore an admin", async () => {
    getClubRole.mockResolvedValue("admin");
    const { calls } = withDb({ tables: { club_members: [targetRow("admin")] } });

    const res = await restoreMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Admins can only restore plain members.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-24 (negative): a plain member cannot restore anyone", async () => {
    getClubRole.mockResolvedValue("member");
    const { calls } = withDb({ tables: { club_members: [targetRow("member")] } });

    const res = await restoreMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Only club owners and admins can restore members.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-25: an owner restoring a removed member binds the update to the club", async () => {
    getClubRole.mockResolvedValue("owner");
    const { calls } = withDb({ tables: { club_members: [targetRow("member")] } });

    const res = await restoreMember(CLUB_ID, MEMBER_ROW_ID, SLUG);

    expect(res.success).toBe(true);
    const update = calls.find((c) => c.table === "club_members" && c.method === "update");
    expect(update!.args[0]).toMatchObject({ is_active: true });
    // Same authorize-on-A / operate-on-B binding as CM-19, on the write path.
    const eqAfterUpdate = calls
      .slice(calls.indexOf(update!))
      .filter((c) => c.method === "eq")
      .map((c) => c.args[0]);
    expect(eqAfterUpdate).toContain("club_id");
  });
});

// ─────────────────────────────────────────────────────────────
// changeMemberRole — owner-only, and the last-owner guard
// ─────────────────────────────────────────────────────────────
describe("Suite CM — changeMemberRole", () => {
  it("CM-26 (negative): an admin cannot change roles — this action is owner-only", async () => {
    getClubRole.mockResolvedValue("admin");
    const { rpcSpy, calls } = withDb({ tables: { club_members: [targetRow("member")] } });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "admin", SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Only club owners can change roles.");
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-27 (negative): an admin cannot promote anyone to owner", async () => {
    // The escalation this action exists to prevent: admin → self-serve owner.
    getClubRole.mockResolvedValue("admin");
    const { rpcSpy } = withDb({ tables: { club_members: [targetRow("member")] } });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "owner", SLUG);

    expect(res.success).toBe(false);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("CM-28 (negative): an unrecognised role string is refused before any write", async () => {
    getClubRole.mockResolvedValue("owner");
    const { rpcSpy, calls } = withDb({ tables: { club_members: [targetRow("member")] } });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "superuser" as never, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Invalid role.");
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(writes(calls)).toHaveLength(0);
  });

  it("CM-29 (negative): an owner cannot change their own role", async () => {
    getClubRole.mockResolvedValue("owner");
    const { rpcSpy } = withDb({
      tables: {
        club_members: [
          { data: { id: MEMBER_ROW_ID, player_id: ACTOR_ID, role: "owner" }, error: null },
        ],
      },
    });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "member", SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("You can't change your own role.");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("CM-30: a no-op role change succeeds without touching the RPC", async () => {
    getClubRole.mockResolvedValue("owner");
    const { rpcSpy } = withDb({ tables: { club_members: [targetRow("admin")] } });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "admin", SLUG);

    expect(res.success).toBe(true);
    expect(res.message).toBe("No change.");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("CM-31 (negative): demoting the club's only owner is blocked", async () => {
    getClubRole.mockResolvedValue("owner");
    withDb({
      tables: { club_members: [targetRow("owner")] },
      rpc: {
        club_member_set_role: { data: { success: false, reason: "only_owner" }, error: null },
      },
    });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "member", SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Can't demote the club's only owner.");
  });

  it("CM-32: a valid promotion re-checks the prior role under the lock", async () => {
    getClubRole.mockResolvedValue("owner");
    const { rpcSpy } = withDb({
      tables: { club_members: [targetRow("member")] },
      rpc: { club_member_set_role: { data: { success: true }, error: null } },
    });

    const res = await changeMemberRole(CLUB_ID, MEMBER_ROW_ID, "admin", SLUG);

    expect(res.success).toBe(true);
    expect(rpcSpy).toHaveBeenCalledWith(
      "club_member_set_role",
      expect.objectContaining({
        p_club_id: CLUB_ID,
        p_member_id: MEMBER_ROW_ID,
        p_new_role: "admin",
        p_expected_role: "member",
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────
// leaveClub — self-service exit
// ─────────────────────────────────────────────────────────────
describe("Suite CM — leaveClub", () => {
  it("CM-33 (negative): a non-member cannot leave a club they were never in", async () => {
    const { rpcSpy } = withDb({ tables: { club_members: [{ data: null, error: null }] } });

    const res = await leaveClub(CLUB_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("You're not a member of this club.");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("CM-34 (negative): the only owner must hand off before leaving", async () => {
    // Without this the club is left ownerless and unadministrable — nobody can
    // promote anyone, because promotion is owner-only (CM-26).
    withDb({
      tables: { club_members: [{ data: { id: MEMBER_ROW_ID, role: "owner" }, error: null }] },
      rpc: {
        club_member_deactivate: { data: { success: false, reason: "only_owner" }, error: null },
      },
    });

    const res = await leaveClub(CLUB_ID, SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe(
      "You're the only owner — promote someone else to owner before leaving."
    );
  });

  it("CM-35 (negative): a malformed clubId is refused before any lookup", async () => {
    const { calls } = withDb({});

    const res = await leaveClub("not-a-uuid", SLUG);

    expect(res.success).toBe(false);
    expect(res.message).toBe("Invalid club.");
    expect(calls).toHaveLength(0);
  });

  it("CM-36: an owner with a co-owner may leave", async () => {
    withDb({
      tables: { club_members: [{ data: { id: MEMBER_ROW_ID, role: "owner" }, error: null }] },
      rpc: { club_member_deactivate: { data: { success: true }, error: null } },
    });

    const res = await leaveClub(CLUB_ID, SLUG);

    expect(res.success).toBe(true);
    expect(res.message).toBe("You've left the club.");
  });
});
