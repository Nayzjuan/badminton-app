"use client";

// ============================================================
// useOrganizerSession — live session state + realtime health
// ============================================================
// Manages:
//   liveSession     — live session record (updates in real-time)
//   realtimeConnected — health indicator (all channels SUBSCRIBED)
//   capSaturation   — partner-pair cap saturation notice
//
// Provides:
//   handleChannelStatus — callback passed to other sub-hooks so
//                         they can report their channel status.
//   dismissCapSaturation
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";
import { whenRealtimeAuthReady } from "@/utils/supabase/client";
import { getSessionForOrganizer } from "@/app/actions/sessions";
import type {
  AutoMatchmakingToggledPayload,
  AutoPublishToggledPayload,
  CapSaturationPayload,
  DraftCapPhasePayload,
  OrganizerInterventionPayload,
  SessionClosedPayload,
} from "@/lib/broadcast";
import type { Session } from "@/types/database";

// Organizer-facing copy for a co-organizer's intervention. Distinct from the
// player-side messages in useOrganizerBroadcast — these tell the OTHER
// organizer what a co-organizer just did, so a cleared/cancelled match doesn't
// silently vanish from their board. {actor} is filled from the payload.
const CO_ORGANIZER_INTERVENTION_COPY: Record<
  OrganizerInterventionPayload["type"],
  (actor: string) => string
> = {
  on_deck_cleared: (actor) => `${actor} cleared an on-deck match.`,
  match_cancelled: (actor) => `${actor} cancelled a match.`,
  active_roster_changed: (actor) => `${actor} changed a court lineup.`,
};

// Total number of table channels tracked for the realtimeConnected indicator.
// courts(1) + queue_entries(1) + matches(1) + match_players(1) + profiles(1) = 5
const REALTIME_CHANNEL_COUNT = 5;

// ── Draft-cap lockout lease ───────────────────────────────────
// The lockout is a LEASE, not a latch: 'done' releases it early, and the lease
// releases it no matter what. Without this, a dropped 'done' — a Realtime 5xx,
// a WebSocket drop, a serverless timeout, a CHANNEL_ERROR on this private
// channel — leaves a `fixed inset-0 z-[200]` overlay with no dismiss control
// and no Esc handler, i.e. a dashboard bricked until reload. Neither the 15s
// poll nor the reconnect refresh touches this state. The server supplies ttlMs;
// these bounds clamp a garbled or hostile value.
const CAP_PHASE_TTL_DEFAULT_MS = 30_000;
const CAP_PHASE_TTL_MIN_MS = 5_000;
const CAP_PHASE_TTL_MAX_MS = 120_000;

// Phase ordering, so a duplicate or inverted message cannot walk the lock
// backwards (e.g. a late 'clearing' after 'generating' already arrived).
const CAP_PHASE_RANK: Record<"clearing" | "generating" | "done", number> = {
  clearing: 1,
  generating: 2,
  done: 3,
};

// Ring of recently-finished opIds, so a 'clearing' that arrives AFTER its own
// 'done' is discarded rather than re-locking the board for a full lease.
const FINISHED_CAP_OPS_MAX = 16;

// Stand-in id for a payload with no opId (an older server, mid-rolling-deploy).
// It is deliberately kept OUT of the finished-op ring: every legacy op collapses
// onto this one string, so remembering it would make the first legacy 'done'
// discard the 'clearing' of every legacy op that followed — during a rolling
// deploy, where legacy is the only traffic, exactly one cap reset would ever
// show the overlay. Out-of-order delivery cannot be detected without a
// correlation id anyway; the TTL lease is what bounds that case.
const LEGACY_CAP_OP = "__legacy__";

function rememberFinishedCapOp(ring: string[], id: string): void {
  if (ring.includes(id)) return;
  ring.push(id);
  if (ring.length > FINISHED_CAP_OPS_MAX) ring.shift();
}

/**
 * Manages the live session record, realtime health tracking, and cap saturation signals.
 *
 * `realtimeConnected` is true only after all five table channels have confirmed
 * SUBSCRIBED status. The dashboard shows a ReconnectModal when this is false.
 *
 * `handleChannelStatus` is a stable callback — safe to pass to child sub-hooks
 * without causing subscription restarts on re-renders.
 */
/** Phase exposed to the UI. 'done' is broadcast-only and maps to null here. */
export type CapPhase = "clearing" | "generating" | null;

/**
 * Draft-cap lockout signal received over Broadcast. `phase: null` = idle.
 *
 * Carries the opId so the tab that STARTED the operation can recognise its own
 * echo (the REST broadcast endpoint has no sending socket, so Realtime fans
 * every message back to the actor's own tab) and `actorName` so co-organizers
 * can be told whose reset is holding their board.
 */
