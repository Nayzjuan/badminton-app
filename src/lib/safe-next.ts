// ============================================================
// safeNext — open-redirect guard for ?next= destinations
// ============================================================
// Only internal absolute paths are allowed as a post-auth redirect
// target — never a protocol-relative (//evil.com) or external URL.
// Shared by the OAuth actions, the OAuth callback, and the /rename gate.
// ============================================================

/** Returns `next` if it is a safe internal path, else the fallback (default /play). */
export function safeNext(next: string | null | undefined, fallback = "/play"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
