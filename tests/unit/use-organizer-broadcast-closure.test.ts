// @vitest-environment happy-dom
// ============================================================
// Unit Tests — session-closure detection (useSessionClosedWatcher)
// ============================================================
// Exercised through useOrganizerBroadcast, which is how the player dashboard
// mounts it. (The organizer board mounts the watcher directly and passes a
// fallbackPath; the logic under test is the same object.)
//
// `session_closed` used to reach players over the broadcast channel and
// NOWHERE else. Nothing the player dashboard polls carries the fact —
// useSessionData reads `courts` and `queue_entries`, never the session row —
// so a player whose channel never joined, or whose socket happened to be down
// across the one moment the organizer closed, sat on a frozen dashboard until
// they manually reloaded. Broadcasts are fire-and-forget with no replay, so
// nothing would ever have arrived. (PENDING_WORK_2026-07-23.md §2.3.)
//
// There are now THREE independent detection paths — broadcast, the `sessions`
// row's own postgres_changes stream, and a status poll — funnelling into one
// latched navigation whose DESTINATION is resolved per viewer rather than
// assumed.
//
// Every failure below is silent by construction — the dashboard keeps
// rendering a live-looking session — so only these assertions can catch a
// regression.
//
//   OBC-1  The broadcast still navigates, club-scoped when under /c/<slug>/…
//          and to the legacy path otherwise. The fallback must not have
//          displaced the fast path.
//   OBC-2  Channel silent forever → the slow poll discovers the closure and
//          navigates. This is the whole point of the change.
//   OBC-3  A session that is still active never navigates, however many times
//          it is polled. A false positive yanks a player out of a live session.
//   OBC-4  Every error shape holds: unauthenticated, "session not found", and a
//          thrown transport failure. "Unknown" is NOT "closed".
//   OBC-5  Broadcast and poll both concluding closed navigate exactly ONCE.
//   OBC-6  A channel-status transition re-checks immediately — a join failure
//          or a drop+rejoin is exactly when a message can have been missed,
//          and waiting out the interval is the difference between "stale for a
//          second" and "stale for twenty".
//   OBC-7  Phone unlock / tab restore re-checks. The socket was killed while
//          the screen was off, so this is the realistic recovery moment.
//   OBC-8  A burst of triggers collapses to one call (min-gap throttle) — and
//          the suppressed tick is RESCHEDULED, not dropped. Gym wifi produces
//          CHANNEL_ERROR/TIMED_OUT storms; without the floor each player would
//          hammer the action, and without the reschedule a storm could eat
//          every trigger in a window and leave nothing pending.
//   OBC-9  Unmount stops the interval AND removes the listener — no stray
//          server action, no navigation fired onto another screen.
//   OBC-10 The destination is resolved for THIS viewer. A player with no
//          session_wrapped_stats row goes to the lobby, not to an all-zero
//          recap that would then remember having been dismissed.
//   OBC-11 The `sessions` row subscription is its own detection path: it fires
//          when the broadcast POST never lands, and it is not fooled by an
//          UPDATE that leaves the session running.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { OrganizerBroadcastHandlers } from "@/lib/realtime";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PLAYER_ID = "99999999-8888-7777-6666-555555555555";

const POLL_MS = 20_000;
const MIN_GAP_MS = 5_000;
const REDIRECT_DELAY_MS = 250;

const WRAPPED_PATH = `/wrapped/${SESSION_ID}/${PLAYER_ID}`;
const LOBBY_PATH = "/play";

// ── Mocks ─────────────────────────────────────────────────────
// Each factory only *closes over* the module-level bindings; none reads them
// while the factory itself runs, which keeps them out of the TDZ (vi.mock
// factories are hoisted above this file's module body).

let capturedHandlers: OrganizerBroadcastHandlers | null = null;
const unsubscribeSpy = vi.fn();

type RowChange = { new: unknown; old: unknown; eventType: string };
let capturedRowChange: ((payload: RowChange) => void) | null = null;
let capturedRowStatus: (() => void) | null = null;
const unsubscribeRowSpy = vi.fn();

vi.mock("@/lib/realtime", () => ({
  subscribeToOrganizerBroadcast: (
    _client: unknown,
    _sessionId: string,
    handlers: OrganizerBroadcastHandlers
  ) => {
    capturedHandlers = handlers;
    return unsubscribeSpy;
  },
  subscribeToSessionRow: (
    _client: unknown,
    _sessionId: string,
    onChange: (payload: RowChange) => void,
    _channelPrefix: string | undefined,
    onStatus: (() => void) | undefined
  ) => {
    capturedRowChange = onChange;
    capturedRowStatus = onStatus ?? null;
    return unsubscribeRowSpy;
  },
}));

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({}),
}));

