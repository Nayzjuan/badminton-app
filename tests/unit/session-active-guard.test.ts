// ============================================================
// Suite SA — isSessionActive (the closed-session write guard)
// ============================================================
// WHY THIS FILE EXISTS
//
// isSessionActive is the only thing standing between a stale client and a
// write into a session that has already ended. Production has the rows that
// prove the client exists: queue entries created 46.7 s and 2.2 s AFTER their
// session's `ended_at`, both from the Join Queue button.
//
// It had no test at any altitude. Every unit file that reaches one of its six
// call sites `vi.mock`s it, so the real function was never executed by
// anything. Changing `return data.is_active;` to `return true;` — the guard
// never bites, every post-close write is admitted — left the entire unit
// suite green.
//
// The fail-OPEN branch is the part that most needs pinning. `if (error ||
// !data) return true;` is deliberate: a transient read failure must not
// freeze a live session's queue. But it is indistinguishable from a bug on
// sight, and a later reader "hardening" it to fail-closed would break the
// queue for every player the moment Supabase hiccups. SA-4 and SA-5 make that
// change announce itself.
//
//   SA-1  open session   → true
//   SA-2  closed session → false  (the guard actually biting)
//   SA-3  bound by id    → the lookup filters on the session it was asked about
//   SA-4  read error     → true  (fail-open, INTENTIONAL)
//   SA-5  no such row    → true  (fail-open, INTENTIONAL)
//   SA-6  service client → RLS must not be able to blind the guard
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { createServiceClient } from "@/utils/supabase/service";
import { isSessionActive } from "@/app/actions/_shared";

const SESSION_ID = "00000000-0000-4000-8000-0000000005e5";

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };

function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  b["select"] = (cols: string) => {
    ops.push(`select:${cols}`);
    return b;
  };
  b["eq"] = (col: string, val: unknown) => {
    ops.push(`eq:${col}=${String(val)}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

function useService(resp: Resp): { recorded: Recorded[]; from: ReturnType<typeof vi.fn> } {
  const recorded: Recorded[] = [];
  const from = vi.fn((table: string) => {
    const entry: Recorded = { table, ops: [] };
    recorded.push(entry);
    return builder(resp, entry.ops);
  });
  vi.mocked(createServiceClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof createServiceClient>);
  return { recorded, from };
}

beforeEach(() => vi.clearAllMocks());

describe("Suite SA — isSessionActive", () => {
  it("SA-1: returns true for a session that is still running", async () => {
    useService({ data: { is_active: true }, error: null });
    expect(await isSessionActive(SESSION_ID)).toBe(true);
  });

  it("SA-2 (negative): returns false for a session that has been closed", async () => {
    // This is the whole point of the guard. If it ever stops returning false
    // here, every guarded action starts admitting post-close writes again.
    useService({ data: { is_active: false }, error: null });
    expect(await isSessionActive(SESSION_ID)).toBe(false);
  });

  it("SA-3: the lookup is bound to the session id it was asked about", async () => {
    const { recorded } = useService({ data: { is_active: false }, error: null });

    await isSessionActive(SESSION_ID);

    const read = recorded.find((r) => r.table === "sessions");
    expect(read, "isSessionActive never read the sessions table").toBeDefined();
    // Without the column=value pairing, a guard that read some OTHER session's
    // is_active would answer confidently and wrongly, and a table-name-only
    // assertion would not notice.
    expect(read!.ops).toContain(`eq:id=${SESSION_ID}`);
  });

  it("SA-4: fails OPEN on a read error — this is intentional, not a bug", async () => {
    // A transient Supabase error must not freeze a live session's queue. The
    // close path has its own guards; the cost of one late row is far below the
    // cost of the queue refusing to work mid-session. If someone "hardens"
    // this to fail closed, this test is where that decision surfaces.
    useService({ data: null, error: { message: "network" } });
    expect(await isSessionActive(SESSION_ID)).toBe(true);
  });

  it("SA-5: fails OPEN when no row comes back — also intentional", async () => {
    useService({ data: null, error: null });
    expect(await isSessionActive(SESSION_ID)).toBe(true);
  });

  it("SA-6: reads through the service client so RLS cannot blind the guard", async () => {
    useService({ data: { is_active: false }, error: null });

    await isSessionActive(SESSION_ID);

    // Under an RLS-bound client, a caller who cannot see the session row gets
    // `data: null` — which the fail-open branch turns into "active". A guard
    // that fails open MUST read with a client that can always see the row, or
    // the two behaviours combine into a guard that never bites for exactly
    // the callers it is meant to stop.
    expect(createServiceClient).toHaveBeenCalled();
  });
});
