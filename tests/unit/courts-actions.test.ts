// ============================================================
// Court actions — organizer gate, guard ORDER, and session binding
// ============================================================
// src/app/actions/courts.ts exposes three organizer-only mutations that all
// run through the SERVICE client, which bypasses RLS. That makes the
// TypeScript in this one file the entire write-gate for the courts table:
// there is no second layer behind it to catch a dropped filter.
//
// Two properties are worth a unit suite, and neither is observable from a
// return value — which is why every case here asserts on what the mocked
// Supabase client was ASKED to do, not on the {success,message} alone:
//
//   1. SESSION BINDING. updateCourtStatusAction and removeCourtAction take a
//      sessionId and a courtId as two independent client-supplied arguments.
//      They gate on the sessionId and must bind the write to BOTH ids, so an
//      organizer of Session A cannot reach a court in Session B by pairing
//      their own sessionId with a foreign courtId. This is this repo's
//      most-repeated security defect ("authorize on A, operate on B"), so the
//      proof is an EXACT compare on the recorded .eq() calls — a mere presence
//      check would stay green for the swap mutant .eq("id", sessionId)
//      .eq("session_id", courtId), which makes two eq calls and still escapes.
//
//   2. GUARD ORDER. The service client must not even be CONSTRUCTED when the
//      auth gate or the organizer gate fails. "No query was issued" is the
//      weaker claim; "createServiceClient was never called" is the strongest
//      statement of ordering available, and it is unavailable to the
//      integration lane (tests/integration/setup.ts hands the server client a
//      real service-role client, so both are the same object there).
//
// Every mutation named below was APPLIED to src/app/actions/courts.ts and the
// listed IDs were observed going red; the source was then restored.
//
// IDs — negatives are marked, and each of the three functions carries its own
// case for the gates because each gate is written out independently in each
// function (a mutation to one must go red on exactly one test):
//
//   CT-1  (negative) addCourtAction refuses an unauthenticated caller before
//                    the organizer gate and before any client is constructed
//   CT-2  (negative) same for updateCourtStatusAction
//   CT-3  (negative) same for removeCourtAction
//   CT-4  (negative) addCourtAction refuses a non-organizer; no row inserted
//   CT-5  (negative) updateCourtStatusAction refuses a non-organizer; no update
//   CT-6  (negative) removeCourtAction refuses a non-organizer; no delete
//   CT-7  (negative) all three ask the organizer gate about the sessionId the
//                    write binds to — never about the caller-supplied courtId
//   CT-8            addCourtAction inserts exactly {session_id, name}, bound to
//                    the authorized session
//   CT-9  (negative) updateCourtStatusAction cannot reach a court in another
//                    session — filter set is EXACTLY [eq:id, eq:session_id]
//   CT-10 (negative) removeCourtAction cannot delete a court in another session
//   CT-11           positive control for CT-9 — own court updates succeed
//                    (CT-9 is equally satisfied by an action broken for all)
//   CT-12           positive control for CT-10 — a real DELETE, not a soft
//                    delete disguised as one (the message is identical either way)
//   CT-13 (negative) addCourtAction surfaces the DB error message verbatim
//   CT-14 (negative) same for updateCourtStatusAction
//   CT-15 (negative) same for removeCourtAction
//   CT-16 (edge)     an auth lookup resolving undefined (not null) is still
//                    refused, and still RESOLVES rather than throwing
//   CT-17 (edge)     every CourtStatus reaches the payload verbatim, and the
//                    session binding holds for each of them
//   CT-18 (edge)     court names are inserted byte-for-byte; no trim, no
//                    case-fold, no empty-string rejection
//   CT-19 (edge)     an error whose message is "" is still a failure
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// courts.ts imports exactly these two from _shared. Stubbing the whole module
// keeps the real isSessionOrganizer (which builds its OWN service client) out
// of the picture, so every createServiceClient call counted below is one that
// courts.ts made itself.
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
}));

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import {
  addCourtAction,
  updateCourtStatusAction,
  removeCourtAction,
  type CourtActionResult,
} from "@/app/actions/courts";
import type { CourtStatus } from "@/types/database";

