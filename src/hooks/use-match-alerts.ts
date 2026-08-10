"use client";

// ============================================================
// useMatchAlerts — Real-time match status → IN-APP AUDIO
// ============================================================
// Watches the player's queue entry and match assignment for
// state transitions and plays the appropriate in-app beep exactly
// once per transition, while the app is OPEN.
//
// Alerts fired:
//   → on_deck      playWarningBeep()   (match forming, get ready)
//   → playing      playCourtCall()     (court assigned, go now)
//   → in_progress  playCourtCall()     (match started on court)
//
// NOTE ON PUSH: Web Push (OS-level sound + vibration + banner for a
// backgrounded/locked phone) is NOT fired here. It is fired
// SERVER-SIDE the moment the status changes (pushToPlayers wired into
// the status-transition actions), so it reaches devices even when
// this hook isn't running. This hook is purely the in-app audio layer.
//
// Android-specific fixes applied here:
//
//   FIX 1 — Transition detection: no longer requires knowing the
//   exact previous state.  Old code checked `prev === "waiting"`
//   which fails if bootstrap() hadn't finished yet (race condition).
//   New code checks `next === "on_deck" && prev !== "on_deck"` so
//   any entry INTO the target state fires the alert, regardless of
//   what state we thought we were in before.
//
//   FIX 3 — AudioContext async issue is fixed in audio.ts; play
//   functions are now async and await ctx.resume() before scheduling
//   tones.
// ============================================================

