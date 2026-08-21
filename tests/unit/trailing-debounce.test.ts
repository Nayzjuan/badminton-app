// ============================================================
// trailingDebounce — the TRAILING edge is the whole contract (TD)
// ============================================================
// src/lib/trailing-debounce.ts is fifteen lines and it sits underneath every
// realtime refetch in the app: use-session-data builds three of them (courts /
// waitlist / matches) inside one effect, and use-organizer-matches,
// use-tv-board, use-match-history, use-match-alerts and use-player-match each
// build their own. Nothing else throttles those postgres_changes streams, so
// each property below is load-bearing in production:
//
//   • THERE IS NO LEADING EDGE. Committing one match is 1 `matches` INSERT +
//     4 `match_players` INSERTs; a draft-cap regeneration is roughly fifty
//     events. If `fn` ever fired on the FIRST call of a burst, the fan-out
//     this module exists to collapse would be back at full width, multiplied
//     across six hooks — which is the exact cost that motivated wrapping the
//     callbacks in the first place.
//
//   • THE WINDOW IS MEASURED FROM THE LAST CALL. A window anchored to the
//     first call fires mid-burst, i.e. against a half-written engine state:
//     the refetch lands between the `matches` INSERT and its `match_players`
//     rows and renders a live match with nobody on the court. The trailing
//     edge is what guarantees the read happens after the writes have stopped.
//
//   • ONE TIMER PER INSTANCE. Three debouncers share one effect in
//     use-session-data. If they shared a timer, the most recent stream would
//     cancel the other two and two of the three lists would simply never
//     refresh — a silently stale queue, which is the "kicked out of the queue"
//     failure class this app has already shipped once.
//
//   • cancel() ACTUALLY CANCELS. The subscription effects call it from their
//     cleanup. If it degraded to a no-op, a full refetch pipeline would run
//     against a torn-down hook after unmount.
//
// Every timing test drives vi.useFakeTimers(), so "has not fired yet" is an
// assertion about the scheduled deadline rather than about wall-clock luck.
// The module holds no module-level state (TD-10 and TD-13 are the tests that
// pin that), so no suite-order coupling is possible and none is reset.
//
// Tests:
//   TD-1  (negative) the first call does NOT invoke fn — there is no leading edge
//   TD-2  a single call invokes fn exactly once, ms later (positive control for TD-1)
//   TD-3  a burst of 12 calls inside one window collapses to exactly ONE invocation
//   TD-4  (edge) the delay is measured from the LAST call, not the first
//   TD-5  (edge) boundary: nothing at ms-1, exactly one at ms, still one long after
//   TD-6  (negative) cancel() before the deadline prevents the run entirely
//   TD-7  (negative, edge) cancel() on an idle debouncer is a no-op and does not throw
//   TD-8  (edge) cancel() after the run has already fired does not re-run or throw
//   TD-9  run() after a cancel() still schedules and fires
//   TD-10 (negative) two instances do not share a timer
//   TD-11 (edge) the pending handle is cleared BEFORE fn runs, so a run scheduled
//         from inside fn is still cancellable
//   TD-12 (edge) ms = 0 still defers to a timer tick instead of running inline
//   TD-13 (negative) cancel() on one instance does not cancel another's pending run
//
// WHAT THIS FILE DOES NOT PROVE
//   • That any hook actually WIRES its realtime callback through a debouncer,
//     or that the ordering-critical callbacks deliberately stay eager. That is
//     tests/unit/realtime-refetch-debounce.test.tsx (Suite RRD), which owns the
//     useMatchAlerts property that the ref resets must NOT be deferred.
//   • The value of REALTIME_REFETCH_DEBOUNCE_MS, or that callers pass it at
//     all. This module takes `ms` as an argument and has no opinion about it.
//   • That an effect cleanup calls cancel(). Whether cancel() is reached is a
//     hook-lifecycle concern owned by the suites for those hooks; this file
//     only proves what cancel() does once it is called.
//   • Behaviour under real timers, including timer coalescing or a backgrounded
//     tab throttling setTimeout. Fake timers model the scheduling contract, not
//     the browser's scheduler.
// ============================================================

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { trailingDebounce, type TrailingDebouncer } from "@/lib/trailing-debounce";

// The delay every test uses unless it is specifically probing another value.
// Deliberately not a round 100 so an off-by-one in the source cannot hide
// behind an advance amount that happens to be a multiple of it.
const MS = 120;

