"use client";

// ============================================================
// useMatchAlerts — Real-time match status → audio + push
// ============================================================
// Watches the player's queue entry and match assignment for
// state TRANSITIONS and fires the appropriate alert exactly
// once per transition.
//
// Transitions tracked:
//   waiting → on_deck       playWarningBeep()   (get ready)
//   on_deck → playing       playCourtCall()     (go now)
//   pending → in_progress   playCourtCall()     (court assigned)
//
// The hook fires audio immediately (client-side, no latency)
// and separately calls the sendPlayerNotification server
// action when the player is NOT currently focused on the app
// (document.visibilityState !== "visible").
// ============================================================

import { useCallback, useEffect, useRef, useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToQueue, subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import { playWarningBeep, playCourtCall, unlockAudio } from "@/lib/notifications/audio";
import type { QueueStatus, MatchStatus, QueueEntry, Match, MatchPlayer } from "@/types/database";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

type AlertType = "ON_DECK_WARNING" | "COURT_CALL";

interface UseMatchAlertsOptions {
  sessionId: string;
  playerId: string;
  /** Set to false to suppress all audio (e.g. user has muted). */
  audioEnabled?: boolean;
}

// ── Hook ─────────────────────────────────────────────────────

export function useMatchAlerts({
  sessionId,
  playerId,
  audioEnabled = true,
}: UseMatchAlertsOptions): void {
  const supabase = useMemo(() => createClient(), []);

  // Track the last-known status values so we can detect direction
  // of the transition and avoid re-firing on unrelated updates.
  const lastQueueStatus = useRef<QueueStatus | null>(null);
  const lastMatchStatus = useRef<MatchStatus | null>(null);

  // Whether the player is currently assigned to ANY non-completed match.
  const assignedMatchId = useRef<string | null>(null);

  // ── Audio unlock on first interaction ──────────────────────
  // Browsers require a user gesture before AudioContext can start.
  // Register a one-time listener so we capture the first click/touch
  // on the dashboard and prime the AudioContext before any alert fires.
  useEffect(() => {
    const unlock = () => {
      unlockAudio();
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true, passive: true });
    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
  }, []);

  // ── Fire alert ───────────────────────────────────────────────
  const fireAlert = useCallback(
    async (type: AlertType) => {
      // Audio fires immediately regardless of visibility.
      if (audioEnabled) {
        if (type === "ON_DECK_WARNING") {
          playWarningBeep();
        } else {
          playCourtCall();
        }
      }

      // Push notification only fires if the tab is backgrounded.
      // When the app is visible, the in-app audio + UI (MatchAlert overlay,
      // OnDeckAlert) already give strong feedback.
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        try {
          const { sendPlayerNotification } = await import(
            "@/app/actions/notifications"
          );
          await sendPlayerNotification(playerId, type);
        } catch (err) {
          // Non-critical — audio already fired; just log.
          console.warn("[useMatchAlerts] push notification failed:", err);
        }
      }
    },
    [playerId, audioEnabled]
  );

  // ── Initial state bootstrap ──────────────────────────────────
  // Fetch the player's current queue and match status so the refs
  // are seeded before any realtime events arrive.  This prevents a
  // false-positive alert on the first subscription event.
  const bootstrap = useCallback(async () => {
    // Queue status
    const { data: queueRow } = await supabase
      .from("queue_entries")
      .select("status")
      .eq("session_id", sessionId)
      .eq("player_id", playerId)
      .in("status", ["waiting", "on_deck", "playing"])
      .maybeSingle();

    if (queueRow) {
      lastQueueStatus.current = queueRow.status as QueueStatus;
    }

    // Active match (pending / in_progress) for this player
    const { data: assignments } = await supabase
      .from("match_players")
      .select("match_id, matches!inner(session_id, status)")
      .eq("player_id", playerId)
      .eq("matches.session_id", sessionId);

    if (assignments && assignments.length > 0) {
      const matchIds = assignments.map((a) => a.match_id);
      const { data: activeMatch } = await supabase
        .from("matches")
        .select("id, status")
        .eq("session_id", sessionId)
        .in("id", matchIds)
        .in("status", ["pending", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeMatch) {
        assignedMatchId.current = activeMatch.id;
        lastMatchStatus.current = activeMatch.status as MatchStatus;
      }
    }
  }, [supabase, sessionId, playerId]);

  // ── Queue changes ─────────────────────────────────────────────
  // Fires when *any* queue_entry in this session changes.
  // We filter to our own player's row and inspect the transition.
  const handleQueueChange = useCallback(
    (payload: RealtimePostgresChangesPayload<QueueEntry>) => {
      const row = payload.new as Partial<QueueEntry>;

      // Ignore updates for other players.
      if (row.player_id !== playerId) return;

      const prev = lastQueueStatus.current;
      const next = row.status;

      // Only fire on status change, not on other field updates.
      if (!next || next === prev) return;
      lastQueueStatus.current = next as QueueStatus;

      // waiting → on_deck: match is forming
      if (prev === "waiting" && next === "on_deck") {
        fireAlert("ON_DECK_WARNING");
        return;
      }

      // on_deck → playing: court assigned (match moved to in_progress)
      // The COURT_CALL fires from the match change handler below, but
      // this catches the edge case where queue status changes without
      // a separate match update being observed.
      if (prev === "on_deck" && next === "playing") {
        fireAlert("COURT_CALL");
      }
    },
    [playerId, fireAlert]
  );

  // ── Match changes ─────────────────────────────────────────────
  // Fires when any match in this session changes.  We verify the
  // player is actually in the match before firing.
  const handleMatchChange = useCallback(
    async (payload: RealtimePostgresChangesPayload<Match>) => {
      const row = payload.new as Partial<Match>;
      const matchId = row.id;
      if (!matchId) return;

      const next = row.status;

      // Determine if this player is in the match — check against
      // the in-memory assignedMatchId first (fast path), then fall
      // back to a DB query if the match is new.
      let playerIsInMatch = assignedMatchId.current === matchId;

      if (!playerIsInMatch) {
        const { data } = await supabase
          .from("match_players")
          .select("match_id")
          .eq("match_id", matchId)
          .eq("player_id", playerId)
          .maybeSingle();

        playerIsInMatch = !!data;
        if (playerIsInMatch) {
          assignedMatchId.current = matchId;
        }
      }

      if (!playerIsInMatch) return;

      const prev = lastMatchStatus.current;
      if (!next || next === prev) return;
      lastMatchStatus.current = next as MatchStatus;

      // pending → in_progress: the match got a court; walk there now
      if (prev === "pending" && next === "in_progress") {
        fireAlert("COURT_CALL");
      }
    },
    [supabase, playerId, fireAlert]
  );

  // ── Subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    bootstrap();

    const unsubQueue = subscribeToQueue(
      supabase,
      sessionId,
      handleQueueChange,
      "alerts-queue"
    );

    const unsubMatches = subscribeToMatches(
      supabase,
      sessionId,
      handleMatchChange,
      "alerts-matches"
    );

    // match_players changes signal when a player is added to a new match.
    // We refresh our assignment ref so subsequent match status events are
    // correctly attributed.
    const unsubPlayers = subscribeToMatchPlayers(
      supabase,
      sessionId,
      (_payload: RealtimePostgresChangesPayload<MatchPlayer>) => {
        // Re-bootstrap the assigned match when player assignments change.
        assignedMatchId.current = null;
        lastMatchStatus.current = null;
        bootstrap();
      },
      "alerts-match-players"
    );

    return () => {
      unsubQueue();
      unsubMatches();
      unsubPlayers();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId, playerId]);
}
