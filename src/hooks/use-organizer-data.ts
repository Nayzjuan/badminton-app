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
  subscribeToOrganizerBroadcast,
} from "@/lib/realtime";
import type { AutoMatchmakingToggledPayload, CapSaturationPayload } from "@/lib/broadcast";
import {
  callNextMatch as callNextMatchAction,
  type MatchmakingResult,
} from "@/app/actions/matchmaking";
import {
  endMatchAction,
  cancelMatchAction,
  createManualMatchAction,
  clearOnDeckMatch as clearOnDeckMatchAction,
  reorderOnDeckMatches as reorderOnDeckMatchesAction,
  publishMatchAction,
  publishAllDraftMatchesAction,
} from "@/app/actions/match";
import {
  swapPlayerInMatch as swapPlayerInMatchAction,
  swapMatchPlayers as swapMatchPlayersAction,
  type SwapResult,
  type SwapMatchPlayersResult,
} from "@/app/actions/swap-player";
import { togglePlayerPause } from "@/app/actions/queue";
import { updateSessionSettings } from "@/app/actions/sessions";
import type {
  Court,
  Match,
  MatchPlayer,
  Profile,
  QueueWithWaitTime,
  Session,
} from "@/types/database";

// Number of table channels tracked for the realtimeConnected health indicator.
// Declared at module scope so useCallback([]) can reference it without
// needing to list it in the dep array.
const REALTIME_CHANNEL_COUNT = 5; // courts, queue_entries, matches, match_players, profiles

/** A match enriched with its player profiles + court info. */
export interface EnrichedMatch extends Match {
  court: Court | null;
  players: (MatchPlayer & { profile: Profile })[];
}

export interface UseOrganizerDataResult {
  /** Live session record — updates in real-time when settings change. */
  session: Session;
  courts: Court[];
  queue: QueueWithWaitTime[];
  /** All active matches (pending + in_progress). */
  activeMatches: EnrichedMatch[];
  /** Pending matches — formed but waiting for a court (on-deck). */
  onDeckMatches: EnrichedMatch[];
  /**
   * Draft Mode: pending matches that are NOT yet published (hidden from
   * players and TV). Only the organizer can see and publish these.
   */
  draftMatches: EnrichedMatch[];
  /**
   * Draft Mode: pending matches that are published and visible to players
   * and the TV view.
   */
  publishedOnDeckMatches: EnrichedMatch[];
  /** In-progress matches — assigned to a court, currently playing. */
  inProgressMatches: EnrichedMatch[];
  profiles: Map<string, Profile>;
  loading: boolean;
  /**
   * True when all five realtime channels (courts, queue, matches,
   * match_players, profiles) have confirmed SUBSCRIBED status.
   * False if any channel reports CHANNEL_ERROR or TIMED_OUT.
   * Starts true so the indicator doesn't flash on initial load;
   * channels report their status within ~1 second of mounting.
   */
  realtimeConnected: boolean;
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
  reorderOnDeckMatches: (orderedMatchIds: string[]) => Promise<{ error?: string }>;
  // -- Draft Mode --
  publishMatch: (matchId: string) => Promise<{ error?: string }>;
  publishAllDrafts: () => Promise<{ error?: string; publishedCount?: number }>;
  // -- Swap actions --
  swapPlayer: (
    matchId: string,
    outPlayerId: string,
    inPlayerId: string
  ) => Promise<SwapResult>;
  swapMatchPlayers: (
    aMatchId: string,
    aPlayerId: string,
    bMatchId: string,
    bPlayerId: string,
    sessionId: string,
  ) => Promise<SwapMatchPlayersResult>;
  // -- Queue actions --
  removeFromQueue: (playerId: string) => Promise<{ error?: string }>;
  pausePlayer: (playerId: string, isPaused: boolean) => Promise<{ error?: string }>;
  // -- Session settings --
  updateTimeLimit: (minutes: number | null) => Promise<{ error?: string }>;
  // -- Cap saturation --
  /**
   * Non-null when the partner-pair cap blocked the last match attempt.
   * The UI renders a dismissable notice/alert in the On Deck panel.
   */
  capSaturation: CapSaturationPayload | null;
  /** Clears the capSaturation notice. */
  dismissCapSaturation: () => void;
}

