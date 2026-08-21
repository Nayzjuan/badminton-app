// ============================================================
// Upcoming held draft — the caller-scoped reservation read (UM)
// ============================================================
// src/app/actions/upcoming-match.ts is the ONE place that reads a held
// cross-court draft with the SERVICE-ROLE client. Every other layer of the
// draft firewall (RLS + realtime filter + client query filter) hides those
// rows from the player, so this action is the single deliberate hole in it.
// The only thing keeping that hole honest is the shape of its query:
//
//   .eq("session_id", sessionId)                 this session, not another
//   .eq("status", "pending")                     a live draft, not a finished match
//   .eq("is_held", true)                         a HELD draft, not any unpublished one
//   .contains("pulled_player_ids", [user.id])    the CALLER's own reservation
//
// Drop any one of those four and the action starts reporting somebody else's
// reservation — or another session's — to whoever asks. Presence is not
// enough: the column-to-value PAIRING is the security property, because three
// eq() calls with two of the values swapped is still three eq() calls. So the
// mock records every filter it is handed and the tests assert the pairs.
//
// Guard ORDER is the second property under test. isValidUUID runs BEFORE
// getAuthenticatedUser, which runs before the service client is ever
// constructed. The negatives below prove position, not merely outcome: the
// downstream mocks are wired to SUCCEED, so the only thing that can stop them
// from running is the gate sitting in front of them.
//
// Tests:
//   UM-1  reserved + NOT ready when held_ready_at is null
//   UM-2  reserved + ready when held_ready_at carries a timestamp
//   UM-3  no row -> neither reserved nor ready, and NOT an error
//   UM-4  a null data payload degrades to "nothing upcoming" without throwing
//   UM-5  (negative) a query error -> success:false, and no upcoming payload
//   UM-6  (negative) a malformed session id is rejected BEFORE auth is
//         consulted and never reaches the database
//   UM-7  (negative) every malformed id shape is rejected — empty, padded,
//         newline-suffixed, truncated, non-hex, injection string
//   UM-8  (negative) an unauthenticated caller is refused before any
//         service-role client is created
//   UM-9  (negative) an undefined user is unauthenticated, not a caller
//   UM-10 (negative) SECURITY — the read is bound to the AUTHENTICATED
//         caller's own id via contains(pulled_player_ids, [user.id]), and the
//         bound value TRACKS the authenticated identity rather than matching
//         one fixture by coincidence
//   UM-11 (negative) the full filter set is applied with the right pairing
//   UM-12 (negative) the action reads `matches` and nothing else
//   UM-13 (negative) the read is projected to id + held_ready_at, limit 1
//   UM-14 ready is decided by a null check, not by truthiness
//   UM-15 an absent held_ready_at is reserved but NOT ready
//   UM-16 a valid uppercase session id is accepted and forwarded verbatim
//
// IDs: UM
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// upcoming-match.ts imports exactly one symbol from _shared. Replacing the
// whole module keeps the real server-context auth client out of the test.
vi.mock("@/app/actions/_shared", () => ({ getAuthenticatedUser: vi.fn() }));
// @/lib/validate is deliberately NOT mocked. UM-6/UM-7 are tests OF the real
// anchored regex; stubbing it would leave the guard itself unexercised.

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser } from "@/app/actions/_shared";
import {
  getUpcomingHeldDraft,
  type UpcomingHeldDraft,
  type UpcomingHeldDraftResult,
} from "@/app/actions/upcoming-match";

// Hex letters on purpose: an all-digit UUID is unchanged by toUpperCase(), and
// UM-16 would then pass against a `.toLowerCase()` rewrite of the caller's id.
const SESSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const USER = { id: "1111aaaa-2222-4bbb-8ccc-3333dddd4444" };
const OTHER_PLAYER = { id: "9999eeee-8888-4fff-9aaa-7777bbbb6666" };

const STAMP = "2026-08-21T10:00:00.000Z";

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };

/**
 * Chainable builder that records every filter, projection and bound it is
 * given, so a test can assert on WHICH column was bound to WHICH value. A mock
 * that only records the table name cannot see a dropped or swapped filter,
 * which is the entire class of defect this file exists to catch.
 *
 * `then` is what makes the builder awaitable: the action awaits the chain
 * directly, with no .single()/.maybeSingle() terminator.
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
  b["contains"] = (col: string, val: unknown) => {
    ops.push(`contains:${col}=${JSON.stringify(val)}`);
    return b;
  };
  b["limit"] = (n: number) => {
    ops.push(`limit:${n}`);
    return b;
  };
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

/** Service client that answers every table with `resp` and logs the call. */
function serviceClient(resp: Resp, recorded: Recorded[]) {
  return {
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(resp, entry.ops);
    }),
  };
}

