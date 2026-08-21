// @vitest-environment happy-dom
// ============================================================
// Suite OAL — useOrganizerAlerts: the organizer's inbox + centered interrupts
// ============================================================
// PREFIX. `OA-` is already claimed by tests/unit/oauth-actions.test.ts — run
// `rg -n '^//   OA-' tests/` to see them. Two suites sharing a prefix makes a
// red ID ambiguous in CI output, so this file uses `OAL-`.
//
// WHY THIS MODULE IS DANGEROUS
//
// 1. IT IS THE ONLY PLACE THE ORGANIZER LEARNS A PLAYER LEFT. The center card
//    is an interrupt: it is how an organizer finds out mid-session that a body
//    they were about to put on court has checked out, or that a player is
//    disputing a score. A dropped card is not a cosmetic regression — it is a
//    published match with a player who is not in the building.
//
// 2. IT FETCHES ON FOUR INDEPENDENT TRIGGERS. Mount, a 45 s poll, the
//    visibility-recovery hook, and any caller-driven refreshInbox() all call
//    the same server action. On a phone waking from lock, three of those fire
//    within a few hundred milliseconds of each other, so responses arrive OUT
//    OF ORDER as a matter of routine, not as a rare race. `fetchSeq` — the
//    monotonic sequence ref CLAUDE.md mandates — is the only thing standing
//    between that and a stale response overwriting a fresh inbox. OAL-2 is the
//    headline: it resolves an earlier request AFTER a later one and asserts the
//    later one wins, and that the discarded response did not run ANY of its
//    downstream work either (it must not silently mark rows as already-shown,
//    which would suppress a future center card forever).
//
// 3. THE DEDUPE IS A REF, NOT STATE. `shownCenterRef` decides whether a
//    broadcast raises a card. Get it wrong in one direction and the organizer
//    is shown the same card on every reconnect; wrong in the other and the card
//    is never shown at all. Neither is visible from a green build.
//
//   OAL-1   hydrate: the mount fetch is bound to the sessionId handed in, and
//           its rows commit (POSITIVE CONTROL for every negative below)
//   OAL-2   fetchSeq: an earlier request resolving LAST is discarded whole —
//           the later request's rows win AND the stale rows were never marked
//           as already-shown
//   OAL-3   fetchSeq positive control: two NON-overlapping fetches both commit,
//           so the guard is not simply refusing everything
//   OAL-4   (negative) a failed result does not clobber a populated inbox; the
//           next successful one replaces it (positive control, same test)
//   OAL-5   stability: six re-renders with identical props issue exactly ONE
//           fetch — that count IS the "callback is stable" property
//   OAL-6   (edge) a sessionId change issues a second fetch bound to the NEW id
//   OAL-7   poll: the 45 s interval refetches while the document is visible
//   OAL-8   (negative) the poll does not refetch while hidden; it resumes once
//           visible again (positive control, same test)
//   OAL-9   (edge) unmount clears the poll interval — no fetch afterwards
//   OAL-10  visibilitychange refetches (phone-unlock recovery)
//   OAL-11  a row-backed notice upserts into the inbox AND raises the card,
//           with the copy composed from the row
//   OAL-12  (negative) payload.interrupt === false: the row still lands in the
//           inbox, no card is raised
//   OAL-13  (negative) a row already seen at hydrate does not re-interrupt; an
//           unseen row does (positive control, same test)
//   OAL-14  (negative) a row whose status is already "read" does not interrupt;
//           the SAME id unread does (positive control, same test)
//   OAL-15  (edge) a second copy of a known row replaces it, never duplicates,
//           and the inbox stays newest-first
//   OAL-16  ephemeral notice copy per kind, incl. the blank-name fallback, and
//           the card queue is FIFO
//   OAL-17  (negative) an ephemeral notice with interrupt === false raises
//           nothing and touches nothing
//   OAL-18  (edge) the card queue is capped at CENTER_ALERT_CAP and the OLDEST
//           card survives the cap, not the newest
//   OAL-19  dismiss pops the head, marks the backing row read on the server
//           with its exact id, and flips that row only
//   OAL-20  (negative) dismissing a score_correction card does NOT mark it
//           read; the next card, a player_left, does (positive control)
//   OAL-21  (negative) dismissing an ephemeral card calls no server action
//   OAL-22  markRead(id) targets exactly that id and leaves its neighbour alone
//   OAL-23  (negative) markRead does not locally clear a score_correction, but
//           still calls the server (positive control: player_left clears)
//   OAL-25  a pause already past the threshold at hydrate writes ONE reminder,
//           bucket 1, and does NOT interrupt (it is catch-up, not news)
//   OAL-26  (negative) a pause under the threshold, and a player who has
//           resumed, write nothing at all
//   OAL-27  a pause that crosses the threshold on a 15 s tick DOES interrupt —
//           it happened while the organizer was watching
//   OAL-28  (lifecycle) the same bucket still due on later ticks writes exactly
//           once; deepening into bucket 2 writes exactly once more
//   OAL-29  (negative) a closed session writes nothing, and neither does a
//           queue that has not loaded yet
//   OAL-30  (negative, edge) a player who resumes and pauses again does NOT
//           re-arm a bucket already written — the client mirrors the DB unique
//   OAL-24  unreadCount counts a pending correction that is already "read", and
//           stops counting a resolved one
//
// WHAT THIS FILE DOES NOT PROVE
//
//   - REALTIME WIRING. There is none to pin. This hook opens NO Supabase
//     channel: it is fed by the existing `queue_notice` broadcast through its
//     `enqueueNotice` callback (see the module banner — "no 6th table
//     channel"). `rg -n 'channel\(|setAuth|subscribe\(' src/hooks/use-organizer-alerts.ts`
//     returns nothing. Channel-name/setAuth-order/unsubscribe properties belong
//     to the hooks that do open channels and are covered there.
//
//   - WHEN A PAUSE REMINDER IS *DELIVERED*. OAL-25 … OAL-29 pin the write and
//     its interrupt flag; what the organizer then sees arrives through the
//     row → broadcast → enqueueNotice path that OAL-11 … OAL-15 own. Nothing
//     here asserts the two halves meet in production.
//
//   - THE SERVER SIDE of listSessionNotifications / markNotificationRead /
//     recordPauseReminder — the organizer authorization, the partial-unique
//     index and the grants are covered by
//     tests/integration/session-notifications.test.ts (Suite SN) against a
//     real database.
//
//   - THE PURE HELPERS it composes (pause-bucket math, upsert ordering, cap,
//     copy) — tests/unit/organizer-alerts.test.ts and
//     tests/unit/session-notifications.test.ts own those. This file asserts
//     that the hook WIRES them, which is a different claim.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { QueueNoticePayload } from "@/lib/broadcast";
import type { QueueFullWithWaitTime, SessionNotification } from "@/types/database";
import { CENTER_ALERT_CAP } from "@/lib/constants";

