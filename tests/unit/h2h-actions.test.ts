// ============================================================
// Head-to-Head server action — getH2HRecord
// ============================================================
// WHY THIS FILE EXISTS
//
// getH2HRecord is a read-only server action with an unusual failure
// contract: EVERY rejection path returns a bare `null`. That is good for
// the caller (no oracle: an outsider cannot tell "not logged in" from "not
// a member" from "no such session") and terrible for testing, because a
// completely deleted guard also returns null on the happy fixture. So the
// suite below never asserts "it returned null" on its own — each negative
// also pins WHICH downstream work must not have happened (no service
// client constructed, no table read, no RPC issued). That pairing is what
// makes a missing guard visible.
//
// Three properties carry real security weight here:
//
//   1. GUARD ORDER — auth precedes every client, lookup and RPC. This repo
//      has shipped the "authorize after you already read" bug repeatedly;
//      HH-3 pins the ordering rather than only the return value.
//   2. THE MEMBERSHIP FALLBACK'S BINDING — the queue_entries probe must be
//      bound to BOTH the session id AND the CALLER'S OWN user id. Bound to
//      session_id alone it admits any player of any session; bound to a
//      caller-supplied id it is authorize-on-A/operate-on-B. HH-5 asserts
//      the column=value PAIRING, because a swap still makes two eq() calls.
//   3. THE CLUB BOUNDARY — matches/match_players carry no club_id, so
//      `p_club_id` resolved from the session row is the ONLY tenancy
//      boundary the RPC gets. HH-7/HH-8/HH-10 pin that it is server-derived
//      and that a missing/erroring session denies before the RPC.
//
// TESTS (negatives and edges marked explicitly):
//   HH-1                an organizer gets the RPC's first row back
//   HH-2                a non-organizer with a queue row for THIS session is
//                       admitted through the fallback (and the fallback ran)
//   HH-3  (negative)    an unauthenticated caller gets null and nothing
//                       downstream is even constructed  [GUARD ORDER]
//   HH-4  (negative)    an authenticated non-member is refused before the
//                       club lookup and before the RPC
//   HH-5  (negative)    the membership fallback is bound to BOTH the session
//                       id AND the caller's own user id
//   HH-6  (negative)    the organizer gate is asked about (caller, session),
//                       and a passing organizer skips the queue fallback
//   HH-7  (negative)    a missing session row denies before the RPC
//   HH-8  (negative)    p_club_id is the club resolved from the session row,
//                       and the session lookup is keyed on the authorized id
//   HH-9  (edge)        a PostgREST error on the queue lookup denies with
//                       null and never rejects  [FAIL CLOSED]
//   HH-10 (edge)        a PostgREST error on the club lookup denies with null
//                       and never rejects  [FAIL CLOSED]
//   HH-11 (negative)    an RPC error wins even when rows also came back
//   HH-12 (edge)        a null data payload yields null without throwing
//   HH-13 (edge)        an empty RPC result yields null, not undefined
//   HH-14 (edge)        both team arrays are forwarded verbatim and the
//                       caller's arrays are not mutated
//   HH-15 (edge)        empty team arrays still reach the RPC — the
//                       degenerate-overlap decision belongs to the SQL
//   HH-16 (edge)        the identical sessionId string reaches the membership
//                       gate, the club lookup and the RPC
//   HH-17 (negative)    the RPC runs on the request-scoped user client, never
//                       on the service client
//   HH-18 (negative)    the membership and club lookups run on the service
//                       client, never on the user client
//
// IDs: HH
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// Keep the real _shared module (h2h.ts only needs isSessionOrganizer from it)
// but stub the organizer predicate so each test drives the gate directly. The
// predicate has its own coverage; what is under test here is how getH2HRecord
// CONSUMES it — including which arguments it is asked about.
vi.mock("@/app/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/actions/_shared")>();
  return { ...actual, isSessionOrganizer: vi.fn() };
});

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isSessionOrganizer } from "@/app/actions/_shared";
import { getH2HRecord } from "@/app/actions/h2h";
import type { H2HRecord } from "@/types/database";

const SESSION_ID = "00000000-0000-4000-8000-000000000010";
// Deliberately unequal to SESSION_ID and to every team id, so an assertion on
// p_club_id cannot pass by accidentally echoing a caller-supplied argument.
const CLUB_ID = "00000000-0000-4000-8000-0000000000c1";
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };

