// ============================================================
// shouldRefreshLeaderboard — the module-level debounce gate (LR)
// ============================================================
// src/lib/leaderboard-refresh.ts guards a fire-and-forget
// `refresh_alltime_leaderboard()` RPC that rebuilds a materialized view across
// EVERY club, not just the caller's. Two call sites share the one gate —
// endMatchAction (match-lifecycle.ts) and reconnectPlayer (auth.ts) — and both
// fire it without awaiting, so nothing downstream ever observes how often the
// rebuild ran. Recompute the call sites with:
//     rg -n 'shouldRefreshLeaderboard\(' src/
//
// That is what makes nine lines dangerous: this function is the ONLY thing
// standing between "a busy Friday night" and a full cross-club view rebuild
// per match completion. Its failure modes are both silent and opposite.
//
//   THE GATE STOPS CLOSING (the stamp is dropped, or the comparison inverts)
//   and every completion rebuilds. No test fails, no user sees an error; the
//   database just does N times the work, on the RPC the module's own comment
//   singles out as the expensive one.
//
//   THE GATE STOPS OPENING (the window is extended by calls it REFUSED) and
//   the leaderboard goes stale for as long as traffic keeps arriving — the
//   busier the club, the longer it lags, which is the exact inverse of what
//   anyone would want and is invisible until someone compares two screens.
//
// The refused-call case is the off-by-one this file exists for. The source
// stamps AFTER the guard returns:
//
//     if (now - lastRefreshAt < minIntervalMs) return false;
//     lastRefreshAt = now;
//
// Move the assignment one line up and a club completing a match every 20 s
// never refreshes again. LR-6 is the test that catches it.
//
// Because `lastRefreshAt` is MODULE state, every test here takes a freshly
// imported module (vi.resetModules + dynamic import) and drives Date.now()
// with fake timers. LR-1 and LR-9 exist to prove that isolation actually
// works — an order-dependent suite would be a defect introduced by the tests
// rather than found by them.
//
//   LR-1  the first call on a fresh module is allowed (and the fresh-module
//         harness this whole file rests on demonstrably resets the state)
//   LR-2  (negative) an immediate second call is refused
//   LR-3  a call after the window has elapsed is allowed again
//   LR-4  (edge) the boundary: one ms early is refused, EXACTLY the interval
//         is allowed, one ms late is allowed
//   LR-5  a custom minIntervalMs governs the window, at its own boundary
//   LR-6  (negative) a REFUSED call does not restamp the window
//   LR-7  the interval is read per call, not captured when the stamp was set
//   LR-8  (edge) minIntervalMs = 0 disables the debounce entirely
//   LR-9  module state does not leak across vi.resetModules()
//   LR-10 (edge) a clock that moves backwards holds the gate shut until it
//         catches up
//   LR-11 the gate is shared by every importer inside one instance — which is
//         what lets endMatchAction and reconnectPlayer debounce each other
//
// WHAT THIS FILE DOES NOT PROVE
//   - That anything calls the RPC when the gate opens. The `void db.rpc(...)`
//     wiring, and its non-fatal error handling, live in match-lifecycle.ts and
//     auth.ts and are not exercised here.
//   - Cross-instance debouncing. Module state is per warm serverless instance;
//     two concurrent invocations each hold their own `lastRefreshAt` and each
//     refresh. The source says so explicitly ("best-effort reduction in churn,
//     not a hard guarantee") and this suite does not claim otherwise.
//   - Behaviour at wall clocks near the Unix epoch. The `lastRefreshAt = 0`
//     sentinel is a timestamp, not a flag, so a clock inside the first
//     `minIntervalMs` after 1970-01-01T00:00:00Z would refuse the first call.
//     Every test here uses a realistic clock, which is the only case that
//     occurs in production.
//
// IDs: LR
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A realistic wall clock. See WHAT THIS FILE DOES NOT PROVE re: the epoch. */
const BASE = new Date("2026-08-21T10:00:00.000Z").getTime();

/** The module's own default window, restated so the tests read as arithmetic. */
const DEFAULT_WINDOW_MS = 30_000;

type Gate = (minIntervalMs?: number) => boolean;

/**
 * Drop the module registry entry and re-import, so `lastRefreshAt` is back at
 * its initial 0. Without this, the first test to call the gate would stamp it
 * and every later test would inherit that stamp — the suite would pass or fail
 * on file order, which is a defect in the tests, not in the source.
 *
 * The clock is rewound to BASE at the same time, so a second gate inside one
 * test starts where the first did and every at() offset below is measured from
 * the stamp rather than from wherever the previous gate left the clock. Found
 * the hard way: without the rewind, LR-4's "exactly the interval" gate stamped
 * at BASE+29_999 and was really being asked about a 1 ms delta.
 */
