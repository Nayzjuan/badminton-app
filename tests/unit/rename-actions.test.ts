// ============================================================
// Rename server actions — the availability ladder and the commit RPC
// ============================================================
// src/app/actions/rename.ts is the entire server surface of the forced
// duplicate-name flow. Two things about it are load-bearing and neither is
// visible to a type checker:
//
//   1. THE CODE, NOT THE MESSAGE, IS THE API. rename-screen.tsx branches on
//      `code` ("invalid" | "reused" | "taken" go to the inline field state and
//      pick the tone; anything else goes to the submit banner). Every rung of
//      the ladder and every RPC failure has to keep its OWN code, so a test
//      that only checks `success: false` cannot see two rungs collapse into
//      one.
//   2. THE ORDER OF THE LADDER IS THE SECURITY AND COST PROPERTY. auth → Zod →
//      R1 (persisted collided_name) → R2 (global uniqueness). Reordering it is
//      invisible to every happy-path assertion, so the negatives here assert
//      what did NOT run: no service client for an unauthenticated or malformed
//      caller, no R2 read once R1 has already refused.
//
// Both exports derive the player id from the authenticated session — there is
// no caller-supplied id in this module and none may be introduced. RN-9 and
// RN-16 pin that by recording which column the read was bound to and which
// arguments the RPC received.
//
// Supabase clients are mocked. The recording builder captures `select:<cols>`
// and `<op>:<column>=<value>` so a read can be asserted against the column it
// was bound to, matching tests/unit/tenancy-guards.test.ts.
//
// Suite RN — checkNameAvailable (RN-1…RN-11), renamePlayer (RN-12…RN-22):
//   RN-1  (negative) an unauthenticated caller is refused before any DB work
//   RN-2  (negative) an invalid name never reaches the database (2 scenarios)
//   RN-3  (edge)     undefined is coerced to "" before parsing, not passed raw
//   RN-4  (happy)    a valid, unclaimed name is available; one read, no more
//   RN-5  (negative) R1 outranks R2 — collided_name wins over "also taken"
//   RN-6  (negative) R1 compares by NORMALIZED key, not raw string (2 cases)
//   RN-7  (edge)     a near-miss of the collided name is NOT reuse
//   RN-8  (edge)     a missing / unreadable profile row falls through to R2
//   RN-9  (negative) the R1 lookup is bound to the CALLER's own id
//   RN-10 (negative) a globally taken name is "taken" and quotes the PARSED name
//   RN-11 (negative) R2 gets the SERVICE client, the PARSED name, and the self-exclusion
//   RN-12 (negative) renamePlayer refuses an unauthed caller with "error", not "invalid"
//   RN-13 (negative) an invalid name is rejected before the RPC (2 scenarios)
//   RN-14 (edge)     renamePlayer coerces undefined to "" before parsing
//   RN-15 (happy)    a successful RPC returns exactly { success: true }
//   RN-16 (negative) the RPC is bound to the caller's OWN id and the PARSED name
//   RN-17            RPC "reused_dup_name" → code "reused"
//   RN-18            RPC "name_taken" → code "taken", message quotes the PARSED name
//   RN-19            RPC "profile_not_found" keeps its OWN message
//   RN-20 (edge)     an unknown RPC error string falls to the default arm
//   RN-21 (edge)     a null RPC payload is a failure and does not throw
//   RN-22 (negative) a transport error outranks the payload, mappable or not (2 scenarios)
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// R2's read is its own unit (tests/unit/dup-name.test.ts). Stub it so this
// suite can assert WHETHER and HOW it was called without also re-testing it.
vi.mock("@/lib/dup-name", () => ({ isNameTaken: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isNameTaken } from "@/lib/dup-name";
import { checkNameAvailable, renamePlayer } from "@/app/actions/rename";
import type { NameCheckResult, RenameResult } from "@/app/actions/rename";

const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };

// The action logs the underlying transport failure and returns a friendly
// string; silence it so a passing run has a clean transcript, but keep the
// handle so RN-22 can prove the reason was not swallowed.
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

type Resp = { data?: unknown; error?: unknown };
type TableRead = { table: string; ops: string[] };
type RpcCall = { fn: string; args: Record<string, unknown> };

/**
 * Service client that records every table touched, every filter column a read
 * was bound to, and every rpc() call — then resolves reads to `profile` and
 * rpc() to `rpc`.
 */
function serviceClient(opts: { profile?: Resp; rpc?: Resp } = {}) {
  const profileResp: Resp = opts.profile ?? { data: null, error: null };
  const rpcResp: Resp = opts.rpc ?? { data: null, error: null };

  const reads: TableRead[] = [];
  const rpcCalls: RpcCall[] = [];

  const from = vi.fn((table: string) => {
    const rec: TableRead = { table, ops: [] };
    reads.push(rec);

    const b: Record<string, unknown> = {};
    b.select = (cols: string) => {
      rec.ops.push(`select:${cols}`);
      return b;
    };
    for (const m of ["eq", "neq", "ilike", "in", "or", "gte", "lte", "order", "limit"]) {
      b[m] = (col: unknown, val: unknown) => {
        rec.ops.push(`${m}:${String(col)}=${String(val)}`);
        return b;
      };
    }
    b.maybeSingle = () => Promise.resolve(profileResp);
    b.single = () => Promise.resolve(profileResp);
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(profileResp).then(res, rej);
    return b;
  });

  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve(rpcResp);
  });

  return {
    from,
    rpc,
    rpcCalls,
    tables: () => reads.map((r) => r.table),
    opsFor: (table: string) => reads.filter((r) => r.table === table).flatMap((r) => r.ops),
  };
}