const TEAM_A = ["00000000-0000-4000-8000-00000000aa01", "00000000-0000-4000-8000-00000000aa02"];
const TEAM_B = ["00000000-0000-4000-8000-00000000bb01", "00000000-0000-4000-8000-00000000bb02"];

/** The row the RPC is supposed to hand back. */
const REC: H2HRecord = { alltime_a: 7, alltime_b: 3, session_a: 2, session_b: 1 };
/** A second row, present only so "return the FIRST row" is falsifiable. */
const DECOY: H2HRecord = { alltime_a: 99, alltime_b: 98, session_a: 97, session_b: 96 };

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };
/** One response for every table, or a per-table map. */
type RespSource = Resp | Record<string, Resp>;

/**
 * A bare `{data, error}` answers for every table. A map answers per table and
 * defaults anything it does not name to "no row" — the denying default, so a
 * test that forgets to stub a step fails closed rather than inheriting a row.
 */
function respFor(src: RespSource, table: string): Resp {
  const isMap = !("data" in src) && !("error" in src);
  return isMap ? ((src as Record<string, Resp>)[table] ?? { data: null, error: null }) : src;
}

/**
 * Chainable builder that records every filter it is given, so a test can
 * assert on WHICH COLUMN was constrained to WHICH VALUE. A mock that records
 * only the table name cannot see the two defects that matter most here: a
 * fallback bound to session_id alone, and a lookup keyed on a caller-supplied
 * id instead of the authorized one.
 */
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
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

type ServiceStub = {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  recorded: Recorded[];
};

/**
 * Install the service-role client. `recorded` is append-ordered, so its table
 * sequence is the read plan the action actually executed — that is how the
 * negatives prove a step did NOT run rather than merely that a null came back.
 */
function stubServiceClient(src: RespSource): ServiceStub {
  const recorded: Recorded[] = [];
  const stub: ServiceStub = {
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(respFor(src, table), entry.ops);
    }),
    // Never legitimately used by this action: get_h2h_record is STABLE and is
    // NOT security-definer, so running it as service_role would bypass RLS on
    // matches/match_players. Present purely so HH-17 can prove it stays unused.
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    recorded,
  };
  vi.mocked(createServiceClient).mockReturnValue(
    stub as unknown as ReturnType<typeof createServiceClient>
  );
  return stub;
}

type UserStub = {
  auth: { getUser: ReturnType<typeof vi.fn> };
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
};

/** Install the request-scoped (RLS-respecting) client. */
function stubUserClient(user: { id: string } | null, rpcResp: Resp): UserStub {
  const stub: UserStub = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
    // The gate reads belong on the service client; this spy exists so HH-18
    // can prove none of them leaked onto the authenticated client.
    from: vi.fn(() => builder({ data: null, error: null }, [])),
    rpc: vi.fn(() => Promise.resolve(rpcResp)),
  };
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    stub as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  return stub;
}

/** Table read order, which is the assertion every negative leans on. */
const tablesOf = (svc: ServiceStub) => svc.recorded.map((r) => r.table);
/** Filters recorded against the first read of `table`. */
const opsFor = (svc: ServiceStub, table: string) =>
  svc.recorded.find((r) => r.table === table)?.ops ?? [];

beforeEach(() => vi.clearAllMocks());

// ── Admission: the two ways a caller legitimately gets a record ──
describe("HH: getH2HRecord admits members", () => {
  it("HH-1: an organizer gets the RPC's first row back", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    stubServiceClient({ sessions: { data: { club_id: CLUB_ID }, error: null } });
    const user = stubUserClient(CALLER, { data: [REC, DECOY], error: null });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "the organizer path did not return the RPC's first row").toEqual(REC);
    expect(user.rpc, "get_h2h_record was not issued exactly once").toHaveBeenCalledTimes(1);
    expect(user.rpc.mock.calls[0][0], "a different RPC than get_h2h_record was called").toBe(
      "get_h2h_record"
    );
  });

  it("HH-2: a non-organizer with a queue row for this session is admitted via the fallback", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const svc = stubServiceClient({
      queue_entries: { data: { id: "q1" }, error: null },
      sessions: { data: { club_id: CLUB_ID }, error: null },
    });
    stubUserClient(CALLER, { data: [REC], error: null });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "a session player was denied their own session's H2H record").toEqual(REC);
    // Proves the FALLBACK admitted them — not that the organizer arm was
    // silently taken, which would leave the fallback entirely untested.
    expect(tablesOf(svc), "the queue_entries fallback did not run before the club lookup").toEqual([
      "queue_entries",
      "sessions",
    ]);
  });
});