const SESSION_A = "11111111-1111-4111-8111-111111111111"; // the session the caller organizes
const COURT_IN_A = "33333333-3333-4333-8333-333333333333"; // a court the caller owns
const COURT_IN_B = "44444444-4444-4444-8444-444444444444"; // a court in SOMEONE ELSE's session
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };

type Resp = { data?: unknown; error?: unknown };
type WriteOp = { kind: "insert" | "update" | "delete"; payload: unknown };
/** One entry per `.from(table)` call: what was written, and what it was bound to. */
type Recorded = { table: string; writes: WriteOp[]; filters: string[] };

/**
 * Chainable PostgREST stand-in that records the write verb, its payload, and
 * every filter applied to it. Recording the FILTERS is the whole point: the
 * mutant that matters most (dropping `.eq("session_id", sessionId)`) changes
 * nothing a caller can see — same message, same success flag.
 */
function builder(resp: Resp, entry: Recorded) {
  const b: Record<string, unknown> = {};
  const write = (kind: WriteOp["kind"]) => (payload?: unknown) => {
    entry.writes.push({ kind, payload });
    return b;
  };
  b.insert = write("insert");
  b.update = write("update");
  b.delete = write("delete");
  b.select = () => b;
  b.order = () => b;
  b.limit = () => b;
  b.eq = (col: string, val: unknown) => {
    entry.filters.push(`eq:${col}=${String(val)}`);
    return b;
  };
  b.neq = (col: string, val: unknown) => {
    entry.filters.push(`neq:${col}=${String(val)}`);
    return b;
  };
  b.in = (col: string, vals: unknown[]) => {
    entry.filters.push(`in:${col}=${vals.map(String).join(",")}`);
    return b;
  };
  // Recorded, not ignored: an `.or(...)` arm alongside the two eq()s would
  // WIDEN the write back out, and the exact-set compares below must see it.
  b.or = (expr: string) => {
    entry.filters.push(`or:${expr}`);
    return b;
  };
  b.maybeSingle = () => Promise.resolve(resp);
  b.single = () => Promise.resolve(resp);
  b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

/**
 * Installs a fake service client and returns handles on what it recorded.
 * Installed even in the tests that assert it is never CONSTRUCTED, so that a
 * guard-order mutant fails on the ordering assertion rather than on a
 * TypeError from an undefined client — the message the reader needs.
 */
function mockService(resp: Resp = { data: null, error: null }) {
  const recorded: Recorded[] = [];
  const from = vi.fn((table: string) => {
    const entry: Recorded = { table, writes: [], filters: [] };
    recorded.push(entry);
    return builder(resp, entry);
  });
  vi.mocked(createServiceClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createServiceClient
  >);
  return {
    recorded,
    /** Table names in call order — empty means nothing was even looked up. */
    tables: () => recorded.map((r) => r.table),
    /** The single recorded write, asserted to be single. */
    onlyWrite: () => {
      expect(recorded, "expected exactly one .from() call on the service client").toHaveLength(1);
      expect(recorded[0].writes, "expected exactly one write op in the chain").toHaveLength(1);
      return recorded[0];
    },
  };
}

function authenticateAs(user: { id: string } | null | undefined) {
  vi.mocked(getAuthenticatedUser).mockResolvedValue(
    user as unknown as Awaited<ReturnType<typeof getAuthenticatedUser>>
  );
}

/** The three actions, each invoked on the caller's OWN session. */
const ALL_ACTIONS: [string, () => Promise<CourtActionResult>][] = [
  ["addCourtAction", () => addCourtAction(SESSION_A, "Court 7")],
  ["updateCourtStatusAction", () => updateCourtStatusAction(SESSION_A, COURT_IN_A, "closed")],
  ["removeCourtAction", () => removeCourtAction(SESSION_A, COURT_IN_A)],
];

/** Sorted so the assertion is a SET compare, insensitive to chain order. */
const sorted = (xs: string[]) => [...xs].sort();

beforeEach(() => vi.clearAllMocks());

// ── The auth gate runs first, and nothing is built before it ──────────
describe("CT-AUTH: the auth gate precedes everything", () => {
  beforeEach(() => authenticateAs(null));

  it("CT-1 (negative): addCourtAction refuses an unauthenticated caller before the organizer gate and before any client is constructed", async () => {
    const svc = mockService();

    const r = await addCourtAction(SESSION_A, "Court 7");

    expect(r, "an unauthenticated caller must get the auth refusal verbatim").toEqual({
      success: false,
      message: "Not authenticated.",
    });
    expect(
      vi.mocked(isSessionOrganizer),
      "the organizer gate ran for a caller with no identity — the auth gate no longer precedes it"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was CONSTRUCTED for an unauthenticated caller; RLS is bypassed by that client, so nothing may build it before the gates pass"
    ).not.toHaveBeenCalled();
    expect(svc.tables(), "no table may be touched by an unauthenticated caller").toEqual([]);
  });

  it("CT-2 (negative): updateCourtStatusAction refuses an unauthenticated caller before the organizer gate and before any client is constructed", async () => {
    const svc = mockService();

    const r = await updateCourtStatusAction(SESSION_A, COURT_IN_A, "closed");

    expect(r, "an unauthenticated caller must get the auth refusal verbatim").toEqual({
      success: false,
      message: "Not authenticated.",
    });
    expect(
      vi.mocked(isSessionOrganizer),
      "the organizer gate ran for a caller with no identity — the auth gate no longer precedes it"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was CONSTRUCTED for an unauthenticated caller"
    ).not.toHaveBeenCalled();
    expect(svc.tables(), "no table may be touched by an unauthenticated caller").toEqual([]);
  });

  it("CT-3 (negative): removeCourtAction refuses an unauthenticated caller before the organizer gate and before any client is constructed", async () => {
    // The delete is the least reversible of the three writes, so the
    // "nothing was even constructed" proof matters most here.
    const svc = mockService();

    const r = await removeCourtAction(SESSION_A, COURT_IN_A);

    expect(r, "an unauthenticated caller must get the auth refusal verbatim").toEqual({
      success: false,
      message: "Not authenticated.",
    });
    expect(
      vi.mocked(isSessionOrganizer),
      "the organizer gate ran for a caller with no identity — the auth gate no longer precedes it"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was CONSTRUCTED for an unauthenticated caller, on the DELETE path"
    ).not.toHaveBeenCalled();
    expect(svc.tables(), "no table may be touched by an unauthenticated caller").toEqual([]);
  });

  it("CT-16 (edge): an auth lookup that resolves undefined (not null) is still refused, and still does not throw", async () => {
    // getAuthenticatedUser is typed `User | null`, but the runtime value is not
    // type-checked — a Supabase client shape change, or any caller that returns
    // early, can hand back undefined. `if (!user)` must cover both falsy shapes;
    // `if (user === null)` reads .id off undefined and REJECTS, violating the
    // repo rule that a server action never throws unhandled.
    for (const [name, call] of ALL_ACTIONS) {
      vi.clearAllMocks();
      authenticateAs(undefined);
      mockService();

      await expect(
        call(),
        `${name} threw instead of resolving when the auth lookup returned undefined`
      ).resolves.toEqual({ success: false, message: "Not authenticated." });

      expect(
        vi.mocked(createServiceClient),
        `${name} constructed a service client for an undefined user`
      ).not.toHaveBeenCalled();
    }
  });
});

// ── The organizer gate refuses, and nothing is written ────────────────
describe("CT-ORG: the organizer gate refuses a non-organizer", () => {
  beforeEach(() => {
    authenticateAs(CALLER);
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
  });

  it("CT-4 (negative): addCourtAction refuses a non-organizer, and no row is ever inserted", async () => {
    const svc = mockService();

    const r = await addCourtAction(SESSION_A, "Court 7");

    expect(r, "a non-organizer must get the authorization refusal verbatim").toEqual({
      success: false,
      message: "Not authorized.",
    });
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was constructed for a non-organizer"
    ).not.toHaveBeenCalled();
    expect(
      svc.tables(),
      "a non-organizer reached the courts table — the insert gate is gone"
    ).toEqual([]);
  });

  it("CT-5 (negative): updateCourtStatusAction refuses a non-organizer, and no update is ever issued", async () => {
    const svc = mockService();

    const r = await updateCourtStatusAction(SESSION_A, COURT_IN_A, "closed");

    expect(r, "a non-organizer must get the authorization refusal verbatim").toEqual({
      success: false,
      message: "Not authorized.",
    });
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was constructed for a non-organizer"
    ).not.toHaveBeenCalled();
    expect(
      svc.tables(),
      "a non-organizer reached the courts table — the update gate is gone"
    ).toEqual([]);
  });

  it("CT-6 (negative): removeCourtAction refuses a non-organizer, and no delete is ever issued", async () => {
    const svc = mockService();

    const r = await removeCourtAction(SESSION_A, COURT_IN_A);

    expect(r, "a non-organizer must get the authorization refusal verbatim").toEqual({
      success: false,
      message: "Not authorized.",
    });
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was constructed for a non-organizer"
    ).not.toHaveBeenCalled();
    expect(
      svc.tables(),
      "a non-organizer reached the courts table — the delete gate is gone"
    ).toEqual([]);
  });

  it("CT-7 (negative): every action asks the organizer gate about the sessionId its write is bound to — never about the caller-supplied courtId", async () => {
    // The "authorize on A" half of the repo's most-repeated security defect;
    // CT-9/CT-10 are the "operate on A" half. The update/remove calls pass a
    // FOREIGN courtId deliberately, so a gate keyed on the wrong argument
    // produces an observably different call rather than an identical one.
    const probes: [string, () => Promise<CourtActionResult>][] = [
      ["addCourtAction", () => addCourtAction(SESSION_A, "Court 7")],
      ["updateCourtStatusAction", () => updateCourtStatusAction(SESSION_A, COURT_IN_B, "closed")],
      ["removeCourtAction", () => removeCourtAction(SESSION_A, COURT_IN_B)],
    ];

    for (const [name, call] of probes) {
      vi.clearAllMocks();
      authenticateAs(CALLER);
      vi.mocked(isSessionOrganizer).mockResolvedValue(false);
      mockService();

      await call();

      expect(
        vi.mocked(isSessionOrganizer),
        `${name} must consult the organizer gate exactly once`
      ).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(isSessionOrganizer),
        `${name} authorized against the wrong id — the gate must be asked about the caller and the sessionId the write binds to, not the courtId`
      ).toHaveBeenCalledWith(CALLER.id, SESSION_A);
    }
  });
});

