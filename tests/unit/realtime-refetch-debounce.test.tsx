// @vitest-environment happy-dom
// ============================================================
// Realtime refetch debounce — useOrganizerMatches / useTvBoard / useMatchAlerts
// ============================================================
// One organizer action fans out into many postgres_changes events: committing
// a match is 1 `matches` INSERT + 4 `match_players` INSERTs, a draft-cap
// regeneration is up to ~48 events, and an identity merge repoints every
// match_players row a player has ever had. Every one of those events used to
// drive a full refetch in three hooks that had never been converted to the
// trailingDebounce pattern the rest of the app already uses.
//
// These tests pin BOTH halves of that change:
//
//   • the network half collapses  — N events in a burst → ONE refetch;
//   • the ordering-critical half does NOT — useMatchAlerts' ref resets stay
//     eager, because deferring them silently swallows a COURT_CALL.
//
// RRD-5 is the one that matters. It fails against the obvious-but-wrong
// implementation (wrap the whole match_players callback in the debounce) and
// passes only when the resets run eagerly and just bootstrap() is deferred.
//
// IDs: RRD-1 … RRD-8
// ============================================================

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Court, Database } from "@/types/database";

// ── Realtime capture ──────────────────────────────────────────
// Each subscribeToX records the caller's onChange so tests can drive events
// synchronously, and counts unsub calls so cleanup can be asserted.
// vi.hoisted, because vi.mock factories are lifted above every other statement.
const captured = vi.hoisted(() => ({
  matches: [] as ((payload: unknown) => void)[],
  matchPlayers: [] as ((payload: unknown) => void)[],
  queue: [] as ((payload: unknown) => void)[],
  unsubs: 0,
}));

vi.mock("@/lib/realtime", () => {
  const mk =
    (bucket: ((payload: unknown) => void)[]) =>
    (_c: unknown, _s: string, onChange: (payload: unknown) => void) => {
      bucket.push(onChange);
      return () => {
        captured.unsubs++;
      };
    };
  return {
    subscribeToMatches: mk(captured.matches),
    subscribeToMatchPlayers: mk(captured.matchPlayers),
    subscribeToQueue: mk(captured.queue),
  };
});

// ── Audio capture (useMatchAlerts) ────────────────────────────
const audio = vi.hoisted(() => ({ courtCall: vi.fn(), warningBeep: vi.fn() }));
vi.mock("@/lib/notifications/audio", () => ({
  playCourtCall: audio.courtCall,
  playWarningBeep: audio.warningBeep,
  unlockAudio: vi.fn(),
}));

// ── Supabase stub (useMatchAlerts) ────────────────────────────
// Table-keyed responses; every terminal awaits to the configured value.
// `reads` counts per-table SELECTs so a debounced bootstrap is countable.
const db = vi.hoisted(() => ({
  reads: {} as Record<string, number>,
  queueRow: null as { status: string } | null,
  assignmentRows: [] as { match_id: string }[],
  activeMatchRow: null as { id: string; status: string } | null,
  /** match_id the slow-path confirmation query should report the player in. */
  slowPathMatchId: null as string | null,
}));

vi.mock("@/utils/supabase/client", () => {
  const makeBuilder = (table: string) => {
    const resolve = () => {
      if (table === "queue_entries") return { data: db.queueRow, error: null };
      if (table === "matches") return { data: db.activeMatchRow, error: null };
      return { data: db.assignmentRows, error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "order", "limit"]) b[m] = () => b;
    // match_players.maybeSingle is handleMatchChange's slow-path confirmation;
    // every other table's maybeSingle is a bootstrap read.
    b.maybeSingle = () =>
      Promise.resolve(
        table === "match_players"
          ? { data: db.slowPathMatchId ? { match_id: db.slowPathMatchId } : null }
          : resolve()
      );
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(resolve()).then(res);
    return b;
  };
  return {
    createBrowserSupabaseClient: () => ({
      from: (table: string) => {
        db.reads[table] = (db.reads[table] ?? 0) + 1;
        return makeBuilder(table);
      },
    }),
  };
});

// ── getTvData capture (useTvBoard) ────────────────────────────
const tv = vi.hoisted(() => ({
  getTvData: vi.fn(async () => ({ session: { id: "s1" }, matches: [] })),
}));
vi.mock("@/app/actions/tv", () => ({ getTvData: tv.getTvData }));

// ── useEnrichedMatches stub (useOrganizerMatches) ─────────────
const enriched = vi.hoisted(() => ({ fetchActiveMatches: vi.fn(async () => {}) }));
vi.mock("@/hooks/use-enriched-matches", () => ({
  useEnrichedMatches: () => ({
    activeMatches: [],
    setActiveMatches: vi.fn(),
    // Stable identity across renders — the hook keys its mount effect and its
    // ref-sync effect off this, so a fresh function each render would loop.
    fetchActiveMatches: enriched.fetchActiveMatches,
  }),
}));

