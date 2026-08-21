// @vitest-environment happy-dom
// ============================================================
// usePairCounts — the advisory fetch that is allowed to fail silently (PC)
// ============================================================
// src/hooks/use-pair-counts.ts is the ONE hook in this app whose entire error
// policy is "say nothing". getSessionPairCounts can return { success: false }
// or reject outright, and both outcomes are swallowed: the organizer sees no
// toast, no spinner, no red text. That is deliberate — the repeat-pairing
// warning is ADVISORY and must never block manual match creation.
//
// The cost of that policy is that a hook which loads NOTHING, EVER, looks
// exactly like a hook that is working. `counts === null` is the documented
// "no data yet" state, callers render no warnings for it, and every screen
// stays green. So the only defence is a POSITIVE CONTROL on every negative:
// each test that asserts "nothing happened" is paired with a step in the same
// test proving the load path runs at all. A universally-broken usePairCounts
// must not be able to satisfy this file.
//
// Three properties carry the real weight:
//
//   1. WHICH MAP GETS WHICH COUNTS. The payload is two tuple arrays that are
//      rehydrated into two Maps. Swap them and derivePairWarnings reads
//      cross-net counts as same-team counts: the organizer is warned that two
//      players "partnered 3x" when they have only ever faced each other. The
//      call count is identical, the shape is identical, the warning is wrong.
//      So the tests assert the KEY→COUNT pairing per relation, not just that
//      a Map came back.
//
//   2. STALE RESPONSES MUST LOSE. `revision` ticks on every matches /
//      match_players WAL event, so a busy court can re-fire this effect while
//      the previous request is still in flight. The `cancelled` flag is the
//      only thing stopping a slow FIRST response from overwriting a newer
//      SECOND one — that is a warning that silently reverts to the pre-match
//      graph mid-build. The probe below is a recording getter on `data`: if
//      the handler proceeds past the cancelled check it MUST touch `.data` to
//      build the Maps, so a read count of 0 proves the guard fired and a read
//      count > 0 proves the path is live.
//
//   3. A FAILED REFETCH KEEPS THE PREVIOUS COUNTS. Clearing them on failure
//      would make the warning flicker off and on as transient DB errors come
//      and go — worse than stale advice, because the organizer learns the
//      badge is noise and stops reading it.
//
//   PC-1   null until the first load resolves; non-null once it does (control)
//   PC-2   a successful load populates BOTH Maps with the right key→count
//          pairing per relation
//   PC-3   (edge) an empty payload yields two EMPTY Maps — loaded-with-zero is
//          a distinct state from not-loaded-yet (null)
//   PC-4   (negative) a { success:false } refetch leaves the PREVIOUS counts
//          intact, and the refetch provably happened (control)
//   PC-5   (negative, edge) a { success:false } FIRST load leaves counts null
//          instead of throwing or half-writing
//   PC-6   (negative) a REJECTED promise is swallowed, logged, and leaves the
//          previous counts intact (control)
//   PC-7   a `revision` tick refetches, with the same sessionId
//   PC-8   (negative) an unrelated re-render does NOT refetch — and a
//          revision tick in the same test does (control)
//   PC-9   a sessionId change refetches bound to the NEW id
//   PC-10  (edge) a STALE in-flight response resolving AFTER a newer one is
//          discarded — the newer counts survive
//   PC-11  (edge) unmount before the promise resolves performs no state
//          update, and a still-mounted hook does (control)
//
// WHAT THIS FILE DOES NOT PROVE
//   * That getSessionPairCounts authorizes the caller. The action is mocked
//     here; its organizer gate and service-role read are covered by the
//     server-side suites over src/app/actions/repeat-pairing.ts.
//   * That the counts produce the right WARNING. The derivation
//     (thresholds, headline stability, avoidability) is repeat-pairing.test.ts
//     and use-repeat-pairing.test.tsx.
//   * That `revision` actually ticks on a WAL event. That is
//     use-organizer-matches / realtime-refetch-debounce.test.tsx.
//   * That no realtime channel is opened. Channel budget is asserted in the
//     realtime suites, not here.
//
// IDs: PC
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The action is a "use server" module that reaches for the server Supabase
// client and the service client on import. Replacing it wholesale keeps this
// suite a test of the HOOK; the action's own guards are tested server-side.
vi.mock("@/app/actions/repeat-pairing", () => ({
  getSessionPairCounts: vi.fn(),
}));