// ── Refusals: every one returns a bare null, so each also pins the work
//    that must NOT have happened ──
describe("HH: getH2HRecord refuses non-members indistinguishably", () => {
  it("HH-3 (negative): an unauthenticated caller gets null and nothing downstream is even constructed", async () => {
    // GUARD ORDER. A version that builds the service client, or asks the
    // organizer predicate, before checking auth still returns null here — so
    // the return value alone cannot see the defect. The not-called
    // assertions can.
    stubServiceClient({});
    const user = stubUserClient(null, { data: [REC], error: null });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "an anonymous caller received an H2H record").toBeNull();
    expect(
      vi.mocked(createServiceClient),
      "a service-role client was constructed despite the auth gate failing"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(isSessionOrganizer),
      "the organizer predicate ran for a caller with no identity to check"
    ).not.toHaveBeenCalled();
    expect(user.rpc, "the H2H RPC ran for an unauthenticated caller").not.toHaveBeenCalled();
  });

  it("HH-4 (negative): an authenticated non-member with no queue row is refused before the RPC", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const svc = stubServiceClient({
      queue_entries: { data: null, error: null },
      // Deliberately stubbed with a real club: if the guard were deleted the
      // action would sail on and succeed, which is exactly the red we want.
      sessions: { data: { club_id: CLUB_ID }, error: null },
    });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "a stranger to this session received an H2H record").toBeNull();
    expect(
      user.rpc,
      "H2H statistics were computed for a caller who is not in this session"
    ).not.toHaveBeenCalled();
    expect(
      tablesOf(svc),
      "the club lookup ran after the membership gate had already denied"
    ).toEqual(["queue_entries"]);
  });

  it("HH-5 (negative): the membership fallback is bound to BOTH the session id AND the caller's own user id", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const svc = stubServiceClient({
      queue_entries: { data: { id: "q1" }, error: null },
      sessions: { data: { club_id: CLUB_ID }, error: null },
    });
    stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    const ops = opsFor(svc, "queue_entries");
    // The column=value PAIRING, not merely "two eq() calls happened": a swap
    // of the two values also makes two eq() calls.
    expect(
      ops,
      "the membership fallback is not scoped to the session that was asked about"
    ).toContain(`eq:session_id=${SESSION_ID}`);
    expect(
      ops,
      "the membership fallback is not bound to the caller's own id — any player of any session would pass"
    ).toContain(`eq:player_id=${CALLER.id}`);
  });

  it("HH-6 (negative): the organizer gate is asked about (caller id, session id), and a passing organizer skips the queue fallback", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const svc = stubServiceClient({ sessions: { data: { club_id: CLUB_ID }, error: null } });
    stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    // Argument PAIRING. No other case can see this: the mock answers true
    // regardless of what it is asked, so a swapped call site stays green
    // everywhere else.
    expect(
      vi.mocked(isSessionOrganizer),
      "the organizer gate was not asked whether THIS caller organizes THIS session"
    ).toHaveBeenCalledWith(CALLER.id, SESSION_ID);
    expect(tablesOf(svc), "an admitted organizer still ran the queue fallback").toEqual([
      "sessions",
    ]);
  });

  it("HH-7 (negative): a missing session row denies before the RPC", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    // A deleted or non-existent session: no row, and no error either.
    stubServiceClient({ sessions: { data: null, error: null } });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "a non-existent session produced an H2H record").toBeNull();
    expect(
      user.rpc,
      "the RPC ran without a resolved club — the club boundary would be undefined"
    ).not.toHaveBeenCalled();
  });

  it("HH-8 (negative): p_club_id is the club resolved from the session row, and the session lookup is keyed on the authorized session id", async () => {
    // Deliberately unequal to every argument the caller supplied, so the
    // assertion cannot pass by echoing an input.
    const SESSION_CLUB = "00000000-0000-4000-8000-00000000c1ub";
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const svc = stubServiceClient({ sessions: { data: { club_id: SESSION_CLUB }, error: null } });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    // The WHOLE payload, so a renamed or extra key is caught too.
    expect(
      user.rpc,
      "the RPC's club scope is not the club derived from the authorized session"
    ).toHaveBeenCalledWith("get_h2h_record", {
      p_team_a: TEAM_A,
      p_team_b: TEAM_B,
      p_session_id: SESSION_ID,
      p_club_id: SESSION_CLUB,
    });
    expect(
      opsFor(svc, "sessions"),
      "the club was resolved from a row other than the session that was authorized"
    ).toContain(`eq:id=${SESSION_ID}`);
  });
});