type MockService = ReturnType<typeof serviceClient>;

/**
 * Install `svc` as the service client and hand back the reference the action
 * will actually receive, so identity (not deep equality) can be asserted.
 */
function useServiceClient(svc: MockService): Parameters<typeof isNameTaken>[0] {
  vi.mocked(createServiceClient).mockReturnValue(
    svc as unknown as ReturnType<typeof createServiceClient>
  );
  return svc as unknown as Parameters<typeof isNameTaken>[0];
}

function authedAs(user: { id: string } | null) {
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
}

/** Narrow to the refusal arm, failing loudly (not silently) if it is missing. */
function refused(r: NameCheckResult): Extract<NameCheckResult, { available: false }> {
  if (r.available) throw new Error("expected the name to be refused, but it came back available");
  return r;
}

function failed(r: RenameResult): Extract<RenameResult, { success: false }> {
  if (r.success) throw new Error("expected the rename to fail, but it reported success");
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nobody else holds the name. Every test that cares overrides this.
  vi.mocked(isNameTaken).mockResolvedValue(false);
});

// ── checkNameAvailable — rung 0: authentication ───────────────
describe("RN: checkNameAvailable auth gate", () => {
  it("RN-1 (negative): an unauthenticated caller is refused before any DB work", async () => {
    authedAs(null);

    const r = await checkNameAvailable("Juan Cruz");

    expect(r).toEqual({ available: false, code: "invalid", message: "Not signed in." });
    expect(
      vi.mocked(createServiceClient),
      "a service client was built despite the auth gate failing"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(isNameTaken),
      "an anonymous caller reached the global uniqueness read"
    ).not.toHaveBeenCalled();
  });
});

// ── checkNameAvailable — rung 1: shape ────────────────────────
describe("RN: checkNameAvailable shape gate", () => {
  beforeEach(() => authedAs(CALLER));

  it("RN-2 (negative): an invalid name never reaches the database", async () => {
    // (a) too short — the min-length issue.
    const short = refused(await checkNameAvailable("ab"));
    expect(short.code).toBe("invalid");
    expect(short.message).toBe("Name must be at least 3 characters.");

    // (b) illegal characters — a DIFFERENT issue. Two distinct messages prove
    // the action forwards Zod's first issue rather than a hard-coded string.
    const bad = refused(await checkNameAvailable("Juan@Cruz"));
    expect(bad.code).toBe("invalid");
    expect(bad.message).toBe("Keep it simple: letters, numbers, and spaces only. Please remove: @");

    expect(
      vi.mocked(createServiceClient),
      "a Zod failure still built a service client — the DB rung ran before the shape rung"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(isNameTaken),
      "a malformed name reached the global uniqueness read"
    ).not.toHaveBeenCalled();
  });

  it('RN-3 (edge): undefined input is coerced to "" before parsing, not passed raw to Zod', async () => {
    const r = refused(await checkNameAvailable(undefined as unknown as string));

    expect(r.code).toBe("invalid");
    // Without the `?? ""`, zod reports "Invalid input: expected string,
    // received undefined" — internals leaked into a user-facing field error.
    expect(
      r.message,
      "raw undefined reached Zod — the user sees a type error instead of the length rule"
    ).toBe("Name must be at least 3 characters.");
  });
});