async function freshGate(): Promise<Gate> {
  vi.resetModules();
  vi.setSystemTime(BASE);
  const mod = await import("@/lib/leaderboard-refresh");
  return mod.shouldRefreshLeaderboard;
}

/** Move the (fake) wall clock to BASE + offset. */
function at(offsetMs: number): void {
  vi.setSystemTime(BASE + offsetMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The debounce itself ───────────────────────────────────────

describe("shouldRefreshLeaderboard — open, then closed", () => {
  it("LR-1: the first call on a fresh module is allowed", async () => {
    const gate = await freshGate();

    // Doubles as the harness check the rest of the file depends on: if
    // resetModules did not clear `lastRefreshAt`, a fresh module would inherit
    // an earlier test's stamp and this would be false.
    expect(
      gate(),
      "a cold instance refused the very first refresh — either the gate opens on nothing, or the per-test module reset has stopped working and every assertion below is being made against leaked state"
    ).toBe(true);
  });

  it("LR-2 (negative): an immediate second call is refused", async () => {
    const gate = await freshGate();

    expect(gate(), "positive control failed: the first call was not allowed").toBe(true);
    expect(
      gate(),
      "the debounce does nothing — back-to-back match completions each trigger a full cross-club materialized-view rebuild, which is the entire cost this module exists to avoid"
    ).toBe(false);
  });

  it("LR-3: a call after the window has elapsed is allowed again", async () => {
    const gate = await freshGate();

    expect(gate(), "positive control failed: the first call was not allowed").toBe(true);
    at(45_000);
    expect(
      gate(),
      "the window never reopens — the all-time leaderboard freezes at whatever it held when the instance warmed up, and stays wrong for the life of that instance"
    ).toBe(true);
  });
});

// ── The boundary ──────────────────────────────────────────────

describe("shouldRefreshLeaderboard — the window boundary", () => {
  it("LR-4 (edge): one ms early refuses; exactly the interval allows; one ms late allows", async () => {
    // Three independent instances so each assertion is about the boundary and
    // nothing else — sharing one gate would fold LR-6's no-restamp rule into
    // the result and blur what a failure here means.
    const early = await freshGate();
    expect(early(), "positive control failed: the first call was not allowed").toBe(true);
    at(DEFAULT_WINDOW_MS - 1);
    expect(
      early(),
      "a refresh one millisecond inside the window was allowed — the comparison is strict `<`, and loosening it lets a burst slip an extra full rebuild through on every window"
    ).toBe(false);

    const exact = await freshGate();
    expect(exact(), "positive control failed: the first call was not allowed").toBe(true);
    at(DEFAULT_WINDOW_MS);
    expect(
      exact(),
      "the boundary moved to the REFUSING side: `now - lastRefreshAt < minIntervalMs` is false at exactly the interval, so 30_000 ms must be allowed; flipping this to `<=` delays every steady-cadence refresh by a whole extra window"
    ).toBe(true);

    const late = await freshGate();
    expect(late(), "positive control failed: the first call was not allowed").toBe(true);
    at(DEFAULT_WINDOW_MS + 1);
    expect(
      late(),
      "a refresh one millisecond past the window was refused — the gate is closing for longer than the interval it advertises"
    ).toBe(true);
  });

  it("LR-5: a custom minIntervalMs governs the window, at its own boundary", async () => {
    // Two instances, as in LR-4: probing both sides on one gate would fold in
    // LR-6's no-restamp rule and a red here could mean either property.
    const inside = await freshGate();
    expect(inside(1_000), "positive control failed: the first call was not allowed").toBe(true);
    at(999);
    expect(
      inside(1_000),
      "a caller-supplied 1 s window was ignored — the argument is not reaching the comparison, so every call site is silently debounced on the default instead of the interval it asked for"
    ).toBe(false);

    const boundary = await freshGate();
    expect(boundary(1_000), "positive control failed: the first call was not allowed").toBe(true);
    at(1_000);
    expect(
      boundary(1_000),
      "a caller-supplied window did not reopen at its own boundary, so a window shorter than the 30 s default cannot be requested at all"
    ).toBe(true);
  });

  it("LR-8 (edge): minIntervalMs = 0 disables the debounce entirely", async () => {
    const gate = await freshGate();

    expect(
      gate(0),
      "positive control failed: the first call was not allowed even with the debounce disabled"
    ).toBe(true);
    expect(
      gate(0),
      "a zero interval still debounced — `now - lastRefreshAt < 0` is false when the clock has not moved, so 0 has to mean 'never refuse'; a caller that passes 0 to force a rebuild would silently get nothing"
    ).toBe(true);
    expect(
      gate(0),
      "a zero interval refused on the third consecutive call at the same instant"
    ).toBe(true);
  });
});

// ── The off-by-one that ships ─────────────────────────────────

describe("shouldRefreshLeaderboard — refused calls must not extend the window", () => {
  it("LR-6 (negative): a refused call does not restamp lastRefreshAt", async () => {
    const gate = await freshGate();

    expect(gate(), "positive control failed: the first call was not allowed").toBe(true);

    // Three refusals inside the window. Each one must leave the stamp on the
    // ALLOWED call at t0 — if any of them restamps, the deadline walks forward
    // with the traffic.
    for (const offset of [20_000, 25_000, 29_000]) {
      at(offset);
      expect(
        gate(),
        `a call ${offset} ms after the last refresh was allowed, inside a 30 s window — the debounce is not holding`
      ).toBe(false);
    }

    // Deliberately one ms PAST the boundary, not on it: this test is about
    // which call the window is measured from, and sitting exactly on 30_000
    // would also redden for a `<` / `<=` slip that LR-4 already owns.
    at(DEFAULT_WINDOW_MS + 1);
    expect(
      gate(),
      "the window was measured from a REFUSED call rather than from the last allowed refresh — the stamp has moved above the guard, so a club completing a match every 20 s pushes the deadline forward forever and the leaderboard never rebuilds again while play continues"
    ).toBe(true);
  });

  it("LR-7: the interval is read per call, not captured when the stamp was set", async () => {
    // Stamped under the 30 s default, then queried under a 1 s window: the
    // CURRENT call's argument decides.
    const shorter = await freshGate();
    expect(shorter(), "positive control failed: the first call was not allowed").toBe(true);
    at(5_000);
    expect(
      shorter(1_000),
      "a 1 s request was judged against the 30 s interval that happened to be in force when the stamp was written — the interval must be read on the call that is being decided, or a caller can never widen or narrow the window mid-instance"
    ).toBe(true);

    // And the other direction: stamped under 1 s, queried under the default.
    const wider = await freshGate();
    expect(wider(1_000), "positive control failed: the first call was not allowed").toBe(true);
    at(5_000);
    expect(
      wider(),
      "a default-interval request was judged against the 1 s interval used at stamp time, so a call site asking for the expensive-RPC default would be overridden by whichever caller stamped last"
    ).toBe(false);
  });
});

// ── Module state ──────────────────────────────────────────────

describe("shouldRefreshLeaderboard — module-level state", () => {
  it("LR-9: state does not leak across vi.resetModules()", async () => {
    const first = await freshGate();
    expect(first(), "positive control failed: the first call was not allowed").toBe(true);
    expect(first(), "positive control failed: the second call was not refused").toBe(false);

    // Same instant, brand new module: a fresh instance must be open again.
    const second = await freshGate();
    expect(
      second(),
      "a freshly imported module inherited the previous one's stamp — every test in this file would then depend on execution order, and a red here could mean nothing more than that another test ran first"
    ).toBe(true);
  });

  it("LR-11: the gate is shared by every importer inside one instance", async () => {
    vi.resetModules();
    const a = await import("@/lib/leaderboard-refresh");
    const b = await import("@/lib/leaderboard-refresh"); // deliberately NOT reset

    expect(
      a.shouldRefreshLeaderboard(),
      "positive control failed: the first importer's call was not allowed"
    ).toBe(true);
    expect(
      b.shouldRefreshLeaderboard(),
      "a second importer got its own window — endMatchAction and reconnectPlayer import this module separately and MUST debounce each other; per-importer state would mean one full cross-club rebuild per call site rather than one per window"
    ).toBe(false);
  });

  it("LR-10 (edge): a backwards clock holds the gate shut until it catches up", async () => {
    const gate = await freshGate();

    expect(gate(), "positive control failed: the first call was not allowed").toBe(true);

    at(-5_000);
    expect(
      gate(),
      "behaviour under a backwards clock jump changed — `now - lastRefreshAt` goes negative, which is less than any positive interval, so the gate stays shut; this test records that rather than endorsing it, because the alternative (treating a negative delta as 'window elapsed') would let a clock adjustment trigger an unbounded run of rebuilds"
    ).toBe(false);

    at(45_000);
    expect(
      gate(),
      "the gate never recovered after a backwards clock jump — a single NTP correction would freeze the leaderboard for the life of the instance"
    ).toBe(true);
  });
});