// ── The writes themselves ─────────────────────────────────────────────
describe("CT-WRITE: an authorized organizer's writes", () => {
  beforeEach(() => {
    authenticateAs(CALLER);
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  });

  it("CT-8: addCourtAction inserts a row bound to the authorized session, with exactly the two columns it means to set", async () => {
    const svc = mockService({ error: null });

    const r = await addCourtAction(SESSION_A, "Court 7");

    expect(r, "a successful insert must report success with the fixed copy").toEqual({
      success: true,
      message: "Court added.",
    });
    expect(svc.tables(), "the insert must go to courts and nowhere else").toEqual(["courts"]);
    const entry = svc.onlyWrite();
    expect(entry.writes[0].kind, "addCourtAction must INSERT, not update or delete").toBe("insert");
    // Exact compare, not objectContaining: an extra column (e.g. a hardcoded
    // status) or a missing session_id must both be caught.
    expect(
      entry.writes[0].payload,
      "the inserted row must carry exactly session_id + name, and session_id must be the id the organizer gate authorized"
    ).toEqual({ session_id: SESSION_A, name: "Court 7" });
  });

  it("CT-9 (negative): updateCourtStatusAction cannot reach a court in another session — the update is bound to BOTH the courtId and the authorized sessionId", async () => {
    // The action cannot know COURT_IN_B is foreign, so it does issue a
    // statement. What stops the cross-session write is the pair of filters.
    const svc = mockService({ error: null });

    await updateCourtStatusAction(SESSION_A, COURT_IN_B, "closed");

    expect(svc.tables(), "the update must go to courts and nowhere else").toEqual(["courts"]);
    const entry = svc.onlyWrite();
    expect(entry.writes[0].kind, "the write verb must be an UPDATE").toBe("update");
    expect(entry.writes[0].payload, "the update must set exactly the requested status").toEqual({
      status: "closed",
    });
    // An EXACT set compare, so it catches deletion of the session filter, the
    // swap mutant .eq("id", sessionId).eq("session_id", courtId), a third
    // filter, and an added .or(...) widening arm alike.
    expect(
      sorted(entry.filters),
      "the update was not bound to BOTH ids — as written, an organizer of Session A could mutate a court belonging to Session B by passing their own sessionId alongside a foreign courtId"
    ).toEqual(sorted([`eq:id=${COURT_IN_B}`, `eq:session_id=${SESSION_A}`]));
  });

  it("CT-10 (negative): removeCourtAction cannot delete a court in another session — the delete is bound to BOTH the courtId and the authorized sessionId", async () => {
    const svc = mockService({ error: null });

    await removeCourtAction(SESSION_A, COURT_IN_B);

    expect(svc.tables(), "the delete must go to courts and nowhere else").toEqual(["courts"]);
    const entry = svc.onlyWrite();
    expect(entry.writes[0].kind, "the write verb must be a DELETE").toBe("delete");
    expect(
      sorted(entry.filters),
      "the delete was not bound to BOTH ids — as written, an organizer of Session A could permanently delete a court belonging to Session B"
    ).toEqual(sorted([`eq:id=${COURT_IN_B}`, `eq:session_id=${SESSION_A}`]));
  });

  it("CT-11: positive control for CT-9 — the same organizer updating their OWN court succeeds", async () => {
    // CT-9 is equally satisfied by an action that is simply broken for
    // everyone; this is the case that says the feature still works.
    const svc = mockService({ error: null });

    const r = await updateCourtStatusAction(SESSION_A, COURT_IN_A, "available");

    expect(r, "an organizer updating a court in their own session must succeed").toEqual({
      success: true,
      message: "Court status updated.",
    });
    expect(svc.tables(), "the update must go to courts and nowhere else").toEqual(["courts"]);
    const entry = svc.onlyWrite();
    expect(
      entry.writes[0].payload,
      "the status the caller asked for must reach the payload unchanged"
    ).toEqual({ status: "available" });
    expect(sorted(entry.filters), "the own-session write must still carry both bindings").toEqual(
      sorted([`eq:id=${COURT_IN_A}`, `eq:session_id=${SESSION_A}`])
    );
  });

  it("CT-12: positive control for CT-10 — removing an own court issues a real DELETE, not a soft-delete", async () => {
    // courts.ts states soft-delete is deliberately NOT used. A silent switch to
    // one returns the identical message, so only the write verb can announce it.
    const svc = mockService({ error: null });

    const r = await removeCourtAction(SESSION_A, COURT_IN_A);

    expect(r, "an organizer removing a court in their own session must succeed").toEqual({
      success: true,
      message: "Court removed.",
    });
    const entry = svc.onlyWrite();
    expect(
      entry.writes[0].kind,
      "removeCourtAction must issue a real DELETE — a soft-delete returns the same message, so nothing else would notice the swap"
    ).toBe("delete");
    expect(
      entry.writes.map((w) => w.kind),
      "no UPDATE may ride along with the delete"
    ).not.toContain("update");
    expect(sorted(entry.filters), "the own-session delete must still carry both bindings").toEqual(
      sorted([`eq:id=${COURT_IN_A}`, `eq:session_id=${SESSION_A}`])
    );
  });

  it("CT-17 (edge): every CourtStatus value reaches the update payload verbatim, and the session binding holds for each", async () => {
    // Proves the action neither coerces nor normalizes the status, and that the
    // session binding is not conditional on which status was requested.
    const statuses: CourtStatus[] = ["available", "in_use", "closed"];

    for (const status of statuses) {
      vi.clearAllMocks();
      authenticateAs(CALLER);
      vi.mocked(isSessionOrganizer).mockResolvedValue(true);
      const svc = mockService({ error: null });

      const r = await updateCourtStatusAction(SESSION_A, COURT_IN_A, status);

      expect(r.success, `updating a court to "${status}" must succeed`).toBe(true);
      const entry = svc.onlyWrite();
      expect(
        entry.writes[0].payload,
        `"${status}" was rewritten on its way to the database`
      ).toEqual({ status });
      expect(
        sorted(entry.filters),
        `the session binding was dropped for status "${status}" — a binding that holds only for some statuses is not a binding`
      ).toEqual(sorted([`eq:id=${COURT_IN_A}`, `eq:session_id=${SESSION_A}`]));
    }
  });

  it("CT-18 (edge): court names differing only by case or surrounding whitespace, and the empty string, are inserted byte-for-byte", async () => {
    // courts.ts deliberately imports neither @/lib/normalize-name nor
    // @/lib/dup-name — those are the player-identity helpers — and the database
    // is the only validator. A future decision to trim, case-fold or reject has
    // to come through this test and say so, rather than silently changing what
    // the organizer sees on the board.
    const names = ["Court 1", "court 1", "  Court 1  ", ""];

    for (const name of names) {
      vi.clearAllMocks();
      authenticateAs(CALLER);
      vi.mocked(isSessionOrganizer).mockResolvedValue(true);
      const svc = mockService({ error: null });

      const r = await addCourtAction(SESSION_A, name);

      expect(r.success, `addCourtAction refused the name ${JSON.stringify(name)}`).toBe(true);
      const entry = svc.onlyWrite();
      expect(
        entry.writes[0].payload,
        `the name ${JSON.stringify(name)} was normalized or folded on its way to the database`
      ).toEqual({ session_id: SESSION_A, name });
    }
  });
});

