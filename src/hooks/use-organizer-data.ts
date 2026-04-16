"use client";

// ============================================================
// useOrganizerData — Single hook for all organizer real-time state
// ============================================================
// Fetches and subscribes to courts, queue (with wait time view),
// active matches (with their players), and profiles. Provides
// everything the three organizer views need in one place.
//
// Subscription stability notes
// ----------------------------
// The subscription useEffect MUST only re-run when `supabase`
// or `sessionId` changes — never on every state update.
//
// The old code had fetchActiveMatches in its dep array, but
// fetchActiveMatches depended on `courts`. So:
//   courts update → fetchActiveMatches new ref → all 4 channels
//   torn down + rebuilt → events missed during that window.
//
// Fix: use a `courtsRef` so fetchActiveMatches doesn't need
// `courts` in its deps, and use stable callback refs so the
// subscription effect is only wired once per sessionId.
//
// Race-condition fix (fetchActiveMatchesSeq)
// -------------------------------------------
// subscribeToMatchPlayers fires for every match_player insert
// (no session_id filter), so 4 concurrent fetchActiveMatches
// calls can race each other. A stale call that finishes last
// will overwrite the correct, more recent state.
// We guard against this with a monotonically-increasing
// sequence number stored in a ref. Each call captures its seq
// on entry; before every setState it checks that no newer call
// has started. Stale results are silently discarded.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import {
  subscribeToCourts,
  subscribeToQueue,
  subscribeToMatches,
  subscribeToMatchPlayers,
  subscribeToProfiles,
} from "@/lib/realtime";
import {
  callNextMatch as callNextMatchAction,
  type MatchmakingResult,
} from "@/app/actions/matchmaking";
import {
  endMatchAction,
  cancelMatchAction,
  createManualMatchAction,
  clearOnDeckMatch as clearOnDeckMatchAction,
} from "@/app/actions/match";
import type {
  Court,
  Match,
  MatchPlayer,
  Profile,
  QueueWithWaitTime,
} from "@/types/database";

/** A match enriched with its player profiles + court info. */
export interface EnrichedMatch extends Match {
  court: Court | null;
  players: (MatchPlayer & { profile: Profile })[];
}

export interface UseOrganizerDataResult {
  courts: Court[];
  queue: QueueWithWaitTime[];
  /** All active matches (pending + in_progress). */
  activeMatches: EnrichedMatch[];
  /** Pending matches — formed but waiting for a court (on-deck). */
  onDeckMatches: EnrichedMatch[];
  /** In-progress matches — assigned to a court, currently playing. */
  inProgressMatches: EnrichedMatch[];
  profiles: Map<string, Profile>;
  loading: boolean;
  // -- Court actions --
  addCourt: (name: string) => Promise<{ error?: string }>;
  updateCourtStatus: (courtId: string, status: Court["status"]) => Promise<{ error?: string }>;
  removeCourt: (courtId: string) => Promise<{ error?: string }>;
  // -- Matchmaking --
  callNextMatch: (courtId: string) => Promise<MatchmakingResult>;
  // -- Match actions --
  createManualMatch: (
    teamA: string[],
    teamB: string[]
  ) => Promise<{ error?: string }>;
  endMatch: (
    matchId: string,
    teamAScore: number,
    teamBScore: number
  ) => Promise<{ error?: string }>;
  cancelMatch: (matchId: string) => Promise<{ error?: string }>;
  clearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
  // -- Queue actions --
  removeFromQueue: (playerId: string) => Promise<{ error?: string }>;
}

