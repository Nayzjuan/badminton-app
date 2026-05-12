// ============================================================
// Unit Tests — useMatchAlerts Hook
// ============================================================
// Tests transition detection and alert firing logic without a
// real Supabase connection or real audio hardware.
//
//   U-7  Bootstrap seeds lastQueueStatus / lastMatchStatus refs
//   U-8  Queue transition waiting → on_deck fires ON_DECK_WARNING
//   U-9  Queue transition on_deck → playing fires COURT_CALL
//   U-10 Match transition pending → in_progress fires COURT_CALL
//   U-11 No duplicate alerts for same state
//   U-12 Drafted transition fires haptic only (no audio)
//
// Strategy: mock Supabase, realtime, audio, and navigator.vibrate.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMatchAlerts } from "@/hooks/use-match-alerts";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-222";
const PLAYER_ID = "player-me";
const MATCH_ID = "match-bbb";

// ── Mock Audio ────────────────────────────────────────────────

const playWarningBeepMock = vi.fn().mockResolvedValue(undefined);
const playCourtCallMock = vi.fn().mockResolvedValue(undefined);
const unlockAudioMock = vi.fn();

vi.mock("@/lib/notifications/audio", () => ({
  playWarningBeep: () => playWarningBeepMock(),
  playCourtCall: () => playCourtCallMock(),
  unlockAudio: () => unlockAudioMock(),
}));

// ── Mock Notifications ────────────────────────────────────────

const sendPlayerNotificationMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/app/actions/notifications", () => ({
  sendPlayerNotification: (playerId: string, type: string) =>
    sendPlayerNotificationMock(playerId, type),
}));

// ── Mock Supabase + Realtime ──────────────────────────────────

let mockQueueRow: { status: string } | null = null;
let mockMatchRow: { id: string; status: string } | null = null;
let mockAssignments: { match_id: string }[] = [];

let queueCallback: ((payload: unknown) => void) | null = null;
let matchCallback: ((payload: unknown) => void) | null = null;
let playerCallback: ((payload: unknown) => void) | null = null;

function buildMockClient() {
  const makeMaybeSingle = (table: string) => async () => {
    if (table === "queue_entries") return { data: mockQueueRow, error: null };
    if (table === "matches") return { data: mockMatchRow, error: null };
    if (table === "match_players") return { data: mockAssignments[0] ?? null, error: null };
    return { data: null, error: null };
  };

  return {
    from: (table: string) => ({
      select: () => {
        const chain2 = {
          eq: () => ({
            eq: () => ({
              in: () => ({
                maybeSingle: makeMaybeSingle(table),
              }),
              maybeSingle: makeMaybeSingle(table),
            }),
            maybeSingle: makeMaybeSingle(table),
          }),
          in: () => ({
            or: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: makeMaybeSingle(table),
                }),
              }),
            }),
          }),
        };
        return chain2;
      },
    }),
  };
}

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => buildMockClient(),
}));

vi.mock("@/lib/realtime", () => ({
  subscribeToQueue: (_client: unknown, _sid: string, cb: (p: unknown) => void) => {
    queueCallback = cb;
    return () => {
      queueCallback = null;
    };
  },
  subscribeToMatches: (_client: unknown, _sid: string, cb: (p: unknown) => void) => {
    matchCallback = cb;
    return () => {
      matchCallback = null;
    };
  },
  subscribeToMatchPlayers: (_client: unknown, _sid: string, cb: (p: unknown) => void) => {
    playerCallback = cb;
    return () => {
      playerCallback = null;
    };
  },
}));

// ── Tests ─────────────────────────────────────────────────────