import { getSessionPairCounts } from "@/app/actions/repeat-pairing";
import type { GetSessionPairCountsResult } from "@/app/actions/repeat-pairing";
import { usePairCounts } from "@/hooks/use-pair-counts";

const mockGetCounts = vi.mocked(getSessionPairCounts);

// ── Constants ─────────────────────────────────────────────────

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";

// The hook is key-agnostic — it rehydrates whatever tuples it is handed — so
// plain readable keys are used rather than importing pairKey(). What matters
// is that a key landing in `partnerships` is not the one that was sent as an
// opponent count, which literal keys make obvious at the assertion site.
const ALICE_BOB = "alice|bob";
const CAROL_DAVE = "carol|dave";

// ── Deferred promise ──────────────────────────────────────────
// Lets a test hold a response open across a re-render or an unmount, which is
// the only way to exercise PC-10 and PC-11 at all.

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Payload probe ─────────────────────────────────────────────
// `data` is a GETTER that records every read. The hook can only build its Maps
// by reading result.data, so:
//   reads() === 0  →  the handler returned before touching the payload
//   reads()  >  0  →  the handler proceeded to setCounts
// That is the observable this file uses instead of trying to detect a setState
// on an unmounted component, which React 19 performs silently.

type Probe = {
  payload: GetSessionPairCountsResult;
  reads: () => number;
};

function successProbe(partnerships: [string, number][], opponents: [string, number][]): Probe {
  let reads = 0;
  const data = { partnerships, opponents };
  return {
    payload: {
      success: true,
      get data() {
        reads += 1;
        return data;
      },
    },
    reads: () => reads,
  };
}

function failure(error = "Not authorized."): GetSessionPairCountsResult {
  return { success: false, error };
}

// ── Render helper ─────────────────────────────────────────────

type Props = { sessionId: string; revision: number };

