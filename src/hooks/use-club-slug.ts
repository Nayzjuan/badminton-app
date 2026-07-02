"use client";

// ============================================================
// useClubSlug — read the active club slug from the URL
// ============================================================
// Shared dashboard components (PlayerDashboard, OrganizerDashboard, …) are
// rendered by BOTH the legacy routes (/play, /organizer — no club context) and
// the club-namespaced routes (/c/[clubSlug]/…). Rather than thread a clubSlug
// prop through every component, each nav site reads it from the pathname:
//   - on /c/<slug>/… → returns "<slug>"
//   - on a legacy route → returns null (callers fall back to legacy paths)
//
// Pairs with src/lib/club-paths.ts: `slug ? clubPlay(slug, id) : `/play/${id}``.
// ============================================================

import { usePathname } from "next/navigation";

const CLUB_PATH_RE = /^\/c\/([^/]+)(?:\/|$)/;

/** The active club slug from the current path, or null on a non-club route. */
export function useClubSlug(): string | null {
  const pathname = usePathname();
  const match = pathname?.match(CLUB_PATH_RE);
  return match ? match[1] : null;
}
