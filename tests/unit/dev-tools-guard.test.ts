// ============================================================
// Suite DV — dev.ts, the two-layer dev-tools guard
// ============================================================
// WHY THIS FILE EXISTS
//
// src/app/actions/dev.ts had no test of any kind, and it is the most
// destructive module in the repo: every one of its three actions writes
// through createServiceClient(), which bypasses RLS entirely, and one of
// them — clearSessionData — DELETES a session's matches, match_games,
// match_players and queue_entries.
//
// Nothing else stands between a caller and that delete. There is no RLS to
// fall back on and no organizer check: the ONLY thing separating "a dev
// seeding fake players" from "any authenticated player wiping a live
// session" is requireAuth()'s three sequential gates.
//
//   Layer 1  process.env.NODE_ENV !== "production"
//   Layer 2  process.env.DEV_TOOLS_ENABLED === "true"   (exact string)
//   Layer 3  getAuthenticatedUser() is non-null
//
// The module's own comment says "BOTH must pass". That claim was untested,
// so the code was free to drift from it. These tests hold each layer alone:
// every negative here flips exactly ONE gate and leaves the other two open,
// which is what distinguishes "this layer works" from "something, somewhere,
// said no".
//
// Each negative also asserts createServiceClient was NEVER CONSTRUCTED. That
// is deliberately stronger than asserting the return value. A guard that runs
// but returns its refusal AFTER building an RLS-bypassing client, or after
// issuing the delete, would satisfy a value-only assertion while having
// already done the damage. Order is the property; the return value is not.
//
// IDs: DV-1 … DV-9
// ============================================================

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/actions/_shared")>();
  return { ...actual, getAuthenticatedUser: vi.fn() };
});

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser } from "@/app/actions/_shared";
import { seedTestData, seedNamedPlayers, clearSessionData } from "@/app/actions/dev";

const SESSION_ID = "00000000-0000-4000-8000-0000000000d1";
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };

/**
 * Chainable builder that records every call as `method:arg`, so a test can
 * assert WHICH column a delete was bound to — not merely that a delete
 * happened. An unbound `.delete()` and a `.delete().eq("session_id", …)` are
 * indistinguishable unless the filter is recorded.
 */
function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["select", "delete", "order"]) b[m] = self;
  b["update"] = (payload: unknown) => {
    ops.push(`update:${JSON.stringify(payload)}`);
    return b;
  };
  for (const m of ["eq", "in", "is"])
    b[m] = (col: string, val: unknown) => {
      ops.push(`${m}:${col}=${JSON.stringify(val)}`);
      return b;
    };
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

function serviceClient(responses: Resp[]) {
  let i = 0;
  const recorded: Recorded[] = [];
  return {
    recorded,
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(responses[i++] ?? { data: null, error: null }, entry.ops);
    }),
  };
}

/** Installs a service client and returns it, for the tests that get that far. */
function installServiceClient(responses: Resp[]) {
  const svc = serviceClient(responses);
  vi.mocked(createServiceClient).mockReturnValue(
    svc as unknown as ReturnType<typeof createServiceClient>
  );
  return svc;
}

