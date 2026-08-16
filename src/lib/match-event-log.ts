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
// (batch cap-reset / close), checkoutPlayer (a departing player dropping a
// draft below 4), and removePlayerFromQueue (an organizer kicking a player out
// of the queue, which cancels any pending match they were on — the
// remove_player_from_queue_organizer RPC soft-cancels, so the row + FK survive
// and logging after is safe). Those log 'cancelled' with a payload.reason so the
// trail answers "who cleared/cancelled this match?" (the delete paths log BEFORE
// the row is removed, so the FK is valid and ON DELETE SET NULL preserves the
// snapshot).
// ALSO WIRED: published, via logPublishedEvents — every draft → published
// transition in the app (see that function's own doc comment for the list and
// for what deliberately does NOT count as one).
// DEFERRED (plumbed in the type/DB but NOT yet emitted): player_left from the
// leaver paths. See MEMORY.md + plan §14.E-1.
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
  /**
   * Overrides the actorId-derived default below. Only needed for the one actor
   * kind that has no id and is not merely "an automatic consequence": the
   * matchmaking engine, which must be 'engine' rather than the id-less default
   * of 'system'. 'engine' is not a new actor kind here — the 'created' event
   * already writes it for every engine-made match (create_match_with_players
   * picks 'organizer' for p_origin='manual' and 'engine' otherwise, migration
   * 20260617000000_match_provenance_audit).
   */
  actorType?: MatchEventActorType;
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
    const actorType: MatchEventActorType =
      args.actorType ?? (args.actorId ? "organizer" : "system");
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

/**
 * Roster snapshot for audit payloads — [{ team, player_id, player_name }],
 * keyed by match_id. player_name is captured durably (survives a later profile
 * merge/rename), mirroring the shape of the 'created' event payload. Two bulk
 * queries — no N+1.
 */
export async function fetchRosterSnapshots(
  db: ReturnType<typeof createServiceClient>,
  matchIds: string[]
): Promise<Map<string, Array<{ team: string; player_id: string; player_name: string }>>> {
  const map = new Map<string, Array<{ team: string; player_id: string; player_name: string }>>();
  if (matchIds.length === 0) return map;

  const { data: mps } = await db
    .from("match_players")
    .select("match_id, team, player_id")
    .in("match_id", matchIds);
  const rows = mps ?? [];
  if (rows.length === 0) return map;

  const playerIds = [...new Set(rows.map((r) => r.player_id))];
  const { data: profs } = await db.from("profiles").select("id, display_name").in("id", playerIds);
  const nameMap = new Map((profs ?? []).map((p) => [p.id, p.display_name]));

  for (const r of rows) {
    const list = map.get(r.match_id) ?? [];
    list.push({
      team: r.team,
      player_id: r.player_id,
      player_name: nameMap.get(r.player_id) ?? "Unknown",
    });
    map.set(r.match_id, list);
  }
  return map;
}

/**
 * Which transition produced the event. Written to payload.reason, matching the
 * `reason` key the 'cancelled' sites in match-drafts.ts / queue.ts already use.
 *
 * The RPC path and its JS fallback share a reason on purpose: they perform the
 * identical transition, and which one ran is a property of whether publish_match
 * / publish_all_drafts exist on that environment (introduced in migration
 * 20260511210000_atomic_server_actions) — not of the match.
 */
export type PublishReason =
  /** publishMatchAction — organizer published one draft. */
  | "publish_single"
  /** publishAllDraftMatchesAction — organizer published the whole draft set. */
  | "publish_all"
  /** recomputeHeldReadiness — auto_publish mode released a held draft on its own. */
  | "auto_publish_held";