function useServiceClient(resp: Resp): Recorded[] {
  const recorded: Recorded[] = [];
  vi.mocked(createServiceClient).mockReturnValue(
    serviceClient(resp, recorded) as unknown as ReturnType<typeof createServiceClient>
  );
  return recorded;
}

/** `undefined` is a legitimate input here — UM-9 asserts it is refused. */
function authedAs(user: { id: string } | null | undefined) {
  vi.mocked(getAuthenticatedUser).mockResolvedValue(
    user as unknown as Awaited<ReturnType<typeof getAuthenticatedUser>>
  );
}

function opsFor(recorded: Recorded[], table: string): string[] {
  const entry = recorded.find((r) => r.table === table);
  expect(entry, `no query was issued against \`${table}\` at all`).toBeDefined();
  return entry?.ops ?? [];
}

/** Narrows the result union while carrying the house-style failure message. */
function expectSuccess(r: UpcomingHeldDraftResult, why: string): UpcomingHeldDraft {
  expect(r.success, why).toBe(true);
  if (!r.success) throw new Error(`unreachable: ${r.error}`);
  return r.upcoming;
}

function expectFailure(r: UpcomingHeldDraftResult, why: string): string {
  expect(r.success, why).toBe(false);
  if (r.success) throw new Error("unreachable: expected a failure result");
  return r.error;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every downstream step is wired to SUCCEED by default. A negative that
  // asserts a step did not run is therefore proving the gate standing in front
  // of it, not a stub that was never going to work.
  authedAs(USER);
  useServiceClient({ data: [], error: null });
});

// ── The reservation/ready state machine ───────────────────────
describe("UM: getUpcomingHeldDraft — reservation state", () => {
  it("UM-1: a pending held draft with held_ready_at null reports reserved, not ready", async () => {
    useServiceClient({ data: [{ id: "m1", held_ready_at: null }], error: null });

    const up = expectSuccess(
      await getUpcomingHeldDraft(SESSION_ID),
      "a well-formed read of an existing held draft did not succeed"
    );

    expect(
      up.reserved,
      "a pending held draft naming the caller did not register as a reservation"
    ).toBe(true);
    expect(up.ready, "a draft whose source match has NOT freed was reported ready").toBe(false);
  });

  it("UM-2: a held draft with a held_ready_at timestamp reports ready", async () => {
    useServiceClient({ data: [{ id: "m1", held_ready_at: STAMP }], error: null });

    const up = expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");

    expect(up.reserved, "a stamped held draft stopped counting as a reservation").toBe(true);
    expect(
      up.ready,
      "a stamped held_ready_at did not flip ready — the 'up right after this' wording would never appear"
    ).toBe(true);
  });

  it("UM-3: no matching row reports neither reserved nor ready, and is NOT an error", async () => {
    useServiceClient({ data: [], error: null });

    const r = await getUpcomingHeldDraft(SESSION_ID);
    const up = expectSuccess(
      r,
      "no held draft must be a normal, successful 'nothing upcoming', not an error"
    );

    expect(up.reserved, "a player with no held draft was told a spot was reserved").toBe(false);
    expect(up.ready, "a player with no held draft was told they were up next").toBe(false);
  });

  it("UM-4: a null data payload with no error is handled without throwing", async () => {
    // The shape supabase-js hands back when the row set is absent rather than
    // empty. Distinct from UM-3, which exercises the empty-array path.
    useServiceClient({ data: null, error: null });

    let r: UpcomingHeldDraftResult | undefined;
    let threw: unknown = null;
    try {
      r = await getUpcomingHeldDraft(SESSION_ID);
    } catch (e) {
      threw = e;
    }

    expect(
      threw,
      "a null data payload must degrade to 'nothing upcoming', not crash the player dashboard fetch"
    ).toBeNull();

    const up = expectSuccess(
      r as UpcomingHeldDraftResult,
      "a null data payload was reported as a read failure"
    );
    expect(up.reserved, "a null data payload was read as a reservation").toBe(false);
    expect(up.ready, "a null data payload was read as ready").toBe(false);
  });

  it("UM-14: ready is decided by a null check, not by truthiness", async () => {
    // A present-but-falsy stamp. The action compares against null on purpose;
    // a truthiness test would silently reclassify this row as "not ready".
    useServiceClient({ data: [{ id: "m1", held_ready_at: "" }], error: null });

    const up = expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");

    expect(up.reserved, "a matching row must count as a reservation regardless of the stamp").toBe(
      true
    );
    expect(
      up.ready,
      "ready is being decided by truthiness, so any falsy-but-present stamp reads as 'not ready' and the player is never told they are up next"
    ).toBe(true);
  });

  it("UM-15: a row with no held_ready_at field at all is reserved but not ready", async () => {
    // The property absent rather than null — what UM-1 cannot see, because
    // UM-1's row carries an explicit null.
    useServiceClient({ data: [{ id: "m1" }], error: null });

    const up = expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");

    expect(up.reserved, "a matching row must count as a reservation regardless of the stamp").toBe(
      true
    );
    expect(
      up.ready,
      "an absent stamp was treated as ready — the loose != null comparison is what makes undefined and null behave alike, and tightening it tells a still-Holding player they are up next"
    ).toBe(false);
  });

  it("UM-5 (negative): a query error returns success:false with no upcoming payload", async () => {
    useServiceClient({ data: null, error: { message: "boom" } });

    const r = await getUpcomingHeldDraft(SESSION_ID);
    const err = expectFailure(
      r,
      "a failed read was reported to the player as a definitive 'no upcoming match'"
    );

    expect(err, "the read-failure message changed shape").toBe("Failed to check upcoming match.");
    expect(
      "upcoming" in r,
      "a failure result must not carry an upcoming payload the caller could read"
    ).toBe(false);
  });
});

