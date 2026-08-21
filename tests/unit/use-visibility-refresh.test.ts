// @vitest-environment happy-dom
// ============================================================
// useVisibilityRefresh — the phone-unlock recovery path (VR)
// ============================================================
// This hook is the app's only recovery from the failure that produced the
// 07/25 "kicked out of the queue" incident. A mobile browser suspends JS and
// kills the Supabase WebSocket when the screen locks or the user switches
// tabs. Nothing tells the page it happened. When the player comes back, the
// socket is dead, no WAL event will ever arrive again, and the last render
// stays on screen looking authoritative — a stale queue, a match that already
// ended, a court that is now free. The player reads it as being dropped.
//
// The ONLY trigger that fires in that situation is `visibilitychange`. So
// every property below is load-bearing in a way that is invisible on a
// desktop, where the socket never dies and nobody notices the hook is broken:
//
//   * GUARD ORDER. `visibilityState !== "visible"` is checked BEFORE the
//     throttle stamp is written. Swap those two and the HIDING event (which
//     fires on every lock, every tab switch — always immediately before the
//     one that matters) consumes the throttle budget, so the visible event
//     that follows it is refused and recovery is delayed by the full window.
//     The user experiences exactly the incident the hook exists to prevent.
//     VR-11 is that test, and it is the reason the negatives here assert
//     "the budget was not consumed" and not merely "nothing fired".
//
//   * THE LISTENER IS REMOVED ON UNMOUNT. This hook is mounted per screen and
//     the app navigates constantly. A cleanup that does not fire leaves one
//     live handler per visited screen, each holding a stale router and a
//     stale onVisible closure over data that no longer exists; every unlock
//     then fans out into N router.refresh() calls and N re-fetches. VR-7
//     dispatches AFTER unmount, which is the only way to see it.
//
//   * THE REF-CALLBACK PATTERN. Callers pass an inline arrow
//     (`useVisibilityRefresh(() => { refreshQueue(); refreshMatch(); })`), so
//     `onVisible` is a new function on every render. It is deliberately kept
//     out of the effect deps and read through a ref. Two things can go wrong
//     and only one of them is visible without counting registrations: adding
//     it to the deps re-registers the listener on EVERY render (a churn of
//     add/remove on a hot path), and freezing the ref sync calls a callback
//     closed over the first render's state forever. VR-8 asserts both halves.
//
// Fake timers throughout, with an explicit system time. `lastFiredAt` starts
// at 0 and the throttle is `now - lastFiredAt < throttleMs`, so at a mocked
// epoch of 0 the very first event would throttle itself. That is unreachable
// in production (Date.now() is ~1.7e12) but it is reachable in a test, and a
// suite that silently sat in it would report the throttle tests as passing
// for the wrong reason.
//
//   VR-1   (negative) nothing fires while the page is hidden — and the same
//          hook fires both when it becomes visible (control)
//   VR-2   becoming visible calls router.refresh() AND onVisible, once each,
//          refresh first
//   VR-3   (negative) a second visibility event inside throttleMs fires
//          neither — and the first fired both (control)
//   VR-4   an event after throttleMs fires both again
//   VR-5   (edge) the boundary: throttleMs-1 refuses, exactly throttleMs fires
//   VR-6   (edge) a custom throttleMs is honoured, not the 5 s default
//   VR-7   (negative) the listener is removed on unmount — an event dispatched
//          after unmount fires nothing, and one before it fired both (control)
//   VR-8   a new inline onVisible per render: the LATEST is called, the stale
//          one is not, and the listener is registered exactly once
//   VR-9   (edge) an omitted onVisible still refreshes the route and does not
//          throw on the optional call
//   VR-10  (edge) a changed throttleMs takes effect immediately rather than
//          leaving the mount-time window captured in a stale closure
//   VR-11  (negative) GUARD ORDER — a hidden-state event does not consume the
//          throttle budget, so the visible event right after it still fires
//
// WHAT THIS FILE DOES NOT PROVE
//   * That router.refresh() re-runs Server Components. next/navigation is
//     mocked; that is Next.js behaviour, covered by E2E.
//   * That the callbacks passed by real callers re-fetch the right slice.
//     Each hook's own refresh is covered by use-queue / use-player-match /
//     use-organizer-dashboard.
//   * That the socket itself is recycled on recovery. That is
//     realtime-auth-recycle.test.ts and reconnect-throttle.test.ts.
//   * Anything about `pagehide`/`focus`/`online`. This hook listens to
//     visibilitychange only, by design.
//
// IDs: VR
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The router object is created ONCE and returned by every useRouter() call.
// A fresh object per render would be a test artefact, not a Next.js one: the
// hook lists `router` in its effect deps, so an unstable identity would
// re-register the listener every render and VR-8 would be measuring the mock.
const mockRefresh = vi.fn();
const mockRouter = { refresh: mockRefresh };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