function setup(initialProps: Props = { sessionId: SESSION_ID, revision: 0 }) {
  return renderHook(({ sessionId, revision }: Props) => usePairCounts(sessionId, revision), {
    initialProps,
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("usePairCounts — Unit Suite", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetCounts.mockReset();
    // Default: a response that never arrives. Every test that cares about a
    // resolution installs its own. A mock with no implementation would return
    // undefined and the hook's `.then` would throw on it, which would look
    // like a hook defect rather than a test defect.
    mockGetCounts.mockReturnValue(deferred<GetSessionPairCountsResult>().promise);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── PC-1 ───────────────────────────────────────────────────
  it("PC-1: returns null until the first load resolves, and non-null once it does", async () => {
    const d = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(d.promise);

    const { result } = setup();

    expect(
      result.current,
      "counts were non-null before any response arrived — callers treat non-null as 'loaded', so the repeat warning would be computed against a graph the server never sent"
    ).toBeNull();

    // Positive control: the null above must be 'not yet', not 'never'.
    await act(async () => {
      d.resolve(successProbe([[ALICE_BOB, 3]], []).payload);
    });

    expect(
      result.current,
      "counts were STILL null after a successful load — a hook that never leaves null is indistinguishable from one that is working, and every repeat warning silently disappears"
    ).not.toBeNull();
  });

  // ── PC-2 ───────────────────────────────────────────────────
  it("PC-2: a successful load populates both Maps with the right key→count pairing", async () => {
    const d = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(d.promise);

    const { result } = setup();

    await act(async () => {
      d.resolve(successProbe([[ALICE_BOB, 3]], [[CAROL_DAVE, 7]]).payload);
    });

    const counts = result.current;
    expect(counts, "no counts after a successful load").not.toBeNull();

    expect(
      counts?.partnerships instanceof Map,
      "partnerships came back as the raw tuple ARRAY rather than a Map — derivePairWarnings calls .get() on it, which is undefined on an array, so every warning silently reads as count 0"
    ).toBe(true);
    expect(
      counts?.opponents instanceof Map,
      "opponents came back as the raw tuple ARRAY rather than a Map — countFor() would throw or read undefined and the cross-net warning would never fire"
    ).toBe(true);

    expect(
      counts?.partnerships.get(ALICE_BOB),
      "the same-team count for the pair sent as a PARTNERSHIP is missing or wrong — the organizer is not warned about the pair they are actually repeating"
    ).toBe(3);
    expect(
      counts?.opponents.get(CAROL_DAVE),
      "the cross-net count for the pair sent as an OPPONENT pairing is missing or wrong"
    ).toBe(7);

    // The pairing, not merely the presence: opponent counts must NOT appear as
    // partnerships. A swapped assignment produces two populated Maps of the
    // right size and warns "partnered 7x" about players who only ever faced
    // each other.
    expect(
      counts?.partnerships.get(CAROL_DAVE),
      "an OPPONENT count leaked into the partnerships Map — the warning would report a same-team repeat for two players who have never been on the same team"
    ).toBeUndefined();
    expect(
      counts?.opponents.get(ALICE_BOB),
      "a PARTNERSHIP count leaked into the opponents Map — the cross-net warning would fire on a pair that has never faced each other"
    ).toBeUndefined();

    expect(
      counts?.partnerships.size,
      "the partnerships Map holds entries the payload never sent"
    ).toBe(1);
    expect(counts?.opponents.size, "the opponents Map holds entries the payload never sent").toBe(
      1
    );
  });

  // ── PC-3 (edge) ────────────────────────────────────────────
  it("PC-3: (edge) an empty payload yields two empty Maps, not null", async () => {
    const d = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(d.promise);

    const { result } = setup();

    await act(async () => {
      d.resolve(successProbe([], []).payload);
    });

    expect(
      result.current,
      "a session with zero committed matches left counts at null — null is the 'still loading' state, so the caller can never distinguish 'no repeats yet' from 'the fetch has not landed'"
    ).not.toBeNull();
    expect(
      result.current?.partnerships.size,
      "empty partnerships payload did not produce an empty Map"
    ).toBe(0);
    expect(
      result.current?.opponents.size,
      "empty opponents payload did not produce an empty Map"
    ).toBe(0);
  });

  // ── PC-4 (negative) ────────────────────────────────────────
  it("PC-4: (negative) a failed refetch leaves the previous counts intact", async () => {
    const first = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(first.promise);

    const { result, rerender } = setup();

    await act(async () => {
      first.resolve(successProbe([[ALICE_BOB, 4]], []).payload);
    });
    expect(
      result.current?.partnerships.get(ALICE_BOB),
      "control failed: the first load never populated, so 'previous counts survive' would be vacuously true"
    ).toBe(4);

    const second = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(second.promise);

    rerender({ sessionId: SESSION_ID, revision: 1 });
    await act(async () => {
      second.resolve(failure("Not authorized."));
    });

    // Positive control on the negative: the failing refetch must actually have
    // been issued, or "counts unchanged" proves nothing at all.
    expect(
      mockGetCounts,
      "the refetch was never issued, so this test would pass against a hook that ignores `revision` entirely"
    ).toHaveBeenCalledTimes(2);

    expect(
      result.current?.partnerships.get(ALICE_BOB),
      "a transient failure wiped the previously loaded counts — the repeat warning flickers off and back on as the DB blips, which teaches the organizer the badge is noise"
    ).toBe(4);
    expect(
      result.current,
      "a failed refetch cleared counts back to null instead of holding the last good graph"
    ).not.toBeNull();
    // "Did not throw" is the half of the title neither PC-4 nor PC-5 could see.
    // The hook guards with `if (cancelled || !result.success) return;` and
    // wraps the whole handler in a .catch that logs. Drop the `!result.success`
    // half and the handler falls through to `new Map(result.data.partnerships)`
    // on a payload that HAS no `data`: it throws, the catch swallows it, and
    // counts still end up exactly where these two assert they are. Only the
    // absence of a logged error distinguishes "recognised the failure" from
    // "crashed on it and was rescued".
    expect(
      errorSpy,
      "the failure arm was not RECOGNISED as a failure — it fell through to build Maps from a payload with no `data`, threw, and the catch swallowed it"
    ).not.toHaveBeenCalled();
  });

  // ── PC-5 (negative, edge) ──────────────────────────────────
  it("PC-5: (negative, edge) a failed first load leaves counts null and does not throw", async () => {
    const d = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(d.promise);

    const { result } = setup();

    await act(async () => {
      d.resolve(failure("Invalid session ID."));
    });

    expect(
      result.current,
      "a { success:false } first load wrote counts anyway — the payload has no `data` on the failure arm, so anything written here is fabricated"
    ).toBeNull();
    expect(mockGetCounts, "the load was never attempted").toHaveBeenCalledTimes(1);
    // "Did not throw" is the half of the title neither PC-4 nor PC-5 could see.
    // The hook guards with `if (cancelled || !result.success) return;` and
    // wraps the whole handler in a .catch that logs. Drop the `!result.success`
    // half and the handler falls through to `new Map(result.data.partnerships)`
    // on a payload that HAS no `data`: it throws, the catch swallows it, and
    // counts still end up exactly where these two assert they are. Only the
    // absence of a logged error distinguishes "recognised the failure" from
    // "crashed on it and was rescued".
    expect(
      errorSpy,
      "the failure arm was not RECOGNISED as a failure — it fell through to build Maps from a payload with no `data`, threw, and the catch swallowed it"
    ).not.toHaveBeenCalled();
  });

  // ── PC-6 (negative) ────────────────────────────────────────
  it("PC-6: (negative) a rejected promise is swallowed, logged, and keeps the previous counts", async () => {
    const first = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(first.promise);

    const { result, rerender } = setup();

    await act(async () => {
      first.resolve(successProbe([[ALICE_BOB, 2]], []).payload);
    });
    expect(
      result.current?.partnerships.get(ALICE_BOB),
      "control failed: nothing was loaded before the rejection, so 'previous counts survive' is vacuous"
    ).toBe(2);

    const second = deferred<GetSessionPairCountsResult>();
    mockGetCounts.mockReturnValue(second.promise);
    rerender({ sessionId: SESSION_ID, revision: 1 });

    const boom = new Error("network down");
    await act(async () => {
      second.reject(boom);
    });

    expect(
      mockGetCounts,
      "the rejecting refetch was never issued — the assertions below would hold against a hook that never fetches"
    ).toHaveBeenCalledTimes(2);
    expect(
      errorSpy,
      "the rejection was not logged — an advisory feature that fails silently AND leaves no trace cannot be diagnosed from a production log"
    ).toHaveBeenCalledWith("[usePairCounts] getSessionPairCounts failed:", boom);
    expect(
      result.current?.partnerships.get(ALICE_BOB),
      "a rejected refetch destroyed the last good counts"
    ).toBe(2);
  });

  // ── PC-7 ───────────────────────────────────────────────────
  it("PC-7: a revision tick refetches, bound to the same sessionId", async () => {
    const { rerender } = setup();

    expect(mockGetCounts, "no fetch was issued on mount").toHaveBeenCalledTimes(1);

    rerender({ sessionId: SESSION_ID, revision: 1 });

    expect(
      mockGetCounts,
      "a `revision` tick did not refetch — revision is the ENTIRE refresh mechanism (the hook opens no realtime channel), so the repeat warning would freeze at the graph as of the organizer's first render and mis-advise every match after it"
    ).toHaveBeenCalledTimes(2);
    expect(
      mockGetCounts,
      "the refetch was not bound to the session the hook was rendered for"
    ).toHaveBeenNthCalledWith(2, SESSION_ID);
  });

  // ── PC-8 (negative) ────────────────────────────────────────
  it("PC-8: (negative) an unrelated re-render does not refetch, but a revision tick does", async () => {
    const { rerender } = setup();

    expect(mockGetCounts, "no fetch was issued on mount").toHaveBeenCalledTimes(1);

    // Same props, new render — a parent re-render from anything at all.
    rerender({ sessionId: SESSION_ID, revision: 0 });
    rerender({ sessionId: SESSION_ID, revision: 0 });

    expect(
      mockGetCounts,
      "an unrelated re-render refetched — queue-control re-renders on every keystroke and every slot tap, so this is a service-role query per interaction against a session's whole co-play graph"
    ).toHaveBeenCalledTimes(1);

    // Positive control: the hook is not simply inert.
    rerender({ sessionId: SESSION_ID, revision: 1 });
    expect(
      mockGetCounts,
      "control failed: a real revision tick did not refetch either, so the assertion above is satisfied by a hook that fetches once and never again"
    ).toHaveBeenCalledTimes(2);
  });

  // ── PC-9 ───────────────────────────────────────────────────
  it("PC-9: a sessionId change refetches bound to the NEW id", async () => {
    const { rerender } = setup();

    expect(mockGetCounts, "no fetch was issued on mount").toHaveBeenNthCalledWith(1, SESSION_ID);

    rerender({ sessionId: OTHER_SESSION_ID, revision: 0 });

    expect(
      mockGetCounts,
      "changing session did not refetch — the organizer would see the previous session's co-play graph"
    ).toHaveBeenCalledTimes(2);
    expect(
      mockGetCounts,
      "the refetch was issued against the OLD session id — pair counts from another session would be reported as this session's repeats"
    ).toHaveBeenNthCalledWith(2, OTHER_SESSION_ID);
  });

  // ── PC-10 (edge) ───────────────────────────────────────────
  it("PC-10: (edge) a stale in-flight response resolving after a newer one is discarded", async () => {
    const stale = deferred<GetSessionPairCountsResult>();
    const staleProbe = successProbe([[ALICE_BOB, 99]], []);
    mockGetCounts.mockReturnValue(stale.promise);

    const { result, rerender } = setup();

    // Tick the revision while the first request is still open.
    const fresh = deferred<GetSessionPairCountsResult>();
    const freshProbe = successProbe([[ALICE_BOB, 1]], []);
    mockGetCounts.mockReturnValue(fresh.promise);
    rerender({ sessionId: SESSION_ID, revision: 1 });

    // The NEWER request lands first…
    await act(async () => {
      fresh.resolve(freshProbe.payload);
    });
    expect(
      result.current?.partnerships.get(ALICE_BOB),
      "control failed: the newer response never applied, so 'the stale one loses' is vacuous"
    ).toBe(1);
    expect(freshProbe.reads(), "the newer payload was never read").toBeGreaterThan(0);

    // …and the ORIGINAL, slower request resolves afterwards.
    await act(async () => {
      stale.resolve(staleProbe.payload);
    });

    expect(
      staleProbe.reads(),
      "the superseded response was still processed — its effect was cleaned up, so this is the cancelled flag failing and a slow request from a previous revision overwriting fresher data"
    ).toBe(0);
    expect(
      result.current?.partnerships.get(ALICE_BOB),
      "a stale response clobbered newer counts — the repeat warning reverts to the pre-match co-play graph mid-build and the organizer is warned about a pairing that is no longer a repeat"
    ).toBe(1);
  });

  // ── PC-11 (edge) ───────────────────────────────────────────
  it("PC-11: (edge) unmounting before the response lands performs no state update", async () => {
    // Positive control first: a MOUNTED hook must read the payload, or the
    // read-count assertion below is satisfied by a hook that never applies
    // anything at all.
    const mounted = deferred<GetSessionPairCountsResult>();
    const mountedProbe = successProbe([[ALICE_BOB, 5]], []);
    mockGetCounts.mockReturnValue(mounted.promise);
    const live = setup();
    await act(async () => {
      mounted.resolve(mountedProbe.payload);
    });
    expect(
      mountedProbe.reads(),
      "control failed: a mounted hook did not read the resolved payload, so a read count of 0 below proves nothing"
    ).toBeGreaterThan(0);
    expect(
      live.result.current?.partnerships.get(ALICE_BOB),
      "control failed: nothing was applied"
    ).toBe(5);
    live.unmount();

    // The real case: unmount while the request is still open.
    const late = deferred<GetSessionPairCountsResult>();
    const lateProbe = successProbe([[CAROL_DAVE, 8]], []);
    mockGetCounts.mockReturnValue(late.promise);
    const { unmount } = setup();
    unmount();

    await act(async () => {
      late.resolve(lateProbe.payload);
    });

    expect(
      lateProbe.reads(),
      "the response was processed after unmount — the hook builds Maps and calls setCounts on a torn-down component, which React 19 drops SILENTLY, so the leak shows up as retained closures rather than a warning"
    ).toBe(0);
    expect(
      errorSpy,
      "React logged during the post-unmount resolution — a state update outside act() means the cleanup did not run"
    ).not.toHaveBeenCalled();
  });
});