// ── Constants ─────────────────────────────────────────────────

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "99999999-9999-4999-8999-999999999999";
const ANA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";

type ListResult = {
  success: boolean;
  error?: string;
  notifications: SessionNotification[];
};

// ── Server-action mocks ───────────────────────────────────────
// The factory bodies only CLOSE OVER the bindings below; every read happens
// when the hook calls the action, long after module initialisation, so the
// vi.mock hoisting does not trip over the temporal dead zone.

const listSpy = vi.fn((sessionId: string): Promise<ListResult> => listImpl(sessionId));
const markReadSpy = vi.fn(
  (_id: string): Promise<{ success: boolean }> => Promise.resolve({ success: true })
);
const recordPauseSpy = vi.fn(
  (
    _sessionId: string,
    _playerId: string,
    _bucket: number,
    _interrupt: boolean
  ): Promise<{ success: boolean }> => Promise.resolve({ success: true })
);

vi.mock("@/app/actions/notifications", () => ({
  listSessionNotifications: (sessionId: string) => listSpy(sessionId),
  markNotificationRead: (id: string) => markReadSpy(id),
  recordPauseReminder: (sessionId: string, playerId: string, bucket: number, interrupt: boolean) =>
    recordPauseSpy(sessionId, playerId, bucket, interrupt),
}));

// useVisibilityRefresh (kept REAL — OAL-10 asserts the hook is actually wired
// to it) pulls useRouter from next/navigation, which has no Vitest resolution.
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

import { useOrganizerAlerts } from "@/hooks/use-organizer-alerts";

// ── List-result plumbing ──────────────────────────────────────

/**
 * Default implementation: resolve immediately with whatever `autoResult`
 * currently holds. The SAME object (and the same `notifications` array) is
 * handed back on every call, so a repeated fetch of unchanged data bails out
 * of React's setState instead of looping — a test that re-renders can then
 * assert a call COUNT without the count being an artefact of its own churn.
 */
let autoResult: ListResult = { success: true, notifications: [] };
let listImpl: (sessionId: string) => Promise<ListResult> = () => Promise.resolve(autoResult);

type Deferred = { promise: Promise<ListResult>; settle: (result: ListResult) => void };

/** Requests parked by `useManualList()`, in the order the hook issued them. */
let parked: Deferred[] = [];

function useManualList(): void {
  listImpl = () => {
    let settle!: (result: ListResult) => void;
    const promise = new Promise<ListResult>((resolve) => {
      settle = resolve;
    });
    parked.push({ promise, settle });
    return promise;
  };
}

/** Let the hook's `.then` chain run to completion inside act(). */
async function settleMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Fixtures ──────────────────────────────────────────────────

function makeNotification(
  id: string,
  over: Partial<SessionNotification> = {}
): SessionNotification {
  return {
    id,
    session_id: SESSION_ID,
    kind: "player_left",
    status: "unread",
    subject_player_id: ANA,
    match_id: null,
    payload: { playerName: "Ana" },
    resolved_by: null,
    resolved_at: null,
    created_at: "2026-08-21T10:00:00.000Z",
    ...over,
  };
}

