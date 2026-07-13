import "server-only";

// ============================================================
// Best-effort match-event logging (server-action layer)
// ============================================================
// For lifecycle events that do NOT happen inside a composition RPC, we log
// from the server action by calling record_match_event directly.
//
// CURRENTLY WIRED via this helper: score_edit + revert (updateMatchDetails),
// cancelled (cancelMatchAction), and cancelled from the draft-clear + checkout
// leaver paths — clearOnDeckMatch (single on-deck Clear), clearAllUnpublishedDrafts
// (batch cap-reset / close), and checkoutPlayer (a departing player dropping a
// draft below 4). Those three log 'cancelled' with a payload.reason so the trail
// answers "who cleared/cancelled this match?" (the delete paths log BEFORE the
// row is removed, so the FK is valid and ON DELETE SET NULL preserves the snapshot).
// DEFERRED (plumbed in the type/DB but NOT yet emitted): player_left from the
// leaver paths, cancelled from remove_player_from_queue_organizer, and published.
// See MEMORY.md + plan §14.E-1.
//
// These are deliberately BEST-EFFORT (plan §14 decision E-2):
//   • computed seq is NOT under the match row lock (tiny gap/collision risk),
//   • score/revert/cancelled = 0 delta (never affect modification_count),
//   • a failure must NEVER break the user-facing action — errors are swallowed.
//
// Composition events (roster_swap/team_flip/ondeck_pull/undo) are NOT logged
// here — they are written transactionally inside their RPCs.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import type { MatchEventType, MatchPhase, MatchEventActorType } from "@/lib/match-provenance";

type LogArgs = {
  matchId: string;
  sessionId: string;
  eventType: Extract<
    MatchEventType,
    "score_edit" | "revert" | "cancelled" | "player_left" | "published"
  >;
  phase: MatchPhase;
  actorId: string | null;
  actorName: string | null;
  /** RosterSwapMovement[] etc.; default []. */
  movements?: unknown;
  payload?: Record<string, unknown> | null;
};

/**
 * Inserts a non-composition audit event. Never throws — any failure is logged
 * and swallowed so the caller's primary mutation is unaffected.
 */
export async function logMatchEvent(args: LogArgs): Promise<void> {
  try {
    const db = createServiceClient();
    const actorType: MatchEventActorType = args.actorId ? "organizer" : "system";
    const { error } = await db.rpc("record_match_event", {
      p_match_id: args.matchId,
      p_session_id: args.sessionId,
      p_event_type: args.eventType,
      p_phase: args.phase,
      p_actor_type: actorType,
      p_actor_id: args.actorId,
      p_actor_name: args.actorName,
      p_movements: args.movements ?? [],
      p_payload: args.payload ?? null,
    });
    if (error) {
      console.error(`[match-event-log] ${args.eventType} failed:`, error.message);
    }
  } catch (err) {
    console.error(`[match-event-log] ${args.eventType} threw:`, err);
  }
}