import { useVisibilityRefresh } from "@/hooks/use-visibility-refresh";

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_THROTTLE_MS = 5_000;

// Any realistic wall-clock time. See the banner: an epoch of 0 would make the
// first event throttle against lastFiredAt's initial 0.
const SYSTEM_TIME = new Date("2026-08-21T10:00:00.000Z");

// ── Visibility control ────────────────────────────────────────
// happy-dom reports "visible" from a prototype getter. An own property on the
// document instance shadows it; afterEach deletes it so the shadowing cannot
// leak into another suite sharing the environment.

let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
}

/** Set the state and dispatch the event the browser would dispatch with it. */
function fireVisibilityChange(state: DocumentVisibilityState) {
  setVisibility(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** How many of a spy's registrations were for `visibilitychange`. */
function countListenerCalls(calls: readonly unknown[][]): number {
  return calls.filter((call) => call[0] === "visibilitychange").length;
}

/** The `visibilitychange` registrations only, handler argument included. */
function listenerCalls(calls: readonly unknown[][]): readonly unknown[][] {
  return calls.filter((call) => call[0] === "visibilitychange");
}

// ── Tests ─────────────────────────────────────────────────────

describe("useVisibilityRefresh — Unit Suite", () => {
  let addSpy: MockInstance<typeof document.addEventListener>;
  let removeSpy: MockInstance<typeof document.removeEventListener>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SYSTEM_TIME);
    mockRefresh.mockClear();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    addSpy = vi.spyOn(document, "addEventListener");
    removeSpy = vi.spyOn(document, "removeEventListener");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  // ── VR-1 (negative) ────────────────────────────────────────
  it("VR-1: (negative) nothing fires while hidden; the same hook fires both when visible", () => {
    const onVisible = vi.fn();
    renderHook(() => useVisibilityRefresh(onVisible));

    fireVisibilityChange("hidden");

    expect(
      mockRefresh,
      "the route was refreshed as the page went HIDDEN — a suspended tab would issue a Server Component round-trip on its way out, and the throttle budget it burns is the one the recovery needs"
    ).not.toHaveBeenCalled();
    expect(
      onVisible,
      "the re-fetch callback ran while the page was hidden, against a socket that is about to be killed"
    ).not.toHaveBeenCalled();

    // Positive control, past the throttle window so this proves the visibility
    // guard and not the throttle (VR-11 owns the interaction between them).
    vi.advanceTimersByTime(DEFAULT_THROTTLE_MS + 1_000);
    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "control failed: nothing fires on visible either, so the hidden-state assertions above are satisfied by a hook that is simply dead — which is the 07/25 failure mode itself"
    ).toHaveBeenCalledTimes(1);
    expect(
      onVisible,
      "control failed: the re-fetch callback never runs at all"
    ).toHaveBeenCalledTimes(1);
  });

  // ── VR-2 ───────────────────────────────────────────────────
  it("VR-2: becoming visible calls router.refresh() and onVisible once each, refresh first", () => {
    const onVisible = vi.fn();
    renderHook(() => useVisibilityRefresh(onVisible));

    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "router.refresh() did not run on becoming visible — server-rendered profile/session props stay frozen at whatever they were before the phone locked"
    ).toHaveBeenCalledTimes(1);
    expect(
      onVisible,
      "the onVisible callback did not run — client hooks would wait for the Supabase socket to finish reconnecting before the queue updates, which is the delay players read as being dropped"
    ).toHaveBeenCalledTimes(1);

    expect(
      mockRefresh.mock.invocationCallOrder[0],
      "onVisible ran before router.refresh() — the server round-trip should be in flight while the client re-fetches, not queued behind it"
    ).toBeLessThan(onVisible.mock.invocationCallOrder[0]);
  });

  // ── VR-3 (negative) ────────────────────────────────────────
  it("VR-3: (negative) a second visibility event inside throttleMs fires neither", () => {
    const onVisible = vi.fn();
    renderHook(() => useVisibilityRefresh(onVisible));

    fireVisibilityChange("visible");
    expect(mockRefresh, "control failed: the first event fired nothing").toHaveBeenCalledTimes(1);
    expect(onVisible, "control failed: the first event fired nothing").toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "a second visibility event 1 s later refreshed again — rapid tab-switching would fan out into a Server Component render per switch"
    ).toHaveBeenCalledTimes(1);
    expect(
      onVisible,
      "a second visibility event 1 s later re-fetched again — every consumer hook's query runs once per tab switch, against the database"
    ).toHaveBeenCalledTimes(1);
  });

  // ── VR-4 ───────────────────────────────────────────────────
  it("VR-4: an event after throttleMs fires both again", () => {
    const onVisible = vi.fn();
    renderHook(() => useVisibilityRefresh(onVisible));

    fireVisibilityChange("visible");
    vi.advanceTimersByTime(DEFAULT_THROTTLE_MS + 1);
    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "the throttle never re-opened — a hook that fires exactly once per mount cannot recover a player who locks their phone twice"
    ).toHaveBeenCalledTimes(2);
    expect(
      onVisible,
      "the throttle never re-opened for the re-fetch callback"
    ).toHaveBeenCalledTimes(2);
  });

  // ── VR-5 (edge) ────────────────────────────────────────────
  it("VR-5: (edge) the boundary — throttleMs-1 refuses, exactly throttleMs fires", () => {
    const onVisible = vi.fn();
    renderHook(() => useVisibilityRefresh(onVisible));

    fireVisibilityChange("visible");
    expect(mockRefresh, "control failed: the first event fired nothing").toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULT_THROTTLE_MS - 1);
    fireVisibilityChange("visible");
    expect(
      mockRefresh,
      "an event one millisecond INSIDE the window fired — the comparison is `elapsed < throttleMs`, so this is off by one in the permissive direction"
    ).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    fireVisibilityChange("visible");
    expect(
      mockRefresh,
      "an event at exactly throttleMs was refused — the comparison is strict `<`, so the boundary must fire; off by one in the restrictive direction delays every recovery that lands on the boundary"
    ).toHaveBeenCalledTimes(2);
    expect(
      onVisible,
      "the re-fetch callback did not follow the boundary firing"
    ).toHaveBeenCalledTimes(2);
  });

  // ── VR-6 (edge) ────────────────────────────────────────────
  it("VR-6: (edge) a custom throttleMs is honoured rather than the 5 s default", () => {
    const onVisible = vi.fn();
    const CUSTOM_MS = 100;
    renderHook(() => useVisibilityRefresh(onVisible, CUSTOM_MS));

    fireVisibilityChange("visible");
    expect(mockRefresh, "control failed: the first event fired nothing").toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CUSTOM_MS - 1);
    fireVisibilityChange("visible");
    expect(
      mockRefresh,
      "an event inside the CUSTOM window fired — the caller's throttle is being ignored in the permissive direction"
    ).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    fireVisibilityChange("visible");
    expect(
      mockRefresh,
      "an event past the caller's 100 ms window was refused — the default 5 s is hardcoded into the comparison and every caller that asked for a tighter window silently gets 5 s"
    ).toHaveBeenCalledTimes(2);
    expect(
      onVisible,
      "the re-fetch callback did not follow the custom-window firing"
    ).toHaveBeenCalledTimes(2);
  });

  // ── VR-7 (negative) ────────────────────────────────────────
  it("VR-7: (negative) the listener is removed on unmount", () => {
    const onVisible = vi.fn();
    const { unmount } = renderHook(() => useVisibilityRefresh(onVisible));

    const registered = listenerCalls(addSpy.mock.calls);
    expect(registered.length, "the hook never registered a visibilitychange listener at all").toBe(
      1
    );

    // Control: the listener is live before unmount.
    fireVisibilityChange("visible");
    expect(
      mockRefresh,
      "control failed: the listener was never live, so 'nothing fires after unmount' is vacuous"
    ).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULT_THROTTLE_MS + 1);
    unmount();

    const removed = listenerCalls(removeSpy.mock.calls);
    expect(
      removed.length,
      "removeEventListener was never called for visibilitychange on unmount"
    ).toBe(1);
    expect(
      removed[0][1],
      "the cleanup removed a DIFFERENT function than the one registered — removeEventListener silently no-ops on a non-matching handler, so the listener stays attached and this looks like a working cleanup"
    ).toBe(registered[0][1]);

    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "an unmounted hook still refreshed the route — every screen the player has visited keeps a live handler, so one unlock fans out into a router.refresh() per stale mount"
    ).toHaveBeenCalledTimes(1);
    expect(
      onVisible,
      "an unmounted hook still ran its re-fetch callback, which closes over state that no longer exists"
    ).toHaveBeenCalledTimes(1);
  });

  // ── VR-8 ───────────────────────────────────────────────────
  it("VR-8: a new inline onVisible per render — the latest is called and the listener is not re-registered", () => {
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useVisibilityRefresh(cb), {
      initialProps: { cb: first },
    });

    const afterMount = countListenerCalls(addSpy.mock.calls);
    expect(afterMount, "the hook never registered a visibilitychange listener").toBe(1);

    // A parent re-render handing down a brand-new arrow — what every real
    // caller does, since they all pass an inline closure.
    rerender({ cb: second });

    expect(
      countListenerCalls(addSpy.mock.calls),
      "the listener was re-registered on a plain re-render — `onVisible` has leaked into the effect deps, so a screen that renders on every queue tick churns add/remove on document for no reason"
    ).toBe(afterMount);
    expect(
      countListenerCalls(removeSpy.mock.calls),
      "the listener was torn down on a plain re-render — between the remove and the add there is a window in which a visibilitychange is dropped entirely"
    ).toBe(0);

    fireVisibilityChange("visible");

    expect(
      second,
      "the LATEST onVisible was not called — the ref sync is frozen, so recovery runs a callback closed over the first render's state and re-fetches with a stale session or player id"
    ).toHaveBeenCalledTimes(1);
    expect(
      first,
      "the STALE onVisible from a previous render was called — that closure captures data the screen has already replaced"
    ).not.toHaveBeenCalled();
  });

  // ── VR-9 (edge) ────────────────────────────────────────────
  it("VR-9: (edge) an omitted onVisible still refreshes the route and does not throw", () => {
    renderHook(() => useVisibilityRefresh());

    expect(() => fireVisibilityChange("visible")).not.toThrow();

    expect(
      mockRefresh,
      "a caller that wants only the Server Component refresh got nothing — the optional callback must not gate the router refresh"
    ).toHaveBeenCalledTimes(1);
  });

  // ── VR-10 (edge) ───────────────────────────────────────────
  it("VR-10: (edge) a changed throttleMs takes effect immediately", () => {
    const onVisible = vi.fn();
    const { rerender } = renderHook(
      ({ ms }: { ms: number }) => useVisibilityRefresh(onVisible, ms),
      { initialProps: { ms: DEFAULT_THROTTLE_MS } }
    );

    fireVisibilityChange("visible");
    expect(mockRefresh, "control failed: the first event fired nothing").toHaveBeenCalledTimes(1);

    rerender({ ms: 100 });
    vi.advanceTimersByTime(200);
    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "the handler is still enforcing the MOUNT-TIME throttle — throttleMs is missing from the effect deps, so a screen that tightens its window after mount keeps the old one until it unmounts"
    ).toHaveBeenCalledTimes(2);
    expect(
      onVisible,
      "the re-fetch callback did not follow the re-opened window"
    ).toHaveBeenCalledTimes(2);
  });

  // ── VR-11 (negative) ───────────────────────────────────────
  it("VR-11: (negative) GUARD ORDER — a hidden event does not consume the throttle budget", () => {
    const onVisible = vi.fn();
    renderHook(() => useVisibilityRefresh(onVisible));

    // The exact real-world sequence: the screen locks (hidden), then a moment
    // later the player unlocks it (visible). The two events are always well
    // inside the 5 s window.
    fireVisibilityChange("hidden");

    // Pin down WHICH event does the work. Without this, the assertions below
    // are also satisfied by a hook that has lost its visibility guard
    // entirely and fired on the lock instead of the unlock — one call either
    // way, for opposite reasons.
    expect(
      mockRefresh,
      "the lock itself refreshed the route — the count below would then be spent on the wrong event and this test would pass while the unlock did nothing"
    ).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    fireVisibilityChange("visible");

    expect(
      mockRefresh,
      "the HIDDEN event consumed the throttle budget, so the unlock that followed it was refused — the visibility check must run BEFORE the throttle stamp. Reversed, the hook fires nothing on the one event it exists for and the player stares at a stale queue for the whole window: the 07/25 incident, reproduced by the fix for it"
    ).toHaveBeenCalledTimes(1);
    expect(
      onVisible,
      "the re-fetch callback was suppressed by a throttle stamp written while the page was hidden"
    ).toHaveBeenCalledTimes(1);
  });
});