function makeNotice(over: Partial<QueueNoticePayload> = {}): QueueNoticePayload {
  return {
    kind: "player_left",
    playerId: ANA,
    playerName: "Ana",
    cancelledDraft: false,
    ...over,
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

/** The hook takes a queue only for the pause clock; most tests need no row. */
const NO_QUEUE: never[] = [];

function mount(sessionId: string = SESSION_ID) {
  return renderHook(({ id }: { id: string }) => useOrganizerAlerts(id, NO_QUEUE, false, true), {
    initialProps: { id: sessionId },
  });
}

/**
 * One queue row, shaped for the pause clock. `minutesAgo` is resolved against
 * Date.now() at call time rather than a frozen literal: the hook compares
 * paused_at to its own ticking `nowMs`, so a fixed timestamp would drift into
 * a different bucket as the suite runs.
 */
function pausedRow(
  playerId: string,
  displayName: string,
  minutesAgo: number | null
): QueueFullWithWaitTime {
  return {
    id: `qe-${playerId}`,
    session_id: SESSION_ID,
    player_id: playerId,
    status: "waiting",
    games_played: 0,
    joined_at: "2026-08-21T09:00:00.000Z",
    position: null,
    is_paused: minutesAgo !== null,
    paused_at: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    created_at: "2026-08-21T09:00:00.000Z",
    display_name: displayName,
    skill_level: "intermediate",
    skill_level_int: 2,
    wait_minutes: 0,
    is_bottleneck: false,
    status_priority: 2,
  };
}

/** Mount with a queue, and let the hydrate fetch settle so the pause clock arms. */
async function mountPaused(
  queue: QueueFullWithWaitTime[],
  opts: { isClosed?: boolean; queueReady?: boolean } = {}
) {
  const isClosed = opts.isClosed ?? false;
  const queueReady = opts.queueReady ?? true;
  const rendered = renderHook(
    ({ q }: { q: QueueFullWithWaitTime[] }) =>
      useOrganizerAlerts(SESSION_ID, q, isClosed, queueReady),
    { initialProps: { q: queue } }
  );
  await waitFor(() => expect(listSpy).toHaveBeenCalled());
  await settleMicrotasks();
  return rendered;
}

// ── Lifecycle ─────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // shouldAdvanceTime keeps Date.now() moving so waitFor and the real
  // useVisibilityRefresh throttle behave; the intervals stay under our control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  autoResult = { success: true, notifications: [] };
  listImpl = () => Promise.resolve(autoResult);
  parked = [];
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
});

// ── OAL-1 · OAL-2 · OAL-3 — hydrate and the fetchSeq guard ────

describe("useOrganizerAlerts — hydrate and the fetchSeq race guard", () => {
  it("OAL-1: the mount fetch is bound to the sessionId handed in, and its rows commit", async () => {
    const row = makeNotification("n-1");
    autoResult = { success: true, notifications: [row] };

    const { result } = mount();
    await waitFor(() => expect(result.current.inbox).toHaveLength(1));

    // The ARGUMENT, not the count — OAL-5 owns the call count, and keeping the
    // two claims in separate tests is what lets a mutation point at one of them.
    expect(
      listSpy.mock.calls[0],
      "the inbox fetch was not bound to the session the organizer is looking at — a co-organizer of two clubs would be shown another session's notices"
    ).toEqual([SESSION_ID]);
    expect(
      result.current.inbox[0].id,
      "the fetched rows never reached state, so the organizer's inbox is empty on every page load"
    ).toBe("n-1");
  });

  it("OAL-2: an earlier request resolving LAST is discarded whole — later rows win, and the stale rows are not marked as already-shown", async () => {
    useManualList();
    const staleRow = makeNotification("n-stale");
    const freshRow = makeNotification("n-fresh");

    const { result } = mount();
    act(() => {
      result.current.refreshInbox();
    });
    expect(
      parked,
      "the two fetches this race needs were never issued — the test is not exercising the guard"
    ).toHaveLength(2);

    // Resolve them OUT OF ORDER: request #2 first, then the slow request #1.
    await act(async () => {
      parked[1].settle({ success: true, notifications: [freshRow] });
    });
    await settleMicrotasks();
    await act(async () => {
      parked[0].settle({ success: true, notifications: [staleRow] });
    });
    await settleMicrotasks();

    expect(
      result.current.inbox.map((n) => n.id),
      "a slow earlier fetch overwrote the fresh inbox — the fetchSeq guard is gone, and an organizer who unlocks their phone sees notices from before the lock"
    ).toEqual(["n-fresh"]);

    // The discarded response must not have run ANY of its downstream work.
    // shownCenterRef is the tell: if the stale handler ran past the guard it
    // marked "n-stale" as already-shown, and that row can then never raise a
    // center card again.
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: staleRow }));
    });
    expect(
      result.current.current?.id,
      "the discarded fetch still marked its rows as already-shown — that notice is now permanently suppressed and the organizer will never be interrupted by it"
    ).toBe("n-stale");

    // …and the converse, asserted through the queue DEPTH so this test does not
    // depend on dismiss() (which OAL-19 through OAL-21 own).
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: freshRow }));
    });
    expect(
      result.current.remaining,
      "the WINNING fetch failed to mark its rows as shown — every reconnect would re-interrupt the organizer with notices they have already seen"
    ).toBe(1);
  });

  it("OAL-3: two non-overlapping fetches both commit — the guard refuses stale responses, not all of them", async () => {
    useManualList();
    const first = makeNotification("n-first");
    const second = makeNotification("n-second");

    const { result } = mount();
    await act(async () => {
      parked[0].settle({ success: true, notifications: [first] });
    });
    await settleMicrotasks();
    expect(
      result.current.inbox.map((n) => n.id),
      "the FIRST fetch never committed — the sequence guard is rejecting every response, so the inbox can never hydrate"
    ).toEqual(["n-first"]);

    act(() => {
      result.current.refreshInbox();
    });
    await act(async () => {
      parked[1].settle({ success: true, notifications: [second] });
    });
    await settleMicrotasks();
    expect(
      result.current.inbox.map((n) => n.id),
      "a second, non-overlapping fetch did not commit — refreshInbox is inert after the first hydrate"
    ).toEqual(["n-second"]);
  });

  it("OAL-4 (negative): a failed result leaves a populated inbox alone; the next success replaces it", async () => {
    useManualList();
    const good = makeNotification("n-good");
    const newer = makeNotification("n-newer");

    const { result } = mount();
    await act(async () => {
      parked[0].settle({ success: true, notifications: [good] });
    });
    await settleMicrotasks();

    act(() => {
      result.current.refreshInbox();
    });
    await act(async () => {
      parked[1].settle({ success: false, error: "Not authorized.", notifications: [] });
    });
    await settleMicrotasks();
    expect(
      result.current.inbox.map((n) => n.id),
      "a failed or unauthorized fetch wiped the organizer's inbox — this is the de-authed-client class: RLS returns success-with-0-rows and the UI blanks"
    ).toEqual(["n-good"]);

    // Positive control: the same call path DOES replace on success.
    act(() => {
      result.current.refreshInbox();
    });
    await act(async () => {
      parked[2].settle({ success: true, notifications: [newer] });
    });
    await settleMicrotasks();
    expect(
      result.current.inbox.map((n) => n.id),
      "a successful refresh no longer replaces the inbox — the negative above would then pass for a universally broken fetch"
    ).toEqual(["n-newer"]);
  });
});

