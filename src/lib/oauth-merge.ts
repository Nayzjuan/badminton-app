// ============================================================
// OAuth identity-collision merge token
// ============================================================
// When linkIdentity fails with identity_already_exists, the guest is
// still signed in and the Google identity belongs to a different user
// (the keeper). We stash the guest id in a signed cookie, send them
// through a fresh Google sign-in (which authenticates as the keeper),
// then merge guest play history onto the keeper without overwriting
// the keeper's display_name.
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";

export const OAUTH_MERGE_COOKIE = "oauth_merge_from";
export const OAUTH_MERGE_MAX_AGE_SEC = 10 * 60;

function mergeSecret(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
}

function sign(body: string): string {
  return createHmac("sha256", mergeSecret()).update(body).digest("hex");
}

/** `userId.expMs.hmac` — expMs is unix-ms so the token is bound in time. */
export function createMergeToken(fromUserId: string, nowMs = Date.now()): string {
  const expMs = nowMs + OAUTH_MERGE_MAX_AGE_SEC * 1000;
  const body = `${fromUserId}.${expMs}`;
  return `${body}.${sign(body)}`;
}

export function readMergeToken(
  token: string | undefined | null,
  nowMs = Date.now()
): string | null {
  if (!token) return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const body = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const sep = body.lastIndexOf(".");
  if (sep <= 0) return null;
  const fromUserId = body.slice(0, sep);
  const expMs = Number(body.slice(sep + 1));
  if (!Number.isFinite(expMs) || expMs < nowMs) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromUserId)) {
    return null;
  }
  if (!mergeSecret()) return null;
  const expected = sign(body);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return fromUserId;
}
