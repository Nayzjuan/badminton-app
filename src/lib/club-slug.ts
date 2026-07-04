// ============================================================
// Club slug — pure helpers (parity with the SQL CHECK)
// ============================================================
// clubs.slug CHECK (migration 20260630000000_clubs_foundation.sql):
//
//   char_length(slug) BETWEEN 3 AND 50
//   AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
//
// i.e. 3–50 chars, lowercase alphanumeric "words" joined by single
// hyphens — no leading/trailing/double hyphens. Keep this module
// byte-aligned with that constraint so client validation matches the DB.
//
// No reserved-slug denylist is needed: every club route lives under the
// /c/ namespace (/c/[clubSlug]/…), so slugs never collide with top-level
// app routes. The DB UNIQUE(slug) constraint handles global uniqueness.
// ============================================================

export const CLUB_SLUG_MIN = 3;
export const CLUB_SLUG_MAX = 50;

// Mirrors the SQL regex exactly.
const CLUB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a candidate slug from a free-text club name.
 * "Chillax Badminton!" → "chillax-badminton".  Strips accents, lowercases,
 * collapses non-alphanumeric runs to single hyphens, trims hyphens, and caps
 * length. May return "" (e.g. a name with no ASCII-able characters) — callers
 * must validate with isValidClubSlug before use.
 */
export function slugifyClubName(name: string): string {
  return name
    .normalize("NFKD") // decompose accents…
    .replace(/[̀-ͯ]/g, "") // …and drop the combining marks (U+0300–U+036F)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric runs → single hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, CLUB_SLUG_MAX)
    .replace(/-+$/g, ""); // a slice may have left a trailing hyphen
}

/** True when slug satisfies the DB CHECK exactly (length + shape). */
export function isValidClubSlug(slug: string): boolean {
  return slug.length >= CLUB_SLUG_MIN && slug.length <= CLUB_SLUG_MAX && CLUB_SLUG_RE.test(slug);
}