// useOrganizerMatches pulls in the whole server-action surface at module load.
// None of it is exercised here; stub it so the client bundle stays importable.
const noop = vi.hoisted(() => async () => ({ success: true }));
vi.mock("@/app/actions/matchmaking", () => ({ callNextMatch: noop }));
vi.mock("@/app/actions/match-lifecycle", () => ({
  endMatchAction: noop,
  cancelMatchAction: noop,
  createManualMatchAction: noop,
}));
vi.mock("@/app/actions/match-drafts", () => ({
  clearOnDeckMatch: noop,
  reorderOnDeckMatches: noop,
  publishMatchAction: noop,
  publishAllDraftMatchesAction: noop,
}));
vi.mock("@/app/actions/swap-player", () => ({
  swapPlayerInMatch: noop,
  swapMatchPlayers: noop,
}));

import { useMatchAlerts } from "@/hooks/use-match-alerts";
import { useTvBoard } from "@/hooks/use-tv-board";
import { useOrganizerMatches } from "@/hooks/use-organizer-matches";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";

/** A minimal postgres_changes payload — only `new` is read by these handlers. */
const evt = (row: Record<string, unknown>) =>
  ({ eventType: "UPDATE", new: row, old: {} }) as unknown as RealtimePostgresChangesPayload<never>;

