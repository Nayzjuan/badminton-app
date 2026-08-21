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
import { createBrowserSupabaseClient, hasAuthSession } from "@/utils/supabase/client";
import { createUnknownProfile } from "@/lib/utils";
import { useAuthRecoveryRefetch } from "@/hooks/use-auth-recovery-refetch";
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
import { trailingDebounce } from "@/lib/trailing-debounce";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";

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

  // Race-condition guards. Every fetch in this hook that awaits more than once
  // needs one: `supabase` and `sessionId` are the deps of both callbacks, so a
  // realtime burst can have two runs of the SAME callback in flight, and the
  // slower one must not commit over the faster one. fetchActiveMatches uses its
  // own internal seqRef inside useEnrichedMatches.
  const fetchCourtsSeq = useRef(0);
  const fetchWaitlistSeq = useRef(0);

  // ── Active match enrichment (shared hook) ─────────────────
  // includeDrafts: false — draft firewall: players and TV only see
  // published pending matches and in_progress matches.
  const { activeMatches, fetchActiveMatches } = useEnrichedMatches(supabase, sessionId, courtsRef, {
    includeDrafts: false,
  });

  // ── Fetch courts ──────────────────────────────────────────

  const fetchCourts = useCallback(async () => {
    const mySeq = ++fetchCourtsSeq.current;

    const { data, error } = await supabase
      .from("courts")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (mySeq !== fetchCourtsSeq.current) return;

    if (error) {
      // Preserve stale courts rather than clearing — transient failures should
      // not wipe the panel. The next realtime event will trigger a re-fetch.
      console.error("[useSessionData] fetchCourts error:", error.message);
      return;
    }
    if (!data) return;
    // Empty success + no auth session = this client is running as anon and
    // RLS filtered every row — NOT a court-less session. RLS filtering is a
    // success, not an error, so the error branch above can't catch it. Applies
    // to the FIRST fetch too (cold start racing auth hydration). Hold; the
    // auth-recovery refetch reconverges.
    //
    // hasAuthSession is a second await, so re-check the sequence after it too:
    // a newer run can start and finish while this one is inside the probe.
    if (data.length === 0) {
      const authed = await hasAuthSession(supabase);
      if (mySeq !== fetchCourtsSeq.current) return;
      if (!authed) {
        console.warn("[useSessionData] fetchCourts: empty result without auth — holding state");
        return;
      }
    }
    setCourts(data);
  }, [supabase, sessionId]);

  // ── Fetch waitlist (waiting queue entries + profiles) ──────

  const fetchWaitlist = useCallback(async () => {
    const mySeq = ++fetchWaitlistSeq.current;

    // Single embedded fetch: queue_entries + each player's public profile via the
    // player_id → profiles FK (was two round trips — entries, then profiles).
    const { data: rows, error } = await supabase
      .from("queue_entries")
      .select(`*, profile:profiles(${PUBLIC_PROFILE_COLUMNS})`)
      .eq("session_id", sessionId)
      .in("status", ["waiting", "on_deck"])
      .order("games_played", { ascending: true })
      .order("joined_at", { ascending: true });

    if (mySeq !== fetchWaitlistSeq.current) return;

    if (error) {
      console.error("[useSessionData] fetchWaitlist error:", error.message);
      return; // preserve stale waitlist
    }

    // The embedded profile omits the locked-down `pin` column (PUBLIC_PROFILE_COLUMNS);
    // re-add it as null so the row matches the Profile shape, mirroring the old join.
    const entries = (rows ?? []) as unknown as Array<
      QueueEntry & { profile: Omit<Profile, "pin"> | null }
    >;

    // Empty success + no auth session = this client is running as anon and
    // RLS filtered every row (a success, so the error branch can't catch it)
    // — NOT everyone leaving at once. Applies to the FIRST fetch too (cold
    // start racing auth hydration would otherwise paint "No One Waiting").
    // A genuinely-empty waitlist (all players drafted/playing) still commits:
    // hasAuthSession is true then, and the guard falls through.
    if (entries.length === 0) {
      const authed = await hasAuthSession(supabase);
      if (mySeq !== fetchWaitlistSeq.current) return;
      if (!authed) {
        console.warn("[useSessionData] fetchWaitlist: empty result without auth — holding state");
        return;
      }
    }

    const enriched: QueueEntryWithProfile[] = entries
      .map(({ profile, ...entry }) => ({
        ...entry,
        profile: profile ? { ...profile, pin: null } : createUnknownProfile(entry.player_id),
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
    // One trailing-edge debouncer PER fetch target so an engine burst (matches
    // UPDATE + ~8 match_players rows) collapses into a single fetchActiveMatches
    // instead of ~9. The ref-callback stability pattern + fetchSeq guards stay.
    const courtsDeb = trailingDebounce(
      () => fetchCourtsRef.current(),
      REALTIME_REFETCH_DEBOUNCE_MS
    );
    const waitlistDeb = trailingDebounce(
      () => fetchWaitlistRef.current(),
      REALTIME_REFETCH_DEBOUNCE_MS
    );
    const matchesDeb = trailingDebounce(
      () => fetchActiveMatchesRef.current(),
      REALTIME_REFETCH_DEBOUNCE_MS
    );
    const unsubs = [
      subscribeToCourts(supabase, sessionId, courtsDeb.run, prefix),
      subscribeToQueue(supabase, sessionId, waitlistDeb.run, prefix),
      subscribeToMatches(supabase, sessionId, matchesDeb.run, prefix),
      subscribeToMatchPlayers(supabase, sessionId, matchesDeb.run, prefix),
      // Profile changes → re-fetch waitlist (skill badges) and active matches (player profiles).
      subscribeToProfiles(
        supabase,
        sessionId,
        () => {
          waitlistDeb.run();
          matchesDeb.run();
        },
        prefix
      ),
    ];
    return () => {
      courtsDeb.cancel();
      waitlistDeb.cancel();
      matchesDeb.cancel();
      unsubs.forEach((u) => u());
    };
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

  // Auth recovery → refetch everything. Covers both halves of an auth outage:
  // fetches the guards above held back, and realtime events that never arrived
  // while the socket was de-authed.
  useAuthRecoveryRefetch(supabase, refresh);

  return {
    courts,
    inProgressMatches,
    onDeckMatches,
    waitlist,
    loading,
    refresh,
  };
}
