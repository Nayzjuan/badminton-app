// ============================================================
// runCourtsideAction — bound wait on a courtside mutation
// ============================================================
// Server actions have no client timeout. A hung POST leaves Adding… /
// Saving… latched and, because Next's action queue is FIFO, starves
// later actions from the same tab. This helper abandons the *result*
// after COURTSIDE_ACTION_WATCHDOG_MS so chrome can unlock. It does not
// cancel the request. Callers must not auto-retry non-idempotent
// writes (add court, auto-matchmaking flip).

import { withTimeout } from "@/lib/with-timeout";
import { COURTSIDE_ACTION_SLOW_MS, COURTSIDE_ACTION_WATCHDOG_MS } from "@/lib/constants";

export const COURTSIDE_SLOW_COPY = "Still working — slow connection";
export const COURTSIDE_TIMEOUT_COPY =
  "This may have saved. Do not tap again. Refresh if it stays stuck.";
export const COURTSIDE_OFFLINE_COPY = "You're offline.";

export type CourtsideActionResult<T> =
  | { status: "ok"; value: T }
  | { status: "error"; error: string }
  | { status: "timeout" };

/**
 * Wait for `promise` up to `timeoutMs`. `T` must not be `null` — that is
 * how `withTimeout` signals the timer won.
 */
export async function runCourtsideAction<T>(
  promise: Promise<T>,
  options?: {
    timeoutMs?: number;
    onSlow?: () => void;
  }
): Promise<CourtsideActionResult<T>> {
  const timeoutMs = options?.timeoutMs ?? COURTSIDE_ACTION_WATCHDOG_MS;
  const slowMs = Math.min(COURTSIDE_ACTION_SLOW_MS, timeoutMs);
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  if (options?.onSlow) {
    slowTimer = setTimeout(options.onSlow, slowMs);
  }
  try {
    const value = await withTimeout(promise, timeoutMs);
    if (value === null) return { status: "timeout" };
    return { status: "ok", value };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Action failed.";
    return { status: "error", error };
  } finally {
    if (slowTimer !== undefined) clearTimeout(slowTimer);
  }
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
