"use client";

// ============================================================
// useH2H — head-to-head record for an exact 2v2 pairing
// ============================================================
// Calls getH2HRecord server action on mount and whenever the
// sorted player-ID strings change. Uses JSON.stringify on the
// sorted arrays as the dependency key to avoid reference
// inequality false-positives.
//
// Error handling: any rejection (network, server error) sets
// error=true and loading=false rather than hanging forever.
// ============================================================

import { useEffect, useState } from "react";
import { getH2HRecord } from "@/app/actions/h2h";
import type { H2HRecord } from "@/types/database";

export function useH2H(
  teamAIds: string[],
  teamBIds: string[],
  sessionId: string
): { record: H2HRecord | null; loading: boolean; error: boolean } {
  const [record, setRecord] = useState<H2HRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Stable dep keys — sort so order in the prop doesn't matter
  const keyA = JSON.stringify([...teamAIds].sort());
  const keyB = JSON.stringify([...teamBIds].sort());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    // Sort here — single source of truth for canonical array order.
    // The dep keys (keyA/keyB) are already sorted, so this is O(n log n)
    // only when deps actually change, not on every render.
    const sortedA = [...teamAIds].sort();
    const sortedB = [...teamBIds].sort();

    getH2HRecord(sortedA, sortedB, sessionId)
      .then((result) => {
        if (!cancelled) {
          setRecord(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("[useH2H] getH2HRecord failed:", err);
          setRecord(null);
          setError(true);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyA, keyB, sessionId]);

  return { record, loading, error };
}
