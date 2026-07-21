// ============================================================
// getClientIp — best-effort caller IP for rate limiting
// ============================================================
// Rate-limiting by account alone is defeated by rotating identities
// (signInAnonymously is a live path, and reconnectPlayer runs before the
// caller has any identity at all), so the credential-guessing limiters key on
// IP as well.
//
// On Vercel `x-forwarded-for` is set by the platform proxy from the real
// connecting client rather than passed through from a caller-supplied header,
// so the leftmost hop is not attacker-controlled in this deployment. A missing
// header simply means the IP arm does not bite — the subject arm still applies.
// ============================================================

/** Leftmost `x-forwarded-for` hop, else `x-real-ip`, else null. */
export async function getClientIp(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    return h.get("x-real-ip");
  } catch {
    // headers() throws outside a request scope (some test contexts). Degrade
    // to the subject arm rather than failing the request.
    return null;
  }
}
