// @vitest-environment happy-dom
// ============================================================
// useOrganizerCourts — the realtime channel that must open ONCE (OC)
// ============================================================
// This hook owns the organizer's court list and the one realtime channel that
// keeps it live. Two properties in it fail SILENTLY, which is why the file is
// dangerous:
//
//   1. SUBSCRIPTION STABILITY. `subscribeToCourts` is called from an effect
//      keyed on (supabase, sessionId, onChannelStatus) and the change handler
//      reaches the fetcher through `fetchCourtsRef.current` rather than closing
//      over `fetchCourts`. CLAUDE.md states the rule outright: "Never break the
//      subscription stability pattern." Put a render-scoped value in that
//      dependency array — `courts`, or the fetch callback once its own deps
//      widen — and the channel is torn down and re-opened on every render. The
//      production symptom is NOT an error. It is a court whose status change
//      lands during the ~1 s the socket is re-joining and never arrives, so the
//      organizer stares at a board that says "in use" for a court that finished
//      two matches ago. Nothing logs, nothing throws, and the next manual
//      refresh hides it. OC-7/OC-8/OC-9 pin the three independent ways that
//      pattern can be broken: a widened effect dep, an unstable fetch callback,
//      and the ref indirection being replaced by the callback itself.
//
//   2. A FAILED READ MUST NOT BLANK THE BOARD. `fetchCourts` commits only when
//      `data` is present; an error leaves the previous array alone. This is the
//      07/25 incident class — a degraded client fetches, gets nothing back, and
//      the hook wipes a populated list, which reads to the organizer as "all my
//      courts disappeared". OC-5 is the negative and OC-6 is its positive
//      control: an EMPTY-but-successful read still commits, otherwise removing
//      the last court could never render.
//
// The write actions are all delegated to server actions, so what this file can
// prove about them is argument PAIRING and GUARD ORDER: `updateCourtStatus`
// hands three positional ids to the server and a swapped pair is still three
// arguments; a refused action must not have started the refetch at all.
// `updateTimeLimit` is the one piece of local optimistic state — it writes the
// new limit into the session before the server answers and reverts from
// `prevTimeLimitRef` on failure. OC-16..OC-19 pin the capture, the revert, and
// the null boundary ("no time limit" is null, never 0).
//
// Tests:
//   OC-1   initial state — loading=true, courts=[] before the first read lands
//   OC-2   a successful read commits the rows verbatim, in view order
//   OC-3   courtsRef mirrors the committed courts (feeds match enrichment)
//   OC-4   the read is bound to THIS session — table, projection, column=value
//          pairing and created_at ASC ordering
//   OC-5   (negative) a read error leaves the populated board intact
//   OC-6   an empty-but-successful read DOES commit (positive control for OC-5)
//   OC-7   subscribeToCourts is called EXACTLY ONCE across re-renders and a
//          state change — the subscription-stability rule
//   OC-8   fetchCourts keeps one identity across re-renders (the precondition
//          that makes OC-7 safe to rely on)
//   OC-9   the channel handler is the ref indirection, not fetchCourts itself
//   OC-10  the channel is bound to this session and forwards the status reporter
//   OC-11  a realtime court event triggers a refetch that reaches state
//   OC-12  a sessionId change DOES re-open the channel (positive control:
//          proves OC-7 is not satisfied by a dead effect)
//   OC-12b the RE-OPENED channel's handler reads the NEW session, not the old
//          one — the freshness half of the ref pattern, which OC-9 and OC-12
//          together still cannot see
//   OC-13  unmount runs the unsubscriber returned by subscribeToCourts, once
//   OC-14  addCourt forwards (sessionId, name), refetches, returns {}
//   OC-15  (negative) a refused write returns the message and never starts the
//          refetch — for all three court actions, with pairing on each
//   OC-16  updateTimeLimit applies the new limit optimistically and keeps it
//          when the server agrees
//   OC-17  (negative) a server failure reverts to the value captured BEFORE the
//          optimistic write, and returns the error
//   OC-18  (edge) null means "no limit" and is forwarded as null, not 0
//   OC-19  (edge) the revert target tracks the LATEST confirmed value across
//          successive calls — not the value captured at mount
//   OC-20  an ACCEPTED status change and removal each refetch the board
//
// WHAT THIS FILE DOES NOT PROVE
//   - That the server actions authorize the caller. addCourtAction /
//     updateCourtStatusAction / removeCourtAction are mocked here; their
//     organizer gate is covered in tests/unit/courts-actions.test.ts, and
//     updateSessionSettings' gate in tests/unit/close-session-timeout.test.ts
//     and the sessions suites.
//   - That subscribeToCourts actually joins a Postgres channel, sets auth
//     before subscribe, or names the channel correctly. That is
//     tests/unit/realtime-auth-recycle.test.ts and the realtime suites; here it
//     is a spy and only the CALL is observable.
//   - Anything about how courts are rendered, or how courtsRef is consumed by
//     useOrganizerMatches — that composition lives in use-organizer-data.ts,
//     which is integration-tested.
//
// IDs: OC
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Court, Database, Session } from "@/types/database";

