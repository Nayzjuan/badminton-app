// ============================================================
// after-queue.ts — pending work scheduled by the stubbed after()
// ============================================================
// tests/integration/setup.ts stubs Next's `after()` so it RUNS the callback
// (see the long note there — several call sites wrap runEngineForSession, not
// push notifications, so dropping them breaks real assertions).
//
// Real after() work is fire-and-forget: the action returns before it finishes.
// Reproducing that faithfully means the engine can still be writing rows while
// afterEach starts deleting them, which surfaces as FK violations and
// cross-test pollution that move around between runs.
//
// So we keep a handle on every in-flight callback and let the cleanup helper
// drain them first. This module is deliberately standalone — importing
// setup.ts from truncate.ts would re-run its vi.mock registrations.
// ============================================================

const pending = new Set<Promise<unknown>>();

/** Records an in-flight after() callback. Called only by the setup stub. */
export function trackAfterCallback(p: Promise<unknown>): void {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/**
 * Waits for every after() callback scheduled so far to settle.
 *
 * Loops rather than awaiting once: a callback may schedule more after() work
 * (the engine's publish path does), and those would otherwise still be running
 * when the caller proceeds.
 */
export async function flushAfterCallbacks(): Promise<void> {
  // Bounded so a callback that reschedules itself forever cannot hang the run.
  for (let i = 0; i < 20 && pending.size > 0; i++) {
    await Promise.allSettled([...pending]);
  }
}