const pushSpy = vi.fn();
const refreshSpy = vi.fn();
let pathname = "/play";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
  usePathname: () => pathname,
}));

type StatusResult =
  | { success: true; isActive: boolean; hasWrapped: boolean }
  | { success: false; error: string };

const getPlayerSessionStatusMock = vi.fn<(sessionId: string) => Promise<StatusResult>>(() =>
  Promise.resolve({ success: true, isActive: true, hasWrapped: false })
);

vi.mock("@/app/actions/sessions", () => ({
  getPlayerSessionStatus: (sessionId: string) => getPlayerSessionStatusMock(sessionId),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { useOrganizerBroadcast } from "@/hooks/use-organizer-broadcast";
import { useSessionClosedWatcher } from "@/hooks/use-session-closed-watcher";

// ── Harness ───────────────────────────────────────────────────

/** A closed session this viewer HAS a recap for — the happy path. */
const CLOSED_WITH_RECAP: StatusResult = { success: true, isActive: false, hasWrapped: true };
/** A closed session this viewer has NO recap for — walk-in, never played. */
const CLOSED_NO_RECAP: StatusResult = { success: true, isActive: false, hasWrapped: false };

function renderBroadcast() {
  return renderHook(() => useOrganizerBroadcast(SESSION_ID, PLAYER_ID));
}

/**
 * Mount the watcher directly, the way the organizer board does.
 *
 * `useOrganizerBroadcast` returns void and never surfaces `suppressLocalClose`
 * or the options, so those can only be reached from here.
 */
function renderWatcher(options?: { fallbackPath?: string; toastMessage?: string }) {
  return renderHook(() => useSessionClosedWatcher(SESSION_ID, PLAYER_ID, options));
}

/** Drain the microtask queue without moving the clock. */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * Advance fake timers inside act, flushing the promises the tick kicks off.
 *
 * The drain matters more than it used to: navigation is now gated on
 * Promise.all([destination probe, toast delay]), so the push lands several
 * microtask hops after the timer that released it.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await drain();
  });
}

/** Let a pending server-action promise settle without moving the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await drain();
  });
}

/** Deliver a channel-status transition the way createStatusHandler would. */
async function emitStatus(connected: boolean): Promise<void> {
  const handler = capturedHandlers?.onStatus;
  if (!handler) throw new Error("onStatus was never registered");
  await act(async () => {
    handler(`session-events:${SESSION_ID}`, connected);
  });
  await flush();
}

/**
 * Deliver session_closed the way subscribeToOrganizerBroadcast would.
 *
 * `wrappedReady` is the session-wide hint closeSession puts on the payload:
 * true = compute_session_wrapped succeeded, false = it did not (nobody has a
 * recap), undefined = an older client that predates the field.
 */
function emitSessionClosed(wrappedReady?: boolean): void {
  const handler = capturedHandlers?.onSessionClosed;
  if (!handler) throw new Error("onSessionClosed was never registered");
  act(() => {
    handler({ sessionId: SESSION_ID, wrappedReady });
  });
}

/** Deliver a `sessions` row UPDATE the way postgres_changes would. */
async function emitRowUpdate(isActive: boolean): Promise<void> {
  const handler = capturedRowChange;
  if (!handler) throw new Error("subscribeToSessionRow was never registered");
  await act(async () => {
    handler({
      eventType: "UPDATE",
      old: { id: SESSION_ID },
      new: { id: SESSION_ID, is_active: isActive },
    });
    await drain();
  });
}

