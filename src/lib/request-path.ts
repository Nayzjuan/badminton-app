// ============================================================
// Request path for post-gate redirects
// ============================================================
// Club layouts only know `clubSlug`, not the session URL the player
// opened. Middleware stamps the path (+ search) on `x-request-path`
// so `enforceRenameGateForUser` can send them back there after
// /rename. safeNext is the open-redirect guard.
// ============================================================

import { safeNext } from "@/lib/safe-next";

export const REQUEST_PATH_HEADER = "x-request-path";

export function requestPathHeaderValue(pathname: string, search = ""): string {
  return `${pathname}${search}`;
}

/**
 * Prefer the stamped request path; fall back when missing, unsafe,
 * or already on /rename (do not loop).
 */
export async function renameNextFromRequest(fallback: string): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    const raw = (await headers()).get(REQUEST_PATH_HEADER);
    if (!raw) return fallback;
    const pathOnly = raw.split("?")[0] ?? "";
    if (pathOnly === "/rename") return fallback;
    return safeNext(raw, fallback);
  } catch {
    return fallback;
  }
}