// ── Fail-closed: a database error on a gate read must deny, not throw.
//    CLAUDE.md forbids a server action throwing unhandled. ──
describe("HH: getH2HRecord fails closed on gate errors", () => {
  it("HH-9 (edge): a PostgREST error on the queue lookup denies with null and never rejects", async () => {
    // The shape a malformed sessionId produces — h2h.ts runs no isValidUUID,
    // so a junk id reaches Postgres and comes back as an error, not a null row.
    // HH-4 cannot see this: its fixture carries no error object.
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    stubServiceClient({
      queue_entries: {
        data: null,
        error: { message: 'invalid input syntax for type uuid: "not-a-uuid"' },
      },
      sessions: { data: { club_id: CLUB_ID }, error: null },
    });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await expect(
      getH2HRecord(TEAM_A, TEAM_B, "not-a-uuid"),
      "a failed membership probe rejected instead of denying — the action would 500"
    ).resolves.toBeNull();
    expect(user.rpc, "the RPC ran after the membership probe failed").not.toHaveBeenCalled();
  });

  it("HH-10 (edge): a PostgREST error on the club lookup denies with null and never rejects", async () => {
    // Distinct from HH-7, whose fixture has no error object.
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    stubServiceClient({
      sessions: { data: null, error: { message: "permission denied for table sessions" } },
    });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await expect(
      getH2HRecord(TEAM_A, TEAM_B, SESSION_ID),
      "a failed club lookup rejected instead of denying — the action would 500"
    ).resolves.toBeNull();
    expect(user.rpc, "the RPC ran without a resolved club boundary").not.toHaveBeenCalled();
  });
});

// ── The RPC result contract: H2HRecord | null, never undefined, never a
//    half-built row ──
describe("HH: getH2HRecord normalises the RPC result", () => {
  /** Gates open; only the RPC's answer varies. */
  function gatesOpen(rpcResp: Resp): UserStub {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    stubServiceClient({ sessions: { data: { club_id: CLUB_ID }, error: null } });
    return stubUserClient(CALLER, rpcResp);
  }

  it("HH-11 (negative): an RPC error wins even when the RPC also returned rows", async () => {
    // PostgREST can hand back both — a partial result plus an error.
    gatesOpen({ data: [REC], error: { message: "boom" } });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "a partial/errored RPC result was surfaced as a real H2H record").toBeNull();
    expect(
      typeof result === "object" && result !== null,
      "an errored RPC leaked an object to the caller"
    ).toBe(false);
  });

  it("HH-12 (edge): a null data payload yields null without throwing", async () => {
    gatesOpen({ data: null, error: null });

    await expect(
      getH2HRecord(TEAM_A, TEAM_B, SESSION_ID),
      "a null RPC payload was dereferenced — this is an unhandled throw in a server action"
    ).resolves.toBeNull();
  });

  it("HH-13 (edge): an empty RPC result yields null, not undefined", async () => {
    // Exactly what the SQL function's degenerate-overlap guard produces:
    // `IF p_team_a && p_team_b THEN RETURN;` returns zero rows.
    gatesOpen({ data: [], error: null });

    const result = await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(result, "an empty RPC result was not normalised to null").toBeNull();
    expect(result === undefined, "an undefined leaked past the H2HRecord | null contract").toBe(
      false
    );
  });
});