// ── OAL-5 · OAL-6 — callback stability and session binding ────

describe("useOrganizerAlerts — fetch stability", () => {
  it("OAL-5: six re-renders with identical props issue exactly ONE fetch", async () => {
    const { result, rerender } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    for (let i = 0; i < 6; i += 1) {
      rerender({ id: SESSION_ID });
    }
    await settleMicrotasks();

    expect(
      listSpy.mock.calls.length,
      "the fetch callback is no longer memoised, so every render re-fires the mount effect — this is the same defect class as a realtime channel torn down and rebuilt on each render, and it hammers the server action once per keystroke elsewhere on the dashboard"
    ).toBe(1);
    expect(
      result.current.inbox,
      "the hook stopped returning an inbox at all — the count above would then be meaningless"
    ).toEqual([]);
  });

  it("OAL-6 (edge): a sessionId change issues a second fetch bound to the NEW id", async () => {
    const { rerender } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    rerender({ id: OTHER_SESSION_ID });
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));

    expect(
      listSpy.mock.calls,
      "switching sessions did not re-bind the fetch — the organizer would keep reading the previous session's notices under the new session's header"
    ).toEqual([[SESSION_ID], [OTHER_SESSION_ID]]);
  });
});

// ── OAL-7 … OAL-10 — poll, visibility, cleanup ────────────────

describe("useOrganizerAlerts — poll, visibility recovery, cleanup", () => {
  it("OAL-7: the 45 s poll refetches while the document is visible", async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(
      listSpy.mock.calls.length,
      "the background poll never fires, so an organizer sitting on the dashboard with the tab open sees no new notices until they navigate"
    ).toBe(2);
  });

  it("OAL-8 (negative): the poll does not refetch while hidden, and resumes once visible", async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000 * 3);
    });
    expect(
      listSpy.mock.calls.length,
      "the poll keeps hitting the server action from a backgrounded tab — on a phone in a pocket that is a request every 45 s per organizer, forever"
    ).toBe(1);

    // Positive control: the interval itself is alive; only the guard held it.
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(
      listSpy.mock.calls.length,
      "the poll never resumed after the tab came back — the negative above would then be satisfied by a poll that is simply dead"
    ).toBe(2);
  });

  it("OAL-9 (edge): unmount clears the poll interval", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000 * 3);
    });

    expect(
      listSpy.mock.calls.length,
      "the poll survived unmount — every organizer-dashboard mount leaks a timer that calls a server action forever and setState on a dead tree"
    ).toBe(1);
  });

  it("OAL-10: a visibilitychange refetches (phone-unlock recovery)", async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settleMicrotasks();

    expect(
      listSpy.mock.calls.length,
      "the hook is not wired to useVisibilityRefresh — a phone waking from lock shows the inbox as it was before the screen went off, for up to 45 s"
    ).toBe(2);
    expect(
      routerRefresh,
      "useVisibilityRefresh itself did not run, so this test proves nothing about the hook's wiring"
    ).toHaveBeenCalled();
  });
});

// ── OAL-11 … OAL-15 — row-backed notices ──────────────────────

