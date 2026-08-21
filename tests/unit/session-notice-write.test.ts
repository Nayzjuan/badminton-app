// ============================================================
// Session notice WRITE helper — the best-effort layer (NW)
// ============================================================
// src/lib/session-notice-write.ts is the only writer of
// `session_notifications`. It is deliberately BEST-EFFORT: the notice inbox is
// a convenience surface bolted onto flows (leave, checkout, long pause, score
// correction) that must keep working when the table is absent. So every write
// failure it recognises is swallowed — no throw, no error returned, nothing the
// caller can branch on.
//
// That design makes every bug in this file SILENT. A helper that never inserts
// anything, a helper whose insert names the wrong columns, a helper whose
// `isMissingNoticeTable` returns true too readily and eats a permission-denied
// or a constraint violation — all four look EXACTLY like the healthy module
// from the outside: the calling action returns success, the UI updates, and the
// organizer's inbox is simply empty forever. There is no red anything.
//
// The only defence is to test both halves of every degradation as a PAIR:
//   - the write really happens on the good path, with the exact payload; and
//   - the recognised failure degrades quietly, while an UNRECOGNISED one does
//     not get the same free pass.
// Assert only the first and a swallow-everything helper passes. Assert only the
// second and a helper that never writes passes. Both, and neither does.
//
// ── WHERE THIS FILE SITS AMONG THE THREE NOTICE SUITES ──────
// Three files cover session notices and they must not be confused:
//
//   tests/unit/session-notifications.test.ts        the SELECTOR / COPY layer.
//       Pure functions over a row that already exists — noticeTitle, noticeBody,
//       kindLabel, countsAsUnread, shouldInterrupt, capCenterQueue,
//       shouldBroadcastAfterNoticeInsert, upsertNotification. No client, no I/O.
//
//   tests/integration/session-notifications.test.ts (Suite SN)  the REAL-DB
//       contract — the partial unique indexes, the RLS policy, the absent
//       INSERT grant, the SECURITY DEFINER RPC. Things a mock structurally
//       cannot fail.
//
//   THIS FILE (NW)                                   the WRITE helper between
//       them: which columns the insert names, which column=value pairs bind the
//       read and the update, which errors are recognised as "table absent", and
//       what the broadcast carries in each case. Not the copy, not the schema.
//
// ── Tests ───────────────────────────────────────────────────
// isMissingNoticeTable — the discrimination that decides what gets swallowed
//   NW-1   recognises both codes it is meant to recognise (42P01, PGRST205)
//   NW-2   recognises both message shapes, case-insensitively
//   NW-3   (negative) null is not a missing table
//   NW-4   (edge) an empty error object is not a missing table
//   NW-5   (negative) a DIFFERENT error code is not a missing table
//   NW-6   (negative) "does not exist" about ANOTHER relation is not a match
//   NW-7   (negative) a message naming session_notifications for any OTHER
//          reason is not a match
//   NW-8   (edge) an absent message with a recognised code still matches; an
//          absent message with no code does not
//
// emitOrganizerNotice
//   NW-9   the happy write — exact insert payload, projection, single row
//   NW-10  (edge) defaults: status "unread", match_id null, cancelledDraft false
//   NW-11  status and match_id are FORWARDED, not hard-coded
//   NW-12  the broadcast carries the inserted row and the caller's fields
//   NW-13  (negative) a missing table is swallowed — no throw, NOT logged, and
//          the broadcast STILL fires (paired with NW-9/NW-12)
//   NW-14  (negative) a DIFFERENT insert error IS logged, and still broadcasts
//   NW-15  (negative) a unique violation returns duplicate:true and the
//          broadcast is never STARTED (guard order, paired with NW-12)
//   NW-16  (edge) data null with no error broadcasts notification:null
//   NW-17  (negative) the write touches session_notifications and nothing else
//
// closePendingScoreCorrections
//   NW-18  the read is bound match_id=X AND kind=score_correction AND
//          status IN (unread, read) — column=value pairs, not filter counts
//   NW-19  the update repeats all three bounds and writes the close columns
//   NW-20  nextStatus is forwarded, not hard-coded to "resolved"
//   NW-21  one broadcast per pending row, each on that ROW's own session
//   NW-22  the stamp broadcast to clients is the stamp written to the row
//   NW-23  (edge) zero pending rows — the update is never STARTED
//   NW-24  (edge) a null pending payload — the update is never STARTED
//   NW-25  (negative) a read error stops before the update, with the update
//          wired to succeed so only the guard can be what stopped it
//   NW-26  (negative) a missing table on the read is silent, a different read
//          error is logged
//   NW-27  (negative) an update error stops before any broadcast; missing-table
//          silent, other logged
//
// ── WHAT THIS FILE DOES NOT PROVE ───────────────────────────
//   - That the partial unique index exists, or that a duplicate pending
//     correction is actually rejected by Postgres. The 23505 branch here is
//     driven by a stubbed error; only a real database can produce one.
//     Covered by Suite SN (tests/integration/session-notifications.test.ts).
//   - The RLS policy, the grants, or resolve_score_correction. Suite SN.
//   - What any notice READS as — titles, bodies, unread rules, interrupt rules,
//     center-queue capping. Covered by tests/unit/session-notifications.test.ts.
//   - That broadcastQueueNotice reaches a real channel, or that the realtime
//     join is authorized. broadcast.ts is mocked here; Suite RB owns that.
//   - Which callers invoke these helpers, and whether they are authorized to.
//     The organizer gates live in the calling actions and are tested there.
//
// IDs: NW
// ============================================================

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Each factory REPLACES the whole module, so every export the module under
// test imports has to appear. session-notice-write.ts imports exactly one
// symbol from each of these three.
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({ getActorContext: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({ broadcastQueueNotice: vi.fn() }));

import { createServiceClient } from "@/utils/supabase/service";
import { getActorContext } from "@/app/actions/_shared";
import { broadcastQueueNotice } from "@/lib/broadcast";
// Type-only, so it is erased before the vi.mock factory above replaces the module.
import type { QueueNoticePayload } from "@/lib/broadcast";
import {
  isMissingNoticeTable,
  emitOrganizerNotice,
  closePendingScoreCorrections,
} from "@/lib/session-notice-write";
import type { SessionNotification } from "@/types/database";

const SESSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_SESSION_ID = "5f4e3d2c-1b0a-4c9d-8e7f-6a5b4c3d2e1f";
const MATCH_ID = "11112222-3333-4444-8555-666677778888";
const SUBJECT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const OTHER_SUBJECT_ID = "22223333-4444-4555-8666-777788889999";
const ACTOR_ID = "99998888-7777-4666-8555-444433332222";
const ACTOR_NAME = "Miggy";

/** Pinned via fake timers so NW-22 can compare the DB write to the broadcast. */
const NOW = "2026-08-21T10:00:00.000Z";

// The module deliberately logs the errors it does NOT swallow. Silence them so
// a passing run has a clean transcript, but keep the handle: NW-13/NW-14 and
// NW-26/NW-27 exist precisely to assert which side of that line an error fell.
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// ── Mock harness ──────────────────────────────────────────────

type PgError = { message?: string; code?: string };
type Resp = { data?: unknown; error?: PgError | null };
type Recorded = { table: string; ops: string[]; payload?: unknown };

/**
 * Chainable builder that records WHICH column was bound to WHICH value, plus
 * the object handed to insert()/update(). A mock that only counts calls cannot
 * see a swapped .eq() argument — and a swapped-argument mutant makes exactly
 * the same number of calls as the correct code, which is the whole class of
 * defect NW-18/NW-19 exist to catch.
 *
 * `then` is what makes the builder awaitable: closePendingScoreCorrections
 * awaits both of its chains directly, with no terminator. `maybeSingle` is the
 * emit path's terminator.
 */
function builder(resolveResp: () => Resp, entry: Recorded) {
  const b: Record<string, unknown> = {};
  b["select"] = (cols: string) => {
    entry.ops.push(`select:${cols}`);
    return b;
  };
  b["insert"] = (row: unknown) => {
    entry.ops.push("insert");
    entry.payload = row;
    return b;
  };
  b["update"] = (patch: unknown) => {
    entry.ops.push("update");
    entry.payload = patch;
    return b;
  };
  b["eq"] = (col: string, val: unknown) => {
    entry.ops.push(`eq:${col}=${String(val)}`);
    return b;
  };
  b["in"] = (col: string, vals: unknown) => {
    entry.ops.push(`in:${col}=${JSON.stringify(vals)}`);
    return b;
  };
  b["maybeSingle"] = () => {
    entry.ops.push("maybeSingle");
    return Promise.resolve(resolveResp());
  };
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resolveResp()).then(res, rej);
  return b;
}