export function useOrganizerData(
  sessionId: string,
  initialSession: Session
): UseOrganizerDataResult {
  const supabase = useMemo(() => createClient(), []);
  const [session, setSession] = useState<Session>(initialSession);
  const [courts, setCourts] = useState<Court[]>([]);
  const [queue, setQueue] = useState<QueueWithWaitTime[]>([]);
  const [activeMatches, setActiveMatches] = useState<EnrichedMatch[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [loading, setLoading] = useState(true);
  // Starts true — channels report SUBSCRIBED within ~1 s of mounting, so
  // there's no "flash" of the indicator on load. Flips to false the moment
  // any channel reports CHANNEL_ERROR or TIMED_OUT.
  const [realtimeConnected, setRealtimeConnected] = useState(true);
  const [capSaturation, setCapSaturation] = useState<CapSaturationPayload | null>(null);

  // ── Realtime health tracking ──────────────────────────────────
  // Tracks which channel IDs have confirmed SUBSCRIBED. Using a Set
  // (keyed by channel name) rather than a bare counter prevents
  // double-counting when a channel fires SUBSCRIBED twice on reconnect:
  //   counter approach: SUBSCRIBED → SUBSCRIBED → count=2 for 1 channel ✗
  //   Set approach:     SUBSCRIBED → SUBSCRIBED → size=1 (idempotent) ✓
  // The Set is cleared on cleanup so each mount starts fresh.
  const connectedChannelIds = useRef(new Set<string>());

  // ------------------------------------------------------------------
  // Stable ref that always mirrors `courts` state.
  // Used inside fetchActiveMatches so that callback doesn't need
  // `courts` in its useCallback dep array — breaking the cascade that
  // caused subscriptions to tear down on every court update.
  // ------------------------------------------------------------------
  const courtsRef = useRef<Court[]>([]);

  // Captures the last confirmed court_time_limit_minutes before an optimistic
  // update so that a failed save reverts to the right value — not the stale
  // initialSession value captured at mount time.
  const prevTimeLimitRef = useRef<number | null>(initialSession.court_time_limit_minutes);
  useEffect(() => {
    courtsRef.current = courts;
  }, [courts]);

  // ------------------------------------------------------------------
  // Sequence counters — shared guard pattern for any fetch that makes
  // multiple async round-trips before calling setState.
  //
  // How it works: each invocation captures `mySeq = ++counter.current`
  // on entry. Before every setState (or between async phases), it checks
  // `mySeq === counter.current`. If a newer call has started since, the
  // current call silently aborts — preventing a slow stale call from
  // overwriting the correct result of a faster newer call.
  //
  // fetchQueue needs this because it does TWO sequential queries:
  //   Phase 1: SELECT * FROM v_queue_with_wait_time
  //   Phase 2: SELECT player_id, is_paused FROM queue_entries  (pause merge)
  // Without the guard, a stale Phase 2 completing after a newer call's
  // setQueue will overwrite the correct state with old data.
  //
  // When one match ends and the engine fires, up to 8 concurrent
  // fetchQueue calls can be in flight (4 "return to waiting" events +
  // 4 "promoted to on_deck" events). The guard ensures only the
  // last-started call wins.
  // ------------------------------------------------------------------
  const fetchActiveMatchesSeq = useRef(0);
  const fetchQueueSeq = useRef(0);

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
    // Capture sequence number up-front. Any newer fetchQueue call will
    // increment fetchQueueSeq.current, making our mySeq stale.
    const mySeq = ++fetchQueueSeq.current;

    // ── Phase 1: fetch waiting players from the view ──────────────
    const { data, error } = await supabase
      .from("v_queue_with_wait_time")
      .select("*")
      .eq("session_id", sessionId)
      // Must match the matchmaking sort so the organizer sees the real queue order.
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    // Abort if a newer call started while Phase 1 was in flight.
    if (mySeq !== fetchQueueSeq.current) return;

    if (error) {
      console.error("[useOrganizerData] fetchQueue error:", error);
    }
    if (data) {
      // ── Phase 2: merge is_paused flag ─────────────────────────────
      // v_queue_with_wait_time doesn't expose is_paused; fetch it
      // directly from queue_entries and merge in-memory.
      const { data: pauseData } = await supabase
        .from("queue_entries")
        .select("player_id, is_paused")
        .eq("session_id", sessionId);

      // Abort if a newer call started while Phase 2 was in flight.
      // Without this guard a slow stale Phase 2 can overwrite the
      // correct newer setQueue with old player data.
      if (mySeq !== fetchQueueSeq.current) return;

      const pauseMap = new Map((pauseData ?? []).map((r) => [r.player_id, r.is_paused]));
      setQueue(data.map((row) => ({ ...row, is_paused: pauseMap.get(row.player_id) ?? false })));
    }
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
      .order("sort_order", { ascending: true, nullsFirst: false })
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
            vip_tag: null,
            vip_theme: null,
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

  // Stable callback that counts SUBSCRIBED/error events across all five
  // table channels and flips realtimeConnected accordingly.
  // Defined outside the effect so it never changes identity — the effect
  // only re-runs when supabase/sessionId change, not on every render.
  const handleChannelStatus = useCallback(
    (channelId: string, connected: boolean) => {
      if (connected) {
        connectedChannelIds.current.add(channelId);
      } else {
        connectedChannelIds.current.delete(channelId);
      }
      setRealtimeConnected(connectedChannelIds.current.size === REALTIME_CHANNEL_COUNT);
    },
    [] // deliberately stable — only accesses connectedChannelIds (ref, stable identity)
       // and setRealtimeConnected (stable setState dispatcher)
  );

  useEffect(() => {
    // Clear the Set so each new subscription cycle starts from zero.
    connectedChannelIds.current.clear();

    // Session settings channel — filtered to this session ID.
    // Handles court_time_limit_minutes changes made by the organizer.
    // Not included in the health counter — it's a metadata channel, not
    // a player-data channel, so we don't need it to be "live" for gameplay.
    //
    // NOTE: is_auto_matchmaking_on is intentionally NOT synced through
    // this channel. The sessions table RLS SELECT policy only grants access
    // to the session creator, so co-organizers (non-creators) would never
    // receive this UPDATE event — the channel fires silently for them.
    // Auto-toggle state is synced via the Broadcast channel below instead.
    const sessionChannel = supabase
      .channel(`session-settings:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          // Apply all session field changes EXCEPT is_auto_matchmaking_on.
          // That field is synced via the Broadcast channel so co-organizers
          // (who fail the sessions RLS SELECT check) also receive updates.
          // Excluding it here prevents a race where the primary organizer
          // sees a stale postgres_changes value overwrite the fresh broadcast.
          const next = payload.new as Partial<Session>;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { is_auto_matchmaking_on: _, ...rest } = next;
          setSession((prev) => ({ ...prev, ...rest }));
        }
      )
      .subscribe();

    // Auto-matchmaking toggle sync via Broadcast (bypasses RLS).
    // When any organizer flips the toggle, toggleAutoMatchmaking emits
    // "auto_matchmaking_toggled" on session-events:{sessionId}.
    // All co-organizers on this channel receive it immediately,
    // regardless of their RLS SELECT access on the sessions table.
    const unsubBroadcast = subscribeToOrganizerBroadcast(
      supabase,
      sessionId,
      // organizer_intervention handler — not used here (players handle it),
      // but the function signature requires it.
      () => {},
      // session_closed handler — not used by organizer dashboard.
      undefined,
      (payload: AutoMatchmakingToggledPayload) => {
        setSession((prev) => ({
          ...prev,
          is_auto_matchmaking_on: payload.isOn,
        }));
      },
      (payload: CapSaturationPayload) => {
        setCapSaturation(payload);
      }
    );

    const unsubs = [
      subscribeToCourts(supabase, sessionId, () => fetchCourtsRef.current(), undefined, handleChannelStatus),
      subscribeToQueue(supabase, sessionId, () => fetchQueueRef.current(), undefined, handleChannelStatus),
      subscribeToMatches(supabase, sessionId, () => fetchActiveMatchesRef.current(), undefined, handleChannelStatus),
      subscribeToMatchPlayers(supabase, sessionId, () => fetchActiveMatchesRef.current(), undefined, handleChannelStatus),
      // Profile changes (e.g. skill override) → re-fetch queue (view includes
      // skill_level from profiles) and active matches (embedded profiles).
      subscribeToProfiles(supabase, sessionId, () => {
        fetchQueueRef.current();
        fetchActiveMatchesRef.current();
      }, undefined, handleChannelStatus),
    ];
    return () => {
      supabase.removeChannel(sessionChannel);
      unsubBroadcast();
      unsubs.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId, handleChannelStatus]); // Intentionally omit the fetch refs — they are kept current via the ref pattern above.

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

  const reorderOnDeckMatches = useCallback(
    async (orderedMatchIds: string[]) => {
      const result = await reorderOnDeckMatchesAction(sessionId, orderedMatchIds);
      if (!result.success) return { error: result.message };
      return {};
    },
    [sessionId]
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

  // Soft pause: keeps player in queue but excludes them from matchmaking.
  // joined_at and games_played are NEVER modified — position is preserved.
  const pausePlayer = useCallback(
    async (playerId: string, isPaused: boolean) => {
      const result = await togglePlayerPause(sessionId, playerId, isPaused);
      if (!result.success) return { error: result.error };
      await fetchQueue();
      return {};
    },
    [sessionId, fetchQueue]
  );

  // ---- Swap action ----
  // Wraps the server action and explicitly refreshes queue + active matches
  // so the UI updates immediately without relying on Realtime.

  const swapPlayer = useCallback(
    async (
      matchId: string,
      outPlayerId: string,
      inPlayerId: string
    ): Promise<SwapResult> => {
      const result = await swapPlayerInMatchAction(matchId, outPlayerId, inPlayerId);
      // Always refresh state so the UI reflects the swap (or the latest
      // server state if it failed due to a concurrent change).
      await Promise.all([fetchQueue(), fetchActiveMatches()]);
      return result;
    },
    [fetchQueue, fetchActiveMatches]
  );

  // ---- Match-to-match swap action ----
  // Swaps two players who are already inside on-deck matches.
  // Neither player changes queue status (both remain "on_deck").
  // Refreshes active matches so the UI reflects the change immediately.

  const swapMatchPlayers = useCallback(
    async (
      aMatchId: string,
      aPlayerId: string,
      bMatchId: string,
      bPlayerId: string,
      sessionId: string,
    ): Promise<SwapMatchPlayersResult> => {
      const result = await swapMatchPlayersAction(aMatchId, aPlayerId, bMatchId, bPlayerId, sessionId);
      // Refresh active matches regardless of outcome so the UI
      // shows the latest server state (swap or any concurrent change).
      await fetchActiveMatches();
      return result;
    },
    [fetchActiveMatches]
  );

  // ---- Session settings action ----

  const updateTimeLimit = useCallback(
    async (minutes: number | null) => {
      // Capture current value before overwriting — used for revert on failure.
      // Using a setState callback guarantees we read the latest state value
      // even if React has batched multiple updates since the last render.
      setSession((prev) => {
        prevTimeLimitRef.current = prev.court_time_limit_minutes;
        return { ...prev, court_time_limit_minutes: minutes };
      });
      const result = await updateSessionSettings(sessionId, { court_time_limit_minutes: minutes });
      if (result.error) {
        // Revert to the last confirmed value, not the stale initialSession value
        setSession((prev) => ({ ...prev, court_time_limit_minutes: prevTimeLimitRef.current }));
        return { error: result.error };
      }
      return {};
    },
    [sessionId]
  );

  // Derived splits — avoids the dashboard needing to filter itself.
  const onDeckMatches = activeMatches.filter((m) => m.status === "pending");
  const draftMatches = onDeckMatches.filter((m) => !m.is_published);
  const publishedOnDeckMatches = onDeckMatches.filter((m) => m.is_published);
  const inProgressMatches = activeMatches.filter((m) => m.status === "in_progress");

  // ── Cap saturation ────────────────────────────────────────────

  const dismissCapSaturation = useCallback(() => {
    setCapSaturation(null);
  }, []);

  // ── Draft Mode actions ────────────────────────────────────────

  const publishMatch = useCallback(
    async (matchId: string): Promise<{ error?: string }> => {
      const result = await publishMatchAction(matchId);
      return result.success ? {} : { error: result.message };
    },
    []
  );

  const publishAllDrafts = useCallback(
    async (): Promise<{ error?: string; publishedCount?: number }> => {
      const result = await publishAllDraftMatchesAction(sessionId);
      return result.success
        ? { publishedCount: result.publishedCount }
        : { error: result.message };
    },
    [sessionId]
  );

  return {
    session,
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    draftMatches,
    publishedOnDeckMatches,
    inProgressMatches,
    profiles,
    loading,
    realtimeConnected,
    addCourt,
    updateCourtStatus,
    removeCourt,
    callNextMatch,
    createManualMatch,
    endMatch,
    cancelMatch,
    clearOnDeckMatch,
    reorderOnDeckMatches,
    publishMatch,
    publishAllDrafts,
    swapPlayer,
    swapMatchPlayers,
    removeFromQueue,
    pausePlayer,
    updateTimeLimit,
    capSaturation,
    dismissCapSaturation,
  };
}