/** Fire a visibilitychange with the given state. */
async function setVisibility(state: "visible" | "hidden"): Promise<void> {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers = null;
  capturedRowChange = null;
  capturedRowStatus = null;
  pathname = "/play";
  getPlayerSessionStatusMock.mockResolvedValue({
    success: true,
    isActive: true,
    hasWrapped: false,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── OBC-1 ─────────────────────────────────────────────────────

describe("OBC-1: the broadcast fast path still navigates", () => {
  it("OBC-1a: redirects to the legacy Wrapped path off a club route", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();
    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-1b: redirects club-scoped when the path carries a slug", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    pathname = `/c/chillax/play/${SESSION_ID}`;
    renderBroadcast();
    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(
      `/c/chillax/wrapped/${SESSION_ID}/${PLAYER_ID}`
    );
  });

  it("OBC-1c: does not navigate before the toast has had its moment", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();
    emitSessionClosed(true);
    await flush();

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("OBC-1d: refreshes the current route immediately, without waiting for the push", async () => {
    // The push is delayed and can land on a page that does not redirect at all
    // (the organizer board). The refresh is what makes the screen stop lying in
    // the meantime.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();
    emitSessionClosed(true);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

// ── OBC-2 ─────────────────────────────────────────────────────

describe("OBC-2: the poll rescues a player the broadcast never reached", () => {
  it("OBC-2a: a closed session discovered by the interval navigates", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    // No broadcast, no row event, no unlock — only the safety net.
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledWith(SESSION_ID);
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-2b: nothing is polled before the first interval elapses", async () => {
    renderBroadcast();
    await advance(POLL_MS - 1);

    expect(getPlayerSessionStatusMock).not.toHaveBeenCalled();
  });
});

// ── OBC-3 ─────────────────────────────────────────────────────

describe("OBC-3: a live session is never navigated away from", () => {
  it("OBC-3a: repeated polls of an active session never redirect", async () => {
    renderBroadcast();

    for (let i = 0; i < 5; i++) await advance(POLL_MS);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(5);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ── OBC-4 ─────────────────────────────────────────────────────

describe("OBC-4: an ambiguous answer holds the dashboard", () => {
  it.each([
    ["unauthenticated", { success: false as const, error: "Not authenticated." }],
    ["missing row", { success: false as const, error: "Session not found." }],
    ["read failure", { success: false as const, error: "Failed to read session status." }],
  ])("OBC-4 (%s): does not navigate", async (_label, result) => {
    getPlayerSessionStatusMock.mockResolvedValue(result);
    renderBroadcast();

    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("OBC-4d: a thrown transport error is swallowed and retried next tick", async () => {
    getPlayerSessionStatusMock.mockRejectedValueOnce(new Error("Failed to fetch"));
    renderBroadcast();

    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);
    expect(pushSpy).not.toHaveBeenCalled();

    // The rejection must not have wedged the in-flight latch.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });
});

// ── OBC-5 ─────────────────────────────────────────────────────

describe("OBC-5: the paths cannot double-navigate", () => {
  it("OBC-5a: broadcast then poll pushes exactly once", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    emitSessionClosed(true);
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);
    await advance(POLL_MS);

    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("OBC-5b: a broadcast arriving after the poll won a race adds no second push", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    await advance(POLL_MS);
    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("OBC-5c: the row event and the broadcast for one closure push once", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    await emitRowUpdate(false);
    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});

// ── OBC-6 ─────────────────────────────────────────────────────

describe("OBC-6: a channel-status transition re-checks immediately", () => {
  it("OBC-6a: a failed join checks without waiting out the interval", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    await emitStatus(false);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-6b: a re-join after a drop also checks — that gap is unreplayable", async () => {
    renderBroadcast();

    await emitStatus(false);
    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);

    // Past the throttle floor, so the re-join is its own check rather than a
    // suppressed duplicate of the drop.
    await advance(MIN_GAP_MS);
    await emitStatus(true);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(2);
  });

  it("OBC-6c: the session-row channel's own status transition also re-checks", async () => {
    // Path 2 can fail to join for exactly the reasons path 1 can. Its status
    // handler shares the same check.
    renderBroadcast();

    await act(async () => {
      capturedRowStatus?.();
      await drain();
    });

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);
  });
});

// ── OBC-7 ─────────────────────────────────────────────────────

describe("OBC-7: phone unlock re-checks", () => {
  it("OBC-7a: becoming visible checks and navigates on a closed session", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    await setVisibility("visible");
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-7b: going hidden checks nothing", async () => {
    renderBroadcast();

    await setVisibility("hidden");

    expect(getPlayerSessionStatusMock).not.toHaveBeenCalled();
  });
});

// ── OBC-8 ─────────────────────────────────────────────────────

describe("OBC-8: a trigger storm collapses to one call", () => {
  it("OBC-8a: ten status flaps inside the floor produce a single check", async () => {
    renderBroadcast();

    for (let i = 0; i < 10; i++) {
      await emitStatus(i % 2 === 0);
      await advance(MIN_GAP_MS / 20);
    }

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);
  });

  it("OBC-8b: the floor releases once it has elapsed", async () => {
    renderBroadcast();

    await emitStatus(false);
    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);

    await advance(MIN_GAP_MS);
    await emitStatus(false);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(2);
  });

  it("OBC-8c: a throttled trigger is rescheduled, not dropped", async () => {
    // The storm consumed every trigger in the window. If the suppressed tick
    // were simply discarded, nothing would run until the next 20 s interval —
    // and a storm is precisely when a closure is most likely to have been
    // missed. The floor must delay the check, not cancel it.
    renderBroadcast();

    await emitStatus(false); // check #1, at t=0
    await advance(MIN_GAP_MS / 10);
    await emitStatus(true); // suppressed → rescheduled for the floor
    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);

    await advance(MIN_GAP_MS);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(2);
  });
});

// ── OBC-9 ─────────────────────────────────────────────────────

describe("OBC-9: unmount tears everything down", () => {
  it("OBC-9a: no poll, no listener and no navigation after unmount", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { unmount } = renderBroadcast();

    unmount();

    await advance(POLL_MS * 3);
    await setVisibility("visible");
    await advance(REDIRECT_DELAY_MS);

    expect(getPlayerSessionStatusMock).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).toHaveBeenCalled();
    expect(unsubscribeRowSpy).toHaveBeenCalled();
  });

  it("OBC-9b: a reply landing after unmount cannot navigate", async () => {
    let resolveStatus: (r: StatusResult) => void = () => {};
    getPlayerSessionStatusMock.mockReturnValueOnce(
      new Promise<StatusResult>((resolve) => {
        resolveStatus = resolve;
      })
    );
    const { unmount } = renderBroadcast();

    await advance(POLL_MS); // check dispatched, still in flight
    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveStatus(CLOSED_WITH_RECAP);
      await drain();
    });
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("OBC-9c: a redirect already scheduled when the component unmounts is cancelled", async () => {
    // The gap between the toast and the push is long enough for the route to
    // change underneath it. The closed session ALSO makes the RSC bounce a
    // returning player to the club lobby, so an uncancelled timer would drag
    // them off that page moments after they landed on it.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { unmount } = renderBroadcast();

    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS / 2); // scheduled, not yet fired
    expect(pushSpy).not.toHaveBeenCalled();

    unmount();
    await advance(REDIRECT_DELAY_MS * 8);

    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ── OBC-10 ────────────────────────────────────────────────────

describe("OBC-10: the destination is resolved for this viewer", () => {
  it("OBC-10a: no recap for this player → the lobby, not an all-zero Wrapped", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_NO_RECAP);
    renderBroadcast();

    emitSessionClosed(true); // session-wide compute DID succeed…
    await advance(REDIRECT_DELAY_MS);

    // …but this walk-in never played, so there is no row to render.
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(LOBBY_PATH);
  });

  it("OBC-10b: wrappedReady=false is session-wide and skips the probe entirely", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    emitSessionClosed(false); // compute_session_wrapped failed for everyone
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(LOBBY_PATH);
    // Authoritative answer — no reason to ask again.
    expect(getPlayerSessionStatusMock).not.toHaveBeenCalled();
  });

  it("OBC-10c: club-scoped viewers fall back to the club lobby", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_NO_RECAP);
    pathname = `/c/chillax/play/${SESSION_ID}`;
    renderBroadcast();

    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith("/c/chillax");
  });

  it("OBC-10d: an inconclusive probe trusts the broadcast's session-wide hint", async () => {
    // The probe errored, but the close itself said a recap exists. Wrapped is
    // the better guess than stranding the player in the lobby.
    getPlayerSessionStatusMock.mockResolvedValue({ success: false, error: "Not authenticated." });
    renderBroadcast();

    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-10e: the push waits for a probe slower than the toast delay", async () => {
    // Racing the probe against the toast delay instead of waiting for it would
    // make 250 ms the probe's real budget and send everyone to the lobby.
    let resolveProbe: (r: StatusResult) => void = () => {};
    getPlayerSessionStatusMock.mockReturnValueOnce(
      new Promise<StatusResult>((resolve) => {
        resolveProbe = resolve;
      })
    );
    renderBroadcast();

    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS * 2);
    expect(pushSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveProbe(CLOSED_WITH_RECAP);
      await drain();
    });

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });
});

// ── OBC-11 ────────────────────────────────────────────────────

describe("OBC-11: the session row is an independent detection path", () => {
  it("OBC-11a: is_active flipping to false navigates with no broadcast at all", async () => {
    // This is the path that survives a broadcast POST that never lands: the
    // row change is committed, so any tab holding a live join hears it.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    renderBroadcast();

    await emitRowUpdate(false);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-11b: an UPDATE that leaves the session running does nothing", async () => {
    // Sessions get updated mid-night for plenty of reasons — toggles, caps,
    // draft phase. None of them is a closure.
    renderBroadcast();

    await emitRowUpdate(true);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ── OBC-12 ────────────────────────────────────────────────────

describe("OBC-12: suppressLocalClose — the tab running its own close flow", () => {
  it("OBC-12a: the organizer's own echo does not double-navigate them", async () => {
    // A REST-originated broadcast has no sending socket, so the organizer who
    // clicked "close" hears their own session_closed — while closeSession is
    // still in flight. Unsuppressed, one click produces two toasts and two
    // competing pushes.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { result } = renderWatcher();

    act(() => {
      result.current.suppressLocalClose(true);
    });
    act(() => {
      result.current.handleSessionClosed({ sessionId: SESSION_ID, wrappedReady: true });
    });
    await advance(REDIRECT_DELAY_MS * 4);

    expect(pushSpy).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("OBC-12b: suppression covers the poll too, not just the broadcast", async () => {
    // Suppression that only gated path 1 would let the poll fire a second push
    // 20 s into a close flow that already navigated.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { result } = renderWatcher();

    act(() => {
      result.current.suppressLocalClose(true);
    });
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("OBC-12c: releasing it re-arms the watcher", async () => {
    // The close FAILED. If suppression stuck, this board would be permanently
    // deaf — a co-organizer closing the session a minute later would move
    // everyone else and leave this one on a live-looking dead board.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { result } = renderWatcher();

    act(() => {
      result.current.suppressLocalClose(true);
    });
    act(() => {
      result.current.suppressLocalClose(false);
    });
    act(() => {
      result.current.handleSessionClosed({ sessionId: SESSION_ID, wrappedReady: true });
    });
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-12d: suppression is not a latch — it never consumes the one navigation", async () => {
    // navigatedRef must NOT be set by a suppressed signal. If it were, the
    // release above would re-arm nothing.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { result } = renderWatcher();

    act(() => {
      result.current.suppressLocalClose(true);
    });
    act(() => {
      result.current.handleSessionClosed({ sessionId: SESSION_ID, wrappedReady: true });
    });
    await advance(REDIRECT_DELAY_MS);
    expect(pushSpy).not.toHaveBeenCalled();

    act(() => {
      result.current.suppressLocalClose(false);
    });
    await emitRowUpdate(false);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });
});

// ── OBC-13 ────────────────────────────────────────────────────

describe("OBC-13: the organizer board's mount options", () => {
  it("OBC-13a: fallbackPath overrides where a recap-less viewer lands", async () => {
    // The organizer board passes its own — "/play" would be wrong for them.
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_NO_RECAP);
    const { result } = renderWatcher({ fallbackPath: "/organizer" });

    act(() => {
      result.current.handleSessionClosed({ sessionId: SESSION_ID, wrappedReady: true });
    });
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith("/organizer");
  });

  it("OBC-13b: toastMessage overrides the player-facing copy", async () => {
    getPlayerSessionStatusMock.mockResolvedValue(CLOSED_WITH_RECAP);
    const { result } = renderWatcher({ toastMessage: "Session closed." });

    act(() => {
      result.current.handleSessionClosed({ sessionId: SESSION_ID, wrappedReady: true });
    });

    expect(toast.info).toHaveBeenCalledWith("Session closed.", expect.anything());
  });
});

// ── OBC-14 ────────────────────────────────────────────────────

describe("OBC-14: a probe that never answers still resolves a destination", () => {
  it("OBC-14a: the probe times out and falls back to the session-wide hint", async () => {
    // Distinct from OBC-10d, which covers a probe that ERRORS. A hung server
    // action returns nothing at all, and an unbounded wait here would leave the
    // viewer on a dead board forever — the failure this whole hook exists for.
    getPlayerSessionStatusMock.mockReturnValue(new Promise<StatusResult>(() => {}));
    renderBroadcast();

    emitSessionClosed(true);
    await advance(REDIRECT_DELAY_MS);
    expect(pushSpy).not.toHaveBeenCalled();

    await advance(1_200); // DESTINATION_PROBE_MS

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(WRAPPED_PATH);
  });

  it("OBC-14b: with no hint at all, a hung probe lands on the page that always renders", async () => {
    getPlayerSessionStatusMock.mockReturnValue(new Promise<StatusResult>(() => {}));
    renderBroadcast();

    await emitRowUpdate(false); // row path carries no wrappedReady
    await advance(REDIRECT_DELAY_MS + 1_200);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(LOBBY_PATH);
  });
});