// ── Realtime spy ──────────────────────────────────────────────
// The hook imports exactly one symbol from @/lib/realtime. Replacing the whole
// module keeps the real channel machinery (and its auth-ready promise) out of
// the test; every subscribe is recorded so a stability regression is countable.

type CourtSub = {
  client: unknown;
  sessionId: unknown;
  handler: () => void;
  channelPrefix: unknown;
  onStatus: unknown;
  unsub: ReturnType<typeof vi.fn>;
};

let courtSubs: CourtSub[] = [];

vi.mock("@/lib/realtime", () => ({
  subscribeToCourts: (
    client: unknown,
    sessionId: unknown,
    handler: () => void,
    channelPrefix: unknown,
    onStatus: unknown
  ) => {
    const unsub = vi.fn();
    courtSubs.push({ client, sessionId, handler, channelPrefix, onStatus, unsub });
    return unsub;
  },
}));

// ── Server-action spies ───────────────────────────────────────
// A vi.mock factory REPLACES the module: an omitted export is `undefined` at
// import time, so every symbol the hook imports has to be listed here.
vi.mock("@/app/actions/courts", () => ({
  addCourtAction: vi.fn(),
  updateCourtStatusAction: vi.fn(),
  removeCourtAction: vi.fn(),
}));

vi.mock("@/app/actions/sessions", () => ({
  updateSessionSettings: vi.fn(),
}));

import { useOrganizerCourts } from "@/hooks/use-organizer-courts";
import { addCourtAction, updateCourtStatusAction, removeCourtAction } from "@/app/actions/courts";
import { updateSessionSettings } from "@/app/actions/sessions";

const mockAddCourt = vi.mocked(addCourtAction);
const mockUpdateStatus = vi.mocked(updateCourtStatusAction);
const mockRemoveCourt = vi.mocked(removeCourtAction);
const mockUpdateSettings = vi.mocked(updateSessionSettings);

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_SESSION_ID = "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f";

function makeCourt(name: string, status: Court["status"] = "available"): Court {
  return {
    id: `court-${name}`,
    session_id: SESSION_ID,
    name,
    status,
    created_at: "2026-08-21T09:00:00.000Z",
  };
}

function makeSession(timeLimit: number | null): Session {
  return {
    id: SESSION_ID,
    name: "Friday Night",
    created_by: "11111111-1111-4111-8111-111111111111",
    club_id: "22222222-2222-4222-8222-222222222222",
    organizer_passcode: null,
    scoring: "single",
    is_active: true,
    is_auto_matchmaking_on: false,
    court_time_limit_minutes: timeLimit,
    max_auto_drafts_override: null,
    auto_publish: false,
    is_hidden: false,
    created_at: "2026-08-21T08:00:00.000Z",
    ended_at: null,
  };
}

// ── Recording Supabase stub ───────────────────────────────────
// A mock that records only the table name cannot see a dropped or swapped
// filter — three eq() calls with two values transposed is still three eq()
// calls. So every projection, filter and ordering is recorded as
// `op:column=value`, and OC-4 asserts the PAIRS.