// ── The error contract ────────────────────────────────────────────────
// The repo-wide rule is that a server action returns {success,message} and
// never throws. These pin the message as VERBATIM, and pin the failure
// predicate to the presence of the error object rather than its truthiness.
describe("CT-ERR: database failures are reported, not swallowed", () => {
  beforeEach(() => {
    authenticateAs(CALLER);
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  });

  const DB_MESSAGE = "duplicate key value violates unique constraint";

  it("CT-13 (negative): addCourtAction surfaces the database error message verbatim and reports failure", async () => {
    mockService({ error: { message: DB_MESSAGE } });

    const r = await addCourtAction(SESSION_A, "Court 7");

    expect(r.success, "a failed insert must not be reported as success").toBe(false);
    expect(r.message, "the database's own message must reach the organizer unaltered").toBe(
      DB_MESSAGE
    );
  });

  it("CT-14 (negative): updateCourtStatusAction surfaces the database error message verbatim and reports failure", async () => {
    mockService({ error: { message: DB_MESSAGE } });

    const r = await updateCourtStatusAction(SESSION_A, COURT_IN_A, "closed");

    expect(r.success, "a failed update must not be reported as success").toBe(false);
    expect(r.message, "the database's own message must reach the organizer unaltered").toBe(
      DB_MESSAGE
    );
  });

  it("CT-15 (negative): removeCourtAction surfaces the database error message verbatim and reports failure", async () => {
    mockService({ error: { message: DB_MESSAGE } });

    const r = await removeCourtAction(SESSION_A, COURT_IN_A);

    expect(r.success, "a failed delete must not be reported as success").toBe(false);
    expect(r.message, "the database's own message must reach the organizer unaltered").toBe(
      DB_MESSAGE
    );
  });

  it("CT-19 (edge): a database error whose message is the empty string is still a failure, not a success", async () => {
    // The predicate must be `if (error)`, not `if (error?.message)`: an error
    // object with an empty message is still a write that did not happen.
    for (const [name, call] of ALL_ACTIONS) {
      vi.clearAllMocks();
      authenticateAs(CALLER);
      vi.mocked(isSessionOrganizer).mockResolvedValue(true);
      mockService({ error: { message: "" } });

      const r = await call();

      expect(
        r.success,
        `${name} reported success for a failed write because the error's message happened to be empty`
      ).toBe(false);
    }
  });
});