describe("useOrganizerAlerts — enqueueNotice with a notification row", () => {
  it("OAL-11: upserts into the inbox AND raises a card with copy composed from the row", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const row = makeNotification("n-out", {
      kind: "player_checked_out",
      payload: { playerName: "Ana", actorName: "Miggy" },
    });
    act(() => {
      result.current.enqueueNotice(makeNotice({ kind: "player_checked_out", notification: row }));
    });

    expect(
      result.current.inbox.map((n) => n.id),
      "a live notice never reached the inbox list — the organizer's badge and history pane stay behind until the next poll"
    ).toEqual(["n-out"]);
    expect(
      result.current.current?.title,
      "the center card is not composed from the row — the organizer is interrupted by a card that does not say who or what"
    ).toBe("Ana was checked out");
    expect(
      result.current.current?.body,
      "the card body dropped the actor, so a co-organizer cannot tell who removed the player"
    ).toBe("Miggy removed them from the queue.");
    expect(
      result.current.remaining,
      "the card queue depth is wrong, so the 'N more' affordance under the card lies"
    ).toBe(1);
  });

  it("OAL-12 (negative): interrupt === false files the row but raises no card", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const quiet = makeNotification("n-quiet");
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: quiet, interrupt: false }));
    });

    expect(
      result.current.current,
      "a notice explicitly flagged non-interrupting still hijacked the screen — this is the flag the ACTING organizer's own client sets to avoid being alerted about the dialog they just confirmed"
    ).toBeNull();
    expect(
      result.current.inbox.map((n) => n.id),
      "suppressing the interrupt also dropped the row from the inbox — the notice is now invisible everywhere"
    ).toEqual(["n-quiet"]);

    // Positive control: the same row without the flag DOES interrupt.
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: quiet }));
    });
    expect(
      result.current.current?.id,
      "no row can raise a card at all, so the negative above is satisfied by a universally broken enqueueNotice"
    ).toBe("n-quiet");
  });

  it("OAL-13 (negative): a row already seen at hydrate does not re-interrupt; an unseen row does", async () => {
    const seen = makeNotification("n-seen");
    autoResult = { success: true, notifications: [seen] };

    const { result } = mount();
    await waitFor(() => expect(result.current.inbox).toHaveLength(1));

    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: seen }));
    });
    expect(
      result.current.current,
      "a row the organizer already had in their inbox raised a fresh interrupt — every reconnect would replay the whole backlog as center cards"
    ).toBeNull();

    // Positive control: a row that was NOT in the hydrate does interrupt.
    const unseen = makeNotification("n-unseen");
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: unseen }));
    });
    expect(
      result.current.current?.id,
      "nothing can interrupt any more — the dedupe is swallowing genuinely new notices and the organizer is never told a player left"
    ).toBe("n-unseen");
  });

  it("OAL-14 (negative): an already-read row does not interrupt; the same id unread does", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    act(() => {
      result.current.enqueueNotice(
        makeNotice({ notification: makeNotification("n-14", { status: "read" }) })
      );
    });
    expect(
      result.current.current,
      "a notice another organizer has already read still interrupted this one — two organizers on one session would each dismiss the other's cards"
    ).toBeNull();

    // Positive control, deliberately the SAME id: this proves the refusal came
    // from the row's status and not from the shown-before dedupe.
    act(() => {
      result.current.enqueueNotice(
        makeNotice({ notification: makeNotification("n-14", { status: "unread" }) })
      );
    });
    expect(
      result.current.current?.id,
      "an unread row cannot interrupt either, so the refusal above was not about status at all"
    ).toBe("n-14");
  });

  it("OAL-15 (edge): a second copy of a known row replaces it and the inbox stays newest-first", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const older = makeNotification("n-older", { created_at: "2026-08-21T09:00:00.000Z" });
    const newer = makeNotification("n-newer", { created_at: "2026-08-21T11:00:00.000Z" });
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: older, interrupt: false }));
      result.current.enqueueNotice(makeNotice({ notification: newer, interrupt: false }));
    });
    expect(
      result.current.inbox.map((n) => n.id),
      "the inbox is not sorted newest-first, so the organizer reads their notices in arrival order rather than event order"
    ).toEqual(["n-newer", "n-older"]);

    const revised = makeNotification("n-older", {
      created_at: "2026-08-21T09:00:00.000Z",
      status: "read",
    });
    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: revised, interrupt: false }));
    });
    expect(
      result.current.inbox.map((n) => n.id),
      "an updated copy of a known row was appended instead of replacing it — the inbox grows a duplicate every time a row's status changes"
    ).toEqual(["n-newer", "n-older"]);
    expect(
      result.current.inbox[1].status,
      "the update did not overwrite the stored row, so a resolved correction keeps rendering as pending"
    ).toBe("read");
  });
});

// ── OAL-16 … OAL-18 — ephemeral notices and the cap ───────────