/**
 * Records a 'published' event per match for one draft → published transition.
 *
 * WIRED AT (every transition that flips is_published false → true):
 *   • publishMatchAction + publishMatchFallback          → publish_single
 *   • publishAllDraftMatchesAction + publishAllDraftsFallback → publish_all
 *   • recomputeHeldReadiness's auto_publish_match arm     → auto_publish_held
 *
 * NOT a transition, and deliberately unlogged: a match BORN published. Both
 * create_match_with_players callers can insert one — match-lifecycle.ts with a
 * literal true (a manual on-deck match), and matchmaking-db.ts with the
 * engine's EFFECTIVE auto-publish flag. Note that flag is not the session's:
 * effectiveAutoPublish = autoPublish || (bypassGate && i === 0), so
 * callNextMatch's slot 0 is born published in a draft-mode session too
 * (matchmaking.ts, where the reason is written down at the assignment).
 * Neither caller was ever a draft that an organizer released, so "draft →
 * published" never happened; the 'created' event already carries the fact, and
 * emitting a synthetic 'published' beside it would make the ledger claim a
 * review step nobody performed. (swap-player.ts also takes a p_is_published,
 * but on the unrelated swap_player_in_match RPC, which only reads it to pick
 * the incoming player's queue status — it never writes matches.is_published.)
 *
 * Best-effort, like every writer in this module: it never throws, so a logging
 * defect can't fail a publish the organizer already saw succeed. The corollary
 * is that a missing row still cannot be read as "not published" — but a PRESENT
 * row is now proof that it was, which is the half that did not exist before.
 *
 * `phase` is always "draft": the match is `pending` on BOTH sides of this
 * transition (publishing flips is_published, never status), and the codebase
 * convention is that pending ⇒ "draft" — see the same note in queue.ts's
 * organizer-remove path. The published/unpublished distinction lives in the
 * payload, not the phase.
 */
export async function logPublishedEvents(args: {
  db: ReturnType<typeof createServiceClient>;
  sessionId: string;
  matchIds: string[];
  reason: PublishReason;
  actorId: string | null;
  actorName: string | null;
  actorType?: MatchEventActorType;
}): Promise<void> {
  if (args.matchIds.length === 0) return;
  try {
    // Read AFTER the publish on purpose. Only created_method is immutable after
    // insert; the held pair is NOT — recomputeHeldReadiness downgrades a held
    // draft whose pulled body left the roster by clearing pulled_player_ids
    // (which drives the GENERATED is_held) and held_ready_at. What keeps the
    // late read safe is that its CANDIDATE query filters `.is("held_ready_at",
    // null)` while a held draft cannot publish until held_ready_at is stamped
    // (migration 20260816000000), so the two normally never see the same row —
    // not because the columns are frozen. Keep that filter if this ever moves.
    // It is a read-then-write, not a lock, so two overlapping recompute runs
    // could still clobber a row published in between; the cost is one payload
    // with a stale held triple, which is why this is worth a comment and not a
    // transaction.
    // is_published is NOT in the payload: post-write it is `true` for every row
    // here, so it would record nothing.
    const [{ data: rows }, rosters] = await Promise.all([
      args.db
        .from("matches")
        .select("id, created_method, is_held, held_ready_at")
        .in("id", args.matchIds),
      fetchRosterSnapshots(args.db, args.matchIds),
    ]);
    const provenance = new Map((rows ?? []).map((r) => [r.id, r]));

    await Promise.all(
      args.matchIds.map((matchId) => {
        const p = provenance.get(matchId);
        return logMatchEvent({
          matchId,
          sessionId: args.sessionId,
          eventType: "published",
          phase: "draft",
          actorId: args.actorId,
          actorName: args.actorName,
          actorType: args.actorType,
          payload: {
            reason: args.reason,
            created_method: p?.created_method ?? null,
            // The held pair is what makes a cross-court publish answerable:
            // held_ready_at is when the hold unlocked, the event's own
            // created_at is when it was published, and the gap between them is
            // how long the draft sat waiting for someone to act on it.
            is_held: p?.is_held ?? false,
            held_ready_at: p?.held_ready_at ?? null,
            roster: rosters.get(matchId) ?? [],
          },
        });
      })
    );
  } catch (err) {
    console.error("[match-event-log] published batch threw:", err);
  }
}