import { useCallback, useEffect, useRef, useMemo } from "react";
import { createBrowserSupabaseClient } from "@/utils/supabase/client";
import { subscribeToQueue, subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";
import { trailingDebounce } from "@/lib/trailing-debounce";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";
import { playWarningBeep, playCourtCall, unlockAudio } from "@/lib/notifications/audio";
import type { QueueStatus, MatchStatus, QueueEntry, Match } from "@/types/database";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export type AlertType = "ON_DECK_WARNING" | "COURT_CALL";

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
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  // Last-known status refs — used only to detect transitions and
  // suppress duplicate alerts for the same state.
  const lastQueueStatus = useRef<QueueStatus | null>(null);
  const lastMatchStatus = useRef<MatchStatus | null>(null);

  // Fast-path cache: the match ID the player is currently assigned to.
  const assignedMatchId = useRef<string | null>(null);

  // ── Audio unlock on first interaction ──────────────────────
  // Browsers require a user gesture before AudioContext can start.
  // We register a one-time listener and also call unlockAudio()
  // eagerly so the context is primed as soon as possible.
  useEffect(() => {
    const unlock = () => unlockAudio();
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true, passive: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  // ── Fire alert (IN-APP AUDIO ONLY) ───────────────────────────
  // This hook owns the low-latency in-app beep that plays while the
  // app is OPEN. The Web Push notification (OS-level sound + vibration
  // + banner for backgrounded/locked phones) is fired SERVER-SIDE at
  // the moment the status changes — see pushToPlayers() wired into the
  // status-transition actions (promoteOnDeckMatchInternal, publish*,
  // live swaps). Keeping push server-side is what makes it fire when
  // this hook isn't even running (app closed / websocket suspended),
  // and removing the client push here prevents a double notification.
  const fireAlert = useCallback(
    async (type: AlertType) => {
      // play* functions are async and await ctx.resume() internally
      // so they work correctly on Android Chrome.
      if (audioEnabled) {
        if (type === "ON_DECK_WARNING") {
          await playWarningBeep();
        } else {
          await playCourtCall();
        }
      }
    },
    [audioEnabled]
  );

  // ── Initial state bootstrap ──────────────────────────────────
  // Seeds the lastQueueStatus / lastMatchStatus refs so the first
  // real-time event is compared against the correct baseline.
  //
  // NOTE: bootstrap is async and there IS a small race window where a
  // realtime event can arrive before bootstrap finishes.  The transition
  // detection below uses `next !== prev` (not `prev === "waiting"`) so it
  // fires correctly even if prev is null.
  const bootstrap = useCallback(async () => {
    // ── Queue status ─────────────────────────────────────────
    const { data: queueRow } = await supabase
      .from("queue_entries")
      .select("status")
      .eq("session_id", sessionId)
      .eq("player_id", playerId)
      .in("status", ["waiting", "drafted", "on_deck", "playing"])
      .maybeSingle();

    if (queueRow) {
      lastQueueStatus.current = queueRow.status as QueueStatus;
    }

    // ── Active match (pending / in_progress) ─────────────────
    const { data: assignments } = await supabase
      .from("match_players")
      .select("match_id, matches!inner(session_id)")
      .eq("player_id", playerId)
      .eq("matches.session_id", sessionId);

    if (assignments && assignments.length > 0) {
      const matchIds = assignments.map((a) => a.match_id);
      const { data: activeMatch } = await supabase
        .from("matches")
        .select("id, status")
        .eq("session_id", sessionId)
        .in("id", matchIds)
        .or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeMatch) {
        assignedMatchId.current = activeMatch.id;
        lastMatchStatus.current = activeMatch.status as MatchStatus;
      }
    }
  }, [supabase, sessionId, playerId]);

  // Ref-based callback per CLAUDE.md guardrail 3.1. The subscription effect below
  // carries an exhaustive-deps disable to keep its channels stable, so the
  // LONG-LIVED path — the debounced re-seed fired by the match_players handler on
  // every later event — must go through this ref rather than a captured closure.
  //
  // The one-shot `bootstrap()` at the top of that effect is deliberately a direct
  // call, not `bootstrapRef.current()`: it runs only when the effect itself runs,
  // and `bootstrap`'s deps ([supabase, sessionId, playerId]) are exactly the
  // effect's deps, so the captured closure is never stale at that moment.
  const bootstrapRef = useRef(bootstrap);
  useEffect(() => {
    bootstrapRef.current = bootstrap;
  }, [bootstrap]);

  // ── Queue changes ─────────────────────────────────────────────
  const handleQueueChange = useCallback(
    (payload: RealtimePostgresChangesPayload<QueueEntry>) => {
      const row = payload.new as Partial<QueueEntry>;

      // Ignore other players.
      if (row.player_id !== playerId) return;

      const prev = lastQueueStatus.current;
      const next = row.status;
      if (!next || next === prev) return;

      lastQueueStatus.current = next as QueueStatus;

      // ── Drafted: single short haptic, no audio ────────────────
      // Signals "something is happening" without creating urgency —
      // the draft may still be cancelled or reshuffled before publish.
      // Audio is intentionally reserved for the confirmed on_deck moment.
      // Guard mirrors the on_deck pattern (prev !== target) so it fires even
      // if bootstrap lost the race and prev is still null when the event arrives.
      if (next === "drafted" && prev !== "drafted") {
        if (typeof navigator !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate(80);
        }
        return;
      }

      // ── FIX 1: check `next === target` not `prev === source`  ──
      // Old: if (prev === "waiting" && next === "on_deck")
      // Problem: if bootstrap hasn't finished, prev === null and the
      // check fails even though the transition is genuine.
      // New: fire whenever we ENTER on_deck, regardless of origin.
      if (next === "on_deck" && prev !== "on_deck") {
        fireAlert("ON_DECK_WARNING");
        return;
      }

      // Also catch queue-level playing transition as a belt-and-suspenders
      // COURT_CALL in case the match status event is missed.
      if (next === "playing" && prev !== "playing") {
        fireAlert("COURT_CALL");
      }
    },
    [playerId, fireAlert]
  );

  // ── Match changes ─────────────────────────────────────────────
  const handleMatchChange = useCallback(
    async (payload: RealtimePostgresChangesPayload<Match>) => {
      const row = payload.new as Partial<Match>;
      const matchId = row.id;
      if (!matchId) return;

      const next = row.status;
      // Only care about in_progress transitions (court assigned).
      if (next !== "in_progress") return;

      // Fast-path: is this the match we already know about?
      let playerIsInMatch = assignedMatchId.current === matchId;

      if (!playerIsInMatch) {
        // Slow-path: query match_players to confirm this player is in the match.
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
      if (next === prev) return;
      lastMatchStatus.current = next as MatchStatus;

      // ── FIX 1 (same pattern): fire on entering in_progress ─────
      // Old: if (prev === "pending" && next === "in_progress")
      // Problem: if bootstrap hasn't set lastMatchStatus yet, or if the
      // match was created while bootstrap was running, prev is null.
      // New: fire whenever match enters in_progress.
      fireAlert("COURT_CALL");
    },
    [supabase, playerId, fireAlert]
  );

  // ── Subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    bootstrap();

    const unsubQueue = subscribeToQueue(supabase, sessionId, handleQueueChange, "alerts-queue");

    const unsubMatches = subscribeToMatches(
      supabase,
      sessionId,
      handleMatchChange,
      "alerts-matches"
    );

    // Only the NETWORK half of this handler is debounced. The two ref resets
    // stay EAGER and un-debounced on purpose: they are ordering-critical. A
    // roster change arrives as up to 4 match_players rows immediately followed
    // by the `matches` status event, and handleMatchChange reads these refs
    // synchronously. Deferring the resets by even one event would let the
    // status event be attributed to the player's OLD match and fire — or
    // suppress — a COURT_CALL alert wrongly. Debouncing only bootstrap()
    // collapses the redundant re-seed round trips (an identity merge repoints
    // every match_players row a player has ever had) while leaving the
    // synchronous attribution logic exactly as it was.
    const alertsDeb = trailingDebounce(
      () => void bootstrapRef.current(),
      REALTIME_REFETCH_DEBOUNCE_MS
    );

    const unsubPlayers = subscribeToMatchPlayers(
      supabase,
      sessionId,
      () => {
        // Player assignment changed — re-seed the match ref so subsequent
        // match status events are correctly attributed.
        assignedMatchId.current = null;
        lastMatchStatus.current = null;
        alertsDeb.run();
      },
      "alerts-match-players"
    );

    return () => {
      alertsDeb.cancel();
      unsubQueue();
      unsubMatches();
      unsubPlayers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId, playerId]);
}