describe("trailingDebounce (TD)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("TD-1 (negative): the first call does not invoke fn — there is no leading edge", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    deb.run();

    expect(
      fn,
      "trailingDebounce fired on the leading edge. Every realtime callback in the app is wrapped in this, so a leading edge means the first of a ~50-event draft-cap burst triggers a full refetch pipeline immediately — the fan-out this module exists to collapse is back, and the refetch reads engine state that is still mid-write"
    ).not.toHaveBeenCalled();
  });

  it("TD-2: a single call invokes fn exactly once, ms after the call", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    deb.run();
    vi.advanceTimersByTime(MS);

    expect(
      fn,
      "a lone call never reached fn. This is TD-1's positive control: without it, a debouncer that simply never invokes anything would satisfy every 'does not fire' assertion in this file while leaving the courts, waitlist and matches lists frozen on their first render"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-3: a burst of 12 calls inside one window collapses to exactly one invocation", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    // 12 events spaced 5 ms apart — the shape of one committed match plus its
    // match_players rows arriving as separate postgres_changes payloads.
    for (let i = 0; i < 12; i++) {
      deb.run();
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(MS);

    expect(
      fn,
      "a burst did not collapse into a single trailing invocation — the debouncer is running one refetch per realtime event, which is the N-refetches-per-action stampede that made these callbacks unusable before they were wrapped"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-4 (edge): the delay is measured from the LAST call, not the first", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    deb.run(); // deadline at t = 120
    vi.advanceTimersByTime(60);
    expect(
      fn,
      "fn ran before its own window elapsed — the timer is not honouring `ms` at all"
    ).not.toHaveBeenCalled();

    deb.run(); // t = 60, deadline must move to t = 180
    vi.advanceTimersByTime(60); // t = 120 — the FIRST call's deadline

    expect(
      fn,
      "the window is anchored to the first call of a burst instead of the last. That fires the refetch WHILE the engine is still writing: the read lands between the `matches` INSERT and its `match_players` INSERTs and renders a live match with an empty court"
    ).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59); // t = 179 — one tick short of the real deadline
    expect(
      fn,
      "the rescheduled deadline came early — the burst's quiet period was cut short and the refetch raced the writes it was waiting out"
    ).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // t = 180 — ms after the LAST call
    expect(
      fn,
      "fn never ran after the burst went quiet. A debounce that swallows the trailing invocation is worse than no debounce: the UI stops updating entirely and only a manual reload recovers it"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-5 (edge): nothing fires at ms-1, exactly one at ms, and still one long afterwards", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    deb.run();

    vi.advanceTimersByTime(MS - 1);
    expect(
      fn,
      "fn fired before the full window elapsed — the debounce interval is shorter than the caller asked for, so a burst whose gaps exceed the real window stops collapsing and the per-event refetch stampede comes back"
    ).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(
      fn,
      "fn had not fired at exactly `ms` — the delay is longer than the caller asked for, which delays every realtime-driven UI update by the difference"
    ).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MS * 50);
    expect(
      fn,
      "the trailing run repeated. setTimeout was replaced by a repeating schedule somewhere, so one realtime event now refetches forever on an interval"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-6 (negative): cancel() before the deadline prevents the run entirely", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    // Positive control FIRST, on this very instance: an uncancelled cycle must
    // reach fn. Without it, "the cancelled run never happened" would be
    // satisfied by a debouncer that never invokes anything at all.
    deb.run();
    vi.advanceTimersByTime(MS);
    expect(
      fn,
      "the positive control never fired — this test proves nothing about cancel(), because the debouncer was not running anything in the first place"
    ).toHaveBeenCalledTimes(1);

    deb.run();
    // Late in the window but not on its boundary. Cancelling at exactly ms-1
    // would make this test fail for any change to the window LENGTH too, and
    // this test is about cancel(); TD-5 owns the boundary.
    vi.advanceTimersByTime(MS / 2);
    deb.cancel();
    vi.advanceTimersByTime(MS * 10);

    expect(
      fn,
      "cancel() did not stop a pending run — the invocation count rose past the one the control produced. The subscription effects call cancel() from their cleanup, so a no-op cancel means a full refetch pipeline fires against a hook that has already unmounted: setState on a dead tree, and a wasted round trip on every navigation"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-7 (negative, edge): cancel() on an idle debouncer is a no-op and does not throw", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    expect(
      () => deb.cancel(),
      "cancel() threw with nothing pending. Effect cleanups run whether or not an event ever arrived, so this throws inside React's unmount path for any hook whose stream stayed quiet"
    ).not.toThrow();
    expect(() => {
      deb.cancel();
      deb.cancel();
    }, "a repeated cancel() threw — cleanup is not idempotent, and StrictMode double-invokes cleanups in development").not.toThrow();

    vi.advanceTimersByTime(MS * 10);
    expect(
      fn,
      "cancelling an idle debouncer somehow scheduled a run — cancel() is mutating state it is only supposed to clear"
    ).not.toHaveBeenCalled();
  });

  it("TD-8 (edge): cancel() after the run has already fired does not re-run or throw", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    deb.run();
    vi.advanceTimersByTime(MS);
    expect(
      fn,
      "the scheduled run never happened, so this test's premise is void"
    ).toHaveBeenCalledTimes(1);

    expect(
      () => deb.cancel(),
      "cancel() threw when called after the timer had already fired. This is the ordinary unmount path — the burst settled, the refetch ran, then the component went away"
    ).not.toThrow();

    vi.advanceTimersByTime(MS * 10);
    expect(
      fn,
      "a post-fire cancel() resurrected the run. cancel() must clear, never schedule"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-9: run() after a cancel() still schedules and fires", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, MS);

    deb.run();
    deb.cancel();
    expect(fn, "the cancelled run fired anyway — see TD-6").not.toHaveBeenCalled();

    deb.run();
    vi.advanceTimersByTime(MS);

    expect(
      fn,
      "the debouncer was poisoned by a cancel() and stopped scheduling. Realtime hooks cancel on every re-subscribe, so a one-shot debouncer means the list stops refreshing after the first reconnect and stays stale for the rest of the session"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-10 (negative): two instances do not share a timer", () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const a = trailingDebounce(fnA, MS);
    const b = trailingDebounce(fnB, MS);

    a.run(); // t = 0, deadline 120
    vi.advanceTimersByTime(30);
    b.run(); // t = 30, deadline 150
    vi.advanceTimersByTime(90); // t = 120 — a's deadline

    expect(
      fnA,
      "one debouncer's run() cancelled another's pending run — the timer is shared instead of per-instance. use-session-data creates courts/waitlist/matches debouncers in a single effect, so a shared timer means the busiest stream starves the other two and two of the three lists silently never refresh"
    ).toHaveBeenCalledTimes(1);
    expect(
      fnB,
      "the second instance fired on the FIRST instance's deadline — the two are sharing one timer handle and whichever scheduled last wins"
    ).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30); // t = 150 — b's deadline
    expect(fnB, "the second instance's own deadline never fired").toHaveBeenCalledTimes(1);
    expect(
      fnA,
      "the first instance ran a second time off the other instance's timer"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-11 (edge): a run scheduled from inside fn is still cancellable", () => {
    // The source sets `timer = null` BEFORE calling fn. If those two lines were
    // swapped, a run() issued from inside fn would have its handle overwritten
    // with null the instant fn returned — leaving a live timer that cancel()
    // can no longer see.
    let self: TrailingDebouncer | null = null;
    const fn = vi.fn(() => {
      self?.run();
    });
    const deb = trailingDebounce(fn, MS);
    self = deb;

    deb.run();
    vi.advanceTimersByTime(MS);
    expect(
      fn,
      "the first trailing run never happened, so this test's premise is void"
    ).toHaveBeenCalledTimes(1);

    deb.cancel();
    vi.advanceTimersByTime(MS * 20);

    expect(
      fn,
      "a run scheduled from inside fn survived cancel(). The debouncer lost track of its own pending handle, so cleanup cannot stop it — the refetch keeps firing after unmount and, because each run reschedules, it never stops"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-12 (edge): ms = 0 still defers to a timer tick instead of running inline", () => {
    const fn = vi.fn();
    const deb = trailingDebounce(fn, 0);

    deb.run();
    expect(
      fn,
      "a zero delay short-circuited into a synchronous call. Running inline re-enters the caller's realtime handler on the same stack, which is precisely the reentrancy the deferral is there to avoid"
    ).not.toHaveBeenCalled();

    deb.run();
    vi.advanceTimersByTime(0);
    expect(
      fn,
      "a zero-delay debouncer never fired — `ms` of 0 must still schedule, and two calls in the same tick must still collapse to one"
    ).toHaveBeenCalledTimes(1);
  });

  it("TD-13 (negative): cancel() on one instance does not cancel another's pending run", () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const a = trailingDebounce(fnA, MS);
    const b = trailingDebounce(fnB, MS);

    a.run();
    b.run();
    a.cancel();
    vi.advanceTimersByTime(MS * 2);

    expect(
      fnA,
      "the cancelled instance ran anyway — see TD-6; cancel() is not clearing its own timer"
    ).not.toHaveBeenCalled();
    expect(
      fnB,
      "cancelling one debouncer cancelled a different instance's pending run. Unsubscribing a single realtime stream would then silently kill the refetch of every other stream created in the same effect"
    ).toHaveBeenCalledTimes(1);
  });
});
