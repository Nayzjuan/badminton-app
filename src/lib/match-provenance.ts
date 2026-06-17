// ============================================================
// Match provenance & modification audit — pure logic
// ============================================================
// Source of truth for the *derivation* rules behind match provenance:
//   • final_classification  (the 6-value ultimate label)
//   • backfill mapping      (legacy origin/is_held → created_method/count)
//   • modification delta     (per-event effect on modification_count)
//   • movement payload shapes (canonical JSONB written by the RPCs + read by the UI)
//
// IMPORTANT (see MATCH_PROVENANCE_AUDIT_PLAN.md §14, H7): the *authoritative*
// modification_count lives in PL/pgSQL (maintained transactionally inside the swap
// RPCs). The `modificationDelta` / `applyModification` helpers here are the canonical
// SPEC the SQL mirrors — unit-tested for the contract; the integration checklist
// verifies the RPC matches. Same for `backfillProvenance`: it mirrors the backfill
// UPDATE in migration 1, and is the readable spec for that SQL.
//
// Everything here is pure + deterministic → fully unit-testable, no DB.
// ============================================================

export type MatchTeam = "a" | "b";

/** How a match was originally created. Immutable — never overwritten after insert. */
export type MatchCreatedMethod = "auto" | "manual" | "held";

/**
 * Ultimate provenance label, derived from (created_method, modification_count > 0).
 * Mirrors the generated column `matches.final_classification`.
 */
export type MatchClassification =
  | "auto_clean"
  | "auto_modified"
  | "manual_clean"
  | "manual_modified"
  | "held_clean"
  | "held_modified";

/** Event kinds recorded in `match_events`. */
export type MatchEventType =
  | "created" // birth (method=auto/manual/held)
  | "published" // draft → published
  | "roster_swap" // 1-out/1-in (queue replacement, fix-record full replacement, cross-match draft swap leg)
  | "team_flip" // 2 players exchange sides (live team swap, fix-record team flip)
  | "ondeck_pull" // cross-match 3-way pull leg (two correlated rows)
  | "player_left" // player removed from a draft via checkout/cleanup (composition change)
  | "cancelled" // match cancelled (lifecycle, no count)
  | "undo" // reverses one prior composition event (decrements)
  | "score_edit" // score correction (players unchanged — never counts)
  | "revert"; // completed → active (players unchanged — never counts)

/** Match status at the moment an event occurred. */
export type MatchPhase = "draft" | "active" | "post_completion";

/** Who performed the action. */
export type MatchEventActorType = "engine" | "organizer" | "system";

// ── Movement payload shapes (canonical) ─────────────────────

/** One player swapped out for another on the same team. */
export type RosterSwapMovement = {
  out_player_id: string;
  out_player_name: string;
  in_player_id: string;
  in_player_name: string;
  team: MatchTeam;
};

/** One player changing sides (team_flip records two of these). */
export type TeamFlipMovement = {
  player_id: string;
  player_name: string;
  from_team: MatchTeam;
  to_team: MatchTeam;
};

export type MatchMovement = RosterSwapMovement | TeamFlipMovement;

// ── Derivations ─────────────────────────────────────────────

/**
 * The ultimate 6-value label. Mirrors EXACTLY the generated column:
 *   created_method || (modification_count > 0 ? '_modified' : '_clean')
 */
export function deriveFinalClassification(
  createdMethod: MatchCreatedMethod,
  modificationCount: number
): MatchClassification {
  const suffix = modificationCount > 0 ? "_modified" : "_clean";
  return `${createdMethod}${suffix}` as MatchClassification;
}

/** True when the match's roster ended up different from how it was composed. */
export function isModified(modificationCount: number): boolean {
  return modificationCount > 0;
}

/**
 * Legacy backfill: recover (created_method, modification_count) from the old
 * (origin, is_held) pair. Mirrors the backfill UPDATE in migration 1.
 *
 * Recovery is exact for BIRTH because of the sticky rule (swaps only flipped
 * origin when it was 'auto'), so origin='modified' provably came from an auto
 * birth. `is_held` distinguishes held drafts (which were historically stamped
 * origin='auto').
 *
 * LIMITATION (plan §14 H1): a historically-modified *manual* match stayed
 * origin='manual' (sticky), so it backfills as manual_clean. There is no schema
 * signal to recover it — manual_modified is accurate only going forward. The
 * count for legacy modified rows is a FLOOR of 1 (≥1, exact unknown).
 */
export function backfillProvenance(
  origin: "auto" | "manual" | "modified",
  isHeld: boolean
): { createdMethod: MatchCreatedMethod; modificationCount: number } {
  const createdMethod: MatchCreatedMethod = isHeld
    ? "held"
    : origin === "manual"
      ? "manual"
      : "auto"; // origin 'auto' OR 'modified' ⇒ born auto (sticky rule)
  const modificationCount = origin === "modified" ? 1 : 0;
  return { createdMethod, modificationCount };
}

/**
 * Per-event-row effect on `modification_count` (the SPEC the RPCs mirror).
 * Composition changes +1; undo −1; everything else 0.
 * Note: an ondeck_pull writes TWO rows (one per match); each row is +1 on its
 * own match, so the per-row delta is +1.
 */
export function modificationDelta(eventType: MatchEventType): -1 | 0 | 1 {
  switch (eventType) {
    case "roster_swap":
    case "team_flip":
    case "ondeck_pull":
    case "player_left":
      return 1;
    case "undo":
      return -1;
    case "created":
    case "published":
    case "cancelled":
    case "score_edit":
    case "revert":
      return 0;
  }
}

/** Apply one event to a running count, floored at 0 (undo never drives it negative). */
export function applyModification(count: number, eventType: MatchEventType): number {
  return Math.max(0, count + modificationDelta(eventType));
}

/** Does this event type count toward the "modified" classification? */
export function countsAsModification(eventType: MatchEventType): boolean {
  return modificationDelta(eventType) > 0;
}

/**
 * fix_record_swap_player chooses its mode at runtime: a non-null in-player team
 * means both players are already in the match (team flip); null means a full
 * replacement from another match. Mirrors `v_is_team_flip := v_in_team IS NOT NULL`.
 */
export function fixRecordEventType(inPlayerTeam: MatchTeam | null): "team_flip" | "roster_swap" {
  return inPlayerTeam !== null ? "team_flip" : "roster_swap";
}

// ── Movement builders (canonical shapes shared by RPC payloads + UI readers) ──

export function rosterSwapMovement(m: {
  outPlayerId: string;
  outPlayerName: string;
  inPlayerId: string;
  inPlayerName: string;
  team: MatchTeam;
}): RosterSwapMovement[] {
  return [
    {
      out_player_id: m.outPlayerId,
      out_player_name: m.outPlayerName,
      in_player_id: m.inPlayerId,
      in_player_name: m.inPlayerName,
      team: m.team,
    },
  ];
}

export function teamFlipMovements(
  a: { playerId: string; playerName: string; team: MatchTeam },
  b: { playerId: string; playerName: string; team: MatchTeam }
): TeamFlipMovement[] {
  return [
    { player_id: a.playerId, player_name: a.playerName, from_team: a.team, to_team: b.team },
    { player_id: b.playerId, player_name: b.playerName, from_team: b.team, to_team: a.team },
  ];
}

/** Type guard distinguishing the two movement shapes when reading the JSONB. */
export function isRosterSwapMovement(m: MatchMovement): m is RosterSwapMovement {
  return "out_player_id" in m;
}
