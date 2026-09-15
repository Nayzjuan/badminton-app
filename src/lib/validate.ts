// ============================================================
// validate.ts — Shared input validation helpers
// ============================================================
// Lightweight guards for server-action parameters.
// These run before any database call so malformed IDs return a
// clean error rather than a silent empty result.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true if `s` is a well-formed UUID (v4 format).
 * Accepts the caller as `unknown` so TypeScript narrows the type
 * in the `if (isValidUUID(x))` branch without a cast.
 */
export function isValidUUID(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Club URL slugs: lowercase alphanumerics separated by single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Returns true if `s` is a well-formed club slug.
 * Accepts the caller as `unknown` so TypeScript narrows the type
 * in the `if (isValidSlug(x))` branch without a cast.
 */
export function isValidSlug(s: unknown): s is string {
  return typeof s === "string" && s.length >= 1 && s.length <= 64 && SLUG_RE.test(s);
}
