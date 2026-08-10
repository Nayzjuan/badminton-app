"use client";

// ============================================================
// useTvBoard — data + realtime hook for the TV scoreboard
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { getTvData } from "@/app/actions/tv";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import { trailingDebounce } from "@/lib/trailing-debounce";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";
import type { TvMatch } from "@/app/actions/tv";
import type { MatchStatus } from "@/types/database";

// Typed constants — prevent silent breakage if MatchStatus values change.
const IN_PROGRESS: MatchStatus = "in_progress";
const PENDING: MatchStatus = "pending";

/**
 * Manages the TV board's data freshness via two mechanisms:
 *
 *   1. Realtime subscriptions — fires on match or match_player changes so the
 *      board updates instantly without waiting for the 15 s polling cycle.
 *      These only ever deliver for an AUTHENTICATED viewer (see below).
 *
 *   2. 15 s polling fallback — the ONLY update path for an anonymous viewer,
 *      which is the normal case for this page.
 *
 * The anon caveat is not hypothetical, it is the measured behaviour (verified
 * against prod 2026-08-04): `/tv/[sessionId]` is deliberately public and fetches
 * its initial data with the service-role client, but the CLIENT here holds an
 * anon session. postgres_changes re-checks the table's SELECT policy per row,
 * and both policies route through `session_access_level(session_id)`, whose
 * every branch tests `auth.uid()` and therefore returns NULL for anon — so
 * `matches_select` evaluates its ELSE (false) and `match_players_select` is
 * `TO authenticated` and never applies at all. An anonymous TV client therefore
 * receives no INSERT and no UPDATE on either channel — which is every event the
 * board actually renders from, since a score change, a court call and a new
 * draft are all INSERT/UPDATE. A signed-in viewer (an organizer casting to the
 * TV) gets the full realtime path.
 *
 * One exception, stated for accuracy rather than because it helps: Realtime does
 * not apply RLS to DELETE, so DELETEs still arrive for anon. They carry only the
 * PK (both tables are REPLICA IDENTITY DEFAULT) and this hook ignores the payload
 * and refetches, so a cleared draft can nudge an anon board — incidentally, not
 * dependably. That half was NOT part of the 2026-08-04 prod verification, which
 * covered the INSERT/UPDATE suppression above.
 *
 * That is why the poll is load-bearing rather than a belt-and-braces fallback,
 * and why the board can lag up to 15 s on the shared screen. Making realtime
 * work for anon would require widening an RLS policy to the anon role — a
 * tenancy decision, deliberately not taken here.
 *
 * Returns pre-filtered match lists so TvBoard stays a pure layout component.
 */
export function useTvBoard(
  sessionId: string,
  initialMatches: TvMatch[]
): {
  inProgress: TvMatch[];
  onDeck: TvMatch[];
  lastUpdated: Date | null;
} {
  const [matches, setMatches] = useState<TvMatch[]>(initialMatches);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const refresh = useCallback(async () => {
    const { matches: fresh } = await getTvData(sessionId);
    setMatches(fresh);
    setLastUpdated(new Date());
  }, [sessionId]);

  // Stable ref so subscription callbacks always call the latest refresh closure
  // without needing to re-create the subscription on every render.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    // One debouncer shared by both streams: a match INSERT and its four
    // match_players INSERTs are one logical event and must collapse into a
    // single getTvData() round trip, not five. Inert for anon viewers (who
    // receive no events at all — see the note above); it is the signed-in
    // viewer whose burst this collapses. 200 ms of added latency is invisible
    // on a scoreboard already backed by a 15 s poll.
    const boardDeb = trailingDebounce(() => refreshRef.current(), REALTIME_REFETCH_DEBOUNCE_MS);
    const unsubMatches = subscribeToMatches(supabase, sessionId, boardDeb.run, "tv");
    const unsubPlayers = subscribeToMatchPlayers(supabase, sessionId, boardDeb.run, "tv");
    // Polling fallback — and the anon viewer's ONLY update path.
    const poll = setInterval(() => refreshRef.current(), 15_000);

    return () => {
      boardDeb.cancel();
      unsubMatches();
      unsubPlayers();
      clearInterval(poll);
    };
  }, [supabase, sessionId]);

  const inProgress = useMemo(() => matches.filter((m) => m.status === IN_PROGRESS), [matches]);
  const onDeck = useMemo(() => matches.filter((m) => m.status === PENDING), [matches]);

  return { inProgress, onDeck, lastUpdated };
}
