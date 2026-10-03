// ============================================================
// Score + start attribution — pure rules
// ============================================================
// Who is recorded on a `scored` / `started` match_events row.
// The RPCs validate the same actor-type constraints; this module
// is the JS-side spec those calls must follow.
// ============================================================

import type { MatchEventActorType } from "@/lib/match-provenance";

export type ScoreVia = "organizer_end" | "player_submit";

export type ScoreAttribution = {
  actorType: Extract<MatchEventActorType, "organizer" | "player">;
  via: ScoreVia;
};

/**
 * First-score actor.
 * - Player card (`participantVerified`) is always `player`, even when
 *   the caller is also an organizer or club admin.
 * - Organizer modal (`endMatchAction`) is `organizer` only when the
 *   caller is an organizer; a non-organizer who is in the match is
 *   `player`.
 */
export function scoreActorType(args: {
  participantVerified: boolean;
  isOrganizer: boolean;
}): ScoreAttribution {
  if (args.participantVerified) {
    return { actorType: "player", via: "player_submit" };
  }
  if (args.isOrganizer) {
    return { actorType: "organizer", via: "organizer_end" };
  }
  return { actorType: "player", via: "player_submit" };
}

export type MatchStartTrigger = "call_next" | "after_score" | "after_cancel";

export type MatchStartAttribution =
  | {
      trigger: "call_next";
      actorId: string;
      actorName: string | null;
    }
  | {
      trigger: "after_score" | "after_cancel";
      triggerMatchId: string;
      triggerActorId: string;
      triggerActorName: string | null;
    };

export type StartRpcFields = {
  trigger: MatchStartTrigger;
  actorType: Extract<MatchEventActorType, "organizer" | "system">;
  actorId: string | null;
  actorName: string | null;
  triggerMatchId: string | null;
  triggerActorId: string | null;
  triggerActorName: string | null;
};

/**
 * System starts keep actor_id / actor_name NULL. The person whose
 * score or cancel freed the court lives only in the trigger_* fields.
 */
/** PostgREST returns jsonb as an object; some fixtures/clients give a string. */
export function parseJsonRpcResult<T extends object>(data: unknown): T | null {
  if (data == null) return null;
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed && typeof parsed === "object" ? (parsed as T) : null;
    } catch {
      return null;
    }
  }
  if (typeof data === "object") return data as T;
  return null;
}

export function startActorFields(attr: MatchStartAttribution): StartRpcFields {
  if (attr.trigger === "call_next") {
    return {
      trigger: "call_next",
      actorType: "organizer",
      actorId: attr.actorId,
      actorName: attr.actorName,
      triggerMatchId: null,
      triggerActorId: null,
      triggerActorName: null,
    };
  }
  return {
    trigger: attr.trigger,
    actorType: "system",
    actorId: null,
    actorName: null,
    triggerMatchId: attr.triggerMatchId,
    triggerActorId: attr.triggerActorId,
    triggerActorName: attr.triggerActorName,
  };
}
