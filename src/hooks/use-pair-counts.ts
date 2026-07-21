"use client";

// ============================================================
// usePairCounts — session pair counts for the repeat-pairing warning
// ============================================================
// Deliberately does NOT open a realtime channel. useOrganizerMatches
// already subscribes to BOTH `matches` and `match_players` for this
// session; it exposes a monotonic `matchRevision` that ticks on every
// such event (and immediately after each match mutation). Passing that
// revision in as a dep is the whole refresh mechanism — an eighth
// channel would duplicate WAL traffic for zero extra information.
//
// Failure is silent by design: the repeat warning is ADVISORY. If the
// fetch fails we keep the previous counts (or none) and simply render
// no warning — it must never block or degrade manual match creation.
// ============================================================

import { useEffect, useState } from "react";
import { getSessionPairCounts } from "@/app/actions/repeat-pairing";
import type { PairCounts } from "@/lib/repeat-pairing";

/**
 * Fetches the session's same-team + cross-net pair counts, re-fetching
 * whenever `revision` ticks.
 *
 * Returns null until the first successful load. Callers treat null as
 * "no data yet" → no warnings, no markers.
 */
export function usePairCounts(sessionId: string, revision: number): PairCounts | null {
  const [counts, setCounts] = useState<PairCounts | null>(null);

  useEffect(() => {
    let cancelled = false;

    getSessionPairCounts(sessionId)
      .then((result) => {
        if (cancelled || !result.success) return;
        setCounts({
          partnerships: new Map(result.data.partnerships),
          opponents: new Map(result.data.opponents),
        });
      })
      .catch((err: unknown) => {
        // Advisory feature — log and stay silent rather than surface an error.
        console.error("[usePairCounts] getSessionPairCounts failed:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  return counts;
}