describe("useOrganizerAlerts — enqueueNotice without a row (ephemeral)", () => {
  it("OAL-16: copy per kind, blank-name fallback, and the card queue is FIFO", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    act(() => {
      result.current.enqueueNotice(makeNotice({ kind: "player_left", playerName: "   " }));
      result.current.enqueueNotice(
        makeNotice({ kind: "player_checked_out", playerId: BEN, playerName: "Ben" })
      );
      result.current.enqueueNotice(
        makeNotice({ kind: "score_correction", playerId: BEN, playerName: "Ben" })
      );
      result.current.enqueueNotice(
        makeNotice({ kind: "player_paused_long", playerId: BEN, playerName: "Ben" })
      );
    });

    const seen: Array<{ title: string; body: string }> = [];
    for (let i = 0; i < 4; i += 1) {
      const card = result.current.current;
      if (card) seen.push({ title: card.title, body: card.body });
      act(() => {
        result.current.dismiss();
      });
    }

    expect(
      seen,
      "the fallback copy for a broadcast that carried no inbox row is wrong, or the cards are not shown in the order the events happened — the organizer reads an interrupt that names the wrong player or the wrong event"
    ).toEqual([
      { title: "A player left the queue", body: "They are no longer waiting to be matched." },
      { title: "Ben was checked out", body: "They are no longer waiting to be matched." },
      {
        title: "Ben requested a score correction",
        body: "Open Edit Match to review their proposed scores.",
      },
      { title: "Ben has been paused", body: "They are no longer waiting to be matched." },
    ]);
    expect(
      result.current.remaining,
      "dismissing every card did not empty the queue — the center overlay would never close"
    ).toBe(0);
  });

  it("OAL-17 (negative): an ephemeral notice with interrupt === false raises nothing", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    act(() => {
      result.current.enqueueNotice(makeNotice({ interrupt: false }));
    });
    expect(
      result.current.remaining,
      "a row-less notice flagged non-interrupting still raised a card — the organizer who just confirmed the checkout dialog is alerted about their own action"
    ).toBe(0);
    expect(
      result.current.inbox,
      "a notice with no inbox row somehow wrote to the inbox — the list would render a row the server never created"
    ).toEqual([]);

    // Positive control: the same payload without the flag does raise a card.
    act(() => {
      result.current.enqueueNotice(makeNotice());
    });
    expect(
      result.current.remaining,
      "no ephemeral notice can raise a card, so the negative above proves nothing"
    ).toBe(1);
  });

  it("OAL-18 (edge): the card queue is capped, and the OLDEST card survives", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const overflow = CENTER_ALERT_CAP + 2;
    act(() => {
      for (let i = 0; i < overflow; i += 1) {
        result.current.enqueueNotice(
          makeNotice({ playerId: `player-${i}`, playerName: `Player ${i}` })
        );
      }
    });

    expect(
      result.current.remaining,
      "the center-card queue is unbounded — a burst of checkouts at session close buries the organizer under cards they must dismiss one by one"
    ).toBe(CENTER_ALERT_CAP);
    expect(
      result.current.current?.title,
      "the cap dropped the OLDEST card instead of the newest, so the first player to leave is the one the organizer never hears about"
    ).toBe("Player 0 left the queue");
  });

  it("OAL-18b (edge): notification-BACKED cards are capped the same way, and the oldest still survives", async () => {
    // enqueueNotice has two arms and they each call capCenterQueue separately.
    // OAL-18 only walks the ephemeral one, so the row-backed cap can be deleted
    // whole and the suite stays green — and the row-backed arm is the one that
    // matters at session close, when a run of server-side events arrives down
    // the queue_notice broadcast in a single burst.
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const overflow = CENTER_ALERT_CAP + 2;
    act(() => {
      for (let i = 0; i < overflow; i += 1) {
        result.current.enqueueNotice(
          makeNotice({
            playerId: `player-${i}`,
            playerName: `Player ${i}`,
            notification: makeNotification(`cap-${i}`, {
              subject_player_id: `player-${i}`,
              payload: { playerName: `Player ${i}` },
            }),
          })
        );
      }
    });

    expect(
      result.current.remaining,
      "the row-backed center-card queue is unbounded — every server-side notice raises a card with no cap, so a session close buries the organizer"
    ).toBe(CENTER_ALERT_CAP);
    expect(
      result.current.current?.id,
      "the row-backed cap dropped the OLDEST card instead of the newest — the first event of the burst is the one the organizer never sees"
    ).toBe("cap-0");
    expect(
      result.current.inbox,
      "capping the CARD queue also dropped rows from the inbox — the cap is a display bound on the interrupt stack, not a reason to lose the record"
    ).toHaveLength(overflow);
  });
});

// ── OAL-19 … OAL-24 — dismiss, markRead, unreadCount ──────────

