"use client";

// ============================================================
// usePlayerMatch Hook — Detects on-deck / active match assignment
// ============================================================
// Watches for matches where this player is assigned (via
// match_players) and the match is pending or in_progress.
// Provides court info and teammate/opponent names for the
// on-deck alert UI.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabaseClient, hasAuthSession } from "@/utils/supabase/client";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import { useAuthRecoveryRefetch } from "@/hooks/use-auth-recovery-refetch";
import { trailingDebounce } from "@/lib/trailing-debounce";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";
import { getUpcomingHeldDraft, type UpcomingHeldDraft } from "@/app/actions/upcoming-match";
import type { Match, Court, Profile, Team } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

interface PlayerMatchInfo {
  match: Match;
  court: Court | null;
  myTeam: Team;
  teammates: Profile[];
  opponents: Profile[];
  /**
   * 1-based position among all pending (on-deck) matches for this session,
   * ordered by sort_order ASC then created_at ASC.
   * - 1  = next match to receive a court (highest priority)
   * - 2+ = waiting behind N-1 other pending matches
   * - null if the match is already in_progress (position is no longer relevant)
   */
  onDeckPosition: number | null;
  /** Total number of pending (on-deck) matches right now (including this one). */
  totalOnDeck: number;
}

interface UsePlayerMatchResult {
  /** The player's current/upcoming match, or null if none. */
  currentMatch: PlayerMatchInfo | null;
  /**
   * Set when the player is the still-playing "pulled body" of a pending
   * held cross-court draft, i.e. they have a match reserved for right after
   * the one they're playing now. null when there's no reservation.
   * The held draft itself is firewalled from the client, so this is resolved
   * via a service-role server action scoped to the caller's own id.
   */
  upcomingHeld: UpcomingHeldDraft | null;
  /** Whether data is loading. */
  loading: boolean;
  /** Manually re-fetch match data (used by useVisibilityRefresh). */
  refresh: () => Promise<void>;
}