/** Opens layers 1–3. Individual tests then close exactly one. */
function unlockAllGates() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_TOOLS_ENABLED", "true");
  vi.mocked(getAuthenticatedUser).mockResolvedValue(
    CALLER as unknown as Awaited<ReturnType<typeof getAuthenticatedUser>>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  unlockAllGates();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Every exported action must be behind the same guard. Testing only one would
// leave the other two free to lose it — which is how a guard added "to dev.ts"
// ends up protecting one third of dev.ts.
const ALL_ACTIONS = [
  { name: "seedTestData", call: () => seedTestData(SESSION_ID, 4) },
  { name: "seedNamedPlayers", call: () => seedNamedPlayers(SESSION_ID) },
  { name: "clearSessionData", call: () => clearSessionData(SESSION_ID) },
] as const;

describe("Suite DV — dev-tools guard", () => {
  // ── Layer 1: NODE_ENV ───────────────────────────────────────
  it("DV-1 (negative): in production every dev action refuses, before any service client exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Layers 2 and 3 are left OPEN on purpose: if this test passed because
    // DEV_TOOLS_ENABLED was unset, it would prove nothing about NODE_ENV.

    for (const { name, call } of ALL_ACTIONS) {
      const res = await call();
      expect(res.success, `${name} succeeded with NODE_ENV=production`).toBe(false);
      expect(res.message, `${name} refused, but not for the production reason`).toBe(
        "Dev tools are disabled in production."
      );
    }

    expect(
      vi.mocked(createServiceClient),
      "an RLS-bypassing service client was constructed in production — the NODE_ENV " +
        "gate returns a refusal but no longer runs BEFORE the client is built"
    ).not.toHaveBeenCalled();
  });

  // ── Layer 2: DEV_TOOLS_ENABLED ──────────────────────────────
  it("DV-2 (negative): an unset DEV_TOOLS_ENABLED refuses every action, outside production", async () => {
    vi.stubEnv("DEV_TOOLS_ENABLED", undefined);
    // NODE_ENV stays "development", so layer 1 is open and cannot be what refuses.

    for (const { name, call } of ALL_ACTIONS) {
      const res = await call();
      expect(res.success, `${name} ran with DEV_TOOLS_ENABLED unset`).toBe(false);
      expect(res.message, `${name} refused, but not for the opt-in reason`).toMatch(
        /DEV_TOOLS_ENABLED=true/
      );
    }

    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled();
  });

  it("DV-3 (edge): the opt-in is an exact-string check — 'TRUE', '1' and 'yes' do NOT unlock it", async () => {
    // Default-false posture means anything other than the literal "true" must
    // stay locked. `=== "true"` gives that for free; a truthiness check
    // (`if (process.env.DEV_TOOLS_ENABLED)`) would unlock on all three of
    // these, and would read as correct to anyone skimming the line.
    for (const value of ["TRUE", "True", "1", "yes", ""]) {
      vi.stubEnv("DEV_TOOLS_ENABLED", value);
      const res = await clearSessionData(SESSION_ID);
      expect(res.success, `DEV_TOOLS_ENABLED=${JSON.stringify(value)} unlocked the dev tools`).toBe(
        false
      );
    }
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled();
  });

  // ── Layer 3: authentication ─────────────────────────────────
  it("DV-4 (negative): with both env layers open, an anonymous caller is still refused", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getAuthenticatedUser>>
    );

    for (const { name, call } of ALL_ACTIONS) {
      const res = await call();
      expect(res.success, `${name} ran for an anonymous caller`).toBe(false);
      expect(res.message, `${name} refused, but not for the auth reason`).toBe(
        "Not authenticated."
      );
    }

    expect(
      vi.mocked(createServiceClient),
      "a service client was constructed for an anonymous caller"
    ).not.toHaveBeenCalled();
  });

  // ── Positive control ────────────────────────────────────────
  it("DV-5: with all three layers open, clearSessionData reaches the database and reports success", async () => {
    // Without this test, DV-1 through DV-4 are all satisfied by a
    // clearSessionData that refuses unconditionally — including one broken
    // outright. This is the half that proves the gates OPEN.
    const svc = installServiceClient([
      { data: [{ id: "m1" }, { id: "m2" }], error: null }, // matches select
      { error: null }, // match_games delete
      { error: null }, // match_players delete
      { error: null }, // matches delete
      { error: null }, // queue_entries delete
      { error: null }, // courts reset
    ]);

    const res = await clearSessionData(SESSION_ID);

    expect(res.success, res.message).toBe(true);
    expect(res.message).toMatch(/2 matches/);
    expect(
      vi.mocked(createServiceClient),
      "all three gates were open and clearSessionData still never built a client — " +
        "every negative test above is now vacuous"
    ).toHaveBeenCalled();
    expect(svc.recorded.map((r) => r.table)).toEqual([
      "matches",
      "match_games",
      "match_players",
      "matches",
      "queue_entries",
      "courts",
    ]);
  });

  // ── Blast radius ────────────────────────────────────────────
  it("DV-6: every delete is bound to the session — an unbound delete would empty the table", async () => {
    const svc = installServiceClient([
      { data: [{ id: "m1" }], error: null },
      { error: null },
      { error: null },
      { error: null },
      { error: null },
      { error: null },
    ]);

    await clearSessionData(SESSION_ID);

    const byTable = (t: string) => svc.recorded.filter((r) => r.table === t);

    // The two session-scoped deletes and the courts reset must each carry the
    // session_id filter. Dropping one turns a per-session clear into a
    // club-wide wipe, through a client that RLS does not stop.
    expect(byTable("matches")[1].ops, "the matches DELETE is not bound to session_id").toContain(
      `eq:session_id=${JSON.stringify(SESSION_ID)}`
    );
    expect(
      byTable("queue_entries")[0].ops,
      "the queue_entries DELETE is not bound to session_id"
    ).toContain(`eq:session_id=${JSON.stringify(SESSION_ID)}`);
    expect(byTable("courts")[0].ops, "the courts reset is not bound to session_id").toContain(
      `eq:session_id=${JSON.stringify(SESSION_ID)}`
    );

    // The child deletes are bound to the ids we just read, not to the session.
    expect(byTable("match_games")[0].ops).toEqual([`in:match_id=${JSON.stringify(["m1"])}`]);
    expect(byTable("match_players")[0].ops).toEqual([`in:match_id=${JSON.stringify(["m1"])}`]);
  });

  it("DV-7 (edge): a session with no matches skips the child deletes rather than issuing an empty IN", async () => {
    const svc = installServiceClient([
      { data: [], error: null }, // no matches
      { error: null }, // matches delete
      { error: null }, // queue_entries delete
      { error: null }, // courts reset
    ]);

    const res = await clearSessionData(SESSION_ID);

    expect(res.success, res.message).toBe(true);
    expect(
      svc.recorded.map((r) => r.table),
      "match_games / match_players were touched for a session with zero matches"
    ).toEqual(["matches", "matches", "queue_entries", "courts"]);
    expect(res.message).toMatch(/0 matches/);
  });

  it("DV-8 (edge): a null matches read is treated as zero matches, not as a crash", async () => {
    // supabase-js returns data: null alongside an error. The action logs the
    // error and continues, so `matches ?? []` is what stops a TypeError from
    // taking down an action whose contract forbids throwing.
    const svc = installServiceClient([
      { data: null, error: { message: "boom" } },
      { error: null },
      { error: null },
      { error: null },
    ]);

    const res = await clearSessionData(SESSION_ID);

    expect(res.success, res.message).toBe(true);
    expect(svc.recorded.map((r) => r.table)).toEqual([
      "matches",
      "matches",
      "queue_entries",
      "courts",
    ]);
  });

  it("DV-9 (negative): a failed queue_entries delete is reported as a partial clear, not as success", async () => {
    // The silent-failure case: five of six statements land, one does not, and
    // the organizer is told the session is clean while stale queue rows
    // survive. success must be false and the message must name the failure.
    installServiceClient([
      { data: [{ id: "m1" }], error: null },
      { error: null },
      { error: null },
      { error: null },
      { error: { message: "queue delete failed" } },
      { error: null },
    ]);

    const res = await clearSessionData(SESSION_ID);

    expect(res.success, "a failed queue_entries delete was reported as a successful clear").toBe(
      false
    );
    expect(res.message).toMatch(/Partial clear/);
    expect(res.message).toMatch(/queue delete failed/);
  });
});