// ── Guard order: the id guard, then auth, then the DB ─────────
describe("UM: getUpcomingHeldDraft — input and auth gates", () => {
  it("UM-6 (negative): a malformed session id is rejected BEFORE auth is consulted", async () => {
    // A perfectly good auth session exists and the service client is wired to
    // return a row, so the ONLY thing that can stop either running is the
    // position of the UUID guard.
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: STAMP }], error: null });

    const err = expectFailure(
      await getUpcomingHeldDraft("not-a-uuid"),
      "a malformed session id was accepted"
    );

    expect(err, "the invalid-id message changed shape").toBe("Invalid session ID.");
    expect(
      vi.mocked(getAuthenticatedUser),
      "the UUID guard ran after the auth gate — a malformed id now costs an auth round trip and the ordering that protects the DB read is gone"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(createServiceClient),
      "a malformed session id reached the service-role client"
    ).not.toHaveBeenCalled();
    expect(recorded, "a malformed session id reached the database").toEqual([]);
  });

  const MALFORMED: [string, string][] = [
    ["an empty string", ""],
    ["whitespace-padded", `  ${SESSION_ID}  `],
    ["newline-suffixed", `${SESSION_ID}\n`],
    ["truncated by one hex digit", SESSION_ID.slice(0, -1)],
    ["carrying a non-hex character", `0000000g${SESSION_ID.slice(8)}`],
    ["a SQL-injection string", "x' OR 1=1--"],
  ];

  for (const [label, input] of MALFORMED) {
    it(`UM-7 (negative): rejects a session id that is ${label}`, async () => {
      const recorded = useServiceClient({
        data: [{ id: "m1", held_ready_at: STAMP }],
        error: null,
      });

      const err = expectFailure(
        await getUpcomingHeldDraft(input),
        `a session id that is ${label} was accepted as well-formed`
      );

      expect(err, "the invalid-id message changed shape").toBe("Invalid session ID.");
      expect(
        vi.mocked(createServiceClient),
        "a value that only LOOKS like a session id reached the service-role client"
      ).not.toHaveBeenCalled();
      expect(recorded, "a malformed session id reached the database").toEqual([]);
    });
  }

  it("UM-8 (negative): an unauthenticated caller is refused before any service client", async () => {
    authedAs(null);
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: STAMP }], error: null });

    const r = await getUpcomingHeldDraft(SESSION_ID);
    const err = expectFailure(r, "an unauthenticated caller was served a reservation answer");

    expect(err, "the unauthenticated message changed shape").toBe("Not authenticated.");
    expect("upcoming" in r, "a refusal carried an upcoming payload").toBe(false);
    expect(
      vi.mocked(createServiceClient),
      "an unauthenticated request reached the service-role client — with no user.id there is nothing to scope the query to, so the read would be unscoped"
    ).not.toHaveBeenCalled();
    expect(recorded, "an unauthenticated request reached the database").toEqual([]);
  });

  it("UM-9 (negative): an undefined user is treated as unauthenticated, not as a caller", async () => {
    authedAs(undefined);
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: STAMP }], error: null });

    const err = expectFailure(
      await getUpcomingHeldDraft(SESSION_ID),
      "an absent user slipped past the auth gate because the check compares against null by identity"
    );

    expect(err, "the unauthenticated message changed shape").toBe("Not authenticated.");
    expect(
      vi.mocked(createServiceClient),
      "an absent user reached the service-role client, where user.id is undefined and the caller scope collapses"
    ).not.toHaveBeenCalled();
    expect(recorded, "an absent user reached the database").toEqual([]);
  });
});