describe("useOrganizerAlerts — dismiss, markRead, unreadCount", () => {
  it("OAL-19: dismiss pops the head, marks its exact id read, and flips that row only", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    act(() => {
      result.current.enqueueNotice(makeNotice({ notification: makeNotification("n-1") }));
      result.current.enqueueNotice(
        makeNotice({
          playerId: BEN,
          notification: makeNotification("n-2", {
            subject_player_id: BEN,
            created_at: "2026-08-21T09:00:00.000Z",
            payload: { playerName: "Ben" },
          }),
        })
      );
    });
    expect(result.current.remaining, "the two cards this test dismisses were never queued").toBe(2);

    act(() => {
      result.current.dismiss();
    });

    expect(
      markReadSpy.mock.calls,
      "dismiss marked the wrong notification read — an .eq() on the right column with the wrong value still makes exactly one call, so the organizer's OTHER unread notice silently disappears"
    ).toEqual([["n-1"]]);
    expect(
      result.current.inbox.find((n) => n.id === "n-1")?.status,
      "the dismissed row was not marked read locally, so the unread badge stays lit until the next poll and the organizer re-checks an inbox they already cleared"
    ).toBe("read");
    expect(
      result.current.inbox.find((n) => n.id === "n-2")?.status,
      "dismissing one card marked a DIFFERENT row read — notices the organizer never saw are being cleared out from under them"
    ).toBe("unread");
    expect(
      result.current.current?.id,
      "dismiss did not advance to the next queued card — the overlay would either close early or replay the same card"
    ).toBe("n-2");
  });

  it("OAL-20 (negative): dismissing a score_correction does not mark it read; the next card does", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const correction = makeNotification("n-corr", {
      kind: "score_correction",
      match_id: "match-1",
      payload: { playerName: "Ana", proposedScoreA: 21, proposedScoreB: 19 },
    });
    act(() => {
      result.current.enqueueNotice(
        makeNotice({ kind: "score_correction", notification: correction })
      );
      result.current.enqueueNotice(makeNotice({ notification: makeNotification("n-left") }));
    });

    act(() => {
      result.current.dismiss();
    });
    expect(
      markReadSpy,
      "dismissing a score-correction card marked it read — a correction is only closed by resolving it, so this drops a player's disputed score off the organizer's actionable list without anyone deciding it"
    ).not.toHaveBeenCalled();
    expect(
      result.current.inbox.find((n) => n.id === "n-corr")?.status,
      "the correction row was locally downgraded, so the actionable badge clears while the dispute is still open"
    ).toBe("unread");

    // Positive control: the very next dismiss, of a player_left card, DOES mark.
    act(() => {
      result.current.dismiss();
    });
    expect(
      markReadSpy.mock.calls,
      "dismiss never marks anything read, so the negative above is satisfied by a universally broken dismiss"
    ).toEqual([["n-left"]]);
  });

  it("OAL-21 (negative): dismissing an ephemeral card calls no server action", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    act(() => {
      result.current.enqueueNotice(makeNotice());
    });
    expect(
      result.current.remaining,
      "the ephemeral card this test dismisses was never raised"
    ).toBe(1);

    act(() => {
      result.current.dismiss();
    });
    expect(
      markReadSpy,
      "dismiss called markNotificationRead for a card with no backing row — the id is a synthetic 'ephemeral:…' string and the server action would be handed a value that is not a UUID"
    ).not.toHaveBeenCalled();
    expect(
      result.current.remaining,
      "the ephemeral card did not pop, so the overlay cannot be closed"
    ).toBe(0);
  });

  it("OAL-22: markRead targets exactly that id and leaves its neighbour alone", async () => {
    autoResult = {
      success: true,
      notifications: [
        makeNotification("n-a"),
        makeNotification("n-b", {
          subject_player_id: BEN,
          created_at: "2026-08-21T09:00:00.000Z",
          payload: { playerName: "Ben" },
        }),
      ],
    };
    const { result } = mount();
    await waitFor(() => expect(result.current.inbox).toHaveLength(2));

    act(() => {
      result.current.markRead("n-a");
    });

    expect(
      markReadSpy.mock.calls,
      "markRead sent the wrong id to the server — tapping one notice clears another"
    ).toEqual([["n-a"]]);
    expect(
      result.current.inbox.find((n) => n.id === "n-a")?.status,
      "the tapped notice did not clear locally, so it stays bold until the next poll"
    ).toBe("read");
    expect(
      result.current.inbox.find((n) => n.id === "n-b")?.status,
      "marking one notice read cleared a different one — unread notices vanish without being seen"
    ).toBe("unread");
  });

  it("OAL-23 (negative): markRead does not locally clear a score_correction, but still calls the server", async () => {
    autoResult = {
      success: true,
      notifications: [
        makeNotification("n-corr", {
          kind: "score_correction",
          match_id: "match-1",
          payload: { playerName: "Ana" },
        }),
        makeNotification("n-left", {
          created_at: "2026-08-21T09:00:00.000Z",
        }),
      ],
    };
    const { result } = mount();
    await waitFor(() => expect(result.current.inbox).toHaveLength(2));

    act(() => {
      result.current.markRead("n-corr");
    });
    expect(
      result.current.inbox.find((n) => n.id === "n-corr")?.status,
      "marking a score correction read locally downgraded it — a pending dispute drops out of the actionable list before an organizer has ruled on it"
    ).toBe("unread");
    expect(
      markReadSpy.mock.calls,
      "the server was not told at all, so the read-receipt for a correction is lost even though the local row is deliberately untouched"
    ).toEqual([["n-corr"]]);

    // Positive control: a non-correction row DOES flip locally.
    act(() => {
      result.current.markRead("n-left");
    });
    expect(
      result.current.inbox.find((n) => n.id === "n-left")?.status,
      "no row flips locally, so the negative above is satisfied by a markRead that updates nothing"
    ).toBe("read");
  });

  it("OAL-24: unreadCount counts a pending correction that is already read, and drops a resolved one", async () => {
    autoResult = {
      success: true,
      notifications: [
        makeNotification("c-read", {
          kind: "score_correction",
          status: "read",
          payload: { playerName: "Ana" },
        }),
        makeNotification("c-resolved", {
          kind: "score_correction",
          status: "resolved",
          created_at: "2026-08-21T09:59:00.000Z",
          payload: { playerName: "Ana" },
        }),
        makeNotification("l-unread", {
          status: "unread",
          created_at: "2026-08-21T09:58:00.000Z",
        }),
        makeNotification("l-read", {
          status: "read",
          created_at: "2026-08-21T09:57:00.000Z",
        }),
      ],
    };
    const { result } = mount();
    await waitFor(() => expect(result.current.inbox).toHaveLength(4));

    expect(
      result.current.unreadCount,
      "the badge is counting raw status instead of countsAsUnread — an open score dispute that an organizer merely opened stops being counted, and the only prompt to resolve it disappears"
    ).toBe(2);
  });

  it("OAL-24b (edge): an empty inbox reports a zero badge and no current card", async () => {
    const { result } = mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    expect(
      result.current.unreadCount,
      "an empty inbox reports a non-zero badge — the organizer is sent hunting for a notice that does not exist"
    ).toBe(0);
    expect(
      result.current.current,
      "an empty alert queue still yields a card, so the center overlay opens over an empty session"
    ).toBeNull();
    expect(
      recordPauseSpy,
      "a pause reminder was written for a session with an empty queue — nobody is paused"
    ).not.toHaveBeenCalled();
  });
});

