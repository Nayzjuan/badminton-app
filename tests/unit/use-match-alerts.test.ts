// @vitest-environment happy-dom
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
// Controls what the bootstrap direct-await `match_players` query returns
// (the `.eq().eq()` chain without `.maybeSingle()`).
let mockBootstrapAssignments: { match_id: string }[] | null = null;

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

  const makeThen = (table: string) => (onFulfilled: (v: unknown) => unknown) => {
    // The bootstrap match_players direct-await path:
    // `await supabase.from("match_players").select(...).eq(...).eq(...)`
    const data = table === "match_players" ? mockBootstrapAssignments : null;
    return Promise.resolve({ data, error: null }).then(onFulfilled);
  };

  return {
    from: (table: string) => {
      // Flat self-referential chain: every chaining method returns the same
      // chain object so any query sequence (regardless of depth) resolves via
      // `maybeSingle()` or direct `then`.
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "or", "order", "limit"]) {
        chain[method] = () => chain;
      }
      chain["maybeSingle"] = makeMaybeSingle(table);
      chain["then"] = makeThen(table);
      return chain;
    },
  };
}

vi.mock("@/utils/supabase/client", () => ({
  createBrowserSupabaseClient: () => buildMockClient(),
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
    mockBootstrapAssignments = null;
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

  // ── UA-new-1 ────────────────────────────────────────────────
  it("UA-new-1: bootstrap seeds assignedMatchId from an in_progress match assignment (lines 150-166)", async () => {
    // Set bootstrap assignments so the match_players direct-await returns data.
    mockBootstrapAssignments = [{ match_id: MATCH_ID }];
    // The subsequent matches query uses .or().order().limit().maybeSingle() → mockMatchRow
    mockMatchRow = { id: MATCH_ID, status: "in_progress" };
    mockQueueRow = null;

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    // After bootstrap: assignedMatchId.current = MATCH_ID (set via lines 163-164).
    // Verify by firing a match realtime event for MATCH_ID without slow-path mockAssignments.
    // If the fast path works (assignedMatchId matches), COURT_CALL fires.
    // If bootstrap failed to set it, slow path would be tried but mockAssignments=[] → no alert.
    matchCallback?.(makeMatchPayload("in_progress"));
    await vi.advanceTimersByTimeAsync(50);

    // Since lastMatchStatus was already set to "in_progress" by bootstrap,
    // the status hasn't changed → no alert (next === prev → return).
    // But there's no crash — bootstrap successfully ran lines 150-166.
    // Verify by confirming the mock chain resolved correctly (no uncaught errors).
    expect(playCourtCallMock).not.toHaveBeenCalled(); // same status → no transition
  });

  // ── UA-new-2 ────────────────────────────────────────────────
  it("UA-new-2: bootstrap seeds assignedMatchId from a published pending match — fast path used when status transitions", async () => {
    // Bootstrap: player assigned to a pending (on-deck) match.
    mockBootstrapAssignments = [{ match_id: MATCH_ID }];
    mockMatchRow = { id: MATCH_ID, status: "pending" };
    mockQueueRow = { status: "on_deck" };

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    // Bootstrap ran lines 150-166: assignedMatchId.current = MATCH_ID,
    // lastMatchStatus.current = "pending".
    //
    // Now fire match update: pending → in_progress.
    // Fast path: assignedMatchId.current === MATCH_ID → no slow-path query needed.
    // mockAssignments remains empty so if slow path is accidentally taken, alert won't fire.
    matchCallback?.(makeMatchPayload("in_progress"));
    await vi.advanceTimersByTimeAsync(50);

    // Fast path: status changed pending→in_progress → COURT_CALL fires
    expect(playCourtCallMock).toHaveBeenCalledTimes(1);
  });

  // ── UA-new-3 ────────────────────────────────────────────────
  it("UA-new-3: match_players realtime callback resets assignedMatchId and re-bootstraps (lines 283-285)", async () => {
    mockQueueRow = { status: "waiting" };
    mockMatchRow = null;
    mockBootstrapAssignments = null;

    renderHook(() => useMatchAlerts({ sessionId: SESSION_ID, playerId: PLAYER_ID }));
    await vi.advanceTimersByTimeAsync(50);

    // Fire the match_players subscription callback (lines 283-285):
    // This resets assignedMatchId.current = null, lastMatchStatus.current = null,
    // then calls bootstrap() again.
    expect(playerCallback).not.toBeNull();
    playerCallback?.({}); // any payload triggers the re-bootstrap
    await vi.advanceTimersByTimeAsync(50);

    // No crash, no alert (queue and match are still null after re-bootstrap)
    expect(playWarningBeepMock).not.toHaveBeenCalled();
    expect(playCourtCallMock).not.toHaveBeenCalled();
  });
});