// ── The query shape IS the security boundary ──────────────────
describe("UM: getUpcomingHeldDraft — service-role query shape", () => {
  it("UM-10 (negative): the read is bound to the AUTHENTICATED caller's own id", async () => {
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: null }], error: null });

    expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");

    const ops = opsFor(recorded, "matches");
    const containsOps = ops.filter((o) => o.startsWith("contains:"));

    expect(
      containsOps.length,
      "the caller-scoping filter was dropped entirely — the action now returns the FIRST held draft in the session regardless of who it reserves"
    ).toBeGreaterThan(0);
    expect(
      ops,
      "the held-draft read is not scoped to the caller's own id — it would surface another player's draft assignment, which the three-layer draft firewall exists to hide"
    ).toContain(`contains:pulled_player_ids=${JSON.stringify([USER.id])}`);
    for (const op of containsOps) {
      expect(
        op,
        "the caller-scoping filter was bound to the session id instead of the caller's id"
      ).not.toContain(SESSION_ID);
    }

    // Same call as a DIFFERENT authenticated player. The bound value must move
    // with the identity; a fixture that merely happens to equal USER.id, or a
    // hard-coded id, passes the assertion above and fails this one.
    authedAs(OTHER_PLAYER);
    const recordedOther = useServiceClient({
      data: [{ id: "m2", held_ready_at: null }],
      error: null,
    });
    expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");

    expect(
      opsFor(recordedOther, "matches"),
      "the caller-scoping filter does not track the authenticated identity — every caller is handed the same player's reservation"
    ).toContain(`contains:pulled_player_ids=${JSON.stringify([OTHER_PLAYER.id])}`);
  });

  it("UM-11 (negative): the full filter set is applied with the correct pairing", async () => {
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: null }], error: null });

    expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");
    const ops = opsFor(recorded, "matches");

    expect(
      ops,
      "the read is not scoped to this session — a held draft from another session would be reported as this session's upcoming match"
    ).toContain(`eq:session_id=${SESSION_ID}`);
    expect(
      ops,
      "a completed or in_progress match could be reported as an upcoming reservation"
    ).toContain("eq:status=pending");
    expect(
      ops,
      "an ordinary unpublished draft would be reported as a held cross-court reservation, which is a different lifecycle with different copy"
    ).toContain("eq:is_held=true");
  });

  it("UM-12 (negative): the action reads the matches table and nothing else", async () => {
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: STAMP }], error: null });

    expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");

    expect(
      recorded.map((r) => r.table),
      "the service-role lookup widened beyond the caller's own reservation row — reading match_players or profiles here pulls the firewalled draft's roster, which the module header promises it never touches"
    ).toEqual(["matches"]);
  });

  it("UM-13 (negative): the read is projected to id + held_ready_at and bounded to one row", async () => {
    const recorded = useServiceClient({ data: [{ id: "m1", held_ready_at: null }], error: null });

    expectSuccess(await getUpcomingHeldDraft(SESSION_ID), "a well-formed read failed");
    const ops = opsFor(recorded, "matches");

    expect(
      ops,
      "the service-role read of a firewalled draft row was widened — the roster columns this action must never load are now in memory one field access away from the return value"
    ).toContain("select:id, held_ready_at");
    expect(ops, "the caller-scoped read is no longer bounded to a single row").toContain("limit:1");
  });

  it("UM-16: a valid session id in uppercase is accepted and forwarded verbatim", async () => {
    const upper = SESSION_ID.toUpperCase();
    const recorded = useServiceClient({ data: [], error: null });

    expectSuccess(
      await getUpcomingHeldDraft(upper),
      "the case-insensitive UUID guard rejected an uppercase session id"
    );

    expect(
      opsFor(recorded, "matches"),
      "a valid session id was rewritten before it reached the query — the value the action filters on must be the value the caller passed"
    ).toContain(`eq:session_id=${upper}`);
  });
});