export type CapPhaseSignal = {
  phase: CapPhase;
  /** Correlates to the opId the initiating tab minted. null on a legacy payload. */
  opId: string | null;
  actorName: string | null;
};

const IDLE_CAP_SIGNAL: CapPhaseSignal = { phase: null, opId: null, actorName: null };

export function useOrganizerSession(
  sessionId: string,
  initialSession: Session,
  supabase: SupabaseClient<Database>,
  /** The viewing organizer's own id — used to suppress their own intervention toast. */
  currentUserId: string,
  /**
   * Optional hooks into the session broadcast channel, so the board can react
   * to a CO-ORGANIZER closing the session (or its own close in another tab).
   * Wired to useSessionClosedWatcher at the call site.
   *
   * `onBroadcastStatus` is deliberately NOT `handleChannelStatus`: that counter
   * asserts an exact REALTIME_CHANNEL_COUNT of *postgres_changes* channels, so
   * feeding a sixth into it would peg the "live" indicator to disconnected
   * forever. It exists to tell the watcher the channel flapped and a
   * `session_closed` may have been missed.
   */
  closeHooks?: {
    onSessionClosed?: (payload: SessionClosedPayload) => void;
    onBroadcastStatus?: () => void;
  }
): {
  liveSession: Session;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  realtimeConnected: boolean;
  capSaturation: CapSaturationPayload | null;
  dismissCapSaturation: () => void;
  handleChannelStatus: (channelId: string, connected: boolean) => void;
  /** Draft-cap reset signal driven by a co-organizer or self (see CapPhaseSignal). */
  capSignal: CapPhaseSignal;
} {
  const [liveSession, setSession] = useState<Session>(initialSession);
  const [realtimeConnected, setRealtimeConnected] = useState(true);
  const [capSaturation, setCapSaturation] = useState<CapSaturationPayload | null>(null);
  const [capSignal, setCapSignal] = useState<CapPhaseSignal>(IDLE_CAP_SIGNAL);

  // The op currently holding this client's lock, with the highest phase rank
  // seen for it. Ref, not state — read inside the broadcast callback, which must
  // not re-register the channel.
  //
  // Deliberately a SINGLE slot, not a map. Two co-organizers changing the cap at
  // the same instant can interleave: op2's 'clearing' overwrites the slot, then
  // op2's 'done' unlocks the board while op1 is still generating. If op1 has an
  // advancing phase left it re-adopts the slot and re-locks; if its only
  // remaining phase is 'done' the board just stays unlocked through op1's engine
  // run. Either way the lease bounds the worst case, and
  // the overlay is advisory (the server is the authority on what the cap is), so
  // the residue is a flicker rather than a lost edit. A map keyed by opId would
  // close it, at the cost of a second eviction policy for ops whose 'done' never
  // arrives — not worth it for a window this narrow.
  const capOpRef = useRef<{ id: string; rank: number } | null>(null);
  const finishedCapOpsRef = useRef<string[]>([]);
  const capLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracks which channel IDs have confirmed SUBSCRIBED — Set prevents double-counting.
  const connectedChannelIds = useRef(new Set<string>());

  // Monotonic sequence counter for session refresh — guards against stale polls.
  const fetchSessionSeq = useRef(0);

  // Stable ref so the broadcast callback reads the current id without
  // re-registering the channel (the subscription effect deps stay minimal).
  const currentUserIdRef = useRef(currentUserId);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  });

  // Same reason: the watcher's callbacks change identity whenever it re-renders,
  // and the broadcast channel must be registered once per session.
  const closeHooksRef = useRef(closeHooks);
  useEffect(() => {
    closeHooksRef.current = closeHooks;
  });

  // ── Session refresh ───────────────────────────────────────────
  // Lightweight poll/reconnect handler. Uses server action (getSessionForOrganizer)
  // backed by service-role so it works for both the creator AND co-organizers.
  const fetchSession = useCallback(async () => {
    const mySeq = ++fetchSessionSeq.current;
    const result = await getSessionForOrganizer(sessionId);
    if (mySeq !== fetchSessionSeq.current) return; // stale — discard
    if (!result.success || !result.session) {
      console.error("[useOrganizerSession] fetchSession error:", result.error);
      return;
    }
    setSession(result.session);
  }, [sessionId]);

  // Stable ref so polling effects don't need fetchSession in dep arrays.
  const fetchSessionRef = useRef(fetchSession);
  // eslint-disable-next-line react-hooks/refs
  fetchSessionRef.current = fetchSession;

  // Single release path for the draft-cap lockout: cancels the lease timer,
  // forgets the active op, and returns the signal to idle.
  const releaseCapLock = useCallback(() => {
    if (capLockTimerRef.current) {
      clearTimeout(capLockTimerRef.current);
      capLockTimerRef.current = null;
    }
    capOpRef.current = null;
    setCapSignal(IDLE_CAP_SIGNAL);
  }, []);
  const releaseCapLockRef = useRef(releaseCapLock);
  // eslint-disable-next-line react-hooks/refs
  releaseCapLockRef.current = releaseCapLock;

  // ── Stable handleChannelStatus callback ───────────────────────
  // Passed to every sub-hook so they can report their channel status.
  const handleChannelStatus = useCallback(
    (channelId: string, connected: boolean) => {
      if (connected) {
        connectedChannelIds.current.add(channelId);
      } else {
        connectedChannelIds.current.delete(channelId);
      }
      setRealtimeConnected(connectedChannelIds.current.size === REALTIME_CHANNEL_COUNT);
    },
    [] // stable — only accesses refs and stable setState dispatchers
  );

  // ── Session settings channel + organizer broadcast ─────────────
  useEffect(() => {
    connectedChannelIds.current.clear();

    // Session settings channel — filtered to this session ID.
    // Handles court_time_limit_minutes changes made by the organizer.
    // Not included in the health counter — it's a metadata channel, not
    // a player-data channel, so we don't need it to be "live" for gameplay.
    //
    // NOTE: is_auto_matchmaking_on is intentionally NOT synced through this
    // channel — auto-toggle state goes over the Broadcast channel instead.
    // This used to be justified as "sessions RLS only grants the creator",
    // which is no longer true: the multi-tenant policy is
    // `is_session_organizer(id) OR is_club_member(club_id)`, so co-organizers
    // AND players do receive these UPDATEs (useSessionClosedWatcher's path 2
    // depends on exactly that). Keeping the split anyway: broadcast is the
    // faster, prefix-namespaced path the toggle UI already reads.
    // Defer the join until the Realtime JWT is set (see whenRealtimeAuthReady
    // in src/utils/supabase/client.ts): postgres_changes RLS binds to the
    // socket's role at join time, and the club-scoped sessions SELECT policy
    // rejects `anon`, so joining before the organizer's JWT propagates would
    // silently deliver zero events. The 15s poll below is the fallback.
    let sessionChannel: RealtimeChannel | null = null;
    let sessionChannelCancelled = false;

    void whenRealtimeAuthReady().then(() => {
      if (sessionChannelCancelled) return;
      sessionChannel = supabase
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
            // Apply all session field changes EXCEPT is_auto_matchmaking_on and
            // auto_publish. Those are synced via Broadcast so co-organizers (who
            // are blocked by the sessions RLS SELECT policy) also receive them.
            const next = payload.new as Partial<Session>;
            const { is_auto_matchmaking_on: _a, auto_publish: _p, ...rest } = next;
            setSession((prev) => ({ ...prev, ...rest }));
          }
        )
        .subscribe();
    });

    // Auto-matchmaking toggle sync via Broadcast (bypasses RLS).
    const unsubBroadcast = subscribeToOrganizerBroadcast(supabase, sessionId, {
      // A co-organizer cleared/cancelled a match. The board already drops the
      // card (Postgres row-delete event), but silently — this toast explains
      // WHO did WHAT so it isn't a mysterious disappearance. Only fires when an
      // actor is attached (clear/cancel) and it wasn't THIS organizer.
      onIntervention: (payload: OrganizerInterventionPayload) => {
        const actorId = payload.actorId;
        if (!actorId || actorId === currentUserIdRef.current) return;
        const copy = CO_ORGANIZER_INTERVENTION_COPY[payload.type];
        if (!copy) return;
        toast.info(copy(payload.actorName ?? "A co-organizer"), {
          duration: 5_000,
          closeButton: true,
        });
      },
      // A co-organizer (or this organizer, from another tab) closed the
      // session. The board has no meaning any more; the watcher decides where
      // this organizer goes and gets them there.
      onSessionClosed: (payload: SessionClosedPayload) => {
        setSession((prev) => ({ ...prev, is_active: false }));
        closeHooksRef.current?.onSessionClosed?.(payload);
      },
      onStatus: () => {
        closeHooksRef.current?.onBroadcastStatus?.();
      },
      onAutoMatchmakingToggled: (payload: AutoMatchmakingToggledPayload) => {
        // Invalidate any in-flight fetchSession poll (F3 fix).
        ++fetchSessionSeq.current;
        setSession((prev) => ({
          ...prev,
          is_auto_matchmaking_on: payload.isOn,
        }));
      },
      onAutoPublishToggled: (payload: AutoPublishToggledPayload) => {
        ++fetchSessionSeq.current;
        setSession((prev) => ({
          ...prev,
          auto_publish: payload.isOn,
        }));
      },
      onCapSaturation: (payload: CapSaturationPayload) => {
        setCapSaturation(payload);
      },
      onDraftCapPhaseChanged: (payload: DraftCapPhasePayload) => {
        const phase = payload?.phase;

        // Closed-union guard. The previous code was `phase === "done" ? null :
        // phase`, so ANY other wire value — "Done", "clearing ", an object —
        // locked the board permanently and rendered as "Generating new drafts…".
        // Never trust a wire string as a state value.
        if (phase !== "clearing" && phase !== "generating" && phase !== "done") {
          console.warn("[useOrganizerSession] ignoring unknown draft_cap_phase:", phase);
          return;
        }

        // Rolling-deploy compatibility: an older server sends no opId. A single
        // sentinel reproduces the previous semantics (any phase adopts, any
        // 'done' clears) without a separate code path.
        const opId = typeof payload.opId === "string" ? payload.opId : LEGACY_CAP_OP;
        const isLegacy = opId === LEGACY_CAP_OP;

        if (phase === "done") {
          if (!isLegacy) rememberFinishedCapOp(finishedCapOpsRef.current, opId);
          const active = capOpRef.current;
          // Only OUR op's 'done' releases OUR lock — otherwise organizer A
          // finishing would unlock organizer B's still-running reset.
          if (!active || active.id === opId || isLegacy) {
            releaseCapLockRef.current();
          }
          // Refetch regardless of actor: cheaply converges max_auto_drafts_override.
          ++fetchSessionSeq.current;
          fetchSessionRef.current();
          return;
        }

        // Out-of-order guard: 'done' for this op already arrived. Without this a
        // late 'clearing' locks a board that only the lease would ever unlock.
        // Legacy payloads are exempt — see LEGACY_CAP_OP.
        if (!isLegacy && finishedCapOpsRef.current.includes(opId)) return;

        const active = capOpRef.current;
        // Same op, same-or-earlier phase → a stale duplicate or an inverted pair.
        if (active && active.id === opId && CAP_PHASE_RANK[phase] <= active.rank) return;

        capOpRef.current = { id: opId, rank: CAP_PHASE_RANK[phase] };
        setCapSignal({
          phase,
          opId: payload.opId ?? null,
          actorName: typeof payload.actorName === "string" ? payload.actorName : null,
        });

        // (Re-)arm the lease on every advancing phase, so a long-but-progressing
        // operation is never cut short mid-flight.
        if (capLockTimerRef.current) clearTimeout(capLockTimerRef.current);
        const ttl = Math.min(
          Math.max(payload.ttlMs ?? CAP_PHASE_TTL_DEFAULT_MS, CAP_PHASE_TTL_MIN_MS),
          CAP_PHASE_TTL_MAX_MS
        );
        capLockTimerRef.current = setTimeout(() => {
          console.warn(
            "[useOrganizerSession] draft-cap lock expired without 'done' — self-unlocking"
          );
          if (!isLegacy) rememberFinishedCapOp(finishedCapOpsRef.current, opId);
          releaseCapLockRef.current();
          ++fetchSessionSeq.current;
          fetchSessionRef.current();
          if (document.visibilityState === "visible") {
            toast.info("Draft reset is taking longer than expected — controls unlocked.");
          }
        }, ttl);
      },
    });

    return () => {
      sessionChannelCancelled = true;
      if (sessionChannel) supabase.removeChannel(sessionChannel);
      // Drop any armed lease so it cannot fire after unmount.
      if (capLockTimerRef.current) {
        clearTimeout(capLockTimerRef.current);
        capLockTimerRef.current = null;
      }
      unsubBroadcast();
    };
  }, [supabase, sessionId]);

  // ── Layer 2 — Polling + visibility refresh ────────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchSessionRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchSessionRef.current();
      }
    }, 15000);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(interval);
    };
  }, []);

  // ── Layer 3 — Reconnect refresh ───────────────────────────────
  const prevRealtimeConnected = useRef(realtimeConnected);
  useEffect(() => {
    if (realtimeConnected && !prevRealtimeConnected.current) {
      fetchSessionRef.current();
    }
    prevRealtimeConnected.current = realtimeConnected;
  }, [realtimeConnected]);

  const dismissCapSaturation = useCallback(() => {
    setCapSaturation(null);
  }, []);

  return {
    liveSession,
    setSession,
    realtimeConnected,
    capSaturation,
    dismissCapSaturation,
    handleChannelStatus,
    capSignal,
  };
}