export function usePlayerMatch(sessionId: string, playerId: string): UsePlayerMatchResult {
  const [currentMatch, setCurrentMatch] = useState<PlayerMatchInfo | null>(null);
  const [upcomingHeld, setUpcomingHeld] = useState<UpcomingHeldDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // ── Sequence guard ────────────────────────────────────────────
  // fetchMyMatch makes 5–6 sequential DB queries. When two Realtime
  // events fire in rapid succession (e.g., sort_order reorder AND
  // match_players update from a swap), two concurrent calls race.
  // The earlier call can finish AFTER the later one and overwrite
  // the correct fresh state with stale data.
  //
  // Guard: increment on entry, check before every setState. If a
  // newer call has started (seq advanced), silently discard.
  // Mirrors the fetchActiveMatchesSeq pattern in use-organizer-data.ts
  // and the fetchQueueSeq pattern in use-organizer-data.ts.
  const fetchMyMatchSeq = useRef(0);

  const fetchMyMatch = useCallback(async () => {
    const mySeq = ++fetchMyMatchSeq.current;

    // Find match_players rows for this player in this session's active matches.
    // P1-6: Scope by session_id via a join filter so we don't pull stale
    // assignments from historical sessions when a player reconnects.
    const { data: myAssignments, error: assignError } = await supabase
      .from("match_players")
      .select("match_id, team, matches!inner(session_id)")
      .eq("player_id", playerId)
      .eq("matches.session_id", sessionId);

    if (mySeq !== fetchMyMatchSeq.current) return;

    // Errors preserve stale state — this chain runs 5–6 sequential queries on
    // every realtime event, and treating one blip as "no match" is what made
    // the Heads Up takeover vanish (or never appear) mid-transition.
    if (assignError) {
      console.error("[usePlayerMatch] assignments fetch error:", assignError.message);
      return;
    }

    if (!myAssignments || myAssignments.length === 0) {
      // "No assignment" is the normal state for a waiting player — but it is
      // ALSO what an anon-fallback fetch returns, and this page only exists
      // for authenticated players. The worst case is a cold start: the player
      // unlocks their phone BECAUSE the on-deck push fired, the PWA reloads,
      // and the first fetch races auth hydration — committing that emptiness
      // paints "Ready to play?" over a player who is actually on deck. Without
      // auth, hold instead (loading stays as-is → skeleton on a cold start,
      // stale alert mid-session); useAuthRecoveryRefetch refetches on recovery.
      const authed = await hasAuthSession(supabase);
      if (mySeq !== fetchMyMatchSeq.current) return;
      if (!authed) {
        console.warn("[usePlayerMatch] empty assignments without auth — holding state");
        return;
      }
      setCurrentMatch(null);
      setUpcomingHeld(null);
      setLoading(false);
      return;
    }

    const matchIds = myAssignments.map((a) => a.match_id);

    // Find the active match (pending or in_progress) for this session.
    // Draft Mode firewall: pending matches are only visible when published.
    const { data: matches, error: matchesError } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .in("id", matchIds)
      .or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)")
      .order("created_at", { ascending: false })
      .limit(1);

    if (mySeq !== fetchMyMatchSeq.current) return;

    if (matchesError) {
      console.error("[usePlayerMatch] matches fetch error:", matchesError.message);
      return;
    }

    if (!matches || matches.length === 0) {
      // Assignments exist but none of their matches are active — the normal
      // "all my matches completed" state. Same anon-fallback caveat as above.
      const authed = await hasAuthSession(supabase);
      if (mySeq !== fetchMyMatchSeq.current) return;
      if (!authed) {
        console.warn("[usePlayerMatch] no active match without auth — holding state");
        return;
      }
      setCurrentMatch(null);
      setUpcomingHeld(null);
      setLoading(false);
      return;
    }

    const match = matches[0];
    const myAssignment = myAssignments.find((a) => a.match_id === match.id)!;

    // Get court info.
    let court: Court | null = null;
    if (match.court_id) {
      const { data: courtData } = await supabase
        .from("courts")
        .select("*")
        .eq("id", match.court_id)
        .single();
      court = courtData;
    }

    // ── On-deck position ─────────────────────────────────────
    // Count how many pending (on-deck) matches exist in this session,
    // ordered by sort_order ASC then created_at ASC (same order as the
    // organizer's On Deck panel). Position 1 = next to receive a court.
    // Only relevant when match is still pending — once in_progress the
    // player is already on a court so position is moot.
    let onDeckPosition: number | null = null;
    let totalOnDeck = 0;

    if (match.status === "pending") {
      const { data: pendingMatches } = await supabase
        .from("matches")
        .select("id, sort_order, created_at")
        .eq("session_id", sessionId)
        .eq("status", "pending")
        .eq("is_published", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (mySeq !== fetchMyMatchSeq.current) return;

      if (pendingMatches && pendingMatches.length > 0) {
        totalOnDeck = pendingMatches.length;
        const idx = pendingMatches.findIndex((m) => m.id === match.id);
        onDeckPosition = idx >= 0 ? idx + 1 : null;
      }
    }

    // Get all players in this match.
    const { data: allPlayers, error: playersError } = await supabase
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", match.id);

    if (mySeq !== fetchMyMatchSeq.current) return;

    if (playersError || !allPlayers) {
      // Was a wipe (setCurrentMatch(null)) — but a roster we already rendered
      // failing to re-fetch is a blip, not "the match is gone". Preserve.
      console.error("[usePlayerMatch] roster fetch error:", playersError?.message ?? "no data");
      return;
    }

    // Fetch profiles for all players.
    const playerIds = allPlayers.map((p) => p.player_id);
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select(PUBLIC_PROFILE_COLUMNS)
      .in("id", playerIds);

    if (mySeq !== fetchMyMatchSeq.current) return;

    if (profilesError) {
      console.error("[usePlayerMatch] profiles fetch error:", profilesError.message);
      return;
    }

    // Zero profiles for a real roster = anon fallback (profiles_select is
    // authenticated-only) — don't re-render every teammate as missing.
    if (playerIds.length > 0 && (profiles ?? []).length === 0) {
      const authed = await hasAuthSession(supabase);
      if (mySeq !== fetchMyMatchSeq.current) return;
      if (!authed) {
        console.warn("[usePlayerMatch] no profiles without auth — holding state");
        return;
      }
    }

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, { ...p, pin: null }]));

    const teammates: Profile[] = [];
    const opponents: Profile[] = [];

    for (const mp of allPlayers) {
      const profile = profileMap.get(mp.player_id);
      if (!profile || mp.player_id === playerId) continue;
      if (mp.team === myAssignment.team) {
        teammates.push(profile);
      } else {
        opponents.push(profile);
      }
    }

    setCurrentMatch({
      match,
      court,
      myTeam: myAssignment.team as Team,
      teammates,
      opponents,
      onDeckPosition,
      totalOnDeck,
    });
    setLoading(false);

    // ── Upcoming held-draft reservation ──────────────────────
    // Only relevant while actually on court: the held draft that
    // reserves this player is firewalled from the client (it's an
    // unpublished is_held match), so resolve it via a server action
    // scoped to this player's own id. When not in_progress, clear it.
    if (match.status === "in_progress") {
      const res = await getUpcomingHeldDraft(sessionId);
      if (mySeq !== fetchMyMatchSeq.current) return;
      setUpcomingHeld(res.success ? res.upcoming : null);
    } else {
      setUpcomingHeld(null);
    }
  }, [supabase, sessionId, playerId]);

  // Auth recovery → refetch, so the alert reappears (or appears for the first
  // time, on a cold start that raced auth hydration) the moment the session
  // is restored.
  useAuthRecoveryRefetch(supabase, fetchMyMatch);

  // Initial fetch + real-time subscriptions.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMyMatch(); // initial load stays immediate

    // Both streams target the same fetch → one shared trailing debouncer, so an
    // engine burst (matches UPDATE + ~8 match_players rows) collapses into a
    // single fetchMyMatch. The internal fetchSeq guard still drops stale results.
    const matchDeb = trailingDebounce(() => fetchMyMatch(), REALTIME_REFETCH_DEBOUNCE_MS);
    const unsubMatches = subscribeToMatches(supabase, sessionId, matchDeb.run);
    const unsubPlayers = subscribeToMatchPlayers(supabase, sessionId, matchDeb.run);

    return () => {
      matchDeb.cancel();
      unsubMatches();
      unsubPlayers();
    };
  }, [supabase, sessionId, fetchMyMatch]);

  return { currentMatch, upcomingHeld, loading, refresh: fetchMyMatch };
}