type Responses = { insert?: Resp; read?: Resp; update?: Resp };

/**
 * The response is chosen LAZILY, from the operations the chain actually
 * performed, rather than from the order of `from()` calls. That matters for the
 * guard-order tests: if a mutation makes the code issue an extra query it was
 * meant to skip, that query still gets a sensible, SUCCEEDING answer instead of
 * falling off the end of a fixed queue — so the test fails on the assertion
 * that names the guard, not on a starved stub.
 */
function serviceClient(responses: Responses, recorded: Recorded[]) {
  return {
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(() => {
        if (entry.ops.includes("insert")) return responses.insert ?? { data: null, error: null };
        if (entry.ops.includes("update")) return responses.update ?? { data: null, error: null };
        return responses.read ?? { data: [], error: null };
      }, entry);
    }),
  };
}

function useServiceClient(responses: Responses): Recorded[] {
  const recorded: Recorded[] = [];
  vi.mocked(createServiceClient).mockReturnValue(
    serviceClient(responses, recorded) as unknown as ReturnType<typeof createServiceClient>
  );
  return recorded;
}

function entriesOfKind(recorded: Recorded[], kind: "insert" | "update" | "read"): Recorded[] {
  return recorded.filter((e) =>
    kind === "read" ? !e.ops.includes("insert") && !e.ops.includes("update") : e.ops.includes(kind)
  );
}

