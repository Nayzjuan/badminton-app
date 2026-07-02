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
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { createUnknownProfile } from "@/lib/utils";
import { useEnrichedMatches, type EnrichedMatch } from "@/hooks/use-enriched-matches";
import {
  subscribeToCourts,
  subscribeToQueue,
  subscribeToMatches,
  subscribeToMatchPlayers,
  subscribeToProfiles,
} from "@/lib/realtime";
import type { Court, Profile, QueueEntry } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

// ── Types ────────────────────────────────────────────────────

// EnrichedMatch (imported from use-enriched-matches) replaces the former
// local SessionMatch type. Re-export both names so components importing
// SessionMatch or EnrichedMatchPlayer from this file don't need to update.
export type SessionMatch = EnrichedMatch;
export type EnrichedMatchPlayer = EnrichedMatch["players"][number];

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
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [courts, setCourts] = useState<Court[]>([]);
  const [waitlist, setWaitlist] = useState<QueueEntryWithProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // Stable ref for courts — passed to useEnrichedMatches so it can resolve
  // court names without needing courts in its dep array (avoids teardown cascade).
  const courtsRef = useRef<Court[]>([]);
  useEffect(() => {
    courtsRef.current = courts;
  }, [courts]);

  // Race-condition guard for fetchWaitlist (fetchActiveMatches uses its own
  // internal seqRef inside useEnrichedMatches).
  const fetchWaitlistSeq = useRef(0);

  // ── Active match enrichment (shared hook) ─────────────────
  // includeDrafts: false — draft firewall: players and TV only see
  // published pending matches and in_progress matches.
  const { activeMatches, fetchActiveMatches } = useEnrichedMatches(supabase, sessionId, courtsRef, {
    includeDrafts: false,
  });

  // ── Fetch courts ──────────────────────────────────────────

  const fetchCourts = useCallback(async () => {
    const { data, error } = await supabase
      .from("courts")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (error) {
      // Preserve stale courts rather than clearing — transient failures should
      // not wipe the panel. The next realtime event will trigger a re-fetch.
      console.error("[useSessionData] fetchCourts error:", error.message);
      return;
    }
    if (data) setCourts(data);
  }, [supabase, sessionId]);

  // ── Fetch waitlist (waiting queue entries + profiles) ──────

  const fetchWaitlist = useCallback(async () => {
    const mySeq = ++fetchWaitlistSeq.current;

    const { data: entries, error: entriesError } = await supabase
      .from("queue_entries")
      .select("*")
      .eq("session_id", sessionId)
      .in("status", ["waiting", "on_deck"])
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    if (mySeq !== fetchWaitlistSeq.current) return;

    if (entriesError) {
      console.error("[useSessionData] fetchWaitlist queue_entries error:", entriesError.message);
      return; // preserve stale waitlist
    }

    if (!entries || entries.length === 0) {
      setWaitlist([]);
      return;
    }

    const playerIds = entries.map((e) => e.player_id);
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select(PUBLIC_PROFILE_COLUMNS)
      .in("id", playerIds);

    if (mySeq !== fetchWaitlistSeq.current) return;

    if (profilesError) {
      console.error("[useSessionData] fetchWaitlist profiles error:", profilesError.message);
      return; // preserve stale waitlist
    }

    const profileMap = new Map((profiles ?? []).map((p) => [p.id, { ...p, pin: null }]));

    const enriched: QueueEntryWithProfile[] = entries
      .map((entry) => ({
        ...entry,
        profile: profileMap.get(entry.player_id) ?? createUnknownProfile(entry.player_id),
      }))
      // Pin on_deck rows to the top; preserve games_played/joined_at order within each tier.
      .sort((a, b) => {
        const aPriority = a.status === "on_deck" ? 0 : 1;
        const bPriority = b.status === "on_deck" ? 0 : 1;
        return aPriority - bPriority;
      });

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
  // Sync all three callback refs in a single effect so they're always
  // up-to-date before the subscription effect runs, with one commit
  // instead of three. Each callback is useCallback-memoised so identity
  // only changes when supabase or sessionId changes.
  useEffect(() => {
    fetchCourtsRef.current = fetchCourts;
    fetchActiveMatchesRef.current = fetchActiveMatches;
    fetchWaitlistRef.current = fetchWaitlist;
  }, [fetchCourts, fetchActiveMatches, fetchWaitlist]);

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
      subscribeToProfiles(
        supabase,
        sessionId,
        () => {
          fetchWaitlistRef.current();
          fetchActiveMatchesRef.current();
        },
        prefix
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [supabase, sessionId]);

  // ── Derived splits ────────────────────────────────────────
  // Memoised: avoids re-filtering on every parent render (e.g. when courts or
  // waitlist state changes) when activeMatches itself hasn't changed.
  const inProgressMatches = useMemo(
    () => activeMatches.filter((m) => m.status === "in_progress"),
    [activeMatches]
  );
  const onDeckMatches = useMemo(
    () => activeMatches.filter((m) => m.status === "pending"),
    [activeMatches]
  );

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