export function useOrganizerData(sessionId: string): UseOrganizerDataResult {
  const supabase = useMemo(() => createClient(), []);
  const [courts, setCourts] = useState<Court[]>([]);
  const [queue, setQueue] = useState<QueueWithWaitTime[]>([]);
  const [activeMatches, setActiveMatches] = useState<EnrichedMatch[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [loading, setLoading] = useState(true);

  // ------------------------------------------------------------------
  // Stable ref that always mirrors `courts` state.
  // Used inside fetchActiveMatches so that callback doesn't need
  // `courts` in its useCallback dep array — breaking the cascade that
  // caused subscriptions to tear down on every court update.
  // ------------------------------------------------------------------
  const courtsRef = useRef<Court[]>([]);
  useEffect(() => {
    courtsRef.current = courts;
  }, [courts]);

  // ------------------------------------------------------------------
  // Sequence counter for fetchActiveMatches.
  // Prevents stale concurrent calls from overwriting newer results.
  // Each invocation captures `mySeq = ++counter` on entry and
  // checks `mySeq === counter` before every setState. If a newer
  // call has started since, the current call silently aborts.
  // ------------------------------------------------------------------
  const fetchActiveMatchesSeq = useRef(0);

  // ---- Fetch functions ----

  const fetchCourts = useCallback(async () => {
    const { data, error } = await supabase
      .from("courts")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[useOrganizerData] fetchCourts error:", error);
    }
    if (data) setCourts(data);
  }, [supabase, sessionId]);

  const fetchQueue = useCallback(async () => {
    const { data, error } = await supabase
      .from("v_queue_with_wait_time")
      .select("*")
      .eq("session_id", sessionId)
      // Must match the matchmaking sort so the organizer sees the real queue order.
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });
    if (error) {
      console.error("[useOrganizerData] fetchQueue error:", error);
    }
    if (data) setQueue(data);
  }, [supabase, sessionId]);

  const fetchActiveMatches = useCallback(async () => {
    // Capture this call's sequence number. If a newer call starts
    // before we finish, we will discard our stale results.
    const mySeq = ++fetchActiveMatchesSeq.current;

    const { data: matches, error: matchError } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: true });

    // Abort if superseded.
    if (mySeq !== fetchActiveMatchesSeq.current) return;

    if (matchError) {
      console.error("[useOrganizerData] fetchActiveMatches error:", matchError);
    }

    if (!matches || matches.length === 0) {
      setActiveMatches([]);
      return;
    }

    const matchIds = matches.map((m) => m.id);
    const { data: matchPlayers } = await supabase
      .from("match_players")
      .select("*")
      .in("match_id", matchIds);

    // Abort if superseded.
    if (mySeq !== fetchActiveMatchesSeq.current) return;

    const playerIds = [...new Set((matchPlayers ?? []).map((mp) => mp.player_id))];
    let profileMap = new Map<string, Profile>();
    if (playerIds.length > 0) {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .in("id", playerIds);

      // Abort if superseded.
      if (mySeq !== fetchActiveMatchesSeq.current) return;

      profileMap = new Map((profileData ?? []).map((p) => [p.id, p]));
    }

    setProfiles((prev) => {
      const next = new Map(prev);
      profileMap.forEach((v, k) => next.set(k, v));
      return next;
    });

    // Use the ref instead of the `courts` state value — this removes
    // `courts` from the dependency array and prevents the subscription
    // teardown cascade.
    const enriched: EnrichedMatch[] = matches.map((match) => {
      const court = courtsRef.current.find((c) => c.id === match.court_id) ?? null;
      const players = (matchPlayers ?? [])
        .filter((mp) => mp.match_id === match.id)
        .map((mp) => ({
          ...mp,
          profile: profileMap.get(mp.player_id) ?? {
            id: mp.player_id,
            display_name: "Unknown",
            skill_level: "beginner" as const,
            pin: null,
            created_at: "",
            updated_at: "",
          },
        }));
      return { ...match, court, players };
    });

    setActiveMatches(enriched);
    // NOTE: deps no longer include `courts` — we read from courtsRef instead.
  }, [supabase, sessionId]);

  const fetchQueueProfiles = useCallback(async () => {
    const playerIds = queue.map((q) => q.player_id);
    if (playerIds.length === 0) return;
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .in("id", playerIds);
    if (data) {
      setProfiles((prev) => {
        const next = new Map(prev);
        data.forEach((p) => next.set(p.id, p));
        return next;
      });
    }
  }, [supabase, queue]);

  // ---- Initial load ----

  useEffect(() => {
    async function load() {
      await Promise.all([fetchCourts(), fetchQueue()]);
      setLoading(false);
    }
    load();
  }, [fetchCourts, fetchQueue]);

  useEffect(() => {
    fetchActiveMatches();
  }, [fetchActiveMatches]);

  useEffect(() => {
    fetchQueueProfiles();
  }, [fetchQueueProfiles]);

  // ---- Real-time subscriptions ----
  //
  // We use stable callback refs so the subscription useEffect only
  // runs when `supabase` or `sessionId` changes — never on every
  // state update. Without this, courts changes would cascade into
  // a full teardown/rebuild of all 4 channels.
  //
  const fetchCourtsRef = useRef(fetchCourts);
  const fetchQueueRef = useRef(fetchQueue);
  const fetchActiveMatchesRef = useRef(fetchActiveMatches);
  // Update refs on every render so the latest closures are always used.
  fetchCourtsRef.current = fetchCourts;
  fetchQueueRef.current = fetchQueue;
  fetchActiveMatchesRef.current = fetchActiveMatches;

  useEffect(() => {
    const unsubs = [
      subscribeToCourts(supabase, sessionId, () => fetchCourtsRef.current()),
      subscribeToQueue(supabase, sessionId, () => fetchQueueRef.current()),
      subscribeToMatches(supabase, sessionId, () => fetchActiveMatchesRef.current()),
      subscribeToMatchPlayers(supabase, sessionId, () => fetchActiveMatchesRef.current()),
      // Profile changes (e.g. skill override) → re-fetch queue (view includes
      // skill_level from profiles) and active matches (embedded profiles).
      subscribeToProfiles(supabase, sessionId, () => {
        fetchQueueRef.current();
        fetchActiveMatchesRef.current();
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId]); // Intentionally omit the fetch refs — they are kept current via the ref pattern above.

  // ---- Court actions ----
  // Each mutation explicitly calls fetchCourts() after a successful write
  // so the current client's UI updates immediately without waiting for the
  // Realtime push. The subscription handles live-sync for other clients.

  const addCourt = useCallback(
    async (name: string) => {
      const { error } = await supabase
        .from("courts")
        .insert({ session_id: sessionId, name });
      if (error) return { error: error.message };
      await fetchCourts();
      return {};
    },
    [supabase, sessionId, fetchCourts]
  );

  const updateCourtStatus = useCallback(
    async (courtId: string, status: Court["status"]) => {
      const { error } = await supabase
        .from("courts")
        .update({ status })
        .eq("id", courtId);
      if (error) return { error: error.message };
      await fetchCourts();
      return {};
    },
    [supabase, fetchCourts]
  );

  const removeCourt = useCallback(
    async (courtId: string) => {
      const { error } = await supabase.from("courts").delete().eq("id", courtId);
      if (error) return { error: error.message };
      await fetchCourts();
      return {};
    },
    [supabase, fetchCourts]
  );

  // ---- Matchmaking ----
  //
  // After the server action completes, we explicitly refresh courts and
  // activeMatches BEFORE returning. This guarantees that when the
  // component sets matchmakingCourt to null, activeMatches already
  // contains the new match — preventing the brief flash back to the
  // "Call Next Match" button.

  const callNextMatch = useCallback(
    async (courtId: string): Promise<MatchmakingResult> => {
      const result = await callNextMatchAction(sessionId, courtId);
      await Promise.all([fetchCourts(), fetchActiveMatches()]);
      return result;
    },
    [sessionId, fetchCourts, fetchActiveMatches]
  );

  // ---- Match actions ----

  // P1-2: createManualMatch is now delegated to a server action so all
  // validation and DB writes run server-side. This prevents a disconnected
  // browser from leaving courts stuck in a stale state and adds proper
  // auth + session-ownership checks on the server.
  const createManualMatch = useCallback(
    async (teamA: string[], teamB: string[]) => {
      const result = await createManualMatchAction(sessionId, teamA, teamB);
      if (!result.success) return { error: result.message };
      // Refresh queue (players moved to on_deck) and active matches (new pending match).
      await Promise.all([fetchQueue(), fetchActiveMatches()]);
      return {};
    },
    [sessionId, fetchQueue, fetchActiveMatches]
  );

  const endMatch = useCallback(
    async (matchId: string, teamAScore: number, teamBScore: number) => {
      // Delegated to the server action so it runs with authenticated server
      // credentials and reads games_played directly from queue_entries
      // (players in "playing" status are excluded from v_queue_with_wait_time,
      // so the old client-side queue state lookup always returned 0).
      const result = await endMatchAction(matchId, teamAScore, teamBScore);
      if (!result.success) return { error: result.message };
      // Explicit refresh — removes the completed match and resets court status
      // before realtime has a chance to fire.
      await Promise.all([fetchCourts(), fetchActiveMatches()]);
      return {};
    },
    [fetchCourts, fetchActiveMatches]
  );

  const cancelMatch = useCallback(
    async (matchId: string) => {
      const result = await cancelMatchAction(matchId);
      if (!result.success) return { error: result.message };
      // Explicit refresh — removes the cancelled match immediately.
      await Promise.all([fetchCourts(), fetchActiveMatches()]);
      return {};
    },
    [fetchCourts, fetchActiveMatches]
  );

  const clearOnDeckMatch = useCallback(
    async (matchId: string) => {
      const result = await clearOnDeckMatchAction(matchId);
      if (!result.success) return { error: result.message };
      // Refresh both the match list and the queue so players appear waiting again.
      await Promise.all([fetchQueue(), fetchActiveMatches()]);
      return {};
    },
    [fetchQueue, fetchActiveMatches]
  );

  // ---- Queue actions ----

  const removeFromQueue = useCallback(
    async (playerId: string) => {
      const { error } = await supabase
        .from("queue_entries")
        .update({ status: "left" as const })
        .eq("session_id", sessionId)
        .eq("player_id", playerId);
      if (error) return { error: error.message };
      return {};
    },
    [supabase, sessionId]
  );

  // Derived splits — avoids the dashboard needing to filter itself.
  const onDeckMatches = activeMatches.filter((m) => m.status === "pending");
  const inProgressMatches = activeMatches.filter((m) => m.status === "in_progress");

  return {
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    inProgressMatches,
    profiles,
    loading,
    addCourt,
    updateCourtStatus,
    removeCourt,
    callNextMatch,
    createManualMatch,
    endMatch,
    cancelMatch,
    clearOnDeckMatch,
    removeFromQueue,
  };
}
