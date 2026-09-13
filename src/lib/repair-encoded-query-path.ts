// ============================================================
// Repair join URLs that in-app browsers encoded into the path
// ============================================================
// Chat apps and in-app browsers (Reclub, Facebook IAB, some Android
// WebViews) wrap or share `https://host/c/slug/join?session=<uuid>` and
// turn the `?` into `%3F`. Next then looks for a path that does not
// exist and serves the branded 404. The same link pasted into Safari
// keeps `?` as a query delimiter and works.
//
// Pure: takes a pathname, returns a repaired path or null (leave alone).
// ============================================================

import { isValidUUID } from "@/lib/validate";

function fullyDecode(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

/**
 * If `pathname` is a known join route whose query string was encoded into
 * the path, return the canonical path-based join URL. Otherwise null.
 */
export function repairEncodedQueryPath(pathname: string): string | null {
  const decoded = fullyDecode(pathname);
  const q = decoded.indexOf("?");
  if (q === -1) return null;

  const path = decoded.slice(0, q).replace(/\/$/, "") || "/";
  const params = new URLSearchParams(decoded.slice(q + 1));
  const session = params.get("session");

  const clubJoin = path.match(/^\/c\/([^/]+)\/join$/);
  if (clubJoin) {
    return session && isValidUUID(session)
      ? `/c/${clubJoin[1]}/join/${session}`
      : `/c/${clubJoin[1]}/join`;
  }

  const clubJoinId = path.match(/^\/c\/([^/]+)\/join\/([^/]+)$/);
  if (clubJoinId && isValidUUID(clubJoinId[2])) {
    return `/c/${clubJoinId[1]}/join/${clubJoinId[2]}`;
  }

  if (path === "/play/join") {
    return session && isValidUUID(session) ? `/j/${session}` : "/play";
  }

  const short = path.match(/^\/j\/([^/]+)$/);
  if (short && isValidUUID(short[1])) {
    return `/j/${short[1]}`;
  }

  return null;
}

/**
 * Canonical join URL for a request that still has `?session=` (or any
 * leftover search) on a join route. next.config `redirects()` always
 * forwards the original query, so the 308 must happen here — otherwise
 * `/play/join?session=<id>` becomes `/j/<id>?session=<id>` and a wrapper
 * that encodes `?` 404s `/j/<id>%3Fsession=`.
 *
 * Returns a path with no query, or null (leave the request alone).
 */
export function resolveJoinRedirect(pathname: string, search = ""): string | null {
  const encoded = repairEncodedQueryPath(pathname);
  if (encoded) return encoded;

  const path = pathname.replace(/\/$/, "") || "/";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const session = params.get("session");
  const hasSearch = params.toString() !== "";

  if (path === "/play/join") {
    return session && isValidUUID(session) ? `/j/${session}` : null;
  }

  const playId = path.match(/^\/play\/join\/([^/]+)$/);
  if (playId && isValidUUID(playId[1])) return `/j/${playId[1]}`;

  const clubBare = path.match(/^\/c\/([^/]+)\/join$/);
  if (clubBare) {
    return session && isValidUUID(session) ? `/c/${clubBare[1]}/join/${session}` : null;
  }

  const clubId = path.match(/^\/c\/([^/]+)\/join\/([^/]+)$/);
  if (clubId && isValidUUID(clubId[2]) && hasSearch) {
    return `/c/${clubId[1]}/join/${clubId[2]}`;
  }

  const short = path.match(/^\/j\/([^/]+)$/);
  if (short && isValidUUID(short[1]) && hasSearch) return `/j/${short[1]}`;

  return null;
}
