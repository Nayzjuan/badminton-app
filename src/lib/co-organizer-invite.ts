// ============================================================
// Co-organizer invite token — shape + generator
// ============================================================
// 24 random bytes → 32-char base64url. Distinct from session UUID and
// from the spoken organizer_passcode. URL-safe so /o/[token] does not
// need query strings (in-app browsers encode or strip `?`).

export const CO_ORGANIZER_INVITE_BYTES = 24;
export const CO_ORGANIZER_INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function generateCoOrganizerInviteToken(): string {
  const bytes = new Uint8Array(CO_ORGANIZER_INVITE_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function isCoOrganizerInviteTokenShape(token: string): boolean {
  return CO_ORGANIZER_INVITE_TOKEN_RE.test(token);
}

/** Next may already decode the segment; a lone `%` must not throw URIError. */
export function decodeInviteTokenParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
