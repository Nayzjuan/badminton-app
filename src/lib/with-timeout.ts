// ============================================================
// withTimeout — a hard ceiling on a server action
// ============================================================

/**
 * Races a promise against a timer, resolving `null` if the timer wins.
 *
 * Server actions have no built-in timeout, and a hung one is worse than slow:
 * Next's router action queue is FIFO and only preempts for navigations, so a
 * single stuck action starves `router.refresh()` and every other action from
 * the same tab. A `finally` behind such an await never runs either, which is
 * how a hung probe leaves a flag latched forever.
 *
 * Losing the race ABANDONS the result, it does not cancel the request — only
 * use this where the call is idempotent and the abandoned answer is worthless.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
