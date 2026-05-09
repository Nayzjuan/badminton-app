"use client";

// ============================================================
// useSessionData — Global session state for the Player Dashboard
// ============================================================
// Provides a read-only view of everything happening in the
// session: all courts, all active matches (with players/profiles),
// and the full waiting queue with profiles.
//
// This is the player-side equivalent of useOrganizerData, but
// without any mutation actions (players can't modify courts,
// cancel matches, etc.).
//
// Subscription stability: uses the same ref-pattern as
// useOrganizerData to avoid teardown cascades.
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
import type {
  Court,
  Match,
  MatchPlayer,
  Profile,
  QueueEntry,
} from "@/types/database";

// ── Types ────────────────────────────────────────────────────

export interface EnrichedMatchPlayer extends MatchPlayer {
  profile: Profile;
}

export interface SessionMatch extends Match {
  court: Court | null;
  players: EnrichedMatchPlayer[];
}

export interface QueueEntryWithProfile extends QueueEntry {
  profile: Profile;
}

export interface UseSessionDataResult {
  courts: Court[];
  /** Matches currently in progress (on a court). */
  inProgressMatches: SessionMatch[];
  /** Matches on deck (pending — formed but waiting for a court). */
  onDeckMatches: SessionMatch[];
  /** All waiting queue entries with profiles, sorted by matchmaking order. */
  waitlist: QueueEntryWithProfile[];
  loading: boolean;
  /** Manually re-fetch all session data (used by useVisibilityRefresh). */
  refresh: () => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────

export function useSessionData(sessionId: string): UseSessionDataResult {
  const supabase = useMemo(() => createClient(), []);

  const [courts, setCourts] = useState<Court[]>([]);
  const [activeMatches, setActiveMatches] = useState<SessionMatch[]>([]);
  const [waitlist, setWaitlist] = useState<QueueEntryWithProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // Stable ref for courts (used inside fetchActiveMatches).
  const courtsRef = useRef<Court[]>([]);
  useEffect(() => {
    courtsRef.current = courts;
  }, [courts]);

  // Race-condition guards for concurrent fetches.
  const fetchSeq = useRef(0);
  const fetchWaitlistSeq = useRef(0);

  // ── Fetch courts ──────────────────────────────────────────

  const fetchCourts = useCallback(async () => {
    const { data } = await supabase
      .from("courts")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (data) setCourts(data);
  }, [supabase, sessionId]);

  // ── Fetch active matches (pending + in_progress) ──────────

  const fetchActiveMatches = useCallback(async () => {
    const mySeq = ++fetchSeq.current;

    // Draft Mode firewall: in_progress matches are always visible;
    // pending matches are only visible when is_published=true.
    // This prevents players and the TV from seeing engine drafts.
    const { data: matches } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)")
      .order("created_at", { ascending: true });

    if (mySeq !== fetchSeq.current) return;

    if (!matches || matches.length === 0) {
      setActiveMatches([]);
      return;
    }

    const matchIds = matches.map((m) => m.id);
    const { data: matchPlayers } = await supabase
      .from("match_players")
      .select("*")
      .in("match_id", matchIds);

    if (mySeq !== fetchSeq.current) return;

    const playerIds = [...new Set((matchPlayers ?? []).map((mp) => mp.player_id))];
    let profileMap = new Map<string, Profile>();
    if (playerIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("*")
        .in("id", playerIds);

      if (mySeq !== fetchSeq.current) return;
      profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    }

    const enriched: SessionMatch[] = matches.map((match) => {
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
  }, [supabase, sessionId]);

  // ── Fetch waitlist (waiting queue entries + profiles) ──────

  const fetchWaitlist = useCallback(async () => {
    const mySeq = ++fetchWaitlistSeq.current;

    const { data: entries } = await supabase
      .from("queue_entries")
      .select("*")
      .eq("session_id", sessionId)
      .eq("status", "waiting")
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    if (mySeq !== fetchWaitlistSeq.current) return;

    if (!entries || entries.length === 0) {
      setWaitlist([]);
      return;
    }

    const playerIds = entries.map((e) => e.player_id);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("*")
      .in("id", playerIds);

    if (mySeq !== fetchWaitlistSeq.current) return;

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

    const enriched: QueueEntryWithProfile[] = entries.map((entry) => ({
      ...entry,
      profile: profileMap.get(entry.player_id) ?? {
        id: entry.player_id,
        display_name: "Unknown",
        skill_level: "beginner" as const,
        pin: null,
        vip_tag: null,
        vip_theme: null,
        created_at: "",
        updated_at: "",
      },
    }));

    setWaitlist(enriched);
  }, [supabase, sessionId]);

  // ── Initial load ──────────────────────────────────────────

  useEffect(() => {
    async function load() {
      await Promise.all([fetchCourts(), fetchActiveMatches(), fetchWaitlist()]);
      setLoading(false);
    }
    load();
  }, [fetchCourts, fetchActiveMatches, fetchWaitlist]);

  // ── Real-time subscriptions ───────────────────────────────

  const fetchCourtsRef = useRef(fetchCourts);
  const fetchActiveMatchesRef = useRef(fetchActiveMatches);
  const fetchWaitlistRef = useRef(fetchWaitlist);
  // Synchronous ref-update during render: intentional stable-callback pattern.
  // The refs are only read inside effects/event handlers, never during render.
  // eslint-disable-next-line react-hooks/refs
  fetchCourtsRef.current = fetchCourts;
  // eslint-disable-next-line react-hooks/refs
  fetchActiveMatchesRef.current = fetchActiveMatches;
  // eslint-disable-next-line react-hooks/refs
  fetchWaitlistRef.current = fetchWaitlist;

  useEffect(() => {
    // Use a unique channel prefix so these subscriptions don't collide
    // with the ones in useQueue and usePlayerMatch on the same page.
    const prefix = "session-data";
    const unsubs = [
      subscribeToCourts(supabase, sessionId, () => fetchCourtsRef.current(), prefix),
      subscribeToQueue(supabase, sessionId, () => fetchWaitlistRef.current(), prefix),
      subscribeToMatches(supabase, sessionId, () => fetchActiveMatchesRef.current(), prefix),
      subscribeToMatchPlayers(supabase, sessionId, () => fetchActiveMatchesRef.current(), prefix),
      // Profile changes → re-fetch waitlist (skill badges) and active matches (player profiles).
      subscribeToProfiles(supabase, sessionId, () => {
        fetchWaitlistRef.current();
        fetchActiveMatchesRef.current();
      }, prefix),
    ];
    return () => unsubs.forEach((u) => u());
  }, [supabase, sessionId]);

  // ── Derived splits ────────────────────────────────────────

  const inProgressMatches = activeMatches.filter((m) => m.status === "in_progress");
  const onDeckMatches = activeMatches.filter((m) => m.status === "pending");

  const refresh = useCallback(async () => {
    await Promise.all([fetchCourts(), fetchActiveMatches(), fetchWaitlist()]);
  }, [fetchCourts, fetchActiveMatches, fetchWaitlist]);

  return {
    courts,
    inProgressMatches,
    onDeckMatches,
    waitlist,
    loading,
    refresh,
  };
}