// ── checkNameAvailable — rungs 2 and 3: R1 then R2 ────────────
describe("RN: checkNameAvailable R1/R2 ladder", () => {
  beforeEach(() => authedAs(CALLER));

  it("RN-4: a valid, unclaimed name is available", async () => {
    const svc = serviceClient({ profile: { data: { collided_name: null }, error: null } });
    useServiceClient(svc);

    const r = await checkNameAvailable("Juan Cruz");

    expect(r).toEqual({ available: true });
    expect(
      svc.tables(),
      "the clean path must cost exactly one read — the R1 profile lookup"
    ).toEqual(["profiles"]);
  });

  it('RN-5 (negative): R1 outranks R2 — the persisted collided_name is "reused", not "taken"', async () => {
    // Both rungs would fire. The screen shows amber guidance for "reused" and
    // a red error for "taken"; collapsing them tells the player the wrong story.
    const svc = serviceClient({ profile: { data: { collided_name: "Juan Cruz" }, error: null } });
    useServiceClient(svc);
    vi.mocked(isNameTaken).mockResolvedValue(true);

    const r = refused(await checkNameAvailable("Juan Cruz"));

    expect(r.code, "R2 outranked R1 — the ladder is in the wrong order").toBe("reused");
    expect(r.message).toMatch(/name we need to change/);
    expect(
      vi.mocked(isNameTaken),
      "R2 was consulted even though R1 already refused — the ladder is not short-circuiting"
    ).not.toHaveBeenCalled();
  });

  it("RN-6 (negative): R1 compares by NORMALIZED key, not raw string", async () => {
    // (a) the stored collided_name is the messy side.
    useServiceClient(
      serviceClient({ profile: { data: { collided_name: "  juan   CRUZ  " }, error: null } })
    );
    const storedMessy = refused(await checkNameAvailable("Juan Cruz"));
    expect(
      storedMessy.code,
      "a case/whitespace variant of the stored collided_name slipped past R1"
    ).toBe("reused");

    // (b) the candidate is the messy side (Zod collapses it to "juan cruz").
    useServiceClient(
      serviceClient({ profile: { data: { collided_name: "Juan Cruz" }, error: null } })
    );
    const typedMessy = refused(await checkNameAvailable("juan   cruz"));
    expect(typedMessy.code, "re-typing the duplicated name in another case slipped past R1").toBe(
      "reused"
    );
  });

  it("RN-7 (edge): a near-miss of the collided name is not treated as reuse", async () => {
    // The /rename screen's own suggestion chips append a digit. If R1 were a
    // prefix/substring test instead of equality of normalized keys, it would
    // reject every suggestion the screen itself offers.
    const svc = serviceClient({ profile: { data: { collided_name: "Juan Cruz" }, error: null } });
    useServiceClient(svc);

    const r = await checkNameAvailable("Juan Cruz 2");

    expect(r, "R1 refused a suffixed variant — the comparison is not strict equality").toEqual({
      available: true,
    });
  });

  it("RN-8 (edge): a missing profile row — and a profiles read that errors — fall through to R2", async () => {
    // (a) no row at all.
    useServiceClient(serviceClient({ profile: { data: null, error: null } }));
    expect(
      await checkNameAvailable("Juan Cruz"),
      "a missing profile row blocked the rename — an unreadable row must fail OPEN, the unique index is the real R2 authority"
    ).toEqual({ available: true });

    // (b) the read failed; the action destructures only `data`.
    useServiceClient(serviceClient({ profile: { data: null, error: { message: "boom" } } }));
    expect(
      await checkNameAvailable("Juan Cruz"),
      "a transient read error blocked the rename — R1 must fail OPEN"
    ).toEqual({ available: true });
  });

  it("RN-9 (negative): the R1 lookup is bound to the AUTHENTICATED user's id and reads collided_name", async () => {
    const svc = serviceClient({ profile: { data: { collided_name: null }, error: null } });
    useServiceClient(svc);

    await checkNameAvailable("Juan Cruz");

    const ops = svc.opsFor("profiles");
    expect(ops, "the R1 lookup was not bound to the caller's own id").toContain(
      `eq:id=${CALLER.id}`
    );
    expect(ops, "R1 read a column other than collided_name").toContain("select:collided_name");
    expect(svc.tables(), "R1 touched a table other than profiles").toEqual(["profiles"]);
  });

  it('RN-10 (negative): a globally taken name returns code "taken" and quotes the PARSED name', async () => {
    const svc = serviceClient({ profile: { data: { collided_name: null }, error: null } });
    useServiceClient(svc);
    vi.mocked(isNameTaken).mockResolvedValue(true);

    const r = refused(await checkNameAvailable("  Juan   Cruz  "));

    expect(r.code, "a global collision must be red 'taken', not amber 'reused'").toBe("taken");
    expect(r.message, "the message did not quote the parsed name").toContain('"Juan Cruz"');
    expect(
      r.message,
      "the message echoed the raw padded spelling the player typed, not the name that will be stored"
    ).not.toContain("Juan   Cruz");
  });

  it("RN-11 (negative): R2 is handed the SERVICE client, the PARSED name, and the caller's own id", async () => {
    const svc = serviceClient({ profile: { data: { collided_name: null }, error: null } });
    const handle = useServiceClient(svc);

    await checkNameAvailable("  Juan   Cruz  ");

    expect(vi.mocked(isNameTaken)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(isNameTaken).mock.calls[0][0],
      "R2 ran on some other client — only the service role can see across RLS to answer 'is this name taken'"
    ).toBe(handle);
    // Arity-strict on purpose: dropping the self-exclusion makes a player's own
    // current name read as taken, which strands them on the rename screen.
    expect(vi.mocked(isNameTaken)).toHaveBeenCalledWith(handle, "Juan Cruz", CALLER.id);
  });
});

