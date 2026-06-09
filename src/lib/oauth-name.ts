// ============================================================
// OAuth display-name derivation
// ============================================================
// A new Google user has no app display_name — only Google metadata
// (full_name / name / email). We derive a candidate that satisfies the
// displayNameSchema allow-list ([a-zA-Z0-9 ], 3–30 chars) before the
// uniqueness check / rename gate take over.
//
// Pure + deterministic so it is fully unit-testable.
// ============================================================

export interface OAuthMeta {
  full_name?: string | null;
  name?: string | null;
  email?: string | null;
}

/**
 * Coerce an arbitrary string into the displayNameSchema allow-list:
 *   • NFKD decompose + strip combining marks  → "José" → "Jose"
 *   • replace any non [a-zA-Z0-9 ] with a space (drops apostrophes, hyphens, …)
 *   • collapse whitespace, trim
 *   • clamp to 30, trim again (in case the cut landed on a space)
 * May return a string shorter than 3 — the caller decides the fallback.
 */
// Common Latin letters that do NOT NFKD-decompose to ASCII (they carry a stroke
// or are ligatures), so they'd otherwise be stripped entirely. Transliterate
// them first so "S\u00f8der" \u2192 "Soder" rather than "S der".
const TRANSLITERATE: Record<string, string> = {
  ø: "o",
  Ø: "O",
  æ: "ae",
  Æ: "Ae",
  œ: "oe",
  Œ: "Oe",
  ß: "ss",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "Th",
};

export function sanitizeToDisplayName(raw: string): string {
  return raw
    .replace(
      /[\u00f8\u00d8\u00e6\u00c6\u0153\u0152\u00df\u0142\u0141\u0111\u0110\u00f0\u00d0\u00fe\u00de]/g,
      (ch) => TRANSLITERATE[ch] ?? ch
    )
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks (NFKD)
    .replace(/[^a-zA-Z0-9 ]/g, " ") // allow-list
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)
    .trim();
}

/**
 * Best display-name candidate from Google metadata, guaranteed to satisfy the
 * schema (3–30 chars, allow-listed). Tries full_name → name → email local-part,
 * accepting the first that yields ≥ 3 sanitized chars; falls back to "Player"
 * (which, if it collides, is resolved by the uniqueness check + rename gate).
 */
export function deriveDisplayName(meta: OAuthMeta): string {
  const candidates = [meta.full_name, meta.name, meta.email?.split("@")[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sanitized = sanitizeToDisplayName(candidate);
    if (sanitized.length >= 3) return sanitized;
  }
  return "Player";
}
