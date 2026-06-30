// ============================================================
// Club-scoped route path builders — single source of truth
// ============================================================
// Every club route lives under /c/[clubSlug]/... (routing decision locked,
// MULTI_TENANT_PLAN.md §3). These pure builders are the ONLY place that
// interpolates a slug into a path, so the ~25 client navigation sites that
// move under /c/[clubSlug] in Phase 2 cannot drift or typo the prefix.
//
// Pure + dependency-free → unit-testable and safe to import anywhere
// (server components, client components, hooks, server actions).
// ============================================================

/** Club lobby — /c/[slug] */
export function clubBase(slug: string): string {
  return `/c/${slug}`;
}

/** Player dashboard — /c/[slug]/play[/sessionId] */
export function clubPlay(slug: string, sessionId?: string): string {
  return sessionId ? `/c/${slug}/play/${sessionId}` : `/c/${slug}/play`;
}

/** Organizer dashboard / entry — /c/[slug]/organizer[/sessionId] */
export function clubOrganizer(slug: string, sessionId?: string): string {
  return sessionId ? `/c/${slug}/organizer/${sessionId}` : `/c/${slug}/organizer`;
}

/** Club admin panel — /c/[slug]/admin */
export function clubAdmin(slug: string): string {
  return `/c/${slug}/admin`;
}

/** TV scoreboard — /c/[slug]/tv/[sessionId] */
export function clubTv(slug: string, sessionId: string): string {
  return `/c/${slug}/tv/${sessionId}`;
}

/** Session Wrapped — /c/[slug]/wrapped/[sessionId]/[playerId] */
export function clubWrapped(slug: string, sessionId: string, playerId: string): string {
  return `/c/${slug}/wrapped/${sessionId}/${playerId}`;
}

/** Leaderboard — /c/[slug]/leaderboard[/sessionId] */
export function clubLeaderboard(slug: string, sessionId?: string): string {
  return sessionId ? `/c/${slug}/leaderboard/${sessionId}` : `/c/${slug}/leaderboard`;
}

/** QR / passcode join entry — /c/[slug]/join[?session=sessionId] */
export function clubJoin(slug: string, sessionId?: string): string {
  return sessionId ? `/c/${slug}/join?session=${encodeURIComponent(sessionId)}` : `/c/${slug}/join`;
}