function soleEntry(
  recorded: Recorded[],
  kind: "insert" | "update" | "read",
  why: string
): Recorded {
  const found = entriesOfKind(recorded, kind);
  expect(found.length, why).toBe(1);
  return found[0] as Recorded;
}

function noticeRow(over: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: "n1",
    session_id: SESSION_ID,
    kind: "score_correction",
    status: "unread",
    subject_player_id: SUBJECT_ID,
    match_id: MATCH_ID,
    payload: { playerName: "Alex", proposedScoreA: 21, proposedScoreB: 19 },
    resolved_by: null,
    resolved_at: null,
    created_at: "2026-08-21T09:00:00.000Z",
    ...over,
  };
}

/** The one argument list broadcastQueueNotice was called with, or a failure. */
function soleBroadcast(why: string): [string, QueueNoticePayload] {
  const calls = vi.mocked(broadcastQueueNotice).mock.calls;
  expect(calls.length, why).toBe(1);
  const [channelSessionId, payload] = calls[0] as [string, QueueNoticePayload];
  return [channelSessionId, payload];
}

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy.mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  // Every downstream step is wired to SUCCEED by default, so a negative that
  // asserts a step did not run is proving the guard in front of it rather than
  // a stub that was never going to work.
  vi.mocked(broadcastQueueNotice).mockResolvedValue(undefined);
  vi.mocked(getActorContext).mockResolvedValue({ id: ACTOR_ID, name: ACTOR_NAME });
  useServiceClient({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ── isMissingNoticeTable: what gets swallowed, and what must not ──
describe("NW: isMissingNoticeTable — the swallow/report discrimination", () => {
  it("NW-1: recognises both of the codes it is meant to recognise", () => {
    // Positive control for NW-5/NW-6/NW-7. Without it, a helper hard-wired to
    // `return false` satisfies every negative in this describe block.
    expect(
      isMissingNoticeTable({ code: "42P01", message: 'relation "x" does not exist' }),
      "Postgres 42P01 (undefined_table) is no longer recognised — a club whose database predates the session_notifications migration now gets a logged error on every leave, checkout and pause"
    ).toBe(true);
    expect(
      isMissingNoticeTable({ code: "PGRST205", message: "Could not find the table" }),
      "PostgREST PGRST205 (table not in schema cache) is no longer recognised — the window right after the migration, before the cache reloads, now logs on every notice"
    ).toBe(true);
  });

  it("NW-2: recognises both message shapes, case-insensitively", () => {
    expect(
      isMissingNoticeTable({ message: 'relation "public.session_notifications" does not exist' }),
      "the does-not-exist message shape is no longer recognised — some drivers report the missing table by message with no usable code"
    ).toBe(true);
    expect(
      isMissingNoticeTable({
        message: "Could not find the table 'public.session_notifications' in the schema cache",
      }),
      "the schema-cache message shape is no longer recognised"
    ).toBe(true);
    expect(
      isMissingNoticeTable({ message: 'RELATION "SESSION_NOTIFICATIONS" DOES NOT EXIST' }),
      "the message match stopped being case-insensitive — the lowercasing step is what makes this robust to a driver that upper-cases identifiers"
    ).toBe(true);
  });

  it("NW-3 (negative): a null error is not a missing table", () => {
    expect(
      isMissingNoticeTable(null),
      "a SUCCESSFUL write is being classified as a missing table — every caller's 'did this fail?' check inverts and healthy inserts get treated as degraded"
    ).toBe(false);
  });

  it("NW-4 (edge): an empty error object is not a missing table", () => {
    expect(
      isMissingNoticeTable({}),
      "an error carrying neither a code nor a message is being swallowed as 'table absent' — an unrecognisable failure is exactly the one that most needs to reach the log"
    ).toBe(false);
    expect(
      isMissingNoticeTable({ message: "", code: "" }),
      "empty-string code and message are being swallowed as 'table absent'"
    ).toBe(false);
  });

  const OTHER_CODES: [string, string][] = [
    ["23505 (unique violation)", "23505"],
    ["42501 (insufficient privilege)", "42501"],
    ["23503 (foreign key violation)", "23503"],
    ["PGRST116 (no rows)", "PGRST116"],
    ["42P02 (one character off 42P01)", "42P02"],
    ["PGRST205X (a prefix match, not an equality)", "PGRST205X"],
  ];

  for (const [label, code] of OTHER_CODES) {
    it(`NW-5 (negative): code ${label} is not a missing table`, () => {
      expect(
        isMissingNoticeTable({ code, message: "boom" }),
        `error code ${code} is being swallowed as 'the notice table is absent' — a real, fixable write failure now disappears without a log line and the organizer's inbox is silently empty`
      ).toBe(false);
    });
  }

  it("NW-6 (negative): 'does not exist' about ANOTHER relation is not a match", () => {
    expect(
      isMissingNoticeTable({ message: 'relation "public.matches" does not exist' }),
      "the message check dropped its session_notifications requirement — a missing/renamed table ANYWHERE in the query now reads as 'the notice table is absent' and is swallowed silently"
    ).toBe(false);
    expect(
      isMissingNoticeTable({ message: "column resolved_by does not exist" }),
      "a missing COLUMN on session_notifications is being swallowed as a missing TABLE — the exact shape a half-applied migration produces, and the one that most needs to be loud"
    ).toBe(false);
  });

  it("NW-7 (negative): naming session_notifications for any OTHER reason is not a match", () => {
    expect(
      isMissingNoticeTable({ message: "permission denied for table session_notifications" }),
      "a permission-denied on the notice table is being swallowed as 'absent' — a revoked or missing GRANT would then look identical to a database that never had the table, and nothing would ever report it"
    ).toBe(false);
    expect(
      isMissingNoticeTable({
        message:
          'duplicate key value violates unique constraint "session_notifications_pending_correction_idx"',
      }),
      "a constraint violation naming the table is being swallowed as 'absent'"
    ).toBe(false);
  });

  it("NW-8 (edge): an absent message is tolerated, and is not itself a match", () => {
    expect(
      isMissingNoticeTable({ code: "42P01" }),
      'an error with a recognised code but NO message stopped matching (or threw) — the message is optional and the `?? ""` default is what keeps this from crashing the caller'
    ).toBe(true);
    expect(
      isMissingNoticeTable({ code: undefined, message: undefined }),
      "an error with neither field is being classified as a missing table"
    ).toBe(false);
  });
});

// ── emitOrganizerNotice: the write, and the two ways it degrades ──
describe("NW: emitOrganizerNotice — the insert", () => {
  const BASE = {
    sessionId: SESSION_ID,
    kind: "player_left" as const,
    subjectPlayerId: SUBJECT_ID,
    payload: { playerName: "Alex" },
  };

  it("NW-9: the happy path writes the exact column payload and returns the row", () => {
    const inserted = noticeRow({ id: "n-new", kind: "player_left", match_id: null });
    const recorded = useServiceClient({ insert: { data: inserted, error: null } });

    return emitOrganizerNotice({ ...BASE, matchId: MATCH_ID, status: "read" }).then((res) => {
      const entry = soleEntry(
        recorded,
        "insert",
        "the notice insert did not happen at all — this is the assertion that stops every 'it degraded gracefully' test below from being satisfied by a helper that never writes anything"
      );

      expect(
        entry.table,
        "the notice is being written to a table other than session_notifications"
      ).toBe("session_notifications");
      expect(
        entry.payload,
        "the inserted column set changed — a dropped or renamed column here is invisible to the caller, which never inspects the row, so the inbox just quietly loses a field"
      ).toEqual({
        session_id: SESSION_ID,
        kind: "player_left",
        subject_player_id: SUBJECT_ID,
        match_id: MATCH_ID,
        payload: { playerName: "Alex" },
        status: "read",
      });
      expect(
        entry.ops,
        "the insert is no longer projected back with select('*') — without the returned row the broadcast carries notification:null and every client has to refetch the inbox to see the new notice"
      ).toContain("select:*");
      expect(
        entry.ops,
        "the insert is no longer terminated with maybeSingle() — .single() would turn a zero-row return into an error and make every notice write look like a failure"
      ).toContain("maybeSingle");

      expect(
        res.row,
        "the inserted row is not being returned to the caller — the notice id is what the organizer UI upserts by"
      ).toEqual(inserted);
      expect(res.duplicate, "a successful insert was reported as a duplicate").toBe(false);
    });
  });

  it("NW-10 (edge): defaults — status unread, match_id null, cancelledDraft false", async () => {
    const recorded = useServiceClient({ insert: { data: null, error: null } });

    await emitOrganizerNotice(BASE);

    expect(
      soleEntry(recorded, "insert", "no insert was issued").payload,
      "the defaults for an omitted status/matchId changed — a notice inserted with no status is invisible to the unread counter, and a non-null match_id on a leave notice collides with the score-correction partial unique index"
    ).toEqual({
      session_id: SESSION_ID,
      kind: "player_left",
      subject_player_id: SUBJECT_ID,
      match_id: null,
      payload: { playerName: "Alex" },
      status: "unread",
    });

    const [, payload] = soleBroadcast("the broadcast did not fire on the default path");
    expect(
      payload.cancelledDraft,
      "an omitted cancelledDraft no longer defaults to false — an undefined here reaches the client card, where a missing flag reads differently from an explicit false"
    ).toBe(false);
    expect(
      payload.matchId,
      "a null matchId is being broadcast as null rather than omitted — QueueNoticePayload types matchId as `string | undefined`, so null is off-contract"
    ).toBeUndefined();
  });

  it("NW-11: status and matchId are forwarded, not hard-coded", async () => {
    const recorded = useServiceClient({ insert: { data: null, error: null } });

    await emitOrganizerNotice({
      ...BASE,
      kind: "player_paused_long",
      status: "resolved",
      matchId: MATCH_ID,
      payload: { playerName: "Alex", bucket: 3, interrupt: true, cancelledDraft: true },
    });

    const entry = soleEntry(recorded, "insert", "no insert was issued");
    expect(
      entry.payload,
      "a caller-supplied status/matchId/kind is being overwritten by the helper's defaults — the pause-reminder bucket rows would all collapse onto one shape"
    ).toEqual({
      session_id: SESSION_ID,
      kind: "player_paused_long",
      subject_player_id: SUBJECT_ID,
      match_id: MATCH_ID,
      payload: { playerName: "Alex", bucket: 3, interrupt: true, cancelledDraft: true },
      status: "resolved",
    });
  });

  it("NW-12: the broadcast carries the inserted row and the caller's fields", async () => {
    const inserted = noticeRow({ id: "n-new", kind: "score_correction" });
    useServiceClient({ insert: { data: inserted, error: null } });

    await emitOrganizerNotice({
      sessionId: SESSION_ID,
      kind: "score_correction",
      subjectPlayerId: SUBJECT_ID,
      matchId: MATCH_ID,
      payload: {
        playerName: "Alex",
        cancelledDraft: true,
        bucket: 2,
        interrupt: true,
        proposedScoreA: 21,
        proposedScoreB: 19,
      },
      actorId: ACTOR_ID,
      actorName: ACTOR_NAME,
    });

    const [channelSessionId, payload] = soleBroadcast(
      "the live notice was not broadcast — organizers would see nothing until their next full refetch"
    );

    expect(
      channelSessionId,
      "the notice is being broadcast on the wrong session's channel — organizers of one session would receive another session's notices"
    ).toBe(SESSION_ID);
    expect(
      payload,
      "the broadcast payload shape changed — every field here drives a distinct behaviour on the receiving client (which card, whose card, whether it interrupts, and whether the row can be upserted by id)"
    ).toEqual({
      kind: "score_correction",
      playerId: SUBJECT_ID,
      playerName: "Alex",
      cancelledDraft: true,
      actorId: ACTOR_ID,
      actorName: ACTOR_NAME,
      notification: inserted,
      bucket: 2,
      interrupt: true,
      matchId: MATCH_ID,
      proposedScoreA: 21,
      proposedScoreB: 19,
    });
  });

  it("NW-13 (negative): a missing table is swallowed, unlogged, and still broadcasts", async () => {
    const recorded = useServiceClient({
      insert: { data: null, error: { code: "42P01", message: "relation does not exist" } },
    });

    let threw: unknown = null;
    let res: { row: SessionNotification | null; duplicate: boolean } | undefined;
    try {
      res = await emitOrganizerNotice({ ...BASE, matchId: MATCH_ID });
    } catch (e) {
      threw = e;
    }

    expect(
      threw,
      "a missing notice table now throws — this helper is called from inside leave/checkout/pause actions, so a throw here breaks the queue operation itself, which is the exact coupling best-effort exists to avoid"
    ).toBeNull();
    expect(res?.row, "a failed insert reported a row").toBeNull();
    expect(res?.duplicate, "a missing table was reported as a duplicate").toBe(false);
    expect(
      errorSpy,
      "a missing notice table is being logged as a failure — this is the ONE error the module is designed to expect, and logging it fills the server log on every queue event for a club whose database predates the migration"
    ).not.toHaveBeenCalled();

    // The half that keeps NW-13 honest: degrading must not mean going quiet.
    const [, payload] = soleBroadcast(
      "the live broadcast was skipped because the insert failed — the inbox row is optional, the toast is not, and skipping it means an organizer sees nothing at all"
    );
    expect(
      payload.notification,
      "a failed insert is being broadcast as though a row existed"
    ).toBeNull();
    expect(
      recorded.length,
      "the insert was never attempted on the missing-table path — this test must exercise a real write that failed, not a write that was skipped"
    ).toBe(1);
  });

  it("NW-14 (negative): a DIFFERENT insert error is logged, and still broadcasts", async () => {
    useServiceClient({
      insert: {
        data: null,
        error: { code: "42501", message: "permission denied for table session_notifications" },
      },
    });

    const res = await emitOrganizerNotice({ ...BASE, matchId: MATCH_ID });

    expect(
      errorSpy,
      "an unrecognised insert failure is being swallowed silently — a revoked grant, a bad column, a constraint break all vanish, and the only symptom in production is an inbox that is permanently empty"
    ).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls[0]?.[0],
      "the insert-failure log prefix changed — it is what makes this findable in the server log"
    ).toBe("[emitOrganizerNotice] insert failed:");
    expect(
      errorSpy.mock.calls[0]?.[1],
      "the log no longer carries the driver's own message, which is the only part that says WHY"
    ).toBe("permission denied for table session_notifications");

    expect(res.row, "a failed insert reported a row").toBeNull();
    expect(
      res.duplicate,
      "a permission error is being reported to the caller as a duplicate — requestScoreCorrection branches on this flag and would tell the player 'already requested'"
    ).toBe(false);
    expect(
      vi.mocked(broadcastQueueNotice),
      "an unrecognised insert error suppressed the live toast as well as the row"
    ).toHaveBeenCalledTimes(1);
  });

  it("NW-15 (negative): a unique violation returns duplicate and never starts the broadcast", async () => {
    useServiceClient({
      insert: {
        data: null,
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      },
    });

    const res = await emitOrganizerNotice({ ...BASE, kind: "score_correction", matchId: MATCH_ID });

    expect(
      res.duplicate,
      "a unique violation is no longer reported as a duplicate — the partial unique index is the ONLY thing enforcing one pending correction per match, and the caller cannot tell the player 'already requested' without this flag"
    ).toBe(true);
    expect(res.row, "a rejected insert reported a row").toBeNull();
    // The broadcast is wired to succeed (see beforeEach), so the ONLY thing
    // that can stop it running is the early return sitting in front of it.
    // NW-12 is the positive control that it does run on the good path.
    expect(
      vi.mocked(broadcastQueueNotice),
      "a rejected duplicate still broadcast a queue notice — organizers would get a second live card for a correction that was never inserted, carrying notification:null so it can never be dismissed by id"
    ).not.toHaveBeenCalled();
    expect(
      errorSpy,
      "a duplicate is being logged as an insert failure — it is an expected outcome of the partial unique index, not a fault"
    ).not.toHaveBeenCalled();
  });

  it("NW-16 (edge): a null data payload with no error broadcasts notification:null", async () => {
    useServiceClient({ insert: { data: null, error: null } });

    const res = await emitOrganizerNotice({ ...BASE, matchId: null });

    expect(res.row, "an absent row was coerced into something truthy").toBeNull();
    expect(res.duplicate, "an absent row was reported as a duplicate").toBe(false);
    const [, payload] = soleBroadcast("no broadcast fired for a null-data insert");
    expect(
      payload.notification,
      "an absent row is being broadcast as undefined rather than null — clients distinguish the two when deciding whether to upsert by id"
    ).toBeNull();
  });

  it("NW-17 (negative): the write touches session_notifications and nothing else", async () => {
    const recorded = useServiceClient({ insert: { data: noticeRow(), error: null } });

    await emitOrganizerNotice({ ...BASE, matchId: MATCH_ID });

    expect(
      recorded.map((r) => r.table),
      "the service-role notice writer widened beyond session_notifications — this module holds the service client precisely because it is NOT a server action, and any extra table it touches is an unauthorized, RLS-free write on a path with no organizer gate in front of it"
    ).toEqual(["session_notifications"]);
  });
});

// ── closePendingScoreCorrections: which rows, and which columns ──
describe("NW: closePendingScoreCorrections — the read/update binding", () => {
  it("NW-18: the read is bound to this match, this kind, and the pending statuses", async () => {
    const recorded = useServiceClient({ read: { data: [noticeRow()], error: null } });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    const ops = soleEntry(recorded, "read", "no pending-notice read was issued at all").ops;
    expect(
      ops,
      "the pending read is not bound to this match — it would collect (and then close) every open score correction in the database"
    ).toContain(`eq:match_id=${MATCH_ID}`);
    expect(
      ops,
      "the pending read is not bound to kind=score_correction — leave, checkout and pause notices for the same match would be swept into the close"
    ).toContain("eq:kind=score_correction");
    expect(
      ops,
      "the pending-status filter changed — without it, already-resolved corrections are re-resolved and re-broadcast on every score edit"
    ).toContain(`in:status=${JSON.stringify(["unread", "read"])}`);
    // Pairing, not presence: two eq() calls with the values swapped make the
    // same number of calls, so the values must be checked against each other.
    expect(
      ops.filter((o) => o.startsWith("eq:")).length,
      "the read grew or lost an eq() filter — the exact pair (match_id, kind) is what scopes this to one match's corrections"
    ).toBe(2);
    // The rows this read returns are handed straight to the broadcast loop,
    // which reads session_id, subject_player_id and payload off each one. A
    // narrowed projection would leave those undefined on the wire — and no
    // mock can see that, because a stub returns whole rows whatever is asked
    // for. So the projection itself has to be the assertion.
    expect(
      ops,
      "the pending read is no longer projected with select('*') — the close broadcast reads session_id, subject_player_id and payload.playerName off these rows, so a narrower projection sends a notice with no session, no subject and no name"
    ).toContain("select:*");
  });

  it("NW-19: the update repeats all three bounds and writes the close columns", async () => {
    const recorded = useServiceClient({ read: { data: [noticeRow()], error: null } });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    const entry = soleEntry(
      recorded,
      "update",
      "the pending corrections were read but never actually updated — every organizer would keep seeing a correction request that the score edit already answered"
    );
    expect(
      entry.table,
      "the close is being written to a table other than session_notifications"
    ).toBe("session_notifications");
    expect(
      entry.payload,
      "the close no longer stamps the same three columns — resolved_by and resolved_at are what the organizer UI shows as 'handled by X', and a missing status leaves the row pending forever"
    ).toEqual({ status: "resolved", resolved_by: ACTOR_ID, resolved_at: NOW });

    expect(
      entry.ops,
      "the UPDATE is not bound to this match — it would resolve every pending score correction in the database, in every session and every club, on one organizer's score edit"
    ).toContain(`eq:match_id=${MATCH_ID}`);
    expect(
      entry.ops,
      "the UPDATE is not bound to kind=score_correction — leave/checkout/pause notices on the same match would be stamped resolved and vanish from the inbox"
    ).toContain("eq:kind=score_correction");
    expect(
      entry.ops,
      "the UPDATE lost its pending-status filter — an already-resolved correction would be re-stamped with a new actor and timestamp, rewriting who handled it"
    ).toContain(`in:status=${JSON.stringify(["unread", "read"])}`);
    expect(
      entry.ops.filter((o) => o.startsWith("eq:")).length,
      "the UPDATE grew or lost an eq() filter"
    ).toBe(2);
  });

  it("NW-20: nextStatus is forwarded, not hard-coded to resolved", async () => {
    const recorded = useServiceClient({ read: { data: [noticeRow()], error: null } });

    await closePendingScoreCorrections(MATCH_ID, "superseded", ACTOR_ID);

    expect(
      soleEntry(recorded, "update", "no update was issued").payload,
      "the caller's nextStatus is being ignored — 'superseded' (the score was changed again) and 'resolved' (the correction was acted on) are different outcomes and the inbox renders them differently"
    ).toEqual({ status: "superseded", resolved_by: ACTOR_ID, resolved_at: NOW });

    const calls = vi.mocked(broadcastQueueNotice).mock.calls;
    expect(calls.length, "the supersede was not broadcast").toBe(1);
    expect(
      calls[0]?.[1].notification?.status,
      "the broadcast row carries a different status from the one written to the database — the client's optimistic copy and the row would disagree until the next refetch"
    ).toBe("superseded");
  });

  it("NW-21: one broadcast per pending row, each on that row's own session", async () => {
    // Two rows from DIFFERENT sessions and different subjects. A loop that
    // reuses the first row (or the actor's session) passes a one-row fixture.
    const rowA = noticeRow({
      id: "n-a",
      session_id: SESSION_ID,
      subject_player_id: SUBJECT_ID,
      payload: { playerName: "Alex" },
    });
    const rowB = noticeRow({
      id: "n-b",
      session_id: OTHER_SESSION_ID,
      subject_player_id: OTHER_SUBJECT_ID,
      payload: { playerName: "Bea" },
    });
    useServiceClient({ read: { data: [rowA, rowB], error: null } });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    const calls = vi.mocked(broadcastQueueNotice).mock.calls;
    expect(
      calls.length,
      "the close broadcast one notice for many pending rows — every row after the first stays on screen as an unanswered correction request"
    ).toBe(2);

    expect(
      calls.map((c) => c[0]),
      "the close notices are not being sent on each ROW's own session channel — a row is broadcast to a session that cannot see it, and the session that can never hears the resolution"
    ).toEqual([SESSION_ID, OTHER_SESSION_ID]);
    expect(
      calls.map((c) => c[1].playerId),
      "the per-row subject is not being carried — every close card would be attributed to the same player"
    ).toEqual([SUBJECT_ID, OTHER_SUBJECT_ID]);
    expect(
      calls.map((c) => c[1].playerName),
      "the per-row player name is not being carried"
    ).toEqual(["Alex", "Bea"]);

    expect(
      calls[0]?.[1],
      "the close broadcast payload shape changed — actorName comes from getActorContext and is what the card shows as who handled it; interrupt:false is what keeps a resolution from stealing focus like a new request does"
    ).toEqual({
      kind: "score_correction",
      playerId: SUBJECT_ID,
      playerName: "Alex",
      cancelledDraft: false,
      actorId: ACTOR_ID,
      actorName: ACTOR_NAME,
      matchId: MATCH_ID,
      interrupt: false,
      notification: { ...rowA, status: "resolved", resolved_by: ACTOR_ID, resolved_at: NOW },
    });
    expect(
      vi.mocked(getActorContext).mock.calls,
      "the actor name is being resolved for someone other than the acting organizer"
    ).toEqual([[ACTOR_ID]]);
  });

  it("NW-22: the stamp broadcast to clients is the stamp written to the row", async () => {
    const recorded = useServiceClient({ read: { data: [noticeRow()], error: null } });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    const written = (
      soleEntry(recorded, "update", "no update was issued").payload as {
        resolved_at: string;
      }
    ).resolved_at;
    const [, payload] = soleBroadcast("no close notice was broadcast");
    const broadcastStamp = (payload.notification as SessionNotification).resolved_at;

    expect(written, "resolved_at is no longer taken from the clock at close time").toBe(NOW);
    expect(
      broadcastStamp,
      "the timestamp handed to clients is computed separately from the one written to the row — two calls to new Date() cannot be assumed equal, and the client's copy would drift from the database on every close"
    ).toBe(written);
  });

  it("NW-23 (edge): zero pending rows — the update is never started", async () => {
    const recorded = useServiceClient({ read: { data: [], error: null } });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    // The update response is wired to succeed, so nothing but the emptiness
    // guard can be what stopped it. NW-19 is the positive control.
    expect(
      entriesOfKind(recorded, "update"),
      "an UPDATE was issued with no pending rows to close — a filter-only update against a busy table for every score edit on every match, doing nothing"
    ).toEqual([]);
    expect(
      vi.mocked(getActorContext),
      "the actor profile was looked up with nothing to broadcast — a wasted service-role read on the hot score-submit path"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(broadcastQueueNotice),
      "a close notice was broadcast with no pending correction to close"
    ).not.toHaveBeenCalled();
  });

  it("NW-24 (edge): a null pending payload — the update is never started", async () => {
    // The shape supabase-js returns when the row set is absent rather than
    // empty. Distinct from NW-23, which exercises the empty-array path.
    const recorded = useServiceClient({ read: { data: null, error: null } });

    let threw: unknown = null;
    try {
      await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);
    } catch (e) {
      threw = e;
    }

    expect(
      threw,
      "a null row set crashes the close — this runs inside score submission, so the score edit itself would fail"
    ).toBeNull();
    expect(
      entriesOfKind(recorded, "update"),
      "an UPDATE was issued against a null row set"
    ).toEqual([]);
    expect(
      vi.mocked(broadcastQueueNotice),
      "a close notice was broadcast for a null row set"
    ).not.toHaveBeenCalled();
  });

  it("NW-25 (negative): a read error stops before the update", async () => {
    // The read returns rows AND an error: if the error branch were removed the
    // code would sail straight on to the update. So this asserts the guard,
    // not a starved stub.
    const recorded = useServiceClient({
      read: { data: [noticeRow()], error: { code: "42501", message: "permission denied" } },
    });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    expect(
      entriesOfKind(recorded, "update"),
      "a failed read was followed by the UPDATE anyway — the rows it would close were never actually confirmed to exist, and the broadcast that follows would name rows nobody read"
    ).toEqual([]);
    expect(
      vi.mocked(getActorContext),
      "the actor was resolved after a failed read"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(broadcastQueueNotice),
      "a resolution was broadcast to clients after the read that was supposed to find the rows failed"
    ).not.toHaveBeenCalled();
  });

  it("NW-26 (negative): a missing table on the read is silent, another error is logged", async () => {
    useServiceClient({
      read: { data: null, error: { code: "42P01", message: "relation does not exist" } },
    });
    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);
    expect(
      errorSpy,
      "a missing notice table is being logged on every score submission — the module's whole point is that a database without this table still works"
    ).not.toHaveBeenCalled();

    errorSpy.mockClear();
    useServiceClient({
      read: { data: null, error: { code: "42501", message: "permission denied" } },
    });
    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);
    expect(
      errorSpy,
      "an unrecognised read failure is silent — corrections would sit pending forever with nothing in the log to say why"
    ).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls[0]?.[0],
      "the close-failure log prefix changed — it is what makes this findable in the server log"
    ).toBe("[closePendingScoreCorrections]");
    expect(errorSpy.mock.calls[0]?.[1], "the driver's own message is no longer logged").toBe(
      "permission denied"
    );
  });

  it("NW-27 (negative): an update error stops before any broadcast", async () => {
    const recorded = useServiceClient({
      read: { data: [noticeRow()], error: null },
      update: { data: null, error: { code: "42P01", message: "relation does not exist" } },
    });

    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);

    expect(
      entriesOfKind(recorded, "update").length,
      "this test must exercise a real UPDATE that failed, not one that was skipped"
    ).toBe(1);
    expect(
      vi.mocked(broadcastQueueNotice),
      "clients were told the correction was resolved when the UPDATE that resolves it failed — the card disappears from every organizer's screen while the row stays pending in the database, so it comes back on the next refetch"
    ).not.toHaveBeenCalled();
    expect(
      errorSpy,
      "a missing notice table is being logged on the update path too"
    ).not.toHaveBeenCalled();

    errorSpy.mockClear();
    useServiceClient({
      read: { data: [noticeRow()], error: null },
      update: { data: null, error: { code: "23514", message: "check constraint violated" } },
    });
    await closePendingScoreCorrections(MATCH_ID, "resolved", ACTOR_ID);
    expect(
      errorSpy,
      "an unrecognised UPDATE failure is silent — the most consequential failure in this module, because the read succeeded and the caller has every reason to believe the close landed"
    ).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(broadcastQueueNotice),
      "clients were told the correction was resolved after an unrecognised UPDATE failure"
    ).not.toHaveBeenCalled();
  });
});