type Recorded = { table: string; ops: string[] };
type CourtsResponse = { data: Court[] | null; error: { message: string } | null };

let recorded: Recorded[] = [];
let courtsResponse: CourtsResponse = { data: [], error: null };

function buildSupabase(): SupabaseClient<Database> {
  return {
    from(table: string) {
      const rec: Recorded = { table, ops: [] };
      recorded.push(rec);
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          rec.ops.push(`select:${cols}`);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          rec.ops.push(`eq:${col}=${String(val)}`);
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          rec.ops.push(`order:${col}:${opts?.ascending ? "asc" : "desc"}`);
          return chain;
        },
        then: (onFulfilled: (v: CourtsResponse) => unknown) =>
          Promise.resolve(courtsResponse).then(onFulfilled),
      };
      return chain;
    },
  } as unknown as SupabaseClient<Database>;
}

/** One client identity for the whole file — an unstable client would make the
 *  subscription-stability assertions vacuous (the effect legitimately depends
 *  on it), so it is created once and reused. */
const supabase = buildSupabase();

function courtReads(): Recorded[] {
  return recorded.filter((r) => r.table === "courts");
}

// ── setSession stub ───────────────────────────────────────────
// Models React's functional-update contract: the hook captures the previous
// time limit INSIDE the updater, so a stub that ignores the function form
// would leave prevTimeLimitRef unset and make OC-17/OC-19 pass vacuously.

let liveSession: Session;
let setSession: Dispatch<SetStateAction<Session>>;
let setSessionSpy: ReturnType<typeof vi.fn>;