/** Let queued microtasks (the hooks' awaits) settle without advancing timers. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const tick = async (ms = REALTIME_REFETCH_DEBOUNCE_MS) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

// Module-level so its identity is stable across renders. A fresh object here
// would land in the subscription effect's dep array and tear down + rebuild
// both channels on every render — which is exactly the bug the ref-based
// callback pattern exists to prevent, and it would quietly invalidate these
// assertions by leaving stale debouncers behind.
const stableSupabase = {} as unknown as SupabaseClient<Database>;

/** Renders useOrganizerMatches with throwaway collaborators. */
function renderOrganizerMatches() {
  return renderHook(() => {
    const courtsRef = useRef<Court[]>([]);
    return useOrganizerMatches(
      "s1",
      stableSupabase,
      courtsRef,
      () => {},
      async () => {},
      async () => {}
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  captured.matches.length = 0;
  captured.matchPlayers.length = 0;
  captured.queue.length = 0;
  captured.unsubs = 0;
  for (const k of Object.keys(db.reads)) delete db.reads[k];
  db.queueRow = null;
  db.assignmentRows = [];
  db.activeMatchRow = null;
  db.slowPathMatchId = null;
  audio.courtCall.mockClear();
  audio.warningBeep.mockClear();
  tv.getTvData.mockClear();
  enriched.fetchActiveMatches.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("realtime refetch debounce — Unit Suite", () => {
  // ───────────────────────────────────────────────────────────
  // useOrganizerMatches — the highest-traffic subscriber
  // ───────────────────────────────────────────────────────────
  it("RRD-1: organizer collapses a match + its 4 match_players events into ONE refetch", async () => {
    const { result } = renderOrganizerMatches();
    await flush();
    enriched.fetchActiveMatches.mockClear(); // ignore the mount load
    const revBefore = result.current.matchesRevision;

    // Channel stability (CLAUDE.md guardrail 3.3): the loading-state re-render
    // must not have rebuilt the subscriptions. If it had, the handlers below
    // would belong to an orphaned debouncer that unmount can no longer cancel.
    expect(captured.matches).toHaveLength(1);
    expect(captured.matchPlayers).toHaveLength(1);

    act(() => {
      captured.matches[0](evt({ id: "m1" }));
      for (let i = 0; i < 4; i++) captured.matchPlayers[0](evt({ match_id: "m1" }));
    });

    // Nothing yet — the whole point of a TRAILING debounce.
    expect(enriched.fetchActiveMatches).not.toHaveBeenCalled();

    await tick();

    // Was 5 refetches AND 5 revision bumps (each bump re-runs usePairCounts,
    // so the real cost was ~10 round trips); now exactly one of each.
    expect(enriched.fetchActiveMatches).toHaveBeenCalledTimes(1);
    expect(result.current.matchesRevision).toBe(revBefore + 1);
  });

  it("RRD-2: organizer cancels a pending refetch on unmount", async () => {
    const { unmount } = renderOrganizerMatches();
    await flush();
    enriched.fetchActiveMatches.mockClear();

    act(() => {
      captured.matches[0](evt({ id: "m1" }));
    });
    unmount();
    await tick(REALTIME_REFETCH_DEBOUNCE_MS * 5);

    expect(enriched.fetchActiveMatches).not.toHaveBeenCalled();
    expect(captured.unsubs).toBeGreaterThanOrEqual(2);
  });

  // ───────────────────────────────────────────────────────────
  // useTvBoard
  // ───────────────────────────────────────────────────────────
  it("RRD-3: TV board collapses a 5-event burst into ONE getTvData refetch", async () => {
    renderHook(() => useTvBoard("s1", []));
    await flush();
    tv.getTvData.mockClear();

    act(() => {
      captured.matches[0](evt({ id: "m1" }));
      for (let i = 0; i < 4; i++) captured.matchPlayers[0](evt({ match_id: "m1" }));
    });
    expect(tv.getTvData).not.toHaveBeenCalled();

    await tick();
    expect(tv.getTvData).toHaveBeenCalledTimes(1);
  });

  it("RRD-4: TV board cancels a pending refetch on unmount but keeps the poll contract", async () => {
    const { unmount } = renderHook(() => useTvBoard("s1", []));
    await flush();
    tv.getTvData.mockClear();

    act(() => {
      captured.matches[0](evt({ id: "m1" }));
    });
    unmount();
    // Well past both the debounce window AND a 15 s poll cycle — neither the
    // deferred refetch nor the interval may survive teardown.
    await tick(20_000);

    expect(tv.getTvData).not.toHaveBeenCalled();
    expect(captured.unsubs).toBeGreaterThanOrEqual(2);
  });

  // ───────────────────────────────────────────────────────────
  // useMatchAlerts — the ordering-critical one
  // ───────────────────────────────────────────────────────────
  it("RRD-5: a COURT_CALL still fires when the player is moved to a new match mid-burst", async () => {
    // Bootstrap seeds the refs: player is in M1, which is already in_progress.
    db.queueRow = { status: "playing" };
    db.assignmentRows = [{ match_id: "m1" }];
    db.activeMatchRow = { id: "m1", status: "in_progress" };

    renderHook(() => useMatchAlerts({ sessionId: "s1", playerId: "p1" }));
    await flush();
    audio.courtCall.mockClear();

    // The organizer swaps the player into M2. That arrives as a match_players
    // event, ahead of anything the debounced bootstrap() could re-seed.
    db.slowPathMatchId = "m2"; // the slow-path confirmation now finds them in M2
    act(() => {
      captured.matchPlayers[0](evt({ match_id: "m2", player_id: "p1" }));
    });

    // M2 goes in_progress WHILE the bootstrap debounce is still pending.
    await act(async () => {
      await captured.matches[0](evt({ id: "m2", status: "in_progress" }));
    });

    // The refs were reset EAGERLY, so lastMatchStatus is null rather than the
    // stale "in_progress" carried over from M1 — the `next === prev` early
    // return at use-match-alerts.ts:246 does not fire, and the player is called.
    //
    // Debounce the ref resets alongside bootstrap() and this is 0 calls: the
    // player is never told their court is ready. That is the regression this
    // test exists to catch.
    expect(audio.courtCall).toHaveBeenCalledTimes(1);
  });

  it("RRD-6: useMatchAlerts collapses a match_players burst into ONE bootstrap", async () => {
    db.queueRow = { status: "waiting" };
    renderHook(() => useMatchAlerts({ sessionId: "s1", playerId: "p1" }));
    await flush();

    // bootstrap() reads queue_entries exactly once per run — use it as the counter.
    const afterMount = db.reads["queue_entries"] ?? 0;

    act(() => {
      for (let i = 0; i < 6; i++) captured.matchPlayers[0](evt({ match_id: `m${i}` }));
    });
    expect((db.reads["queue_entries"] ?? 0) - afterMount).toBe(0);

    await tick();

    // Exactly one re-seed for six events (was six).
    expect((db.reads["queue_entries"] ?? 0) - afterMount).toBe(1);
  });

  it("RRD-7: useMatchAlerts re-arms rather than firing mid-burst", async () => {
    db.queueRow = { status: "waiting" };
    renderHook(() => useMatchAlerts({ sessionId: "s1", playerId: "p1" }));
    await flush();
    const afterMount = db.reads["queue_entries"] ?? 0;

    // Events spaced just under the window must not each produce a bootstrap.
    for (let i = 0; i < 4; i++) {
      act(() => {
        captured.matchPlayers[0](evt({ match_id: `m${i}` }));
      });
      await tick(REALTIME_REFETCH_DEBOUNCE_MS - 20);
    }
    expect((db.reads["queue_entries"] ?? 0) - afterMount).toBe(0);

    await tick();
    expect((db.reads["queue_entries"] ?? 0) - afterMount).toBe(1);
  });

  it("RRD-8: useMatchAlerts cancels a pending bootstrap on unmount", async () => {
    db.queueRow = { status: "waiting" };
    const { unmount } = renderHook(() => useMatchAlerts({ sessionId: "s1", playerId: "p1" }));
    await flush();
    const afterMount = db.reads["queue_entries"] ?? 0;

    act(() => {
      captured.matchPlayers[0](evt({ match_id: "m1" }));
    });
    unmount();
    await tick(REALTIME_REFETCH_DEBOUNCE_MS * 5);

    expect((db.reads["queue_entries"] ?? 0) - afterMount).toBe(0);
  });
});