// ── renamePlayer — gates ──────────────────────────────────────
describe("RN: renamePlayer gates", () => {
  it('RN-12 (negative): an unauthenticated caller gets code "error", not "invalid"', async () => {
    authedAs(null);

    const r = failed(await renamePlayer("Juan Cruz"));

    // rename-screen.tsx routes "invalid" | "taken" | "reused" into the inline
    // field state and everything else into the submit banner. A lost session is
    // not a problem with the text in the field, so the discriminator matters.
    expect(r.code, "a lost session was reported as a bad name in the input field").toBe("error");
    expect(r.error).toMatch(/Not signed in/);
    expect(
      vi.mocked(createServiceClient),
      "a service client was built despite the auth gate failing"
    ).not.toHaveBeenCalled();
  });

  it("RN-13 (negative): an invalid name is rejected before the RPC is ever called", async () => {
    authedAs(CALLER);
    const svc = serviceClient({ rpc: { data: { success: true }, error: null } });
    useServiceClient(svc);

    // (a) too short.
    const short = failed(await renamePlayer("ab"));
    expect(short.code).toBe("invalid");
    expect(short.error).toBe("Name must be at least 3 characters.");

    // (b) illegal characters — a different Zod issue, so the action is proven
    // to forward the issue rather than a hard-coded string.
    const bad = failed(await renamePlayer("Juan@Cruz"));
    expect(bad.code).toBe("invalid");
    expect(bad.error).toBe("Keep it simple: letters, numbers, and spaces only. Please remove: @");

    expect(
      vi.mocked(createServiceClient),
      "a service client was built for a name that failed Zod"
    ).not.toHaveBeenCalled();
    expect(svc.rpc, "a malformed name reached the rename RPC").not.toHaveBeenCalled();
  });

  it('RN-14 (edge): renamePlayer coerces undefined to "" before parsing', async () => {
    authedAs(CALLER);

    const r = failed(await renamePlayer(undefined as unknown as string));

    expect(r.code).toBe("invalid");
    expect(
      r.error,
      "raw undefined reached Zod — the submit banner shows a type error instead of the length rule"
    ).toBe("Name must be at least 3 characters.");
  });
});