// ── OAL-25 … OAL-29 — the pause-reminder write ────────────────
// This is the only path in the hook that writes to the database on its own,
// with no user gesture behind it, and it is the organizer's only prompt that a
// player has been sitting paused. It shipped unreachable: the bookkeeping
// `setSeenPause` ran in the RENDER phase, React discarded that pass and
// re-rendered before commit, and on the second pass every due bucket was
// already marked seen — so the committed `duePauseKey` was always "" and the
// effect returned at its own length check. Nothing errored and nothing was
// slow; the feature simply never fired. These five pin both halves: that a due
// pause DOES write, and that everything which is not a due pause does not.
describe("useOrganizerAlerts — pause reminders", () => {
  it("OAL-25: a pause already past the threshold at hydrate writes ONE reminder, bucket 1, and does not interrupt", async () => {
    await mountPaused([pausedRow(ANA, "Ana", 20)]);

    await waitFor(() =>
      expect(
        recordPauseSpy,
        "a player paused 20 minutes produced no reminder — the organizer is never told, and the player waits until someone happens to look at Match Control"
      ).toHaveBeenCalledTimes(1)
    );
    expect(
      recordPauseSpy.mock.calls[0],
      "the reminder was written with the wrong arguments: it must name THIS session, THIS player and bucket 1 (15–29 min), and must NOT interrupt — it was already due when the organizer opened the page, so it is catch-up, not news"
    ).toEqual([SESSION_ID, ANA, 1, false]);
  });

  it("OAL-26 (negative): a pause under the threshold, and a player who has resumed, write nothing", async () => {
    await mountPaused([pausedRow(ANA, "Ana", 5), pausedRow(BEN, "Ben", null)]);

    // Give the clock a tick to prove the silence is the guard, not latency.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      recordPauseSpy,
      "a 5-minute pause and an un-paused player produced a reminder — the organizer is interrupted about players who are fine, which is how an alert channel gets ignored"
    ).not.toHaveBeenCalled();
  });

  it("OAL-27: a pause that crosses the threshold on a tick DOES interrupt", async () => {
    // 14 minutes at hydrate: under the bucket, so the catch-up arming records
    // nothing. Two ticks later it is past 15 and the reminder is live news.
    const { rerender } = await mountPaused([pausedRow(ANA, "Ana", 14)]);

    expect(
      recordPauseSpy,
      "a 14-minute pause fired before it was due — the threshold is not being applied"
    ).not.toHaveBeenCalled();

    rerender({ q: [pausedRow(ANA, "Ana", 16)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() =>
      expect(
        recordPauseSpy,
        "a pause that crossed the threshold while the page was open produced no reminder"
      ).toHaveBeenCalledTimes(1)
    );
    expect(
      recordPauseSpy.mock.calls[0],
      "a pause that became due WHILE the organizer was watching must interrupt (interrupt=true). Only buckets that were already due at hydrate are suppressed, so treating this one as catch-up silences the live case the feature exists for"
    ).toEqual([SESSION_ID, ANA, 1, true]);
  });

  it("OAL-28 (lifecycle): the same bucket writes exactly once across ticks; deepening to bucket 2 writes exactly once more", async () => {
    const { rerender } = await mountPaused([pausedRow(ANA, "Ana", 20)]);
    await waitFor(() => expect(recordPauseSpy).toHaveBeenCalledTimes(1));

    // Four more ticks with the same bucket still due.
    for (let i = 0; i < 4; i += 1) {
      rerender({ q: [pausedRow(ANA, "Ana", 20 + i)] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
    }

    expect(
      recordPauseSpy,
      "the same pause bucket wrote again on a later tick — every 15 s the organizer gets the same alert, and session_notifications fills with duplicates of one event"
    ).toHaveBeenCalledTimes(1);

    // Past 30 minutes: a NEW bucket, and the escalation the organizer needs.
    rerender({ q: [pausedRow(ANA, "Ana", 31)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() =>
      expect(
        recordPauseSpy,
        "a pause deepening past 30 minutes produced no second reminder — the escalation stops at the first bucket and a player can sit paused indefinitely after one dismissed card"
      ).toHaveBeenCalledTimes(2)
    );
    expect(
      recordPauseSpy.mock.calls[1],
      "the escalation wrote the wrong bucket or suppressed its interrupt — bucket 2 became due while the organizer was watching, so it is news"
    ).toEqual([SESSION_ID, ANA, 2, true]);
  });

  it("OAL-29 (negative): a closed session writes nothing, and neither does a queue that has not loaded", async () => {
    const { unmount } = await mountPaused([pausedRow(ANA, "Ana", 20)], { isClosed: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      recordPauseSpy,
      "a CLOSED session still wrote pause reminders — the organizer is alerted about a session that has already ended"
    ).not.toHaveBeenCalled();
    unmount();

    await mountPaused([pausedRow(BEN, "Ben", 20)], { queueReady: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      recordPauseSpy,
      "a reminder was written before the queue had loaded — an error or auth hold leaves the queue empty or partial, and arming off it invents alerts from a snapshot that is not the session"
    ).not.toHaveBeenCalled();
  });

  it("OAL-30 (negative, edge): a player who resumes and pauses again does not re-write a bucket already sent", async () => {
    const { rerender } = await mountPaused([pausedRow(ANA, "Ana", 20)]);
    await waitFor(() => expect(recordPauseSpy).toHaveBeenCalledTimes(1));

    // Resume: prunePauseSeen drops ana:1, so the bucket becomes "unseen" again
    // and collectDuePauseAlerts will re-emit it the moment she re-pauses.
    rerender({ q: [pausedRow(ANA, "Ana", null)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // Re-paused, past the threshold again — a fresh bucket 1.
    rerender({ q: [pausedRow(ANA, "Ana", 18)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      recordPauseSpy,
      "a second bucket-1 reminder was written for the same player in the same session. session_notifications_pause_bucket_idx is UNIQUE on (session_id, subject_player_id, payload->>'bucket') with no status predicate, so the insert is rejected for the whole life of the session — the write is a guaranteed round-trip to a constraint violation, and knownPauseKeys is the client-side mirror of that index"
    ).toHaveBeenCalledTimes(1);
  });
});
