"use client";

// ============================================================
// useOrganizerCourts — court state, subscriptions, and actions
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { subscribeToCourts } from "@/lib/realtime";
import { updateSessionSettings } from "@/app/actions/sessions";
import type { Court, Session } from "@/types/database";

export function useOrganizerCourts(
  sessionId: string,
  supabase: SupabaseClient<Database>,
  /**
   * setSession from useOrganizerSession — needed so updateTimeLimit
   * can apply an optimistic update on the live session state.
   */
  setSession: Dispatch<SetStateAction<Session>>,
  onChannelStatus?: (channelId: string, connected: boolean) => void
): {
  courts: Court[];
  courtsRef: MutableRefObject<Court[]>;
  fetchCourts: () => Promise<void>;
  loading: boolean;
  addCourt: (name: string) => Promise<{ error?: string }>;
  updateCourtStatus: (courtId: string, status: Court["status"]) => Promise<{ error?: string }>;
  removeCourt: (courtId: string) => Promise<{ error?: string }>;
  updateTimeLimit: (minutes: number | null) => Promise<{ error?: string }>;
} {
  const [courts, setCourts] = useState<Court[]>([]);
  const [loading, setLoading] = useState(true);

  // Stable ref always mirroring courts state — used inside fetchActiveMatches
  // (via useOrganizerMatches) so that callback doesn't need courts in its dep array.
  const courtsRef = useRef<Court[]>([]);

  // Captures the last confirmed time limit for revert on optimistic-update failure.
  const prevTimeLimitRef = useRef<number | null>(null);

  useEffect(() => {
    courtsRef.current = courts;
  }, [courts]);

  const fetchCourts = useCallback(async () => {
    const { data, error } = await supabase
      .from("courts")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[useOrganizerCourts] fetchCourts error:", error);
    }
    if (data) setCourts(data);
  }, [supabase, sessionId]);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    fetchCourts().then(() => setLoading(false));
  }, [fetchCourts]);

  // ── Stable ref for subscription ───────────────────────────────
  const fetchCourtsRef = useRef(fetchCourts);
  // eslint-disable-next-line react-hooks/refs
  fetchCourtsRef.current = fetchCourts;

  // ── Realtime subscription ─────────────────────────────────────
  useEffect(() => {
    const unsub = subscribeToCourts(
      supabase,
      sessionId,
      () => fetchCourtsRef.current(),
      undefined,
      onChannelStatus
    );
    return unsub;
  }, [supabase, sessionId, onChannelStatus]);

  // ── Court actions ─────────────────────────────────────────────

  const addCourt = useCallback(
    async (name: string) => {
      const { error } = await supabase.from("courts").insert({ session_id: sessionId, name });
      if (error) return { error: error.message };
      await fetchCourts();
      return {};
    },
    [supabase, sessionId, fetchCourts]
  );

  const updateCourtStatus = useCallback(
    async (courtId: string, status: Court["status"]) => {
      const { error } = await supabase.from("courts").update({ status }).eq("id", courtId);
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

  const updateTimeLimit = useCallback(
    async (minutes: number | null) => {
      // Optimistic update: immediately reflect the new time limit in the session state.
      // Capture current value for revert using the setState callback so we always
      // read the latest state value even if React has batched updates since last render.
      setSession((prev) => {
        prevTimeLimitRef.current = prev.court_time_limit_minutes;
        return { ...prev, court_time_limit_minutes: minutes };
      });
      const result = await updateSessionSettings(sessionId, { court_time_limit_minutes: minutes });
      if (result.error) {
        // Revert to the last confirmed value on failure.
        setSession((prev) => ({
          ...prev,
          court_time_limit_minutes: prevTimeLimitRef.current,
        }));
        return { error: result.error };
      }
      return {};
    },
    [sessionId, setSession]
  );

  return {
    courts,
    courtsRef,
    fetchCourts,
    loading,
    addCourt,
    updateCourtStatus,
    removeCourt,
    updateTimeLimit,
  };
}
