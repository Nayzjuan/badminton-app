// ============================================================
// safeNext — open-redirect guard for ?next= destinations
// ============================================================
// Only internal absolute paths are allowed as a post-auth redirect
// target — never a protocol-relative (//evil.com) or external URL.
// Shared by the OAuth actions, the OAuth callback, and the /rename gate.
//
// The guard resolves the candidate against a sentinel origin and requires
// the result to STAY on it, rather than testing the string character by
// character. That is not a stylistic preference: the character form shipped
// as `!next.startsWith("/") || next.startsWith("//")` and let `/\evil.com`
// straight through, because the WHATWG URL parser treats a backslash as a
// path separator, so browsers read that as protocol-relative and land on
// https://evil.com/. Any new separator the parser learns to normalise is
// covered here for free; a character blacklist has to be told about it.
// See tests/unit/safe-next.test.ts (Suite SN) for the hostile inputs.
// ============================================================

/**
 * Reserved TLD (RFC 2606) — resolution against it can never reach a real host,
 * and any candidate that escapes it has, by definition, changed origin.
 */
const SENTINEL_ORIGIN = "https://safe-next.invalid";

/** Returns `next` if it is a safe internal path, else the fallback (default /clubs). */
export function safeNext(next: string | null | undefined, fallback = "/clubs"): string {
  // Reject relative ("clubs") and scheme-bearing ("https://…", "javascript:…")
  // candidates up front; only a rooted path is a legal destination here.
  if (!next || !next.startsWith("/")) return fallback;

  try {
    if (new URL(next, SENTINEL_ORIGIN).origin !== SENTINEL_ORIGIN) return fallback;
  } catch {
    return fallback;
  }

  return next;
}
