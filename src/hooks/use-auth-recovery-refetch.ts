"use client";

// ============================================================
// useAuthRecoveryRefetch — re-fetch data when auth comes back
// ============================================================
// A client whose auth session dies mid-session (refresh-token rotation race,
// network blip) silently degrades to `anon`: REST fetches return empty under
// club-scoped RLS and already-joined realtime channels stop delivering, so
// the UI would sit stale until something refetches. The data hooks hold their
// stale state for that window (see hasAuthSession in utils/supabase/client);
// this hook closes the loop by refetching the moment a session is back.
//
// TOKEN_REFRESHED also fires on routine proactive refreshes, and SIGNED_IN
// can re-fire on tab focus — the extra refetches are cheap (every fetcher is
// seq-guarded) and guarantee the UI reconverges after any auth transition
// without having to track a separate "degraded" flag.
//
// Ref-based callback pattern (same as the realtime hooks): the auth listener
// is registered once per client; the ref keeps the callback current without
// resubscribing.

import { useEffect, useRef } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export function useAuthRecoveryRefetch(
  supabase: SupabaseClient<Database>,
  refetch: () => void | Promise<void>
): void {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") {
        void refetchRef.current();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);
}