describe("useMatchAlerts — Unit Suite", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockQueueRow = null;
    mockMatchRow = null;
    mockAssignments = [];
    queueCallback = null;
    matchCallback = null;
    playerCallback = null;
    playWarningBeepMock.mockClear();
    playCourtCallMock.mockClear();
    sendPlayerNotificationMock.mockClear();

    // Mock navigator.vibrate
    Object.defineProperty(globalThis, "navigator", {
      value: { vibrate: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeQueuePayload(
    status: string
  ): RealtimePostgresChangesPayload<Record<string, unknown>> {
    return {
      new: { player_id: PLAYER_ID, session_id: SESSION_ID, status },
      old: {},
      eventType: "UPDATE",
      schema: "public",
      table: "queue_entries",
      commit_timestamp: new Date().toISOString(),
      errors: [],
    } as RealtimePostgresChangesPayload<Record<string, unknown>>;
  }

  function makeMatchPayload(
    status: string
  ): RealtimePostgresChangesPayload<Record<string, unknown>> {
    return {
      new: { id: MATCH_ID, session_id: SESSION_ID, status },
      old: {},
      eventType: "UPDATE",
      schema: "public",
      table: "matches",
      commit_timestamp: new Date().toISOString(),
      errors: [],
    } as RealtimePostgresChangesPayload<Record<string, unknown>>;
  }

  // ── U-7 ────────────────────────────────────────────────────
  it("U-7: bootstrap seeds refs from current DB state", async () => {
    mockQueueRow = { status: "on_deck" };
    mockMatchRow = { id: MATCH_ID, status: "pending" };

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    // No alert should fire during bootstrap — only transitions do.
    expect(playWarningBeepMock).not.toHaveBeenCalled();
    expect(playCourtCallMock).not.toHaveBeenCalled();
  });

  // ── U-8 ────────────────────────────────────────────────────
  it("U-8: waiting → on_deck fires ON_DECK_WARNING", async () => {
    mockQueueRow = { status: "waiting" };
    mockMatchRow = null;

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    queueCallback?.(makeQueuePayload("on_deck"));
    await vi.advanceTimersByTimeAsync(50);

    expect(playWarningBeepMock).toHaveBeenCalledTimes(1);
    expect(sendPlayerNotificationMock).toHaveBeenCalledWith(PLAYER_ID, "ON_DECK_WARNING");
    expect(playCourtCallMock).not.toHaveBeenCalled();
  });

  // ── U-9 ────────────────────────────────────────────────────
  it("U-9: on_deck → playing fires COURT_CALL", async () => {
    mockQueueRow = { status: "on_deck" };
    mockMatchRow = null;

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    queueCallback?.(makeQueuePayload("playing"));
    await vi.advanceTimersByTimeAsync(50);

    expect(playCourtCallMock).toHaveBeenCalledTimes(1);
    expect(sendPlayerNotificationMock).toHaveBeenCalledWith(PLAYER_ID, "COURT_CALL");
    expect(playWarningBeepMock).not.toHaveBeenCalled();
  });

  // ── U-10 ───────────────────────────────────────────────────
  it("U-10: match pending → in_progress fires COURT_CALL", async () => {
    mockQueueRow = { status: "playing" };
    mockMatchRow = { id: MATCH_ID, status: "pending" };
    mockAssignments = [{ match_id: MATCH_ID }];

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    matchCallback?.(makeMatchPayload("in_progress"));
    await vi.advanceTimersByTimeAsync(50);

    expect(playCourtCallMock).toHaveBeenCalledTimes(1);
    expect(sendPlayerNotificationMock).toHaveBeenCalledWith(PLAYER_ID, "COURT_CALL");
  });

  // ── U-11 ───────────────────────────────────────────────────
  it("U-11: no duplicate alerts for same state", async () => {
    mockQueueRow = { status: "waiting" };
    mockMatchRow = null;

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    // First transition fires alert
    queueCallback?.(makeQueuePayload("on_deck"));
    // Second transition to same state is suppressed
    queueCallback?.(makeQueuePayload("on_deck"));
    await vi.advanceTimersByTimeAsync(50);

    expect(playWarningBeepMock).toHaveBeenCalledTimes(1);
  });

  // ── U-12 ───────────────────────────────────────────────────
  it("U-12: drafted transition fires haptic only (no audio)", async () => {
    mockQueueRow = { status: "waiting" };
    mockMatchRow = null;

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    queueCallback?.(makeQueuePayload("drafted"));
    await vi.advanceTimersByTimeAsync(50);

    expect((globalThis.navigator as Navigator).vibrate).toHaveBeenCalledWith(80);
    expect(playWarningBeepMock).not.toHaveBeenCalled();
    expect(playCourtCallMock).not.toHaveBeenCalled();
    expect(sendPlayerNotificationMock).not.toHaveBeenCalled();
  });
});