function renderCourts(sessionId: string = SESSION_ID, onStatus?: () => void) {
  return renderHook(
    ({ setter }: { setter: Dispatch<SetStateAction<Session>>; id: string }) =>
      useOrganizerCourts(sessionId, supabase, setter, onStatus),
    { initialProps: { setter: setSession, id: sessionId } }
  );
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  courtSubs = [];
  recorded = [];
  courtsResponse = { data: [], error: null };
  liveSession = makeSession(20);
  setSessionSpy = vi.fn((updater: SetStateAction<Session>) => {
    liveSession =
      typeof updater === "function" ? (updater as (p: Session) => Session)(liveSession) : updater;
  });
  setSession = setSessionSpy as unknown as Dispatch<SetStateAction<Session>>;
  // The hook console.errors on a failed read (OC-5 asserts it). Silencing keeps
  // the suite output honest about real failures.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("useOrganizerCourts — Suite OC", () => {
  // ── OC-1 ────────────────────────────────────────────────────
  it("OC-1: starts loading with an empty board", () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };

    const { result } = renderCourts();

    expect(
      result.current.loading,
      "the hook reported loaded before the first read resolved — the organizer's court board renders as 'no courts' for a frame instead of a skeleton"
    ).toBe(true);
    expect(
      result.current.courts,
      "courts started non-empty, so the first render shows rows nothing has fetched"
    ).toEqual([]);
  });

  // ── OC-2 ────────────────────────────────────────────────────
  it("OC-2: a successful read commits the rows verbatim, in view order", async () => {
    const rows = [makeCourt("Court 1"), makeCourt("Court 2", "in_use"), makeCourt("Court 3")];
    courtsResponse = { data: rows, error: null };

    const { result } = renderCourts();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      result.current.courts,
      "the court list was re-shaped or re-ordered on the client — the board's left-to-right order is the created_at order the query asks for, and a client-side sort makes it disagree with every other surface"
    ).toEqual(rows);
  });

  // ── OC-3 ────────────────────────────────────────────────────
  it("OC-3: courtsRef mirrors the committed courts", async () => {
    const rows = [makeCourt("Court 1"), makeCourt("Court 2")];
    courtsResponse = { data: rows, error: null };

    const { result } = renderCourts();

    await waitFor(() => expect(result.current.courts).toHaveLength(2));
    await waitFor(() =>
      expect(
        result.current.courtsRef.current,
        "courtsRef stopped mirroring courts — useOrganizerMatches reads court NAMES out of this ref to enrich match cards, so a stale or empty ref renders live matches with no court label at all"
      ).toEqual(rows)
    );
  });

  // ── OC-4 ────────────────────────────────────────────────────
  it("OC-4: the read is bound to this session, projected and ordered as the board expects", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const reads = courtReads();
    expect(reads.length, "the courts table was never read").toBeGreaterThan(0);
    const ops = reads[0].ops;

    expect(
      ops,
      "the courts read is no longer filtered by session_id BOUND TO THIS SESSION — asserting an eq() happened is not asserting which, and a transposed pair here puts another club's courts on this organizer's board"
    ).toContain(`eq:session_id=${SESSION_ID}`);
    expect(
      ops,
      "the court projection changed; the board and courtsRef both expect whole rows"
    ).toContain("select:*");
    expect(
      ops,
      "courts are no longer ordered by created_at ascending — the board would re-shuffle its columns between refreshes while matches stay pinned to court ids"
    ).toContain("order:created_at:asc");
    expect(
      recorded.map((r) => r.table),
      "the hook widened past the courts table; it must read nothing else"
    ).toEqual(reads.map(() => "courts"));
  });

  // ── OC-5 (negative) ─────────────────────────────────────────
  it("OC-5 (negative): a read error leaves the populated board intact", async () => {
    const rows = [makeCourt("Court 1"), makeCourt("Court 2")];
    courtsResponse = { data: rows, error: null };

    const { result } = renderCourts();
    // Positive control: the board is genuinely populated before the failure,
    // so "still 2 courts" cannot be satisfied by a hook that never fetches.
    await waitFor(() => expect(result.current.courts).toHaveLength(2));

    courtsResponse = { data: null, error: { message: "JWT expired" } };
    await act(async () => {
      await result.current.fetchCourts();
    });

    expect(
      result.current.courts,
      "a failed read blanked a populated court board — this is the 07/25 incident shape: a degraded client fetches, gets nothing, and the organizer watches every court vanish with no error on screen"
    ).toEqual(rows);
    expect(
      consoleErrorSpy,
      "the read failure was swallowed without a log — the only trace this failure mode leaves in production is that console line"
    ).toHaveBeenCalled();
  });

  // ── OC-6 ────────────────────────────────────────────────────
  it("OC-6: an empty-but-successful read commits (positive control for OC-5)", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };
    const { result } = renderCourts();
    await waitFor(() => expect(result.current.courts).toHaveLength(1));

    courtsResponse = { data: [], error: null };
    await act(async () => {
      await result.current.fetchCourts();
    });

    expect(
      result.current.courts,
      "a genuine empty result was held back — removing the last court would then leave a phantom court on the board forever"
    ).toEqual([]);
  });

  // ── OC-7 ────────────────────────────────────────────────────
  it("OC-7: subscribeToCourts is called exactly once across re-renders and a state change", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };

    const { result, rerender } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Unrelated prop churn: a fresh setSession identity every render, which is
    // what an inline arrow in the composer produces. It is not a subscription
    // input and must not re-open the channel.
    for (let i = 0; i < 3; i++) {
      rerender({ setter: vi.fn() as unknown as Dispatch<SetStateAction<Session>>, id: SESSION_ID });
    }

    // A realtime event changes `courts` state — the render-scoped value most
    // likely to be pulled into that dependency array by a well-meaning refactor.
    courtsResponse = { data: [makeCourt("Court 1"), makeCourt("Court 2")], error: null };
    await act(async () => {
      courtSubs[0].handler();
    });
    await waitFor(() => expect(result.current.courts).toHaveLength(2));

    rerender({ setter: setSession, id: SESSION_ID });

    expect(
      courtSubs.length,
      "the courts realtime channel was re-opened on a render that changed neither supabase nor sessionId — CLAUDE.md's subscription-stability rule. Every re-open drops events for the ~1 s the socket is re-joining, so a court status change lands nowhere and the organizer sees a board that is silently, intermittently wrong"
    ).toBe(1);
    expect(
      courtSubs[0].unsub,
      "the original channel was torn down mid-session while its replacement was counted elsewhere"
    ).not.toHaveBeenCalled();
  });

  // ── OC-8 ────────────────────────────────────────────────────
  it("OC-8: fetchCourts keeps one identity across re-renders", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };

    const { result, rerender } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current.fetchCourts;

    courtsResponse = { data: [makeCourt("Court 1"), makeCourt("Court 2")], error: null };
    await act(async () => {
      courtSubs[0].handler();
    });
    await waitFor(() => expect(result.current.courts).toHaveLength(2));
    rerender({ setter: vi.fn() as unknown as Dispatch<SetStateAction<Session>>, id: SESSION_ID });

    expect(
      result.current.fetchCourts,
      "fetchCourts changed identity on a render — it is memoized on exactly (supabase, sessionId), and widening those deps re-runs the initial-load effect on every court change AND arms the subscription-stability trap OC-7 guards, because the ref is then the only thing keeping the channel off this callback"
    ).toBe(first);
  });

  // ── OC-9 ────────────────────────────────────────────────────
  it("OC-9: the channel handler goes through the ref, not the fetch callback itself", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Precondition, deliberately not "exactly one" — channel COUNT is OC-7's
    // property, and duplicating it here would make a churn regression redden a
    // test that names something else.
    expect(courtSubs.length, "no courts channel was opened at all").toBeGreaterThan(0);
    expect(
      courtSubs[0].handler,
      "the fetch callback was handed to subscribeToCourts directly instead of the `() => fetchCourtsRef.current()` indirection — that is the exact edit that puts fetchCourts into the effect's dependency array, and from there every widening of the fetcher's own deps starts re-opening the realtime channel"
    ).not.toBe(result.current.fetchCourts);

    // Positive control: the indirection still reaches the real fetcher.
    const before = courtReads().length;
    await act(async () => {
      courtSubs[0].handler();
    });
    expect(
      courtReads().length,
      "the channel handler no longer triggers a read — the indirection exists to keep the channel stable, not to disconnect it"
    ).toBe(before + 1);
  });

  // ── OC-10 ───────────────────────────────────────────────────
  it("OC-10: the channel is bound to this session and forwards the status reporter", async () => {
    const onStatus = vi.fn();
    courtsResponse = { data: [], error: null };

    const { result } = renderCourts(SESSION_ID, onStatus);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(
      courtSubs[0].sessionId,
      "the courts channel was opened against something other than this session id — subscribeToCourts builds the channel name and the postgres_changes filter from it, so a wrong value here subscribes the organizer to another session's courts"
    ).toBe(SESSION_ID);
    expect(
      courtSubs[0].client,
      "the channel was opened on a different client than the one the hook reads with — its realtime JWT would be a different auth identity"
    ).toBe(supabase);
    expect(
      courtSubs[0].channelPrefix,
      "a channel prefix appeared where the hook passes none; the prefix argument sits between the handler and the status reporter, so a value here means the arguments shifted"
    ).toBeUndefined();
    expect(
      courtSubs[0].onStatus,
      "the channel-status reporter was not forwarded — the organizer's connection indicator would show a permanently healthy socket, including while it is dead"
    ).toBe(onStatus);
  });

  // ── OC-11 ───────────────────────────────────────────────────
  it("OC-11: a realtime court event refetches and the result reaches state", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };
    const { result } = renderCourts();
    await waitFor(() => expect(result.current.courts).toHaveLength(1));

    courtsResponse = {
      data: [makeCourt("Court 1", "in_use"), makeCourt("Court 2")],
      error: null,
    };
    await act(async () => {
      courtSubs[0].handler();
    });

    await waitFor(() =>
      expect(
        result.current.courts,
        "a realtime courts event did not reach state — court status changes made from another device (or by the engine) would never appear on this organizer's board"
      ).toHaveLength(2)
    );
    expect(result.current.courts[0].status, "the refetched row was not committed").toBe("in_use");
  });

  // ── OC-12 ───────────────────────────────────────────────────
  it("OC-12: a sessionId change DOES re-open the channel (positive control for OC-7)", async () => {
    courtsResponse = { data: [], error: null };

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useOrganizerCourts(id, supabase, setSession, undefined),
      { initialProps: { id: SESSION_ID } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const opened = courtSubs.length;
    expect(opened, "no courts channel was opened at all").toBeGreaterThan(0);
    const previous = courtSubs[courtSubs.length - 1];

    rerender({ id: OTHER_SESSION_ID });

    expect(
      courtSubs.length,
      "switching sessions did not open a new courts channel — OC-7's 'exactly once' would then be satisfied by an effect that simply never re-runs, and an organizer moving between sessions would keep receiving the old session's court events"
    ).toBeGreaterThan(opened);
    expect(
      previous.unsub,
      "the previous session's courts channel was left open — its events keep arriving and refetching against the new session"
    ).toHaveBeenCalledTimes(1);
    expect(
      courtSubs[courtSubs.length - 1].sessionId,
      "the new channel was not bound to the new session id"
    ).toBe(OTHER_SESSION_ID);
  });

  // ── OC-12b ──────────────────────────────────────────────────
  // CLAUDE.md's subscription-stability rule has four halves, and this file
  // pinned three: the handler is the ref indirection, not fetchCourts itself
  // (OC-9); the effect does not re-run on every render (OC-7); a real
  // sessionId change does re-open, bound to the new id (OC-12). The fourth is
  // FRESHNESS — that the surviving ref points at the CURRENT fetcher. Delete
  // the `fetchCourtsRef.current = fetchCourts` sync effect and all of OC-7,
  // OC-9 and OC-12 stay green while every realtime event on the new session
  // refetches and commits the PREVIOUS session's courts.
  it("OC-12b: the re-opened channel's handler reads the NEW session, not the old one", async () => {
    courtsResponse = { data: [], error: null };

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useOrganizerCourts(id, supabase, setSession, undefined),
      { initialProps: { id: SESSION_ID } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ id: OTHER_SESSION_ID });
    await waitFor(() => expect(courtSubs[courtSubs.length - 1].sessionId).toBe(OTHER_SESSION_ID));

    const before = courtReads().length;
    await act(async () => {
      courtSubs[courtSubs.length - 1].handler();
    });
    const fresh = JSON.stringify(courtReads().slice(before));

    expect(
      courtReads().length,
      "the newest channel's handler fired no read at all — this test must exercise a live refetch, or the binding assertions below are vacuous"
    ).toBeGreaterThan(before);
    expect(
      fresh,
      "a realtime event on the NEW session refetched nothing bound to it — the ref still holds the fetcher captured for the old sessionId"
    ).toContain(`eq:session_id=${OTHER_SESSION_ID}`);
    expect(
      fresh,
      "a realtime event on the new session refetched the PREVIOUS session's courts and committed them into the organizer panel"
    ).not.toContain(`eq:session_id=${SESSION_ID}`);
  });

  // ── OC-13 ───────────────────────────────────────────────────
  it("OC-13: unmount runs the unsubscriber exactly once", async () => {
    courtsResponse = { data: [], error: null };
    const { result, unmount } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The LIVE channel is the last one opened; comparing its own call count
    // before and after keeps this test about teardown rather than about how
    // many channels were opened (that is OC-7).
    const live = courtSubs[courtSubs.length - 1];
    const before = live.unsub.mock.calls.length;

    unmount();

    expect(
      live.unsub.mock.calls.length,
      "the courts channel outlived the dashboard — a leaked channel keeps firing refetches into an unmounted tree and counts against the client's channel budget for the rest of the page's life"
    ).toBe(before + 1);
  });

  // ── OC-14 ───────────────────────────────────────────────────
  it("OC-14: addCourt forwards (sessionId, name), refetches, and returns {}", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };
    mockAddCourt.mockResolvedValue({ success: true, message: "" });

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = courtReads().length;

    let out!: { error?: string };
    await act(async () => {
      out = await result.current.addCourt("Court 9");
    });

    expect(
      mockAddCourt,
      "addCourt sent the wrong pair to the server — the action authorizes on argument 1 and names the court from argument 2, so a transposed pair either fails the organizer check or creates a court named after a session id"
    ).toHaveBeenCalledWith(SESSION_ID, "Court 9");
    expect(out, "a successful add reported an error to the UI").toEqual({});
    expect(
      courtReads().length,
      "the board was not refetched after a successful add — the new court would not appear until an unrelated realtime event happened to fire"
    ).toBe(before + 1);
  });

  // ── OC-15 (negative) ────────────────────────────────────────
  it("OC-15 (negative): a refused write returns the message and never starts the refetch", async () => {
    courtsResponse = { data: [makeCourt("Court 1")], error: null };
    mockAddCourt.mockResolvedValue({ success: false, message: "Not authorized." });
    mockUpdateStatus.mockResolvedValue({ success: false, message: "Not authorized." });
    mockRemoveCourt.mockResolvedValue({ success: false, message: "Court not found." });

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = courtReads().length;

    let addOut!: { error?: string };
    let statusOut!: { error?: string };
    let removeOut!: { error?: string };
    await act(async () => {
      addOut = await result.current.addCourt("Court 9");
      statusOut = await result.current.updateCourtStatus("court-Court 1", "closed");
      removeOut = await result.current.removeCourt("court-Court 1");
    });

    expect(addOut.error, "a refused add did not surface the server's reason").toBe(
      "Not authorized."
    );
    expect(statusOut.error, "a refused status change did not surface the server's reason").toBe(
      "Not authorized."
    );
    expect(removeOut.error, "a refused removal did not surface the server's reason").toBe(
      "Court not found."
    );

    // Pairing, checked on the calls that were actually made: the two three-arg
    // actions are where a transposed id is invisible in the call count.
    expect(
      mockUpdateStatus,
      "updateCourtStatus's positional arguments drifted — (sessionId, courtId, status) transposed either writes a status onto the wrong court or sends a court id where the server expects a status enum"
    ).toHaveBeenCalledWith(SESSION_ID, "court-Court 1", "closed");
    expect(
      mockRemoveCourt,
      "removeCourt's positional arguments drifted — the server authorizes on the session id and deletes the court id, so a transposed pair deletes against an unauthorized binding"
    ).toHaveBeenCalledWith(SESSION_ID, "court-Court 1");

    expect(
      courtReads().length,
      "a refused write still ran the refetch — the guard must stop the downstream work from STARTING, not merely change what the caller is told; a hook that refetches on refusal masks the refusal behind a board that looks like it updated"
    ).toBe(before);
  });

  // ── OC-20 ───────────────────────────────────────────────────
  it("OC-20: an accepted status change and removal each refetch the board", async () => {
    courtsResponse = { data: [makeCourt("Court 1"), makeCourt("Court 2")], error: null };
    mockUpdateStatus.mockResolvedValue({ success: true, message: "" });
    mockRemoveCourt.mockResolvedValue({ success: true, message: "" });

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.courts).toHaveLength(2));

    // Status change: the board must reflect it without waiting for realtime.
    let statusOut!: { error?: string };
    let before = courtReads().length;
    courtsResponse = {
      data: [makeCourt("Court 1", "closed"), makeCourt("Court 2")],
      error: null,
    };
    await act(async () => {
      statusOut = await result.current.updateCourtStatus("court-Court 1", "closed");
    });

    expect(statusOut, "an accepted status change reported an error to the UI").toEqual({});
    expect(
      courtReads().length,
      "closing a court did not refetch the board — court status gates whether the engine may assign a match there, so an organizer who closes a court would keep seeing it as available and keep being offered matches on it until an unrelated realtime event fired"
    ).toBe(before + 1);
    await waitFor(() =>
      expect(
        result.current.courts[0].status,
        "the refetched board never reached state — the read happened but the new status was not committed"
      ).toBe("closed")
    );

    // Removal: same contract, and it is the one that must not leave a ghost.
    let removeOut!: { error?: string };
    before = courtReads().length;
    courtsResponse = { data: [makeCourt("Court 2")], error: null };
    await act(async () => {
      removeOut = await result.current.removeCourt("court-Court 1");
    });

    expect(removeOut, "an accepted removal reported an error to the UI").toEqual({});
    expect(
      courtReads().length,
      "removing a court did not refetch the board — the deleted court stays on screen as a ghost the organizer can still try to assign a match to"
    ).toBe(before + 1);
    await waitFor(() =>
      expect(result.current.courts, "the removed court survived the refetch in state").toHaveLength(
        1
      )
    );
  });

  // ── OC-16 ───────────────────────────────────────────────────
  it("OC-16: updateTimeLimit applies the new limit optimistically and keeps it on success", async () => {
    courtsResponse = { data: [], error: null };
    mockUpdateSettings.mockResolvedValue({ success: true });

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let out!: { error?: string };
    await act(async () => {
      out = await result.current.updateTimeLimit(45);
    });

    expect(
      mockUpdateSettings,
      "the time limit was not persisted under the session it was set on, or not under the court_time_limit_minutes key the server writes"
    ).toHaveBeenCalledWith(SESSION_ID, { court_time_limit_minutes: 45 });
    expect(
      setSessionSpy,
      "a confirmed time-limit change wrote to the session more than once — the extra write is the revert path firing on a success, which snaps the organizer's chosen limit back in front of them"
    ).toHaveBeenCalledTimes(1);
    expect(
      liveSession.court_time_limit_minutes,
      "the new court time limit never reached the live session state — every court's countdown keeps using the old cap"
    ).toBe(45);
    expect(out, "a successful settings write reported an error").toEqual({});
  });

  // ── OC-17 (negative) ────────────────────────────────────────
  it("OC-17 (negative): a failed write reverts to the value captured before the optimistic update", async () => {
    courtsResponse = { data: [], error: null };
    mockUpdateSettings.mockResolvedValue({ error: "Not authorized." });

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(liveSession.court_time_limit_minutes, "fixture precondition").toBe(20);

    let out!: { error?: string };
    await act(async () => {
      out = await result.current.updateTimeLimit(45);
    });

    expect(
      liveSession.court_time_limit_minutes,
      "a rejected time-limit change was left applied — the organizer's UI shows a 45-minute cap the database never accepted, and every court on screen counts down against a limit that does not exist"
    ).toBe(20);
    expect(out.error, "the server's refusal was not surfaced to the caller").toBe(
      "Not authorized."
    );
    expect(
      setSessionSpy,
      "the optimistic write and its revert are two writes; anything else means one of them did not happen"
    ).toHaveBeenCalledTimes(2);
  });

  // ── OC-18 (edge) ────────────────────────────────────────────
  it("OC-18 (edge): null means 'no limit' and is forwarded as null, not 0", async () => {
    courtsResponse = { data: [], error: null };
    mockUpdateSettings.mockResolvedValue({ success: true });

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateTimeLimit(null);
    });

    expect(
      mockUpdateSettings,
      "clearing the court time limit sent something other than null — 0 is a REAL limit of zero minutes, and the column's 'no cap' value is null; coercing one into the other expires every court the moment it starts"
    ).toHaveBeenCalledWith(SESSION_ID, { court_time_limit_minutes: null });
    expect(
      liveSession.court_time_limit_minutes,
      "the optimistic state did not clear the limit"
    ).toBeNull();
  });

  // ── OC-19 (edge) ────────────────────────────────────────────
  it("OC-19 (edge): the revert target tracks the latest confirmed value, not the one at mount", async () => {
    courtsResponse = { data: [], error: null };

    const { result } = renderCourts();
    await waitFor(() => expect(result.current.loading).toBe(false));

    // First change is confirmed: 20 → 45.
    mockUpdateSettings.mockResolvedValueOnce({ success: true });
    await act(async () => {
      await result.current.updateTimeLimit(45);
    });
    expect(liveSession.court_time_limit_minutes, "positive control: the first change stuck").toBe(
      45
    );

    // Second change is refused: 45 → null must snap back to 45, not to 20.
    mockUpdateSettings.mockResolvedValueOnce({ error: "Session closed." });
    await act(async () => {
      await result.current.updateTimeLimit(null);
    });

    expect(
      liveSession.court_time_limit_minutes,
      "the revert restored a stale value instead of the last CONFIRMED one — prevTimeLimitRef must be captured inside the setState updater on every call, so a second failed edit rolls back one step rather than undoing an earlier successful edit the organizer never asked to undo"
    ).toBe(45);
  });
});
