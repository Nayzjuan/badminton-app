/**
 * Debounce gate for the fire-and-forget refresh_alltime_leaderboard() RPC,
 * which rebuilds a materialized view across ALL clubs on every call. Without
 * this, back-to-back match completions (or reconnects) each trigger a full
 * rebuild. Module-level state only debounces within a single warm serverless
 * instance — it's a best-effort reduction in churn, not a hard guarantee.
 */
let lastRefreshAt = 0;

export function shouldRefreshLeaderboard(minIntervalMs = 30_000): boolean {
  const now = Date.now();
  if (now - lastRefreshAt < minIntervalMs) return false;
  lastRefreshAt = now;
  return true;
}
