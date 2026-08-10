// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useOrganizerBroadcast session-closure fallback
// ============================================================
// `session_closed` used to reach players over the broadcast channel and
// NOWHERE else. Nothing the player dashboard polls carries the fact —
// useSessionData reads `courts` and `queue_entries`, never the session row —
// so a player whose channel never joined, or whose socket happened to be down
// across the one moment the organizer closed, sat on a frozen dashboard until
// they manually reloaded. Broadcasts are fire-and-forget with no replay, so
// nothing would ever have arrived. (PENDING_WORK_2026-07-23.md §2.3.)
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
//          and waiting out the 2-minute interval is the difference between
//          "stale for a second" and "stale for two minutes".
//   OBC-7  Phone unlock / tab restore re-checks. The socket was killed while
//          the screen was off, so this is the realistic recovery moment.
//   OBC-8  A burst of triggers collapses to one call (min-gap throttle).
//          Gym wifi produces CHANNEL_ERROR/TIMED_OUT storms; without the floor
//          each player would hammer the action.
//   OBC-9  Unmount stops the interval AND removes the listener — no stray
//          server action, no navigation fired onto another screen.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { OrganizerBroadcastHandlers } from "@/lib/realtime";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PLAYER_ID = "99999999-8888-7777-6666-555555555555";

const POLL_MS = 120_000;
const MIN_GAP_MS = 10_000;
const REDIRECT_DELAY_MS = 800;

// ── Mocks ─────────────────────────────────────────────────────
// Each factory only *closes over* the module-level bindings; none reads them
// while the factory itself runs, which keeps them out of the TDZ (vi.mock
// factories are hoisted above this file's module body).

let capturedHandlers: OrganizerBroadcastHandlers | null = null;
const unsubscribeSpy = vi.fn();

vi.mock("@/lib/realtime", () => ({
  subscribeToOrganizerBroadcast: (
    _client: unknown,
    _sessionId: string,
    handlers: OrganizerBroadcastHandlers
  ) => {
    capturedHandlers = handlers;
    return unsubscribeSpy;
  },
}));

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({}),
}));

const pushSpy = vi.fn();
let pathname = "/play";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, refresh: vi.fn() }),
  usePathname: () => pathname,
}));

type StatusResult = { success: true; isActive: boolean } | { success: false; error: string };

const getPlayerSessionStatusMock = vi.fn<(sessionId: string) => Promise<StatusResult>>(() =>
  Promise.resolve({ success: true, isActive: true })
);

vi.mock("@/app/actions/sessions", () => ({
  getPlayerSessionStatus: (sessionId: string) => getPlayerSessionStatusMock(sessionId),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { useOrganizerBroadcast } from "@/hooks/use-organizer-broadcast";

// ── Harness ───────────────────────────────────────────────────

function renderBroadcast() {
  return renderHook(() => useOrganizerBroadcast(SESSION_ID, PLAYER_ID));
}

/** Advance fake timers inside act, flushing the promises the tick kicks off. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** Let a pending server-action promise settle without moving the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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

/** Deliver session_closed the way subscribeToOrganizerBroadcast would. */
function emitSessionClosed(): void {
  const handler = capturedHandlers?.onSessionClosed;
  if (!handler) throw new Error("onSessionClosed was never registered");
  act(() => {
    handler({ sessionId: SESSION_ID });
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
  pathname = "/play";
  getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── OBC-1 ─────────────────────────────────────────────────────

describe("OBC-1: the broadcast fast path still navigates", () => {
  it("OBC-1a: redirects to the legacy Wrapped path off a club route", async () => {
    renderBroadcast();
    emitSessionClosed();
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(`/wrapped/${SESSION_ID}/${PLAYER_ID}`);
  });

  it("OBC-1b: redirects club-scoped when the path carries a slug", async () => {
    pathname = `/c/chillax/play/${SESSION_ID}`;
    renderBroadcast();
    emitSessionClosed();
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(
      `/c/chillax/wrapped/${SESSION_ID}/${PLAYER_ID}`
    );
  });

  it("OBC-1c: does not navigate before the toast has had its moment", () => {
    renderBroadcast();
    emitSessionClosed();

    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ── OBC-2 ─────────────────────────────────────────────────────

describe("OBC-2: the poll rescues a player the broadcast never reached", () => {
  it("OBC-2a: a closed session discovered by the interval navigates", async () => {
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    renderBroadcast();

    // No broadcast, no status transition, no unlock — only the safety net.
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledWith(SESSION_ID);
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(`/wrapped/${SESSION_ID}/${PLAYER_ID}`);
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
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(`/wrapped/${SESSION_ID}/${PLAYER_ID}`);
  });
});

// ── OBC-5 ─────────────────────────────────────────────────────

describe("OBC-5: the two paths cannot double-navigate", () => {
  it("OBC-5a: broadcast then poll pushes exactly once", async () => {
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    renderBroadcast();

    emitSessionClosed();
    await advance(POLL_MS);
    await advance(REDIRECT_DELAY_MS);
    await advance(POLL_MS);

    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("OBC-5b: a broadcast arriving after the poll won a race adds no second push", async () => {
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    renderBroadcast();

    await advance(POLL_MS);
    emitSessionClosed();
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});

// ── OBC-6 ─────────────────────────────────────────────────────

describe("OBC-6: a channel-status transition re-checks immediately", () => {
  it("OBC-6a: a failed join checks without waiting out the interval", async () => {
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    renderBroadcast();

    await emitStatus(false);
    await advance(REDIRECT_DELAY_MS);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(`/wrapped/${SESSION_ID}/${PLAYER_ID}`);
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
});

// ── OBC-7 ─────────────────────────────────────────────────────

describe("OBC-7: phone unlock re-checks", () => {
  it("OBC-7a: becoming visible checks and navigates on a closed session", async () => {
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    renderBroadcast();

    await setVisibility("visible");
    await advance(REDIRECT_DELAY_MS);

    expect(getPlayerSessionStatusMock).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledExactlyOnceWith(`/wrapped/${SESSION_ID}/${PLAYER_ID}`);
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
});

// ── OBC-9 ─────────────────────────────────────────────────────

describe("OBC-9: unmount tears everything down", () => {
  it("OBC-9a: no poll, no listener and no navigation after unmount", async () => {
    getPlayerSessionStatusMock.mockResolvedValue({ success: true, isActive: false });
    const { unmount } = renderBroadcast();

    unmount();

    await advance(POLL_MS * 3);
    await setVisibility("visible");
    await advance(REDIRECT_DELAY_MS);

    expect(getPlayerSessionStatusMock).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).toHaveBeenCalled();
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
      resolveStatus({ success: true, isActive: false });
      await Promise.resolve();
    });
    await advance(REDIRECT_DELAY_MS);

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("OBC-9c: a redirect already scheduled when the component unmounts is cancelled", async () => {
    // The 800 ms gap between the toast and the push is long enough for the
    // route to change underneath it. The closed session ALSO makes the RSC
    // bounce a returning player to the club lobby, so an uncancelled timer
    // would drag them off that page 800 ms after they landed on it.
    const { unmount } = renderBroadcast();

    emitSessionClosed();
    await advance(REDIRECT_DELAY_MS / 2); // scheduled, not yet fired
    expect(pushSpy).not.toHaveBeenCalled();

    unmount();
    await advance(REDIRECT_DELAY_MS * 2);

    expect(pushSpy).not.toHaveBeenCalled();
  });
});
