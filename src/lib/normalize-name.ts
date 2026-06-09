// ============================================================
// Display-name normalization — single source of truth
// ============================================================
// The duplicate-name rules (R1: no reuse of the duplicated name,
// R2: global uniqueness) compare names by a NORMALIZED key, not the
// raw string. This module defines that key for the JavaScript side.
//
// ⚠ PARITY CONTRACT — DO NOT EDIT WITHOUT CHANGING THE SQL ⚠
// The Postgres UNIQUE index and RPCs must produce byte-identical
// output. The matching SQL expression is:
//
//     lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g')))
//
// (migration 20260608000001_profiles_unique_name_index.sql and the
//  rename_player_identity RPC). Both sides deliberately collapse
//  ASCII space + tab ONLY — NOT the full Unicode/POSIX whitespace
//  class — because JS `\s` and Postgres POSIX `\s` disagree on NBSP
//  and friends, which would open a uniqueness-bypass seam. Keep both
//  pinned to `[ \t]`.
//
// Note: validated display names can only contain `[a-zA-Z0-9 ]`
// (see displayNameSchema), so tabs never actually reach storage —
// the tab in the class is defensive parity, not a live code path.
// ============================================================

/**
 * Canonical normalization key for a display name.
 *
 * Steps (mirrors the SQL index expression exactly):
 *   1. Collapse every run of ASCII space/tab to a single space.
 *   2. Trim leading/trailing spaces.
 *   3. Lower-case.
 *
 * Two names are "the same name" for duplicate-detection purposes iff
 * their normalized keys are strictly equal.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/[ \t]+/g, " ") // 1. collapse ASCII whitespace runs
    .replace(/^ +| +$/g, "") // 2. btrim (spaces only — matches Postgres btrim default)
    .toLowerCase(); // 3. fold case
}

/**
 * True when two raw names collapse to the same normalized key.
 * Used by R1 (candidate vs the duplicated `collided_name`) and as the
 * client-side pre-check for R2 (candidate vs each existing name).
 */
export function namesMatch(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}