// ── renamePlayer — the RPC call and its result mapping ────────
describe("RN: renamePlayer RPC binding and failure mapping", () => {
  beforeEach(() => authedAs(CALLER));

  it("RN-15: a successful RPC returns { success: true }", async () => {
    useServiceClient(
      serviceClient({ rpc: { data: { success: true, new_name: "Juan Cruz" }, error: null } })
    );

    expect(await renamePlayer("Juan Cruz")).toEqual({ success: true });
  });

  it("RN-16 (negative): the RPC is bound to the caller's OWN user id and the PARSED name", async () => {
    const svc = serviceClient({
      rpc: { data: { success: true, new_name: "Juan Cruz" }, error: null },
    });
    useServiceClient(svc);

    await renamePlayer("  Juan   Cruz  ");

    expect(svc.rpc).toHaveBeenCalledTimes(1);
    expect(svc.rpcCalls[0].fn).toBe("rename_player_identity");
    // toEqual, not objectContaining: an added parameter — especially a
    // caller-derived one — has to come back to this test before it can ship.
    expect(
      svc.rpcCalls[0].args,
      "the rename RPC must be bound to the authenticated session's id and the parsed name — there is no caller-supplied id in this module and none may be introduced"
    ).toEqual({ p_user_id: CALLER.id, p_new_name: "Juan Cruz" });
  });

  it('RN-17: RPC error "reused_dup_name" maps to code "reused"', async () => {
    useServiceClient(
      serviceClient({ rpc: { data: { success: false, error: "reused_dup_name" }, error: null } })
    );

    const r = failed(await renamePlayer("Juan Cruz"));

    // The server-side R1 re-check losing is recoverable guidance, not a crash:
    // the screen re-renders the amber hint instead of a red failure banner.
    expect(r.code, "the server-side R1 refusal was reported as a generic failure").toBe("reused");
    expect(r.error).toMatch(/name we need to change/);
  });

  it('RN-18: RPC error "name_taken" maps to code "taken" and quotes the PARSED name', async () => {
    useServiceClient(
      serviceClient({ rpc: { data: { success: false, error: "name_taken" }, error: null } })
    );

    const r = failed(await renamePlayer("  Juan   Cruz  "));

    expect(r.code, "a lost uniqueness race was reported as a generic failure").toBe("taken");
    expect(r.error, "the message did not quote the parsed name").toContain('"Juan Cruz"');
    expect(
      r.error,
      "the message echoed the raw padded spelling instead of the name that was actually attempted"
    ).not.toContain("Juan   Cruz");
  });

  it('RN-19: RPC error "profile_not_found" keeps its OWN message', async () => {
    useServiceClient(
      serviceClient({ rpc: { data: { success: false, error: "profile_not_found" }, error: null } })
    );

    const r = failed(await renamePlayer("Juan Cruz"));

    expect(r.code).toBe("error");
    // The code alone is identical to the default arm's, so only the message can
    // see this case disappear — "sign in again" is actionable, "try again" is not.
    expect(r.error, "the profile_not_found arm collapsed into the generic default").toMatch(
      /Profile not found/
    );
    expect(r.error).not.toMatch(/Couldn't save your name/);
  });

  it("RN-20 (edge): an unknown RPC error string falls to the default arm", async () => {
    // The RPC returns jsonb; a future migration can add a code the generated
    // Returns type does not yet name.
    useServiceClient(
      serviceClient({ rpc: { data: { success: false, error: "some_future_code" }, error: null } })
    );

    const r = failed(await renamePlayer("Juan Cruz"));

    expect(r.code, "a future error code must degrade to the generic failure, not to success").toBe(
      "error"
    );
    expect(r.error).toMatch(/Couldn't save your name/);
  });

  it("RN-21 (edge): a null RPC payload with no error is a failure, and the action does not throw", async () => {
    useServiceClient(serviceClient({ rpc: { data: null, error: null } }));

    await expect(
      renamePlayer("Juan Cruz"),
      "a null RPC payload must RESOLVE to a failure — this module's contract is never to throw, and it must never report an unwritten rename as success"
    ).resolves.toEqual({
      success: false,
      code: "error",
      error: "Couldn't save your name. Please try again.",
    });
  });

  it("RN-22 (negative): a transport-level error wins over the payload", async () => {
    // (a) a success-looking body alongside a transport error: if the error
    // branch is dropped, a rename that never reached Postgres is reported as
    // saved.
    useServiceClient(
      serviceClient({
        rpc: { data: { success: true, new_name: "Juan Cruz" }, error: { message: "boom" } },
      })
    );

    const looksSaved = failed(await renamePlayer("Juan Cruz"));

    expect(looksSaved.code, "an unwritten rename was reported as saved").toBe("error");
    expect(looksSaved.error).toMatch(/Couldn't save your name/);
    expect(
      errorSpy,
      "the underlying transport failure was swallowed — nothing in the logs would explain it"
    ).toHaveBeenCalledWith("[renamePlayer] RPC error:", "boom");

    // (b) a MAPPABLE body alongside a transport error. This is the scenario
    // that pins the ORDER: read the payload first and this comes back as the
    // recoverable "taken" (sending the player back to edit a field that is
    // fine) with nothing logged, instead of the generic failure plus the log
    // line that is the only record of why the call actually died.
    errorSpy.mockClear();
    useServiceClient(
      serviceClient({
        rpc: { data: { success: false, error: "name_taken" }, error: { message: "boom" } },
      })
    );

    const alsoMappable = failed(await renamePlayer("Juan Cruz"));

    expect(
      alsoMappable.code,
      "the payload was read before the transport error — a dead RPC was reported as a lost uniqueness race"
    ).toBe("error");
    expect(alsoMappable.error).toMatch(/Couldn't save your name/);
    expect(
      errorSpy,
      "the transport failure went unlogged because the payload short-circuited it"
    ).toHaveBeenCalledWith("[renamePlayer] RPC error:", "boom");
  });
});