// ── Arguments reach the RPC exactly as the caller wrote them ──
describe("HH: getH2HRecord forwards its arguments verbatim", () => {
  it("HH-14 (edge): both team arrays are forwarded verbatim and the caller's arrays are not mutated", async () => {
    // Values that differ only by case and leading whitespace, deliberately
    // unsorted, so any reordering or normalisation is visible. The module's
    // own contract says the CALLER (useH2H) sorts — a second sort here would
    // silently disagree with whatever the caller decided.
    const teamA = ["b-2", "A-1", " a-1"];
    const teamB = ["d-4", "C-3"];
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    stubServiceClient({ sessions: { data: { club_id: CLUB_ID }, error: null } });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(teamA, teamB, SESSION_ID);

    const payload = user.rpc.mock.calls[0][1] as { p_team_a: string[]; p_team_b: string[] };
    // No reference-identity assertion: a harmless defensive copy must not go red.
    expect(payload.p_team_a, "team A was reordered or normalised on the way to the RPC").toEqual([
      "b-2",
      "A-1",
      " a-1",
    ]);
    expect(payload.p_team_b, "team B was reordered or normalised on the way to the RPC").toEqual([
      "d-4",
      "C-3",
    ]);
    expect(teamA, "the caller's team A array was sorted in place").toEqual(["b-2", "A-1", " a-1"]);
    expect(teamB, "the caller's team B array was sorted in place").toEqual(["d-4", "C-3"]);
  });

  it("HH-15 (edge): empty team arrays still pass both gates and reach the RPC", async () => {
    // Pins that the degenerate-input decision belongs to the SQL function, so
    // nobody adds a second, divergent copy of it in TypeScript.
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    stubServiceClient({ sessions: { data: { club_id: CLUB_ID }, error: null } });
    const user = stubUserClient(CALLER, { data: [], error: null });

    const result = await getH2HRecord([], [], SESSION_ID);

    expect(
      user.rpc,
      "a JS-side degenerate guard short-circuited the RPC — the SQL owns that decision"
    ).toHaveBeenCalledWith("get_h2h_record", {
      p_team_a: [],
      p_team_b: [],
      p_session_id: SESSION_ID,
      p_club_id: CLUB_ID,
    });
    expect(result, "an empty RPC result was not normalised to null").toBeNull();
  });

  it("HH-16 (edge): the identical sessionId string reaches the membership gate, the club lookup and the RPC", async () => {
    // A padded id, so normalising in ONE consumer is visible. Every other test
    // passes an already-clean id and would stay green through such a change.
    const RAW = ` ${SESSION_ID} `;
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const svc = stubServiceClient({
      queue_entries: { data: { id: "q1" }, error: null },
      sessions: { data: { club_id: CLUB_ID }, error: null },
    });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(TEAM_A, TEAM_B, RAW);

    const seam =
      "the id that was authorized is not the id that was queried — normalising in one place only opens a gate/operand seam";
    expect(vi.mocked(isSessionOrganizer), seam).toHaveBeenCalledWith(CALLER.id, RAW);
    expect(opsFor(svc, "queue_entries"), seam).toContain(`eq:session_id=${RAW}`);
    expect(opsFor(svc, "sessions"), seam).toContain(`eq:id=${RAW}`);
    expect((user.rpc.mock.calls[0][1] as { p_session_id: string }).p_session_id, seam).toBe(RAW);
  });
});

// ── Client selection: which role performs which statement ──
describe("HH: getH2HRecord uses the right client for each statement", () => {
  it("HH-17 (negative): the RPC runs on the request-scoped user client, never on the service client", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const svc = stubServiceClient({ sessions: { data: { club_id: CLUB_ID }, error: null } });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(user.rpc, "the H2H RPC did not run on the authenticated client").toHaveBeenCalledWith(
      "get_h2h_record",
      expect.any(Object)
    );
    expect(
      svc.rpc,
      "get_h2h_record ran as service_role — the function is STABLE and NOT security-definer, so this bypasses RLS on matches/match_players"
    ).not.toHaveBeenCalled();
  });

  it("HH-18 (negative): the membership and club lookups run on the service client, never on the user client", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const svc = stubServiceClient({
      queue_entries: { data: { id: "q1" }, error: null },
      sessions: { data: { club_id: CLUB_ID }, error: null },
    });
    const user = stubUserClient(CALLER, { data: [REC], error: null });

    await getH2HRecord(TEAM_A, TEAM_B, SESSION_ID);

    expect(
      tablesOf(svc),
      "a membership gate read went through the authenticated client — RLS can hide the very row the gate needs, silently denying legitimate session members"
    ).toEqual(["queue_entries", "sessions"]);
    expect(
      user.from.mock.calls.map((c: unknown[]) => c[0]),
      "a gate read went through the authenticated client — RLS can hide the very row the gate needs"
    ).toEqual([]);
  });
});
